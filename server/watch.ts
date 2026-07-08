import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AwvEvent } from '../shared/schema';
import type { SessionStore, SessionState } from './store';
import { TranscriptNormalizer, type SubagentMeta, type TranscriptSource } from './normalizer';
import { computeSessionStats } from './stats';
import { StatsCache, fingerprintOf, type FileStamp } from './statsCache';

interface WatchOptions {
  root?: string;
  pollMs?: number;
  livenessMs?: number;
  /** Disable fs.watch (tests drive scan() manually and rely on polling only). */
  watchFs?: boolean;
  statsCache?: StatsCache;
  /** Parallel background full-parses for historical stats (default 2). */
  statsConcurrency?: number;
}

interface FileSource {
  path: string;
  source: TranscriptSource;
}

const PEEK_HEAD_BYTES = 64 * 1024;
const PEEK_TAIL_BYTES = 32 * 1024;

export class ClaudeProjectWatcher {
  private root: string;
  private pollMs: number;
  private timer: Timer | null = null;
  private watchers = new Map<string, FSWatcher>();
  private nudgeTimer: Timer | null = null;
  private busy = false;
  private livenessMs: number;
  private watchFs: boolean;
  // Cache resolved subagent meta by file path. meta.json is written once per
  // agent, so once we've read real fields we never re-read; until then (create
  // race) we retry each poll so a late-arriving meta still gets picked up.
  private metaCache = new Map<string, SubagentMeta>();
  private statsCache: StatsCache | null;
  private statsConcurrency: number;
  private statsQueue: SessionState[] = [];
  private statsActive = 0;

  constructor(private store: SessionStore, opts?: WatchOptions) {
    this.root = opts?.root || process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects');
    this.pollMs = opts?.pollMs ?? 1500;
    this.livenessMs = opts?.livenessMs ?? 5 * 60_000;
    this.watchFs = opts?.watchFs ?? true;
    this.statsCache = opts?.statsCache ?? null;
    this.statsConcurrency = Math.max(1, opts?.statsConcurrency ?? 2);
  }

  start() {
    this.ensureWatch(this.root);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const state of this.statsQueue) state.statsQueued = false;
    this.statsQueue = [];
  }

  setLivenessMs(ms: number) {
    this.livenessMs = ms;
  }

  setPollMs(ms: number) {
    if (ms === this.pollMs) return;
    this.pollMs = ms;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => void this.tick(), this.pollMs);
    }
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.scan();
    } catch (err) {
      console.error('[watch] scan failed', err);
    } finally {
      this.busy = false;
    }
  }

  /** Fully parse a session on demand (subscriber asked for a historical session). */
  async ensureLoaded(state: SessionState) {
    if (state.loaded) return;
    await this.processSession(state);
  }

  async scan() {
    const projects = await safeReaddir(this.root, true);
    for (const projectEntry of projects) {
      if (!projectEntry.isDirectory()) continue;
      const project = projectEntry.name;
      const projectDir = join(this.root, project);
      this.ensureWatch(projectDir);
      const files = await safeReaddir(projectDir, true);
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const rootFile = join(projectDir, f.name);
        const st = await stat(rootFile).catch(() => null);
        if (!st) continue;
        const sessionId = f.name.replace(/\.jsonl$/, '');
        const sessionDir = join(projectDir, sessionId);
        const id = `${project}/${sessionId}`;
        const state = this.store.upsertSession({ id, project, sessionId, rootFile, sessionDir, lastActive: st.mtimeMs });
        const live = Date.now() - st.mtimeMs < this.livenessMs;
        if (live || this.store.hasExplicitInterest(state)) {
          await this.processSession(state);
        } else {
          if (!state.peeked) await this.peekSession(state, st.size);
          if (state.loaded) this.releaseSessionWatches(state);
          state.live = false;
          const rootStamp = `${Math.round(st.mtimeMs)}:${st.size}`;
          if (this.statsCache && !state.loaded && !state.statsQueued && state.statsRootStamp !== rootStamp) {
            state.statsQueued = true;
            state.statsRootStamp = rootStamp;
            this.statsQueue.push(state);
          }
        }
      }
    }
    this.store.broadcastSessions();
    this.pumpStats();
  }

  /** Drain the historical-stats queue with bounded parallelism; never blocks the live scan path. */
  private pumpStats() {
    while (this.statsActive < this.statsConcurrency && this.statsQueue.length) {
      const state = this.statsQueue.shift()!;
      this.statsActive++;
      void this.computeHistoricalStats(state)
        .catch((err) => console.error('[watch] stats parse failed', state.id, err))
        .finally(() => {
          state.statsQueued = false;
          this.statsActive--;
          this.pumpStats();
        });
    }
  }

  /**
   * Full-parse a non-live session off the hot path: serve from the disk cache
   * when the source fingerprint matches, otherwise parse with a throwaway
   * normalizer and persist the result. The live path stays authoritative — if
   * the session got loaded while we were queued, this is a no-op.
   */
  private async computeHistoricalStats(state: SessionState) {
    if (!this.statsCache || state.loaded || state.loading) return;
    const sources = await this.discoverSources(state, false);
    const stamps: FileStamp[] = [];
    for (const fs of sources) {
      const st = await stat(fs.path).catch(() => null);
      if (st) stamps.push({ path: fs.path, mtimeMs: st.mtimeMs, size: st.size });
    }
    const fingerprint = fingerprintOf(stamps);
    if (state.statsFingerprint === fingerprint && state.statsBase) return;
    const cached = await this.statsCache.get(state.id, fingerprint);
    if (cached) {
      state.statsFingerprint = fingerprint;
      this.store.setExternalStats(state, cached.stats, cached.search);
      return;
    }
    const normalizer = new TranscriptNormalizer({
      sessionId: state.sessionId,
      project: state.project,
      cwd: state.cwd,
      contextLimits: this.store.getContextLimits(),
    });
    const events: AwvEvent[] = [];
    for (const fs of sources) {
      const text = await readFile(fs.path, 'utf8').catch(() => '');
      if (!text) continue;
      const journal = fs.source.kind === 'workflow-journal';
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const batch = journal ? normalizer.ingestJournal(line, fs.source) : normalizer.normalizeLine(line, fs.source);
        events.push(...batch.events);
      }
    }
    if (state.loaded || state.loading) return; // live path took over mid-parse
    const base = computeSessionStats({ id: state.id, normalizer, events });
    const search = [...normalizer.searchParts];
    state.statsFingerprint = fingerprint;
    this.store.setExternalStats(state, base, search);
    await this.statsCache.put(state.id, { fingerprint, stats: base, search });
  }

  private ensureWatch(path: string) {
    if (!this.watchFs || this.watchers.has(path)) return;
    try {
      const watcher = watch(path, { persistent: false }, () => {
        if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
        this.nudgeTimer = setTimeout(() => void this.tick(), 120);
      });
      watcher.on('error', () => {
        watcher.close();
        this.watchers.delete(path);
      });
      this.watchers.set(path, watcher);
    } catch {
      // Directory may not exist yet or fs.watch may be unavailable; polling remains authoritative.
    }
  }

  /** Drop fs.watch handles for a session that is no longer live/subscribed (polling still covers it). */
  private releaseSessionWatches(state: SessionState) {
    for (const [path, watcher] of this.watchers) {
      if (path === state.sessionDir || path.startsWith(state.sessionDir + '/')) {
        watcher.close();
        this.watchers.delete(path);
      }
    }
  }

  private async processSession(state: SessionState) {
    if (state.processing) return state.processing;
    const p = this.doProcess(state).finally(() => { if (state.processing === p) state.processing = undefined; });
    state.processing = p;
    return p;
  }

  private async doProcess(state: SessionState) {
    const initial = !state.loaded;
    if (initial) state.loading = true;
    const sources = await this.discoverSources(state);
    for (const fs of sources) await this.readNewLines(state, fs);
    if (initial) this.store.finishLoad(state);
    state.live = Date.now() - state.lastActive < this.livenessMs;
  }

  /** Read a bounded head+tail slice to learn cwd/title/start time without parsing the whole transcript. */
  private async peekSession(state: SessionState, size: number) {
    state.peeked = true;
    try {
      const file = Bun.file(state.rootFile);
      const head = await file.slice(0, Math.min(size, PEEK_HEAD_BYTES)).text();
      for (const line of head.split('\n')) {
        if (line.trim()) state.normalizer.peekLine(line);
      }
      if (size > PEEK_HEAD_BYTES + PEEK_TAIL_BYTES) {
        const tail = await file.slice(size - PEEK_TAIL_BYTES, size).text();
        const lines = tail.split('\n');
        lines.shift(); // first line is almost certainly partial
        for (const line of lines) {
          if (line.trim()) state.normalizer.peekLine(line);
        }
      }
      state.cwd = state.cwd || state.normalizer.cwd;
    } catch {
      // Unreadable file: leave defaults; a later subscribe will surface real errors.
    }
  }

  private async discoverSources(state: SessionState, addWatches = true): Promise<FileSource[]> {
    const sources: FileSource[] = [{
      path: state.rootFile,
      source: { sessionId: state.sessionId, project: state.project, cwd: state.cwd, filePath: state.rootFile, kind: 'root' },
    }];
    const subDir = join(state.sessionDir, 'subagents');
    if (addWatches) this.ensureWatch(subDir);
    const subs = await safeReaddir(subDir, true);
    for (const ent of subs) {
      const p = join(subDir, ent.name);
      if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        const agentId = ent.name.replace(/\.jsonl$/, '');
        sources.push({
          path: p,
          source: { sessionId: state.sessionId, project: state.project, cwd: state.cwd, filePath: p, kind: 'subagent', agentId, meta: await this.readMetaCached(p, agentId) },
        });
      } else if (ent.isDirectory() && ent.name === 'workflows') {
        const wfs = await safeReaddir(p, true);
        for (const wf of wfs) {
          if (!wf.isDirectory() || !wf.name.startsWith('wf_')) continue;
          const wfDir = join(p, wf.name);
          if (addWatches) this.ensureWatch(wfDir);
          const wfFiles = await safeReaddir(wfDir, true);
          for (const file of wfFiles) {
            if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
            const fp = join(wfDir, file.name);
            if (file.name === 'journal.jsonl') {
              sources.push({
                path: fp,
                source: { sessionId: state.sessionId, project: state.project, cwd: state.cwd, filePath: fp, kind: 'workflow-journal', workflowId: wf.name },
              });
              continue;
            }
            const agentId = file.name.replace(/\.jsonl$/, '');
            sources.push({
              path: fp,
              source: { sessionId: state.sessionId, project: state.project, cwd: state.cwd, filePath: fp, kind: 'workflow-agent', workflowId: wf.name, agentId, meta: await this.readMetaCached(fp, agentId) },
            });
          }
        }
      }
    }
    return sources;
  }

  /**
   * Resolve subagent meta with caching. `readMeta` returns a fallback of just
   * `{ slug }` when meta.json is missing/unreadable; we only cache once real
   * fields (agentType/description/toolUseId) have arrived, so the create-race
   * retry from the original design is preserved.
   */
  private async readMetaCached(jsonlPath: string, slug: string): Promise<SubagentMeta | null> {
    const cached = this.metaCache.get(jsonlPath);
    if (cached) return cached;
    const meta = await readMeta(jsonlPath, slug);
    if (meta && (meta.agentType || meta.description || meta.toolUseId)) {
      this.metaCache.set(jsonlPath, meta);
    }
    return meta;
  }

  private async readNewLines(state: SessionState, file: FileSource) {
    const st = await stat(file.path).catch(() => null);
    if (!st) return;
    let cursor = state.files.get(file.path);
    if (!cursor || st.size < cursor.offset) {
      cursor = { offset: 0, buffer: '', sourceKey: file.path };
      state.files.set(file.path, cursor);
    }
    if (st.size === cursor.offset) return;
    const handle = Bun.file(file.path);
    const slice = handle.slice(cursor.offset, st.size);
    const text = await slice.text();
    cursor.offset = st.size;
    const combined = cursor.buffer + text;
    const parts = combined.split(/\r?\n/);
    cursor.buffer = parts.pop() || '';
    const agents = [] as any[];
    const events = [] as any[];
    const journal = file.source.kind === 'workflow-journal';
    for (const line of parts) {
      if (!line.trim()) continue;
      const batch = journal ? state.normalizer.ingestJournal(line, file.source) : state.normalizer.normalizeLine(line, file.source);
      agents.push(...batch.agents);
      events.push(...batch.events);
    }
    this.store.merge(state, agents, events);
  }
}

async function readMeta(jsonlPath: string, slug: string): Promise<SubagentMeta | null> {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
  try {
    const obj = JSON.parse(await readFile(metaPath, 'utf8'));
    return { ...obj, slug };
  } catch {
    return { slug };
  }
}

async function safeReaddir(path: string, withFileTypes: true) {
  try { return await readdir(path, { withFileTypes }); } catch { return []; }
}

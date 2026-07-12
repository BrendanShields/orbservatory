import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AwvEvent, TranscriptItem, TranscriptResponse } from '../../shared/schema';
import type { SessionStore, SessionState } from '../store';
import type { SubagentMeta, TranscriptSource } from '../normalizer';
import { TranscriptNormalizer, bareIdOf, contentBlocks, failedResult, isHousekeepingType, isMetaText, realTimestampOf, rootAgentId, summarizeInput, textFromContent, usageTokens } from '../normalizer';
import type { SessionProvider } from './types';
import { tailLines } from './tail';
import { computeSessionStats } from '../stats';
import { StatsCache, fingerprintOf, type FileStamp } from '../statsCache';
import { readFileSlice } from '../fileSlice';
import { capText, extractClock, pageItems, type TranscriptQuery } from '../transcript';

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

export function defaultClaudeRoot(): string {
  return process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects');
}

export class ClaudeProjectWatcher implements SessionProvider {
  readonly source = 'claude' as const;
  private root: string;
  private pollMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private watchers = new Map<string, FSWatcher>();
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.root = opts?.root || defaultClaudeRoot();
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
    this.timer = null;
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

  async transcript(state: SessionState, q: TranscriptQuery): Promise<TranscriptResponse | null> {
    const sources = await this.discoverSources(state, false);
    const items: TranscriptItem[] = [];
    const clock = extractClock({ rebase: true });
    const lastTokens = new Map<string, number>();
    const toolNames = new Map<string, string>();
    for (const fs of sources) {
      if (fs.source.kind === 'workflow-journal') continue;
      let text: string;
      try {
        text = await readFile(fs.path, 'utf8');
      } catch (err) {
        if (fs.path === state.rootFile) throw err;
        continue;
      }
      const agentId = fs.source.kind === 'root'
        ? rootAgentId(state.sessionId)
        : `${rootAgentId(state.sessionId)}:agent-${bareIdOf(fs.source.agentId)}`;
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const rec = safeJson(line);
        if (rec && typeof rec === 'object') claudeLineItems(rec, agentId, state.cwd || this.normalizerOf(state).cwd, clock, lastTokens, toolNames, items);
      }
    }
    items.forEach((it, idx) => { it.i = idx; });
    return pageItems(items, q);
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
        const state = this.store.upsertSession({ id, source: 'claude', project, sessionId, rootFile, sessionDir, lastActive: st.mtimeMs });
        const live = Date.now() - st.mtimeMs < this.livenessMs;
        try {
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
        } catch (err) {
          // One unreadable session (EACCES, deleted mid-scan) must not stall
          // every other session in the scan.
          console.error(`[claude] failed to read ${rootFile}; skipping this poll`, err);
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
        .catch((err) => console.error('[claude] stats parse failed', state.id, err))
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

  private normalizerOf(state: SessionState): TranscriptNormalizer {
    return state.normalizer as TranscriptNormalizer;
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
    if (!state.loaded) state.loading = true;
    let wasReset = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const sources = await this.discoverSources(state);
      let resetNeeded = false;
      for (const fs of sources) {
        if (await this.readNewLines(state, fs)) { resetNeeded = true; break; }
      }
      if (resetNeeded && attempt === 0) {
        // A source file shrank (rewritten in place): derived events are stale.
        wasReset = true;
        this.store.resetSession(state);
        continue;
      }
      break;
    }
    if (!state.loaded) this.store.finishLoad(state);
    state.live = Date.now() - state.lastActive < this.livenessMs;
    if (wasReset) this.store.pushSnapshot(state);
  }

  /** Read a bounded head+tail slice to learn cwd/title/start time without parsing the whole transcript. */
  private async peekSession(state: SessionState, size: number) {
    state.peeked = true;
    const normalizer = this.normalizerOf(state);
    try {
      const head = await readFileSlice(state.rootFile, 0, Math.min(size, PEEK_HEAD_BYTES));
      for (const line of head.split('\n')) {
        if (line.trim()) normalizer.peekLine(line);
      }
      if (size > PEEK_HEAD_BYTES + PEEK_TAIL_BYTES) {
        const tail = await readFileSlice(state.rootFile, size - PEEK_TAIL_BYTES, size);
        const lines = tail.split('\n');
        lines.shift(); // first line is almost certainly partial
        for (const line of lines) {
          if (line.trim()) normalizer.peekLine(line);
        }
      }
      state.cwd = state.cwd || normalizer.cwd;
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
          this.ensureWatch(wfDir);
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

  /** Returns true when the file shrank (rewrite) and the session needs a full reset. */
  private async readNewLines(state: SessionState, file: FileSource): Promise<boolean> {
    const normalizer = this.normalizerOf(state);
    const agents = [] as any[];
    const events = [] as any[];
    let tasksChanged = false;
    const journal = file.source.kind === 'workflow-journal';
    const { reset } = await tailLines(state.files, file.path, (line) => {
      const batch = journal ? normalizer.ingestJournal(line, file.source) : normalizer.normalizeLine(line, file.source);
      agents.push(...batch.agents);
      events.push(...batch.events);
      if (batch.tasksChanged) tasksChanged = true;
    });
    if (reset) return true;
    this.store.merge(state, agents, events, tasksChanged);
    return false;
  }
}

/** One transcript line → readable rows, mirroring the normalizer's skip/summarize rules. */
function claudeLineItems(rec: any, agentId: string, cwd: string | undefined, clock: ReturnType<typeof extractClock>, lastTokens: Map<string, number>, toolNames: Map<string, string>, out: TranscriptItem[]) {
  const type = String(rec.type || '');
  if (type === 'summary' || type === 'ai-title' || type === 'custom-title') return;
  if (type === 'system' && rec.subtype === 'compact_boundary') { clock.at(realTimestampOf(rec)); return; }
  if (isHousekeepingType(type)) return;
  const { ts, t } = clock.at(realTimestampOf(rec));
  const iso = new Date(ts).toISOString();
  const push = (role: TranscriptItem['role'], text: string, extra?: Partial<TranscriptItem>) => {
    const c = capText(text);
    const item: TranscriptItem = { i: 0, t, ts: iso, role, agent: agentId, text: c.text, ...extra };
    if (c.truncated) item.truncated = true;
    out.push(item);
  };
  const content = rec.message?.content ?? rec.content;

  if (type === 'user') {
    const rawText = textFromContent(content);
    if (rawText.includes('<task-notification>') || rec.isMeta || rec.isCompactSummary) return;
    const blocks = contentBlocks(content);
    const toolResults = blocks.filter((b) => b && typeof b === 'object' && b.type === 'tool_result');
    if (toolResults.length) {
      for (const block of toolResults) {
        const useId = String(block.tool_use_id || block.toolUseId || '');
        const failed = block.is_error || failedResult(rec.toolUseResult);
        const text = textFromContent(block.content) || (failed ? 'tool error' : 'result');
        push(failed ? 'error' : 'tool-result', text, { tool: toolNames.get(useId) });
      }
      return;
    }
    if (rawText && isMetaText(rawText)) return;
    if (rawText) push('user', rawText);
    else if (blocks.some((b) => b && typeof b === 'object' && b.type === 'image')) push('user', '[image]');
    return;
  }

  if (type === 'assistant') {
    if (rec.isApiErrorMessage) {
      push('error', textFromContent(content) || 'API error');
      return;
    }
    const usageTotal = usageTokens(rec.message?.usage ?? rec.usage);
    let tokens: number | undefined;
    if (usageTotal != null) {
      const diff = usageTotal - (lastTokens.get(agentId) ?? 0);
      if (diff > 0) tokens = diff;
      lastTokens.set(agentId, usageTotal);
    }
    let toolIdx = 0;
    for (const block of contentBlocks(content)) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && block.text) {
        push('assistant', String(block.text), tokens != null ? { tokens } : undefined);
        tokens = undefined;
      } else if (block.type === 'tool_use') {
        const tool = String(block.name || 'tool');
        if (block.id) toolNames.set(String(block.id), tool);
        // Same 30ms stagger the normalizer applies to tool events, so click-seek lands exactly.
        const extra: Partial<TranscriptItem> = { tool, t: t + toolIdx * 30 };
        if (tokens != null) { extra.tokens = tokens; tokens = undefined; }
        push('tool', summarizeInput(block.input, tool, cwd), extra);
        toolIdx++;
      }
    }
  }
}

function safeJson(raw: string): any | null {
  try { return JSON.parse(raw); } catch { return null; }
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

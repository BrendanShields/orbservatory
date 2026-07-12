import { readdir, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import type { SessionStore, SessionState } from '../store';
import type { SessionProvider } from './types';
import { PiNormalizer } from './pi-normalizer';
import { tailLines } from './tail';
import { readFileSlice } from '../fileSlice';

interface PiOptions {
  root?: string;
  pollMs?: number;
  livenessMs?: number;
}

interface PiHead {
  sessionId: string;
  cwd?: string;
}

const PEEK_HEAD_BYTES = 64 * 1024;
const HEAD_PROBE_BYTES = 64 * 1024;

/**
 * pi stores sessions under `<agentDir>/sessions/--escaped-cwd--/<ts>_<id>.jsonl`
 * where agentDir defaults to ~/.pi/agent (PI_CODING_AGENT_DIR overrides it,
 * PI_CODING_AGENT_SESSION_DIR points straight at one session directory).
 */
export function defaultPiRoot(): string {
  const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (sessionDir) return sessionDir;
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  return join(agentDir, 'sessions');
}

export class PiProvider implements SessionProvider {
  readonly source = 'pi' as const;
  private root: string;
  private pollMs: number;
  private livenessMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private heads = new Map<string, PiHead>();

  constructor(private store: SessionStore, opts?: PiOptions) {
    this.root = opts?.root || defaultPiRoot();
    this.pollMs = opts?.pollMs ?? 1500;
    this.livenessMs = opts?.livenessMs ?? 5 * 60_000;
  }

  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
      console.error('[pi] scan failed', err);
    } finally {
      this.busy = false;
    }
  }

  async ensureLoaded(state: SessionState) {
    if (state.loaded) return;
    await this.processSession(state);
  }

  async scan() {
    const files = await walkSessions(this.root);
    for (const path of files) {
      const st = await stat(path).catch(() => null);
      if (!st) continue;
      const head = await this.headOf(path, st.size);
      if (!head) continue;
      const id = `pi:${head.sessionId}`;
      const state = this.store.upsertSession({
        id,
        source: 'pi',
        project: 'pi',
        sessionId: head.sessionId,
        rootFile: path,
        sessionDir: dirname(path),
        cwd: head.cwd,
        lastActive: st.mtimeMs,
        makeNormalizer: () => new PiNormalizer({ sessionId: head.sessionId }),
      });
      // pi migrates old session files by rewriting them in place; a shrink
      // resets the tail cursor (handled in tailLines) — nothing extra here.
      const live = Date.now() - st.mtimeMs < this.livenessMs;
      try {
        if (live || this.store.hasExplicitInterest(state)) {
          await this.processSession(state);
        } else {
          if (!state.peeked) await this.peekSession(state, st.size);
          state.live = false;
        }
      } catch (err) {
        console.error(`[pi] failed to read ${path}; skipping this poll`, err);
      }
    }
    this.store.broadcastSessions();
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
      const normalizer = state.normalizer as PiNormalizer;
      const agents = [] as any[];
      const events = [] as any[];
      const { reset } = await tailLines(state.files, state.rootFile, (line) => {
        const batch = normalizer.normalizeLine(line);
        agents.push(...batch.agents);
        events.push(...batch.events);
      });
      if (reset && attempt === 0) {
        // pi rewrites session files in place on format migration.
        wasReset = true;
        this.store.resetSession(state, () => new PiNormalizer({ sessionId: state.sessionId }));
        continue;
      }
      this.store.merge(state, agents, events);
      break;
    }
    state.cwd = state.cwd || (state.normalizer as PiNormalizer).cwd;
    if (!state.loaded) this.store.finishLoad(state);
    state.live = Date.now() - state.lastActive < this.livenessMs;
    if (wasReset) this.store.pushSnapshot(state);
  }

  private async peekSession(state: SessionState, size: number) {
    state.peeked = true;
    const normalizer = state.normalizer as PiNormalizer;
    try {
      const head = await readFileSlice(state.rootFile, 0, Math.min(size, PEEK_HEAD_BYTES));
      for (const line of head.split('\n')) {
        if (line.trim()) normalizer.peekLine(line);
      }
      state.cwd = state.cwd || normalizer.cwd;
    } catch {
      // Unreadable file: leave defaults; a later subscribe will surface real errors.
    }
  }

  /**
   * Resolve the session header of a file, cached. Returns null while the first
   * line is still partial (retry next poll) or when the file is not a pi
   * session (first entry must be `{type:"session"}` with a string id).
   */
  private async headOf(path: string, size: number): Promise<PiHead | null> {
    const cached = this.heads.get(path);
    if (cached) return cached;
    const text = await readFileSlice(path, 0, Math.min(size, HEAD_PROBE_BYTES)).catch(() => '');
    const nl = text.indexOf('\n');
    if (nl < 0) return null;
    const first = safeJson(text.slice(0, nl));
    if (!first || first.type !== 'session' || typeof first.id !== 'string' || !first.id) return null;
    const head: PiHead = {
      sessionId: first.id,
      cwd: typeof first.cwd === 'string' && first.cwd ? first.cwd : undefined,
    };
    this.heads.set(path, head);
    return head;
  }
}

async function walkSessions(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    const p = join(root, ent.name);
    if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      out.push(p);
    } else if (ent.isDirectory()) {
      let files;
      try { files = await readdir(p, { withFileTypes: true }); } catch { continue; }
      for (const f of files) {
        if (f.isFile() && f.name.endsWith('.jsonl')) out.push(join(p, f.name));
      }
    }
  }
  return out.sort((a, b) => basename(a).localeCompare(basename(b)));
}

function safeJson(raw: string): any | null {
  try { return JSON.parse(raw); } catch { return null; }
}

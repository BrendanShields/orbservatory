import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SessionStore, SessionState } from '../store';
import type { SessionProvider } from './types';
import { CopilotNormalizer } from './copilot-normalizer';
import { tailLines } from './tail';
import { readFileSlice } from '../fileSlice';

interface CopilotOptions {
  root?: string;
  pollMs?: number;
  livenessMs?: number;
}

const PEEK_HEAD_BYTES = 64 * 1024;

export function defaultCopilotRoot(): string {
  const home = process.env.COPILOT_HOME || join(homedir(), '.copilot');
  return join(home, 'session-state');
}

export class CopilotProvider implements SessionProvider {
  readonly source = 'copilot' as const;
  private root: string;
  private pollMs: number;
  private livenessMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private broken = new Set<string>();

  constructor(private store: SessionStore, opts?: CopilotOptions) {
    this.root = opts?.root || defaultCopilotRoot();
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
      console.error('[copilot] scan failed', err);
    } finally {
      this.busy = false;
    }
  }

  async ensureLoaded(state: SessionState) {
    if (state.loaded) return;
    await this.processSession(state);
  }

  async scan() {
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const sessionId = ent.name;
      const id = `copilot:${sessionId}`;
      if (this.broken.has(id)) continue;
      const sessionDir = join(this.root, sessionId);
      const rootFile = join(sessionDir, 'events.jsonl');
      const st = await stat(rootFile).catch(() => null);
      if (!st) continue;
      const state = this.store.upsertSession({
        id,
        source: 'copilot',
        project: 'copilot',
        sessionId,
        rootFile,
        sessionDir,
        lastActive: st.mtimeMs,
        makeNormalizer: () => new CopilotNormalizer({ sessionId }),
      });
      const live = Date.now() - st.mtimeMs < this.livenessMs;
      try {
        if (live || this.store.hasExplicitInterest(state)) {
          await this.processSession(state);
        } else {
          if (!state.peeked) await this.peekSession(state, st.size);
          state.live = false;
        }
      } catch (err) {
        // Whole-file failure skips this session without affecting the rest.
        this.broken.add(id);
        console.error(`[copilot] failed to parse ${rootFile}; skipping session`, err);
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
    const initial = !state.loaded;
    if (initial) state.loading = true;
    const normalizer = state.normalizer as CopilotNormalizer;
    const agents = [] as any[];
    const events = [] as any[];
    await tailLines(state.files, state.rootFile, (line) => {
      const batch = normalizer.normalizeLine(line);
      agents.push(...batch.agents);
      events.push(...batch.events);
    });
    this.store.merge(state, agents, events);
    state.cwd = state.cwd || normalizer.cwd;
    if (initial) this.store.finishLoad(state);
    state.live = Date.now() - state.lastActive < this.livenessMs;
  }

  private async peekSession(state: SessionState, size: number) {
    state.peeked = true;
    const normalizer = state.normalizer as CopilotNormalizer;
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
}

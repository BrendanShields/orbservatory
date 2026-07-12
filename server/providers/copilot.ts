import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TranscriptItem, TranscriptResponse } from '../../shared/schema';
import type { SessionStore, SessionState } from '../store';
import type { SessionProvider } from './types';
import { CopilotNormalizer, messageRole, messageText, summarize } from './copilot-normalizer';
import { tailLines } from './tail';
import { readFileSlice } from '../fileSlice';
import { capText, extractClock, pageItems, type TranscriptQuery } from '../transcript';

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
  /** Session id → mtime at parse failure; a changed mtime clears the skip so appends get retried. */
  private broken = new Map<string, number>();

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

  async transcript(state: SessionState, q: TranscriptQuery): Promise<TranscriptResponse | null> {
    const text = await readFile(state.rootFile, 'utf8');
    const items: TranscriptItem[] = [];
    const clock = extractClock();
    const toolNames = new Map<string, string>();
    const agentId = `session:${state.sessionId}`;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const rec = safeJson(line);
      if (rec && typeof rec === 'object') copilotLineItems(rec, agentId, clock, toolNames, items);
    }
    items.forEach((it, idx) => { it.i = idx; });
    return pageItems(items, q);
  }

  async scan() {
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const sessionId = ent.name;
      const id = `copilot:${sessionId}`;
      const sessionDir = join(this.root, sessionId);
      const rootFile = join(sessionDir, 'events.jsonl');
      const st = await stat(rootFile).catch(() => null);
      if (!st) continue;
      const brokenAt = this.broken.get(id);
      if (brokenAt != null) {
        if (brokenAt === st.mtimeMs) continue;
        this.broken.delete(id);
      }
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
        // Whole-file failure skips this session (retried when the file changes) without affecting the rest.
        this.broken.set(id, st.mtimeMs);
        console.error(`[copilot] failed to parse ${rootFile}; skipping session until it changes`, err);
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
      const normalizer = state.normalizer as CopilotNormalizer;
      const agents = [] as any[];
      const events = [] as any[];
      const { reset } = await tailLines(state.files, state.rootFile, (line) => {
        const batch = normalizer.normalizeLine(line);
        agents.push(...batch.agents);
        events.push(...batch.events);
      });
      if (reset && attempt === 0) {
        wasReset = true;
        this.store.resetSession(state, () => new CopilotNormalizer({ sessionId: state.sessionId }));
        continue;
      }
      this.store.merge(state, agents, events);
      break;
    }
    state.cwd = state.cwd || (state.normalizer as CopilotNormalizer).cwd;
    if (!state.loaded) this.store.finishLoad(state);
    state.live = Date.now() - state.lastActive < this.livenessMs;
    if (wasReset) this.store.pushSnapshot(state);
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

function copilotLineItems(rec: any, agentId: string, clock: ReturnType<typeof extractClock>, toolNames: Map<string, string>, out: TranscriptItem[]) {
  const type = String(rec.type || '');
  const data = rec.data ?? {};
  const n = Date.parse(rec.timestamp || '');
  const { ts, t } = clock.at(Number.isFinite(n) ? n : null);
  const iso = new Date(ts).toISOString();
  const push = (role: TranscriptItem['role'], text: string, tool?: string) => {
    const c = capText(text);
    const item: TranscriptItem = { i: 0, t, ts: iso, role, agent: agentId, text: c.text };
    if (c.truncated) item.truncated = true;
    if (tool) item.tool = tool;
    out.push(item);
  };

  if (type === 'tool.execution_start') {
    const tool = String(data.toolName ?? data.tool ?? data.name ?? 'tool');
    const useId = strOrUndef(data.toolCallId ?? data.callId ?? data.id);
    if (useId) toolNames.set(useId, tool);
    push('tool', summarize(data.arguments ?? data.input), tool);
    return;
  }
  if (type === 'tool.execution_complete') {
    if (data.success === false) {
      const useId = strOrUndef(data.toolCallId ?? data.callId ?? data.id);
      const tool = useId ? toolNames.get(useId) : undefined;
      push('error', String(data.error ?? data.message ?? `${tool || 'tool'} failed`), tool);
    }
    return;
  }
  const text = messageText(rec);
  if (!text) return;
  push(messageRole(rec) === 'assistant' ? 'assistant' : 'user', text);
}

function strOrUndef(v: any): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function safeJson(raw: string): any | null {
  try { return JSON.parse(raw); } catch { return null; }
}

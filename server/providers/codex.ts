import { readdir, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import type { SessionStore, SessionState } from '../store';
import type { SessionProvider } from './types';
import { CodexNormalizer, type CodexLineSource } from './codex-normalizer';
import { tailLines } from './tail';

interface CodexOptions {
  root?: string;
  pollMs?: number;
  livenessMs?: number;
}

interface RolloutHead {
  threadId: string;
  subagent: boolean;
  parentThreadId?: string;
  subagentName?: string;
}

interface RolloutFile {
  path: string;
  head: RolloutHead;
  mtime: number;
  size: number;
}

const PEEK_HEAD_BYTES = 64 * 1024;
const HEAD_PROBE_BYTES = 128 * 1024;
const UUIDISH = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function defaultCodexRoot(): string {
  const home = process.env.CODEX_HOME;
  return home ? join(home, 'sessions') : join(homedir(), '.codex', 'sessions');
}

export class CodexProvider implements SessionProvider {
  readonly source = 'codex' as const;
  private root: string;
  private pollMs: number;
  private livenessMs: number;
  private timer: Timer | null = null;
  private busy = false;
  private heads = new Map<string, RolloutHead>();
  private sessionFiles = new Map<string, RolloutFile[]>();

  constructor(private store: SessionStore, opts?: CodexOptions) {
    this.root = opts?.root || defaultCodexRoot();
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
      console.error('[codex] scan failed', err);
    } finally {
      this.busy = false;
    }
  }

  async ensureLoaded(state: SessionState) {
    if (state.loaded) return;
    await this.processSession(state);
  }

  async scan() {
    const paths = await walkRollouts(this.root);
    const groups = new Map<string, { rootPath?: string; lastActive: number; files: RolloutFile[] }>();
    for (const path of paths) {
      const st = await stat(path).catch(() => null);
      if (!st) continue;
      const head = await this.headOf(path, st.size);
      if (!head) continue;
      const sid = head.subagent && head.parentThreadId ? head.parentThreadId : head.threadId;
      let g = groups.get(sid);
      if (!g) { g = { lastActive: 0, files: [] }; groups.set(sid, g); }
      if (!head.subagent || !head.parentThreadId) g.rootPath = path;
      g.lastActive = Math.max(g.lastActive, st.mtimeMs);
      g.files.push({ path, head, mtime: st.mtimeMs, size: st.size });
    }
    for (const [sid, g] of groups) {
      if (!g.rootPath) continue;
      const id = `codex:${sid}`;
      const state = this.store.upsertSession({
        id,
        source: 'codex',
        project: 'codex',
        sessionId: sid,
        rootFile: g.rootPath,
        sessionDir: dirname(g.rootPath),
        lastActive: g.lastActive,
        makeNormalizer: () => new CodexNormalizer({ threadId: sid }),
      });
      this.sessionFiles.set(id, g.files);
      const live = Date.now() - g.lastActive < this.livenessMs;
      if (live || this.store.hasExplicitInterest(state)) {
        await this.processSession(state);
      } else {
        if (!state.peeked) await this.peekSession(state, g.rootPath, g.files.find((f) => f.path === g.rootPath)?.size ?? 0);
        state.live = false;
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
    const normalizer = state.normalizer as CodexNormalizer;
    const files = this.sessionFiles.get(state.id) ?? [];
    for (const file of files) {
      const src: CodexLineSource = file.head.subagent
        ? { kind: 'subagent', threadId: file.head.threadId, name: file.head.subagentName }
        : { kind: 'root', threadId: file.head.threadId };
      const agents = [] as any[];
      const events = [] as any[];
      await tailLines(state.files, file.path, (line) => {
        const batch = normalizer.normalizeLine(line, src);
        agents.push(...batch.agents);
        events.push(...batch.events);
      });
      this.store.merge(state, agents, events);
    }
    state.cwd = state.cwd || normalizer.cwd;
    if (initial) this.store.finishLoad(state);
    state.live = Date.now() - state.lastActive < this.livenessMs;
  }

  private async peekSession(state: SessionState, rootPath: string, size: number) {
    state.peeked = true;
    const normalizer = state.normalizer as CodexNormalizer;
    try {
      const head = await Bun.file(rootPath).slice(0, Math.min(size, PEEK_HEAD_BYTES)).text();
      for (const line of head.split('\n')) {
        if (line.trim()) normalizer.peekLine(line);
      }
      state.cwd = state.cwd || normalizer.cwd;
    } catch {
      // Unreadable file: leave defaults; a later subscribe will surface real errors.
    }
  }

  /**
   * Resolve the session_meta of a rollout file, cached. Returns null while the
   * first line is still partial (retry next poll).
   */
  private async headOf(path: string, size: number): Promise<RolloutHead | null> {
    const cached = this.heads.get(path);
    if (cached) return cached;
    const text = await Bun.file(path).slice(0, Math.min(size, HEAD_PROBE_BYTES)).text().catch(() => '');
    const nl = text.indexOf('\n');
    if (nl < 0) return null;
    const first = safeJson(text.slice(0, nl));
    const payload = first?.type === 'session_meta' ? first.payload : null;
    const fallbackId = UUIDISH.exec(basename(path))?.[1] || basename(path).replace(/\.jsonl$/, '');
    const head: RolloutHead = payload && typeof payload === 'object'
      ? {
          threadId: String(payload.id || payload.session_id || fallbackId),
          subagent: payload.thread_source === 'subagent',
          parentThreadId: strOrUndef(payload.parent_thread_id ?? payload.source?.parent_thread_id),
          subagentName: subagentName(payload.source),
        }
      : { threadId: fallbackId, subagent: false };
    this.heads.set(path, head);
    return head;
  }
}

function subagentName(source: any): string | undefined {
  if (!source) return undefined;
  const sub = source.subagent;
  if (typeof sub === 'string') return sub;
  if (sub && typeof sub === 'object') return strOrUndef(sub.name ?? sub.type);
  return undefined;
}

function strOrUndef(v: any): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

async function walkRollouts(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && ent.name.startsWith('rollout-') && ent.name.endsWith('.jsonl')) out.push(p);
    }
  }
  // Lexicographic order puts parent rollouts (earlier timestamps) before their subagent files.
  return out.sort();
}

function safeJson(raw: string): any | null {
  try { return JSON.parse(raw); } catch { return null; }
}

import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { AwvAgent, AwvEvent } from '../../shared/schema';
import type { SessionStore, SessionState } from '../store';
import type { SessionProvider } from './types';
import { OpencodeNormalizer } from './opencode-normalizer';
import { openOpencodeDb, type OpencodeDb } from './opencode-db';

interface OpencodeOptions {
  dataDir?: string;
  pollMs?: number;
  livenessMs?: number;
}

export function defaultOpencodeDataDir(): string {
  return process.env.OPENCODE_DATA_DIR
    || (process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, 'opencode') : join(homedir(), '.local', 'share', 'opencode'));
}

export function findOpencodeDb(dataDir: string): string | null {
  const main = join(dataDir, 'opencode.db');
  if (existsSync(main)) return main;
  try {
    const channel = readdirSync(dataDir).filter((f) => /^opencode-[\w.-]+\.db$/.test(f)).sort();
    return channel.length ? join(dataDir, channel[0]) : null;
  } catch {
    return null;
  }
}

export class OpencodeProvider implements SessionProvider {
  readonly source = 'opencode' as const;
  private dataDir: string;
  private pollMs: number;
  private livenessMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private db: OpencodeDb | null = null;
  private disabled = false;
  private timeCursor = 0;
  private parentOf = new Map<string, string | null>();

  constructor(private store: SessionStore, opts?: OpencodeOptions) {
    this.dataDir = opts?.dataDir || defaultOpencodeDataDir();
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
    this.db?.close();
    this.db = null;
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
    if (this.busy || this.disabled) return;
    this.busy = true;
    try {
      await this.scan();
    } catch (err) {
      if (isBusyError(err)) {
        // SQLITE_BUSY: retry next poll.
      } else if (isSchemaError(err)) {
        console.error('[opencode] unexpected database schema; disabling provider', err);
        this.disabled = true;
        this.db?.close();
        this.db = null;
      } else {
        console.error('[opencode] scan failed', err);
      }
    } finally {
      this.busy = false;
    }
  }

  async ensureLoaded(state: SessionState) {
    if (state.loaded || this.disabled || !this.open()) return;
    await this.processSession(state, true);
  }

  async scan() {
    const db = this.open();
    if (!db) return;
    const rows = db.sessionsUpdatedAfter(this.timeCursor);
    const changedRoots = new Set<string>();
    for (const row of rows) {
      this.parentOf.set(row.id, row.parent_id);
      this.timeCursor = Math.max(this.timeCursor, row.time_updated);
      const rootId = this.rootIdOf(row.id, db);
      changedRoots.add(rootId);
    }
    for (const rootId of changedRoots) {
      const row = db.sessionById(rootId);
      if (!row) continue;
      const id = `opencode:${rootId}`;
      const state = this.store.upsertSession({
        id,
        source: 'opencode',
        project: 'opencode',
        sessionId: rootId,
        rootFile: this.dbPath(),
        sessionDir: dirname(this.dbPath()),
        lastActive: row.time_updated,
        makeNormalizer: () => new OpencodeNormalizer({ sessionId: rootId }),
      });
      const normalizer = state.normalizer as OpencodeNormalizer;
      const agents: AwvAgent[] = [];
      const events: AwvEvent[] = [];
      normalizer.applySessionRow(rowData(row), true, agents, events);
      if (agents.length || events.length) this.store.merge(state, agents, events);
      state.cwd = state.cwd || normalizer.cwd;
      state.peeked = true;
      const live = Date.now() - row.time_updated < this.livenessMs;
      if (live || state.loaded || this.store.hasExplicitInterest(state)) {
        await this.processSession(state, false);
      } else {
        state.live = false;
      }
    }
    this.store.broadcastSessions();
  }

  private processSession(state: SessionState, full: boolean) {
    if (state.processing) return state.processing;
    const p = this.doProcess(state, full).finally(() => { if (state.processing === p) state.processing = undefined; });
    state.processing = p;
    return p;
  }

  private async doProcess(state: SessionState, full: boolean) {
    const db = this.open();
    if (!db) return;
    const initial = !state.loaded;
    if (initial) state.loading = true;
    const normalizer = state.normalizer as OpencodeNormalizer;
    const tree = this.sessionTree(state.sessionId, db);
    for (const sessId of tree) {
      const row = db.sessionById(sessId);
      if (!row) continue;
      const agents: AwvAgent[] = [];
      const events: AwvEvent[] = [];
      normalizer.applySessionRow(rowData(row), sessId === state.sessionId, agents, events);
      const msgCursor = full ? '' : normalizer.messageCursor(sessId);
      const messages = db.messagesAfter(sessId, msgCursor);
      for (const m of messages) normalizer.applyMessage(sessId, m.id, rowData(m), agents, events);
      const partCursor = full ? '' : normalizer.partCursor(sessId);
      const parts = db.partsAfter(sessId, partCursor);
      for (const p of parts) normalizer.applyPart(sessId, p.id, rowData(p), agents, events);
      this.store.merge(state, agents, events);
    }
    const live = Date.now() - state.lastActive < this.livenessMs;
    if (!live) {
      const done = normalizer.finalizeIfIdle();
      if (done) this.store.merge(state, done.agents, done.events);
    }
    state.cwd = state.cwd || normalizer.cwd;
    if (initial) this.store.finishLoad(state);
    state.live = live;
  }

  private rootIdOf(id: string, db: OpencodeDb): string {
    let cur = id;
    for (let i = 0; i < 32; i++) {
      let parent = this.parentOf.get(cur);
      if (parent === undefined) {
        parent = db.parentById(cur) ?? null;
        this.parentOf.set(cur, parent);
      }
      if (!parent) return cur;
      cur = parent;
    }
    return cur;
  }

  private sessionTree(rootId: string, db: OpencodeDb): string[] {
    const out = [rootId];
    for (let i = 0; i < out.length && i < 256; i++) {
      out.push(...db.childIds(out[i]));
    }
    return out;
  }

  private dbPathCache: string | null = null;
  private dbPath(): string {
    return this.dbPathCache || join(this.dataDir, 'opencode.db');
  }

  private openFailed = false;
  private open(): OpencodeDb | null {
    if (this.db) return this.db;
    const path = findOpencodeDb(this.dataDir);
    if (!path) return null;
    try {
      this.db = openOpencodeDb(path);
      this.dbPathCache = path;
      this.openFailed = false;
      return this.db;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
        console.error('[opencode] node:sqlite is unavailable on this Node version (needs Node ≥ 22.13); disabling the opencode provider');
        this.disabled = true;
      } else if (!this.openFailed) {
        console.error('[opencode] failed to open database; will retry quietly', err);
      }
      this.openFailed = true;
      return null;
    }
  }
}

function rowData(row: { data: string }): any {
  try { return JSON.parse(row.data); } catch { return {}; }
}

function isBusyError(err: unknown): boolean {
  const msg = String((err as Error)?.message || err || '');
  return /SQLITE_BUSY|database is locked/i.test(msg);
}

function isSchemaError(err: unknown): boolean {
  const msg = String((err as Error)?.message || err || '');
  return /no such table|no such column/i.test(msg);
}

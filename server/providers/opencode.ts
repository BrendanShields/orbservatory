import { Database } from 'bun:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { AwvAgent, AwvEvent } from '../../shared/schema';
import type { SessionStore, SessionState } from '../store';
import type { SessionProvider } from './types';
import { OpencodeNormalizer } from './opencode-normalizer';

interface OpencodeOptions {
  dataDir?: string;
  pollMs?: number;
  livenessMs?: number;
}

interface SessionRow {
  id: string;
  parent_id: string | null;
  time_created: number;
  time_updated: number;
  data: string;
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
  private timer: Timer | null = null;
  private busy = false;
  private db: Database | null = null;
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
    const rows = db
      .query<SessionRow, [number]>('SELECT id, parent_id, time_created, time_updated, data FROM session WHERE time_updated > ?1 ORDER BY time_updated ASC')
      .all(this.timeCursor);
    const changedRoots = new Set<string>();
    for (const row of rows) {
      this.parentOf.set(row.id, row.parent_id);
      this.timeCursor = Math.max(this.timeCursor, row.time_updated);
      const rootId = this.rootIdOf(row.id, db);
      changedRoots.add(rootId);
    }
    for (const rootId of changedRoots) {
      const row = db
        .query<SessionRow, [string]>('SELECT id, parent_id, time_created, time_updated, data FROM session WHERE id = ?1')
        .get(rootId);
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
      normalizer.applySessionRow(rowData(row), true);
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
      const row = db
        .query<SessionRow, [string]>('SELECT id, parent_id, time_created, time_updated, data FROM session WHERE id = ?1')
        .get(sessId);
      if (!row) continue;
      const agents: AwvAgent[] = [];
      const events: AwvEvent[] = [];
      normalizer.applySessionRow(rowData(row), sessId === state.sessionId, agents, events);
      const msgCursor = full ? '' : normalizer.messageCursor(sessId);
      const messages = db
        .query<{ id: string; data: string }, [string, string]>('SELECT id, data FROM message WHERE session_id = ?1 AND id > ?2 ORDER BY id ASC')
        .all(sessId, msgCursor);
      for (const m of messages) normalizer.applyMessage(sessId, m.id, rowData(m), agents, events);
      const partCursor = full ? '' : normalizer.partCursor(sessId);
      const parts = db
        .query<{ id: string; data: string }, [string, string]>('SELECT id, data FROM part WHERE session_id = ?1 AND id > ?2 ORDER BY id ASC')
        .all(sessId, partCursor);
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

  private rootIdOf(id: string, db: Database): string {
    let cur = id;
    for (let i = 0; i < 32; i++) {
      let parent = this.parentOf.get(cur);
      if (parent === undefined) {
        const row = db.query<{ parent_id: string | null }, [string]>('SELECT parent_id FROM session WHERE id = ?1').get(cur);
        parent = row ? row.parent_id : null;
        this.parentOf.set(cur, parent);
      }
      if (!parent) return cur;
      cur = parent;
    }
    return cur;
  }

  private sessionTree(rootId: string, db: Database): string[] {
    const out = [rootId];
    for (let i = 0; i < out.length && i < 256; i++) {
      const kids = db.query<{ id: string }, [string]>('SELECT id FROM session WHERE parent_id = ?1 ORDER BY id ASC').all(out[i]);
      for (const k of kids) out.push(k.id);
    }
    return out;
  }

  private dbPathCache: string | null = null;
  private dbPath(): string {
    return this.dbPathCache || join(this.dataDir, 'opencode.db');
  }

  private open(): Database | null {
    if (this.db) return this.db;
    const path = findOpencodeDb(this.dataDir);
    if (!path) return null;
    try {
      this.db = new Database(path, { readonly: true });
      this.dbPathCache = path;
      return this.db;
    } catch (err) {
      console.error('[opencode] failed to open database; will retry', err);
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

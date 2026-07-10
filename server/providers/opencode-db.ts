import { createRequire } from 'node:module';

export interface OpencodeDb {
  close(): void;
  sessionsUpdatedAfter(timeCursor: number): SessionRow[];
  sessionById(id: string): SessionRow | undefined;
  parentById(id: string): string | null | undefined;
  childIds(parentId: string): string[];
  messagesAfter(sessionId: string, cursor: string): Array<{ id: string; data: string }>;
  partsAfter(sessionId: string, cursor: string): Array<{ id: string; data: string }>;
}

export interface SessionRow {
  id: string;
  parent_id: string | null;
  time_created: number;
  time_updated: number;
  data: string;
}

interface SQLiteDatabaseSync {
  close(): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

const require = createRequire(import.meta.url);

function openSqlite(path: string): SQLiteDatabaseSync {
  if (typeof Bun !== 'undefined') {
    const { Database } = require('bun:sqlite') as { Database: new (path: string, options: { readonly: boolean }) => SQLiteDatabaseSync };
    return new Database(path, { readonly: true });
  }
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => SQLiteDatabaseSync;
  };
  return new DatabaseSync(path, { readOnly: true });
}

export function openOpencodeDb(path: string): OpencodeDb {
  const db = openSqlite(path);
  const hasSessionData = !!db.prepare("SELECT 1 FROM pragma_table_info('session') WHERE name = 'data'").get();
  const sessionCols = hasSessionData
    ? 'id, parent_id, time_created, time_updated, data'
    : "id, parent_id, time_created, time_updated, json_object('id', id, 'title', title, 'directory', directory, 'time', json_object('created', time_created, 'updated', time_updated)) AS data";
  return {
    close: () => db.close(),
    sessionsUpdatedAfter: (timeCursor) => db
      .prepare(`SELECT ${sessionCols} FROM session WHERE time_updated > ?1 ORDER BY time_updated ASC`)
      .all(timeCursor) as SessionRow[],
    sessionById: (id) => db
      .prepare(`SELECT ${sessionCols} FROM session WHERE id = ?1`)
      .get(id) as SessionRow | undefined,
    parentById: (id) => {
      const row = db.prepare('SELECT parent_id FROM session WHERE id = ?1').get(id) as Pick<SessionRow, 'parent_id'> | undefined;
      return row?.parent_id;
    },
    childIds: (parentId) => {
      const rows = db.prepare('SELECT id FROM session WHERE parent_id = ?1 ORDER BY id ASC').all(parentId) as Array<{ id: string }>;
      return rows.map((row) => row.id);
    },
    messagesAfter: (sessionId, cursor) => db
      .prepare('SELECT id, data FROM message WHERE session_id = ?1 AND id > ?2 ORDER BY id ASC')
      .all(sessionId, cursor) as Array<{ id: string; data: string }>,
    partsAfter: (sessionId, cursor) => db
      .prepare('SELECT id, data FROM part WHERE session_id = ?1 AND id > ?2 ORDER BY id ASC')
      .all(sessionId, cursor) as Array<{ id: string; data: string }>,
  };
}

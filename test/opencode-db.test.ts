import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { openOpencodeDb } from '../server/providers/opencode-db';

function makeDb(path: string, legacy: boolean) {
  const db = new Database(path);
  if (legacy) {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(
      'ses_1', null, 1000, 2000,
      JSON.stringify({ id: 'ses_1', title: 'legacy', directory: '/tmp/x', time: { created: 1000, updated: 2000 } }),
    );
  } else {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)');
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run('ses_2', null, 'structured', '/tmp/y', 3000, 4000);
  }
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)');
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)');
  db.close();
}

describe('openOpencodeDb', () => {
  test('reads legacy schema with session.data column', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ocdb-')), 'opencode.db');
    makeDb(path, true);
    const db = openOpencodeDb(path);
    const rows = db.sessionsUpdatedAfter(0);
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0].data).title).toBe('legacy');
    expect(db.sessionById('ses_1')?.time_updated).toBe(2000);
    db.close();
  });

  test('reads structured schema without session.data column', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ocdb-')), 'opencode.db');
    makeDb(path, false);
    const db = openOpencodeDb(path);
    const rows = db.sessionsUpdatedAfter(0);
    expect(rows.length).toBe(1);
    const data = JSON.parse(rows[0].data);
    expect(data.title).toBe('structured');
    expect(data.directory).toBe('/tmp/y');
    expect(data.time.created).toBe(3000);
    expect(db.sessionById('ses_2')?.parent_id).toBeNull();
    db.close();
  });
});

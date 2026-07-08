import { join } from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import type { SearchPart, SessionStatsBase } from '../shared/schema';
import { hashStr } from '../shared/order';
import { configDir } from './settings';

export interface CachedSessionRecord {
  /** Source file-set fingerprint (path:mtime:size per file) the record was computed from. */
  fingerprint: string;
  stats: SessionStatsBase;
  search: SearchPart[];
}

export interface FileStamp {
  path: string;
  mtimeMs: number;
  size: number;
}

/** Canonical fingerprint for a session's source file set — any change invalidates. */
export function fingerprintOf(files: FileStamp[]): string {
  return files
    .map((f) => `${f.path}:${Math.round(f.mtimeMs)}:${f.size}`)
    .sort()
    .join('|');
}

/**
 * Disk sidecar for full-parse outputs (stats + search text), keyed by session id
 * and guarded by the source fingerprint. A changed file never serves stale data.
 */
export class StatsCache {
  private dir: string;
  private ready: Promise<void> | null = null;

  constructor(dir?: string) {
    this.dir = dir || join(configDir(), 'stats-cache');
  }

  private fileFor(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(-80);
    return join(this.dir, `${safe}.${hashStr(sessionId).toString(16)}.json`);
  }

  async get(sessionId: string, fingerprint: string): Promise<CachedSessionRecord | null> {
    try {
      const rec = JSON.parse(await readFile(this.fileFor(sessionId), 'utf8')) as CachedSessionRecord;
      if (!rec || rec.fingerprint !== fingerprint || !rec.stats || !Array.isArray(rec.search)) return null;
      return rec;
    } catch {
      return null;
    }
  }

  async put(sessionId: string, rec: CachedSessionRecord): Promise<void> {
    if (!this.ready) this.ready = mkdir(this.dir, { recursive: true }).then(() => {});
    await this.ready;
    const file = this.fileFor(sessionId);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(rec));
      await rename(tmp, file);
    } catch {
      await unlink(tmp).catch(() => {});
    }
  }
}

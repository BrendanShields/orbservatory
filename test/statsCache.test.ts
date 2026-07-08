import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatsCache, fingerprintOf, type CachedSessionRecord, type FileStamp } from '../server/statsCache';
import type { SessionStatsBase } from '../shared/schema';

let dir = '';

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cviz-cache-')); });
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const stamp = (path: string, mtimeMs: number, size: number): FileStamp => ({ path, mtimeMs, size });

const baseStats = (sessionId: string): SessionStatsBase => ({
  sessionId,
  tokens: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0, total: 3 },
  tokensByModel: {},
  toolCalls: 0,
  toolBreakdown: {},
  distinctTools: 0,
  skills: {},
  subagentCount: 0,
  treeDepth: 0,
  compactions: 0,
  retries: 0,
  errors: 0,
  userTurns: 1,
  durationMs: 1000,
  models: [],
  firstActive: 1_700_000_000_000,
  lastActive: 1_700_000_001_000,
});

const record = (sessionId: string, fingerprint: string): CachedSessionRecord => ({
  fingerprint,
  stats: baseStats(sessionId),
  search: [{ f: 'prompt', s: 'hello world' }],
});

test('fingerprint is order-independent over the file set', () => {
  const a = stamp('/r/p/s1.jsonl', 1000, 10);
  const b = stamp('/r/p/s1/subagents/agent-a.jsonl', 2000, 20);
  expect(fingerprintOf([a, b])).toBe(fingerprintOf([b, a]));
});

test('fingerprint changes when mtime or size changes', () => {
  const orig = fingerprintOf([stamp('/r/p/s1.jsonl', 1000, 10)]);
  expect(fingerprintOf([stamp('/r/p/s1.jsonl', 1001, 10)])).not.toBe(orig);
  expect(fingerprintOf([stamp('/r/p/s1.jsonl', 1000, 11)])).not.toBe(orig);
});

test('put then get with a matching fingerprint round-trips (cache hit)', async () => {
  const cache = new StatsCache(dir);
  const rec = record('demo/s1', 'fp-1');
  await cache.put('demo/s1', rec);
  expect(await cache.get('demo/s1', 'fp-1')).toEqual(rec);
});

test('a stale fingerprint invalidates the cached record (source changed)', async () => {
  const cache = new StatsCache(dir);
  await cache.put('demo/s1', record('demo/s1', 'fp-1'));
  expect(await cache.get('demo/s1', 'fp-2')).toBeNull();
});

test('unknown sessions miss', async () => {
  const cache = new StatsCache(dir);
  expect(await cache.get('demo/never-seen', 'fp-1')).toBeNull();
});

test('records persist across cache instances (disk sidecar)', async () => {
  await new StatsCache(dir).put('demo/s1', record('demo/s1', 'fp-1'));
  expect(await new StatsCache(dir).get('demo/s1', 'fp-1')).not.toBeNull();
});

test('distinct session ids never collide even when sanitized names match', async () => {
  const cache = new StatsCache(dir);
  await cache.put('demo/a b', record('demo/a b', 'fp-1'));
  await cache.put('demo/a_b', record('demo/a_b', 'fp-1'));
  const first = await cache.get('demo/a b', 'fp-1');
  const second = await cache.get('demo/a_b', 'fp-1');
  expect(first!.stats.sessionId).toBe('demo/a b');
  expect(second!.stats.sessionId).toBe('demo/a_b');
});

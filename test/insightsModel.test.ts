import { describe, expect, test } from 'bun:test';
import type { SessionStats, SessionSummary, SessionTier } from '../shared/schema';
import { bucketByDay } from '../web/insightsModel';

function sum(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id, source: 'claude', project: '/tmp/p', projectName: 'proj', title: `Session ${id}`,
    live: false, lastActive: 1000, eventCount: 10, agentCount: 1, ...over,
  };
}

function stats(sessionId: string, over: Partial<SessionStats> = {}): SessionStats {
  return {
    sessionId,
    tokens: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, total: 150 },
    tokensByModel: { 'claude-opus-4-8': { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, total: 150 } },
    toolCalls: 5, toolBreakdown: { Bash: 3, Read: 2 }, distinctTools: 2,
    skills: {}, subagentCount: 0, treeDepth: 1, compactions: 0, retries: 0, errors: 0,
    userTurns: 2, durationMs: 60_000, models: ['claude-opus-4-8'],
    firstActive: 0, lastActive: 1000, tier: 'simple' as SessionTier, ...over,
  };
}

/** Local-time epoch ms in whatever TZ is active (month is 1-based). */
function at(y: number, mo: number, d: number, hh = 12, mm = 0): number {
  return new Date(y, mo - 1, d, hh, mm).getTime();
}

function inTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
}

describe('bucketByDay day iteration', () => {
  test('7 consecutive local calendar days across US spring-forward (23h day)', () => inTZ('America/New_York', () => {
    const now = at(2026, 3, 11);
    const early = sum('a', { lastActive: at(2026, 3, 8, 1, 30) });
    const late = sum('b', { lastActive: at(2026, 3, 8, 23, 30) });
    const { buckets } = bucketByDay([], [early, late], { days: 7, now });
    expect(buckets.map((b) => b.day)).toEqual([
      '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10', '2026-03-11',
    ]);
    expect(buckets[3].sessions).toBe(2);
  }));

  test('7 consecutive local calendar days across US fall-back (25h day)', () => inTZ('America/New_York', () => {
    const now = at(2026, 11, 4);
    const s = sum('a', { lastActive: at(2026, 11, 1, 1, 30) });
    const { buckets } = bucketByDay([], [s], { days: 7, now });
    expect(buckets.map((b) => b.day)).toEqual([
      '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04',
    ]);
    expect(buckets[3].sessions).toBe(1);
  }));

  test('range spans month and year boundaries', () => inTZ('America/New_York', () => {
    const { buckets } = bucketByDay([], [], { days: 7, now: at(2027, 1, 2) });
    expect(buckets.map((b) => b.day)).toEqual([
      '2026-12-27', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02',
    ]);
  }));

  test('30/90-day ranges return one bucket per day, zeroed when empty', () => inTZ('America/New_York', () => {
    const now = at(2026, 7, 12);
    const r30 = bucketByDay([], [], { days: 30, now });
    const r90 = bucketByDay([], [], { days: 90, now });
    expect(r30.buckets.length).toBe(30);
    expect(r90.buckets.length).toBe(90);
    expect(new Set(r90.buckets.map((b) => b.day)).size).toBe(90);
    expect(r30.buckets.at(-1)!.day).toBe('2026-07-12');
    for (const b of r30.buckets) {
      expect(b.sessions).toBe(0);
      expect(b.analysed).toBe(0);
      expect(b.tokens.total).toBe(0);
      expect(b.cacheRate).toBeNull();
      expect(b.costByModel).toEqual({});
    }
  }));
});

describe('bucketByDay range edges + clamping', () => {
  const now = () => at(2026, 7, 12, 15);

  test('session exactly at day-0 local midnight is included; 1ms earlier is excluded', () => inTZ('America/New_York', () => {
    const edge = sum('edge', { lastActive: at(2026, 7, 6, 0, 0) });
    const before = sum('before', { lastActive: at(2026, 7, 6, 0, 0) - 1 });
    const { buckets, total } = bucketByDay([], [edge, before], { days: 7, now: now() });
    expect(buckets[0].day).toBe('2026-07-06');
    expect(buckets[0].sessions).toBe(1);
    expect(total).toBe(1);
  }));

  test('today is the last bucket and receives now-stamped sessions', () => inTZ('America/New_York', () => {
    const s = sum('a', { lastActive: now() });
    const { buckets } = bucketByDay([], [s], { days: 7, now: now() });
    expect(buckets.at(-1)!.day).toBe('2026-07-12');
    expect(buckets.at(-1)!.sessions).toBe(1);
  }));

  test('future lastActive clamps to today', () => inTZ('America/New_York', () => {
    const s = sum('a', { lastActive: now() + 3 * 86_400_000 });
    const st = stats('a', { lastActive: now() + 3 * 86_400_000 });
    const { buckets, total, analysed } = bucketByDay([st], [s], { days: 7, now: now() });
    expect(buckets.at(-1)!.sessions).toBe(1);
    expect(buckets.at(-1)!.analysed).toBe(1);
    expect(total).toBe(1);
    expect(analysed).toBe(1);
  }));

  test('attribution prefers stats.lastActive over the summary, falling back when 0', () => inTZ('America/New_York', () => {
    const a = sum('a', { lastActive: at(2026, 7, 8) });
    const sa = stats('a', { lastActive: at(2026, 7, 10) });
    const b = sum('b', { lastActive: at(2026, 7, 9) });
    const sb = stats('b', { lastActive: 0 });
    const { buckets } = bucketByDay([sa, sb], [a, b], { days: 7, now: now() });
    expect(buckets.find((x) => x.day === '2026-07-10')!.sessions).toBe(1);
    expect(buckets.find((x) => x.day === '2026-07-08')!.sessions).toBe(0);
    expect(buckets.find((x) => x.day === '2026-07-09')!.sessions).toBe(1);
  }));
});

describe('bucketByDay filtering + counts', () => {
  const now = () => at(2026, 7, 12, 15);

  test('project filter matches projectName || project (home semantics)', () => inTZ('America/New_York', () => {
    const a = sum('a', { projectName: 'alpha', lastActive: now() });
    const b = sum('b', { projectName: 'beta', lastActive: now() });
    const c = sum('c', { projectName: '', project: '/tmp/alpha', lastActive: now() });
    const sts = [stats('a', { lastActive: now() }), stats('b', { lastActive: now() })];
    const alpha = bucketByDay(sts, [a, b, c], { days: 7, project: 'alpha', now: now() });
    expect(alpha.total).toBe(1);
    expect(alpha.analysed).toBe(1);
    expect(alpha.buckets.at(-1)!.tokens.total).toBe(150);
    const byPath = bucketByDay(sts, [a, b, c], { days: 7, project: '/tmp/alpha', now: now() });
    expect(byPath.total).toBe(1);
    expect(byPath.analysed).toBe(0);
  }));

  test('sessions without stats count in sessions/total but contribute no sums', () => inTZ('America/New_York', () => {
    const a = sum('a', { lastActive: now() });
    const b = sum('b', { lastActive: now() });
    const { buckets, total, analysed } = bucketByDay([stats('a', { lastActive: now() })], [a, b], { days: 7, now: now() });
    const today = buckets.at(-1)!;
    expect(total).toBe(2);
    expect(analysed).toBe(1);
    expect(today.sessions).toBe(2);
    expect(today.analysed).toBe(1);
    expect(today.tokens.total).toBe(150);
    expect(today.toolCalls).toBe(5);
  }));

  test('total/analysed only count in-range sessions', () => inTZ('America/New_York', () => {
    const inRange = sum('a', { lastActive: now() });
    const old = sum('b', { lastActive: at(2026, 5, 1) });
    const { total, analysed } = bucketByDay([stats('b', { lastActive: at(2026, 5, 1) })], [inRange, old], { days: 7, now: now() });
    expect(total).toBe(1);
    expect(analysed).toBe(0);
  }));

  test('stats without a matching summary are ignored', () => inTZ('America/New_York', () => {
    const { buckets, total, analysed } = bucketByDay([stats('ghost', { lastActive: now() })], [], { days: 7, now: now() });
    expect(total).toBe(0);
    expect(analysed).toBe(0);
    expect(buckets.at(-1)!.tokens.total).toBe(0);
  }));

  test('tokens and tool calls sum across a day', () => inTZ('America/New_York', () => {
    const mk = (id: string) => sum(id, { lastActive: now() });
    const sts = [
      stats('a', { lastActive: now(), tokens: { input: 10, output: 5, cacheRead: 30, cacheCreation: 2, total: 47 }, toolCalls: 3 }),
      stats('b', { lastActive: now(), tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, toolCalls: 4 }),
    ];
    const { buckets } = bucketByDay(sts, [mk('a'), mk('b')], { days: 7, now: now() });
    const today = buckets.at(-1)!;
    expect(today.tokens).toEqual({ input: 11, output: 6, cacheRead: 30, cacheCreation: 2, total: 49 });
    expect(today.toolCalls).toBe(7);
  }));
});

describe('bucketByDay cache rate + cost', () => {
  const now = () => at(2026, 7, 12, 15);

  test('cacheRate = cacheRead / (input + cacheRead); null when the denominator is 0', () => inTZ('America/New_York', () => {
    const a = sum('a', { lastActive: now() });
    const b = sum('b', { lastActive: at(2026, 7, 10) });
    const sts = [
      stats('a', { lastActive: now(), tokens: { input: 100, output: 10, cacheRead: 300, cacheCreation: 0, total: 410 } }),
      stats('b', { lastActive: at(2026, 7, 10), tokens: { input: 0, output: 50, cacheRead: 0, cacheCreation: 10, total: 60 } }),
    ];
    const { buckets } = bucketByDay(sts, [a, b], { days: 7, now: now() });
    expect(buckets.at(-1)!.cacheRate).toBe(0.75);
    expect(buckets.find((x) => x.day === '2026-07-10')!.cacheRate).toBeNull();
    expect(buckets[0].cacheRate).toBeNull();
  }));

  test('costUsd attributes wholly to the session last model; unpriced sessions add nothing', () => inTZ('America/New_York', () => {
    const mk = (id: string) => sum(id, { lastActive: now() });
    const sts = [
      stats('a', { lastActive: now(), costUsd: 2.5, models: ['claude-haiku-4', 'claude-opus-4-8'] }),
      stats('b', { lastActive: now(), costUsd: 1.5, models: ['claude-opus-4-8'] }),
      stats('c', { lastActive: now(), models: ['claude-opus-4-8'] }),
    ];
    const { buckets, analysed } = bucketByDay(sts, [mk('a'), mk('b'), mk('c')], { days: 7, now: now() });
    expect(buckets.at(-1)!.costByModel).toEqual({ 'claude-opus-4-8': 4 });
    expect(analysed).toBe(3);
  }));

  test('cost split lands on separate days and models', () => inTZ('America/New_York', () => {
    const a = sum('a', { lastActive: at(2026, 7, 11) });
    const b = sum('b', { lastActive: now() });
    const sts = [
      stats('a', { lastActive: at(2026, 7, 11), costUsd: 1, models: ['m1'] }),
      stats('b', { lastActive: now(), costUsd: 0.25, models: ['m2'] }),
    ];
    const { buckets } = bucketByDay(sts, [a, b], { days: 7, now: now() });
    expect(buckets.find((x) => x.day === '2026-07-11')!.costByModel).toEqual({ m1: 1 });
    expect(buckets.at(-1)!.costByModel).toEqual({ m2: 0.25 });
  }));
});

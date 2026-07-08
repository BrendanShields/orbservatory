import { describe, expect, test } from 'bun:test';
import type { SessionStats, SessionSummary, SessionTier } from '../shared/schema';
import { EMPTY_FILTER, aggregate, buildRows, facetOptions, filterRows, sortRows } from '../web/homeModel';

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

function rowsOf(pairs: [SessionSummary, SessionStats | undefined][]) {
  const map = new Map<string, SessionStats>();
  for (const [s, st] of pairs) if (st) map.set(s.id, st);
  return buildRows(pairs.map(([s]) => s), map);
}

describe('filterRows', () => {
  const rows = rowsOf([
    [sum('a', { live: true, projectName: 'alpha' }), stats('a', { tier: 'complex', skills: { dataviz: 2 }, models: ['claude-opus-4-8'] })],
    [sum('b', { projectName: 'beta', title: 'Fix flaky CI' }), stats('b', { tier: 'simple', toolBreakdown: { Grep: 4 } })],
    [sum('c', { projectName: 'alpha', source: 'codex' }), undefined],
  ]);

  test('empty filter keeps everything', () => {
    expect(filterRows(rows, EMPTY_FILTER).length).toBe(3);
  });

  test('liveOnly / source / project facets use summaries (work without stats)', () => {
    expect(filterRows(rows, { ...EMPTY_FILTER, liveOnly: true }).map((r) => r.sum.id)).toEqual(['a']);
    expect(filterRows(rows, { ...EMPTY_FILTER, source: 'codex' }).map((r) => r.sum.id)).toEqual(['c']);
    expect(filterRows(rows, { ...EMPTY_FILTER, project: 'alpha' }).map((r) => r.sum.id)).toEqual(['a', 'c']);
  });

  test('stats-backed facets exclude sessions whose stats are still pending', () => {
    expect(filterRows(rows, { ...EMPTY_FILTER, tier: 'complex' }).map((r) => r.sum.id)).toEqual(['a']);
    expect(filterRows(rows, { ...EMPTY_FILTER, skill: 'dataviz' }).map((r) => r.sum.id)).toEqual(['a']);
    expect(filterRows(rows, { ...EMPTY_FILTER, tool: 'Grep' }).map((r) => r.sum.id)).toEqual(['b']);
    expect(filterRows(rows, { ...EMPTY_FILTER, model: 'claude-opus-4-8' }).map((r) => r.sum.id).sort()).toEqual(['a', 'b']);
  });

  test('text matches title, project, model, skill, tool metadata', () => {
    expect(filterRows(rows, { ...EMPTY_FILTER, text: 'flaky' }).map((r) => r.sum.id)).toEqual(['b']);
    expect(filterRows(rows, { ...EMPTY_FILTER, text: 'dataviz' }).map((r) => r.sum.id)).toEqual(['a']);
    expect(filterRows(rows, { ...EMPTY_FILTER, text: 'alpha' }).map((r) => r.sum.id)).toEqual(['a', 'c']);
  });

  test('server full-text ids extend metadata matches', () => {
    const f = { ...EMPTY_FILTER, text: 'zzz-not-in-metadata', textIds: new Set(['c']) };
    expect(filterRows(rows, f).map((r) => r.sum.id)).toEqual(['c']);
  });
});

describe('sortRows', () => {
  const rows = rowsOf([
    [sum('a', { lastActive: 3000 }), stats('a', { lastActive: 3000, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 10 }, tier: 'moderate', durationMs: 5 })],
    [sum('b', { lastActive: 1000 }), stats('b', { lastActive: 1000, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 900 }, tier: 'complex', durationMs: 50, costUsd: 2 })],
    [sum('c', { lastActive: 2000 }), undefined],
  ]);

  test('recent desc falls back to summary lastActive for stats-less rows', () => {
    expect(sortRows(rows, 'recent').map((r) => r.sum.id)).toEqual(['a', 'c', 'b']);
  });

  test('tokens desc puts missing stats last', () => {
    expect(sortRows(rows, 'tokens').map((r) => r.sum.id)).toEqual(['b', 'a', 'c']);
  });

  test('asc order flips', () => {
    expect(sortRows(rows, 'tokens', false).map((r) => r.sum.id)).toEqual(['c', 'a', 'b']);
  });

  test('tier ranks simple<moderate<complex; cost treats unpriced as smallest', () => {
    expect(sortRows(rows, 'tier').map((r) => r.sum.id)).toEqual(['b', 'a', 'c']);
    expect(sortRows(rows, 'cost')[0].sum.id).toBe('b');
  });
});

describe('aggregate', () => {
  const rows = rowsOf([
    [sum('a', { live: true }), stats('a', {
      tokens: { input: 10, output: 5, cacheRead: 100, cacheCreation: 20, total: 135 },
      costUsd: 1.5, toolCalls: 7, subagentCount: 2, tier: 'complex',
      skills: { dataviz: 1 }, toolBreakdown: { Bash: 7 },
      tokensByModel: { m1: { input: 10, output: 5, cacheRead: 100, cacheCreation: 20, total: 135 } },
    })],
    [sum('b'), stats('b', {
      tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 },
      toolCalls: 3, tier: 'simple', skills: { dataviz: 2, dd: 1 }, toolBreakdown: { Read: 3 },
      tokensByModel: { m2: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 } },
    })],
    [sum('c'), undefined],
  ]);
  const agg = aggregate(rows);

  test('counts + readiness', () => {
    expect(agg.count).toBe(3);
    expect(agg.liveCount).toBe(1);
    expect(agg.statsReady).toBe(2);
  });

  test('token totals with cache split', () => {
    expect(agg.tokens).toEqual({ input: 11, output: 6, cacheRead: 100, cacheCreation: 20, total: 137 });
  });

  test('cost sums priced rows only and reports coverage', () => {
    expect(agg.costUsd).toBe(1.5);
    expect(agg.pricedCount).toBe(1);
  });

  test('tool calls, subagents, tiers, tops', () => {
    expect(agg.toolCalls).toBe(10);
    expect(agg.subagents).toBe(2);
    expect(agg.tiers).toEqual({ simple: 1, moderate: 0, complex: 1 });
    expect(agg.topSkills[0]).toEqual(['dataviz', 3]);
    expect(agg.topTools[0]).toEqual(['Bash', 7]);
    expect(agg.models[0]).toEqual(['m1', 135]);
  });

  test('empty set aggregates to zeros', () => {
    const empty = aggregate([]);
    expect(empty.count).toBe(0);
    expect(empty.tokens.total).toBe(0);
    expect(empty.topSkills).toEqual([]);
  });
});

describe('facetOptions', () => {
  test('collects distinct values, frequency-ordered', () => {
    const rows = rowsOf([
      [sum('a', { projectName: 'alpha' }), stats('a', { models: ['m1'], skills: { s1: 1 } })],
      [sum('b', { projectName: 'alpha' }), stats('b', { models: ['m1', 'm2'], toolBreakdown: { Grep: 1 } })],
      [sum('c', { projectName: 'beta' }), undefined],
    ]);
    const f = facetOptions(rows);
    expect(f.projects).toEqual(['alpha', 'beta']);
    expect(f.models).toEqual(['m1', 'm2']);
    expect(f.skills).toEqual(['s1']);
    expect(f.tools).toEqual(['Bash', 'Grep', 'Read']); // all freq 1 → alphabetical tie-break
  });
});

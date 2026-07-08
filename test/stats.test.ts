import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../server/store';
import { ClaudeProjectWatcher } from '../server/watch';
import { DEFAULT_TIER_THRESHOLDS, computeSessionStats, costUsdOf, finalizeStats, tierOf } from '../server/stats';
import type { AwvEvent, SessionStats } from '../shared/schema';

let root = '';
const project = 'demo';
const sessionId = 's1';
const id = `${project}/${sessionId}`;

function rootFile() { return join(root, project, `${sessionId}.jsonl`); }
function subFile(name: string) { return join(root, project, sessionId, 'subagents', name); }

const line = (obj: unknown) => JSON.stringify(obj) + '\n';
const userLine = (t: string, content: string) => line({ type: 'user', timestamp: t, cwd: '/x', message: { content } });
const asstLine = (t: string, msg: Record<string, unknown>) => line({ type: 'assistant', timestamp: t, message: msg });
const toolUse = (tid: string, name: string, input: unknown) => ({ type: 'tool_use', id: tid, name, input });
const toolResultLine = (t: string, toolUseId: string, opts?: { error?: boolean }) =>
  line({ type: 'user', timestamp: t, message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: !!opts?.error, content: opts?.error ? 'boom' : 'ok' }] } });

async function scanned() {
  const store = new SessionStore();
  const watcher = new ClaudeProjectWatcher(store, { root, pollMs: 60_000, watchFs: false });
  await watcher.scan();
  const state = store.get(id)!;
  const stats = store.allStats().find((s) => s.sessionId === id)!;
  return { store, state, stats };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cviz-stats-'));
  await mkdir(join(root, project), { recursive: true });
});

afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test('sums tokens overall and per model', async () => {
  await writeFile(rootFile(),
    userLine('2026-07-08T00:00:00.000Z', 'sum my tokens') +
    asstLine('2026-07-08T00:00:01.000Z', {
      id: 'm1', model: 'claude-opus-4-8',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
      content: [],
    }) +
    asstLine('2026-07-08T00:00:02.000Z', {
      id: 'm2', model: 'claude-haiku-4-5-20251001',
      usage: { input_tokens: 20, output_tokens: 30 },
      content: [],
    }));
  const { stats } = await scanned();
  expect(stats.tokens).toEqual({ input: 120, output: 80, cacheRead: 10, cacheCreation: 5, total: 215 });
  expect(stats.tokensByModel['claude-opus-4-8'].total).toBe(165);
  expect(stats.tokensByModel['claude-haiku-4-5-20251001'].total).toBe(50);
  expect(stats.models.sort()).toEqual(['claude-haiku-4-5-20251001', 'claude-opus-4-8']);
  expect(stats.userTurns).toBe(1);
});

test('breaks down tool calls and counts skill invocations', async () => {
  await writeFile(rootFile(),
    userLine('2026-07-08T00:00:00.000Z', 'go') +
    asstLine('2026-07-08T00:00:01.000Z', { id: 'm1', content: [toolUse('t1', 'Read', { file_path: 'a.ts' }), toolUse('t2', 'Bash', { command: 'ls' })] }) +
    asstLine('2026-07-08T00:00:02.000Z', { id: 'm2', content: [toolUse('t3', 'Read', { file_path: 'b.ts' })] }) +
    asstLine('2026-07-08T00:00:03.000Z', { id: 'm3', content: [toolUse('t4', 'Skill', { skill: 'dataviz' })] }));
  const { stats } = await scanned();
  expect(stats.toolCalls).toBe(4);
  expect(stats.toolBreakdown).toEqual({ Read: 2, Bash: 1, Skill: 1 });
  expect(stats.distinctTools).toBe(3);
  expect(stats.skills).toEqual({ dataviz: 1 });
});

test('counts subagents and measures tree depth from spawn parents', async () => {
  await writeFile(rootFile(),
    userLine('2026-07-08T00:00:00.000Z', 'go') +
    asstLine('2026-07-08T00:00:01.000Z', { id: 'm1', content: [toolUse('toolu_a', 'Agent', { subagent_type: 'Explore', description: 'survey' })] }));
  await mkdir(join(root, project, sessionId, 'subagents'), { recursive: true });
  await writeFile(subFile('agent-a.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'survey', toolUseId: 'toolu_a' }));
  await writeFile(subFile('agent-a.jsonl'), asstLine('2026-07-08T00:00:02.000Z', { id: 'm2', usage: { input_tokens: 30 }, content: [] }));
  const { stats } = await scanned();
  expect(stats.subagentCount).toBe(1);
  expect(stats.treeDepth).toBe(1);
});

test('a large context-total drop counts as a compaction', async () => {
  await writeFile(rootFile(),
    userLine('2026-07-08T00:00:00.000Z', 'go') +
    asstLine('2026-07-08T00:00:01.000Z', { id: 'm1', usage: { input_tokens: 50_000 }, content: [] }) +
    asstLine('2026-07-08T00:00:02.000Z', { id: 'm2', usage: { input_tokens: 1_000 }, content: [] }));
  const { stats } = await scanned();
  expect(stats.compactions).toBe(1);
});

test('failed tool results count as errors', async () => {
  await writeFile(rootFile(),
    userLine('2026-07-08T00:00:00.000Z', 'go') +
    asstLine('2026-07-08T00:00:01.000Z', { id: 'm1', content: [toolUse('t1', 'Bash', { command: 'false' })] }) +
    toolResultLine('2026-07-08T00:00:02.000Z', 't1', { error: true }));
  const { stats } = await scanned();
  expect(stats.errors).toBe(1);
});

test('retry events are tallied', async () => {
  await writeFile(rootFile(), userLine('2026-07-08T00:00:00.000Z', 'go'));
  const { state } = await scanned();
  const retry = { t: 10, type: 'retry', agent: `session:${sessionId}` } as AwvEvent;
  const base = computeSessionStats({ id, normalizer: state.normalizer, events: [...state.events, retry] });
  expect(base.retries).toBe(1);
});

test('unparseable lines flag the stats as partial', async () => {
  await writeFile(rootFile(), userLine('2026-07-08T00:00:00.000Z', 'go'));
  await appendFile(rootFile(), 'this is not json\n');
  const { stats } = await scanned();
  expect(stats.partial).toBe(true);
});

test('clean sessions are not flagged partial', async () => {
  await writeFile(rootFile(), userLine('2026-07-08T00:00:00.000Z', 'go'));
  const { stats } = await scanned();
  expect(stats.partial).toBeUndefined();
});

// --- tier bucketing (pure) ---

const th = DEFAULT_TIER_THRESHOLDS;
const b = (subagentCount: number, toolCalls: number, compactions = 0) => ({ subagentCount, toolCalls, compactions });

test('tier bucketing follows the thresholds', () => {
  expect(tierOf(b(0, 0), th)).toBe('simple');
  expect(tierOf(b(0, th.simpleMaxTools - 1), th)).toBe('simple');
  expect(tierOf(b(0, th.simpleMaxTools), th)).toBe('moderate');
  expect(tierOf(b(1, 3), th)).toBe('moderate'); // any subagent leaves "simple"
  expect(tierOf(b(th.complexMinSubagents, 0), th)).toBe('complex');
  expect(tierOf(b(0, th.complexMinTools), th)).toBe('complex');
  expect(tierOf(b(0, 0, 1), th)).toBe('complex'); // any compaction is complex
});

// --- cost (pure) ---

const tok = (input: number, output: number, cacheRead = 0, cacheCreation = 0) =>
  ({ input, output, cacheRead, cacheCreation, total: input + output + cacheRead + cacheCreation });

test('cost sums per-model rates over used tokens', () => {
  const pricing = { m1: { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 } };
  const usd = costUsdOf({ m1: tok(1_000_000, 1_000_000, 1_000_000, 1_000_000) }, pricing);
  expect(usd).toBeCloseTo(3 + 15 + 0.3 + 3.75, 6);
});

test('cost is undefined when any used model is unpriced or nothing was used', () => {
  const pricing = { m1: { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 } };
  expect(costUsdOf({ m1: tok(10, 10), mystery: tok(10, 10) }, pricing)).toBeUndefined();
  expect(costUsdOf({}, pricing)).toBeUndefined();
});

test('finalizeStats applies tier and only attaches cost when priced', async () => {
  await writeFile(rootFile(),
    userLine('2026-07-08T00:00:00.000Z', 'go') +
    asstLine('2026-07-08T00:00:01.000Z', { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 500 }, content: [] }));
  const { state } = await scanned();
  const base = computeSessionStats({ id, normalizer: state.normalizer, events: state.events });

  const unpriced: SessionStats = finalizeStats(base, { pricing: {}, tierThresholds: th });
  expect(unpriced.tier).toBe('simple');
  expect(unpriced.costUsd).toBeUndefined();

  const priced = finalizeStats(base, { pricing: { 'claude-opus-4-8': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 } }, tierThresholds: th });
  expect(priced.costUsd).toBeCloseTo((1000 * 3 + 500 * 15) / 1e6, 9);
});

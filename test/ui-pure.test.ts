import { expect, test } from 'bun:test';
import { paletteCandidates, type NodeCandidate } from '../web/palette';
import { filterAgents, logFilter, dedupeKicker, followIndex, prependAnchor, transcriptTabVisible } from '../web/panels';
import type { SessionSummary } from '../shared/schema';
import type { EngineAgent } from '../web/engine';

const sum = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id, source: 'claude', project: `-x-${id}`, projectName: `proj-${id}`, title: `Fix bug ${id}`,
  live: false, lastActive: 1000, eventCount: 1, agentCount: 1, ...over,
});

const NODES: NodeCandidate[] = [
  { id: 'n1', name: 'reviewer', task: 'review the diff', status: 'active', color: '#fff' },
  { id: 'n2', name: 'builder', task: 'compile things', status: 'complete', color: '#fff' },
];
const COMMANDS = [
  { id: 'import', label: 'Import session…' },
  { id: 'export', label: 'Export session', disabled: true },
  { id: 'settings', label: 'Settings' },
];

test('paletteCandidates mixes sections in order: sessions, nodes, commands', () => {
  const sessions = [{ sum: sum('a', { title: 'review pass' }) }, { sum: sum('b') }];
  const rows = paletteCandidates('review', sessions, NODES, COMMANDS);
  const kinds = rows.map(r => r.kind);
  expect(kinds).toEqual(['session', 'node']);
  const rows2 = paletteCandidates('se', sessions, NODES, COMMANDS);
  expect(rows2.some(r => r.kind === 'command')).toBe(true);
  expect(rows2.findIndex(r => r.kind === 'command')).toBeGreaterThan(rows2.findIndex(r => r.kind === 'session'));
});

test('paletteCandidates empty query: recent sessions + all commands, no nodes', () => {
  const sessions = [{ sum: sum('a') }, { sum: sum('b', { live: true }) }];
  const rows = paletteCandidates('', sessions, NODES, COMMANDS);
  expect(rows.filter(r => r.kind === 'node').length).toBe(0);
  expect(rows.filter(r => r.kind === 'command').length).toBe(3);
  const first = rows[0];
  expect(first.kind === 'session' && first.sum.id).toBe('b');
});

test('paletteCandidates with no active session still lists sessions and commands', () => {
  const rows = paletteCandidates('fix', [{ sum: sum('a') }], [], COMMANDS);
  expect(rows.some(r => r.kind === 'session')).toBe(true);
  expect(rows.some(r => r.kind === 'node')).toBe(false);
});

test('paletteCandidates matches nodes on name or task, carries disabled flag', () => {
  const rows = paletteCandidates('compile', [], NODES, COMMANDS);
  expect(rows.filter(r => r.kind === 'node').map(r => (r as any).node.id)).toEqual(['n2']);
  const exp = paletteCandidates('export', [], [], COMMANDS).find(r => r.kind === 'command') as any;
  expect(exp.cmd.disabled).toBe(true);
});

const agent = (name: string, task?: string) => ({ a: { def: { name, task } } as unknown as EngineAgent });

test('filterAgents matches name/task substring, case-insensitive; empty query is identity', () => {
  const vis = [agent('Reviewer', 'audit diff'), agent('builder', 'compile'), agent('scout')];
  expect(filterAgents(vis, '')).toEqual(vis);
  expect(filterAgents(vis, 'REVIEW').length).toBe(1);
  expect(filterAgents(vis, 'compile').length).toBe(1);
  expect(filterAgents(vis, 'zzz').length).toBe(0);
});

test('logFilter buckets', () => {
  expect(logFilter('all', { type: 'tool' })).toBe(true);
  expect(logFilter('tools', { type: 'tool' })).toBe(true);
  expect(logFilter('tools', { type: 'message' })).toBe(false);
  for (const t of ['message', 'spawn', 'complete', 'compact']) expect(logFilter('messages', { type: t })).toBe(true);
  expect(logFilter('messages', { type: 'tool' })).toBe(false);
  expect(logFilter('errors', { type: 'error' })).toBe(true);
  expect(logFilter('errors', { type: 'retry' })).toBe(true);
  expect(logFilter('errors', { type: 'tool' })).toBe(false);
});

test('dedupeKicker collapses consecutive duplicate segments', () => {
  expect(dedupeKicker(['root', 'root', 'claude'])).toBe('root · claude');
  expect(dedupeKicker(['agent', 'child of x', 'claude'])).toBe('agent · child of x · claude');
  expect(dedupeKicker(['root', undefined, 'root'])).toBe('root');
});

test('followIndex picks the latest row with t <= simT across non-monotonic append order', () => {
  const items = [{ t: 0 }, { t: 1000 }, { t: 5000 }, { t: 2000 }];
  expect(followIndex([], 100)).toBe(-1);
  expect(followIndex(items, -1)).toBe(-1);
  expect(followIndex(items, 0)).toBe(0);
  expect(followIndex(items, 1500)).toBe(1);
  expect(followIndex(items, 2500)).toBe(3);
  expect(followIndex(items, 9000)).toBe(2);
});

test('prependAnchor keeps the viewport on the same row after a prepend', () => {
  expect(prependAnchor(100, 400, 1000)).toBe(700);
  expect(prependAnchor(0, 400, 900)).toBe(500);
  expect(prependAnchor(100, 400, 300)).toBe(100);
});

test('transcriptTabVisible hides the tab without a server session or when unsupported', () => {
  expect(transcriptTabVisible('demo/s1', false)).toBe(true);
  expect(transcriptTabVisible('demo/s1', true)).toBe(false);
  expect(transcriptTabVisible(null, false)).toBe(false);
  expect(transcriptTabVisible(undefined, false)).toBe(false);
});

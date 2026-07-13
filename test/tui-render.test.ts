import { expect, test } from 'bun:test';
import type { StyledText } from '@opentui/core';
import { renderStats, renderTasks, tasksTitle, fmtTokens, fmtDuration, bar, sparkline, activityOf, SPINNER } from '../tui/render';
import type { TuiState } from '../tui/client';

const plain = (s: StyledText) => s.chunks.map((c) => c.text).join('');

function baseState(over: Partial<TuiState> = {}): TuiState {
  return {
    sessionId: 'abc12345-0000-0000-0000-000000000000',
    storeId: 'proj/abc12345-0000-0000-0000-000000000000',
    connection: 'open',
    baseUrl: 'http://127.0.0.1:8787',
    tasks: [],
    ctxTokens: 0,
    lastEventMs: 0,
    ...over,
  };
}

test('formatters', () => {
  expect(fmtTokens(950)).toBe('950');
  expect(fmtTokens(45_200)).toBe('45.2k');
  expect(fmtTokens(1_234_000)).toBe('1.23M');
  expect(fmtDuration(42_000)).toBe('42s');
  expect(fmtDuration(3_720_000)).toBe('1h 2m');
  expect(bar(0.5, 10)).toBe('█████░░░░░');
  expect(bar(2, 4)).toBe('████');
  expect(sparkline([0, 50, 100], 10)).toBe('▁▅█');
  expect(sparkline([1], 10)).toBe('');
});

test('activity derivation: working, idle, ended', () => {
  const now = Date.parse('2026-07-12T10:00:00Z');
  const live = { live: true } as any;
  expect(activityOf(baseState({ summary: live, lastEventMs: now - 5_000 }), now)).toBe('working');
  expect(activityOf(baseState({ summary: live, lastEventMs: now - 60_000 }), now)).toBe('idle');
  expect(activityOf(baseState({ summary: { live: false } as any }), now)).toBe('ended');
});

test('stats frame shows context bar and cost', () => {
  const now = Date.parse('2026-07-12T10:00:00Z');
  const state = baseState({
    summary: { title: 'fix login', live: true } as any,
    session: { name: 'fix login', agents: [{ id: 'session:abc12345-0000-0000-0000-000000000000', name: 'demo', model: 'claude-fable-5', limit: 1_000_000 }], events: [] } as any,
    ctxTokens: 410_000,
    lastEventMs: now - 2_000,
    stats: {
      sessionId: 'proj/abc12345-0000-0000-0000-000000000000',
      tokens: { input: 1_000_000, output: 45_000, cacheRead: 200_000, cacheCreation: 0, total: 1_245_000 },
      toolBreakdown: { Read: 42, Bash: 17, Edit: 9, Grep: 2 },
      toolCalls: 70, costUsd: 3.417, durationMs: 4_320_000,
      subagentCount: 2, compactions: 1, errors: 0,
    } as any,
    tasks: [{ subject: 'a', status: 'completed' }, { subject: 'b', status: 'pending' }],
  });
  const out = plain(renderStats(state, 60, now, 3, [0, 100_000, 410_000]));
  expect(out).toContain(SPINNER[3]);
  expect(out).toContain('▁▂█');
  expect(out).toContain('working');
  expect(out).toContain('claude-fable-5');
  expect(out).toContain('410k / 1.00M');
  expect(out).toContain('41%');
  expect(out).toContain('$3.42');
  expect(out).toContain('Read 42 · Bash 17 · Edit 9');
  expect(out).toContain('1/2 done');
});

test('tasks frame orders in-progress first and truncates to height', () => {
  const state = baseState({
    tasks: [
      { subject: 'done thing', status: 'completed' },
      { subject: 'current thing', status: 'in_progress' },
      { subject: 'next thing', status: 'pending' },
      { subject: 'later thing', status: 'pending' },
    ],
  });
  const out = plain(renderTasks(state, 40, 5));
  const rows = out.split('\n').filter((l) => l.trim().startsWith('◐') || l.trim().startsWith('○') || l.trim().startsWith('●'));
  expect(rows[0]).toContain('current thing');
  expect(out).toContain('…1 more');
  expect(tasksTitle(state)).toBe(' tasks 1/4 ');
});

test('frames surface connection problems', () => {
  const out = plain(renderStats(baseState({ connection: 'reconnecting' }), 40, 0));
  expect(out).toContain('reconnecting…');
  const waiting = plain(renderTasks(baseState({ connection: 'waiting' }), 40, 10));
  expect(waiting).toContain('waiting for session');
});

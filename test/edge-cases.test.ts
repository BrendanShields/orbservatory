import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptNormalizer, type TranscriptSource } from '../server/normalizer';
import { CodexNormalizer } from '../server/providers/codex-normalizer';
import { OpencodeNormalizer } from '../server/providers/opencode-normalizer';
import { tailLines, type FileCursor } from '../server/providers/tail';
import { SessionStore } from '../server/store';
import { ClaudeProjectWatcher } from '../server/watch';

const SRC: TranscriptSource = { sessionId: 's1', project: 'demo', filePath: '/x/s1.jsonl', kind: 'root' };

function norm() {
  return new TranscriptNormalizer({ sessionId: 's1', project: 'demo' });
}

function feed(n: TranscriptNormalizer, recs: unknown[]) {
  const events = [] as any[];
  for (const r of recs) events.push(...n.normalizeLine(JSON.stringify(r), SRC).events);
  return events;
}

// --- Claude: synthetic/API-error records must not fabricate compactions ---

test('zero-usage API-error records emit an error, not a phantom compact + token spike', () => {
  const n = norm();
  const events = feed(n, [
    { type: 'user', timestamp: '2026-07-06T00:00:00Z', message: { content: 'go' } },
    { type: 'assistant', timestamp: '2026-07-06T00:00:01Z', message: { id: 'm1', model: 'claude-opus-4-5', usage: { input_tokens: 100_000, output_tokens: 500 }, content: [] } },
    { type: 'assistant', timestamp: '2026-07-06T00:00:02Z', isApiErrorMessage: true, message: { id: 'm2', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'API Error: 529 overloaded' }] } },
    { type: 'assistant', timestamp: '2026-07-06T00:00:03Z', message: { id: 'm3', model: 'claude-opus-4-5', usage: { input_tokens: 100_500, output_tokens: 600 }, content: [] } },
  ]);
  expect(events.filter((e) => e.type === 'compact')).toHaveLength(0);
  const err = events.find((e) => e.type === 'error') as any;
  expect(err.label).toContain('529');
  // The post-error delta is small (real growth), not a full-context re-count.
  const deltas = events.filter((e) => e.type === 'message' && e.from).map((e: any) => e.tokens);
  expect(deltas[deltas.length - 1]).toBeLessThan(10_000);
  expect(n.usageByModel.has('unknown')).toBe(false);
});

test('custom-title outranks ai-title; compact summaries are not prompts', () => {
  const n = norm();
  feed(n, [
    { type: 'user', timestamp: '2026-07-06T00:00:00Z', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation…' } },
    { type: 'user', timestamp: '2026-07-06T00:00:01Z', message: { content: 'real prompt' } },
    { type: 'ai-title', aiTitle: 'AI title' },
    { type: 'custom-title', customTitle: 'My renamed session' },
    { type: 'ai-title', aiTitle: 'AI title again' },
  ]);
  expect(n.title).toBe('My renamed session');
  expect(n.userTurns).toBe(1);
});

test('compact_boundary system records emit a compact event', () => {
  const n = norm();
  const events = feed(n, [
    { type: 'user', timestamp: '2026-07-06T00:00:00Z', message: { content: 'go' } },
    { type: 'system', subtype: 'compact_boundary', timestamp: '2026-07-06T00:10:00Z', compactMetadata: { trigger: 'auto' } },
  ]);
  const compact = events.find((e) => e.type === 'compact') as any;
  expect(compact).toBeTruthy();
  expect(compact.trigger).toBe('auto');
});

test('image-only prompts still produce a message event', () => {
  const n = norm();
  const events = feed(n, [
    { type: 'user', timestamp: '2026-07-06T00:00:00Z', message: { content: [{ type: 'image', source: {} }] } },
  ]);
  expect(events.some((e) => e.type === 'message' && (e as any).label.includes('image'))).toBe(true);
});

// --- Codex: plain-text tool output, aborted turns, explicit compaction ---

function codexFeed(recs: unknown[]) {
  const n = new CodexNormalizer({ threadId: 'thread1' });
  const events = [] as any[];
  for (const r of recs) events.push(...n.normalizeLine(JSON.stringify(r), { kind: 'root', threadId: 'thread1' }).events);
  return events;
}

test('codex plain-text shell output with non-zero exit becomes an error with exitCode', () => {
  const events = codexFeed([
    { type: 'session_meta', timestamp: '2026-07-06T00:00:00Z', payload: { id: 'thread1', cwd: '/x' } },
    { type: 'response_item', timestamp: '2026-07-06T00:00:01Z', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":"make"}' } },
    { type: 'response_item', timestamp: '2026-07-06T00:00:02Z', payload: { type: 'function_call_output', call_id: 'c1', output: 'Chunk ID: d2897b\nWall time: 0.1 seconds\nProcess exited with code 2\nOutput:\nmake: *** No rule to make target' } },
  ]);
  const tool = events.find((e) => e.type === 'tool') as any;
  expect(tool.exitCode).toBe(2);
  const err = events.find((e) => e.type === 'error') as any;
  expect(err.label).toContain('make:');
});

test('codex turn_aborted and failed patches surface as errors; compacted resets tokens', () => {
  const events = codexFeed([
    { type: 'session_meta', timestamp: '2026-07-06T00:00:00Z', payload: { id: 'thread1', cwd: '/x' } },
    { type: 'event_msg', timestamp: '2026-07-06T00:00:01Z', payload: { type: 'turn_aborted', reason: 'interrupted' } },
    { type: 'event_msg', timestamp: '2026-07-06T00:00:02Z', payload: { type: 'patch_apply_end', success: false } },
    { type: 'compacted', timestamp: '2026-07-06T00:00:03Z', payload: { message: 'compacted' } },
  ]);
  const errors = events.filter((e) => e.type === 'error') as any[];
  expect(errors.some((e) => e.label.includes('interrupted'))).toBe(true);
  expect(errors.some((e) => e.label.includes('patch'))).toBe(true);
  expect(events.some((e) => e.type === 'compact')).toBe(true);
});

test('codex subagent source {other: name} resolves the display name', async () => {
  // subagentName is internal to codex.ts; exercise via the provider head path instead.
  const { CodexProvider } = await import('../server/providers/codex');
  const root = await mkdtemp(join(tmpdir(), 'cviz-codex-'));
  try {
    const parent = join(root, 'rollout-2026-07-06T00-00-00-019ef4f0-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl');
    const sub = join(root, 'rollout-2026-07-06T00-01-00-019ef4f1-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl');
    await writeFile(parent, JSON.stringify({ type: 'session_meta', timestamp: '2026-07-06T00:00:00Z', payload: { id: '019ef4f0-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cwd: '/x' } }) + '\n'
      + JSON.stringify({ type: 'event_msg', timestamp: '2026-07-06T00:00:01Z', payload: { type: 'user_message', message: 'hi' } }) + '\n');
    await writeFile(sub, JSON.stringify({ type: 'session_meta', timestamp: '2026-07-06T00:01:00Z', payload: { id: '019ef4f1-bbbb-4bbb-8bbb-bbbbbbbbbbbb', thread_source: 'subagent', parent_thread_id: '019ef4f0-aaaa-4aaa-8aaa-aaaaaaaaaaaa', source: { subagent: { other: 'guardian' } } } }) + '\n'
      + JSON.stringify({ type: 'event_msg', timestamp: '2026-07-06T00:01:01Z', payload: { type: 'agent_message', message: 'done' } }) + '\n');
    const store = new SessionStore();
    const provider = new CodexProvider(store, { root, pollMs: 60_000 });
    await provider.scan();
    const state = store.get('codex:019ef4f0-aaaa-4aaa-8aaa-aaaaaaaaaaaa')!;
    const child = [...state.agents.values()].find((a) => a.role === 'subagent')!;
    expect(child.name).toContain('guardian');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- opencode: cursor must not skip past pending rows ---

test('opencode cursor holds before a pending assistant message until it completes', () => {
  const n = new OpencodeNormalizer({ sessionId: 'root1' });
  const agents = [] as any[];
  const events = [] as any[];
  n.applySessionRow({ id: 'root1', title: 't', directory: '/x', time: { created: 1000, updated: 1000 } }, true, agents, events);
  // msg_01 pending (no completed), msg_02 terminal (user).
  n.applyMessage('root1', 'msg_01', { id: 'msg_01', role: 'assistant', time: { created: 1100 } }, agents, events);
  n.applyMessage('root1', 'msg_02', { id: 'msg_02', role: 'user', time: { created: 1200 } }, agents, events);
  expect(n.messageCursor('root1')).toBe('');
  // msg_01 completes on a later poll (re-read because cursor held) — now the cursor advances.
  n.applyMessage('root1', 'msg_01', { id: 'msg_01', role: 'assistant', time: { created: 1100, completed: 1300 }, tokens: { input: 10, output: 5 }, modelID: 'm' }, agents, events);
  n.applyMessage('root1', 'msg_02', { id: 'msg_02', role: 'user', time: { created: 1200 } }, agents, events);
  expect(n.messageCursor('root1')).toBe('msg_02');
  expect(events.some((e) => e.type === 'message' && e.from)).toBe(true);
});

test('opencode root spawn reaches the merged event stream', () => {
  const n = new OpencodeNormalizer({ sessionId: 'root1' });
  const agents = [] as any[];
  const events = [] as any[];
  n.applySessionRow({ id: 'root1', title: 't', directory: '/x', time: { created: 1000, updated: 1000 } }, true, agents, events);
  expect(agents).toHaveLength(1);
  expect(events.some((e) => e.type === 'spawn')).toBe(true);
});

// --- tail: UTF-8 split across polls, rewrite reset ---

let dir = '';
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cviz-tail-')); });
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

test('multibyte characters split across two polls decode intact', async () => {
  const p = join(dir, 'f.jsonl');
  const line = JSON.stringify({ text: 'héllo → 🌍' });
  const bytes = Buffer.from(line + '\n', 'utf8');
  const cut = bytes.indexOf(Buffer.from('🌍', 'utf8')[0]) + 2; // mid-emoji
  await writeFile(p, bytes.subarray(0, cut));
  const cursors = new Map<string, FileCursor>();
  const lines: string[] = [];
  await tailLines(cursors, p, (l) => lines.push(l));
  expect(lines).toHaveLength(0);
  await appendFile(p, bytes.subarray(cut));
  await tailLines(cursors, p, (l) => lines.push(l));
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]).text).toBe('héllo → 🌍');
  expect(lines[0]).not.toContain('�');
});

test('a rewritten (shrunk) claude transcript re-ingests without duplicate events', async () => {
  const project = 'demo';
  await mkdir(join(dir, project), { recursive: true });
  const rootFile = join(dir, project, 's1.jsonl');
  const user = (t: string, text: string) => JSON.stringify({ type: 'user', timestamp: t, cwd: '/x', message: { content: text } }) + '\n';
  await writeFile(rootFile, user('2026-07-06T00:00:00Z', 'one') + user('2026-07-06T00:00:01Z', 'two'));
  const store = new SessionStore();
  const watcher = new ClaudeProjectWatcher(store, { root: dir, pollMs: 60_000, watchFs: false });
  await watcher.scan();
  const state = store.get(`${project}/s1`)!;
  const before = state.events.filter((e) => e.type === 'message').length;
  expect(before).toBe(2);
  await writeFile(rootFile, user('2026-07-06T00:00:00Z', 'rewritten'));
  await watcher.scan();
  const messages = state.events.filter((e) => e.type === 'message') as any[];
  expect(messages).toHaveLength(1);
  expect(messages[0].label).toBe('rewritten');
  expect(state.events.filter((e) => e.type === 'spawn')).toHaveLength(1);
  expect(state.loaded).toBe(true);
});

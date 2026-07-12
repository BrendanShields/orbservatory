import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../server/store';
import { PiProvider } from '../server/providers/pi';
import { PiNormalizer } from '../server/providers/pi-normalizer';

let root = '';
const cwdDir = '--Users-b-dev-myproject--';
const sessionId = '0198a3f2-7c1e-7d20-9d5e-3f2b1a9c4d10';
const fileName = `2026-07-11T09-15-12-345Z_${sessionId}.jsonl`;

function sessionFile() { return join(root, cwdDir, fileName); }

const line = (obj: unknown) => JSON.stringify(obj) + '\n';
const header = () => line({ type: 'session', version: 3, id: sessionId, timestamp: '2026-07-11T09:15:12.345Z', cwd: '/Users/b/dev/myproject' });
const userMsg = (t: string, text: string, id = 'u1') =>
  line({ type: 'message', id, parentId: null, timestamp: t, message: { role: 'user', content: [{ type: 'text', text }], timestamp: Date.parse(t) } });
const asstMsg = (t: string, opts: { tool?: { id: string; name: string; args: unknown }; text?: string; usage?: any; stopReason?: string; errorMessage?: string; model?: string } = {}) =>
  line({
    type: 'message', id: 'a' + Math.random().toString(36).slice(2, 8), parentId: 'u1', timestamp: t,
    message: {
      role: 'assistant',
      content: [
        ...(opts.text ? [{ type: 'text', text: opts.text }] : []),
        ...(opts.tool ? [{ type: 'toolCall', id: opts.tool.id, name: opts.tool.name, arguments: opts.tool.args }] : []),
      ],
      api: 'anthropic-messages', provider: 'anthropic', model: opts.model ?? 'claude-opus-4-5',
      usage: opts.usage ?? { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: opts.stopReason ?? 'stop',
      ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
      timestamp: Date.parse(t),
    },
  });
const toolResult = (t: string, callId: string, opts: { isError?: boolean; text?: string } = {}) =>
  line({ type: 'message', id: 'r' + callId, parentId: 'x', timestamp: t, message: { role: 'toolResult', toolCallId: callId, toolName: 'bash', content: [{ type: 'text', text: opts.text ?? 'ok' }], isError: !!opts.isError, timestamp: Date.parse(t) } });

function makeProvider() {
  const store = new SessionStore();
  const provider = new PiProvider(store, { root, pollMs: 60_000 });
  return { store, provider };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cviz-pi-'));
  await mkdir(join(root, cwdDir), { recursive: true });
});

afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test('discovers a pi session, spawns the root agent, parses messages and tools', async () => {
  await writeFile(sessionFile(),
    header() +
    userMsg('2026-07-11T09:15:20.001Z', 'fix the bug in foo.ts') +
    asstMsg('2026-07-11T09:15:24.120Z', { tool: { id: 'toolu_01', name: 'read', args: { path: '/Users/b/dev/myproject/foo.ts' } } }));
  const { store, provider } = makeProvider();
  await provider.scan();
  const state = store.get(`pi:${sessionId}`);
  expect(state).toBeTruthy();
  expect(state!.loaded).toBe(true);
  expect(state!.cwd).toBe('/Users/b/dev/myproject');
  expect([...state!.agents.keys()]).toEqual([`session:${sessionId}`]);
  expect(state!.events.some((e) => e.type === 'spawn')).toBe(true);
  expect(state!.events.some((e) => e.type === 'message' && e.to === `session:${sessionId}`)).toBe(true);
  const tool = state!.events.find((e) => e.type === 'tool') as any;
  expect(tool.tool).toBe('read');
  expect(tool.label).toContain('foo.ts');
  const norm = state!.normalizer as PiNormalizer;
  expect(norm.title).toBe('fix the bug in foo.ts');
  expect(norm.projectName).toBe('myproject');
  expect(norm.userTurns).toBe(1);
});

test('accumulates usage per model with cacheWrite mapped to cacheCreation', async () => {
  await writeFile(sessionFile(),
    header() +
    userMsg('2026-07-11T09:15:20.001Z', 'go') +
    asstMsg('2026-07-11T09:15:24.120Z', { usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 30, totalTokens: 200 } }) +
    asstMsg('2026-07-11T09:15:30.000Z', { model: 'gpt-5.2', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } }));
  const { store, provider } = makeProvider();
  await provider.scan();
  const norm = store.get(`pi:${sessionId}`)!.normalizer as PiNormalizer;
  const claude = norm.usageByModel.get('claude-opus-4-5')!;
  expect(claude).toEqual({ input: 100, output: 20, cacheRead: 50, cacheCreation: 30, total: 200 });
  expect(norm.usageByModel.get('gpt-5.2')!.total).toBe(15);
});

test('session_info names the session (latest wins) and beats the prompt title', async () => {
  await writeFile(sessionFile(),
    header() +
    userMsg('2026-07-11T09:15:20.001Z', 'first prompt') +
    line({ type: 'session_info', id: 's1', parentId: 'u1', timestamp: '2026-07-11T09:16:00.000Z', name: 'Fix foo bug' }));
  const { store, provider } = makeProvider();
  await provider.scan();
  const state = store.get(`pi:${sessionId}`)!;
  const norm = state.normalizer as PiNormalizer;
  expect(norm.title).toBe('Fix foo bug');
  await appendFile(sessionFile(), line({ type: 'session_info', id: 's2', parentId: 's1', timestamp: '2026-07-11T09:17:00.000Z', name: 'Renamed' }));
  await provider.scan();
  expect(norm.title).toBe('Renamed');
});

test('failed tool results and error stop reasons surface as error events', async () => {
  await writeFile(sessionFile(),
    header() +
    userMsg('2026-07-11T09:15:20.001Z', 'go') +
    asstMsg('2026-07-11T09:15:24.120Z', { tool: { id: 'toolu_02', name: 'bash', args: { command: 'ls /nope' } } }) +
    toolResult('2026-07-11T09:15:25.000Z', 'toolu_02', { isError: true, text: 'no such file' }) +
    asstMsg('2026-07-11T09:15:30.000Z', { stopReason: 'error', errorMessage: 'rate limited' }));
  const { store, provider } = makeProvider();
  await provider.scan();
  const state = store.get(`pi:${sessionId}`)!;
  const errors = state.events.filter((e) => e.type === 'error') as any[];
  expect(errors.some((e) => e.label.includes('no such file'))).toBe(true);
  expect(errors.some((e) => e.label.includes('rate limited'))).toBe(true);
  const tool = state.events.find((e) => e.type === 'tool') as any;
  expect(tool.exitCode).toBe(1);
});

test('compaction entries emit compact events and reset the token curve', async () => {
  await writeFile(sessionFile(),
    header() +
    userMsg('2026-07-11T09:15:20.001Z', 'go') +
    asstMsg('2026-07-11T09:15:24.120Z', { usage: { input: 40_000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 40_500 } }) +
    line({ type: 'compaction', id: 'c1', parentId: 'x', timestamp: '2026-07-11T10:00:00.000Z', summary: 'sum', firstKeptEntryId: 'u1', tokensBefore: 50_000 }));
  const { store, provider } = makeProvider();
  await provider.scan();
  const state = store.get(`pi:${sessionId}`)!;
  const compact = state.events.find((e) => e.type === 'compact') as any;
  expect(compact).toBeTruthy();
  expect(compact.label).toContain('50k');
});

test('bashExecution user commands become tool events; non-zero exit is an error', async () => {
  await writeFile(sessionFile(),
    header() +
    line({ type: 'message', id: 'b1', parentId: null, timestamp: '2026-07-11T09:15:21.000Z', message: { role: 'bashExecution', command: 'make test', output: 'FAIL: 2 tests', exitCode: 2, cancelled: false, truncated: false, timestamp: Date.parse('2026-07-11T09:15:21.000Z') } }));
  const { store, provider } = makeProvider();
  await provider.scan();
  const state = store.get(`pi:${sessionId}`)!;
  const tool = state.events.find((e) => e.type === 'tool') as any;
  expect(tool.tool).toBe('bash');
  expect(tool.exitCode).toBe(2);
  expect(state.events.some((e) => e.type === 'error')).toBe(true);
});

test('model_change entries update the agent model', async () => {
  await writeFile(sessionFile(),
    header() +
    userMsg('2026-07-11T09:15:20.001Z', 'go') +
    line({ type: 'model_change', id: 'm1', parentId: 'u1', timestamp: '2026-07-11T09:20:00.000Z', provider: 'openai', modelId: 'gpt-5.2' }));
  const { store, provider } = makeProvider();
  await provider.scan();
  const state = store.get(`pi:${sessionId}`)!;
  expect(state.agents.get(`session:${sessionId}`)!.model).toBe('gpt-5.2');
});

test('parses v1 files (no version, no entry ids, model on the header)', async () => {
  const v1 = join(root, cwdDir, `2025-12-09T00-52-54-397Z_v1session.jsonl`);
  await writeFile(v1,
    line({ type: 'session', id: 'v1session', timestamp: '2025-12-09T00:52:54.397Z', cwd: '/Users/b/old', provider: 'anthropic', modelId: 'claude-opus-4-5', thinkingLevel: 'off' }) +
    line({ type: 'message', timestamp: '2025-12-09T00:53:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'old style' }], timestamp: Date.parse('2025-12-09T00:53:00.000Z') } }));
  const { store, provider } = makeProvider();
  await provider.scan();
  const state = store.get('pi:v1session')!;
  expect(state).toBeTruthy();
  expect(state.agents.get('session:v1session')!.model).toBe('claude-opus-4-5');
  expect(state.events.some((e) => e.type === 'message')).toBe(true);
});

test('ignores jsonl files that are not pi sessions and partial first lines until complete', async () => {
  const alien = join(root, cwdDir, 'notes.jsonl');
  await writeFile(alien, line({ type: 'other', hello: 1 }));
  const partial = join(root, cwdDir, `2026-07-11T09-15-12-345Z_partial.jsonl`);
  await writeFile(partial, '{"type":"session","id":"partial-sess","timestamp":"2026-07-11T09:15:12.345Z","cwd":"/x"');
  const { store, provider } = makeProvider();
  await provider.scan();
  expect(store.all().length).toBe(0);
  await appendFile(partial, '}\n' + userMsg('2026-07-11T09:15:20.001Z', 'now complete'));
  await provider.scan();
  expect(store.get('pi:partial-sess')).toBeTruthy();
});

test('in-place rewrite (v1→v3 migration) resets the cursor and re-parses cleanly', async () => {
  await writeFile(sessionFile(), header() + userMsg('2026-07-11T09:15:20.001Z', 'one') + userMsg('2026-07-11T09:16:20.001Z', 'two', 'u2'));
  const { store, provider } = makeProvider();
  await provider.scan();
  const state = store.get(`pi:${sessionId}`)!;
  expect(state.files.get(sessionFile())!.offset).toBeGreaterThan(0);
  await writeFile(sessionFile(), header() + userMsg('2026-07-11T09:15:20.001Z', 'one'));
  await provider.scan();
  const cursor = state.files.get(sessionFile())!;
  expect(cursor.offset).toBe(Buffer.byteLength(header() + userMsg('2026-07-11T09:15:20.001Z', 'one')));
});

test('sessions directly in the root are discovered (PI_CODING_AGENT_SESSION_DIR layout)', async () => {
  const flat = join(root, `2026-07-11T09-15-12-345Z_flatsess.jsonl`);
  await writeFile(flat,
    line({ type: 'session', version: 3, id: 'flatsess', timestamp: '2026-07-11T09:15:12.345Z', cwd: '/Users/b/dev/flat' }) +
    userMsg('2026-07-11T09:15:20.001Z', 'flat layout'));
  const { store, provider } = makeProvider();
  await provider.scan();
  expect(store.get('pi:flatsess')).toBeTruthy();
});

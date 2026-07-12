import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { TranscriptItem, TranscriptResponse } from '../shared/schema';
import { capText, pageItems, parseTranscriptQuery, LIMIT_DEFAULT, LIMIT_MAX, TEXT_CAP } from '../server/transcript';
import { SessionStore } from '../server/store';
import { ClaudeProjectWatcher } from '../server/providers/claude';
import { CodexProvider } from '../server/providers/codex';
import { PiProvider } from '../server/providers/pi';
import { CopilotProvider } from '../server/providers/copilot';
import { OpencodeProvider } from '../server/providers/opencode';

const line = (obj: unknown) => JSON.stringify(obj) + '\n';

function item(i: number, over: Partial<TranscriptItem> = {}): TranscriptItem {
  return { i, t: i * 1000, role: 'user', agent: 'session:s1', text: `row ${i}`, ...over };
}

describe('pageItems', () => {
  const all = Array.from({ length: 10 }, (_, i) => item(i, { agent: i % 2 ? 'session:s1:agent-a' : 'session:s1' }));

  test('no cursor: newest page with total and nextCursor', () => {
    const res = pageItems(all, { limit: 3 });
    expect(res.items.map((x) => x.i)).toEqual([7, 8, 9]);
    expect(res.total).toBe(10);
    expect(res.nextCursor).toBe(7);
    const everything = pageItems(all, { limit: 50 });
    expect(everything.items.length).toBe(10);
    expect(everything.nextCursor).toBeUndefined();
  });

  test('before: the page closest below the cursor', () => {
    const res = pageItems(all, { before: 7, limit: 3 });
    expect(res.items.map((x) => x.i)).toEqual([4, 5, 6]);
    expect(res.nextCursor).toBe(4);
    const first = pageItems(all, { before: 2, limit: 5 });
    expect(first.items.map((x) => x.i)).toEqual([0, 1]);
    expect(first.nextCursor).toBeUndefined();
  });

  test('after: the live tail past the cursor', () => {
    const res = pageItems(all, { after: 7, limit: 50 });
    expect(res.items.map((x) => x.i)).toEqual([8, 9]);
    expect(pageItems(all, { after: 9, limit: 50 }).items).toEqual([]);
  });

  test('after beyond the newest item (in-place rewrite) returns a fresh first page', () => {
    const res = pageItems(all, { after: 42, limit: 3 });
    expect(res.items.map((x) => x.i)).toEqual([7, 8, 9]);
    expect(res.total).toBe(10);
  });

  test('agent filter windows the filtered list', () => {
    const res = pageItems(all, { agent: 'session:s1:agent-a', limit: 2 });
    expect(res.items.map((x) => x.i)).toEqual([7, 9]);
    expect(res.total).toBe(5);
    expect(res.nextCursor).toBe(7);
    const older = pageItems(all, { agent: 'session:s1:agent-a', before: 7, limit: 2 });
    expect(older.items.map((x) => x.i)).toEqual([3, 5]);
  });

  test('limit clamps to the hard max and a sane minimum', () => {
    expect(pageItems(all, { limit: 0 }).items.length).toBe(10);
    expect(pageItems(all, { limit: -5 }).items.length).toBe(1);
    const big = Array.from({ length: 1200 }, (_, i) => item(i));
    expect(pageItems(big, { limit: 99999 }).items.length).toBe(LIMIT_MAX);
  });
});

describe('capText / parseTranscriptQuery', () => {
  test('capText caps at TEXT_CAP and flags truncation', () => {
    expect(capText('short')).toEqual({ text: 'short' });
    const long = capText('x'.repeat(TEXT_CAP + 5));
    expect(long.text.length).toBe(TEXT_CAP);
    expect(long.truncated).toBe(true);
  });

  test('parseTranscriptQuery clamps limit and ignores junk', () => {
    const sp = new URLSearchParams('limit=99999&before=12&agent=session:s1');
    expect(parseTranscriptQuery(sp)).toEqual({ agent: 'session:s1', before: 12, after: undefined, limit: LIMIT_MAX });
    const junk = parseTranscriptQuery(new URLSearchParams('limit=abc&after=xyz'));
    expect(junk.limit).toBe(LIMIT_DEFAULT);
    expect(junk.after).toBeUndefined();
  });
});

describe('claude extractor', () => {
  let root = '';
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'cviz-tr-claude-')); await mkdir(join(root, 'demo'), { recursive: true }); });
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  test('maps roles, aligns t with events, attributes subagents, [image] placeholder', async () => {
    const rootFile = join(root, 'demo', 's1.jsonl');
    await writeFile(rootFile,
      line({ type: 'user', timestamp: '2026-07-10T10:00:00.000Z', cwd: '/x', message: { content: 'go build the thing' } }) +
      line({ type: 'assistant', timestamp: '2026-07-10T10:00:05.000Z', message: { id: 'm1', usage: { input_tokens: 100 }, content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x/a.ts' } }] } }) +
      line({ type: 'user', timestamp: '2026-07-10T10:00:06.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body', is_error: false }] } }) +
      line({ type: 'user', timestamp: '2026-07-10T10:00:07.000Z', isMeta: true, message: { content: 'meta noise' } }) +
      line({ type: 'user', timestamp: '2026-07-10T10:00:08.000Z', message: { content: [{ type: 'image', source: {} }] } }) +
      line({ type: 'assistant', timestamp: '2026-07-10T10:00:09.000Z', isApiErrorMessage: true, message: { id: 'm2', usage: { input_tokens: 0 }, content: [{ type: 'text', text: 'API Error: 529' }] } }));
    await mkdir(join(root, 'demo', 's1', 'subagents'), { recursive: true });
    await writeFile(join(root, 'demo', 's1', 'subagents', 'agent-a.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'survey', toolUseId: 't9' }));
    await writeFile(join(root, 'demo', 's1', 'subagents', 'agent-a.jsonl'),
      line({ type: 'assistant', timestamp: '2026-07-10T10:00:10.000Z', message: { id: 'm3', usage: { input_tokens: 30 }, content: [{ type: 'text', text: 'child says hi' }] } }));
    const store = new SessionStore();
    const watcher = new ClaudeProjectWatcher(store, { root, pollMs: 60_000, watchFs: false });
    await watcher.scan();
    const state = store.get('demo/s1')!;
    const res = (await watcher.transcript(state, { limit: 200 }))!;
    expect(res.total).toBe(7);
    expect(res.items.map((x) => x.role)).toEqual(['user', 'assistant', 'tool', 'tool-result', 'user', 'error', 'assistant']);
    const [user, asst, tool, toolRes, image, err] = res.items;
    expect(user.text).toBe('go build the thing');
    expect(asst.tokens).toBe(100);
    expect(tool.tool).toBe('Read');
    expect(tool.text).toContain('a.ts');
    expect(toolRes.text).toBe('file body');
    expect(toolRes.tool).toBe('Read');
    expect(image.text).toBe('[image]');
    expect(err.role).toBe('error');
    expect(err.text).toContain('529');
    const userEvent = state.events.find((e) => e.type === 'message' && e.to === 'session:s1') as any;
    expect(user.t).toBe(userEvent.t);
    const toolEvent = state.events.find((e) => e.type === 'tool') as any;
    expect(tool.t).toBe(toolEvent.t);
  });

  test('subagent rows carry the child agent id and filter by agent', async () => {
    const rootFile = join(root, 'demo', 's1.jsonl');
    await writeFile(rootFile, line({ type: 'user', timestamp: '2026-07-10T10:00:00.000Z', cwd: '/x', message: { content: 'go' } }));
    await mkdir(join(root, 'demo', 's1', 'subagents'), { recursive: true });
    await writeFile(join(root, 'demo', 's1', 'subagents', 'agent-a.jsonl'),
      line({ type: 'user', timestamp: '2026-07-10T10:00:02.000Z', message: { content: 'child prompt' } }));
    const store = new SessionStore();
    const watcher = new ClaudeProjectWatcher(store, { root, pollMs: 60_000, watchFs: false });
    await watcher.scan();
    const state = store.get('demo/s1')!;
    const all = (await watcher.transcript(state, { limit: 200 }))!;
    expect(all.items.map((x) => x.agent)).toEqual(['session:s1', 'session:s1:agent-a']);
    const filtered = (await watcher.transcript(state, { agent: 'session:s1:agent-a', limit: 200 }))!;
    expect(filtered.items.map((x) => x.text)).toEqual(['child prompt']);
    expect(filtered.total).toBe(1);
  });

  test('long text is capped and flagged truncated', async () => {
    const big = 'y'.repeat(TEXT_CAP + 100);
    await writeFile(join(root, 'demo', 's1.jsonl'), line({ type: 'user', timestamp: '2026-07-10T10:00:00.000Z', cwd: '/x', message: { content: big } }));
    const store = new SessionStore();
    const watcher = new ClaudeProjectWatcher(store, { root, pollMs: 60_000, watchFs: false });
    await watcher.scan();
    const res = (await watcher.transcript(store.get('demo/s1')!, { limit: 200 }))!;
    expect(res.items[0].truncated).toBe(true);
    expect(res.items[0].text.length).toBe(TEXT_CAP);
  });
});

describe('codex extractor', () => {
  let root = '';
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'cviz-tr-codex-')); });
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  test('maps messages, tool calls, plain-text failed output, and subagent rollouts', async () => {
    const parentId = '019ef4f0-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const subId = '019ef4f1-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await writeFile(join(root, `rollout-2026-07-10T00-00-00-${parentId}.jsonl`),
      line({ type: 'session_meta', timestamp: '2026-07-10T00:00:00Z', payload: { id: parentId, cwd: '/x' } }) +
      line({ type: 'event_msg', timestamp: '2026-07-10T00:00:01Z', payload: { type: 'user_message', message: 'run the build' } }) +
      line({ type: 'response_item', timestamp: '2026-07-10T00:00:02Z', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":"make"}' } }) +
      line({ type: 'response_item', timestamp: '2026-07-10T00:00:03Z', payload: { type: 'function_call_output', call_id: 'c1', output: 'Chunk ID: x\nProcess exited with code 2\nOutput:\nmake: *** No rule' } }) +
      line({ type: 'event_msg', timestamp: '2026-07-10T00:00:04Z', payload: { type: 'agent_message', message: 'build failed, investigating' } }));
    await writeFile(join(root, `rollout-2026-07-10T00-01-00-${subId}.jsonl`),
      line({ type: 'session_meta', timestamp: '2026-07-10T00:01:00Z', payload: { id: subId, thread_source: 'subagent', parent_thread_id: parentId, source: { subagent: { other: 'guardian' } } } }) +
      line({ type: 'event_msg', timestamp: '2026-07-10T00:01:01Z', payload: { type: 'agent_message', message: 'sub done' } }));
    const store = new SessionStore();
    const provider = new CodexProvider(store, { root, pollMs: 60_000 });
    await provider.scan();
    const state = store.get(`codex:${parentId}`)!;
    const res = (await provider.transcript(state, { limit: 200 }))!;
    expect(res.items.map((x) => x.role)).toEqual(['user', 'tool', 'error', 'assistant', 'assistant']);
    const [user, tool, err, asst, sub] = res.items;
    expect(user.text).toBe('run the build');
    expect(tool.tool).toBe('shell');
    expect(tool.text).toContain('make');
    expect(err.tool).toBe('shell');
    expect(err.text).toContain('No rule');
    expect(asst.agent).toBe(`session:${parentId}`);
    expect(sub.agent).toBe(`session:${parentId}:agent-${subId}`);
    expect(user.t).toBe(1000);
  });
});

describe('pi extractor', () => {
  let root = '';
  const cwdDir = '--Users-b-dev-myproject--';
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'cviz-tr-pi-')); await mkdir(join(root, cwdDir), { recursive: true }); });
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  test('v3: user, assistant text + toolCall, failed toolResult, bashExecution', async () => {
    const sessionId = 'sess-v3';
    const t0 = Date.parse('2026-07-10T09:00:00.000Z');
    await writeFile(join(root, cwdDir, `2026-07-10T09-00-00-000Z_${sessionId}.jsonl`),
      line({ type: 'session', version: 3, id: sessionId, timestamp: '2026-07-10T09:00:00.000Z', cwd: '/Users/b/dev/myproject' }) +
      line({ type: 'message', id: 'u1', timestamp: '2026-07-10T09:00:05.000Z', message: { role: 'user', content: [{ type: 'text', text: 'fix it' }], timestamp: t0 + 5000 } }) +
      line({ type: 'message', id: 'a1', timestamp: '2026-07-10T09:00:08.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'sure' }, { type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } }], model: 'claude-opus-4-5', usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 }, stopReason: 'stop', timestamp: t0 + 8000 } }) +
      line({ type: 'message', id: 'r1', timestamp: '2026-07-10T09:00:09.000Z', message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'bash', content: [{ type: 'text', text: 'no such dir' }], isError: true, timestamp: t0 + 9000 } }) +
      line({ type: 'message', id: 'b1', timestamp: '2026-07-10T09:00:12.000Z', message: { role: 'bashExecution', command: 'make test', output: 'FAIL', exitCode: 2, cancelled: false, timestamp: t0 + 12000 } }));
    const store = new SessionStore();
    const provider = new PiProvider(store, { root, pollMs: 60_000 });
    await provider.scan();
    const state = store.get(`pi:${sessionId}`)!;
    const res = (await provider.transcript(state, { limit: 200 }))!;
    expect(res.items.map((x) => x.role)).toEqual(['user', 'assistant', 'tool', 'error', 'tool', 'error']);
    const [user, asst, tool, toolErr, bash, bashErr] = res.items;
    expect(user.t).toBe(5000);
    expect(asst.tokens).toBe(120);
    expect(tool.tool).toBe('bash');
    expect(toolErr.text).toBe('no such dir');
    expect(bash.text).toBe('make test');
    expect(bashErr.text).toBe('FAIL');
    const userEvent = state.events.find((e) => e.type === 'message' && e.to === `session:${sessionId}`) as any;
    expect(user.t).toBe(userEvent.t);
  });

  test('v1 files (no ids) still produce sequential i', async () => {
    await writeFile(join(root, cwdDir, '2025-12-09T00-52-54-397Z_v1sess.jsonl'),
      line({ type: 'session', id: 'v1sess', timestamp: '2025-12-09T00:52:54.397Z', cwd: '/Users/b/old', provider: 'anthropic', modelId: 'claude-opus-4-5' }) +
      line({ type: 'message', timestamp: '2025-12-09T00:53:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'old one' }], timestamp: Date.parse('2025-12-09T00:53:00.000Z') } }) +
      line({ type: 'message', timestamp: '2025-12-09T00:53:10.000Z', message: { role: 'user', content: [{ type: 'text', text: 'old two' }], timestamp: Date.parse('2025-12-09T00:53:10.000Z') } }));
    const store = new SessionStore();
    const provider = new PiProvider(store, { root, pollMs: 60_000 });
    await provider.scan();
    const res = (await provider.transcript(store.get('pi:v1sess')!, { limit: 200 }))!;
    expect(res.items.map((x) => x.i)).toEqual([0, 1]);
    expect(res.items.map((x) => x.text)).toEqual(['old one', 'old two']);
  });
});

describe('copilot extractor', () => {
  let root = '';
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'cviz-tr-copilot-')); });
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  test('maps message and tool records per the normalizer', async () => {
    await mkdir(join(root, 'sess1'), { recursive: true });
    await writeFile(join(root, 'sess1', 'events.jsonl'),
      line({ type: 'session.start', timestamp: '2026-07-10T08:00:00.000Z', data: { cwd: '/x' } }) +
      line({ type: 'user.message', timestamp: '2026-07-10T08:00:01.000Z', data: { role: 'user', content: 'hello copilot' } }) +
      line({ type: 'tool.execution_start', timestamp: '2026-07-10T08:00:02.000Z', data: { toolName: 'bash', toolCallId: 'c1', arguments: { command: 'ls' } } }) +
      line({ type: 'tool.execution_complete', timestamp: '2026-07-10T08:00:03.000Z', data: { toolCallId: 'c1', success: false, error: 'boom' } }) +
      line({ type: 'assistant.message', timestamp: '2026-07-10T08:00:04.000Z', data: { role: 'assistant', content: 'done anyway' } }));
    const store = new SessionStore();
    const provider = new CopilotProvider(store, { root, pollMs: 60_000 });
    await provider.scan();
    const state = store.get('copilot:sess1')!;
    const res = (await provider.transcript(state, { limit: 200 }))!;
    expect(res.items.map((x) => x.role)).toEqual(['user', 'tool', 'error', 'assistant']);
    expect(res.items[1].tool).toBe('bash');
    expect(res.items[2].text).toBe('boom');
    expect(res.items[0].t).toBe(1000);
    expect(res.items.every((x) => x.agent === 'session:sess1')).toBe(true);
  });
});

describe('opencode extractor', () => {
  let dataDir = '';
  beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), 'cviz-tr-oc-')); });
  afterEach(async () => { if (dataDir) await rm(dataDir, { recursive: true, force: true }); });

  test('maps text parts, tool parts, and errors across the session tree', async () => {
    const db = new Database(join(dataDir, 'opencode.db'));
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)');
    db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)');
    const t0 = 1_800_000_000_000;
    const ins = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)');
    ins.run('ses_root', null, t0, t0 + 60_000, JSON.stringify({ id: 'ses_root', title: 'root sess', directory: '/x', time: { created: t0, updated: t0 + 60_000 } }));
    ins.run('ses_child', 'ses_root', t0 + 10_000, t0 + 20_000, JSON.stringify({ id: 'ses_child', title: 'child', time: { created: t0 + 10_000 } }));
    const insMsg = db.prepare('INSERT INTO message VALUES (?, ?, ?)');
    insMsg.run('msg_01', 'ses_root', JSON.stringify({ id: 'msg_01', role: 'user', time: { created: t0 + 1000 } }));
    insMsg.run('msg_02', 'ses_root', JSON.stringify({ id: 'msg_02', role: 'assistant', time: { created: t0 + 2000, completed: t0 + 9000 }, error: { data: { message: 'rate limited' } } }));
    const insPart = db.prepare('INSERT INTO part VALUES (?, ?, ?)');
    insPart.run('prt_01', 'ses_root', JSON.stringify({ id: 'prt_01', messageID: 'msg_01', type: 'text', text: 'hello opencode', time: { start: t0 + 1000 } }));
    insPart.run('prt_02', 'ses_root', JSON.stringify({ id: 'prt_02', messageID: 'msg_02', type: 'text', text: 'hi back', time: { start: t0 + 3000 } }));
    insPart.run('prt_03', 'ses_root', JSON.stringify({ id: 'prt_03', messageID: 'msg_02', type: 'tool', tool: 'read', callID: 'c1', state: { status: 'error', title: 'read a.ts', error: 'nope', time: { start: t0 + 4000, end: t0 + 5000 } } }));
    insPart.run('prt_04', 'ses_child', JSON.stringify({ id: 'prt_04', messageID: 'msg_03', type: 'text', text: 'child text', time: { start: t0 + 12_000 } }));
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('msg_03', 'ses_child', JSON.stringify({ id: 'msg_03', role: 'assistant', time: { created: t0 + 11_000, completed: t0 + 13_000 } }));
    db.close();
    const store = new SessionStore();
    const provider = new OpencodeProvider(store, { dataDir, pollMs: 60_000 });
    await provider.scan();
    const state = store.get('opencode:ses_root')!;
    const res = (await provider.transcript(state, { limit: 200 }))!;
    provider.stop();
    expect(res.items.map((x) => [x.role, x.agent.endsWith('agent-ses_child')])).toEqual([
      ['user', false], ['assistant', false], ['tool', false], ['error', false], ['error', false], ['assistant', true],
    ]);
    const [user, asst, tool, toolErr, msgErr, child] = res.items;
    expect(user.text).toBe('hello opencode');
    expect(user.t).toBe(1000);
    expect(asst.text).toBe('hi back');
    expect(tool.tool).toBe('read');
    expect(tool.text).toBe('read a.ts');
    expect(toolErr.text).toBe('nope');
    expect(msgErr.text).toBe('rate limited');
    expect(child.text).toBe('child text');
    expect(child.t).toBe(12_000);
  });
});

describe('endpoint through the runtime', () => {
  let root = '';
  const savedEnv = new Map<string, string | undefined>();
  const ENV_KEYS = ['ORBSERVATORY_CONFIG_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'OPENCODE_DATA_DIR', 'COPILOT_HOME', 'PI_CODING_AGENT_SESSION_DIR'];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'cviz-tr-rt-'));
    for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);
    process.env.ORBSERVATORY_CONFIG_DIR = join(root, 'config');
    process.env.CLAUDE_PROJECTS_DIR = join(root, 'claude');
    process.env.CODEX_HOME = join(root, 'codex-nonexistent');
    process.env.OPENCODE_DATA_DIR = join(root, 'opencode-nonexistent');
    process.env.COPILOT_HOME = join(root, 'copilot-nonexistent');
    process.env.PI_CODING_AGENT_SESSION_DIR = join(root, 'pi-nonexistent');
    await mkdir(join(root, 'claude', 'demo'), { recursive: true });
    await writeFile(join(root, 'claude', 'demo', 's1.jsonl'),
      line({ type: 'user', timestamp: '2026-07-10T10:00:00.000Z', cwd: '/x', message: { content: 'one' } }) +
      line({ type: 'user', timestamp: '2026-07-10T10:00:01.000Z', message: { content: 'two' } }) +
      line({ type: 'user', timestamp: '2026-07-10T10:00:02.000Z', message: { content: 'three' } }) +
      line({ type: 'user', timestamp: '2026-07-10T10:00:03.000Z', message: { content: 'four' } }));
  });

  afterAll(async () => {
    const { getRuntime } = await import('../server/runtime');
    getRuntime().close();
    delete (globalThis as any).__claudeVizRuntime;
    for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function get(parts: string[], qs = ''): Promise<Response> {
    const { GET } = await import('../app/api/session/[...parts]/route');
    const url = `http://127.0.0.1/api/session/${parts.join('/')}${qs}`;
    return GET(new Request(url), { params: Promise.resolve({ parts }) });
  }

  test('serves paged transcript JSON for a claude session', async () => {
    const { getRuntime } = await import('../server/runtime');
    const runtime = getRuntime();
    await runtime.ready;
    runtime.store.upsertSession({
      id: 'demo/s1', source: 'claude', project: 'demo', sessionId: 's1',
      rootFile: join(root, 'claude', 'demo', 's1.jsonl'), sessionDir: join(root, 'claude', 'demo', 's1'), lastActive: Date.now(),
    });
    const r = await get(['demo', 's1', 'transcript'], '?limit=2');
    expect(r.status).toBe(200);
    const body = await r.json() as TranscriptResponse;
    expect(body.items.map((x) => x.text)).toEqual(['three', 'four']);
    expect(body.total).toBe(4);
    expect(body.nextCursor).toBe(2);
    const older = await (await get(['demo', 's1', 'transcript'], '?limit=2&before=2')).json() as TranscriptResponse;
    expect(older.items.map((x) => x.text)).toEqual(['one', 'two']);
    expect(older.nextCursor).toBeUndefined();
    const tail = await (await get(['demo', 's1', 'transcript'], '?after=2')).json() as TranscriptResponse;
    expect(tail.items.map((x) => x.text)).toEqual(['four']);
    const filtered = await (await get(['demo', 's1', 'transcript'], '?agent=session:s1:agent-none')).json() as TranscriptResponse;
    expect(filtered.items).toEqual([]);
  });

  test('404 for unknown sessions and non-transcript tails', async () => {
    expect((await get(['nope', 'transcript'])).status).toBe(404);
    expect((await get(['demo', 's1', 'bogus'])).status).toBe(404);
  });

  test('404 + unsupported when the provider is not running', async () => {
    const { getRuntime } = await import('../server/runtime');
    const runtime = getRuntime();
    await runtime.ready;
    runtime.store.upsertSession({
      id: 'codex:thread9', source: 'codex', project: 'codex', sessionId: 'thread9',
      rootFile: join(root, 'nope.jsonl'), sessionDir: root, lastActive: Date.now(),
    });
    const r = await get(['codex:thread9', 'transcript']);
    expect(r.status).toBe(404);
    expect((await r.json()).unsupported).toBe(true);
  });

  test('410 when the source file vanished', async () => {
    const { getRuntime } = await import('../server/runtime');
    const runtime = getRuntime();
    await runtime.ready;
    runtime.store.upsertSession({
      id: 'demo/gone', source: 'claude', project: 'demo', sessionId: 'gone',
      rootFile: join(root, 'claude', 'demo', 'gone.jsonl'), sessionDir: join(root, 'claude', 'demo', 'gone'), lastActive: Date.now(),
    });
    expect((await get(['demo', 'gone', 'transcript'])).status).toBe(410);
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptItem, TranscriptResponse } from '../shared/schema';
import { capText, pageItems, parseTranscriptQuery, LIMIT_DEFAULT, LIMIT_MAX, TEXT_CAP } from '../server/transcript';
import { SessionStore } from '../server/store';
import { ClaudeProjectWatcher } from '../server/providers/claude';

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

describe('endpoint through the runtime', () => {
  let root = '';
  const savedEnv = new Map<string, string | undefined>();
  const ENV_KEYS = ['ORBSERVATORY_CONFIG_DIR', 'CLAUDE_PROJECTS_DIR'];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'cviz-tr-rt-'));
    for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);
    process.env.ORBSERVATORY_CONFIG_DIR = join(root, 'config');
    process.env.CLAUDE_PROJECTS_DIR = join(root, 'claude');
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

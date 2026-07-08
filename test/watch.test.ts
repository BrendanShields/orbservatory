import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../server/store';
import { ClaudeProjectWatcher } from '../server/watch';

let root = '';
const project = 'demo';
const sessionId = 's1';

function rootFile() { return join(root, project, `${sessionId}.jsonl`); }
function subFile(name: string) { return join(root, project, sessionId, 'subagents', name); }

const line = (obj: unknown) => JSON.stringify(obj) + '\n';
const userLine = (t: string, content: string) => line({ type: 'user', timestamp: t, cwd: '/x', message: { content } });
const asstTool = (t: string, id: string, name: string, input: unknown) =>
  line({ type: 'assistant', timestamp: t, message: { usage: { input_tokens: 10 }, content: [{ type: 'tool_use', id, name, input }] } });

function makeWatcher() {
  const store = new SessionStore();
  const watcher = new ClaudeProjectWatcher(store, { root, pollMs: 60_000, watchFs: false });
  return { store, watcher };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cviz-watch-'));
  await mkdir(join(root, project), { recursive: true });
});

afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test('discovers a session and parses its initial lines', async () => {
  await writeFile(rootFile(), userLine('2026-07-06T00:00:00.000Z', 'build the app'));
  const { store, watcher } = makeWatcher();
  await watcher.scan();
  const state = store.get(`${project}/${sessionId}`);
  expect(state).toBeTruthy();
  expect(state!.loaded).toBe(true);
  expect(state!.events.some((e) => e.type === 'message')).toBe(true);
});

test('incrementally tails appended lines and buffers a partial final line', async () => {
  await writeFile(rootFile(), userLine('2026-07-06T00:00:00.000Z', 'hi'));
  const { store, watcher } = makeWatcher();
  await watcher.scan();
  const state = store.get(`${project}/${sessionId}`)!;
  const afterFirst = state.events.length;

  // Append a complete line plus a partial (no trailing newline) line.
  await appendFile(rootFile(), asstTool('2026-07-06T00:00:01.000Z', 't1', 'Read', { file_path: 'a.ts' }));
  await appendFile(rootFile(), '{"type":"assistant","timestamp":"2026-07-06T00:00:02.000Z","message":{"usage":{"input_tokens":20},"content":[{"type":"tool_use","id":"t2","name":"Bash"');
  await watcher.scan();
  const afterPartial = state.events.length;
  expect(afterPartial).toBeGreaterThan(afterFirst); // t1 parsed
  expect(state.files.get(rootFile())!.buffer.length).toBeGreaterThan(0); // t2 still buffered

  // Complete the buffered line; the tool event should now appear.
  await appendFile(rootFile(), ',"input":{"command":"ls"}}]}}\n');
  await watcher.scan();
  expect(state.events.filter((e) => e.type === 'tool').length).toBeGreaterThanOrEqual(2);
});

test('resets the offset and re-parses when the transcript is truncated', async () => {
  await writeFile(rootFile(), userLine('2026-07-06T00:00:00.000Z', 'one') + asstTool('2026-07-06T00:00:01.000Z', 't1', 'Read', { file_path: 'a.ts' }));
  const { store, watcher } = makeWatcher();
  await watcher.scan();
  const state = store.get(`${project}/${sessionId}`)!;
  expect(state.files.get(rootFile())!.offset).toBeGreaterThan(0);

  // Rewrite the file smaller than the previous offset (truncation/rotation).
  await writeFile(rootFile(), userLine('2026-07-06T00:00:05.000Z', 'fresh'));
  await watcher.scan();
  const cursor = state.files.get(rootFile())!;
  // Offset now equals the new (smaller) file size — it was reset, not left stale.
  expect(cursor.offset).toBe(Buffer.byteLength(userLine('2026-07-06T00:00:05.000Z', 'fresh')));
});

test('a subagent file that appears mid-stream hot-joins as a spawned child', async () => {
  await writeFile(rootFile(),
    userLine('2026-07-06T00:00:00.000Z', 'go') +
    asstTool('2026-07-06T00:00:01.000Z', 'toolu_a', 'Agent', { subagent_type: 'Explore', description: 'survey' }));
  const { store, watcher } = makeWatcher();
  await watcher.scan();
  const state = store.get(`${project}/${sessionId}`)!;
  expect([...state.agents.keys()].some((k) => k.includes('agent-'))).toBe(false);

  await mkdir(join(root, project, sessionId, 'subagents'), { recursive: true });
  await writeFile(subFile('agent-a.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'survey', toolUseId: 'toolu_a' }));
  await writeFile(subFile('agent-a.jsonl'), line({ type: 'assistant', timestamp: '2026-07-06T00:00:02.000Z', message: { usage: { input_tokens: 30 }, content: [] } }));
  await watcher.scan();
  expect([...state.agents.keys()].some((k) => k.endsWith(':agent-a'))).toBe(true);
  expect(state.events.some((e) => e.type === 'spawn' && (e as any).agent.endsWith(':agent-a'))).toBe(true);
});

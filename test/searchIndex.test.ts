import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../server/store';
import { ClaudeProjectWatcher } from '../server/watch';
import { matchDoc, searchDocs, snippetAround } from '../server/searchIndex';
import type { SearchPart } from '../shared/schema';

// --- pure matching ---

test('snippet windows the text around the match with ellipses only where trimmed', () => {
  expect(snippetAround('short text', 0, 5)).toBe('short text');
  const long = 'a'.repeat(100) + 'NEEDLE' + 'b'.repeat(100);
  const snip = snippetAround(long, 100, 6);
  expect(snip.startsWith('…')).toBe(true);
  expect(snip.endsWith('…')).toBe(true);
  expect(snip).toContain('NEEDLE');
});

test('a prompt hit outranks a tool hit', () => {
  const parts: SearchPart[] = [
    { f: 'tool', s: 'Bash rebuild the project' },
    { f: 'prompt', s: 'please rebuild the app' },
  ];
  const m = matchDoc('demo/s1', parts, 'rebuild')!;
  expect(m.field).toBe('prompt');
  expect(m.snippet).toContain('rebuild the app');
});

test('matching is case-insensitive', () => {
  const m = matchDoc('demo/s1', [{ f: 'assistant', s: 'Refactored the Watcher' }], 'wAtChEr');
  expect(m?.field).toBe('assistant');
});

test('empty queries and misses return null', () => {
  expect(matchDoc('demo/s1', [{ f: 'prompt', s: 'hello' }], '   ')).toBeNull();
  expect(matchDoc('demo/s1', [{ f: 'prompt', s: 'hello' }], 'absent')).toBeNull();
});

test('searchDocs intersects with the metadata-filter allowlist and honors limit', () => {
  const docs: Array<[string, SearchPart[]]> = [
    ['demo/s1', [{ f: 'prompt', s: 'fix the login bug' }]],
    ['demo/s2', [{ f: 'prompt', s: 'fix the logout bug' }]],
    ['demo/s3', [{ f: 'prompt', s: 'fix the search bug' }]],
  ];
  const all = searchDocs(docs, 'bug');
  expect(all.map((m) => m.sessionId)).toEqual(['demo/s1', 'demo/s2', 'demo/s3']);

  const allowed = searchDocs(docs, 'bug', new Set(['demo/s2']));
  expect(allowed.map((m) => m.sessionId)).toEqual(['demo/s2']);

  expect(searchDocs(docs, 'bug', undefined, 2)).toHaveLength(2);
});

// --- index build from a real transcript scan ---

let root = '';
const project = 'demo';
const sessionId = 's1';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cviz-search-'));
  await mkdir(join(root, project), { recursive: true });
});

afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test('a scanned session yields a search doc with title, prompt, assistant, tool and skill parts', async () => {
  const line = (obj: unknown) => JSON.stringify(obj) + '\n';
  await writeFile(join(root, project, `${sessionId}.jsonl`),
    line({ type: 'user', timestamp: '2026-07-08T00:00:00.000Z', cwd: '/x', message: { content: 'hunt the flaky retry test' } }) +
    line({ type: 'assistant', timestamp: '2026-07-08T00:00:01.000Z', message: { id: 'm1', content: [
      { type: 'text', text: 'Scanning CI logs for markers' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'grep -n flaky ci.log' } },
      { type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'dataviz' } },
    ] } }));
  const store = new SessionStore();
  const watcher = new ClaudeProjectWatcher(store, { root, pollMs: 60_000, watchFs: false });
  await watcher.scan();

  const docs = [...store.searchDocs()];
  expect(docs).toHaveLength(1);
  const [docId, parts] = docs[0];
  expect(docId).toBe(`${project}/${sessionId}`);
  expect(parts[0].f).toBe('title');
  const fields = new Set(parts.map((p) => p.f));
  for (const f of ['prompt', 'assistant', 'tool', 'skill'] as const) expect(fields.has(f)).toBe(true);

  // The title is derived from the first prompt and outranks the prompt part.
  const m = searchDocs(store.searchDocs(), 'flaky retry');
  expect(m).toHaveLength(1);
  expect(m[0].field).toBe('title');
  expect(m[0].snippet).toContain('flaky retry test');

  // Text unique to other fields resolves to those fields.
  expect(searchDocs(store.searchDocs(), 'Scanning CI logs')[0]?.field).toBe('assistant');
  expect(searchDocs(store.searchDocs(), 'dataviz')[0]?.field).toBe('skill');

  // Metadata-filter intersection that excludes the only match.
  expect(searchDocs(store.searchDocs(), 'flaky retry', new Set(['demo/other']))).toHaveLength(0);
});

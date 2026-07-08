import { expect, test } from 'bun:test';
import { TranscriptNormalizer } from '../server/normalizer';

const rootSource = { sessionId: 's1', project: '-Users-b-dev-demo', cwd: '/Users/b/dev/demo', filePath: '/tmp/s1.jsonl', kind: 'root' as const };

test('normalizes root user prompt and assistant tool usage', () => {
  const n = new TranscriptNormalizer({ sessionId: 's1', project: '-Users-b-dev-demo' });
  const a = n.normalizeLine(JSON.stringify({ type: 'user', timestamp: '2026-07-06T00:00:00.000Z', cwd: '/Users/b/dev/demo', message: { content: 'build this app' } }), rootSource);
  const b = n.normalizeLine(JSON.stringify({ type: 'assistant', timestamp: '2026-07-06T00:00:01.000Z', message: { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 }, content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'docs/spec.md' } }] } }), rootSource);
  expect(a.events.map(e => e.type)).toEqual(['spawn', 'message']);
  expect(b.events[0]).toMatchObject({ type: 'tool', agent: 'session:s1', tool: 'Read', tokens: 125 });
  expect(n.snapshot([...a.events, ...b.events]).agents[0].name).toBe('demo');
});

test('detects compaction when usage total drops strongly', () => {
  const n = new TranscriptNormalizer({ sessionId: 's1', project: 'demo' });
  n.normalizeLine({ type: 'user', timestamp: '2026-07-06T00:00:00.000Z', message: { content: 'x' } }, rootSource);
  n.normalizeLine({ type: 'assistant', timestamp: '2026-07-06T00:00:01.000Z', message: { usage: { input_tokens: 10000, output_tokens: 1000 }, content: [] } }, rootSource);
  const c = n.normalizeLine({ type: 'assistant', timestamp: '2026-07-06T00:00:02.000Z', message: { usage: { input_tokens: 4000, output_tokens: 200 }, content: [] } }, rootSource);
  expect(c.events[0]).toMatchObject({ type: 'compact', to: 4200 });
});

test('ai-title wins over summary and prompt; meta lines are skipped', () => {
  const n = new TranscriptNormalizer({ sessionId: 's1', project: '-Users-b-dev-1-Projects-avand-web' });
  const meta = n.normalizeLine({ type: 'user', isMeta: true, timestamp: '2026-07-06T00:00:00.000Z', cwd: '/Users/b/dev/1-Projects/avand-web', message: { content: '<local-command-caveat>noise</local-command-caveat>' } }, { ...rootSource, project: '-Users-b-dev-1-Projects-avand-web', cwd: undefined });
  expect(meta.events.filter(e => e.type === 'message')).toEqual([]);
  n.normalizeLine({ type: 'user', timestamp: '2026-07-06T00:00:01.000Z', cwd: '/Users/b/dev/1-Projects/avand-web', message: { content: 'fix the login flow' } }, rootSource);
  expect(n.title).toBe('fix the login flow');
  n.normalizeLine({ type: 'summary', summary: 'Login flow repairs' }, rootSource);
  expect(n.title).toBe('Login flow repairs');
  n.normalizeLine({ type: 'ai-title', aiTitle: 'Fix login flow' }, rootSource);
  expect(n.title).toBe('Fix login flow');
  n.normalizeLine({ type: 'summary', summary: 'Should not override ai-title' }, rootSource);
  expect(n.title).toBe('Fix login flow');
  expect(n.projectName).toBe('avand-web');
});

test('peekLine extracts cwd, title, and start time without events', () => {
  const n = new TranscriptNormalizer({ sessionId: 's2', project: '-Users-b-dev-1-Projects-avand-web' });
  n.peekLine(JSON.stringify({ type: 'user', timestamp: '2026-07-06T01:00:00.000Z', cwd: '/Users/b/dev/1-Projects/avand-web', message: { content: 'add dark mode' } }));
  n.peekLine(JSON.stringify({ type: 'ai-title', aiTitle: 'Add dark mode toggle' }));
  expect(n.projectName).toBe('avand-web');
  expect(n.title).toBe('Add dark mode toggle');
  expect(n.startedAt).toBe(Date.parse('2026-07-06T01:00:00.000Z'));
  expect(n.getAgents()).toEqual([]);
});

test('context limit defaults to 1M and adapts to the observed model', () => {
  const n = new TranscriptNormalizer({ sessionId: 's1', project: 'demo' });
  n.normalizeLine({ type: 'user', timestamp: '2026-07-06T00:00:00.000Z', message: { content: 'x' } }, rootSource);
  expect(n.snapshot([]).agents[0].limit).toBe(1_000_000);
  n.normalizeLine({ type: 'assistant', timestamp: '2026-07-06T00:00:01.000Z', message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 10 }, content: [] } }, rootSource);
  expect(n.snapshot([]).agents[0].limit).toBe(200_000);
  n.normalizeLine({ type: 'assistant', timestamp: '2026-07-06T00:00:02.000Z', message: { model: 'claude-fable-5', usage: { input_tokens: 20 }, content: [] } }, rootSource);
  expect(n.snapshot([]).agents[0].limit).toBe(1_000_000);
});

test('links subagent result to parent tool result', () => {
  const n = new TranscriptNormalizer({ sessionId: 's1', project: 'demo' });
  n.normalizeLine({ type: 'user', timestamp: '2026-07-06T00:00:00.000Z', message: { content: 'x' } }, rootSource);
  const sub = { sessionId: 's1', project: 'demo', filePath: '/tmp/s1/subagents/agent-a.jsonl', kind: 'subagent' as const, agentId: 'agent-a', meta: { agentType: 'explorer', description: 'inspect docs', toolUseId: 'toolu_1', slug: 'agent-a' } };
  const s = n.normalizeLine({ type: 'assistant', timestamp: '2026-07-06T00:00:02.000Z', message: { usage: { input_tokens: 100 }, content: [] } }, sub);
  expect(s.events.some(e => e.type === 'spawn' && e.agent.includes('agent-a'))).toBe(true);
  const r = n.normalizeLine({ type: 'user', timestamp: '2026-07-06T00:00:04.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] } }, rootSource);
  expect(r.events.map(e => e.type)).toEqual(['message', 'complete']);
});

test('subagent id is bare-agentId based regardless of location', () => {
  const n = new TranscriptNormalizer({ sessionId: 's1', project: 'demo' });
  n.normalizeLine({ type: 'user', timestamp: '2026-07-06T00:00:00.000Z', message: { content: 'x' } }, rootSource);
  const sub = { sessionId: 's1', project: 'demo', filePath: '/tmp/s1/subagents/agent-abc.jsonl', kind: 'subagent' as const, agentId: 'agent-abc', meta: { agentType: 'Explore', description: 'survey', toolUseId: 'toolu_1' } };
  const s = n.normalizeLine({ type: 'assistant', timestamp: '2026-07-06T00:00:02.000Z', message: { usage: { input_tokens: 100 }, content: [] } }, sub);
  const spawn = s.events.find(e => e.type === 'spawn' && (e as any).agent !== 'session:s1') as any;
  expect(spawn.agent).toBe('session:s1:agent-abc');
});

test('enriches subagent from Agent toolUseResult', () => {
  const n = new TranscriptNormalizer({ sessionId: 's1', project: 'demo' });
  n.normalizeLine({ type: 'user', timestamp: '2026-07-06T00:00:00.000Z', message: { content: 'x' } }, rootSource);
  n.normalizeLine({ type: 'assistant', timestamp: '2026-07-06T00:00:01.000Z', message: { usage: { input_tokens: 10 }, content: [{ type: 'tool_use', id: 'toolu_x', name: 'Agent', input: { subagent_type: 'Explore', description: 'survey docs' } }] } }, rootSource);
  const sub = { sessionId: 's1', project: 'demo', filePath: '/tmp/s1/subagents/agent-abc.jsonl', kind: 'subagent' as const, agentId: 'agent-abc', meta: { agentType: 'Explore', description: 'survey docs', toolUseId: 'toolu_x' } };
  n.normalizeLine({ type: 'assistant', timestamp: '2026-07-06T00:00:02.000Z', message: { usage: { input_tokens: 50 }, content: [] } }, sub);
  const r = n.normalizeLine({ type: 'user', timestamp: '2026-07-06T00:00:30.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'all done' }] }, toolUseResult: { status: 'completed', agentId: 'abc', agentType: 'Explore', totalDurationMs: 88719, totalTokens: 77907, totalToolUseCount: 14, toolStats: { readCount: 6, searchCount: 0, bashCount: 8, editFileCount: 0, linesAdded: 0, linesRemoved: 0, otherToolCount: 0 } } }, rootSource);
  expect(r.events.map(e => e.type)).toEqual(['message', 'complete']);
  const child = n.getAgents().find(a => a.id === 'session:s1:agent-abc')!;
  expect(child).toMatchObject({ durationMs: 88719, finalStatus: 'completed', totalTokens: 77907, toolCount: 14 });
  expect(child.toolStats).toMatchObject({ read: 6, bash: 8 });
});

test('names a subagent from subagent_type when the child file arrives after the tool_use', () => {
  const n = new TranscriptNormalizer({ sessionId: 's1', project: 'demo' });
  n.normalizeLine({ type: 'user', timestamp: '2026-07-06T00:00:00.000Z', message: { content: 'x' } }, rootSource);
  n.normalizeLine({ type: 'assistant', timestamp: '2026-07-06T00:00:01.000Z', message: { usage: { input_tokens: 10 }, content: [{ type: 'tool_use', id: 'toolu_y', name: 'Agent', input: { subagent_type: 'Plan', description: 'design the flow' } }] } }, rootSource);
  const sub = { sessionId: 's1', project: 'demo', filePath: '/tmp/s1/subagents/agent-p.jsonl', kind: 'subagent' as const, agentId: 'agent-p', meta: { toolUseId: 'toolu_y' } };
  n.normalizeLine({ type: 'assistant', timestamp: '2026-07-06T00:00:02.000Z', message: { usage: { input_tokens: 20 }, content: [] } }, sub);
  expect(n.getAgents().find(a => a.id === 'session:s1:agent-p')!.name).toBe('Plan · design the flow');
});

test('marks a failed Bash tool result and stamps exitCode on the tool event', () => {
  const n = new TranscriptNormalizer({ sessionId: 's1', project: 'demo' });
  n.normalizeLine({ type: 'user', timestamp: '2026-07-06T00:00:00.000Z', message: { content: 'x' } }, rootSource);
  const asm = n.normalizeLine({ type: 'assistant', timestamp: '2026-07-06T00:00:01.000Z', message: { usage: { input_tokens: 10 }, content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'ls /nope' } }] } }, rootSource);
  const toolEv = asm.events.find(e => e.type === 'tool')!;
  const r = n.normalizeLine({ type: 'user', timestamp: '2026-07-06T00:00:02.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'no such file' }] }, toolUseResult: { stdout: '', stderr: 'no such file', exitCode: 2, interrupted: false } }, rootSource);
  expect(r.events.some(e => e.type === 'error')).toBe(true);
  expect((toolEv as any).exitCode).toBe(2);
});

test('background agent completes from a buffered task-notification, not from async_launched', () => {
  const n = new TranscriptNormalizer({ sessionId: 's1', project: 'demo' });
  n.normalizeLine({ type: 'user', timestamp: '2026-07-06T00:00:00.000Z', message: { content: 'x' } }, rootSource);
  n.normalizeLine({ type: 'assistant', timestamp: '2026-07-06T00:00:01.000Z', message: { usage: { input_tokens: 10 }, content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { subagent_type: 'Explore', description: 'dig' } }] } }, rootSource);
  const launch = n.normalizeLine({ type: 'user', timestamp: '2026-07-06T00:00:02.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'launched' }] }, toolUseResult: { status: 'async_launched', agentId: 'bg1' } }, rootSource);
  expect(launch.events.some(e => e.type === 'complete')).toBe(false);
  n.normalizeLine({ type: 'user', timestamp: '2026-07-06T00:00:20.000Z', message: { content: '<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>\n</task-notification>' } }, rootSource);
  const sub = { sessionId: 's1', project: 'demo', filePath: '/tmp/s1/subagents/agent-bg1.jsonl', kind: 'subagent' as const, agentId: 'agent-bg1', meta: { agentType: 'Explore', toolUseId: 'toolu_bg' } };
  const s = n.normalizeLine({ type: 'assistant', timestamp: '2026-07-06T00:00:05.000Z', message: { usage: { input_tokens: 30 }, content: [] } }, sub);
  expect(s.events.some(e => e.type === 'complete' && e.agent === 'session:s1:agent-bg1')).toBe(true);
  expect(n.getAgents().find(a => a.id === 'session:s1:agent-bg1')!.finalStatus).toBe('completed');
});

test('names workflow + fan-out agents and never creates a journal node', () => {
  const n = new TranscriptNormalizer({ sessionId: 's1', project: 'demo' });
  n.normalizeLine({ type: 'user', timestamp: '2026-07-06T00:00:00.000Z', message: { content: 'x' } }, rootSource);
  n.normalizeLine({ type: 'user', timestamp: '2026-07-06T00:00:01.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_w', content: 'launched' }] }, toolUseResult: { status: 'async_launched', workflowName: 'docs-enrich', runId: 'wf_abc', summary: 'enrich the docs' } }, rootSource);
  const wfAgent = { sessionId: 's1', project: 'demo', filePath: '/tmp/s1/subagents/workflows/wf_abc/agent-a1.jsonl', kind: 'workflow-agent' as const, workflowId: 'wf_abc', agentId: 'agent-a1', meta: { agentType: 'workflow-subagent' } };
  n.normalizeLine({ type: 'assistant', timestamp: '2026-07-06T00:00:03.000Z', message: { usage: { input_tokens: 20 }, content: [] } }, wfAgent);
  const journalSource = { sessionId: 's1', project: 'demo', filePath: '/tmp/s1/subagents/workflows/wf_abc/journal.jsonl', kind: 'workflow-journal' as const, workflowId: 'wf_abc' };
  n.ingestJournal({ type: 'started', agentId: 'a1' }, journalSource);
  const done = n.ingestJournal({ type: 'result', agentId: 'a1', result: { findings: [] } }, journalSource);
  const agents = n.getAgents();
  expect(agents.find(a => a.id === 'session:s1:wf_abc')!.name).toBe('docs-enrich · enrich the docs');
  expect(agents.some(a => /journal/i.test(a.name) || a.id.includes('journal'))).toBe(false);
  expect(agents.some(a => a.id === 'session:s1:agent-a1')).toBe(true);
  expect(done.events.some(e => e.type === 'complete' && e.agent === 'session:s1:agent-a1')).toBe(true);
});

test('root spawn is not stamped with wall-clock time when the transcript starts with metadata records', () => {
  const n = new TranscriptNormalizer({ sessionId: 's1', project: 'demo' });
  n.peekLine(JSON.stringify({ type: 'user', timestamp: '2026-06-23T10:00:00.000Z', message: { content: 'original prompt' } }));
  const a = n.normalizeLine({ type: 'last-prompt', leafUuid: 'x', sessionId: 's1' }, rootSource);
  const b = n.normalizeLine({ type: 'user', timestamp: '2026-06-23T10:00:05.000Z', message: { content: 'original prompt' } }, rootSource);
  const spawn = [...a.events, ...b.events].find(e => e.type === 'spawn') as any;
  expect(spawn.t).toBeLessThanOrEqual(5000);
});

test('records without timestamps inherit the previous timestamp instead of wall clock', () => {
  const n = new TranscriptNormalizer({ sessionId: 's1', project: 'demo' });
  n.normalizeLine({ type: 'user', timestamp: '2026-06-23T10:00:00.000Z', message: { content: 'start' } }, rootSource);
  const b = n.normalizeLine({ type: 'user', message: { content: 'no clock on this record' } }, rootSource);
  const msg = b.events.find(e => e.type === 'message') as any;
  expect(msg.t).toBe(0);
});

test('journal ingested before any timestamped line does not poison startedAt', () => {
  const n = new TranscriptNormalizer({ sessionId: 's1', project: 'demo' });
  const journalSource = { sessionId: 's1', project: 'demo', filePath: '/tmp/s1/subagents/workflows/wf_1/journal.jsonl', kind: 'workflow-journal' as const, workflowId: 'wf_1' };
  n.ingestJournal({ type: 'result', agentId: 'agent-a1' }, journalSource);
  const a = n.normalizeLine({ type: 'user', timestamp: '2026-06-23T10:00:00.000Z', message: { content: 'start' } }, rootSource);
  const b = n.normalizeLine({ type: 'user', timestamp: '2026-06-23T10:01:00.000Z', message: { content: 'later' } }, rootSource);
  const m1 = a.events.find(e => e.type === 'message') as any;
  const m2 = b.events.find(e => e.type === 'message') as any;
  expect(m2.t - m1.t).toBe(60000);
});

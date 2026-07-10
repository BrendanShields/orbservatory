import { expect, test } from 'bun:test';
import { SessionStore, type Subscriber } from '../server/store';
import { TranscriptNormalizer } from '../server/normalizer';
import type { AwvAgent, AwvEvent, ServerMessage } from '../shared/schema';

function makeStore() {
  const store = new SessionStore();
  const state = store.upsertSession({
    id: 'demo/s1', project: 'demo', sessionId: 's1',
    rootFile: '/tmp/s1.jsonl', sessionDir: '/tmp/s1', lastActive: Date.now(),
  });
  return { store, state };
}

class CapturingSubscriber implements Subscriber {
  messages: ServerMessage[] = [];
  send(m: ServerMessage) { this.messages.push(m); }
  wants() { return true; }
  wantsExplicitly() { return false; }
  events() { return this.messages.filter((m) => m.type === 'events') as Extract<ServerMessage, { type: 'events' }>[]; }
}

const ev = (t: number, type: AwvEvent['type'] = 'tool'): AwvEvent =>
  ({ t, type, agent: 'session:s1', tool: 'Read', ts: new Date(1_000 + t).toISOString() } as AwvEvent);

test('merge keeps the stored log append-only even when a batch arrives out of order', () => {
  const { store, state } = makeStore();
  store.merge(state, [], [ev(100), ev(300)]);
  // A later poll surfaces an event that is earlier in time than the last stored one.
  store.merge(state, [], [ev(200)]);
  expect(state.events.map((e) => e.t)).toEqual([100, 300, 200]); // arrival order preserved
});

test('snapshot returns events in canonical time order regardless of arrival order', () => {
  const { store, state } = makeStore();
  store.merge(state, [], [ev(100), ev(300)]);
  store.merge(state, [], [ev(200)]);
  const snap = store.snapshot(state);
  expect(snap.events.map((e) => e.t)).toEqual([100, 200, 300]);
});

test('fan-out reports a from offset that matches the append-only index', () => {
  const { store, state } = makeStore();
  const sub = new CapturingSubscriber();
  store.addSubscriber(sub);
  store.merge(state, [], [ev(100), ev(300)]);
  store.merge(state, [], [ev(200)]);
  const batches = sub.events();
  expect(batches.map((b) => b.from)).toEqual([0, 2]);
  // slice(from) on the stored log reconstructs exactly what each batch delivered.
  for (const b of batches) {
    expect(state.events.slice(b.from, b.from + b.events.length)).toEqual(b.events);
  }
});

test('an out-of-order tail append never rewrites earlier indices (index-resume safety)', () => {
  const { store, state } = makeStore();
  store.merge(state, [], [ev(100), ev(300)]);
  const before = state.events.slice(0, 2);
  store.merge(state, [], [ev(50)]); // earlier than everything already stored
  // Indices 0..1 are untouched, so a client cursor at 2 still points past them.
  expect(state.events.slice(0, 2)).toEqual(before);
  expect(state.events.length).toBe(3);
});

test('agents merge into the snapshot', () => {
  const { store, state } = makeStore();
  const agent: AwvAgent = { id: 'session:s1', name: 'root', role: 'root' };
  store.merge(state, [agent], [ev(100, 'spawn')]);
  const snap = store.snapshot(state);
  expect(snap.agents.some((a) => a.id === 'session:s1')).toBe(true);
});

function statsMessages(sub: CapturingSubscriber) {
  return sub.messages.filter((m) => m.type === 'stats') as Extract<ServerMessage, { type: 'stats' }>[];
}

test('a new subscriber is greeted with a stats message for known sessions', () => {
  const { store, state } = makeStore();
  state.loaded = true;
  store.merge(state, [], [ev(100), ev(200), ev(300)]);
  const sub = new CapturingSubscriber();
  store.addSubscriber(sub);
  const greeting = statsMessages(sub);
  expect(greeting).toHaveLength(1);
  const s1 = greeting[0].stats.find((s) => s.sessionId === 'demo/s1')!;
  expect(s1.toolCalls).toBe(3);
  expect(s1.tier).toBe('simple');
});

test('transcript growth surfaces in the next stats broadcast', () => {
  const { store, state } = makeStore();
  state.loaded = true;
  store.merge(state, [], [ev(100)]);
  const sub = new CapturingSubscriber();
  store.addSubscriber(sub);

  store.merge(state, [], [ev(200), ev(300)]);
  store.broadcastSessions(); // the scan-cycle flush point
  const latest = statsMessages(sub).at(-1)!;
  expect(latest.stats.find((s) => s.sessionId === 'demo/s1')!.toolCalls).toBe(3);
});

test('changing tier thresholds re-finalizes and re-broadcasts stats', () => {
  const { store, state } = makeStore();
  state.loaded = true;
  store.merge(state, [], [ev(100), ev(200), ev(300)]);
  const sub = new CapturingSubscriber();
  store.addSubscriber(sub);
  expect(statsMessages(sub).at(-1)!.stats[0].tier).toBe('simple');

  sub.messages = [];
  store.setStatsConfig({}, { simpleMaxTools: 1, complexMinSubagents: 99, complexMinTools: 99 });
  const rebroadcast = statsMessages(sub);
  expect(rebroadcast).toHaveLength(1);
  expect(rebroadcast[0].stats.find((s) => s.sessionId === 'demo/s1')!.tier).toBe('moderate');
});

test('setContextLimits live-updates loaded agents that have observed models', () => {
  const { store, state } = makeStore();
  const source = { sessionId: 's1', project: 'demo', filePath: '/tmp/s1.jsonl', kind: 'root' as const };
  const norm = state.normalizer as TranscriptNormalizer;
  const user = norm.normalizeLine({ type: 'user', timestamp: '2026-07-06T00:00:00.000Z', message: { content: 'x' } }, source);
  store.merge(state, user.agents, user.events);
  const assistant = norm.normalizeLine({ type: 'assistant', timestamp: '2026-07-06T00:00:01.000Z', message: { model: 'claude-custom-model', usage: { input_tokens: 10 }, content: [] } }, source);
  store.merge(state, assistant.agents, assistant.events);
  expect(store.snapshot(state).agents.find((a) => a.id === 'session:s1')?.limit).toBe(1_000_000);

  const sub = new CapturingSubscriber();
  store.addSubscriber(sub);
  sub.messages = [];
  store.setContextLimits({ 'claude-custom-model': 123_456 });

  expect(store.snapshot(state).agents.find((a) => a.id === 'session:s1')?.limit).toBe(123_456);
  const update = sub.events().at(-1);
  expect(update?.agents?.find((a) => a.id === 'session:s1')?.limit).toBe(123_456);
});

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { AwvEvent, AwvSession, AwvTask, ServerMessage, SessionStats, SessionSummary } from '../shared/schema';
import { configDir } from '../server/settings';
import { rootAgentId } from '../server/normalizer';

export type Connection = 'connecting' | 'waiting' | 'open' | 'reconnecting';

export interface TuiState {
  sessionId: string;
  storeId?: string;
  connection: Connection;
  baseUrl: string;
  summary?: SessionSummary;
  session?: AwvSession;
  tasks: AwvTask[];
  stats?: SessionStats;
  /** Reconstructed current context tokens of the root agent. */
  ctxTokens: number;
  lastEventMs: number;
}

export async function resolveBaseUrl(): Promise<string> {
  const env = Number(process.env.PORT);
  if (Number.isFinite(env) && env > 0) return `http://127.0.0.1:${env}`;
  try {
    const raw = JSON.parse(await readFile(join(configDir(), 'settings.json'), 'utf8'));
    const p = Number(raw?.port);
    if (Number.isFinite(p) && p > 0) return `http://127.0.0.1:${p}`;
  } catch { /* fall through to default */ }
  return 'http://127.0.0.1:8787';
}

function applyEvents(state: TuiState, events: AwvEvent[]) {
  const root = rootAgentId(state.sessionId);
  for (const e of events) {
    const ts = e.ts ? Date.parse(e.ts) : NaN;
    if (Number.isFinite(ts) && ts > state.lastEventMs) state.lastEventMs = ts;
    if (e.type === 'compact' && e.agent === root) state.ctxTokens = e.to;
    else if (e.type === 'tool' && e.agent === root && e.tokens) state.ctxTokens += e.tokens;
    else if (e.type === 'message' && e.from === root && e.to === root && e.tokens) state.ctxTokens += e.tokens;
  }
}

/**
 * Own the whole client lifecycle: resolve the store session id from the Claude
 * session uuid, keep one subscribed WebSocket alive, and invoke `onState`
 * after every change. Never returns; the caller exits via signals.
 */
export async function runClient(sessionId: string, onState: (s: TuiState) => void): Promise<never> {
  const state: TuiState = {
    sessionId,
    connection: 'connecting',
    baseUrl: await resolveBaseUrl(),
    tasks: [],
    ctxTokens: 0,
    lastEventMs: 0,
  };
  onState(state);

  // The transcript may not exist yet right after SessionStart; poll until the
  // server has discovered it.
  while (!state.storeId) {
    try {
      const res = await fetch(`${state.baseUrl}/api/sessions`);
      const sessions = (await res.json()) as SessionSummary[];
      const hit = sessions.find((s) => s.source === 'claude' && s.id.endsWith(`/${sessionId}`));
      if (hit) { state.storeId = hit.id; state.summary = hit; break; }
      state.connection = 'waiting';
    } catch {
      state.connection = 'connecting';
    }
    onState(state);
    await sleep(2000);
  }

  let backoff = 1000;
  for (;;) {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`${state.baseUrl.replace(/^http/, 'ws')}/ws`);
      ws.on('open', () => {
        backoff = 1000;
        state.connection = 'open';
        ws.send(JSON.stringify({ type: 'subscribe', sessionIds: [state.storeId] }));
        onState(state);
      });
      ws.on('message', (data) => {
        let msg: ServerMessage;
        try { msg = JSON.parse(String(data)); } catch { return; }
        if (msg.type === 'sessions') {
          const hit = msg.sessions.find((s) => s.id === state.storeId);
          if (hit) state.summary = hit;
        } else if (msg.type === 'snapshot' && msg.sessionId === state.storeId) {
          state.session = msg.session;
          if (msg.session.tasks) state.tasks = msg.session.tasks;
          state.ctxTokens = 0;
          state.lastEventMs = 0;
          applyEvents(state, msg.session.events);
        } else if (msg.type === 'events' && msg.sessionId === state.storeId) {
          if (state.session) {
            state.session.events.push(...msg.events);
            if (msg.agents) {
              const byId = new Map(state.session.agents.map((a) => [a.id, a]));
              for (const a of msg.agents) byId.set(a.id, a);
              state.session.agents = [...byId.values()];
            }
          }
          if (msg.tasks) state.tasks = msg.tasks;
          applyEvents(state, msg.events);
        } else if (msg.type === 'stats') {
          const hit = msg.stats.find((s) => s.sessionId === state.storeId);
          if (hit) state.stats = hit;
        } else {
          return;
        }
        onState(state);
      });
      const done = () => resolve();
      ws.on('close', done);
      ws.on('error', done);
    });
    state.connection = 'reconnecting';
    onState(state);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 15_000);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Alt-screen render loop: coalesces updates and restores the terminal on exit. */
export function makeScreen(render: () => string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const draw = () => {
    timer = null;
    process.stdout.write('\x1b[2J\x1b[H' + render());
  };
  const restore = () => {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    process.exit(0);
  };
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  process.on('SIGINT', restore);
  process.on('SIGTERM', restore);
  process.stdout.on('resize', () => schedule());
  const schedule = () => {
    if (!timer) timer = setTimeout(draw, 80);
  };
  return schedule;
}

import type { ServerWebSocket } from 'bun';
import type { ClientMessage, SearchRequest, SearchResponse, ServerMessage, Settings } from '../shared/schema';
import { SessionStore, type SessionState, type Subscriber } from './store';
import { ClaudeProjectWatcher } from './watch';
import { StatsCache } from './statsCache';
import { searchDocs } from './searchIndex';
import { SettingsStore } from './settings';
import { resolveConfig } from './config';
import { resumeAction } from './resume';
import index from '../web/index.html';

const settings = new SettingsStore();
await settings.load();
const cfg = resolveConfig(settings.get());

const store = new SessionStore({
  livenessMs: cfg.livenessMs,
  contextLimits: cfg.contextLimits,
  pricing: settings.get().pricing,
  tierThresholds: settings.get().tierThresholds,
});
const statsCache = new StatsCache();
const watcher = new ClaudeProjectWatcher(store, { root: cfg.root, pollMs: cfg.pollMs, livenessMs: cfg.livenessMs, statsCache });
watcher.start();

function applySettings(s: Settings) {
  store.setLivenessMs(s.livenessMs);
  store.setContextLimits(s.contextLimits);
  store.setStatsConfig(s.pricing, s.tierThresholds);
  watcher.setLivenessMs(s.livenessMs);
  watcher.setPollMs(s.pollMs);
}

const server = Bun.serve<{ sub?: WsSubscriber }>({
  port: cfg.port,
  hostname: cfg.host,
  development: process.env.NODE_ENV === 'development',
  routes: { '/': index },
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (server.upgrade(req, { data: {} })) return undefined;
      return new Response('Upgrade failed', { status: 400 });
    }
    if (url.pathname === '/api/health') return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    if (url.pathname === '/api/sessions') return json(store.summaries());
    if (url.pathname === '/api/settings') {
      if (req.method === 'GET') return json(settings.get());
      if (req.method === 'PUT') {
        const patch = await req.json().catch(() => ({}));
        const next = await settings.patch(patch as Partial<Settings>);
        applySettings(next);
        store.broadcastSettings(next);
        return json(next);
      }
      return new Response('Method not allowed', { status: 405 });
    }
    if (url.pathname === '/api/search') {
      if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      const body = (await req.json().catch(() => null)) as SearchRequest | null;
      const q = typeof body?.q === 'string' ? body.q.trim() : '';
      const allow = Array.isArray(body?.sessionIds) ? new Set(body.sessionIds.map(String)) : undefined;
      const limit = Math.min(Math.max(Math.trunc(Number(body?.limit)) || 100, 1), 500);
      return json(runSearch(q, allow, limit));
    }
    const exp = /^\/api\/session\/(.+)\/export$/.exec(url.pathname);
    if (exp) {
      const id = decodeURIComponent(exp[1]);
      const s = store.get(id);
      if (!s) return json({ error: 'not found' }, 404);
      await watcher.ensureLoaded(s);
      return json(store.snapshot(s));
    }
    return new Response('Not found', { status: 404 });
  },
  websocket: {
    open(ws) {
      const sub = new WsSubscriber(ws, store);
      ws.data.sub = sub;
      store.addSubscriber(sub);
      sub.send({ type: 'settings', settings: settings.get() });
    },
    message(ws, message) {
      const sub = ws.data.sub;
      if (!sub) return;
      try {
        const parsed = JSON.parse(String(message));
        void sub.handle(parsed).catch((err: Error) => sub.send({ type: 'error', message: String(err.message || err) }));
      } catch (err) { sub.send({ type: 'error', message: String((err as Error).message || err) }); }
    },
    close(ws) {
      const sub = ws.data.sub;
      if (sub) store.removeSubscriber(sub);
    },
  },
});

const displayHost = cfg.host === '127.0.0.1' || cfg.host === '0.0.0.0' ? 'localhost' : cfg.host;
console.log(`claude-viz listening on http://${displayHost}:${server.port}`);

export const port = server.port;
export const host = displayHost;

class WsSubscriber implements Subscriber {
  private mode: 'all-live' | 'ids' = 'all-live';
  private ids = new Set<string>();
  constructor(private ws: ServerWebSocket<any>, private store: SessionStore) {}
  send(message: ServerMessage) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }
  wants(state: SessionState): boolean {
    return this.mode === 'all-live' ? state.live : this.ids.has(state.id);
  }
  wantsExplicitly(state: SessionState): boolean {
    return this.mode === 'ids' && this.ids.has(state.id);
  }
  async handle(msg: ClientMessage) {
    if (msg.type === 'ping') { this.send({ type: 'pong' }); return; }
    if (msg.type !== 'subscribe') return;
    if (msg.sessionIds === 'all-live') { this.mode = 'all-live'; this.ids.clear(); }
    else { this.mode = 'ids'; this.ids = new Set(msg.sessionIds); }
    const states = this.store.all().filter(s => this.wants(s));
    for (const state of states) {
      await watcher.ensureLoaded(state);
      const since = msg.lastEventIndex?.[state.id] ?? 0;
      const action = resumeAction(since, state.events.length);
      if (action.kind === 'noop') continue;
      if (action.kind === 'events') {
        this.send({ type: 'events', sessionId: state.id, events: state.events.slice(action.from), from: action.from });
      } else {
        this.send({ type: 'snapshot', sessionId: state.id, session: this.store.snapshot(state), eventOffset: 0, done: true });
      }
    }
  }
}

/**
 * Full-text search over in-memory docs. Sessions the background parse hasn't
 * reached yet are scanned by title only; they mark the response `partial` so
 * the client can show a "still scanning" state and retry.
 */
function runSearch(q: string, allow: Set<string> | undefined, limit: number): SearchResponse {
  const candidates = store.all().filter(s => !allow || allow.has(s.id));
  const total = candidates.length;
  if (!q) return { matches: [], partial: false, scanned: 0, total };
  const matches = searchDocs(store.searchDocs(), q, allow, limit);
  const scanned = candidates.filter(s => store.hasSearchDoc(s)).length;
  const partial = scanned < total || matches.length >= limit;
  return { matches, partial, scanned, total };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json' } });
}

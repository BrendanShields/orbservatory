import type { ServerWebSocket } from 'bun';
import type { ClientMessage, ServerMessage, Settings } from '../shared/schema';
import { SessionStore, type SessionState, type Subscriber } from './store';
import { ClaudeProjectWatcher } from './watch';
import { SettingsStore } from './settings';
import { resolveConfig } from './config';
import index from '../web/index.html';

const settings = new SettingsStore();
await settings.load();
const cfg = resolveConfig(settings.get());

const store = new SessionStore({ livenessMs: cfg.livenessMs, contextLimits: cfg.contextLimits });
const watcher = new ClaudeProjectWatcher(store, { root: cfg.root, pollMs: cfg.pollMs, livenessMs: cfg.livenessMs });
watcher.start();

function applySettings(s: Settings) {
  store.setLivenessMs(s.livenessMs);
  store.setContextLimits(s.contextLimits);
  watcher.setLivenessMs(s.livenessMs);
  watcher.setPollMs(s.pollMs);
}

const server = Bun.serve<{ sub?: WsSubscriber }>({
  port: cfg.port,
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

console.log(`claude-viz listening on http://localhost:${server.port}`);

export const port = server.port;

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
      if (since > 0 && since >= state.events.length) continue;
      if (since > 0 && since < state.events.length) {
        this.send({ type: 'events', sessionId: state.id, events: state.events.slice(since), from: since });
      } else {
        this.send({ type: 'snapshot', sessionId: state.id, session: this.store.snapshot(state), eventOffset: 0, done: true });
      }
    }
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json' } });
}

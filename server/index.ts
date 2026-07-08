import type { ServerWebSocket } from 'bun';
import { existsSync } from 'node:fs';
import type { ClientMessage, ServerMessage, SessionSource, Settings } from '../shared/schema';
import { SessionStore, type SessionState, type Subscriber } from './store';
import { ClaudeProjectWatcher } from './providers/claude';
import { CodexProvider, defaultCodexRoot } from './providers/codex';
import { OpencodeProvider, defaultOpencodeDataDir, findOpencodeDb } from './providers/opencode';
import { CopilotProvider, defaultCopilotRoot } from './providers/copilot';
import type { SessionProvider } from './providers/types';
import { SettingsStore } from './settings';
import { resolveConfig } from './config';
import { resumeAction } from './resume';
import index from '../web/index.html';

const settings = new SettingsStore();
await settings.load();
const cfg = resolveConfig(settings.get());

// Identifies this server process. Resume cursors (array indexes into the
// append-ordered event log) are only valid within the boot that minted them.
const BOOT_ID = crypto.randomUUID();

const store = new SessionStore({ livenessMs: cfg.livenessMs, contextLimits: cfg.contextLimits, bootId: BOOT_ID });

const providerFactories: Record<SessionSource, () => SessionProvider | null> = {
  claude: () => new ClaudeProjectWatcher(store, { root: cfg.root, pollMs: cfg.pollMs, livenessMs: cfg.livenessMs }),
  codex: () => (existsSync(defaultCodexRoot()) ? new CodexProvider(store, { pollMs: cfg.pollMs, livenessMs: cfg.livenessMs }) : null),
  opencode: () => (findOpencodeDb(defaultOpencodeDataDir()) ? new OpencodeProvider(store, { pollMs: cfg.pollMs, livenessMs: cfg.livenessMs }) : null),
  copilot: () => (existsSync(defaultCopilotRoot()) ? new CopilotProvider(store, { pollMs: cfg.pollMs, livenessMs: cfg.livenessMs }) : null),
};

const providers = new Map<SessionSource, SessionProvider>();

function syncProviders(s: Settings) {
  for (const source of Object.keys(providerFactories) as SessionSource[]) {
    const want = s.providers[source] !== false;
    const running = providers.get(source);
    if (want && !running) {
      try {
        const p = providerFactories[source]();
        if (p) { p.start(); providers.set(source, p); }
      } catch (err) {
        console.error(`[${source}] provider failed to start; continuing without it`, err);
      }
    } else if (!want && running) {
      running.stop();
      providers.delete(source);
    }
  }
}

function applySettings(s: Settings) {
  store.setLivenessMs(s.livenessMs);
  store.setContextLimits(s.contextLimits);
  syncProviders(s);
  for (const p of providers.values()) {
    p.setLivenessMs(s.livenessMs);
    p.setPollMs(s.pollMs);
  }
}

syncProviders(settings.get());

async function ensureLoaded(state: SessionState) {
  const provider = providers.get(state.source);
  if (provider) await provider.ensureLoaded(state);
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
    const exp = /^\/api\/session\/(.+)\/export$/.exec(url.pathname);
    if (exp) {
      const id = decodeURIComponent(exp[1]);
      const s = store.get(id);
      if (!s) return json({ error: 'not found' }, 404);
      await ensureLoaded(s);
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
    const sameBoot = msg.bootId === BOOT_ID;
    const states = this.store.all().filter(s => this.wants(s));
    for (const state of states) {
      await ensureLoaded(state);
      const since = msg.lastEventIndex?.[state.id] ?? 0;
      const action = resumeAction(since, state.events.length, sameBoot);
      if (action.kind === 'noop') continue;
      if (action.kind === 'events') {
        // Include current agent defs: the gap being replayed may contain events
        // for agents whose defs the client never received.
        this.send({ type: 'events', sessionId: state.id, events: state.events.slice(action.from), from: action.from, agents: [...state.agents.values()] });
      } else {
        this.send({ type: 'snapshot', sessionId: state.id, session: this.store.snapshot(state), eventOffset: 0, done: true });
      }
    }
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json' } });
}

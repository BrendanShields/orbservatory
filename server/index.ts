import type { ServerWebSocket } from 'bun';
import { existsSync } from 'node:fs';
import type { ClientMessage, SearchRequest, SearchResponse, ServerMessage, SessionSource, Settings } from '../shared/schema';
import { SessionStore, type SessionState, type Subscriber } from './store';
import { ClaudeProjectWatcher } from './providers/claude';
import { CodexProvider, defaultCodexRoot } from './providers/codex';
import { OpencodeProvider, defaultOpencodeDataDir, findOpencodeDb } from './providers/opencode';
import { CopilotProvider, defaultCopilotRoot } from './providers/copilot';
import type { SessionProvider } from './providers/types';
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
// Historical-stats cache is claude-only for now; other providers surface
// event-derived (partial) stats once their sessions load.
const statsCache = new StatsCache();

const providerFactories: Record<SessionSource, () => SessionProvider | null> = {
  claude: () => new ClaudeProjectWatcher(store, { root: cfg.root, pollMs: cfg.pollMs, livenessMs: cfg.livenessMs, statsCache }),
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
  store.setStatsConfig(s.pricing, s.tierThresholds);
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

// macOS SO_REUSEPORT can let two Bun processes silently share one port, which
// splits requests across mismatched bundles (blank screen: HTML from one
// process, chunk 404s from the other). Refuse to start if the port is taken.
try {
  const probeHost = cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host;
  const probe = await fetch(`http://${probeHost}:${cfg.port}/api/health`, { signal: AbortSignal.timeout(500) });
  if (probe.ok) {
    console.error(`claude-viz: another server is already listening on ${probeHost}:${cfg.port} — stop it or pass --port <n>.`);
    process.exit(1);
  }
} catch {
  // connection refused / timeout — port is free
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
    const states = this.store.all().filter(s => this.wants(s));
    for (const state of states) {
      await ensureLoaded(state);
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

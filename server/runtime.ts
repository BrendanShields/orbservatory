import { existsSync } from 'node:fs';
import type { ClientMessage, SearchRequest, SearchResponse, ServerMessage, SessionSource, Settings, TranscriptResponse } from '../shared/schema';
import { SessionStore, type SessionState, type Subscriber } from './store';
import { ClaudeProjectWatcher } from './providers/claude';
import { CodexProvider, defaultCodexRoot } from './providers/codex';
import { OpencodeProvider, defaultOpencodeDataDir, findOpencodeDb } from './providers/opencode';
import { CopilotProvider, defaultCopilotRoot } from './providers/copilot';
import { PiProvider, defaultPiRoot } from './providers/pi';
import type { SessionProvider } from './providers/types';
import type { TranscriptQuery } from './transcript';
import { StatsCache } from './statsCache';
import { searchDocs } from './searchIndex';
import { SettingsStore } from './settings';
import { resolveConfig } from './config';
import { resumeAction } from './resume';

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
}

export const WS_OPEN = 1;

export class VisualiserRuntime {
  readonly settings = new SettingsStore();
  readonly bootId = crypto.randomUUID();
  readonly ready: Promise<void>;

  store!: SessionStore;

  private providers = new Map<SessionSource, SessionProvider>();
  private statsCache = new StatsCache();
  private started = false;

  constructor() {
    this.ready = this.init();
  }

  private async init() {
    await this.settings.load();
    const cfg = resolveConfig(this.settings.get());
    this.store = new SessionStore({
      livenessMs: cfg.livenessMs,
      contextLimits: cfg.contextLimits,
      bootId: this.bootId,
      pricing: this.settings.get().pricing,
      tierThresholds: this.settings.get().tierThresholds,
    });
    this.syncProviders(this.settings.get());
    this.started = true;
  }

  private providerFactories(): Record<SessionSource, () => SessionProvider | null> {
    const cfg = resolveConfig(this.settings.get());
    return {
      claude: () => new ClaudeProjectWatcher(this.store, { root: cfg.root, pollMs: cfg.pollMs, livenessMs: cfg.livenessMs, statsCache: this.statsCache }),
      codex: () => (existsSync(defaultCodexRoot()) ? new CodexProvider(this.store, { pollMs: cfg.pollMs, livenessMs: cfg.livenessMs }) : null),
      opencode: () => (findOpencodeDb(defaultOpencodeDataDir()) ? new OpencodeProvider(this.store, { pollMs: cfg.pollMs, livenessMs: cfg.livenessMs }) : null),
      copilot: () => (existsSync(defaultCopilotRoot()) ? new CopilotProvider(this.store, { pollMs: cfg.pollMs, livenessMs: cfg.livenessMs }) : null),
      pi: () => (existsSync(defaultPiRoot()) ? new PiProvider(this.store, { pollMs: cfg.pollMs, livenessMs: cfg.livenessMs }) : null),
    };
  }

  private syncProviders(s: Settings) {
    const factories = this.providerFactories();
    for (const source of Object.keys(factories) as SessionSource[]) {
      const want = s.providers[source] !== false;
      const running = this.providers.get(source);
      if (want && !running) {
        try {
          const p = factories[source]();
          if (p) { p.start(); this.providers.set(source, p); }
        } catch (err) {
          console.error(`[${source}] provider failed to start; continuing without it`, err);
        }
      } else if (!want && running) {
        running.stop();
        this.providers.delete(source);
      }
    }
  }

  private applySettings(s: Settings) {
    this.store.setLivenessMs(s.livenessMs);
    this.store.setContextLimits(s.contextLimits);
    this.store.setStatsConfig(s.pricing, s.tierThresholds);
    this.syncProviders(s);
    for (const p of this.providers.values()) {
      p.setLivenessMs(s.livenessMs);
      p.setPollMs(s.pollMs);
    }
  }

  async ensureLoaded(state: SessionState) {
    await this.ready;
    const provider = this.providers.get(state.source);
    if (provider) await provider.ensureLoaded(state);
  }

  async sessions() {
    await this.ready;
    return this.store.summaries();
  }

  async getSettings() {
    await this.ready;
    return this.settings.get();
  }

  async patchSettings(patch: Partial<Settings>) {
    await this.ready;
    const next = await this.settings.patch(patch);
    this.applySettings(next);
    this.store.broadcastSettings(next);
    return next;
  }

  async search(body: SearchRequest | null): Promise<SearchResponse> {
    await this.ready;
    const q = typeof body?.q === 'string' ? body.q.trim() : '';
    const allow = Array.isArray(body?.sessionIds) ? new Set(body.sessionIds.map(String)) : undefined;
    const limit = Math.min(Math.max(Math.trunc(Number(body?.limit)) || 100, 1), 500);
    return this.runSearch(q, allow, limit);
  }

  async exportSession(id: string) {
    await this.ready;
    const state = this.store.get(id);
    if (!state) return null;
    await this.ensureLoaded(state);
    return this.store.snapshot(state);
  }

  /** Extractors read disk directly — no ensureLoaded. Throws (ENOENT) when the source vanished. */
  async transcript(id: string, q: TranscriptQuery): Promise<TranscriptResponse | { unsupported: true } | null> {
    await this.ready;
    const state = this.store.get(id);
    if (!state) return null;
    const provider = this.providers.get(state.source);
    if (!provider?.transcript) return { unsupported: true };
    const res = await provider.transcript(state, q);
    return res ?? { unsupported: true };
  }

  addWebSocket(ws: WebSocketLike): WsSubscriber {
    const sub = new WsSubscriber(ws, this);
    this.store.addSubscriber(sub);
    sub.send({ type: 'settings', settings: this.settings.get() });
    return sub;
  }

  removeSubscriber(sub: Subscriber) {
    this.store.removeSubscriber(sub);
  }

  private runSearch(q: string, allow: Set<string> | undefined, limit: number): SearchResponse {
    const candidates = this.store.all().filter(s => !allow || allow.has(s.id));
    const total = candidates.length;
    if (!q) return { matches: [], partial: false, scanned: 0, total };
    const matches = searchDocs(this.store.searchDocs(), q, allow, limit);
    const scanned = candidates.filter(s => this.store.hasSearchDoc(s)).length;
    const partial = scanned < total || matches.length >= limit;
    return { matches, partial, scanned, total };
  }

  close() {
    if (!this.started) return;
    for (const p of this.providers.values()) p.stop();
    this.providers.clear();
    this.started = false;
  }
}

class WsSubscriber implements Subscriber {
  private mode: 'all-live' | 'ids' = 'all-live';
  private ids = new Set<string>();

  constructor(private ws: WebSocketLike, private runtime: VisualiserRuntime) {}

  send(message: ServerMessage) {
    if (this.ws.readyState === WS_OPEN) this.ws.send(JSON.stringify(message));
  }

  wants(state: SessionState): boolean {
    return this.mode === 'all-live' ? state.live : this.ids.has(state.id);
  }

  wantsExplicitly(state: SessionState): boolean {
    return this.mode === 'ids' && this.ids.has(state.id);
  }

  async handle(msg: ClientMessage) {
    await this.runtime.ready;
    if (msg.type === 'ping') { this.send({ type: 'pong' }); return; }
    if (msg.type !== 'subscribe') return;
    if (msg.sessionIds === 'all-live') { this.mode = 'all-live'; this.ids.clear(); }
    else { this.mode = 'ids'; this.ids = new Set(msg.sessionIds); }
    const sameBoot = msg.bootId === this.runtime.bootId;
    const states = this.runtime.store.all().filter(s => this.wants(s));
    for (const state of states) {
      await this.runtime.ensureLoaded(state);
      const since = msg.lastEventIndex?.[state.id] ?? 0;
      const action = resumeAction(since, state.events.length, sameBoot);
      if (action.kind === 'noop') continue;
      if (action.kind === 'events') {
        this.send({ type: 'events', sessionId: state.id, events: state.events.slice(action.from), from: action.from, agents: [...state.agents.values()] });
      } else {
        this.send({ type: 'snapshot', sessionId: state.id, session: this.runtime.store.snapshot(state), eventOffset: 0, done: true });
      }
    }
  }
}

const globalRuntime = globalThis as typeof globalThis & { __claudeVizRuntime?: VisualiserRuntime };

export function getRuntime(): VisualiserRuntime {
  return globalRuntime.__claudeVizRuntime ??= new VisualiserRuntime();
}

export async function json(data: unknown, status = 200): Promise<Response> {
  return Response.json(data, { status });
}

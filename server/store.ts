import type { AwvAgent, AwvEvent, AwvSession, SessionSummary, ServerMessage } from '../shared/schema';
import { eventRank } from '../shared/order';
import { TranscriptNormalizer } from './normalizer';

export interface SessionState {
  id: string;
  project: string;
  sessionId: string;
  rootFile: string;
  sessionDir: string;
  cwd?: string;
  lastActive: number;
  loaded: boolean;
  loading: boolean;
  peeked: boolean;
  live: boolean;
  processing?: Promise<void>;
  normalizer: TranscriptNormalizer;
  agents: Map<string, AwvAgent>;
  events: AwvEvent[];
  files: Map<string, { offset: number; buffer: string; sourceKey: string }>;
}

export interface Subscriber {
  send(message: ServerMessage): void;
  wants(state: SessionState): boolean;
  /** True only when this subscriber explicitly asked for this session by id (keeps non-live sessions loaded). */
  wantsExplicitly(state: SessionState): boolean;
}

export class SessionStore {
  private sessions = new Map<string, SessionState>();
  private subscribers = new Set<Subscriber>();
  private livenessMs: number;
  private contextLimits: Record<string, number>;
  private lastSummariesDigest = '';

  constructor(opts?: { livenessMs?: number; contextLimits?: Record<string, number> }) {
    this.livenessMs = opts?.livenessMs ?? 5 * 60_000;
    this.contextLimits = opts?.contextLimits ?? {};
  }

  setLivenessMs(ms: number) {
    this.livenessMs = ms;
  }

  setContextLimits(limits: Record<string, number>) {
    this.contextLimits = limits;
  }

  upsertSession(meta: { id: string; project: string; sessionId: string; rootFile: string; sessionDir: string; cwd?: string; lastActive: number }): SessionState {
    let s = this.sessions.get(meta.id);
    if (!s) {
      s = {
        ...meta,
        loaded: false,
        loading: false,
        peeked: false,
        live: Date.now() - meta.lastActive < this.livenessMs,
        normalizer: new TranscriptNormalizer({ sessionId: meta.sessionId, project: meta.project, cwd: meta.cwd, contextLimits: this.contextLimits }),
        agents: new Map(),
        events: [],
        files: new Map(),
      };
      this.sessions.set(meta.id, s);
    } else {
      s.lastActive = Math.max(s.lastActive, meta.lastActive);
      s.cwd = s.cwd || meta.cwd;
      s.live = Date.now() - s.lastActive < this.livenessMs;
    }
    return s;
  }

  get(id: string): SessionState | undefined {
    return this.sessions.get(id);
  }

  all(): SessionState[] {
    return [...this.sessions.values()].sort((a, b) => b.lastActive - a.lastActive);
  }

  /** True when some subscriber asked for this session by id (so we keep tailing it even when not live). */
  hasExplicitInterest(state: SessionState): boolean {
    for (const sub of this.subscribers) if (sub.wantsExplicitly(state)) return true;
    return false;
  }

  summaries(): SessionSummary[] {
    return this.all().map((s) => ({
      id: s.id,
      project: s.project,
      projectName: s.normalizer.projectName,
      title: s.normalizer.title || s.sessionId,
      cwd: s.cwd || s.normalizer.cwd,
      live: Date.now() - s.lastActive < this.livenessMs,
      lastActive: s.lastActive,
      startedAt: s.normalizer.startedAt || undefined,
      eventCount: s.events.length,
      agentCount: s.agents.size,
    }));
  }

  merge(state: SessionState, agents: AwvAgent[], events: AwvEvent[]) {
    let changed = false;
    for (const agent of agents) {
      state.agents.set(agent.id, agent);
      changed = true;
    }
    if (events.length) {
      // Append-only: the stored log preserves arrival order so a subscriber's
      // array-index cursor stays valid even when a later poll surfaces
      // out-of-order events (root vs subagent files in one tick). Canonical
      // time ordering is applied at read time in snapshot(); the client also
      // sorts every batch it receives, so display order is unaffected.
      state.events.push(...events);
      let lastTs = 0;
      for (const e of events) {
        const n = e.ts ? Date.parse(e.ts) : 0;
        if (Number.isFinite(n) && n > lastTs) lastTs = n;
      }
      if (lastTs > 0) state.lastActive = Math.max(state.lastActive, lastTs);
      changed = true;
    }
    if (!state.loading && (events.length || agents.length)) {
      const from = Math.max(0, state.events.length - events.length);
      const upserts = agents.length ? agents : undefined;
      for (const sub of this.subscribers) {
        if (sub.wants(state)) sub.send({ type: 'events', sessionId: state.id, events, from, agents: upserts });
      }
    }
    if (changed && !state.loading) this.broadcastSessions();
  }

  /** Called once when a session's initial full read completes. */
  finishLoad(state: SessionState) {
    state.loaded = true;
    state.loading = false;
  }

  snapshot(state: SessionState): AwvSession {
    // The stored log is append-ordered; hand the normalizer a time-sorted copy
    // so snapshot events are canonical. Sorting a copy keeps array-index
    // cursors (used for reconnect resync) stable against the append-only log.
    const ordered = state.events.slice().sort(byTime);
    const sc = state.normalizer.snapshot(ordered);
    // The normalizer owns canonical agent ordering, but make sure late merged agents are present.
    const byId = new Map(sc.agents.map((a) => [a.id, a]));
    for (const a of state.agents.values()) byId.set(a.id, a);
    sc.agents = [...byId.values()];
    return sc;
  }

  addSubscriber(sub: Subscriber) {
    this.subscribers.add(sub);
    sub.send({ type: 'sessions', sessions: this.summaries() });
  }

  removeSubscriber(sub: Subscriber) {
    this.subscribers.delete(sub);
  }

  broadcastSettings(settings: import('../shared/schema').Settings) {
    const msg: ServerMessage = { type: 'settings', settings };
    for (const sub of this.subscribers) sub.send(msg);
  }

  broadcastSessions() {
    const sessions = this.summaries();
    const digest = JSON.stringify(sessions);
    if (digest === this.lastSummariesDigest) return;
    this.lastSummariesDigest = digest;
    const msg: ServerMessage = { type: 'sessions', sessions };
    for (const sub of this.subscribers) sub.send(msg);
  }
}

function byTime(a: AwvEvent, b: AwvEvent): number {
  return a.t - b.t || eventRank(a.type) - eventRank(b.type);
}

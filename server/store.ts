import type { AwvAgent, AwvEvent, AwvSession, ModelPricing, SearchPart, SessionSource, SessionStats, SessionStatsBase, SessionSummary, ServerMessage, TierThresholds } from '../shared/schema';
import { eventRank } from '../shared/order';
import { TranscriptNormalizer } from './normalizer';
import type { SessionNormalizer } from './providers/types';
import type { FileCursor } from './providers/tail';
import { computeSessionStats, DEFAULT_TIER_THRESHOLDS, finalizeStats } from './stats';

export interface SessionState {
  id: string;
  source: SessionSource;
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
  normalizer: SessionNormalizer;
  agents: Map<string, AwvAgent>;
  events: AwvEvent[];
  files: Map<string, FileCursor>;
  /** Pricing-independent stats — recomputed from the live normalizer or restored from the disk cache. */
  statsBase?: SessionStatsBase;
  /** Loaded sessions have stale statsBase until the next flush. */
  statsDirty?: boolean;
  /** Search doc for sessions whose stats came from the cache/background parse (loaded sessions use the normalizer's). */
  searchParts?: SearchPart[];
  /** Source-file fingerprint statsBase was computed from (background full-parse path). */
  statsFingerprint?: string;
  /** Cheap `${mtime}:${size}` of the root file at last stats attempt — change re-queues. */
  statsRootStamp?: string;
  statsQueued?: boolean;
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
  private pricing: Record<string, ModelPricing>;
  private tierThresholds: TierThresholds;
  private lastSummariesDigest = '';
  private bootId?: string;

  constructor(opts?: { livenessMs?: number; contextLimits?: Record<string, number>; pricing?: Record<string, ModelPricing>; tierThresholds?: TierThresholds; bootId?: string }) {
    this.livenessMs = opts?.livenessMs ?? 5 * 60_000;
    this.contextLimits = opts?.contextLimits ?? {};
    this.pricing = opts?.pricing ?? {};
    this.tierThresholds = opts?.tierThresholds ?? DEFAULT_TIER_THRESHOLDS;
    this.bootId = opts?.bootId;
  }

  setLivenessMs(ms: number) {
    this.livenessMs = ms;
  }

  /** Pricing map / tier thresholds changed: re-finalize every known stats record and re-broadcast. */
  setStatsConfig(pricing: Record<string, ModelPricing>, tierThresholds: TierThresholds) {
    const changed = JSON.stringify(this.pricing) !== JSON.stringify(pricing)
      || JSON.stringify(this.tierThresholds) !== JSON.stringify(tierThresholds);
    this.pricing = pricing ?? {};
    this.tierThresholds = tierThresholds ?? DEFAULT_TIER_THRESHOLDS;
    if (changed) this.broadcastStats([...this.sessions.values()].filter((s) => s.statsBase));
  }

  getContextLimits(): Record<string, number> {
    return this.contextLimits;
  }

  setContextLimits(limits: Record<string, number>) {
    this.contextLimits = limits;
    for (const state of this.sessions.values()) {
      const changed = state.normalizer.setContextLimits(limits);
      if (changed.length) this.merge(state, changed, []);
    }
  }

  upsertSession(meta: { id: string; source?: SessionSource; project: string; sessionId: string; rootFile: string; sessionDir: string; cwd?: string; lastActive: number; makeNormalizer?: () => SessionNormalizer }): SessionState {
    let s = this.sessions.get(meta.id);
    if (!s) {
      const { makeNormalizer, ...rest } = meta;
      const normalizer = makeNormalizer
        ? makeNormalizer()
        : new TranscriptNormalizer({ sessionId: meta.sessionId, project: meta.project, cwd: meta.cwd, contextLimits: this.contextLimits });
      if (makeNormalizer) normalizer.setContextLimits(this.contextLimits);
      s = {
        ...rest,
        source: meta.source ?? 'claude',
        loaded: false,
        loading: false,
        peeked: false,
        live: Date.now() - meta.lastActive < this.livenessMs,
        normalizer,
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
      source: s.source,
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
    if (changed) state.statsDirty = true;
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
    state.statsDirty = true;
  }

  /**
   * A source file was rewritten in place (shrunk): every event already derived
   * from the old contents is stale, so drop all derived state and let the
   * provider re-ingest from scratch. `loading` stays true until finishLoad so
   * merge() doesn't stream the re-read as incremental events.
   */
  resetSession(state: SessionState, makeNormalizer?: () => SessionNormalizer) {
    state.agents.clear();
    state.events.length = 0;
    state.files.clear();
    const normalizer = makeNormalizer
      ? makeNormalizer()
      : new TranscriptNormalizer({ sessionId: state.sessionId, project: state.project, cwd: state.cwd, contextLimits: this.contextLimits });
    if (makeNormalizer) normalizer.setContextLimits(this.contextLimits);
    state.normalizer = normalizer;
    state.loaded = false;
    state.loading = true;
    state.statsDirty = true;
  }

  /** Replace subscribers' copy of a session wholesale (after an in-place rewrite re-ingest). */
  pushSnapshot(state: SessionState) {
    const msg: ServerMessage = { type: 'snapshot', sessionId: state.id, session: this.snapshot(state), eventOffset: 0, done: true };
    for (const sub of this.subscribers) {
      if (sub.wants(state)) sub.send(msg);
    }
  }

  /** Stats + search doc computed off-thread of the live pipeline (cache hit or background full parse). */
  setExternalStats(state: SessionState, base: SessionStatsBase, search: SearchPart[]) {
    if (state.loaded) return; // live normalizer path is authoritative once loaded
    state.statsBase = base;
    state.searchParts = search;
    state.statsDirty = false;
    this.broadcastStats([state]);
  }

  statsOf(state: SessionState): SessionStats | null {
    if (!state.statsBase) return null;
    return finalizeStats(state.statsBase, { pricing: this.pricing, tierThresholds: this.tierThresholds });
  }

  allStats(): SessionStats[] {
    this.flushDirtyStats(false);
    const out: SessionStats[] = [];
    for (const s of this.all()) {
      const st = this.statsOf(s);
      if (st) out.push(st);
    }
    return out;
  }

  /** Recompute stats for loaded sessions whose transcript advanced since the last flush. */
  private flushDirtyStats(broadcast = true) {
    const changed: SessionState[] = [];
    for (const s of this.sessions.values()) {
      if (!s.statsDirty || !s.loaded || s.loading) continue;
      s.statsBase = computeSessionStats({ id: s.id, normalizer: s.normalizer, events: s.events });
      s.statsDirty = false;
      changed.push(s);
    }
    if (broadcast && changed.length) this.broadcastStats(changed);
  }

  private broadcastStats(states: SessionState[]) {
    const stats = states.map((s) => this.statsOf(s)).filter((s): s is SessionStats => !!s);
    if (!stats.length) return;
    const msg: ServerMessage = { type: 'stats', stats };
    for (const sub of this.subscribers) sub.send(msg);
  }

  /** Search docs (title + extracted text) for every session that has one. */
  *searchDocs(): IterableIterator<[string, SearchPart[]]> {
    for (const s of this.all()) {
      const parts = s.loaded ? s.normalizer.searchParts : s.searchParts;
      if (!parts || !parts.length) {
        const title = s.normalizer.title;
        if (title) yield [s.id, [{ f: 'title', s: title }]];
        continue;
      }
      yield [s.id, [{ f: 'title', s: s.normalizer.title || s.sessionId }, ...parts]];
    }
  }

  /** True when a session still lacks a search doc (background parse hasn't reached it). */
  hasSearchDoc(state: SessionState): boolean {
    const parts = state.loaded ? state.normalizer.searchParts : state.searchParts;
    return !!parts;
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
    sub.send({ type: 'sessions', sessions: this.summaries(), bootId: this.bootId });
    const stats = this.allStats();
    if (stats.length) sub.send({ type: 'stats', stats });
  }

  removeSubscriber(sub: Subscriber) {
    this.subscribers.delete(sub);
  }

  broadcastSettings(settings: import('../shared/schema').Settings) {
    const msg: ServerMessage = { type: 'settings', settings };
    for (const sub of this.subscribers) sub.send(msg);
  }

  broadcastSessions() {
    this.flushDirtyStats();
    const sessions = this.summaries();
    const digest = JSON.stringify(sessions);
    if (digest === this.lastSummariesDigest) return;
    this.lastSummariesDigest = digest;
    const msg: ServerMessage = { type: 'sessions', sessions, bootId: this.bootId };
    for (const sub of this.subscribers) sub.send(msg);
  }
}

function byTime(a: AwvEvent, b: AwvEvent): number {
  return a.t - b.t || eventRank(a.type) - eventRank(b.type);
}

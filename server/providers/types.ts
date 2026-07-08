import type { AwvAgent, AwvEvent, AwvSession, SearchPart, SessionSource, TokenTotals } from '../../shared/schema';
import type { SessionState } from '../store';

/** Minimal normalizer surface the store depends on; each provider supplies its own implementation. */
export interface SessionNormalizer {
  title: string;
  cwd?: string;
  startedAt: number;
  readonly projectName: string;
  setContextLimits(limits: Record<string, number>): AwvAgent[];
  snapshot(events: AwvEvent[]): AwvSession;

  // Optional stats/search surface. Providers that expose it get token-accurate
  // session stats and full-text search; the rest degrade to event-derived
  // stats (marked partial) and title-only search until they implement it.
  usageByModel?: ReadonlyMap<string, TokenTotals>;
  skills?: Record<string, number>;
  userTurns?: number;
  lastActiveTs?: number;
  parseFailures?: number;
  searchParts?: SearchPart[];
  getAgents?(): AwvAgent[];
}

export interface SessionProvider {
  readonly source: SessionSource;
  start(): void;
  stop(): void;
  /** Test hook, same contract as the Claude watcher's scan(). */
  scan(): Promise<void>;
  setPollMs(ms: number): void;
  setLivenessMs(ms: number): void;
  /** Fully parse a session on demand (subscriber asked for a historical session). */
  ensureLoaded(state: SessionState): Promise<void>;
}

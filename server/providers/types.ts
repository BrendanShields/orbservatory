import type { AwvAgent, AwvEvent, AwvSession, AwvTask, SearchPart, SessionSource, TokenTotals, TranscriptResponse } from '../../shared/schema';
import type { SessionState } from '../store';
import type { TranscriptQuery } from '../transcript';

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
  /** Live task list (Claude TodoWrite/TaskCreate/TaskUpdate); providers without one omit it. */
  tasks?: AwvTask[];
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
  /** Read-only transcript page straight from disk; never touches tail cursors or live normalizer state. */
  transcript?(state: SessionState, q: TranscriptQuery): Promise<TranscriptResponse | null>;
}

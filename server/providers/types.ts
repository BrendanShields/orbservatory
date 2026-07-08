import type { AwvAgent, AwvEvent, AwvSession, SessionSource } from '../../shared/schema';
import type { SessionState } from '../store';

/** Minimal normalizer surface the store depends on; each provider supplies its own implementation. */
export interface SessionNormalizer {
  title: string;
  cwd?: string;
  startedAt: number;
  readonly projectName: string;
  setContextLimits(limits: Record<string, number>): AwvAgent[];
  snapshot(events: AwvEvent[]): AwvSession;
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

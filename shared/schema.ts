export type AgentColor = 'gold' | 'cyan' | 'purple' | 'pink' | 'green' | 'red' | 'slate' | string;

export type SessionSource = 'claude' | 'codex' | 'opencode' | 'copilot';

export interface AgentToolStats {
  read?: number;
  edit?: number;
  bash?: number;
  search?: number;
  other?: number;
  linesAdded?: number;
  linesRemoved?: number;
}

export interface AwvAgent {
  id: string;
  name: string;
  color?: AgentColor;
  limit?: number;
  task?: string;
  role?: string;
  agentType?: string;
  subagentType?: string;
  model?: string;
  durationMs?: number;
  finalStatus?: 'completed' | 'error' | 'interrupted' | 'async_launched';
  totalTokens?: number;
  toolCount?: number;
  toolStats?: AgentToolStats;
  result?: string;
  source?: 'transcript' | 'hook' | 'both';
}

export type AwvEvent =
  | { t: number; ts?: string; type: 'spawn'; agent: string; parent?: string; tokens?: number; label?: string }
  | { t: number; ts?: string; type: 'message'; from?: string; to?: string; label?: string; tokens?: number }
  | { t: number; ts?: string; type: 'tool'; agent: string; tool: string; label?: string; tokens?: number; useId?: string; exitCode?: number; filePath?: string }
  | { t: number; ts?: string; type: 'compact'; agent: string; to: number; label?: string; trigger?: 'auto' | 'manual' }
  | { t: number; ts?: string; type: 'error'; agent: string; label?: string }
  | { t: number; ts?: string; type: 'retry'; agent: string; label?: string }
  | { t: number; ts?: string; type: 'complete'; agent: string; label?: string };

export interface AwvSession {
  name: string;
  desc?: string;
  agents: AwvAgent[];
  events: AwvEvent[];
}

export interface Settings {
  palette: string;
  layout: string;
  showGrid: boolean;
  livenessMs: number;
  pollMs: number;
  contextLimits: Record<string, number>;
  providers: Record<string, boolean>;
  port: number;
}

export interface SessionSummary {
  id: string;
  source: SessionSource;
  project: string;
  projectName: string;
  title: string;
  cwd?: string;
  live: boolean;
  lastActive: number;
  startedAt?: number;
  eventCount: number;
  agentCount: number;
}

export type ClientMessage =
  | { type: 'subscribe'; sessionIds: string[] | 'all-live'; lastEventIndex?: Record<string, number> }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'snapshot'; sessionId: string; session: AwvSession; eventOffset: number; done?: boolean }
  | { type: 'events'; sessionId: string; events: AwvEvent[]; from: number; agents?: AwvAgent[] }
  | { type: 'settings'; settings: Settings }
  | { type: 'pong' }
  | { type: 'error'; message: string };

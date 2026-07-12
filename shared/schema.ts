export type AgentColor = 'gold' | 'cyan' | 'purple' | 'pink' | 'green' | 'red' | 'slate' | string;

export type SessionSource = 'claude' | 'codex' | 'opencode' | 'copilot' | 'pi';

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

export type AwvTaskStatus = 'pending' | 'in_progress' | 'completed';

export interface AwvTask {
  /** Harness task id when known (TaskCreate result); TodoWrite items have none. */
  id?: string;
  subject: string;
  status: AwvTaskStatus;
}

export interface AwvSession {
  name: string;
  desc?: string;
  agents: AwvAgent[];
  events: AwvEvent[];
  tasks?: AwvTask[];
}

export interface ModelPricing {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface TierThresholds {
  /** "Simple" requires 0 subagents and fewer tool calls than this. */
  simpleMaxTools: number;
  /** "Complex" when subagents >= this… */
  complexMinSubagents: number;
  /** …or tool calls >= this, or any compaction. */
  complexMinTools: number;
}

export interface Settings {
  palette: string;
  layout: string;
  theme: 'system' | 'light' | 'dark';
  canvasStyle: 'match' | 'dark';
  maskProjects: boolean;
  showGrid: boolean;
  showSubagentNames: boolean;
  showOrchestratorName: boolean;
  livenessMs: number;
  pollMs: number;
  contextLimits: Record<string, number>;
  providers: Record<string, boolean>;
  pricing: Record<string, ModelPricing>;
  tierThresholds: TierThresholds;
  port: number;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

export type SessionTier = 'simple' | 'moderate' | 'complex';

/** Pricing/threshold-independent stats computed from one full transcript parse (cacheable). */
export interface SessionStatsBase {
  sessionId: string;
  tokens: TokenTotals;
  tokensByModel: Record<string, TokenTotals>;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  distinctTools: number;
  skills: Record<string, number>;
  subagentCount: number;
  treeDepth: number;
  compactions: number;
  retries: number;
  errors: number;
  userTurns: number;
  durationMs: number;
  models: string[];
  firstActive: number;
  lastActive: number;
  partial?: boolean;
}

export interface SessionStats extends SessionStatsBase {
  /** Present only when every used model is in the pricing map. */
  costUsd?: number;
  tier: SessionTier;
}

export type SearchField = 'prompt' | 'assistant' | 'tool' | 'skill' | 'title';

export interface SearchPart {
  f: SearchField;
  s: string;
}

export interface SearchRequest {
  q: string;
  /** Optional allowlist (client-side metadata filter intersection). */
  sessionIds?: string[];
  limit?: number;
}

export interface SearchMatch {
  sessionId: string;
  field: SearchField;
  snippet: string;
}

export interface SearchResponse {
  matches: SearchMatch[];
  /** True when the scan hit its time budget before covering every candidate. */
  partial: boolean;
  scanned: number;
  total: number;
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
  | { type: 'subscribe'; sessionIds: string[] | 'all-live'; lastEventIndex?: Record<string, number>; bootId?: string }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'sessions'; sessions: SessionSummary[]; bootId?: string }
  | { type: 'snapshot'; sessionId: string; session: AwvSession; eventOffset: number; done?: boolean }
  | { type: 'events'; sessionId: string; events: AwvEvent[]; from: number; agents?: AwvAgent[]; tasks?: AwvTask[] }
  | { type: 'stats'; stats: SessionStats[] }
  | { type: 'settings'; settings: Settings }
  | { type: 'pong' }
  | { type: 'error'; message: string };

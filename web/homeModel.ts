import type { SessionStats, SessionSource, SessionSummary, SessionTier, TokenTotals } from '../shared/schema';

/** One Home row: cheap summary always present, stats fill in as parses land. */
export interface HomeRow {
  sum: SessionSummary;
  stats?: SessionStats;
}

export interface HomeFilter {
  /** Free text — matched against metadata client-side; full-text ids arrive from the server. */
  text: string;
  /** Session ids matched by server full-text search; null = no server results yet/none pending. */
  textIds: Set<string> | null;
  source: SessionSource | 'all';
  project: string | 'all';
  model: string | 'all';
  tier: SessionTier | 'all';
  skill: string | 'all';
  tool: string | 'all';
  liveOnly: boolean;
}

export const EMPTY_FILTER: HomeFilter = {
  text: '', textIds: null, source: 'all', project: 'all', model: 'all',
  tier: 'all', skill: 'all', tool: 'all', liveOnly: false,
};

export type SortKey = 'recent' | 'duration' | 'tokens' | 'cost' | 'tools' | 'subagents' | 'tier' | 'title';

const TIER_RANK: Record<SessionTier, number> = { simple: 0, moderate: 1, complex: 2 };

export function buildRows(sessions: SessionSummary[], stats: Map<string, SessionStats>): HomeRow[] {
  return sessions.map((sum) => ({ sum, stats: stats.get(sum.id) }));
}

/** Case-insensitive metadata match: title, project, id, model, skills, tools. */
function metaMatches(row: HomeRow, needle: string): boolean {
  const { sum, stats } = row;
  if (sum.title.toLowerCase().includes(needle)) return true;
  if (sum.projectName.toLowerCase().includes(needle) || sum.project.toLowerCase().includes(needle)) return true;
  if (sum.id.toLowerCase().startsWith(needle)) return true;
  if (!stats) return false;
  if (stats.models.some((m) => m.toLowerCase().includes(needle))) return true;
  if (Object.keys(stats.skills).some((s) => s.toLowerCase().includes(needle))) return true;
  if (Object.keys(stats.toolBreakdown).some((t) => t.toLowerCase().includes(needle))) return true;
  return false;
}

export function filterRows(rows: HomeRow[], f: HomeFilter): HomeRow[] {
  const needle = f.text.trim().toLowerCase();
  return rows.filter((row) => {
    const { sum, stats } = row;
    if (f.liveOnly && !sum.live) return false;
    if (f.source !== 'all' && sum.source !== f.source) return false;
    if (f.project !== 'all' && (sum.projectName || sum.project) !== f.project) return false;
    // Stats-backed facets: a session without stats yet can't prove a match — hide it
    // while the facet is active rather than showing false positives.
    if (f.model !== 'all' && !(stats && stats.models.includes(f.model))) return false;
    if (f.tier !== 'all' && !(stats && stats.tier === f.tier)) return false;
    if (f.skill !== 'all' && !(stats && f.skill in stats.skills)) return false;
    if (f.tool !== 'all' && !(stats && f.tool in stats.toolBreakdown)) return false;
    if (needle && !metaMatches(row, needle) && !(f.textIds && f.textIds.has(sum.id))) return false;
    return true;
  });
}

export function sortRows(rows: HomeRow[], key: SortKey, desc = true): HomeRow[] {
  const dir = desc ? -1 : 1;
  const val = (r: HomeRow): number | string => {
    switch (key) {
      case 'recent': return r.stats?.lastActive || r.sum.lastActive;
      case 'duration': return r.stats?.durationMs ?? -1;
      case 'tokens': return r.stats?.tokens.total ?? -1;
      case 'cost': return r.stats?.costUsd ?? -1;
      case 'tools': return r.stats?.toolCalls ?? -1;
      case 'subagents': return r.stats?.subagentCount ?? -1;
      case 'tier': return r.stats ? TIER_RANK[r.stats.tier] : -1;
      case 'title': return (r.sum.title || r.sum.id).toLowerCase();
    }
  };
  return rows.slice().sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va === vb) return b.sum.lastActive - a.sum.lastActive; // tiebreak: most recent first
    return (va < vb ? 1 : -1) * -dir;
  });
}

export interface HomeAggregates {
  count: number;
  liveCount: number;
  /** How many filtered rows have stats (drives "n of m analysed" copy). */
  statsReady: number;
  tokens: TokenTotals;
  /** Sum over priced rows only; pricedCount tells how complete it is. */
  costUsd: number;
  pricedCount: number;
  toolCalls: number;
  subagents: number;
  compactions: number;
  errors: number;
  tiers: Record<SessionTier, number>;
  topSkills: [string, number][];
  topTools: [string, number][];
  /** Total tokens per model across the filtered set, descending. */
  models: [string, number][];
}

const TOP_N = 5;

export function aggregate(rows: HomeRow[]): HomeAggregates {
  const tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
  const tiers: Record<SessionTier, number> = { simple: 0, moderate: 0, complex: 0 };
  const skills = new Map<string, number>();
  const tools = new Map<string, number>();
  const models = new Map<string, number>();
  let statsReady = 0, costUsd = 0, pricedCount = 0, toolCalls = 0, subagents = 0, compactions = 0, errors = 0, liveCount = 0;
  for (const { sum, stats } of rows) {
    if (sum.live) liveCount++;
    if (!stats) continue;
    statsReady++;
    tokens.input += stats.tokens.input;
    tokens.output += stats.tokens.output;
    tokens.cacheRead += stats.tokens.cacheRead;
    tokens.cacheCreation += stats.tokens.cacheCreation;
    tokens.total += stats.tokens.total;
    if (stats.costUsd != null) { costUsd += stats.costUsd; pricedCount++; }
    toolCalls += stats.toolCalls;
    subagents += stats.subagentCount;
    compactions += stats.compactions;
    errors += stats.errors;
    tiers[stats.tier]++;
    for (const [k, v] of Object.entries(stats.skills)) skills.set(k, (skills.get(k) || 0) + v);
    for (const [k, v] of Object.entries(stats.toolBreakdown)) tools.set(k, (tools.get(k) || 0) + v);
    for (const [k, v] of Object.entries(stats.tokensByModel)) models.set(k, (models.get(k) || 0) + v.total);
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N);
  return {
    count: rows.length, liveCount, statsReady, tokens, costUsd, pricedCount,
    toolCalls, subagents, compactions, errors, tiers,
    topSkills: top(skills), topTools: top(tools), models: top(models),
  };
}

export interface FacetOptions {
  projects: string[];
  models: string[];
  skills: string[];
  tools: string[];
}

/** Distinct facet values over the *unfiltered* set, most-frequent first. */
export function facetOptions(rows: HomeRow[]): FacetOptions {
  const projects = new Map<string, number>();
  const models = new Map<string, number>();
  const skills = new Map<string, number>();
  const tools = new Map<string, number>();
  for (const { sum, stats } of rows) {
    const p = sum.projectName || sum.project;
    if (p) projects.set(p, (projects.get(p) || 0) + 1);
    if (!stats) continue;
    for (const m of stats.models) models.set(m, (models.get(m) || 0) + 1);
    for (const s of Object.keys(stats.skills)) skills.set(s, (skills.get(s) || 0) + 1);
    for (const t of Object.keys(stats.toolBreakdown)) tools.set(t, (tools.get(t) || 0) + 1);
  }
  const names = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);
  return { projects: names(projects), models: names(models), skills: names(skills), tools: names(tools) };
}

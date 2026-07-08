import type { AwvEvent, ModelPricing, SessionStats, SessionStatsBase, SessionTier, TierThresholds, TokenTotals } from '../shared/schema';
import type { TranscriptNormalizer } from './normalizer';

export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  simpleMaxTools: 15,
  complexMinSubagents: 2,
  complexMinTools: 60,
};

export interface StatsInput {
  /** Store id (`project/sessionId`), the key the client already navigates by. */
  id: string;
  normalizer: TranscriptNormalizer;
  events: AwvEvent[];
}

/**
 * Pure derivation of a session's pricing-independent stats from fully parsed
 * normalizer state. Live and historical sessions both funnel through here;
 * live is near-free because the normalizer is already up to date.
 */
export function computeSessionStats(input: StatsInput): SessionStatsBase {
  const { normalizer, events } = input;
  const tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
  const tokensByModel: Record<string, TokenTotals> = {};
  for (const [model, t] of normalizer.usageByModel) {
    tokensByModel[model] = { ...t };
    tokens.input += t.input; tokens.output += t.output;
    tokens.cacheRead += t.cacheRead; tokens.cacheCreation += t.cacheCreation;
    tokens.total += t.total;
  }

  const toolBreakdown: Record<string, number> = {};
  let toolCalls = 0;
  let compactions = 0;
  let retries = 0;
  let errors = 0;
  let maxT = 0;
  const parentOf = new Map<string, string>();
  for (const e of events) {
    if (e.t > maxT) maxT = e.t;
    if (e.type === 'tool') { toolCalls++; toolBreakdown[e.tool] = (toolBreakdown[e.tool] || 0) + 1; }
    else if (e.type === 'compact') compactions++;
    else if (e.type === 'retry') retries++;
    else if (e.type === 'error') errors++;
    else if (e.type === 'spawn' && e.parent) parentOf.set(e.agent, e.parent);
  }

  let subagentCount = 0;
  for (const a of normalizer.getAgents()) {
    if (a.role === 'subagent' || a.role === 'workflow agent') subagentCount++;
  }
  let treeDepth = 0;
  for (const id of parentOf.keys()) {
    let d = 0;
    for (let p: string | undefined = id; p && parentOf.has(p) && d < 32; p = parentOf.get(p)) d++;
    if (d > treeDepth) treeDepth = d;
  }

  const firstActive = normalizer.startedAt || 0;
  const durationMs = maxT;
  const stats: SessionStatsBase = {
    sessionId: input.id,
    tokens,
    tokensByModel,
    toolCalls,
    toolBreakdown,
    distinctTools: Object.keys(toolBreakdown).length,
    skills: { ...normalizer.skills },
    subagentCount,
    treeDepth,
    compactions,
    retries,
    errors,
    userTurns: normalizer.userTurns,
    durationMs,
    models: [...normalizer.usageByModel.keys()].filter((m) => m !== 'unknown'),
    firstActive,
    lastActive: firstActive ? firstActive + durationMs : normalizer.lastActiveTs,
  };
  if (normalizer.parseFailures > 0) stats.partial = true;
  return stats;
}

export function tierOf(base: Pick<SessionStatsBase, 'subagentCount' | 'toolCalls' | 'compactions'>, th: TierThresholds): SessionTier {
  if (base.subagentCount >= th.complexMinSubagents || base.toolCalls >= th.complexMinTools || base.compactions > 0) return 'complex';
  if (base.subagentCount === 0 && base.toolCalls < th.simpleMaxTools) return 'simple';
  return 'moderate';
}

/** Dollars for the used tokens — undefined unless every used model is priced. */
export function costUsdOf(tokensByModel: Record<string, TokenTotals>, pricing: Record<string, ModelPricing>): number | undefined {
  const models = Object.keys(tokensByModel);
  if (!models.length) return undefined;
  let usd = 0;
  for (const model of models) {
    const rate = pricing[model];
    if (!rate) return undefined;
    const t = tokensByModel[model];
    usd += (t.input * rate.input + t.output * rate.output + t.cacheRead * rate.cacheRead + t.cacheCreation * rate.cacheCreation) / 1e6;
  }
  return usd;
}

/** Apply the settings-dependent fields (tier thresholds, pricing) to cached base stats. */
export function finalizeStats(base: SessionStatsBase, opts: { pricing: Record<string, ModelPricing>; tierThresholds: TierThresholds }): SessionStats {
  const out: SessionStats = { ...base, tier: tierOf(base, opts.tierThresholds) };
  const cost = costUsdOf(base.tokensByModel, opts.pricing);
  if (cost != null) out.costUsd = cost;
  return out;
}

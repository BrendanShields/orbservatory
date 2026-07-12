import type { SessionStats, SessionSummary, TokenTotals } from '../shared/schema';

export type InsightsRange = 7 | 30 | 90;

export interface DayBucket {
  /** YYYY-MM-DD, local calendar day. */
  day: string;
  tokens: TokenTotals;
  /** Whole-session costUsd attributed to the session's last model (matches home's model column). */
  costByModel: Record<string, number>;
  sessions: number;
  toolCalls: number;
  /** cacheRead / (input + cacheRead); null when the denominator is 0. */
  cacheRate: number | null;
  analysed: number;
}

export interface InsightsOpts {
  days: InsightsRange;
  project?: string;
  now?: number;
}

export interface Insights {
  buckets: DayBucket[];
  /** In-range sessions after the project filter; analysed ⊆ total have stats. */
  total: number;
  analysed: number;
}

function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Aggregate per-session stats into one bucket per local calendar day, ending
 * today. A session's whole totals land on the day of its lastActive (clamped
 * to now); sessions whose stats are still pending count toward sessions/total
 * only. Days are iterated via Date(y, m, d) so DST weeks stay 7 keys long.
 */
export function bucketByDay(stats: SessionStats[], summaries: SessionSummary[], opts: InsightsOpts): Insights {
  const now = opts.now ?? Date.now();
  const today = new Date(now);
  const buckets: DayBucket[] = [];
  const byDay = new Map<string, DayBucket>();
  for (let i = opts.days - 1; i >= 0; i--) {
    const b: DayBucket = {
      day: dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)),
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
      costByModel: {}, sessions: 0, toolCalls: 0, cacheRate: null, analysed: 0,
    };
    buckets.push(b);
    byDay.set(b.day, b);
  }
  const statsById = new Map(stats.map((s) => [s.sessionId, s]));
  let total = 0, analysed = 0;
  for (const sum of summaries) {
    if (opts.project && (sum.projectName || sum.project) !== opts.project) continue;
    const st = statsById.get(sum.id);
    const b = byDay.get(dayKey(new Date(Math.min(st?.lastActive || sum.lastActive, now))));
    if (!b) continue;
    total++; b.sessions++;
    if (!st) continue;
    analysed++; b.analysed++;
    b.tokens.input += st.tokens.input;
    b.tokens.output += st.tokens.output;
    b.tokens.cacheRead += st.tokens.cacheRead;
    b.tokens.cacheCreation += st.tokens.cacheCreation;
    b.tokens.total += st.tokens.total;
    b.toolCalls += st.toolCalls;
    if (st.costUsd != null) {
      const m = st.models[st.models.length - 1] || 'unknown';
      b.costByModel[m] = (b.costByModel[m] || 0) + st.costUsd;
    }
  }
  for (const b of buckets) {
    const den = b.tokens.input + b.tokens.cacheRead;
    b.cacheRate = den > 0 ? b.tokens.cacheRead / den : null;
  }
  return { buckets, total, analysed };
}

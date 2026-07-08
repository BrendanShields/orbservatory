import type { SessionStats, SessionTier, TokenTotals } from '../shared/schema';
import { esc } from './panels';

/** 1234 → "1.2k", 5_600_000 → "5.6M". Tokens are glanceable, not precise. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 100) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return n > 0 ? `$${n.toFixed(3)}` : '$0';
}

export function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 90_000) return 'now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

export function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const m = Math.round(ms / 60_000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.round(h / 24)}d`;
}

const TIER_LETTER: Record<SessionTier, string> = { simple: 'S', moderate: 'M', complex: 'C' };

/**
 * Tier badge. Raw driving numbers ride along in the tooltip so the badge is
 * never a black box (the table also shows subagents/tools as columns).
 */
export function tierBadge(stats: SessionStats | undefined): string {
  if (!stats) return `<span class="tier-badge pending" title="Analysing…">·</span>`;
  const t = stats.tier;
  const why = `${stats.subagentCount} subagents · ${stats.toolCalls} tool calls · ${stats.compactions} compactions`;
  const partial = stats.partial ? ' partial' : '';
  return `<span class="tier-badge ${t}${partial}" title="${esc(t)} — ${esc(why)}${stats.partial ? ' · incomplete transcript' : ''}">${TIER_LETTER[t]}<i>${esc(t)}</i></span>`;
}

/** Aggregate-strip tile. `sub` is a small secondary line (already-escaped HTML allowed via `subHtml`). */
export function tile(label: string, value: string, opts: { sub?: string; subHtml?: string; accent?: string } = {}): string {
  const sub = opts.subHtml ?? (opts.sub ? esc(opts.sub) : '');
  return `<div class="tile${opts.accent ? ` ${opts.accent}` : ''}"><span class="tile-v">${esc(value)}</span><span class="tile-l">${esc(label)}</span>${sub ? `<span class="tile-s">${sub}</span>` : ''}</div>`;
}

/** Stacked cache-split bar: input / output / cache-read / cache-creation. */
export function cacheSplitBar(t: TokenTotals): string {
  if (!t.total) return '';
  const seg = (n: number, cls: string, name: string) => {
    const pct = (n / t.total) * 100;
    return pct < 0.5 ? '' : `<i class="${cls}" style="width:${pct.toFixed(1)}%" title="${name}: ${fmtTokens(n)}"></i>`;
  };
  return `<span class="split-bar" role="img" aria-label="in ${fmtTokens(t.input)}, out ${fmtTokens(t.output)}, cache read ${fmtTokens(t.cacheRead)}, cache write ${fmtTokens(t.cacheCreation)}">${seg(t.input, 'in', 'input')}${seg(t.output, 'out', 'output')}${seg(t.cacheRead, 'cr', 'cache read')}${seg(t.cacheCreation, 'cc', 'cache write')}</span>`;
}

/** Small ranked chip list for top skills / tools / models. */
export function chipList(items: [string, number][], fmt: (n: number) => string = String): string {
  if (!items.length) return '<span class="chip none">—</span>';
  return items.map(([name, n]) => `<span class="chip" title="${esc(name)}: ${esc(fmt(n))}">${esc(name)}<b>${esc(fmt(n))}</b></span>`).join('');
}

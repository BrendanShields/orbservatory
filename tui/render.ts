import { StyledText, stringToStyledText, dim, fg, green, yellow, type TextChunk } from '@opentui/core';
import type { TuiState } from './client';
import { rootAgentId } from '../server/normalizer';

export const ACCENT = '#22d3ee';
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function bar(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** Green→yellow→red for a position in [0,1]. */
export function heat(p: number): string {
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const g = [74, 222, 128], y = [251, 191, 36], r = [248, 113, 113];
  const c = p < 0.5 ? mix(g, y, p * 2) : mix(y, r, (p - 0.5) * 2);
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Context bar where each filled cell walks the green→red gradient. */
export function gradientBar(ratio: number, width: number): TextChunk[] {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  const chunks: TextChunk[] = [];
  for (let i = 0; i < filled; i++) chunks.push(fg(heat(i / Math.max(1, width - 1)))('█'));
  if (filled < width) chunks.push(dim('░'.repeat(width - filled)));
  return chunks;
}

const SPARK = '▁▂▃▄▅▆▇█';

export function sparkline(values: number[], width: number): string {
  const vals = values.slice(-width);
  if (vals.length < 2) return '';
  const min = Math.min(...vals);
  const span = (Math.max(...vals) - min) || 1;
  return vals.map((v) => SPARK[Math.min(7, Math.floor(((v - min) / span) * 8))]).join('');
}

function truncLine(s: string, width: number): string {
  return s.length <= width ? s : s.slice(0, Math.max(0, width - 1)) + '…';
}

/** A plain unstyled chunk; only public way to make one is via stringToStyledText. */
function chunk(s: string): TextChunk {
  return stringToStyledText(s).chunks[0];
}

/** Join chunk rows into one StyledText with newlines between rows. */
function joinLines(rows: TextChunk[][]): StyledText {
  const out: TextChunk[] = [];
  rows.forEach((r, i) => {
    if (i) out.push(chunk('\n'));
    out.push(...r);
  });
  return new StyledText(out);
}

export type Activity = 'working' | 'idle' | 'ended';

export function activityOf(state: TuiState, nowMs: number): Activity {
  if (state.summary && !state.summary.live) return 'ended';
  if (state.lastEventMs && nowMs - state.lastEventMs < 15_000) return 'working';
  return 'idle';
}

function connLines(state: TuiState): TextChunk[][] {
  if (state.connection === 'open') return [];
  const text = state.connection === 'waiting'
    ? 'waiting for session to appear…'
    : state.connection === 'connecting' ? `connecting to ${state.baseUrl}…` : 'reconnecting…';
  return [[], [yellow(text)]];
}

/**
 * Body of the stats pane (title lives in the panel border). `tick` animates the
 * working spinner; `burn` is a sampled history of context tokens for the sparkline.
 */
export function renderStats(state: TuiState, width: number, nowMs: number, tick?: number, burn: number[] = []): StyledText {
  const w = Math.max(28, width);
  const rows: TextChunk[][] = [];
  const row = (label: string, ...value: TextChunk[]) => rows.push([dim(label.padEnd(9)), ...value]);

  const activity = activityOf(state, nowMs);
  const age = state.lastEventMs ? fmtDuration(nowMs - state.lastEventMs) : '—';
  const glyph = activity === 'working'
    ? fg(ACCENT)(tick == null ? '●' : SPINNER[tick % SPINNER.length])
    : activity === 'ended' ? dim('■') : yellow('○');
  row('state', glyph, chunk(` ${activity} `), dim(`(${age} ago)`));

  const root = state.session?.agents.find((a) => a.id === rootAgentId(state.sessionId));
  if (root?.model) row('model', chunk(truncLine(root.model, w - 9)));

  if (root?.limit && state.ctxTokens > 0) {
    const ratio = state.ctxTokens / root.limit;
    row('context',
      chunk(`${fmtTokens(state.ctxTokens)} / ${fmtTokens(root.limit)}  `),
      ...gradientBar(ratio, 10),
      chunk(' '),
      fg(heat(ratio))(`${Math.round(ratio * 100)}%`));
  }

  const spark = sparkline(burn, Math.min(24, w - 9));
  if (spark) row('burn', fg(ACCENT)(spark));

  const st = state.stats;
  if (st) {
    row('tokens', chunk(`in ${fmtTokens(st.tokens.input + st.tokens.cacheRead + st.tokens.cacheCreation)} · out ${fmtTokens(st.tokens.output)}`));
    if (st.costUsd != null) row('cost', chunk(`$${st.costUsd.toFixed(2)}`));
    const top = Object.entries(st.toolBreakdown).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([tool, n]) => `${tool} ${n}`).join(' · ');
    if (top) row('tools', chunk(truncLine(top, w - 20) + ' '), dim(`(${st.toolCalls} total)`));
    row('agents', chunk(`${st.subagentCount} subagents · ${st.compactions} compactions · ${st.errors} errors`));
    if (st.durationMs > 0) row('elapsed', chunk(fmtDuration(st.durationMs)));
  }

  if (state.tasks.length) {
    const done = state.tasks.filter((t) => t.status === 'completed').length;
    row('tasks', chunk(`${done}/${state.tasks.length} done`));
  }

  return joinLines([...rows, ...connLines(state)]);
}

/** Body of the tasks pane (count lives in the panel title). `tick` animates in-progress glyphs. */
export function renderTasks(state: TuiState, width: number, height: number, tick?: number): StyledText {
  const w = Math.max(24, width);
  const rows: TextChunk[][] = [];
  if (!state.tasks.length) {
    rows.push([dim('no tasks yet')]);
  } else {
    // In-progress first, then pending, completed last; stable within groups.
    const order: Record<string, number> = { in_progress: 0, pending: 1, completed: 2 };
    const sorted = state.tasks.map((t, i) => ({ t, i })).sort((a, b) => (order[a.t.status] ?? 1) - (order[b.t.status] ?? 1) || a.i - b.i);
    const max = Math.max(1, height - 2);
    for (const { t } of sorted.slice(0, max)) {
      const subject = truncLine(t.subject, w - 4);
      const glyph = t.status === 'completed' ? green('●')
        : t.status === 'in_progress' ? fg(ACCENT)(tick == null ? '◐' : SPINNER[tick % SPINNER.length])
        : dim('○');
      rows.push([chunk(' '), glyph, chunk(' '), t.status === 'completed' ? dim(subject) : chunk(subject)]);
    }
    if (sorted.length > max) rows.push([dim(` …${sorted.length - max} more`)]);
  }
  return joinLines([...rows, ...connLines(state)]);
}

/** Panel title for the tasks pane. */
export function tasksTitle(state: TuiState): string {
  const done = state.tasks.filter((t) => t.status === 'completed').length;
  return ` tasks ${done}/${state.tasks.length} `;
}

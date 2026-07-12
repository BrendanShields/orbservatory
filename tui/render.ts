import type { TuiState } from './client';
import { rootAgentId } from '../server/normalizer';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

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

function truncLine(s: string, width: number): string {
  return s.length <= width ? s : s.slice(0, Math.max(0, width - 1)) + '…';
}

export type Activity = 'working' | 'idle' | 'ended';

export function activityOf(state: TuiState, nowMs: number): Activity {
  if (state.summary && !state.summary.live) return 'ended';
  if (state.lastEventMs && nowMs - state.lastEventMs < 15_000) return 'working';
  return 'idle';
}

function connLine(state: TuiState): string {
  if (state.connection === 'open') return '';
  const text = state.connection === 'waiting'
    ? 'waiting for session to appear…'
    : state.connection === 'connecting' ? `connecting to ${state.baseUrl}…` : 'reconnecting…';
  return `\n${YELLOW}${text}${RESET}\n`;
}

export function renderStats(state: TuiState, width: number, nowMs: number): string {
  const w = Math.max(28, width);
  const title = state.summary?.title || state.sessionId.slice(0, 8);
  const lines: string[] = [`${BOLD}${CYAN}orb${RESET} ${truncLine(title, w - 5)}`, ''];
  const row = (label: string, value: string) => lines.push(`${DIM}${label.padEnd(9)}${RESET}${truncLine(value, w - 9)}`);

  const activity = activityOf(state, nowMs);
  const age = state.lastEventMs ? fmtDuration(nowMs - state.lastEventMs) : '—';
  const glyph = activity === 'working' ? `${GREEN}●${RESET}` : activity === 'ended' ? `${DIM}■${RESET}` : `${YELLOW}○${RESET}`;
  row('state', `${glyph} ${activity} ${DIM}(${age} ago)${RESET}`);

  const root = state.session?.agents.find((a) => a.id === rootAgentId(state.sessionId));
  if (root?.model) row('model', root.model);

  if (root?.limit && state.ctxTokens > 0) {
    const ratio = state.ctxTokens / root.limit;
    row('context', `${fmtTokens(state.ctxTokens)} / ${fmtTokens(root.limit)}  ${bar(ratio, 10)} ${Math.round(ratio * 100)}%`);
  }

  const st = state.stats;
  if (st) {
    row('tokens', `in ${fmtTokens(st.tokens.input + st.tokens.cacheRead + st.tokens.cacheCreation)} · out ${fmtTokens(st.tokens.output)}`);
    if (st.costUsd != null) row('cost', `$${st.costUsd.toFixed(2)}`);
    const top = Object.entries(st.toolBreakdown).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([tool, n]) => `${tool} ${n}`).join(' · ');
    if (top) row('tools', `${top} ${DIM}(${st.toolCalls} total)${RESET}`);
    row('agents', `${st.subagentCount} subagents · ${st.compactions} compactions · ${st.errors} errors`);
    if (st.durationMs > 0) row('elapsed', fmtDuration(st.durationMs));
  }

  if (state.tasks.length) {
    const done = state.tasks.filter((t) => t.status === 'completed').length;
    row('tasks', `${done}/${state.tasks.length} done`);
  }

  return lines.join('\n') + connLine(state) + '\n';
}

const TASK_GLYPH: Record<string, string> = {
  pending: `${DIM}○${RESET}`,
  in_progress: `${YELLOW}◐${RESET}`,
  completed: `${GREEN}●${RESET}`,
};

export function renderTasks(state: TuiState, width: number, height: number): string {
  const w = Math.max(24, width);
  const done = state.tasks.filter((t) => t.status === 'completed').length;
  const lines: string[] = [`${BOLD}${CYAN}tasks${RESET} ${DIM}${done}/${state.tasks.length}${RESET}`, ''];
  if (!state.tasks.length) {
    lines.push(`${DIM}no tasks yet${RESET}`);
  } else {
    // In-progress first, then pending, completed last; stable within groups.
    const order: Record<string, number> = { in_progress: 0, pending: 1, completed: 2 };
    const sorted = state.tasks.map((t, i) => ({ t, i })).sort((a, b) => (order[a.t.status] ?? 1) - (order[b.t.status] ?? 1) || a.i - b.i);
    const max = Math.max(1, height - 3);
    for (const { t } of sorted.slice(0, max)) {
      const strike = t.status === 'completed' ? DIM : '';
      lines.push(` ${TASK_GLYPH[t.status] ?? '○'} ${strike}${truncLine(t.subject, w - 4)}${RESET}`);
    }
    if (sorted.length > max) lines.push(`${DIM} …${sorted.length - max} more${RESET}`);
  }
  return lines.join('\n') + connLine(state) + '\n';
}

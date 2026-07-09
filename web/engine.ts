import type { AwvAgent, AwvEvent, AwvSession } from '../shared/schema';
import { eventRank, hashStr } from '../shared/order';

export interface EngineAgent {
  def: AwvAgent;
  id: string;
  spawnT: number;
  completeT: number;
  parent: string | null;
  depth: number;
  kf: Array<{ t: number; v: number }>;
  evs: AwvEvent[];
  children: string[];
  /** Precomputed [start, end) error windows so statusAt stays O(log n). */
  errRanges: Array<{ s: number; e: number }>;
  /** Event times of this agent's own activity, sorted — used for idle detection. */
  evT: number[];
}

export interface Engine {
  sc: AwvSession;
  agents: Map<string, EngineAgent>;
  evs: AwvEvent[];
  duration: number;
  order: string[];
  warp: TimeWarp;
}

/**
 * Nonlinear timeline mapping: idle stretches longer than an adaptive threshold are
 * log-compressed so activity stays readable. Purely visual — simulation, playback
 * and events always use real session time; only the scrubber maps through the warp.
 */
export interface TimeWarp {
  /** Real session time → 0..1 fraction of timeline width. */
  x(t: number): number;
  /** 0..1 timeline fraction → real session time. */
  t(x: number): number;
  /** Compressed idle stretches [t0, t1) in real session time, sorted. */
  gaps: Array<{ t0: number; t1: number }>;
}

export function buildWarp(evs: Array<{ t: number }>, duration: number): TimeWarp {
  const threshold = Math.min(120_000, Math.max(15_000, duration * 0.02));
  const ts: number[] = [0];
  for (const e of evs) {
    const t = Math.min(duration, Math.max(0, e.t));
    if (t > ts[ts.length - 1]) ts.push(t);
  }
  if (duration > ts[ts.length - 1]) ts.push(duration);
  const weights: number[] = [];
  const gaps: Array<{ t0: number; t1: number }> = [];
  let act = 0, idle = 0;
  for (let i = 1; i < ts.length; i++) {
    const g = ts[i] - ts[i - 1];
    if (g > threshold) {
      const w = threshold * (1 + Math.log10(g / threshold));
      weights.push(w); idle += w;
      gaps.push({ t0: ts[i - 1], t1: ts[i] });
    } else { weights.push(g); act += g; }
  }
  // Idle never claims more than ~35% of the strip, as long as there is real activity to show.
  const idleBudget = act * (0.35 / 0.65);
  if (act > 1000 && idle > idleBudget) {
    const k = idleBudget / idle;
    for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > threshold) weights[i - 1] *= k;
  }
  const xs: number[] = [0];
  for (const w of weights) xs.push(xs[xs.length - 1] + w);
  const total = xs[xs.length - 1] || 1;
  const seg = (arr: number[], v: number) => {
    let lo = 0, hi = arr.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m; else hi = m; }
    return lo;
  };
  return {
    gaps,
    x(t: number): number {
      if (ts.length < 2) return 0;
      t = Math.min(duration, Math.max(0, t));
      const i = seg(ts, t);
      const span = ts[i + 1] - ts[i];
      const f = span > 0 ? (t - ts[i]) / span : 0;
      return (xs[i] + f * (xs[i + 1] - xs[i])) / total;
    },
    t(x: number): number {
      if (ts.length < 2) return 0;
      const v = Math.min(1, Math.max(0, x)) * total;
      const i = seg(xs, v);
      const span = xs[i + 1] - xs[i];
      const f = span > 0 ? (v - xs[i]) / span : 0;
      return ts[i] + f * (ts[i + 1] - ts[i]);
    },
  };
}

export const COL: Record<string, string> = {
  gold: '#f3c47e', cyan: '#72d6ee', purple: '#b4a0f2', pink: '#ee9fbe', green: '#84e4c0', red: '#ff7a70', slate: '#93aab4'
};

export function parseSession(sc: AwvSession): Engine {
  const agents = new Map<string, EngineAgent>();
  for (const d of sc.agents || []) {
    agents.set(d.id, { def: d, id: d.id, spawnT: Infinity, completeT: Infinity, parent: null, depth: 0, kf: [], evs: [], children: [], errRanges: [], evT: [] });
  }
  const evs = (sc.events || []).slice().sort((a, b) => a.t - b.t || order(a.type) - order(b.type));
  const cur: Record<string, number> = {};
  const kf = (id: string, t: number, v: number) => {
    const a = agents.get(id); if (!a) return;
    v = Math.max(0, v);
    a.kf.push({ t, v }); cur[id] = v;
  };
  for (const e of evs) {
    if (e.type === 'spawn') {
      const a = agents.get(e.agent); if (!a) continue;
      a.spawnT = Math.min(a.spawnT, e.t);
      a.parent = (e.parent && agents.has(e.parent)) ? e.parent : null;
      if (a.parent) {
        const p = agents.get(a.parent)!;
        if (!p.children.includes(e.agent)) p.children.push(e.agent);
      }
      // Honest zero: live spawns carry tokens 0 — fabricating a floor here made
      // every event-starved agent report a fictional token count.
      kf(e.agent, e.t, 0); kf(e.agent, e.t + 500, e.tokens ?? 0);
    } else if (e.type === 'message' && e.to && agents.has(e.to)) {
      kf(e.to, e.t, (cur[e.to] || 0) + (e.tokens || 0));
    } else if (e.type === 'tool' && agents.has(e.agent)) {
      kf(e.agent, e.t, (cur[e.agent] || 0) + (e.tokens || 0));
    } else if (e.type === 'compact' && agents.has(e.agent)) {
      (e as any)._drop = Math.max(0, (cur[e.agent] || 0) - (e.to || 0));
      kf(e.agent, Math.max(0, e.t - 260), cur[e.agent] || 0); kf(e.agent, e.t, e.to || 0);
    } else if (e.type === 'complete' && agents.has(e.agent)) {
      agents.get(e.agent)!.completeT = e.t;
    }
    if ('agent' in e && e.agent && agents.has(e.agent)) agents.get(e.agent)!.evs.push(e);
    if (e.type === 'message') {
      if (e.from && agents.has(e.from)) agents.get(e.from)!.evs.push(e);
      if (e.to && agents.has(e.to)) agents.get(e.to)!.evs.push(e);
    }
  }
  for (const a of agents.values()) {
    let d = 0, p = a.parent;
    while (p && agents.has(p)) { d++; p = agents.get(p)!.parent; }
    a.depth = d; a.kf.sort((x, y) => x.t - y.t); a.evs.sort((x, y) => x.t - y.t);
    a.evT = a.evs.map(e => e.t);
    // An agent with recorded activity must exist from its first event — guards
    // against spawn events stamped far in the future by clock-less transcript
    // records (which would otherwise hide the agent for the whole replay).
    if (a.evs.length) a.spawnT = Math.min(a.spawnT, a.evs[0].t);
    if (a.completeT !== Infinity) {
      for (let i = a.evs.length - 1; i >= 0; i--) {
        const e = a.evs[i];
        if (e.t <= a.completeT) break;
        const own = e.type === 'message' ? e.from === a.id : e.type !== 'complete' && 'agent' in e && e.agent === a.id;
        if (own) { a.completeT = Infinity; break; }
      }
    }
    let open: number | null = null;
    for (const e of a.evs) {
      const own = 'agent' in e && (e as any).agent === a.id;
      if (!own) continue;
      if (e.type === 'error') { if (open == null) open = e.t; }
      else if (open != null && (e.type === 'retry' || e.type === 'tool' || e.type === 'complete')) { a.errRanges.push({ s: open, e: e.t }); open = null; }
    }
    if (open != null) a.errRanges.push({ s: open, e: Infinity });
  }
  // A parent must exist no later than its first child, or the child's wire dangles.
  const byDepth = [...agents.values()].sort((x, y) => y.depth - x.depth);
  for (const a of byDepth) {
    if (!a.parent) continue;
    const p = agents.get(a.parent);
    if (p) p.spawnT = Math.min(p.spawnT, a.spawnT);
  }
  const duration = Math.max(2500, (evs.length ? evs[evs.length - 1].t : 0) + 2500);
  return { sc, agents, evs, duration, order: (sc.agents || []).map(a => a.id), warp: buildWarp(evs, duration) };
}

export function tokensAt(a: EngineAgent, t: number): number {
  const k = a.kf; if (!k.length || t < k[0].t) return 0;
  if (t >= k[k.length - 1].t) return k[k.length - 1].v;
  let lo = 0, hi = k.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (k[m].t <= t) lo = m; else hi = m; }
  const A = k[lo], B = k[hi], f = (t - A.t) / Math.max(1, B.t - A.t);
  return A.v + (B.v - A.v) * f;
}

export type AgentStatus = 'pending' | 'active' | 'idle' | 'error' | 'complete';

export function statusAt(a: EngineAgent, t: number, liveNow?: number): AgentStatus {
  if (t < a.spawnT) return 'pending';
  if (t >= a.completeT) return 'complete';
  for (const r of a.errRanges) {
    if (t >= r.s && t < r.e) return 'error';
    if (r.s > t) break;
  }
  if (liveNow != null && t >= liveNow - 50 && !a.parent) {
    // Binary search the last own-event time <= t.
    const k = a.evT;
    let lo = 0, hi = k.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (k[m] <= t) lo = m + 1; else hi = m; }
    const last = lo > 0 ? Math.max(a.spawnT, k[lo - 1]) : a.spawnT;
    if (t - last > 90_000) return 'idle';
  }
  return 'active';
}

export function colorOf(a: EngineAgent): string { return COL[a.def.color || ''] || a.def.color || COL.cyan; }
export function radius(a: EngineAgent): number { return [28, 17, 12, 9.5, 8][Math.min(a.depth, 4)]; }
export function ringColor(p: number): string { return p < 0.6 ? '#6fe3c3' : p < 0.85 ? '#f3c47e' : '#ff7a70'; }
export function fmt(n: number): string { if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1000) return (n / 1000).toFixed(1) + 'k'; return String(Math.round(n)); }
export function fmtT(ms: number): string { const sign = ms < 0 ? '-' : ''; const t = Math.abs(ms) / 1000; const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60); const s = Math.floor(t % 60); return sign + (h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`); }
/** Re-exported so render.ts and others import a single canonical hash. */
export const hash = hashStr;

const order = eventRank;

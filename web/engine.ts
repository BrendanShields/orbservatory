import type { AwvAgent, AwvEvent, AwvSession } from '../shared/schema';

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
      kf(e.agent, e.t, 0); kf(e.agent, e.t + 500, e.tokens || 1800);
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
    let open: number | null = null;
    for (const e of a.evs) {
      const own = 'agent' in e && (e as any).agent === a.id;
      if (!own) continue;
      if (e.type === 'error') { if (open == null) open = e.t; }
      else if (open != null && (e.type === 'retry' || e.type === 'tool' || e.type === 'complete')) { a.errRanges.push({ s: open, e: e.t }); open = null; }
    }
    if (open != null) a.errRanges.push({ s: open, e: Infinity });
  }
  const duration = Math.max(2500, (evs.length ? evs[evs.length - 1].t : 0) + 2500);
  return { sc, agents, evs, duration, order: (sc.agents || []).map(a => a.id) };
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
export function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }

function order(type: string): number { return ({ spawn: 0, message: 1, tool: 2, compact: 3, error: 4, retry: 5, complete: 6 } as Record<string, number>)[type] ?? 9; }

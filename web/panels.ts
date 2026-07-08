import type { Engine, EngineAgent } from './engine';
import { colorOf, fmt, fmtT, ringColor, statusAt, tokensAt } from './engine';

export function statusMeta(st: string): [string, string] {
  return ({ pending: ['queued', 'rgba(150,200,215,.45)'], active: ['live', '#7adcf2'], idle: ['idle', 'rgba(150,200,215,.45)'], error: ['error', '#ff7a70'], complete: ['done', 'rgba(132,228,192,.75)'] } as any)[st];
}

export function renderRail(el: HTMLElement, eng: Engine | undefined, t: number, selectedId: string | null, liveNow: number | undefined, onSelect: (id: string) => void) {
  if (!eng) { el.innerHTML = `<div class="empty">Waiting for Claude sessions…</div>`; return; }
  let live = 0, done = 0;
  const rows = eng.order.map(id => {
    const a = eng.agents.get(id)!;
    const st = statusAt(a, t, liveNow); if (st === 'active' || st === 'error') live++; if (st === 'complete') done++;
    // Finished agents leave the rail (still counted in the header); keep the selected one so the inspector stays reachable.
    if (st === 'complete' && selectedId !== id) return '';
    const tok = tokensAt(a, t), pct = Math.min(1, tok / (a.def.limit || 1000000));
    const [label, scol] = statusMeta(st);
    return `<button class="agent-row ${selectedId === id ? 'selected' : ''}" data-agent="${esc(id)}" style="--agent:${colorOf(a)};opacity:${st === 'pending' ? .35 : st === 'complete' ? .62 : 1}">
      <span class="agent-dot"></span>
      <span class="agent-main"><span class="agent-name">${esc(a.def.name)}</span><span class="agent-meter"><i style="width:${(pct*100).toFixed(1)}%;background:${ringColor(pct)}"></i></span></span>
      <span class="agent-side"><b style="color:${scol}">${label}</b><em>${st === 'pending' ? '—' : fmt(tok)}</em></span>
    </button>`;
  }).join('');
  el.innerHTML = `<div class="rail-head"><span>AGENTS</span><b>${live} live · ${done} done · ${eng.order.length} total</b></div>${rows || `<div class="empty">No agents yet.</div>`}`;
  el.querySelectorAll<HTMLButtonElement>('[data-agent]').forEach(btn => btn.onclick = () => onSelect(btn.dataset.agent!));
}

export function renderInspector(el: HTMLElement, eng: Engine | undefined, t: number, selectedId: string | null, liveNow: number | undefined, onSelect: (id: string) => void, onClose: () => void) {
  const sel = selectedId && eng?.agents.get(selectedId);
  if (!eng || !sel) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const st = statusAt(sel, t, liveNow), tok = tokensAt(sel, t), lim = sel.def.limit || 1000000, pct = Math.min(1, tok / lim), [lbl, scol] = statusMeta(st);
  const skills: Record<string, number> = {};
  for (const e of sel.evs) if (e.type === 'tool' && e.t <= t) skills[e.tool] = (skills[e.tool] || 0) + 1;
  const children = sel.children.map(cid => childRow(eng.agents.get(cid)!, t, liveNow)).join('');
  // Walk backwards from the newest visible event — the log shows at most 70 rows.
  const log: string[] = [];
  for (let i = sel.evs.length - 1; i >= 0 && log.length < 70; i--) {
    const e = sel.evs[i];
    if (e.t > t) continue;
    const time = fmtT(e.t);
    if (e.type === 'spawn') log.push(logRow(time, 'SPAWN', '#72d6ee', sel.parent ? `spawned by ${eng.agents.get(sel.parent)?.def.name || sel.parent}` : 'session started', `+${fmt(e.tokens || 0)}`));
    else if (e.type === 'message' && e.to === sel.id) log.push(logRow(time, '◀ RECV', '#aee8f7', `${e.label || 'message'}${e.from ? ' — from ' + (eng.agents.get(e.from)?.def.name || e.from) : ' — external'}`, `+${fmt(e.tokens || 0)}`));
    else if (e.type === 'message' && e.from === sel.id && e.to !== sel.id) log.push(logRow(time, 'SEND ▶', 'rgba(207,230,238,.8)', `${e.label || 'message'} — to ${eng.agents.get(e.to || '')?.def.name || e.to}`, ''));
    else if (e.type === 'message' && e.from === sel.id) log.push(logRow(time, 'REPLY', 'rgba(207,230,238,.8)', e.label || 'assistant reply', `+${fmt(e.tokens || 0)}`));
    else if (e.type === 'tool') log.push(logRow(time, 'TOOL', '#f3c47e', `${e.tool}${e.label ? ' — ' + e.label : ''}`, `+${fmt(e.tokens || 0)}`));
    else if (e.type === 'compact') log.push(logRow(time, 'COMPACT', '#b4a0f2', e.label || 'context compacted', `−${fmt((e as any)._drop || 0)}`));
    else if (e.type === 'error') log.push(logRow(time, 'ERROR', '#ff7a70', e.label || 'error', ''));
    else if (e.type === 'complete') log.push(logRow(time, 'DONE', '#84e4c0', e.label || 'completed', ''));
  }
  el.innerHTML = `<div class="inspect-card">
    <button class="close" title="Close">×</button>
    <div class="inspect-kicker" style="--agent:${colorOf(sel)}"><span></span>${esc(((sel.def.role || 'agent') + ' · ' + (sel.parent ? 'child of ' + (eng.agents.get(sel.parent)?.def.name || sel.parent) : 'root')).toUpperCase())}</div>
    <h2>${esc(sel.def.name)}</h2>
    <div class="status-pill" style="color:${scol};border-color:${scol}44;background:${scol}12">${lbl.toUpperCase()}</div>
    <p class="task">${esc(sel.def.task || 'No task metadata available.')}</p>
    <div class="context-box"><div><b>${fmt(tok)}</b><span>/ ${fmt(lim)} context</span></div><strong>${Math.round(pct*100)}%</strong><i><em style="width:${(pct*100).toFixed(1)}%;background:${ringColor(pct)}"></em></i></div>
    ${runStats(sel.def)}
    <h3>Tools used</h3>
    <div class="chips">${Object.entries(skills).map(([k,v]) => `<span>${esc(k)} <b>${v}</b></span>`).join('') || '<em>None yet</em>'}</div>
    <h3>Sub-agents</h3>
    <div class="children">${children || '<em>No child agents</em>'}</div>
    <h3>Event log</h3>
    <div class="event-log">${log.join('') || '<em>No visible events yet</em>'}</div>
  </div>`;
  el.querySelector<HTMLButtonElement>('.close')!.onclick = onClose;
  el.querySelectorAll<HTMLButtonElement>('[data-child]').forEach(btn => btn.onclick = () => onSelect(btn.dataset.child!));
}

function runStats(a: import('../shared/schema').AwvAgent): string {
  const cells: string[] = [];
  if (a.durationMs != null) cells.push(cell('duration', fmtDur(a.durationMs)));
  if (a.totalTokens != null) cells.push(cell('tokens', fmt(a.totalTokens)));
  if (a.toolCount != null) cells.push(cell('tool calls', String(a.toolCount)));
  const ts = a.toolStats;
  if (ts && (ts.linesAdded || ts.linesRemoved)) cells.push(cell('lines', `+${ts.linesAdded || 0} −${ts.linesRemoved || 0}`));
  if (a.model) cells.push(cell('model', a.model.replace(/^claude-/, '')));
  const result = a.result ? `<p class="task run-result">${esc(a.result)}</p>` : '';
  if (!cells.length && !result) return '';
  return `<div class="run-stats">${cells.join('')}</div>${result}`;
}

function cell(label: string, value: string): string {
  return `<div class="run-cell"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function childRow(a: EngineAgent, t: number, liveNow: number | undefined) {
  const st = statusAt(a, t, liveNow), pct = Math.min(1, tokensAt(a, t) / (a.def.limit || 1000000)), [label, scol] = statusMeta(st);
  return `<button class="child-row" data-child="${esc(a.id)}" style="--agent:${colorOf(a)}"><span></span><b>${esc(a.def.name)}</b><em style="color:${scol}">${label} · ${(pct*100).toFixed(0)}%</em></button>`;
}

function logRow(time: string, tag: string, color: string, text: string, delta: string) {
  return `<div class="log-row"><time>${time}</time><b style="color:${color}">${esc(tag)}</b><span>${esc(text)}</span><em>${esc(delta)}</em></div>`;
}

export function esc(v: string) { return String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }

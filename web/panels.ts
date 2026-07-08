import type { AgentStatus, Engine, EngineAgent } from './engine';
import { colorOf, fmt, fmtT, ringColor, statusAt, tokensAt } from './engine';

export function statusMeta(st: string): [string, string] {
  return ({ pending: ['queued', 'rgba(150,200,215,.45)'], active: ['live', '#7adcf2'], idle: ['idle', 'rgba(150,200,215,.45)'], error: ['error', '#ff7a70'], complete: ['done', 'rgba(132,228,192,.75)'] } as any)[st];
}

interface RailRow { el: HTMLButtonElement; name: HTMLElement; meter: HTMLElement; status: HTMLElement; tok: HTMLElement; last: string }
interface RailState { body: HTMLElement; count: HTMLElement; toggle: HTMLButtonElement; rows: Map<string, RailRow>; empty: HTMLElement | null; onSelect: (id: string) => void; onToggle?: () => void }
const rails = new WeakMap<HTMLElement, RailState>();

function railShell(el: HTMLElement): RailState {
  el.innerHTML = `<div class="rail-head"><span>AGENTS</span><b></b><button class="rail-filter" data-toggle-completed aria-pressed="false" title="Show completed agents (c)">done</button></div><div class="rail-body"></div>`;
  const st: RailState = { body: el.querySelector('.rail-body')!, count: el.querySelector('.rail-head b')!, toggle: el.querySelector('.rail-filter')!, rows: new Map(), empty: null, onSelect: () => {} };
  el.addEventListener('click', e => {
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>('[data-agent]');
    if (row) st.onSelect(row.dataset.agent!);
    else if (target.closest('[data-toggle-completed]')) st.onToggle?.();
  });
  rails.set(el, st);
  return st;
}

function railEmpty(st: RailState, msg: string) {
  for (const r of st.rows.values()) r.el.remove();
  st.rows.clear();
  if (!st.empty) { st.empty = document.createElement('div'); st.empty.className = 'empty'; st.body.append(st.empty); }
  st.empty.textContent = msg;
}

function makeRow(id: string): RailRow {
  const el = document.createElement('button');
  el.className = 'agent-row';
  el.dataset.agent = id;
  el.innerHTML = `<span class="agent-dot"></span><span class="agent-main"><span class="agent-name"></span><span class="agent-meter"><i></i></span></span><span class="agent-side"><b></b><em></em></span>`;
  return { el, name: el.querySelector('.agent-name')!, meter: el.querySelector('.agent-meter i')!, status: el.querySelector('.agent-side b')!, tok: el.querySelector('.agent-side em')!, last: '' };
}

export function renderRail(el: HTMLElement, eng: Engine | undefined, t: number, selectedId: string | null, liveNow: number | undefined, onSelect: (id: string) => void, showCompleted = false, onToggleCompleted?: () => void) {
  const st = rails.get(el) || railShell(el);
  st.onSelect = onSelect; st.onToggle = onToggleCompleted;
  st.toggle.hidden = !onToggleCompleted;
  st.toggle.classList.toggle('on', showCompleted);
  st.toggle.setAttribute('aria-pressed', String(showCompleted));
  if (!eng) { st.count.textContent = ''; railEmpty(st, 'Waiting for Claude sessions…'); return; }
  let live = 0, done = 0;
  const vis: Array<{ id: string; a: EngineAgent; status: AgentStatus }> = [];
  for (const id of eng.order) {
    const a = eng.agents.get(id)!;
    const status = statusAt(a, t, liveNow);
    if (status === 'active' || status === 'error') live++;
    if (status === 'complete') done++;
    // Finished agents leave the rail (still counted in the header) unless the
    // user opts to keep them — useful when reviewing a replay/history. The
    // selected agent always stays so the inspector remains reachable.
    if (status === 'complete' && !showCompleted && selectedId !== id) continue;
    vis.push({ id, a, status });
  }
  st.count.textContent = `${live} live · ${done} done · ${eng.order.length} total`;
  const seen = new Set(vis.map(v => v.id));
  for (const [id, row] of st.rows) if (!seen.has(id)) { row.el.remove(); st.rows.delete(id); }
  if (!vis.length) { railEmpty(st, 'No agents yet.'); return; }
  if (st.empty) { st.empty.remove(); st.empty = null; }
  let cursor = st.body.firstElementChild;
  for (const v of vis) {
    let row = st.rows.get(v.id);
    if (!row) { row = makeRow(v.id); st.rows.set(v.id, row); st.body.insertBefore(row.el, cursor); }
    else if (row.el === cursor) cursor = cursor.nextElementSibling;
    else st.body.insertBefore(row.el, cursor);
    const tok = tokensAt(v.a, t), pct = Math.min(1, tok / (v.a.def.limit || 1000000));
    const [label, scol] = statusMeta(v.status);
    const col = colorOf(v.a), width = (pct * 100).toFixed(1) + '%', tokTxt = v.status === 'pending' ? '—' : fmt(tok);
    const op = v.status === 'pending' ? '.35' : v.status === 'complete' ? '.62' : '1';
    const key = [v.a.def.name, col, width, label, scol, tokTxt, op].join('|');
    if (key !== row.last) {
      row.last = key;
      row.name.textContent = v.a.def.name;
      row.el.style.setProperty('--agent', col);
      row.el.style.opacity = op;
      row.meter.style.width = width;
      row.meter.style.background = ringColor(pct);
      row.status.textContent = label;
      row.status.style.color = scol;
      row.tok.textContent = tokTxt;
    }
    row.el.classList.toggle('selected', selectedId === v.id);
  }
}

interface InspRefs { kicker: HTMLElement; kickerText: Text; h2: HTMLElement; pill: HTMLElement; task: HTMLElement; ctx: HTMLElement; stats: HTMLElement; chips: HTMLElement; children: HTMLElement; log: HTMLElement }
interface InspState { key: string; refs: InspRefs | null; last: Record<string, string>; onSelect: (id: string) => void; onClose: () => void }
const inspectors = new WeakMap<HTMLElement, InspState>();

export function renderInspector(el: HTMLElement, eng: Engine | undefined, t: number, selectedId: string | null, liveNow: number | undefined, onSelect: (id: string) => void, onClose: () => void, sourceOf?: (agentId: string) => string | undefined) {
  let st = inspectors.get(el);
  if (!st) {
    const s: InspState = { key: '', refs: null, last: {}, onSelect, onClose };
    el.addEventListener('click', e => {
      const target = e.target as HTMLElement;
      if (target.closest('.close')) s.onClose();
      else { const c = target.closest<HTMLElement>('[data-child]'); if (c) s.onSelect(c.dataset.child!); }
    });
    inspectors.set(el, s);
    st = s;
  }
  st.onSelect = onSelect; st.onClose = onClose;
  const sel = selectedId && eng ? eng.agents.get(selectedId) : undefined;
  if (!eng || !sel) { el.hidden = true; el.innerHTML = ''; st.key = ''; st.refs = null; return; }
  el.hidden = false;
  if (st.key !== selectedId) {
    el.innerHTML = `<div class="inspect-card">
      <button class="close" title="Close" aria-label="Close inspector">×</button>
      <div class="inspect-kicker"><span></span></div>
      <h2></h2>
      <div class="status-pill"></div>
      <p class="task"></p>
      <div class="context-box"></div>
      <div class="i-stats"></div>
      <h3>Tools used</h3>
      <div class="chips"></div>
      <h3>Sub-agents</h3>
      <div class="children"></div>
      <h3>Event log</h3>
      <div class="event-log"></div>
    </div>`;
    const q = (sl: string) => el.querySelector<HTMLElement>(sl)!;
    const kicker = q('.inspect-kicker');
    const kickerText = document.createTextNode('');
    kicker.appendChild(kickerText);
    st.refs = { kicker, kickerText, h2: q('h2'), pill: q('.status-pill'), task: q('.task'), ctx: q('.context-box'), stats: q('.i-stats'), chips: q('.chips'), children: q('.children'), log: q('.event-log') };
    st.key = selectedId!;
    st.last = {};
  }
  const R = st.refs!, last = st.last;
  const setHtml = (k: string, node: HTMLElement, html: string) => { if (last[k] !== html) { last[k] = html; node.innerHTML = html; } };
  const status = statusAt(sel, t, liveNow), tok = tokensAt(sel, t), lim = sel.def.limit || 1000000, pct = Math.min(1, tok / lim), [lbl, scol] = statusMeta(status);
  const col = colorOf(sel);
  const src = sourceOf?.(selectedId!);
  const ktext = ((sel.def.role || 'agent') + ' · ' + (sel.parent ? 'child of ' + (eng.agents.get(sel.parent)?.def.name || sel.parent) : 'root') + (src ? ' · ' + src : '')).toUpperCase();
  const head = [ktext, sel.def.name, sel.def.task || '', col].join('|');
  if (last.head !== head) {
    last.head = head;
    R.kicker.style.setProperty('--agent', col);
    R.kickerText.nodeValue = ktext;
    R.h2.textContent = sel.def.name;
    R.task.textContent = sel.def.task || 'No task metadata available.';
  }
  const pill = lbl + '|' + scol;
  if (last.pill !== pill) {
    last.pill = pill;
    R.pill.textContent = lbl.toUpperCase();
    R.pill.style.color = scol; R.pill.style.borderColor = scol + '44'; R.pill.style.background = scol + '12';
  }
  setHtml('ctx', R.ctx, `<div><b>${fmt(tok)}</b><span>/ ${fmt(lim)} context</span></div><strong>${Math.round(pct * 100)}%</strong><i><em style="width:${(pct * 100).toFixed(1)}%;background:${ringColor(pct)}"></em></i>`);
  setHtml('stats', R.stats, runStats(sel.def));
  const skills: Record<string, number> = {};
  for (const e of sel.evs) if (e.type === 'tool' && e.t <= t) skills[e.tool] = (skills[e.tool] || 0) + 1;
  setHtml('chips', R.chips, Object.entries(skills).map(([k, v]) => `<span>${esc(k)} <b>${v}</b></span>`).join('') || '<em>None yet</em>');
  setHtml('children', R.children, sel.children.map(cid => childRow(eng.agents.get(cid)!, t, liveNow)).join('') || '<em>No child agents</em>');
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
  const logHtml = log.join('') || '<em>No visible events yet</em>';
  if (last.log !== logHtml) {
    last.log = logHtml;
    const oldTop = R.log.scrollTop, oldH = R.log.scrollHeight;
    R.log.innerHTML = logHtml;
    if (oldTop > 0) R.log.scrollTop = oldTop + (R.log.scrollHeight - oldH);
  }
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
  return `<button class="child-row" data-child="${esc(a.id)}" style="--agent:${colorOf(a)}"><span></span><b>${esc(a.def.name)}</b><em style="color:${scol}">${label} · ${(pct * 100).toFixed(0)}%</em></button>`;
}

function logRow(time: string, tag: string, color: string, text: string, delta: string) {
  return `<div class="log-row"><time>${time}</time><b style="color:${color}">${esc(tag)}</b><span>${esc(text)}</span><em>${esc(delta)}</em></div>`;
}

export function esc(v: string) { return String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }

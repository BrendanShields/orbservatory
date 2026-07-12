import type { TranscriptItem } from '../shared/schema';
import type { AgentStatus, Engine, EngineAgent } from './engine';
import { colorOf, fmt, fmtT, ringColor, statusAt, tokensAt } from './engine';
import { html, type Html } from './html';
import { cleanLabel, maskProject } from './privacy';
import { fetchTranscript } from './transport';
import { toast } from './importer';

/** Display name for an agent: paths collapsed everywhere, root project names masked when the privacy mask is on. */
export function displayName(a: EngineAgent): string {
  const name = cleanLabel(a.def.name);
  return a.parent ? name : maskProject(name);
}

export function statusMeta(st: string): [string, string] {
  return ({ pending: ['queued', 'var(--status-dim)'], active: ['live', 'var(--accent)'], idle: ['idle', 'var(--status-dim)'], error: ['error', 'var(--err)'], complete: ['done', 'var(--status-done)'] } as any)[st];
}

interface RailRow { el: HTMLButtonElement; name: HTMLElement; meter: HTMLElement; status: HTMLElement; tok: HTMLElement; last: string }
interface RailState { body: HTMLElement; count: HTMLElement; toggle: HTMLButtonElement; qInput: HTMLInputElement; q: string; rows: Map<string, RailRow>; empty: HTMLElement | null; onSelect: (id: string) => void; onToggle?: () => void; rerender: () => void }
const rails = new WeakMap<HTMLElement, RailState>();

export function filterAgents<T extends { a: EngineAgent }>(vis: T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return vis;
  return vis.filter(v => v.a.def.name.toLowerCase().includes(needle) || (v.a.def.task || '').toLowerCase().includes(needle));
}

export function focusRailFilter(el: HTMLElement) {
  rails.get(el)?.qInput.focus();
}

function railShell(el: HTMLElement): RailState {
  el.innerHTML = `<div class="rail-head">
    <div class="rail-head-row"><span>AGENTS</span><b></b></div>
    <div class="rail-head-row"><input class="rail-q" type="text" placeholder="Filter agents… (/)" aria-label="Filter agents" autocomplete="off" spellcheck="false"><button class="rail-filter" data-toggle-completed aria-pressed="false" title="Show completed agents (c)">done</button></div>
  </div><div class="rail-body"></div>`;
  const st: RailState = { body: el.querySelector('.rail-body')!, count: el.querySelector('.rail-head b')!, toggle: el.querySelector('.rail-filter')!, qInput: el.querySelector('.rail-q')!, q: '', rows: new Map(), empty: null, onSelect: () => {}, rerender: () => {} };
  st.qInput.addEventListener('input', () => { st.q = st.qInput.value; st.rerender(); });
  st.qInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); st.qInput.value = ''; st.q = ''; st.qInput.blur(); st.rerender(); }
  });
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
  st.rerender = () => renderRail(el, eng, t, selectedId, liveNow, onSelect, showCompleted, onToggleCompleted);
  st.toggle.hidden = !onToggleCompleted;
  st.toggle.classList.toggle('on', showCompleted);
  st.toggle.setAttribute('aria-pressed', String(showCompleted));
  if (!eng) { st.count.textContent = ''; railEmpty(st, 'Waiting for sessions…'); return; }
  let live = 0, done = 0;
  const all: Array<{ id: string; a: EngineAgent; status: AgentStatus }> = [];
  for (const id of eng.order) {
    const a = eng.agents.get(id)!;
    const status = statusAt(a, t, liveNow);
    if (status === 'active' || status === 'error') live++;
    if (status === 'complete') done++;
    // Finished agents leave the rail (still counted in the header) unless the
    // user opts to keep them — useful when reviewing a replay/history. The
    // selected agent always stays so the inspector remains reachable.
    if (status === 'complete' && !showCompleted && selectedId !== id) continue;
    all.push({ id, a, status });
  }
  st.count.textContent = `${live} live · ${done} done · ${eng.order.length} total`;
  const vis = filterAgents(all, st.q);
  const seen = new Set(vis.map(v => v.id));
  for (const [id, row] of st.rows) if (!seen.has(id)) { row.el.remove(); st.rows.delete(id); }
  if (!vis.length) { railEmpty(st, st.q.trim() ? 'No agents match' : 'No agents yet.'); return; }
  if (st.empty) { st.empty.remove(); st.empty = null; }
  let cursor = st.body.firstElementChild;
  for (const v of vis) {
    let row = st.rows.get(v.id);
    if (!row) { row = makeRow(v.id); st.rows.set(v.id, row); st.body.insertBefore(row.el, cursor); }
    else if (row.el === cursor) cursor = cursor.nextElementSibling;
    else st.body.insertBefore(row.el, cursor);
    const tok = tokensAt(v.a, t), pct = Math.min(1, tok / (v.a.def.limit || 1000000));
    const [label, scol] = statusMeta(v.status);
    const name = displayName(v.a);
    const col = colorOf(v.a), width = (pct * 100).toFixed(1) + '%', tokTxt = v.status === 'pending' ? '—' : fmt(tok);
    const op = v.status === 'pending' ? '.35' : v.status === 'complete' ? '.62' : '1';
    const key = [name, col, width, label, scol, tokTxt, op].join('|');
    if (key !== row.last) {
      row.last = key;
      row.name.textContent = name;
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

export type LogKind = 'all' | 'tools' | 'messages' | 'errors';

export function logFilter(kind: LogKind, e: { type: string }): boolean {
  if (kind === 'tools') return e.type === 'tool';
  if (kind === 'errors') return e.type === 'error' || e.type === 'retry';
  if (kind === 'messages') return e.type === 'message' || e.type === 'spawn' || e.type === 'complete' || e.type === 'compact';
  return true;
}

export function dedupeKicker(parts: Array<string | undefined>): string {
  const segs = parts.filter((p): p is string => !!p);
  return segs.filter((p, i) => p !== segs[i - 1]).join(' · ');
}

/** The transcript tab exists only for a single server-backed session (not all-live merges or imported replays) whose provider has an extractor. */
export function transcriptTabVisible(sessionId: string | null | undefined, unsupported: boolean): boolean {
  return !!sessionId && !unsupported;
}

/** Index of the loaded row the playhead is on: the latest item with t <= simT (-1 when none). Items are in append order, so t is not globally sorted — linear scan. */
export function followIndex(items: Array<{ t: number }>, simT: number): number {
  let best = -1, bestT = -Infinity;
  for (let i = 0; i < items.length; i++) {
    const t = items[i].t;
    if (t <= simT && t >= bestT) { best = i; bestT = t; }
  }
  return best;
}

/** Keeps the viewport anchored on the same row when older items are prepended above it. */
export function prependAnchor(oldScrollTop: number, oldScrollHeight: number, newScrollHeight: number): number {
  return oldScrollTop + Math.max(0, newScrollHeight - oldScrollHeight);
}

export interface InspectorTranscript {
  /** Null hides the tab (all-live merge / imported replay). */
  sessionId: string | null;
  live: boolean;
  eventCount: number;
  playing: boolean;
  onSeek: (t: number) => void;
}

const TR_PAGE = 200;
/** Sessions whose provider answered `unsupported` — the tab stays hidden for the page load. */
const trUnsupported = new Set<string>();

interface TranscriptState {
  key: string;
  sessionId: string;
  agent?: string;
  items: TranscriptItem[];
  total?: number;
  loading: boolean;
  gone: boolean;
  follow: boolean;
  atStart: boolean;
  fetched: boolean;
  gen: number;
  renderedGen: number;
  seq: number;
  lastEventCount: number;
  tailTimer: number | null;
  scrollBottom: boolean;
  anchor: boolean;
  currentI: number;
}

function freshTr(key: string, sessionId: string, agent: string | undefined, eventCount: number): TranscriptState {
  return { key, sessionId, agent, items: [], loading: false, gone: false, follow: true, atStart: false, fetched: false, gen: 0, renderedGen: -1, seq: 0, lastEventCount: eventCount, tailTimer: null, scrollBottom: false, anchor: false, currentI: -2 };
}

interface InspRefs { head: HTMLElement; kickerText: Text; h2: HTMLElement; tabs: HTMLElement; inspectPane: HTMLElement; pill: HTMLElement; task: HTMLElement; ctx: HTMLElement; stats: HTMLElement; chips: HTMLElement; children: HTMLElement; log: HTMLElement; logChips: HTMLElement; trPane: HTMLElement; trBar: HTMLElement; trList: HTMLElement }
interface InspState { key: string; refs: InspRefs | null; last: Record<string, string>; logKind: LogKind; tab: 'inspect' | 'transcript'; trAll: boolean; tr: TranscriptState | null; onSelect: (id: string) => void; onClose: () => void; onSeek: ((t: number) => void) | null; rerender: () => void }
const inspectors = new WeakMap<HTMLElement, InspState>();

export function renderInspector(el: HTMLElement, eng: Engine | undefined, t: number, selectedId: string | null, liveNow: number | undefined, onSelect: (id: string) => void, onClose: () => void, sourceOf?: (agentId: string) => string | undefined, sessionMeta?: { cwd?: string; projectName?: string }, transcript?: InspectorTranscript) {
  let st = inspectors.get(el);
  if (!st) {
    const s: InspState = { key: '', refs: null, last: {}, logKind: 'all', tab: 'inspect', trAll: false, tr: null, onSelect, onClose, onSeek: null, rerender: () => {} };
    el.addEventListener('click', e => {
      const target = e.target as HTMLElement;
      if (target.closest('.close')) { s.onClose(); return; }
      const tab = target.closest<HTMLElement>('[data-tab]');
      if (tab) { s.tab = tab.dataset.tab as 'inspect' | 'transcript'; s.rerender(); return; }
      if (target.closest('[data-tr-all]')) { s.trAll = !s.trAll; s.rerender(); return; }
      if (target.closest('[data-tr-follow]')) { if (s.tr) { s.tr.follow = true; s.tr.currentI = -2; } s.rerender(); return; }
      if (target.closest('.t-more')) { target.closest('.t-row')?.classList.toggle('expanded'); return; }
      const trow = target.closest<HTMLElement>('.t-row');
      if (trow) { s.onSeek?.(Number(trow.dataset.t) || 0); return; }
      const c = target.closest<HTMLElement>('[data-child]');
      if (c) { s.onSelect(c.dataset.child!); return; }
      const f = target.closest<HTMLElement>('[data-logf]');
      if (f) { s.logKind = f.dataset.logf as LogKind; delete s.last.log; delete s.last.logChips; s.rerender(); return; }
      const row = target.closest<HTMLElement>('.log-row');
      if (row) row.classList.toggle('expanded');
    });
    inspectors.set(el, s);
    st = s;
  }
  st.onSelect = onSelect; st.onClose = onClose; st.onSeek = transcript?.onSeek ?? null;
  st.rerender = () => renderInspector(el, eng, t, selectedId, liveNow, onSelect, onClose, sourceOf, sessionMeta, transcript);
  const sel = selectedId && eng ? eng.agents.get(selectedId) : undefined;
  if (!eng || !sel) { el.hidden = true; el.innerHTML = ''; el.classList.remove('transcript-open'); st.key = ''; st.refs = null; return; }
  el.hidden = false;
  if (st.key !== selectedId) {
    el.innerHTML = `<div class="inspect-card">
      <div class="inspect-head"><span class="i-dot"></span><div class="inspect-kicker"></div><button class="close" title="Close" aria-label="Close inspector">×</button></div>
      <h2></h2>
      <div class="inspect-tabs" role="tablist" aria-label="Inspector view"></div>
      <div class="inspect-pane">
      <div class="status-pill"></div>
      <p class="task"></p>
      <div class="context-box"></div>
      <div class="i-stats"></div>
      <h3>Tools used</h3>
      <div class="chips"></div>
      <h3>Sub-agents</h3>
      <div class="children"></div>
      <h3>Event log</h3>
      <div class="log-chips" role="group" aria-label="Filter event log"></div>
      <div class="event-log"></div>
      </div>
      <div class="transcript-pane" hidden>
        <div class="transcript-bar" role="group" aria-label="Transcript controls"></div>
        <div class="transcript-list" aria-label="Transcript"></div>
      </div>
    </div>`;
    const q = (sl: string) => el.querySelector<HTMLElement>(sl)!;
    const kickerText = document.createTextNode('');
    q('.inspect-kicker').appendChild(kickerText);
    st.refs = { head: q('.inspect-head'), kickerText, h2: q('h2'), tabs: q('.inspect-tabs'), inspectPane: q('.inspect-pane'), pill: q('.status-pill'), task: q('.task'), ctx: q('.context-box'), stats: q('.i-stats'), chips: q('.chips'), children: q('.children'), log: q('.event-log'), logChips: q('.log-chips'), trPane: q('.transcript-pane'), trBar: q('.transcript-bar'), trList: q('.transcript-list') };
    st.key = selectedId!;
    st.last = {};
    if (st.tr) { st.tr.renderedGen = -1; st.tr.currentI = -2; }
    const s = st;
    // Scroll events fire for programmatic moves too, so they only drive
    // pagination; follow disengages on user-intent inputs (wheel/touch).
    st.refs.trList.addEventListener('scroll', () => {
      const tr = s.tr;
      if (!tr || !s.refs) return;
      if (s.refs.trList.scrollTop < 40) trFetchOlder(s, tr);
    });
    const unfollow = () => {
      const tr = s.tr;
      if (tr?.follow) { tr.follow = false; s.rerender(); }
    };
    st.refs.trList.addEventListener('wheel', unfollow, { passive: true });
    st.refs.trList.addEventListener('touchmove', unfollow, { passive: true });
  }
  const R = st.refs!, last = st.last;
  const setHtml = (k: string, node: HTMLElement, h: Html) => { if (last[k] !== h.s) { last[k] = h.s; node.innerHTML = h.s; } };
  const trSession = transcript?.sessionId ?? null;
  const tabVisible = transcriptTabVisible(trSession, trSession ? trUnsupported.has(trSession) : false);
  if (!tabVisible && st.tab === 'transcript') st.tab = 'inspect';
  const showTr = st.tab === 'transcript' && tabVisible;
  setHtml('tabs', R.tabs, tabVisible
    ? html`${(['inspect', 'transcript'] as const).map(k => html`<button data-tab="${k}" role="tab" aria-selected="${k === st.tab}" class="${k === st.tab ? 'on' : ''}">${k === 'inspect' ? 'Inspect' : 'Transcript'}</button>`)}`
    : html``);
  R.tabs.hidden = !tabVisible;
  R.inspectPane.hidden = showTr;
  R.trPane.hidden = !showTr;
  el.classList.toggle('transcript-open', showTr);
  if (showTr && transcript && trSession) renderTranscript(el, st, R, eng, t, selectedId!, trSession, transcript);
  const status = statusAt(sel, t, liveNow), tok = tokensAt(sel, t), lim = sel.def.limit || 1000000, pct = Math.min(1, tok / lim), [lbl, scol] = statusMeta(status);
  const col = colorOf(sel);
  const src = sourceOf?.(selectedId!);
  const parentAgent = sel.parent ? eng.agents.get(sel.parent) : undefined;
  const ktext = dedupeKicker([sel.def.role || 'agent', sel.parent ? 'child of ' + (parentAgent ? displayName(parentAgent) : sel.parent) : 'root', src]).toUpperCase();
  const isRoot = !sel.parent;
  let taskText = (isRoot && sessionMeta?.cwd && sel.def.task === sessionMeta.cwd && sessionMeta.projectName) ? sessionMeta.projectName : sel.def.task;
  taskText = taskText && cleanLabel(taskText);
  if (isRoot && taskText) taskText = maskProject(taskText);
  const name = displayName(sel);
  const head = [ktext, name, taskText || '', col].join('|');
  if (last.head !== head) {
    last.head = head;
    R.head.style.setProperty('--agent', col);
    R.kickerText.nodeValue = ktext;
    R.h2.textContent = name;
    R.task.textContent = taskText || 'No task metadata available.';
  }
  setHtml('logChips', R.logChips, html`${(['all', 'tools', 'messages', 'errors'] as const).map(k => html`<button data-logf="${k}" class="${k === st.logKind ? 'on' : ''}" aria-pressed="${k === st.logKind}">${k}</button>`)}`);
  const pill = lbl + '|' + scol;
  if (last.pill !== pill) {
    last.pill = pill;
    R.pill.textContent = lbl.toUpperCase();
    R.pill.style.color = scol;
    R.pill.style.borderColor = `color-mix(in srgb, ${scol} 27%, transparent)`;
    R.pill.style.background = `color-mix(in srgb, ${scol} 8%, transparent)`;
  }
  setHtml('ctx', R.ctx, html`<div><b>${fmt(tok)}</b><span>/ ${fmt(lim)} context</span></div><strong>${Math.round(pct * 100)}%</strong><i><em style="width:${(pct * 100).toFixed(1)}%;background:${ringColor(pct)}"></em></i>`);
  setHtml('stats', R.stats, runStats(sel.def));
  const skills: Record<string, number> = {};
  for (const e of sel.evs) if (e.type === 'tool' && e.t <= t) skills[e.tool] = (skills[e.tool] || 0) + 1;
  const chips = Object.entries(skills).map(([k, v]) => html`<span>${k} <b>${v}</b></span>`);
  setHtml('chips', R.chips, chips.length ? html`${chips}` : html`<em>None yet</em>`);
  const children = sel.children.map(cid => childRow(eng.agents.get(cid)!, t, liveNow));
  setHtml('children', R.children, children.length ? html`${children}` : html`<em>No child agents</em>`);
  // Walk backwards from the newest visible event — the log shows at most 70 rows.
  const log: Html[] = [];
  for (let i = sel.evs.length - 1; i >= 0 && log.length < 70; i--) {
    const e = sel.evs[i];
    if (e.t > t) continue;
    if (!logFilter(st.logKind, e)) continue;
    const time = fmtT(e.t);
    const nameOf = (id: string | undefined) => { const a = id ? eng.agents.get(id) : undefined; return a ? displayName(a) : id; };
    if (e.type === 'spawn') log.push(logRow(time, 'SPAWN', 'var(--accent)', sel.parent ? `spawned by ${nameOf(sel.parent)}` : 'session started', `+${fmt(e.tokens || 0)}`));
    else if (e.type === 'message' && e.to === sel.id) log.push(logRow(time, '◀ RECV', 'var(--accent-bright)', `${e.label || 'message'}${e.from ? ' — from ' + nameOf(e.from) : ' — external'}`, `+${fmt(e.tokens || 0)}`));
    else if (e.type === 'message' && e.from === sel.id && e.to !== sel.id) log.push(logRow(time, 'SEND ▶', 'rgba(var(--text-mid-rgb),.8)', `${e.label || 'message'} — to ${nameOf(e.to || '')}`, ''));
    else if (e.type === 'message' && e.from === sel.id) log.push(logRow(time, 'REPLY', 'rgba(var(--text-mid-rgb),.8)', e.label || 'assistant reply', `+${fmt(e.tokens || 0)}`));
    else if (e.type === 'tool') log.push(logRow(time, 'TOOL', 'var(--warn)', `${e.tool}${e.label ? ' — ' + e.label : ''}`, `+${fmt(e.tokens || 0)}`));
    else if (e.type === 'compact') log.push(logRow(time, 'COMPACT', 'var(--purple)', e.label || 'context compacted', `−${fmt((e as any)._drop || 0)}`));
    else if (e.type === 'error') log.push(logRow(time, 'ERROR', 'var(--err)', e.label || 'error', ''));
    else if (e.type === 'complete') log.push(logRow(time, 'DONE', 'var(--ok-2)', e.label || 'completed', ''));
  }
  const logHtml = (log.length ? html`${log}` : html`<em>No visible events yet</em>`).s;
  if (last.log !== logHtml) {
    last.log = logHtml;
    const oldTop = R.log.scrollTop, oldH = R.log.scrollHeight;
    R.log.innerHTML = logHtml;
    if (oldTop > 0) R.log.scrollTop = oldTop + (R.log.scrollHeight - oldH);
  }
}

function renderTranscript(el: HTMLElement, st: InspState, R: InspRefs, eng: Engine, simT: number, selectedId: string, sessionId: string, ctx: InspectorTranscript) {
  const key = `${sessionId}|${st.trAll ? '*' : selectedId}`;
  let tr = st.tr;
  if (!tr || tr.key !== key) {
    if (tr?.tailTimer != null) clearTimeout(tr.tailTimer);
    tr = st.tr = freshTr(key, sessionId, st.trAll ? undefined : selectedId, ctx.eventCount);
    delete st.last.trBar;
    trFetchInitial(st, tr);
  }
  if (tr.fetched && ctx.live && ctx.eventCount !== tr.lastEventCount) {
    tr.lastEventCount = ctx.eventCount;
    if (tr.tailTimer == null) {
      const cur = tr;
      tr.tailTimer = window.setTimeout(() => { cur.tailTimer = null; if (st.tr === cur) trFetchTail(st, cur); }, 500);
    }
  }
  const count = tr.loading && !tr.items.length ? 'loading…' : `${tr.items.length}${tr.total != null && tr.total > tr.items.length ? ` of ${tr.total}` : ''} rows`;
  const barKey = [st.trAll, tr.follow, count].join('|');
  if (st.last.trBar !== barKey) {
    st.last.trBar = barKey;
    R.trBar.innerHTML = html`<button data-tr-all class="${st.trAll ? 'on' : ''}" aria-pressed="${st.trAll}">all agents</button><button data-tr-follow class="${tr.follow ? 'on' : ''}" aria-pressed="${tr.follow}" title="Auto-scroll to the playhead">follow</button><span class="t-count">${count}</span>`.s;
  }
  if (tr.renderedGen !== tr.gen) {
    tr.renderedGen = tr.gen;
    const list = R.trList;
    const oldTop = list.scrollTop, oldH = list.scrollHeight;
    const empty = tr.loading ? 'Loading transcript…' : tr.gone ? 'Transcript source file is gone.' : 'No transcript rows.';
    list.innerHTML = (tr.items.length ? html`${tr.items.map(it => trRow(it, eng, st.trAll))}` : html`<em>${empty}</em>`).s;
    if (tr.scrollBottom) { tr.scrollBottom = false; list.scrollTop = list.scrollHeight; }
    else if (tr.anchor) { tr.anchor = false; list.scrollTop = prependAnchor(oldTop, oldH, list.scrollHeight); }
    tr.currentI = -2;
  }
  // Level-triggered top pagination: a scroll-edge fetch can lose to an
  // in-flight tail fetch on live sessions, so retry while parked at the top.
  if (!tr.loading && !tr.atStart && tr.items.length && R.trList.scrollTop < 40 && R.trList.scrollHeight > R.trList.clientHeight) {
    trFetchOlder(st, tr);
  }
  const fi = followIndex(tr.items, simT);
  const curI = fi >= 0 ? tr.items[fi].i : -1;
  if (curI !== tr.currentI) {
    tr.currentI = curI;
    R.trList.querySelector('.t-row.current')?.classList.remove('current');
    if (curI >= 0) R.trList.querySelector(`[data-ti="${curI}"]`)?.classList.add('current');
  }
  if (curI >= 0 && tr.follow && (ctx.playing || ctx.live)) {
    const list = R.trList;
    const row = list.querySelector<HTMLElement>(`[data-ti="${curI}"]`);
    if (row) {
      const y = row.offsetTop - list.offsetTop;
      if (y < list.scrollTop || y + row.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = Math.max(0, y + row.offsetHeight - list.clientHeight + 8);
      }
    }
  }
}

function trRow(it: TranscriptItem, eng: Engine, showAgent: boolean): Html {
  const a = eng.agents.get(it.agent);
  const who = showAgent ? html`<b class="t-who"><i style="background:${a ? colorOf(a) : 'var(--accent)'}"></i>${a ? displayName(a) : it.agent}</b>` : '';
  const tool = it.tool ? html`<em class="t-tool">${it.tool}</em>` : '';
  const more = it.truncated || it.text.length > 360 ? html`<i class="t-more" title="Expand">${it.truncated ? '…truncated' : '⋯'}</i>` : '';
  return html`<button class="t-row role-${it.role}" data-ti="${it.i}" data-t="${it.t}"><time>${fmtT(it.t)}</time><span class="t-body">${who}${tool}<span class="t-text">${cleanLabel(it.text)}</span>${more}</span></button>`;
}

function trApply(st: InspState, tr: TranscriptState, mutate: () => void) {
  mutate();
  tr.gen++;
  if (st.tr === tr) st.rerender();
}

function trFetchInitial(st: InspState, tr: TranscriptState) {
  tr.loading = true;
  const seq = ++tr.seq;
  void fetchTranscript(tr.sessionId, { agent: tr.agent, limit: TR_PAGE }).then((res) => {
    if (tr.seq !== seq || st.tr !== tr) return;
    tr.loading = false;
    tr.fetched = true;
    if (res && 'unsupported' in res) { trUnsupported.add(tr.sessionId); st.tab = 'inspect'; st.rerender(); return; }
    if (res && 'gone' in res) { toast('Transcript unavailable: source file is gone'); trApply(st, tr, () => { tr.gone = true; }); return; }
    trApply(st, tr, () => {
      if (!res) return;
      tr.items = res.items;
      tr.total = res.total;
      tr.atStart = res.nextCursor == null;
      tr.scrollBottom = true;
    });
  });
}

function trFetchOlder(st: InspState, tr: TranscriptState) {
  if (tr.loading || tr.atStart || !tr.items.length) return;
  tr.loading = true;
  const seq = ++tr.seq;
  const before = tr.items[0].i;
  void fetchTranscript(tr.sessionId, { agent: tr.agent, before, limit: TR_PAGE }).then((res) => {
    if (tr.seq !== seq || st.tr !== tr) return;
    tr.loading = false;
    if (!res || 'unsupported' in res) return;
    if ('gone' in res) { toast('Transcript unavailable: source file is gone'); trApply(st, tr, () => { tr.gone = true; }); return; }
    const fresh = res.items.filter((x) => x.i < before);
    trApply(st, tr, () => {
      if (!fresh.length) { tr.atStart = true; return; }
      tr.items = [...fresh, ...tr.items];
      tr.atStart = res.nextCursor == null;
      tr.anchor = true;
    });
  });
}

function trFetchTail(st: InspState, tr: TranscriptState) {
  if (tr.loading || !tr.items.length) { if (!tr.items.length && tr.fetched && !tr.loading) trFetchInitial(st, tr); return; }
  tr.loading = true;
  const seq = ++tr.seq;
  const after = tr.items[tr.items.length - 1].i;
  void fetchTranscript(tr.sessionId, { agent: tr.agent, after, limit: TR_PAGE }).then((res) => {
    if (tr.seq !== seq || st.tr !== tr) return;
    tr.loading = false;
    if (!res || 'unsupported' in res) return;
    if ('gone' in res) { trApply(st, tr, () => { tr.gone = true; }); return; }
    if (!res.items.length) return;
    trApply(st, tr, () => {
      const maxI = res.items[res.items.length - 1].i;
      if (maxI <= after) {
        // i regressed: the session was rewritten in place — replace the list wholesale.
        tr.items = res.items;
        tr.atStart = res.nextCursor == null;
      } else {
        tr.items = [...tr.items, ...res.items.filter((x) => x.i > after)];
      }
      if (tr.follow) tr.scrollBottom = true;
    });
  });
}

function runStats(a: import('../shared/schema').AwvAgent): Html {
  const cells: Html[] = [];
  if (a.durationMs != null) cells.push(cell('duration', fmtDur(a.durationMs)));
  if (a.totalTokens != null) cells.push(cell('tokens', fmt(a.totalTokens)));
  if (a.toolCount != null) cells.push(cell('tool calls', String(a.toolCount)));
  const ts = a.toolStats;
  if (ts && (ts.linesAdded || ts.linesRemoved)) cells.push(cell('lines', `+${ts.linesAdded || 0} −${ts.linesRemoved || 0}`));
  if (a.model) cells.push(cell('model', a.model.replace(/^claude-/, '')));
  if (!cells.length && !a.result) return html``;
  return html`<div class="run-stats">${cells}</div>${a.result ? html`<p class="task run-result">${cleanLabel(a.result)}</p>` : ''}`;
}

function cell(label: string, value: string): Html {
  return html`<div class="run-cell"><b>${value}</b><span>${label}</span></div>`;
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function childRow(a: EngineAgent, t: number, liveNow: number | undefined): Html {
  const st = statusAt(a, t, liveNow), pct = Math.min(1, tokensAt(a, t) / (a.def.limit || 1000000)), [label, scol] = statusMeta(st);
  return html`<button class="child-row" data-child="${a.id}" style="--agent:${colorOf(a)}"><span></span><b>${displayName(a)}</b><em style="color:${scol}">${label} · ${(pct * 100).toFixed(0)}%</em></button>`;
}

function logRow(time: string, tag: string, color: string, text: string, delta: string): Html {
  return html`<div class="log-row"><time>${time}</time><b style="color:${color}">${tag}</b><span>${cleanLabel(text)}</span><em>${delta}</em></div>`;
}

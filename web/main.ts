import type { AwvSession, ServerMessage, SessionSource, SessionStats, SessionSummary, Settings } from '../shared/schema';
import { parseSession, fmtT } from './engine';
import type { Engine } from './engine';
import { VisualRenderer, PALETTES, type LayoutMode, type PaletteName } from './render';
import { renderInspector, renderRail } from './panels';
import { HomeView } from './home';
import { Palette } from './palette';
import { html, raw } from './html';
import { Transport, searchServer, putSettings } from './transport';
import { SettingsModal } from './settingsModal';
import { setupImport, exportSession } from './importer';
import { relTime } from './stats-viz';


interface ViewSession { id: string; awv: AwvSession; eng: Engine; live: boolean; lastIndex: number; startMs: number }

type Route =
  | { view: 'home' }
  | { view: 'live' }
  | { view: 'session'; id: string }
  | { view: 'replay' };

const app = document.getElementById('app')!;
app.innerHTML = `
  <div id="homeRoot" class="home-root" hidden></div>
  <div id="graphRoot" class="shell" hidden>
    <header class="topbar">
      <button id="homeBtn" class="ghost home-btn" aria-label="Back to sessions home" title="Sessions home (esc)">← Home</button>
      <div class="brand"><i></i><div><b>AGENT ORCHESTRA</b><span>CLAUDE CODE LIVE VISUALISER</span></div></div>
      <select id="sessionPicker" class="select" aria-label="Session"><option value="all-live">All live sessions</option></select>
      <select id="sourceFilter" class="select compact" aria-label="Filter sessions by source"><option value="all">All sources</option><option value="claude">claude</option><option value="codex">codex</option><option value="opencode">opencode</option><option value="copilot">copilot</option></select>
      <div id="sessionDesc" class="desc">Connecting to local transcript stream…</div>
      <select id="layout" class="select compact" aria-label="Layout"><option>organic</option><option>radial</option><option>fixed</option></select>
      <select id="palette" class="select compact" aria-label="Colour palette">${Object.keys(PALETTES).map(p => `<option>${p}</option>`).join('')}</select>
      <button id="fit" class="ghost" aria-label="Fit view to agents">⤢ Fit</button>
      <button id="live" class="live off" aria-label="Follow live">● LIVE</button>
      <button id="import" class="amber">Import</button>
      <button id="export" class="amber">Export</button>
      <button id="settings" class="ghost" aria-label="Settings" title="Settings">⚙</button>
      <input id="file" type="file" accept="application/json,.json" hidden>
    </header>
    <main class="stage">
      <canvas id="canvas" aria-label="Agent orchestra graph" role="img"></canvas>
      <aside id="rail" class="rail"></aside>
      <button id="railToggle" class="rail-toggle" aria-label="Show agents panel">AGENTS</button>
      <aside id="inspector" class="inspector" aria-live="polite" hidden></aside>
      <div id="empty" class="empty-state" hidden></div>
      <div class="canvas-nav" role="group" aria-label="View controls">
        <button id="zoomIn" class="cnav-btn" aria-label="Zoom in" title="Zoom in">+</button>
        <button id="zoomOut" class="cnav-btn" aria-label="Zoom out" title="Zoom out">−</button>
        <button id="fitBtn" class="cnav-btn" aria-label="Fit view to agents" title="Fit to view (f)">⤢</button>
      </div>
      <div class="hint">drag to pan · scroll to zoom · dbl-click to fit · click a node to inspect · space play/pause · ←/→ step · ⌘K switch session · drop AWV JSON to import</div>
    </main>
    <footer class="timeline">
      <div class="controls"><button id="play" aria-label="Play or pause">▶</button><button id="back" aria-label="Step to previous event">←</button><button id="fwd" aria-label="Step to next event">→</button><button data-speed="0.5" aria-label="0.5× speed">0.5×</button><button class="on" data-speed="1" aria-label="1× speed">1×</button><button data-speed="2" aria-label="2× speed">2×</button><button data-speed="4" aria-label="4× speed">4×</button><button data-speed="16" aria-label="16× speed">16×</button><button data-speed="64" aria-label="64× speed">64×</button></div>
      <canvas id="tl" aria-label="Timeline scrubber" role="slider" tabindex="0"></canvas>
      <div id="time" class="time">0:00 / 0:00</div>
    </footer>
    <div id="dropOverlay" class="drop-overlay" hidden><div>Drop AWV JSON to import</div></div>
  </div>
  <div id="settingsModal" class="modal" hidden role="dialog" aria-modal="true" aria-label="Settings"></div>`;

const homeRoot = document.getElementById('homeRoot')!;
const graphRoot = document.getElementById('graphRoot')!;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const renderer = new VisualRenderer(canvas);
renderer.setTimeline(document.getElementById('tl') as HTMLCanvasElement);
const reduceMotionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
renderer.reduceMotion = reduceMotionMq.matches;
reduceMotionMq.addEventListener('change', e => { renderer.reduceMotion = e.matches; });
const rail = document.getElementById('rail')!;
const inspector = document.getElementById('inspector')!;
const picker = document.getElementById('sessionPicker') as HTMLSelectElement;
const sourceFilterEl = document.getElementById('sourceFilter') as HTMLSelectElement;
const desc = document.getElementById('sessionDesc')!;
const playBtn = document.getElementById('play')!;
const liveBtn = document.getElementById('live')!;
const timeEl = document.getElementById('time')!;
const fileInput = document.getElementById('file') as HTMLInputElement;
const emptyEl = document.getElementById('empty')!;
let lastEmptyKey = '';

let sessions: SessionSummary[] = [];
let statsById = new Map<string, SessionStats>();
let sourceFilter: SessionSource | 'all' = 'all';
let route: Route = parseRoute(location.hash);
let views = new Map<string, ViewSession>();
let active: ViewSession | null = null;
let imported: ViewSession | null = null;
let playing = true;
let livePinned = true;
let speed = 1;
let simT = 0;
let selectedId: string | null = null;
let lastFrame = 0;
let lastLiveKey = '';
let dirty = new Set<string>();
let rebuildTimer: number | null = null;
let homeTimer: number | null = null;
let panelsDirty = false;
let panelsAt = 0;
let showCompleted = false;
let serverSettings: Settings | null = null;
let serverBootId: string | undefined;

const homeView = new HomeView(homeRoot, {
  onOpen: (id) => { location.hash = `#/s/${id}`; },
  onWatchLive: () => { location.hash = '#/live'; },
  onImport: () => fileInput.click(),
  search: searchServer,
});
const palette = new Palette(document.body, {
  onOpen: (id) => { location.hash = `#/s/${id}`; },
  search: searchServer,
  onOpenChange: (open) => setGraphInert(open || settingsModal.isOpen),
});
palette.bindData(() => ({ sessions, stats: statsById }));
const settingsModal = new SettingsModal(document.getElementById('settingsModal')!, (open) => setGraphInert(open || palette.isOpen));
const transport = new Transport({
  onOpen: () => { lastLiveKey = ''; subscribe(); updateChrome(); scheduleHome(0); },
  onMessage: handle,
  onDown: () => { desc.textContent = 'Disconnected — retrying…'; scheduleHome(); },
});

renderer.onSelect = (id) => { selectedId = id; renderer.selectedId = id; renderPanels(); };
renderer.onSeek = (t) => { simT = t; livePinned = false; playing = false; panelsDirty = true; };

transport.connect();
applyRoute(route, true);
requestAnimationFrame(frame);

// ---------- routing ----------

function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  if (h === 'live') return { view: 'live' };
  if (h === 'replay') return { view: 'replay' };
  const m = /^s\/(.+)$/.exec(h);
  if (m) return { view: 'session', id: decodeURIComponent(m[1]) };
  return { view: 'home' };
}

function graphChoice(r: Route): 'all-live' | string | null {
  return r.view === 'live' ? 'all-live' : r.view === 'session' ? r.id : null;
}

function applyRoute(r: Route, initial = false) {
  const prev = route;
  route = r;
  if (r.view === 'replay' && !imported) { location.hash = ''; return; }
  const isGraph = r.view !== 'home';
  homeRoot.hidden = isGraph;
  graphRoot.hidden = !isGraph;
  if (r.view === 'home') {
    active = null;
    imported = null;
    views.clear(); dirty.clear();
    lastLiveKey = '';
    subscribe();
    scheduleHome(0);
    if (matchMedia('(pointer:fine)').matches) requestAnimationFrame(() => homeView.focusSearch());
    return;
  }
  if (r.view === 'replay') { if (imported) setActive(imported); return; }
  const choice = graphChoice(r)!;
  const prevChoice = initial ? null : graphChoice(prev);
  if (choice !== prevChoice) {
    imported = null;
    livePinned = true; playing = true;
    views.clear(); dirty.clear();
    lastLiveKey = '';
    desc.textContent = 'Loading session…';
    active = null;
    subscribe();
  }
  renderPicker();
  updateChrome();
}

window.addEventListener('hashchange', () => {
  const r = parseRoute(location.hash);
  if (JSON.stringify(r) !== JSON.stringify(route)) applyRoute(r);
});

// ---------- server messages ----------

function summaryOf(id: string): SessionSummary | undefined {
  return sessions.find(s => s.id === id);
}

function handle(msg: ServerMessage) {
  if (msg.type === 'sessions') {
    if (msg.bootId) serverBootId = msg.bootId;
    sessions = msg.sessions;
    renderPicker();
    // Only resubscribe when the set of live sessions actually changed (server broadcasts summaries on any activity).
    if (!imported && route.view === 'live') {
      const key = sessions.filter(s => s.live).map(s => s.id).sort().join(',');
      if (key !== lastLiveKey) { lastLiveKey = key; subscribe(); }
    }
    updateChrome(false);
    scheduleHome();
  } else if (msg.type === 'stats') {
    for (const st of msg.stats) statsById.set(st.sessionId, st);
    scheduleHome();
  } else if (msg.type === 'snapshot') {
    const sum = summaryOf(msg.sessionId);
    const startMs = sum?.startedAt || firstEventMs(msg.session) || Date.now();
    const v: ViewSession = { id: msg.sessionId, awv: msg.session, eng: parseSession(msg.session), live: sum?.live ?? false, lastIndex: msg.session.events.length, startMs };
    views.set(msg.sessionId, v);
    scheduleRebuild();
  } else if (msg.type === 'settings') {
    applyServerSettings(msg.settings);
  } else if (msg.type === 'events') {
    const v = views.get(msg.sessionId);
    if (!v) return;
    const len = v.awv.events.length;
    if (msg.from > len) {
      // A batch was lost between server and us (drop/backpressure). Index
      // arithmetic can no longer be trusted — refetch a full snapshot.
      v.lastIndex = 0;
      subscribe();
      return;
    }
    if (msg.agents?.length) {
      for (const a of msg.agents) {
        const i = v.awv.agents.findIndex(x => x.id === a.id);
        if (i >= 0) v.awv.agents[i] = a; else v.awv.agents.push(a);
      }
    }
    // Drop the already-applied overlap when a resume replays events we have.
    const fresh = msg.events.slice(len - msg.from);
    if (fresh.length) v.awv.events.push(...fresh);
    v.lastIndex = v.awv.events.length;
    dirty.add(msg.sessionId);
    scheduleRebuild();
  }
}

function firstEventMs(awv: AwvSession): number | undefined {
  for (const e of awv.events) { if (e.ts) { const n = Date.parse(e.ts); if (Number.isFinite(n)) return n; } }
  return undefined;
}

/** Coalesce bursts of snapshots/event batches into one engine rebuild. */
function scheduleRebuild() {
  if (rebuildTimer != null) return;
  rebuildTimer = window.setTimeout(() => {
    rebuildTimer = null;
    for (const id of dirty) {
      const v = views.get(id);
      if (v) v.eng = parseSession(v.awv);
    }
    dirty.clear();
    rebuildActive();
  }, 250);
}

/** Coalesce sessions/stats bursts into one Home re-render. */
function scheduleHome(delay = 200) {
  if (route.view !== 'home') return;
  if (homeTimer != null) return;
  homeTimer = window.setTimeout(() => {
    homeTimer = null;
    if (route.view !== 'home') return;
    const pricingConfigured = !!serverSettings && Object.keys(serverSettings.pricing || {}).length > 0;
    homeView.update(sessions, statsById, { pricingConfigured, connected: transport.open });
  }, delay);
}

function subscribe() {
  if (imported) return;
  const choice = graphChoice(route);
  const lastEventIndex: Record<string, number> = {};
  for (const [id, v] of views) lastEventIndex[id] = v.lastIndex;
  // Home keeps the socket for summaries/stats but streams no snapshots.
  transport.send({ type: 'subscribe', sessionIds: choice === 'all-live' ? 'all-live' : choice ? [choice] : [], lastEventIndex, bootId: serverBootId });
}

function applyServerSettings(s: Settings) {
  serverSettings = s;
  renderer.palette = s.palette as PaletteName;
  renderer.layout = s.layout as LayoutMode;
  renderer.showGrid = !!s.showGrid;
  renderer.showSubagentNames = s.showSubagentNames !== false;
  renderer.showOrchestratorName = s.showOrchestratorName !== false;
  const p = document.getElementById('palette') as HTMLSelectElement;
  const l = document.getElementById('layout') as HTMLSelectElement;
  if (p) p.value = s.palette;
  if (l) l.value = s.layout;
  settingsModal.setSettings(s);
  scheduleHome();
}

// ---------- active session ----------

function renderPicker() {
  const liveCount = sessions.filter(s => s.live).length;
  const visible = sourceFilter === 'all' ? sessions : sessions.filter(s => s.source === sourceFilter);
  const groups = new Map<string, SessionSummary[]>();
  for (const s of visible) {
    const key = s.projectName || s.project;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  const sorted = [...groups.entries()].sort((a, b) => Math.max(...b[1].map(s => s.lastActive)) - Math.max(...a[1].map(s => s.lastActive)));
  const opts = [];
  if (imported) opts.push(html`<option value="__imported">Imported replay</option>`);
  opts.push(html`<option value="all-live">All live sessions (${liveCount})</option>`);
  for (const [projectName, list] of sorted) {
    list.sort((a, b) => b.lastActive - a.lastActive);
    const rows = list.map(s => html`<option value="${s.id}">${s.live ? '● ' : ''}[${s.source}] ${s.title || s.id.slice(0, 8)} — ${relTime(s.lastActive)}</option>`);
    opts.push(html`<optgroup label="${projectName}">${rows}</optgroup>`);
  }
  picker.innerHTML = html`${opts}`.s;
  picker.value = imported ? '__imported' : (graphChoice(route) ?? 'all-live');
}

function rebuildActive() {
  if (imported) { setActive(imported); return; }
  const choice = graphChoice(route);
  if (!choice) return; // Home — no graph to rebuild
  if (choice === 'all-live') {
    // Keep every subscribed view in the merge (even ones that just went idle) so nodes don't vanish mid-scrub.
    const liveViews = [...views.values()];
    if (!liveViews.length) { active = null; renderPanels(); updateChrome(); return; }
    const minStart = Math.min(...liveViews.map(v => v.startMs));
    const awv: AwvSession = {
      name: 'All live sessions',
      desc: `${liveViews.length} agent session${liveViews.length === 1 ? '' : 's'} · mission control`,
      agents: [], events: [],
    };
    for (const v of liveViews) {
      const prefix = `${v.id}::`; // stable across rebuilds so node positions and selection survive
      const offset = v.startMs - minStart; // align every session onto shared wall-clock time
      const sum = summaryOf(v.id);
      const rootName = truncateLabel(`${sum?.projectName || v.awv.name} — ${sum?.title || ''}`, 60);
      awv.agents.push(...v.awv.agents.map(a => ({ ...a, id: prefix + a.id, name: a.role === 'root' ? rootName : a.name })));
      awv.events.push(...v.awv.events.map(e => remapEvent(e, prefix, offset)));
    }
    awv.events.sort((a, b) => a.t - b.t);
    setActive({ id: 'all-live', awv, eng: parseSession(awv), live: true, lastIndex: awv.events.length, startMs: minStart });
  } else {
    const v = views.get(choice);
    if (v) setActive(v);
  }
}

function truncateLabel(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').replace(/ — $/, '').trim();
  return one.length <= n ? one : one.slice(0, n - 1) + '…';
}

function remapEvent(e: any, prefix: string, offset: number): any {
  const out = { ...e, t: e.t + offset };
  if (out.agent) out.agent = prefix + out.agent;
  if (out.parent) out.parent = prefix + out.parent;
  if (out.from) out.from = prefix + out.from;
  if (out.to) out.to = prefix + out.to;
  return out;
}

function setActive(v: ViewSession) {
  const oldId = active?.id;
  active = v;
  if (oldId !== v.id) {
    simT = livePinned && v.live ? v.eng.duration : 0;
    selectedId = null;
    renderer.selectedId = null;
    // Live mission control stays decluttered by default, but replay/imported
    // sessions should show the completed cast for post-run inspection.
    showCompleted = !v.live;
  } else if (livePinned && v.live) simT = v.eng.duration;
  renderer.setEngine(v.eng, oldId !== v.id);
  renderer.liveNow = v.live ? v.eng.duration : undefined;
  updateChrome();
}

// ---------- frame loop & panels ----------

function frame(ts: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(48, ts - (lastFrame || ts)); lastFrame = ts;
  if (active && route.view !== 'home') {
    if (livePinned && active.live) simT = active.eng.duration;
    else if (playing) {
      // Dead air auto-skips: a compressed idle gap crosses in ~600ms of wall time
      // regardless of its real length, then playback resumes at the chosen speed.
      let adv = dt * speed;
      for (const g of active.eng.warp.gaps) {
        if (g.t0 > simT) break;
        if (simT < g.t1) {
          adv = Math.min(Math.max(adv, (g.t1 - g.t0) * (dt / 600)), g.t1 - simT + dt * speed);
          break;
        }
      }
      simT = Math.min(active.eng.duration, simT + adv);
      if (simT >= active.eng.duration && !active.live) playing = false;
    }
    renderer.railOpen = !rail.classList.contains('closed');
    renderer.drawFrame(simT, dt);
    if ((panelsDirty || playing || (livePinned && active.live)) && ts - panelsAt > 200) { panelsAt = ts; panelsDirty = false; renderPanels(); }
  }
  if (route.view !== 'home') updateChrome(false);
}

function renderPanels() {
  renderRail(rail, active?.eng, simT, selectedId, active?.live ? active.eng.duration : undefined, (id) => {
    selectedId = id; renderer.selectedId = id; renderer.focusId = id; renderPanels();
  }, showCompleted, () => { showCompleted = !showCompleted; renderPanels(); });
  renderInspector(inspector, active?.eng, simT, selectedId, active?.live ? active.eng.duration : undefined, (id) => {
    selectedId = id; renderer.selectedId = id; renderer.focusId = id; renderPanels();
  }, () => { selectedId = null; renderer.selectedId = null; renderPanels(); }, sourceOfAgent);
  // Drive the on-canvas nav offset from the inspector's *settled* hidden state.
  // A CSS sibling combinator (`#inspector:not([hidden]) ~ .canvas-nav`) is unreliable
  // here: toggling the `hidden` attribute on an earlier sibling doesn't consistently
  // invalidate the combinator match for the later sibling, so the nav overlapped the
  // inspector. An explicit class on the stage is deterministic.
  document.querySelector('.stage')?.classList.toggle('inspector-open', !inspector.hidden);
}

function sourceOfAgent(agentId: string): string | undefined {
  if (!active) return undefined;
  if (active.id === 'all-live') {
    const sep = agentId.indexOf('::');
    return sep > 0 ? summaryOf(agentId.slice(0, sep))?.source : undefined;
  }
  return summaryOf(active.id)?.source;
}

function updateChrome(render = true) {
  playBtn.textContent = playing ? '❚❚' : '▶';
  liveBtn.classList.toggle('off', !livePinned || !active?.live);
  timeEl.textContent = active ? `${fmtT(simT)} / ${fmtT(active.eng.duration)}` : '0:00 / 0:00';
  desc.textContent = active?.awv.desc || (transport.open ? 'No live sessions yet — start an agent session or import a replay.' : 'Connecting…');
  updateEmptyState();
  if (render) renderPanels();
}

function updateEmptyState() {
  const connected = transport.open;
  const show = !active && route.view !== 'home';
  const key = show ? (connected ? 'idle' : transport.connecting ? 'connecting' : 'offline') : 'hidden';
  if (key === lastEmptyKey) return;
  lastEmptyKey = key;
  emptyEl.hidden = !show;
  if (!show) return;
  const head = connected ? 'No live sessions' : transport.connecting ? 'Connecting…' : 'Disconnected';
  const sub = connected
    ? 'Start a coding agent (Claude Code, Codex, opencode, Copilot) in any project, pick a past session above, or import a replay.'
    : 'Reconnecting to the local transcript stream…';
  emptyEl.innerHTML = html`<div class="empty-card"><span class="empty-dot ${connected ? 'on' : ''}"></span><h2>${head}</h2><p>${sub}</p>${connected ? raw('<button id="emptyImport" class="amber">Import a replay</button>') : ''}</div>`.s;
  const b = document.getElementById('emptyImport');
  if (b) b.onclick = () => fileInput.click();
}

function setGraphInert(inert: boolean) {
  graphRoot.toggleAttribute('inert', inert);
  homeRoot.toggleAttribute('inert', inert);
}

// ---------- controls ----------

document.getElementById('homeBtn')!.onclick = () => { location.hash = ''; };
picker.onchange = () => {
  if (picker.value === '__imported') { if (imported) setActive(imported); return; }
  location.hash = picker.value === 'all-live' ? '#/live' : `#/s/${picker.value}`;
};
sourceFilterEl.onchange = () => { sourceFilter = sourceFilterEl.value as SessionSource | 'all'; renderPicker(); };
(document.getElementById('layout') as HTMLSelectElement).onchange = e => { renderer.layout = (e.target as HTMLSelectElement).value as LayoutMode; putSettings({ layout: renderer.layout }); };
(document.getElementById('palette') as HTMLSelectElement).onchange = e => { renderer.palette = (e.target as HTMLSelectElement).value as PaletteName; putSettings({ palette: renderer.palette }); };
document.getElementById('fit')!.onclick = () => renderer.fit();
document.getElementById('fitBtn')!.onclick = () => renderer.fit();
document.getElementById('zoomIn')!.onclick = () => renderer.zoomBy(1.3);
document.getElementById('zoomOut')!.onclick = () => renderer.zoomBy(1 / 1.3);
liveBtn.onclick = () => { if (!active?.live) return; livePinned = true; playing = true; simT = active.eng.duration; updateChrome(); };
playBtn.onclick = () => { if (simT >= (active?.eng.duration || 0) - 1) simT = 0; playing = !playing; livePinned = false; updateChrome(); };
document.getElementById('back')!.onclick = () => step(-1);
document.getElementById('fwd')!.onclick = () => step(1);
document.getElementById('railToggle')!.onclick = () => rail.classList.toggle('closed');
document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach(btn => btn.onclick = () => { speed = Number(btn.dataset.speed); document.querySelectorAll('[data-speed]').forEach(b => b.classList.toggle('on', b === btn)); });
document.getElementById('import')!.onclick = () => fileInput.click();
document.getElementById('export')!.onclick = () => { if (active) exportSession(active.awv); };
document.getElementById('settings')!.onclick = () => settingsModal.toggle();

setupImport(fileInput, document.getElementById('dropOverlay')!, (awv) => {
  imported = { id: '__imported', awv, eng: parseSession(awv), live: false, lastIndex: awv.events.length, startMs: 0 };
  livePinned = false; playing = true;
  if (route.view !== 'replay') location.hash = '#/replay';
  else applyRoute(route);
  renderPicker();
  setActive(imported);
});

function step(dir: number) {
  if (!active) return;
  const evs = active.eng.evs; livePinned = false; playing = false;
  if (dir > 0) { const e = evs.find(e => e.t > simT + 1); simT = e ? e.t : active.eng.duration; }
  else { let prev = 0; for (const e of evs) { if (e.t < simT - 1) prev = e.t; else break; } simT = prev; }
  updateChrome();
}

window.addEventListener('keydown', e => {
  if (settingsModal.handleKey(e)) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.toggle(); return; }
  if (e.key === 'Escape' && palette.isOpen) { e.preventDefault(); palette.hide(); return; }
  const tag = (e.target as HTMLElement)?.tagName || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (palette.isOpen) return;
  if (route.view === 'home') {
    if (e.key === '/') { e.preventDefault(); homeView.focusSearch(); }
    return;
  }
  if (e.key === 'Escape') { e.preventDefault(); location.hash = ''; return; }
  if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'f') renderer.fit();
  else if (e.key === 'c') { showCompleted = !showCompleted; renderPanels(); }
});

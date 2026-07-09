import type { AwvSession, ServerMessage, SessionStats, SessionSummary, Settings } from '../shared/schema';
import { parseSession, fmtT } from './engine';
import type { Engine } from './engine';
import { VisualRenderer, type LayoutMode, type PaletteName } from './render';
import { renderInspector, renderRail, focusRailFilter } from './panels';
import { HomeView } from './home';
import { Palette } from './palette';
import { html, raw } from './html';
import { Transport, searchServer, putSettings } from './transport';
import { SettingsModal } from './settingsModal';
import { setupImport, exportSession } from './importer';
import { setMask, maskProject } from './privacy';
import { theme } from './theme';


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
      <button id="sessionTitle" class="session-title bare" aria-label="Switch session (⌘K)" title=""><i></i><b></b><span></span></button>
      <span class="topbar-spacer"></span>
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
        <i class="cnav-div" aria-hidden="true"></i>
        <button id="layoutBtn" class="cnav-btn" aria-label="Graph layout" title="Layout">⊞</button>
        <button id="exportBtn" class="cnav-btn" aria-label="Export session JSON" title="Export session">⇣</button>
        <button id="helpBtn" class="cnav-btn" aria-label="Keyboard shortcuts" title="Shortcuts">?</button>
      </div>
    </main>
    <footer class="timeline">
      <div class="controls"><button id="play" aria-label="Play or pause">▶</button><button id="back" aria-label="Step to previous event">←</button><button id="fwd" aria-label="Step to next event">→</button><button id="speedChip" class="speed-chip" aria-label="Playback speed">1×</button></div>
      <canvas id="tl" aria-label="Timeline scrubber" role="slider" tabindex="0"></canvas>
      <div class="t-right"><div id="time" class="time">0:00 / 0:00</div><button id="live" class="live off" aria-label="Follow live" hidden>● LIVE</button></div>
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
theme.subscribe(t => { renderer.resolvedTheme = t; });
const rail = document.getElementById('rail')!;
const inspector = document.getElementById('inspector')!;
const playBtn = document.getElementById('play')!;
const liveBtn = document.getElementById('live')!;
const timeEl = document.getElementById('time')!;
const speedChip = document.getElementById('speedChip')!;
const fileInput = document.getElementById('file') as HTMLInputElement;
const emptyEl = document.getElementById('empty')!;
const titleBtn = document.getElementById('sessionTitle')!;
const titleProject = titleBtn.querySelector('b')!;
const titleText = titleBtn.querySelector('span')!;
let lastEmptyKey = '';

let sessions: SessionSummary[] = [];
let statsById = new Map<string, SessionStats>();
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

function cycleTheme() {
  const order = ['system', 'light', 'dark'] as const;
  const cur = serverSettings?.theme ?? 'system';
  putSettings({ theme: order[(order.indexOf(cur) + 1) % order.length] });
}

const homeView = new HomeView(homeRoot, {
  onOpen: (id) => { location.hash = `#/s/${id}`; },
  onImport: () => fileInput.click(),
  onSettings: () => settingsModal.toggle(),
  onCycleTheme: cycleTheme,
  search: searchServer,
});
const palette = new Palette(document.body, {
  onOpen: (id) => { location.hash = `#/s/${id}`; },
  onNode: (id) => { selectedId = id; renderer.selectedId = id; renderer.focusId = id; renderPanels(); },
  search: searchServer,
  onOpenChange: (open) => setGraphInert(open || settingsModal.isOpen),
});
palette.bindData(() => ({ sessions, stats: statsById }));
palette.bindActive(() => active ? { eng: active.eng, selectedId } : null);
palette.bindCommands(() => [
  { id: 'import', label: 'Import session…', run: () => fileInput.click() },
  { id: 'export', label: 'Export session', disabled: !active, run: () => { if (active) exportSession(active.awv); } },
  { id: 'mask', label: `Toggle privacy mask (${serverSettings?.maskProjects ? 'on' : 'off'})`, run: () => putSettings({ maskProjects: !serverSettings?.maskProjects }) },
  { id: 'theme', label: `Theme: ${serverSettings?.theme ?? 'system'} (cycle)`, run: cycleTheme },
  { id: 'settings', label: 'Settings', run: () => settingsModal.toggle() },
]);
const settingsModal = new SettingsModal(document.getElementById('settingsModal')!, (open) => setGraphInert(open || palette.isOpen));
const transport = new Transport({
  onOpen: () => { lastLiveKey = ''; subscribe(); updateChrome(); scheduleHome(0); },
  onMessage: handle,
  onDown: () => { updateChrome(); scheduleHome(); },
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
    active = null;
    subscribe();
  }
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
  theme.setSetting(s.theme || 'system');
  renderer.canvasStyle = s.canvasStyle || 'match';
  renderer.showGrid = !!s.showGrid;
  renderer.showSubagentNames = s.showSubagentNames !== false;
  renderer.showOrchestratorName = s.showOrchestratorName !== false;
  const maskChanged = maskWas !== s.maskProjects;
  maskWas = s.maskProjects;
  setMask(!!s.maskProjects);
  settingsModal.setSettings(s);
  if (maskChanged) { delete titleBtn.dataset.key; updateChrome(); }
  scheduleHome();
}
let maskWas = false;

// ---------- active session ----------

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
  const sum = active && active.id !== 'all-live' ? summaryOf(active.id) : undefined;
  renderInspector(inspector, active?.eng, simT, selectedId, active?.live ? active.eng.duration : undefined, (id) => {
    selectedId = id; renderer.selectedId = id; renderer.focusId = id; renderPanels();
  }, () => { selectedId = null; renderer.selectedId = null; renderPanels(); }, sourceOfAgent, sum ? { cwd: sum.cwd, projectName: sum.projectName } : undefined);
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
  liveBtn.hidden = !active?.live;
  liveBtn.classList.toggle('off', !livePinned || !active?.live);
  timeEl.textContent = active ? `${fmtT(simT)} / ${fmtT(active.eng.duration)}` : '0:00 / 0:00';
  let project = '', title = '', liveDot = false;
  if (imported && active === imported) {
    project = active.awv.name; title = 'imported replay';
  } else if (active) {
    const sum = summaryOf(active.id);
    project = sum?.projectName || active.awv.name;
    title = sum?.title || active.awv.desc || '';
    liveDot = active.live;
  } else {
    title = transport.open ? 'No session — ⌘K to switch' : 'Connecting…';
  }
  project = maskProject(project);
  const key = [project, title, liveDot].join('|');
  if (titleBtn.dataset.key !== key) {
    titleBtn.dataset.key = key;
    titleProject.textContent = project;
    titleText.textContent = title;
    titleBtn.classList.toggle('bare', !project);
    titleBtn.classList.toggle('is-live', liveDot);
    titleBtn.title = project ? `${project} — ${title}` : title;
  }
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
    ? 'Start a coding agent (Claude Code, Codex, opencode, Copilot) in any project, press ⌘K to pick a past session, or import a replay.'
    : 'Reconnecting to the local transcript stream…';
  emptyEl.innerHTML = html`<div class="empty-card"><span class="empty-dot ${connected ? 'on' : ''}"></span><h2>${head}</h2><p>${sub}</p>${connected ? raw('<button id="emptyImport" class="amber">Import a replay</button>') : ''}</div>`.s;
  const b = document.getElementById('emptyImport');
  if (b) b.onclick = () => fileInput.click();
}

function setGraphInert(inert: boolean) {
  graphRoot.toggleAttribute('inert', inert);
  homeRoot.toggleAttribute('inert', inert);
}

// ---------- popover ----------

interface PopItem { label: string; hint?: string; on?: boolean; run?: () => void }
let popoverClose: (() => void) | null = null;
let popoverAnchor: HTMLElement | null = null;

function togglePopover(anchor: HTMLElement, items: PopItem[]) {
  if (popoverAnchor === anchor) { closePopover(); return; }
  closePopover();
  const el = document.createElement('div');
  el.className = 'popover';
  el.setAttribute('role', 'menu');
  for (const it of items) {
    if (it.run) {
      const b = document.createElement('button');
      b.className = 'pop-item' + (it.on ? ' on' : '');
      b.setAttribute('role', 'menuitem');
      b.innerHTML = html`<i>${it.on ? '✓' : ''}</i><span>${it.label}</span>${it.hint ? html`<em>${it.hint}</em>` : ''}`.s;
      b.onclick = () => { closePopover(); it.run!(); };
      el.append(b);
    } else {
      const d = document.createElement('div');
      d.className = 'pop-row';
      d.innerHTML = html`<span>${it.label}</span>${it.hint ? html`<em>${it.hint}</em>` : ''}`.s;
      el.append(d);
    }
  }
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  el.style.bottom = `${window.innerHeight - r.top + 8}px`;
  if (r.left + r.right > window.innerWidth) el.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  else el.style.left = `${r.left}px`;
  const onDown = (e: PointerEvent) => { if (!el.contains(e.target as Node)) closePopover(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  popoverAnchor = anchor;
  popoverClose = () => {
    el.remove();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    popoverClose = null; popoverAnchor = null;
  };
}

function closePopover() { popoverClose?.(); }

const SPEEDS = [0.5, 1, 2, 4, 16, 64];
const SHORTCUTS: Array<[string, string]> = [
  ['Play / pause', 'space'],
  ['Step event', '← →'],
  ['Fit view', 'f'],
  ['Toggle completed agents', 'c'],
  ['Filter agents', '/'],
  ['Command palette', '⌘K'],
  ['Pan · zoom · fit', 'drag · scroll · dbl-click'],
  ['Import replay', 'drop AWV JSON'],
];

// ---------- controls ----------

document.getElementById('homeBtn')!.onclick = () => { location.hash = ''; };
titleBtn.onclick = () => palette.toggle();
document.getElementById('fitBtn')!.onclick = () => renderer.fit();
document.getElementById('zoomIn')!.onclick = () => renderer.zoomBy(1.3);
document.getElementById('zoomOut')!.onclick = () => renderer.zoomBy(1 / 1.3);
const layoutBtn = document.getElementById('layoutBtn')!;
layoutBtn.onclick = () => togglePopover(layoutBtn, (['organic', 'radial', 'fixed'] as const).map(l => ({
  label: l, on: renderer.layout === l,
  run: () => { renderer.layout = l as LayoutMode; putSettings({ layout: l }); },
})));
document.getElementById('exportBtn')!.onclick = () => { if (active) exportSession(active.awv); };
const helpBtn = document.getElementById('helpBtn')!;
helpBtn.onclick = () => togglePopover(helpBtn, SHORTCUTS.map(([label, hint]) => ({ label, hint })));
liveBtn.onclick = () => { if (!active?.live) return; livePinned = true; playing = true; simT = active.eng.duration; updateChrome(); };
playBtn.onclick = () => { if (simT >= (active?.eng.duration || 0) - 1) simT = 0; playing = !playing; livePinned = false; updateChrome(); };
document.getElementById('back')!.onclick = () => step(-1);
document.getElementById('fwd')!.onclick = () => step(1);
document.getElementById('railToggle')!.onclick = () => rail.classList.toggle('closed');
speedChip.onclick = () => togglePopover(speedChip, SPEEDS.map(v => ({
  label: `${v}×`, on: speed === v,
  run: () => { speed = v; speedChip.textContent = `${v}×`; },
})));
document.getElementById('settings')!.onclick = () => settingsModal.toggle();

setupImport(fileInput, document.getElementById('dropOverlay')!, (awv) => {
  imported = { id: '__imported', awv, eng: parseSession(awv), live: false, lastIndex: awv.events.length, startMs: 0 };
  livePinned = false; playing = true;
  if (route.view !== 'replay') location.hash = '#/replay';
  else applyRoute(route);
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
  if (e.key === '/') { e.preventDefault(); rail.classList.remove('closed'); focusRailFilter(rail); return; }
  if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'f') renderer.fit();
  else if (e.key === 'c') { showCompleted = !showCompleted; renderPanels(); }
});

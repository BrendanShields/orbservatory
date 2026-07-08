import type { AwvSession, ServerMessage, SessionSummary } from '../shared/schema';
import { parseSession, fmtT } from './engine';
import type { Engine } from './engine';
import { VisualRenderer, PALETTES, type LayoutMode, type PaletteName } from './render';
import { renderInspector, renderRail, esc } from './panels';


interface ViewSession { id: string; awv: AwvSession; eng: Engine; live: boolean; lastIndex: number; startMs: number }

type SessionChoice = 'all-live' | string;

const app = document.getElementById('app')!;
app.innerHTML = `
  <div class="shell">
    <header class="topbar">
      <div class="brand"><i></i><div><b>AGENT ORCHESTRA</b><span>CLAUDE CODE LIVE VISUALISER</span></div></div>
      <select id="sessionPicker" class="select" aria-label="Session"><option value="all-live">All live sessions</option></select>
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
      <div class="hint">drag to pan · scroll to zoom · dbl-click to fit · click a node to inspect · space play/pause · ←/→ step · drop AWV JSON to import</div>
    </main>
    <footer class="timeline">
      <div class="controls"><button id="play" aria-label="Play or pause">▶</button><button id="back" aria-label="Step to previous event">←</button><button id="fwd" aria-label="Step to next event">→</button><button data-speed="0.5" aria-label="0.5× speed">0.5×</button><button class="on" data-speed="1" aria-label="1× speed">1×</button><button data-speed="2" aria-label="2× speed">2×</button><button data-speed="4" aria-label="4× speed">4×</button><button data-speed="16" aria-label="16× speed">16×</button><button data-speed="64" aria-label="64× speed">64×</button></div>
      <canvas id="tl" aria-label="Timeline scrubber" role="slider" tabindex="0"></canvas>
      <div id="time" class="time">0:00 / 0:00</div>
    </footer>
    <div id="settingsModal" class="modal" hidden role="dialog" aria-modal="true" aria-label="Settings"></div>
  </div>`;

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const renderer = new VisualRenderer(canvas);
renderer.setTimeline(document.getElementById('tl') as HTMLCanvasElement);
const reduceMotionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
renderer.reduceMotion = reduceMotionMq.matches;
reduceMotionMq.addEventListener('change', e => { renderer.reduceMotion = e.matches; });
const rail = document.getElementById('rail')!;
const inspector = document.getElementById('inspector')!;
const picker = document.getElementById('sessionPicker') as HTMLSelectElement;
const desc = document.getElementById('sessionDesc')!;
const playBtn = document.getElementById('play')!;
const liveBtn = document.getElementById('live')!;
const timeEl = document.getElementById('time')!;
const fileInput = document.getElementById('file') as HTMLInputElement;
const emptyEl = document.getElementById('empty')!;
const settingsModal = document.getElementById('settingsModal')!;
let lastEmptyKey = '';

let sessions: SessionSummary[] = [];
let choice: SessionChoice = 'all-live';
let views = new Map<string, ViewSession>();
let active: ViewSession | null = null;
let imported: ViewSession | null = null;
let playing = true;
let livePinned = true;
let speed = 1;
let simT = 0;
let selectedId: string | null = null;
let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let lastFrame = 0;
let lastLiveKey = '';
let dirty = new Set<string>();
let rebuildTimer: number | null = null;
let panelsDirty = false;
let panelsAt = 0;
let showCompleted = false;
let serverSettings: import('../shared/schema').Settings | null = null;

renderer.onSelect = (id) => { selectedId = id; renderer.selectedId = id; renderPanels(); };
renderer.onSeek = (t) => { simT = t; livePinned = false; playing = false; panelsDirty = true; };

connect();
requestAnimationFrame(frame);

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => { lastLiveKey = ''; subscribe(); updateChrome(); };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    ws = null;
    desc.textContent = 'Disconnected — retrying…';
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connect, 900);
  };
  ws.onerror = () => ws?.close();
}

function summaryOf(id: string): SessionSummary | undefined {
  return sessions.find(s => s.id === id);
}

function handle(msg: ServerMessage) {
  if (msg.type === 'sessions') {
    sessions = msg.sessions;
    renderPicker();
    // Only resubscribe when the set of live sessions actually changed (server broadcasts summaries on any activity).
    if (!imported && choice === 'all-live') {
      const key = sessions.filter(s => s.live).map(s => s.id).sort().join(',');
      if (key !== lastLiveKey) { lastLiveKey = key; subscribe(); }
    }
    updateChrome(false);
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
    if (msg.agents?.length) {
      for (const a of msg.agents) {
        const i = v.awv.agents.findIndex(x => x.id === a.id);
        if (i >= 0) v.awv.agents[i] = a; else v.awv.agents.push(a);
      }
    }
    if (msg.events.length) v.awv.events.push(...msg.events);
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

function subscribe() {
  if (!ws || ws.readyState !== WebSocket.OPEN || imported) return;
  const lastEventIndex: Record<string, number> = {};
  for (const [id, v] of views) lastEventIndex[id] = v.lastIndex;
  ws.send(JSON.stringify({ type: 'subscribe', sessionIds: choice === 'all-live' ? 'all-live' : [choice], lastEventIndex }));
}

function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 90_000) return 'now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

function renderPicker() {
  const liveCount = sessions.filter(s => s.live).length;
  const groups = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const key = s.projectName || s.project;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  const sorted = [...groups.entries()].sort((a, b) => Math.max(...b[1].map(s => s.lastActive)) - Math.max(...a[1].map(s => s.lastActive)));
  const opts: string[] = [];
  if (imported) opts.push(`<option value="__imported">Imported replay</option>`);
  opts.push(`<option value="all-live">All live sessions (${liveCount})</option>`);
  for (const [projectName, list] of sorted) {
    list.sort((a, b) => b.lastActive - a.lastActive);
    const rows = list.map(s => `<option value="${esc(s.id)}">${s.live ? '● ' : ''}${esc(s.title || s.id.slice(0, 8))} — ${relTime(s.lastActive)}</option>`);
    opts.push(`<optgroup label="${esc(projectName)}">${rows.join('')}</optgroup>`);
  }
  picker.innerHTML = opts.join('');
  picker.value = imported ? '__imported' : choice;
}

function rebuildActive() {
  if (imported) { setActive(imported); return; }
  if (choice === 'all-live') {
    // Keep every subscribed view in the merge (even ones that just went idle) so nodes don't vanish mid-scrub.
    const liveViews = [...views.values()];
    if (!liveViews.length) { active = null; renderPanels(); updateChrome(); return; }
    const minStart = Math.min(...liveViews.map(v => v.startMs));
    const awv: AwvSession = {
      name: 'All live sessions',
      desc: `${liveViews.length} Claude Code session${liveViews.length === 1 ? '' : 's'} · mission control`,
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
  renderPanels();
  updateChrome();
}

function frame(ts: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(48, ts - (lastFrame || ts)); lastFrame = ts;
  if (active) {
    if (livePinned && active.live) simT = active.eng.duration;
    else if (playing) {
      simT = Math.min(active.eng.duration, simT + dt * speed);
      if (simT >= active.eng.duration && !active.live) playing = false;
    }
    renderer.railOpen = !rail.classList.contains('closed');
    renderer.drawFrame(simT, dt);
    if (panelsDirty && ts - panelsAt > 200) { panelsAt = ts; panelsDirty = false; renderPanels(); }
  }
  updateChrome(false);
}

function renderPanels() {
  renderRail(rail, active?.eng, simT, selectedId, active?.live ? active.eng.duration : undefined, (id) => {
    selectedId = id; renderer.selectedId = id; renderer.focusId = id; renderPanels();
  }, showCompleted, () => { showCompleted = !showCompleted; renderPanels(); });
  renderInspector(inspector, active?.eng, simT, selectedId, active?.live ? active.eng.duration : undefined, (id) => {
    selectedId = id; renderer.selectedId = id; renderer.focusId = id; renderPanels();
  }, () => { selectedId = null; renderer.selectedId = null; renderPanels(); });
}

function updateChrome(render = true) {
  playBtn.textContent = playing ? '❚❚' : '▶';
  liveBtn.classList.toggle('off', !livePinned || !active?.live);
  timeEl.textContent = active ? `${fmtT(simT)} / ${fmtT(active.eng.duration)}` : '0:00 / 0:00';
  desc.textContent = active?.awv.desc || (ws?.readyState === WebSocket.OPEN ? 'No live sessions yet — start Claude Code or import a replay.' : 'Connecting…');
  updateEmptyState();
  if (render) renderPanels();
}

function updateEmptyState() {
  const connected = ws?.readyState === WebSocket.OPEN;
  const show = !active;
  const key = show ? (connected ? 'idle' : ws ? 'connecting' : 'offline') : 'hidden';
  if (key === lastEmptyKey) return;
  lastEmptyKey = key;
  emptyEl.hidden = !show;
  if (!show) return;
  const head = connected ? 'No live sessions' : ws ? 'Connecting…' : 'Disconnected';
  const sub = connected
    ? 'Start Claude Code in any project, pick a past session above, or import a replay.'
    : 'Reconnecting to the local transcript stream…';
  emptyEl.innerHTML = `<div class="empty-card"><span class="empty-dot ${connected ? 'on' : ''}"></span><h2>${head}</h2><p>${sub}</p>${connected ? `<button id="emptyImport" class="amber">Import a replay</button>` : ''}</div>`;
  const b = document.getElementById('emptyImport');
  if (b) b.onclick = () => fileInput.click();
}

picker.onchange = () => {
  if (picker.value === '__imported') { choice = 'all-live'; if (imported) setActive(imported); return; }
  imported = null; choice = picker.value as SessionChoice; livePinned = true; playing = true;
  views.clear(); dirty.clear(); lastLiveKey = choice === 'all-live' ? '' : lastLiveKey;
  desc.textContent = 'Loading session…';
  subscribe();
};
(document.getElementById('layout') as HTMLSelectElement).onchange = e => { renderer.layout = (e.target as HTMLSelectElement).value as LayoutMode; putSettings({ layout: renderer.layout }); };
(document.getElementById('palette') as HTMLSelectElement).onchange = e => { renderer.palette = (e.target as HTMLSelectElement).value as PaletteName; putSettings({ palette: renderer.palette }); };

function applyServerSettings(s: import('../shared/schema').Settings) {
  serverSettings = s;
  renderer.palette = s.palette as PaletteName;
  renderer.layout = s.layout as LayoutMode;
  renderer.showGrid = !!s.showGrid;
  const p = document.getElementById('palette') as HTMLSelectElement;
  const l = document.getElementById('layout') as HTMLSelectElement;
  if (p) p.value = s.palette;
  if (l) l.value = s.layout;
  if (!settingsModal.hidden) renderSettingsModal();
}

function putSettings(patch: Record<string, unknown>) {
  fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).catch(() => {});
}

function openSettings() {
  renderSettingsModal();
  settingsModal.hidden = false;
  const first = settingsModal.querySelector<HTMLElement>('input,select,button');
  first?.focus();
}

function closeSettings() {
  settingsModal.hidden = true;
  (document.getElementById('settings') as HTMLElement)?.focus();
}

function renderSettingsModal() {
  const s = serverSettings;
  if (!s) { settingsModal.innerHTML = `<div class="modal-card"><p class="task">Waiting for settings…</p></div>`; return; }
  const limits = JSON.stringify(s.contextLimits ?? {}, null, 0);
  settingsModal.innerHTML = `<div class="modal-card">
    <button class="close" id="settingsClose" aria-label="Close settings" title="Close">×</button>
    <h2>Settings</h2>
    <label class="set-row"><input type="checkbox" id="setGrid" ${s.showGrid ? 'checked' : ''}><span>Show background grid</span></label>
    <label class="set-row"><span>Liveness window (minutes)</span><input type="number" id="setLiveness" min="1" max="1440" step="1" value="${Math.round(s.livenessMs / 60000)}"></label>
    <label class="set-row"><span>Poll interval (ms)</span><input type="number" id="setPoll" min="250" max="60000" step="50" value="${s.pollMs}"></label>
    <label class="set-row"><span>Port <em>(restart to apply)</em></span><input type="number" id="setPort" min="1" max="65535" step="1" value="${s.port}"></label>
    <label class="set-row col"><span>Per-model context limits (JSON)</span><input type="text" id="setLimits" spellcheck="false" value="${esc(limits)}" placeholder="{&quot;claude-haiku-4-5&quot;: 200000}"></label>
    <p class="set-err" id="setErr" role="alert" aria-live="polite" hidden></p>
    <div class="set-actions"><button class="ghost" id="settingsCancel">Cancel</button><button class="amber" id="settingsSave">Save</button></div>
  </div>`;
  settingsModal.querySelector<HTMLButtonElement>('#settingsClose')!.onclick = closeSettings;
  settingsModal.querySelector<HTMLButtonElement>('#settingsCancel')!.onclick = closeSettings;
  settingsModal.querySelector<HTMLButtonElement>('#settingsSave')!.onclick = saveSettings;
}

function saveSettings() {
  const err = settingsModal.querySelector<HTMLElement>('#setErr')!;
  err.hidden = true;
  const grid = settingsModal.querySelector<HTMLInputElement>('#setGrid')!.checked;
  const livenessMin = Number(settingsModal.querySelector<HTMLInputElement>('#setLiveness')!.value);
  const pollMs = Number(settingsModal.querySelector<HTMLInputElement>('#setPoll')!.value);
  const port = Number(settingsModal.querySelector<HTMLInputElement>('#setPort')!.value);
  const limitsRaw = settingsModal.querySelector<HTMLInputElement>('#setLimits')!.value.trim();
  let contextLimits: Record<string, number> = {};
  if (limitsRaw) {
    try {
      const parsed = JSON.parse(limitsRaw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be a JSON object');
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`"${k}" must be a number`);
        contextLimits[k] = v;
      }
    } catch (e) {
      err.textContent = `Context limits: ${(e as Error).message}`; err.hidden = false; return;
    }
  }
  if (!Number.isFinite(livenessMin) || livenessMin < 1) { err.textContent = 'Liveness must be at least 1 minute.'; err.hidden = false; return; }
  if (!Number.isFinite(pollMs) || pollMs < 250) { err.textContent = 'Poll interval must be at least 250 ms.'; err.hidden = false; return; }
  if (!Number.isFinite(port) || port < 1 || port > 65535) { err.textContent = 'Port must be between 1 and 65535.'; err.hidden = false; return; }
  // Server sanitises and re-broadcasts; the WS 'settings' message updates our UI.
  putSettings({ showGrid: grid, livenessMs: Math.round(livenessMin * 60000), pollMs, port, contextLimits });
  closeSettings();
}
document.getElementById('fit')!.onclick = () => renderer.fit();
liveBtn.onclick = () => { if (!active?.live) return; livePinned = true; playing = true; simT = active.eng.duration; updateChrome(); };
playBtn.onclick = () => { if (simT >= (active?.eng.duration || 0) - 1) simT = 0; playing = !playing; livePinned = false; updateChrome(); };
document.getElementById('back')!.onclick = () => step(-1);
document.getElementById('fwd')!.onclick = () => step(1);
document.getElementById('railToggle')!.onclick = () => rail.classList.toggle('closed');
document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach(btn => btn.onclick = () => { speed = Number(btn.dataset.speed); document.querySelectorAll('[data-speed]').forEach(b => b.classList.toggle('on', b === btn)); });
document.getElementById('import')!.onclick = () => fileInput.click();
document.getElementById('export')!.onclick = exportActive;
document.getElementById('settings')!.onclick = () => (settingsModal.hidden ? openSettings() : closeSettings());
fileInput.onchange = () => { const f = fileInput.files?.[0]; if (f) importFile(f); };

function step(dir: number) {
  if (!active) return;
  const evs = active.eng.evs; livePinned = false; playing = false;
  if (dir > 0) { const e = evs.find(e => e.t > simT + 1); simT = e ? e.t : active.eng.duration; }
  else { let prev = 0; for (const e of evs) { if (e.t < simT - 1) prev = e.t; else break; } simT = prev; }
  updateChrome();
}

function importFile(file: File) {
  file.text().then(text => {
    const obj = JSON.parse(text) as AwvSession;
    if (!Array.isArray(obj.agents) || !Array.isArray(obj.events)) throw new Error('JSON needs agents and events arrays');
    imported = { id: '__imported', awv: { name: obj.name || 'Imported replay', desc: obj.desc || file.name, agents: obj.agents, events: obj.events }, eng: parseSession(obj), live: false, lastIndex: obj.events.length, startMs: 0 };
    livePinned = false; playing = true; renderPicker(); setActive(imported);
  }).catch(err => alert(String(err.message || err)));
}

function exportActive() {
  if (!active) return;
  const blob = new Blob([JSON.stringify(active.awv, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${active.awv.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'claude-session'}.json`; a.click(); URL.revokeObjectURL(a.href);
}

window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !settingsModal.hidden) { e.preventDefault(); closeSettings(); return; }
  const tag = (e.target as HTMLElement)?.tagName || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (!settingsModal.hidden) return;
  if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'f') renderer.fit();
  else if (e.key === 'c') { showCompleted = !showCompleted; renderPanels(); }
});

window.addEventListener('dragover', e => { e.preventDefault(); });
window.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) importFile(f); });

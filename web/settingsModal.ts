import type { Settings } from '../shared/schema';
import { esc } from './html';
import { putSettings } from './transport';
import { PALETTES } from './render';

export class SettingsModal {
  private settings: Settings | null = null;
  private lastFocus: HTMLElement | null = null;

  constructor(private el: HTMLElement, private onOpenChange: (open: boolean) => void) {}

  get isOpen() { return !this.el.hidden; }

  setSettings(s: Settings) {
    this.settings = s;
    if (this.isOpen) this.render();
  }

  toggle() { this.isOpen ? this.close() : this.open(); }

  open() {
    this.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.render();
    this.el.hidden = false;
    this.el.classList.add('open');
    this.onOpenChange(true);
    this.el.querySelector<HTMLElement>('input,select,button')?.focus();
  }

  close() {
    this.el.hidden = true;
    this.el.classList.remove('open');
    this.onOpenChange(false);
    (this.lastFocus ?? document.getElementById('settings') as HTMLElement)?.focus();
    this.lastFocus = null;
  }

  /** Returns true if the event was consumed (modal is open). */
  handleKey(e: KeyboardEvent): boolean {
    if (this.el.hidden) return false;
    if (e.key === 'Tab') trapFocus(e, this.el);
    else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    return true;
  }

  private render() {
    const s = this.settings;
    if (!s) { this.el.innerHTML = `<div class="modal-card"><p class="task">Waiting for settings…</p></div>`; return; }
    const limits = JSON.stringify(s.contextLimits ?? {}, null, 0);
    const pricing = JSON.stringify(s.pricing ?? {}, null, 0);
    const opt = (v: string, cur: string, label = v) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`;
    this.el.innerHTML = `<div class="modal-card">
      <button class="close" id="settingsClose" aria-label="Close settings" title="Close">×</button>
      <h2>Settings</h2>
      <h3 class="set-head">Appearance</h3>
      <label class="set-row"><span>Theme</span><select id="setTheme" class="select compact">${(['system', 'light', 'dark'] as const).map(v => opt(v, s.theme || 'system')).join('')}</select></label>
      <label class="set-row"><span>Canvas</span><select id="setCanvasStyle" class="select compact">${opt('match', s.canvasStyle || 'match', 'match theme')}${opt('dark', s.canvasStyle || 'match', 'always dark')}</select></label>
      <label class="set-row"><span>Palette</span><select id="setPalette" class="select compact">${Object.keys(PALETTES).map(p => opt(p, s.palette)).join('')}</select></label>
      <h3 class="set-head">Privacy</h3>
      <label class="set-row"><input type="checkbox" id="setMask" ${s.maskProjects ? 'checked' : ''}><span>Mask project names <em>(display-only aliases for screen sharing)</em></span></label>
      <h3 class="set-head">Graph</h3>
      <label class="set-row"><input type="checkbox" id="setGrid" ${s.showGrid ? 'checked' : ''}><span>Show background grid</span></label>
      <label class="set-row"><input type="checkbox" id="setSubNames" ${s.showSubagentNames !== false ? 'checked' : ''}><span>Show sub-agent names <em>(hover always shows)</em></span></label>
      <label class="set-row"><input type="checkbox" id="setOrchName" ${s.showOrchestratorName !== false ? 'checked' : ''}><span>Show orchestrator name <em>(hover always shows)</em></span></label>
      <label class="set-row col"><span>Per-model context limits (JSON)</span><input type="text" id="setLimits" spellcheck="false" value="${esc(limits)}" placeholder="{&quot;claude-haiku-4-5&quot;: 200000}"></label>
      <h3 class="set-head">Ingestion</h3>
      ${(['claude', 'codex', 'opencode', 'copilot'] as const).map(p => `<label class="set-row"><input type="checkbox" class="setProv" data-src="${p}" ${s.providers?.[p] !== false ? 'checked' : ''}><span>Ingest ${p} sessions</span></label>`).join('')}
      <label class="set-row"><span>Liveness window (minutes)</span><input type="number" id="setLiveness" min="1" max="1440" step="1" value="${Math.round(s.livenessMs / 60000)}"></label>
      <label class="set-row"><span>Poll interval (ms)</span><input type="number" id="setPoll" min="250" max="60000" step="50" value="${s.pollMs}"></label>
      <h3 class="set-head">Server</h3>
      <label class="set-row"><span>Port <em>(restart to apply)</em></span><input type="number" id="setPort" min="1" max="65535" step="1" value="${s.port}"></label>
      <label class="set-row col"><span>Per-model pricing (JSON, USD per Mtok)</span><input type="text" id="setPricing" spellcheck="false" value="${esc(pricing)}" placeholder="{&quot;claude-opus-4-8&quot;: {&quot;input&quot;: 15, &quot;output&quot;: 75, &quot;cacheRead&quot;: 1.5, &quot;cacheCreation&quot;: 18.75}}"></label>
      <p class="set-err" id="setErr" role="alert" aria-live="polite" hidden></p>
      <div class="set-actions"><button class="ghost" id="settingsCancel">Cancel</button><button class="amber" id="settingsSave">Save</button></div>
    </div>`;
    this.el.querySelector<HTMLButtonElement>('#settingsClose')!.onclick = () => this.close();
    this.el.querySelector<HTMLButtonElement>('#settingsCancel')!.onclick = () => this.close();
    this.el.querySelector<HTMLButtonElement>('#settingsSave')!.onclick = () => this.save();
  }

  private save() {
    const el = this.el;
    const err = el.querySelector<HTMLElement>('#setErr')!;
    err.hidden = true;
    const themeSel = el.querySelector<HTMLSelectElement>('#setTheme')!.value as Settings['theme'];
    const canvasStyle = el.querySelector<HTMLSelectElement>('#setCanvasStyle')!.value as Settings['canvasStyle'];
    const palette = el.querySelector<HTMLSelectElement>('#setPalette')!.value;
    const mask = el.querySelector<HTMLInputElement>('#setMask')!.checked;
    const grid = el.querySelector<HTMLInputElement>('#setGrid')!.checked;
    const subNames = el.querySelector<HTMLInputElement>('#setSubNames')!.checked;
    const orchName = el.querySelector<HTMLInputElement>('#setOrchName')!.checked;
    const livenessMin = Number(el.querySelector<HTMLInputElement>('#setLiveness')!.value);
    const pollMs = Number(el.querySelector<HTMLInputElement>('#setPoll')!.value);
    const port = Number(el.querySelector<HTMLInputElement>('#setPort')!.value);
    const limitsRaw = el.querySelector<HTMLInputElement>('#setLimits')!.value.trim();
    const pricingRaw = el.querySelector<HTMLInputElement>('#setPricing')!.value.trim();
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
    let pricing: Record<string, unknown> = {};
    if (pricingRaw) {
      try {
        const parsed = JSON.parse(pricingRaw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be a JSON object');
        for (const [k, v] of Object.entries(parsed)) {
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`"${k}" must be an object`);
          for (const f of ['input', 'output', 'cacheRead', 'cacheCreation']) {
            const n = (v as Record<string, unknown>)[f];
            if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Error(`"${k}.${f}" must be a non-negative number`);
          }
          pricing[k] = v;
        }
      } catch (e) {
        err.textContent = `Pricing: ${(e as Error).message}`; err.hidden = false; return;
      }
    }
    if (!Number.isFinite(livenessMin) || livenessMin < 1) { err.textContent = 'Liveness must be at least 1 minute.'; err.hidden = false; return; }
    if (!Number.isFinite(pollMs) || pollMs < 250) { err.textContent = 'Poll interval must be at least 250 ms.'; err.hidden = false; return; }
    if (!Number.isFinite(port) || port < 1 || port > 65535) { err.textContent = 'Port must be between 1 and 65535.'; err.hidden = false; return; }
    const providers: Record<string, boolean> = {};
    el.querySelectorAll<HTMLInputElement>('.setProv').forEach(cb => { providers[cb.dataset.src!] = cb.checked; });
    // Server sanitises and re-broadcasts; the WS 'settings' message updates our UI.
    putSettings({ theme: themeSel, canvasStyle, palette, maskProjects: mask, showGrid: grid, showSubagentNames: subNames, showOrchestratorName: orchName, livenessMs: Math.round(livenessMin * 60000), pollMs, port, contextLimits, pricing, providers });
    this.close();
  }
}

function trapFocus(e: KeyboardEvent, root: HTMLElement) {
  const focusables = [...root.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.hasAttribute('disabled') && !el.hidden && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  if (!focusables.length) return;
  const first = focusables[0], last = focusables[focusables.length - 1], activeEl = document.activeElement;
  if (e.shiftKey && activeEl === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && activeEl === last) { e.preventDefault(); first.focus(); }
}

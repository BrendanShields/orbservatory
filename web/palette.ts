import type { SearchResponse, SessionStats, SessionSummary } from '../shared/schema';
import type { Engine } from './engine';
import { colorOf, statusAt } from './engine';
import { html, raw } from './html';
import { relTime, tierBadge } from './stats-viz';
import { cleanLabel, maskProject } from './privacy';

export interface PaletteCallbacks {
  onOpen(id: string): void;
  onNode(id: string): void;
  /** Server full-text search; resolve null on failure. */
  search(q: string): Promise<SearchResponse | null>;
  onOpenChange?(open: boolean): void;
}

export interface NodeCandidate { id: string; name: string; task?: string; status: string; color: string }
export interface CommandCandidate { id: string; label: string; disabled?: boolean; run?: () => void }

export type PaletteRow =
  | { kind: 'session'; sum: SessionSummary; stats?: SessionStats; snippet?: string; field?: string }
  | { kind: 'node'; node: NodeCandidate }
  | { kind: 'command'; cmd: CommandCandidate };

const MAX_SESSIONS = 12;
const MAX_NODES = 10;

export function paletteCandidates(
  query: string,
  sessions: Array<{ sum: SessionSummary; stats?: SessionStats }>,
  nodes: NodeCandidate[],
  commands: CommandCandidate[],
): PaletteRow[] {
  const needle = query.trim().toLowerCase();
  const base = sessions.slice().sort((a, b) => Number(b.sum.live) - Number(a.sum.live) || b.sum.lastActive - a.sum.lastActive);
  const meta = (needle
    ? base.filter(({ sum, stats }) => sum.title.toLowerCase().includes(needle)
      || (sum.projectName || sum.project).toLowerCase().includes(needle)
      || sum.id.toLowerCase().startsWith(needle)
      || (stats?.models.some((m) => m.toLowerCase().includes(needle)) ?? false)
      || Object.keys(stats?.skills || {}).some((k) => k.toLowerCase().includes(needle)))
    : base
  ).slice(0, MAX_SESSIONS);
  const rows: PaletteRow[] = meta.map(({ sum, stats }) => ({ kind: 'session', sum, stats }));
  if (needle) {
    let added = 0;
    for (const node of nodes) {
      if (added >= MAX_NODES) break;
      if (node.name.toLowerCase().includes(needle) || (node.task || '').toLowerCase().includes(needle)) {
        rows.push({ kind: 'node', node });
        added++;
      }
    }
  }
  for (const cmd of commands) {
    if (needle && !cmd.label.toLowerCase().includes(needle)) continue;
    rows.push({ kind: 'command', cmd });
  }
  return rows;
}

const SECTION_LABEL: Record<PaletteRow['kind'], string> = { session: 'Sessions', node: 'This session', command: 'Commands' };

/**
 * ⌘K hub: session switch, in-session agent jump, commands. Metadata matches
 * render instantly; server full-text matches merge in when the debounced
 * search returns.
 */
export class Palette {
  private el: HTMLElement;
  private input!: HTMLInputElement;
  private listEl!: HTMLElement;
  private open = false;
  private sel = 0;
  private results: PaletteRow[] = [];
  private searchTimer: number | null = null;
  private searchSeq = 0;
  private getData: () => { sessions: SessionSummary[]; stats: Map<string, SessionStats> } = () => ({ sessions: [], stats: new Map() });
  private getActive: () => { eng: Engine; selectedId: string | null } | null = () => null;
  private getCommands: () => CommandCandidate[] = () => [];

  constructor(parent: HTMLElement, private cb: PaletteCallbacks) {
    this.el = document.createElement('div');
    this.el.className = 'palette';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-label', 'Command palette');
    this.el.innerHTML = `<div class="palette-card">
      <input class="palette-q" type="text" placeholder="Search sessions, agents, commands…" aria-label="Search sessions, agents, commands" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="paletteList" aria-activedescendant="">
      <div id="paletteList" class="palette-list" role="listbox"></div>
      <div class="palette-hint">↑↓ navigate · ↵ open · esc close</div>
    </div>`;
    parent.append(this.el);
    this.input = this.el.querySelector('.palette-q')!;
    this.listEl = this.el.querySelector('.palette-list')!;
    this.input.oninput = () => this.query(this.input.value);
    this.input.onkeydown = (e) => this.onKey(e);
    this.el.onclick = (e) => { if (e.target === this.el) this.hide(); };
  }

  bindData(getData: () => { sessions: SessionSummary[]; stats: Map<string, SessionStats> }) {
    this.getData = getData;
  }

  bindActive(getActive: () => { eng: Engine; selectedId: string | null } | null) {
    this.getActive = getActive;
  }

  bindCommands(getCommands: () => CommandCandidate[]) {
    this.getCommands = getCommands;
  }

  get isOpen() { return this.open; }

  show() {
    this.open = false; // force re-show even if already open (refresh results)
    this.el.hidden = false;
    this.open = true;
    this.cb.onOpenChange?.(true);
    this.input.setAttribute('aria-expanded', 'true');
    this.input.value = '';
    this.query('');
    this.input.focus();
  }

  hide() {
    this.open = false;
    this.el.hidden = true;
    this.cb.onOpenChange?.(false);
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  toggle() { this.open ? this.hide() : this.show(); }

  private nodeCandidates(): NodeCandidate[] {
    const act = this.getActive();
    if (!act) return [];
    return [...act.eng.agents.values()].map((a) => ({
      id: a.id,
      name: a.parent ? cleanLabel(a.def.name) : maskProject(cleanLabel(a.def.name)),
      task: a.def.task,
      status: statusAt(a, act.eng.duration),
      color: colorOf(a),
    }));
  }

  private query(q: string) {
    const { sessions, stats } = this.getData();
    const paired = sessions.map((sum) => ({ sum, stats: stats.get(sum.id) }));
    this.results = paletteCandidates(q, paired, this.nodeCandidates(), this.getCommands());
    this.sel = this.firstSelectable(0, 1);
    this.renderList();

    if (this.searchTimer) clearTimeout(this.searchTimer);
    const needle = q.trim().toLowerCase();
    if (!needle) return;
    const seq = ++this.searchSeq;
    this.searchTimer = window.setTimeout(async () => {
      const res = await this.cb.search(needle).catch(() => null);
      if (seq !== this.searchSeq || !this.open || !res) return;
      const sessionRows = this.results.filter((r) => r.kind === 'session');
      const have = new Set(sessionRows.map((r) => r.sum.id));
      const byId = new Map(this.getData().sessions.map((s) => [s.id, s]));
      let insertAt = this.results.findIndex((r) => r.kind !== 'session');
      if (insertAt < 0) insertAt = this.results.length;
      let count = sessionRows.length;
      for (const m of res.matches) {
        if (count >= MAX_SESSIONS) break;
        const sum = byId.get(m.sessionId);
        if (!sum || have.has(sum.id)) {
          // Already listed via metadata — attach the snippet for context.
          const r = sessionRows.find((x) => x.sum.id === m.sessionId);
          if (r && !r.snippet) { r.snippet = m.snippet; r.field = m.field; }
          continue;
        }
        have.add(sum.id);
        this.results.splice(insertAt++, 0, { kind: 'session', sum, stats: this.getData().stats.get(sum.id), snippet: m.snippet, field: m.field });
        count++;
      }
      this.renderList();
    }, 200);
  }

  private selectable(i: number): boolean {
    const r = this.results[i];
    return !!r && !(r.kind === 'command' && r.cmd.disabled);
  }

  private firstSelectable(from: number, dir: 1 | -1): number {
    for (let i = from; i >= 0 && i < this.results.length; i += dir) if (this.selectable(i)) return i;
    return -1;
  }

  private renderList() {
    if (!this.results.length) {
      this.listEl.innerHTML = `<div class="palette-none">No matches</div>`;
      this.input.removeAttribute('aria-activedescendant');
      return;
    }
    let lastKind: string | null = null;
    const parts = this.results.map((r, i) => {
      const head = r.kind !== lastKind ? html`<div class="palette-sect" role="presentation">${SECTION_LABEL[r.kind]}</div>` : html``;
      lastKind = r.kind;
      return html`${head}${this.rowHtml(r, i)}`;
    });
    this.listEl.innerHTML = html`${parts}`.s;
    if (this.sel >= 0) this.input.setAttribute('aria-activedescendant', `paletteOpt-${this.sel}`);
    else this.input.removeAttribute('aria-activedescendant');
    this.listEl.querySelectorAll<HTMLElement>('.palette-row').forEach((row) => {
      const i = Number(row.dataset.i);
      row.onclick = () => this.openSel(i);
      row.onmousemove = () => {
        if (i !== this.sel && this.selectable(i)) { this.sel = i; this.renderList(); }
      };
    });
    this.listEl.querySelector('.palette-row.sel')?.scrollIntoView({ block: 'nearest' });
  }

  private rowHtml(r: PaletteRow, i: number) {
    const sel = i === this.sel;
    const base = `id="paletteOpt-${i}" role="option" aria-selected="${sel}" data-i="${i}"`;
    if (r.kind === 'session') {
      return html`<div ${raw(base)} class="palette-row${sel ? ' sel' : ''}">
        <span class="p-dot${r.sum.live ? ' live' : ''}"></span>
        <span class="p-main"><b>${r.sum.title || r.sum.id.slice(0, 8)}</b><span>${maskProject(r.sum.projectName || r.sum.project)} · ${relTime(r.sum.lastActive)}</span>${r.snippet ? html`<em class="p-snip">${r.field || ''}: ${cleanLabel(r.snippet)}</em>` : ''}</span>
        ${tierBadge(r.stats)}
      </div>`;
    }
    if (r.kind === 'node') {
      return html`<div ${raw(base)} class="palette-row${sel ? ' sel' : ''}">
        <span class="p-dot" style="background:${r.node.color}"></span>
        <span class="p-main"><b>${r.node.name}</b><span>${r.node.status}</span></span>
      </div>`;
    }
    return html`<div ${raw(base)} class="palette-row${sel ? ' sel' : ''}${r.cmd.disabled ? ' disabled' : ''}" aria-disabled="${!!r.cmd.disabled}">
      <span class="p-cmd">⌘</span>
      <span class="p-main"><b>${r.cmd.label}</b></span>
    </div>`;
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); const n = this.firstSelectable(this.sel + 1, 1); if (n >= 0) { this.sel = n; this.renderList(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); const n = this.firstSelectable(this.sel - 1, -1); if (n >= 0) { this.sel = n; this.renderList(); } }
    else if (e.key === 'Enter') { e.preventDefault(); this.openSel(this.sel); }
    else if (e.key === 'Escape') { e.preventDefault(); this.hide(); }
  }

  private openSel(i: number) {
    const r = this.results[i];
    if (!r || !this.selectable(i)) return;
    this.hide();
    if (r.kind === 'session') this.cb.onOpen(r.sum.id);
    else if (r.kind === 'node') this.cb.onNode(r.node.id);
    else r.cmd.run?.();
  }
}

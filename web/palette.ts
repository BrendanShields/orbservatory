import type { SearchResponse, SessionStats, SessionSummary } from '../shared/schema';
import { esc } from './panels';
import { relTime, tierBadge } from './stats-viz';

export interface PaletteCallbacks {
  onOpen(id: string): void;
  /** Server full-text search; resolve null on failure. */
  search(q: string): Promise<SearchResponse | null>;
}

interface Candidate {
  sum: SessionSummary;
  stats?: SessionStats;
  snippet?: string;
  field?: string;
}

const MAX_RESULTS = 12;

/**
 * ⌘K quick-switch. Metadata matches render instantly; server full-text
 * matches merge in (with snippets) when the debounced search returns.
 */
export class Palette {
  private el: HTMLElement;
  private input!: HTMLInputElement;
  private listEl!: HTMLElement;
  private open = false;
  private sel = 0;
  private results: Candidate[] = [];
  private searchTimer: number | null = null;
  private searchSeq = 0;
  private getData: () => { sessions: SessionSummary[]; stats: Map<string, SessionStats> } = () => ({ sessions: [], stats: new Map() });

  constructor(parent: HTMLElement, private cb: PaletteCallbacks) {
    this.el = document.createElement('div');
    this.el.className = 'palette';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-label', 'Quick session switch');
    this.el.innerHTML = `<div class="palette-card">
      <input class="palette-q" type="text" placeholder="Jump to session… (type to search metadata + full text)" aria-label="Search sessions" autocomplete="off" spellcheck="false">
      <div class="palette-list" role="listbox"></div>
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

  get isOpen() { return this.open; }

  show() {
    this.open = false; // force re-show even if already open (refresh results)
    this.el.hidden = false;
    this.open = true;
    this.input.value = '';
    this.query('');
    this.input.focus();
  }

  hide() {
    this.open = false;
    this.el.hidden = true;
  }

  toggle() { this.open ? this.hide() : this.show(); }

  private query(q: string) {
    const { sessions, stats } = this.getData();
    const needle = q.trim().toLowerCase();
    const base = sessions.slice().sort((a, b) => Number(b.live) - Number(a.live) || b.lastActive - a.lastActive);
    const meta = (needle
      ? base.filter((s) => s.title.toLowerCase().includes(needle)
        || (s.projectName || s.project).toLowerCase().includes(needle)
        || s.id.toLowerCase().startsWith(needle)
        || (stats.get(s.id)?.models.some((m) => m.toLowerCase().includes(needle)) ?? false)
        || Object.keys(stats.get(s.id)?.skills || {}).some((k) => k.toLowerCase().includes(needle)))
      : base
    ).slice(0, MAX_RESULTS);
    this.results = meta.map((sum) => ({ sum, stats: stats.get(sum.id) }));
    this.sel = 0;
    this.renderList();

    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (!needle) return;
    const seq = ++this.searchSeq;
    this.searchTimer = window.setTimeout(async () => {
      const res = await this.cb.search(needle).catch(() => null);
      if (seq !== this.searchSeq || !this.open || !res) return;
      const have = new Set(this.results.map((r) => r.sum.id));
      const byId = new Map(this.getData().sessions.map((s) => [s.id, s]));
      for (const m of res.matches) {
        if (this.results.length >= MAX_RESULTS) break;
        const sum = byId.get(m.sessionId);
        if (!sum || have.has(sum.id)) {
          // Already listed via metadata — attach the snippet for context.
          const r = this.results.find((x) => x.sum.id === m.sessionId);
          if (r && !r.snippet) { r.snippet = m.snippet; r.field = m.field; }
          continue;
        }
        have.add(sum.id);
        this.results.push({ sum, stats: this.getData().stats.get(sum.id), snippet: m.snippet, field: m.field });
      }
      this.renderList();
    }, 200);
  }

  private renderList() {
    if (!this.results.length) {
      this.listEl.innerHTML = `<div class="palette-none">No matching sessions</div>`;
      return;
    }
    this.listEl.innerHTML = this.results.map((r, i) => `
      <div class="palette-row${i === this.sel ? ' sel' : ''}" role="option" aria-selected="${i === this.sel}" data-i="${i}">
        <span class="p-dot${r.sum.live ? ' live' : ''}"></span>
        <span class="p-main"><b>${esc(r.sum.title || r.sum.id.slice(0, 8))}</b><span>${esc(r.sum.projectName || r.sum.project)} · ${relTime(r.sum.lastActive)}</span>${r.snippet ? `<em class="p-snip">${esc(r.field || '')}: ${esc(r.snippet)}</em>` : ''}</span>
        ${tierBadge(r.stats)}
      </div>`).join('');
    this.listEl.querySelectorAll<HTMLElement>('.palette-row').forEach((row) => {
      row.onclick = () => this.openSel(Number(row.dataset.i));
      row.onmousemove = () => {
        const i = Number(row.dataset.i);
        if (i !== this.sel) { this.sel = i; this.renderList(); }
      };
    });
    this.listEl.querySelector('.palette-row.sel')?.scrollIntoView({ block: 'nearest' });
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); this.sel = Math.min(this.results.length - 1, this.sel + 1); this.renderList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.sel = Math.max(0, this.sel - 1); this.renderList(); }
    else if (e.key === 'Enter') { e.preventDefault(); this.openSel(this.sel); }
    else if (e.key === 'Escape') { e.preventDefault(); this.hide(); }
  }

  private openSel(i: number) {
    const r = this.results[i];
    if (!r) return;
    this.hide();
    this.cb.onOpen(r.sum.id);
  }
}

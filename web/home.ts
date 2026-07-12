import type { SearchResponse, SessionStats, SessionSummary } from '../shared/schema';
import { html, raw, type Html } from './html';
import { fmtT } from './engine';
import {
  EMPTY_FILTER, type HomeFilter, type HomeRow, type SortKey,
  aggregate, buildRows, facetOptions, filterRows, sortRows,
} from './homeModel';
import { cacheSplitBar, chipList, fmtDur, fmtTokens, fmtUsd, relTime, tierBadge, tile } from './stats-viz';
import { maskProject } from './privacy';

export interface HomeCallbacks {
  onOpen(id: string): void;
  onImport(): void;
  onSettings(): void;
  onCycleTheme(): void;
  /** Server full-text search; resolve null on failure (treated as "no extra ids"). */
  search(q: string): Promise<SearchResponse | null>;
}

interface HomeData {
  sessions: SessionSummary[];
  stats: Map<string, SessionStats>;
  pricingConfigured: boolean;
  connected: boolean;
}

const SORT_LABELS: Record<SortKey, string> = {
  recent: 'Recent', tokens: 'Tokens', cost: 'Est. $', duration: 'Duration',
  tools: 'Tool calls', subagents: 'Subagents', tier: 'Tier', title: 'Title',
};

const SKEL = raw('<span class="skel">…</span>');
const FACETS = ['project', 'source', 'model', 'tier', 'skill', 'tool'] as const;
type FacetKey = typeof FACETS[number];
const PAGE_SIZE = 25;

interface ColDef { label: string; cls?: string; detail?: boolean; cell(r: HomeRow): Html | string }

export class HomeView {
  private filter: HomeFilter = { ...EMPTY_FILTER };
  private sort: SortKey = 'recent';
  private desc = true;
  private details = localStorage.getItem('homeDetails') === '1';
  private insightsOpen = localStorage.getItem('homeInsights') === '1';
  private data: HomeData = { sessions: [], stats: new Map(), pricingConfigured: false, connected: false };
  private searchTimer: number | null = null;
  private searchSeq = 0;
  private searching = false;
  private searchPartial = false;
  private filterOpen = false;
  private page = 0;
  private els: {
    q: HTMLInputElement; live: HTMLButtonElement; filterToggle: HTMLButtonElement; sort: HTMLSelectElement; dir: HTMLButtonElement;
    detailsBtn: HTMLButtonElement; chips: HTMLElement; facets: HTMLElement; liveStrip: HTMLElement;
    aggWrap: HTMLElement; agg: HTMLElement; list: HTMLElement; meta: HTMLElement; statline: HTMLElement; insights: HTMLButtonElement;
  };

  constructor(private root: HTMLElement, private cb: HomeCallbacks) {
    root.innerHTML = `
      <div class="home" role="main">
        <div class="home-head">
          <div class="brand"><i></i><div><b>ORBSERVATORY</b></div></div>
          <input id="homeQ" class="home-q" type="search" placeholder="⌕ Search sessions… (title, project, skills, tools, full text) (/)" aria-label="Search sessions" autocomplete="off" spellcheck="false">
          <button id="homeImportBtn" class="ghost" title="Import an exported AWV session">Import session</button>
          <div class="icon-cluster">
            <button id="homeTheme" class="cnav-btn" aria-label="Cycle theme (system → light → dark)" title="Theme">◐</button>
            <button id="homeSettings" class="cnav-btn" aria-label="Settings" title="Settings">⚙</button>
          </div>
        </div>
        <div class="insights-zone">
          <div class="home-stats">
            <span id="homeStatline" class="statline"></span>
            <button id="homeInsights" class="ghost insights-toggle" aria-expanded="false">Insights <i class="ins-chev">▾</i></button>
            <div id="homeLiveStrip" class="live-strip" role="list" aria-label="Live sessions" hidden></div>
          </div>
          <div id="homeAgg" class="home-agg-wrap"><div id="homeAggInner" class="home-agg" aria-label="Aggregate stats for the filtered set"></div></div>
        </div>
        <div class="home-controls">
          <button id="homeFilterToggle" class="ghost filter-toggle" aria-expanded="false" aria-controls="homeFacets">Filters</button>
          <div id="homeChips" class="facet-chips"></div>
          <button id="homeLive" class="chip-toggle" aria-pressed="false" title="Only live sessions">● live only</button>
          <span class="spacer"></span>
          <label class="sort-wrap">sort <select id="homeSort" class="select compact" aria-label="Sort by">${(Object.keys(SORT_LABELS) as SortKey[]).map((k) => `<option value="${k}">${SORT_LABELS[k]}</option>`).join('')}</select></label>
          <button id="homeDir" class="ghost dir" aria-label="Toggle sort direction" title="Sort direction">↓</button>
          <button id="homeDetails" class="chip-toggle" aria-pressed="false" title="Show tier, subagents, tools, cost, skills and model columns">details</button>
        </div>
        <div id="homeFacets" class="home-facets" role="group" aria-label="Filters" hidden></div>
        <div id="homeMeta" class="home-meta" aria-live="polite"></div>
        <div id="homeList" class="home-list"></div>
      </div>`;
    this.els = {
      q: root.querySelector('#homeQ')!,
      live: root.querySelector('#homeLive')!,
      filterToggle: root.querySelector('#homeFilterToggle')!,
      sort: root.querySelector('#homeSort')!,
      dir: root.querySelector('#homeDir')!,
      detailsBtn: root.querySelector('#homeDetails')!,
      chips: root.querySelector('#homeChips')!,
      facets: root.querySelector('#homeFacets')!,
      liveStrip: root.querySelector('#homeLiveStrip')!,
      aggWrap: root.querySelector('#homeAgg')!,
      agg: root.querySelector('#homeAggInner')!,
      list: root.querySelector('#homeList')!,
      meta: root.querySelector('#homeMeta')!,
      statline: root.querySelector('#homeStatline')!,
      insights: root.querySelector('#homeInsights')!,
    };
    this.els.q.oninput = () => this.onQuery(this.els.q.value);
    this.els.live.onclick = () => { this.filter.liveOnly = !this.filter.liveOnly; this.page = 0; this.render(); };
    this.els.filterToggle.onclick = () => { this.filterOpen = !this.filterOpen; this.render(); };
    this.els.sort.onchange = () => { this.sort = this.els.sort.value as SortKey; this.page = 0; this.render(); };
    this.els.dir.onclick = () => { this.desc = !this.desc; this.page = 0; this.render(); };
    this.els.detailsBtn.onclick = () => {
      this.details = !this.details;
      localStorage.setItem('homeDetails', this.details ? '1' : '0');
      this.render();
    };
    this.els.insights.onclick = () => {
      this.insightsOpen = !this.insightsOpen;
      localStorage.setItem('homeInsights', this.insightsOpen ? '1' : '0');
      if (this.insightsOpen) {
        this.els.aggWrap.classList.add('opening');
        window.setTimeout(() => this.els.aggWrap.classList.remove('opening'), 500);
      }
      this.render();
    };
    (root.querySelector('#homeImportBtn') as HTMLButtonElement).onclick = () => cb.onImport();
    (root.querySelector('#homeTheme') as HTMLButtonElement).onclick = () => cb.onCycleTheme();
    (root.querySelector('#homeSettings') as HTMLButtonElement).onclick = () => cb.onSettings();
  }

  focusSearch() { this.els.q.focus(); this.els.q.select(); }

  /** Skip innerHTML (and handler rebinding) when a section's markup is unchanged —
      live broadcasts re-render every ~200ms and naive replacement replays entry
      animations, closes open <select> dropdowns, and drops hover states. */
  private lastHtml = new WeakMap<HTMLElement, string>();
  private setHtml(el: HTMLElement, s: string): boolean {
    if (this.lastHtml.get(el) === s) return false;
    this.lastHtml.set(el, s);
    el.innerHTML = s;
    return true;
  }

  update(sessions: SessionSummary[], stats: Map<string, SessionStats>, opts: { pricingConfigured: boolean; connected: boolean }) {
    this.data = { sessions, stats, pricingConfigured: opts.pricingConfigured, connected: opts.connected };
    this.render();
  }

  private onQuery(q: string) {
    this.filter.text = q;
    this.filter.textIds = null;
    this.searchPartial = false;
    this.page = 0;
    this.render(); // metadata matches are instant
    if (this.searchTimer) clearTimeout(this.searchTimer);
    const trimmed = q.trim();
    if (!trimmed) { this.searching = false; return; }
    this.searching = true;
    const seq = ++this.searchSeq;
    this.searchTimer = window.setTimeout(async () => {
      const res = await this.cb.search(trimmed).catch(() => null);
      if (seq !== this.searchSeq) return; // stale
      this.searching = false;
      this.searchPartial = !!res?.partial;
      this.filter.textIds = res ? new Set(res.matches.map((m) => m.sessionId)) : null;
      this.render();
    }, 250);
  }

  private setFacet<K extends keyof HomeFilter>(k: K, v: HomeFilter[K]) {
    this.filter[k] = v;
    this.page = 0;
    this.render();
  }

  private render() {
    const rows = buildRows(this.data.sessions, this.data.stats);
    const visible = sortRows(filterRows(rows, this.filter), this.sort, this.desc);
    this.renderFacets(rows);
    this.renderFacetChips();
    this.renderLiveStrip(rows);
    this.renderStats(visible);
    this.renderMeta(rows.length, visible.length);
    this.renderList(visible);
    this.els.live.classList.toggle('on', this.filter.liveOnly);
    this.els.live.setAttribute('aria-pressed', String(this.filter.liveOnly));
    const activeFilters = this.activeFilterCount();
    this.els.filterToggle.classList.toggle('on', this.filterOpen || activeFilters > 0);
    this.els.filterToggle.textContent = activeFilters ? `Filters · ${activeFilters}` : 'Filters';
    this.els.filterToggle.setAttribute('aria-expanded', String(this.filterOpen));
    this.els.facets.hidden = !this.filterOpen;
    this.els.detailsBtn.classList.toggle('on', this.details);
    this.els.detailsBtn.setAttribute('aria-pressed', String(this.details));
    this.els.dir.textContent = this.desc ? '↓' : '↑';
    this.els.sort.value = this.sort;
    this.els.insights.setAttribute('aria-expanded', String(this.insightsOpen));
    this.els.aggWrap.classList.toggle('open', this.insightsOpen);
  }

  private activeFilterCount(): number {
    return FACETS.reduce((n, k) => n + Number(this.filter[k] !== 'all'), 0);
  }

  private renderFacets(rows: HomeRow[]) {
    const f = facetOptions(rows);
    const sel = (id: FacetKey, label: string, cur: string, opts: string[]) => {
      const seen = opts.includes(cur) || cur === 'all';
      const show = (o: string) => id === 'project' ? maskProject(o) : o;
      return html`<select class="select compact facet" data-facet="${id}" aria-label="Filter by ${label}">
        <option value="all">${label}: all</option>
        ${seen ? '' : html`<option value="${cur}" selected>${show(cur)}</option>`}
        ${opts.map((o) => html`<option value="${o}"${o === cur ? raw(' selected') : ''}>${show(o)}</option>`)}
      </select>`;
    };
    const changed = this.setHtml(this.els.facets, html`${[
      sel('project', 'project', this.filter.project, f.projects),
      sel('source', 'source', this.filter.source, ['claude', 'codex', 'opencode', 'copilot', 'pi']),
      sel('model', 'model', this.filter.model, f.models),
      sel('tier', 'tier', this.filter.tier, ['simple', 'moderate', 'complex']),
      sel('skill', 'skill', this.filter.skill, f.skills),
      sel('tool', 'tool', this.filter.tool, f.tools),
    ]}`.s);
    if (!changed) return;
    this.els.facets.querySelectorAll<HTMLSelectElement>('select.facet').forEach((s) => {
      s.onchange = () => {
        const k = s.dataset.facet as FacetKey;
        this.setFacet(k, s.value as HomeFilter[FacetKey] & string);
      };
    });
  }

  private renderFacetChips() {
    const active = FACETS.filter((k) => this.filter[k] !== 'all');
    if (!this.setHtml(this.els.chips, html`${active.map((k) => {
      const v = this.filter[k] as string;
      return html`<button class="f-chip" data-facet="${k}" title="Remove ${k} filter">${k === 'project' ? maskProject(v) : v} ✕</button>`;
    })}`.s)) return;
    this.els.chips.querySelectorAll<HTMLButtonElement>('.f-chip').forEach((b) => {
      b.onclick = () => this.setFacet(b.dataset.facet as FacetKey, 'all');
    });
  }

  private renderLiveStrip(rows: HomeRow[]) {
    const live = rows.filter((r) => r.sum.live);
    this.els.liveStrip.hidden = !live.length;
    if (!live.length) { this.setHtml(this.els.liveStrip, ''); return; }
    if (!this.setHtml(this.els.liveStrip, html`${live.map(({ sum, stats }) => html`
      <button class="live-card" role="listitem" data-id="${sum.id}">
        <span class="lc-main"><b>${maskProject(sum.projectName || sum.project)}</b><span>${sum.title || sum.id.slice(0, 8)}</span></span>
        <span class="lc-side">${stats ? fmtTokens(stats.tokens.total) : '…'}<em>${sum.source}</em></span>
        <span class="lc-dot"></span>
      </button>`)}`.s)) return;
    this.els.liveStrip.querySelectorAll<HTMLButtonElement>('.live-card').forEach((c) => {
      c.onclick = () => this.cb.onOpen(c.dataset.id!);
    });
  }

  private renderStats(visible: HomeRow[]) {
    const a = aggregate(visible);
    const t = a.tokens;
    const bits = [
      `${a.count} sessions`,
      `${fmtTokens(t.total)} tokens`,
      `${fmtTokens(a.toolCalls)} tool calls`,
    ];
    if (this.data.pricingConfigured && a.costUsd > 0) bits.push(fmtUsd(a.costUsd));
    this.els.statline.textContent = bits.join(' · ');
    const tiles = [
      tile('sessions', String(a.count), { sub: `${a.liveCount} live · ${a.statsReady}/${a.count} analysed` }),
      tile('tokens', fmtTokens(t.total), {
        sub: t.total ? html`${cacheSplitBar(t)}<span class="split-key">in ${fmtTokens(t.input)} · out ${fmtTokens(t.output)} · cache ${fmtTokens(t.cacheRead + t.cacheCreation)}</span>` : '',
      }),
      this.data.pricingConfigured
        ? tile('est. cost', fmtUsd(a.costUsd), { sub: a.pricedCount < a.statsReady ? `${a.pricedCount}/${a.statsReady} priced` : undefined })
        : tile('est. cost', '—', { sub: 'add pricing in ⚙ settings' }),
      tile('tool calls', fmtTokens(a.toolCalls)),
      tile('subagents', String(a.subagents), { sub: a.compactions ? `${a.compactions} compactions` : undefined }),
      tile('tier mix', `${a.tiers.simple}·${a.tiers.moderate}·${a.tiers.complex}`, { sub: 'simple · moderate · complex' }),
    ];
    const chips = html`
      <div class="chip-group"><span class="chip-label">top skills</span>${chipList(a.topSkills)}</div>
      <div class="chip-group"><span class="chip-label">top tools</span>${chipList(a.topTools)}</div>
      <div class="chip-group"><span class="chip-label">models</span>${chipList(a.models, fmtTokens)}</div>`;
    this.setHtml(this.els.agg, html`<div class="tiles">${tiles}</div><div class="chip-rows">${chips}</div>`.s);
  }

  private renderMeta(total: number, shown: number) {
    const bits: string[] = [];
    if (shown !== total) bits.push(`${shown} of ${total} sessions`);
    if (this.searching) bits.push('searching full text…');
    else if (this.searchPartial) bits.push('search still scanning — partial results');
    this.els.meta.textContent = bits.join(' · ');
    this.els.meta.hidden = !bits.length;
  }

  private cols(usd: boolean): ColDef[] {
    const sk = (v: string | Html | false | undefined): string | Html => v || SKEL;
    return [
      { label: 'session', cls: 't-title', cell: ({ sum }) => {
        const title = sum.title || sum.id.slice(0, 8);
        return html`<b>${title}</b><span>${maskProject(sum.projectName || sum.project)} · ${sum.source}</span>`;
      } },
      { label: 'when', cls: 't-when', cell: ({ sum, stats }) => html`<span title="${new Date(stats?.lastActive || sum.lastActive).toLocaleString()}">${relTime(stats?.lastActive || sum.lastActive)}</span>` },
      { label: 'dur', cls: 't-dur', cell: ({ stats }) => sk(stats && (stats.durationMs >= 3_600_000 ? fmtDur(stats.durationMs) : fmtT(stats.durationMs))) },
      { label: 'tier', cls: 't-tier', detail: true, cell: ({ stats }) => tierBadge(stats) },
      { label: 'sub', cls: 'num t-sub', detail: true, cell: ({ stats }) => sk(stats && String(stats.subagentCount)) },
      { label: 'tools', cls: 'num t-tools', detail: true, cell: ({ stats }) => sk(stats && String(stats.toolCalls)) },
      { label: 'tokens', cls: 'num t-tok', cell: ({ stats }) => sk(stats && html`${fmtTokens(stats.tokens.total)}${cacheSplitBar(stats.tokens)}`) },
      ...(usd ? [{ label: '$', cls: 'num t-cost', detail: true, cell: ({ stats }: HomeRow) => sk(stats && (stats.costUsd != null ? fmtUsd(stats.costUsd) : '—')) }] : []),
      { label: 'skills', cls: 't-skills', detail: true, cell: ({ stats }) => {
        const skills = stats ? Object.entries(stats.skills).sort((a, b) => b[1] - a[1]).slice(0, 3) : [];
        return skills.length ? html`${skills.map(([s]) => html`<span class="chip">${s}</span>`)}` : stats ? raw('<span class="chip none">—</span>') : SKEL;
      } },
      { label: 'model', cls: 't-model', detail: true, cell: ({ stats }) => stats?.models.length
        ? html`${shortModel(stats.models[stats.models.length - 1])}${stats.models.length > 1 ? ` +${stats.models.length - 1}` : ''}`
        : SKEL },
      { label: 'status', cls: 't-status', cell: ({ sum, stats }) => html`${raw(sum.live ? '<span class="st live">● live</span>' : '<span class="st done">done</span>')}${stats?.partial ? raw('<span class="st part" title="Transcript could not be fully parsed">incomplete</span>') : ''}` },
    ];
  }

  private renderList(visible: HomeRow[]) {
    if (!this.data.sessions.length) {
      if (!this.setHtml(this.els.list, html`<div class="home-empty"><h2>${this.data.connected ? 'No sessions yet' : 'Connecting…'}</h2><p>${this.data.connected ? 'Start a coding agent (Claude Code, Codex, opencode, Copilot, pi) in any project — sessions appear here automatically. Or import a replay.' : 'Reconnecting to the local transcript stream…'}</p>${this.data.connected ? raw('<button id="homeImportEmpty" class="ghost">Import a replay</button>') : ''}</div>`.s)) return;
      const b = this.els.list.querySelector<HTMLButtonElement>('#homeImportEmpty');
      if (b) b.onclick = () => this.cb.onImport();
      return;
    }
    if (!visible.length) {
      this.setHtml(this.els.list, html`<div class="home-empty"><h2>No matches</h2><p>No sessions match the current filters${this.filter.text.trim() ? ' or search' : ''}. Clear a filter or broaden the query.</p></div>`.s);
      return;
    }
    const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
    if (this.page >= pages) this.page = pages - 1;
    const start = this.page * PAGE_SIZE;
    const slice = visible.slice(start, start + PAGE_SIZE);
    const cols = this.cols(this.data.pricingConfigured).filter((c) => this.details || !c.detail);
    const head = html`<tr>${cols.map((c) => html`<th class="${c.cls || ''}">${c.label}</th>`)}</tr>`;
    const body = slice.map((r) => html`<tr class="srow" data-id="${r.sum.id}" tabindex="0" role="link" aria-label="Open session ${r.sum.title || r.sum.id.slice(0, 8)}">
      ${cols.map((c) => html`<td class="${c.cls || ''}">${c.cell(r)}</td>`)}
    </tr>`);
    const pager = visible.length > PAGE_SIZE ? html`<div class="pager">
      <button id="pgPrev" class="ghost" aria-label="Previous page"${this.page === 0 ? raw(' disabled') : ''}>←</button>
      <span>${start + 1}–${Math.min(start + PAGE_SIZE, visible.length)} of ${visible.length}</span>
      <button id="pgNext" class="ghost" aria-label="Next page"${this.page >= pages - 1 ? raw(' disabled') : ''}>→</button>
    </div>` : html``;
    if (!this.setHtml(this.els.list, html`<table class="home-table">${head}${body}</table>${pager}`.s)) return;
    this.els.list.querySelectorAll<HTMLTableRowElement>('tr.srow').forEach((tr) => {
      const open = () => this.cb.onOpen(tr.dataset.id!);
      tr.onclick = open;
      tr.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    });
    const turn = (d: number) => { this.page += d; this.render(); this.root.scrollTo({ top: 0 }); };
    const prev = this.els.list.querySelector<HTMLButtonElement>('#pgPrev');
    const next = this.els.list.querySelector<HTMLButtonElement>('#pgNext');
    if (prev) prev.onclick = () => turn(-1);
    if (next) next.onclick = () => turn(1);
  }
}

function shortModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

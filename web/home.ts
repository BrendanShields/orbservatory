import type { SearchResponse, SessionStats, SessionSummary } from '../shared/schema';
import { html, raw, type Html } from './html';
import { fmtT } from './engine';
import {
  EMPTY_FILTER, type HomeFilter, type HomeRow, type SortKey,
  aggregate, buildRows, facetOptions, filterRows, sortRows,
} from './homeModel';
import { cacheSplitBar, chipList, fmtDur, fmtTokens, fmtUsd, relTime, tierBadge, tile } from './stats-viz';

const compactFiltersMq = window.matchMedia('(max-width: 760px)');

export interface HomeCallbacks {
  onOpen(id: string): void;
  onWatchLive(): void;
  onImport(): void;
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

export class HomeView {
  private filter: HomeFilter = { ...EMPTY_FILTER };
  private sort: SortKey = 'recent';
  private desc = true;
  private data: HomeData = { sessions: [], stats: new Map(), pricingConfigured: false, connected: false };
  private searchTimer: number | null = null;
  private searchSeq = 0;
  private searching = false;
  private searchPartial = false;
  private filterOpen = false;
  private els: {
    q: HTMLInputElement; live: HTMLButtonElement; filterToggle: HTMLButtonElement; sort: HTMLSelectElement; dir: HTMLButtonElement;
    facets: HTMLElement; agg: HTMLElement; list: HTMLElement; meta: HTMLElement;
  };

  constructor(private root: HTMLElement, private cb: HomeCallbacks) {
    root.innerHTML = `
      <div class="home" role="main">
        <div class="home-head">
          <input id="homeQ" class="home-q" type="search" placeholder="Search sessions… (title, project, skills, tools, full text)" aria-label="Search sessions" autocomplete="off" spellcheck="false">
          <button id="homeFilterToggle" class="ghost filter-toggle" aria-expanded="false" aria-controls="homeFacets">Filters</button>
          <div id="homeFacets" class="home-facets" role="group" aria-label="Filters"></div>
          <button id="homeLive" class="chip-toggle" aria-pressed="false" title="Only live sessions">● live only</button>
          <span class="spacer"></span>
          <label class="sort-wrap">sort <select id="homeSort" class="select compact" aria-label="Sort by">${(Object.keys(SORT_LABELS) as SortKey[]).map((k) => `<option value="${k}">${SORT_LABELS[k]}</option>`).join('')}</select></label>
          <button id="homeDir" class="ghost dir" aria-label="Toggle sort direction" title="Sort direction">↓</button>
          <button id="homeWatch" class="amber" title="Open the merged live graph">Watch all live</button>
        </div>
        <div id="homeAgg" class="home-agg" aria-label="Aggregate stats for the filtered set"></div>
        <div id="homeMeta" class="home-meta" aria-live="polite"></div>
        <div id="homeList" class="home-list"></div>
      </div>`;
    this.els = {
      q: root.querySelector('#homeQ')!,
      live: root.querySelector('#homeLive')!,
      filterToggle: root.querySelector('#homeFilterToggle')!,
      sort: root.querySelector('#homeSort')!,
      dir: root.querySelector('#homeDir')!,
      facets: root.querySelector('#homeFacets')!,
      agg: root.querySelector('#homeAgg')!,
      list: root.querySelector('#homeList')!,
      meta: root.querySelector('#homeMeta')!,
    };
    this.els.q.oninput = () => this.onQuery(this.els.q.value);
    this.els.live.onclick = () => { this.filter.liveOnly = !this.filter.liveOnly; this.render(); };
    this.els.filterToggle.onclick = () => { this.filterOpen = !this.filterOpen; this.render(); };
    compactFiltersMq.addEventListener('change', () => this.render());
    this.els.sort.onchange = () => { this.sort = this.els.sort.value as SortKey; this.render(); };
    this.els.dir.onclick = () => { this.desc = !this.desc; this.render(); };
    (root.querySelector('#homeWatch') as HTMLButtonElement).onclick = () => cb.onWatchLive();
  }

  focusSearch() { this.els.q.focus(); this.els.q.select(); }

  update(sessions: SessionSummary[], stats: Map<string, SessionStats>, opts: { pricingConfigured: boolean; connected: boolean }) {
    this.data = { sessions, stats, pricingConfigured: opts.pricingConfigured, connected: opts.connected };
    this.render();
  }

  private onQuery(q: string) {
    this.filter.text = q;
    this.filter.textIds = null;
    this.searchPartial = false;
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
    this.render();
  }

  private render() {
    const rows = buildRows(this.data.sessions, this.data.stats);
    const visible = sortRows(filterRows(rows, this.filter), this.sort, this.desc);
    this.renderFacets(rows);
    this.renderAgg(visible);
    this.renderMeta(rows.length, visible.length);
    this.renderList(visible);
    this.els.live.classList.toggle('on', this.filter.liveOnly);
    this.els.live.setAttribute('aria-pressed', String(this.filter.liveOnly));
    const activeFilters = this.activeFilterCount();
    this.els.filterToggle.hidden = !activeFilters && !compactFiltersMq.matches;
    this.els.filterToggle.classList.toggle('on', this.filterOpen || activeFilters > 0);
    this.els.filterToggle.textContent = activeFilters ? `Filters · ${activeFilters}` : 'Filters';
    this.els.filterToggle.setAttribute('aria-expanded', String(this.filterOpen));
    this.els.facets.classList.toggle('open', this.filterOpen || activeFilters > 0);
    this.els.dir.textContent = this.desc ? '↓' : '↑';
    this.els.sort.value = this.sort;
  }

  private activeFilterCount(): number {
    return Number(this.filter.source !== 'all')
      + Number(this.filter.project !== 'all')
      + Number(this.filter.model !== 'all')
      + Number(this.filter.tier !== 'all')
      + Number(this.filter.skill !== 'all')
      + Number(this.filter.tool !== 'all');
  }

  private renderFacets(rows: HomeRow[]) {
    const f = facetOptions(rows);
    const sel = (id: string, label: string, cur: string, opts: string[]) => {
      const seen = opts.includes(cur) || cur === 'all';
      return html`<select class="select compact facet" data-facet="${id}" aria-label="Filter by ${label}">
        <option value="all">${label}: all</option>
        ${seen ? '' : html`<option value="${cur}" selected>${cur}</option>`}
        ${opts.map((o) => html`<option value="${o}"${o === cur ? raw(' selected') : ''}>${o}</option>`)}
      </select>`;
    };
    this.els.facets.innerHTML = html`${[
      sel('project', 'project', this.filter.project, f.projects),
      sel('source', 'source', this.filter.source, ['claude', 'codex', 'opencode', 'copilot']),
      sel('model', 'model', this.filter.model, f.models),
      sel('tier', 'tier', this.filter.tier, ['simple', 'moderate', 'complex']),
      sel('skill', 'skill', this.filter.skill, f.skills),
      sel('tool', 'tool', this.filter.tool, f.tools),
    ]}`.s;
    this.els.facets.querySelectorAll<HTMLSelectElement>('select.facet').forEach((s) => {
      s.onchange = () => {
        const k = s.dataset.facet as 'project' | 'source' | 'model' | 'tier' | 'skill' | 'tool';
        this.setFacet(k, s.value as HomeFilter[typeof k] & string);
      };
    });
  }

  private renderAgg(visible: HomeRow[]) {
    const a = aggregate(visible);
    const t = a.tokens;
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
    this.els.agg.innerHTML = html`<div class="tiles">${tiles}</div><div class="chip-rows">${chips}</div>`.s;
  }

  private renderMeta(total: number, shown: number) {
    const bits: string[] = [];
    if (shown !== total) bits.push(`${shown} of ${total} sessions`);
    if (this.searching) bits.push('searching full text…');
    else if (this.searchPartial) bits.push('search still scanning — partial results');
    this.els.meta.textContent = bits.join(' · ');
    this.els.meta.hidden = !bits.length;
  }

  private renderList(visible: HomeRow[]) {
    if (!this.data.sessions.length) {
      this.els.list.innerHTML = html`<div class="home-empty"><h2>${this.data.connected ? 'No sessions yet' : 'Connecting…'}</h2><p>${this.data.connected ? 'Start a coding agent (Claude Code, Codex, opencode, Copilot) in any project — sessions appear here automatically. Or import a replay.' : 'Reconnecting to the local transcript stream…'}</p>${this.data.connected ? raw('<button id="homeImport" class="amber">Import a replay</button>') : ''}</div>`.s;
      const b = this.els.list.querySelector<HTMLButtonElement>('#homeImport');
      if (b) b.onclick = () => this.cb.onImport();
      return;
    }
    if (!visible.length) {
      this.els.list.innerHTML = html`<div class="home-empty"><h2>No matches</h2><p>No sessions match the current filters${this.filter.text.trim() ? ' or search' : ''}. Clear a filter or broaden the query.</p></div>`.s;
      return;
    }
    const usd = this.data.pricingConfigured;
    const head = html`<tr><th>session</th><th>when</th><th>dur</th><th>tier</th><th class="num">sub</th><th class="num">tools</th><th class="num">tokens</th>${usd ? raw('<th class="num">$</th>') : ''}<th>skills</th><th>model</th><th>status</th></tr>`;
    const sk = (v: string | Html | false | undefined): string | Html => v || SKEL;
    const body = visible.map(({ sum, stats }) => {
      const title = sum.title || sum.id.slice(0, 8);
      const skills = stats ? Object.entries(stats.skills).sort((a, b) => b[1] - a[1]).slice(0, 3) : [];
      const model = stats?.models.length
        ? html`${shortModel(stats.models[stats.models.length - 1])}${stats.models.length > 1 ? ` +${stats.models.length - 1}` : ''}`
        : SKEL;
      return html`<tr class="srow" data-id="${sum.id}" tabindex="0" role="link" aria-label="Open session ${title}">
        <td class="t-title"><b>${title}</b><span>${sum.projectName || sum.project} · ${sum.source}</span></td>
        <td class="t-when" title="${new Date(stats?.lastActive || sum.lastActive).toLocaleString()}">${relTime(stats?.lastActive || sum.lastActive)}</td>
        <td>${sk(stats && (stats.durationMs >= 3_600_000 ? fmtDur(stats.durationMs) : fmtT(stats.durationMs)))}</td>
        <td>${tierBadge(stats)}</td>
        <td class="num">${sk(stats && String(stats.subagentCount))}</td>
        <td class="num">${sk(stats && String(stats.toolCalls))}</td>
        <td class="num t-tok">${sk(stats && html`${fmtTokens(stats.tokens.total)}${cacheSplitBar(stats.tokens)}`)}</td>
        ${usd ? html`<td class="num">${sk(stats && (stats.costUsd != null ? fmtUsd(stats.costUsd) : '—'))}</td>` : ''}
        <td class="t-skills">${skills.length ? skills.map(([s]) => html`<span class="chip">${s}</span>`) : stats ? raw('<span class="chip none">—</span>') : SKEL}</td>
        <td class="t-model">${model}</td>
        <td>${raw(sum.live ? '<span class="st live">● live</span>' : '<span class="st done">done</span>')}${stats?.partial ? raw('<span class="st part" title="Transcript could not be fully parsed">incomplete</span>') : ''}</td>
      </tr>`;
    });
    this.els.list.innerHTML = html`<table class="home-table">${head}${body}</table>`.s;
    this.els.list.querySelectorAll<HTMLTableRowElement>('tr.srow').forEach((tr) => {
      const open = () => this.cb.onOpen(tr.dataset.id!);
      tr.onclick = open;
      tr.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    });
  }
}

function shortModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

import type { SessionStats, SessionSummary } from '../shared/schema';
import { hashStr } from '../shared/order';
import { html, raw, type Html } from './html';
import { buildRows, facetOptions } from './homeModel';
import { bucketByDay, type DayBucket, type InsightsRange } from './insightsModel';
import { fmtTokens, fmtUsd } from './stats-viz';
import { maskProject } from './privacy';
import { theme } from './theme';

export interface InsightsCallbacks { onBack(): void }

interface InsightsData {
  sessions: SessionSummary[];
  stats: Map<string, SessionStats>;
  pricingConfigured: boolean;
  connected: boolean;
}

interface ChartSeries {
  color: string;
  values: (number | null)[];
  bar?: boolean;
  right?: boolean;
}

interface ChartSpec {
  days: string[];
  series: ChartSeries[];
  fmtLeft(n: number): string;
  fmtRight?(n: number): string;
  maxLeft?: number;
  ticks?: number;
  tip(i: number): string;
}

function niceStep(v: number): number {
  if (v <= 0) return 1;
  const k = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5]) if (m * k >= v) return m * k;
  return 10 * k;
}

function nice3(max: number): number {
  return max > 0 ? 3 * niceStep(max / 3) : 3;
}

function shortModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

const tipLines = (...ls: Array<string | Html>) => ls.map((l) => (typeof l === 'string' ? l : l.s)).join('<br>');

/** One canvas chart: stacked bars + overlay lines, dpr-aware, hover tooltip. */
class Chart {
  private ctx: CanvasRenderingContext2D;
  private tip: HTMLElement;
  private spec: ChartSpec | null = null;
  private hover = -1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas context unavailable');
    this.ctx = ctx;
    this.tip = document.createElement('div');
    this.tip.className = 'tl-tip ins-tip';
    this.tip.hidden = true;
    canvas.parentElement?.append(this.tip);
    canvas.addEventListener('pointermove', (e) => {
      if (!this.spec) return;
      const { padL, plotW } = this.geo();
      const r = canvas.getBoundingClientRect();
      const n = this.spec.days.length;
      this.setHover(Math.max(0, Math.min(n - 1, Math.floor((e.clientX - r.left - padL) / (plotW / n)))));
    });
    canvas.addEventListener('pointerleave', () => this.setHover(-1));
  }

  set(spec: ChartSpec) {
    this.spec = spec;
    this.hover = -1;
    this.tip.hidden = true;
    this.draw();
  }

  private geo() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const padL = 40, padR = this.spec?.fmtRight ? 42 : 8, padT = 8, padB = 16;
    return { w, h, padL, padR, padT, padB, plotW: w - padL - padR, plotH: h - padT - padB };
  }

  private setHover(i: number) {
    if (i === this.hover || !this.spec) return;
    this.hover = i;
    if (i < 0) { this.tip.hidden = true; this.draw(); return; }
    const { w, padL, plotW } = this.geo();
    const slot = plotW / this.spec.days.length;
    this.tip.innerHTML = this.spec.tip(i);
    this.tip.hidden = false;
    this.tip.style.left = `${Math.max(80, Math.min(w - 80, padL + (i + 0.5) * slot))}px`;
    this.draw();
  }

  draw() {
    const { spec, canvas: cv, ctx } = this;
    const dpr = devicePixelRatio || 1;
    const { w, h, padL, padT, padB, plotW, plotH } = this.geo();
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!spec) return;
    const dim = getComputedStyle(document.documentElement).getPropertyValue('--text-dim-rgb').trim();
    const n = spec.days.length;
    const slot = plotW / n;
    const bars = spec.series.filter((s) => s.bar);
    const lines = spec.series.filter((s) => !s.bar);
    const stackMax = Math.max(0, ...Array.from({ length: n }, (_, i) => bars.reduce((t, s) => t + (s.values[i] || 0), 0)));
    const leftLineMax = Math.max(0, ...lines.filter((s) => !s.right).flatMap((s) => s.values.map((v) => v || 0)));
    const top = spec.maxLeft ?? nice3(Math.max(stackMax, leftLineMax));
    const rTop = nice3(Math.max(0, ...lines.filter((s) => s.right).flatMap((s) => s.values.map((v) => v || 0))));
    const ticks = spec.ticks ?? 3;
    ctx.font = '8.5px "JetBrains Mono", monospace';
    if (this.hover >= 0) {
      ctx.fillStyle = `rgba(${dim},.08)`;
      ctx.fillRect(padL + this.hover * slot, padT, slot, plotH);
    }
    for (let k = 0; k <= ticks; k++) {
      const y = Math.round(padT + plotH - (plotH * k) / ticks) + 0.5;
      ctx.strokeStyle = k === 0 ? `rgba(${dim},.28)` : `rgba(${dim},.13)`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
      if (k === 0) continue;
      ctx.fillStyle = `rgba(${dim},.75)`;
      ctx.textAlign = 'right';
      ctx.fillText(spec.fmtLeft((top * k) / ticks), padL - 5, y + 3);
      if (spec.fmtRight && lines.some((s) => s.right)) {
        ctx.fillStyle = lines.find((s) => s.right)!.color;
        ctx.textAlign = 'left';
        ctx.fillText(spec.fmtRight((rTop * k) / ticks), padL + plotW + 5, y + 3);
      }
    }
    const bw = Math.max(2, Math.min(slot * 0.72, 26));
    for (let i = 0; i < n; i++) {
      let y = padT + plotH;
      const x = padL + i * slot + (slot - bw) / 2;
      for (const s of bars) {
        const v = s.values[i] || 0;
        if (v <= 0) continue;
        const bh = (plotH * v) / top;
        y -= bh;
        ctx.fillStyle = s.color;
        ctx.fillRect(x, y, bw, bh);
      }
    }
    for (const s of lines) {
      const axisTop = s.right ? rTop : top;
      const ys = (v: number) => padT + plotH - (plotH * Math.min(v, axisTop)) / axisTop;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (v == null) { pen = false; continue; }
        const x = padL + (i + 0.5) * slot;
        if (pen) ctx.lineTo(x, ys(v)); else { ctx.moveTo(x, ys(v)); pen = true; }
      }
      ctx.stroke();
      ctx.fillStyle = s.color;
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (v == null) continue;
        if (n > 31 && (s.values[i - 1] != null || s.values[i + 1] != null)) continue;
        ctx.beginPath();
        ctx.arc(padL + (i + 0.5) * slot, ys(v), 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const step = Math.ceil(n / 6);
    ctx.fillStyle = `rgba(${dim},.75)`;
    ctx.textAlign = 'center';
    for (let i = n - 1; i >= 0; i -= step) ctx.fillText(spec.days[i].slice(5), padL + (i + 0.5) * slot, h - padB + 12);
  }
}

const RANGES: InsightsRange[] = [7, 30, 90];

export class InsightsView {
  private range: InsightsRange = 30;
  private project = 'all';
  private data: InsightsData = { sessions: [], stats: new Map(), pricingConfigured: false, connected: false };
  private lastKey = '';
  private resizeTimer: number | null = null;
  private els: {
    ranges: HTMLElement; project: HTMLSelectElement; statline: HTMLElement; empty: HTMLElement;
    charts: HTMLElement; tokKey: HTMLElement; costCanvas: HTMLCanvasElement; costHint: HTMLElement;
    costKey: HTMLElement; actKey: HTMLElement;
  };
  private charts: { tokens: Chart; cost: Chart; activity: Chart; cache: Chart };

  constructor(private root: HTMLElement, private cb: InsightsCallbacks) {
    root.innerHTML = `
      <div class="insights" role="main">
        <div class="insights-head">
          <button id="insBack" class="ghost home-btn" aria-label="Back to sessions home" title="Sessions home (esc)">← Home</button>
          <div class="brand"><i></i><div><b>ORBSERVATORY</b><span>USAGE TRENDS</span></div></div>
          <span class="spacer"></span>
          <span id="insStatline" class="statline"></span>
          <div id="insRanges" class="ins-ranges" role="group" aria-label="Date range">${RANGES.map((d) => `<button class="chip-toggle" data-days="${d}" aria-pressed="false">${d}d</button>`).join('')}</div>
          <select id="insProject" class="select compact" aria-label="Filter by project"></select>
        </div>
        <div id="insEmpty" class="home-empty" hidden></div>
        <div id="insCharts" class="ins-charts" hidden>
          <section class="chart-card"><h3>tokens / day</h3><canvas id="insTok" aria-label="Tokens per day" role="img"></canvas><div id="insTokKey" class="ins-key"></div></section>
          <section class="chart-card"><h3>est. cost / day</h3><div id="insCostHint" class="ins-hint" hidden></div><canvas id="insCost" aria-label="Estimated cost per day by model" role="img"></canvas><div id="insCostKey" class="ins-key"></div></section>
          <section class="chart-card"><h3>activity / day</h3><canvas id="insAct" aria-label="Sessions and tool calls per day" role="img"></canvas><div id="insActKey" class="ins-key"></div></section>
          <section class="chart-card"><h3>cache hit-rate</h3><canvas id="insCache" aria-label="Cache hit rate per day" role="img"></canvas><div class="ins-key"></div></section>
        </div>
      </div>`;
    this.els = {
      ranges: root.querySelector('#insRanges')!,
      project: root.querySelector('#insProject')!,
      statline: root.querySelector('#insStatline')!,
      empty: root.querySelector('#insEmpty')!,
      charts: root.querySelector('#insCharts')!,
      tokKey: root.querySelector('#insTokKey')!,
      costCanvas: root.querySelector('#insCost')!,
      costHint: root.querySelector('#insCostHint')!,
      costKey: root.querySelector('#insCostKey')!,
      actKey: root.querySelector('#insActKey')!,
    };
    this.charts = {
      tokens: new Chart(root.querySelector('#insTok')!),
      cost: new Chart(this.els.costCanvas),
      activity: new Chart(root.querySelector('#insAct')!),
      cache: new Chart(root.querySelector('#insCache')!),
    };
    (root.querySelector('#insBack') as HTMLButtonElement).onclick = () => cb.onBack();
    this.els.ranges.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.onclick = () => { this.range = Number(b.dataset.days) as InsightsRange; this.render(); };
    });
    this.els.project.onchange = () => { this.project = this.els.project.value; this.render(); };
    window.addEventListener('resize', () => {
      if (this.resizeTimer != null) clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => { this.resizeTimer = null; this.render(); }, 150);
    });
    theme.subscribe(() => this.render());
  }

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

  private render() {
    const { sessions, stats } = this.data;
    this.renderProjectSelect(facetOptions(buildRows(sessions, stats)).projects);
    for (const b of this.els.ranges.querySelectorAll<HTMLButtonElement>('button')) {
      const on = Number(b.dataset.days) === this.range;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const res = bucketByDay([...stats.values()], sessions, {
      days: this.range,
      project: this.project === 'all' ? undefined : this.project,
    });
    this.els.statline.textContent = `${res.analysed} analysed / ${res.total} total · last ${this.range}d`;
    const empty = this.emptyCopy(res.total, res.analysed);
    this.els.empty.hidden = !empty;
    this.els.charts.hidden = !!empty;
    if (empty) { this.setHtml(this.els.empty, empty); this.lastKey = ''; return; }
    const key = [hashStr(JSON.stringify(res.buckets)), this.range, this.project, theme.resolved, this.root.clientWidth, this.data.pricingConfigured].join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.drawCharts(res.buckets);
  }

  private emptyCopy(total: number, analysed: number): string | null {
    if (!this.data.sessions.length && !this.data.connected) {
      return html`<h2>Connecting…</h2><p>Reconnecting to the local transcript stream…</p>`.s;
    }
    const scope = `the last ${this.range} days${this.project === 'all' ? '' : ' in this project'}`;
    if (total === 0) {
      return html`<h2>No sessions in range</h2><p>No sessions were active in ${scope}. Widen the range or clear the project filter.</p>`.s;
    }
    if (analysed === 0) {
      return html`<h2>Waiting for background analysis</h2><p>${total} session${total === 1 ? '' : 's'} in ${scope} still analysing — charts appear as stats land.</p>`.s;
    }
    return null;
  }

  private renderProjectSelect(projects: string[]) {
    const cur = this.project;
    const seen = cur === 'all' || projects.includes(cur);
    const s = html`<option value="all">project: all</option>
      ${seen ? '' : html`<option value="${cur}" selected>${maskProject(cur)}</option>`}
      ${projects.map((p) => html`<option value="${p}"${p === cur ? raw(' selected') : ''}>${maskProject(p)}</option>`)}`.s;
    if (this.setHtml(this.els.project, s)) this.els.project.value = cur;
  }

  private drawCharts(buckets: DayBucket[]) {
    const css = getComputedStyle(document.documentElement);
    const val = (name: string) => css.getPropertyValue(name).trim();
    const days = buckets.map((b) => b.day);
    const note = raw('<em>attributed to day of last activity</em>');
    const who = (b: DayBucket) => `${b.sessions} session${b.sessions === 1 ? '' : 's'} · ${b.analysed} analysed`;
    const legend = (items: Array<[string, string, boolean?]>) =>
      html`${items.map(([c, l, line]) => html`<span><i class="${line ? 'line' : ''}" style="background:${c}"></i>${l}</span>`)}`.s;

    const tokC = [val('--viz-in'), val('--viz-out'), val('--viz-in-dim'), val('--viz-out-dim')];
    this.charts.tokens.set({
      days,
      series: [
        { bar: true, color: tokC[0], values: buckets.map((b) => b.tokens.input) },
        { bar: true, color: tokC[1], values: buckets.map((b) => b.tokens.output) },
        { bar: true, color: tokC[2], values: buckets.map((b) => b.tokens.cacheRead) },
        { bar: true, color: tokC[3], values: buckets.map((b) => b.tokens.cacheCreation) },
      ],
      fmtLeft: fmtTokens,
      tip: (i) => {
        const b = buckets[i], t = b.tokens;
        return tipLines(
          html`<b>${b.day}</b>`,
          `in ${fmtTokens(t.input)} · out ${fmtTokens(t.output)}`,
          `cache read ${fmtTokens(t.cacheRead)} · write ${fmtTokens(t.cacheCreation)}`,
          `total ${fmtTokens(t.total)}`, who(b), note,
        );
      },
    });
    this.setHtml(this.els.tokKey, legend([[tokC[0], 'input'], [tokC[1], 'output'], [tokC[2], 'cache read'], [tokC[3], 'cache write']]));

    const MODEL_TOKENS = ['--accent', '--purple', '--ok', '--warn', '--err', '--viz-in', '--viz-out'];
    const modelColor = (m: string) => val(MODEL_TOKENS[hashStr(m) % MODEL_TOKENS.length]);
    const costOf = (m: string) => buckets.reduce((t, b) => t + (b.costByModel[m] || 0), 0);
    const models = [...new Set(buckets.flatMap((b) => Object.keys(b.costByModel)))].sort((a, b) => costOf(b) - costOf(a));
    const hasCost = models.some((m) => costOf(m) > 0);
    this.els.costCanvas.hidden = !hasCost;
    this.els.costHint.hidden = hasCost;
    if (!hasCost) {
      this.els.costHint.textContent = this.data.pricingConfigured ? 'no priced sessions in range' : 'add pricing in ⚙ settings';
      this.setHtml(this.els.costKey, '');
    } else {
      this.charts.cost.set({
        days,
        series: models.map((m) => ({ bar: true, color: modelColor(m), values: buckets.map((b) => b.costByModel[m] || 0) })),
        fmtLeft: fmtUsd,
        tip: (i) => {
          const b = buckets[i];
          const rows = models.filter((m) => (b.costByModel[m] || 0) > 0)
            .map((m) => html`${shortModel(m)} ${fmtUsd(b.costByModel[m])}`);
          const total = models.reduce((t, m) => t + (b.costByModel[m] || 0), 0);
          return tipLines(html`<b>${b.day}</b>`, ...(rows.length ? rows : ['no priced sessions']), `total ${fmtUsd(total)}`, who(b), note);
        },
      });
      this.setHtml(this.els.costKey, legend(models.slice(0, 6).map((m) => [modelColor(m), shortModel(m)] as [string, string])));
    }

    const maxSessions = Math.max(0, ...buckets.map((b) => b.sessions));
    const actBar = `rgba(${val('--accent-rgb')},.6)`;
    const actLine = val('--warn');
    this.charts.activity.set({
      days,
      series: [
        { bar: true, color: actBar, values: buckets.map((b) => b.sessions) },
        { color: actLine, right: true, values: buckets.map((b) => (b.analysed ? b.toolCalls : null)) },
      ],
      fmtLeft: (v) => String(Math.round(v)),
      fmtRight: fmtTokens,
      maxLeft: 3 * Math.max(1, Math.ceil(maxSessions / 3)),
      tip: (i) => {
        const b = buckets[i];
        return tipLines(html`<b>${b.day}</b>`, who(b), b.analysed ? `${fmtTokens(b.toolCalls)} tool calls` : 'tool calls pending analysis', note);
      },
    });
    this.setHtml(this.els.actKey, legend([[actBar, 'sessions'], [actLine, 'tool calls', true]]));

    this.charts.cache.set({
      days,
      series: [{ color: val('--ok'), values: buckets.map((b) => b.cacheRate) }],
      fmtLeft: (v) => `${Math.round(v * 100)}%`,
      maxLeft: 1,
      ticks: 4,
      tip: (i) => {
        const b = buckets[i];
        const rate = b.cacheRate == null ? 'no cacheable input' : `${(b.cacheRate * 100).toFixed(1)}% cache hits`;
        return tipLines(html`<b>${b.day}</b>`, rate, `read ${fmtTokens(b.tokens.cacheRead)} · in ${fmtTokens(b.tokens.input)}`, who(b), note);
      },
    });
  }
}

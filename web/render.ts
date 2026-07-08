import type { Engine, EngineAgent } from './engine';
import { colorOf, fmt, hash, radius, ringColor, statusAt, tokensAt } from './engine';

export type LayoutMode = 'organic' | 'radial' | 'fixed';
export type PaletteName = 'Deep Teal' | 'Obsidian' | 'Ink Blue' | 'Void Violet' | 'Carbon';

export const PALETTES: Record<PaletteName, { stops: string[]; grid: string; vign: string }> = {
  'Deep Teal': { stops: ['#0a2029', '#06141a', '#040d12'], grid: 'rgba(140,200,220,.055)', vign: 'rgba(3,10,14,.5)' },
  'Obsidian': { stops: ['#151518', '#0a0a0d', '#000000'], grid: 'rgba(205,210,220,.05)', vign: 'rgba(0,0,0,.62)' },
  'Ink Blue': { stops: ['#0a1626', '#050c16', '#01040a'], grid: 'rgba(150,180,225,.055)', vign: 'rgba(1,4,10,.58)' },
  'Void Violet': { stops: ['#151019', '#0b0710', '#020104'], grid: 'rgba(195,170,225,.05)', vign: 'rgba(2,1,5,.6)' },
  'Carbon': { stops: ['#1b1b1e', '#101012', '#050506'], grid: 'rgba(212,212,218,.05)', vign: 'rgba(0,0,0,.56)' },
};

interface NodeState { id: string; a: EngineAgent; x: number; y: number; vx: number; vy: number; r: number; tx?: number; ty?: number }

// Completed agents linger long enough for the completion flash + power-down, fade out, then detach.
const REMOVE_LINGER_MS = 3000;
const REMOVE_FADE_MS = 800;

export class VisualRenderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tl?: HTMLCanvasElement;
  tctx?: CanvasRenderingContext2D;
  eng?: Engine;
  nodes = new Map<string, NodeState>();
  staticPos = new Map<string, { x: number; y: number }>();
  cam = { x: 0, y: 0, s: 1 };
  userCam = false;
  focusId: string | null = null;
  hoverId: string | null = null;
  selectedId: string | null = null;
  railOpen = true;
  layout: LayoutMode = 'organic';
  palette: PaletteName = 'Deep Teal';
  glow = 1;
  edgeStyle: 'beams' | 'wires' = 'beams';
  showGrid = false;
  liveNow?: number;
  reduceMotion = false;
  sprites: Record<string, HTMLCanvasElement> = {};
  /** Last rendered simulation time, used as the base for keyboard scrubbing. */
  private seekAt = 0;
  private down: { x: number; y: number; moved: number; node: NodeState | null; cx: number; cy: number } | null = null;
  private scrub = false;
  onSelect?: (id: string | null) => void;
  onSeek?: (t: number) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas context unavailable');
    this.ctx = ctx;
    this.bindCanvas();
  }

  setTimeline(canvas: HTMLCanvasElement) {
    this.tl = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('timeline context unavailable');
    this.tctx = ctx;
    const seek = (e: PointerEvent) => {
      if (!this.eng) return;
      const r = canvas.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      this.onSeek?.(p * this.eng.duration);
    };
    canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); this.scrub = true; seek(e); });
    canvas.addEventListener('pointermove', e => { if (this.scrub) seek(e); });
    canvas.addEventListener('pointerup', () => { this.scrub = false; });
    // Keyboard scrubbing: the timeline is exposed as role="slider" tabindex="0".
    canvas.addEventListener('keydown', e => {
      if (!this.eng) return;
      const dur = this.eng.duration, cur = Math.min(dur, Math.max(0, this.seekAt));
      const stepMs = Math.max(1000, dur * 0.02);
      let next: number | null = null;
      if (e.key === 'ArrowRight') next = cur + stepMs;
      else if (e.key === 'ArrowLeft') next = cur - stepMs;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = dur;
      if (next == null) return;
      e.preventDefault();
      this.onSeek?.(Math.min(dur, Math.max(0, next)));
    });
  }

  setEngine(eng: Engine, reset = false) {
    const sameShape = this.eng && [...this.nodes.keys()].every(id => eng.agents.has(id));
    this.eng = eng;
    if (reset || !sameShape) {
      this.nodes.clear();
      this.userCam = false;
      this.focusId = null;
    } else {
      for (const [id, node] of this.nodes) {
        const next = eng.agents.get(id);
        if (next) { node.a = next; node.r = radius(next); }
        else this.nodes.delete(id);
      }
    }
    this.computeStatic();
  }

  fit() { this.userCam = false; this.focusId = null; }

  drawFrame(t: number, dt: number) {
    if (!this.eng) return;
    this.seekAt = t;
    this.syncNodes(t); this.physics(t, dt); this.updateCam(); this.draw(t); this.drawTL(t);
  }

  toWorld(px: number, py: number) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return { x: (px - w / 2) / this.cam.s + this.cam.x, y: (py - h / 2) / this.cam.s + this.cam.y };
  }

  private bindCanvas() {
    const el = this.canvas;
    el.addEventListener('pointerdown', e => {
      el.setPointerCapture(e.pointerId);
      const hit = this.hitTest(e.offsetX, e.offsetY);
      this.down = { x: e.offsetX, y: e.offsetY, moved: 0, node: hit, cx: this.cam.x, cy: this.cam.y };
    });
    el.addEventListener('pointermove', e => {
      if (this.down) {
        const dx = e.offsetX - this.down.x, dy = e.offsetY - this.down.y;
        this.down.moved += Math.abs(dx) + Math.abs(dy);
        if (this.down.node) {
          const n = this.down.node; const w = this.toWorld(e.offsetX, e.offsetY);
          n.x = w.x; n.y = w.y; n.vx = 0; n.vy = 0;
        } else if (this.down.moved > 4) {
          this.userCam = true; this.focusId = null;
          this.cam.x = this.down.cx - dx / this.cam.s; this.cam.y = this.down.cy - dy / this.cam.s;
        }
      } else {
        const hit = this.hitTest(e.offsetX, e.offsetY);
        this.hoverId = hit ? hit.id : null;
        el.style.cursor = hit ? 'pointer' : 'default';
      }
    });
    el.addEventListener('pointerup', () => {
      if (this.down && this.down.moved < 5) {
        this.selectedId = this.down.node ? this.down.node.id : null;
        this.onSelect?.(this.selectedId);
      }
      this.down = null;
    });
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * 0.0013);
      const s2 = Math.min(3, Math.max(0.12, this.cam.s * f));
      const wp = this.toWorld(e.offsetX, e.offsetY);
      this.cam.x = wp.x - (e.offsetX - this.canvas.clientWidth / 2) / s2;
      this.cam.y = wp.y - (e.offsetY - this.canvas.clientHeight / 2) / s2;
      this.cam.s = s2; this.userCam = true; this.focusId = null;
    }, { passive: false });
    el.addEventListener('dblclick', () => this.fit());
  }

  private hitTest(px: number, py: number): NodeState | null {
    const wp = this.toWorld(px, py);
    let best: NodeState | null = null, bd = 1e9;
    for (const n of this.nodes.values()) {
      const d = Math.hypot(n.x - wp.x, n.y - wp.y);
      if (d < n.r + 8 && d < bd) { bd = d; best = n; }
    }
    return best;
  }

  /** 0 = fully visible, 1 = fully faded out (node about to be removed). */
  private goneFrac(a: EngineAgent, t: number): number {
    if (a.completeT === Infinity) return 0;
    return Math.min(1, Math.max(0, (t - a.completeT - (REMOVE_LINGER_MS - REMOVE_FADE_MS)) / REMOVE_FADE_MS));
  }

  private syncNodes(t: number) {
    if (!this.eng) return;
    for (const a of this.eng.agents.values()) {
      const alive = t >= a.spawnT && (a.completeT === Infinity || t <= a.completeT + REMOVE_LINGER_MS);
      let n = this.nodes.get(a.id);
      if (alive && !n) {
        const p = a.parent && this.nodes.get(a.parent);
        const idx = a.parent ? (this.eng.agents.get(a.parent)?.children.indexOf(a.id) ?? 0) : [...this.nodes.values()].filter(n => !n.a.parent).length;
        const ang = idx * 2.399963 + a.depth * 1.7 + (hash(a.id) % 628) / 100;
        const sp = this.staticPos.get(a.id);
        const useStatic = this.layout === 'fixed' && sp;
        const sx = useStatic ? sp!.x : (p ? p.x + Math.cos(ang) * 55 : (idx - 1) * 220);
        const sy = useStatic ? sp!.y : (p ? p.y + Math.sin(ang) * 55 : Math.sin(idx) * 90);
        n = { id: a.id, a, x: sx, y: sy, vx: 0, vy: 0, r: radius(a) };
        this.nodes.set(a.id, n);
      } else if (!alive && n) this.nodes.delete(a.id);
    }
  }

  private computeStatic() {
    if (!this.eng) return;
    const ag = this.eng.agents, pos = new Map<string, { x: number; y: number }>(), leaves: Record<string, number> = {};
    const count = (id: string): number => { const ks = ag.get(id)?.children || []; if (!ks.length) return (leaves[id] = 1); return (leaves[id] = ks.reduce((s, k) => s + count(k), 0)); };
    const roots = this.eng.order.filter(id => !ag.get(id)?.parent);
    let total = 0; roots.forEach(r => total += count(r));
    const ring = [0, 170, 310, 420, 515, 600];
    const rad = (d: number) => d < ring.length ? ring[d] : 600 + (d - 5) * 80;
    const assign = (id: string, a0: number, a1: number) => {
      const a = ag.get(id); if (!a) return;
      const mid = (a0 + a1) / 2;
      pos.set(id, { x: Math.cos(mid) * rad(a.depth), y: Math.sin(mid) * rad(a.depth) });
      let cur = a0;
      for (const k of a.children) { const span = (a1 - a0) * ((leaves[k] || 1) / (leaves[id] || 1)); assign(k, cur, cur + span); cur += span; }
    };
    let cur = -Math.PI / 2;
    for (const r of roots) { const span = Math.PI * 2 * ((leaves[r] || 1) / (total || 1)); assign(r, cur, cur + span); cur += span; }
    this.staticPos = pos;
  }

  private radialLayout() {
    if (!this.eng) return;
    const alive = this.nodes, ag = this.eng.agents;
    const kids = (id: string) => (ag.get(id)?.children || []).filter(c => alive.has(c));
    const leaves: Record<string, number> = {};
    const count = (id: string): number => { const ks = kids(id); if (!ks.length) return (leaves[id] = 1); return (leaves[id] = ks.reduce((s, k) => s + count(k), 0)); };
    const roots = [...alive.keys()].filter(id => { const a = ag.get(id); return !a?.parent || !alive.has(a.parent); });
    let total = 0; roots.forEach(r => total += count(r));
    const ring = [0, 170, 310, 420, 515, 600];
    const rad = (d: number) => d < ring.length ? ring[d] : 600 + (d - 5) * 80;
    const assign = (id: string, a0: number, a1: number) => {
      const a = ag.get(id), n = alive.get(id); if (!a || !n) return;
      const mid = (a0 + a1) / 2; n.tx = Math.cos(mid) * rad(a.depth); n.ty = Math.sin(mid) * rad(a.depth);
      let cur = a0; for (const k of kids(id)) { const span = (a1 - a0) * ((leaves[k] || 1) / (leaves[id] || 1)); assign(k, cur, cur + span); cur += span; }
    };
    let cur = -Math.PI / 2;
    for (const r of roots) { const span = Math.PI * 2 * ((leaves[r] || 1) / (total || 1)); assign(r, cur, cur + span); cur += span; }
  }

  private physics(t: number, dt: number) {
    if (!this.eng) return;
    // Long-completed agents are visually frozen orbs — exclude them from the O(n²) simulation.
    const ns: NodeState[] = [];
    for (const n of this.nodes.values()) { if (this.powerDown(n.a, t) < 1) ns.push(n); }
    const st = Math.min(2, dt / 16);
    if (this.layout === 'fixed') {
      for (const n of ns) {
        const target = this.staticPos.get(n.id); if (!target) continue;
        n.vx += (target.x - n.x) * 0.12 * st; n.vy += (target.y - n.y) * 0.12 * st;
        n.vx *= Math.pow(0.55, st); n.vy *= Math.pow(0.55, st); n.x += n.vx * st; n.y += n.vy * st;
      }
      return;
    }
    if (this.layout === 'radial') {
      this.radialLayout();
      for (const n of ns) {
        if (n.tx != null) { n.vx += (n.tx - n.x) * 0.05 * st; n.vy += (n.ty! - n.y) * 0.05 * st; }
        n.vx *= Math.pow(0.7, st); n.vy *= Math.pow(0.7, st); n.x += n.vx * st; n.y += n.vy * st;
      }
      return;
    }
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
      const A = ns[i], B = ns[j]; let dx = B.x - A.x, dy = B.y - A.y, d2 = dx * dx + dy * dy;
      if (d2 < 1) { dx = ((hash(A.id) % 10) - 5) || 1; dy = ((hash(B.id) % 10) - 5) || 1; d2 = dx * dx + dy * dy; }
      const d = Math.sqrt(d2); const rep = (3400 * (A.r + B.r) / 42) / (d2 + 500);
      const fx = dx / d * rep, fy = dy / d * rep; A.vx -= fx * st; A.vy -= fy * st; B.vx += fx * st; B.vy += fy * st;
    }
    for (const n of ns) {
      const p = n.a.parent && this.nodes.get(n.a.parent);
      const pd = this.powerDown(n.a, t);
      if (p && pd < 1) {
        const kids = this.eng.agents.get(n.a.parent!)?.children.length || 1;
        const rest = (n.a.depth === 1 ? 170 : 98) + kids * 4;
        const dx = p.x - n.x, dy = p.y - n.y, d = Math.hypot(dx, dy) || 1;
        const f = (d - rest) * 0.0055 * (1 - pd);
        n.vx += dx / d * f * d * 0.02 * st + dx / d * f * st * 8;
        n.vy += dy / d * f * d * 0.02 * st + dy / d * f * st * 8;
        if (pd > 0) { n.vx -= dx / d * 0.4 * st; n.vy -= dy / d * 0.4 * st; }
      } else if (!p) {
        n.vx -= n.x * 0.0022 * st; n.vy -= n.y * 0.0022 * st;
      }
      n.vx *= Math.pow(0.87, st); n.vy *= Math.pow(0.87, st);
      const sp = Math.hypot(n.vx, n.vy); if (sp > 7) { n.vx *= 7 / sp; n.vy *= 7 / sp; }
      n.x += n.vx * st; n.y += n.vy * st;
    }
  }

  private updateCam() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.focusId) {
      const n = this.nodes.get(this.focusId);
      if (n) { this.cam.x += (n.x - this.cam.x) * 0.09; this.cam.y += (n.y - this.cam.y) * 0.09; if (Math.hypot(n.x - this.cam.x, n.y - this.cam.y) < 3) this.focusId = null; }
      else this.focusId = null;
      return;
    }
    if (this.userCam || !this.nodes.size) return;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const n of this.nodes.values()) { x0 = Math.min(x0, n.x - 75); y0 = Math.min(y0, n.y - 65); x1 = Math.max(x1, n.x + 75); y1 = Math.max(y1, n.y + 65); }
    const px0 = this.railOpen ? 282 : 22, px1 = w - (this.selectedId ? 374 : 22);
    const vw = Math.max(140, px1 - px0), vh = h - 80;
    const ts = Math.min(1.35, Math.max(0.14, Math.min(vw / Math.max(1, x1 - x0), vh / Math.max(1, y1 - y0))));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const tx = cx - ((px0 + px1) / 2 - w / 2) / ts;
    this.cam.s += (ts - this.cam.s) * 0.045; this.cam.x += (tx - this.cam.x) * 0.05; this.cam.y += (cy - this.cam.y) * 0.05;
  }

  private draw(t: number) {
    if (!this.eng) return;
    const cv = this.canvas, x = this.ctx, dpr = devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
    const pal = PALETTES[this.palette] || PALETTES['Deep Teal'];
    const bg = x.createRadialGradient(w / 2, h * .28, 40, w / 2, h * .28, Math.max(w, h));
    bg.addColorStop(0, pal.stops[0]); bg.addColorStop(.58, pal.stops[1]); bg.addColorStop(1, pal.stops[2]);
    x.fillStyle = bg; x.fillRect(0, 0, w, h);
    if (this.showGrid) this.drawGrid(x, w, h, pal.grid);
    const cam = this.cam, s = cam.s;
    x.save(); x.translate(w / 2, h / 2); x.scale(s, s); x.translate(-cam.x, -cam.y);
    this.drawWorld(t, x);
    x.restore();
    this.drawLabels(t, x, w, h);
    const vg = x.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.38, w / 2, h / 2, Math.max(w, h) * 0.75);
    vg.addColorStop(0, 'rgba(4,13,18,0)'); vg.addColorStop(1, pal.vign); x.fillStyle = vg; x.fillRect(0, 0, w, h);
  }

  private drawGrid(x: CanvasRenderingContext2D, w: number, h: number, color: string) {
    x.save(); x.strokeStyle = color; x.lineWidth = 1;
    const step = 42 * this.cam.s; const ox = ((-this.cam.x * this.cam.s + w / 2) % step + step) % step; const oy = ((-this.cam.y * this.cam.s + h / 2) % step + step) % step;
    for (let px = ox; px < w; px += step) { x.beginPath(); x.moveTo(px, 0); x.lineTo(px, h); x.stroke(); }
    for (let py = oy; py < h; py += step) { x.beginPath(); x.moveTo(0, py); x.lineTo(w, py); x.stroke(); }
    x.restore();
  }

  /** First index in eng.evs with t >= target (events are sorted by t). */
  private evLowerBound(target: number): number {
    const evs = this.eng!.evs;
    let lo = 0, hi = evs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (evs[m].t < target) lo = m + 1; else hi = m; }
    return lo;
  }

  private drawWorld(T: number, x: CanvasRenderingContext2D) {
    if (!this.eng) return;
    const recent: Record<string, number> = {};
    const evs = this.eng.evs;
    for (let i = this.evLowerBound(T - 1200); i < evs.length; i++) {
      const e = evs[i]; if (e.t > T) break;
      const id = ('agent' in e && e.agent) || (e as any).to; if (id) recent[id] = T - e.t;
    }
    for (const n of this.nodes.values()) {
      const p = n.a.parent && this.nodes.get(n.a.parent); if (!p) continue;
      const pd = this.powerDown(n.a, T), fade = 1 - pd;
      const nc = colorOf(n.a), pc = colorOf(p.a); const [r1,g1,b1] = this.rgb(pc), [r2,g2,b2] = this.rgb(nc);
      const c = this.curve(p.x, p.y, n.x, n.y, hash(n.id));
      const end = 1 - pd * .97; const base = (recent[n.id] != null ? .5 : .2) * fade;
      const gr = x.createLinearGradient(p.x, p.y, n.x, n.y); gr.addColorStop(0, `rgba(${r1},${g1},${b1},${base})`); gr.addColorStop(1, `rgba(${r2},${g2},${b2},${base})`);
      const pathTo = (frac: number) => { x.beginPath(); x.moveTo(p.x, p.y); if (frac >= .999) x.quadraticCurveTo(c.cx, c.cy, n.x, n.y); else for (let k=1;k<=16;k++) { const q=this.qPt(p.x,p.y,c.cx,c.cy,n.x,n.y,(k/16)*frac); x.lineTo(q.x,q.y); } };
      if (this.edgeStyle === 'beams') { x.strokeStyle = `rgba(${r2},${g2},${b2},${(recent[n.id] != null ? .1 : .045) * this.glow * fade})`; x.lineWidth = 6; pathTo(end); x.stroke(); }
      x.strokeStyle = gr; x.lineWidth = 1.1; pathTo(end); x.stroke();
    }
    this.drawEffects(T, x);
    for (const n of this.nodes.values()) this.drawNode(T, x, n, recent[n.id] != null);
  }

  private drawEffects(T: number, x: CanvasRenderingContext2D) {
    if (!this.eng) return;
    const evs = this.eng.evs;
    for (let i = this.evLowerBound(T - 1300); i < evs.length; i++) {
      const e = evs[i];
      if (e.t > T) break;
      const age = T - e.t;
      if (e.type === 'spawn' && e.parent && age < 750) {
        const n = this.nodes.get(e.agent), p = this.nodes.get(e.parent); if (!n || !p) continue;
        const pr = age / 750, c = this.curve(p.x,p.y,n.x,n.y,hash(e.agent)), col = colorOf(n.a), [R,G,B] = this.rgb(col);
        x.strokeStyle = `rgba(${R},${G},${B},${(1-pr)*.85})`; x.lineWidth = 2; x.beginPath(); x.moveTo(p.x,p.y); for(let k=1;k<=14;k++){const q=this.qPt(p.x,p.y,c.cx,c.cy,n.x,n.y,(k/14)*pr); x.lineTo(q.x,q.y);} x.stroke();
        const hd=this.qPt(p.x,p.y,c.cx,c.cy,n.x,n.y,pr); x.drawImage(this.glowSprite(col),hd.x-14,hd.y-14,28,28);
      } else if (e.type === 'message' && e.from && e.to && age < 950) {
        const f=this.nodes.get(e.from), to=this.nodes.get(e.to); if(!f||!to) continue;
        const pr=Math.min(1,age/900), c=this.curve(f.x,f.y,to.x,to.y,hash(e.from+e.to)), col=colorOf(f.a), [R,G,B]=this.rgb(col);
        x.strokeStyle=`rgba(${R},${G},${B},.12)`; x.lineWidth=1; x.beginPath(); x.moveTo(f.x,f.y); x.quadraticCurveTo(c.cx,c.cy,to.x,to.y); x.stroke();
        for(let k=4;k>=0;k--){const tt=pr-k*.045;if(tt<0||tt>1)continue;const q=this.qPt(f.x,f.y,c.cx,c.cy,to.x,to.y,tt), sz=(16-k*2.4)*this.glow; x.drawImage(this.glowSprite(col),q.x-sz/2,q.y-sz/2,sz,sz);}
      } else if (e.type === 'message' && !e.from && e.to && age < 900) {
        const n=this.nodes.get(e.to); if(n){const pr=age/900; x.strokeStyle=`rgba(232,245,250,${(1-pr)*.5})`; x.lineWidth=1.3; x.beginPath(); x.arc(n.x,n.y,n.r+3+pr*26,0,7); x.stroke();}
      } else if (e.type === 'tool' && age < 900) {
        const n=this.nodes.get(e.agent); if(n){const pr=age/900; x.strokeStyle=`rgba(243,196,126,${(1-pr)*.4})`; x.lineWidth=1.2; x.beginPath(); x.arc(n.x,n.y,n.r+2+pr*13,0,7); x.stroke();}
      } else if (e.type === 'compact' && age < 900) {
        const n=this.nodes.get(e.agent); if(n){const pr=age/900; x.strokeStyle=`rgba(180,160,242,${(1-pr)*.65})`; x.lineWidth=1.6; x.beginPath(); x.arc(n.x,n.y,n.r+4+(1-pr)*n.r*2.4,0,7); x.stroke();}
      } else if (e.type === 'error' && age < 1300) {
        const n=this.nodes.get(e.agent); if(n){const pr=age/1300; x.strokeStyle=`rgba(255,122,112,${(1-pr)*.7})`; x.lineWidth=1.8; x.beginPath(); x.arc(n.x,n.y,n.r+3+pr*30,0,7); x.stroke();}
      } else if (e.type === 'complete' && age < 650) {
        const n=this.nodes.get(e.agent); if(n){const pr=age/650, sz=n.r*6*(1-pr*.4); x.globalAlpha=1-pr; x.drawImage(this.glowSprite(colorOf(n.a)),n.x-sz/2,n.y-sz/2,sz,sz); x.globalAlpha=1;}
      }
    }
  }

  private drawNode(T: number, x: CanvasRenderingContext2D, n: NodeState, recent: boolean) {
    const a=n.a, gone=this.goneFrac(a,T); if(gone>=1)return; const vis=1-gone;
    const col=colorOf(a), status=statusAt(a,T,this.liveNow), tok=tokensAt(a,T), lim=a.def.limit||1000000, pct=Math.min(1,tok/lim), dim=status==='complete'||status==='idle', pd=this.powerDown(a,T), breathe=(status==='active'&&!this.reduceMotion)?1+.08*Math.sin(T/260+hash(a.id)):1;
    const halo=n.r*(4.6+(recent?1.6:0))*breathe*this.glow*(dim ? .38 : 1)*vis; if(halo>1)x.drawImage(this.glowSprite(status==='error'?'#ff7a70':col),n.x-halo/2,n.y-halo/2,halo,halo);
    x.globalAlpha=(status==='idle'?.48:(status==='complete'?.75-pd*.4:1))*vis; x.drawImage(this.orbSprite(status==='error'?'#ff7a70':col,n.r,dim),n.x-n.r,n.y-n.r,n.r*2,n.r*2); x.globalAlpha=1;
    if(pd>0&&vis>0){x.fillStyle=`rgba(6,16,20,${pd*.66*vis})`;x.beginPath();x.arc(n.x,n.y,n.r,0,7);x.fill();}
    x.strokeStyle=`rgba(200,230,240,${.13*vis})`; x.lineWidth=1.6; x.beginPath(); x.arc(n.x,n.y,n.r+4.5,0,7); x.stroke();
    if(pct>.003){x.strokeStyle=ringColor(pct); x.globalAlpha=(dim ? .4 : .95)*(pct>.85&&status==='active'&&!this.reduceMotion? .6+.4*Math.sin(T/130):1)*vis; x.lineWidth=2.4; x.lineCap='round'; x.beginPath(); x.arc(n.x,n.y,n.r+4.5,-Math.PI/2,-Math.PI/2+pct*Math.PI*2); x.stroke(); x.globalAlpha=1; x.lineCap='butt';}
    if(status==='complete'){x.strokeStyle=`rgba(10,25,30,${.85*(1-pd)})`; x.lineWidth=Math.max(1.6,n.r*.16); x.lineCap='round'; x.beginPath(); x.moveTo(n.x-n.r*.38,n.y+n.r*.02); x.lineTo(n.x-n.r*.1,n.y+n.r*.32); x.lineTo(n.x+n.r*.42,n.y-n.r*.28); x.stroke(); x.lineCap='butt';}
    if(status==='error'){x.fillStyle='#fff1ef'; x.font=`700 ${Math.max(9,n.r)}px 'JetBrains Mono',monospace`; x.textAlign='center'; x.textBaseline='middle'; x.fillText('!',n.x,n.y+.5);}
    if(this.selectedId===a.id){x.strokeStyle='rgba(235,250,255,.65)'; x.lineWidth=1.2; x.setLineDash([4,5]); x.lineDashOffset=this.reduceMotion?0:-T/40; x.beginPath(); x.arc(n.x,n.y,n.r+10,0,7); x.stroke(); x.setLineDash([]);}
  }

  private drawLabels(T: number, x: CanvasRenderingContext2D, w: number, h: number) {
    if (!this.eng) return;
    const cam=this.cam, s=cam.s, total=this.nodes.size;
    for (const n of this.nodes.values()) {
      const a=n.a; if(this.goneFrac(a,T)>0)continue;
      const sx=(n.x-cam.x)*s+w/2, sy=(n.y-cam.y)*s+h/2; if(sx<-90||sx>w+90||sy<-70||sy>h+70)continue;
      const sel=this.selectedId===a.id, hov=this.hoverId===a.id, show=a.depth<=1||sel||hov||total<=20||n.r*s>12, status=statusAt(a,T,this.liveNow);
      if(!show)continue; const tok=tokensAt(a,T), lim=a.def.limit||1000000, pct=Math.min(1,tok/lim), fs=Math.max(8.5,Math.min(13,11*Math.sqrt(s)));
      x.textAlign='center'; x.textBaseline='alphabetic'; x.font=`500 ${fs}px Outfit,sans-serif`; x.fillStyle=status==='complete'||status==='idle'?'rgba(190,215,224,.5)':'rgba(224,242,248,.92)'; x.shadowColor='rgba(4,13,17,.9)'; x.shadowBlur=4; x.fillText(a.def.name,sx,sy-(n.r+10)*s-4);
      if(a.depth<=1||sel||hov){x.font=`500 ${Math.max(7.5,fs*.78)}px 'JetBrains Mono',monospace`; x.fillStyle=pct>.85?'rgba(255,150,140,.9)':'rgba(150,200,215,.75)'; x.fillText(`${fmt(tok)} · ${Math.round(pct*100)}%`,sx,sy+(n.r+9)*s+11);} x.shadowBlur=0;
    }
    x.textAlign='center';
    const evs=this.eng.evs;
    for(let i=this.evLowerBound(T-1700);i<evs.length;i++){const e=evs[i];if(e.t>T)break; const age=T-e.t;if(age>1700)continue; const id=('agent'in e&&e.agent)||(e as any).to; const n=id&&this.nodes.get(id); if(!n)continue; const pr=age/1700, sx=(n.x-cam.x)*s+w/2, sy=(n.y-cam.y)*s+h/2-(n.r+16)*s-14-pr*16; let txt='', col='#f3c47e'; if(e.type==='tool')txt='⚙ '+e.tool; else if(e.type==='compact'){txt='⇣ compact'; col='#b4a0f2';} else if(e.type==='error'){txt='✕ '+(e.label||'error'); col='#ff7a70';} else if(e.type==='retry'){txt='↻ retry'; col='#84e4c0';} if(!txt)continue; x.globalAlpha=Math.min(1,(1-pr)*1.6); x.font=`500 9.5px 'JetBrains Mono',monospace`; x.shadowColor='rgba(4,13,17,.95)'; x.shadowBlur=4; x.fillStyle=col; x.fillText(txt,sx,sy); x.shadowBlur=0; x.globalAlpha=1;}
  }

  private tlCache: { canvas: HTMLCanvasElement; key: string } | null = null;

  drawTL(t: number) {
    const cv=this.tl, x=this.tctx, eng=this.eng; if(!cv||!x||!eng)return; const dpr=devicePixelRatio||1,w=cv.clientWidth,h=cv.clientHeight; if(cv.width!==Math.round(w*dpr)||cv.height!==Math.round(h*dpr)){cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr);} x.setTransform(dpr,0,0,dpr,0,0); x.clearRect(0,0,w,h); const dur=eng.duration,y=h/2;
    // Event ticks are static per engine state — render once to an offscreen layer, blit per frame.
    const key = `${eng.evs.length}|${dur}|${w}|${h}|${dpr}`;
    if (!this.tlCache || this.tlCache.key !== key) {
      const off = document.createElement('canvas'); off.width = Math.round(w*dpr); off.height = Math.round(h*dpr);
      const ox = off.getContext('2d')!; ox.setTransform(dpr,0,0,dpr,0,0);
      ox.fillStyle='rgba(150,210,230,.08)'; ox.beginPath(); ox.roundRect(1,y-4,w-2,8,4); ox.fill();
      ox.globalAlpha=.75;
      for(const e of eng.evs){const ex=1+(e.t/dur)*(w-2); ox.fillStyle=({spawn:'#72d6ee',message:'rgba(207,230,238,.55)',tool:'#f3c47e',compact:'#b4a0f2',error:'#ff7a70',retry:'#84e4c0',complete:'#84e4c0'} as any)[e.type]||'rgba(200,220,230,.4)'; ox.fillRect(ex,y-8,1.3,16);}
      ox.globalAlpha=1;
      this.tlCache = { canvas: off, key };
    }
    x.drawImage(this.tlCache.canvas, 0, 0, w, h);
    const px=1+(Math.min(dur,Math.max(0,t))/dur)*(w-2), gr=x.createLinearGradient(0,0,px,0); gr.addColorStop(0,'rgba(43,111,133,.55)'); gr.addColorStop(1,'rgba(122,220,242,.75)'); x.fillStyle=gr; x.globalAlpha=.85; x.beginPath(); x.roundRect(1,y-4,Math.max(4,px),8,4); x.fill(); x.globalAlpha=1; x.strokeStyle='rgba(234,247,251,.9)'; x.lineWidth=1.4; x.beginPath(); x.moveTo(px,3); x.lineTo(px,h-3); x.stroke(); x.fillStyle='#eaf7fb'; x.shadowColor='#7adcf2'; x.shadowBlur=8; x.beginPath(); x.arc(px,y,3.4,0,7); x.fill(); x.shadowBlur=0;
  }

  private rgb(hex: string): [number, number, number] { if(!hex.startsWith('#')) return [114,214,238]; const n=parseInt(hex.slice(1),16); return [n>>16&255,n>>8&255,n&255]; }
  private glowSprite(color: string): HTMLCanvasElement { const k='g'+color; if(!this.sprites[k]){const c=document.createElement('canvas'); c.width=c.height=96; const x=c.getContext('2d')!, [r,g,b]=this.rgb(color), gr=x.createRadialGradient(48,48,2,48,48,48); gr.addColorStop(0,`rgba(${r},${g},${b},.55)`); gr.addColorStop(.35,`rgba(${r},${g},${b},.16)`); gr.addColorStop(1,`rgba(${r},${g},${b},0)`); x.fillStyle=gr; x.fillRect(0,0,96,96); this.sprites[k]=c;} return this.sprites[k]; }
  private orbSprite(color: string, r: number, dim: boolean): HTMLCanvasElement { const rr=Math.max(4,Math.round(r)), k='o'+color+'|'+rr+(dim?'d':''); if(!this.sprites[k]){const S=rr*4,c=document.createElement('canvas'); c.width=c.height=S; const x=c.getContext('2d')!, [R,G,B]=this.rgb(color), cx=S/2; const gr=x.createRadialGradient(cx-rr*.35,cx-rr*.45,1,cx,cx,rr*1.8); gr.addColorStop(0,`rgba(255,255,255,${dim ? .28 : .75})`); gr.addColorStop(.22,`rgba(${R},${G},${B},${dim ? .45 : .92})`); gr.addColorStop(.72,`rgba(${Math.max(0,R-70)},${Math.max(0,G-70)},${Math.max(0,B-70)},${dim ? .72 : 1})`); gr.addColorStop(1,'rgba(4,12,16,1)'); x.fillStyle=gr; x.beginPath(); x.arc(cx,cx,rr*1.85,0,7); x.fill(); x.strokeStyle=`rgba(${R},${G},${B},${dim ? .28 : .65})`; x.lineWidth=1.6; x.beginPath(); x.arc(cx,cx,rr*1.78,0,7); x.stroke(); this.sprites[k]=c;} return this.sprites[k]; }
  private curve(x1:number,y1:number,x2:number,y2:number,h:number){const mx=(x1+x2)/2,my=(y1+y2)/2,dx=x2-x1,dy=y2-y1,d=Math.hypot(dx,dy)||1,bend=((h%200)-100)/100*38; return {cx:mx-dy/d*bend,cy:my+dx/d*bend};}
  private qPt(x1:number,y1:number,cx:number,cy:number,x2:number,y2:number,t:number){const a=(1-t)*(1-t),b=2*(1-t)*t,c=t*t; return {x:a*x1+b*cx+c*x2,y:a*y1+b*cy+c*y2};}
  private powerDown(a: EngineAgent, t: number): number { return a.completeT < Infinity ? Math.min(1, Math.max(0, (t - a.completeT) / 1400)) : 0; }
}

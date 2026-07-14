import type { Engine, EngineAgent } from './engine';
import { colorOf, fmt, fmtT, hash, radius, ringColor, statusAt, tokensAt } from './engine';
import type { AwvEvent } from '../shared/schema';
import { cleanLabel, maskProject } from './privacy';

export type LayoutMode = 'organic' | 'radial' | 'fixed';
export type PaletteName = 'Deep Teal' | 'Obsidian' | 'Ink Blue' | 'Void Violet' | 'Carbon';
export type CanvasMode = 'dark' | 'light';

interface PaletteSkin { stops: string[]; vign: string }

export const PALETTES: Record<PaletteName, Record<CanvasMode, PaletteSkin>> = {
  'Deep Teal': {
    dark: { stops: ['#0a2029', '#06141a', '#040d12'], vign: 'rgba(3,10,14,.5)' },
    light: { stops: ['#f4f9fa', '#e9f2f4', '#dce8ec'], vign: 'rgba(176,196,204,.35)' },
  },
  'Obsidian': {
    dark: { stops: ['#151518', '#0a0a0d', '#000000'], vign: 'rgba(0,0,0,.62)' },
    light: { stops: ['#f7f7f8', '#ededf0', '#dfdfe4'], vign: 'rgba(185,185,195,.38)' },
  },
  'Ink Blue': {
    dark: { stops: ['#0a1626', '#050c16', '#01040a'], vign: 'rgba(1,4,10,.58)' },
    light: { stops: ['#f3f7fc', '#e7eef7', '#d8e3f0'], vign: 'rgba(172,190,212,.36)' },
  },
  'Void Violet': {
    dark: { stops: ['#151019', '#0b0710', '#020104'], vign: 'rgba(2,1,5,.6)' },
    light: { stops: ['#f8f5fb', '#efe9f6', '#e2d9ee'], vign: 'rgba(190,178,205,.36)' },
  },
  'Carbon': {
    dark: { stops: ['#1b1b1e', '#101012', '#050506'], vign: 'rgba(0,0,0,.56)' },
    light: { stops: ['#f6f6f7', '#ebebed', '#dcdce0'], vign: 'rgba(182,182,188,.38)' },
  },
};

interface CanvasTheme {
  vignInner: string;
  labelInk: string; labelDim: string; labelShadow: string;
  tokenText: string; tokenHot: string;
  ringRgb: string; pdRgb: string; checkRgb: string; selStroke: string; msgRgb: string; errBang: string;
  haloAlpha: number; haloDarken: number; orbEdge: string;
  tickMessage: string; tickFallback: string;
  tlTrack: string; tlP0: string; tlP1: string; tlLine: string; tlHover: string; tlDot: string; tlGlow: string;
  tlGapFill: string; tlGapHatch: string;
}

const CANVAS_THEMES: Record<CanvasMode, CanvasTheme> = {
  dark: {
    vignInner: 'rgba(4,13,18,0)',
    labelInk: 'rgba(224,242,248,.92)', labelDim: 'rgba(190,215,224,.5)', labelShadow: 'rgba(4,13,17,.9)',
    tokenText: 'rgba(150,200,215,.75)', tokenHot: 'rgba(255,150,140,.9)',
    ringRgb: '200,230,240', pdRgb: '6,16,20', checkRgb: '10,25,30', selStroke: 'rgba(235,250,255,.65)', msgRgb: '232,245,250', errBang: '#fff1ef',
    haloAlpha: 1, haloDarken: 0, orbEdge: 'rgba(4,12,16,1)',
    tickMessage: 'rgba(207,230,238,.55)', tickFallback: 'rgba(200,220,230,.4)',
    tlTrack: 'rgba(150,210,230,.08)', tlP0: 'rgba(43,111,133,.55)', tlP1: 'rgba(122,220,242,.75)',
    tlLine: 'rgba(234,247,251,.9)', tlHover: 'rgba(234,247,251,.3)', tlDot: '#eaf7fb', tlGlow: '#7adcf2',
    tlGapFill: 'rgba(4,11,15,.78)', tlGapHatch: 'rgba(150,210,230,.16)',
  },
  light: {
    vignInner: 'rgba(230,240,244,0)',
    labelInk: 'rgba(18,44,56,.94)', labelDim: 'rgba(60,90,104,.6)', labelShadow: 'rgba(255,255,255,.85)',
    tokenText: 'rgba(55,95,112,.85)', tokenHot: 'rgba(185,45,35,.95)',
    ringRgb: '40,70,84', pdRgb: '225,235,239', checkRgb: '245,252,254', selStroke: 'rgba(20,50,64,.6)', msgRgb: '35,80,98', errBang: '#fff5f3',
    haloAlpha: .3, haloDarken: .45, orbEdge: 'rgba(34,52,60,.92)',
    tickMessage: 'rgba(60,95,110,.5)', tickFallback: 'rgba(70,100,115,.4)',
    tlTrack: 'rgba(40,90,110,.1)', tlP0: 'rgba(14,110,140,.4)', tlP1: 'rgba(11,125,158,.8)',
    tlLine: 'rgba(15,45,58,.85)', tlHover: 'rgba(15,45,58,.3)', tlDot: '#0b6480', tlGlow: 'rgba(14,127,160,.8)',
    tlGapFill: 'rgba(205,220,226,.85)', tlGapHatch: 'rgba(45,90,108,.25)',
  },
};

interface NodeState { id: string; a: EngineAgent; x: number; y: number; vx: number; vy: number; r: number; hov: number; tx?: number; ty?: number }

// Completed agents linger long enough for the completion flash + power-down, fade out, then detach.
const REMOVE_LINGER_MS = 3000;
const REMOVE_FADE_MS = 800;

const TICK_COLOR: Record<string, string> = { spawn: '#72d6ee', tool: '#f3c47e', compact: '#b4a0f2', error: '#ff7a70', retry: '#84e4c0', complete: '#84e4c0' };
const LENS_R = 60;
const LENS_MAG = 2.5;
const NODE_HIT_RADIUS_PX = 22;
const DRAG_THRESHOLD_PX = 10;
const TL_SNAP_PX = 8;

export class VisualRenderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tl?: HTMLCanvasElement;
  tctx?: CanvasRenderingContext2D;
  private tip: HTMLDivElement | null = null;
  eng?: Engine;
  nodes = new Map<string, NodeState>();
  staticPos = new Map<string, { x: number; y: number }>();
  cam = { x: 0, y: 0, s: 1 };
  userCam = false;
  focusId: string | null = null;
  hoverId: string | null = null;
  selectedId: string | null = null;
  railOpen = true;
  /** Live inspector element — measured for the camera gutter (the pane widens when the transcript tab is open). */
  inspectorEl?: HTMLElement;
  layout: LayoutMode = 'organic';
  palette: PaletteName = 'Carbon';
  resolvedTheme: CanvasMode = 'dark';
  canvasStyle: 'match' | 'dark' = 'match';
  glow = 1;
  edgeStyle: 'beams' | 'wires' = 'beams';
  showSubagentNames = true;
  showOrchestratorName = true;
  liveNow?: number;
  reduceMotion = false;
  sprites: Record<string, HTMLCanvasElement> = {};
  /** Last rendered simulation time, used as the base for keyboard scrubbing. */
  private seekAt = 0;
  /** Timeline hover position as a fraction of duration (duration grows live). */
  private tlHover: number | null = null;
  /** Pointer position over the timeline as a width fraction — drives the magnifier lens. */
  private tlPointer: number | null = null;
  private lensAmt = 0;
  private lastAriaT = -1e9;
  private down: {
    x: number;
    y: number;
    moved: number;
    dragging: boolean;
    node: NodeState | null;
    nodeDx: number;
    nodeDy: number;
    cx: number;
    cy: number;
    px: number;
    py: number;
    pt: number;
    pvx: number;
    pvy: number;
  } | null = null;
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
    this.tip = document.createElement('div');
    this.tip.className = 'tl-tip';
    this.tip.hidden = true;
    canvas.parentElement?.append(this.tip);
    const frac = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      if (r.width <= 0) return 0;
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };
    const seek = (e: PointerEvent) => {
      if (!this.eng) return;
      const t = this.eng.warp.t(frac(e));
      this.onSeek?.(this.nearestEvent(t, canvas.getBoundingClientRect().width)?.t ?? t);
    };
    canvas.setAttribute('aria-valuemin', '0');
    canvas.addEventListener('pointerdown', e => {
      e.preventDefault();
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(e.pointerId);
      this.scrub = true;
      this.tlHover = null;
      this.tlPointer = frac(e);
      seek(e);
    });
    canvas.addEventListener('pointermove', e => {
      this.tlPointer = frac(e);
      if (this.scrub) { seek(e); return; }
      this.tlHover = this.tlPointer;
    });
    const endScrub = () => { this.scrub = false; };
    canvas.addEventListener('pointerup', endScrub);
    canvas.addEventListener('pointercancel', endScrub);
    canvas.addEventListener('lostpointercapture', endScrub);
    canvas.addEventListener('pointerleave', () => { this.tlHover = null; this.tlPointer = null; if (this.tip) this.tip.hidden = true; });
    // Keyboard scrubbing: the timeline is exposed as role="slider" tabindex="0".
    // Arrow steps move 2% of *visual* width so each press covers the same distance
    // on screen whether the playhead sits in dense activity or a compressed gap.
    canvas.addEventListener('keydown', e => {
      if (!this.eng) return;
      const dur = this.eng.duration, warp = this.eng.warp, cur = Math.min(dur, Math.max(0, this.seekAt));
      let next: number | null = null;
      if (e.key === 'ArrowRight') next = warp.t(warp.x(cur) + 0.02);
      else if (e.key === 'ArrowLeft') next = warp.t(warp.x(cur) - 0.02);
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

  /** Zoom around the canvas centre by a multiplicative factor (on-canvas +/− buttons). */
  zoomBy(factor: number) {
    // The world transform pins `cam` at the screen centre, so scaling alone keeps the
    // centre fixed — no need to re-anchor cam.x/cam.y.
    this.cam.s = Math.min(3, Math.max(0.12, this.cam.s * factor));
    this.userCam = true; this.focusId = null;
  }

  drawFrame(t: number, dt: number) {
    if (!this.eng) return;
    this.seekAt = t;
    this.syncNodes(t); this.physics(t, dt);
    for (const n of this.nodes.values()) {
      const target = this.hoverId === n.id ? 1 : 0;
      n.hov = this.reduceMotion ? target : n.hov + (target - n.hov) * Math.min(1, dt / 120);
    }
    this.updateCam(); this.draw(t); this.drawTL(t);
  }

  toWorld(px: number, py: number) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return { x: (px - w / 2) / this.cam.s + this.cam.x, y: (py - h / 2) / this.cam.s + this.cam.y };
  }

  private bindCanvas() {
    const el = this.canvas;
    el.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const hit = this.hitTest(e.offsetX, e.offsetY);
      const wp = this.toWorld(e.offsetX, e.offsetY);
      document.body.classList.add('is-canvas-gesturing');
      el.classList.add('dragging');
      this.down = {
        x: e.offsetX, y: e.offsetY, moved: 0, dragging: false,
        node: hit, nodeDx: hit ? hit.x - wp.x : 0, nodeDy: hit ? hit.y - wp.y : 0,
        cx: this.cam.x, cy: this.cam.y, px: e.offsetX, py: e.offsetY, pt: e.timeStamp, pvx: 0, pvy: 0,
      };
    });
    el.addEventListener('pointermove', e => {
      if (this.down) {
        e.preventDefault();
        const dx = e.offsetX - this.down.x, dy = e.offsetY - this.down.y;
        const dist = Math.hypot(dx, dy);
        this.down.moved = Math.max(this.down.moved, dist);
        if (!this.down.dragging && dist >= DRAG_THRESHOLD_PX) {
          this.down.dragging = true;
          this.focusId = null;
        }
        if (this.down.dragging && this.down.node) {
          const n = this.down.node; const w = this.toWorld(e.offsetX, e.offsetY);
          n.x = w.x + this.down.nodeDx; n.y = w.y + this.down.nodeDy; n.vx = 0; n.vy = 0;
          const d = this.down, dtm = e.timeStamp - d.pt;
          if (dtm > 0) {
            const k = .7;
            d.pvx = d.pvx * (1 - k) + ((e.offsetX - d.px) / dtm) * k;
            d.pvy = d.pvy * (1 - k) + ((e.offsetY - d.py) / dtm) * k;
            d.px = e.offsetX; d.py = e.offsetY; d.pt = e.timeStamp;
          }
        } else if (this.down.dragging) {
          this.userCam = true; this.focusId = null;
          this.cam.x = this.down.cx - dx / this.cam.s; this.cam.y = this.down.cy - dy / this.cam.s;
        }
      } else {
        const hit = this.hitTest(e.offsetX, e.offsetY);
        this.hoverId = hit ? hit.id : null;
        el.style.cursor = hit ? 'pointer' : 'default';
      }
    });
    el.addEventListener('pointerup', e => {
      const d = this.down;
      if (d && !d.dragging) {
        this.selectedId = d.node ? d.node.id : null;
        this.onSelect?.(this.selectedId);
      } else if (d?.dragging && d.node && !this.reduceMotion && e.timeStamp - d.pt <= 80) {
        let vx = (d.pvx / this.cam.s) * 16, vy = (d.pvy / this.cam.s) * 16;
        const sp = Math.hypot(vx, vy);
        if (sp > 7) { vx *= 7 / sp; vy *= 7 / sp; }
        d.node.vx = vx; d.node.vy = vy;
      }
      this.clearPointerGesture();
    });
    el.addEventListener('pointercancel', () => this.clearPointerGesture());
    el.addEventListener('lostpointercapture', () => this.clearPointerGesture());
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const dy = Math.max(-240, Math.min(240, e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.canvas.clientHeight : 1)));
      const f = Math.exp(-dy * (e.ctrlKey ? 0.0045 : 0.0013));
      const s2 = Math.min(3, Math.max(0.12, this.cam.s * f));
      const wp = this.toWorld(e.offsetX, e.offsetY);
      this.cam.x = wp.x - (e.offsetX - this.canvas.clientWidth / 2) / s2;
      this.cam.y = wp.y - (e.offsetY - this.canvas.clientHeight / 2) / s2;
      this.cam.s = s2; this.userCam = true; this.focusId = null;
    }, { passive: false });
    el.addEventListener('dblclick', () => this.fit());
  }

  private clearPointerGesture() {
    this.down = null;
    document.body.classList.remove('is-canvas-gesturing');
    this.canvas.classList.remove('dragging');
  }

  private hitTest(px: number, py: number): NodeState | null {
    const wp = this.toWorld(px, py);
    let best: NodeState | null = null, bd = 1e9;
    for (const n of this.nodes.values()) {
      const d = Math.hypot(n.x - wp.x, n.y - wp.y);
      if (d * this.cam.s < Math.max(n.r * this.cam.s + 10, NODE_HIT_RADIUS_PX) && d < bd) { bd = d; best = n; }
    }
    return best;
  }

  /** 0 = fully visible, 1 = fully faded out (node about to be removed). */
  private goneFrac(a: EngineAgent, t: number): number {
    if (a.completeT === Infinity) return 0;
    return Math.min(1, Math.max(0, (t - a.completeT - (REMOVE_LINGER_MS - REMOVE_FADE_MS)) / REMOVE_FADE_MS));
  }

  /** Distinct rest position per root so concurrent sessions never pile onto a shared origin. */
  private rootAnchorX = new Map<string, number>();

  private computeRootAnchors() {
    this.rootAnchorX.clear();
    if (!this.eng) return;
    const roots = this.eng.order.filter(id => !this.eng!.agents.get(id)?.parent);
    roots.forEach((id, i) => this.rootAnchorX.set(id, (i - (roots.length - 1) / 2) * 340));
  }

  private syncNodes(t: number) {
    if (!this.eng) return;
    this.computeRootAnchors();
    for (const a of this.eng.agents.values()) {
      const alive = t >= a.spawnT && (a.completeT === Infinity || t <= a.completeT + REMOVE_LINGER_MS);
      let n = this.nodes.get(a.id);
      if (alive && !n) {
        const p = a.parent && this.nodes.get(a.parent);
        const idx = a.parent ? (this.eng.agents.get(a.parent)?.children.indexOf(a.id) ?? 0) : [...this.nodes.values()].filter(n => !n.a.parent).length;
        const ang = idx * 2.399963 + a.depth * 1.7 + (hash(a.id) % 628) / 100;
        const sp = this.staticPos.get(a.id);
        const useStatic = this.layout === 'fixed' && sp;
        const sx = useStatic ? sp!.x : (p ? p.x + Math.cos(ang) * 55 : (this.rootAnchorX.get(a.id) ?? (idx - 1) * 220));
        const sy = useStatic ? sp!.y : (p ? p.y + Math.sin(ang) * 55 : Math.sin(idx) * 90);
        n = { id: a.id, a, x: sx, y: sy, vx: 0, vy: 0, r: radius(a), hov: 0 };
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
    const dragged = this.down?.dragging && this.down.node ? this.down.node.id : null;
    if (this.layout === 'fixed') {
      for (const n of ns) {
        if (n.id === dragged) continue;
        const target = this.staticPos.get(n.id); if (!target) continue;
        n.vx += (target.x - n.x) * 0.12 * st; n.vy += (target.y - n.y) * 0.12 * st;
        n.vx *= Math.pow(0.55, st); n.vy *= Math.pow(0.55, st); n.x += n.vx * st; n.y += n.vy * st;
      }
      return;
    }
    if (this.layout === 'radial') {
      this.radialLayout();
      for (const n of ns) {
        if (n.id === dragged) continue;
        if (n.tx != null) { n.vx += (n.tx - n.x) * 0.05 * st; n.vy += (n.ty! - n.y) * 0.05 * st; }
        n.vx *= Math.pow(0.7, st); n.vy *= Math.pow(0.7, st); n.x += n.vx * st; n.y += n.vy * st;
      }
      return;
    }
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
      const A = ns[i], B = ns[j]; let dx = B.x - A.x, dy = B.y - A.y, d2 = dx * dx + dy * dy;
      if (d2 < 1) { dx = ((hash(A.id) % 10) - 5) || 1; dy = ((hash(B.id) % 10) - 5) || 1; d2 = dx * dx + dy * dy; }
      const d = Math.sqrt(d2); const rep = (3400 * (A.r + B.r) / 42) / (d2 + 500);
      const fx = dx / d * rep, fy = dy / d * rep;
      if (A.id !== dragged) { A.vx -= fx * st; A.vy -= fy * st; }
      if (B.id !== dragged) { B.vx += fx * st; B.vy += fy * st; }
    }
    for (const n of ns) {
      if (n.id === dragged) { n.vx = 0; n.vy = 0; continue; }
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
        const ax = this.rootAnchorX.get(n.id) ?? 0;
        n.vx += (ax - n.x) * 0.0022 * st; n.vy -= n.y * 0.0022 * st;
      }
      n.vx *= Math.pow(0.87, st); n.vy *= Math.pow(0.87, st);
      const sp = Math.hypot(n.vx, n.vy); if (sp > 7) { n.vx *= 7 / sp; n.vy *= 7 / sp; }
      n.x += n.vx * st; n.y += n.vy * st;
    }
  }

  /** Measured inspector width + its right offset/margin; falls back to the historical 374 (344px pane + 30). */
  private inspectorGutter(): number {
    const el = this.inspectorEl;
    const w = el && !el.hidden ? el.offsetWidth : 0;
    return w > 0 ? w + 30 : 374;
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
    const px0 = this.railOpen ? 282 : 22, px1 = w - (this.selectedId ? this.inspectorGutter() : 22);
    const vw = Math.max(140, px1 - px0), vh = h - 80;
    const ts = Math.min(1.35, Math.max(0.14, Math.min(vw / Math.max(1, x1 - x0), vh / Math.max(1, y1 - y0))));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    // Panels (rail / inspector) are overlays: treat their gutters as *constraints*,
    // not a fixed reservation. Center content on screen by default, then nudge only
    // as far as needed to keep it clear of a panel. This keeps a lone orchestrator
    // dead-centre instead of shoving it ~130px right for a rail that isn't occluding it.
    const halfW = ((x1 - x0) / 2) * ts;
    const leftEdge = w / 2 - halfW, rightEdge = w / 2 + halfW;
    let shiftPx = 0;
    if (leftEdge < px0 && rightEdge > px1) shiftPx = (px0 + px1) / 2 - w / 2; // wider than gap: centre within it
    else if (leftEdge < px0) shiftPx = px0 - leftEdge;                       // clears rail
    else if (rightEdge > px1) shiftPx = -(rightEdge - px1);                  // clears inspector
    const tx = cx - shiftPx / ts;
    this.cam.s += (ts - this.cam.s) * 0.045; this.cam.x += (tx - this.cam.x) * 0.05; this.cam.y += (cy - this.cam.y) * 0.05;
  }

  private draw(t: number) {
    if (!this.eng) return;
    const cv = this.canvas, x = this.ctx, dpr = devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
    const pal = (PALETTES[this.palette] || PALETTES['Carbon'])[this.mode()];
    const bg = x.createRadialGradient(w / 2, h * .28, 40, w / 2, h * .28, Math.max(w, h));
    bg.addColorStop(0, pal.stops[0]); bg.addColorStop(.58, pal.stops[1]); bg.addColorStop(1, pal.stops[2]);
    x.fillStyle = bg; x.fillRect(0, 0, w, h);
    const cam = this.cam, s = cam.s;
    x.save(); x.translate(w / 2, h / 2); x.scale(s, s); x.translate(-cam.x, -cam.y);
    this.drawWorld(t, x);
    x.restore();
    this.drawLabels(t, x, w, h);
    const vg = x.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.38, w / 2, h / 2, Math.max(w, h) * 0.75);
    vg.addColorStop(0, this.theme().vignInner); vg.addColorStop(1, pal.vign); x.fillStyle = vg; x.fillRect(0, 0, w, h);
  }

  /** Effective canvas mode: 'dark' canvasStyle pins the video-editor stage regardless of app theme. */
  mode(): CanvasMode { return this.canvasStyle === 'dark' ? 'dark' : this.resolvedTheme; }
  private theme(): CanvasTheme { return CANVAS_THEMES[this.mode()]; }

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
      // Data transfer: crisp comet particles stream parent→child along active/recent edges.
      const cs = statusAt(n.a, T, this.liveNow);
      if (!this.reduceMotion && (cs === 'active' || recent[n.id] != null) && fade > 0) {
        const spr = this.glowSprite(nc), N = 3, speed = 0.5, dark = this.mode() === 'dark';
        const amp = (cs === 'active' ? 1 : .5) * fade;
        if (dark) x.globalCompositeOperation = 'lighter';
        for (let k = 0; k < N; k++) {
          const fr = (((T / 1000) * speed + k / N) % 1) * end;
          const env = Math.sin(Math.PI * fr) * amp;
          if (env <= .02) continue;
          x.fillStyle = `rgb(${r2},${g2},${b2})`;
          for (let j = 3; j >= 1; j--) {
            const tf = fr - j * .022; if (tf <= 0) continue;
            const q = this.qPt(p.x, p.y, c.cx, c.cy, n.x, n.y, tf);
            x.globalAlpha = env * .35 * (1 - j / 4);
            x.beginPath(); x.arc(q.x, q.y, 1.6 - j * .3, 0, 7); x.fill();
          }
          const q = this.qPt(p.x, p.y, c.cx, c.cy, n.x, n.y, fr);
          const sz = 9 * this.glow;
          if (sz > 1) { x.globalAlpha = env * .6; x.drawImage(spr, q.x - sz / 2, q.y - sz / 2, sz, sz); }
          x.globalAlpha = env;
          x.beginPath(); x.arc(q.x, q.y, 1.8, 0, 7); x.fill();
          x.globalAlpha = env * .9;
          x.fillStyle = dark ? 'rgba(255,255,255,.9)' : `rgb(${Math.max(0, r2 - 60)},${Math.max(0, g2 - 60)},${Math.max(0, b2 - 60)})`;
          x.beginPath(); x.arc(q.x, q.y, .9, 0, 7); x.fill();
          x.fillStyle = `rgb(${r2},${g2},${b2})`;
        }
        x.globalAlpha = 1;
        if (dark) x.globalCompositeOperation = 'source-over';
      }
    }
    this.drawEffects(T, x);
    for (const n of this.nodes.values()) this.drawNode(T, x, n, recent[n.id] != null);
  }

  private drawEffects(T: number, x: CanvasRenderingContext2D) {
    if (!this.eng) return;
    if (this.reduceMotion) return;
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
        const n=this.nodes.get(e.to); if(n){const pr=age/900; x.strokeStyle=`rgba(${this.theme().msgRgb},${(1-pr)*.5})`; x.lineWidth=1.3; x.beginPath(); x.arc(n.x,n.y,n.r+3+pr*26,0,7); x.stroke();}
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
    const a=n.a, gone=this.goneFrac(a,T); if(gone>=1)return; const vis=1-gone, rr=n.r*this.grow(a,T); if(rr<.5)return;
    const col=colorOf(a), status=statusAt(a,T,this.liveNow), tok=tokensAt(a,T), lim=a.def.limit||1000000, pct=Math.min(1,tok/lim), dim=status==='complete'||status==='idle', pd=this.powerDown(a,T), breathe=(status==='active'&&!this.reduceMotion)?1+.08*Math.sin(T/260+hash(a.id)):1;
    const th=this.theme();
    const halo=rr*(4.6+(recent?1.6:0)+n.hov*1.3)*breathe*this.glow*(dim ? .38 : 1)*vis; if(halo>1){const bl=this.mode()==='dark'; if(bl)x.globalCompositeOperation='lighter'; x.drawImage(this.glowSprite(status==='error'?'#ff7a70':col),n.x-halo/2,n.y-halo/2,halo,halo); if(bl)x.globalCompositeOperation='source-over';}
    x.globalAlpha=(status==='idle'?.48:(status==='complete'?.75-pd*.4:1))*vis; x.drawImage(this.orbSprite(status==='error'?'#ff7a70':col,n.r,dim),n.x-rr,n.y-rr,rr*2,rr*2); x.globalAlpha=1;
    if(pd>0&&vis>0){x.fillStyle=`rgba(${th.pdRgb},${pd*.66*vis})`;x.beginPath();x.arc(n.x,n.y,rr,0,7);x.fill();}
    x.strokeStyle=`rgba(${th.ringRgb},${(.13+.14*n.hov)*vis})`; x.lineWidth=1.6; x.beginPath(); x.arc(n.x,n.y,rr+4.5,0,7); x.stroke();
    if(pct>.003){x.strokeStyle=ringColor(pct); x.globalAlpha=(dim ? .4 : .95)*(pct>.85&&status==='active'&&!this.reduceMotion? .6+.4*Math.sin(T/130):1)*vis; x.lineWidth=2.4; x.lineCap='round'; x.beginPath(); x.arc(n.x,n.y,rr+4.5,-Math.PI/2,-Math.PI/2+pct*Math.PI*2); x.stroke(); x.globalAlpha=1; x.lineCap='butt';}
    if(status==='complete'){x.strokeStyle=`rgba(${th.checkRgb},${.85*(1-pd)})`; x.lineWidth=Math.max(1.6,rr*.16); x.lineCap='round'; x.beginPath(); x.moveTo(n.x-rr*.38,n.y+rr*.02); x.lineTo(n.x-rr*.1,n.y+rr*.32); x.lineTo(n.x+rr*.42,n.y-rr*.28); x.stroke(); x.lineCap='butt';}
    if(status==='error'){x.fillStyle=th.errBang; x.font=`700 ${Math.max(9,rr)}px 'JetBrains Mono',monospace`; x.textAlign='center'; x.textBaseline='middle'; x.fillText('!',n.x,n.y+.5);}
    if(this.selectedId===a.id){x.strokeStyle=th.selStroke; x.lineWidth=1.2; x.setLineDash([4,5]); x.lineDashOffset=this.reduceMotion?0:-T/40; x.beginPath(); x.arc(n.x,n.y,rr+10,0,7); x.stroke(); x.setLineDash([]);}
  }

  /** Spawn grow-in: 0→1 over 450ms with easeOutBack overshoot; pure function of sim time so scrubbing both directions stays correct. */
  private grow(a: EngineAgent, t: number): number {
    const p = (t - a.spawnT) / 450;
    if (this.reduceMotion || p >= 1) return 1;
    const q = p - 1, c1 = 1.70158;
    // Floor at .5 so a live/parked agent never collapses to an invisible orb with floating labels.
    return Math.max(0.5, 1 + (c1 + 1) * q * q * q + c1 * q * q);
  }

  private drawLabels(T: number, x: CanvasRenderingContext2D, w: number, h: number) {
    if (!this.eng) return;
    const cam=this.cam, s=cam.s, total=this.nodes.size;
    for (const n of this.nodes.values()) {
      const a=n.a; if(this.goneFrac(a,T)>0)continue;
      const sx=(n.x-cam.x)*s+w/2, sy=(n.y-cam.y)*s+h/2; if(sx<-90||sx>w+90||sy<-70||sy>h+70)continue;
      const sel=this.selectedId===a.id, hov=this.hoverId===a.id;
      const nameOn=a.depth===0?this.showOrchestratorName:this.showSubagentNames;
      const dense=a.depth<=1||total<=20||n.r*s>12;
      const showName=(nameOn&&dense)||sel||hov, showTok=a.depth<=1||sel||hov;
      if(!showName&&!showTok)continue;
      const th=this.theme();
      const status=statusAt(a,T,this.liveNow), tok=tokensAt(a,T), lim=a.def.limit||1000000, pct=Math.min(1,tok/lim), fs=Math.max(8.5,Math.min(13,11*Math.sqrt(s)));
      x.textAlign='center'; x.textBaseline='alphabetic'; x.shadowColor=th.labelShadow; x.shadowBlur=4;
      if(showName){const nm=a.parent?cleanLabel(a.def.name):maskProject(cleanLabel(a.def.name)); x.font=`500 ${fs}px Outfit,sans-serif`; x.fillStyle=status==='complete'||status==='idle'?th.labelDim:th.labelInk; x.fillText(nm,sx,sy-(n.r+10)*s-4);}
      if(showTok){x.font=`500 ${Math.max(7.5,fs*.78)}px 'JetBrains Mono',monospace`; x.fillStyle=pct>.85?th.tokenHot:th.tokenText; x.fillText(`${fmt(tok)} · ${Math.round(pct*100)}%`,sx,sy+(n.r+9)*s+11);} x.shadowBlur=0;
    }
    x.textAlign='center';
    const evs=this.eng.evs;
    for(let i=this.evLowerBound(T-1700);i<evs.length;i++){const e=evs[i];if(e.t>T)break; const age=T-e.t;if(age>1700)continue; const id=('agent'in e&&e.agent)||(e as any).to; const n=id&&this.nodes.get(id); if(!n)continue; const pr=age/1700, sx=(n.x-cam.x)*s+w/2, sy=(n.y-cam.y)*s+h/2-(n.r+16)*s-14-pr*16; let txt='', col='#f3c47e'; if(e.type==='tool')txt='⚙ '+e.tool; else if(e.type==='compact'){txt='⇣ compact'; col='#b4a0f2';} else if(e.type==='error'){txt='✕ '+cleanLabel(e.label||'error'); col='#ff7a70';} else if(e.type==='retry'){txt='↻ retry'; col='#84e4c0';} if(!txt)continue; x.globalAlpha=Math.min(1,(1-pr)*1.6); x.font=`500 9.5px 'JetBrains Mono',monospace`; x.shadowColor=this.theme().labelShadow; x.shadowBlur=4; x.fillStyle=col; x.fillText(txt,sx,sy); x.shadowBlur=0; x.globalAlpha=1;}
  }

  private tlCache: { canvas: HTMLCanvasElement; key: string } | null = null;

  private tick(type: string): string {
    if (type === 'message') return this.theme().tickMessage;
    return TICK_COLOR[type] || this.theme().tickFallback;
  }

  drawTL(t: number) {
    const cv=this.tl, x=this.tctx, eng=this.eng; if(!cv||!x||!eng)return; const dpr=devicePixelRatio||1,w=cv.clientWidth,h=cv.clientHeight; if(cv.width!==Math.round(w*dpr)||cv.height!==Math.round(h*dpr)){cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr);} x.setTransform(dpr,0,0,dpr,0,0); x.clearRect(0,0,w,h); const dur=eng.duration,warp=eng.warp,y=h/2;
    const th=this.theme();
    // Event ticks are static per engine state — render once to an offscreen layer, blit per frame.
    const key = `${eng.evs.length}|${dur}|${w}|${h}|${dpr}|${this.mode()}`;
    if (!this.tlCache || this.tlCache.key !== key) {
      const off = document.createElement('canvas'); off.width = Math.round(w*dpr); off.height = Math.round(h*dpr);
      const ox = off.getContext('2d')!; ox.setTransform(dpr,0,0,dpr,0,0);
      ox.fillStyle=th.tlTrack; ox.beginPath(); ox.roundRect(1,y-4,w-2,8,4); ox.fill();
      ox.globalAlpha=.75;
      for(const e of eng.evs){const ex=1+warp.x(e.t)*(w-2); ox.fillStyle=this.tick(e.type); ox.fillRect(ex,y-8,1.3,16);}
      ox.globalAlpha=1;
      this.tlCache = { canvas: off, key };
      cv.setAttribute('aria-valuemax', String(Math.round(dur / 1000)));
    }
    x.drawImage(this.tlCache.canvas, 0, 0, w, h);
    const lens = this.lensFn(w);
    const px = (lens?.map ?? (p => p))(1 + warp.x(Math.min(dur, Math.max(0, t))) * (w - 2));
    const gr=x.createLinearGradient(0,0,px,0); gr.addColorStop(0,th.tlP0); gr.addColorStop(1,th.tlP1); x.fillStyle=gr; x.globalAlpha=.85; x.beginPath(); x.roundRect(1,y-4,Math.max(4,px),8,4); x.fill(); x.globalAlpha=1;
    if (lens) this.drawLens(x, w, y, lens, px, gr);
    this.drawTLGaps(x, w, y, lens?.map);
    x.strokeStyle=th.tlLine; x.lineWidth=1.4; x.beginPath(); x.moveTo(px,3); x.lineTo(px,h-3); x.stroke(); x.fillStyle=th.tlDot; x.shadowColor=th.tlGlow; x.shadowBlur=8; x.beginPath(); x.arc(px,y,3.4,0,7); x.fill(); x.shadowBlur=0;
    if (this.tlHover != null && !this.scrub) {
      const rawT = warp.t(this.tlHover);
      const ev = this.nearestEvent(rawT, w - 2);
      const ht = ev ? ev.t : rawT;
      const hx = (lens?.map ?? (p => p))(1 + warp.x(ht) * (w - 2));
      x.strokeStyle = th.tlHover; x.lineWidth = 1; x.beginPath(); x.moveTo(hx, 3); x.lineTo(hx, h - 3); x.stroke();
      let label = fmtT(ht);
      if (ev) label += ` · ${ev.type === 'tool' ? ev.tool : ev.type}`;
      else { const g = warp.gaps.find(g => rawT >= g.t0 && rawT < g.t1); if (g) label += ` · ${fmtT(g.t1 - g.t0)} idle`; }
      if (this.tip) {
        this.tip.textContent = label;
        this.tip.style.fontSize = `${(10 + 3.5 * this.lensAmt).toFixed(2)}px`;
        this.tip.hidden = false;
        const half = this.tip.offsetWidth / 2;
        const fw = cv.parentElement?.clientWidth ?? w;
        this.tip.style.left = `${Math.min(fw - half - 4, Math.max(half + 4, cv.offsetLeft + hx))}px`;
      }
    } else if (this.tip) this.tip.hidden = true;
    if (Math.abs(t - this.lastAriaT) >= 1000) {
      this.lastAriaT = t;
      cv.setAttribute('aria-valuenow', String(Math.round(Math.min(dur, Math.max(0, t)) / 1000)));
      cv.setAttribute('aria-valuetext', fmtT(t));
    }
  }

  /**
   * Dock-style fisheye around the pointer: identity outside LENS_R, zero displacement
   * at the cursor itself so pointer position and seek target always agree.
   */
  private lensFn(w: number): { cx: number; map: (p: number) => number } | null {
    if (this.tlPointer == null || this.reduceMotion) { this.lensAmt = 0; return null; }
    this.lensAmt += (1 - this.lensAmt) * 0.25;
    const m = 1 + (LENS_MAG - 1) * this.lensAmt;
    const cx = 1 + this.tlPointer * (w - 2);
    const map = (p: number) => {
      const a = Math.abs(p - cx) / LENS_R;
      if (a >= 1) return p;
      return cx + (p - cx) * (1 + (m - 1) * (1 - a) * (1 - a));
    };
    return { cx, map };
  }

  /** Re-render the tick strip under the lens: magnified spacing and tick height near the cursor. */
  private drawLens(x: CanvasRenderingContext2D, w: number, y: number, lens: { cx: number; map: (p: number) => number }, px: number, gr: CanvasGradient) {
    const eng = this.eng!, warp = eng.warp, evs = eng.evs;
    const x0 = Math.max(1, lens.cx - LENS_R), x1 = Math.min(w - 1, lens.cx + LENS_R);
    if (x1 - x0 < 4) return;
    x.save();
    x.beginPath(); x.rect(x0, y - 13, x1 - x0, 26); x.clip();
    x.clearRect(x0, y - 13, x1 - x0, 26);
    x.fillStyle = this.theme().tlTrack; x.fillRect(x0, y - 4, x1 - x0, 8);
    const tA = warp.t((x0 - 1) / (w - 2)), tB = warp.t((x1 - 1) / (w - 2));
    x.globalAlpha = .75;
    for (let i = this.evLowerBound(tA); i < evs.length; i++) {
      const e = evs[i];
      if (e.t > tB) break;
      const bp = 1 + warp.x(e.t) * (w - 2);
      const d = Math.min(1, Math.abs(bp - lens.cx) / LENS_R);
      const hh = 8 * (1 + 0.5 * this.lensAmt * (1 - d) * (1 - d));
      x.fillStyle = this.tick(e.type);
      x.fillRect(lens.map(bp), y - hh, 1.3, hh * 2);
    }
    x.globalAlpha = 1;
    if (px > x0) { x.fillStyle = gr; x.globalAlpha = .85; x.fillRect(x0, y - 4, Math.min(px, x1) - x0, 8); x.globalAlpha = 1; }
    x.restore();
  }

  /** Hatched axis-break bands over compressed idle stretches, drawn above the progress fill. */
  private drawTLGaps(x: CanvasRenderingContext2D, w: number, y: number, map?: (p: number) => number) {
    const eng = this.eng!;
    for (const g of eng.warp.gaps) {
      let x0 = 1 + eng.warp.x(g.t0) * (w - 2), x1 = 1 + eng.warp.x(g.t1) * (w - 2);
      if (map) { x0 = map(x0); x1 = map(x1); }
      const bw = x1 - x0 - 2;
      if (bw < 2) continue;
      x.save();
      x.beginPath(); x.rect(x0 + 1, y - 5, bw, 10); x.clip();
      x.fillStyle = this.theme().tlGapFill; x.fillRect(x0 + 1, y - 5, bw, 10);
      x.strokeStyle = this.theme().tlGapHatch; x.lineWidth = 1;
      x.beginPath();
      for (let gx = x0 - 8; gx < x1 + 8; gx += 6) { x.moveTo(gx, y + 6); x.lineTo(gx + 8, y - 6); }
      x.stroke();
      x.restore();
    }
  }

  /** Nearest event within `px` pixels of warped time t — pointer landings snap to data. */
  private nearestEvent(t: number, width: number, px = TL_SNAP_PX): AwvEvent | null {
    const eng = this.eng;
    if (!eng || !eng.evs.length) return null;
    const i = this.evLowerBound(t);
    const xt = eng.warp.x(t) * width;
    let best: AwvEvent | null = null, bd = px;
    for (const e of [eng.evs[i - 1], eng.evs[i]]) {
      if (!e) continue;
      const d = Math.abs(eng.warp.x(e.t) * width - xt);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  private rgb(hex: string): [number, number, number] { if(!hex.startsWith('#')) return [114,214,238]; const n=parseInt(hex.slice(1),16); return [n>>16&255,n>>8&255,n&255]; }
  private glowSprite(color: string): HTMLCanvasElement { const th=this.theme(), k='g'+color+'|'+this.mode(); if(!this.sprites[k]){const c=document.createElement('canvas'); c.width=c.height=96; const x=c.getContext('2d')!; let [r,g,b]=this.rgb(color); if(th.haloDarken>0){r=Math.round(r*(1-th.haloDarken)); g=Math.round(g*(1-th.haloDarken)); b=Math.round(b*(1-th.haloDarken));} const gr=x.createRadialGradient(48,48,2,48,48,48); gr.addColorStop(0,`rgba(${r},${g},${b},${(.55*Math.max(th.haloAlpha,.5)).toFixed(3)})`); gr.addColorStop(.35,`rgba(${r},${g},${b},${(.16*th.haloAlpha+.04).toFixed(3)})`); gr.addColorStop(1,`rgba(${r},${g},${b},0)`); x.fillStyle=gr; x.fillRect(0,0,96,96); this.sprites[k]=c;} return this.sprites[k]; }
  private orbSprite(color: string, r: number, dim: boolean): HTMLCanvasElement { const th=this.theme(), rr=Math.max(4,Math.round(r)), k='o'+color+'|'+rr+(dim?'d':'')+'|'+this.mode(); if(!this.sprites[k]){const S=rr*4,c=document.createElement('canvas'); c.width=c.height=S; const x=c.getContext('2d')!, [R,G,B]=this.rgb(color), cx=S/2; const gr=x.createRadialGradient(cx-rr*.35,cx-rr*.45,1,cx,cx,rr*1.8); gr.addColorStop(0,`rgba(255,255,255,${dim ? .28 : .75})`); gr.addColorStop(.22,`rgba(${R},${G},${B},${dim ? .45 : .92})`); gr.addColorStop(.72,`rgba(${Math.max(0,R-70)},${Math.max(0,G-70)},${Math.max(0,B-70)},${dim ? .72 : 1})`); gr.addColorStop(1,th.orbEdge); x.fillStyle=gr; x.beginPath(); x.arc(cx,cx,rr*1.85,0,7); x.fill(); x.strokeStyle=`rgba(${R},${G},${B},${dim ? .28 : .65})`; x.lineWidth=1.6; x.beginPath(); x.arc(cx,cx,rr*1.78,0,7); x.stroke(); this.sprites[k]=c;} return this.sprites[k]; }
  private curve(x1:number,y1:number,x2:number,y2:number,h:number){const mx=(x1+x2)/2,my=(y1+y2)/2,dx=x2-x1,dy=y2-y1,d=Math.hypot(dx,dy)||1,bend=((h%200)-100)/100*38; return {cx:mx-dy/d*bend,cy:my+dx/d*bend};}
  private qPt(x1:number,y1:number,cx:number,cy:number,x2:number,y2:number,t:number){const a=(1-t)*(1-t),b=2*(1-t)*t,c=t*t; return {x:a*x1+b*cx+c*x2,y:a*y1+b*cy+c*y2};}
  private powerDown(a: EngineAgent, t: number): number { return a.completeT < Infinity ? Math.min(1, Math.max(0, (t - a.completeT) / 1400)) : 0; }
}

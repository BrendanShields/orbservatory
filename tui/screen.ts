import {
  createCliRenderer, BoxRenderable, TextRenderable, FrameBufferRenderable, RGBA,
  type CliRenderer, type OptimizedBuffer, type StyledText,
} from '@opentui/core';
import { ACCENT } from './render';

const ORB_W = 18;
const ORB_H = 9;
const SHADES = ' ░▒▓█';

/** Cell-shaded sphere with an orbiting light — the "orb" in orbservatory. */
function drawOrb(fb: OptimizedBuffer, t: number) {
  const bg = RGBA.fromValues(0, 0, 0, 0);
  fb.clear(bg);
  const lx = Math.cos(t), ly = Math.sin(t * 0.7) * 0.6, lz = 0.8;
  const ll = Math.hypot(lx, ly, lz);
  const cx = (ORB_W - 1) / 2, cy = (ORB_H - 1) / 2;
  for (let y = 0; y < ORB_H; y++) {
    for (let x = 0; x < ORB_W; x++) {
      const nx = (x - cx) / (ORB_W / 2), ny = (y - cy) / (ORB_H / 2);
      const d2 = nx * nx + ny * ny;
      if (d2 > 1) continue;
      const nz = Math.sqrt(1 - d2);
      const lum = Math.max(0, (nx * lx + ny * ly + nz * lz) / ll);
      const i = 0.15 + 0.85 * lum ** 1.4;
      const ch = SHADES[Math.min(SHADES.length - 1, Math.floor(i * SHADES.length))];
      fb.setCell(x, y, ch, RGBA.fromValues(0.13 * i + 0.05, 0.83 * i, 0.93 * i, 1), bg);
    }
  }
}

export interface Screen {
  renderer: CliRenderer;
  set(content: StyledText | string): void;
  setTitle(title: string): void;
  /** Columns available to text content inside the panel. */
  textWidth(): number;
  /** Rows available to text content inside the panel. */
  textHeight(): number;
}

/**
 * One bordered panel: optional animated orb pane on the left, text content on
 * the right. OpenTUI owns the alternate screen, resize events, and terminal
 * restore (Ctrl+C via exitOnCtrlC, SIGTERM here).
 */
export async function makeScreen(opts: { onResize: () => void; orb?: boolean; title?: string }): Promise<Screen> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 });
  const panel = new BoxRenderable(renderer, {
    id: 'panel', width: '100%', height: '100%',
    border: true, borderStyle: 'rounded', borderColor: '#334155',
    title: opts.title ?? ' orb ', titleColor: ACCENT, titleAlignment: 'left',
    padding: 1, gap: 2, flexDirection: 'row',
  });
  renderer.root.add(panel);

  let orb: FrameBufferRenderable | null = null;
  if (opts.orb) {
    orb = new FrameBufferRenderable(renderer, { id: 'orb', width: ORB_W, height: ORB_H, flexShrink: 0 });
    panel.add(orb);
    let t = 0;
    setInterval(() => { drawOrb(orb!.frameBuffer, t += 0.12); orb!.requestRender(); }, 100);
  }

  const text = new TextRenderable(renderer, { id: 'screen', flexGrow: 1, height: '100%' });
  panel.add(text);
  renderer.on('resize', opts.onResize);
  process.on('SIGTERM', () => {
    renderer.destroy();
    process.exit(0);
  });
  return {
    renderer,
    set: (content) => { text.content = content; },
    setTitle: (title) => { panel.title = title; },
    textWidth: () => Math.max(20, renderer.width - 4 - (orb ? ORB_W + 2 : 0)),
    textHeight: () => Math.max(4, renderer.height - 4),
  };
}

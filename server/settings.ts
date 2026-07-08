import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import type { Settings } from '../shared/schema';
import { DEFAULT_TIER_THRESHOLDS } from './stats';

export const DEFAULT_SETTINGS: Settings = {
  palette: 'Deep Teal',
  layout: 'organic',
  showGrid: false,
  livenessMs: 5 * 60_000,
  pollMs: 1500,
  contextLimits: {},
  providers: {},
  pricing: {},
  tierThresholds: { ...DEFAULT_TIER_THRESHOLDS },
  port: 8787,
};

export function configDir(): string {
  const override = process.env.CLAUDE_VIZ_CONFIG_DIR;
  if (override) return override;
  const p = platform();
  if (p === 'darwin') return join(homedir(), 'Library', 'Application Support', 'claude-viz');
  if (p === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'claude-viz');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'claude-viz');
}

function settingsFile(): string {
  return join(configDir(), 'settings.json');
}

export class SettingsStore {
  private current: Settings = { ...DEFAULT_SETTINGS };

  async load(): Promise<Settings> {
    try {
      const raw = JSON.parse(await readFile(settingsFile(), 'utf8'));
      this.current = sanitize({ ...DEFAULT_SETTINGS, ...raw });
    } catch {
      this.current = { ...DEFAULT_SETTINGS };
    }
    return this.current;
  }

  get(): Settings {
    return this.current;
  }

  async patch(patch: Partial<Settings>): Promise<Settings> {
    this.current = sanitize({ ...this.current, ...patch });
    await this.persist();
    return this.current;
  }

  private async persist() {
    const dir = configDir();
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.settings.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(this.current, null, 2));
    await rename(tmp, settingsFile());
  }
}

function sanitize(s: Settings): Settings {
  return {
    palette: String(s.palette || DEFAULT_SETTINGS.palette),
    layout: String(s.layout || DEFAULT_SETTINGS.layout),
    showGrid: Boolean(s.showGrid),
    livenessMs: clampNum(s.livenessMs, 10_000, 24 * 3600_000, DEFAULT_SETTINGS.livenessMs),
    pollMs: clampNum(s.pollMs, 250, 60_000, DEFAULT_SETTINGS.pollMs),
    contextLimits: s.contextLimits && typeof s.contextLimits === 'object' ? s.contextLimits : {},
    providers: sanitizeProviders(s.providers),
    pricing: s.pricing && typeof s.pricing === 'object' ? s.pricing : {},
    tierThresholds: sanitizeTiers(s.tierThresholds),
    port: clampNum(s.port, 1, 65_535, DEFAULT_SETTINGS.port),
  };
}

function sanitizeProviders(v: unknown): Record<string, boolean> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'boolean') out[k] = val;
  }
  return out;
}

function sanitizeTiers(t: Settings['tierThresholds'] | undefined): Settings['tierThresholds'] {
  if (!t || typeof t !== 'object') return { ...DEFAULT_TIER_THRESHOLDS };
  return {
    simpleMaxTools: clampNum(t.simpleMaxTools, 0, 10_000, DEFAULT_TIER_THRESHOLDS.simpleMaxTools),
    complexMinSubagents: clampNum(t.complexMinSubagents, 1, 1_000, DEFAULT_TIER_THRESHOLDS.complexMinSubagents),
    complexMinTools: clampNum(t.complexMinTools, 1, 100_000, DEFAULT_TIER_THRESHOLDS.complexMinTools),
  };
}

function clampNum(v: any, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

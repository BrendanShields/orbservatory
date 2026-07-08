import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Settings } from '../shared/schema';

export interface RuntimeConfig {
  port: number;
  root: string;
  pollMs: number;
  livenessMs: number;
  contextLimits: Record<string, number>;
}

export function resolveConfig(settings: Settings): RuntimeConfig {
  const envPort = Number(process.env.PORT);
  return {
    port: Number.isFinite(envPort) && envPort > 0 ? envPort : settings.port,
    root: process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects'),
    pollMs: settings.pollMs,
    livenessMs: settings.livenessMs,
    contextLimits: settings.contextLimits,
  };
}

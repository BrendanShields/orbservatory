import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Settings } from '../shared/schema';

export interface RuntimeConfig {
  port: number;
  host: string;
  root: string;
  pollMs: number;
  livenessMs: number;
  contextLimits: Record<string, number>;
}

export function resolveConfig(settings: Settings): RuntimeConfig {
  const envPort = Number(process.env.PORT);
  return {
    port: Number.isFinite(envPort) && envPort > 0 ? envPort : settings.port,
    // Bind to loopback by default so transcript metadata is never exposed on the
    // LAN. Set HOST=0.0.0.0 to opt into wider binding intentionally.
    host: process.env.HOST || '127.0.0.1',
    root: process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects'),
    pollMs: settings.pollMs,
    livenessMs: settings.livenessMs,
    contextLimits: settings.contextLimits,
  };
}

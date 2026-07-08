#!/usr/bin/env bun
import { spawn } from 'node:child_process';

process.env.NODE_ENV ||= 'production';

const mod = await import('../server/index');
const port = (mod as { port?: number }).port ?? Number(process.env.PORT) ?? 8787;
const url = `http://localhost:${port}`;

if (!process.env.CLAUDE_VIZ_NO_OPEN) openBrowser(url);

function openBrowser(target: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [target], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {
    console.log(`Open ${target} in your browser.`);
  }
}

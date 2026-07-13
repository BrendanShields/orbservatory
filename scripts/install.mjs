#!/usr/bin/env node
// Install orbservatory from a git clone: checks runtimes, installs deps.
// Safe to re-run. Works on macOS, Linux, and Windows.
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const win = process.platform === 'win32';
const has = (cmd) => spawnSync(cmd, ['--version'], { shell: win, stdio: 'ignore' }).status === 0;

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 9)) {
  console.error(`Node ${process.versions.node} is too old — need >= 20.9 (https://nodejs.org)`);
  process.exit(1);
}
const pm = has('pnpm') ? 'pnpm' : 'npm';
console.log(`installing dependencies with ${pm}…`);
execSync(`${pm} install`, { stdio: 'inherit', cwd: root });

const hasBun = has('bun');
if (!hasBun) {
  console.warn(`\nbun not found — only needed for the terminal UIs (orb-stats / orb-tasks). Install it with:
  ${win ? 'powershell -c "irm bun.com/install.ps1 | iex"' : 'curl -fsSL https://bun.com/install | bash'}`);
}

console.log(`
done. run:
  ${pm} start                              # web app at http://localhost:8787
  bun tui/orb-stats.ts --session <id>     # stats TUI (server must be running)${hasBun ? '' : '  [needs bun]'}
  bun tui/orb-tasks.ts --session <id>     # tasks TUI${hasBun ? '' : '  [needs bun]'}
`);

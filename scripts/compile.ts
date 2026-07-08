import { $ } from 'bun';

const ALL = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'windows-x64'];

function current(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return `darwin-${arch}`;
  if (process.platform === 'win32') return 'windows-x64';
  return 'linux-x64';
}

const targets = process.argv.includes('--all') ? ALL : [current()];

for (const t of targets) {
  const out = `dist/claude-viz-${t}${t.startsWith('windows') ? '.exe' : ''}`;
  console.log(`building ${out}`);
  await $`bun build --compile --minify --target=bun-${t} --outfile ${out} scripts/cli.ts`;
}

console.log('done');

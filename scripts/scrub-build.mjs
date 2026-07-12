#!/usr/bin/env node
// next build bakes the build machine's absolute repo path into .next
// (required-server-files.json and friends). The values aren't used for
// resolution at runtime here, but they leak local paths into the published
// tarball — neutralize them before packing.
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const nextDir = join(root, '.next');
const replacement = '/orbservatory';
let patched = 0;
let mapsRemoved = 0;

async function walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'cache' || ent.name === 'dev') continue;
      await walk(p);
      continue;
    }
    if (ent.name.endsWith('.map')) {
      // pnpm pack does not honour `!.next/**/*.map` in the files list.
      await rm(p, { force: true });
      mapsRemoved++;
      continue;
    }
    if (!/\.(json|js)$/.test(ent.name)) continue;
    const text = await readFile(p, 'utf8').catch(() => null);
    if (!text || !text.includes(root)) continue;
    await writeFile(p, text.replaceAll(root, replacement));
    patched++;
  }
}

await walk(nextDir);
console.log(`[scrub-build] neutralized build path in ${patched} file(s), removed ${mapsRemoved} sourcemap(s)`);

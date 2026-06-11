// Bundles bench/compare.ts (which imports avocado's real .ts modules) into a
// runnable .mjs, then executes it with --expose-gc for stable allocation
// measurement. One command: `npm run bench`.
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const genDir = join(here, '.gen');
const out = join(genDir, 'compare.mjs');

await rm(genDir, { recursive: true, force: true });
await mkdir(genDir, { recursive: true });

await esbuild.build({
  entryPoints: [join(here, 'compare.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
});

const res = spawnSync(process.execPath, [out], { stdio: 'inherit' });
await rm(genDir, { recursive: true, force: true });
process.exit(res.status ?? 0);

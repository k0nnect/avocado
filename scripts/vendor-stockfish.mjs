// avocado engine vendor step — pulls a real Stockfish wasm build into
// vendor/stockfish/ so the extension runs 100% locally (no network at runtime).
//
// Source: the `stockfish` npm package (nmrugg/stockfish.js), Stockfish 18.
// We vendor three self-contained builds (each embeds its NNUE net — no separate
// weight files to manage):
//   - stockfish-18-lite.js        multi-threaded + SIMD, ~7MB   (DEFAULT)
//   - stockfish-18.js             multi-threaded + SIMD, full net ~113MB (MAX)
//   - stockfish-18-lite-single.js single-threaded fallback for low-core/non-isolated
//
// Run: `npm run vendor`  (one time; commit the result).
//
// We fetch the npm tarball via `npm pack` into a temp dir, extract, and copy the
// bin/ files. No new dependency — uses npm + tar already on the system.

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, cp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dest = join(root, 'vendor', 'stockfish');

const BUILDS = [
  'stockfish-18-lite.js',
  'stockfish-18-lite.wasm',
  'stockfish-18-lite-single.js',
  'stockfish-18-lite-single.wasm',
  // The full 113MB net build is optional — uncomment to vendor MAX strength:
  // 'stockfish-18.js',
  // 'stockfish-18.wasm',
];

const tmp = await mkdtemp(join(tmpdir(), 'avocado-sf-'));
try {
  console.log('avocado: fetching stockfish npm tarball…');
  const tgz = execFileSync('npm', ['pack', 'stockfish', '--silent'], { cwd: tmp })
    .toString()
    .trim()
    .split('\n')
    .pop();
  execFileSync('tar', ['xzf', tgz], { cwd: tmp });

  const binDir = join(tmp, 'package', 'bin');
  const present = new Set(await readdir(binDir));

  await mkdir(dest, { recursive: true });
  for (const f of BUILDS) {
    if (!present.has(f)) {
      console.warn(`  [warn] ${f} not in package — skipping`);
      continue;
    }
    await cp(join(binDir, f), join(dest, f));
    console.log(`  vendored ${f}`);
  }

  // Also copy the license alongside the binaries (GPLv3 — keep it with them).
  const copying = join(tmp, 'package', 'Copying.txt');
  await cp(copying, join(dest, 'Copying.txt')).catch(() => {});

  console.log(`avocado: stockfish vendored → vendor/stockfish/`);
  console.log('  default build: stockfish-18-lite.js (multi-threaded, SIMD, net embedded)');
} finally {
  await rm(tmp, { recursive: true, force: true });
}

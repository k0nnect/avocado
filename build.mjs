// avocado build — esbuild bundles each entry point into dist/, then we copy
// static assets (manifest, html, css, icons, vendored stockfish) verbatim.
// One dependency (esbuild), no framework. `node build.mjs [--watch]`.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');

// Each value becomes dist/<key>.js. Workers are bundled as separate entry
// points because they run in their own realm and can't share a chunk.
const entries = {
  'content/main': 'src/content/main.ts',
  'background/service-worker': 'src/background/service-worker.ts',
  'offscreen/engine-host': 'src/offscreen/engine-host.ts',
  'offscreen/engine-worker': 'src/offscreen/engine-worker.ts',
  'popup/popup': 'src/popup/popup.ts',
};

/** Copy a path if it exists; silently skip if not (e.g. vendor not yet pulled). */
async function copyIfPresent(from, to) {
  try {
    await access(from);
  } catch {
    return false;
  }
  await cp(from, to, { recursive: true });
  return true;
}

async function copyStatic() {
  await cp(join(root, 'manifest.json'), join(dist, 'manifest.json'));
  await mkdir(join(dist, 'popup'), { recursive: true });
  await mkdir(join(dist, 'offscreen'), { recursive: true });
  await mkdir(join(dist, 'content'), { recursive: true });
  await cp(join(root, 'src/popup/popup.html'), join(dist, 'popup/popup.html'));
  await cp(join(root, 'src/offscreen/offscreen.html'), join(dist, 'offscreen/offscreen.html'));
  await cp(join(root, 'src/content/overlay.css'), join(dist, 'content/overlay.css'));
  await copyIfPresent(join(root, 'icons'), join(dist, 'icons'));
  const hadVendor = await copyIfPresent(join(root, 'vendor/stockfish'), join(dist, 'vendor/stockfish'));
  if (!hadVendor) {
    console.warn('  [warn] vendor/stockfish missing — run `npm run vendor` before loading the extension.');
  }
}

const buildOptions = {
  entryPoints: Object.fromEntries(
    Object.entries(entries).map(([out, src]) => [out, join(root, src)]),
  ),
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
  // The engine worker is its own entry point; keep esbuild from trying to
  // re-bundle it when it sees `new Worker(new URL('./engine-worker.js', …))`.
  // The vendored stockfish glue is referenced only via runtime URL strings, so
  // esbuild never touches it.
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.rebuild();
  await copyStatic();
  await ctx.watch();
  console.log('avocado: watching for changes…');
} else {
  await esbuild.build(buildOptions);
  await copyStatic();
  console.log('avocado: build complete → dist/');
}

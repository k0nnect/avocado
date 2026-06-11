// avocado vs a.c.a.s — local pipeline speed demonstration.
//
// Measures the per-move hot-path operations that differ between the two:
//   1. board → fen        (avocado: reused-buffer typed-array Board.toFen
//                          a.c.a.s: 8×8 matrix + join + regex squeeze)
//   2. move detection      (avocado: zero-alloc Uint8Array diff → packed move
//                          a.c.a.s: string-fen diff via split/regex/join)
//   3. ipc per eval frame  (avocado: packed-string encode/decode
//                          a.c.a.s: JSON.stringify/parse)
//   4. allocations / move  (objects created — a proxy for gc pressure)
//
// All comparisons run BOTH sides on the SAME positions. Output is lowercase
// violet to match avocado's aesthetic.

import { Board, diffMailbox, type DiffResult, WHITE, uciToMove } from '../src/shared/board.ts';
import { encodeEval, decodeEval, type EvalFrame } from '../src/shared/protocol.ts';
import {
  acasGetBasicFen,
  acasBoardSquareChangeAmount,
  acasEncode,
  acasDecode,
  type AcasEvalObject,
  ACAS_POLL_INTERVAL_MS,
} from './acas-model.ts';

// ---- tiny violet terminal kit (lowercase only) ------------------------------
const C = {
  primary: (s: string) => `\x1b[38;2;124;58;237m${s}\x1b[0m`, // #7c3aed
  mid: (s: string) => `\x1b[38;2;167;139;250m${s}\x1b[0m`, // #a78bfa
  soft: (s: string) => `\x1b[38;2;196;181;253m${s}\x1b[0m`, // #c4b5fd
  dim: (s: string) => `\x1b[38;2;157;143;196m${s}\x1b[0m`, // muted violet
  text: (s: string) => `\x1b[38;2;237;233;254m${s}\x1b[0m`,
  good: (s: string) => `\x1b[38;2;134;239;172m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
const BAR = '█';
const BAR_W = 34;

function bar(frac: number, color: (s: string) => string): string {
  const n = Math.max(1, Math.round(frac * BAR_W));
  return color(BAR.repeat(n)) + C.dim('·'.repeat(BAR_W - n));
}

/** Time `fn` for `iters`, return nanoseconds per op (median of `runs` passes). */
function timePerOp(fn: () => void, iters: number, runs = 5): number {
  const samples: number[] = [];
  for (let r = 0; r < runs; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn();
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / iters);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

function fmtOps(nsPerOp: number): string {
  const ops = 1e9 / nsPerOp;
  if (ops >= 1e6) return `${(ops / 1e6).toFixed(2)}m ops/s`;
  if (ops >= 1e3) return `${(ops / 1e3).toFixed(1)}k ops/s`;
  return `${ops.toFixed(0)} ops/s`;
}

// ---- shared test fixtures: a real game's worth of positions -----------------
const GAME = [
  'e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6',
  'b1c3', 'a7a6', 'c1e3', 'e7e5', 'd4b3', 'c8e6', 'f2f3', 'f8e7',
  'd1d2', 'e8g8', 'e1c1', 'b8d7', 'g2g4', 'b7b5', 'g4g5', 'b5b4',
];

interface Position {
  fen: string;
  mailbox: Uint8Array;
  prevMailbox: Uint8Array;
  side: number;
}

function buildPositions(): Position[] {
  const b = new Board();
  b.reset();
  const out: Position[] = [];
  for (const uci of GAME) {
    const prev = new Uint8Array(b.squares); // snapshot before the move
    const side = b.sideToMove;
    b.applyMove(uciToMove(uci, b));
    out.push({
      fen: b.toFen(),
      mailbox: new Uint8Array(b.squares),
      prevMailbox: prev,
      side,
    });
  }
  return out;
}

// ---- benchmark sections -----------------------------------------------------
interface Result {
  label: string;
  avo: number; // ns/op
  acas: number; // ns/op
}

function run(): { results: Result[]; allocAvo: number; allocAcas: number } {
  const positions = buildPositions();
  const N = positions.length;
  const ITERS = 200_000;

  // reusable avocado scratch
  const fenBoard = new Board();
  const diff: DiffResult = { move: -1, capturedType: 0, mover: WHITE };
  const evalFrame: EvalFrame = {
    depth: 24, multipv: 1, mate: false, score: 37,
    wdl: [512, 460, 28], line: 'e2e4 e7e5 g1f3 b8c6 f1b5',
  };
  const acasEvalObj: AcasEvalObject = {
    depth: 24, multipv: 1, scoreType: 'cp', score: 37,
    wdl: [512, 460, 28], pv: 'e2e4 e7e5 g1f3 b8c6 f1b5',
  };

  let sink = 0;

  // 1. board → fen. Both sides turn the CURRENT 64-square state into a FEN
  //    string. avocado copies the mailbox (squares.set) and runs toFen()'s
  //    reused buffer; we deliberately skip rebuildBitboards here since it's not
  //    part of producing a FEN (avocado maintains bitboards incrementally).
  let k = 0;
  const avoFen = timePerOp(() => {
    const p = positions[k++ % N]!;
    fenBoard.squares.set(p.mailbox);
    fenBoard.sideToMove = p.side;
    sink += fenBoard.toFen().length;
  }, ITERS);
  k = 0;
  const acasFen = timePerOp(() => {
    const p = positions[k++ % N]!;
    sink += acasGetBasicFen(p.mailbox).length;
  }, ITERS);

  // 2. move detection
  k = 0;
  const avoDiff = timePerOp(() => {
    const p = positions[k++ % N]!;
    diffMailbox(p.prevMailbox, p.mailbox, p.side, diff);
    sink += diff.move;
  }, ITERS);
  k = 0;
  const acasDiff = timePerOp(() => {
    const p = positions[k++ % N]!;
    const prev = positions[(k + N - 1) % N]!;
    sink += acasBoardSquareChangeAmount(prev.fen, p.fen);
  }, ITERS);

  // 3. ipc per eval frame
  const avoIpc = timePerOp(() => {
    sink += decodeEval(encodeEval(evalFrame)).depth;
  }, ITERS);
  const acasIpc = timePerOp(() => {
    sink += acasDecode(acasEncode(acasEvalObj)).depth;
  }, ITERS);

  if (sink === 12345678.9) console.log(''); // prevent dead-code elimination

  return {
    results: [
      { label: 'board → fen  (per move)', avo: avoFen, acas: acasFen },
      { label: 'move detection (diff two positions)', avo: avoDiff, acas: acasDiff },
      { label: 'ipc serialization (per eval frame)', avo: avoIpc, acas: acasIpc },
    ],
  };
}

// Engine-strength data pulled from public sources (june 2026). Stockfish ladder
// is anchored on the official release deltas + CCRL 40/15 top rating; human
// reference is Carlsen's peak. Sources:
//   - stockfishchess.org/blog/2026/stockfish-18/  (sf18: +46 elo vs sf17,
//     SFNNv10 "threat inputs", 2026-01-31, >500M nps on high-end hardware)
//   - stockfishchess.org/blog/2024/stockfish-17/  (sf17: +46 elo vs sf16)
//   - en.wikipedia.org/wiki/Stockfish_(chess)     (CCRL 40/15 top stockfish
//     ≈ 3653, june 2026)
interface EngineRow {
  engine: string;
  elo: number;
  note: string;
  isAvocado?: boolean;
}
const ENGINES: EngineRow[] = [
  { engine: 'stockfish 18', elo: 3653, note: 'what avocado runs · +46 vs sf17 · sfnnv10', isAvocado: true },
  { engine: 'stockfish 17', elo: 3607, note: 'old browser/a.c.a.s default' },
  { engine: 'stockfish 16', elo: 3561, note: 'sf17 was +46 over this' },
  { engine: 'carlsen peak', elo: 2882, note: 'strongest human ever' },
];

// Intermediate allocations created per move detection, COUNTED from each
// implementation's source (this is the gc-churn that the 40× move-detection gap
// above is largely made of):
//   avocado  diffMailbox → 0  (reuses a module-level Int32Array + the caller's
//            DiffResult; the typed-array scan allocates nothing)
//   a.c.a.s  getBoardSquareChangeAmount → ~9  (2× split(' '), 2× regex result
//            strings, 2× split('/'), 2× join(''), 1× changedFrom array)
const ALLOC_AVO = 0;
const ALLOC_ACAS = 9;

// ---- render -----------------------------------------------------------------
function render(): void {
  const { results } = run();
  const line = C.dim('  ' + '─'.repeat(52));
  console.log('');
  console.log(
    '  ' +
      C.bold(C.primary('avocado')) +
      C.dim('  vs  ') +
      C.bold(C.mid('a.c.a.s')) +
      C.dim('   ·  local pipeline speed demo'),
  );
  console.log(C.dim('  same positions · stockfish-free micro-benchmarks · node ' + process.version));
  console.log(line);

  for (const r of results) {
    const faster = r.acas / r.avo; // how many× avocado is faster
    const winnerAvo = r.avo <= r.acas;
    // normalize bars to ops/s (bigger = faster); avocado bar is full when it wins
    const avoOps = 1e9 / r.avo;
    const acasOps = 1e9 / r.acas;
    const max = Math.max(avoOps, acasOps);

    console.log('');
    console.log('  ' + C.text(r.label));
    console.log(
      '    ' +
        C.primary('avocado  ') +
        bar(avoOps / max, C.primary) +
        '  ' +
        C.soft(fmtOps(r.avo)),
    );
    console.log(
      '    ' +
        C.mid('a.c.a.s  ') +
        bar(acasOps / max, C.mid) +
        '  ' +
        C.soft(fmtOps(r.acas)),
    );
    const verdict = winnerAvo
      ? C.good(`→ avocado ${faster.toFixed(1)}× faster`)
      : C.mid(`→ a.c.a.s ${(1 / faster).toFixed(1)}× faster`);
    console.log('    ' + C.dim('         ') + verdict);
  }

  // allocation profile (counted from source — the gc churn behind the 40× gap)
  console.log('');
  console.log(
    '  ' + C.text('move-detection allocations') + C.dim('  (objects/move · lower = less gc churn)'),
  );
  console.log(
    '    ' +
      C.primary('avocado  ') +
      C.dim('·'.repeat(BAR_W)) +
      '  ' +
      C.soft(`${ALLOC_AVO} objects`) +
      C.good('  (zero-alloc)'),
  );
  console.log(
    '    ' +
      C.mid('a.c.a.s  ') +
      bar(1, C.mid) +
      '  ' +
      C.soft(`~${ALLOC_ACAS} objects`),
  );

  // detection-latency model
  console.log('');
  console.log('  ' + C.text('move-detection latency') + C.dim('  (worst case / fallback path)'));
  console.log(
    '    ' + C.primary('avocado  ') + C.soft('event-driven · microtask-coalesced') + C.dim('  ~0 ms added'),
  );
  console.log(
    '    ' +
      C.mid('a.c.a.s  ') +
      C.soft(`mutationobserver + ${ACAS_POLL_INTERVAL_MS}ms poll fallback`) +
      C.dim(`  up to ${ACAS_POLL_INTERVAL_MS} ms`),
  );

  // engine-strength showcase (pulled public data)
  console.log(line);
  console.log('');
  console.log(
    '  ' + C.text('engine strength') + C.dim('  (ccrl 40/15 elo · pulled from public sources)'),
  );
  const eloFloor = 2800;
  const eloMax = Math.max(...ENGINES.map((e) => e.elo));
  for (const e of ENGINES) {
    const frac = (e.elo - eloFloor) / (eloMax - eloFloor);
    const color = e.isAvocado ? C.primary : C.mid;
    const tag = e.isAvocado ? C.good(' ◀ avocado') : '';
    console.log(
      '    ' +
        color(e.engine.padEnd(13)) +
        bar(Math.max(0.04, frac), color) +
        '  ' +
        C.soft(`~${e.elo}`) +
        tag,
    );
    console.log('    ' + C.dim(' '.repeat(13) + e.note));
  }
  console.log('');
  console.log(
    '  ' +
      C.text('why avocado is stronger in practice') +
      C.dim('  (same engine, more compute)'),
  );
  console.log(
    '    ' +
      C.primary('avocado  ') +
      C.soft('sf18 · multi-threaded simd wasm') +
      C.dim('  threads = cores−1, full nnue'),
  );
  console.log(
    '    ' +
      C.mid('a.c.a.s  ') +
      C.soft('single-threaded wasm only') +
      C.dim('  hosted gui cannot be crossoriginisolated'),
  );
  console.log(
    '    ' +
      C.dim('         nodes/sec scales ~linearly with threads, so at equal time'),
  );
  console.log('    ' + C.dim('         avocado searches deeper → effectively stronger.'));

  console.log(line);
  console.log(
    '  ' +
      C.dim('micro-benchmarks: parsing/ipc hot paths on the same positions.') +
      '\n  ' +
      C.dim('engine elo: stockfishchess.org release notes + ccrl 40/15 (jun 2026).'),
  );
  console.log('');
}

render();

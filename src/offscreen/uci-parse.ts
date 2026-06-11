// avocado UCI output parser — pure, zero-copy, and unit-tested against real
// Stockfish 18 output. Kept separate from engine-worker so it can be tested
// without a live engine or the ring buffer.
//
// Scans for keyword positions with indexOf and slices only the needed numbers;
// no String.split, no regex. Returns into a caller-supplied frame to stay
// allocation-free on the hot path.

import type { EvalFrame } from '../shared/protocol.ts';

/** If `line` is "bestmove <uci> …", return the uci move; else null. */
export function parseBestMove(line: string): string | null {
  if (line.charCodeAt(0) !== 98 /* 'b' */ || !line.startsWith('bestmove')) return null;
  const sp = line.indexOf(' ');
  if (sp === -1) return null;
  const end = line.indexOf(' ', sp + 1);
  return end === -1 ? line.slice(sp + 1) : line.slice(sp + 1, end);
}

/**
 * Parse an `info … pv …` line into `out`. Returns out on success, or null if the
 * line isn't an info line with both a score and a pv. Mutates `out` in place.
 */
export function parseInfoLine(line: string, out: EvalFrame): EvalFrame | null {
  if (line.charCodeAt(0) !== 105 /* 'i' */ || !line.startsWith('info ')) return null;

  const pvIdx = line.indexOf(' pv ');
  if (pvIdx === -1) return null;
  const scoreIdx = line.indexOf(' score ');
  if (scoreIdx === -1) return null;

  const depth = readIntAfter(line, ' depth ');
  if (depth < 0) return null;
  const mpv = readIntAfter(line, ' multipv ');
  out.depth = depth;
  out.multipv = mpv < 0 ? 1 : mpv;

  // "score cp 37" | "score mate -4"
  const sAfter = scoreIdx + 7;
  if (line.charCodeAt(sAfter) === 99 /* 'c' */) {
    out.mate = false;
    out.score = parseInt(line.slice(sAfter + 3), 10);
  } else {
    out.mate = true;
    out.score = parseInt(line.slice(sAfter + 5), 10);
  }

  // optional "wdl 512 460 28" (only when it precedes pv)
  const wdlIdx = line.indexOf(' wdl ');
  if (wdlIdx !== -1 && wdlIdx < pvIdx) {
    let i = wdlIdx + 5;
    const w = parseInt(line.slice(i), 10);
    i = line.indexOf(' ', i) + 1;
    const d = parseInt(line.slice(i), 10);
    i = line.indexOf(' ', i) + 1;
    const l = parseInt(line.slice(i), 10);
    out.wdl = [w, d, l];
  } else {
    out.wdl = null;
  }

  out.line = line.slice(pvIdx + 4);
  return out;
}

function readIntAfter(line: string, key: string): number {
  const i = line.indexOf(key);
  if (i === -1) return -1;
  return parseInt(line.slice(i + key.length), 10);
}

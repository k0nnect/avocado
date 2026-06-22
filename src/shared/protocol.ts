// avocado wire protocol — the ONLY serialization code in the system.
//
// Two boundaries carry data:
//   1. content script  ⇄  service worker  ⇄  offscreen host   (chrome Ports)
//   2. offscreen host   ⇄  engine worker                       (SAB ring buffer)
//
// Both carry short packed strings, never JSON. A frame is a single-char opcode,
// then ':'-delimited fields. This avoids JSON.parse/stringify entirely and keeps
// each message to a handful of bytes — structured-clone of a short string across
// the Port boundary is microseconds; the ring buffer carries raw UTF-8 bytes.
//
// Frame grammar (all examples literal):
//   position frame  →  "p:<fen>:<context>:<safeArrows0|1>"
//   analyse control →  "a:<multipv>:<hashMb>:<threads>"   (engine config push)
//   stop            →  "x"
//   eval frame      →  "e:<depth>:<multipv>:<scoreType>:<score>:<wdl>:<nps>:<line>"
//                        scoreType = 'c' (centipawns) | 'm' (mate in N, signed)
//                        wdl = "w/d/l" permille or "-" if unavailable
//                        nps = nodes/sec (0 if the engine didn't report it)
//                        line = space-joined UCI moves (pv), first = best move
//   bestmove        →  "b:<uci>"
//   ready / id      →  "r"     (engine booted & configured)
//   log (debug)     →  "l:<text>"

export const enum Op {
  Position = 'p',
  Analyse = 'a',
  Stop = 'x',
  Eval = 'e',
  BestMove = 'b',
  Ready = 'r',
  Log = 'l',
}

export type GameContext = 'playing' | 'spectating' | 'analysis' | 'bot' | 'unknown';

export interface PositionFrame {
  fen: string;
  context: GameContext;
  safeArrows: boolean;
}

export interface EvalFrame {
  depth: number;
  multipv: number; // 1-based rank of this line
  mate: boolean;
  score: number; // centipawns (mate=false) or signed mate distance (mate=true)
  wdl: readonly [number, number, number] | null; // win/draw/loss permille
  nps: number; // nodes/sec (0 if the engine didn't report it)
  line: string; // space-joined UCI pv, line.split(' ')[0] = best move
}

const CTX_CODE: Record<GameContext, string> = {
  playing: 'p',
  spectating: 's',
  analysis: 'a',
  bot: 'b',
  unknown: 'u',
};
const CODE_CTX: Record<string, GameContext> = {
  p: 'playing',
  s: 'spectating',
  a: 'analysis',
  b: 'bot',
  u: 'unknown',
};

// ---- encode -----------------------------------------------------------------

export function encodePosition(f: PositionFrame): string {
  return `p:${f.fen}:${CTX_CODE[f.context]}:${f.safeArrows ? 1 : 0}`;
}

export function encodeAnalyse(multipv: number, hashMb: number, threads: number): string {
  return `a:${multipv}:${hashMb}:${threads}`;
}

export function encodeStop(): string {
  return 'x';
}

export function encodeEval(f: EvalFrame): string {
  const st = f.mate ? 'm' : 'c';
  const wdl = f.wdl ? `${f.wdl[0]}/${f.wdl[1]}/${f.wdl[2]}` : '-';
  return `e:${f.depth}:${f.multipv}:${st}:${f.score}:${wdl}:${f.nps}:${f.line}`;
}

export function encodeBestMove(uci: string): string {
  return `b:${uci}`;
}

// ---- decode -----------------------------------------------------------------
// Decoders avoid String.split on the hot eval path by scanning for ':' with
// indexOf and slicing only the fields that vary in count (the pv line is the
// tail, so it can contain no ':' — UCI never does).

export function decodePosition(s: string): PositionFrame {
  // p:<fen>:<ctx>:<safe>   — fen has no ':'; split from both ends.
  const last = s.lastIndexOf(':');
  const prev = s.lastIndexOf(':', last - 1);
  const fen = s.slice(2, prev);
  const ctx = s.slice(prev + 1, last);
  const safe = s.charCodeAt(last + 1) === 49; // '1'
  return { fen, context: CODE_CTX[ctx] ?? 'unknown', safeArrows: safe };
}

export function decodeAnalyse(s: string): { multipv: number; hashMb: number; threads: number } {
  const a = s.indexOf(':');
  const b = s.indexOf(':', a + 1);
  const c = s.indexOf(':', b + 1);
  return {
    multipv: parseInt(s.slice(a + 1, b), 10),
    hashMb: parseInt(s.slice(b + 1, c), 10),
    threads: parseInt(s.slice(c + 1), 10),
  };
}

/**
 * Decode an eval frame. The pv `line` is the final field and is returned as a
 * raw slice (no split) so the caller can read line.split(' ')[0] lazily.
 */
export function decodeEval(s: string): EvalFrame {
  // e:depth:multipv:st:score:wdl:nps:line
  let i = 2;
  const i2 = s.indexOf(':', i);
  const depth = parseInt(s.slice(i, i2), 10);
  i = i2 + 1;
  const i3 = s.indexOf(':', i);
  const multipv = parseInt(s.slice(i, i3), 10);
  i = i3 + 1;
  const st = s[i]; // single char
  i += 2; // skip "<st>:"
  const i5 = s.indexOf(':', i);
  const score = parseInt(s.slice(i, i5), 10);
  i = i5 + 1;
  const i6 = s.indexOf(':', i);
  const wdlRaw = s.slice(i, i6);
  i = i6 + 1;
  const i7 = s.indexOf(':', i);
  const nps = parseInt(s.slice(i, i7), 10);
  const line = s.slice(i7 + 1);
  let wdl: [number, number, number] | null = null;
  if (wdlRaw !== '-') {
    const p = wdlRaw.indexOf('/');
    const q = wdlRaw.indexOf('/', p + 1);
    wdl = [
      parseInt(wdlRaw.slice(0, p), 10),
      parseInt(wdlRaw.slice(p + 1, q), 10),
      parseInt(wdlRaw.slice(q + 1), 10),
    ];
  }
  return { depth, multipv, mate: st === 'm', score, wdl, nps, line };
}

export function decodeBestMove(s: string): string {
  return s.slice(2);
}

/** Cheap opcode peek without decoding the rest. */
export function opOf(s: string): string {
  return s[0]!;
}

import { describe, it, expect } from 'vitest';
import { parseInfoLine, parseBestMove } from '../src/offscreen/uci-parse.ts';
import type { EvalFrame } from '../src/shared/protocol.ts';

// These are VERBATIM Stockfish 18 lite output lines captured by running the
// vendored engine on the position after 1.e4 (depth 14, MultiPV 3, ShowWDL on).
const REAL = [
  'info depth 14 seldepth 27 multipv 1 score cp -31 wdl 7 928 65 nodes 330510 nps 1551690 hashfull 113 time 213 pv e7e6 d2d4 d7d5 b1c3 g8f6 e4e5',
  'info depth 14 seldepth 27 multipv 2 score cp -35 wdl 6 918 76 nodes 330510 nps 1551690 hashfull 113 time 213 pv e7e5 g1f3 g8f6 d2d4',
  'info depth 14 seldepth 25 multipv 3 score cp -41 wdl 4 901 95 nodes 330510 nps 1551690 hashfull 113 time 213 pv c7c5 g1f3 d7d6',
];

function frame(): EvalFrame {
  return { depth: 0, multipv: 1, mate: false, score: 0, wdl: null, line: '' };
}

describe('parseInfoLine on real Stockfish 18 output', () => {
  it('parses multipv 1 with cp score, wdl, and pv', () => {
    const f = parseInfoLine(REAL[0], frame())!;
    expect(f.depth).toBe(14);
    expect(f.multipv).toBe(1);
    expect(f.mate).toBe(false);
    expect(f.score).toBe(-31);
    expect(f.wdl).toEqual([7, 928, 65]);
    expect(f.line.split(' ')[0]).toBe('e7e6');
  });

  it('parses multipv 2 and 3', () => {
    const f2 = parseInfoLine(REAL[1], frame())!;
    expect(f2.multipv).toBe(2);
    expect(f2.score).toBe(-35);
    expect(f2.line.split(' ')[0]).toBe('e7e5');
    const f3 = parseInfoLine(REAL[2], frame())!;
    expect(f3.multipv).toBe(3);
    expect(f3.line.split(' ')[0]).toBe('c7c5');
  });

  it('parses a mate score', () => {
    const line =
      'info depth 31 seldepth 8 multipv 1 score mate 3 wdl 1000 0 0 nodes 1234 pv h5f7 e8d8 f7f8';
    const f = parseInfoLine(line, frame())!;
    expect(f.mate).toBe(true);
    expect(f.score).toBe(3);
    expect(f.line.split(' ')[0]).toBe('h5f7');
  });

  it('handles negative mate (getting mated)', () => {
    const line = 'info depth 20 multipv 1 score mate -2 pv a2a1 b3b2';
    const f = parseInfoLine(line, frame())!;
    expect(f.mate).toBe(true);
    expect(f.score).toBe(-2);
    expect(f.wdl).toBeNull();
  });

  it('rejects info lines without a pv', () => {
    expect(parseInfoLine('info depth 1 seldepth 1 nodes 20 nps 20000', frame())).toBeNull();
    expect(parseInfoLine('info string NNUE evaluation using net', frame())).toBeNull();
  });
});

describe('parseBestMove', () => {
  it('extracts the move and ignores ponder', () => {
    expect(parseBestMove('bestmove e7e6 ponder d2d4')).toBe('e7e6');
    expect(parseBestMove('bestmove a1a8q')).toBe('a1a8q');
  });
  it('returns null for non-bestmove lines', () => {
    expect(parseBestMove('info depth 14 ... pv e2e4')).toBeNull();
  });
});

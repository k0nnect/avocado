import { describe, it, expect } from 'vitest';
import {
  encodePosition,
  decodePosition,
  encodeAnalyse,
  decodeAnalyse,
  encodeEval,
  decodeEval,
  encodeBestMove,
  decodeBestMove,
  opOf,
  Op,
  type EvalFrame,
} from '../src/shared/protocol.ts';

describe('position frame', () => {
  it('round-trips a fen with context and safe flag', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const enc = encodePosition({ fen, context: 'analysis', safeArrows: true });
    expect(opOf(enc)).toBe(Op.Position);
    const dec = decodePosition(enc);
    expect(dec.fen).toBe(fen);
    expect(dec.context).toBe('analysis');
    expect(dec.safeArrows).toBe(true);
  });

  it('handles playing context with arrows off', () => {
    const fen = '8/8/8/8/8/8/8/k6K w - - 0 1';
    const dec = decodePosition(encodePosition({ fen, context: 'playing', safeArrows: false }));
    expect(dec.context).toBe('playing');
    expect(dec.safeArrows).toBe(false);
    expect(dec.fen).toBe(fen);
  });
});

describe('analyse frame', () => {
  it('round-trips engine config', () => {
    const dec = decodeAnalyse(encodeAnalyse(3, 256, 7));
    expect(dec).toEqual({ multipv: 3, hashMb: 256, threads: 7 });
  });
});

describe('eval frame', () => {
  it('round-trips a centipawn eval with wdl and pv', () => {
    const f: EvalFrame = {
      depth: 24,
      multipv: 1,
      mate: false,
      score: 37,
      wdl: [512, 460, 28],
      line: 'e2e4 e7e5 g1f3 b8c6',
    };
    const dec = decodeEval(encodeEval(f));
    expect(dec).toEqual(f);
    expect(dec.line.split(' ')[0]).toBe('e2e4');
  });

  it('round-trips a mate score and absent wdl', () => {
    const f: EvalFrame = {
      depth: 31,
      multipv: 2,
      mate: true,
      score: -4,
      wdl: null,
      line: 'h2h4 g5h4',
    };
    const dec = decodeEval(encodeEval(f));
    expect(dec).toEqual(f);
  });

  it('handles a single-move pv', () => {
    const f: EvalFrame = { depth: 10, multipv: 1, mate: false, score: 0, wdl: null, line: 'd2d4' };
    expect(decodeEval(encodeEval(f))).toEqual(f);
  });
});

describe('bestmove frame', () => {
  it('round-trips', () => {
    expect(decodeBestMove(encodeBestMove('e7e8q'))).toBe('e7e8q');
  });
});

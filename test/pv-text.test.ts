import { describe, it, expect } from 'vitest';
import { pvToText } from '../src/shared/pv-text.ts';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('pvToText', () => {
  it('renders a quiet opening line as light SAN', () => {
    const pv = 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6';
    expect(pvToText(START, pv)).toBe('e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6');
  });

  it('marks pawn captures with the from-file', () => {
    expect(pvToText(START, 'e2e4 d7d5 e4d5')).toBe('e4 d5 exd5');
  });

  it('marks piece captures with x', () => {
    expect(pvToText(START, 'e2e4 e7e5 g1f3 b8c6 f3e5')).toBe('e4 e5 Nf3 Nc6 Nxe5');
  });

  it('renders castling both sides', () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    expect(pvToText(fen, 'e1g1')).toBe('O-O');
    expect(pvToText(fen, 'e1c1')).toBe('O-O-O');
  });

  it('renders promotion and promotion-capture', () => {
    expect(pvToText('8/P7/8/8/8/8/8/k6K w - - 0 1', 'a7a8q')).toBe('a8=Q');
    expect(pvToText('1n6/P7/8/8/8/8/8/k6K w - - 0 1', 'a7b8q')).toBe('axb8=Q');
  });

  it('renders an en-passant capture', () => {
    expect(pvToText('k7/8/8/3pP3/8/8/8/K7 w - d6 0 1', 'e5d6')).toBe('exd6');
  });

  it('truncates to maxPlies', () => {
    expect(pvToText(START, 'e2e4 e7e5 g1f3 b8c6 f1b5', 3)).toBe('e4 e5 Nf3');
  });

  it('returns empty string for an empty line', () => {
    expect(pvToText(START, '')).toBe('');
    expect(pvToText(START, '   ')).toBe('');
  });
});

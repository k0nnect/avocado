import { describe, it, expect } from 'vitest';
import {
  Board,
  mailboxEqual,
  sanePosition,
  isGeometricallyLegal,
  algebraicToSquare,
} from '../src/shared/board.ts';
import { classifyGameOverText } from '../src/content/adapters/game-result.ts';

function mbFromFen(fen: string): Uint8Array {
  const b = new Board();
  b.loadMailboxFen(fen);
  return b.squares;
}
const sq = algebraicToSquare;

describe('mailboxEqual', () => {
  it('detects identical and differing positions', () => {
    const a = mbFromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    const b = mbFromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    const c = mbFromFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
    expect(mailboxEqual(a, b)).toBe(true);
    expect(mailboxEqual(a, c)).toBe(false);
  });
});

describe('sanePosition', () => {
  it('accepts the start position', () => {
    expect(sanePosition(mbFromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'))).toBe(true);
  });
  it('rejects a board missing a king', () => {
    expect(sanePosition(mbFromFen('rnbq1bnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1'))).toBe(false);
  });
  it('rejects a pawn on the back rank (garbage scan)', () => {
    expect(sanePosition(mbFromFen('Pnbqkbnr/8/8/8/8/8/8/RNBQKBNr w - - 0 1'))).toBe(false);
  });
});

describe('isGeometricallyLegal', () => {
  const start = mbFromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');

  it('accepts a pawn double push and a knight jump', () => {
    expect(isGeometricallyLegal(start, sq('e2'), sq('e4'))).toBe(true);
    expect(isGeometricallyLegal(start, sq('g1'), sq('f3'))).toBe(true);
  });

  it('rejects the impossible bishop-straight-up-a-file move (the c1c8 bug)', () => {
    expect(isGeometricallyLegal(start, sq('c1'), sq('c8'))).toBe(false);
  });

  it('rejects a blocked rook and a blocked bishop at the start', () => {
    expect(isGeometricallyLegal(start, sq('a1'), sq('a4'))).toBe(false); // pawn blocks
    expect(isGeometricallyLegal(start, sq('c1'), sq('a3'))).toBe(false); // pawn blocks diagonal
  });

  it('accepts a real diagonal bishop slide on an open board', () => {
    const mb = mbFromFen('4k3/8/8/8/8/8/2B5/4K3 w - - 0 1');
    expect(isGeometricallyLegal(mb, sq('c2'), sq('h7'))).toBe(true);
    expect(isGeometricallyLegal(mb, sq('c2'), sq('c5'))).toBe(false); // bishop can't go straight
  });

  it('rejects capturing your own piece', () => {
    expect(isGeometricallyLegal(start, sq('a1'), sq('a2'))).toBe(false);
  });
});

describe('classifyGameOverText', () => {
  it('classifies chess.com / lichess game-over phrasings', () => {
    expect(classifyGameOverText('ci3rta won by checkmate')).toBe('checkmate');
    expect(classifyGameOverText('Rooky won on time')).toBe('timewin');
    expect(classifyGameOverText('Game drawn by stalemate')).toBe('stalemate');
    expect(classifyGameOverText('Rooky resigned')).toBe('resign');
    expect(classifyGameOverText('Game drawn by repetition')).toBe('draw');
    expect(classifyGameOverText('White is playing')).toBeNull();
    expect(classifyGameOverText('')).toBeNull();
  });
});

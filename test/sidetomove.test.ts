// Side-to-move inference from the last-move highlight. Guessing wrong on an
// already-active game makes the FEN illegal when the side not-to-move is in
// check, which Stockfish answers with `bestmove (none)` and zero evals — the
// "engine waking…" hang. These tests pin the highlight → side-to-move logic.

import { describe, it, expect } from 'vitest';
import { ChesscomAdapter } from '../src/content/adapters/chesscom.ts';
import { LichessAdapter } from '../src/content/adapters/lichess.ts';
import { makePiece, WHITE, BLACK, PieceType, EMPTY } from '../src/shared/board.ts';

const sq = (file: number, rank: number) => rank * 8 + file;

/** Minimal stand-in for the chess.com board element. */
function chesscomBoard(highlightClasses: string[]) {
  return {
    querySelectorAll: (sel: string) =>
      sel === '.highlight' ? highlightClasses.map((className) => ({ className })) : [],
  } as unknown as HTMLElement;
}

describe('chess.com sideToMove (from last-move highlight)', () => {
  const a = new ChesscomAdapter();

  it('after 1.e4 (white pawn on e4), black is to move', () => {
    const mb = new Uint8Array(64).fill(EMPTY);
    mb[sq(4, 3)] = makePiece(WHITE, PieceType.Pawn); // e4 occupied (destination)
    // highlights: e2 (origin, empty) + e4 (destination, occupied)
    const board = chesscomBoard(['highlight square-52', 'highlight square-54']);
    expect(a.sideToMove(board, mb)).toBe(BLACK);
  });

  it('after a black move (black knight on f6), white is to move', () => {
    const mb = new Uint8Array(64).fill(EMPTY);
    mb[sq(5, 5)] = makePiece(BLACK, PieceType.Knight); // f6 (destination)
    const board = chesscomBoard(['highlight square-68', 'highlight square-66']); // g8→f6
    expect(a.sideToMove(board, mb)).toBe(WHITE);
  });

  it('returns -1 when highlights are ambiguous (a piece is selected → 3 highlights)', () => {
    const mb = new Uint8Array(64).fill(EMPTY);
    mb[sq(4, 3)] = makePiece(WHITE, PieceType.Pawn);
    const board = chesscomBoard(['highlight square-52', 'highlight square-54', 'highlight square-71']);
    expect(a.sideToMove(board, mb)).toBe(-1);
  });

  it('returns -1 with no last move (fresh board, no highlights)', () => {
    const mb = new Uint8Array(64).fill(EMPTY);
    expect(a.sideToMove(chesscomBoard([]), mb)).toBe(-1);
  });
});

describe('lichess sideToMove (from chessground last-move squares)', () => {
  const a = new LichessAdapter();

  function lichessBoard(transforms: string[]) {
    return {
      getBoundingClientRect: () => ({ width: 256 }) as DOMRect, // edge = 32px
      closest: () => ({ classList: { contains: () => false } }), // orientation white
      querySelectorAll: (sel: string) =>
        sel === 'square.last-move' ? transforms.map((t) => ({ style: { transform: t } })) : [],
    } as unknown as HTMLElement;
  }

  it('after 1.e4 (white pawn on e4 @ translate(128,96)), black is to move', () => {
    // edge 32: e-file x=4*32=128; e4 is 4 ranks from top (rankFromTop=4) → y=128.
    // e2 origin: rankFromTop=6 → y=192.
    const mb = new Uint8Array(64).fill(EMPTY);
    mb[sq(4, 3)] = makePiece(WHITE, PieceType.Pawn); // e4
    const board = lichessBoard(['translate(128px, 128px)', 'translate(128px, 192px)']);
    expect(a.sideToMove(board, mb)).toBe(BLACK);
  });

  it('returns -1 when not exactly two last-move squares', () => {
    const mb = new Uint8Array(64).fill(EMPTY);
    expect(a.sideToMove(lichessBoard([]), mb)).toBe(-1);
  });
});

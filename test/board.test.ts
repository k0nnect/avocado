import { describe, it, expect } from 'vitest';
import {
  Board,
  diffMailbox,
  packMove,
  moveFrom,
  moveTo,
  moveFlag,
  MoveFlag,
  uciToMove,
  squareToAlgebraic,
  algebraicToSquare,
  type DiffResult,
  WHITE,
  BLACK,
  PieceType,
  makePiece,
} from '../src/shared/board.ts';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function newDiff(): DiffResult {
  return { move: -1, capturedType: 0, mover: WHITE };
}

describe('move packing', () => {
  it('round-trips from/to/flag', () => {
    for (const [f, t, fl] of [
      [0, 63, MoveFlag.Quiet],
      [12, 28, MoveFlag.Capture],
      [60, 62, MoveFlag.Castle],
      [52, 60, MoveFlag.PromoQ],
    ] as const) {
      const m = packMove(f, t, fl);
      expect(moveFrom(m)).toBe(f);
      expect(moveTo(m)).toBe(t);
      expect(moveFlag(m)).toBe(fl);
    }
  });
});

describe('square <-> algebraic', () => {
  it('maps corners', () => {
    expect(squareToAlgebraic(0)).toBe('a1');
    expect(squareToAlgebraic(7)).toBe('h1');
    expect(squareToAlgebraic(56)).toBe('a8');
    expect(squareToAlgebraic(63)).toBe('h8');
    expect(algebraicToSquare('e4')).toBe(28);
    expect(algebraicToSquare('e2')).toBe(12);
  });
});

describe('Board.reset / toFen', () => {
  it('produces the standard start FEN', () => {
    const b = new Board();
    b.reset();
    expect(b.toFen()).toBe(START_FEN);
  });
});

describe('Board.applyMove + FEN', () => {
  it('1. e4 updates side, ep square, and placement', () => {
    const b = new Board();
    b.reset();
    b.applyMove(uciToMove('e2e4', b));
    expect(b.toFen()).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
  });

  it('1. e4 e5 2. Nf3 increments clocks correctly', () => {
    const b = new Board();
    b.reset();
    b.applyMove(uciToMove('e2e4', b));
    b.applyMove(uciToMove('e7e5', b));
    b.applyMove(uciToMove('g1f3', b));
    expect(b.toFen()).toBe('rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2');
  });

  it('white kingside castling moves the rook and revokes rights', () => {
    const b = new Board();
    // position after 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 — white can O-O
    b.loadMailboxFen('r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4');
    b.applyMove(uciToMove('e1g1', b));
    expect(b.toFen()).toBe('r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 5 4');
  });

  it('promotion to queen', () => {
    const b = new Board();
    b.loadMailboxFen('8/P7/8/8/8/8/8/k6K w - - 0 1');
    b.applyMove(uciToMove('a7a8q', b));
    expect(b.toFen()).toBe('Q7/8/8/8/8/8/8/k6K b - - 0 1');
  });

  it('en passant capture removes the passed pawn', () => {
    const b = new Board();
    b.loadMailboxFen('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
    b.applyMove(uciToMove('e5f6', b));
    expect(b.toFen()).toBe('rnbqkbnr/ppp1p1pp/5P2/3p4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3');
  });
});

describe('bitboards stay consistent', () => {
  it('matches a fresh rebuild after a sequence of moves', () => {
    const b = new Board();
    b.reset();
    for (const uci of ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6']) {
      b.applyMove(uciToMove(uci, b));
    }
    const incremental = Uint64Snapshot(b);
    b.rebuildBitboards();
    expect(Uint64Snapshot(b)).toEqual(incremental);
  });
});

function Uint64Snapshot(b: Board): string {
  return Array.from(b.bitboards, (x) => x.toString(16)).join(',');
}

describe('diffMailbox infers moves', () => {
  it('reads a quiet pawn push', () => {
    const b = new Board();
    b.reset();
    b.prev.set(b.squares);
    b.applyMove(uciToMove('e2e4', b)); // mutate cur in place via squares
    const out = newDiff();
    diffMailbox(b.prev, b.squares, WHITE, out);
    expect(moveFrom(out.move)).toBe(algebraicToSquare('e2'));
    expect(moveTo(out.move)).toBe(algebraicToSquare('e4'));
    expect(out.capturedType).toBe(0);
  });

  it('reads a capture and reports the captured piece value', () => {
    const b = new Board();
    b.loadMailboxFen('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2');
    b.prev.set(b.squares);
    b.applyMove(uciToMove('e4d5', b));
    const out = newDiff();
    diffMailbox(b.prev, b.squares, WHITE, out);
    expect(moveFlag(out.move)).toBe(MoveFlag.Capture);
    expect(out.capturedType).toBe(PieceType.Pawn);
  });

  it('reads kingside castling (4 changed squares)', () => {
    const b = new Board();
    b.loadMailboxFen('r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4');
    b.prev.set(b.squares);
    b.applyMove(uciToMove('e1g1', b));
    const out = newDiff();
    diffMailbox(b.prev, b.squares, WHITE, out);
    expect(moveFlag(out.move)).toBe(MoveFlag.Castle);
    expect(moveFrom(out.move)).toBe(algebraicToSquare('e1'));
    expect(moveTo(out.move)).toBe(algebraicToSquare('g1'));
  });

  it('returns -1 when the change is not a single move', () => {
    const b = new Board();
    b.reset();
    b.prev.set(b.squares);
    // wipe the board — incoherent, should not parse as a move
    b.squares.fill(0);
    const out = newDiff();
    diffMailbox(b.prev, b.squares, WHITE, out);
    expect(out.move).toBe(-1);
  });
});

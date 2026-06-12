// Mid-drag scans must be rejected wholesale. A dragged piece follows the
// cursor's translate, so "hovering it over another piece" reads it at that
// square — a garbage position that would poke the engine and flicker the
// arrows. The board is only readable once the piece is actually PLACED.

import { describe, it, expect } from 'vitest';
import { ChesscomAdapter } from '../src/content/adapters/chesscom.ts';
import { LichessAdapter } from '../src/content/adapters/lichess.ts';

const out = new Uint8Array(64);

function lichessBoard(pieces: Array<{ cls: string; tf: string }>) {
  return {
    getBoundingClientRect: () => ({ width: 256 }) as DOMRect, // edge = 32px
    closest: () => ({ classList: { contains: () => false } }), // orientation white
    querySelectorAll: (sel: string) =>
      sel === 'piece'
        ? pieces.map((p) => ({ className: p.cls, style: { transform: p.tf } }))
        : [],
  } as unknown as HTMLElement;
}

function chesscomBoard(classNames: string[]) {
  return {
    querySelectorAll: (sel: string) =>
      sel === '.piece' ? classNames.map((className) => ({ className })) : [],
  } as unknown as HTMLElement;
}

describe('drag guard — board unreadable until the piece is placed', () => {
  it('lichess: a piece mid-drag aborts the whole scan', () => {
    const a = new LichessAdapter();
    const board = lichessBoard([
      { cls: 'white pawn dragging', tf: 'translate(100px, 300px)' }, // following the cursor
      { cls: 'black knight', tf: 'translate(160px, 64px)' },
    ]);
    expect(a.scanBoard(board, out)).toBe(false);
  });

  it('lichess: the same position scans fine once dropped', () => {
    const a = new LichessAdapter();
    const board = lichessBoard([
      { cls: 'white pawn', tf: 'translate(128px, 128px)' }, // e4
      { cls: 'black knight', tf: 'translate(160px, 64px)' },
    ]);
    expect(a.scanBoard(board, out)).toBe(true);
  });

  it('chess.com fallback: a piece mid-drag aborts the scan', () => {
    const a = new ChesscomAdapter();
    const board = chesscomBoard(['piece wp square-52 dragging', 'piece bk square-58']);
    expect(a.scanBoard(board, out)).toBe(false);
  });

  it('chess.com fallback: scans fine without a drag', () => {
    const a = new ChesscomAdapter();
    const board = chesscomBoard(['piece wp square-52', 'piece bk square-58']);
    expect(a.scanBoard(board, out)).toBe(true);
  });
});

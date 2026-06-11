// avocado chess.com adapter.
//
// chess.com renders the board as a `<wc-chess-board>` (or a `.board` element).
// Pieces are `<div class="piece wp square-52">`:
//   - "wp"/"bn"/… → colour (w/b) + role (p,n,b,r,q,k)
//   - "square-XY" → file X (1-8), rank Y (1-8); square index = (Y-1)*8 + (X-1)
// Orientation: the board carries the class "flipped" when Black is on the bottom.
//
// Only standard 8×8 boards are handled here; chess.com's /variants boards use a
// different DOM (data-piece attributes) and are deferred to v2 with
// fairy-stockfish.

import type { SiteAdapter, GameEndKind } from './types.ts';
import { readGameOver } from './game-result.ts';
import type { GameContext } from '../../shared/protocol.ts';
import { makePiece, WHITE, BLACK, PieceType, EMPTY } from '../../shared/board.ts';

const ROLE_TYPE: Record<string, PieceType> = {
  p: PieceType.Pawn,
  n: PieceType.Knight,
  b: PieceType.Bishop,
  r: PieceType.Rook,
  q: PieceType.Queen,
  k: PieceType.King,
};

export class ChesscomAdapter implements SiteAdapter {
  readonly name = 'chess.com';

  matches(): boolean {
    return location.hostname.endsWith('chess.com');
  }

  findBoard(): HTMLElement | null {
    // Try the most specific selectors first (querySelector with a comma-list
    // returns document-order, not selector-order, so we iterate to keep
    // priority). A.C.A.S targets `#board-layout-chessboard > .board`; the modern
    // board is a `<wc-chess-board>` element that also carries class `board`.
    for (const sel of [
      'wc-chess-board',
      '#board-layout-chessboard .board',
      '#board-single .board',
      '.board.board-layout-chessboard',
      'chess-board',
      '.board',
    ]) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && el.querySelector('.piece')) return el; // must actually hold pieces
    }
    return null;
  }

  observeTarget(board: HTMLElement): { target: Node; options: MutationObserverInit } {
    // chess.com mutates each piece's class (the square-XY token) on every move.
    return {
      target: board,
      options: { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] },
    };
  }

  orientation(board: HTMLElement): number {
    return board.classList.contains('flipped') ? BLACK : WHITE;
  }

  boardRect(board: HTMLElement): DOMRect {
    return board.getBoundingClientRect();
  }

  scanBoard(board: HTMLElement, out: Uint8Array): boolean {
    out.fill(EMPTY);
    const pieces = board.querySelectorAll<HTMLElement>('.piece');
    if (pieces.length === 0) return false;

    for (let i = 0; i < pieces.length; i++) {
      const cls = pieces[i]!.className;
      // find the "wp"/"bn" colour+role token and the "square-XY" token by scanning
      let color = -1;
      let type = 0;
      let file = -1;
      let rank = -1;

      // tokens are space-separated; walk without allocating a split array
      let start = 0;
      for (let j = 0; j <= cls.length; j++) {
        if (j === cls.length || cls.charCodeAt(j) === 32 /* space */) {
          const len = j - start;
          if (len === 2) {
            const c = cls[start]!;
            const r = cls[start + 1]!;
            const t = ROLE_TYPE[r];
            if ((c === 'w' || c === 'b') && t !== undefined) {
              color = c === 'w' ? WHITE : BLACK;
              type = t;
            }
          } else if (len === 9 && cls.startsWith('square-', start)) {
            file = cls.charCodeAt(start + 7) - 49; // '1' → 0
            rank = cls.charCodeAt(start + 8) - 49;
          }
          start = j + 1;
        }
      }
      if (color === -1 || type === 0 || file < 0 || file > 7 || rank < 0 || rank > 7) continue;
      out[rank * 8 + file] = makePiece(color, type);
    }
    return true;
  }

  gameContext(): GameContext {
    const path = location.pathname;
    if (path.includes('/analysis')) return 'analysis';
    if (path.includes('/play/computer') || path.includes('/computer')) return 'bot';
    if (path.includes('/puzzles') || path.includes('/lessons')) return 'analysis';
    if (path.includes('/game/') || path.includes('/play/') || path.includes('/live')) {
      // a board where we have clocks/controls is our own game
      return document.querySelector('.clock-component') ? 'playing' : 'spectating';
    }
    return document.querySelector('.clock-component') ? 'playing' : 'spectating';
  }

  readClockMs(side: number): number {
    // chess.com bottom clock is always the player's; top is the opponent's.
    // We map white/black to bottom/top via board orientation at call sites that
    // care; here we just read both labelled clocks if present.
    const sel =
      side === WHITE
        ? '.clock-white .clock-time-monospace, .clock-bottom .clock-time-monospace'
        : '.clock-black .clock-time-monospace, .clock-top .clock-time-monospace';
    const el = document.querySelector(sel);
    if (!el?.textContent) return -1;
    return parseClock(el.textContent);
  }

  gameResult(): GameEndKind | null {
    // chess.com shows a game-over modal; the headline + sub-line carry the reason.
    return readGameOver([
      '.game-over-modal-content',
      '[class*="game-over-header"]',
      '[class*="game-over"] [class*="header"]',
      '.modal-game-over-component',
      '.header-title-component',
    ]);
  }
}

/** Parse "1:23", "0:09.3", "12:05", "1:02:30" → ms. -1 on failure. */
function parseClock(text: string): number {
  const parts = text.trim().split(':');
  if (parts.length < 2) return -1;
  let s = 0;
  for (const p of parts) {
    const n = parseFloat(p);
    if (Number.isNaN(n)) return -1;
    s = s * 60 + n;
  }
  return s * 1000;
}

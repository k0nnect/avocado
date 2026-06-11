// avocado lichess adapter.
//
// lichess renders the board with chessground: a `<cg-board>` containing absolute
// `<piece>` elements positioned by `transform: translate(Xpx, Ypx)`. A piece's
// className is "<color> <role>", e.g. "white pawn" / "black knight". The board's
// orientation lives on the `.cg-wrap` ancestor as `.orientation-white` /
// `.orientation-black`.
//
// We read square = rank*8 + file (a1=0) directly from each piece's translate,
// dividing by the square edge (boardWidth / 8) and accounting for orientation.
// No allocation in scanBoard beyond reading the live NodeList.

import type { SiteAdapter } from './types.ts';
import type { GameContext } from '../../shared/protocol.ts';
import { makePiece, WHITE, BLACK, PieceType, EMPTY } from '../../shared/board.ts';

const ROLE_TYPE: Record<string, PieceType> = {
  pawn: PieceType.Pawn,
  knight: PieceType.Knight,
  bishop: PieceType.Bishop,
  rook: PieceType.Rook,
  queen: PieceType.Queen,
  king: PieceType.King,
};

export class LichessAdapter implements SiteAdapter {
  readonly name = 'lichess';

  matches(): boolean {
    return location.hostname.endsWith('lichess.org');
  }

  findBoard(): HTMLElement | null {
    return document.querySelector<HTMLElement>('cg-board');
  }

  observeTarget(board: HTMLElement): { target: Node; options: MutationObserverInit } {
    // Chessground mutates piece nodes' class/style and adds/removes them.
    // Observing the cg-board subtree for childList + attribute changes catches
    // every move without the 250ms poll A.C.A.S falls back to.
    return {
      target: board,
      options: {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
      },
    };
  }

  orientation(board: HTMLElement): number {
    const wrap = board.closest('.cg-wrap');
    return wrap?.classList.contains('orientation-black') ? BLACK : WHITE;
  }

  boardRect(board: HTMLElement): DOMRect {
    return board.getBoundingClientRect();
  }

  scanBoard(board: HTMLElement, out: Uint8Array): boolean {
    const rect = board.getBoundingClientRect();
    if (rect.width === 0) return false;
    const edge = rect.width / 8;
    const flipped = this.orientation(board) === BLACK;

    out.fill(EMPTY);
    const pieces = board.querySelectorAll<HTMLElement>('piece');
    if (pieces.length === 0) return false;

    for (let i = 0; i < pieces.length; i++) {
      const el = pieces[i]!;
      // className is "white pawn" (sometimes with trailing "dragging" etc.)
      const cls = el.className;
      // ghost/dragging pieces during a drag should be ignored
      if (cls.indexOf('ghost') !== -1) continue;

      const color = cls.indexOf('white') !== -1 ? WHITE : cls.indexOf('black') !== -1 ? BLACK : -1;
      if (color === -1) continue;
      let type = 0;
      // scan the class for a known role without split/regex
      for (const role in ROLE_TYPE) {
        if (cls.indexOf(role) !== -1) {
          type = ROLE_TYPE[role]!;
          break;
        }
      }
      if (type === 0) continue;

      // translate(Xpx, Ypx) — read from inline style
      const tf = el.style.transform;
      const open = tf.indexOf('(');
      if (open === -1) continue;
      const comma = tf.indexOf(',', open);
      const px = parseFloat(tf.slice(open + 1));
      const py = comma === -1 ? 0 : parseFloat(tf.slice(comma + 1));

      let file = Math.round(px / edge);
      let rankFromTop = Math.round(py / edge);
      if (flipped) {
        file = 7 - file;
        rankFromTop = 7 - rankFromTop;
      }
      const rank = 7 - rankFromTop; // translate y grows downward; rank 8 at top
      if (file < 0 || file > 7 || rank < 0 || rank > 7) continue;
      out[rank * 8 + file] = makePiece(color, type);
    }
    return true;
  }

  gameContext(): GameContext {
    const path = location.pathname;
    if (path.startsWith('/analysis') || path.includes('/analysis')) return 'analysis';
    if (path.startsWith('/study')) return 'analysis';
    if (path.startsWith('/training') || path.startsWith('/practice')) return 'analysis';
    // Watching someone else's game (TV / spectate) — board has no "playing" class.
    if (document.querySelector('.round__app.is-playing, .rcontrols .ricons')) {
      // our own playable game in progress
      const vsBot = document.body.textContent?.includes('Play with the computer');
      return vsBot ? 'bot' : 'playing';
    }
    if (path.startsWith('/@/') || document.querySelector('.tv-channels')) return 'spectating';
    // default: if there's a move-list controls panel we can't classify, be safe.
    return document.querySelector('.round__app') ? 'playing' : 'spectating';
  }

  readClockMs(side: number): number {
    // lichess clocks: .rclock-bottom / .rclock-top hold "M:SS" in .time.
    const sel = side === WHITE ? '.rclock-white .time, .rclock-bottom .time' : '.rclock-black .time, .rclock-top .time';
    const el = document.querySelector(sel);
    if (!el?.textContent) return -1;
    return parseClock(el.textContent);
  }
}

/** Parse "1:23", "0:09.3", "12:05" → milliseconds. Returns -1 on failure. */
function parseClock(text: string): number {
  const t = text.trim();
  const colon = t.indexOf(':');
  if (colon === -1) return -1;
  const min = parseInt(t.slice(0, colon), 10);
  const sec = parseFloat(t.slice(colon + 1));
  if (Number.isNaN(min) || Number.isNaN(sec)) return -1;
  return (min * 60 + sec) * 1000;
}

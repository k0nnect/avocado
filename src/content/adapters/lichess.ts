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

import type { SiteAdapter, GameEndKind } from './types.ts';
import { readGameOver } from './game-result.ts';
import type { GameContext } from '../../shared/protocol.ts';
import { makePiece, pieceColor, WHITE, BLACK, PieceType, EMPTY } from '../../shared/board.ts';

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
    // lichess renders cg-boards all over pages that AREN'T your game: TV and
    // "current games" thumbnails on the homepage, sidebar minis, broadcast
    // strips. Those stream live moves, so naively taking the first cg-board
    // lights up the engine + commentary while just browsing. Only accept a
    // board that isn't a thumbnail and renders at real, playable size.
    const boards = document.querySelectorAll<HTMLElement>('cg-board');
    for (let i = 0; i < boards.length; i++) {
      const b = boards[i]!;
      if (b.closest('.mini-board, .mini-game')) continue; // homepage/sidebar thumbnail
      if (b.getBoundingClientRect().width < 240) continue; // too small to be the game
      return b;
    }
    return null;
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

  sideToMove(board: HTMLElement, mailbox: Uint8Array): number {
    // Chessground marks the last move with two `square.last-move` overlays,
    // positioned by the same translate() math as pieces. The occupied one is the
    // destination; the piece there is the side that just moved.
    const sqs = board.querySelectorAll<HTMLElement>('square.last-move');
    if (sqs.length !== 2) return -1;
    const rect = board.getBoundingClientRect();
    if (rect.width === 0) return -1;
    const edge = rect.width / 8;
    const flipped = this.orientation(board) === BLACK;
    for (let i = 0; i < sqs.length; i++) {
      const sq = squareFromTransform(sqs[i]!.style.transform, edge, flipped);
      if (sq < 0) continue;
      const pc = mailbox[sq]!;
      if (pc !== EMPTY) return pieceColor(pc) ^ 1; // mover sits here → other side to move
    }
    return -1;
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
      // A piece mid-drag follows the CURSOR's translate — hovering it over
      // another piece/square would read it at that square and produce a garbage
      // position. The board is unreadable until the piece is actually PLACED:
      // abort the whole scan (capture skips this tick; the drop emits the move).
      if (cls.indexOf('dragging') !== -1) return false;
      // the ghost marking the origin square during a drag is not a real piece
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

  gameResult(): GameEndKind | null {
    // lichess shows the outcome in .status (with .result) under the move list.
    return readGameOver(['.result-wrap .status', '.status', '.game__status']);
  }
}

/** Square index (a1=0 … h8=63) from a chessground `translate(Xpx,Ypx)`, or -1. */
function squareFromTransform(tf: string, edge: number, flipped: boolean): number {
  const open = tf.indexOf('(');
  if (open === -1) return -1;
  const comma = tf.indexOf(',', open);
  const px = parseFloat(tf.slice(open + 1));
  const py = comma === -1 ? 0 : parseFloat(tf.slice(comma + 1));
  let file = Math.round(px / edge);
  let rankFromTop = Math.round(py / edge);
  if (flipped) {
    file = 7 - file;
    rankFromTop = 7 - rankFromTop;
  }
  const rank = 7 - rankFromTop;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return -1;
  return rank * 8 + file;
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

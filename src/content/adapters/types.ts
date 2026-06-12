// avocado site adapter contract.
//
// Generalizes A.C.A.S's `addSupportedChessSite(...)` registry into a typed
// interface. Each adapter knows ONE site's DOM and answers a few questions; the
// capture pipeline (capture.ts) stays site-agnostic. An adapter must fill a
// preallocated 64-byte mailbox from the DOM without allocating — that's the hot
// path called on every board mutation.

import type { GameContext } from '../../shared/protocol.ts';

export interface SiteAdapter {
  /** Human label, for debug logs. */
  readonly name: string;

  /** True if the current page belongs to this adapter (cheap hostname check). */
  matches(): boolean;

  /** Locate the live board element, or null if not present yet. */
  findBoard(): HTMLElement | null;

  /**
   * Element to attach the MutationObserver to (usually the pieces container),
   * plus the observer options scoped tightly to what signals a move.
   */
  observeTarget(board: HTMLElement): { target: Node; options: MutationObserverInit };

  /**
   * Fill `out` (64 bytes, a1=0 … h8=63) from the current DOM. Returns false if
   * the board can't be read coherently (mid-animation, detached). MUST NOT
   * allocate — reuse the passed array only.
   */
  scanBoard(board: HTMLElement, out: Uint8Array): boolean;

  /**
   * If the site exposes its own authoritative game state, return the full FEN
   * (placement + side-to-move + castling + en-passant). This is preferred over
   * scanBoard because it's exact and trivially cheap — chess.com's
   * `<wc-chess-board>` answers `.game.getFEN()` in ~0.7µs and never produces an
   * illegal position, so it sidesteps the side-to-move guessing that otherwise
   * hangs the engine on "engine waking…". Return null if unavailable (the
   * capture pipeline then falls back to scanBoard).
   */
  liveFen?(board: HTMLElement): string | null;

  /** 0 = white pieces on the bottom, 1 = black on the bottom (board flipped). */
  orientation(board: HTMLElement): number;

  /**
   * Best-effort side-to-move (0 = white, 1 = black) for a STATIC board avocado
   * has just attached to — read from the site's last-move highlight: the
   * highlighted square that still holds a piece is the move's destination, so
   * that piece's colour is the side that just moved, and the other side is to
   * move. Returns -1 when it can't tell (no last move yet, ambiguous highlights).
   *
   * This matters because guessing the wrong side-to-move yields an ILLEGAL FEN
   * whenever the side-not-to-move is in check — Stockfish then returns
   * `bestmove (none)` with no eval, so the overlay hangs on "engine waking…".
   * O(1): inspects only the highlight elements. `mailbox` is the freshly-scanned
   * position, used to find the occupied (destination) highlight.
   */
  sideToMove?(board: HTMLElement, mailbox: Uint8Array): number;

  /** Where the user sits in this game — drives safe-mode arrow gating. */
  gameContext(): GameContext;

  /** Bounding rect of the playable 8×8 area, in CSS px, for overlay alignment. */
  boardRect(board: HTMLElement): DOMRect;

  /**
   * Remaining clock for a side (0 = white, 1 = black) in milliseconds, or -1 if
   * unknown. Sampled only when a move lands, never polled.
   */
  readClockMs(side: number): number;

  /**
   * Read the site's game-over UI, if the game has ended. Returns the reason so
   * the commentary engine can react (checkmate / stalemate / time / resign /
   * draw), or null while the game is ongoing.
   */
  gameResult(): GameEndKind | null;
}

export type GameEndKind = 'checkmate' | 'stalemate' | 'timewin' | 'resign' | 'draw';

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

  /** 0 = white pieces on the bottom, 1 = black on the bottom (board flipped). */
  orientation(board: HTMLElement): number;

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

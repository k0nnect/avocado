// avocado capture pipeline — turns board DOM mutations into packed positions.
//
// Hot path discipline:
//  - One MutationObserver scoped to the board (no document-wide observation, no
//    250ms poll fallback like A.C.A.S). Mutation bursts during an animation are
//    coalesced into ONE diff via a queued microtask + dirty flag.
//  - Two preallocated mailboxes (cur/prev) plus one reused DiffResult. A move is
//    derived as a packed 16-bit int; the Board applies it in place to keep
//    castling/ep/clocks correct, then emits a FEN.
//  - Zero allocation per move except the final FEN string handed to the engine.

import type { SiteAdapter } from './adapters/types.ts';
import {
  Board,
  diffMailbox,
  WHITE,
  type DiffResult,
  moveFrom,
  moveTo,
  PIECE_VALUE,
} from '../shared/board.ts';

export interface CaptureEvent {
  fen: string;
  /** packed 16-bit move that produced this position, or -1 if resynced */
  move: number;
  /** PieceType captured by that move (0 = none) */
  capturedType: number;
  /** value of the captured piece (0..9), for commentary */
  capturedValue: number;
  /** side that just moved (WHITE/BLACK) */
  mover: number;
  /** remaining clock (ms) of the side that just moved, or -1 */
  clockMs: number;
  /** ms the move took, if derivable from clock deltas, else -1 */
  moveTimeMs: number;
}

export type CaptureSink = (e: CaptureEvent) => void;

export class CapturePipeline {
  private readonly board = new Board();
  private readonly cur = new Uint8Array(64);
  private readonly diff: DiffResult = { move: -1, capturedType: 0, mover: WHITE };
  private observer: MutationObserver | null = null;
  private dirty = false;
  private synced = false;
  private lastClock: [number, number] = [-1, -1];

  constructor(
    private readonly adapter: SiteAdapter,
    private readonly boardEl: HTMLElement,
    private readonly sink: CaptureSink,
  ) {}

  start(): void {
    const { target, options } = this.adapter.observeTarget(this.boardEl);
    this.observer = new MutationObserver(() => this.onMutations());
    this.observer.observe(target, options);
    // Prime from the current DOM so we have a baseline to diff against.
    this.resync();
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  /** Coalesce a mutation burst: set the flag, schedule one microtask. */
  private onMutations(): void {
    if (this.dirty) return;
    this.dirty = true;
    queueMicrotask(() => {
      this.dirty = false;
      this.process();
    });
  }

  /**
   * Re-read the whole board and treat it as a fresh baseline. Emits the current
   * position (move = -1) so the engine analyses it immediately — this is what
   * makes the eval bar + arrows appear the moment you open a board (analysis,
   * spectate, or a bot game waiting on your move), not only after the first move.
   */
  private resync(): void {
    if (!this.adapter.scanBoard(this.boardEl, this.cur)) return;
    this.board.loadMailbox(this.cur);
    // We don't know side-to-move reliably from a static scan; assume white if it
    // looks like the start, otherwise leave as-is. The engine tolerates either;
    // the diff loop corrects side-to-move as moves flow.
    this.board.prev.set(this.cur);
    this.synced = true;
    this.sampleClocks();

    // emit the baseline position (move = -1 → no commentary, just eval/arrows)
    this.sink({
      fen: this.board.toFen(),
      move: -1,
      capturedType: 0,
      capturedValue: 0,
      mover: this.board.sideToMove ^ 1, // so consumers read stm = current side
      clockMs: -1,
      moveTimeMs: -1,
    });
  }

  private process(): void {
    if (!this.adapter.scanBoard(this.boardEl, this.cur)) return;
    if (!this.synced) {
      this.resync();
      return;
    }

    const side = this.board.sideToMove;
    diffMailbox(this.board.prev, this.cur, side, this.diff);

    if (this.diff.move === -1) {
      // Try the other side — orientation or our side guess may be stale.
      diffMailbox(this.board.prev, this.cur, side ^ 1, this.diff);
    }

    if (this.diff.move === -1) {
      // Incoherent change (board flip, new game, takeback). Resync silently.
      this.resync();
      return;
    }

    // Apply against the authoritative Board to keep FEN metadata correct.
    this.board.sideToMove = this.diff.mover;
    this.board.applyMove(this.diff.move);
    this.board.prev.set(this.board.squares);

    const mover = this.diff.mover;
    const moveTimeMs = this.sampleClocks(mover);
    const capturedValue = this.diff.capturedType ? PIECE_VALUE[this.diff.capturedType]! : 0;

    this.sink({
      fen: this.board.toFen(),
      move: this.diff.move,
      capturedType: this.diff.capturedType,
      capturedValue,
      mover,
      clockMs: this.lastClock[mover],
      moveTimeMs,
    });
  }

  /**
   * Sample both clocks; if `mover` is given, return how long that side's clock
   * dropped since the previous sample (their move time), else -1.
   */
  private sampleClocks(mover?: number): number {
    const w = this.adapter.readClockMs(WHITE);
    const b = this.adapter.readClockMs(1);
    let moveTime = -1;
    if (mover !== undefined) {
      const prev = this.lastClock[mover];
      const now = mover === WHITE ? w : b;
      if (prev >= 0 && now >= 0 && prev >= now) moveTime = prev - now;
    }
    this.lastClock[0] = w;
    this.lastClock[1] = b;
    return moveTime;
  }
}

/** Convenience: is this move a capture of a high-value piece? (for commentary) */
export function hangValue(e: CaptureEvent): number {
  return e.capturedValue;
}

/** The destination square of the last move (for overlay highlight, if wanted). */
export function lastMoveSquares(move: number): [number, number] {
  return [moveFrom(move), moveTo(move)];
}

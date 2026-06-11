// avocado commentary engine — a rule-and-priority state machine that turns each
// move + the engine's eval swing into one lowercase larp callout.
//
// Inputs are quantized into small buckets; a single category is chosen by strict
// priority (mate > hung queen > … > filler) so we never spam; per-category
// cooldowns stop repeats. The chosen (category, seed) indexes a flat line table
// — no allocation beyond the returned string reference.
//
// Audio in a later version keys off the SAME LineCat, so the mapping is stable.

import { LineCat, pickLine } from './lines.ts';
import { Motif } from './motifs.ts';
import { WHITE } from '../../shared/board.ts';

export interface CommentaryInput {
  /** side that just moved (WHITE/BLACK) */
  mover: number;
  /** White-POV centipawn eval AFTER the move (mate folded out) */
  evalCpWhite: number;
  /** signed mate distance, White POV (0 = none). +N = White mates in N. */
  mateWhite: number;
  /** value of the piece the mover just captured (0 = none) */
  capturedValue: number;
  /** ms the mover spent on this move (-1 unknown) */
  moveTimeMs: number;
  /** mover's remaining clock in ms (-1 unknown) */
  clockMs: number;
  /** Motif bit mask from detectMotifs */
  motifs: number;
}

export interface Callout {
  tag: string;
  text: string;
  cat: LineCat;
}

const COOLDOWN_MS = 6000; // per-category minimum gap
const GLOBAL_GAP_MS = 1500; // never two callouts closer than this

export class Commentary {
  private prevEvalWhite = 0;
  private prevMateWhite = 0;
  private havePrev = false;
  private lastCatAt = new Map<LineCat, number>();
  private lastAnyAt = -Infinity; // first callout is never gated
  private seed = 0x1234567;

  /**
   * Feed the latest move+eval. Returns a Callout to display, or null if nothing
   * fires (cooldowns, or nothing interesting happened). `now` is injected for
   * testability (pass performance.now() in the content script).
   */
  observe(input: CommentaryInput, now: number): Callout | null {
    const cat = this.classify(input);
    // advance the running eval baseline regardless of whether we speak
    this.prevEvalWhite = input.evalCpWhite;
    this.prevMateWhite = input.mateWhite;
    this.havePrev = true;

    if (cat === null) return null;
    if (now - this.lastAnyAt < GLOBAL_GAP_MS) return null;
    const last = this.lastCatAt.get(cat) ?? -Infinity;
    if (now - last < COOLDOWN_MS) return null;

    this.lastCatAt.set(cat, now);
    this.lastAnyAt = now;
    // evolve the seed so repeated categories rotate variants
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    const picked = pickLine(cat, this.seed);
    return { tag: picked.tag, text: picked.text, cat };
  }

  /**
   * Terminal game-end callout (checkmate / stalemate / win on time). Fires once
   * — a `fired` latch stops it repeating while the game-over screen lingers.
   */
  private endFired = false;
  gameEnd(kind: 'checkmate' | 'stalemate' | 'timewin' | 'resign'): Callout | null {
    if (this.endFired) return null;
    this.endFired = true;
    const cat =
      kind === 'checkmate'
        ? LineCat.Checkmate
        : kind === 'stalemate'
          ? LineCat.Stalemate
          : kind === 'resign'
            ? LineCat.Resign
            : LineCat.TimeWin;
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    const picked = pickLine(cat, this.seed);
    return { tag: picked.tag, text: picked.text, cat };
  }

  /** Map the quantized state to a single category by priority, or null. */
  private classify(input: CommentaryInput): LineCat | null {
    const moverIsWhite = input.mover === WHITE;
    // "centipawn loss" for the mover: positive = the move made the mover worse.
    const moverEvalAfter = moverIsWhite ? input.evalCpWhite : -input.evalCpWhite;
    const moverEvalBefore = this.havePrev
      ? moverIsWhite
        ? this.prevEvalWhite
        : -this.prevEvalWhite
      : moverEvalAfter;
    const cpLoss = moverEvalBefore - moverEvalAfter;

    // mate situations dominate everything.
    const moverMateAfter = moverIsWhite ? input.mateWhite : -input.mateWhite;
    if (moverMateAfter > 0) return LineCat.MateGiving;
    if (moverMateAfter < 0) return LineCat.MateGettingMated;

    const m = input.motifs;

    // losing a queen / piece — read from what the OPPONENT captured on their
    // move is handled when they move; here capturedValue is what THIS mover took.
    // A big negative swing while down material reads as a hang.
    if (cpLoss > 250) {
      // distinguish queen-level disaster for flavour
      if (input.capturedValue === 0 && this.lostHeavy(cpLoss)) {
        return cpLoss > 800 ? LineCat.HungQueen : LineCat.HungPiece;
      }
      return LineCat.Blunder;
    }

    // brilliant: the mover improved a lot, especially via a sacrifice
    if (cpLoss < -150 && (m & Motif.Sacrifice || input.capturedValue === 0)) {
      return LineCat.Brilliancy;
    }

    if (cpLoss > 120) return LineCat.Mistake;

    // tactical motifs (only when the move was at least sound)
    if (m & Motif.Fork) return LineCat.Fork;
    if (input.capturedValue >= 5) return LineCat.BigCapture;
    if (m & Motif.Promotion) return LineCat.Promotion;
    if (m & Motif.Check) return LineCat.Check;
    if (m & Motif.Castle) return LineCat.Castle;

    if (cpLoss > 50) return LineCat.Inaccuracy;

    // time-based flavour
    if (input.clockMs >= 0 && input.clockMs < 10000) return LineCat.TimeScramble;
    if (input.moveTimeMs >= 0 && input.moveTimeMs < 300) return LineCat.Premove;
    if (input.moveTimeMs >= 0 && input.moveTimeMs > 30000) return LineCat.Tank;

    // positional read from the absolute eval
    const absWhite = Math.abs(input.evalCpWhite);
    if (absWhite > 300) return LineCat.Dominance;
    if (absWhite < 30) return LineCat.Equal;

    return LineCat.Filler;
  }

  /** Heuristic: a swing this large with no capture means material was dropped. */
  private lostHeavy(cpLoss: number): boolean {
    return cpLoss > 250;
  }

  /** Reset between games. */
  reset(): void {
    this.havePrev = false;
    this.prevEvalWhite = 0;
    this.prevMateWhite = 0;
    this.lastCatAt.clear();
    this.lastAnyAt = -Infinity;
    this.endFired = false;
  }
}

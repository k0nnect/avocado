// avocado tactical motif detection — runs once per move (not a hot loop), so it
// reads the mailbox directly with small attack tests. No move generator: we only
// answer the few questions the commentary engine asks.
//
// Motifs are returned as a bit mask so the commentary state hash can fold them
// in cheaply.

import {
  Board,
  pieceType,
  pieceColor,
  PieceType,
  moveTo,
  moveFlag,
  MoveFlag,
  PIECE_VALUE,
  EMPTY,
} from '../../shared/board.ts';

export const enum Motif {
  Check = 1 << 0,
  Fork = 1 << 1, // the moved piece attacks 2+ valuable enemy targets
  Promotion = 1 << 2,
  Castle = 1 << 3,
  BigCapture = 1 << 4, // captured a rook/queen
  Sacrifice = 1 << 5, // moved a piece onto a square defended by a lower-value enemy
}

// Knight move offsets as (df, dr) pairs.
const KNIGHT: ReadonlyArray<readonly [number, number]> = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const KING: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
const BISHOP_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];
const ROOK_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

function onBoard(f: number, r: number): boolean {
  return f >= 0 && f < 8 && r >= 0 && r < 8;
}

/** Is `sq` attacked by any piece of color `by`? Mailbox scan from the square. */
export function isAttackedBy(board: Board, sq: number, by: number): boolean {
  const sf = sq & 7;
  const sr = sq >> 3;
  const sq8 = board.squares;

  // pawns: attackers sit on the diagonal "behind" relative to their direction
  const pawnRank = by === 0 ? sr - 1 : sr + 1; // white pawns attack upward
  for (const df of [-1, 1]) {
    const f = sf + df;
    if (onBoard(f, pawnRank)) {
      const p = sq8[pawnRank * 8 + f]!;
      if (p !== EMPTY && pieceColor(p) === by && pieceType(p) === PieceType.Pawn) return true;
    }
  }
  // knights
  for (const [df, dr] of KNIGHT) {
    const f = sf + df;
    const r = sr + dr;
    if (onBoard(f, r)) {
      const p = sq8[r * 8 + f]!;
      if (p !== EMPTY && pieceColor(p) === by && pieceType(p) === PieceType.Knight) return true;
    }
  }
  // king
  for (const [df, dr] of KING) {
    const f = sf + df;
    const r = sr + dr;
    if (onBoard(f, r)) {
      const p = sq8[r * 8 + f]!;
      if (p !== EMPTY && pieceColor(p) === by && pieceType(p) === PieceType.King) return true;
    }
  }
  // sliders: bishops/queens on diagonals, rooks/queens on files/ranks
  if (slideHit(board, sf, sr, BISHOP_DIRS, by, PieceType.Bishop)) return true;
  if (slideHit(board, sf, sr, ROOK_DIRS, by, PieceType.Rook)) return true;
  return false;
}

function slideHit(
  board: Board,
  sf: number,
  sr: number,
  dirs: ReadonlyArray<readonly [number, number]>,
  by: number,
  straightType: PieceType,
): boolean {
  const sq8 = board.squares;
  for (const [df, dr] of dirs) {
    let f = sf + df;
    let r = sr + dr;
    while (onBoard(f, r)) {
      const p = sq8[r * 8 + f]!;
      if (p !== EMPTY) {
        if (pieceColor(p) === by) {
          const t = pieceType(p);
          if (t === PieceType.Queen || t === straightType) return true;
        }
        break; // blocked
      }
      f += df;
      r += dr;
    }
  }
  return false;
}

/** Square index of `color`'s king, or -1. */
function kingSquare(board: Board, color: number): number {
  for (let sq = 0; sq < 64; sq++) {
    const p = board.squares[sq]!;
    if (p !== EMPTY && pieceColor(p) === color && pieceType(p) === PieceType.King) return sq;
  }
  return -1;
}

/**
 * Detect motifs for the position AFTER `mover` played `move`. `board` is already
 * in the post-move state. Returns a Motif bit mask.
 */
export function detectMotifs(board: Board, move: number, mover: number, capturedValue: number): number {
  let mask = 0;
  const flag = moveFlag(move);
  const to = moveTo(move);

  if (flag === MoveFlag.Castle) mask |= Motif.Castle;
  if (flag >= MoveFlag.PromoN) mask |= Motif.Promotion;
  if (capturedValue >= 5) mask |= Motif.BigCapture;

  const opp = mover ^ 1;

  // check: opponent king now attacked by the mover
  const oppKing = kingSquare(board, opp);
  if (oppKing >= 0 && isAttackedBy(board, oppKing, mover)) mask |= Motif.Check;

  // fork: the piece that landed on `to` attacks 2+ enemy targets worth ≥3 (or king)
  const landed = board.squares[to]!;
  if (landed !== EMPTY) {
    let targets = 0;
    const lt = pieceType(landed);
    forEachAttackTarget(board, to, lt, (tsq) => {
      const tp = board.squares[tsq]!;
      if (tp !== EMPTY && pieceColor(tp) === opp) {
        const tv = pieceType(tp) === PieceType.King ? 10 : PIECE_VALUE[pieceType(tp)]!;
        if (tv >= 3) targets++;
      }
    });
    if (targets >= 2) mask |= Motif.Fork;
  }

  // sacrifice: the mover's piece sits on a square defended by a lower-value
  // enemy pawn/minor (a deliberate give-up). Cheap heuristic, paired with eval
  // delta in the commentary layer.
  if (landed !== EMPTY) {
    const lv = PIECE_VALUE[pieceType(landed)]!;
    if (lv >= 3 && isAttackedBy(board, to, opp)) mask |= Motif.Sacrifice;
  }

  return mask;
}

/** Call `cb` for each square the piece of type `t` on `sq` attacks. */
function forEachAttackTarget(
  board: Board,
  sq: number,
  t: PieceType,
  cb: (target: number) => void,
): void {
  const sf = sq & 7;
  const sr = sq >> 3;
  if (t === PieceType.Knight) {
    for (const [df, dr] of KNIGHT) {
      const f = sf + df;
      const r = sr + dr;
      if (onBoard(f, r)) cb(r * 8 + f);
    }
    return;
  }
  if (t === PieceType.King) {
    for (const [df, dr] of KING) {
      const f = sf + df;
      const r = sr + dr;
      if (onBoard(f, r)) cb(r * 8 + f);
    }
    return;
  }
  if (t === PieceType.Pawn) {
    const dir = pieceColor(board.squares[sq]!) === 0 ? 1 : -1;
    for (const df of [-1, 1]) {
      const f = sf + df;
      const r = sr + dir;
      if (onBoard(f, r)) cb(r * 8 + f);
    }
    return;
  }
  const dirs =
    t === PieceType.Bishop
      ? BISHOP_DIRS
      : t === PieceType.Rook
        ? ROOK_DIRS
        : [...BISHOP_DIRS, ...ROOK_DIRS];
  for (const [df, dr] of dirs) {
    let f = sf + df;
    let r = sr + dr;
    while (onBoard(f, r)) {
      const target = r * 8 + f;
      cb(target);
      if (board.squares[target]! !== EMPTY) break;
      f += df;
      r += dr;
    }
  }
}

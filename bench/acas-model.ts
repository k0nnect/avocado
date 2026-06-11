// Faithful port of A.C.A.S's per-move hot-path algorithms, so the comparison is
// against its REAL approach, not a strawman. Line citations refer to the
// reference source in ../A.C.A.S/acas.user.js.
//
// What A.C.A.S does on every detected move:
//   1. getBasicFen()  (acas.user.js:2167) — build an 8×8 char matrix, join rows
//      with '/', then squeezeEmptySquares() (:1903) regex-collapses runs of '1'.
//   2. getBoardSquareChangeAmount(lastFen, newFen) (:2221) — detect the move by
//      string-diffing two FENs: split, regex-expand digits to spaces, rejoin,
//      compare char by char.
//   3. CommLink ships everything as JSON (singlePacketResponseWaitTime: 250,
//      :440) — modelled here as JSON.stringify/parse of an eval frame.
//
// Each function mirrors the source's allocation profile (intermediate arrays,
// per-row join strings, regex passes) — that profile is the point of the
// comparison.

// piece byte → fen char, matching avocado's encoding (color<<3 | type)
const FEN_CHARS = ['', 'p', 'n', 'b', 'r', 'q', 'k'];
function byteToFenChar(p: number): string {
  if (p === 0) return '1'; // empty square placeholder, exactly like A.C.A.S's matrix
  const type = p & 0b111;
  const ch = FEN_CHARS[type]!;
  return p >> 3 === 0 ? ch.toUpperCase() : ch;
}

/** A.C.A.S getBoardMatrix(): an 8×8 array of fen chars built by scanning squares.
 *  We feed it avocado's mailbox so both sides parse the SAME position. */
function getBoardMatrix(mailbox: Uint8Array): string[][] {
  const matrix: string[][] = [];
  for (let rank = 7; rank >= 0; rank--) {
    const row: string[] = [];
    for (let file = 0; file < 8; file++) {
      row.push(byteToFenChar(mailbox[rank * 8 + file]!));
    }
    matrix.push(row);
  }
  return matrix;
}

// :1903
export function squeezeEmptySquares(fenStr: string): string {
  return fenStr.replace(/1+/g, (match) => String(match.length));
}

// :2167 — getBasicFen()
export function acasGetBasicFen(mailbox: Uint8Array): string {
  const boardMatrix = getBoardMatrix(mailbox);
  return squeezeEmptySquares(boardMatrix.map((x) => x.join('')).join('/'));
}

// :2221 — getBoardSquareChangeAmount(lastFen, newFen)
export function acasBoardSquareChangeAmount(lastFen: string, newFen: string): number {
  const board1 = lastFen
    .split(' ')[0]!
    .replace(/\d/g, (d) => ' '.repeat(Number(d)))
    .split('/')
    .join('');
  const board2 = newFen
    .split(' ')[0]!
    .replace(/\d/g, (d) => ' '.repeat(Number(d)))
    .split('/')
    .join('');

  const changedFrom: string[] = [];
  let diff = 0;
  for (let i = 0; i < board1.length; i++) {
    if (board1[i] !== board2[i]) {
      if ((board1[i]?.trim()?.length ?? 0) > 0) changedFrom.push(board1[i]!.toLowerCase());
      diff += 1;
    }
  }
  return diff;
}

// CommLink JSON transport (:440, singlePacketResponseWaitTime). A.C.A.S passes
// move/eval data as plain objects through a message bus that serializes to JSON.
export interface AcasEvalObject {
  depth: number;
  multipv: number;
  scoreType: 'cp' | 'mate';
  score: number;
  wdl: [number, number, number] | null;
  pv: string;
}

export function acasEncode(o: AcasEvalObject): string {
  return JSON.stringify(o);
}
export function acasDecode(s: string): AcasEvalObject {
  return JSON.parse(s);
}

// A.C.A.S board observing uses a MutationObserver PLUS a 250ms polling fallback
// (:2322, dumbBoardObservingInterval). Exposed as a constant for the latency
// model in the report.
export const ACAS_POLL_INTERVAL_MS = 250;

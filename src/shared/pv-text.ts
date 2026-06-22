// avocado pv → text — render a UCI principal variation as a compact, glanceable
// move list for the picture-in-picture readout ("e2e4 e7e5 g1f3" → "e4 e5 Nf3").
//
// This is a READOUT, not a PGN exporter. It is intentionally LIGHT SAN:
//   - no disambiguation (never "Nbd2" / "R1e2") — a glance, not a scoresheet,
//   - no check/mate marks (+ / #).
// Captures (including en passant), castling, and promotion ARE shown, since they
// carry the most meaning when skimming a line. It walks a scratch Board applying
// each move so piece identity and capture detection stay correct past ply 1.
// Cold path (called at most once per animation frame when the PiP is open).

import {
  Board,
  EMPTY,
  MoveFlag,
  PieceType,
  moveFrom,
  moveTo,
  moveFlag,
  pieceType,
  squareToAlgebraic,
  uciToMove,
} from './board.ts';

const FILE_CHARS = 'abcdefgh';
// piece letter by PieceType (1=P … 6=K); pawn is rendered without a letter.
const PIECE_LETTER = ['', '', 'N', 'B', 'R', 'Q', 'K'];

/**
 * Render `uciLine` (space-joined UCI moves) starting from `fen` as light SAN,
 * stopping after `maxPlies` moves. Returns '' for an empty/blank line, and stops
 * early on the first token that isn't a coherent move.
 */
export function pvToText(fen: string, uciLine: string, maxPlies = 12): string {
  const line = uciLine.trim();
  if (!line) return '';
  const board = new Board();
  board.loadMailboxFen(fen);

  let out = '';
  let count = 0;
  let i = 0;
  while (i < line.length && count < maxPlies) {
    let sp = line.indexOf(' ', i);
    if (sp === -1) sp = line.length;
    const uci = line.slice(i, sp);
    i = sp + 1;
    if (uci.length < 4) break;
    const m = uciToMove(uci, board);
    const san = sanOf(board, m); // read the board BEFORE applying
    if (!san) break;
    out = out ? `${out} ${san}` : san;
    board.applyMove(m);
    count++;
  }
  return out;
}

/** Light SAN for a single packed move on the current `board` (pre-apply). */
function sanOf(board: Board, m: number): string {
  const from = moveFrom(m);
  const to = moveTo(m);
  const flag = moveFlag(m);
  if (flag === MoveFlag.Castle) return (to & 7) === 6 ? 'O-O' : 'O-O-O';

  const piece = board.squares[from]!;
  if (!piece) return ''; // malformed PV — square is empty
  const type = pieceType(piece);
  const capture = board.squares[to] !== EMPTY || flag === MoveFlag.EnPassant;
  const dest = squareToAlgebraic(to);

  if (type === PieceType.Pawn) {
    const body = capture ? `${FILE_CHARS[from & 7]}x${dest}` : dest;
    const promo = promoLetter(flag);
    return promo ? `${body}=${promo}` : body;
  }
  return `${PIECE_LETTER[type]}${capture ? 'x' : ''}${dest}`;
}

function promoLetter(flag: number): string {
  switch (flag) {
    case MoveFlag.PromoN:
      return 'N';
    case MoveFlag.PromoB:
      return 'B';
    case MoveFlag.PromoR:
      return 'R';
    case MoveFlag.PromoQ:
    case MoveFlag.PromoQCapture:
      return 'Q';
    default:
      return '';
  }
}

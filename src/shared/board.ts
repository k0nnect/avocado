// avocado board core — zero-allocation board state for the capture hot path.
//
// Design goals (this is the GC-sensitive part of the pipeline):
//  - No object/array allocation per move. Two preallocated mailboxes are
//    swapped by reference; bitboards are updated in place by XOR.
//  - Moves are packed into a single 16-bit int (from|to|flags), never an object.
//  - FEN is rebuilt incrementally from scalar state (side, castling, ep) plus a
//    single 64-byte scan, into a reused character buffer.
//
// Piece encoding (one byte per square, 0 = empty):
//   value = (color << 3) | type
//   color: 0 = white, 1 = black
//   type:  1=P 2=N 3=B 4=R 5=Q 6=K
// Square index: a1 = 0, b1 = 1, … h8 = 63  (square = rank*8 + file).

export const EMPTY = 0;

export const enum PieceType {
  Pawn = 1,
  Knight = 2,
  Bishop = 3,
  Rook = 4,
  Queen = 5,
  King = 6,
}

export const WHITE = 0;
export const BLACK = 1;

export function makePiece(color: number, type: PieceType): number {
  return (color << 3) | type;
}
export function pieceColor(p: number): number {
  return p >> 3;
}
export function pieceType(p: number): number {
  return p & 0b111;
}

// Centipawn-ish material values, indexed by PieceType. King = 0 (never captured).
export const PIECE_VALUE = [0, 1, 3, 3, 5, 9, 0] as const;

// ---- move packing -----------------------------------------------------------
// 16-bit move: bits 0-5 = from, bits 6-11 = to, bits 12-15 = flags.
export const enum MoveFlag {
  Quiet = 0,
  Capture = 1,
  EnPassant = 2,
  Castle = 3,
  PromoN = 4,
  PromoB = 5,
  PromoR = 6,
  PromoQ = 7,
  PromoQCapture = 8, // promotion that is also a capture (rare to distinguish; kept for completeness)
}

export function packMove(from: number, to: number, flag: MoveFlag): number {
  return (from & 0x3f) | ((to & 0x3f) << 6) | ((flag & 0xf) << 12);
}
export function moveFrom(m: number): number {
  return m & 0x3f;
}
export function moveTo(m: number): number {
  return (m >> 6) & 0x3f;
}
export function moveFlag(m: number): number {
  return (m >> 12) & 0xf;
}

// ---- square <-> algebraic ---------------------------------------------------
const FILE_CHARS = 'abcdefgh';
export function squareToAlgebraic(sq: number): string {
  return FILE_CHARS[sq & 7] + (1 + (sq >> 3));
}
export function algebraicToSquare(s: string): number {
  const file = s.charCodeAt(0) - 97; // 'a'
  const rank = s.charCodeAt(1) - 49; // '1'
  return rank * 8 + file;
}

/** Pack a UCI move string ("e2e4", "e7e8q") into a 16-bit move given the board. */
export function uciToMove(uci: string, board: Board): number {
  const from = algebraicToSquare(uci.slice(0, 2));
  const to = algebraicToSquare(uci.slice(2, 4));
  const promo = uci.length > 4 ? uci[4] : '';
  let flag: MoveFlag = board.squares[to] !== EMPTY ? MoveFlag.Capture : MoveFlag.Quiet;
  if (promo) {
    flag =
      promo === 'n'
        ? MoveFlag.PromoN
        : promo === 'b'
          ? MoveFlag.PromoB
          : promo === 'r'
            ? MoveFlag.PromoR
            : MoveFlag.PromoQ;
  } else if (pieceType(board.squares[from]) === PieceType.King && Math.abs((to & 7) - (from & 7)) === 2) {
    flag = MoveFlag.Castle;
  } else if (
    pieceType(board.squares[from]) === PieceType.Pawn &&
    (to & 7) !== (from & 7) &&
    board.squares[to] === EMPTY
  ) {
    flag = MoveFlag.EnPassant;
  }
  return packMove(from, to, flag);
}

const PIECE_FEN = ['', 'P', 'N', 'B', 'R', 'Q', 'K'];

// Piece byte (color<<3 | type) → FEN ASCII code, precomputed once. White pieces
// occupy bytes 1..6, black 9..14; everything else is 0 (unused). Lets toFen emit
// a byte without branching on colour or calling toLowerCase per square.
const PIECE_CODE = new Uint8Array(16);
for (let t = 1; t <= 6; t++) {
  const upper = PIECE_FEN[t]!.charCodeAt(0);
  PIECE_CODE[t] = upper; // white
  PIECE_CODE[8 | t] = upper + 32; // black (ASCII lowercase offset)
}
// One shared decoder turns the reused byte buffer into the final FEN string.
const FEN_DECODER = new TextDecoder('latin1');

const FEN_TYPE: Record<string, PieceType> = {
  p: PieceType.Pawn,
  n: PieceType.Knight,
  b: PieceType.Bishop,
  r: PieceType.Rook,
  q: PieceType.Queen,
  k: PieceType.King,
};

/**
 * Board holds the full game state needed to reconstruct a legal FEN. Everything
 * is preallocated and mutated in place — construct ONE per game and reuse it.
 */
export class Board {
  /** 64-byte mailbox (the live position). */
  readonly squares = new Uint8Array(64);
  /** Scratch mailbox used by capture.ts for diffing against the previous frame. */
  readonly prev = new Uint8Array(64);

  /** Per (color,type) bitboards: index = color*7 + type. 64-bit via BigUint64Array. */
  readonly bitboards = new BigUint64Array(14);

  sideToMove = WHITE;
  castling = 0b1111; // KQkq bit order: 1=K 2=Q 4=k 8=q
  epSquare = -1; // en-passant target square, or -1
  halfmove = 0;
  fullmove = 1;

  // Reused FEN scratch: ASCII bytes are written here and decoded once, so toFen
  // allocates nothing beyond the final string (no per-square temporaries, no
  // toLowerCase, no array-of-strings join). Max FEN length is well under 96.
  private fenBytes = new Uint8Array(96);

  /** Reset to the standard starting position. */
  reset(): void {
    this.squares.fill(EMPTY);
    const back = [
      PieceType.Rook,
      PieceType.Knight,
      PieceType.Bishop,
      PieceType.Queen,
      PieceType.King,
      PieceType.Bishop,
      PieceType.Knight,
      PieceType.Rook,
    ];
    for (let f = 0; f < 8; f++) {
      this.squares[f] = makePiece(WHITE, back[f]);
      this.squares[8 + f] = makePiece(WHITE, PieceType.Pawn);
      this.squares[48 + f] = makePiece(BLACK, PieceType.Pawn);
      this.squares[56 + f] = makePiece(BLACK, back[f]);
    }
    this.sideToMove = WHITE;
    this.castling = 0b1111;
    this.epSquare = -1;
    this.halfmove = 0;
    this.fullmove = 1;
    this.rebuildBitboards();
  }

  /** Recompute all bitboards from the mailbox (cold path; used after reset/load). */
  rebuildBitboards(): void {
    this.bitboards.fill(0n);
    for (let sq = 0; sq < 64; sq++) {
      const p = this.squares[sq]!;
      if (p === EMPTY) continue;
      const idx = pieceColor(p) * 7 + pieceType(p);
      this.bitboards[idx]! |= 1n << BigInt(sq);
    }
  }

  /** Toggle a single square in the relevant bitboard (XOR, in place). */
  private xorSquare(sq: number, piece: number): void {
    if (piece === EMPTY) return;
    const idx = pieceColor(piece) * 7 + pieceType(piece);
    this.bitboards[idx]! ^= 1n << BigInt(sq);
  }

  /**
   * Load a position directly from a 64-byte mailbox (e.g. the first board the
   * capture pipeline sees). Copies bytes, rebuilds bitboards, leaves metadata
   * at caller-provided defaults.
   */
  loadMailbox(src: Uint8Array, side = WHITE, castling = 0b1111, ep = -1): void {
    this.squares.set(src);
    this.sideToMove = side;
    this.castling = castling;
    this.epSquare = ep;
    this.rebuildBitboards();
  }

  /**
   * Load a full position from a FEN string. Cold path (parses with split) —
   * used for tests, the popup's "set position", and resyncing after the diff
   * loop loses track. The capture hot path never calls this.
   */
  loadMailboxFen(fen: string): void {
    this.squares.fill(EMPTY);
    const parts = fen.trim().split(/\s+/);
    const placement = parts[0]!;
    let sq = 56; // start at a8 (rank 8), walk down
    for (let i = 0; i < placement.length; i++) {
      const ch = placement[i]!;
      if (ch === '/') {
        sq -= 16; // back to the start of the rank below
      } else if (ch >= '1' && ch <= '8') {
        sq += ch.charCodeAt(0) - 48;
      } else {
        const isWhite = ch >= 'A' && ch <= 'Z';
        const t = FEN_TYPE[ch.toLowerCase()]!;
        this.squares[sq] = makePiece(isWhite ? WHITE : BLACK, t);
        sq++;
      }
    }
    this.sideToMove = parts[1] === 'b' ? BLACK : WHITE;
    let c = 0;
    const rights = parts[2] ?? '-';
    if (rights.includes('K')) c |= 0b0001;
    if (rights.includes('Q')) c |= 0b0010;
    if (rights.includes('k')) c |= 0b0100;
    if (rights.includes('q')) c |= 0b1000;
    this.castling = c;
    this.epSquare = parts[3] && parts[3] !== '-' ? algebraicToSquare(parts[3]) : -1;
    this.halfmove = parts[4] ? parseInt(parts[4], 10) : 0;
    this.fullmove = parts[5] ? parseInt(parts[5], 10) : 1;
    this.rebuildBitboards();
  }

  /**
   * Apply a packed move, updating mailbox, bitboards, and metadata in place.
   * Assumes the move is legal (it came from a real board mutation or the engine).
   */
  applyMove(m: number): void {
    const from = moveFrom(m);
    const to = moveTo(m);
    const flag = moveFlag(m);
    const piece = this.squares[from]!;
    const color = pieceColor(piece);
    const captured = this.squares[to]!;

    // bitboard: lift from, clear any captured at to
    this.xorSquare(from, piece);
    this.xorSquare(to, captured);

    let landed = piece;
    if (flag >= MoveFlag.PromoN) {
      const promoType =
        flag === MoveFlag.PromoN
          ? PieceType.Knight
          : flag === MoveFlag.PromoB
            ? PieceType.Bishop
            : flag === MoveFlag.PromoR
              ? PieceType.Rook
              : PieceType.Queen;
      landed = makePiece(color, promoType);
    }
    this.xorSquare(to, landed);

    this.squares[from] = EMPTY;
    this.squares[to] = landed;

    // en passant: remove the pawn that was captured behind the ep square
    if (flag === MoveFlag.EnPassant) {
      const capSq = color === WHITE ? to - 8 : to + 8;
      this.xorSquare(capSq, this.squares[capSq]!);
      this.squares[capSq] = EMPTY;
    }

    // castling: move the rook too
    if (flag === MoveFlag.Castle) {
      const rank = from & ~7;
      const kingside = (to & 7) === 6;
      const rookFrom = rank + (kingside ? 7 : 0);
      const rookTo = rank + (kingside ? 5 : 3);
      const rook = this.squares[rookFrom]!;
      this.xorSquare(rookFrom, rook);
      this.xorSquare(rookTo, rook);
      this.squares[rookFrom] = EMPTY;
      this.squares[rookTo] = rook;
    }

    // update castling rights if king/rook left home, or a home rook was captured
    this.updateCastlingRights(from, to);

    // en-passant target for the next move
    this.epSquare =
      pieceType(piece) === PieceType.Pawn && Math.abs(to - from) === 16
        ? (from + to) >> 1
        : -1;

    // clocks
    if (pieceType(piece) === PieceType.Pawn || captured !== EMPTY || flag === MoveFlag.EnPassant) {
      this.halfmove = 0;
    } else {
      this.halfmove++;
    }
    if (color === BLACK) this.fullmove++;
    this.sideToMove = color ^ 1;
  }

  private updateCastlingRights(from: number, to: number): void {
    // any move from/to a corner or the king squares can revoke rights
    // white king e1=4, rooks a1=0 h1=7 ; black king e8=60, rooks a8=56 h8=63
    if (from === 4) this.castling &= ~0b0011;
    if (from === 60) this.castling &= ~0b1100;
    if (from === 7 || to === 7) this.castling &= ~0b0001; // white kingside
    if (from === 0 || to === 0) this.castling &= ~0b0010; // white queenside
    if (from === 63 || to === 63) this.castling &= ~0b0100; // black kingside
    if (from === 56 || to === 56) this.castling &= ~0b1000; // black queenside
  }

  /**
   * Build a FEN string for the current state. Writes ASCII codes into a reused
   * byte buffer and decodes once — the returned string is the ONLY allocation.
   * No per-square temporaries, no toLowerCase, no array join.
   */
  toFen(): string {
    const b = this.fenBytes;
    const sq = this.squares;
    let n = 0;
    // piece placement, rank 8 → rank 1
    for (let rank = 7; rank >= 0; rank--) {
      let empty = 0;
      const base = rank * 8;
      for (let file = 0; file < 8; file++) {
        const p = sq[base + file]!;
        if (p === EMPTY) {
          empty++;
          continue;
        }
        if (empty) {
          b[n++] = 48 + empty; // '0' + run length (always 1..8)
          empty = 0;
        }
        b[n++] = PIECE_CODE[p]!;
      }
      if (empty) b[n++] = 48 + empty;
      if (rank > 0) b[n++] = 47; // '/'
    }
    b[n++] = 32; // ' '
    b[n++] = this.sideToMove === WHITE ? 119 : 98; // 'w' / 'b'
    b[n++] = 32;
    // castling
    if (this.castling === 0) {
      b[n++] = 45; // '-'
    } else {
      if (this.castling & 0b0001) b[n++] = 75; // 'K'
      if (this.castling & 0b0010) b[n++] = 81; // 'Q'
      if (this.castling & 0b0100) b[n++] = 107; // 'k'
      if (this.castling & 0b1000) b[n++] = 113; // 'q'
    }
    b[n++] = 32;
    // en passant
    if (this.epSquare >= 0) {
      b[n++] = 97 + (this.epSquare & 7); // file 'a'..'h'
      b[n++] = 49 + (this.epSquare >> 3); // rank '1'..'8'
    } else {
      b[n++] = 45; // '-'
    }
    b[n++] = 32;
    n = writeUint(b, n, this.halfmove);
    b[n++] = 32;
    n = writeUint(b, n, this.fullmove);
    return FEN_DECODER.decode(b.subarray(0, n));
  }
}

/** Write a non-negative integer's decimal digits as ASCII into `b` at `n`. */
function writeUint(b: Uint8Array, n: number, value: number): number {
  if (value === 0) {
    b[n++] = 48;
    return n;
  }
  const start = n;
  let v = value;
  while (v > 0) {
    b[n++] = 48 + (v % 10);
    v = (v / 10) | 0;
  }
  // digits were written least-significant first; reverse in place
  for (let i = start, j = n - 1; i < j; i++, j--) {
    const tmp = b[i]!;
    b[i] = b[j]!;
    b[j] = tmp;
  }
  return n;
}

// ---- mailbox diff -----------------------------------------------------------

/** Result of diffing two mailboxes, written into a reused object (zero-alloc). */
export interface DiffResult {
  /** packed 16-bit move, or -1 if the diff isn't a single coherent move */
  move: number;
  /** PieceType captured (0 if none), for commentary */
  capturedType: number;
  /** color that moved */
  mover: number;
}

// Reused scratch so diffMailbox allocates nothing per call.
const _changed = new Int32Array(8); // squares whose contents changed (cap 8: handles castling)

/**
 * Diff `prev` → `cur` and infer the single move that produced it. Returns the
 * move packed into `out`. Handles quiet moves, captures, castling, en passant,
 * and promotions. Returns out.move = -1 when the change can't be read as one
 * legal move (board flip, setup, multi-move jump) — caller should resync.
 *
 * Zero allocation: scans 64 bytes, records up to 8 changed squares in a static
 * buffer, classifies by pattern.
 */
export function diffMailbox(
  prev: Uint8Array,
  cur: Uint8Array,
  side: number,
  out: DiffResult,
): DiffResult {
  let n = 0;
  for (let sq = 0; sq < 64; sq++) {
    if (prev[sq] !== cur[sq]) {
      if (n < _changed.length) _changed[n] = sq;
      n++;
    }
  }
  out.move = -1;
  out.capturedType = 0;
  out.mover = side;

  if (n < 2 || n > 4) return out; // not a single move

  // Identify the "from" (became empty for the side to move) and "to" (now holds
  // a piece of the side to move). Castling touches 4 squares; ep touches 3.
  let from = -1;
  let to = -1;
  let capturedType = 0;

  for (let i = 0; i < n; i++) {
    const sq = _changed[i]!;
    const before = prev[sq]!;
    const after = cur[sq]!;
    if (after === EMPTY && before !== EMPTY && pieceColor(before) === side) {
      // a square the mover vacated; the real "from" is a non-rook in castling
      if (from === -1 || pieceType(before) === PieceType.King) from = sq;
    } else if (after !== EMPTY && pieceColor(after) === side) {
      // a square the mover now occupies; "to" is a non-rook in castling
      if (to === -1 || pieceType(after) === PieceType.King) to = sq;
      if (before !== EMPTY && pieceColor(before) !== side) capturedType = pieceType(before);
    }
  }

  if (from === -1 || to === -1) return out;

  const movedPiece = cur[to]!;
  let flag: MoveFlag = capturedType ? MoveFlag.Capture : MoveFlag.Quiet;

  // castling: king moved two files and 4 squares changed
  if (pieceType(movedPiece) === PieceType.King && Math.abs((to & 7) - (from & 7)) === 2) {
    flag = MoveFlag.Castle;
  }

  // promotion: a pawn became something else on the back rank
  const fromWasPawn = pieceType(prev[from]!) === PieceType.Pawn;
  if (fromWasPawn && pieceType(movedPiece) !== PieceType.Pawn) {
    const t = pieceType(movedPiece);
    flag =
      t === PieceType.Knight
        ? MoveFlag.PromoN
        : t === PieceType.Bishop
          ? MoveFlag.PromoB
          : t === PieceType.Rook
            ? MoveFlag.PromoR
            : MoveFlag.PromoQ;
  }

  // en passant: pawn changed file to an empty target, with a 3rd changed square
  if (
    fromWasPawn &&
    (to & 7) !== (from & 7) &&
    prev[to] === EMPTY &&
    capturedType === 0 &&
    n === 3
  ) {
    flag = MoveFlag.EnPassant;
    capturedType = PieceType.Pawn;
  }

  out.move = packMove(from, to, flag);
  out.capturedType = capturedType;
  return out;
}

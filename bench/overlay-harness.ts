// Visual harness: builds a realistic chess.com board DOM, then drives avocado's
// ChesscomAdapter + Overlay with a mock multi-pv eval to verify the eval bar and
// arrows render in the correct squares. No engine, no extension APIs — pure
// drawing verification (the half that can't be unit-tested).

import { ChesscomAdapter } from '../src/content/adapters/chesscom.ts';
import { Overlay } from '../src/content/overlay.ts';
import type { EvalFrame } from '../src/shared/protocol.ts';

const EDGE = 60;
const SIZE = EDGE * 8;

// Build a chess.com-style board: <wc-chess-board class="board"> with .piece
// elements carrying `square-XY` classes (file 1-8, rank 1-8).
const board = document.createElement('wc-chess-board');
board.className = 'board';
Object.assign(board.style, {
  position: 'absolute',
  left: '80px',
  top: '40px',
  width: `${SIZE}px`,
  height: `${SIZE}px`,
  background:
    'conic-gradient(#7e9eb8 90deg, #d6e2ea 0 180deg, #7e9eb8 0 270deg, #d6e2ea 0) 0 0/' +
    `${EDGE * 2}px ${EDGE * 2}px`,
});

// start position pieces (just enough for findBoard's `.piece` check + realism)
const START: Array<[number, number, string]> = [];
for (let f = 1; f <= 8; f++) {
  START.push([f, 2, 'wp'], [f, 7, 'bp']);
}
const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
for (let f = 1; f <= 8; f++) {
  START.push([f, 1, 'w' + back[f - 1]], [f, 8, 'b' + back[f - 1]]);
}
for (const [f, r, code] of START) {
  const p = document.createElement('div');
  p.className = `piece ${code} square-${f}${r}`;
  Object.assign(p.style, {
    position: 'absolute',
    width: `${EDGE}px`,
    height: `${EDGE}px`,
    left: `${(f - 1) * EDGE}px`,
    top: `${(8 - r) * EDGE}px`,
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'center',
    'font-size': '30px',
    color: code[0] === 'w' ? '#f4ecd8' : '#3a3a3a',
  });
  const glyph: Record<string, string> = { p: '♟', r: '♜', n: '♞', b: '♝', q: '♛', k: '♚' };
  p.textContent = glyph[code[1]!] ?? '';
  board.appendChild(p);
}
document.body.appendChild(board);

// drive the overlay
const adapter = new ChesscomAdapter();
const overlay = new Overlay(adapter, board);
overlay.mount();

// mock eval: white to move, +37cp, three PV lines (e2e4 / d2d4 / g1f3), opp reply
const frames: EvalFrame[] = [
  { depth: 24, multipv: 1, mate: false, score: 37, wdl: [512, 460, 28], line: 'e2e4 e7e5 g1f3' },
  { depth: 24, multipv: 2, mate: false, score: 30, wdl: [500, 470, 30], line: 'd2d4 d7d5 c2c4' },
  { depth: 24, multipv: 3, mate: false, score: 22, wdl: [480, 480, 40], line: 'g1f3 g8f6 c2c4' },
];
overlay.setEval(frames, /* safeArrows */ true, /* stmIsWhite */ true);
overlay.pushCommentary('absolute positional dominance, buddy', 'dominance');

// expose for assertions
(window as unknown as { _adapter: ChesscomAdapter; _board: HTMLElement })._adapter = adapter;
(window as unknown as { _board: HTMLElement })._board = board;

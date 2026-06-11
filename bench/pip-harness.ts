// Visual harness for the PiP window. Document Picture-in-Picture needs a user
// gesture + can't open headless, so we stub `documentPictureInPicture` to return
// the current window — PipController then builds its UI into this page, letting
// us screenshot the exact board/arrows/commentary it would show in the real PiP.

import { PipController } from '../src/content/pip.ts';
import { Board, uciToMove } from '../src/shared/board.ts';
import type { EvalFrame } from '../src/shared/protocol.ts';

Object.defineProperty(window, 'documentPictureInPicture', {
  configurable: true,
  value: { requestWindow: async () => window },
});

const b = new Board();
b.reset();
for (const uci of ['e2e4', 'c7c5', 'g1f3']) b.applyMove(uciToMove(uci, b));

const frames: EvalFrame[] = [
  { depth: 26, multipv: 1, mate: false, score: 41, wdl: null, line: 'd2d4 c5d4 f3d4 g8f6' },
  { depth: 26, multipv: 2, mate: false, score: 33, wdl: null, line: 'f1b5 b8c6 e1g1' },
  { depth: 26, multipv: 3, mate: false, score: 21, wdl: null, line: 'b1c3 b8c6 f1b5' },
];

const pip = new PipController();
await pip.open();
pip.setEval(frames, b.squares, /* orientation */ 0, '+0.41');
pip.pushCommentary('absolute positional dominance, buddy', 'dominance', 'user');
pip.pushCommentary('dude logged', 'resign', 'enemy');

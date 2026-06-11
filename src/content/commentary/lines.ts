// avocado commentary line tables — pre-indexed, lowercase, high-larp.
//
// The commentary state machine classifies each move into ONE category, then
// indexes into that category's flat array and picks a variant. No allocation:
// every line is a literal already in memory; we only return a reference.
//
// Categories are ordered by priority in commentary.ts (mate > hung queen > …).
// Audio triggers in a later version map 1:1 onto these same category keys, so
// keep keys stable.

export const enum LineCat {
  MateGiving, // mover is delivering forced mate
  MateGettingMated, // mover just walked into a forced mate
  HungQueen, // mover lost their queen
  HungPiece, // mover lost a rook/minor
  Brilliancy, // big positive swing, often a sac
  Blunder, // big negative swing
  Mistake,
  Inaccuracy,
  BigCapture, // grabbed a rook/queen
  Fork,
  Check,
  Promotion,
  Castle,
  TimeScramble, // moved in deep time trouble
  Premove, // moved basically instantly
  Tank, // sat and thought forever
  Dominance, // quietly crushing
  Equal, // dead level
  Filler, // nothing else fired
}

// tag = the small violet label shown above the line.
export interface LineSet {
  tag: string;
  lines: readonly string[];
}

export const LINES: Readonly<Record<LineCat, LineSet>> = {
  [LineCat.MateGiving]: {
    tag: 'mate incoming',
    lines: [
      'mate is on the board buddy, it is OVER',
      'count it. it is forced. say goodnight',
      'the king has nowhere to run, nowhere to hide',
      'checkmate speedrun any%, lets gooo',
    ],
  },
  [LineCat.MateGettingMated]: {
    tag: 'uh oh',
    lines: [
      'oh no. oh no no no. that is getting mated',
      'we are so cooked. the king is in the blender',
      'wait is that mate? that is mate. pack it up',
      'somebody call a doctor, this king is not okay',
    ],
  },
  [LineCat.HungQueen]: {
    tag: 'the queen',
    lines: [
      'oh no, my queen!!',
      'the lady is GONE. who hung the queen',
      'not the queen bro. not like this',
      'queen just walked into traffic, incredible',
    ],
  },
  [LineCat.HungPiece]: {
    tag: 'free piece',
    lines: [
      'that is just hanging. free real estate',
      'a whole piece, gift wrapped, no notes',
      'somebody left a piece en prise and i am feasting',
      'oof. that piece is not coming back',
    ],
  },
  [LineCat.Brilliancy]: {
    tag: 'juicer alert',
    lines: [
      'wait, is that a juicer??',
      'NO WAY he saw that. absolute filth',
      'sacrifice the soul, win the game. gorgeous',
      'that is a top engine move buddy, chefs kiss',
    ],
  },
  [LineCat.Blunder]: {
    tag: 'blunder',
    lines: [
      'oh that is a catastrophe. what are we doing',
      'the eval bar just fell off a cliff',
      'big yikes. that move lost the plot entirely',
      'from winning to losing in one click, classic',
    ],
  },
  [LineCat.Mistake]: {
    tag: 'mistake',
    lines: [
      'eh, that is not it chief',
      'small disaster. recoverable but ouch',
      'the engine is not happy with that one',
      'we are leaking advantage, tighten up',
    ],
  },
  [LineCat.Inaccuracy]: {
    tag: 'inaccuracy',
    lines: [
      'slightly inaccurate but we move',
      'not the cleanest, still fine',
      'engine raises an eyebrow. minor',
    ],
  },
  [LineCat.BigCapture]: {
    tag: 'nom',
    lines: [
      'snack acquired. delicious',
      'just took the big piece, no hesitation',
      'material in the bank, baby',
    ],
  },
  [LineCat.Fork]: {
    tag: 'fork',
    lines: [
      'FORK. pick one, you cannot save both',
      'the family fork, somebody is losing material',
      'two birds, one knight. brutal',
    ],
  },
  [LineCat.Check]: {
    tag: 'check',
    lines: ['check please', 'poke. king on the move', 'annoying little check, i love it'],
  },
  [LineCat.Promotion]: {
    tag: 'promotion',
    lines: ['new queen just dropped', 'pawn went to college and came back a queen', 'big promote'],
  },
  [LineCat.Castle]: {
    tag: 'castle',
    lines: ['king tucked away safe and cozy', 'castles. responsible chess', 'safety first, o-o'],
  },
  [LineCat.TimeScramble]: {
    tag: 'scramble',
    lines: [
      'NO TIME NO TIME just move',
      'flagging incoming, pure chaos now',
      'this is a blitz scramble and i am living for it',
    ],
  },
  [LineCat.Premove]: {
    tag: 'instant',
    lines: ['premoved without even looking, cold', 'instant. did not even blink', 'zero think, all vibes'],
  },
  [LineCat.Tank]: {
    tag: 'big think',
    lines: ['tanked for ages and played the obvious move', 'deep in the think tank', 'the calculation arc'],
  },
  [LineCat.Dominance]: {
    tag: 'dominance',
    lines: [
      'absolute positional dominance, buddy',
      'this is just clean. total control',
      'slow squeeze. the python special',
    ],
  },
  [LineCat.Equal]: {
    tag: 'dead even',
    lines: ['dead level, anybody can win this', 'flat as a pancake, play on', 'the eval bar is asleep'],
  },
  [LineCat.Filler]: {
    tag: 'avocado',
    lines: ['solid. carry on', 'noted. the plan continues', 'fine move, nothing spicy'],
  },
};

/** xorshift32 PRNG — deterministic variant picking with no Math.random. */
export function xorshift(seed: number): number {
  let x = seed | 0 || 0x9e3779b9;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

/** Pick a line from a category given a seed. Returns the line + its tag. */
export function pickLine(cat: LineCat, seed: number): { tag: string; text: string } {
  const set = LINES[cat];
  const idx = xorshift(seed) % set.lines.length;
  return { tag: set.tag, text: set.lines[idx]! };
}

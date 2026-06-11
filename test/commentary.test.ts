import { describe, it, expect } from 'vitest';
import { Commentary, type CommentaryInput } from '../src/content/commentary/commentary.ts';
import { LineCat } from '../src/content/commentary/lines.ts';
import { Motif } from '../src/content/commentary/motifs.ts';
import { WHITE, BLACK } from '../src/shared/board.ts';

function base(over: Partial<CommentaryInput> = {}): CommentaryInput {
  return {
    mover: WHITE,
    evalCpWhite: 0,
    mateWhite: 0,
    capturedValue: 0,
    moveTimeMs: 5000,
    clockMs: 120000,
    motifs: 0,
    ...over,
  };
}

describe('commentary classification', () => {
  it('mate for the mover dominates everything', () => {
    const c = new Commentary();
    const out = c.observe(base({ mateWhite: 3, mover: WHITE, motifs: Motif.Check }), 1000);
    expect(out?.cat).toBe(LineCat.MateGiving);
  });

  it('walking into mate fires the getting-mated line', () => {
    const c = new Commentary();
    // black moved and now white mates black → black is getting mated
    const out = c.observe(base({ mover: BLACK, mateWhite: 2 }), 1000);
    expect(out?.cat).toBe(LineCat.MateGettingMated);
  });

  it('a big eval drop for the mover is a blunder/hang', () => {
    const c = new Commentary();
    c.observe(base({ evalCpWhite: 50 }), 0); // establish baseline ~ even
    const out = c.observe(base({ mover: WHITE, evalCpWhite: -600 }), 5000);
    expect([LineCat.Blunder, LineCat.HungPiece, LineCat.HungQueen]).toContain(out?.cat);
  });

  it('a fork is announced when the move is sound', () => {
    const c = new Commentary();
    c.observe(base({ evalCpWhite: 20 }), 0);
    const out = c.observe(base({ mover: WHITE, evalCpWhite: 40, motifs: Motif.Fork }), 5000);
    expect(out?.cat).toBe(LineCat.Fork);
  });

  it('grabbing a rook triggers a big-capture line', () => {
    const c = new Commentary();
    c.observe(base(), 0);
    const out = c.observe(base({ capturedValue: 5, evalCpWhite: 30 }), 5000);
    expect(out?.cat).toBe(LineCat.BigCapture);
  });

  it('time scramble fires under 10s on the clock', () => {
    const c = new Commentary();
    c.observe(base(), 0);
    const out = c.observe(base({ clockMs: 4000, evalCpWhite: 10 }), 5000);
    expect(out?.cat).toBe(LineCat.TimeScramble);
  });
});

describe('commentary cooldowns', () => {
  it('does not repeat the same category within the cooldown', () => {
    const c = new Commentary();
    c.observe(base(), 0);
    const a = c.observe(base({ capturedValue: 9, evalCpWhite: 100 }), 5000);
    expect(a?.cat).toBe(LineCat.BigCapture);
    // immediately again — within cooldown, should be suppressed
    const b = c.observe(base({ capturedValue: 9, evalCpWhite: 120 }), 5500);
    expect(b).toBeNull();
  });

  it('enforces a global gap between any two callouts', () => {
    const c = new Commentary();
    c.observe(base(), 0);
    const a = c.observe(base({ motifs: Motif.Check, evalCpWhite: 20 }), 5000);
    expect(a).not.toBeNull();
    const b = c.observe(base({ capturedValue: 9, evalCpWhite: 40 }), 5500); // <1500ms later
    expect(b).toBeNull();
  });
});

describe('commentary determinism', () => {
  it('same seed sequence yields the same lines', () => {
    const mk = () => {
      const c = new Commentary();
      const texts: string[] = [];
      let t = 0;
      for (let i = 0; i < 5; i++) {
        c.observe(base(), t);
        t += 7000;
        const o = c.observe(base({ capturedValue: 9, evalCpWhite: 100 + i }), t);
        t += 7000;
        if (o) texts.push(o.text);
      }
      return texts;
    };
    expect(mk()).toEqual(mk());
  });
});

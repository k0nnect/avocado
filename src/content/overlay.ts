// avocado overlay — canvas eval bar + ranked multi-pv arrows + commentary ticker.
//
// Performance contract:
//  - ONE fixed-position canvas with pointer-events:none, so it never intercepts
//    clicks or forces the page to relayout.
//  - All drawing happens inside a single requestAnimationFrame, only when a
//    dirty flag is set. No per-frame layout reads: the board rect is cached and
//    refreshed only on resize/scroll (passive) via ResizeObserver.
//  - The ticker is a tiny DOM node updated with textContent + a CSS class
//    (compositor-only opacity/transform), never innerHTML in a loop.

import type { SiteAdapter } from './adapters/types.ts';
import type { EvalFrame } from '../shared/protocol.ts';
import { PV_COLORS, OPP_COLOR, VIOLET } from '../shared/theme.ts';
import { algebraicToSquare } from '../shared/board.ts';

interface ArrowPV {
  from: number; // square index
  to: number;
  rank: number; // 0 = best
}

export class Overlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ticker: HTMLDivElement;
  private tickerTimer = 0;

  private rect: DOMRect;
  private dpr = Math.max(1, window.devicePixelRatio || 1);
  private dirty = false;
  private rafPending = false;

  // current render state
  private arrows: ArrowPV[] = [];
  private oppArrow: ArrowPV | null = null;
  private showArrows = false; // safe-mode gate
  private hoverOnly = false; // "moves on demand"
  private evalCp = 0;
  private evalMate = 0; // signed mate distance, 0 = none
  private wdl: readonly [number, number, number] | null = null;

  private resizeObs: ResizeObserver;

  constructor(
    private readonly adapter: SiteAdapter,
    private readonly boardEl: HTMLElement,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'avocado-canvas';
    this.ctx = this.canvas.getContext('2d')!;
    this.ticker = document.createElement('div');
    this.ticker.className = 'avocado-ticker';
    this.rect = this.adapter.boardRect(this.boardEl);

    this.resizeObs = new ResizeObserver(() => this.refreshRect());
  }

  mount(): void {
    document.body.appendChild(this.canvas);
    document.body.appendChild(this.ticker);
    this.resizeObs.observe(this.boardEl);
    window.addEventListener('scroll', this.refreshRect, { passive: true, capture: true });
    window.addEventListener('resize', this.refreshRect, { passive: true });
    this.refreshRect();
  }

  unmount(): void {
    this.resizeObs.disconnect();
    window.removeEventListener('scroll', this.refreshRect, { capture: true } as any);
    window.removeEventListener('resize', this.refreshRect);
    this.canvas.remove();
    this.ticker.remove();
  }

  /** Cache the board rect and size the canvas to cover it (+ a left gutter for
   * the eval bar). Called only on resize/scroll, never in the render path. */
  private refreshRect = (): void => {
    this.rect = this.adapter.boardRect(this.boardEl);
    const gutter = 18; // px for the eval bar to the left of the board
    const w = this.rect.width + gutter;
    const h = this.rect.height;
    this.canvas.style.left = `${this.rect.left - gutter}px`;
    this.canvas.style.top = `${this.rect.top}px`;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    // ticker sits just below the board
    this.ticker.style.left = `${this.rect.left}px`;
    this.ticker.style.top = `${this.rect.bottom + 8}px`;
    this.markDirty();
  };

  // ---- inputs from the pipeline ----

  /** Update evaluation + the ranked PV arrows from a set of multipv frames. */
  setEval(
    frames: ReadonlyArray<EvalFrame>,
    safeArrows: boolean,
    stmIsWhite: boolean,
  ): void {
    this.showArrows = safeArrows;
    // frame scores are from the side-to-move's POV; normalize the eval bar to
    // White's POV so "up" always means White is better.
    const best = frames.find((f) => f.multipv === 1) ?? frames[0];
    if (best) {
      const sign = stmIsWhite ? 1 : -1;
      this.evalMate = best.mate ? best.score * sign : 0;
      this.evalCp = best.mate ? 0 : best.score * sign;
      this.wdl = best.wdl;
    }

    this.arrows.length = 0;
    this.oppArrow = null;
    for (const f of frames) {
      const moves = f.line.split(' ');
      const first = moves[0];
      if (!first || first.length < 4) continue;
      const rank = f.multipv - 1;
      if (rank < PV_COLORS.length) {
        this.arrows.push({
          from: algebraicToSquare(first.slice(0, 2)),
          to: algebraicToSquare(first.slice(2, 4)),
          rank,
        });
      }
      // opponent-reply guess from the best line's 2nd ply (A.C.A.S-style)
      if (rank === 0 && moves.length > 1 && moves[1]!.length >= 4) {
        this.oppArrow = {
          from: algebraicToSquare(moves[1]!.slice(0, 2)),
          to: algebraicToSquare(moves[1]!.slice(2, 4)),
          rank: -1,
        };
      }
    }
    this.markDirty();
  }

  setHoverOnly(v: boolean): void {
    this.hoverOnly = v;
    this.markDirty();
  }

  /** Show a commentary line in the ticker; auto-hides after a few seconds. */
  pushCommentary(text: string, tag?: string): void {
    this.ticker.textContent = '';
    if (tag) {
      const t = document.createElement('span');
      t.className = 'avocado-tag';
      t.textContent = tag;
      this.ticker.appendChild(t);
    }
    this.ticker.appendChild(document.createTextNode(text));
    this.ticker.classList.add('show');
    if (this.tickerTimer) clearTimeout(this.tickerTimer);
    this.tickerTimer = window.setTimeout(() => this.ticker.classList.remove('show'), 4200);
  }

  // ---- render loop ----

  private markDirty(): void {
    this.dirty = true;
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      if (this.dirty) {
        this.dirty = false;
        this.render();
      }
    });
  }

  private render(): void {
    const ctx = this.ctx;
    const gutter = 18;
    const edge = this.rect.width / 8;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.drawEvalBar(gutter);

    if (this.showArrows && !this.hoverOnly) {
      // draw weakest → strongest so the best line lands on top
      for (let i = this.arrows.length - 1; i >= 0; i--) {
        const a = this.arrows[i]!;
        this.drawArrow(a.from, a.to, PV_COLORS[a.rank] ?? VIOLET.soft, gutter, edge, 1 - a.rank * 0.22);
      }
      if (this.oppArrow) {
        this.drawArrow(this.oppArrow.from, this.oppArrow.to, OPP_COLOR, gutter, edge, 0.5);
      }
    }
  }

  /** Vertical eval bar in the left gutter; White advantage fills from the bottom. */
  private drawEvalBar(gutter: number): void {
    const ctx = this.ctx;
    const h = this.rect.height;
    const w = gutter - 6;
    const x = 2;
    ctx.fillStyle = VIOLET.bgPanel;
    ctx.fillRect(x, 0, w, h);

    // map eval → fraction White (0..1). mate dominates.
    let frac: number;
    if (this.evalMate !== 0) {
      frac = this.evalMate > 0 ? 1 : 0;
    } else {
      // logistic squ/ash: ~1 pawn ≈ small shift, saturates by ~+8
      frac = 1 / (1 + Math.exp(-this.evalCp / 320));
    }
    const fillH = h * frac;
    ctx.fillStyle = VIOLET.primary;
    ctx.fillRect(x, h - fillH, w, fillH);

    // midline
    ctx.strokeStyle = 'rgba(218,191,252,0.5)'; // lilac midline
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, h / 2);
    ctx.lineTo(x + w, h / 2);
    ctx.stroke();
  }

  /** Map a square index to a pixel center on the canvas (accounts for gutter +
   * orientation). */
  private squareCenter(sq: number, gutter: number, edge: number): [number, number] {
    const file = sq & 7;
    const rank = sq >> 3;
    const flipped = this.adapter.orientation(this.boardEl) === 1;
    const col = flipped ? 7 - file : file;
    const row = flipped ? rank : 7 - rank;
    return [gutter + (col + 0.5) * edge, (row + 0.5) * edge];
  }

  private drawArrow(
    from: number,
    to: number,
    color: string,
    gutter: number,
    edge: number,
    alpha: number,
  ): void {
    const ctx = this.ctx;
    const [x1, y1] = this.squareCenter(from, gutter, edge);
    const [x2, y2] = this.squareCenter(to, gutter, edge);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const head = edge * 0.34;
    const width = edge * 0.16;
    // shorten so the head sits inside the target square
    const ex = x2 - ux * head * 0.8;
    const ey = y2 - uy * head * 0.8;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // arrowhead
    const px = -uy;
    const py = ux;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(ex - px * head * 0.5, ey - py * head * 0.5);
    ctx.lineTo(ex + px * head * 0.5, ey + py * head * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

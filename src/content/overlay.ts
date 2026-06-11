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
  // Two tickers: the user's commentary sits below their side of the board, the
  // enemy's above theirs. Which is which depends on board orientation.
  private tickerBottom: HTMLDivElement; // user side
  private tickerTop: HTMLDivElement; // enemy side
  private timerBottom = 0;
  private timerTop = 0;
  private popoutBtn: HTMLButtonElement;
  private statusEl: HTMLDivElement;
  private statusTimer = 0;

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
    private boardEl: HTMLElement,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'avocado-canvas';
    this.ctx = this.canvas.getContext('2d')!;
    this.tickerBottom = document.createElement('div');
    this.tickerBottom.className = 'avocado-ticker';
    this.tickerTop = document.createElement('div');
    this.tickerTop.className = 'avocado-ticker avocado-ticker-enemy';
    this.popoutBtn = document.createElement('button');
    this.popoutBtn.className = 'avocado-popout';
    this.popoutBtn.textContent = '⧉';
    this.popoutBtn.title = 'pop out to picture-in-picture';
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'avocado-status';
    this.rect = this.adapter.boardRect(this.boardEl);

    this.resizeObs = new ResizeObserver(() => this.refreshRect());
  }

  /** Wire the pop-out button to a handler (opens/closes the PiP window). */
  onPopout(fn: () => void): void {
    this.popoutBtn.addEventListener('click', fn);
  }

  /** Re-target the overlay onto a new board element (after an SPA swap). */
  setBoard(el: HTMLElement): void {
    this.resizeObs.disconnect();
    this.boardEl = el;
    this.resizeObs.observe(el);
    this.refreshRect();
  }

  mount(): void {
    document.body.appendChild(this.canvas);
    document.body.appendChild(this.tickerBottom);
    document.body.appendChild(this.tickerTop);
    document.body.appendChild(this.popoutBtn);
    document.body.appendChild(this.statusEl);
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
    this.tickerBottom.remove();
    this.tickerTop.remove();
    this.popoutBtn.remove();
    this.statusEl.remove();
  }

  /**
   * Show a small status pill near the board ("scanning…", "thinking…", engine
   * errors). `sticky` keeps it until the next call; otherwise it fades after 2.5s.
   * Makes a stalled pipeline visible instead of a silent blank board.
   */
  setStatus(text: string, sticky = false): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.add('show');
    if (this.statusTimer) clearTimeout(this.statusTimer);
    if (!sticky) {
      this.statusTimer = window.setTimeout(() => this.statusEl.classList.remove('show'), 2500);
    }
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
    // Tickers: user below the board, enemy above it. Right-aligned to the board's
    // right edge so they clear the player avatar + name, which sit on the left.
    const rightPx = Math.max(0, window.innerWidth - this.rect.right);
    this.tickerBottom.style.left = 'auto';
    this.tickerBottom.style.right = `${rightPx}px`;
    this.tickerBottom.style.top = `${this.rect.bottom + 8}px`;
    this.tickerTop.style.left = 'auto';
    this.tickerTop.style.right = `${rightPx}px`;
    this.tickerTop.style.top = `${this.rect.top - 8}px`; // CSS anchors it by its bottom edge
    // pop-out button: top-right corner just outside the board
    this.popoutBtn.style.left = `${this.rect.right - 30}px`;
    this.popoutBtn.style.top = `${this.rect.top - 26}px`;
    // status pill: under the pop-out button, right-aligned
    this.statusEl.style.right = `${Math.max(0, window.innerWidth - this.rect.right)}px`;
    this.statusEl.style.top = `${this.rect.top + 4}px`;
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

  /**
   * Show a commentary line. `side` picks the ticker: 'user' (below the board) or
   * 'enemy' (above it), so each player's moves get commentary on their own side.
   */
  pushCommentary(text: string, tag: string | undefined, side: 'user' | 'enemy'): void {
    const el = side === 'enemy' ? this.tickerTop : this.tickerBottom;
    el.textContent = '';
    if (tag) {
      const t = document.createElement('span');
      t.className = 'avocado-tag';
      t.textContent = tag;
      el.appendChild(t);
    }
    el.appendChild(document.createTextNode(text));
    el.classList.add('show');
    if (side === 'enemy') {
      if (this.timerTop) clearTimeout(this.timerTop);
      this.timerTop = window.setTimeout(() => el.classList.remove('show'), 4200);
    } else {
      if (this.timerBottom) clearTimeout(this.timerBottom);
      this.timerBottom = window.setTimeout(() => el.classList.remove('show'), 4200);
    }
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
      // opponent-reply guess first (underneath), then PV lines weakest → strongest
      if (this.oppArrow) {
        this.drawArrow(this.oppArrow.from, this.oppArrow.to, OPP_COLOR, gutter, edge, 0.5, 0);
      }
      for (let i = this.arrows.length - 1; i >= 0; i--) {
        const a = this.arrows[i]!;
        // rank+1 → #1 is the best move, #2/#3 the alternates
        this.drawArrow(a.from, a.to, PV_COLORS[a.rank] ?? VIOLET.soft, gutter, edge, 1 - a.rank * 0.22, a.rank + 1);
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
    label: number,
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

    // priority badge (#1 = best). Drawn opaque on top, near the arrow tail so it
    // labels which piece to move. Apple system font for the numeral.
    if (label > 0) {
      const r = edge * 0.155;
      const bx = x1 + ux * (edge * 0.3);
      const by = y1 + uy * (edge * 0.3);
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = Math.max(1, edge * 0.03);
      ctx.strokeStyle = '#11111b';
      ctx.stroke();
      ctx.fillStyle = '#11111b';
      ctx.font = `700 ${r * 1.25}px -apple-system, 'SF Pro Text', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(label), bx, by);
    }
  }
}

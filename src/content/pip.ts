// avocado picture-in-picture — a floating companion window (Document
// Picture-in-Picture, Chrome 116+) showing the eval, the ranked best-move
// arrows, the two commentary tickers, and a toggleable board view.
//
// Unlike A.C.A.S (which renders to a canvas, captures a MediaStream, pipes it
// through a <video>, and requests video-PiP — adding encode/decode latency),
// this is a real DOM window we draw into directly. Updates are rAF-throttled and
// reuse buffers, so a move reflects in the PiP within one frame, zero per-update
// allocation.
//
// The board is drawn from the position avocado already tracks (Unicode chess
// glyphs), so it needs none of chess.com's sprites/stylesheets to render.

import { PV_COLORS, OPP_COLOR, VIOLET } from '../shared/theme.ts';
import { pieceType, pieceColor, WHITE, algebraicToSquare } from '../shared/board.ts';
import type { EvalFrame } from '../shared/protocol.ts';

interface PipArrow {
  from: number;
  to: number;
  rank: number;
}

// glyphs indexed by PieceType (1..6 = P N B R Q K)
const GLYPH_W = ['', '♙', '♘', '♗', '♖', '♕', '♔'];
const GLYPH_B = ['', '♟', '♞', '♝', '♜', '♛', '♚'];

const BOARD_PX = 296;

export class PipController {
  private win: Window | null = null;
  private doc: Document | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private boardWrap: HTMLElement | null = null;
  private enemyEl: HTMLElement | null = null;
  private userEl: HTMLElement | null = null;
  private evalEl: HTMLElement | null = null;
  private showBoard = true;
  private dirty = false;
  private rafId = 0;

  // latest state — reused buffers, no per-update allocation
  private readonly mailbox = new Uint8Array(64);
  private arrows: PipArrow[] = [];
  private opp: PipArrow | null = null;
  private orientation = 0;
  private evalText = '';

  get isOpen(): boolean {
    return !!this.win;
  }

  async toggle(): Promise<void> {
    if (this.isOpen) this.close();
    else await this.open();
  }

  async open(): Promise<void> {
    const dpip = (window as unknown as { documentPictureInPicture?: { requestWindow(o: object): Promise<Window> } })
      .documentPictureInPicture;
    if (!dpip?.requestWindow) {
      console.warn('avocado: Document Picture-in-Picture not supported in this browser');
      return;
    }
    this.win = await dpip.requestWindow({ width: 320, height: 470 });
    this.doc = this.win.document;
    this.build();
    this.win.addEventListener('pagehide', () => this.onClosed());
    this.scheduleRender();
  }

  close(): void {
    this.win?.close();
    this.onClosed();
  }

  private onClosed(): void {
    if (this.rafId && this.win) this.win.cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.win = this.doc = null;
    this.canvas = this.ctx = null;
    this.boardWrap = this.enemyEl = this.userEl = this.evalEl = null;
  }

  private build(): void {
    const d = this.doc!;
    const style = d.createElement('style');
    style.textContent = PIP_CSS;
    d.head.appendChild(style);
    d.body.className = 'avo-pip';

    const header = d.createElement('div');
    header.className = 'avo-h';
    const brand = d.createElement('span');
    brand.className = 'avo-brand';
    brand.textContent = 'avocado';
    const evalEl = d.createElement('span');
    evalEl.className = 'avo-eval';
    this.evalEl = evalEl;
    const tog = d.createElement('label');
    tog.className = 'avo-tog';
    const cb = d.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.showBoard;
    cb.addEventListener('change', () => {
      this.showBoard = cb.checked;
      if (this.boardWrap) this.boardWrap.style.display = this.showBoard ? 'block' : 'none';
      this.scheduleRender();
    });
    tog.append(cb, d.createTextNode('board'));
    header.append(brand, evalEl, tog);

    const enemy = d.createElement('div');
    enemy.className = 'avo-line avo-enemy';
    this.enemyEl = enemy;

    const wrap = d.createElement('div');
    wrap.className = 'avo-board';
    this.boardWrap = wrap;
    const canvas = d.createElement('canvas');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    wrap.appendChild(canvas);
    wrap.style.display = this.showBoard ? 'block' : 'none';

    const user = d.createElement('div');
    user.className = 'avo-line avo-user';
    this.userEl = user;

    d.body.append(header, enemy, wrap, user);
  }

  // ---- inputs from the pipeline ----

  /** Update eval + arrows + the board snapshot. Cheap; only called when open. */
  setEval(
    frames: ReadonlyArray<EvalFrame>,
    mailbox: Uint8Array,
    orientation: number,
    evalText: string,
  ): void {
    if (!this.win) return;
    this.mailbox.set(mailbox);
    this.orientation = orientation;
    this.evalText = evalText;
    this.arrows.length = 0;
    this.opp = null;
    for (const f of frames) {
      const sp = f.line.indexOf(' ');
      const first = sp === -1 ? f.line : f.line.slice(0, sp);
      if (first.length < 4) continue;
      const rank = f.multipv - 1;
      if (rank < PV_COLORS.length) {
        this.arrows.push({
          from: algebraicToSquare(first.slice(0, 2)),
          to: algebraicToSquare(first.slice(2, 4)),
          rank,
        });
      }
      if (rank === 0 && sp !== -1) {
        const rest = f.line.slice(sp + 1);
        const sp2 = rest.indexOf(' ');
        const m2 = sp2 === -1 ? rest : rest.slice(0, sp2);
        if (m2.length >= 4) {
          this.opp = { from: algebraicToSquare(m2.slice(0, 2)), to: algebraicToSquare(m2.slice(2, 4)), rank: -1 };
        }
      }
    }
    this.scheduleRender();
  }

  pushCommentary(text: string, tag: string | undefined, side: 'user' | 'enemy'): void {
    const el = side === 'enemy' ? this.enemyEl : this.userEl;
    if (!el) return;
    el.textContent = tag ? `${tag} · ${text}` : text;
    el.classList.add('show');
  }

  // ---- render (rAF-throttled, runs in the PiP window) ----

  private scheduleRender(): void {
    if (!this.win) return;
    this.dirty = true;
    if (this.rafId) return;
    this.rafId = this.win.requestAnimationFrame(() => {
      this.rafId = 0;
      if (this.dirty) {
        this.dirty = false;
        this.render();
      }
    });
  }

  private render(): void {
    if (this.evalEl) this.evalEl.textContent = this.evalText;
    if (!this.showBoard || !this.ctx || !this.canvas || !this.win) return;

    const dpr = this.win.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(BOARD_PX * dpr)) {
      this.canvas.width = Math.round(BOARD_PX * dpr);
      this.canvas.height = Math.round(BOARD_PX * dpr);
      this.canvas.style.width = `${BOARD_PX}px`;
      this.canvas.style.height = `${BOARD_PX}px`;
    }
    const ctx = this.ctx;
    const edge = BOARD_PX / 8;
    const flipped = this.orientation === 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // squares
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        ctx.fillStyle = (r + f) & 1 ? '#3b364f' : '#5a5476';
        ctx.fillRect(f * edge, r * edge, edge, edge);
      }
    }

    // pieces
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${edge * 0.74}px 'SF Pro Text', -apple-system, system-ui, sans-serif`;
    for (let sq = 0; sq < 64; sq++) {
      const p = this.mailbox[sq]!;
      if (!p) continue;
      const [cx, cy] = this.center(sq, edge, flipped);
      const white = pieceColor(p) === WHITE;
      ctx.fillStyle = white ? '#f4ecd8' : '#15121c';
      ctx.fillText((white ? GLYPH_W : GLYPH_B)[pieceType(p)]!, cx, cy);
    }

    // arrows: opponent reply under the ranked PV lines
    if (this.opp) this.drawArrow(this.opp.from, this.opp.to, OPP_COLOR, edge, 0.5, 0, flipped);
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i]!;
      this.drawArrow(a.from, a.to, PV_COLORS[a.rank] ?? VIOLET.soft, edge, 1 - a.rank * 0.22, a.rank + 1, flipped);
    }
  }

  private center(sq: number, edge: number, flipped: boolean): [number, number] {
    const file = sq & 7;
    const rank = sq >> 3;
    const col = flipped ? 7 - file : file;
    const row = flipped ? rank : 7 - rank;
    return [(col + 0.5) * edge, (row + 0.5) * edge];
  }

  private drawArrow(
    from: number,
    to: number,
    color: string,
    edge: number,
    alpha: number,
    label: number,
    flipped: boolean,
  ): void {
    const ctx = this.ctx!;
    const [x1, y1] = this.center(from, edge, flipped);
    const [x2, y2] = this.center(to, edge, flipped);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const head = edge * 0.34;
    const ex = x2 - ux * head * 0.8;
    const ey = y2 - uy * head * 0.8;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = edge * 0.16;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    const px = -uy;
    const py = ux;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(ex - px * head * 0.5, ey - py * head * 0.5);
    ctx.lineTo(ex + px * head * 0.5, ey + py * head * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

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

const PIP_CSS = `
  :root { color-scheme: dark; }
  body.avo-pip {
    margin: 0; padding: 10px; background: #11111b; color: #cdd6f4;
    font-family: 'SF Pro Text', -apple-system, 'SFMono-Regular', monospace;
    font-size: 12px; text-transform: lowercase; user-select: none;
  }
  .avo-h { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .avo-brand { font-weight: 700; letter-spacing: 2px; color: #cba6f7; text-shadow: 0 0 8px rgba(203,166,247,0.5); }
  .avo-eval { color: #dabffc; font-variant-numeric: tabular-nums; }
  .avo-tog { margin-left: auto; display: flex; align-items: center; gap: 5px; color: #9399b2; cursor: pointer; }
  .avo-tog input { accent-color: #cba6f7; }
  .avo-board { line-height: 0; border-radius: 6px; overflow: hidden; box-shadow: 0 0 12px rgba(203,166,247,0.25); }
  .avo-line {
    min-height: 18px; margin: 7px 2px; padding: 6px 9px; border-radius: 6px;
    background: rgba(24,24,37,0.0); border: 1px solid transparent; line-height: 1.35;
    transition: background .15s, border-color .15s;
  }
  .avo-line.show { background: rgba(24,24,37,0.94); }
  .avo-enemy.show { border-color: #b4befe; }
  .avo-user.show { border-color: #cba6f7; }
`;

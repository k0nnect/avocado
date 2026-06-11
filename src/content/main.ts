// avocado content script entry — wires the four pipelines together on a
// supported chess page:
//
//   capture (DOM → FEN) ──▶ engine (via SW Port) ──▶ overlay + commentary
//
// Lifecycle: wait for a board to exist, pick the matching site adapter, open a
// persistent Port to the service worker, and stream positions out / eval frames
// back. Settings (safe mode, multipv, hash, hover-only) come from chrome.storage
// and update live via storage.onChanged — no polling.

import { LichessAdapter } from './adapters/lichess.ts';
import { ChesscomAdapter } from './adapters/chesscom.ts';
import type { SiteAdapter } from './adapters/types.ts';
import { CapturePipeline, type CaptureEvent } from './capture.ts';
import { Overlay } from './overlay.ts';
import { Commentary } from './commentary/commentary.ts';
import { detectMotifs } from './commentary/motifs.ts';
import { Board, WHITE, isGeometricallyLegal, algebraicToSquare } from '../shared/board.ts';
import {
  encodePosition,
  encodeAnalyse,
  decodeEval,
  decodeBestMove,
  opOf,
  Op,
  type EvalFrame,
  type GameContext,
} from '../shared/protocol.ts';

interface Settings {
  safeArrowsOverride: boolean; // force-enable arrows in live human games
  hoverOnly: boolean;
  multipv: number;
  hashMb: number;
  engineBuild: string;
  commentary: boolean;
}

const DEFAULTS: Settings = {
  safeArrowsOverride: false,
  hoverOnly: false,
  multipv: 3,
  hashMb: 256,
  engineBuild: 'stockfish-18-lite.js',
  commentary: true,
};

const COMMENTARY_DEPTH = 14; // speak once the best line is this deep

const ADAPTERS: SiteAdapter[] = [new LichessAdapter(), new ChesscomAdapter()];

// Flip on with `chrome.storage.local.set({ debug: true })` then reload the page
// to trace the pipeline (board found → position sent → eval received → drawn).
let DEBUG = false;
function dbg(...args: unknown[]): void {
  if (DEBUG) console.log('%c avocado ', 'background:#cba6f7;color:#11111b', ...args);
}

class Avocado {
  private adapter!: SiteAdapter;
  private boardEl!: HTMLElement;
  private port: chrome.runtime.Port | null = null;
  private capture!: CapturePipeline;
  private overlay!: Overlay;
  private commentary = new Commentary();
  private settings: Settings = { ...DEFAULTS };

  // per-move state
  private board = new Board(); // mirrors the position we last sent the engine
  private pending: CaptureEvent | null = null;
  private spokenForMove = false;
  private pvFrames = new Map<number, EvalFrame>(); // multipv → latest frame

  async boot(): Promise<void> {
    const adapter = ADAPTERS.find((a) => a.matches());
    if (!adapter) return;
    this.adapter = adapter;

    await this.loadSettings();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') this.onSettingsChanged(changes);
    });

    dbg('booting on', this.adapter.name);
    const board = await this.waitForBoard();
    if (!board) {
      dbg('no board found — giving up');
      return;
    }
    this.boardEl = board;
    dbg('board found', board.tagName.toLowerCase(), '· context', this.adapter.gameContext());

    this.connectPort();

    this.overlay = new Overlay(this.adapter, this.boardEl);
    this.overlay.mount();
    this.overlay.setHoverOnly(this.settings.hoverOnly);

    // push engine config (multipv/hash/threads — threads decided in the worker)
    this.send(encodeAnalyse(this.settings.multipv, this.settings.hashMb, 0));

    this.capture = new CapturePipeline(this.adapter, this.boardEl, (e) => this.onMove(e));
    this.capture.start();

    this.watchGameOver();
  }

  /**
   * Connect (or reconnect) the Port to the service worker. MV3 service workers
   * are killed after ~30s idle, which disconnects the Port — posting on it then
   * throws "Attempting to use a disconnected port object". We mark the port dead
   * on disconnect and lazily reconnect on the next send (chrome.runtime.connect
   * wakes the service worker back up).
   */
  private connectPort(): void {
    this.port = chrome.runtime.connect({ name: 'avocado-content' });
    this.port.onMessage.addListener((frame: string) => this.onEngineFrame(frame));
    this.port.onDisconnect.addListener(() => {
      dbg('port disconnected (service worker idled) — will reconnect on next send');
      this.port = null;
    });
  }

  /** Post a frame to the engine, transparently reconnecting a dead Port. */
  private send(frame: string): void {
    if (!this.port) this.connectPort();
    try {
      this.port!.postMessage(frame);
    } catch {
      // port died between the check and the post — reconnect once and retry
      this.connectPort();
      try {
        this.port!.postMessage(frame);
      } catch {
        dbg('send failed after reconnect — extension reloaded?');
        this.port = null;
      }
    }
  }

  private async loadSettings(): Promise<void> {
    const stored = await chrome.storage.local.get({ ...DEFAULTS, debug: false });
    this.settings = { ...DEFAULTS, ...stored } as Settings;
    DEBUG = (stored as { debug?: boolean }).debug === true;
  }

  private onSettingsChanged(changes: { [k: string]: chrome.storage.StorageChange }): void {
    let reanalyse = false;
    for (const k in changes) {
      (this.settings as any)[k] = changes[k]!.newValue;
      if (k === 'multipv' || k === 'hashMb') reanalyse = true;
      if (k === 'hoverOnly') this.overlay?.setHoverOnly(this.settings.hoverOnly);
    }
    if (reanalyse) {
      this.send(encodeAnalyse(this.settings.multipv, this.settings.hashMb, 0));
    }
  }

  /** Poll the DOM (via a short-lived observer) until the board appears. */
  private waitForBoard(): Promise<HTMLElement | null> {
    return new Promise((resolve) => {
      const found = this.adapter.findBoard();
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const b = this.adapter.findBoard();
        if (b) {
          obs.disconnect();
          resolve(b);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      // give up quietly after 30s (page may not be a game)
      setTimeout(() => {
        obs.disconnect();
        resolve(this.adapter.findBoard());
      }, 30000);
    });
  }

  /** A move landed on the board → analyse the new position. */
  private onMove(e: CaptureEvent): void {
    this.pending = e;
    this.spokenForMove = false;
    this.pvFrames.clear();
    // Mirror the analysed position so we can validate engine moves against it
    // before drawing (rejects impossible arrows from any stale/garbage eval).
    this.board.loadMailboxFen(e.fen);

    const context: GameContext = this.adapter.gameContext();
    const safeArrows = this.computeSafeArrows(context);

    dbg(e.move < 0 ? 'position (baseline)' : 'move', e.fen, '· ctx', context, '· arrows', safeArrows);
    this.send(encodePosition({ fen: e.fen, context, safeArrows }));
  }

  /** Is the engine's principal move actually possible on the analysed board? */
  private bestMoveLegal(): boolean {
    const best = this.pvFrames.get(1);
    if (!best || best.line.length < 4) return false;
    // first UCI token, without allocating a split array
    const from = algebraicToSquare(best.line.slice(0, 2));
    const to = algebraicToSquare(best.line.slice(2, 4));
    return isGeometricallyLegal(this.board.squares, from, to);
  }

  /** Arrows allowed automatically unless it's the user's live human game. */
  private computeSafeArrows(context: GameContext): boolean {
    if (context === 'analysis' || context === 'spectating' || context === 'bot') return true;
    // 'playing' (or 'unknown') → only if the user explicitly opted in
    return this.settings.safeArrowsOverride;
  }

  private onEngineFrame(frame: string): void {
    const op = opOf(frame);
    if (op === Op.Log) {
      dbg('engine:', frame.slice(2));
      return;
    }
    if (!this.pending) return;
    if (op === Op.BestMove) {
      // search ended (rare in infinite mode; happens on game end) — ignore
      decodeBestMove(frame);
      return;
    }
    if (op !== Op.Eval) return;

    const f = decodeEval(frame);
    if (this.pvFrames.size === 0) dbg('first eval', `d${f.depth}`, f.mate ? `#${f.score}` : `${f.score}cp`, f.line.split(' ')[0]);
    this.pvFrames.set(f.multipv, f);

    // side to move in the analysed position = opponent of the mover
    const stm = this.pending.mover ^ 1;
    const stmIsWhite = stm === WHITE;

    // Don't draw until the engine's best move is actually possible on the board.
    // If it isn't, this eval is stale/garbage (e.g. the position changed under
    // us) — skip it rather than render an impossible arrow.
    if (!this.bestMoveLegal()) {
      dbg('skip draw — best move not legal on current board');
      return;
    }

    // refresh the overlay with the current set of PV lines
    const frames = [...this.pvFrames.values()].sort((a, b) => a.multipv - b.multipv);
    const context = this.adapter.gameContext();
    this.overlay.setEval(frames, this.computeSafeArrows(context), stmIsWhite);

    // commentary: fire once, when the best line reaches a stable depth — but
    // only for real moves (move >= 0); the baseline resync position (move = -1)
    // draws eval/arrows without a callout.
    if (
      this.settings.commentary &&
      !this.spokenForMove &&
      this.pending.move >= 0 &&
      f.multipv === 1 &&
      f.depth >= COMMENTARY_DEPTH
    ) {
      this.speak(f, stmIsWhite);
      this.spokenForMove = true;
    }
  }

  private speak(best: EvalFrame, stmIsWhite: boolean): void {
    const e = this.pending!;
    // board already mirrors e.fen (loaded in onMove); motif detection reads it
    const motifs = detectMotifs(this.board, e.move, e.mover, e.capturedValue);

    const whiteSign = stmIsWhite ? 1 : -1;
    const evalCpWhite = best.mate ? 0 : best.score * whiteSign;
    const mateWhite = best.mate ? best.score * whiteSign : 0;

    const out = this.commentary.observe(
      {
        mover: e.mover,
        evalCpWhite,
        mateWhite,
        capturedValue: e.capturedValue,
        moveTimeMs: e.moveTimeMs,
        clockMs: e.clockMs,
        motifs,
      },
      performance.now(),
    );
    if (out) this.overlay.pushCommentary(out.text, out.tag, this.sideOf(e.mover));
  }

  /** Which ticker a move's commentary belongs to: the mover's own side. */
  private sideOf(mover: number): 'user' | 'enemy' {
    // orientation: 0 = white on bottom (user is white), 1 = black on bottom.
    const userColor = this.adapter.orientation(this.boardEl);
    return mover === userColor ? 'user' : 'enemy';
  }

  // ---- game-over watch (resign / flag / mate / stalemate) ----
  private gameOverObs: MutationObserver | null = null;
  private gameOverTimer = 0;

  private watchGameOver(): void {
    this.gameOverObs = new MutationObserver(() => {
      if (this.gameOverTimer) return; // single-flight debounce
      this.gameOverTimer = self.setTimeout(() => {
        this.gameOverTimer = 0;
        this.checkGameOver();
      }, 400);
    });
    this.gameOverObs.observe(document.body, { childList: true, subtree: true });
  }

  private checkGameOver(): void {
    const kind = this.adapter.gameResult();
    if (!kind || kind === 'draw') return; // draw = no callout for now
    const callout = this.commentary.gameEnd(kind);
    if (!callout) return;
    dbg('game over:', kind);
    // "dude logged" lands on the opponent's side; the rest on the user's side.
    this.overlay.pushCommentary(callout.text, callout.tag, kind === 'resign' ? 'enemy' : 'user');
  }
}

// content script runs at document_start; kick off once the DOM is usable.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new Avocado().boot());
} else {
  new Avocado().boot();
}

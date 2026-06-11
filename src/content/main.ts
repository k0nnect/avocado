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
import { Board, WHITE } from '../shared/board.ts';
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
  private port!: chrome.runtime.Port;
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

    this.port = chrome.runtime.connect({ name: 'avocado-content' });
    this.port.onMessage.addListener((frame: string) => this.onEngineFrame(frame));

    this.overlay = new Overlay(this.adapter, this.boardEl);
    this.overlay.mount();
    this.overlay.setHoverOnly(this.settings.hoverOnly);

    // push engine config (multipv/hash/threads — threads decided in the worker)
    this.port.postMessage(encodeAnalyse(this.settings.multipv, this.settings.hashMb, 0));

    this.capture = new CapturePipeline(this.adapter, this.boardEl, (e) => this.onMove(e));
    this.capture.start();
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
      this.port.postMessage(encodeAnalyse(this.settings.multipv, this.settings.hashMb, 0));
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

    const context: GameContext = this.adapter.gameContext();
    const safeArrows = this.computeSafeArrows(context);

    dbg(e.move < 0 ? 'position (baseline)' : 'move', e.fen, '· ctx', context, '· arrows', safeArrows);
    this.port.postMessage(
      encodePosition({ fen: e.fen, context, safeArrows }),
    );
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
    // rebuild the analysed position so motif detection has the board state
    this.board.loadMailboxFen(e.fen);
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
    if (out) this.overlay.pushCommentary(out.text, out.tag);
  }
}

// content script runs at document_start; kick off once the DOM is usable.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new Avocado().boot());
} else {
  new Avocado().boot();
}

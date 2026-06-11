// avocado engine worker — owns the Stockfish wasm and the UCI loop.
//
// Runs as a module Worker inside the offscreen document. The vendored Stockfish
// build (stockfish.js family) is itself an Emscripten Worker that talks UCI over
// postMessage and spawns its own pthread workers for multi-threading. So this
// worker BRIDGES:
//   host ──postMessage(command frame)──▶ engine-worker ──UCI──▶ stockfish sub-worker
//   stockfish ──UCI info line──▶ engine-worker ──(parse, pack)──▶ EVAL ring ──▶ host
//
// Why a ring for the eval direction but postMessage for commands:
//  - eval `info` lines arrive in bursts while thinking; packing them into a SAB
//    ring the host drains avoids a structured-clone allocation per line (the GC
//    pressure A.C.A.S's JSON message bus suffers). Commands are rare (one per
//    move) so postMessage is fine there.
//  - We must NOT block on Atomics.wait here: Stockfish delivers its output via
//    postMessage onto THIS worker's event loop, so the loop has to stay free.
//
// Parsing of `info` lines is zero-copy: indexOf/charCodeAt + slice, never split.

import { RingWriter, type RingLayout } from './ring-buffer.ts';
import {
  opOf,
  Op,
  decodePosition,
  decodeAnalyse,
  encodeEval,
  encodeBestMove,
  type EvalFrame,
} from '../shared/protocol.ts';
import { parseInfoLine, parseBestMove } from './uci-parse.ts';

// Eval frames go out via the SAB ring when the offscreen doc is crossOriginIsolated
// (fast path, no clone per line). When it isn't, SharedArrayBuffer doesn't exist,
// so we fall back to plain postMessage — slower, but it works everywhere.
let evalWriter: RingWriter | null = null;
let engine: Worker; // the Stockfish sub-worker
let threads = 1;
let hashMb = 256;
let multipv = 3;
let analysing = false;

/** Send a frame to the host: SAB ring if available, else postMessage. */
function emit(frame: string): void {
  if (evalWriter) evalWriter.write(frame);
  else (self as unknown as Worker).postMessage(frame);
}

// Reused eval frame — mutated and re-encoded per line, never reallocated.
const frame: EvalFrame = { depth: 0, multipv: 1, mate: false, score: 0, wdl: null, line: '' };

// UCI ready handshake. Stockfish's wasm loads asynchronously; commands sent
// before it's ready get dropped (this is the "engine never responds" race). We
// hold host commands in a queue until we've seen `uciok` → `readyok`, then flush.
let ready = false;
const queue: string[] = [];

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m && m.type === 'init') {
    init(m);
    return;
  }
  if (typeof m === 'string') handleCommand(m);
};

let hwc = 4;
let fallbackUrl = '';
let triedFallback = false;

function init(m: {
  evalSab: SharedArrayBuffer | null;
  evalCap: number;
  engineUrl: string;
  fallbackUrl: string;
  hardwareConcurrency: number;
}): void {
  evalWriter = m.evalSab ? new RingWriter({ sab: m.evalSab, capacity: m.evalCap } as RingLayout) : null;
  hwc = m.hardwareConcurrency;
  fallbackUrl = m.fallbackUrl;
  spawn(m.engineUrl);
}

/** (Re)spawn the Stockfish sub-worker for `url` and start the UCI handshake. */
function spawn(url: string): void {
  // Single-threaded builds ignore the Threads option; for threaded use cores−1.
  threads = url.includes('single') ? 1 : Math.max(1, hwc - 1);
  ready = false;

  try {
    engine = new Worker(url);
  } catch (err) {
    log(`FAILED to construct engine worker: ${(err as Error)?.message ?? err}`);
    tryFallback(url);
    return;
  }
  engine.onmessage = (e: MessageEvent) =>
    onEngineLine(typeof e.data === 'string' ? e.data : (e.data?.data ?? ''));
  engine.onerror = (e) => {
    log(`stockfish error: ${e.message ?? 'unknown'}`);
    tryFallback(url);
  };

  log(`engine starting · ${url.split('/').pop()} · threads=${threads}`);
  send('uci'); // → uciok → applyConfig → readyok → flush queue

  // If it doesn't reach readyok, the build can't run here (e.g. pthreads/SAB
  // unavailable) — fall back to the rock-solid single-threaded build.
  self.setTimeout(() => {
    if (!ready) tryFallback(url);
  }, 8000);
}

function tryFallback(failedUrl: string): void {
  if (ready || triedFallback || !fallbackUrl || failedUrl.includes('single')) {
    if (!ready && !fallbackUrl) log('engine FAILED and no fallback available');
    return;
  }
  triedFallback = true;
  log('engine did not start — falling back to single-threaded build');
  // NOTE: keep evalWriter as-is. The SAB ring is the engine-worker↔host
  // transport, independent of which Stockfish build runs; only the stockfish
  // sub-worker changes here.
  try {
    engine.terminate();
  } catch {
    /* ignore */
  }
  spawn(fallbackUrl);
}

/** Emit a debug log line to the host (host + content surface it). */
function log(text: string): void {
  try {
    emit(`l:${text}`);
  } catch {
    /* transport not ready */
  }
  console.log('avocado engine:', text);
}

function send(cmd: string): void {
  engine.postMessage(cmd);
}

function applyConfig(): void {
  send(`setoption name Threads value ${threads}`);
  send(`setoption name Hash value ${hashMb}`);
  send(`setoption name MultiPV value ${multipv}`);
  send('setoption name UCI_ShowWDL value true');
  send('setoption name UCI_AnalyseMode value true');
  send('isready');
}

function handleCommand(s: string): void {
  if (!ready) {
    // Engine still booting — keep only the latest position (they supersede each
    // other) plus any analyse/stop, so the queue can't grow unbounded.
    if (opOf(s) === Op.Position) {
      const i = queue.findIndex((q) => opOf(q) === Op.Position);
      if (i >= 0) queue[i] = s;
      else queue.push(s);
    } else {
      queue.push(s);
    }
    return;
  }
  handleCommandNow(s);
}

function handleCommandNow(s: string): void {
  switch (opOf(s)) {
    case Op.Position: {
      const p = decodePosition(s);
      if (analysing) send('stop');
      send(`position fen ${p.fen}`);
      // Streaming search: `go infinite`, interrupted by `stop` on the next
      // position. Eval sharpens continuously rather than truncating at a fixed
      // movetime (A.C.A.S used fixed movetime; we don't).
      send('go infinite');
      analysing = true;
      break;
    }
    case Op.Analyse: {
      const cfg = decodeAnalyse(s);
      multipv = cfg.multipv;
      hashMb = cfg.hashMb;
      threads = cfg.threads;
      if (analysing) send('stop');
      applyConfig();
      break;
    }
    case Op.Stop: {
      if (analysing) send('stop');
      analysing = false;
      break;
    }
  }
}

// ---- UCI output → eval ring -------------------------------------------------
// Parsing lives in uci-parse.ts (pure + unit-tested against real SF18 output).
function onEngineLine(line: string): void {
  if (!line) return;

  // handshake: uciok → configure; readyok → ready, flush queued commands
  if (line.startsWith('uciok')) {
    applyConfig(); // sends setoptions + isready (→ readyok)
    return;
  }
  if (line.startsWith('readyok')) {
    if (!ready) {
      ready = true;
      log(`engine ready · ${queue.length} queued`);
      for (const q of queue) handleCommandNow(q);
      queue.length = 0;
    }
    return;
  }

  const best = parseBestMove(line);
  if (best !== null) {
    emit(encodeBestMove(best));
    return;
  }

  if (parseInfoLine(line, frame)) {
    // If the ring is momentarily full the host is a tick behind; the next depth
    // supersedes this line anyway, so dropping it costs nothing visible.
    emit(encodeEval(frame));
  }
}

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

let evalWriter: RingWriter;
let engine: Worker; // the Stockfish sub-worker
let threads = 1;
let hashMb = 256;
let multipv = 3;
let analysing = false;

// Reused eval frame — mutated and re-encoded per line, never reallocated.
const frame: EvalFrame = { depth: 0, multipv: 1, mate: false, score: 0, wdl: null, line: '' };

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m && m.type === 'init') {
    init(m);
    return;
  }
  if (typeof m === 'string') handleCommand(m);
};

function init(m: {
  evalSab: SharedArrayBuffer;
  evalCap: number;
  engineUrl: string;
  hardwareConcurrency: number;
}): void {
  evalWriter = new RingWriter({ sab: m.evalSab, capacity: m.evalCap } as RingLayout);
  threads = Math.max(1, m.hardwareConcurrency - 1);

  // Spawn the vendored Stockfish. It is a CLASSIC Emscripten worker (UCI over
  // postMessage); it locates its own .wasm relative to its URL and spawns
  // pthreads internally. Both inherit the offscreen doc's crossOriginIsolation.
  engine = new Worker(m.engineUrl);
  engine.onmessage = (e: MessageEvent) => onEngineLine(typeof e.data === 'string' ? e.data : e.data?.data ?? '');
  engine.onerror = (e) => console.error('avocado stockfish error:', e.message);

  // Boot UCI at FULL STRENGTH — no Skill Level / UCI_LimitStrength, ever.
  send('uci');
  applyConfig();
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

  const best = parseBestMove(line);
  if (best !== null) {
    evalWriter.write(encodeBestMove(best));
    return;
  }

  if (parseInfoLine(line, frame)) {
    // If the ring is momentarily full the host is a tick behind; the next depth
    // supersedes this line anyway, so dropping it costs nothing visible.
    evalWriter.write(encodeEval(frame));
  }
}

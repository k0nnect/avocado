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

// Position serialization. Stockfish must NOT receive a new `position` while a
// search is running — doing so traps the wasm ("unreachable") and kills the
// engine, which looks like the overlay drawing one arrow then freezing. So we
// track the position the host WANTS analysed (`desiredFen`) separately from the
// one currently being searched (`searchingFen`): a new position only interrupts
// via `stop`, and the actual `position`/`go` is sent once the running search
// reports `bestmove`. driveSearch() is the single place that issues commands.
let desiredFen = '';
let searchingFen = '';
// Engine options changed (Op.Analyse) while a search may be running — applied
// by driveSearch() at the next idle moment, never mid-search.
let configDirty = false;
// Crash resilience: if the engine traps anyway, respawn and re-analyse the
// desired position rather than freezing. Bounded so a pathological position
// can't spin forever; the counter resets after any clean search. If even that
// is exhausted, reviveIfDead() brings the engine back on the next watchdog
// position (rate-limited) — the engine is never permanently dead.
let crashCount = 0;
const MAX_CRASH_RESPAWNS = 6;
let currentUrl = ''; // engine build url last spawned, for revive
let lastSpawnAt = 0; // performance.now() of the last spawn, for revive cooldown
const REVIVE_COOLDOWN_MS = 10_000;

// Wedge detection. The multithreaded stockfish.js occasionally hangs SILENTLY on
// its first `go` (thread-pool/shared-memory init race): handshake completes,
// commands are accepted, but no info line ever comes back — not even for depth 1,
// which normally lands in <50ms. We can't fix the race inside the wasm, so we
// detect it (search running, zero output after WEDGE_MS) and respawn: once more
// threaded, then the single-threaded build, which has never wedged. Worst case
// a few seconds to live evals instead of a permanent "engine waking…" hang.
let goAt = 0; // performance.now() when the current `go` was issued
let searchAlive = false; // any output seen for the current search
let wedgeRespawns = 0;
const WEDGE_MS = 2000;
self.setInterval(() => {
  if (!ready || !analysing || searchAlive) return;
  if (goAt === 0 || performance.now() - goAt < WEDGE_MS) return;
  wedgeRespawns++;
  const next = wedgeRespawns >= 2 && fallbackUrl ? fallbackUrl : currentUrl;
  log(`search wedged (no output ${WEDGE_MS}ms after go) — respawning ${next.split('/').pop()}`);
  try {
    engine.terminate();
  } catch {
    /* ignore */
  }
  spawn(next);
}, 500);

// Search bounds. The original design ran `go infinite`, which NEVER stops on its
// own — on a static position (e.g. an open analysis board, or while the player
// thinks) every engine thread pegs a core indefinitely. A companion doesn't need
// depth 60: a high-but-finite depth ceiling reaches near-perfect play in a second
// or two and then STOPS, freeing the CPU until the next move. Streaming `info`
// lines still update the overlay continuously up to that depth.
const SEARCH_DEPTH = 24;

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
  // Single-threaded builds ignore the Threads option; for threaded use cores−1
  // (full strength). The CPU runaway was `go infinite` never stopping — fixed by
  // the SEARCH_DEPTH ceiling below, which ends each search by itself — so we keep
  // all the threads for maximum speed to that depth.
  threads = url.includes('single') ? 1 : Math.max(1, hwc - 1);
  ready = false;
  currentUrl = url;
  lastSpawnAt = performance.now();
  // A fresh engine isn't searching anything; the running search (if any) died
  // with the old worker. readyok → driveSearch() will (re)start `desiredFen`.
  analysing = false;
  searchingFen = '';
  appliedConfig = ''; // fresh engine: full config must be sent again
  goAt = 0;
  searchAlive = false;

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
    if (!ready) {
      tryFallback(url); // crashed during boot → try the single-threaded build
      return;
    }
    // Crashed at runtime. Respawn the same build (bounded) and recover the
    // desired position so a single trap doesn't freeze the overlay forever.
    if (crashCount++ < MAX_CRASH_RESPAWNS) {
      log(`engine crashed — respawning (#${crashCount})`);
      try {
        engine.terminate();
      } catch {
        /* ignore */
      }
      spawn(url);
    } else {
      // Back off rather than spin — but mark the engine NOT ready so incoming
      // positions queue and reviveIfDead() can bring it back (rate-limited).
      log('engine crashed repeatedly — backing off; will revive on next position');
      ready = false;
    }
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

// Last options actually sent — re-sending identical setoptions makes stockfish.js
// re-init its thread pool / hash for nothing, which is exactly the fragile path
// behind the first-`go` wedge. Only send what changed.
let appliedConfig = '';

function applyConfig(): void {
  const want = `${threads}/${hashMb}/${multipv}`;
  if (want === appliedConfig) return; // nothing changed — don't poke the pool
  appliedConfig = want;
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
      // If the engine is DEAD (crash-looped / failed boot) rather than booting,
      // this position is the content watchdog asking for service — revive.
      reviveIfDead();
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
      const fen = decodePosition(s).fen;
      // A re-send of a position we already finished is the content watchdog
      // recovering from lost eval frames (the service worker idles every ~30s,
      // dropping frames mid-handoff). Eval frames are transient — the only
      // recovery is to RE-RUN the search, so clear the done-marker. (Without
      // this the re-send dedups silently and the overlay hangs on
      // "engine waking…" forever.)
      if (fen === searchingFen && !analysing) searchingFen = '';
      desiredFen = fen;
      driveSearch();
      break;
    }
    case Op.Analyse: {
      const cfg = decodeAnalyse(s);
      multipv = cfg.multipv;
      hashMb = cfg.hashMb;
      // Ignore an invalid (0) thread count — the host sends 0 to mean "engine
      // decides"; clobbering Threads to 0 would crash Stockfish on the next go.
      if (cfg.threads >= 1) threads = cfg.threads;
      // Never `setoption` mid-search (same wasm-trap family as position-mid-
      // search) — mark dirty; driveSearch applies it at the next idle moment.
      configDirty = true;
      driveSearch();
      break;
    }
    case Op.Stop: {
      desiredFen = ''; // don't auto-restart
      if (analysing) send('stop');
      break;
    }
  }
}

/**
 * The ONLY place that issues `position`/`go`/`setoption` to the engine.
 * Reconciles what the host wants (`desiredFen`, `configDirty`) with what's
 * running (`searchingFen`):
 *  - engine busy on a stale position (or with stale config) → `stop`; the
 *    bestmove handler re-enters here and restarts,
 *  - engine idle → apply any pending config, then start the wanted position.
 * Never sends `position`/`setoption` mid-search — that's what traps the wasm.
 */
function driveSearch(): void {
  if (!ready) return;
  if (analysing) {
    if (configDirty || (desiredFen !== '' && searchingFen !== desiredFen)) send('stop');
    return;
  }
  if (configDirty) {
    configDirty = false;
    applyConfig(); // safe: engine idle. The extra readyok is ignored once ready.
  }
  if (!desiredFen || searchingFen === desiredFen) return; // idle, nothing new
  searchingFen = desiredFen;
  // Streaming search to a finite depth ceiling: eval sharpens up to SEARCH_DEPTH,
  // then the engine stops by itself — a static position never pegs the CPU
  // forever (the bug `go infinite` caused), and the next move starts fresh.
  send(`position fen ${desiredFen}`);
  send(`go depth ${SEARCH_DEPTH}`);
  analysing = true;
  goAt = performance.now();
  searchAlive = false;
}

/**
 * Self-healing: if the engine is dead (crash-loop exhausted, boot failed) a new
 * position from the watchdog respawns it — rate-limited so we never stomp a
 * boot in progress or spin on a machine where the wasm genuinely can't run.
 * Guarantees the long-lived offscreen document can NEVER serve dead silence
 * forever: every page's watchdog re-sends positions, so service always returns.
 */
function reviveIfDead(): void {
  if (ready || !currentUrl) return; // healthy, or init hasn't happened yet
  if (performance.now() - lastSpawnAt < REVIVE_COOLDOWN_MS) return; // boot in progress
  log('engine unresponsive — reviving');
  crashCount = 0;
  triedFallback = false; // allow the boot path to fall back again if needed
  try {
    engine.terminate();
  } catch {
    /* ignore */
  }
  spawn(currentUrl);
}

// ---- UCI output → eval ring -------------------------------------------------
// Parsing lives in uci-parse.ts (pure + unit-tested against real SF18 output).
function onEngineLine(line: string): void {
  if (!line) return;
  // ANY output during a search proves the engine isn't wedged.
  if (analysing) searchAlive = true;

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
      // (Re)start whatever position is wanted — this is also how a respawned
      // engine recovers the analysis after a crash, since its queue is empty.
      driveSearch();
    }
    return;
  }

  const best = parseBestMove(line);
  if (best !== null) {
    emit(encodeBestMove(best));
    analysing = false;
    crashCount = 0; // a clean bestmove means the engine is healthy
    // search finished (depth cap reached) or was stopped for a newer position;
    // driveSearch() starts the next desired position, or idles if none.
    driveSearch();
    return;
  }

  if (parseInfoLine(line, frame)) {
    // If the ring is momentarily full the host is a tick behind; the next depth
    // supersedes this line anyway, so dropping it costs nothing visible.
    emit(encodeEval(frame));
  }
}

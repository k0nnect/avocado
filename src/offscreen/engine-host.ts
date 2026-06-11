// avocado engine host — runs in the offscreen document (crossOriginIsolated).
//
//  - owns the EVAL ring buffer and the engine worker,
//  - forwards command frames (position/analyse/stop) from the service worker to
//    the engine worker via postMessage,
//  - drains the eval ring on a short timer and relays frames back to the SW,
//    which routes them to the originating tab.
//
// No Atomics.wait on this thread — the document main thread can't block. Polling
// the eval ring on an 8ms timer adds at most one frame of latency and avoids a
// structured-clone per `info` line.

import { createRing, RingReader } from './ring-buffer.ts';

let activeTabId = -1;

// Which engine build to run. Default: SF18 lite (multi-threaded, SIMD, net
// embedded — self-contained). The multi-threaded build REQUIRES SharedArrayBuffer,
// which only exists when this document is crossOriginIsolated. If it isn't, the
// threaded wasm throws on load and no eval ever flows — so we transparently fall
// back to the single-threaded build, which works everywhere.
const THREADED_ENGINE = 'stockfish-18-lite.js';
const SINGLE_ENGINE = 'stockfish-18-lite-single.js';

const isolated = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;

// SAB eval ring only when isolated (SharedArrayBuffer exists). Otherwise the
// worker streams eval frames back over postMessage and we never touch SAB.
const EVAL_RING = isolated ? createRing(1 << 16) : null;
const evalReader = EVAL_RING ? new RingReader(EVAL_RING) : null;

async function chosenEngineUrl(): Promise<string> {
  let file = isolated ? THREADED_ENGINE : SINGLE_ENGINE;
  try {
    const { engineBuild } = await chrome.storage.local.get('engineBuild');
    if (typeof engineBuild === 'string' && engineBuild.endsWith('.js')) file = engineBuild;
  } catch {
    /* storage may be unavailable; use default */
  }
  // Guard: never run a threaded build without SAB — it cannot instantiate.
  if (!isolated && !file.includes('single')) file = SINGLE_ENGINE;
  console.log(`avocado engine: crossOriginIsolated=${isolated}, using ${file}`);
  return new URL(`../vendor/stockfish/${file}`, import.meta.url).href;
}

const worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });

chosenEngineUrl().then((engineUrl) => {
  worker.postMessage({
    type: 'init',
    evalSab: EVAL_RING ? EVAL_RING.sab : null,
    evalCap: EVAL_RING ? EVAL_RING.capacity : 0,
    engineUrl,
    hardwareConcurrency: navigator.hardwareConcurrency || 4,
  });
});

// Relay to/from the service worker. The SW is killed after ~30s idle, which
// disconnects this Port — reconnect immediately (connect() wakes the SW), so
// command frames keep flowing and eval frames always have a live channel.
let port: chrome.runtime.Port;

function connectPort(): void {
  port = chrome.runtime.connect({ name: 'avocado-offscreen' });
  port.onMessage.addListener((msg: { tabId: number; frame: string }) => {
    activeTabId = msg.tabId;
    worker.postMessage(msg.frame); // command frame → engine worker
  });
  port.onDisconnect.addListener(() => {
    // small delay so we don't spin if the extension is being unloaded
    setTimeout(connectPort, 250);
  });
}
connectPort();

/** Forward one engine frame to the active tab, surfacing log frames locally. */
function forward(frame: string): void {
  if (frame.charCodeAt(0) === 108 /* 'l' */ && frame[1] === ':') {
    console.log('avocado engine:', frame.slice(2));
  }
  try {
    port.postMessage({ tabId: activeTabId, frame });
  } catch {
    /* port mid-reconnect; this frame is superseded by the next depth tick */
  }
}

if (evalReader) {
  // SAB ring: drain on a short timer (engine info lines arrive far slower).
  const reader = evalReader;
  setInterval(() => {
    for (let s = reader.read(); s !== null; s = reader.read()) forward(s);
  }, 8);
} else {
  // postMessage fallback: eval frames arrive as worker messages.
  worker.onmessage = (e: MessageEvent) => {
    if (typeof e.data === 'string') forward(e.data);
  };
}

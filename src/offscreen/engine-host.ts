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

const EVAL_RING = createRing(1 << 16); // 64KB worker → host (multi-pv bursts)
const evalReader = new RingReader(EVAL_RING);

let activeTabId = -1;

// Which engine build to run. Default: SF18 lite (multi-threaded, SIMD, net
// embedded — self-contained, no separate NNUE file). Overridable from the popup.
const DEFAULT_ENGINE = 'stockfish-18-lite.js';

async function chosenEngineUrl(): Promise<string> {
  let file = DEFAULT_ENGINE;
  try {
    const { engineBuild } = await chrome.storage.local.get('engineBuild');
    if (typeof engineBuild === 'string' && engineBuild.endsWith('.js')) file = engineBuild;
  } catch {
    /* storage may be unavailable; use default */
  }
  return new URL(`../vendor/stockfish/${file}`, import.meta.url).href;
}

const worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });

chosenEngineUrl().then((engineUrl) => {
  worker.postMessage({
    type: 'init',
    evalSab: EVAL_RING.sab,
    evalCap: EVAL_RING.capacity,
    engineUrl,
    hardwareConcurrency: navigator.hardwareConcurrency || 4,
  });
});

// Relay to/from the service worker.
const port = chrome.runtime.connect({ name: 'avocado-offscreen' });

port.onMessage.addListener((msg: { tabId: number; frame: string }) => {
  activeTabId = msg.tabId;
  worker.postMessage(msg.frame); // command frame → engine worker
});

function drain(): void {
  for (let s = evalReader.read(); s !== null; s = evalReader.read()) {
    port.postMessage({ tabId: activeTabId, frame: s });
  }
}
setInterval(drain, 8); // ~120Hz; engine info lines arrive far slower

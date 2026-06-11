// avocado service worker — pure router + offscreen lifecycle owner.
//
// MV3 service workers are ephemeral and CANNOT hold a SharedArrayBuffer or run a
// threaded wasm engine. So the engine lives in an OFFSCREEN DOCUMENT (which we
// keep alive), and this worker only:
//   1. spins up that offscreen document on demand,
//   2. relays packed-string frames between each content-script Port and the
//      offscreen document.
//
// No JSON, no engine logic here. Frames are the opaque strings from protocol.ts.

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

let creating: Promise<void> | null = null;

/** Ensure the single offscreen document exists (idempotent, race-safe). */
async function ensureOffscreen(): Promise<void> {
  const getContexts = (chrome.runtime as any).getContexts as
    | ((opts: { contextTypes: string[] }) => Promise<unknown[]>)
    | undefined;
  if (getContexts) {
    const existing = await getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing && existing.length > 0) return;
  }

  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Runs the local Stockfish engine in a multi-threaded Web Worker.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

// The offscreen document connects back to us with this Port name so we can push
// eval frames to whichever content-script Port is active.
let offscreenPort: chrome.runtime.Port | null = null;
// Content-script Ports keyed by tab id, so eval frames route to the right tab.
const contentPorts = new Map<number, chrome.runtime.Port>();
// Frames that arrived BEFORE the offscreen document finished booting. Creating
// the offscreen doc is async, so the very first position/analyse frame would
// otherwise be dropped (engine never analyses the opening position → no arrows).
// We buffer per tab and flush the moment the offscreen host connects.
const pending = new Map<number, string[]>();

function sendToEngine(tabId: number, frame: string): void {
  if (offscreenPort) {
    offscreenPort.postMessage({ tabId, frame });
  } else {
    const q = pending.get(tabId) ?? [];
    q.push(frame);
    pending.set(tabId, q);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'avocado-offscreen') {
    offscreenPort = port;
    // flush anything that queued while the offscreen doc was starting up
    for (const [tabId, frames] of pending) {
      for (const frame of frames) port.postMessage({ tabId, frame });
    }
    pending.clear();
    port.onMessage.addListener((msg: { tabId: number; frame: string }) => {
      // eval/bestmove frames flowing engine → content
      const cp = contentPorts.get(msg.tabId);
      cp?.postMessage(msg.frame);
    });
    port.onDisconnect.addListener(() => {
      if (offscreenPort === port) offscreenPort = null;
    });
    return;
  }

  if (port.name === 'avocado-content') {
    const tabId = port.sender?.tab?.id;
    if (tabId === undefined) return;
    contentPorts.set(tabId, port);

    port.onMessage.addListener(async (frame: string) => {
      // position/analyse/stop frames flowing content → engine
      await ensureOffscreen();
      sendToEngine(tabId, frame);
    });
    port.onDisconnect.addListener(() => {
      contentPorts.delete(tabId);
    });
  }
});

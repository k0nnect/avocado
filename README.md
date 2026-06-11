# avocado 🥑

local chess companion — low-latency board capture, a **fully local** stockfish engine, and
streamer-style violet larp commentary. inspired by [A.C.A.S], rebuilt as a single self-contained
manifest v3 extension that runs **multi-threaded** where A.C.A.S runs single-threaded.

> **fair play:** engine hints during a rated game against a human are cheating on chess.com and
> lichess and can get your account banned. avocado keeps best-move arrows **off** in live human
> games by default (eval bar + commentary still run). flip the override in the popup at your own
> risk. avocado never auto-moves and ships no detection-evasion features.

## what it does

- **capture** — a tightly-scoped `MutationObserver` on the board (no polling) turns DOM moves into a
  packed FEN with zero per-move allocation (preallocated mailboxes + bitboards, 16-bit move packing).
- **engine** — the latest Stockfish 18 (multi-threaded + SIMD wasm, NNUE net embedded) runs in a Web
  Worker inside an **offscreen document** that is `crossOriginIsolated` via COOP/COEP manifest keys —
  which is exactly what lets us use `SharedArrayBuffer` + threads where A.C.A.S's hosted GUI cannot.
- **overlay** — a single `pointer-events:none` canvas draws a violet eval bar (with WDL), ranked
  multi-PV arrows, and an opponent-reply guess, all inside one `requestAnimationFrame`.
- **commentary** — a priority state machine maps eval swings, captured material, time pressure, and
  bitboard tactical motifs (fork/check/sac/promotion) to lowercase hype lines, with cooldowns.

## architecture

```
chess.com / lichess page  (content script, isolated world)
  capture.ts ─ MutationObserver → Uint8Array(64) diff → 16-bit move → FEN
  overlay.ts ─ canvas eval bar / multi-pv arrows / ticker (rAF only)
  commentary ─ eval delta + motifs → priority state machine → violet ticker
        │  chrome.runtime Port — packed strings (protocol.ts), never JSON
service-worker.ts  (router + offscreen lifecycle)
        │  Port relay
offscreen document  (crossOriginIsolated)
  engine-host.ts  ─ drains eval ring, relays frames
        │  postMessage (commands) ─── SAB ring buffer (eval frames)
  engine-worker.ts ─ bridges UCI, parses info lines zero-copy (uci-parse.ts)
        └─ stockfish-18-lite.js  (N threads + SIMD, net embedded)
```

Why a SAB ring only for the eval direction: `info` lines arrive in bursts while the engine thinks,
so packing them into a lock-free ring the host drains avoids a structured-clone allocation per line.
Commands are one-per-move, so plain `postMessage` is fine there. Neither the offscreen main thread
nor the bridging worker blocks on `Atomics.wait` (that would deadlock the engine's own callbacks).

## build & install

```bash
npm install
npm run vendor      # one-time: pull Stockfish 18 wasm into vendor/stockfish/
npm run build       # → dist/
npm test            # 41 unit tests (board, protocol, ring, commentary, real-output parser)
```

Then load it: `chrome://extensions` → enable Developer mode → **Load unpacked** → select `dist/`.
Open `lichess.org/analysis` or a chess.com bot game and play moves.

`npm run watch` rebuilds on change (reload the extension to pick up content/worker changes).

## engine builds (popup-selectable)

| build | threads | net | size | use |
|---|---|---|---|---|
| `stockfish-18-lite.js` | multi | embedded | ~7MB | **default** |
| `stockfish-18-lite-single.js` | single | embedded | ~7MB | low-core / non-isolated fallback |
| `stockfish-18.js` | multi | full net | ~113MB | max strength (uncomment in `scripts/vendor-stockfish.mjs` first) |

## layout

```
src/shared/    board.ts (bitboards, move packing, FEN) · protocol.ts (packed wire format) · theme.ts
src/content/   main.ts · capture.ts · overlay.ts · adapters/{lichess,chesscom}.ts · commentary/*
src/offscreen/ engine-host.ts · engine-worker.ts · ring-buffer.ts · uci-parse.ts
src/background/ service-worker.ts
src/popup/     popup.html · popup.ts
vendor/stockfish/  vendored engine (committed; runtime is 100% local)
```

`A.C.A.S/` is the upstream reference source (gitignored, not part of the build).

[A.C.A.S]: https://github.com/psyyke/A.C.A.S

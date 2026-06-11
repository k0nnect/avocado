# avocado — local chess companion extension (MV3) — implementation plan

## Context

Greenfield build in `/Users/chris/Documents/avocado` (not yet a git repo — `git init` first). avocado is a local-only chess companion Chrome extension inspired by A.C.A.S: it watches the board DOM on chess.com/lichess, evaluates positions with a locally-running Stockfish, renders a low-latency overlay (eval bar, optional arrows), and emits streamer-style "larp" commentary driven by eval deltas and tactical motifs. No cloud calls, no telemetry.

The user has dropped the full A.C.A.S source into `./A.C.A.S/` as reference material (keep it out of the build and out of `dist/`; treat it as read-only inspo). Exploration of it (notably `acas.user.js`, `app/assets/js/AcasInstance.js`, `app/assets/engines/`) confirms where avocado must beat it — see "Beating A.C.A.S" below.

**Decisions confirmed with user:**
- **Engine:** Option B — the latest Stockfish (17.1, or 18 if a maintained wasm build exists at implementation time) at **full strength**: multi-threaded + SIMD Wasm with the full-size dual NNUE nets (big + small), running in a Web Worker inside an **offscreen document**, with a lock-free SAB ring buffer between offscreen main thread and engine worker. (Native messaging was rejected for v1: Chrome forces JSON framing at the native boundary, defeating the zero-copy goal, and it needs an installer.)
- **Tooling:** TypeScript + esbuild (single dev dependency besides stockfish + vitest).
- **Commentary:** text callouts only in v1; state machine designed so audio triggers map 1:1 onto the same state hashes later.
- **Fair play:** safe-mode default. Eval bar + commentary always run; best-move arrows auto-enable only when spectating / analyzing / playing bots, with an explicit user override toggle for live human games (off by default).
- **Aesthetic:** lowercase violet — palette `#7c3aed` / `#a78bfa` / `#c4b5fd` on `#16121f`, all UI text lowercase, monospace.

## Beating A.C.A.S (findings from `./A.C.A.S/` source)

A.C.A.S's ceiling is structural, and avocado clears it on every axis:

| Axis | A.C.A.S (measured in source) | avocado |
|---|---|---|
| Engine threading | **Single-threaded** wasm only (`app/assets/engines/stockfish-1{7,8}-single/`) — its hosted GitHub-Pages GUI can't get cross-origin isolation, so no SharedArrayBuffer | Multi-threaded SIMD wasm; extensions set COOP/COEP in the manifest, so `Threads = hardwareConcurrency − 1` |
| Engine config | MultiPV=2 default, modest Hash | Full dual NNUE nets, `Hash 256–512MB`, `MultiPV` 1–4 (default 3), `UCI_ShowWDL on`, streaming `go infinite` + `stop` on position change (no fixed movetime — eval sharpens continuously). No `Skill Level`/`UCI_LimitStrength` caps — always full strength |
| Move detection | MutationObserver **plus a 250ms polling fallback** (acas.user.js ~line 3322) and 2500ms settings refresh | Pure event-driven: scoped MutationObserver + microtask coalescing; settings pushed via `chrome.storage.onChanged` |
| IPC | JSON over CommLink message bus, with ~250ms response waits, userscript → hosted GUI page → worker | Packed strings over a persistent Port + SAB ring buffer with `Atomics.wait` inside the offscreen doc |
| Distribution | Userscript + hosted GUI tab + optional Electron app on :2800 | One self-contained extension, zero external pages |
| Asset loading | 66–108MB engines chunked into 6 parts, re-fetched from the network | Vendored once in the package; loads from `chrome-extension://` instantly |

**Features worth borrowing from A.C.A.S** (it earned them): ranked Multi-PV arrows (best line bold violet, alternates dimmer), opponent-reply guess arrow (from PV ply 2), hover "moves on demand" to cut clutter, settings export/import, and its per-site adapter registry pattern (`addSupportedChessSite`) — our `SiteAdapter` interface generalizes the same idea. Chess variants via fairy-stockfish: deferred to v2.

**Explicitly NOT borrowed:** A.C.A.S's auto-move executor and its "legitimacy" randomization (humanized delays to evade fair-play detection). avocado renders information; it never moves pieces or simulates input, and we don't build detection-evasion features. This is firm regardless of other settings.

## Architecture (one diagram)

```
chess.com / lichess page
  └─ content script (isolated world)
       capture.ts ── MutationObserver → Uint8Array(64) mailbox diff → 16-bit move
       overlay.ts ── canvas (pointer-events:none), rAF-only renders
       commentary.ts ── state-hash → pre-indexed line table → ticker
            │  chrome.runtime Port — packed strings, never JSON.stringify
service worker (router only; owns offscreen lifecycle)
            │  Port relay
offscreen document  (crossOriginIsolated via COOP/COEP manifest keys)
       engine-host.ts ── owns 2× SAB SPSC ring buffers (cmd→, ←eval)
            │  Atomics.wait / Atomics.notify (no postMessage per eval)
       engine-worker.ts ── UCI loop, zero-copy line scan
            └─ stockfish-17 lite multi wasm (N threads, SIMD)
```

Honest latency note baked into code comments: SAB cannot cross the content-script↔extension process boundary; the ring buffer eliminates per-eval `postMessage` churn *inside* the offscreen doc, and the cross-process hop uses single packed strings over a persistent Port (structured clone of a short string ≈ µs; no JSON parse/stringify anywhere).

## Directory structure

```
avocado/
├── manifest.json
├── package.json / tsconfig.json / build.mjs      # esbuild bundler script
├── vendor/stockfish/                             # committed local wasm build (zero cloud)
│   ├── sf17-lite-multi.js / .wasm / nnue weights
├── src/
│   ├── shared/
│   │   ├── protocol.ts      # opcodes + packed-string codecs (the ONLY ser/de code)
│   │   ├── board.ts         # mailbox + BigUint64Array bitboards, move packing
│   │   └── theme.ts         # violet palette + css custom props
│   ├── content/
│   │   ├── main.ts          # entry: adapter select, Port wiring, module lifecycles
│   │   ├── capture.ts       # MutationObserver pipeline (zero-alloc diff)
│   │   ├── adapters/lichess.ts
│   │   ├── adapters/chesscom.ts
│   │   ├── overlay.ts       # canvas eval bar / arrows / ticker, rAF loop
│   │   └── commentary/
│   │       ├── commentary.ts  # state machine + hash composer
│   │       ├── lines.ts       # pre-indexed lowercase line tables
│   │       └── motifs.ts      # bitboard fork/pin/hang/sac detectors
│   ├── background/service-worker.ts   # offscreen lifecycle + Port relay
│   ├── offscreen/
│   │   ├── offscreen.html / engine-host.ts
│   │   ├── engine-worker.ts           # UCI ⇄ stockfish wasm
│   │   └── ring-buffer.ts             # lock-free SPSC byte ring on SAB
│   └── popup/popup.html / popup.ts    # settings: safe mode, threads, depth/movetime
├── test/                              # vitest: board diff, move packing, ring, hashing
└── docs/superpowers/specs/2026-06-11-avocado-design.md   # this design, committed
```

## Key implementation details

### manifest.json (MV3)
- `"cross_origin_embedder_policy": {"value": "require-corp"}` + `"cross_origin_opener_policy": {"value": "same-origin"}` → `crossOriginIsolated === true` in the offscreen document → SharedArrayBuffer + threaded wasm work.
- `content_security_policy.extension_pages` includes `'wasm-unsafe-eval'`.
- `permissions: ["offscreen", "storage"]`; content scripts matched to `*://*.chess.com/*` and `*://lichess.org/*`, `run_at: document_start` with lazy board discovery.

### capture.ts — zero-allocation board tracking
- `SiteAdapter` interface: `findBoard()`, `decodePieceClass(el): u8`, `squareOf(el): u8`, `gameContext(): 'playing'|'spectating'|'analysis'|'bot'`, `readClockMs(): number`.
- Board state: two preallocated `Uint8Array(64)` mailboxes (cur/prev, swapped by reference) + `BigUint64Array` per-piece bitboards updated by XOR; class-string parsing via `charCodeAt` scans, no regex/split in the hot path.
- MutationObserver scoped to the board element, `attributeFilter` per adapter; mutations set a dirty flag, a single queued microtask coalesces the burst, diffs mailboxes → derives the move as a packed 16-bit int (6 from / 6 to / 4 flags), reconstructs FEN incrementally (side-to-move, castling, ep tracked as scalars).
- Time-pressure sampled from the clock DOM only when a move lands (no polling).

### offscreen engine pipeline
- Service worker creates the offscreen document on first board detection (`reasons: ["WORKERS"]`), keeps it alive across games.
- `ring-buffer.ts`: SPSC byte ring on a SAB — `Int32Array` head/tail + `Uint8Array` data, writer bumps tail then `Atomics.notify`; the engine worker parks in `Atomics.wait`. Two rings: command (host→worker) and eval (worker→host).
- `engine-worker.ts`: instantiates the vendored Stockfish at full strength — `Threads = max(1, hardwareConcurrency − 1)`, `Hash 256` (popup-tunable to 512), `MultiPV 3`, `UCI_ShowWDL true`, never any strength-limiting options; runs streaming `go infinite` per position with `stop` issued on board change; parses `info` lines zero-copy (indexOf/charCodeAt, no `.split()`), pushes packed eval frames `e:<depth>:<multipv>:<cp|#mate>:<wdl>:<best>:<pv0..3>` into the eval ring, throttled to one frame per depth tick per PV.
- Vendor step: pull the **latest full-strength multi-threaded SIMD build** — first choice `lila-stockfish-web`'s Stockfish 17.1 with the full dual NNUE nets (big ~79MB + small); if a maintained SF18 multi wasm exists at implementation time, prefer it. Commit under `vendor/` (runtime stays 100% local; large file is fine for an unpacked/self-distributed extension — A.C.A.S ships 108MB chunked over the network, we load ours from disk). Fallback build: SF17 lite multi (7MB) kept alongside for low-RAM machines, selectable in popup.

### overlay.ts
- One `<canvas>` positioned over the board, `pointer-events: none`, DPR-aware, resized via `ResizeObserver`; board rect cached, refreshed only on resize/scroll (passive listeners) — zero layout reads in the render path.
- Renders only inside `requestAnimationFrame` when a dirty flag is set: violet eval bar with WDL readout, ranked Multi-PV arrows (PV1 bold `#7c3aed`, PV2/3 dimmer `#a78bfa`/`#c4b5fd`), opponent-reply guess arrow from PV ply 2 (hover-to-show, borrowed from A.C.A.S), and the commentary ticker (a small DOM node updated via `textContent` + compositor-only transforms). All arrows sit behind the safe-mode gate; eval bar + ticker do not.

### commentary engine
- Inputs quantized into small enums: `deltaEval` bucket (blunder/mistake/inaccuracy/neutral/brilliant), mate-flip flag, `pieceVal` of capture/hang, `clockBucket`, `moveTimeBucket` (premove/insta/normal/tank), motif bits from `motifs.ts` (fork/pin/skewer/sac/back-rank, computed with bitboard masks).
- Buckets bit-packed into one int state hash → direct index into a flat pre-built table in `lines.ts` (~120 lowercase lines: "wait, is that a juicer?", "oh no, my queen", "absolute positional dominance, buddy", …); variant picked by xorshift PRNG; per-category cooldowns + priority ordering (mate > hung queen > big swing > scramble > filler) prevent spam. No allocation beyond the chosen string reference.

### safe-mode gating
- Adapter-reported `gameContext` drives it: arrows render for `spectating | analysis | bot`; for `playing` they require the explicit popup toggle (default off, persisted in `chrome.storage.local`). Eval bar + commentary unconditional. Popup states the fair-play warning in lowercase violet.

## Build order (milestones)

1. `git init` (`.gitignore`: `dist/`, `node_modules/`, `.DS_Store`; keep `A.C.A.S/` as reference or gitignore it — ask-free default: gitignore it, it has its own upstream), scaffold: package.json, tsconfig, build.mjs, manifest, theme — extension loads unpacked with a hello-world content script.
2. `shared/board.ts` + `protocol.ts` with vitest tests (move packing, mailbox diff, FEN reconstruction).
3. Lichess adapter + capture pipeline (lichess DOM is cleaner); verify moves logged on lichess.org/analysis.
4. Offscreen doc + ring buffer + engine worker + vendored full-strength Stockfish (multi-threaded SIMD + dual NNUE, lite build as fallback); verify Multi-PV eval frames flow end-to-end and `Threads > 1` actually engages (check `crossOriginIsolated` in the offscreen console).
5. Overlay (eval bar + WDL first, ranked Multi-PV arrows + opponent-guess behind gate).
6. Commentary engine + line tables.
7. Chess.com adapter (standard boards; `/variants` DOM differs — defer with fairy-stockfish to v2).
8. Popup settings (safe mode, engine build, threads, hash, MultiPV, settings export/import) + safe-mode wiring; commit design doc.

## Verification

- **Unit:** `npx vitest` — board diff/packing, ring buffer (real SAB in node), commentary hash→line lookup, UCI line parser.
- **End-to-end:** `npm run build` → load `dist/` unpacked → open `lichess.org/analysis` (safe context), play moves: eval bar tracks, ticker emits lines, arrow renders; repeat on a chess.com bot game. Check the offscreen console for engine output and `chrome://extensions` for SW errors.
- **Latency proof:** `performance.now()` marks behind a `DEBUG` flag at capture→send, engine-recv→go, eval-frame→paint; log a histogram and confirm capture→overlay (excluding think time) stays sub-millisecond.

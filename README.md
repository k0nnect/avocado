<div align="center">

# 🥑 avocado

**`local chess companion · violet larp · 100% offline`**

*a low-latency chess overlay that watches your board, thinks with a fully-local stockfish 18,*
*and talks like a hype streamer — rebuilt from [a.c.a.s] to run multi-threaded where a.c.a.s can't.*

`#7c3aed` · `#a78bfa` · `#c4b5fd` · all lowercase, always

</div>

---

## what it is

avocado is a manifest v3 chrome extension. open a game on lichess or chess.com and it:

- **sees** every move the instant the board changes (no polling),
- **thinks** with stockfish 18 — multi-threaded, simd, full nnue — running entirely on your machine,
- **shows** a violet eval bar, ranked best-move arrows, and an opponent-reply guess on a canvas overlay,
- **talks** — *"wait, is that a juicer??"*, *"oh no, my queen!!"*, *"absolute positional dominance, buddy"* —
  driven by the real eval swing and tactical motifs, not canned timing.

> [!WARNING]
> **fair play.** engine hints during a rated game against a human are cheating on chess.com and
> lichess and can get you banned. avocado keeps best-move **arrows off by default in live human games**
> (the eval bar and commentary still run). there's an opt-in toggle in the popup. avocado never
> auto-moves, never simulates input, and ships no detection-evasion features.

---

## why it's faster than a.c.a.s

a.c.a.s is the inspiration and it's great — but its architecture caps it. avocado clears that ceiling
on every axis. run the demo yourself: **`npm run bench`** (lowercase violet, of course).

```
  board → fen  (per move)
    avocado  ██████████████████████████████████  5.55m ops/s
    a.c.a.s  ████······························  665k ops/s   → 8.3× faster

  move detection (diff two positions)
    avocado  ██████████████████████████████████  20.6m ops/s
    a.c.a.s  █·································  502k ops/s   → 41× faster

  ipc serialization (per eval frame)
    avocado  ██████████████████████████████████  5.89m ops/s
    a.c.a.s  █████████████████·················  3.02m ops/s  → 1.9× faster

  move-detection allocations    avocado 0 objects  ·  a.c.a.s ~9 objects
  move-detection latency        avocado ~0 ms      ·  a.c.a.s up to 250 ms poll
```

the benchmark runs avocado's **real** modules against a faithful port of a.c.a.s's **actual** code
(`getBasicFen`, `getBoardSquareChangeAmount`, its json comm bus, its 250ms poll — all cited to line
numbers in `a.c.a.s/acas.user.js`), on the same positions. it's not a strawman.

| axis | a.c.a.s | avocado |
|---|---|---|
| engine threads | **single-threaded** wasm (hosted gui can't be cross-origin-isolated) | **multi-threaded** simd, `threads = cores−1` |
| move detection | string-fen diff, ~9 allocs/move | typed-array mailbox diff, **zero alloc** |
| move latency | mutationobserver + **250ms poll** fallback | pure event-driven, microtask-coalesced |
| ipc | json over a message bus (~250ms waits) | packed strings + a lock-free SAB ring |
| distribution | userscript + hosted gui tab + electron app | **one** self-contained extension |
| engine assets | 66–108mb refetched over the network | vendored once, loads from disk |

---

## engine strength `(ccrl 40/15 elo · pulled from public sources, jun 2026)`

```
  stockfish 18  ██████████████████████████████████  ~3653   ◀ what avocado runs
  stockfish 17  ████████████████████████████████··  ~3607     old browser / a.c.a.s default
  stockfish 16  ██████████████████████████████····  ~3561
  carlsen peak  ███·······························  ~2882     strongest human ever
```

avocado runs **stockfish 18** (the [sfnnv10 "threat inputs" net][sf18], `+46 elo` over sf17, released
2026-01-31). and because it's **multi-threaded**, nodes/sec scale ~linearly with your cores — so at
equal time it searches deeper than the single-threaded build a.c.a.s and most in-browser tools are
stuck on. same engine family, more compute, stronger play.

engine builds are popup-selectable:

| build | threads | net | size | use |
|---|---|---|---|---|
| `stockfish-18-lite.js` | multi | embedded | ~7mb | **default** |
| `stockfish-18-lite-single.js` | single | embedded | ~7mb | low-core / non-isolated fallback |
| `stockfish-18.js` | multi | full net | ~113mb | max strength *(vendor it first)* |

---

## how it works

```
  lichess / chess.com page  (content script, isolated world)
    capture.ts   ─ mutationobserver → uint8array(64) diff → 16-bit move → fen
    overlay.ts   ─ canvas eval bar / ranked multi-pv arrows / ticker (raf only)
    commentary   ─ eval delta + bitboard motifs → priority state machine → violet ticker
          │  chrome.runtime port — packed strings, never json
  service-worker.ts   (router + offscreen lifecycle)
          │  port relay
  offscreen document  (crossoriginisolated via coop/coep manifest keys)
    engine-host.ts    ─ drains the eval ring, relays frames
          │  postmessage (commands) ··· SAB ring buffer (eval frames)
    engine-worker.ts  ─ bridges uci, parses info lines zero-copy (uci-parse.ts)
          └─ stockfish-18-lite.js   (N threads + simd, net embedded)
```

the offscreen document is the trick: an extension page **can** set `coop`/`coep` and become
`crossoriginisolated`, which is exactly what unlocks `sharedarraybuffer` + threaded wasm — the thing
a.c.a.s's github-pages gui can't have. the SAB ring carries the high-frequency eval frames so we never
pay a structured-clone per `info` line; commands are one-per-move, so plain `postmessage` is fine there.

---

## quickstart

```bash
npm install
npm run vendor      # one-time: pull stockfish 18 wasm into vendor/stockfish/
npm run build       # → dist/
npm test            # 41 unit tests (board, protocol, ring, commentary, real-engine-output parser)
npm run bench       # the avocado vs a.c.a.s speed demo above
```

then: `chrome://extensions` → enable developer mode → **load unpacked** → pick `dist/`.
open `lichess.org/analysis` or a chess.com bot game and start playing.

`npm run watch` rebuilds on change (reload the extension to pick up content/worker edits).

---

## layout

```
  src/shared/     board.ts (bitboards · 16-bit moves · single-alloc fen) · protocol.ts · theme.ts
  src/content/    main.ts · capture.ts · overlay.ts · adapters/{lichess,chesscom}.ts · commentary/*
  src/offscreen/  engine-host.ts · engine-worker.ts · ring-buffer.ts · uci-parse.ts
  src/background/ service-worker.ts
  src/popup/      popup.html · popup.ts
  bench/          compare.ts (real modules vs faithful a.c.a.s port) · acas-model.ts
  vendor/stockfish/   vendored engine — committed, runtime is 100% local
```

`a.c.a.s/` is the upstream reference source (gitignored, not part of the build).

---

<div align="center">

`built for microsecond pipelines and maximum larp` · 🥑

</div>

[a.c.a.s]: https://github.com/psyyke/A.C.A.S
[sf18]: https://stockfishchess.org/blog/2026/stockfish-18/

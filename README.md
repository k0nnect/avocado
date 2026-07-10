<div align="center">

```
       .-"""-.
     .'       '.
    /   .---.   \
   |   / o o \   |
   |   \  ‿  /   |
    \   '---'   /
     '.       .'
       '-...-'
```

# avocado

**`local chess companion · live commentary engine · 100% offline`**

*a low-latency chess overlay that watches your board, thinks with a fully-local stockfish 18,*
* — rebuilt from [a.c.a.s] to run multi-threaded where a.c.a.s can't.*

`#cba6f7` · `#b4befe` · `#dabffc`

</div>

---

## what it is

avocado is a manifest v3 chrome extension. open a game on lichess or chess.com and it:

- **sees** every move the instant the board changes (no polling) — on chess.com it reads the board's
  own game state directly (`wc-chess-board.game.getFEN()`, ~0.7µs, always exact: right side-to-move,
  castling, en-passant), on lichess a zero-alloc piece scan — and ignores mere clicks/selections,
- **thinks** with stockfish 18 — multi-threaded, simd, full nnue, entirely on your machine — searching
  to a depth ceiling and then *stopping* (a static position never pins your cores), and respawning
  itself if the wasm ever traps, so it can't get stuck,
- **shows** a mauve eval bar and ranked best-move arrows numbered by priority (**#1** best, **#2**, **#3**),
  plus a translucent opponent-reply guess — and never draws a move that isn't legal on the board,
- **talks** — *"wait, is that a juicer??"*, *"oh no, my queen!!"*, *"absolute positional dominance, buddy"* —
  driven by the real eval swing and tactical motifs. commentary lives **exclusively in the pip window**
  (your moves on one line, the opponent's on the other) so the site itself stays clean,
- **calls the finish** — checkmate, stalemate, flagging on time.
- **pops out** — a `⧉` button opens a picture-in-picture companion window (eval, numbered arrows, both
  commentary lines, and a toggleable board drawn from the live position) that floats over any tab.
- **goes dark** — a **stealth / screenshare-proof** toggle hides *everything* avocado draws on the
  chess tab (eval bar, arrows, status pill, and the `⧉` button); all analysis moves to the pip
  window, which tab- and window-shares don't capture (a full-screen share still does). with the
  button hidden, open the companion with the **`alt + a`** hotkey on the board (macOS: **`⌃ a`**
  or **`⌥ a`**).

> [!WARNING]
> **fair play.** engine hints during a rated game against a human are cheating on chess.com and
> lichess and can get you banned. avocado keeps best-move **arrows off by default in live human games**
> (the eval bar and commentary still run). there's an opt-in toggle in the popup. avocado never
> auto-moves, never simulates input, and ships no detection-evasion features.

---

## why it's faster than a.c.a.s

a.c.a.s is the inspiration and it's great — but its architecture caps it. avocado clears that ceiling
on every axis. run the demo yourself: **`npm run bench`**.

```
  board → fen  (per move)
    avocado  ██████████████████████████████████  4.96m ops/s
    a.c.a.s  ████······························  600k ops/s   → 8.3× faster

  move detection (diff two positions)
    avocado  ██████████████████████████████████  19.0m ops/s
    a.c.a.s  █·································  471k ops/s   → 40× faster

  ipc serialization (per eval frame)
    avocado  ██████████████████████████████████  5.29m ops/s
    a.c.a.s  ██████████████████················  2.85m ops/s  → 1.9× faster

  move-detection allocations    avocado 0 objects  ·  a.c.a.s ~9 objects
  move-detection latency        avocado ~0 ms      ·  a.c.a.s up to 250 ms poll
```

move validation and the click/flicker guard run *outside* these hot paths — real moves still emit with
zero added latency; only the analyse/ipc/parse loops are measured above.

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
    capture.ts   ─ mutationobserver → wc-chess-board.game.getFEN() (chess.com) │ mailbox diff (lichess) → fen
    overlay.ts   ─ canvas eval bar / ranked multi-pv arrows / status pill (raf only)
    commentary   ─ eval delta + bitboard motifs → priority state machine → pip window
          │  chrome.runtime port — packed strings, never json
  service-worker.ts   (router + offscreen lifecycle)
          │  port relay
  offscreen document  (crossoriginisolated via coop/coep manifest keys)
    engine-host.ts    ─ drains the eval ring, relays frames
          │  postmessage (commands) ··· SAB ring buffer (eval frames)
    engine-worker.ts  ─ bridges uci (serialized `go depth N`, self-stops + auto-respawns), parses info zero-copy
          └─ stockfish-18-lite.js   (N threads + simd, net embedded)
```

the offscreen document is the trick: an extension page **can** set `coop`/`coep` and become
`crossoriginisolated`, which is exactly what unlocks `sharedarraybuffer` + threaded wasm — the thing
a.c.a.s's github-pages gui can't have. the SAB ring carries the high-frequency eval frames so we never
pay a structured-clone per `info` line; commands are one-per-move, so plain `postmessage` is fine there.

**never stuck.** stockfish traps the wasm if you hand it a new `position` mid-search, so the worker
*serializes*: a new move only `stop`s the running search, and the next `position`/`go` waits for the
`bestmove`. each search runs `go depth N` (not `go infinite`) so it ends itself and a quiet board drops
to idle. and if the engine ever crashes anyway, it respawns and re-analyses the live position — so it
recovers instead of hanging on *"engine waking…"*, even joining an already-active game mid-blitz.

**picture-in-picture.** the `⧉` companion window uses the modern **document picture-in-picture** api
(chrome 116+) — a real dom window we draw into directly, rAF-throttled and allocation-free. a.c.a.s
renders to a canvas, captures a `MediaStream`, pipes it through a `<video>`, and requests *video*-pip;
that encode→decode→present path adds frames of latency we skip entirely. the pip board is drawn from
the position avocado already tracks (unicode glyphs), so it needs none of chess.com's sprites to render.

---

## quickstart

```bash
npm install
npm run vendor      # one-time: pull stockfish 18 wasm into vendor/stockfish/
npm run build       # → dist/
npm test            # 57 unit tests (board, protocol, ring, commentary, side-to-move, real-engine-output parser)
npm run bench       # the avocado vs a.c.a.s speed demo above
```

then: `chrome://extensions` → enable developer mode → **load unpacked** → pick `dist/`.
open `lichess.org/analysis` or a chess.com bot game and start playing.

`npm run watch` rebuilds on change (reload the extension to pick up content/worker edits).

---

## layout

```
  src/shared/     board.ts (bitboards · 16-bit moves · single-alloc fen) · protocol.ts · theme.ts
  src/content/    main.ts · capture.ts · overlay.ts · pip.ts · adapters/{lichess,chesscom}.ts · commentary/*
  src/offscreen/  engine-host.ts · engine-worker.ts · ring-buffer.ts · uci-parse.ts
  src/background/ service-worker.ts
  src/popup/      popup.html · popup.ts
  bench/          compare.ts (real modules vs faithful a.c.a.s port) · acas-model.ts
  vendor/stockfish/   vendored engine — committed, runtime is 100% local
```

`a.c.a.s/` is the upstream reference source (gitignored, not part of the build).

---

<div align="center">

<img src="icons/logo.svg" width="22" alt="avocado" /> &nbsp; `built for microsecond pipelines and a loud commentary engine`

</div>

[a.c.a.s]: https://github.com/psyyke/A.C.A.S
[sf18]: https://stockfishchess.org/blog/2026/stockfish-18/

// avocado SAB ring buffer — lock-free SPSC byte ring on a SharedArrayBuffer.
//
// Used INSIDE the offscreen document between the host (main thread) and the
// engine worker, so we never pay a postMessage + structured-clone per eval
// frame. One writer, one reader per ring (single-producer / single-consumer),
// which is the whole reason this can be lock-free with just two atomics.
//
// Memory layout of the backing SAB:
//   [0]  Int32  head (read index, owned by consumer)
//   [1]  Int32  tail (write index, owned by producer)
//   [2..] Uint8 data[capacity]
//
// Framing: each record is length-prefixed with a 4-byte little-endian u32 so the
// reader knows how many bytes to pull. Capacity is a power of two; indices are
// free-running and masked, classic ring discipline.
//
// Blocking: the consumer parks in Atomics.wait on `tail`; the producer bumps
// `tail` then Atomics.notify. The producer never blocks — if the ring is full it
// returns false and the caller drops/overwrites (eval frames are throttled
// upstream, so a full ring means the reader is briefly behind, not data loss
// that matters: the next depth tick supersedes it).

const HEAD = 0; // Int32 slot
const TAIL = 1; // Int32 slot
const HEADER_I32 = 2; // number of Int32 slots before the byte region
const LEN_PREFIX = 4; // bytes

export interface RingLayout {
  sab: SharedArrayBuffer;
  capacity: number;
}

/** Allocate a SAB sized for `capacity` data bytes (rounded up to a power of two). */
export function createRing(capacity: number): RingLayout {
  let cap = 1;
  while (cap < capacity) cap <<= 1;
  const sab = new SharedArrayBuffer(HEADER_I32 * 4 + cap);
  return { sab, capacity: cap };
}

export class RingWriter {
  private readonly i32: Int32Array;
  private readonly bytes: Uint8Array;
  private readonly cap: number;
  private readonly mask: number;
  private readonly enc = new TextEncoder();
  // Reused scratch buffer to encode strings without allocating per call.
  private scratch = new Uint8Array(1024);

  constructor(layout: RingLayout) {
    this.i32 = new Int32Array(layout.sab, 0, HEADER_I32);
    this.bytes = new Uint8Array(layout.sab, HEADER_I32 * 4);
    this.cap = layout.capacity;
    this.mask = this.cap - 1;
  }

  private freeBytes(): number {
    const head = Atomics.load(this.i32, HEAD);
    const tail = Atomics.load(this.i32, TAIL);
    return this.cap - (tail - head);
  }

  /**
   * Write one UTF-8 string record. Returns false if the ring lacks room (caller
   * decides to drop). Wakes a parked reader on success.
   */
  write(s: string): boolean {
    // encodeInto into a reused, growable scratch buffer (no per-call alloc once warm)
    let res = this.enc.encodeInto(s, this.scratch);
    while (res.read < s.length) {
      this.scratch = new Uint8Array(this.scratch.length * 2);
      res = this.enc.encodeInto(s, this.scratch);
    }
    const len = res.written;
    const total = LEN_PREFIX + len;
    if (total > this.freeBytes()) return false;

    let tail = Atomics.load(this.i32, TAIL);
    // length prefix (LE u32), byte by byte through the mask
    this.bytes[tail & this.mask] = total & 0xff;
    this.bytes[(tail + 1) & this.mask] = (total >>> 8) & 0xff;
    this.bytes[(tail + 2) & this.mask] = (total >>> 16) & 0xff;
    this.bytes[(tail + 3) & this.mask] = (total >>> 24) & 0xff;
    tail += LEN_PREFIX;
    for (let i = 0; i < len; i++) {
      this.bytes[(tail + i) & this.mask] = this.scratch[i]!;
    }
    tail += len;

    Atomics.store(this.i32, TAIL, tail);
    Atomics.notify(this.i32, TAIL, 1);
    return true;
  }
}

export class RingReader {
  private readonly i32: Int32Array;
  private readonly bytes: Uint8Array;
  private readonly cap: number;
  private readonly mask: number;
  private readonly dec = new TextDecoder();
  private linear = new Uint8Array(1024); // scratch for wrap-around records

  constructor(layout: RingLayout) {
    this.i32 = new Int32Array(layout.sab, 0, HEADER_I32);
    this.bytes = new Uint8Array(layout.sab, HEADER_I32 * 4);
    this.cap = layout.capacity;
    this.mask = this.cap - 1;
  }

  private available(): number {
    return Atomics.load(this.i32, TAIL) - Atomics.load(this.i32, HEAD);
  }

  /** Non-blocking: read one record, or null if the ring is empty. */
  read(): string | null {
    if (this.available() < LEN_PREFIX) return null;
    let head = Atomics.load(this.i32, HEAD);
    const total =
      this.bytes[head & this.mask]! |
      (this.bytes[(head + 1) & this.mask]! << 8) |
      (this.bytes[(head + 2) & this.mask]! << 16) |
      (this.bytes[(head + 3) & this.mask]! << 24);
    const len = total - LEN_PREFIX;
    head += LEN_PREFIX;
    if (len > this.linear.length) this.linear = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      this.linear[i] = this.bytes[(head + i) & this.mask]!;
    }
    head += len;
    Atomics.store(this.i32, HEAD, head);
    return this.dec.decode(this.linear.subarray(0, len));
  }

  /**
   * Block (up to timeoutMs) until at least one record is available, then return
   * it. Returns null on timeout. ONLY call from a Worker — Atomics.wait throws on
   * the main thread.
   */
  readBlocking(timeoutMs = Infinity): string | null {
    for (;;) {
      const s = this.read();
      if (s !== null) return s;
      const tail = Atomics.load(this.i32, TAIL);
      // wait for tail to change from its current value
      const r = Atomics.wait(this.i32, TAIL, tail, timeoutMs);
      if (r === 'timed-out') return this.read();
    }
  }
}

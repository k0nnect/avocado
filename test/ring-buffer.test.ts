import { describe, it, expect } from 'vitest';
import { createRing, RingWriter, RingReader } from '../src/offscreen/ring-buffer.ts';

describe('ring buffer (real SharedArrayBuffer)', () => {
  it('round-trips a single record', () => {
    const ring = createRing(256);
    const w = new RingWriter(ring);
    const r = new RingReader(ring);
    expect(w.write('e:24:1:c:37:512/460/28:e2e4 e7e5')).toBe(true);
    expect(r.read()).toBe('e:24:1:c:37:512/460/28:e2e4 e7e5');
    expect(r.read()).toBe(null);
  });

  it('preserves FIFO order across many records', () => {
    const ring = createRing(4096);
    const w = new RingWriter(ring);
    const r = new RingReader(ring);
    const sent: string[] = [];
    for (let i = 0; i < 50; i++) {
      const s = `e:${i}:1:c:${i * 3}:-:d2d4`;
      sent.push(s);
      expect(w.write(s)).toBe(true);
    }
    const got: string[] = [];
    for (let s = r.read(); s !== null; s = r.read()) got.push(s);
    expect(got).toEqual(sent);
  });

  it('wraps around the capacity boundary correctly', () => {
    // small ring forces wrap; interleave write/read so we never overflow
    const ring = createRing(64);
    const w = new RingWriter(ring);
    const r = new RingReader(ring);
    for (let i = 0; i < 500; i++) {
      const s = `x${i}`;
      expect(w.write(s)).toBe(true);
      expect(r.read()).toBe(s);
    }
  });

  it('returns false when full rather than corrupting', () => {
    const ring = createRing(16); // 16 data bytes
    const w = new RingWriter(ring);
    // "hello" → 4-byte prefix + 5 bytes = 9; second write would need 9 more, no room
    expect(w.write('hello')).toBe(true);
    expect(w.write('world')).toBe(false);
    const r = new RingReader(ring);
    expect(r.read()).toBe('hello');
  });

  it('handles multibyte UTF-8 (commentary lines can have unicode)', () => {
    const ring = createRing(256);
    const w = new RingWriter(ring);
    const r = new RingReader(ring);
    const s = 'l:absolute domination ♟ buddy';
    expect(w.write(s)).toBe(true);
    expect(r.read()).toBe(s);
  });
});

// Generates the violet avocado action icons (16/48/128) as valid PNGs using
// only node's built-in zlib — no image library. A flat rounded-ish violet tile
// with a lighter pit; enough to satisfy the manifest and look on-brand.
import { writeFile, mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'icons');

// brand palette — mauve / lilac
const BG = [17, 17, 27]; // #11111b
const FLESH = [203, 166, 247]; // #cba6f7 (mauve body)
const MID = [168, 127, 212]; // #a87fd4 (darker rim around the pit)
const PIT = [230, 214, 251]; // #e6d6fb (pale lilac pit)
const FACE = [17, 17, 27]; // smiley face, same as bg

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const cx = size / 2;
  const cy = size / 2;
  // raw image: each row prefixed with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) / (size * 0.42);
      const dy = (y - cy) / (size * 0.46);
      const r2 = dx * dx + dy * dy;
      let col = BG;
      let a = 0;
      if (r2 <= 1) {
        col = FLESH;
        a = 255;

        const pcy = cy - size * 0.04; // pit center (sits a touch low)
        const pr = size * 0.16; // pit radius

        // inner flesh ring around the pit
        const mdx = (x - cx) / (size * 0.205);
        const mdy = (y - pcy) / (size * 0.205);
        if (mdx * mdx + mdy * mdy <= 1) col = MID;

        // pit + smiley face
        const pdx = (x - cx) / pr;
        const pdy = (y - pcy) / pr;
        if (pdx * pdx + pdy * pdy <= 1) {
          col = PIT;

          // eyes
          const eyeR = pr * 0.2;
          const eyeY = pcy - pr * 0.28;
          const eyeDX = pr * 0.42;
          const lE = (x - (cx - eyeDX)) ** 2 + (y - eyeY) ** 2;
          const rE = (x - (cx + eyeDX)) ** 2 + (y - eyeY) ** 2;
          if (lE <= eyeR * eyeR || rE <= eyeR * eyeR) col = FACE;

          // smile: lower arc of a circle centred just above the pit middle
          const scy = pcy - pr * 0.12;
          const sr = pr * 0.52;
          const t = Math.max(1, size * 0.02);
          const d = Math.hypot(x - cx, y - scy);
          if (Math.abs(d - sr) < t && y > scy && Math.abs(x - cx) < sr * 0.95) col = FACE;
        }
      }
      raw[p++] = col[0];
      raw[p++] = col[1];
      raw[p++] = col[2];
      raw[p++] = a;
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir(out, { recursive: true });
for (const size of [16, 48, 128]) {
  await writeFile(join(out, `avocado${size}.png`), png(size));
}
console.log('avocado: icons written → icons/');

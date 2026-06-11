// Generates the violet avocado action icons (16/48/128) as valid PNGs using
// only node's built-in zlib — no image library. A flat rounded-ish violet tile
// with a lighter pit; enough to satisfy the manifest and look on-brand.
import { writeFile, mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'icons');

// brand palette
const BG = [22, 18, 31]; // #16121f
const FLESH = [124, 58, 237]; // #7c3aed
const PIT = [196, 181, 253]; // #c4b5fd

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
        // pit
        const pdx = (x - cx) / (size * 0.16);
        const pdy = (y - cy + size * 0.04) / (size * 0.16);
        if (pdx * pdx + pdy * pdy <= 1) col = PIT;
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

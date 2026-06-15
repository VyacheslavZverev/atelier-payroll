// Generates PNG app icons (192/512) without any image library: draws a "₽"
// glyph from simple shapes into an RGBA buffer and encodes a PNG by hand.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'client', 'public');

const BG = [0x4f, 0x46, 0xe5, 0xff];
const FG = [0xff, 0xff, 0xff, 0xff];

function makeCrcTable() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}
const CRC_TABLE = makeCrcTable();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const corner = size * 0.18;

  // "₽" geometry (relative to icon size)
  const stemX0 = 0.36 * size;
  const stemX1 = 0.45 * size;
  const stemY0 = 0.2 * size;
  const stemY1 = 0.8 * size;
  const bowlCx = 0.45 * size;
  const bowlCy = 0.345 * size;
  const bowlOuter = 0.155 * size;
  const bowlInner = 0.065 * size;
  const barY0 = 0.62 * size;
  const barY1 = 0.7 * size;
  const barX0 = 0.26 * size;
  const barX1 = 0.6 * size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // rounded-corner background
      let inBg = true;
      const cx = x < corner ? corner : x > size - corner ? size - corner : x;
      const cy = y < corner ? corner : y > size - corner ? size - corner : y;
      if ((x < corner || x > size - corner) && (y < corner || y > size - corner)) {
        inBg = Math.hypot(x - cx, y - cy) <= corner;
      }

      let color = null;
      if (inBg) {
        color = BG;
        const inStem = x >= stemX0 && x <= stemX1 && y >= stemY0 && y <= stemY1;
        const d = Math.hypot(x - bowlCx, y - bowlCy);
        const inBowl = x >= stemX0 && d <= bowlOuter && d >= bowlInner;
        const inBar = x >= barX0 && x <= barX1 && y >= barY0 && y <= barY1;
        if (inStem || inBowl || inBar) color = FG;
      }

      if (color) {
        const off = (y * size + x) * 4;
        rgba[off] = color[0];
        rgba[off + 1] = color[1];
        rgba[off + 2] = color[2];
        rgba[off + 3] = color[3];
      }
    }
  }
  return rgba;
}

for (const size of [192, 512]) {
  const png = encodePng(size, drawIcon(size));
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}

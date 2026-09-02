// Generates PWA icons (PNG) with zero dependencies: rasterises a simple perch
// silhouette + stripes into an RGBA buffer and encodes it as PNG via zlib.
// Usage: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- drawing ---------------------------------------------------------------
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG = hex('#0f2a3a'); // deep canal blue-green
const BODY = hex('#7fb069'); // perch olive
const STRIPE = hex('#2f4a2c');
const FIN = hex('#e0603a'); // red-orange fins
const EYE = hex('#f4f1de');

function render(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      // Background: full square for maskable, rounded disc otherwise.
      if (maskable || dx * dx + dy * dy <= R * R) put(x, y, BG);
      else put(x, y, BG, 0);

      // Body: ellipse, scaled down a bit on maskable so the safe zone holds.
      const s = maskable ? 0.72 : 0.84;
      const bx = dx / (R * s * 0.86);
      const by = (dy + R * 0.02) / (R * s * 0.46);
      const inBody = bx * bx + by * by <= 1;
      // Tail: triangle to the left of the body.
      const tx = dx + R * s * 0.86;
      const inTail = tx < R * s * 0.14 && tx > -R * s * 0.18 && Math.abs(dy) < (R * s * 0.18 - tx) * 1.1 + R * s * 0.05;
      // Dorsal fin: spiky arc above.
      const inDorsal = inBody === false && by < 0 && by > -1.55 && Math.abs(bx + 0.15) < 0.5 && (bx * bx + (by + 0.55) * (by + 0.55) <= 1.0);
      if (inDorsal) put(x, y, FIN);
      if (inTail) put(x, y, FIN);
      if (inBody) {
        // Vertical stripes across the body.
        const stripe = Math.floor((bx + 1) * 3.5) % 2 === 1 && bx > -0.55 && bx < 0.75;
        put(x, y, stripe ? STRIPE : BODY);
      }
      // Eye near the head (right side).
      const ex = dx - R * s * 0.58;
      const ey = dy - R * s * 0.12;
      if (ex * ex + ey * ey <= (R * s * 0.07) ** 2) put(x, y, EYE);
      if (ex * ex + ey * ey <= (R * s * 0.035) ** 2) put(x, y, [10, 10, 10]);
    }
  }
  return encodePng(size, size, px);
}

for (const size of [192, 512]) {
  writeFileSync(join(outDir, `icon-${size}.png`), render(size, false));
  writeFileSync(join(outDir, `icon-${size}-maskable.png`), render(size, true));
}
writeFileSync(join(outDir, 'apple-touch-icon.png'), render(180, true));
console.log('icons written to', outDir);

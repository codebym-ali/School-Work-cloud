/**
 * Generate the app icons as real PNGs — no dependencies, no rasteriser.
 *
 * Why not Next's `ImageResponse` (`app/icon.tsx`), which is the idiomatic answer: the bundled
 * `@vercel/og` in Next 14.2 cannot load its own font on Windows — it builds the path
 * `.\file:\C:\...\noto-sans-v27-latin-regular.ttf` and throws `ERR_INVALID_URL`, so every icon
 * route 500s on a Windows dev machine. It may well work on a Linux deploy, but a manifest whose
 * icons are generated at request time and fail on one platform is worse than a checked-in file:
 * the failure is a 500 behind an <link>, which nothing surfaces and nobody notices.
 *
 * So the icons are committed, and this script is how they are reproduced. Run:
 *   node scripts/generate-app-icons.mjs
 *
 * The mark is a schoolhouse in the brand blue. The product's own emoji is 🏫, so this keeps an
 * association the user already has rather than inventing a logo; drawn as geometry rather than the
 * emoji itself, because emoji render differently on every platform and an icon must not.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public');

const BRAND = [0x33, 0x55, 0xcc, 0xff];
const WHITE = [0xff, 0xff, 0xff, 0xff];

/** CRC32, as PNG specifies it. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** Encode an RGBA pixel buffer as a PNG. Filter byte 0 on every scanline — the images are flat
 *  colour, so a cleverer filter would save bytes nobody is counting. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Draw the mark.
 *
 * `padding` is the maskable safe area: Android crops a launcher icon to whatever shape the device
 * uses, so a mark drawn edge to edge loses its corners. The background always fills the square —
 * it is the crop that must have something to eat.
 */
function drawIcon(size, padding) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, c) => {
    const i = (y * size + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
  };

  const s = size - padding * 2;           // the mark's box
  const u = s / 24;                       // one unit of the 24x24 design grid
  const gx = (n) => padding + n * u;      // design-grid x → pixel
  const gy = (n) => padding + n * u;

  const inRect = (x, y, x0, y0, x1, y1) => x >= gx(x0) && x < gx(x1) && y >= gy(y0) && y < gy(y1);
  // Roof: the triangle (12,3) (22,9) (2,9), tested by interpolating its two edges per scanline.
  const inRoof = (x, y) => {
    if (y < gy(3) || y >= gy(9)) return false;
    const t = (y - gy(3)) / (gy(9) - gy(3));           // 0 at the apex, 1 at the eaves
    return x >= gx(12) - t * (gx(12) - gx(2)) && x <= gx(12) + t * (gx(22) - gx(12));
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let c = BRAND;
      if (inRoof(x, y) || inRect(x, y, 4, 9, 20, 21)) c = WHITE;
      // Knocked back out of the white body so the mark still reads at 48px.
      if (inRect(x, y, 10, 14, 14, 21)) c = BRAND;                     // door
      if (inRect(x, y, 6, 11.5, 8.6, 14.1)) c = BRAND;                 // left window
      if (inRect(x, y, 15.4, 11.5, 18, 14.1)) c = BRAND;               // right window
      set(x, y, c);
    }
  }
  return encodePng(size, size, px);
}

mkdirSync(OUT, { recursive: true });
const files = [
  ['icon-192.png', 192, 14],
  ['icon-512.png', 512, 38],
  // ~20% clear all round, which is what a maskable crop expects.
  ['icon-maskable-512.png', 512, 105],
  ['apple-icon.png', 180, 20],
  ['favicon-32.png', 32, 2],
];
for (const [name, size, padding] of files) {
  const png = drawIcon(size, padding);
  writeFileSync(join(OUT, name), png);
  console.log(`${name.padEnd(24)} ${size}x${size}  ${png.length}b`);
}

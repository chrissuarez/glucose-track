// Generates the PNG icons (no dependencies). Run: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size, pix) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; pix.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// Teal background, white glucose "spike" line, with 4x supersampling for smooth edges.
function render(size, scale) {
  const SS = 3, pix = Buffer.alloc(size * size * 4);
  const pts = [[.18, .62], [.34, .62], [.46, .28], [.60, .72], [.70, .52], [.82, .52]].map(([x, y]) => [x, 0.5 + (y - 0.5) * 1 ]);
  const P = pts.map(([x, y]) => [(0.5 + (x - 0.5) * scale) * size, (0.5 + (y - 0.5) * scale) * size]);
  const half = 0.045 * scale * size;
  const dist = (px, py, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let cov = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = x + (sx + .5) / SS, py = y + (sy + .5) / SS;
      let d = 1e9; for (let i = 0; i < P.length - 1; i++) d = Math.min(d, dist(px, py, P[i], P[i + 1]));
      if (d <= half) cov++;
    }
    const a = cov / (SS * SS), o = (y * size + x) * 4;
    pix[o] = Math.round(15 + (255 - 15) * a); pix[o + 1] = Math.round(118 + (255 - 118) * a); pix[o + 2] = Math.round(110 + (255 - 110) * a); pix[o + 3] = 255;
  }
  return png(size, pix);
}
mkdirSync('icons', { recursive: true });
writeFileSync('icons/icon-192.png', render(192, 1));
writeFileSync('icons/icon-512.png', render(512, 1));
writeFileSync('icons/apple-touch-icon.png', render(180, 1));
writeFileSync('icons/icon-maskable-512.png', render(512, 0.7)); // content inside the maskable safe zone
console.log('icons written');

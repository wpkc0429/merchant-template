#!/usr/bin/env node
/* ============================================================
   gen-placeholders.mjs: generates the neutral placeholder images, no dependencies (Node 18+).

     node scripts/gen-placeholders.mjs

   Writes small, valid, flat-colour PNGs:
     public/assets/og-cover.png        1200 x 630   social share card
     public/assets/story.png           1200 x 900   story / about photo placeholder
     catalog/images/product-01..08.png 800 x 800    sample-catalogue product photos
   Deterministic: running it twice gives byte-identical files. Merchants replace these
   with real photography; nothing here is a design contract.
   ============================================================ */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgb) {            // rgb: Uint8Array w*h*3
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Signed distance functions in a 0..1 square (negative inside).
const sd = {
  circle: (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r,
  box: (x, y, cx, cy, hw, hh, rad = 0) => { const qx = Math.abs(x - cx) - hw + rad, qy = Math.abs(y - cy) - hh + rad; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad; },
  ring: (x, y, cx, cy, r, t) => Math.abs(Math.hypot(x - cx, y - cy) - r) - t,
  diamond: (x, y, cx, cy, r) => (Math.abs(x - cx) + Math.abs(y - cy)) * Math.SQRT1_2 - r,
  tri: (x, y, cx, cy, r) => Math.max(Math.abs(x - cx) * 0.866 + (y - cy) * 0.5, -(y - cy)) - r * 0.5,
  half: (x, y, cx, cy, r) => Math.max(Math.hypot(x - cx, y - cy) - r, y - cy)
};

function render(w, h, bg, fg, shapeFn) {
  const out = new Uint8Array(w * h * 3);
  const px = 1 / Math.min(w, h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = (i + 0.5) / Math.min(w, h), y = (j + 0.5) / Math.min(w, h);
    const d = shapeFn(x, y);
    const c = mix(bg, fg, clamp01(0.5 - d / px));
    out.set(c, (j * w + i) * 3);
  }
  return out;
}

const PRODUCT_LOOKS = [
  ['#ececee', '#c9c9cf', (x, y) => sd.circle(x, y, 0.5, 0.5, 0.26)],
  ['#e9eaec', '#b9bcc4', (x, y) => sd.box(x, y, 0.5, 0.5, 0.25, 0.25, 0.05)],
  ['#eeeeec', '#c8c8c2', (x, y) => sd.tri(x, y, 0.5, 0.58, 0.55)],
  ['#e8ebee', '#b4bfcc', (x, y) => sd.ring(x, y, 0.5, 0.5, 0.24, 0.045)],
  ['#efeeee', '#cfc9c9', (x, y) => Math.min(sd.box(x, y, 0.38, 0.5, 0.06, 0.27), sd.box(x, y, 0.62, 0.5, 0.06, 0.2))],
  ['#eaecec', '#bccaca', (x, y) => sd.half(x, y, 0.5, 0.62, 0.3)],
  ['#ededf0', '#c3c3d1', (x, y) => sd.diamond(x, y, 0.5, 0.5, 0.27)],
  ['#ececea', '#c4c4bb', (x, y) => Math.min(sd.box(x, y, 0.5, 0.5, 0.25, 0.05), sd.box(x, y, 0.5, 0.5, 0.05, 0.25))]
];

function write(rel, buf) {
  const f = path.join(ROOT, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, buf);
  console.log(`wrote ${rel} (${(buf.length / 1024).toFixed(1)} KiB)`);
}

PRODUCT_LOOKS.forEach(([bg, fg, fn], i) => write(`catalog/images/product-0${i + 1}.png`, png(800, 800, render(800, 800, hex(bg), hex(fg), fn))));
write('public/assets/og-cover.png', png(1200, 630, render(1200, 630, hex('#ececee'), hex('#2f5d8a'), (x, y) => Math.min(sd.box(x, y, 0.6, 0.5, 0.16, 0.16, 0.04), sd.box(x, y, 1.1, 0.5, 0.35, 0.035, 0.01)))));
write('public/assets/story.png', png(1200, 900, render(1200, 900, hex('#e9eaec'), hex('#c3c8d0'), (x, y) => Math.min(sd.circle(x, y, 0.62, 0.55, 0.3), sd.box(x, y, 1.0, 0.7, 0.14, 0.14, 0.03)))));

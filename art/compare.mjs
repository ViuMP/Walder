#!/usr/bin/env node
// art/compare.mjs — builds art/out/compare_reference_vs_sprite.png:
// the design sheet's Panel A hero, area-averaged down to the same body height
// as the sprite, next to idle_0 at 3x and 2x.  Zero dependencies.
//
//   node art/compare.mjs

import { inflateSync, deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const REF = join(HERE, '..', 'design', 'references', 'walder_design_sheet_chosen.png');

/* ------------------------------------------------------------ PNG decode -- */
function decodePNG(buf) {
  let p = 8, w = 0, h = 0, bd = 0, ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6)) throw new Error(`unsupported PNG (bd ${bd}, ct ${ct})`);
  const bpp = ct === 2 ? 3 : 4;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prv = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prv[x], c = x >= bpp ? prv[x - bpp] : 0;
      let v = src[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, bpp, data: out };
}

/* ------------------------------------------------------------ PNG encode -- */
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = ~0; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (~c) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(img) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = img.w * 4;
  const raw = Buffer.alloc((stride + 1) * img.h);
  for (let y = 0; y < img.h; y++) Buffer.from(img.data.buffer, img.data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------------------------------------------------------- helpers - */
const getPx = (im, x, y) => {
  const i = (y * im.w + x) * im.bpp;
  return [im.data[i], im.data[i + 1], im.data[i + 2], im.bpp === 4 ? im.data[i + 3] : 255];
};

/** Crop a rect, then trim the near-uniform border colour away. */
function cropTrim(im, x0, y0, x1, y1) {
  const bg = getPx(im, x0, y0);
  const near = (p) => Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) < 24;
  let ax = x1, ay = y1, bx = x0, by = y0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (near(getPx(im, x, y))) continue;
    if (x < ax) ax = x; if (x > bx) bx = x; if (y < ay) ay = y; if (y > by) by = y;
  }
  return { x: ax, y: ay, w: bx - ax + 1, h: by - ay + 1, bg };
}

/** Area-average downscale of a source rect into a w x h RGBA image. */
function resample(im, r, w, h) {
  const out = { w, h, data: new Uint8Array(w * h * 4) };
  const near = (p) => Math.abs(p[0] - r.bg[0]) + Math.abs(p[1] - r.bg[1]) + Math.abs(p[2] - r.bg[2]) < 24;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx0 = r.x + Math.floor(x * r.w / w), sx1 = Math.max(sx0 + 1, r.x + Math.floor((x + 1) * r.w / w));
    const sy0 = r.y + Math.floor(y * r.h / h), sy1 = Math.max(sy0 + 1, r.y + Math.floor((y + 1) * r.h / h));
    let R = 0, G = 0, B = 0, n = 0, op = 0, tot = 0;
    for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
      const p = getPx(im, sx, sy); tot++;
      if (near(p)) continue;
      R += p[0]; G += p[1]; B += p[2]; n++; op++;
    }
    const i = (y * w + x) * 4;
    if (n && op * 2 >= tot) { out.data[i] = R / n; out.data[i + 1] = G / n; out.data[i + 2] = B / n; out.data[i + 3] = 255; }
  }
  return out;
}

function blitRGBA(dst, src, ox, oy) {
  for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
    const s = (y * src.w + x) * 4;
    if (!src.data[s + 3]) continue;
    const X = ox + x, Y = oy + y;
    if (X < 0 || Y < 0 || X >= dst.w || Y >= dst.h) continue;
    const d = (Y * dst.w + X) * 4;
    dst.data[d] = src.data[s]; dst.data[d + 1] = src.data[s + 1];
    dst.data[d + 2] = src.data[s + 2]; dst.data[d + 3] = 255;
  }
}

const hexToRGBA = (hex) => { const s = hex.replace('#', ''); return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), 255]; };

/** Render sprite rows to an RGBA image at `scale`, trimmed to its ink bbox. */
function spriteImg(rows, pal, scale) {
  let ax = 1e9, ay = 1e9, bx = -1, by = -1;
  rows.forEach((r, y) => { for (let x = 0; x < r.length; x++) if (r[x] !== '.' && r[x] !== ' ') { if (x < ax) ax = x; if (x > bx) bx = x; if (y < ay) ay = y; if (y > by) by = y; } });
  const w = (bx - ax + 1) * scale, h = (by - ay + 1) * scale;
  const out = { w, h, data: new Uint8Array(w * h * 4) };
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
    const ch = rows[y][x]; if (ch === '.' || ch === ' ') continue;
    const c = hexToRGBA(pal[ch]);
    for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
      const X = (x - ax) * scale + sx, Y = (y - ay) * scale + sy;
      const i = (Y * w + X) * 4;
      out.data[i] = c[0]; out.data[i + 1] = c[1]; out.data[i + 2] = c[2]; out.data[i + 3] = 255;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ main -- */
const spec = JSON.parse(readFileSync(join(HERE, 'walder.json'), 'utf8'));
const pal = spec.palettes.golden;
const ref = decodePNG(readFileSync(REF));
// Panel A of the design sheet: the 8x hero sits in the top-left card.
const r = cropTrim(ref, 30, 40, 350, 250);

const s3 = spriteImg(spec.frames.idle_0.rows, pal, 3);
const s2 = spriteImg(spec.frames.idle_0.rows, pal, 2);
const refScaled = resample(ref, r, Math.round(r.w * s3.h / r.h), s3.h);

const G = 12;
const BG = hexToRGBA('#5c5c66');
const W = G + refScaled.w + G + s3.w + G + s2.w + G;
const H = G + s3.h + G;
const img = { w: W, h: H, data: new Uint8Array(W * H * 4) };
for (let i = 0; i < W * H; i++) { img.data[i * 4] = BG[0]; img.data[i * 4 + 1] = BG[1]; img.data[i * 4 + 2] = BG[2]; img.data[i * 4 + 3] = 255; }
let x = G;
blitRGBA(img, refScaled, x, G + s3.h - refScaled.h); x += refScaled.w + G;
blitRGBA(img, s3, x, G); x += s3.w + G;
blitRGBA(img, s2, x, G + s3.h - s2.h);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'compare_reference_vs_sprite.png'), encodePNG(img));
console.log(`compare.mjs: ref crop ${r.w}x${r.h} -> ${refScaled.w}x${refScaled.h} | sprite 3x ${s3.w}x${s3.h}, 2x ${s2.w}x${s2.h} -> art/out/compare_reference_vs_sprite.png`);

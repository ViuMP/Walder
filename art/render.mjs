#!/usr/bin/env node
// art/render.mjs — renders art/walder.json to PNGs. Zero dependencies (Node built-ins only).
//
//   node art/render.mjs
//
// Outputs (all under art/out/):
//   <palette>/<frame>@1x.png     transparent, 1 px per logical pixel
//   <palette>/<frame>@2x.png     the app's small size — check readability here
//   <palette>/<frame>@3x.png     the app's large size — check readability here
//   <palette>/<frame>@6x.png     the same, nearest-neighbour 6x
//   sheet_<palette>.png          contact sheet, 4x, one animation per row
//   sheet_index.txt              which animation is on which sheet row
//   expressions_golden@2x.png    the six expressions at the app's default size
//   expressions_golden@3x.png    the same one step larger
//   base_golden_scales.png       idle_0/idle_1 at 1x..6x, for readability checks
//   CHECK.txt                    validation report (dims, palette coverage, animations)

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const spec = JSON.parse(readFileSync(join(HERE, 'walder.json'), 'utf8'));

/* ---------------------------------------------------------------- PNG ---- */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/** img = { w, h, data: Uint8Array(w*h*4) } -> PNG Buffer (RGBA8) */
function encodePNG(img) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0);
  ihdr.writeUInt32BE(img.h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace
  const stride = img.w * 4;
  const raw = Buffer.alloc((stride + 1) * img.h);
  for (let y = 0; y < img.h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(img.data.buffer, img.data.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------- raster --- */

function newImage(w, h, bg) {
  const data = new Uint8Array(w * h * 4);
  if (bg) {
    const [r, g, b, a] = bg;
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
    }
  }
  return { w, h, data };
}

function hexToRGBA(hex) {
  const s = hex.replace('#', '');
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
    s.length >= 8 ? parseInt(s.slice(6, 8), 16) : 255,
  ];
}

function px(img, x, y, rgba) {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
  const i = (y * img.w + x) * 4;
  img.data[i] = rgba[0]; img.data[i + 1] = rgba[1];
  img.data[i + 2] = rgba[2]; img.data[i + 3] = rgba[3];
}

/** Blit a frame's rows into img at (ox,oy), scaled by pixel replication. */
function blitFrame(img, rows, pal, ox, oy, scale) {
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') continue;
      const hex = pal[ch];
      if (!hex) throw new Error(`letter '${ch}' missing from palette`);
      const rgba = hexToRGBA(hex);
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          px(img, ox + x * scale + sx, oy + y * scale + sy, rgba);
        }
      }
    }
  }
}

function renderFrame(rows, pal, scale, bg) {
  const w = Math.max(...rows.map((r) => r.length));
  const img = newImage(w * scale, rows.length * scale, bg);
  blitFrame(img, rows, pal, 0, 0, scale);
  return img;
}

function write(path, buf) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
}

/* --------------------------------------------------------------- checks -- */

const LETTERS_ALWAYS = new Set(['.', ' ']);
const check = [];
let failures = 0;
function ok(line) { check.push('  OK   ' + line); }
function bad(line) { check.push('  FAIL ' + line); failures++; }

const paletteNames = Object.keys(spec.palettes);
const frameNames = Object.keys(spec.frames);

// 1. every frame's dimensions match its declared box
check.push('[1] frame dimensions vs. declared box');
for (const name of frameNames) {
  const f = spec.frames[name];
  const box = spec.boxes[f.box];
  if (!box) { bad(`${name}: unknown box "${f.box}"`); continue; }
  const [bw, bh] = box;
  const widths = new Set(f.rows.map((r) => r.length));
  if (f.rows.length !== bh) bad(`${name}: ${f.rows.length} rows, box "${f.box}" wants ${bh}`);
  else if (widths.size !== 1) bad(`${name}: ragged rows (widths ${[...widths].join(',')})`);
  else if (f.rows[0].length !== bw) bad(`${name}: width ${f.rows[0].length}, box "${f.box}" wants ${bw}`);
  else ok(`${name} ${bw}x${bh} (${f.box})`);
}

// 2. every letter used in any frame resolves in every palette
check.push('');
check.push('[2] palette coverage');
const used = new Set();
for (const name of frameNames) {
  for (const row of spec.frames[name].rows) for (const ch of row) if (!LETTERS_ALWAYS.has(ch)) used.add(ch);
}
check.push(`  letters used across all frames: ${[...used].sort().join(' ')}`);
for (const p of paletteNames) {
  const missing = [...used].filter((ch) => !spec.palettes[p][ch]).sort();
  if (missing.length) bad(`palette "${p}" missing: ${missing.join(' ')}`);
  else ok(`palette "${p}" resolves all ${used.size} letters`);
}
for (const p of paletteNames) {
  const extra = Object.keys(spec.palettes[p]).filter((ch) => !used.has(ch)).sort();
  if (extra.length) check.push(`  note  palette "${p}" defines unused letters: ${extra.join(' ')}`);
}

// 3. animations
check.push('');
check.push('[3] animations');
const animNames = Object.keys(spec.animations);
for (const a of animNames) {
  const an = spec.animations[a];
  const bad0 = an.frames.filter((f) => !spec.frames[f]);
  if (bad0.length) { bad(`${a}: unknown frames ${bad0.join(',')}`); continue; }
  if (an.durationsMs.length !== an.frames.length) { bad(`${a}: ${an.frames.length} frames but ${an.durationsMs.length} durations`); continue; }
  const boxes = new Set(an.frames.map((f) => spec.frames[f].box));
  if (boxes.size !== 1) { bad(`${a}: mixes boxes ${[...boxes].join(',')}`); continue; }
  ok(`${a}: ${an.frames.length} frame(s), box ${[...boxes][0]}, ${an.durationsMs.join('/')} ms, loop=${an.loop}, hold=${an.hold === true}`);
}

// 4. expressions
check.push('');
check.push('[4] expressions');
for (const [k, v] of Object.entries(spec.expressions)) {
  if (spec.animations[v] || spec.frames[v]) ok(`${k} -> ${v}`);
  else bad(`${k} -> ${v} (not a frame or animation)`);
}

// 5. standing frames share a ground line (bottom row must contain ink),
//    unless the frame declares "airborne": true (mid-hop).
check.push('');
check.push(`[5] ground line on standing frames (row ${spec.boxes.stand[1] - 1} must have pixels)`);
for (const name of frameNames) {
  const f = spec.frames[name];
  if (f.box !== 'stand') continue;
  const last = f.rows[f.rows.length - 1];
  if (/[^. ]/.test(last)) {
    if (f.airborne) bad(`${name}: declared airborne but touches the ground row`);
    else ok(`${name}: grounded`);
  } else if (f.airborne) ok(`${name}: airborne (intentionally off the ground)`);
  else bad(`${name}: bottom row is empty (sprite would float)`);
}

/* -------------------------------------------------------------- outputs -- */

// per-frame PNGs. 2x and 3x are the sizes the app actually draws Walder at, so
// they are rendered as first-class outputs and not just eyeballed from the 6x.
const FRAME_SCALES = [1, 2, 3, 6];
for (const p of paletteNames) {
  for (const name of frameNames) {
    const rows = spec.frames[name].rows;
    for (const s of FRAME_SCALES) {
      write(join(OUT, p, `${name}@${s}x.png`), encodePNG(renderFrame(rows, spec.palettes[p], s, null)));
    }
  }
}

// contact sheets: 4x, 8 px gaps, one animation per row
const SHEET_BG = hexToRGBA('#5c5c66');
const GAP = 8;
const SCALE = 4;
const sheetIndex = [];
for (const p of paletteNames) {
  const rowsSpec = animNames.map((a) => ({ a, frames: spec.animations[a].frames }));
  let W = 0, H = GAP;
  const rowGeom = [];
  for (const r of rowsSpec) {
    let w = GAP, h = 0;
    for (const fn of r.frames) {
      const f = spec.frames[fn];
      w += f.rows[0].length * SCALE + GAP;
      h = Math.max(h, f.rows.length * SCALE);
    }
    rowGeom.push({ ...r, w, h, y: H });
    W = Math.max(W, w);
    H += h + GAP;
  }
  const img = newImage(W, H, SHEET_BG);
  for (const r of rowGeom) {
    let x = GAP;
    for (const fn of r.frames) {
      const f = spec.frames[fn];
      // bottom-align inside the row band so ground lines line up
      const oy = r.y + (r.h - f.rows.length * SCALE);
      blitFrame(img, f.rows, spec.palettes[p], x, oy, SCALE);
      x += f.rows[0].length * SCALE + GAP;
    }
  }
  write(join(OUT, `sheet_${p}.png`), encodePNG(img));
  if (p === paletteNames[0]) {
    sheetIndex.push(`sheet_<palette>.png — rows top to bottom, ${SCALE}x, ${GAP} px gaps, frames left to right:`);
    rowGeom.forEach((r, i) => sheetIndex.push(`  row ${String(i + 1).padStart(2)}  ${r.a.padEnd(14)} ${r.frames.join(', ')}`));
  }
}
write(join(OUT, 'sheet_index.txt'), Buffer.from(sheetIndex.join('\n') + '\n', 'utf8'));

// expressions strip (golden, opaque so it is easy to eyeball). Written at 6x for
// pixel-level work and at 3x because that is what the app shows.
const EXPR_ORDER = ['neutral', 'happy', 'worried', 'exhausted', 'out', 'confused'];
{
  const pick = EXPR_ORDER.map((k) => {
    const v = spec.expressions[k];
    const fn = spec.animations[v] ? spec.animations[v].frames[0] : v;
    return { k, fn };
  }).filter((e) => spec.frames[e.fn]);
  for (const S of [3, 2]) {
    const G = 8;
    const h = Math.max(...pick.map((e) => spec.frames[e.fn].rows.length)) * S;
    const w = pick.reduce((acc, e) => acc + spec.frames[e.fn].rows[0].length * S + G, G);
    const img = newImage(w, h + G * 2, SHEET_BG);
    let x = G;
    for (const e of pick) {
      const f = spec.frames[e.fn];
      blitFrame(img, f.rows, spec.palettes.golden, x, G + (h - f.rows.length * S), S);
      x += f.rows[0].length * S + G;
    }
    write(join(OUT, `expressions_golden@${S}x.png`), encodePNG(img));
  }
  check.push('');
  check.push('[6] expressions strip order: ' + pick.map((e) => `${e.k}=${e.fn}`).join('  '));
}

// base-pose ladder: idle_0 and idle_1 at every size the app might use, so
// detail that only survives at 6x is easy to spot and strengthen.
{
  const G = 8;
  const scales = [1, 2, 3, 4, 5, 6];
  const f0 = spec.frames.idle_0, f1 = spec.frames.idle_1;
  const bh = f0.rows.length, bw = f0.rows[0].length;
  const rowH = (s) => bh * s;
  const W = scales.reduce((a, s) => a + bw * s * 2 + G * 2, G);
  const H = rowH(Math.max(...scales)) + G * 2;
  const img = newImage(W, H, SHEET_BG);
  let x = G;
  for (const s of scales) {
    for (const f of [f0, f1]) {
      blitFrame(img, f.rows, spec.palettes.golden, x, H - G - rowH(s), s);
      x += bw * s + G;
    }
  }
  write(join(OUT, 'base_golden_scales.png'), encodePNG(img));
  check.push('[7] base ladder: idle_0/idle_1 at ' + scales.map((s) => `${s}x`).join(' ') + ' -> base_golden_scales.png');
}

// CHECK.txt
const header = [
  'art/out/CHECK.txt — generated by art/render.mjs',
  `frames: ${frameNames.length}   animations: ${animNames.length}   palettes: ${paletteNames.length}`,
  `boxes: ${Object.entries(spec.boxes).map(([k, v]) => `${k}=${v[0]}x${v[1]}`).join('  ')}`,
  '',
];
const footer = ['', failures === 0 ? 'RESULT: CLEAN (0 failures)' : `RESULT: ${failures} FAILURE(S)`, ''];
write(join(OUT, 'CHECK.txt'), Buffer.from([...header, ...check, ...footer].join('\n'), 'utf8'));

console.log(`rendered ${frameNames.length} frames x ${paletteNames.length} palettes -> art/out/`);
console.log(failures === 0 ? 'CHECK.txt: CLEAN' : `CHECK.txt: ${failures} FAILURE(S)`);
if (failures) process.exitCode = 1;

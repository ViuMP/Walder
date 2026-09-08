#!/usr/bin/env node
// art/frames.mjs — the script that generates art/walder.json.
//
//   node art/frames.mjs      # rewrites art/walder.json
//
// walder.json is the canonical, hand-editable artwork (plain rows of letters).
// This file is kept because every standing frame is DERIVED from one base pose,
// so proportions and the ground line stay identical across frames: edit the
// part silhouettes here and regenerate, or edit walder.json rows directly for
// one-off pixel fixes.
//
// Method: each body part is a list of row spans. Parts are drawn far -> near;
// each part auto-outlines against whatever is already on the canvas, which is
// what produces the selective inner outlining (ear over cheek, haunch over
// flank) without hand-placing those pixels. Tones come from a vertical-depth
// shade pass (h/l/m/d), then details and the face are stamped on top.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SW = 48, SH = 40;   // stand box
const ZW = 32, ZH = 24;   // sleep box

/* ==========================================================  primitives  */

const blank = (w = SW, h = SH) => Array.from({ length: h }, () => Array(w).fill('.'));
const toRows = (g) => g.map((r) => r.join(''));
/** {y: [x0,x1]} -> [[y,x0,x1]] */
const S = (o) => Object.entries(o).map(([y, v]) => [Number(y), v[0], v[1]]);
const mv = (spans, dx = 0, dy = 0) => spans.map(([y, a, b]) => [y + dy, a + dx, b + dx]);
/** Head tilt: rows further from pivotY slide sideways. */
const shear = (spans, pivotY, k) => spans.map(([y, a, b]) => {
  const dx = -Math.round((pivotY - y) * k);
  return [y, a + dx, b + dx];
});
const shearDx = (y, pivotY, k) => -Math.round((pivotY - y) * k);

function maskOf(spans) {
  const s = new Set();
  for (const [y, x0, x1] of spans) for (let x = x0; x <= x1; x++) s.add(x + ',' + y);
  return s;
}
const has = (m, x, y) => m.has(x + ',' + y);

/**
 * Draw one part: auto-shaded interior + auto outline on its boundary.
 * opts.flat      single letter for the whole interior
 * opts.invert    measure depth from the bottom (fur fringes catch light there)
 * opts.topLight  interior rows nearest the lit edge that get 'h'      (default 1)
 * opts.midLight  rows after those that get 'l'                        (default 2)
 * opts.botDark   rows nearest the shaded edge that get 'd'            (default 1)
 * opts.outline   false -> skip the outline pass (hidden filler parts)
 * opts.sides     which boundary sides get an outline, e.g. { left: true }
 */
function drawPart(g, spans, opts = {}) {
  const m = maskOf(spans);
  const { topLight = 1, midLight = 2, botDark = 1, flat = null } = opts;
  const H = g.length, W = g[0].length;
  for (const key of m) {
    const [x, y] = key.split(',').map(Number);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    if (flat) { g[y][x] = flat; continue; }
    let t = 0; while (has(m, x, y - 1 - t)) t++;
    let b = 0; while (has(m, x, y + 1 + b)) b++;
    if (opts.invert) { const q = t; t = b; b = q; }
    g[y][x] = b < botDark ? 'd' : t < topLight ? 'h' : t < topLight + midLight ? 'l' : 'm';
  }
  if (opts.outline === false) return g;
  const sd = opts.sides || { left: true, right: true, top: true, bottom: true };
  for (const key of m) {
    const [x, y] = key.split(',').map(Number);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const edge =
      (sd.left && (!has(m, x - 1, y) || x === 0)) ||
      (sd.right && (!has(m, x + 1, y) || x === W - 1)) ||
      (sd.top && (!has(m, x, y - 1) || y === 0)) ||
      (sd.bottom && (!has(m, x, y + 1) || y === H - 1));
    if (edge) g[y][x] = 'o';
  }
  return g;
}

const DARKER = { h: 'l', l: 'm', m: 'd', d: 'd', a: 'm' };
/** Shift a region one or more tones darker, preserving its shading gradient. */
function darken(g, spans, steps = 1) {
  for (const [y, x0, x1] of spans) for (let x = x0; x <= x1; x++) {
    if (y < 0 || y >= g.length || x < 0 || x >= g[0].length) continue;
    let c = g[y][x];
    if (!(c in DARKER)) continue;
    for (let i = 0; i < steps; i++) c = DARKER[c];
    g[y][x] = c;
  }
}

/** Recolour a band of rows inside a part, skipping its top/bottom fringes. */
function tintRows(g, spans, letter, fromTop = 0, keepBottom = 0) {
  const ys = spans.map(([y]) => y);
  const y0 = Math.min(...ys) + fromTop, y1 = Math.max(...ys) - keepBottom;
  tint(g, spans.filter(([y]) => y >= y0 && y <= y1), letter);
}

/** Recolour existing ink (never outline, never transparency). */
function tint(g, spans, letter) {
  for (const [y, x0, x1] of spans) for (let x = x0; x <= x1; x++) {
    if (y < 0 || y >= g.length || x < 0 || x >= g[0].length) continue;
    const c = g[y][x];
    if (c === '.' || c === 'o') continue;
    g[y][x] = letter;
  }
}

/** Interior (non-outline, non-empty) x positions of one span row. */
function interior(g, y, x0, x1) {
  const out = [];
  if (y < 0 || y >= g.length) return out;
  for (let x = Math.max(0, x0); x <= Math.min(g[0].length - 1, x1); x++) {
    const c = g[y][x];
    if (c !== '.' && c !== 'o') out.push(x);
  }
  return out;
}

/**
 * A feathered tail plume. Mid tone through the middle, shadow along the
 * underside (the forward edge of a tail carried up), the lit top/back edge in
 * highlight, and 1-px light streaks running out along the hair. The notches in
 * the span list are what make the hem ragged; this only handles the tone.
 */
function drawPlume(g, spans) {
  drawPart(g, spans, { flat: 'm' });
  const ys = spans.map(([y]) => y);
  const yTop = Math.min(...ys);
  for (const [y, x0, x1] of spans) {
    const inner = interior(g, y, x0, x1);
    if (!inner.length) continue;
    const L = inner[0], R = inner[inner.length - 1], t = y - yTop;
    g[y][L] = 'd';                                     // underside, in shadow
    if (R - 1 > L) g[y][L + 1] = 'd';
    g[y][R] = t < 5 ? 'h' : 'l';                       // lit top / back edge
    if (R - 1 > L + 1) g[y][R - 1] = 'l';              // silky streaks along the hair
    if (R - 3 > L + 1 && t % 2 === 1) g[y][R - 3] = 'l';
  }
}

/**
 * Two 1-px light streaks down the length of an ear, tracking its leading edge,
 * which is what makes a long ear read as silky hair rather than a paddle. The
 * cream hem at the bottom comes free from the ear's inverted shading.
 */
function earFeather(g, spans) {
  const ys = spans.map(([y]) => y);
  const yTop = Math.min(...ys), yBot = Math.max(...ys);
  for (const [y, x0, x1] of spans) {
    if (y <= yTop + 1 || y >= yBot - 1) continue;
    const inner = interior(g, y, x0, x1);
    if (inner.length < 3) continue;
    g[y][inner[1]] = 'l';
    if (inner.length >= 5) g[y][inner[3]] = 'l';
  }
}

/**
 * Cream belly feathering: a light band hugging the underline, 1 px in some
 * columns and 2 in others, so its upper boundary is ragged against the shadow
 * band above it. Drawn INSIDE the silhouette on purpose — pixels dangling
 * below the outline read as extra tiny feet once the sprite is down at 2x.
 * A column already covered by a leg is skipped, so it is safe on walk frames.
 */
function bellyFeather(g, xs, yFrom, yTo, letter = 'a') {
  for (const [x, depth = 1] of xs) {
    if (x < 0 || x >= g[0].length) continue;
    for (let y = Math.min(yTo, g.length - 1); y >= yFrom; y--) {
      if (y < 0) break;
      if (g[y][x] !== 'o') continue;                 // found the underline
      for (let i = 1; i <= depth; i++) {
        const c = g[y - i] && g[y - i][x];
        if (c === undefined || c === '.' || c === 'o') break;
        g[y - i][x] = letter;
      }
      break;
    }
  }
}

/** 1-px cream trailing edge down the back of a near leg (leg feathering). */
function legFeather(g, spans) {
  const bottom = Math.max(...spans.map(([y]) => y));
  for (const [y, , x1] of spans) {
    if (y > bottom - 3) continue;               // the paw is tan already
    const x = x1 - 1;
    if (y < 0 || y >= g.length || x < 0 || x >= g[0].length) continue;
    const c = g[y][x];
    if (c === '.' || c === 'o') continue;
    g[y][x] = 'a';
  }
}

/** A 1-px toe split in the paw, so a leg is not a plain column. */
function toeSplit(g, spans) {
  const bottom = Math.max(...spans.map(([y]) => y));
  const row = spans.find(([y]) => y === bottom);
  if (!row) return;
  const cx = Math.round((row[1] + row[2]) / 2);
  for (const y of [bottom - 1, bottom]) {
    if (y < 0 || y >= g.length || cx < 0 || cx >= g[0].length) continue;
    if (g[y][cx] === '.') continue;
    g[y][cx] = 'o';
  }
}

/** Stamp a bitmap. '.' leaves the pixel alone, '_' erases to transparent. */
function stamp(g, ox, oy, rows) {
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const ch = row[dx];
      if (ch === '.') continue;
      const x = ox + dx, y = oy + dy;
      if (y < 0 || y >= g.length || x < 0 || x >= g[0].length) continue;
      g[y][x] = ch === '_' ? '.' : ch;
    }
  });
}

/* ==========================================================  base parts  */
// Coordinates are the locked base pose. Ground line = row 39 for every
// standing frame; rows 0-7 are headroom for the bob, perked ears and hops.

// Tail: a feathered plume, ~10 px long and up to 6 px thick, carried up and
// back in a gentle curve like a flag. Rows 20-22 are the root and sit behind
// the body, so the plume grows out of the rump crest instead of being stuck on
// top of it. The left (under) edge steps 1 px in and out on alternate rows —
// that sawtooth is the whole reason it reads as hair and not a stick. The tip
// stops at row 11, well clear of the headroom rows the bubble uses.
const TAIL = [
  [11, 43, 47], [12, 42, 47], [13, 41, 47], [14, 39, 47],
  [15, 40, 46], [16, 40, 46], [17, 38, 46], [18, 39, 45],
  [19, 38, 45], [20, 37, 44], [21, 37, 44], [22, 38, 43],
];
// wag: the plume pivots ~2 px forward about the root, tip lagging 1 px behind
const TAIL_WAG = [
  [11, 42, 46], [12, 41, 46], [13, 39, 46], [14, 39, 45],
  [15, 37, 44], [16, 38, 44], [17, 36, 44], [18, 37, 43],
  [19, 36, 43], [20, 37, 44], [21, 37, 44], [22, 38, 43],
];
// low / unhappy / tired: the same plume dropped back along the topline
const TAIL_LOW = [
  [15, 41, 47], [16, 42, 47], [17, 40, 46], [18, 41, 46],
  [19, 39, 45], [20, 38, 45], [21, 37, 44], [22, 38, 44],
];

// Body: a cylinder, not a box. The topline lifts 1 px over the shoulders,
// dips through the middle and lifts again over the rump; the rear corner is
// rounded off; the chest is 1 px deeper than the belly, which tucks up toward
// the hind legs. drawPart's botDark then lays a dark band along the bottom
// third, which is what turns the sausage from a slab into a cylinder.
const BODY = [
  [20, 19, 25], [20, 35, 43],                       // shoulder crest, rump crest
  [21, 18, 44],                                     // topline, dipped between them
  [22, 17, 45], [23, 16, 46],
  [24, 15, 46], [25, 15, 46], [26, 15, 46], [27, 15, 46], [28, 15, 46],
  [29, 15, 46], [30, 15, 46],
  [31, 15, 45], [32, 15, 44], [33, 15, 42],         // rounded rump
  [34, 16, 30],                                     // deep chest, belly tucked up
];

// Neck/chest column. Fully hidden behind head + ears in the base pose; it is
// what a raised head uncovers, so it is shaded and outlined like real fur
// rather than left as flat filler.
const NECK = S({
  17: [14, 19], 18: [13, 20], 19: [12, 20], 20: [12, 20], 21: [11, 20],
  22: [11, 20], 23: [11, 20], 24: [11, 20], 25: [11, 20], 26: [11, 20],
  27: [10, 20], 28: [10, 20], 29: [10, 20], 30: [12, 20], 31: [14, 20], 32: [15, 20],
});

const LEG_FN = S({
  33: [17, 21], 34: [17, 21], 35: [17, 21], 36: [17, 21], 37: [17, 21],
  38: [16, 22], 39: [16, 22],
});
const LEG_FF = S({
  34: [23, 26], 35: [23, 26], 36: [23, 26], 37: [23, 26], 38: [23, 27], 39: [23, 27],
});
const LEG_RN = S({
  29: [34, 40], 30: [33, 40], 31: [33, 40], 32: [33, 40], 33: [33, 40],
  34: [33, 39], 35: [33, 39], 36: [33, 39], 37: [33, 39], 38: [32, 40], 39: [32, 40],
});
const LEG_RF = S({
  34: [41, 44], 35: [41, 44], 36: [41, 44], 37: [41, 44], 38: [41, 45], 39: [41, 45],
});
/**
 * A stepping leg: swung forward by dx and shortened by `cut` rows so the paw
 * clears the ground. Shortening reads better than lifting at this scale --
 * a lifted leg just disappears behind the belly.
 */
const step = (spans, dx = -3, cut = 2) => {
  const bottom = Math.max(...spans.map(([y]) => y));
  const nb = bottom - cut;
  return spans.filter(([y]) => y <= nb)
    .map(([y, a, b]) => (y === nb ? [y, a + dx - 1, b + dx + 1] : [y, a + dx, b + dx]));
};

const HEAD = S({
  8: [8, 15], 9: [6, 17], 10: [5, 18], 11: [4, 18], 12: [4, 18],
  13: [4, 18], 14: [3, 18], 15: [2, 18], 16: [1, 18], 17: [1, 18],
  18: [1, 18], 19: [2, 17], 20: [4, 17], 21: [6, 16], 22: [9, 14],
});

// Near ear: long, tapering slightly toward the bottom, ending in a fringed
// hem — three 1-px notches and two hair strands that hang a row further. The
// 1-px tips are outline-coloured (a tooth that small has no interior at this
// scale) with the cream hem immediately above, which is what backlit long hair
// looks like. earFeather() then runs two light streaks down its length.
const EAR_HEM = [
  [28, 9, 11], [28, 13, 14],   // two teeth with a notch between them
  [29, 10, 11], [30, 11, 11],  // the long strand
];
const EAR_NEAR = [
  ...S({
    14: [13, 15], 15: [12, 15], 16: [11, 15], 17: [11, 15], 18: [10, 15],
    19: [10, 15], 20: [10, 15], 21: [10, 15], 22: [9, 15], 23: [9, 15],
    24: [9, 15], 25: [9, 14], 26: [9, 14], 27: [9, 14],
  }),
  ...EAR_HEM,
];
const EAR_FAR = [
  ...S({
    13: [18, 20], 14: [18, 21], 15: [18, 22], 16: [18, 22], 17: [18, 22],
    18: [17, 23], 19: [17, 23], 20: [17, 23], 21: [17, 23], 22: [17, 23],
    23: [17, 23], 24: [17, 23], 25: [18, 23], 26: [18, 22],
  }),
  [27, 19, 21],
];
// follow-through: identical flap with the fringe hanging 1 px lower
const EAR_NEAR_LAG = [...EAR_NEAR, [29, 13, 13], [31, 11, 11]];
// flicked back (ear_flop): narrower, tucked in toward the neck
const EAR_NEAR_BACK = [
  ...S({
    14: [13, 15], 15: [12, 15], 16: [12, 15], 17: [12, 15], 18: [11, 15],
    19: [11, 15], 20: [11, 15], 21: [11, 15], 22: [11, 15], 23: [11, 15],
    24: [10, 15], 25: [10, 15], 26: [10, 14], 27: [10, 14],
  }),
  [28, 10, 12], [28, 14, 14], [29, 11, 12],
];
// perked: short, flared outward and up — the alert silhouette
const EAR_NEAR_PERK = [
  ...S({
    14: [11, 15], 15: [9, 15], 16: [8, 15], 17: [8, 15], 18: [7, 15],
    19: [7, 14], 20: [8, 14], 21: [8, 13], 22: [9, 12],
  }),
  [23, 9, 9], [23, 11, 11],
];
const EAR_FAR_PERK = S({
  13: [18, 20], 14: [18, 22], 15: [18, 23], 16: [18, 23], 17: [18, 23],
  18: [17, 23], 19: [17, 23], 20: [17, 22], 21: [18, 22], 22: [18, 21], 23: [19, 21],
});

/* ==========================================================  head detail */

// Eye = a 2x2 block of 'e' with the specular 'w' in the upper-left, plus one
// darker brow pixel above and slightly inward. side = -1 for the eye nearer
// the snout, +1 for the far one; the brow leans toward the middle of the skull.
const NEAR_EYE = [6, 11, -1], FAR_EYE = [12, 11, +1];

const FACES = {
  neutral: (g, dx, dy, k) => {
    eyes(g, dx, dy, k, 'open');
    mouth(g, dx, dy, k, 'shut');       // closed: a dark line, never any pink
  },
  blink: (g, dx, dy, k) => {
    eyes(g, dx, dy, k, 'shut');
    mouth(g, dx, dy, k, 'shut');
  },
  happy: (g, dx, dy, k) => {
    eyes(g, dx, dy, k, 'open', 'raised');
    mouth(g, dx, dy, k, 'grin');
  },
  blissful: (g, dx, dy, k) => {   // eyes squeezed shut — `pet`
    eyes(g, dx, dy, k, 'arch');
    mouth(g, dx, dy, k, 'grin');
  },
  worried: (g, dx, dy, k) => {
    eyes(g, dx, dy, k, 'open', 'worry');
    mouth(g, dx, dy, k, 'frown');
  },
  exhausted: (g, dx, dy, k) => {
    eyes(g, dx, dy, k, 'half');
    mouth(g, dx, dy, k, 'pant');
  },
  bark: (g, dx, dy, k) => {
    eyes(g, dx, dy, k, 'open');
    mouth(g, dx, dy, k, 'bark');
  },
  alert: (g, dx, dy, k) => {
    eye(g, [6, 10, -1], dx, dy, k, 'open');
    eye(g, [12, 10, +1], dx, dy, k, 'open');
    mouth(g, dx, dy, k, 'smile');
  },
  curious: (g, dx, dy, k) => {
    eye(g, NEAR_EYE, dx, dy, k, 'open');
    eye(g, FAR_EYE, dx, dy, k, 'open', 'worry');
    mouth(g, dx, dy, k, 'dot');
  },
  dead: (g, dx, dy, k) => {
    eyes(g, dx, dy, k, 'cross');
    mouth(g, dx, dy, k, 'pant');
  },
};

// rows are stamped at (x + dx, y + dy + dy0); brow:false = the art is its own brow
const EYE_ART = {
  open:  { rows: ['we', 'ee'], dx: 0, dy: 1 },
  shut:  { rows: ['oo', 'l.'], dx: 0, dy: 1 },
  half:  { rows: ['oo', 'ee'], dx: 0, dy: 1 },
  arch:  { rows: ['.o.', 'o.o'], dx: -1, dy: 1, brow: false },
  cross: { rows: ['o.o', '.o.', 'o.o'], dx: -1, dy: 0, brow: false },
};
// worried brows angle inward-up: the end nearer the middle of the skull is high
const BROW_ART = { '-1': ['.o', 'o.'], '1': ['o.', '.o'] };

function eye(g, [x, y, side], dx, dy, k, kind, brow) {
  const art = EYE_ART[kind];
  const sx = x + dx + shearDx(y, 22, k);
  stamp(g, sx + art.dx, y + dy + art.dy, art.rows);
  if (art.brow === false) return;
  if (brow === 'worry') stamp(g, sx, y + dy - 1, BROW_ART[String(side)]);
  else stamp(g, sx + (side < 0 ? 1 : 0), y + dy - (brow === 'raised' ? 1 : 0), ['o']);
}
const eyes = (g, dx, dy, k, kind, brow) => {
  eye(g, NEAR_EYE, dx, dy, k, kind, brow);
  eye(g, FAR_EYE, dx, dy, k, kind, brow);
};

// Pink appears in exactly three mouths: grin (a hint), pant (hanging) and the
// collapsed 'out' pose. Every closed mouth is dark ink only.
const MOUTH_ART = {
  shut:  [[5, 20, ['kk']]],
  smile: [[5, 20, ['kk']], [7, 19, ['k']]],
  frown: [[5, 19, ['k']], [6, 20, ['kk']]],
  dot:   [[6, 20, ['k']]],
  grin:  [[5, 19, ['kkk']], [6, 20, ['pp']]],
  pant:  [[5, 19, ['kkk']], [5, 20, ['kpk']], [6, 21, ['ppp']], [7, 22, ['pp']]],
  bark:  [[5, 19, ['kkk']], [5, 20, ['kkk']], [6, 21, ['kk']]],
};
function mouth(g, dx, dy, k, kind) {
  for (const [x, y, rows] of MOUTH_ART[kind]) {
    stamp(g, x + dx + shearDx(y, 22, k), y + dy, rows);
  }
}

/** Cream muzzle, nose, tan points on muzzle/eyebrow pips — moves with the head. */
function headDetail(g, dx, dy, k) {
  const t = (spans, ch) => tint(g, shear(mv(spans, dx, dy), 22 + dy, k), ch);
  t(S({ 16: [5, 8], 17: [5, 8], 18: [5, 8] }), 'l');
  t(S({ 19: [3, 8], 20: [5, 8] }), 'a');
  t(S({ 10: [6, 8] }), 'a');    // eyebrow pips: tan on black-and-tan, cream elsewhere
  t(S({ 10: [11, 13] }), 'a');
  stamp(g, 2 + dx + shearDx(16, 22, k), 16 + dy, ['nn', 'nn']);   // nose on the snout tip
}

/* ==========================================================  stand build */

function stand(o = {}) {
  const c = {
    dyBody: 0, dxHead: 0, dyHead: null, dyEar: null, tiltK: 0,
    tail: TAIL, head: HEAD, earNear: EAR_NEAR, earFar: EAR_FAR,
    legFN: LEG_FN, legFF: LEG_FF, legRN: LEG_RN, legRF: LEG_RF,
    face: 'neutral', ruff: true, after: null, ...o,
  };
  const dyH = c.dyHead ?? c.dyBody;
  const dyE = c.dyEar ?? dyH;
  const k = c.tiltK;
  const g = blank();

  drawPlume(g, mv(c.tail, 0, c.dyBody));
  drawPart(g, c.legFF, { flat: 'd' });
  drawPart(g, c.legRF, { flat: 'd' });
  // botDark 4 lays the shadow band along the bottom third of the barrel
  drawPart(g, mv(BODY, 0, c.dyBody), { topLight: 2, midLight: 4, botDark: 4 });
  drawPart(g, mv(NECK, 0, c.dyBody), { topLight: 3, midLight: 5, botDark: 0, sides: { left: true } });
  drawPart(g, c.legRN, { topLight: 1, midLight: 2 });
  drawPart(g, c.legFN, { topLight: 1, midLight: 2 });
  drawPart(g, shear(mv(c.head, c.dxHead, dyH), 22 + dyH, k), { topLight: 2, midLight: 3, botDark: 1 });
  const earFarT = shear(mv(c.earFar, c.dxHead, dyE), 22 + dyE, c.tiltEarK ?? k);
  const earNearT = shear(mv(c.earNear, c.dxHead, dyE), 22 + dyE, c.tiltEarK ?? k);
  drawPart(g, earFarT, { invert: true, topLight: 1, midLight: 2, botDark: 0 });
  drawPart(g, earNearT, { invert: true, topLight: 2, midLight: 3, botDark: 0 });

  // Depth: far ear a full tone darker, near ear mid-tone against the cream
  // face. Derived from the ear spans in use, so perked/tilted ears tone right.
  darken(g, earFarT, 1);
  earFeather(g, earNearT);      // two silky streaks; the far ear stays plain

  headDetail(g, c.dxHead, dyH, k);

  if (c.ruff) {
    // Cream chest and bib: golden long-hairs carry a paler apron under the
    // neck. Bigger than a ruff, and it is 'a', so it turns tan on the
    // tan-pointed coats — which is exactly where a tan point belongs.
    tint(g, mv(S({ 25: [15, 17], 26: [15, 17], 27: [15, 20], 28: [15, 20], 29: [15, 20], 30: [15, 20], 31: [15, 19], 32: [15, 18], 33: [16, 18] }), 0, c.dyBody), 'h');
    tint(g, mv(S({ 26: [15, 16], 27: [15, 18], 28: [15, 19], 29: [15, 19], 30: [15, 19], 31: [15, 18], 32: [16, 17] }), 0, c.dyBody), 'a');
  }
  // paw tan points + a toe split, keyed to whichever leg spans this frame uses
  legFeather(g, c.legFN); legFeather(g, c.legRN);
  pawPoints(g, c.legFN); pawPoints(g, c.legRN);
  toeSplit(g, c.legFN); toeSplit(g, c.legRN);
  // belly fringe: ragged cream along the underline between the legs
  // clumped, not alternating: an even 1-2-1-2 comb reads as gear teeth
  bellyFeather(g, [[16, 1], [22, 1], [23, 2], [24, 2], [25, 1], [26, 2],
                   [27, 1], [28, 1], [29, 2], [30, 2], [31, 1], [32, 1]],
               31 + c.dyBody, 34 + c.dyBody);

  FACES[c.face](g, c.dxHead, dyH, k);
  if (c.after) c.after(g);
  return g;
}

/** Light the top two rows of a near leg's paw. */
function pawPoints(g, legSpans) {
  const rows = legSpans.map(([y]) => y);
  const bottom = Math.max(...rows);
  for (const [y, x0, x1] of legSpans) {
    if (y !== bottom && y !== bottom - 1 && y !== bottom - 2) continue;
    for (let x = x0; x <= x1; x++) {
      if (y < 0 || y >= g.length || x < 0 || x >= g[0].length) continue;
      if (g[y][x] === '.' || g[y][x] === 'o') continue;
      g[y][x] = 'a';
    }
  }
}

/* ==========================================================     frames   */

const F = {};   // name -> { box, rows }
const put = (name, box, g, extra) => { F[name] = { box, rows: toRows(g), ...(extra || {}) }; };

// ---- idle (neutral). 1-px bob; ears overshoot the body by 1 px (DS lag).
put('idle_0', 'stand', stand({}));
put('idle_1', 'stand', stand({ dyBody: 1, earNear: EAR_NEAR_LAG }));
put('idle_neutral_0', 'stand', stand({}));
put('idle_neutral_1', 'stand', stand({ dyBody: 1, earNear: EAR_NEAR_LAG }));

// ---- blink: single frame, dropped between idle frames
put('blink_0', 'stand', stand({ face: 'blink' }));

// ---- happy: same bob, wagging tail, grin + arched eyes
put('idle_happy_0', 'stand', stand({ face: 'happy', tail: TAIL_WAG }));
put('idle_happy_1', 'stand', stand({ face: 'happy', tail: TAIL, dyBody: 1, earNear: EAR_NEAR_LAG }));

// ---- worried: low tail, ears drooped a further 1 px, angled brows, one bead
// of sweat. The bead + the extra droop are what pull it clear of neutral.
const worryBead = (g) => stamp(g, 20, 9, ['.s.', 'sbs']);
put('idle_worried_0', 'stand', stand({ face: 'worried', tail: TAIL_LOW, dyEar: 2, after: worryBead }));
put('idle_worried_1', 'stand', stand({ face: 'worried', tail: TAIL_LOW, dyBody: 1, dyEar: 3, after: worryBead }));

// ---- exhausted: head down, ears drooped, panting, sweat bead
const sweatBead = (g) => stamp(g, 19, 8, ['.s.', 'sbs', '.s.']);
put('idle_exhausted_0', 'stand', stand({ face: 'exhausted', tail: TAIL_LOW, dyHead: 1, dyEar: 2, after: sweatBead }));
put('idle_exhausted_1', 'stand', stand({ face: 'exhausted', tail: TAIL_LOW, dyBody: 1, dyHead: 2, dyEar: 3, after: sweatBead }));

// ---- ear_flop: flick back, then settle
put('ear_flop_0', 'stand', stand({ earNear: EAR_NEAR_BACK, dyEar: -1 }));
put('ear_flop_1', 'stand', stand({}));

// ---- tail_wag
put('tail_wag_0', 'stand', stand({ tail: TAIL_WAG }));
put('tail_wag_1', 'stand', stand({ tail: TAIL }));

// ---- perk: ears up, head raised — "Claude is done"
put('perk_0', 'stand', stand({ face: 'alert', earNear: EAR_NEAR_PERK, earFar: EAR_FAR_PERK, dyHead: -1, tail: TAIL_WAG }));
put('perk_1', 'stand', stand({ face: 'alert', earNear: EAR_NEAR_PERK, earFar: EAR_FAR_PERK, dyHead: -2, tail: TAIL_WAG }));

// ---- tilt: head cocked, one ear up — "waiting for you"
// Head cocked; the ears swing further than the skull (follow-through), which
// reads as a tilt without the perked shape eating the muzzle.
const TILT = { tiltK: 0.22, tiltEarK: 0.36, face: 'curious' };
put('tilt_0', 'stand', stand({ ...TILT, dyHead: -1 }));
put('tilt_1', 'stand', stand({ ...TILT, dyHead: -1, dyBody: 1, dyEar: 0 }));

// ---- confused: same cock of the head, puzzled face ("?" drawn separately)
put('confused_0', 'stand', stand({ ...TILT, face: 'curious', dyHead: -1, tail: TAIL_LOW }));
put('confused_1', 'stand', stand({ ...TILT, face: 'curious', dyHead: 0, tail: TAIL_LOW, tiltK: 0.3 }));

// ---- bark: forward lean, mouth open
put('bark_0', 'stand', stand({ face: 'bark', dxHead: -1, tail: TAIL_WAG }));
put('bark_1', 'stand', stand({ face: 'bark', dxHead: -2, dyHead: -1, dyEar: 0, tail: TAIL_WAG }));

// ---- pet: eyes shut happy, head pushed up into the hand
put('pet_0', 'stand', stand({ face: 'blissful', dyHead: 0, dyEar: 0, tail: TAIL_WAG }));
put('pet_1', 'stand', stand({ face: 'blissful', dyHead: -2, dyEar: -1, tail: TAIL }));
put('pet_2', 'stand', stand({ face: 'blissful', dyHead: -1, dyEar: 0, tail: TAIL_WAG }));

// ---- hop (happy burst): squash, airborne + stretch, squash on landing
const airborne = { dyBody: -3, dyHead: -3, dyEar: -2, tail: TAIL_WAG, face: 'happy' };
put('hop_0', 'stand', stand({ dyBody: 1, dyHead: 2, dyEar: 2, face: 'happy', tail: TAIL_WAG }));
put('hop_1', 'stand', stand({
  ...airborne,
  legFN: step(mv(LEG_FN, -1, -3), 0, 1), legFF: step(mv(LEG_FF, -1, -3), 0, 1),
  legRN: step(mv(LEG_RN, 1, -3), 0, 1), legRF: step(mv(LEG_RF, 1, -3), 0, 1),
}), { airborne: true });
put('hop_2', 'stand', stand({ dyBody: 1, dyHead: 2, dyEar: 3, face: 'happy', tail: TAIL }));

// ---- walk: 4-frame DS trot, diagonal pairs, 1-px body bob, ears bouncing
// Diagonal pairs: frames 0/2 swing one pair forward (shortened, off the
// ground) while the other pair pushes back; frames 1/3 are the contact beats,
// all four down with a 1-px body dip.
put('walk_0', 'stand', stand({
  legFN: step(LEG_FN, -3), legFF: mv(LEG_FF, 2), legRN: mv(LEG_RN, 1), legRF: step(LEG_RF, -2),
  dyEar: 1, tail: TAIL_WAG,
}));
put('walk_1', 'stand', stand({
  dyBody: 1, dyEar: 2,
  legFN: mv(LEG_FN, -2), legFF: mv(LEG_FF, 1), legRN: mv(LEG_RN, 1), legRF: mv(LEG_RF, -1),
  tail: TAIL,
}));
put('walk_2', 'stand', stand({
  legFN: mv(LEG_FN, 2), legFF: step(LEG_FF, -3), legRN: step(LEG_RN, -2), legRF: mv(LEG_RF, 1),
  dyEar: 1, tail: TAIL_WAG,
}));
put('walk_3', 'stand', stand({
  dyBody: 1, dyEar: 2,
  legFN: mv(LEG_FN, 1), legFF: mv(LEG_FF, -2), legRN: mv(LEG_RN, -1), legRF: mv(LEG_RF, 1),
  tail: TAIL,
}));

/* ----------------------------------------------  out: collapsed, flat  */
// Own silhouette (not derived from the standing pose): belly on the floor,
// chin on the floor, legs splayed, X eyes.

// The plume lies flat behind him, still feathered along its lower edge.
const OUT_TAIL = [
  [29, 38, 44], [30, 39, 46], [31, 40, 47], [32, 41, 47], [33, 42, 46],
];
const OUT_BODY = S({
  29: [19, 38], 30: [16, 41], 31: [14, 43], 32: [13, 44], 33: [12, 45],
  34: [12, 45], 35: [12, 45], 36: [12, 45], 37: [13, 45], 38: [14, 44], 39: [15, 43],
});
const OUT_HEAD = S({
  25: [7, 14], 26: [5, 16], 27: [4, 17], 28: [3, 17], 29: [2, 17],
  30: [2, 17], 31: [2, 16], 32: [3, 15], 33: [5, 13],
});
const OUT_SNOUT = S({ 27: [1, 8], 28: [0, 8], 29: [0, 8], 30: [0, 9], 31: [1, 9] });
const OUT_EAR_N = [
  ...S({
    28: [9, 13], 29: [8, 14], 30: [7, 14], 31: [6, 14], 32: [5, 14],
    33: [5, 13], 34: [5, 13], 35: [6, 12],
  }),
  [36, 6, 8], [36, 10, 11], [37, 7, 7],   // fringed hem
];
const OUT_EAR_F = S({
  27: [15, 19], 28: [15, 20], 29: [15, 21], 30: [15, 21], 31: [15, 21],
  32: [16, 21], 33: [16, 20], 34: [17, 19],
});
const OUT_PAW_F = S({ 36: [16, 21], 37: [15, 22], 38: [15, 22], 39: [15, 22] });
const OUT_PAW_R = S({ 36: [35, 41], 37: [34, 42], 38: [34, 42], 39: [34, 42] });

function outPose(rise) {
  const g = blank();
  drawPart(g, mv(OUT_BODY, 0, rise), { topLight: 2, midLight: 4, botDark: 3 });
  drawPlume(g, OUT_TAIL);   // flopped back across the rump; stays put as he breathes
  drawPart(g, OUT_PAW_F, { invert: true, topLight: 2, midLight: 2, botDark: 0 });
  drawPart(g, OUT_PAW_R, { invert: true, topLight: 2, midLight: 2, botDark: 0 });
  drawPart(g, [...OUT_HEAD, ...OUT_SNOUT], { topLight: 2, midLight: 3, botDark: 1 });
  drawPart(g, OUT_EAR_F, { invert: true, topLight: 1, midLight: 2, botDark: 0 });
  drawPart(g, OUT_EAR_N, { invert: true, topLight: 2, midLight: 3, botDark: 0 });
  tint(g, OUT_EAR_F, 'd');
  earFeather(g, OUT_EAR_N);
  tint(g, S({ 28: [4, 8], 29: [4, 8], 30: [4, 9] }), 'l');
  tint(g, S({ 31: [4, 9] }), 'a');
  tint(g, S({ 38: [16, 21] }), 't');    // paw pads
  tint(g, S({ 38: [35, 41] }), 't');
  stamp(g, 1, 28, ['.nnn', 'nnnn', '.nnn']);            // nose flat on the floor
  stamp(g, 5, 27, ['o.o', '.o.', 'o.o']);               // X eye; the far one is
  stamp(g, 11, 27, ['oo']);                             // behind the flopped ear
  stamp(g, 5, 31, ['kkk']);                             // slack mouth
  stamp(g, 6, 32, ['pp']);                              // tongue
  return g;
}
put('out_0', 'stand', outPose(0));
put('out_1', 'stand', outPose(-1));

/* ----------------------------------------  sleep + wake (32x24 box)  */
// The "tiny" fullscreen sprite: 32 px wide at 1x. Curled on the bottom row.
// Read order left to right: nose, closed eye, draped ear, arched back, tail
// plume lying over the rump, front paws tucked under the chest.

const CURL_BODY = S({
   6: [17, 24],  7: [14, 27],  8: [11, 29],  9: [9, 30], 10: [7, 30],
  11: [6, 30], 12: [5, 30], 13: [4, 30], 14: [3, 30], 15: [3, 30],
  16: [3, 30], 17: [2, 30], 18: [2, 30], 19: [2, 29], 20: [3, 29],
  21: [3, 28], 22: [4, 27], 23: [6, 25],
});
// inhale: the chest/back lifts 1 px
const CURL_RISE = [[5, 18, 23], [6, 15, 26], [7, 12, 28], [8, 10, 30]];

const CURL_HEAD = S({
  11: [5, 12], 12: [3, 13], 13: [2, 13], 14: [1, 13], 15: [1, 13],
  16: [1, 13], 17: [2, 13], 18: [3, 12], 19: [5, 11],
});
const CURL_EAR = [
  ...S({
    12: [9, 13], 13: [8, 14], 14: [8, 14], 15: [7, 14], 16: [7, 14],
    17: [7, 14], 18: [7, 13], 19: [8, 13], 20: [8, 12],
  }),
  [21, 8, 9], [21, 11, 11],   // fringed hem
];
// the plume curled over the rump, ragged along its lower edge
const CURL_TAIL = [
  [11, 26, 30], [12, 25, 30], [13, 26, 30], [14, 24, 30], [15, 25, 30],
  [16, 24, 30], [17, 25, 30], [18, 26, 30], [19, 27, 30],
];
const CURL_PAWS = S({ 20: [14, 19], 21: [13, 20], 22: [13, 20], 23: [13, 20] });

function sleepPose(inhale) {
  const g = blank(ZW, ZH);
  drawPart(g, inhale ? [...CURL_BODY, ...CURL_RISE] : CURL_BODY, { topLight: 2, midLight: 5, botDark: 3 });
  drawPlume(g, mv(CURL_TAIL, 0, inhale ? -1 : 0));
  drawPart(g, CURL_PAWS, { invert: true, topLight: 2, midLight: 2, botDark: 0 });
  drawPart(g, CURL_HEAD, { topLight: 2, midLight: 3, botDark: 1 });
  drawPart(g, CURL_EAR, { invert: true, topLight: 2, midLight: 3, botDark: 0 });
  earFeather(g, CURL_EAR);
  tint(g, CURL_PAWS, 'a');
  tint(g, S({ 14: [4, 8], 15: [4, 8], 16: [4, 8] }), 'l');
  tint(g, S({ 17: [3, 8] }), 'a');
  stamp(g, 1, 14, ['.nn', 'nnn', '.nn']);       // nose, resting on the floor
  stamp(g, 5, 12, ['lll', 'ooo']);              // closed eye
  return g;
}
put('sleep_0', 'sleep', sleepPose(false));
put('sleep_1', 'sleep', sleepPose(true));

// wake_0: head lifted off the curl, eyes open, ear still hanging
const WAKE_HEAD = S({
   5: [5, 12],  6: [3, 13],  7: [2, 13],  8: [1, 13],  9: [1, 13],
  10: [1, 13], 11: [2, 13], 12: [3, 12], 13: [5, 11],
});
const WAKE_EAR = [
  ...S({
     6: [9, 13],  7: [8, 14],  8: [8, 14],  9: [7, 14], 10: [7, 14],
    11: [7, 14], 12: [7, 13], 13: [8, 13], 14: [8, 12],
  }),
  [15, 8, 9], [15, 11, 11],
];
const WAKE_NECK = S({
  10: [8, 14], 11: [8, 14], 12: [8, 14], 13: [8, 14], 14: [8, 14], 15: [8, 14],
});
function wake0() {
  const g = blank(ZW, ZH);
  drawPart(g, CURL_BODY, { topLight: 2, midLight: 5, botDark: 3 });
  drawPlume(g, CURL_TAIL);
  drawPart(g, CURL_PAWS, { invert: true, topLight: 2, midLight: 2, botDark: 0 });
  drawPart(g, WAKE_NECK, { topLight: 3, midLight: 4, botDark: 0, sides: { left: true } });
  drawPart(g, WAKE_HEAD, { topLight: 2, midLight: 3, botDark: 1 });
  drawPart(g, WAKE_EAR, { invert: true, topLight: 2, midLight: 3, botDark: 0 });
  earFeather(g, WAKE_EAR);
  tint(g, CURL_PAWS, 'a');
  tint(g, S({ 8: [4, 8], 9: [4, 8], 10: [4, 8] }), 'l');
  tint(g, S({ 11: [3, 8] }), 'a');
  stamp(g, 1, 8, ['.nn', 'nnn', '.nn']);
  stamp(g, 5, 6, ['oo.', 'wee', 'eee']);        // awake
  stamp(g, 4, 11, ['..k', 'kk.']);
  return g;
}
put('wake_0', 'sleep', wake0());

// wake_1: the stretch -- rump high, chest on the floor, front paws reaching,
// eyes squeezed shut, yawning. Front half sits on the bottom row.
const STRETCH_REAR = S({
   9: [21, 26], 10: [19, 28], 11: [18, 29], 12: [17, 30], 13: [16, 30],
  14: [16, 30], 15: [16, 30], 16: [16, 30], 17: [17, 29], 18: [17, 29],
  19: [18, 28], 20: [18, 27], 21: [19, 27], 22: [20, 26], 23: [21, 25],
});
const STRETCH_BODY = S({
  13: [14, 18], 14: [12, 18], 15: [11, 19], 16: [10, 19], 17: [9, 20],
  18: [8, 20], 19: [8, 20], 20: [8, 20], 21: [9, 20], 22: [11, 19],
});
const STRETCH_HEAD = S({
  13: [4, 10], 14: [2, 11], 15: [1, 12], 16: [1, 12], 17: [1, 12],
  18: [1, 12], 19: [2, 11], 20: [4, 10],
});
const STRETCH_EAR = [
  ...S({ 15: [7, 11], 16: [6, 12], 17: [6, 12], 18: [6, 12], 19: [6, 11], 20: [7, 11] }),
  [21, 7, 8], [21, 10, 10],
];
const STRETCH_ARMS = S({ 20: [6, 13], 21: [4, 14], 22: [3, 14], 23: [3, 14] });
const STRETCH_TAIL = [
  [3, 25, 29], [4, 24, 29], [5, 25, 29], [6, 23, 29], [7, 24, 29],
  [8, 24, 29], [9, 25, 29], [10, 26, 29], [11, 26, 28],
];
function wake1() {
  const g = blank(ZW, ZH);
  drawPlume(g, STRETCH_TAIL);
  drawPart(g, STRETCH_REAR, { topLight: 2, midLight: 4, botDark: 3 });
  drawPart(g, STRETCH_BODY, { topLight: 2, midLight: 4, botDark: 3 });
  drawPart(g, STRETCH_ARMS, { invert: true, topLight: 2, midLight: 2, botDark: 0 });
  drawPart(g, STRETCH_HEAD, { topLight: 2, midLight: 3, botDark: 1 });
  drawPart(g, STRETCH_EAR, { invert: true, topLight: 2, midLight: 3, botDark: 0 });
  earFeather(g, STRETCH_EAR);
  tint(g, STRETCH_ARMS, 'a');
  tint(g, S({ 16: [3, 6], 17: [3, 6] }), 'l');
  tint(g, S({ 18: [3, 7] }), 'a');
  stamp(g, 1, 16, ['.nn', 'nnn', '.nn']);
  stamp(g, 4, 13, ['.o.', 'o.o']);              // squeezed shut
  stamp(g, 3, 18, ['kkk']);                     // yawn
  stamp(g, 4, 19, ['pp']);
  return g;
}
put('wake_1', 'sleep', wake1());

/* ----------------------------------------------------  decorations  */

put('heart_0', 'heart', [
  '.rr.rr.',
  'rwrrrrr',
  'rrrrrrr',
  '.rrrrr.',
  '..rrr..',
  '...r...',
].map((r) => r.split('')));
put('heart_1', 'heart', [
  '.......',
  '.rr.rr.',
  'rwrrrrr',
  '.rrrrr.',
  '..rrr..',
  '...r...',
].map((r) => r.split('')));

put('qmark', 'qmark', [
  '.sss.',
  'ss.ss',
  '...ss',
  '..ss.',
  '.ss..',
  '.ss..',
  '.....',
  '.ss..',
].map((r) => r.split('')));

put('zz_0', 'zz', [
  '....zzzz',
  '......z.',
  '.....z..',
  '....zzzz',
  '........',
  '.zzz....',
  '..z.....',
  '.zzz....',
].map((r) => r.split('')));
put('zz_1', 'zz', [
  '......z.',
  '.....z..',
  '....zzzz',
  '........',
  '.zzz....',
  '..z.....',
  '.zzz....',
  '........',
].map((r) => r.split('')));

put('sweat', 'sweat', [
  '.s.',
  '.s.',
  'sbs',
  '.s.',
].map((r) => r.split('')));

/* ==========================================================   palettes  */
// Only o/d/m/l/h/a (coat) and n (nose) vary. 'a' = accent: real tan points on
// black-and-tan and chocolate, and the same value as 'l' on the others, so the
// muzzle band / eyebrow pips / chest / feet read correctly in all five.
const SHARED = {
  e: '#3b2416', w: '#ffffff', p: '#e58fa0', r: '#e24a5c', k: '#140d09',
  t: '#c98b3a', s: '#43434c', b: '#fdfdfd', z: '#7fb8e8',
};
const palettes = {
  golden:          { o: '#5a3416', d: '#b8741f', m: '#e2a53a', l: '#f2c96b', h: '#fbe7b0', a: '#f2c96b', n: '#241a16', ...SHARED },
  red:             { o: '#4a1d10', d: '#8f3a18', m: '#b85326', l: '#d4713c', h: '#eda374', a: '#d4713c', n: '#241a16', ...SHARED },
  cream:           { o: '#6b5236', d: '#d3b489', m: '#e8d5b0', l: '#f5e9cf', h: '#fdf8ea', a: '#f5e9cf', n: '#2b201a', ...SHARED },
  'black-and-tan': { o: '#100d0c', d: '#262020', m: '#38312e', l: '#4e443e', h: '#665a52', a: '#c98b3a', n: '#0b0908', ...SHARED },
  chocolate:       { o: '#241610', d: '#46291a', m: '#654027', l: '#855735', h: '#a37348', a: '#c8873f', n: '#1a1210', ...SHARED },
};

/* ========================================================  animations  */

const animations = {
  idle:           { frames: ['idle_0', 'idle_1'], durationsMs: [600, 600], loop: true },
  idle_neutral:   { frames: ['idle_neutral_0', 'idle_neutral_1'], durationsMs: [600, 600], loop: true },
  blink:          { frames: ['blink_0'], durationsMs: [90], loop: false },
  idle_happy:     { frames: ['idle_happy_0', 'idle_happy_1'], durationsMs: [320, 320], loop: true },
  idle_worried:   { frames: ['idle_worried_0', 'idle_worried_1'], durationsMs: [700, 700], loop: true },
  idle_exhausted: { frames: ['idle_exhausted_0', 'idle_exhausted_1'], durationsMs: [480, 480], loop: true },
  out:            { frames: ['out_0', 'out_1'], durationsMs: [900, 900], loop: true },
  confused:       { frames: ['confused_0', 'confused_1'], durationsMs: [700, 700], loop: true },
  ear_flop:       { frames: ['ear_flop_0', 'ear_flop_1'], durationsMs: [120, 180], loop: false },
  tail_wag:       { frames: ['tail_wag_0', 'tail_wag_1'], durationsMs: [140, 140], loop: true },
  walk:           { frames: ['walk_0', 'walk_1', 'walk_2', 'walk_3'], durationsMs: [130, 130, 130, 130], loop: true },
  bark:           { frames: ['bark_0', 'bark_1'], durationsMs: [90, 160], loop: false },
  pet:            { frames: ['pet_0', 'pet_1', 'pet_2'], durationsMs: [220, 300, 220], loop: true },
  perk:           { frames: ['perk_0', 'perk_1'], durationsMs: [140, 420], loop: false },
  tilt:           { frames: ['tilt_0', 'tilt_1'], durationsMs: [260, 900], loop: true },
  hop:            { frames: ['hop_0', 'hop_1', 'hop_2'], durationsMs: [90, 160, 110], loop: false },
  sleep:          { frames: ['sleep_0', 'sleep_1'], durationsMs: [1200, 1200], loop: true },
  wake:           { frames: ['wake_0', 'wake_1'], durationsMs: [260, 380], loop: false },
  heart:          { frames: ['heart_0', 'heart_1'], durationsMs: [300, 300], loop: true },
  zz:             { frames: ['zz_0', 'zz_1'], durationsMs: [700, 700], loop: true },
  qmark:          { frames: ['qmark'], durationsMs: [900], loop: false },
  sweat:          { frames: ['sweat'], durationsMs: [900], loop: false },
};

const expressions = {
  neutral: 'idle_neutral',
  happy: 'idle_happy',
  worried: 'idle_worried',
  exhausted: 'idle_exhausted',
  out: 'out',
  confused: 'confused',
};

/* ============================================================  emit  */

const spec = {
  boxes: { stand: [SW, SH], sleep: [ZW, ZH], heart: [7, 6], qmark: [5, 8], zz: [8, 8], sweat: [3, 4] },
  palettes,
  frames: F,
  animations,
  expressions,
};

// Pretty-print but keep each row array on one line per row for readability.
const json = JSON.stringify(spec, null, 2)
  .replace(/\[\n\s+((?:-?\d+,?\s*)+)\n\s+\]/g, (m, nums) => '[' + nums.replace(/\s+/g, ' ').trim() + ']');
writeFileSync(join(HERE, 'walder.json'), json + '\n');
console.log(`walder.json: ${Object.keys(F).length} frames, ${Object.keys(animations).length} animations, ${Object.keys(palettes).length} palettes`);

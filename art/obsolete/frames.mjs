#!/usr/bin/env node
// art/frames.mjs — regenerates art/walder.json.  Zero dependencies.
//
//   node art/frames.mjs      # rewrites art/walder.json
//   node art/render.mjs      # then renders PNGs + CHECK.txt
//
// HOW THIS FILE IS ORGANISED
//   1. BOXES / PALETTES      — grid sizes and the five coat palettes
//   2. POSE                   — the hand-authored key poses, as literal row
//                               strings.  `POSE.base` is THE master pose (the
//                               64x64 standing 3/4 view); everything in the
//                               idle family is derived from it so the ground
//                               line and the proportions can never drift.
//   3. grid helpers            — patch / shift / bend / outline
//   4. FACES                   — expression patches applied over the master
//   5. derivations             — every remaining frame
//   6. animations              — frame lists, durations, loop/hold flags
//
// REGENERATING OVERWRITES HAND EDITS TO art/walder.json.  Pixel fixes belong
// either here (structural) or in walder.json (one-off, until the next run).

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));

/* ============================ 1. BOXES / PALETTES ======================== */

const BOXES = {
  stand: [64, 64],   // every standing frame; the paws sit on row 63
  sleep: [40, 28],   // sleep_* and wake_* — the small curled sprite
  heart: [7, 6],
  qmark: [5, 8],
  zz:    [8, 8],
  sweat: [3, 4],
};

// Coat ramp letters, light -> dark:  a h l m t d o q
// `a` doubles as the tan point on the tan-pointed coats (see README).
const SHARED = {
  e: '#2D1A0D',  // eye
  w: '#FFFFFF',  // eye specular / bubble fill
  n: '#1F1208',  // nose
  k: '#3E2411',  // deep ink: mouth line, glyph outline
  p: '#FF6188',  // tongue
  r: '#FF6188',  // heart
  z: '#4BA2E1',  // sleepy blue
  y: '#9CD7FF',  // sleepy blue highlight
  s: '#3E2411',  // bubble outline
  b: '#FFFFFF',  // bubble fill
};
const PALETTES = {
  golden:          { a:'#FFF3D6', h:'#FFE3A6', l:'#FFC67D', m:'#E3A454', t:'#C47A30', d:'#A25F21', o:'#7A451A', q:'#5F3415', ...SHARED },
  red:             { a:'#FFEBD6', h:'#F6D3A9', l:'#DE9A62', m:'#C06B34', t:'#9E5228', d:'#7E3F1E', o:'#5C2C16', q:'#431F10', ...SHARED },
  cream:           { a:'#FFFDF4', h:'#FDF0D8', l:'#F8E3C0', m:'#EBCB9F', t:'#D0A87A', d:'#B48B60', o:'#8E6A45', q:'#6E4F32', ...SHARED },
  'black-and-tan': { a:'#D69A4A', h:'#5E5A5B', l:'#4E4A4B', m:'#3C3839', t:'#302D2F', d:'#262425', o:'#1B1A1B', q:'#121112', ...SHARED },
  chocolate:       { a:'#C8873F', h:'#96684A', l:'#7A5138', m:'#61402B', t:'#4E3322', d:'#3E281A', o:'#2E1D14', q:'#22150E', ...SHARED },
};

/* ============================== 2. POSE ================================= */
// Hand-authored key poses. Row strings, one character per pixel, '.' = clear.
const POSE = {
  base: [
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "...............qqqqqqq..........................................",
    ".............qqhhhhhhhqqq.......................................",
    "...........qqhhlllllllhhhqq.....................................",
    ".........qqhhllllllllllllhq.....................................",
    "........qhhlllllllllllllllhqq...................................",
    ".......qhmlllllllllllllllllhhq..................................",
    ".......qmmmllllllllllllmmllllhq.......................qqq.......",
    "......qhlmmllllllllllllmmlllllq......................qhhhq......",
    ".....qhllloolllllllllllmmlllllhq....................qhlhlaq.....",
    ".....qllltllllllllloollmmmllmllhq...................qmlhllhq....",
    "......qlmlweelllllllllmqmlllllllq..................qhllhlllq....",
    ".....qllmleeellllllweelqmlllllllq.................qhlllhlllhq...",
    "...qqllltleeolllllleeelqmllhllllhq................qalllhlllmq...",
    "...qhlllttllllllllleeolqmllhllllmq................qmlllhlllmq...",
    "...qllmmttmllllllllllllqmllhllllmhq...............qmlllhlllmq...",
    "...qllmmmmmllllllllllllmqmlhllhlllq...............qmlllhlllmq...",
    "..qhllmmmmtmmmllllllllmmqmlhllhllq.................qmmlllllmq...",
    "..qllllmmtlllllllllllmmmqmlhllhllmq................qmmlllllmq...",
    ".qhllllmmmlnnnllllllmmmlqmlhllhllmq.................qmmllllmhq..",
    ".qmmlllmmmlnnnlllllmmmmlqmlhllhlmmmqqq..............qmmmlllmmq..",
    ".qtmtllmmmllkkllllmmlllmqmlhllhlmmmhhhqqqq..........qmmmlllllq..",
    ".qqmlllmmmllllkkklmmlllmqmlhllhlmmttllhhhhqqqq......qtmmlllllq..",
    "...qmmmmmmllhlllllllllltqmlhllhlmmttllllllhhhhq......qmmlllllq..",
    "...qmmtmmtmlllllllllllmtqmlhllhlmmtmllllllllllhqq....qmmllllq...",
    "...qtmmmmttmlllllllllmmtqmlhllhltmtllllllllllllhhq...qmlllllq...",
    "...qttttttttlllllllllmmtmqmlhllhlmmlllllllllllllmhqqqtmlllllmq..",
    "....qqtttttllllllllllmmttqmlhllhlmlllllllllllllllmlttmllllllmq..",
    "......qttqmlllllllllllmttqmllhlllmlllllllllllllllmttmmllllllq...",
    ".......qq.qllhhhllllllmmtqmllhllllllllllllllllllllttmllllllq....",
    "..........qlhhahhllllllllmaaaaalllllllllllllllllllmtmllllllmq...",
    ".........qllhaaahllllllllqqaahmlllllllllllllllllllmtmmlllllmq...",
    ".........qmlhaaahllllllllllqllllllllllllllllllllllmttmmmmtqq....",
    ".........qmlhhahhllllllllllllllllllllmmmmmllllllllmttmmmmq......",
    "..........qllhhhllllllllllllllmmllllmmmmmmmlllllllmttmmmmmq.....",
    "...........qllhlllllllllllllllmmmmmmmmmmmmmlllllllmmtmttqq......",
    "...........qmmlllllllllllllllllmmmmmmmmmmmmlllllllmmmtqq........",
    "...........qmmlllllllmmllllllllmmmmmmmmmmmmmllllllmmtq..........",
    "............qqmllllllmmllllllllmmmmmmmttttttllllmmmmmq..........",
    "..............qtmmmmmmtmllllllllmmmmmtttttttmllmmmammq..........",
    "..............qtttmmamtmlllllllltthtqttttttqqhhmmmammq..........",
    "..............qtttttatttlllllllmthqq.qtmmtq..qqttmammq..........",
    "..............qmmtttqqttlllllmtttq...qmhhmq....qtlalmq..........",
    ".............qllmmmq..qlllllmmtqq...qmmaamq.....qlalmq..........",
    ".............qlllmmq..qlllllttq....qtmmmmq.....qllalmq..........",
    "............qllllmq...qllllltqq....qtttttq.....qllllmq..........",
    "............qttmmtq..qmlllllq.......qqqqq......qmmmmq...........",
    "............qdqddq...qttqmmqq..................qqdqq............",
    "............qqqqqq....qqqqq...................qqqq..............",
  ],
  out: [
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "................................................................",
    "...............................qqqq.............................",
    "......................qqqqqqqqqmmmmqqqqqq.......................",
    ".............qqqqqqqqqmmmmtttttmmmmmmmmmmq......................",
    "............qmlllmmtttmmmmmmmttmmmmmmmmmmmqq....................",
    "..........qqmllllmmmmmmmmmmmmtttmmmmmmmmmmmmq...................",
    "..........qmlllllmmmmmmmmmmmmmttmmmmmmmmmmmmmq..................",
    ".........qmmlllllmmmmmmmttmmmmmmmmmmmmmmmmmmmmq.................",
    "........qtmmlllmmmmmmmmmttmmmmmmmmmmmmmmmmmmmmtq................",
    "........qttmmmmmmmmmmmmmtttmmmmmttmmmmmmmmmmmmmmq...............",
    "........qdtmmmmmmmmmmmmmmtttmmmmttmmmmmmmmmmmmmmdqqqqqqqqq......",
    ".......qtdttmmmmmmmmmmmmmttttmmmmttmmmmmmmmmmmmmddtmmmmmmmqq....",
    "......qmmdddtmmmmttttmmmmmtttmmmmmtmmmmmmmmmmmmmddtmmmmlllmmq...",
    "......qmmdddtmmmtddttmmmmmmttmmmmmttmmmttmmmmmmmddtttmmlllmmq...",
    ".....qtttdddmmmmtddttmmmmmmttmmmmttttttttmmmmmmmtttttmmmmmmmtq..",
    "...qqttttdddmmmmmttttmmmmmmttmmmmtddtttddmmmmmttmlltttmmmmmmtq..",
    "..qmmttttddddktmmmttmmmmmmmtttmmmtddttdddtmmmtttmllmtttttttttq..",
    ".qmmmddttdddeetmmmttmmmmmmttttmmttddddddddtttttttmmmtdqqqqqqq...",
    ".qddddddddddddmmmtttmmmmttdddttttdddqqqqqqtttdqqqddddq..........",
    "..qqqqqqqqqdddmmdqdtmmmtttdddttttdqq......qqqq...qqqq...........",
    "...........qqqqqq.qtttttddddddqddq..............................",
    "...................qddtqqqqqqq.qq...............................",
    "....................qqq.........................................",
  ],
  sleepCurl: [
    "........................................",
    "........................................",
    "........................................",
    "........................................",
    "........................................",
    "........................................",
    ".................qqqqqqqqq..............",
    "..........qqqqqqqttmmmmmmmqqq...........",
    "........qqmmmllmmttmmmmmmmmmmqq.........",
    ".......qmmmllllmmmmmmmmmmmmmmmmqq.......",
    ".....qqmmmmllmmmmmmmmmmttmmmmmmmmq......",
    "....qmmmmmmmmmmmmmmmmmmddtmmmmmmmmq.....",
    "...qmmmmmmmmmmmmmmmmmmmddtmmmmmmmmtq....",
    "...qmmmmmmmmmmmmmmmmmmmmttmmmmmmmmmtq...",
    "..qmmmmmmmmmmmmmmmmttmmmttmmmmmmmmmtq...",
    "..qmmmmmmmmmmmmmmmtttmmmtttmmmmmmmmmq...",
    ".qtmmmmmtmmmmmmmmtddtmmmmttmmmmmmmmmtq..",
    ".qmmmmmmtttttmmmmtddtmmmmtttmmmmmmmmtq..",
    "qtmmmmmmtttttmmmmtddtmmmmtttmmmmmmmmttq.",
    "qmmmmmmtddtttmmdddddtmmmmttttttmmmmtttq.",
    ".qmmmmmtddkdtttddeddtttttttttttmmmmtttq.",
    "qmmmmmttddddtttkkdmmmmmmttttmmmmmmmtttq.",
    "qdttmmttdddmmmmmmmllmmmmmmmmmmmmmmtttq..",
    "qqtttttdddmmmmmmmmllmmmmmmmmmmmmmmtttq..",
    "..qqqqqdddmmmmmmmmmmmmmmmmmmmmmmtddtq...",
    ".......qqqdtmmmmmmmmmmmmttttttdqqqqq....",
    "..........qqttmmmttttqqqtttqqqq.........",
    "............qqqqqqqqq...qqq.............",
  ],
  wakeYawn: [
    "........................................",
    "........................................",
    "........................................",
    "........................................",
    "........................................",
    "........................................",
    "................................qq......",
    "..............................qqmmqqq...",
    "..............................qtmmmmmq..",
    "..........qqqq................qqmmmmmmq.",
    "........qqmmmmqq................qmmmmmq.",
    "......qqmmmmmmmmqq..........qqqqttmmmtq.",
    ".....qttmmmmmmmmmmq......qqqmmmmttmmmq..",
    ".....qttmmttkttmmmq.....qmmmmmmmmtddtq..",
    "...qqdtmmmtttttmmmmq...qmmmmmmmmmtdqq...",
    "...qtetmmmmmttmmmmmtq.qmmmmmmmmmmmq.....",
    "...qttttttmmttmmmmmmtqmmmmmmmmmmmmtq....",
    "...qtttkddtdttmmmmmmttmmmmmttmmmmmtq....",
    "...qtttddtdtdtmmmmmtttmmmmttttmmmttq....",
    "....qqqdtttmmttmmtttttmmmtttddtmmttq....",
    ".......qttllmtttttttttmmtttdddqqqttq....",
    "......qmmlllmmttttttttttttdddq...qmq....",
    "......qmmlllmmtmmmmttttttqdddq...qmq....",
    "....qqmttmmmmttmmmmttttqq.qqq....qq.....",
    "..qqmmmtddmmmmmmmttttqq.................",
    "..qmmqqqddmmmmmmttqqq...................",
    "..qqq...qdmmmqqqqq......................",
    "........qqqqq...........................",
  ],
  wakeBow: [
    "........................................",
    "................................qqq.....",
    "..............................qqmmmqq...",
    "..............................qmmmmmmq..",
    "..............................qtmmmmmmq.",
    ".........qqqqq.................qtmmmmmq.",
    "........qmmmmmqq................qtmmmq..",
    ".......qmmmmmmmmq............qqqttmmmmq.",
    "......qtmmmmmmmmmq........qqqmmtttmmmmq.",
    ".....qttmmmmmmmmmmq......qmmmmmmttttttq.",
    "....qtttmmtdettmmmq.....qmmmmmmmmttttq..",
    "....qdtmmmtddttmmmmq...qmmmmmmmmmtdqq...",
    "....qekmmmmmttmmmmmtq.qtmmmmmmmmmmq.....",
    "...qtddmmmmmttmmmmmttqmmmmmmmmmmmmtq....",
    "...qtdddddttttmmmmmtddmmmmmmmmmmmmtq....",
    "...qtdddddtdddmmmmmtddmmmmmtttmmmmtq....",
    "...qdddttddtddmmmmttdtmmmmttttmmmttq....",
    "...qqdtttdtmmttmmtdddtmmmtttddtmmttq....",
    ".....qttttmmmttdddddttmmtttdddqqtttq....",
    "......qmmllllmtdddttttttttdddq..qttq....",
    "......qmmllllmttmmmtttttttdddq...qmq....",
    "......qmmlllmmtmmmmttttttqddq...qmmq....",
    "....qqtttmmmtttmmmmtddtqq.qq....qqq.....",
    "..qqmmtdddtttmmmmttdddq.................",
    ".qtttttqddttmmmmtttdqq..................",
    ".qqqqqq.qtmmmmmttqqq....................",
    "........qtmmtqqqq.......................",
    "........qqqqq...........................",
  ],
};

/* =========================== 3. grid helpers ============================ */

const toGrid = (rows) => rows.map((r) => r.split(''));
const toRows = (g) => g.map((r) => r.join(''));
const clone = (g) => g.map((r) => r.slice());
const at = (g, x, y) => (y < 0 || x < 0 || y >= g.length || x >= g[0].length) ? '.' : g[y][x];
const set = (g, x, y, c) => { if (y >= 0 && x >= 0 && y < g.length && x < g[0].length) g[y][x] = c; };

/** Stamp a patch of row strings. '.' leaves the pixel alone, '_' erases it. */
function patch(g, x0, y0, rows) {
  rows.forEach((r, dy) => {
    for (let dx = 0; dx < r.length; dx++) {
      const c = r[dx];
      if (c === '.') continue;
      set(g, x0 + dx, y0 + dy, c === '_' ? '.' : c);
    }
  });
  return g;
}
/** Move rows [y0..y1] down by dy; rows below y1 stay put (a squash/bob). */
function squash(g, y0, y1, dy) {
  const src = clone(g);
  for (let y = y1; y >= y0; y--) for (let x = 0; x < g[0].length; x++) set(g, x, y, at(src, x, y - dy));
  for (let y = y0; y < y0 + dy; y++) for (let x = 0; x < g[0].length; x++) set(g, x, y, '.');
  return g;
}
/** Move the whole grid by (dx,dy). */
function shift(g, dx, dy) {
  const src = clone(g);
  for (let y = 0; y < g.length; y++) for (let x = 0; x < g[0].length; x++) set(g, x, y, at(src, x - dx, y - dy));
  return g;
}
/** Bend: shift columns x0..x1 vertically, ramping dyMax at x0 down to 0 at x1. */
function bend(g, x0, x1, yTop, yBot, dyMax) {
  const src = clone(g);
  for (let x = x0; x <= x1; x++) {
    const dy = Math.round(dyMax * (x1 - x) / (x1 - x0));
    if (dy === 0) continue;
    for (let y = yBot; y >= yTop; y--) set(g, x, y, (y - dy) >= yTop ? at(src, x, y - dy) : '.');
  }
  return g;
}
/** Swing a hanging/standing appendage from a fixed root: rows near `yRoot`
 *  stay put, rows near `yTip` move the full (dx,dy). Keeps the tail attached
 *  to the rump and the ear attached to the skull. */
function swing(g, x0, x1, yTip, yRoot, dx, dy) {
  const src = clone(g);
  for (let y = yTip; y <= yRoot; y++) {
    const f = (yRoot - y) / (yRoot - yTip);
    const sx = Math.round(dx * f), sy = Math.round(dy * f);
    if (!sx && !sy) continue;
    for (let x = x0; x <= x1; x++) set(g, x, y, '.');
  }
  for (let y = yTip; y <= yRoot; y++) {
    const f = (yRoot - y) / (yRoot - yTip);
    const sx = Math.round(dx * f), sy = Math.round(dy * f);
    for (let x = x0; x <= x1; x++) { const c = at(src, x, y); if (c !== '.') set(g, x + sx, y + sy, c); }
  }
  mend(g, x0 - 2, x1 + 2, yTip - 3, yRoot + 3);
  return g;
}
/** Close the 1 px seams a shear leaves behind: a hole with ink directly above
 *  and below is filled from above (vertically), then the same horizontally. */
function mend(g, x0, x1, y0, y1) {
  for (let pass = 0; pass < 2; pass++) {
    for (let y = Math.max(1, y0); y <= Math.min(g.length - 2, y1); y++)
      for (let x = Math.max(1, x0); x <= Math.min(g[0].length - 2, x1); x++) {
        if (g[y][x] !== '.') continue;
        if (at(g, x, y - 1) !== '.' && at(g, x, y + 1) !== '.') g[y][x] = at(g, x, y - 1);
        else if (at(g, x - 1, y) !== '.' && at(g, x + 1, y) !== '.') g[y][x] = at(g, x - 1, y);
      }
  }
  return g;
}
/** the plume, swung from its root at row 41 */
const tail = (g, dx, dy) => swing(g, 48, 63, 20, 41, dx, dy);
/** the near ear's hem, swung from the skull */
const earSwing = (g, dx, dy) => swing(g, 23, 35, 48, 20, dx, dy);

/** 1 px inner silhouette outline. */
function outline(g, c = 'q') {
  const hit = [];
  for (let y = 0; y < g.length; y++) for (let x = 0; x < g[0].length; x++) {
    if (g[y][x] === '.') continue;
    if (at(g, x - 1, y) === '.' || at(g, x + 1, y) === '.' || at(g, x, y - 1) === '.' || at(g, x, y + 1) === '.') hit.push([x, y]);
  }
  for (const [x, y] of hit) g[y][x] = c;
  return g;
}
/** Drop ink pixels with fewer than 2 ink neighbours (kills shift artefacts). */
function despeckle(g) {
  const src = clone(g);
  for (let y = 0; y < g.length; y++) for (let x = 0; x < g[0].length; x++) {
    if (src[y][x] === '.') continue;
    let n = 0;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) if (at(src, x + dx, y + dy) !== '.') n++;
    if (n < 2) g[y][x] = '.';
  }
  return g;
}
const base = () => toGrid(POSE.base);

/* ============================== 4. FACES ================================ */
// All coordinates are absolute in the master pose.
//   far eye  : rim (9,25)-(13,29), core (10,26)-(12,28)
//   near eye : rim (18,26)-(22,30), core (19,27)-(21,29)
//   nose     : (10,32)-(14,36)      mouth: rows 36-38, cols 12-20

const EYE_OPEN_FAR  = ['.kkk.', 'kweek', 'keeek', 'keetk', '.kkk.'];
const EYE_OPEN_NEAR = ['.kkk.', 'kweek', 'keeek', 'keetk', '.kkk.'];
const EYE_SHUT      = ['mmmmm', 'kmmmk', 'mkkkm', 'mmmmm', 'mmmmm'];
const EYE_HALF      = ['.ddd.', 'kkkkk', 'kweek', 'keetk', '.kkk.'];
const EYE_SQUEEZE   = ['mmmmm', 'mkmkm', 'kmkmk', 'mmmmm', 'mmmmm'];
const EYE_X         = ['kmmmk', 'mkmkm', 'mmkmm', 'mkmkm', 'kmmmk'];

const MOUTH_NEUTRAL = [
  'mlkkkmmmmm',
  'lllkkkkktt',
  'lhllmmkmmm',
];
const MOUTH_GRIN = [
  'mlkkkmmmmm',
  'llkkkkkkkm',
  'lhkpppkkmm',
  'llkppkmmmm',
  'lllkkmmmmm',
];
const MOUTH_FROWN = [
  'mlkkkmmmmm',
  'lllkkmmmmm',
  'lhllkkmmmm',
  'llllkkkmmm',
  'lllmmmkmmm',
];
const MOUTH_PANT = [
  'mlkkkmmmmm',
  'llkkkkkkmm',
  'lhkpppkmmm',
  'llkpppkmmm',
  'lllkppkmmm',
  'llllkkmmmm',
];
const MOUTH_WAVY = [
  'mlkkkmmmmm',
  'lllkkkmmmm',
  'lhllmkmkmm',
  'llllmmkmmm',
  'lllmmmmmmm',
];
const MOUTH_OPEN = [        // bark / yawn
  'mlkkkmmmmm',
  'llkkkkkmmm',
  'lhkkppkkmm',
  'llkppppkmm',
  'llkkppkkmm',
  'lllkkkkmmm',
];

function face(g, opt = {}) {
  const { far = EYE_OPEN_FAR, near = EYE_OPEN_NEAR, mouth = MOUTH_NEUTRAL, brows } = opt;
  patch(g, 9, 25, far);
  patch(g, 18, 26, near);
  patch(g, 10, 36, mouth);
  if (brows === 'up')      { patch(g, 9, 23, ['dddd']); patch(g, 19, 24, ['dddd']); }
  if (brows === 'worried') { patch(g, 9, 24, ['.ddk']); patch(g, 19, 25, ['kdd.']); }
  if (brows === 'droop')   { patch(g, 9, 24, ['kdd.']); patch(g, 19, 25, ['.ddk']); }
  if (brows === 'quiz')    { patch(g, 9, 23, ['dddd']); patch(g, 19, 26, ['kdd.']); }
  return g;
}

/* =========================== 5. derivations ============================= */
const F = {};                                   // name -> {box, rows, ...}
const add = (name, box, g, extra = {}) => { F[name] = { box, rows: toRows(g), ...extra }; };

/* ---- idle: 4-frame breathe. The paws never move: only rows 0..57 squash. */
function breathe(n) {
  const g = base();
  if (n) squash(g, 0, 57, n);
  return g;
}
add('idle_0', 'stand', base());
add('idle_1', 'stand', breathe(1));
{ const g = breathe(1); earSwing(g, 1, 1); despeckle(g); outline(g); add('idle_2', 'stand', g); }
{ const g = base();     earSwing(g, 1, 0); tail(g, -1, 0); despeckle(g); outline(g); add('idle_3', 'stand', g); }
// idle_neutral is the same pose; kept as its own frames because expressions
// address it by name and the app may cross-fade between the two.
add('idle_neutral_0', 'stand', base());
add('idle_neutral_1', 'stand', breathe(1));
{ const g = breathe(1); earSwing(g, 1, 1); despeckle(g); outline(g); add('idle_neutral_2', 'stand', g); }
{ const g = base();     earSwing(g, 1, 0); tail(g, -1, 0); despeckle(g); outline(g); add('idle_neutral_3', 'stand', g); }

/* ---- blink (2) ---- */
{ const g = base(); face(g, { far: EYE_SHUT, near: EYE_SHUT }); add('blink_0', 'stand', g); }
{ const g = base(); face(g, { far: EYE_HALF, near: EYE_HALF }); add('blink_1', 'stand', g); }

/* ---- idle_rare: ear flick + tail lift (4) ---- */
add('idle_rare_0', 'stand', base());
add('idle_rare_1', 'stand', breathe(1));
{ const g = base(); earSwing(g, 3, -2); tail(g, 1, -2);
  despeckle(g); outline(g); patch(g, 37, 20, ['.q.', 'q.q']); add('idle_rare_2', 'stand', g); }
{ const g = breathe(1); earSwing(g, 2, -1); tail(g, 0, -1); despeckle(g); outline(g); add('idle_rare_3', 'stand', g); }
/* ear_flop keeps its two old frame names and aliases the flick */
{ const g = base(); earSwing(g, 3, -2); despeckle(g); outline(g); add('ear_flop_0', 'stand', g); }
add('ear_flop_1', 'stand', base());

/* ---- expressions ---- */
{ const g = base(); face(g, { mouth: MOUTH_GRIN, brows: 'up' });
  tail(g, -1, -3); despeckle(g); outline(g); add('idle_happy_0', 'stand', g); }
{ const g = breathe(1); face(g, { mouth: MOUTH_GRIN, brows: 'up' });
  tail(g, 2, -1); despeckle(g); outline(g); add('idle_happy_1', 'stand', g); }

{ const g = base(); face(g, { mouth: MOUTH_FROWN, brows: 'worried' });
  earSwing(g, -1, 2); tail(g, -2, 6);
  despeckle(g); outline(g); patch(g, 36, 21, ['.z.', 'zyz', 'zzz', '.z.']); add('idle_worried_0', 'stand', g); }
{ const g = breathe(1); face(g, { mouth: MOUTH_FROWN, brows: 'worried' });
  earSwing(g, -1, 2); tail(g, -2, 6);
  despeckle(g); outline(g); patch(g, 36, 23, ['.z.', 'zyz', 'zzz', '.z.']); add('idle_worried_1', 'stand', g); }

{ const g = squash(base(), 0, 57, 1); face(g, { far: EYE_HALF, near: EYE_HALF, mouth: MOUTH_PANT, brows: 'droop' });
  earSwing(g, -1, 2); tail(g, -3, 8);
  despeckle(g); outline(g); patch(g, 36, 23, ['.z.', 'zyz', 'zzz', '.z.']); add('idle_exhausted_0', 'stand', g); }
{ const g = squash(base(), 0, 57, 2); face(g, { far: EYE_HALF, near: EYE_HALF, mouth: MOUTH_PANT, brows: 'droop' });
  earSwing(g, -1, 3); tail(g, -3, 8);
  despeckle(g); outline(g); add('idle_exhausted_1', 'stand', g); }

/* ---- confused: head lowered and cocked, quizzical brows ---- */
{ const g = base(); face(g, { mouth: MOUTH_WAVY, brows: 'quiz' });
  bend(g, 3, 34, 14, 54, 3); earSwing(g, -2, 2);
  despeckle(g); outline(g); add('confused_0', 'stand', g); }
{ const g = base(); face(g, { mouth: MOUTH_WAVY, brows: 'quiz' });
  bend(g, 3, 34, 14, 54, 4); earSwing(g, -3, 2);
  despeckle(g); outline(g); add('confused_1', 'stand', g); }

/* ---- tilt: three steps of the same cock, holds on the last ---- */
[2, 4, 5].forEach((dy, i) => {
  const g = base(); face(g, { brows: 'quiz' });
  bend(g, 3, 34, 14, 54, dy); earSwing(g, -dy, 2);
  despeckle(g); outline(g); add(`tilt_${i}`, 'stand', g);
});

/* ---- perk: head lifts, ears rise, tail up. Holds on the last. ---- */
[0, 1, 2].forEach((n, i) => {
  const g = base(); face(g, { brows: 'up' });
  if (n) { bend(g, 3, 36, 14, 52, -n); earSwing(g, 1, -n - 1); tail(g, 0, -n - 1); }
  despeckle(g); outline(g); add(`perk_${i}`, 'stand', g);
});

/* ---- bark: lean in, mouth open, motion ticks ---- */
{ const g = base(); face(g, { brows: 'up' }); add('bark_0', 'stand', g); }
{ const g = base(); face(g, { mouth: MOUTH_OPEN, brows: 'up' });
  bend(g, 3, 36, 14, 52, -1); despeckle(g); outline(g);
  patch(g, 1, 24, ['q.q', '.q.', 'q.q']); add('bark_1', 'stand', g); }
{ const g = squash(base(), 0, 57, 1); face(g, { mouth: MOUTH_OPEN, brows: 'up' });
  despeckle(g); outline(g); patch(g, 1, 26, ['q.q', '.q.']); add('bark_2', 'stand', g); }
{ const g = base(); face(g, { brows: 'up' }); add('bark_3', 'stand', g); }

/* ---- pet: eyes squeezed shut, head pushes up into the hand (6) ---- */
[0, 1, 2, 2, 1, 0].forEach((n, i) => {
  const g = base();
  face(g, { far: EYE_SQUEEZE, near: EYE_SQUEEZE, mouth: MOUTH_GRIN });
  if (n) { bend(g, 3, 36, 14, 52, -n); earSwing(g, 0, -n); }
  tail(g, i % 2 ? 1 : -1, -1);
  despeckle(g); outline(g); add(`pet_${i}`, 'stand', g);
});

/* ---- walk: 4-beat trot. Diagonal pairs lift; the body dips on contact. ---- */
// leg blocks: [x0, yTop, x1] — swung from the shoulder/hip so the paw stays attached
const LEG_NF = [12, 52, 22];   // near front
const LEG_FF = [23, 52, 31];   // far front
const LEG_FH = [34, 52, 44];   // far hind
const LEG_NH = [45, 51, 55];   // near hind
function walkFrame(steps, dip) {
  const g = base();
  if (dip) squash(g, 0, 57, dip);
  for (const [blk, dx] of steps) swing(g, blk[0], blk[2], 63, blk[1] + dip, dx, 0);
  despeckle(g); outline(g);
  return g;
}
add('walk_0', 'stand', walkFrame([[LEG_NF, -2], [LEG_FH, -2], [LEG_FF, 2], [LEG_NH, 2]], 0));
add('walk_1', 'stand', walkFrame([], 1));
add('walk_2', 'stand', walkFrame([[LEG_NF, 2], [LEG_FH, 2], [LEG_FF, -2], [LEG_NH, -2]], 0));
add('walk_3', 'stand', walkFrame([], 1));

/* ---- tail_wag: only the plume above the rump moves ---- */
[[0, 0], [-3, -1], [0, 0], [3, 1]].forEach(([dx, dy], i) => {
  const g = base();
  if (dx || dy) { tail(g, dx, dy); despeckle(g); outline(g); }
  add(`tail_wag_${i}`, 'stand', g);
});

/* ---- hop: crouch, deeper crouch, airborne, land, stand ---- */
add('hop_0', 'stand', (() => { const g = squash(base(), 0, 57, 2); despeckle(g); outline(g); return g; })());
add('hop_1', 'stand', (() => { const g = squash(base(), 0, 57, 4); despeckle(g); outline(g); return g; })());
add('hop_2', 'stand', (() => {
  const g = base(); face(g, { brows: 'up' });
  tail(g, 1, -3);
  swing(g, LEG_NF[0], LEG_NF[2], 63, LEG_NF[1], -3, 0);    // front legs reach forward
  swing(g, LEG_FF[0], LEG_FF[2], 63, LEG_FF[1], -2, 0);
  swing(g, LEG_NH[0], LEG_NH[2], 63, LEG_NH[1], 2, 0);     // hind legs trail
  swing(g, LEG_FH[0], LEG_FH[2], 63, LEG_FH[1], 2, 0);
  shift(g, 0, -6);
  despeckle(g); outline(g); return g;
})(), { airborne: true });
add('hop_3', 'stand', (() => { const g = squash(base(), 0, 57, 3); despeckle(g); outline(g); return g; })());
add('hop_4', 'stand', base());

/* ---- out: collapsed flat with X eyes (authored pose) ---- */
{
  const g = toGrid(POSE.out);
  patch(g, 9, 50, EYE_X); patch(g, 15, 51, EYE_X);
  patch(g, 9, 56, ['nnn', 'nnn']);        // nose flat on the floor
  patch(g, 13, 58, ['kkkk']);             // slack mouth
  outline(g); add('out_0', 'stand', g);
}
{
  const g = toGrid(POSE.out);
  patch(g, 9, 50, EYE_X); patch(g, 15, 51, EYE_X);
  patch(g, 9, 56, ['nnn', 'nnn']);
  patch(g, 13, 58, ['kkkk']);
  squash(g, 42, 62, 1); outline(g);
  patch(g, 52, 44, ['.yy.', 'yzzy', '.yy.']);   // one puff of breath
  add('out_1', 'stand', g);
}

/* ---- sleep (40x28, authored curl) ---- */
function sleepFace(g) {
  patch(g, 6, 17, ['mmmmmm', 'kmmmmk', 'mkkkkm', 'mmmmmm']);   // far eye, shut
  patch(g, 14, 16, ['mmmmmm', 'kmmmmk', 'mkkkkm', 'mmmmmm']);  // near eye, shut
  patch(g, 10, 21, ['.nn.', 'nnnn', '.nn.']);                  // nose tucked into the plume
  return g;
}
[0, 1, 2].forEach((i) => {
  const g = sleepFace(toGrid(POSE.sleepCurl));
  if (i === 1) { swing(g, 20, 39, 6, 24, 0, -1); despeckle(g); outline(g); }   // chest rise
  if (i === 2) { swing(g, 20, 39, 6, 24, 0, -1); swing(g, 0, 19, 8, 24, 0, 1); despeckle(g); outline(g); }
  add(`sleep_${i}`, 'sleep', g);
});

/* ---- wake: uncurl, stretch, yawn, up on the front legs (40x28) ---- */
add('wake_0', 'sleep', (() => {
  const g = sleepFace(toGrid(POSE.sleepCurl));
  swing(g, 0, 19, 8, 26, 0, -2);                 // head lifts off the paws
  patch(g, 14, 15, ['.kkk.', 'kweek', 'keeek', '.kkk.']);  // the near eye cracks open
  despeckle(g); outline(g); return g;
})());
add('wake_1', 'sleep', toGrid(POSE.wakeYawn));
add('wake_2', 'sleep', toGrid(POSE.wakeBow));
add('wake_3', 'sleep', (() => {           // up on the front legs, about to hand off to idle
  const g = toGrid(POSE.wakeBow);
  swing(g, 0, 20, 1, 26, 0, -1); despeckle(g); outline(g); return g;
})());

/* ---- decorations ---- */
add('heart_0', 'heart', toGrid(['.kk.kk.', 'kwrkrrk', 'krrrrrk', '.krrrk.', '..krk..', '...k...']));
add('heart_1', 'heart', toGrid(['.kk.kk.', 'kwwkrrk', 'kwrrrrk', 'krrrrrk', '.krrk..', '..kk...']));
add('qmark', 'qmark', toGrid(['.mmm.', '.m.m.', '...m.', '..mm.', '..m..', '..m..', '.....', '..m..']));
add('zz_0', 'zz', toGrid(['yzzzz...', '...z....', '..z.....', 'zzzzz...', '........', '.....yzz', '......z.', '.....zzz']));
add('zz_1', 'zz', toGrid(['..yzzz..', '....z...', '...z....', '..zzzz..', '.....yz.', '......z.', '.....zz.', '........']));
add('sweat', 'sweat', toGrid(['.z.', 'zyz', 'zzz', '.z.']));

/* ============================ 6. animations ============================= */
const ms = (n, v) => Array(n).fill(v);
const ANIM = {
  idle:            { frames: ['idle_0', 'idle_1', 'idle_2', 'idle_3'], durationsMs: ms(4, 125), loop: true },
  idle_neutral:    { frames: ['idle_neutral_0', 'idle_neutral_1', 'idle_neutral_2', 'idle_neutral_3'], durationsMs: ms(4, 125), loop: true },
  idle_rare:       { frames: ['idle_rare_0', 'idle_rare_1', 'idle_rare_2', 'idle_rare_3'], durationsMs: ms(4, 100), loop: false },
  blink:           { frames: ['blink_0', 'blink_1'], durationsMs: ms(2, 83), loop: false },
  idle_happy:      { frames: ['idle_happy_0', 'idle_happy_1'], durationsMs: ms(2, 250), loop: true },
  idle_worried:    { frames: ['idle_worried_0', 'idle_worried_1'], durationsMs: ms(2, 700), loop: true },
  idle_exhausted:  { frames: ['idle_exhausted_0', 'idle_exhausted_1'], durationsMs: ms(2, 480), loop: true },
  out:             { frames: ['out_0', 'out_1'], durationsMs: ms(2, 1000), loop: true },
  confused:        { frames: ['confused_0', 'confused_1'], durationsMs: ms(2, 700), loop: true },
  ear_flop:        { frames: ['ear_flop_0', 'ear_flop_1'], durationsMs: [120, 180], loop: false },
  tail_wag:        { frames: ['tail_wag_0', 'tail_wag_1', 'tail_wag_2', 'tail_wag_3'], durationsMs: ms(4, 100), loop: true },
  walk:            { frames: ['walk_0', 'walk_1', 'walk_2', 'walk_3'], durationsMs: ms(4, 125), loop: true },
  bark:            { frames: ['bark_0', 'bark_1', 'bark_2', 'bark_3'], durationsMs: ms(4, 100), loop: false },
  pet:             { frames: ['pet_0', 'pet_1', 'pet_2', 'pet_3', 'pet_4', 'pet_5'], durationsMs: ms(6, 125), loop: false },
  perk:            { frames: ['perk_0', 'perk_1', 'perk_2'], durationsMs: ms(3, 100), loop: false, hold: true },
  tilt:            { frames: ['tilt_0', 'tilt_1', 'tilt_2'], durationsMs: ms(3, 125), loop: false, hold: true },
  hop:             { frames: ['hop_0', 'hop_1', 'hop_2', 'hop_3', 'hop_4'], durationsMs: ms(5, 100), loop: false },
  sleep:           { frames: ['sleep_0', 'sleep_1', 'sleep_2'], durationsMs: ms(3, 1000), loop: true },
  wake:            { frames: ['wake_0', 'wake_1', 'wake_2', 'wake_3'], durationsMs: ms(4, 125), loop: false },
  heart:           { frames: ['heart_0', 'heart_1'], durationsMs: ms(2, 300), loop: true },
  zz:              { frames: ['zz_0', 'zz_1'], durationsMs: ms(2, 700), loop: true },
  qmark:           { frames: ['qmark'], durationsMs: [900], loop: false },
  sweat:           { frames: ['sweat'], durationsMs: [900], loop: false },
};
const EXPRESSIONS = {
  neutral: 'idle_neutral', happy: 'idle_happy', worried: 'idle_worried',
  exhausted: 'idle_exhausted', out: 'out', confused: 'confused',
};

/* ============================== write out =============================== */
const spec = { boxes: BOXES, palettes: PALETTES, frames: F, animations: ANIM, expressions: EXPRESSIONS };
writeFileSync(join(HERE, 'walder.json'), JSON.stringify(spec, null, 1) + '\n');
console.log(`frames.mjs: ${Object.keys(F).length} frames, ${Object.keys(ANIM).length} animations -> art/walder.json`);

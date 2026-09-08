/**
 * `npx tsx scripts/gen-icons.ts` — the application icon, rendered from the art.
 *
 * Walder ships without an app icon, and electron-builder therefore packages the
 * stock Electron atom. Rather than draw a second, separate mascot in an image
 * editor (which would drift the moment the sprite art changed), the icon is
 * *derived* from the sheet: frame `idle_0`, palette `golden` — the master pose,
 * the default coat, the exact dog the owner sees on his desktop. Regenerating it
 * after an art change is one command, and there is no binary to review.
 *
 * ── The crop: head, not whole dog (decided 2026-09-08, hard-coded on purpose) ──
 *
 * `idle_0` is a 64x64 `stand` box whose ink bounding box is cols 1–61, rows 16–63
 * (61 x 48 logical pixels). Two candidates were rendered and *looked at* side by
 * side at 16 px and 32 px before this line was written:
 *
 *  - **Whole dog** (61 x 48). A 32 px icon has ~26 px of content once the macOS
 *    margin is taken, so a 61-pixel-wide dachshund lands at 0.43 target pixels
 *    per sprite pixel. Everything that identifies him — 2 px eyes, the 3 px nose,
 *    the 1 px outline, the hair streaks in the ear — is *below* one pixel and
 *    averages away. The rendered result is a legible long-dog silhouette with a
 *    blank face: recognisable as "an animal", not as Walder. The tail plume also
 *    forces the whole shape into a 61:48 letterbox, which wastes the top and
 *    bottom of a square icon.
 *  - **Head crop, cols 1–34 x rows 16–48** (34 x 33) — **chosen.** 0.76 target
 *    pixels per sprite pixel at 32 px, i.e. ~1.8x the linear detail, and at that
 *    density both eyes, the nose, the mouth line and the long near ear all
 *    survive; the cream chest bib in the bottom-left corner reads as a chest and
 *    makes it a bust rather than a floating head. It is also nearly square
 *    (34 x 33), so it fills an icon canvas instead of letterboxing it.
 *
 * The crop bounds come from the art's own geometry, documented in `art/README.md`
 * and confirmed against the pixels: the head is "about 55 % of the sprite width
 * once the ears are counted" (34/61 = 56 %), the dog is a 3/4 view facing left
 * with the head at the upper-left, and col 24 is the inner outline where the near
 * ear crosses the cheek, so the ear's own silhouette closes by col 33. Below row
 * 34 the body opens out to the right, which is why the right edge of the crop is
 * a straight cut — read as a portrait crop, and judged better than including the
 * shoulder (rendered: 38 x 37 and 36 x 35 both turn the silhouette into a blob).
 * Tighter crops were also rendered (30 x 30, 28 x 28, 26 x 26, 24 x 24): each one
 * slices the skull or the ear tip against the canvas edge, which reads as a
 * mistake rather than a crop, so they lose despite being crisper.
 *
 * **Why this is a constant and not a heuristic.** An "auto-detect the head"
 * routine would re-decide the framing every time the artist touches a pixel, and
 * a Dock icon that silently reframes between builds is worse than one that is
 * wrong in a way somebody can see and fix. If the pose changes, re-run the
 * comparison and edit `HEAD_CROP` — the numbers above say what to look for.
 *
 * ── Scaling ──
 *
 * Integer nearest-neighbour wherever it fits (see `contentScale`): pixel art
 * scaled by 3.58 has some sprite pixels 3 target pixels wide and others 4, which
 * on a 1 px outline reads as a wobble. Every size from 128 px up therefore lands
 * on an exact 3x/6x/12x/24x. Below that the crop is *larger* than the icon and
 * something has to give, so those sizes are area-averaged (`resample`), which is
 * the honest way to lose detail — nearest-neighbour downsampling would drop whole
 * rows of the outline and make the ear flicker between sizes.
 *
 * ── Outputs ──
 *
 * `build/icon.png` (512, also what electron-builder uses on Linux), `icon.icns`
 * via macOS `iconutil`, and `icon.ico` written by hand — the container is 6 + 16n
 * bytes of header around PNG payloads, which is less code than any dependency
 * that would do it. macOS gets ~10 % transparent margin per side (Apple's icon
 * grid leaves room for the shadow); Windows gets ~3 %, because a taskbar icon
 * with a macOS-sized margin looks shrunken next to its neighbours.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpriteSheetError, TRANSPARENT, validateSheet } from '../src/sprites/types';
import type { Palette, SpriteSheet } from '../src/sprites/types';
import { encodePng } from './png';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = join(root, 'build');

/**
 * Sheet candidates, in order. `src/sprites/walder.json` is the copy
 * `scripts/sync-sheet.ts` has already run `validateSheet` over, so it is the one
 * the app actually draws and the one the icon should match. `art/walder.json` is
 * the artist's file and is only reached when the sync has never run — that leaves
 * a `{}` stub behind (see `sync-sheet.ts`), which is a *recoverable* case here:
 * generating the icon is not a good enough reason to make someone run a second
 * command first.
 */
const SHEET_CANDIDATES: readonly string[] = [
  join(root, 'src', 'sprites', 'walder.json'),
  join(root, 'art', 'walder.json')
];

/** The master pose and the default coat. See the header for why these two. */
const FRAME_NAME = 'idle_0';
const PALETTE_NAME = 'golden';

/**
 * The head crop in `stand`-box logical pixels, inclusive of `x`/`y`. Judged once
 * by rendering the alternatives; see the header comment before changing it.
 */
const HEAD_CROP = { x: 1, y: 16, width: 34, height: 33 } as const;

/** Transparent margin per side, as a fraction of the icon's edge. */
const MAC_PAD = 0.1;
const WIN_PAD = 0.03;

/**
 * How much of the available box an integer scale has to fill before it is
 * preferred over the exact fractional one.
 *
 * At 0.8, a 128 px Windows icon takes 3x (fills 84 % of its box, crisp) instead
 * of 3.58x, while a 64 px macOS icon rejects 1x (which would fill only 65 %,
 * leaving a stamp-sized dog in a quarter of the canvas) and accepts 1.53x. The
 * threshold is the one number here that is a taste call rather than arithmetic.
 */
const INTEGER_SCALE_MIN_FILL = 0.8;

/** 512 x 512, per `build/README.txt`, and the source size electron-builder likes. */
const ICON_PNG_SIZE = 512;

/** The `.iconset` contents `iconutil` expects. Names are fixed by macOS. */
const ICONSET_ENTRIES: readonly { readonly name: string; readonly size: number }[] = [
  { name: 'icon_16x16.png', size: 16 },
  { name: 'icon_16x16@2x.png', size: 32 },
  { name: 'icon_32x32.png', size: 32 },
  { name: 'icon_32x32@2x.png', size: 64 },
  { name: 'icon_128x128.png', size: 128 },
  { name: 'icon_128x128@2x.png', size: 256 },
  { name: 'icon_256x256.png', size: 256 },
  { name: 'icon_256x256@2x.png', size: 512 },
  { name: 'icon_512x512.png', size: 512 },
  { name: 'icon_512x512@2x.png', size: 1024 }
];

/**
 * ICO members. 256 is the largest an `ICONDIRENTRY` can describe (its width byte
 * is 0 for 256 and there is no escape for more), and Windows picks per context:
 * 16 in Explorer's details view, 32 on the taskbar, 256 on the desktop.
 */
const ICO_SIZES: readonly number[] = [16, 32, 48, 64, 128, 256];

/** 0 in an `ICONDIRENTRY`'s width/height byte means 256. */
const ICO_DIMENSION_256 = 0;
const ICONDIR_BYTES = 6;
const ICONDIRENTRY_BYTES = 16;

function fail(message: string): never {
  console.error(`\ngen-icons: ${message}\n`);
  process.exit(1);
}

function rel(path: string): string {
  return relative(root, path);
}

/** Straight RGBA pixels plus their dimensions. Origin is top-left. */
interface Bitmap {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes, **not** premultiplied. */
  readonly rgba: Uint8Array;
}

/**
 * Read the first sheet candidate that is not the `{}` stub, and validate it.
 *
 * Validation is not belt-and-braces even though `sync-sheet` already did it: this
 * script indexes `frames`, `boxes` and `palettes` and slices rows by column, and
 * every one of those reads is only safe because `validateSheet` has proved the
 * row lengths match the box. Reading `art/walder.json` directly (the fallback)
 * has had no check at all.
 */
function loadSheet(): { sheet: SpriteSheet; source: string } {
  const problems: string[] = [];

  for (const path of SHEET_CANDIDATES) {
    if (!existsSync(path)) {
      problems.push(`${rel(path)}: not found`);
      continue;
    }

    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      problems.push(`${rel(path)}: not valid JSON (${(error as Error).message})`);
      continue;
    }

    // The stub `sync-sheet` writes when there is no art yet: an object with none
    // of the four sections. Anything else is a real attempt at a sheet and must
    // be reported by `validateSheet` rather than skipped, or a typo in the art
    // would silently fall through to the other file.
    const looksLikeSheet =
      typeof json === 'object' && json !== null && 'frames' in json && 'boxes' in json;
    if (!looksLikeSheet) {
      problems.push(`${rel(path)}: empty stub (has sync-sheet run?)`);
      continue;
    }

    try {
      return { sheet: validateSheet(json), source: rel(path) };
    } catch (error) {
      if (error instanceof SpriteSheetError) fail(`${rel(path)} is invalid — ${error.message}`);
      throw error;
    }
  }

  return fail(`no usable sprite sheet.\n  ${problems.join('\n  ')}`);
}

/** `#RGB` / `#RRGGBB` -> bytes. Anything else is a sheet the icon cannot use. */
function parseHexColor(color: string, where: string): readonly [number, number, number] {
  const hex = color.trim().replace(/^#/, '');
  const expanded =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;

  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    fail(
      `${where} is "${color}", which this script cannot render. Palette colours must ` +
        `be #RGB or #RRGGBB hex — the sheet format allows any CSS colour, but only a ` +
        `browser can resolve "rebeccapurple".`
    );
  }

  return [
    parseInt(expanded.slice(0, 2), 16),
    parseInt(expanded.slice(2, 4), 16),
    parseInt(expanded.slice(4, 6), 16)
  ] as const;
}

/** The frame's ink bounding box, or `undefined` if the frame is blank. */
function inkBounds(
  rows: readonly string[]
): { x: number; y: number; width: number; height: number } | undefined {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (let y = 0; y < rows.length; y++) {
    const row = rows[y] ?? '';
    for (let x = 0; x < row.length; x++) {
      if (row[x] === TRANSPARENT) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) return undefined;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Render a rectangle of a frame at one target pixel per sprite pixel. */
function cropToBitmap(
  rows: readonly string[],
  palette: Palette,
  crop: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
): Bitmap {
  const { x: cropX, y: cropY, width, height } = crop;
  const rgba = new Uint8Array(width * height * 4);
  let inked = 0;

  for (let y = 0; y < height; y++) {
    const row = rows[cropY + y];
    if (row === undefined) continue;
    for (let x = 0; x < width; x++) {
      const ch = row[cropX + x];
      if (ch === undefined || ch === TRANSPARENT) continue;
      const color = palette[ch];
      // `validateSheet` proved every key resolves in every palette, so this is
      // unreachable; it is a skip rather than a throw for the same reason
      // `rasteriseFrame` skips — a hole beats an exception in a build script.
      if (color === undefined) continue;
      const [r, g, b] = parseHexColor(color, `palette "${PALETTE_NAME}" key "${ch}"`);
      const i = (y * width + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
      inked++;
    }
  }

  if (inked === 0) {
    fail(
      `the crop ${width}x${height} at (${cropX},${cropY}) of frame "${FRAME_NAME}" is ` +
        `entirely transparent — has the pose moved? See HEAD_CROP.`
    );
  }

  return { width, height, rgba };
}

/**
 * Target pixels per sprite pixel for a crop fitted into an `available` box.
 *
 * Prefers a whole number so that every sprite pixel comes out the same size (the
 * rejected alternative — always using the exact fit — makes a 1 px outline
 * alternate between 3 and 4 pixels wide, which is visible as a ripple along the
 * ear). Falls back to the exact fit when the whole number would waste too much of
 * the canvas, and below 1x there is nothing to round to.
 */
function contentScale(bitmap: Bitmap, available: number): number {
  const exact = Math.min(available / bitmap.width, available / bitmap.height);
  if (exact < 1) return exact;
  const whole = Math.floor(exact);
  return whole / exact >= INTEGER_SCALE_MIN_FILL ? whole : exact;
}

/**
 * Area-average resample of `bitmap` to `width` x `height`.
 *
 * Alpha is premultiplied for the duration of the average and divided back out
 * afterwards, which is the difference between an edge that fades to the coat
 * colour and one that fades to black through the transparent pixels next to it.
 * When the ratio is a whole number every target pixel lies inside exactly one
 * source pixel, so this reduces to nearest-neighbour replication and the output
 * is bit-for-bit what a dedicated nearest-neighbour path would produce — which is
 * why there is only one resampler here.
 */
function resample(bitmap: Bitmap, width: number, height: number): Bitmap {
  const out = new Uint8Array(width * height * 4);
  const xStep = bitmap.width / width;
  const yStep = bitmap.height / height;

  for (let dy = 0; dy < height; dy++) {
    const top = dy * yStep;
    const bottom = top + yStep;
    for (let dx = 0; dx < width; dx++) {
      const left = dx * xStep;
      const right = left + xStep;

      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;
      let covered = 0;

      for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) {
        const hSpan = Math.min(bottom, sy + 1) - Math.max(top, sy);
        if (hSpan <= 0) continue;
        for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
          const wSpan = Math.min(right, sx + 1) - Math.max(left, sx);
          if (wSpan <= 0) continue;
          const area = hSpan * wSpan;
          const i = (sy * bitmap.width + sx) * 4;
          const a = (bitmap.rgba[i + 3] ?? 0) / 255;
          r += (bitmap.rgba[i] ?? 0) * a * area;
          g += (bitmap.rgba[i + 1] ?? 0) * a * area;
          b += (bitmap.rgba[i + 2] ?? 0) * a * area;
          alpha += a * area;
          covered += area;
        }
      }

      if (alpha <= 0 || covered <= 0) continue;
      const i = (dy * width + dx) * 4;
      out[i] = Math.round(r / alpha);
      out[i + 1] = Math.round(g / alpha);
      out[i + 2] = Math.round(b / alpha);
      out[i + 3] = Math.round((alpha / covered) * 255);
    }
  }

  return { width, height, rgba: out };
}

/**
 * Scale `art` to fit a `size` x `size` transparent canvas with `pad` per side and
 * centre it. The vertical offset rounds *down* so an odd leftover pixel goes
 * below the dog rather than above: an icon that sits slightly high reads as
 * deliberate, one that sits low reads as fallen over.
 */
function renderIcon(art: Bitmap, size: number, pad: number): Bitmap {
  const margin = Math.floor(size * pad);
  const available = Math.max(1, size - 2 * margin);
  const scale = contentScale(art, available);

  const contentWidth = Math.max(1, Math.min(size, Math.round(art.width * scale)));
  const contentHeight = Math.max(1, Math.min(size, Math.round(art.height * scale)));
  const content = resample(art, contentWidth, contentHeight);

  const rgba = new Uint8Array(size * size * 4);
  const offsetX = Math.floor((size - contentWidth) / 2);
  const offsetY = Math.floor((size - contentHeight) / 2);

  for (let y = 0; y < contentHeight; y++) {
    const source = y * contentWidth * 4;
    const target = ((y + offsetY) * size + offsetX) * 4;
    rgba.set(content.rgba.subarray(source, source + contentWidth * 4), target);
  }

  return { width: size, height: size, rgba };
}

/**
 * The ICO container, with every member PNG-compressed.
 *
 * PNG members (rather than the older BMP+AND-mask form) are supported from
 * Windows Vista on and are the only sane choice for 256 px, where a BMP member
 * would be a 256 KiB uncompressed blob. Header layout is in the file header
 * comment; the one trap is that `bytesInRes`/`imageOffset` are absolute and the
 * offsets can only be filled in once every member's length is known.
 */
function encodeIco(members: readonly Buffer[], sizes: readonly number[]): Buffer {
  if (members.length !== sizes.length) {
    fail(`ICO: ${members.length} images for ${sizes.length} sizes`);
  }

  const header = Buffer.alloc(ICONDIR_BYTES);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon (2 would be a cursor)
  header.writeUInt16LE(members.length, 4);

  const directory = Buffer.alloc(ICONDIRENTRY_BYTES * members.length);
  let offset = ICONDIR_BYTES + directory.length;

  for (let i = 0; i < members.length; i++) {
    const png = members[i] as Buffer;
    const size = sizes[i] as number;
    if (size > 256) fail(`ICO cannot hold a ${size}px image (256 is the maximum)`);

    const at = i * ICONDIRENTRY_BYTES;
    const dimension = size === 256 ? ICO_DIMENSION_256 : size;
    directory[at] = dimension; // width
    directory[at + 1] = dimension; // height
    directory[at + 2] = 0; // palette entries; 0 = not paletted
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  }

  return Buffer.concat([header, directory, ...members]);
}

/**
 * One line per file, as the only output on a good run. `dimensions` is a string
 * rather than a width/height pair because two of the three files are containers
 * holding several sizes, and reporting "256x256" for a six-member ICO would be a
 * quietly wrong number in a log somebody later trusts.
 */
function report(path: string, dimensions: string): void {
  console.log(`wrote ${rel(path)} (${dimensions}, ${statSync(path).size} bytes)`);
}

/**
 * Build the `.icns` through macOS's own `iconutil`.
 *
 * Writing the ICNS container by hand was the rejected alternative: unlike ICO it
 * has a TOC, per-type magic (`ic07`/`ic08`/…) and, for the retina sizes, an
 * `icnV`-versioned layout that Finder is picky about, and getting it subtly wrong
 * produces an app with a blank icon rather than an error. `iconutil` ships with
 * every macOS, and on other platforms this is skipped rather than fatal so the
 * script still yields `icon.png` and `icon.ico` on a Windows or CI box.
 *
 * Returns false when it was skipped.
 */
function writeIcns(art: Bitmap): boolean {
  const iconset = join(BUILD_DIR, 'icon.iconset');
  const icns = join(BUILD_DIR, 'icon.icns');

  if (process.platform !== 'darwin') {
    console.warn(
      `gen-icons: skipping icon.icns — iconutil is macOS-only and this is ` +
        `${process.platform}. icon.png and icon.ico were still written; run this on a ` +
        `Mac before packaging for macOS.`
    );
    return false;
  }

  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });

  // Sizes repeat across the ten names (32 is both 16@2x and 32@1x), so render
  // each distinct size once.
  const rendered = new Map<number, Buffer>();
  for (const { name, size } of ICONSET_ENTRIES) {
    let png = rendered.get(size);
    if (png === undefined) {
      png = encodePng(size, size, renderIcon(art, size, MAC_PAD).rgba);
      rendered.set(size, png);
    }
    writeFileSync(join(iconset, name), png);
  }

  try {
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icns], { stdio: 'pipe' });
  } catch (error) {
    const detail = error as { code?: string; stderr?: Buffer };
    if (detail.code === 'ENOENT') {
      console.warn(
        `gen-icons: skipping icon.icns — iconutil is not on PATH. The iconset is left ` +
          `at ${rel(iconset)} so it can be converted on a machine that has it.`
      );
      return false;
    }
    // A real failure: the iconset is kept so whoever debugs it can see the input.
    fail(
      `iconutil failed: ${detail.stderr?.toString().trim() ?? (error as Error).message}\n` +
        `  the iconset is at ${rel(iconset)}`
    );
  }

  // Only removed on success — it is a temporary, and on failure it is evidence.
  rmSync(iconset, { recursive: true, force: true });
  report(icns, `${ICONSET_ENTRIES.map((e) => e.size).join('/')} px members`);
  return true;
}

function main(): void {
  const { sheet, source } = loadSheet();

  const frame = sheet.frames[FRAME_NAME];
  if (frame === undefined) {
    fail(
      `${source} has no frame "${FRAME_NAME}" (it has: ` +
        `${Object.keys(sheet.frames).slice(0, 8).join(', ')}…)`
    );
  }

  const palette = sheet.palettes[PALETTE_NAME];
  if (palette === undefined) {
    fail(
      `${source} has no palette "${PALETTE_NAME}" (it has: ` +
        `${Object.keys(sheet.palettes).join(', ')})`
    );
  }

  const box = sheet.boxes[frame.box];
  // Unreachable: `validateSheet` rejects a frame naming a box that is absent.
  if (box === undefined) fail(`frame "${FRAME_NAME}" references unknown box "${frame.box}"`);
  const [boxWidth, boxHeight] = box;

  if (
    HEAD_CROP.x < 0 ||
    HEAD_CROP.y < 0 ||
    HEAD_CROP.x + HEAD_CROP.width > boxWidth ||
    HEAD_CROP.y + HEAD_CROP.height > boxHeight
  ) {
    fail(
      `HEAD_CROP ${HEAD_CROP.width}x${HEAD_CROP.height} at (${HEAD_CROP.x},${HEAD_CROP.y}) ` +
        `does not fit box "${frame.box}" (${boxWidth}x${boxHeight}). The art's geometry ` +
        `has changed — re-judge the crop, see this file's header.`
    );
  }

  const ink = inkBounds(frame.rows);
  console.log(
    `source ${source} · frame ${FRAME_NAME} · palette ${PALETTE_NAME} · box ${frame.box} ` +
      `${boxWidth}x${boxHeight}`
  );
  console.log(
    `ink bounds ${ink === undefined ? 'none' : `${ink.width}x${ink.height} at (${ink.x},${ink.y})`}` +
      ` · head crop ${HEAD_CROP.width}x${HEAD_CROP.height} at (${HEAD_CROP.x},${HEAD_CROP.y})`
  );

  const art = cropToBitmap(frame.rows, palette, HEAD_CROP);
  mkdirSync(BUILD_DIR, { recursive: true });

  const pngPath = join(BUILD_DIR, 'icon.png');
  writeFileSync(
    pngPath,
    encodePng(ICON_PNG_SIZE, ICON_PNG_SIZE, renderIcon(art, ICON_PNG_SIZE, MAC_PAD).rgba)
  );
  report(pngPath, `${ICON_PNG_SIZE}x${ICON_PNG_SIZE}`);

  writeIcns(art);

  const icoPath = join(BUILD_DIR, 'icon.ico');
  const members = ICO_SIZES.map((size) =>
    encodePng(size, size, renderIcon(art, size, WIN_PAD).rgba)
  );
  writeFileSync(icoPath, encodeIco(members, ICO_SIZES));
  report(icoPath, `${ICO_SIZES.join('/')} px members`);
}

/*
 * Nothing is exported. `test/gen-icons.test.ts` runs this script and reads the
 * files back — the same thing the build does — rather than importing helpers,
 * because the assertion that matters is "the container a packager will open
 * parses", not "the function returned the buffer I expected".
 */
main();

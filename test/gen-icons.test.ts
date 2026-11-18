/**
 * The application icon, and the containers it ships in.
 *
 * `scripts/gen-icons.ts` writes three files that nothing in this repo reads: the
 * only consumers are electron-builder, Finder and the Windows shell. A malformed
 * ICO directory or an icon that came out blank therefore surfaces at the *end* of
 * a packaging run, or worse, as an app in the Dock with a white rectangle where
 * the dog should be. So the checks that would otherwise be done by eye once are
 * done here on every run:
 *
 *  - the script exits 0 and produces all three files;
 *  - the ICO container parses the way a shell parses it — every directory entry's
 *    offset and length landing on a real PNG whose IHDR agrees with the entry;
 *  - the pixels are a tile with a dog on it: transparent rounded corners, the
 *    outline colour at the tile's top edge in every member (it must survive 16
 *    px), and the sprite's exact iris ink wherever the scale is a whole number —
 *    a tile with nothing composited on it fails there;
 *  - the head crop the script *found* is a head: square, well inside the sprite
 *    box, mostly ink, and containing every eye the frame draws. That last one is
 *    re-derived here from `src/sprites/walder.json` rather than taken on trust,
 *    so the crop is checked against the real sheet by something that does not
 *    share the script's arithmetic. It also cuts no head ink at its left, top or
 *    right edge (the far ear was clipped on the right until 2026-11-17).
 *
 * The script is run for real rather than imported: it has no exports, and the
 * assertion worth making is about the bytes on disk. It writes into `build/`,
 * which is where it always writes — these are build artefacts, the script is
 * deterministic, and regenerating them is exactly what `dist:mac`/`dist:win` do.
 *
 * Written to survive an ordinary redraw. Nothing here asserts a pixel position,
 * a file size or a palette letter; a new pose changes all of those and none of
 * them is a contract.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { native, tsxCli } from './support/host';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(root, 'scripts', 'gen-icons.ts');
const BUILD = join(root, 'build');
/*
 * tsx's own CLI module, run with this Node — not the `.bin/tsx` shim, which on
 * Windows is a `.cmd` that Node will not `execFile` (EINVAL). Why, and why not
 * `shell: true` instead, is in `test/support/host.ts`.
 */
const TSX = tsxCli();

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICONDIR_BYTES = 6;
const ICONDIRENTRY_BYTES = 16;

/*
 * Skipped rather than failed when `tsx` is absent: the suite should still run on
 * a checkout whose devDependencies were pruned. Every other reason for the
 * script not to run is a failure.
 */
const runnable = TSX !== null;

let output = '';

beforeAll(() => {
  if (TSX === null) return;
  output = execFileSync(process.execPath, [TSX, SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe'
  });
}, 60_000);

/** IHDR width/height of a PNG, without decoding it. */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Decode one of *our* PNGs to straight RGBA.
 *
 * Handles exactly what `scripts/png.ts` emits — colour type 6, bit depth 8,
 * filter type 0 on every scanline — and throws otherwise. That narrowness is the
 * point: if the encoder ever starts filtering scanlines, this fails loudly rather
 * than quietly asserting on garbage.
 */
function decodePng(png: Buffer): { width: number; height: number; rgba: Buffer } {
  expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);

  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  let offset = 8;

  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8], 'bit depth').toBe(8);
      expect(data[9], 'colour type').toBe(6);
    }
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  expect(raw.length).toBe(height * (stride + 1));

  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)], `filter byte on row ${y}`).toBe(0);
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }

  return { width, height, rgba };
}

interface Coverage {
  readonly opaqueFraction: number;
  readonly transparentFraction: number;
  readonly distinctColours: number;
}

function coverage(image: { width: number; height: number; rgba: Buffer }): Coverage {
  const total = image.width * image.height;
  const colours = new Set<number>();
  let opaque = 0;
  let transparent = 0;

  for (let i = 0; i < total; i++) {
    const alpha = image.rgba[i * 4 + 3] ?? 0;
    if (alpha === 255) opaque++;
    else if (alpha === 0) transparent++;
    if (alpha > 0) {
      colours.add(
        ((image.rgba[i * 4] ?? 0) << 16) |
          ((image.rgba[i * 4 + 1] ?? 0) << 8) |
          (image.rgba[i * 4 + 2] ?? 0)
      );
    }
  }

  return {
    opaqueFraction: opaque / total,
    transparentFraction: transparent / total,
    distinctColours: colours.size
  };
}

const IRIS = [0x2d, 0x1a, 0x0d];
const OUTLINE = [0xe2, 0xb8, 0x7c, 255];

function hasColour(image: { rgba: Buffer }, [r, g, b]: number[]): boolean {
  for (let i = 0; i < image.rgba.length; i += 4) {
    if (image.rgba[i] === r && image.rgba[i + 1] === g && image.rgba[i + 2] === b) return true;
  }
  return false;
}

/** The first non-transparent pixel straight down from the top centre. */
function topEdge(image: { width: number; height: number; rgba: Buffer }): number[] {
  const x = Math.floor(image.width / 2);
  for (let y = 0; y < image.height; y++) {
    const i = (y * image.width + x) * 4;
    if ((image.rgba[i + 3] ?? 0) > 0) return [...image.rgba.subarray(i, i + 4)];
  }
  return [];
}

/** Every PNG member of the ICO, checked against its own directory entry. */
function readIcoMembers(ico: Buffer): Buffer[] {
  expect(ico.readUInt16LE(0), 'ICONDIR reserved').toBe(0);
  expect(ico.readUInt16LE(2), 'ICONDIR type (1 = icon)').toBe(1);

  const count = ico.readUInt16LE(4);
  expect(count).toBeGreaterThan(0);

  const members: Buffer[] = [];
  let expectedOffset = ICONDIR_BYTES + count * ICONDIRENTRY_BYTES;

  for (let i = 0; i < count; i++) {
    const at = ICONDIR_BYTES + i * ICONDIRENTRY_BYTES;
    const declaredWidth = ico[at] ?? -1;
    const declaredHeight = ico[at + 1] ?? -1;
    // 0 is the escape for 256: the field is one byte, and 256 does not fit.
    const width = declaredWidth === 0 ? 256 : declaredWidth;
    const height = declaredHeight === 0 ? 256 : declaredHeight;

    expect(ico[at + 2], `entry ${i} colour count (0 = not paletted)`).toBe(0);
    expect(ico[at + 3], `entry ${i} reserved`).toBe(0);
    expect(ico.readUInt16LE(at + 4), `entry ${i} planes`).toBe(1);
    expect(ico.readUInt16LE(at + 6), `entry ${i} bits per pixel`).toBe(32);

    const length = ico.readUInt32LE(at + 8);
    const offset = ico.readUInt32LE(at + 12);

    expect(offset, `entry ${i} offset is absolute and follows the previous member`).toBe(
      expectedOffset
    );
    expect(offset + length, `entry ${i} runs past the end of the file`).toBeLessThanOrEqual(
      ico.length
    );

    const png = ico.subarray(offset, offset + length);
    expect(png.subarray(0, 8), `entry ${i} does not point at a PNG`).toEqual(PNG_SIGNATURE);
    expect(pngSize(png), `entry ${i} IHDR disagrees with the directory`).toEqual({ width, height });

    members.push(png);
    expectedOffset += length;
  }

  expect(expectedOffset, 'trailing bytes after the last member').toBe(ico.length);
  return members;
}

describe.runIf(runnable)('scripts/gen-icons.ts', () => {
  it('reports every file it wrote', () => {
    // The script names each file with the host's `path.relative`, so Windows
    // reads `wrote build\icon.png`; the name is matched in that spelling.
    const wrote = (file: string): string =>
      `wrote ${native(`build/${file}`)}`.replace(/[\\.]/g, '\\$&');
    expect(output).toMatch(new RegExp(`${wrote('icon.png')} \\(512x512, \\d+ bytes\\)`));
    expect(output).toMatch(new RegExp(`${wrote('icon.ico')} \\([\\d/]+ px members, \\d+ bytes\\)`));
    // The frame and palette are in the first line so a bad icon can be traced to
    // its source without re-reading the script.
    expect(output).toContain('frame idle_0');
    expect(output).toContain('palette golden');
  });

  it('leaves no temporary iconset behind', () => {
    expect(existsSync(join(BUILD, 'icon.iconset'))).toBe(false);
  });

  /*
   * The crop is *found* (eye clusters -> nearest the ink's top-left -> a square
   * of the head's own width around it), not typed in, so what is worth asserting
   * is the property the search exists to guarantee — a square that holds the face
   * — and not the numbers it happens to produce for today's pose.
   */
  describe('the head crop it found', () => {
    /** `head crop 36x36 at (5,23) · 74 % ink` */
    function reportedCrop(): {
      x: number;
      y: number;
      width: number;
      height: number;
      density: number;
    } {
      const line = /head crop (\d+)x(\d+) at \((\d+),(\d+)\) · (\d+) % ink/.exec(output);
      expect(line, `no head-crop line in:\n${output}`).not.toBeNull();
      const [, w, h, x, y, ink] = line as RegExpExecArray;
      return {
        x: Number(x),
        y: Number(y),
        width: Number(w),
        height: Number(h),
        density: Number(ink) / 100
      };
    }

    /** The frame the icon is cut from, and the box it lives in. */
    function idleFrame(): { rows: string[]; boxWidth: number; boxHeight: number } {
      const sheet = JSON.parse(readFileSync(join(root, 'src', 'sprites', 'walder.json'), 'utf8'));
      const frame = sheet.frames.idle_0;
      const [boxWidth, boxHeight] = sheet.boxes[frame.box];
      return { rows: frame.rows, boxWidth, boxHeight };
    }

    /**
     * Every facial eye/nose pixel of `idle_0`, grouped independently. A lone
     * iris-coloured pixel in the lowest quarter is leg shading; highlights and
     * multi-pixel clusters must still fit, wherever the art placed them.
     *
     * Deliberately a second implementation rather than an import: the script
     * exports nothing, and a check that shares the code under test can only
     * prove it agrees with itself.
     */
    function eyeClusters(): { x: number; y: number; width: number; height: number }[] {
      const sheet = JSON.parse(readFileSync(join(root, 'src', 'sprites', 'walder.json'), 'utf8'));
      const palette: Record<string, string> = sheet.palettes.golden;
      const wanted = new Set(['#2D1A0D', '#1F1208', '#FFFFFF']);
      const letters = new Set(
        Object.entries(palette)
          .filter(([, color]) => wanted.has(color.toUpperCase()))
          .map(([letter]) => letter)
      );
      expect(letters.size, 'the palette no longer defines the eye colours').toBeGreaterThan(0);

      const rows: string[] = sheet.frames.idle_0.rows;
      const inkRows = rows.flatMap((row, y) => row.replaceAll('.', '').length > 0 ? [y] : []);
      const inkTop = Math.min(...inkRows);
      const inkHeight = Math.max(...inkRows) - inkTop + 1;
      const lowerLegStartFraction = 0.75;
      const lowerLegStart = inkTop + inkHeight * lowerLegStartFraction;
      const points: [number, number][] = [];
      rows.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
          const ch = row[x];
          if (ch !== undefined && letters.has(ch)) points.push([x, y]);
        }
      });
      expect(points.length, 'idle_0 draws no eyes').toBeGreaterThan(0);

      const seen = points.map(() => false);
      const boxes: { x: number; y: number; width: number; height: number }[] = [];
      for (let i = 0; i < points.length; i++) {
        if (seen[i]) continue;
        seen[i] = true;
        const stack = [i];
        const members: [number, number][] = [];
        while (stack.length > 0) {
          const at = stack.pop() as number;
          const here = points[at] as [number, number];
          members.push(here);
          for (let k = 0; k < points.length; k++) {
            if (seen[k]) continue;
            const other = points[k] as [number, number];
            if (Math.abs(other[0] - here[0]) <= 2 && Math.abs(other[1] - here[1]) <= 2) {
              seen[k] = true;
              stack.push(k);
            }
          }
        }
        const xs = members.map(([x]) => x);
        const ys = members.map(([, y]) => y);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        const letter = rows[y]?.[x];
        if (members.length === 1 && y >= lowerLegStart && letter !== undefined &&
          palette[letter]?.toUpperCase() === '#2D1A0D') continue;
        boxes.push({ x, y, width: Math.max(...xs) - x + 1, height: Math.max(...ys) - y + 1 });
      }
      return boxes;
    }

    it('reports which eye it anchored on, so a reframe is visible in the build log', () => {
      expect(output).toMatch(/ink bounds \d+x\d+ at \(\d+,\d+\)/);
      expect(output).toMatch(/\d+ eye\/nose clusters · eye \d+x\d+ at \(\d+,\d+\)/);
    });

    it('is a square that fits inside the sprite box', () => {
      const crop = reportedCrop();
      const { boxWidth, boxHeight } = idleFrame();

      expect(crop.width, 'square').toBe(crop.height);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(boxWidth);
      expect(crop.y + crop.height).toBeLessThanOrEqual(boxHeight);
      // A head, not the whole dog: the point of cropping at all.
      expect(crop.width).toBeLessThan(boxWidth);
    });

    it('holds every eye the frame draws', () => {
      const crop = reportedCrop();
      const clusters = eyeClusters();
      expect(clusters.length, 'the search found nothing to anchor on').toBeGreaterThan(0);

      for (const cluster of clusters) {
        const where = `${cluster.width}x${cluster.height} at (${cluster.x},${cluster.y})`;
        expect(cluster.x, where).toBeGreaterThanOrEqual(crop.x);
        expect(cluster.y, where).toBeGreaterThanOrEqual(crop.y);
        expect(cluster.x + cluster.width, where).toBeLessThanOrEqual(crop.x + crop.width);
        expect(cluster.y + cluster.height, where).toBeLessThanOrEqual(crop.y + crop.height);
      }
    });

    /**
     * Ink just outside the crop that belongs to the head: anywhere along the left
     * and top edges, and along the right edge down to the lowest eye/nose
     * landmark — the far ear hangs beside the face, and below it the back is
     * meant to run on into the tile's edge, as the chest runs into its bottom.
     */
    function clippedHeadInk(crop: { x: number; y: number; width: number; height: number }): string[] {
      const { rows } = idleFrame();
      const faceBottom = Math.max(...eyeClusters().map((c) => c.y + c.height - 1));
      const inked = (x: number, y: number): boolean => {
        const ch = rows[y]?.[x];
        return ch !== undefined && ch !== '.';
      };
      const clipped: string[] = [];
      for (let y = crop.y; y < crop.y + crop.height; y++) {
        if (inked(crop.x - 1, y)) clipped.push(`left at row ${y}`);
        if (y <= faceBottom && inked(crop.x + crop.width, y)) clipped.push(`right at row ${y}`);
      }
      for (let x = crop.x; x < crop.x + crop.width; x++) {
        if (inked(x, crop.y - 1)) clipped.push(`top at column ${x}`);
      }
      return clipped;
    }

    it('cuts no ear or skull ink at its left, top or right edge', () => {
      expect(clippedHeadInk(reportedCrop())).toEqual([]);
    });

    it('would catch the old crop that cut the far ear off on the right', () => {
      // The pre-2026-11-17 square: 36 px from the eye anchor, ear tip outside.
      expect(clippedHeadInk({ x: 5, y: 21, width: 36, height: 36 })).toContain('right at row 40');
    });

    it('is mostly ink, which is what a head crop means', () => {
      const crop = reportedCrop();
      const { rows } = idleFrame();

      let inked = 0;
      for (let y = 0; y < crop.height; y++) {
        const row = rows[crop.y + y] ?? '';
        for (let x = 0; x < crop.width; x++) {
          const ch = row[crop.x + x];
          if (ch !== undefined && ch !== '.') inked++;
        }
      }
      const density = inked / (crop.width * crop.height);

      // Re-measured here, and cross-checked against what the script printed:
      // a crop that reported one number and cut another is the bug this catches.
      expect(density).toBeCloseTo(crop.density, 1);
      expect(density, 'a crop that slid off the dog').toBeGreaterThan(0.45);
    });
  });

  describe('build/icon.png', () => {
    it('is a 512x512 RGBA PNG', () => {
      const image = decodePng(readFileSync(join(BUILD, 'icon.png')));
      expect({ width: image.width, height: image.height }).toEqual({ width: 512, height: 512 });
    });

    it('is a tile on a transparent field, with the dog drawn on it', () => {
      const image = decodePng(readFileSync(join(BUILD, 'icon.png')));
      const stats = coverage(image);

      // The corners are the transparent margin macOS expects; a fully flooded
      // canvas (a failed crop, or the whole box rendered opaque) fails here.
      expect(image.rgba[3], 'top-left corner alpha').toBe(0);
      expect(image.rgba[image.rgba.length - 1], 'bottom-right corner alpha').toBe(0);
      expect(stats.opaqueFraction).toBeGreaterThan(0.25);
      expect(stats.opaqueFraction).toBeLessThan(0.9);

      // A cream tile alone would pass the two checks above; the iris colour,
      // exact because 512 is a whole-number scale, only comes from the sprite.
      expect(hasColour(image, IRIS), 'no sprite eye pixels').toBe(true);
      expect(topEdge(image), 'tile outline at the top centre').toEqual(OUTLINE);
    });
  });

  describe('build/icon.ico', () => {
    it('parses as an ICONDIR of PNG members', () => {
      const members = readIcoMembers(readFileSync(join(BUILD, 'icon.ico')));
      expect(members.length).toBeGreaterThanOrEqual(4);
    });

    it('covers the sizes Windows asks for, smallest first, none over 256', () => {
      const members = readIcoMembers(readFileSync(join(BUILD, 'icon.ico')));
      const sizes = members.map((png) => pngSize(png).width);

      expect(sizes).toContain(16);
      expect(sizes).toContain(32);
      expect(sizes).toContain(256);
      expect(Math.max(...sizes), 'an ICONDIRENTRY cannot describe more than 256').toBeLessThanOrEqual(
        256
      );
      expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
      expect(new Set(sizes).size, 'duplicate sizes').toBe(sizes.length);
    });

    it('has a tile with a visible edge in every member, and the dog in the large ones', () => {
      for (const png of readIcoMembers(readFileSync(join(BUILD, 'icon.ico')))) {
        const image = decodePng(png);
        const stats = coverage(image);
        const label = `${image.width}x${image.height}`;

        expect(stats.opaqueFraction, label).toBeGreaterThanOrEqual(0.4);
        // Rounded corners, even at 16 px where the Windows margin rounds to 0.
        expect(image.rgba[3], `${label} top-left corner alpha`).toBe(0);
        // The outline is at least 1 px at every size, so the cream tile does not
        // vanish on a white taskbar.
        expect(topEdge(image), label).toEqual(OUTLINE);
        // Area-averaged sizes blend; whole-number ones keep the exact iris ink.
        expect(stats.distinctColours, label).toBeGreaterThan(5);
        if (image.width >= 128) expect(hasColour(image, IRIS), label).toBe(true);
      }
    });
  });

  describe.runIf(process.platform === 'darwin')('build/icon.icns', () => {
    it('is an icns whose header length matches the file', () => {
      const icns = readFileSync(join(BUILD, 'icon.icns'));
      expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
      expect(icns.readUInt32BE(4), 'declared length').toBe(icns.length);
    });

    it('was accepted by iconutil, which is the only reader that matters', () => {
      // Converting back is the strongest available check: iconutil refuses a
      // container it cannot read, so a zero exit here means Finder can read it.
      const listed = execFileSync(
        'iconutil',
        ['--convert', 'iconset', join(BUILD, 'icon.icns'), '--output', join(BUILD, 'icon.iconset')],
        { cwd: root, encoding: 'utf8', stdio: 'pipe' }
      );
      expect(listed).toBe('');

      const iconset = join(BUILD, 'icon.iconset');
      expect(existsSync(join(iconset, 'icon_16x16.png'))).toBe(true);
      expect(existsSync(join(iconset, 'icon_512x512@2x.png'))).toBe(true);
      expect(pngSize(readFileSync(join(iconset, 'icon_512x512@2x.png')))).toEqual({
        width: 1024,
        height: 1024
      });

      // Put `build/` back the way the script leaves it.
      rmSync(iconset, { recursive: true, force: true });
    });
  });
});

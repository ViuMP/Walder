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
 *  - the pixels are actually a dog: transparent margin, opaque middle, warm coat
 *    colours, and an ink coverage that would catch both an empty canvas and one
 *    flooded with a single colour.
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

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(root, 'scripts', 'gen-icons.ts');
const BUILD = join(root, 'build');
const TSX = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICONDIR_BYTES = 6;
const ICONDIRENTRY_BYTES = 16;

/*
 * Skipped rather than failed when `tsx` is absent: the suite should still run on
 * a checkout whose devDependencies were pruned. Every other reason for the
 * script not to run is a failure.
 */
const runnable = existsSync(TSX);

let output = '';

beforeAll(() => {
  if (!runnable) return;
  output = execFileSync(TSX, [SCRIPT], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
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
    expect(output).toMatch(/wrote build\/icon\.png \(512x512, \d+ bytes\)/);
    expect(output).toMatch(/wrote build\/icon\.ico \([\d/]+ px members, \d+ bytes\)/);
    // The frame and palette are in the first line so a bad icon can be traced to
    // its source without re-reading the script.
    expect(output).toContain('frame idle_0');
    expect(output).toContain('palette golden');
  });

  it('leaves no temporary iconset behind', () => {
    expect(existsSync(join(BUILD, 'icon.iconset'))).toBe(false);
  });

  describe('build/icon.png', () => {
    it('is a 512x512 RGBA PNG', () => {
      const image = decodePng(readFileSync(join(BUILD, 'icon.png')));
      expect({ width: image.width, height: image.height }).toEqual({ width: 512, height: 512 });
    });

    it('is a centred sprite on a transparent field, not a flat rectangle', () => {
      const image = decodePng(readFileSync(join(BUILD, 'icon.png')));
      const stats = coverage(image);

      // The corners are the transparent margin macOS expects; a fully flooded
      // canvas (a failed crop, or the whole box rendered opaque) fails here.
      expect(image.rgba[3], 'top-left corner alpha').toBe(0);
      expect(image.rgba[image.rgba.length - 1], 'bottom-right corner alpha').toBe(0);

      // Between "blank" and "flooded". The sprite covers about half of a square
      // canvas; the band is wide enough for a redrawn pose.
      expect(stats.opaqueFraction).toBeGreaterThan(0.25);
      expect(stats.opaqueFraction).toBeLessThan(0.9);

      // Shaded pixel art, not a silhouette: the coat ramp alone is eight tones.
      expect(stats.distinctColours).toBeGreaterThan(5);
    });

    it('draws the golden coat, opaque through the middle', () => {
      const image = decodePng(readFileSync(join(BUILD, 'icon.png')));
      const centre =
        (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;

      expect(image.rgba[centre + 3], 'centre alpha').toBe(255);
      // Warm, i.e. more red than blue. True of every coat the sheet defines, so
      // this survives a palette change but not a greyscale or empty render.
      expect(image.rgba[centre] ?? 0).toBeGreaterThan(image.rgba[centre + 2] ?? 0);
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

    it('has a legible dog in every member, including 16x16', () => {
      for (const png of readIcoMembers(readFileSync(join(BUILD, 'icon.ico')))) {
        const image = decodePng(png);
        const stats = coverage(image);
        const label = `${image.width}x${image.height}`;

        // Windows uses a smaller margin than macOS, so these fill more of the
        // square — but never all of it, and never none of it.
        expect(stats.opaqueFraction, label).toBeGreaterThan(0.4);
        expect(stats.transparentFraction, label).toBeGreaterThan(0.02);
        // At 16 px the resampler blends, so even the smallest member has more
        // than a handful of tones. A member that came out as one flat blob —
        // the classic symptom of a scale that collapsed to zero — fails here.
        expect(stats.distinctColours, label).toBeGreaterThan(5);
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

/**
 * `npm run gen:tray` — writes the four tray icon PNGs into `build/`.
 *
 * The icons are generated rather than checked in as binary blobs so they stay
 * reviewable: the artwork below is a text grid, and the PNG encoder is 40 lines
 * of `zlib` (a Node built-in — no dependency is added for this). That encoder
 * moved to `./png.ts` when `gen-icons.ts` needed it too; it is byte-for-byte the
 * same code, so these four files are unchanged by the move.
 *
 * Two variants, because the platforms differ in kind and not in degree:
 *
 *  - `trayTemplate.png` / `@2x` — **macOS**. A template image carries its shape
 *    in the alpha channel and is *tinted by the system*, so it is drawn as pure
 *    black with hard alpha and comes out correct on a light or dark menu bar.
 *    The `Template` suffix is what makes macOS treat it as one, and `tray.ts`
 *    also calls `setTemplateImage(true)`.
 *  - `tray-win.png` / `@2x` — **Windows and Linux**, which do no such tinting.
 *    The macOS file there is black on transparent, i.e. invisible on the default
 *    dark taskbar. This one is a white bone with a one-pixel dark outline, which
 *    reads on a dark *and* a light taskbar without knowing which it is.
 *
 * Runs before `dev` and `build` via npm's `pre*` hooks, so the files always
 * exist before the app looks for them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encodePng } from './png';
import { BONE_GRID, BONE_SIZE } from './tray-bone';

/**
 * The artwork. A text grid in its own module (`./tray-bone.ts`) so that the
 * properties which make it read as a bone at 16 px — symmetry, a shaft thinner
 * than the lobes, ink off the border — can be pinned by a test rather than
 * checked by squinting at a menu bar.
 */
const BONE = BONE_GRID;
const SIZE = BONE_SIZE;

function isInk(gx: number, gy: number): boolean {
  if (gx < 0 || gy < 0 || gx >= SIZE || gy >= SIZE) return false;
  return (BONE[gy] as string)[gx] === '#';
}

/**
 * Is this grid cell part of the one-pixel outline? Empty, but touching ink —
 * including diagonally, or the corners of the bone would leak.
 */
function isOutline(gx: number, gy: number): boolean {
  if (isInk(gx, gy)) return false;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (isInk(gx + dx, gy + dy)) return true;
    }
  }
  return false;
}

/**
 * Render the grid at `factor`x with nearest-neighbour scaling.
 *
 * `light: false` is the macOS template: black, shape in the alpha channel.
 * `light: true` is the Windows/Linux variant: white ink, dark outline, both
 * opaque, everything else transparent.
 */
function render(factor: number, light: boolean): Buffer {
  const size = SIZE * factor;
  const rgba = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const gy = Math.floor(y / factor);
    for (let x = 0; x < size; x++) {
      const gx = Math.floor(x / factor);
      const i = (y * size + x) * 4;

      if (isInk(gx, gy)) {
        if (light) {
          rgba[i] = 255;
          rgba[i + 1] = 255;
          rgba[i + 2] = 255;
        }
        // The macOS template leaves RGB at 0: black, and the system tints it.
        rgba[i + 3] = 255;
        continue;
      }

      if (light && isOutline(gx, gy)) {
        // Near-black rather than pure black, so it reads as an outline and not
        // as a second shape when the taskbar behind it is dark.
        rgba[i] = 26;
        rgba[i + 1] = 26;
        rgba[i + 2] = 26;
        rgba[i + 3] = 255;
      }
    }
  }

  return encodePng(size, size, rgba);
}

const buildDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
mkdirSync(buildDir, { recursive: true });

for (const [factor, light, name] of [
  [1, false, 'trayTemplate.png'],
  [2, false, 'trayTemplate@2x.png'],
  [1, true, 'tray-win.png'],
  [2, true, 'tray-win@2x.png']
] as const) {
  const file = join(buildDir, name);
  writeFileSync(file, render(factor, light));
  console.log(`wrote ${file} (${SIZE * factor}x${SIZE * factor})`);
}

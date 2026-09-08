/**
 * Turning a frame's character grid into fills.
 *
 * Split out of `render.ts` for the same reason `mask.ts` was: `render.ts` needs
 * DOM canvas types (`OffscreenCanvas`) and so cannot be typechecked or unit
 * tested outside a browser tsconfig, while the loop below — which decides the
 * exact rectangles the dog is made of — is the part worth pinning down. It takes
 * the narrowest possible target so a recording stub can stand in for a real
 * context.
 */
import type { Frame, Palette } from './types';
import { TRANSPARENT } from './types';
import { frameSize } from './mask';

/**
 * The slice of a 2D context this needs. `fillStyle` is deliberately widened to
 * `unknown`: a real context types it as `string | CanvasGradient | CanvasPattern`,
 * which would not be assignable to a `string` field, and nothing here ever reads
 * it back.
 */
export interface FillTarget {
  fillStyle: unknown;
  fillRect(x: number, y: number, width: number, height: number): void;
}

/**
 * Paint `frame` into `target` at `pixelScale` target pixels per sprite pixel,
 * with the frame's top-left at (0, 0).
 *
 * Runs of one colour within a row are coalesced into a single `fillRect`: pixel
 * art is mostly flat runs, and one fill per pixel would be 1920 calls for the
 * 48x40 stand box on a mascot that has to stay under 1 % idle CPU. Cells whose
 * palette key is missing are skipped — `validateSheet` rules that out for sheet
 * palettes, but a hole beats an exception for a hand-edited one.
 */
export function rasteriseFrame(
  frame: Frame,
  palette: Palette,
  pixelScale: number,
  target: FillTarget
): void {
  const { width, height } = frameSize(frame);

  for (let y = 0; y < height; y++) {
    const row = frame.rows[y] as string;
    let x = 0;
    while (x < width) {
      const ch = row[x] as string;
      if (ch === TRANSPARENT) {
        x++;
        continue;
      }
      const color = palette[ch];
      if (color === undefined) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < width && row[x + run] === ch) run++;
      target.fillStyle = color;
      target.fillRect(x * pixelScale, y * pixelScale, run * pixelScale, pixelScale);
      x += run;
    }
  }
}

/**
 * Device pixels per sprite pixel for a given logical `scale` and device pixel
 * ratio, as an integer.
 *
 * The product is not always whole — 1.5 dpr at scale 3 is 4.5 — and a fractional
 * pixel size makes some sprite pixels 4 device pixels wide and others 5, which on
 * pixel art reads as a visibly uneven, wobbling dog. Rounding to the nearest
 * integer and then drawing the bitmap at exactly that device size keeps every
 * sprite pixel the same width; the sprite ends up a fraction of a percent off
 * its nominal CSS size, which nobody can see.
 */
export function devicePixelScale(scale: number, dpr: number): number {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.max(1, Math.round(scale * ratio));
}

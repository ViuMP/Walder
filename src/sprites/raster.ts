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
 * The device pixel ratio the sprite maths may divide by: `dpr` itself when it is
 * a usable number, otherwise 1.
 *
 * `window.devicePixelRatio` can be 0 on a window that is still 0x0, and a test
 * or a stale caller can hand over anything, so the device size chosen by
 * `devicePixelScale`, the CSS size `spriteCssScale` derives from it and the
 * layout in `core/geometry.ts` (`spriteLayout`) all sanitise the ratio through
 * this one function — they must divide and multiply by the same number, or the
 * drawn box and the laid-out box drift apart again.
 */
export function usableDpr(dpr: number): number {
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

/**
 * How much room the sprite box has across, for `devicePixelScale`'s cap: the
 * box is `box` sprite pixels wide and has `room` CSS pixels of window to be
 * drawn in. The overlay passes the standing window at its nominal size
 * (`spriteFit` in `core/geometry.ts`).
 */
export interface PixelFit {
  readonly room: number;
  readonly box: number;
}

/**
 * Absorbs floating-point noise in `room * dpr / box` when the true quotient is a
 * whole number — 200 CSS px at dpr 1.13 is exactly 226 device px, two per pixel
 * of a 113-pixel box, yet `200 * 1.13 / 113` is 1.9999999999999998 — so the cap
 * never takes away a device pixel that genuinely fits. Far below any real
 * fraction of a device pixel.
 */
const FIT_EPSILON = 1e-9;

/**
 * Device pixels per sprite pixel for a given logical `scale` and device pixel
 * ratio, as an integer.
 *
 * **Why an integer.** The product is not always whole — 1.5 dpr at scale 3 is
 * 4.5 — and a fractional pixel size makes some sprite pixels 4 device pixels
 * wide and others 5, which on pixel art reads as a visibly uneven, wobbling dog.
 * So every sprite pixel gets the same whole number of device pixels, and the
 * bitmap is drawn at exactly that size.
 *
 * **Why `round`, with a minimum of 1 (re-checked for QA row 1.8).** Rounding
 * picks the whole number nearest the nominal size, so the dog is never more than
 * half a device pixel per sprite pixel off it — the smallest error any crisp
 * size can have. `floor` ("never larger than nominal") was weighed and rejected:
 * wherever `round` rounds down it is the same answer, and wherever `round`
 * rounds up it is a much smaller dog — Small at 175 % would get 1 device pixel,
 * 43 % under his window, where `round` gives 2 (14 % over), and all three sizes
 * at 125 % would be 20 % small, which is the very report row 1.8 came from. The
 * minimum of 1 is for absurd inputs (a ratio under 0.5): a sprite pixel cannot
 * be drawn at 0.
 *
 * **The cost: the dog is not exactly his nominal CSS size.** This comment used
 * to say "a fraction of a percent", which is only true when `scale * dpr` is
 * already whole. In CSS pixels he is drawn at `spriteCssScale` = this / dpr per
 * sprite pixel; at the Windows scale factors, for scale 1 / 2 / 3 (Small /
 * Medium / Large), that is
 *
 *   dpr 1.25:  1 -> 1 device px (0.80 CSS, -20 %)  2 -> 3 (2.40, +20 %)  3 -> 4 (3.20, +6.7 %)
 *   dpr 1.5:   1 -> 2 (1.33, +33 %), capped to 1 (0.67, -33 %)  2 -> 3 (2.00, exact)  3 -> 5 (3.33, +11 %)
 *   dpr 1.75:  1 -> 2 (1.14, +14 %)  2 -> 4 (2.29, +14 %)  3 -> 5 (2.86, -4.8 %)
 *
 * and exact at every whole ratio (1, 2, 3). The window main sizes around him
 * keeps its nominal size (`boxMetrics`), so the renderer lays the sprite out at
 * that effective scale, not the nominal one (`spriteLayout` in
 * `core/geometry.ts`): standing on the window's floor and centred, so a smaller
 * dog has a little more air around him and a larger one uses some of the side
 * padding.
 *
 * **`fit`: never wider than the window.** The art's ink reaches both sides of
 * the stand box, so a box drawn wider than the window loses the tip of his nose
 * or tail. The window is the box plus 8 sprite pixels a side at the nominal
 * scale (`boxMetrics`) — 16 across the shipped 72-pixel box, 22 % of slack — and
 * at a ratio of 1 or more `round` exceeds that only at Small between 150 % and
 * about 163 % (2 device pixels where at most 1.5 to 1.63 fit). There the cap
 * steps down to the largest whole size that does fit: 1, the -33 % above. A
 * capped dog is smaller than nominal, never clipped. Absent `fit` (the sprite
 * gallery, and the tests of the rounding itself) there is no cap; a `fit` with
 * an unusable number in it is ignored rather than allowed to collapse the dog.
 */
export function devicePixelScale(scale: number, dpr: number, fit?: PixelFit): number {
  const ratio = usableDpr(dpr);
  const nearest = Math.max(1, Math.round(scale * ratio));
  if (fit === undefined) return nearest;
  const { room, box } = fit;
  if (!Number.isFinite(room) || !Number.isFinite(box) || room <= 0 || box <= 0) return nearest;
  const widest = Math.floor((room * ratio) / box + FIT_EPSILON);
  return Math.max(1, Math.min(nearest, widest));
}

/**
 * CSS pixels per sprite pixel as the sprite is actually **drawn**:
 * `devicePixelScale(scale, dpr, fit) / dpr`.
 *
 * This, not the nominal `scale`, is what everything that lays the sprite out in
 * CSS pixels has to use — the placement, the alpha hit test, the hover rect,
 * the decoration anchors, the debug outline (QA row 1.8). They all used
 * `scale`, so whenever `scale * dpr` was not whole the box that was drawn and
 * the box that was laid out differed: at 125 % Small the bitmap was 72 device
 * pixels in a box laid out as 90, so the dog stood 20 % smaller than his window
 * with his feet floating above its floor, and the hit test mapped a click onto a
 * sprite pixel up to 20 % of his width away from the one under the cursor. The
 * table of values is on `devicePixelScale`.
 */
export function spriteCssScale(scale: number, dpr: number, fit?: PixelFit): number {
  return devicePixelScale(scale, dpr, fit) / usableDpr(dpr);
}

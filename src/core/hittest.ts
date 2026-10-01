/**
 * Pixel hit-testing for the transparent overlay window: the mascot should only
 * swallow a click where it actually has ink, so transparent pixels stay
 * click-through to whatever is behind the window.
 */

/**
 * The logical coordinate `toLogical` returns when its inputs are unusable.
 *
 * Far enough outside any conceivable sprite that no dilation can pull it back
 * into the mask — which matters, because `isOpaqueAt` deliberately dilates
 * *outward* from the frame. A plain `-1` would be a hit on any frame with ink in
 * its top-left pixel.
 */
export const OFF_SPRITE = -1_000_000;

/**
 * Dilation the overlay hit test uses, in logical sprite pixels. One pixel of
 * slack in every direction, so the outline itself is grabbable. The `?debug=1`
 * outline draws the same radius, or it would lie about the clickable area.
 */
export const HIT_DILATE_PX = 1;

/**
 * Every pixel that is ink in *any* of `masks`, as one mask of the same shape.
 *
 * **Why the hit test is not "the frame on screen" any more (0.2.8 QA).** With
 * the cursor resting on the dog, the hover card hid and came back every four
 * or five seconds: `hit:set false`, `hover:leave`, and `hover:enter` 250 ms
 * later. That is the blink. A blink, an ear-flick, a bark and a pet are all
 * other frames with a slightly different silhouette, so a cursor parked on a
 * pixel the idle pose has and the blink does not was on the dog, then off him
 * for one frame, then on again — and every crossing is a click-through flip in
 * main and a card that hides and re-shows. The overlay asks with the union of
 * the frames he can be showing (the running animation's and his resting loop's)
 * instead, so a stationary cursor has one answer for as long as he stands
 * there. Every pixel in it is still a pixel of his, so clicks use the same mask
 * and stay on the dog.
 *
 * All masks must be the same `width * height`; the caller only offers frames
 * of the box being drawn, and one of another length is skipped rather than
 * folded in misaligned. Returns a fresh array — the inputs are cached per
 * frame and must not be written to.
 */
export function unionMask(masks: readonly Uint8ClampedArray[]): Uint8ClampedArray {
  const first = masks[0];
  if (first === undefined) return new Uint8ClampedArray(0);
  const union = new Uint8ClampedArray(first);
  for (let m = 1; m < masks.length; m++) {
    const mask = masks[m] as Uint8ClampedArray;
    if (mask.length !== union.length) continue;
    for (let i = 0; i < union.length; i++) {
      if ((mask[i] as number) > 0) union[i] = mask[i] as number;
    }
  }
  return union;
}

/**
 * True when any pixel within `dilate` (Chebyshev distance) of (x, y) is opaque.
 * `alpha` is the frame's alpha channel at logical resolution, row-major.
 *
 * The dilation works in both directions: a query point *outside* the frame still
 * hits if an inked pixel lies within the radius, so the very edge of the
 * silhouette is grabbable without pixel-perfect aim. Only a non-finite
 * coordinate, or one further than `dilate` from every inked pixel, is a miss.
 */
export function isOpaqueAt(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  dilate = 1
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

  const px = Math.floor(x);
  const py = Math.floor(y);

  const r = Math.max(0, Math.floor(dilate));
  // Clip the neighbourhood to the frame instead of rejecting an out-of-bounds
  // centre: the point may be off the frame while the pixel next to it is ink.
  const y0 = Math.max(0, py - r);
  const y1 = Math.min(height - 1, py + r);
  const x0 = Math.max(0, px - r);
  const x1 = Math.min(width - 1, px + r);

  for (let ny = y0; ny <= y1; ny++) {
    const rowStart = ny * width;
    for (let nx = x0; nx <= x1; nx++) {
      const a = alpha[rowStart + nx];
      if (a !== undefined && a > 0) return true;
    }
  }
  return false;
}

/**
 * Device/CSS pixel -> logical sprite pixel, for a sprite drawn at `scale` with
 * its top-left at `offset` along that axis.
 *
 * Never returns `NaN` or `±Infinity`. `scale` comes from measured layout, so a
 * window that is still 0x0 (or mid-teardown) yields `scale = 0` and a raw
 * divide would hand `isOpaqueAt` a non-finite coordinate. Any unusable input —
 * a non-positive or non-finite `scale`, a non-finite `px`/`offset` — returns
 * `OFF_SPRITE`: finite, but far enough out that no dilation reaches the mask, so
 * the caller reads it as "off the sprite" and the click stays click-through.
 */
export function toLogical(px: number, scale: number, offset: number): number {
  if (!Number.isFinite(px) || !Number.isFinite(offset)) return OFF_SPRITE;
  if (!Number.isFinite(scale) || scale <= 0) return OFF_SPRITE;
  const logical = Math.floor((px - offset) / scale);
  return Number.isFinite(logical) ? logical : OFF_SPRITE;
}

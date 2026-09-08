/**
 * Pixel hit-testing for the transparent overlay window: the mascot should only
 * swallow a click where it actually has ink, so transparent pixels stay
 * click-through to whatever is behind the window.
 */

/**
 * True when any pixel within `dilate` (Chebyshev distance) of (x, y) is opaque.
 * `alpha` is the frame's alpha channel at logical resolution, row-major.
 * A query point outside the frame is never a hit.
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
  if (px < 0 || py < 0 || px >= width || py >= height) return false;

  const r = Math.max(0, Math.floor(dilate));
  for (let dy = -r; dy <= r; dy++) {
    const ny = py + dy;
    if (ny < 0 || ny >= height) continue;
    const rowStart = ny * width;
    for (let dx = -r; dx <= r; dx++) {
      const nx = px + dx;
      if (nx < 0 || nx >= width) continue;
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
 * `-1`: deliberately out of bounds, so the caller reads it as "off the sprite"
 * and the click stays click-through rather than being swallowed.
 */
export function toLogical(px: number, scale: number, offset: number): number {
  if (!Number.isFinite(px) || !Number.isFinite(offset)) return -1;
  if (!Number.isFinite(scale) || scale <= 0) return -1;
  const logical = Math.floor((px - offset) / scale);
  return Number.isFinite(logical) ? logical : -1;
}

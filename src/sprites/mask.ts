/**
 * Frame geometry and alpha masks.
 *
 * Split out of `render.ts` on purpose: `render.ts` needs DOM canvas types, this
 * does not, so the hit-test path stays testable under vitest's node environment
 * and importable from the main process. `render.ts` re-exports both symbols, so
 * renderer code can keep importing everything sprite-shaped from one module.
 */
import type { Frame } from './types';
import { TRANSPARENT } from './types';

export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Logical pixel size of a frame, read from the rows themselves.
 *
 * `validateSheet` has already proved rows are rectangular and match the frame's
 * declared box, so the rows are authoritative and no box lookup is needed here.
 */
export function frameSize(frame: Frame): FrameSize {
  const height = frame.rows.length;
  const width = height === 0 ? 0 : (frame.rows[0] as string).length;
  return { width, height };
}

/**
 * Alpha channel of a frame at logical resolution, row-major: 1 where the frame
 * has ink, 0 where it is transparent.
 *
 * This is the input `isOpaqueAt` in `src/core/hittest.ts` expects; it is what
 * decides whether a click lands on the dog or passes through to the window
 * behind, so it must never report ink where the sprite has none.
 */
export function frameAlphaMask(frame: Frame): Uint8ClampedArray {
  const { width, height } = frameSize(frame);
  const mask = new Uint8ClampedArray(width * height);

  for (let y = 0; y < height; y++) {
    const row = frame.rows[y] as string;
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      if (row[x] !== TRANSPARENT) mask[rowStart + x] = 1;
    }
  }

  return mask;
}

/** Bounding box of a mask's ink, or `null` when the frame is entirely empty. */
export interface MaskBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Tight bounds of the inked pixels. Used only by the `?debug=1` hit-area
 * outline; returns `null` for an empty mask so callers draw nothing.
 */
export function maskBounds(
  mask: Uint8ClampedArray,
  width: number,
  height: number
): MaskBounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      if ((mask[rowStart + x] ?? 0) === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

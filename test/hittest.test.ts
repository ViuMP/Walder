import { describe, expect, it } from 'vitest';

import { HIT_DILATE_PX, OFF_SPRITE, isOpaqueAt, toLogical } from '../src/core/hittest.js';

const W = 4;
const H = 4;

/** 4x4 alpha channel with a single opaque pixel at (2, 1). */
function singlePixel(): Uint8ClampedArray {
  const a = new Uint8ClampedArray(W * H);
  a[1 * W + 2] = 255;
  return a;
}

/** 4x4 alpha channel with a single opaque pixel at the top-left corner. */
function cornerPixel(): Uint8ClampedArray {
  const a = new Uint8ClampedArray(W * H);
  a[0] = 255;
  return a;
}

describe('isOpaqueAt', () => {
  const alpha = singlePixel();

  it('hits the opaque pixel itself with no dilation', () => {
    expect(isOpaqueAt(alpha, W, H, 2, 1, 0)).toBe(true);
  });

  it('misses a transparent neighbour with no dilation', () => {
    expect(isOpaqueAt(alpha, W, H, 1, 1, 0)).toBe(false);
    expect(isOpaqueAt(alpha, W, H, 2, 2, 0)).toBe(false);
  });

  it('hits Chebyshev-adjacent pixels when dilated by 1', () => {
    // 8-neighbourhood of (2, 1), including diagonals.
    for (const [x, y] of [
      [1, 0],
      [2, 0],
      [3, 0],
      [1, 1],
      [3, 1],
      [1, 2],
      [2, 2],
      [3, 2]
    ] as const) {
      expect(isOpaqueAt(alpha, W, H, x, y, 1), `(${x},${y})`).toBe(true);
    }
  });

  it('stops at the dilation radius', () => {
    expect(isOpaqueAt(alpha, W, H, 0, 1, 1)).toBe(false);
    expect(isOpaqueAt(alpha, W, H, 0, 1, 2)).toBe(true);
    expect(isOpaqueAt(alpha, W, H, 2, 3, 1)).toBe(false);
    expect(isOpaqueAt(alpha, W, H, 2, 3, 2)).toBe(true);
  });

  it('defaults to a dilation of 1', () => {
    expect(isOpaqueAt(alpha, W, H, 1, 1)).toBe(true);
    expect(isOpaqueAt(alpha, W, H, 0, 1)).toBe(false);
  });

  it('dilates outward: a point just off the frame still hits adjacent ink', () => {
    // The whole point of dilating outward. Ink at (0, 0), so a click one pixel
    // left of, above, or diagonally off the frame is still on the dog.
    const corner = cornerPixel();
    expect(isOpaqueAt(corner, W, H, -1, 0, 1)).toBe(true);
    expect(isOpaqueAt(corner, W, H, 0, -1, 1)).toBe(true);
    expect(isOpaqueAt(corner, W, H, -1, -1, 1)).toBe(true);
    // ...and off the far edges, against ink at (3, 3).
    const far = new Uint8ClampedArray(W * H);
    far[3 * W + 3] = 255;
    expect(isOpaqueAt(far, W, H, W, 3, 1)).toBe(true);
    expect(isOpaqueAt(far, W, H, 3, H, 1)).toBe(true);
  });

  it('misses an out-of-bounds point that is further than the dilation radius', () => {
    // x = -1 with dilate 1 reaches column 0 only; the ink is at column 2.
    expect(isOpaqueAt(alpha, W, H, -1, 1, 1)).toBe(false);
    expect(isOpaqueAt(cornerPixel(), W, H, -2, 0, 1)).toBe(false);
    expect(isOpaqueAt(alpha, W, H, 1, -3, 1)).toBe(false);
    expect(isOpaqueAt(alpha, W, H, W + 2, 1, 1)).toBe(false);
  });

  it('reaches inward from outside when the radius is large enough', () => {
    // Same query point as above, wider radius: -1 + 5 spans past column 2.
    expect(isOpaqueAt(alpha, W, H, -1, 1, 5)).toBe(true);
  });

  it('treats a non-finite query point as a miss at any radius', () => {
    expect(isOpaqueAt(alpha, W, H, Number.NaN, 1)).toBe(false);
    expect(isOpaqueAt(alpha, W, H, 1, Number.NaN, 99)).toBe(false);
    expect(isOpaqueAt(alpha, W, H, Number.POSITIVE_INFINITY, 1, 99)).toBe(false);
  });

  it('is never rescued by dilation at the OFF_SPRITE sentinel', () => {
    // toLogical returns OFF_SPRITE for unusable input, and outward dilation must
    // not turn that into a hit on a frame with ink in its corner — that would
    // swallow clicks whenever the window is momentarily unmeasurable.
    const corner = cornerPixel();
    expect(isOpaqueAt(corner, W, H, OFF_SPRITE, 0, HIT_DILATE_PX)).toBe(false);
    expect(isOpaqueAt(corner, W, H, OFF_SPRITE, OFF_SPRITE, HIT_DILATE_PX)).toBe(false);
    expect(isOpaqueAt(corner, W, H, 0, OFF_SPRITE, 1000)).toBe(false);
  });

  it('floors fractional coordinates onto the containing pixel', () => {
    expect(isOpaqueAt(alpha, W, H, 2.9, 1.9, 0)).toBe(true);
    expect(isOpaqueAt(alpha, W, H, 3.0, 1.0, 0)).toBe(false);
  });

  it('never hits on a fully transparent frame', () => {
    const blank = new Uint8ClampedArray(W * H);
    expect(isOpaqueAt(blank, W, H, 2, 1, 3)).toBe(false);
  });

  it('counts partially transparent pixels as ink', () => {
    const faint = new Uint8ClampedArray(W * H);
    faint[1 * W + 2] = 1;
    expect(isOpaqueAt(faint, W, H, 2, 1, 0)).toBe(true);
  });

  it('returns false rather than throwing when alpha is shorter than w*h', () => {
    // A truncated or not-yet-filled buffer: every read past the end is a miss.
    const short = new Uint8ClampedArray(3);
    expect(() => isOpaqueAt(short, W, H, 2, 1, 0)).not.toThrow();
    expect(isOpaqueAt(short, W, H, 2, 1, 0)).toBe(false);
    expect(isOpaqueAt(short, W, H, 2, 3, 3)).toBe(false);
    expect(isOpaqueAt(short, W, H, 3, 3, 0)).toBe(false);

    // In-range pixels of a short buffer still read correctly.
    short[0] = 255;
    expect(isOpaqueAt(short, W, H, 0, 0, 0)).toBe(true);
  });

  it('returns false for an empty alpha buffer', () => {
    const empty = new Uint8ClampedArray(0);
    expect(isOpaqueAt(empty, W, H, 0, 0, 5)).toBe(false);
  });
});

describe('toLogical', () => {
  it('converts at 2x with no offset', () => {
    expect(toLogical(0, 2, 0)).toBe(0);
    expect(toLogical(10, 2, 0)).toBe(5);
    expect(toLogical(11, 2, 0)).toBe(5);
  });

  it('converts at 3x with an offset', () => {
    expect(toLogical(4, 3, 4)).toBe(0);
    expect(toLogical(31, 3, 4)).toBe(9);
    expect(toLogical(33, 3, 4)).toBe(9);
    expect(toLogical(34, 3, 4)).toBe(10);
  });

  it('goes negative left of the sprite origin', () => {
    expect(toLogical(3, 2, 4)).toBe(-1);
  });

  it('returns the safe OFF_SPRITE sentinel for a zero or negative scale', () => {
    // A window still measuring 0x0 yields scale 0; a raw divide would hand
    // isOpaqueAt Infinity/NaN. OFF_SPRITE is far out of bounds, so the click
    // passes through — and stays out of bounds under dilation, which a plain -1
    // would not.
    expect(toLogical(10, 0, 0)).toBe(OFF_SPRITE);
    expect(toLogical(0, 0, 0)).toBe(OFF_SPRITE);
    expect(toLogical(-10, 0, 0)).toBe(OFF_SPRITE);
    expect(toLogical(10, 0, 4)).toBe(OFF_SPRITE);
    expect(toLogical(10, -2, 0)).toBe(OFF_SPRITE);
  });

  it('returns OFF_SPRITE for non-finite inputs', () => {
    expect(toLogical(Number.NaN, 2, 0)).toBe(OFF_SPRITE);
    expect(toLogical(10, Number.NaN, 0)).toBe(OFF_SPRITE);
    expect(toLogical(10, 2, Number.NaN)).toBe(OFF_SPRITE);
    expect(toLogical(Number.POSITIVE_INFINITY, 2, 0)).toBe(OFF_SPRITE);
    expect(toLogical(10, Number.POSITIVE_INFINITY, 0)).toBe(OFF_SPRITE);
  });

  it('still returns a plain -1 for a point genuinely one pixel left of the sprite', () => {
    // Not the sentinel: this is a real coordinate that dilation *should* rescue.
    expect(toLogical(3, 2, 4)).toBe(-1);
    expect(toLogical(3, 2, 4)).not.toBe(OFF_SPRITE);
  });

  it('never hands isOpaqueAt a non-finite coordinate, and its sentinel never hits', () => {
    const alpha = new Uint8ClampedArray(W * H).fill(255);
    const x = toLogical(10, 0, 0);
    expect(Number.isFinite(x)).toBe(true);
    expect(isOpaqueAt(alpha, W, H, x, x, 0)).toBe(false);
    // Fully inked frame, default dilation: still a miss.
    expect(isOpaqueAt(alpha, W, H, x, x)).toBe(false);
  });
});

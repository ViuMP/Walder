import { describe, expect, it } from 'vitest';

import { isOpaqueAt, toLogical } from '../src/core/hittest.js';

const W = 4;
const H = 4;

/** 4x4 alpha channel with a single opaque pixel at (2, 1). */
function singlePixel(): Uint8ClampedArray {
  const a = new Uint8ClampedArray(W * H);
  a[1 * W + 2] = 255;
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

  it('treats any out-of-bounds query point as a miss', () => {
    expect(isOpaqueAt(alpha, W, H, -1, 1, 5)).toBe(false);
    expect(isOpaqueAt(alpha, W, H, 1, -1, 5)).toBe(false);
    expect(isOpaqueAt(alpha, W, H, W, 1, 5)).toBe(false);
    expect(isOpaqueAt(alpha, W, H, 1, H, 5)).toBe(false);
    expect(isOpaqueAt(alpha, W, H, Number.NaN, 1)).toBe(false);
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

  it('returns the safe off-sprite -1 for a zero or negative scale', () => {
    // A window still measuring 0x0 yields scale 0; a raw divide would hand
    // isOpaqueAt Infinity/NaN. -1 is out of bounds, so the click passes through.
    expect(toLogical(10, 0, 0)).toBe(-1);
    expect(toLogical(0, 0, 0)).toBe(-1);
    expect(toLogical(-10, 0, 0)).toBe(-1);
    expect(toLogical(10, 0, 4)).toBe(-1);
    expect(toLogical(10, -2, 0)).toBe(-1);
  });

  it('returns -1 for non-finite inputs', () => {
    expect(toLogical(Number.NaN, 2, 0)).toBe(-1);
    expect(toLogical(10, Number.NaN, 0)).toBe(-1);
    expect(toLogical(10, 2, Number.NaN)).toBe(-1);
    expect(toLogical(Number.POSITIVE_INFINITY, 2, 0)).toBe(-1);
    expect(toLogical(10, Number.POSITIVE_INFINITY, 0)).toBe(-1);
  });

  it('never hands isOpaqueAt a non-finite coordinate', () => {
    const alpha = new Uint8ClampedArray(W * H).fill(255);
    const x = toLogical(10, 0, 0);
    expect(Number.isFinite(x)).toBe(true);
    expect(isOpaqueAt(alpha, W, H, x, x, 0)).toBe(false);
  });
});

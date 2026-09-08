/**
 * Frame rasterisation: the exact rectangles the dog is made of, and the integer
 * device-pixel scale they are drawn at.
 *
 * The run-length coalescing is what keeps the mascot under its CPU budget (one
 * fill per run instead of one per pixel), and a bug there is invisible in the
 * aggregate — the dog still looks like a dog while a row is a pixel short. The
 * fills are recorded by a stub context, which is why `rasteriseFrame` takes the
 * narrowest possible target rather than a real canvas.
 *
 * `devicePixelScale` is the fractional-DPR fix: 1.5 dpr at scale 3 is 4.5 device
 * pixels per sprite pixel, and drawing *that* makes some sprite pixels 4 device
 * pixels wide and others 5 — a visibly uneven dog.
 */
import { describe, expect, it } from 'vitest';
import { devicePixelScale, rasteriseFrame, type FillTarget } from '../src/sprites/raster';
import type { Frame, Palette } from '../src/sprites/types';

interface Fill {
  readonly color: unknown;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A stand-in for a 2D context that records the fills it is asked for. */
function recorder(): { target: FillTarget; fills: Fill[] } {
  const fills: Fill[] = [];
  const target: FillTarget = {
    fillStyle: '',
    fillRect(x: number, y: number, w: number, h: number): void {
      fills.push({ color: target.fillStyle, x, y, w, h });
    }
  };
  return { target, fills };
}

const PALETTE: Palette = { a: '#aa0000', b: '#0000bb', c: '#00cc00' };

function frame(rows: readonly string[]): Frame {
  return { box: 'test', rows };
}

describe('rasteriseFrame', () => {
  it('coalesces a run of one colour into a single fill', () => {
    const { target, fills } = recorder();
    rasteriseFrame(frame(['aaaa']), PALETTE, 1, target);
    expect(fills).toEqual([{ color: '#aa0000', x: 0, y: 0, w: 4, h: 1 }]);
  });

  it('breaks a run at a colour change', () => {
    const { target, fills } = recorder();
    rasteriseFrame(frame(['aabb']), PALETTE, 1, target);
    expect(fills).toEqual([
      { color: '#aa0000', x: 0, y: 0, w: 2, h: 1 },
      { color: '#0000bb', x: 2, y: 0, w: 2, h: 1 }
    ]);
  });

  it('breaks a run at a transparent cell and skips it', () => {
    const { target, fills } = recorder();
    rasteriseFrame(frame(['aa.aa']), PALETTE, 1, target);
    expect(fills).toEqual([
      { color: '#aa0000', x: 0, y: 0, w: 2, h: 1 },
      { color: '#aa0000', x: 3, y: 0, w: 2, h: 1 }
    ]);
  });

  it('does not coalesce across rows', () => {
    // One fill per row per run: a run is horizontal, and merging vertically would
    // need a second pass for no measurable gain on this sprite size.
    const { target, fills } = recorder();
    rasteriseFrame(frame(['aa', 'aa']), PALETTE, 1, target);
    expect(fills).toEqual([
      { color: '#aa0000', x: 0, y: 0, w: 2, h: 1 },
      { color: '#aa0000', x: 0, y: 1, w: 2, h: 1 }
    ]);
  });

  it('emits nothing at all for a fully transparent frame', () => {
    const { target, fills } = recorder();
    rasteriseFrame(frame(['....', '....']), PALETTE, 3, target);
    expect(fills).toEqual([]);
  });

  it('multiplies every coordinate and size by the pixel scale', () => {
    const { target, fills } = recorder();
    rasteriseFrame(frame(['.aab', '...c']), PALETTE, 4, target);
    expect(fills).toEqual([
      { color: '#aa0000', x: 4, y: 0, w: 8, h: 4 },
      { color: '#0000bb', x: 12, y: 0, w: 4, h: 4 },
      { color: '#00cc00', x: 12, y: 4, w: 4, h: 4 }
    ]);
  });

  it('leaves a hole for a key the palette does not define, without throwing', () => {
    // validateSheet rules this out for sheet palettes; a hand-edited one could
    // still miss a key, and a missing pixel beats a dead renderer.
    const { target, fills } = recorder();
    rasteriseFrame(frame(['aza']), PALETTE, 1, target);
    expect(fills).toEqual([
      { color: '#aa0000', x: 0, y: 0, w: 1, h: 1 },
      { color: '#aa0000', x: 2, y: 0, w: 1, h: 1 }
    ]);
  });

  it('handles a zero-row frame as a no-op', () => {
    const { target, fills } = recorder();
    rasteriseFrame(frame([]), PALETTE, 2, target);
    expect(fills).toEqual([]);
  });

  it('covers every inked pixel exactly once', () => {
    // The property that matters: total filled area equals the ink count, with no
    // overlap and nothing missed.
    const rows = ['aab.c', '.bb.a', 'ccccc'];
    const { target, fills } = recorder();
    rasteriseFrame(frame(rows), PALETTE, 2, target);
    const inked = rows.join('').split('').filter((ch) => ch !== '.').length;
    const area = fills.reduce((sum, f) => sum + f.w * f.h, 0);
    expect(area).toBe(inked * 2 * 2);
    // Fills are emitted in row-major order, so y never goes backwards.
    const ys = fills.map((f) => f.y);
    expect([...ys].sort((p, q) => p - q)).toEqual(ys);
  });
});

describe('devicePixelScale', () => {
  it('multiplies through exactly when the product is a whole number', () => {
    expect(devicePixelScale(3, 1)).toBe(3);
    expect(devicePixelScale(3, 2)).toBe(6);
    expect(devicePixelScale(2, 2)).toBe(4);
    expect(devicePixelScale(4, 2)).toBe(8);
  });

  it('rounds a fractional product to a whole number of device pixels', () => {
    // 1.5 dpr at scale 3 is 4.5: every sprite pixel gets 5 device pixels rather
    // than a mix of 4s and 5s. The dog ends up a fraction of a percent large.
    expect(devicePixelScale(3, 1.5)).toBe(5);
    expect(devicePixelScale(2, 1.5)).toBe(3);
    expect(devicePixelScale(4, 1.5)).toBe(6);
    expect(devicePixelScale(3, 1.25)).toBe(4);
    expect(devicePixelScale(3, 2.25)).toBe(7);
  });

  it('always returns a positive integer', () => {
    for (const scale of [2, 3, 4]) {
      for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
        const pixel = devicePixelScale(scale, dpr);
        expect(Number.isInteger(pixel)).toBe(true);
        expect(pixel).toBeGreaterThan(0);
      }
    }
  });

  it('never collapses to zero, however small the inputs', () => {
    expect(devicePixelScale(1, 0.4)).toBe(1);
    expect(devicePixelScale(0.1, 0.1)).toBe(1);
  });

  it('treats an unusable ratio as 1 rather than producing nonsense', () => {
    // `window.devicePixelRatio` can be 0 on a window that is still 0x0.
    expect(devicePixelScale(3, 0)).toBe(3);
    expect(devicePixelScale(3, Number.NaN)).toBe(3);
    expect(devicePixelScale(3, -2)).toBe(3);
    expect(devicePixelScale(3, Number.POSITIVE_INFINITY)).toBe(3);
  });
});

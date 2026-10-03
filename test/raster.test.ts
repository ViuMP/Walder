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
 *
 * The price of a whole number is that the dog is not his nominal size, by up to
 * a third at the Windows scale factors — not "a fraction of a percent", which is
 * what this file used to say and is only true when `scale * dpr` is already
 * whole. `spriteCssScale` is the size he is actually drawn at, in CSS pixels,
 * and everything that lays him out reads it (QA row 1.8, owner at 125 %).
 */
import { describe, expect, it } from 'vitest';
import {
  devicePixelScale,
  rasteriseFrame,
  spriteCssScale,
  usableDpr,
  type FillTarget,
  type PixelFit
} from '../src/sprites/raster';
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
    // than a mix of 4s and 5s. The dog ends up 11 % large — see spriteCssScale.
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

/**
 * The shipped stand box is 72 sprite pixels wide and the window gives it 8 more
 * a side at the nominal scale (`boxMetrics`), so the fit the overlay passes is
 * the stand window's width against the box's. Written out here rather than read
 * from `spriteFit` so this file pins the arithmetic, not the plumbing;
 * `test/geometry.test.ts` checks `spriteFit` builds the same thing.
 */
const STAND_WIDTH = 72;
const SIDE_PAD = 8;
function standFit(scale: number): PixelFit {
  return { room: (STAND_WIDTH + 2 * SIDE_PAD) * scale, box: STAND_WIDTH };
}

describe('spriteCssScale: the size the dog is actually drawn at (QA row 1.8)', () => {
  /*
   * The owner's report, 2026-10-03, 125 % display scaling, Size Small: the dog was
   * crisp but drawn at 1 device pixel per sprite pixel — 72 physical pixels wide in
   * a box laid out as 90 — so he was 20 % smaller than his window, with his feet
   * floating above its floor. Every row of the table below is a case where the
   * drawn size and the nominal one differ, and the layout must use the drawn one.
   */
  const TABLE: ReadonlyArray<{ dpr: number; scale: number; device: number; css: number }> = [
    { dpr: 1.25, scale: 1, device: 1, css: 0.8 },
    { dpr: 1.25, scale: 2, device: 3, css: 2.4 },
    { dpr: 1.25, scale: 3, device: 4, css: 3.2 },
    { dpr: 1.5, scale: 1, device: 2, css: 4 / 3 },
    { dpr: 1.5, scale: 2, device: 3, css: 2 },
    { dpr: 1.5, scale: 3, device: 5, css: 10 / 3 },
    { dpr: 1.75, scale: 1, device: 2, css: 2 / 1.75 },
    { dpr: 1.75, scale: 2, device: 4, css: 4 / 1.75 },
    { dpr: 1.75, scale: 3, device: 5, css: 5 / 1.75 }
  ];

  for (const { dpr, scale, device, css } of TABLE) {
    it(`scale ${scale} at dpr ${dpr} is ${device} device px, ${css.toFixed(3)} CSS px per sprite px`, () => {
      expect(devicePixelScale(scale, dpr)).toBe(device);
      expect(spriteCssScale(scale, dpr)).toBeCloseTo(css, 12);
      // The identity the whole fix rests on: CSS size times dpr is the device size.
      expect(spriteCssScale(scale, dpr) * dpr).toBeCloseTo(devicePixelScale(scale, dpr), 12);
    });
  }

  it('is the nominal scale exactly at every whole ratio', () => {
    for (const scale of [1, 2, 3]) {
      for (const dpr of [1, 2, 3]) expect(spriteCssScale(scale, dpr)).toBe(scale);
    }
  });

  it('is 20 % under nominal at 125 % Small — the reported case', () => {
    expect(spriteCssScale(1, 1.25) / 1).toBeCloseTo(0.8, 12);
    // 72 sprite pixels across: 72 physical pixels drawn, 90 nominal.
    expect(STAND_WIDTH * devicePixelScale(1, 1.25)).toBe(72);
    expect(STAND_WIDTH * 1 * 1.25).toBe(90);
  });

  it('divides by the same sanitised ratio devicePixelScale multiplied by', () => {
    expect(spriteCssScale(3, 0)).toBe(3);
    expect(spriteCssScale(3, Number.NaN)).toBe(3);
    expect(usableDpr(0)).toBe(1);
    expect(usableDpr(-1.5)).toBe(1);
    expect(usableDpr(Number.POSITIVE_INFINITY)).toBe(1);
    expect(usableDpr(1.25)).toBe(1.25);
  });
});

describe('devicePixelScale with a fit: never wider than the window', () => {
  it('leaves every Windows-scale case alone except Small at 150 %', () => {
    for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 3.5]) {
      for (const scale of [1, 2, 3]) {
        const capped = devicePixelScale(scale, dpr, standFit(scale));
        const uncapped = devicePixelScale(scale, dpr);
        if (scale === 1 && dpr === 1.5) continue;
        expect(capped, `scale ${scale} dpr ${dpr}`).toBe(uncapped);
      }
    }
  });

  it('steps Small at 150 % down to 1 device px, because 2 would not fit', () => {
    // round(1.5) is 2, which draws the 72-pixel box 144 device pixels wide in a
    // window of 88 * 1.5 = 132: 6 device pixels of nose and tail cut off a side.
    expect(devicePixelScale(1, 1.5)).toBe(2);
    expect(STAND_WIDTH * 2).toBeGreaterThan(standFit(1).room * 1.5);
    expect(devicePixelScale(1, 1.5, standFit(1))).toBe(1);
    expect(spriteCssScale(1, 1.5, standFit(1))).toBeCloseTo(2 / 3, 12);
  });

  it('always fits the box inside the room when one device pixel does', () => {
    for (let dpr = 1; dpr <= 4; dpr += 0.05) {
      for (const scale of [1, 2, 3]) {
        const fit = standFit(scale);
        const pixel = devicePixelScale(scale, dpr, fit);
        expect(STAND_WIDTH * pixel, `scale ${scale} dpr ${dpr}`).toBeLessThanOrEqual(
          fit.room * dpr + 1e-6
        );
      }
    }
  });

  it('keeps a size that fits exactly, despite floating-point noise', () => {
    // 200 CSS px at dpr 1.13 is exactly 226 device px, room for exactly 2 per
    // pixel of a 113-pixel box — but 200 * 1.13 / 113 is 1.9999999999999998 in
    // floating point, and a bare floor would take a device pixel that fits.
    expect((200 * 1.13) / 113).toBeLessThan(2);
    expect(devicePixelScale(2, 1.13, { room: 200, box: 113 })).toBe(2);
  });

  it('never collapses below 1, and ignores an unusable fit', () => {
    expect(devicePixelScale(3, 2, { room: 1, box: 72 })).toBe(1);
    expect(devicePixelScale(3, 2, { room: 0, box: 72 })).toBe(6);
    expect(devicePixelScale(3, 2, { room: 264, box: 0 })).toBe(6);
    expect(devicePixelScale(3, 2, { room: Number.NaN, box: 72 })).toBe(6);
  });
});

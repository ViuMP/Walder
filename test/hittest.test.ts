import { describe, expect, it } from 'vitest';

import {
  HIT_DILATE_PX,
  OFF_SPRITE,
  isOpaqueAt,
  toLogical,
  unionMask
} from '../src/core/hittest.js';
import { HOVER_INITIAL, hoverMove, hoverRetest } from '../src/core/interaction.js';
import { boxMetrics, spriteFit, spriteLayout, spriteOrigin } from '../src/core/geometry.js';
import { devicePixelScale } from '../src/sprites/raster.js';

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

/**
 * QA rows 1.4 / 1.5 / 1.8 at 125 % display scaling: the hit test must map a
 * click through the size the dog is *drawn* at, not his nominal size.
 *
 * At Size Small and dpr 1.25 the bitmap is drawn at 1 device pixel per sprite
 * pixel (`devicePixelScale` rounds 1.25 to 1), i.e. 0.8 CSS px per sprite pixel,
 * standing on the window's floor. The old mapping divided by the nominal scale
 * (1) from the nominal box's origin, so it answered for a dog 25 % bigger than the
 * one on screen — a click on his far side was tested against a pixel well inside
 * him, and a click on the transparent air beside him against his ink.
 */
describe('toLogical through the drawn layout at a fractional scale factor', () => {
  const STAND_BOX = { width: 72, height: 72 };
  const SCALE = 1;
  const DPR = 1.25;
  const small = boxMetrics(SCALE, STAND_BOX, true);
  const pixelScale = devicePixelScale(SCALE, DPR, spriteFit(SCALE, STAND_BOX));
  const layout = spriteLayout({
    viewWidth: small.width,
    viewHeight: small.height,
    box: STAND_BOX,
    scale: SCALE,
    pixelScale,
    dpr: DPR
  });

  /** The CSS point at the centre of device pixel (dx, dy) — where a click lands. */
  function cssAt(dx: number, dy: number): { x: number; y: number } {
    return { x: (dx + 0.5) / DPR, y: (dy + 0.5) / DPR };
  }

  it('is drawn at 1 device px, 0.8 CSS px, per sprite pixel', () => {
    expect(layout.pixelScale).toBe(1);
    expect(layout.cssScale).toBeCloseTo(0.8, 12);
  });

  it('maps a click on a drawn pixel back to that sprite pixel', () => {
    // Sprite pixel (70, 71): a back foot, bottom row, near the right edge.
    const sprite = { x: 70, y: 71 };
    const click = cssAt(layout.device.x + sprite.x, layout.device.y + sprite.y);
    expect(toLogical(click.x, layout.cssScale, layout.css.x)).toBe(sprite.x);
    expect(toLogical(click.y, layout.cssScale, layout.css.y)).toBe(sprite.y);

    const alpha = new Uint8ClampedArray(STAND_BOX.width * STAND_BOX.height);
    alpha[sprite.y * STAND_BOX.width + sprite.x] = 255;
    const hit = isOpaqueAt(
      alpha, STAND_BOX.width, STAND_BOX.height,
      toLogical(click.x, layout.cssScale, layout.css.x),
      toLogical(click.y, layout.cssScale, layout.css.y),
      HIT_DILATE_PX
    );
    expect(hit).toBe(true);
  });

  it('is a pixel the old nominal mapping missed by a fifth of the way across', () => {
    const sprite = { x: 70, y: 71 };
    const click = cssAt(layout.device.x + sprite.x, layout.device.y + sprite.y);
    // What onInk used to do: the nominal origin, divided by the nominal scale.
    const nominal = spriteOrigin(small.width, small.height, STAND_BOX.width, STAND_BOX.height, SCALE);
    const oldX = toLogical(click.x, SCALE, nominal.x);
    // The old mapping is the new one scaled by 0.8 about the nominal origin, so
    // across the 72-pixel box it falls short by up to a fifth: 7 pixels here,
    // far beyond the one pixel of dilation.
    expect(sprite.x - oldX).toBeGreaterThan(HIT_DILATE_PX);
    expect(sprite.x - oldX).toBe(7);

    const alpha = new Uint8ClampedArray(STAND_BOX.width * STAND_BOX.height);
    alpha[sprite.y * STAND_BOX.width + sprite.x] = 255;
    const oldY = toLogical(click.y, SCALE, nominal.y);
    expect(isOpaqueAt(alpha, STAND_BOX.width, STAND_BOX.height, oldX, oldY, HIT_DILATE_PX)).toBe(
      false
    );
  });

  it('maps every drawn device pixel to the sprite pixel it belongs to', () => {
    // Per axis, at 125 % for all three sizes: device pixel d of the sprite belongs
    // to sprite pixel floor(d / pixelScale), and the click there must say so.
    for (const scale of [1, 2, 3]) {
      const win = boxMetrics(scale, STAND_BOX, true);
      const at = spriteLayout({
        viewWidth: win.width,
        viewHeight: win.height,
        box: STAND_BOX,
        scale,
        pixelScale: devicePixelScale(scale, DPR, spriteFit(scale, STAND_BOX)),
        dpr: DPR
      });
      for (let d = 0; d < STAND_BOX.width * at.pixelScale; d++) {
        const click = cssAt(at.device.x + d, at.device.y + d);
        const expected = Math.floor(d / at.pixelScale);
        expect(toLogical(click.x, at.cssScale, at.css.x), `scale ${scale} x ${d}`).toBe(expected);
        expect(toLogical(click.y, at.cssScale, at.css.y), `scale ${scale} y ${d}`).toBe(expected);
      }
    }
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

/*
 * 0.2.8 QA: the hover card hid and came back every 4-5 s under a resting
 * cursor, because the hit mask was the frame of the moment and a blink is
 * another frame. Frame A has the head pixel at (3, 0) — eyes open, ear up — and
 * blink frame B does not; both share the body row.
 */
describe('unionMask', () => {
  const frameA = (): Uint8ClampedArray => {
    const a = new Uint8ClampedArray(W * H);
    a[0 * W + 3] = 1;
    for (let x = 0; x < W; x++) a[3 * W + x] = 1;
    return a;
  };
  const frameB = (): Uint8ClampedArray => {
    const b = new Uint8ClampedArray(W * H);
    b[1 * W + 0] = 1;
    for (let x = 0; x < W; x++) b[3 * W + x] = 1;
    return b;
  };

  it('holds every pixel of every frame, and nothing else', () => {
    const union = unionMask([frameA(), frameB()]);
    expect(isOpaqueAt(union, W, H, 3, 0, 0)).toBe(true);
    expect(isOpaqueAt(union, W, H, 0, 1, 0)).toBe(true);
    expect(isOpaqueAt(union, W, H, 2, 3, 0)).toBe(true);
    expect(isOpaqueAt(union, W, H, 1, 1, 0)).toBe(false);
    expect(Array.from(union).filter((a) => a > 0)).toHaveLength(2 + W);
  });

  it('does not write to the cached masks it was given', () => {
    const a = frameA();
    const before = Array.from(a);
    unionMask([a, frameB()]);
    expect(Array.from(a)).toEqual(before);
  });

  it('skips a mask of another shape instead of folding it in misaligned', () => {
    const odd = new Uint8ClampedArray(W * H + 1).fill(1);
    expect(Array.from(unionMask([frameA(), odd]))).toEqual(Array.from(frameA()));
    expect(unionMask([])).toHaveLength(0);
  });

  it('keeps hover steady across a blink for a cursor on A but not on B', () => {
    // (3, 0) is A's ear, one pixel from nothing in B: with the dilation the
    // overlay uses, B alone says "off" there (no B pixel within 1 of it).
    expect(isOpaqueAt(frameA(), W, H, 3, 0, HIT_DILATE_PX)).toBe(true);
    expect(isOpaqueAt(frameB(), W, H, 3, 0, HIT_DILATE_PX)).toBe(false);

    // The old probe — the frame of the moment — flips on every blink.
    let showing = frameA();
    const perFrame = (x: number, y: number): boolean =>
      isOpaqueAt(showing, W, H, x, y, HIT_DILATE_PX);
    const entered = hoverMove(HOVER_INITIAL, 3, 0, false, perFrame);
    showing = frameB();
    expect(hoverRetest(entered.state, false, perFrame).notify).toBe(true);

    // The union probe: same verdict on both frames, so nothing is ever sent.
    const union = unionMask([frameA(), frameB()]);
    const steady = (x: number, y: number): boolean => isOpaqueAt(union, W, H, x, y, HIT_DILATE_PX);
    const on = hoverMove(HOVER_INITIAL, 3, 0, false, steady);
    expect(on.state.inside).toBe(true);
    for (let blink = 0; blink < 4; blink++) {
      expect(hoverRetest(on.state, false, steady)).toEqual({ state: on.state, notify: false });
    }
  });
});

/**
 * The mirrored hit path, composed exactly as the renderer composes it.
 *
 * `facing.test.ts` proves `mirrorLogicalX` is a correct reflection and
 * `hittest.test.ts` proves `isOpaqueAt` dilates the way it says it does. Neither
 * proves the thing that can actually put a bug on the owner's desktop: that
 * `overlay.ts`'s `onInk` chains them in the right *order*, with the right
 * *width*, so a flipped dog swallows clicks where he is drawn and not where he
 * used to be.
 *
 * That chain is four steps — `toLogical` -> `OFF_SPRITE` check ->
 * `mirrorLogicalX` -> `isOpaqueAt` — and every one of the plausible mistakes is
 * invisible to the unit tests of the parts:
 *
 *  - reflecting with `width - lx` instead of `width - 1 - lx` shifts the whole
 *    hit area one pixel sideways, which on a symmetric silhouette is
 *    unnoticeable and on a real dog is a nose that clicks a pixel late;
 *  - reflecting *before* the `OFF_SPRITE` check folds an unusable coordinate
 *    back onto the sprite, so a click on a window that is still 0x0 lands on the
 *    dog;
 *  - clamping the reflection to `[0, width - 1]` turns a near-miss one pixel off
 *    one edge into a hit one pixel off the other, because `isOpaqueAt` dilates
 *    outward.
 *
 * The mask is therefore deliberately **asymmetric** — ink in columns 0-2 of a
 * 72-wide frame and nowhere else, i.e. all the way over on the art's left. A
 * symmetric test mask would pass with the mirror missing altogether, which is
 * the one thing this file exists to rule out. `onInk` itself is not exported
 * (it closes over the renderer's live frame, scale and placement), so the chain
 * is rebuilt here from the same four pure functions in the same order; if that
 * order ever changes in `overlay.ts`, `hitAt` below is the comment that says
 * what it used to be.
 */
import { describe, expect, it } from 'vitest';
import { HIT_DILATE_PX, OFF_SPRITE, isOpaqueAt, toLogical } from '../src/core/hittest';
import { isMirrored, mirrorLogicalX, type Facing } from '../src/core/facing';
import { frameAlphaMask, frameSize } from '../src/sprites/mask';
import type { Frame } from '../src/sprites/types';

/** The standing box's real width, because the off-by-one only bites at its edge. */
const WIDTH = 72;
const HEIGHT = 8;

/** A sprite scale and a placement that are both non-trivial, so neither cancels out. */
const SCALE = 3;
const ORIGIN = { x: 40, y: 12 };

/**
 * Ink in columns 0-2 only. Three columns rather than one so the dilation is not
 * the only thing keeping the assertions alive, and at the very left edge so the
 * mirrored answers land at the very right edge, where `width - 1` matters.
 */
const FRAME: Frame = {
  box: 'stand',
  rows: Array.from({ length: HEIGHT }, () => 'aaa'.padEnd(WIDTH, '.'))
};

const MASK = frameAlphaMask(FRAME);

/**
 * `onInk`, rebuilt from the pure pieces: CSS pixels in, verdict out.
 *
 * The four steps and their order are the point. Note that `frameSize` supplies
 * the width, as it does in the renderer — passing a hard-coded 72 here would let
 * a renderer that mirrors against the *box* rather than the frame pass.
 */
function hitAt(cssX: number, cssY: number, facing: Facing): boolean {
  const { width, height } = frameSize(FRAME);
  const raw = toLogical(cssX, SCALE, ORIGIN.x);
  const ly = toLogical(cssY, SCALE, ORIGIN.y);
  if (raw === OFF_SPRITE || ly === OFF_SPRITE) return false;
  const lx = isMirrored(facing) ? mirrorLogicalX(raw, width) : raw;
  return isOpaqueAt(MASK, width, height, lx, ly, HIT_DILATE_PX);
}

/** The CSS-pixel cursor position that lands on logical column `lx`, row `ly`. */
function cursorAt(lx: number, ly: number): [number, number] {
  return [ORIGIN.x + lx * SCALE, ORIGIN.y + ly * SCALE];
}

/** Shorthand: is a cursor over logical column `lx` a hit, at this facing? */
function hitColumn(lx: number, facing: Facing): boolean {
  const [x, y] = cursorAt(lx, 2);
  return hitAt(x, y, facing);
}

describe('the mirrored hit path', () => {
  it('has a mask that is ink on one side only', () => {
    // The premise every assertion below rests on. If a redraw of this fixture
    // ever made it symmetric, the rest of the file would go on passing while
    // testing nothing.
    expect(MASK[2 * WIDTH + 0]).toBe(1);
    expect(MASK[2 * WIDTH + 2]).toBe(1);
    expect(MASK[2 * WIDTH + 3]).toBe(0);
    expect(MASK[2 * WIDTH + (WIDTH - 1)]).toBe(0);
  });

  it('moves the clickable side to the other side of the frame', () => {
    // The whole feature in four assertions: the dog's ink is drawn on the
    // screen's right when he is mirrored, so that is where the clicks must land.
    expect(hitColumn(WIDTH - 1, 'right')).toBe(true);
    expect(hitColumn(0, 'right')).toBe(false);
    expect(hitColumn(0, 'left')).toBe(true);
    expect(hitColumn(WIDTH - 1, 'left')).toBe(false);
  });

  it('reflects about width - 1, not width', () => {
    // Column 68 mirrors to art column 3 — one outside the ink, and so a hit only
    // because `isOpaqueAt` dilates by a pixel. `width - lx` would send it to 4,
    // out of reach, and 67 to 3: the entire hit area slid one column right.
    // These two assertions are what fail on that off-by-one.
    expect(mirrorLogicalX(68, WIDTH)).toBe(3);
    expect(hitColumn(68, 'right')).toBe(true);
    expect(hitColumn(67, 'right')).toBe(false);
    // The un-mirrored mirror image of the same pair, for the same reason.
    expect(hitColumn(3, 'left')).toBe(true);
    expect(hitColumn(4, 'left')).toBe(false);
  });

  it('keeps a near-miss off the left edge a miss when mirrored', () => {
    // A cursor one pixel outside the frame on the *screen's* left, on a mirrored
    // dog, is one pixel outside his tail — nowhere near the ink, which is now on
    // the right. Clamping the reflection into `[0, width - 1]` would send it to
    // column 0 instead, where the dilation would make it a hit: a dog who
    // swallows clicks a body-width away from himself.
    expect(mirrorLogicalX(-1, WIDTH)).toBe(WIDTH);
    expect(hitColumn(-1, 'right')).toBe(false);
    // Un-mirrored the same cursor *is* a hit, by exactly the pixel of grab slack
    // `HIT_DILATE_PX` exists to give — so the miss above is the mirror working,
    // not the dilation having been lost.
    expect(hitColumn(-1, 'left')).toBe(true);
  });

  it('rejects an unusable coordinate instead of mirroring it onto the sprite', () => {
    // `scale = 0` is a window that is still 0x0 or mid-teardown, and `toLogical`
    // answers `OFF_SPRITE`. The sentinel must be caught *before* the reflection:
    // reflecting first and comparing after would leave a mirrored sentinel that
    // no longer equals `OFF_SPRITE` and is no longer recognisable as junk.
    for (const facing of ['left', 'right'] as Facing[]) {
      const raw = toLogical(10, 0, ORIGIN.x);
      expect(raw, facing).toBe(OFF_SPRITE);
      expect(isOpaqueAt(MASK, WIDTH, HEIGHT, raw, 2, HIT_DILATE_PX), facing).toBe(false);
      // And the same through the composed chain, at both facings.
      expect(
        (() => {
          const { width, height } = frameSize(FRAME);
          const value = toLogical(10, 0, ORIGIN.x);
          if (value === OFF_SPRITE) return false;
          const lx = isMirrored(facing) ? mirrorLogicalX(value, width) : value;
          return isOpaqueAt(MASK, width, height, lx, 2, HIT_DILATE_PX);
        })(),
        facing
      ).toBe(false);
    }
  });

  it('has an OFF_SPRITE whose own reflection is also out of reach', () => {
    // The belt to the check's braces, and a real constraint on `OFF_SPRITE`'s
    // magnitude rather than a restatement: were it merely `-1`, mirroring it
    // would give `width`, one pixel off the right edge, which the dilation
    // reaches. It must be far enough out that even reflected — in either
    // direction, for any frame width — nothing can pull it back into the mask.
    for (const width of [1, 8, WIDTH, 4096]) {
      const reflected = mirrorLogicalX(OFF_SPRITE, width);
      expect(reflected, `width=${width}`).toBeGreaterThan(width - 1 + HIT_DILATE_PX);
      expect(mirrorLogicalX(-OFF_SPRITE, width), `width=${width}`).toBeLessThan(-HIT_DILATE_PX);
      expect(
        isOpaqueAt(new Uint8ClampedArray(width).fill(1), width, 1, reflected, 0, HIT_DILATE_PX),
        `width=${width}`
      ).toBe(false);
    }
  });

  it('is the same verdict for a cursor that has not moved but a dog that has turned', () => {
    // Why `applyFacing` sets `needsHitTest`: the ink under a stationary cursor
    // changes when he turns, so every column in the frame has to be re-asked.
    // Over the whole width, the two facings agree nowhere except where the
    // dilated ink and its reflection overlap — which, with ink at 0-2 in a
    // 72-wide frame, is nowhere at all.
    const both: number[] = [];
    for (let lx = 0; lx < WIDTH; lx++) {
      if (hitColumn(lx, 'left') && hitColumn(lx, 'right')) both.push(lx);
    }
    expect(both).toEqual([]);
    // And each facing does have a hit area, so the emptiness above is not two
    // silent misses agreeing with each other.
    expect(hitColumn(1, 'left')).toBe(true);
    expect(hitColumn(WIDTH - 2, 'right')).toBe(true);
  });
});

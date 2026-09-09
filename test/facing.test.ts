/**
 * Which way the dog looks, and the arithmetic that turns him round.
 *
 * `core/facing.ts` is pure, and it is the only place in the app that can produce
 * a mirrored mascot, so the whole feature is testable here: the halves of a
 * display, the hysteresis that stops him flapping in the middle, the negative
 * coordinates of a secondary display to the left of the primary one, and the
 * three mirror helpers — each of which must be its own inverse, because the hit
 * test mirrors a cursor *into* art coordinates and the decoration layer mirrors
 * an anchor *out of* them.
 */
import { describe, expect, it } from 'vitest';
import {
  ART_FACING,
  FACING_DEADBAND_FRACTION,
  facingFor,
  isFacing,
  isMirrored,
  mirrorAnchorX,
  mirrorBounds,
  mirrorLogicalX,
  type Facing
} from '../src/core/facing';

/** A 1728x1117 laptop panel at the origin — this Mac's own. */
const PRIMARY = { x: 0, width: 1728 };
/** A second display to the *left* of the primary one, so x is negative. */
const LEFT_OF_PRIMARY = { x: -1920, width: 1920 };

/** Just outside the dead band, on the named side of a display's centre. */
function pastBand(display: { x: number; width: number }, side: 'left' | 'right'): number {
  const centre = display.x + display.width / 2;
  const band = display.width * FACING_DEADBAND_FRACTION;
  return side === 'left' ? centre - band - 1 : centre + band + 1;
}

describe('ART_FACING', () => {
  it('is left, which is how every strip is drawn', () => {
    // `art/README.md` rule 3. If this ever changes, `isMirrored` inverts and
    // every anchor in the sheet is suddenly on the wrong side of the dog.
    expect(ART_FACING).toBe('left');
  });

  it('is the one facing that is not mirrored', () => {
    expect(isMirrored('left')).toBe(false);
    expect(isMirrored('right')).toBe(true);
  });
});

describe('isFacing', () => {
  it('accepts exactly the two directions', () => {
    expect(isFacing('left')).toBe(true);
    expect(isFacing('right')).toBe(true);
  });

  it('rejects junk rather than defaulting', () => {
    // This runs on an IPC payload. A coerced value would silently mirror the dog
    // (or refuse to) for the rest of the session, with nothing in any log.
    for (const value of ['Left', 'RIGHT', 'up', '', 0, 1, true, null, undefined, {}, ['left']]) {
      expect(isFacing(value), JSON.stringify(value) ?? 'undefined').toBe(false);
    }
  });
});

describe('facingFor', () => {
  it('looks towards the middle: right on the left half, left on the right half', () => {
    expect(facingFor(pastBand(PRIMARY, 'left'), PRIMARY, 'left')).toBe('right');
    expect(facingFor(pastBand(PRIMARY, 'right'), PRIMARY, 'right')).toBe('left');
  });

  it('commits from either previous answer once past the band', () => {
    // The decision must not depend on where he came from — only the dead band does.
    for (const previous of ['left', 'right'] as Facing[]) {
      expect(facingFor(pastBand(PRIMARY, 'left'), PRIMARY, previous)).toBe('right');
      expect(facingFor(pastBand(PRIMARY, 'right'), PRIMARY, previous)).toBe('left');
    }
  });

  it('keeps the previous answer inside the dead band', () => {
    const centre = PRIMARY.x + PRIMARY.width / 2;
    const band = PRIMARY.width * FACING_DEADBAND_FRACTION;
    for (const x of [centre, centre - band, centre + band, centre - 1, centre + 1]) {
      expect(facingFor(x, PRIMARY, 'left'), `x=${x}`).toBe('left');
      expect(facingFor(x, PRIMARY, 'right'), `x=${x}`).toBe('right');
    }
  });

  it('turns exactly once when he is dragged across the middle', () => {
    // The bug this whole mechanism exists to avoid is flapping. Walking a dog
    // rightwards across the centre must produce one transition, not several.
    let facing: Facing = 'right';
    const seen: Facing[] = [facing];
    for (let x = 0; x <= PRIMARY.width; x += 8) {
      const next = facingFor(x, PRIMARY, facing);
      if (next !== facing) seen.push(next);
      facing = next;
    }
    expect(seen).toEqual(['right', 'left']);
  });

  it('works on a display with negative coordinates', () => {
    // A monitor to the left of the primary one: its centre is at -960, so the
    // absolute sign of x says nothing about which half he is on.
    expect(facingFor(pastBand(LEFT_OF_PRIMARY, 'left'), LEFT_OF_PRIMARY, 'left')).toBe('right');
    expect(facingFor(pastBand(LEFT_OF_PRIMARY, 'right'), LEFT_OF_PRIMARY, 'right')).toBe('left');
    // -100 is far to the right of THAT display's centre, though it is a negative
    // number and left of the primary display's origin.
    expect(facingFor(-100, LEFT_OF_PRIMARY, 'right')).toBe('left');
  });

  it('keeps the previous answer for any input it cannot reason about', () => {
    // Called during display changes, when `screen` can briefly report nonsense.
    // Keeping the current facing is the only failure that is invisible.
    for (const previous of ['left', 'right'] as Facing[]) {
      expect(facingFor(Number.NaN, PRIMARY, previous)).toBe(previous);
      expect(facingFor(Number.POSITIVE_INFINITY, PRIMARY, previous)).toBe(previous);
      expect(facingFor(100, { x: 0, width: 0 }, previous)).toBe(previous);
      expect(facingFor(100, { x: 0, width: -1728 }, previous)).toBe(previous);
      expect(facingFor(100, { x: Number.NaN, width: 1728 }, previous)).toBe(previous);
      expect(facingFor(100, { x: 0, width: Number.NaN }, previous)).toBe(previous);
    }
  });

  it('uses a dead band that is a few percent of the screen', () => {
    // Wide enough to swallow the window nudges the app produces itself (a bubble
    // widening moves the window's left edge, and so its centre), narrow enough
    // that a dog a third of the way across still faces the right way.
    expect(FACING_DEADBAND_FRACTION).toBeGreaterThan(0);
    expect(FACING_DEADBAND_FRACTION).toBeLessThan(0.1);
    // A dog at a quarter of the screen width is outside it, by construction.
    expect(facingFor(PRIMARY.width / 4, PRIMARY, 'left')).toBe('right');
  });
});

describe('mirrorLogicalX', () => {
  it('reflects a column about the box centre', () => {
    expect(mirrorLogicalX(0, 72)).toBe(71);
    expect(mirrorLogicalX(71, 72)).toBe(0);
    expect(mirrorLogicalX(35, 72)).toBe(36);
  });

  it('is its own inverse', () => {
    // The hit test mirrors a cursor into art coordinates; the debug outline
    // mirrors bounds back out. Both directions are this one function.
    for (const x of [-3, -1, 0, 1, 17, 71, 72, 90]) {
      expect(mirrorLogicalX(mirrorLogicalX(x, 72), 72)).toBe(x);
    }
  });

  it('keeps a near-miss on the correct side rather than clamping it', () => {
    // `isOpaqueAt` dilates outward by a pixel, so a cursor one pixel off the left
    // edge must come back one pixel off the *right* edge. Clamping to 0 would
    // turn a miss on one side into a hit on the other.
    expect(mirrorLogicalX(-1, 72)).toBe(72);
    expect(mirrorLogicalX(72, 72)).toBe(-1);
  });
});

describe('mirrorBounds', () => {
  const bounds = { minX: 8, minY: 4, maxX: 60, maxY: 70 };

  it('swaps and reflects the horizontal edges, leaving the vertical ones alone', () => {
    expect(mirrorBounds(bounds, 72)).toEqual({ minX: 11, minY: 4, maxX: 63, maxY: 70 });
  });

  it('preserves the silhouette width', () => {
    const flipped = mirrorBounds(bounds, 72);
    expect(flipped.maxX - flipped.minX).toBe(bounds.maxX - bounds.minX);
  });

  it('is its own inverse', () => {
    expect(mirrorBounds(mirrorBounds(bounds, 72), 72)).toEqual(bounds);
  });

  it('leaves a centred, symmetric silhouette where it was', () => {
    const symmetric = { minX: 10, minY: 0, maxX: 61, maxY: 71 };
    expect(mirrorBounds(symmetric, 72)).toEqual(symmetric);
  });
});

describe('mirrorAnchorX', () => {
  it('reflects a box left edge, not a point', () => {
    // The 8-px-wide `?` whose left edge is at 24 in a 72-px box: its mirrored
    // left edge is 72 - 8 - 24 = 40, so the glyph lands the same distance from
    // the opposite edge. Reflecting it as a *point* (mirrorLogicalX -> 47) would
    // put its left edge where its right edge belongs.
    expect(mirrorAnchorX(24, 72, 8)).toBe(40);
    expect(mirrorLogicalX(24, 72)).toBe(47);
  });

  it('keeps the decoration inside the box', () => {
    const boxWidth = 72;
    const decorWidth = 8;
    for (const x of [0, 1, 24, 63, boxWidth - decorWidth]) {
      const flipped = mirrorAnchorX(x, boxWidth, decorWidth);
      expect(flipped, `x=${x}`).toBeGreaterThanOrEqual(0);
      expect(flipped + decorWidth, `x=${x}`).toBeLessThanOrEqual(boxWidth);
    }
  });

  it('is its own inverse', () => {
    for (const x of [0, 3, 24, 64]) {
      expect(mirrorAnchorX(mirrorAnchorX(x, 72, 8), 72, 8)).toBe(x);
    }
  });

  it('leaves a decoration that is already centred where it is', () => {
    // The real sleep box is 61 px wide (`walder.json`), so a decoration can only
    // sit exactly centred in it if its own width is odd as well: a 23-px glyph's
    // left edge is 19, and 61 - 23 - 19 is 19 again — a centred glyph must not
    // shift when he turns.
    expect(mirrorAnchorX(19, 61, 23)).toBe(19);
    // The art's `z z` is 22 px, which cannot be centred in 61 at all: the
    // leftover is odd. Its nearest-centre left edge therefore *moves*, by
    // exactly the one pixel it is off centre by, and that is right rather than a
    // rounding bug — nothing here rounds, and a glyph that stayed put would be a
    // pixel off the other way. Where it actually sits is strips.py's call.
    expect(mirrorAnchorX(19, 61, 22)).toBe(20);
  });
});

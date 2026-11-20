/**
 * Window geometry: the maths that keeps the mascot inside the screen — all of
 * him, on one display or across a seam between two, never over space that is
 * on no display (owner, 2026-11-16) — and that sizes the window around the
 * sprite. Pure, so it is tested without launching Electron: every arrangement
 * of displays the rule has to answer for is a list of rectangles here, which
 * is the only way most of them can be tried at all.
 */
import { describe, expect, it } from 'vitest';
import {
  BUBBLE_CHROME_PX,
  BUBBLE_EAR_ROWS,
  bubbleBoxAt,
  bubbleBoxSpace,
  bubbleTop,
  bubbleColumnPx,
  bubbleFontPx,
  bubbleReservePx,
  BUBBLE_EXTRA_MAX_PX,
  bottomRightOf,
  bubbleExtraPx,
  clampRectInsideWorkAreas,
  clampRectInsideWorkAreasAt,
  coveredByWorkAreas,
  inkInset,
  boxMetrics,
  onScreenSpan,
  placementSince,
  overlayMetrics,
  restingRect,
  deviceExtent,
  drawnInkInset,
  spriteFit,
  spriteLayout,
  spriteOrigin,
  type BoxSize,
  type Rect,
  type RectInset
} from '../src/core/geometry';
import { devicePixelScale, spriteCssScale } from '../src/sprites/raster';
import { frameAlphaMask, frameSize, maskBounds } from '../src/sprites/mask';
import { validateSheet } from '../src/sprites/types';
import {
  animationFor,
  boxInkMargin,
  characterOf,
  coatInkMargin,
  decorationPlacements,
  framesFor,
  sharedInkMargin
} from '../src/sprites/contract';
import { mirrorAnchorX } from '../src/core/facing';
import type { Frame } from '../src/sprites/types';
import type { DecorName } from '../src/sprites/contract';
import type { InkMargin } from '../src/core/geometry';
import type { BoxName } from '../src/core/expression';
import shipped from '../src/sprites/walder.json';
import {
  ELLIPSIS,
  bubbleColumnsNeeded,
  bubbleReserveColumns,
  displayColumns,
  introHelloText,
  wrapBubbleText
} from '../src/core/bubble';
import { LANGUAGES, TABLES, type Language } from '../src/core/i18n';
import { setLanguage, t } from '../src/core/strings';

const LAPTOP: Rect = { x: 0, y: 25, width: 1440, height: 875 };
const EXTERNAL: Rect = { x: 1440, y: 0, width: 1920, height: 1080 };
const WIN: Rect = { x: 0, y: 0, width: 192, height: 192 };

/**
 * A stand box the size the placeholder art happens to use. It is a *test
 * fixture*, not a constant of the app: since the 2026-09-08 design gate the box
 * comes from the loaded sheet, and the tests below pass it in explicitly so a
 * re-authored sheet cannot silently change what they assert.
 */
const STAND: BoxSize = { width: 48, height: 40 };

/**
 * SF Mono's advance, which is what `ui-monospace` resolves to on macOS: 1266
 * font units of a 2048-unit em. The renderer's `charWidth` is one
 * `ctx.measureText('M')` of that font, so this is the number the real thing
 * produces — the tests below model the renderer with it rather than with
 * `bubbleColumnPx`'s 0.62 estimate, so they measure the prediction rather than
 * agreeing with it.
 */
const SF_MONO_ADVANCE = 1266 / 2048;

/*
 * The one clamp (owner, 2026-11-16: "walder can't move outside your screen, so
 * it always stay inside your screen borders, no exceptions, should also take
 * multiple displays into account").
 *
 * Until that day there were two. `clampRectToWorkAreas` was the lenient one a
 * drag, the launch and a display change used: a position with 24 px of him on
 * some work area (`MIN_VISIBLE_PX`) was kept, so he could be parked half off an
 * edge, and that was deliberate (QA row 2.2 as it then read). It and its
 * constant are gone. `clampRectInsideWorkAreas`, the strict one a size or box
 * change used, is now the only rule, and it was widened from "wholly on ONE
 * work area" to "wholly on their union", so he may stand across a seam.
 *
 * The tests of the lenient clamp that still say something true are kept below,
 * pointed at the one clamp, with the same answers. The ones that asserted a
 * dog hanging off an edge is left alone are reversed, each marked.
 */
describe('clampRectInsideWorkAreas: the cases the lenient clamp was tested with', () => {
  it('leaves a fully visible window alone', () => {
    const rect = { ...WIN, x: 400, y: 300 };
    expect(clampRectInsideWorkAreas(rect, [LAPTOP])).toEqual({ x: 400, y: 300 });
  });

  it('leaves a window straddling two displays alone when their work areas cover it', () => {
    // Snapping this onto one display would fight the user on every drag across
    // the seam. It is inside the screen: 60 px of it on the laptop, the rest on
    // the external display, and both work areas reach from above it to below.
    const rect = { ...WIN, x: 1380, y: 400 };
    expect(coveredByWorkAreas(rect, [LAPTOP, EXTERNAL])).toBe(true);
    expect(clampRectInsideWorkAreas(rect, [LAPTOP, EXTERNAL])).toEqual({ x: 1380, y: 400 });
  });

  // Reversed, 2026-11-16. This was 'keeps a window peeking over the edge if
  // enough of it shows': 24 px on screen was enough and the position was kept.
  it('pulls a window peeking over the edge wholly back in, however much of it shows', () => {
    const rect = { ...WIN, x: -WIN.width + 24, y: 300 };
    expect(clampRectInsideWorkAreas(rect, [LAPTOP])).toEqual({ x: 0, y: 300 });
    // One pixel over is over.
    expect(clampRectInsideWorkAreas({ ...WIN, x: -1, y: 300 }, [LAPTOP])).toEqual({ x: 0, y: 300 });
  });

  it('pulls a window fully off-screen back onto the nearest display', () => {
    const rect = { ...WIN, x: -5000, y: -5000 };
    const result = clampRectInsideWorkAreas(rect, [LAPTOP, EXTERNAL]);
    expect(result).toEqual({ x: LAPTOP.x, y: LAPTOP.y });
  });

  it('chooses the nearest display when recovering, not simply the first', () => {
    const rect = { ...WIN, x: 4000, y: 500 };
    const result = clampRectInsideWorkAreas(rect, [LAPTOP, EXTERNAL]);
    expect(result).toEqual({
      x: EXTERNAL.x + EXTERNAL.width - WIN.width,
      y: 500
    });
  });

  it('recovers a window from just past the far edge', () => {
    const rect = { ...WIN, x: LAPTOP.width + 500, y: 300 };
    const result = clampRectInsideWorkAreas(rect, [LAPTOP]);
    expect(result).toEqual({ x: LAPTOP.width - WIN.width, y: 300 });
  });

  it('respects a work area that does not start at the origin', () => {
    const rect = { ...WIN, x: -9999, y: -9999 };
    expect(clampRectInsideWorkAreas(rect, [LAPTOP])).toEqual({ x: 0, y: 25 });
  });

  it('pins a window larger than the work area to the work-area origin', () => {
    const huge = { x: -9999, y: -9999, width: 4000, height: 4000 };
    expect(clampRectInsideWorkAreas(huge, [LAPTOP])).toEqual({ x: LAPTOP.x, y: LAPTOP.y });
  });

  it('returns the rect untouched when there are no displays at all', () => {
    // A transient state while displays are being reconfigured; guessing is worse.
    const rect = { ...WIN, x: 123, y: 456 };
    expect(clampRectInsideWorkAreas(rect, [])).toEqual({ x: 123, y: 456 });
    // Same with an inset: no area to measure against, so nothing to decide.
    expect(clampRectInsideWorkAreas(rect, [], inkInset(overlayMetrics(3, STAND)))).toEqual({
      x: 123,
      y: 456
    });
    // And a display that reports an empty work area is no display.
    const empty: Rect = { x: 0, y: 0, width: 0, height: 0 };
    expect(clampRectInsideWorkAreas(rect, [empty])).toEqual({ x: 123, y: 456 });
    expect(clampRectInsideWorkAreas({ ...WIN, x: -50, y: 300 }, [empty, LAPTOP])).toEqual({
      x: 0,
      y: 300
    });
  });
});

describe('clampRectInsideWorkAreas with an ink inset', () => {
  // The overlay window at scale 3: 192 wide, with 24 px of padding either side
  // of the dog and `bubbleReservePx(3)` = 58 px of bubble reserve above it. The
  // ink rect is therefore 144x120 at (+24, +58) inside the window.
  //
  // The reserve stopped being `24 * scale` in 0.2.2 — the bubble is sized for
  // reading now, not as a fraction of the dog — so this number is read from the
  // function rather than written out, and the assertions below say what it is.
  const metrics = overlayMetrics(3, STAND);
  const inset = inkInset(metrics);
  const OVERLAY: Rect = { x: 0, y: 0, width: metrics.width, height: metrics.height };

  it('describes the sprite rect, not the window rect', () => {
    expect(bubbleReservePx(3)).toBe(58);
    expect(inset).toEqual({ left: 24, right: 24, top: 58, bottom: 0 });
  });

  it('measures the dog, not the window, at the left edge', () => {
    // 30 px of window on screen at the left edge. Without an inset the whole
    // window is what must be inside (the old lenient half of this test, which
    // kept the position, is reversed: 2026-11-16)…
    const rect = { ...OVERLAY, x: -(metrics.width - 30), y: 300 };
    expect(clampRectInsideWorkAreas(rect, [LAPTOP])).toEqual({ x: 0, y: 300 });

    // …and with it the *ink* is: the window is translated so the ink lands at
    // the work-area origin, ink.x = 0 means window.x = -24, and the padding
    // stays off screen. Vertically it was already fine, so y does not move.
    const withInk = clampRectInsideWorkAreas(rect, [LAPTOP], inset);
    expect(withInk).toEqual({ x: -inset.left, y: 300 });
  });

  // Reversed, 2026-11-16. This was 'leaves a window alone when enough of the
  // dog itself is on screen': 24 px of ink showing was exactly enough.
  it('pulls him wholly in when only some of the dog himself is on screen', () => {
    const rect = { ...OVERLAY, x: -(inset.left + 144 - 24), y: 300 };
    expect(clampRectInsideWorkAreas(rect, [LAPTOP], inset)).toEqual({ x: -inset.left, y: 300 });
  });

  it('does not count the bubble reserve as part of him, top or bottom', () => {
    // Pushed down past the bottom edge until only the window's top 66 px are on
    // the work area. 58 of those are bubble reserve, so just 8 px of dog shows.
    const rect = { ...OVERLAY, x: 400, y: LAPTOP.y + LAPTOP.height - 66 };
    const withInk = clampRectInsideWorkAreas(rect, [LAPTOP], inset);
    expect(withInk.x).toBe(400);
    // Pulled back up until the whole 120 px-tall ink rect fits, and no further.
    expect(withInk.y + inset.top + 120).toBe(LAPTOP.y + LAPTOP.height);
    // And at the top the reserve may hang above the work area: it is not him.
    const high = { ...OVERLAY, x: 400, y: LAPTOP.y - inset.top };
    expect(clampRectInsideWorkAreas(high, [LAPTOP], inset)).toEqual({ x: 400, y: high.y });
    expect(clampRectInsideWorkAreas({ ...high, y: high.y - 1 }, [LAPTOP], inset)).toEqual({
      x: 400,
      y: high.y
    });
  });

  it('picks the nearest display by where the dog is, not where the window is', () => {
    const rect = { ...OVERLAY, x: 4000, y: 500 };
    const result = clampRectInsideWorkAreas(rect, [LAPTOP, EXTERNAL], inset);
    // Ink pinned to the external display's right edge, window offset back out.
    expect(result.x).toBe(EXTERNAL.x + EXTERNAL.width - 144 - inset.left);
    expect(result.y).toBe(500);
  });

  it('is identical to the un-inset call for a rect with no padding to trim', () => {
    const rect = { ...WIN, x: -5000, y: -5000 };
    const none = clampRectInsideWorkAreas(rect, [LAPTOP, EXTERNAL]);
    expect(clampRectInsideWorkAreas(rect, [LAPTOP, EXTERNAL], {})).toEqual(none);
  });

  it('survives an inset larger than the rect without inverting', () => {
    // A degenerate inset must not produce a zero-size ink rect, which nothing
    // could hold on screen; it is floored at 1x1, which here is on the display.
    const rect = { ...OVERLAY, x: 400, y: 300 };
    const silly = { left: 500, right: 500, top: 500, bottom: 500 };
    expect(clampRectInsideWorkAreas(rect, [LAPTOP], silly)).toEqual({ x: 400, y: 300 });
  });
});

/**
 * The clamp as a size or box change first used it (Windows QA, row 3.3). The
 * work area is the QA machine's: 1920 x 1152 with the taskbar below it. The
 * boxes are the shipped 72 x 72 stand box, so the windows are the logged ones —
 * Small 88 x 120 at the default spot (1816, 1016), Large 264 x 274.
 */
describe('clampRectInsideWorkAreas', () => {
  const WINDOWS: Rect = { x: 0, y: 0, width: 1920, height: 1152 };
  const shipped: BoxSize = { width: 72, height: 72 };
  const large = overlayMetrics(3, shipped);
  const inset = inkInset(large);
  /** The ink rect of a Large window at `pos`. */
  const inkAt = (pos: { x: number; y: number }): Rect => ({
    x: pos.x + inset.left,
    y: pos.y + inset.top,
    width: large.width - inset.left - inset.right,
    height: large.height - inset.top
  });
  const inside = (ink: Rect, area: Rect): boolean =>
    ink.x >= area.x &&
    ink.y >= area.y &&
    ink.x + ink.width <= area.x + area.width &&
    ink.y + ink.height <= area.y + area.height;

  it('pulls a dog grown past the right edge back until all of his ink is on screen', () => {
    // Small → Large at the default spot, bottom-left anchored: the logged
    // window ran from 1816 to 2080 (2102 with the bubble widening). (The
    // lenient clamp let that through, which this test used to assert as the
    // contrast; there is no lenient clamp since 2026-11-16.)
    const target = { x: 1816, y: 1136 - large.height, width: large.width, height: large.height };
    // He moves left, and only left: the bottom he stands on was already on
    // the work area.
    const placed = clampRectInsideWorkAreas(target, [WINDOWS], inset);
    expect(placed.y).toBe(target.y);
    expect(placed.x).toBe(WINDOWS.width - large.width + inset.right);
    expect(inside(inkAt(placed), WINDOWS)).toBe(true);
    // Hard against the edge, not further in than it had to go.
    const ink = inkAt(placed);
    expect(ink.x + ink.width).toBe(WINDOWS.width);
  });

  it('pulls him up as well when he would cross the bottom edge', () => {
    const target = { x: 400, y: WINDOWS.height - 100, width: large.width, height: large.height };
    const placed = clampRectInsideWorkAreas(target, [WINDOWS], inset);
    expect(placed.x).toBe(400);
    expect(placed.y + large.height).toBe(WINDOWS.height);
  });

  it('leaves a dog whose ink is already inside exactly where he is', () => {
    const target = { x: 600, y: 400, width: large.width, height: large.height };
    expect(clampRectInsideWorkAreas(target, [WINDOWS], inset)).toEqual({ x: 600, y: 400 });
    // Including when only transparent padding and bubble reserve hang off:
    // that is the window, not the dog.
    const padded = { x: -inset.left, y: -inset.top, width: large.width, height: large.height };
    expect(clampRectInsideWorkAreas(padded, [WINDOWS], inset)).toEqual({
      x: padded.x,
      y: padded.y
    });
  });

  it('aligns ink larger than the area to its top-left', () => {
    // The honest fallback: he cannot fit, so his head and front stay visible.
    const tiny: Rect = { x: 100, y: 50, width: 120, height: 80 };
    const target = { x: 900, y: 900, width: large.width, height: large.height };
    const placed = clampRectInsideWorkAreas(target, [tiny], inset);
    expect(inkAt(placed).x).toBe(tiny.x);
    expect(inkAt(placed).y).toBe(tiny.y);
    // And that is where he stays: clamping it again changes nothing.
    expect(clampRectInsideWorkAreas({ ...target, ...placed }, [tiny], inset)).toEqual(placed);
  });

  // Reversed, 2026-11-16. This was 'settles on the display he is mostly
  // standing on, not the nearest centre': the strict clamp wanted him wholly
  // on ONE work area and moved this dog 40 px right onto the external display.
  // The owner's second decision allows the seam, and here both work areas
  // cover him, so he is left where he is.
  it('leaves him across the seam when the two work areas cover him', () => {
    const target = {
      x: EXTERNAL.x - inset.left - 40,
      y: 600,
      width: large.width,
      height: large.height
    };
    // Ink x 1400..1616, y 658..874: the laptop's work area ends at y 900.
    expect(inkAt(target)).toEqual({ x: 1400, y: 658, width: 216, height: 216 });
    expect(coveredByWorkAreas(target, [LAPTOP, EXTERNAL], inset)).toBe(true);
    expect(clampRectInsideWorkAreas(target, [LAPTOP, EXTERNAL], inset)).toEqual({
      x: target.x,
      y: target.y
    });
  });

  it('moves him the shorter way when part of him is below the lower display at the seam', () => {
    // The same dog 100 px lower: ink y 758..974, and the 40 px of him on the
    // laptop are below its work area (bottom 900) by 74. Right by 40 is nearer
    // than up by 74.
    const lower = { x: EXTERNAL.x - inset.left - 40, y: 700, width: large.width, height: large.height };
    expect(coveredByWorkAreas(lower, [LAPTOP, EXTERNAL], inset)).toBe(false);
    expect(clampRectInsideWorkAreas(lower, [LAPTOP, EXTERNAL], inset)).toEqual({ x: 1416, y: 700 });
    // 40 px either way is a tie, and the tie goes sideways: he keeps the
    // height he stands at.
    const tie = { ...lower, y: 666 };
    expect(clampRectInsideWorkAreas(tie, [LAPTOP, EXTERNAL], inset)).toEqual({ x: 1416, y: 666 });
    // A pixel shallower and up is nearer.
    expect(clampRectInsideWorkAreas({ ...lower, y: 665 }, [LAPTOP, EXTERNAL], inset)).toEqual({
      x: lower.x,
      y: 626
    });
  });

  it('returns the rect untouched when there are no displays at all', () => {
    const target = { x: 5000, y: -5000, width: large.width, height: large.height };
    expect(clampRectInsideWorkAreas(target, [], inset)).toEqual({ x: 5000, y: -5000 });
    expect(clampRectInsideWorkAreas(target, [])).toEqual({ x: 5000, y: -5000 });
  });
});

/*
 * The geometry of the rule on every arrangement of displays it has to answer
 * for. Work areas of real displays never overlap; they may share an edge, share
 * only a corner, or stop short of each other where a taskbar or menu bar sits
 * on the seam. All numbers are worked by hand in the design of 2026-11-16; none
 * of it has been seen on a second display.
 */
describe('inside the union of the work areas', () => {
  type Point = { x: number; y: number };
  const at = (size: { width: number; height: number }, x: number, y: number): Rect => ({
    x,
    y,
    ...size
  });
  const clamp = (rect: Rect, areas: readonly Rect[]): Point =>
    clampRectInsideWorkAreas(rect, areas);

  const SINGLE: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
  const SAME = [
    { x: 0, y: 0, width: 1000, height: 800 },
    { x: 1000, y: 0, width: 1000, height: 800 }
  ] as const;
  /** Different heights, tops aligned: an L, its inner corner at (1000, 600). */
  const L_TOP = [
    { x: 0, y: 0, width: 1000, height: 600 },
    { x: 1000, y: 0, width: 1000, height: 1000 }
  ] as const;
  /** Different heights, bottoms aligned. */
  const L_BOTTOM = [
    { x: 0, y: 400, width: 1000, height: 600 },
    { x: 1000, y: 0, width: 1000, height: 1000 }
  ] as const;
  const STACKED = [
    { x: 0, y: 0, width: 1000, height: 800 },
    { x: 0, y: 800, width: 1000, height: 800 }
  ] as const;
  const NARROW_BELOW = [
    { x: 0, y: 0, width: 1000, height: 800 },
    { x: 200, y: 800, width: 600, height: 800 }
  ] as const;
  /** Touching at one corner only. */
  const DIAGONAL = [
    { x: 0, y: 0, width: 1000, height: 1000 },
    { x: 1000, y: 1000, width: 1000, height: 1000 }
  ] as const;
  /** A 48 px taskbar on the left display's right edge: the work areas do not meet. */
  const STRIP = [
    { x: 0, y: 0, width: 952, height: 1080 },
    { x: 1000, y: 0, width: 1000, height: 1080 }
  ] as const;

  describe('one display', () => {
    const size = { width: 100, height: 80 };
    it('leaves him alone anywhere inside, flush with the corner included', () => {
      expect(clamp(at(size, 500, 500), [SINGLE])).toEqual({ x: 500, y: 500 });
      expect(clamp(at(size, 1820, 960), [SINGLE])).toEqual({ x: 1820, y: 960 });
      expect(clamp(at(size, 0, 0), [SINGLE])).toEqual({ x: 0, y: 0 });
    });

    it('moves him only across the edge he crossed', () => {
      expect(clamp(at(size, -30, 500), [SINGLE])).toEqual({ x: 0, y: 500 });
      expect(clamp(at(size, 1900, 500), [SINGLE])).toEqual({ x: 1820, y: 500 });
      expect(clamp(at(size, 500, -10), [SINGLE])).toEqual({ x: 500, y: 0 });
      expect(clamp(at(size, 500, 1000), [SINGLE])).toEqual({ x: 500, y: 960 });
    });

    it('moves him on both axes at a corner', () => {
      expect(clamp(at(size, -30, -10), [SINGLE])).toEqual({ x: 0, y: 0 });
      expect(clamp(at(size, 1900, -10), [SINGLE])).toEqual({ x: 1820, y: 0 });
      expect(clamp(at(size, -30, 1000), [SINGLE])).toEqual({ x: 0, y: 960 });
      expect(clamp(at(size, 1900, 1000), [SINGLE])).toEqual({ x: 1820, y: 960 });
    });

    it('slides along the bottom edge: y pinned, x following until the corner', () => {
      // A drag held below the bottom edge and moved to the right, past the
      // corner: what `dragMove` asks at each pointer event.
      let last = -Infinity;
      for (let x = 1700; x <= 2100; x += 7) {
        const q = clamp(at(size, x, 1000), [SINGLE]);
        expect(q, `x ${x}`).toEqual({ x: Math.min(x, 1820), y: 960 });
        expect(q.x).toBeGreaterThanOrEqual(last);
        last = q.x;
      }
    });
  });

  describe('two displays of the same height, side by side', () => {
    const size = { width: 200, height: 100 };
    it('lets him stand across the seam', () => {
      expect(clamp(at(size, 900, 300), SAME)).toEqual({ x: 900, y: 300 });
    });

    it('slides him along the bottom straight through the seam, with no bump', () => {
      expect(clamp(at(size, 900, 750), SAME)).toEqual({ x: 900, y: 700 });
      for (let x = 700; x <= 1100; x += 5) {
        expect(clamp(at(size, x, 750), SAME), `x ${x}`).toEqual({ x, y: 700 });
      }
    });

    it('stops him at the far edge of the far display', () => {
      expect(clamp(at(size, 1900, 300), SAME)).toEqual({ x: 1800, y: 300 });
    });

    it('brings a far-away rect to the nearest covered spot, which may be across the seam', () => {
      const two = [
        { x: 0, y: 0, width: 1000, height: 1000 },
        { x: 1000, y: 0, width: 1000, height: 1000 }
      ];
      expect(clamp({ x: 900, y: 5000, width: 200, height: 200 }, two)).toEqual({ x: 900, y: 800 });
    });
  });

  describe('two displays of different heights (an L)', () => {
    const size = { width: 200, height: 100 };
    it('lets him stand across the seam where both are tall enough, to the pixel', () => {
      expect(clamp(at(size, 900, 450), L_TOP)).toEqual({ x: 900, y: 450 });
      // Feet exactly on the shorter display's bottom edge.
      expect(clamp(at(size, 900, 500), L_TOP)).toEqual({ x: 900, y: 500 });
      expect(coveredByWorkAreas(at(size, 900, 501), L_TOP)).toBe(false);
    });

    it('behind the inner corner, takes the shorter way out', () => {
      // 40 below the short display's floor, 100 short of the tall one: up.
      expect(clamp(at(size, 900, 540), L_TOP)).toEqual({ x: 900, y: 500 });
      // 200 below, 50 short: sideways, onto the tall display.
      expect(clamp(at(size, 950, 700), L_TOP)).toEqual({ x: 1000, y: 700 });
      // 60 either way: the tie goes sideways.
      expect(clamp(at(size, 940, 560), L_TOP)).toEqual({ x: 1000, y: 560 });
    });

    it('is a wall he slides along, then lets him over when up is nearer', () => {
      // On the tall display, below the short one's floor, dragged left.
      for (let x = 1100; x >= 1000; x -= 10) {
        expect(clamp(at(size, x, 700), L_TOP), `x ${x}`).toEqual({ x, y: 700 });
      }
      // Pinned at the wall while sideways is the shorter way (up is 200)…
      for (let x = 990; x >= 800; x -= 10) {
        expect(clamp(at(size, x, 700), L_TOP), `x ${x}`).toEqual({ x: 1000, y: 700 });
      }
      // …and past the diagonal he is over it, on the short display's floor:
      // the one jump of the rule, and never a trap.
      for (let x = 790; x >= 600; x -= 10) {
        expect(clamp(at(size, x, 700), L_TOP), `x ${x}`).toEqual({ x, y: 500 });
      }
    });

    it('holds the same at a seam where the bottoms are aligned and the tops are not', () => {
      // 50 above the shorter display's top, 100 short of the taller: down.
      expect(clamp(at(size, 900, 350), L_BOTTOM)).toEqual({ x: 900, y: 400 });
      expect(clamp(at(size, 900, 400), L_BOTTOM)).toEqual({ x: 900, y: 400 });
    });
  });

  describe('two displays stacked', () => {
    const size = { width: 200, height: 100 };
    it('lets him stand across the horizontal seam', () => {
      expect(clamp(at(size, 400, 750), STACKED)).toEqual({ x: 400, y: 750 });
    });

    it('keeps him off the part of the seam the narrower display does not reach', () => {
      // The lower display starts at x 200: at x 100 half of him would be
      // below the upper display with nothing under it.
      expect(clamp(at(size, 100, 750), NARROW_BELOW)).toEqual({ x: 100, y: 700 });
      expect(clamp(at(size, 200, 750), NARROW_BELOW)).toEqual({ x: 200, y: 750 });
    });
  });

  describe('two displays touching at a corner only', () => {
    const size = { width: 200, height: 100 };
    it('has no position across the corner: he is on one or the other', () => {
      expect(coveredByWorkAreas(at(size, 900, 950), DIAGONAL)).toBe(false);
      // 100 left and 50 up, or 100 right and 50 down: a tie in distance and in
      // height, so the leftmost.
      expect(clamp(at(size, 900, 950), DIAGONAL)).toEqual({ x: 800, y: 900 });
      // Nearer the lower display: one hop onto it.
      expect(clamp(at(size, 950, 980), DIAGONAL)).toEqual({ x: 1000, y: 1000 });
    });
  });

  describe('a taskbar strip on the seam', () => {
    const size = { width: 200, height: 100 };
    it('is in no work area, so nothing touching it is covered', () => {
      for (const x of [753, 800, 900, 951, 999]) {
        expect(coveredByWorkAreas(at(size, x, 300), STRIP), `x ${x}`).toBe(false);
      }
      expect(coveredByWorkAreas(at(size, 752, 300), STRIP)).toBe(true);
      expect(coveredByWorkAreas(at(size, 1000, 300), STRIP)).toBe(true);
    });

    it('holds him on the near side, then hops him across in one go', () => {
      expect(clamp(at(size, 850, 300), STRIP)).toEqual({ x: 752, y: 300 });
      expect(clamp(at(size, 880, 300), STRIP)).toEqual({ x: 1000, y: 300 });
      // 124 either way: the leftmost.
      expect(clamp(at(size, 876, 300), STRIP)).toEqual({ x: 752, y: 300 });
      // A drag from left to right: pinned at 752, then 1000 — his width plus
      // the strip — and from there with the pointer again.
      const seen = new Set<number>();
      for (let x = 700; x <= 1100; x += 4) seen.add(clamp(at(size, x, 300), STRIP).x);
      expect([...seen].filter((x) => x > 752 && x < 1000)).toEqual([]);
    });
  });

  describe('ink that does not fit', () => {
    it('is pinned by its top-left when it fits on no display and across no seam', () => {
      const areas = [
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 500, y: 0, width: 150, height: 100 }
      ];
      const rect = { x: 480, y: 20, width: 200, height: 200 };
      expect(coveredByWorkAreas(rect, areas)).toBe(false);
      const pinned = clamp(rect, areas);
      // The nearer display's top-left; nothing better exists.
      expect(pinned).toEqual({ x: 500, y: 0 });
      expect(clamp({ ...rect, ...pinned }, areas)).toEqual(pinned);
    });

    it('fits across a seam when it is larger than either display alone', () => {
      const areas = [
        { x: 0, y: 0, width: 150, height: 300 },
        { x: 150, y: 0, width: 150, height: 300 }
      ];
      expect(clamp({ x: 500, y: 500, width: 200, height: 100 }, areas)).toEqual({ x: 100, y: 200 });
    });
  });

  it('answers the same far-away cases as before on the laptop and external display', () => {
    expect(clamp({ ...WIN, x: -5000, y: -5000 }, [LAPTOP, EXTERNAL])).toEqual({ x: 0, y: 25 });
    expect(clamp({ ...WIN, x: 4000, y: 500 }, [LAPTOP, EXTERNAL])).toEqual({ x: 3168, y: 500 });
  });

  it('is exact with a fractional width flush with an edge', () => {
    // 125 % Medium is drawn 172.8 CSS px wide. `(1920 - 172.8) + 172.8` is not
    // necessarily 1920 again in floating point; a sliver of noise is not dog.
    const flush = { x: 1920 - 172.8, y: 100, width: 172.8, height: 100 };
    expect(coveredByWorkAreas(flush, [SINGLE])).toBe(true);
    expect(clamp(flush, [SINGLE])).toEqual({ x: flush.x, y: 100 });
    const pulled = clamp({ ...flush, x: 1900 }, [SINGLE]);
    expect(pulled.x).toBeCloseTo(1747.2, 9);
    expect(clamp({ ...flush, ...pulled }, [SINGLE])).toEqual(pulled);
  });

  /*
   * The properties the wiring leans on, over a grid of positions on every
   * arrangement above: clamping twice is clamping once (nothing that
   * re-validates a position can move him, and nothing can oscillate); the
   * answer is covered whenever anything is; and the order the displays are
   * listed in changes nothing.
   */
  describe('properties', () => {
    const layouts: readonly (readonly [string, readonly Rect[]])[] = [
      ['one display', [SINGLE]],
      ['same height', SAME],
      ['L, tops aligned', L_TOP],
      ['L, bottoms aligned', L_BOTTOM],
      ['stacked', STACKED],
      ['narrower below', NARROW_BELOW],
      ['diagonal', DIAGONAL],
      ['taskbar strip', STRIP],
      ['laptop and external', [LAPTOP, EXTERNAL]],
      [
        'three displays',
        [
          { x: 0, y: 200, width: 800, height: 600 },
          { x: 800, y: 0, width: 1200, height: 1000 },
          { x: 2000, y: 300, width: 900, height: 1200 }
        ]
      ]
    ];
    const sizes = [
      { width: 200, height: 100 },
      { width: 88, height: 120 },
      { width: 264, height: 274 }
    ];

    for (const [name, areas] of layouts) {
      it(`is idempotent, covered and order-independent on: ${name}`, () => {
        const reversed = [...areas].reverse();
        for (const size of sizes) {
          for (let x = -450; x <= 3300; x += 125) {
            for (let y = -450; y <= 1900; y += 117) {
              const rect = at(size, x, y);
              const q = clamp(rect, areas);
              const label = `${size.width}x${size.height} at (${x}, ${y})`;
              expect(coveredByWorkAreas({ ...rect, ...q }, areas), label).toBe(true);
              expect(clamp({ ...rect, ...q }, areas), label).toEqual(q);
              expect(clamp(rect, reversed), label).toEqual(q);
              if (coveredByWorkAreas(rect, areas)) expect(q, label).toEqual({ x, y });
            }
          }
        }
      });
    }

    /*
     * Against a brute-force search, on layouts small enough to try every
     * whole position: the nearest covered position, with the documented
     * tie-break. With whole-number inputs the true nearest position is a whole
     * number too (it is one of the candidates, all sums and differences of the
     * inputs), so searching the integers is searching everything.
     */
    const small: readonly (readonly [string, readonly Rect[], { width: number; height: number }])[] = [
      ['one display', [{ x: 0, y: 0, width: 12, height: 9 }], { width: 3, height: 2 }],
      [
        'same height',
        [
          { x: 0, y: 0, width: 8, height: 8 },
          { x: 8, y: 0, width: 8, height: 8 }
        ],
        { width: 3, height: 2 }
      ],
      [
        'L, tops aligned',
        [
          { x: 0, y: 0, width: 8, height: 5 },
          { x: 8, y: 0, width: 8, height: 10 }
        ],
        { width: 3, height: 2 }
      ],
      [
        'L, bottoms aligned',
        [
          { x: 0, y: 4, width: 8, height: 6 },
          { x: 8, y: 0, width: 8, height: 10 }
        ],
        { width: 3, height: 2 }
      ],
      [
        'narrower below',
        [
          { x: 0, y: 0, width: 10, height: 6 },
          { x: 2, y: 6, width: 6, height: 6 }
        ],
        { width: 3, height: 2 }
      ],
      [
        'diagonal',
        [
          { x: 0, y: 0, width: 8, height: 8 },
          { x: 8, y: 8, width: 8, height: 8 }
        ],
        { width: 3, height: 2 }
      ],
      [
        'strip on the seam',
        [
          { x: 0, y: 0, width: 7, height: 9 },
          { x: 9, y: 0, width: 8, height: 9 }
        ],
        { width: 3, height: 2 }
      ],
      [
        'three displays, a U',
        [
          { x: 0, y: 0, width: 5, height: 10 },
          { x: 5, y: 6, width: 6, height: 4 },
          { x: 11, y: 0, width: 5, height: 10 }
        ],
        { width: 3, height: 2 }
      ],
      [
        'wider than either display, fits across both',
        [
          { x: 0, y: 0, width: 4, height: 8 },
          { x: 4, y: 0, width: 4, height: 8 }
        ],
        { width: 6, height: 2 }
      ]
    ];
    for (const [name, areas, size] of small) {
      it(`is the nearest covered position, by brute force, on: ${name}`, () => {
        const covered: Point[] = [];
        for (let x = -12; x <= 30; x++) {
          for (let y = -12; y <= 26; y++) {
            if (coveredByWorkAreas(at(size, x, y), areas)) covered.push({ x, y });
          }
        }
        expect(covered.length).toBeGreaterThan(0);
        for (let x = -9; x <= 26; x++) {
          for (let y = -9; y <= 22; y++) {
            let best: (Point & { d: number; dy: number }) | null = null;
            for (const c of covered) {
              const d = (c.x - x) ** 2 + (c.y - y) ** 2;
              const dy = Math.abs(c.y - y);
              if (
                best === null ||
                d < best.d ||
                (d === best.d &&
                  (dy < best.dy ||
                    (dy === best.dy && (c.x < best.x || (c.x === best.x && c.y < best.y)))))
              ) {
                best = { ...c, d, dy };
              }
            }
            expect(clamp(at(size, x, y), areas), `(${x}, ${y})`).toEqual({
              x: (best as Point).x,
              y: (best as Point).y
            });
          }
        }
      });
    }
  });
});

describe('coveredByWorkAreas', () => {
  it('does not call a position too far off to add a size to covered', () => {
    // At 1e20, x + width === x: no stretch to test must not read as covered.
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
    for (const far of [2e18, 1e20, -1e20, 1e308]) {
      const x = clampRectInsideWorkAreas({ x: far, y: 500, width: 88, height: 100 }, [area]).x;
      expect(x, String(far)).toBeGreaterThanOrEqual(0);
      expect(x, String(far)).toBeLessThanOrEqual(1920 - 88);
      const y = clampRectInsideWorkAreas({ x: 500, y: far, width: 88, height: 100 }, [area]).y;
      expect(y, String(far)).toBeGreaterThanOrEqual(0);
      expect(y, String(far)).toBeLessThanOrEqual(1040 - 100);
    }
  });

  const A: Rect = { x: 0, y: 0, width: 1000, height: 800 };
  const B: Rect = { x: 1000, y: 0, width: 1000, height: 800 };
  const rect: Rect = { x: 900, y: 300, width: 200, height: 100 };

  it('is true wholly inside one area, edges included', () => {
    expect(coveredByWorkAreas({ x: 0, y: 0, width: 1000, height: 800 }, [A])).toBe(true);
    expect(coveredByWorkAreas({ x: 800, y: 700, width: 200, height: 100 }, [A])).toBe(true);
    expect(coveredByWorkAreas({ x: 801, y: 700, width: 200, height: 100 }, [A])).toBe(false);
    expect(coveredByWorkAreas({ x: 800, y: 701, width: 200, height: 100 }, [A])).toBe(false);
  });

  it('is true across a seam the two areas share', () => {
    expect(coveredByWorkAreas(rect, [A, B])).toBe(true);
    expect(coveredByWorkAreas(rect, [B, A])).toBe(true);
    expect(coveredByWorkAreas(rect, [A])).toBe(false);
    expect(coveredByWorkAreas(rect, [B])).toBe(false);
  });

  it('is false across a gap of a single pixel', () => {
    const apart = { ...B, x: 1001 };
    expect(coveredByWorkAreas(rect, [A, apart])).toBe(false);
  });

  it('is false with no areas, and ignores an area with no size', () => {
    expect(coveredByWorkAreas(rect, [])).toBe(false);
    expect(coveredByWorkAreas(rect, [{ x: 0, y: 0, width: 0, height: 0 }])).toBe(false);
    expect(coveredByWorkAreas(rect, [A, { x: 1000, y: 0, width: 1000, height: 0 }])).toBe(false);
  });

  it('is not fooled by a piece that is outside every area in the middle of the rect', () => {
    // Three areas in a row, the middle one shorter: a rect spanning all three
    // below the middle one's floor has its ends covered and its middle not.
    const row = [
      { x: 0, y: 0, width: 100, height: 300 },
      { x: 100, y: 0, width: 100, height: 100 },
      { x: 200, y: 0, width: 100, height: 300 }
    ];
    expect(coveredByWorkAreas({ x: 50, y: 20, width: 200, height: 60 }, row)).toBe(true);
    expect(coveredByWorkAreas({ x: 50, y: 150, width: 200, height: 60 }, row)).toBe(false);
  });

  it('counts overlapping areas as their union', () => {
    // Not something real displays report; the test must not assume otherwise.
    const overlapping = [A, { x: 600, y: 0, width: 1000, height: 800 }];
    expect(coveredByWorkAreas({ x: 300, y: 100, width: 1200, height: 100 }, overlapping)).toBe(true);
  });

  it('measures the inset rect when given an inset', () => {
    const win: Rect = { x: -24, y: -58, width: 192, height: 178 };
    expect(coveredByWorkAreas(win, [A])).toBe(false);
    expect(coveredByWorkAreas(win, [A], { left: 24, right: 24, top: 58, bottom: 0 })).toBe(true);
    expect(coveredByWorkAreas(win, [A], { left: 23, right: 24, top: 58, bottom: 0 })).toBe(false);
  });

  it('does not wave a rect with no size through', () => {
    expect(coveredByWorkAreas({ x: 500, y: 500, width: 0, height: 0 }, [A])).toBe(true);
    expect(coveredByWorkAreas({ x: 5000, y: 500, width: 0, height: 0 }, [A])).toBe(false);
  });
});

/*
 * The clamp for an inset that depends on where he lands: his drawn ink is a
 * function of the scale factor of the display he ends up on.
 */
describe('clampRectInsideWorkAreasAt', () => {
  const S: Rect = { x: 0, y: 0, width: 1920, height: 1040 };

  it('is the plain clamp when the inset is the same everywhere', () => {
    const inset = { left: 16, right: 16, top: 40, bottom: 0 };
    let asked = 0;
    const insetAt = (): typeof inset => {
      asked++;
      return inset;
    };
    const rect = { x: 1900, y: 1000, width: 176, height: 184 };
    expect(clampRectInsideWorkAreasAt(rect, [S], insetAt)).toEqual(
      clampRectInsideWorkAreas(rect, [S], inset)
    );
    // Once at the rect, once where he landed.
    expect(asked).toBe(2);
  });

  it('does not ask for an inset when there are no work areas', () => {
    let asked = 0;
    const insetAt = (): RectInset => {
      asked++;
      return {};
    };
    const rect = { x: 123, y: 456, width: 176, height: 184 };
    expect(clampRectInsideWorkAreasAt(rect, [], insetAt)).toEqual({ x: 123, y: 456 });
    expect(clampRectInsideWorkAreasAt(rect, [{ x: 0, y: 0, width: 0, height: 0 }], insetAt)).toEqual(
      { x: 123, y: 456 }
    );
    expect(asked).toBe(0);
  });

  it('measures him with the inset of the display he lands on', () => {
    // A 100 % display with a taskbar on the seam, then a 125 % one where he is
    // drawn larger (a smaller inset). The display is the one his centre is on.
    const A: Rect = { x: 0, y: 0, width: 952, height: 1080 };
    const B: Rect = { x: 1000, y: 0, width: 1000, height: 1080 };
    const onA = { left: 16, right: 16, top: 40, bottom: 0 };
    const onB = { left: 2, right: 2, top: 40, bottom: 0 };
    const insetAt = (at: Rect): typeof onA => (at.x + at.width / 2 < 976 ? onA : onB);
    const rect = (x: number): Rect => ({ x, y: 300, width: 176, height: 184 });

    // Centre on B, measured as on B (ink 890..1062): 110 to either side, the
    // tie goes left — onto A, where he is the smaller dog. Re-measured there
    // (ink 904..1048): 96 either way, left again, and that answer stands.
    const q = clampRectInsideWorkAreasAt(rect(888), [A, B], insetAt);
    expect(q).toEqual({ x: 792, y: 300 });
    expect(coveredByWorkAreas({ ...rect(888), ...q }, [A, B], insetAt({ ...rect(888), ...q }))).toBe(
      true
    );
    // A fixed point: asked about where he now is, it answers the same.
    expect(clampRectInsideWorkAreasAt(rect(q.x), [A, B], insetAt)).toEqual(q);

    // And every position along a drag over the strip ends covered under the
    // inset of the display it ends on, and stays put when asked again.
    for (let x = 600; x <= 1300; x += 3) {
      const p = clampRectInsideWorkAreasAt(rect(x), [A, B], insetAt);
      const landed = { ...rect(x), ...p };
      expect(coveredByWorkAreas(landed, [A, B], insetAt(landed)), `x ${x}`).toBe(true);
      expect(clampRectInsideWorkAreasAt(landed, [A, B], insetAt), `x ${x}`).toEqual(p);
    }
  });

  it('ends, covered under either inset, when the two insets send him to each other', () => {
    // Contrived so that each inset lands him where the other applies: the
    // largest ink seen decides, and he is covered whichever way he is measured.
    const big = {};
    const smallInk = { right: 150 };
    let asked = 0;
    const insetAt = (at: Rect): { right?: number } => {
      asked++;
      return at.x >= 1760 ? big : smallInk;
    };
    const rect = { x: 1900, y: 100, width: 200, height: 100 };
    const q = clampRectInsideWorkAreasAt(rect, [S], insetAt);
    expect(asked).toBe(3);
    expect(q).toEqual({ x: 1720, y: 100 });
    expect(coveredByWorkAreas({ ...rect, ...q }, [S], big)).toBe(true);
    expect(coveredByWorkAreas({ ...rect, ...q }, [S], smallInk)).toBe(true);
    expect(clampRectInsideWorkAreasAt({ ...rect, ...q }, [S], insetAt)).toEqual(q);
  });
});

describe('bottomRightOf', () => {
  it('insets from the bottom-right corner of the work area', () => {
    expect(bottomRightOf(LAPTOP, 192, 192, 16)).toEqual({
      x: 1440 - 192 - 16,
      y: 25 + 875 - 192 - 16
    });
  });

  it('accounts for a work area offset by the menu bar', () => {
    const { y } = bottomRightOf(LAPTOP, 192, 192, 16);
    expect(y).toBeGreaterThanOrEqual(LAPTOP.y);
  });

  it('never places a too-large window outside the work area', () => {
    expect(bottomRightOf(LAPTOP, 4000, 4000, 16)).toEqual({ x: LAPTOP.x, y: LAPTOP.y });
  });
});

describe('overlayMetrics', () => {
  it('sizes the window from the given stand box plus padding and bubble reserve', () => {
    /*
     * width = box.w*s + 2*(8*s), height = box.h*s + bubbleReservePx(s).
     *
     * The reserve used to be `24 * scale`, which made the bubble a *fraction of
     * the dog* rather than a thing with a size of its own: at Small it was 24 px
     * of room for an 8 px font, which is a bubble you have to lean in to read.
     * It is now derived from the font the renderer will actually use at that
     * size (`bubbleFontPx`), so it barely grows — 48 / 54 / 58 — and the window
     * at Small gets *taller* than it used to be while the one at Large gets
     * shorter. That asymmetry is the point.
     */
    expect(overlayMetrics(1, STAND)).toEqual({
      width: 64,
      height: 40 + 48,
      pad: 8,
      bubbleReserve: 48,
      bubbleExtra: 0
    });
    expect(overlayMetrics(2, STAND)).toEqual({
      width: 128,
      height: 80 + 54,
      pad: 16,
      bubbleReserve: 54,
      bubbleExtra: 0
    });
    expect(overlayMetrics(3, STAND)).toEqual({
      width: 192,
      height: 120 + 58,
      pad: 24,
      bubbleReserve: 58,
      bubbleExtra: 0
    });
  });

  /**
   * The sleeping box is the one place the reserve is dropped: Walder never
   * sleeps with something to say (a bark wakes him into the standing box first),
   * so 24 sprite-pixels of empty space above a curled-up dog would make the tiny
   * mode mostly transparent padding.
   */
  it('drops the bubble reserve for a box that cannot show a bubble', () => {
    const SLEEP: BoxSize = { width: 32, height: 24 };
    expect(boxMetrics(2, SLEEP, false)).toEqual({
      width: 96,
      height: 48,
      pad: 16,
      bubbleReserve: 0,
      bubbleExtra: 0
    });
    // …and the ink inset then trims only the sides.
    expect(inkInset(boxMetrics(2, SLEEP, false))).toEqual({
      left: 16,
      right: 16,
      top: 0,
      bottom: 0
    });
  });

  it('agrees with overlayMetrics when the reserve is kept', () => {
    expect(boxMetrics(2, STAND, true)).toEqual(overlayMetrics(2, STAND));
  });

  it('takes the box from its argument, not from a hard-coded 48x40', () => {
    // The design gate freed the art to choose its own box; this is the assertion
    // that the window follows it. A 64x56 sheet must produce a 64x56-shaped
    // window, with the padding and reserve unchanged.
    const tall: BoxSize = { width: 64, height: 56 };
    expect(overlayMetrics(2, tall)).toEqual({
      width: 64 * 2 + 2 * 16,
      height: 56 * 2 + bubbleReservePx(2),
      pad: 16,
      bubbleReserve: bubbleReservePx(2),
      bubbleExtra: 0
    });
  });

  it('grows strictly with scale', () => {
    expect(overlayMetrics(1, STAND).width).toBeLessThan(overlayMetrics(2, STAND).width);
    expect(overlayMetrics(2, STAND).height).toBeLessThan(overlayMetrics(3, STAND).height);
  });
});

/**
 * The window widens for a bubble that does not fit.
 *
 * The bug: a click-through window cannot grow once the renderer is drawing, so
 * its width is fixed at creation — and at `small` (1 logical pixel per sprite
 * pixel) the standing box is 64 px, about 14 monospace columns. Two lines of
 * that hold `5-hour: 85% used` but not `7-day (all models): 85% used`, which
 * arrived as `7-day (all mod…`: no window name and no number, which is the
 * whole content of the bark.
 */
describe('bubbleExtraPx', () => {
  it('takes nothing when there is no bubble', () => {
    expect(bubbleExtraPx(0, 1, STAND)).toBe(0);
    expect(bubbleExtraPx(-5, 1, STAND)).toBe(0);
    expect(boxMetrics(1, STAND, true, bubbleExtraPx(0, 1, STAND)).width).toBe(
      overlayMetrics(1, STAND).width
    );
  });

  it('takes nothing for the bubbles that are not sentences', () => {
    // `woof` and `?` are the common bubbles, and neither may resize anything —
    // at any size, and at the one-line fit too. A window that resized on every
    // perk would be a window that resized several times a minute.
    for (const scale of [1, 2, 3]) {
      expect(bubbleExtraPx(bubbleColumnsNeeded('woof', 1), scale, STAND), `woof @${scale}x`).toBe(0);
      expect(bubbleExtraPx(bubbleColumnsNeeded('?', 1), scale, STAND), `? @${scale}x`).toBe(0);
    }
  });

  it('widens for an ordinary bark at Small and Medium, but not at Large', () => {
    /*
     * This test used to say the bark cost nothing at Medium and Large, because
     * `main/behaviour.ts` asked for a *two-line* fit. Since 0.2.5 it asks for
     * one line — the two-line fit depended on the renderer's row arithmetic and
     * on the column estimate, and either falling a pixel short cut a word off —
     * and one line of `5-hour: 82% used` is sixteen columns, which Small and
     * Medium do not hold for free. The dog is unmoved and the extra pixels are
     * transparent; that is the price of never ellipsising a warning.
     */
    const columns = bubbleColumnsNeeded('5-hour: 82% used', 1);
    expect(columns).toBe('5-hour: 82% used'.length);
    expect(bubbleExtraPx(columns, 1, STAND)).toBeGreaterThan(0);
    expect(bubbleExtraPx(columns, 2, STAND)).toBeGreaterThan(0);
    // At Large the window is already 192 px wide, which is more than sixteen
    // columns of a 16 px font plus the chrome.
    expect(bubbleExtraPx(columns, 3, STAND)).toBe(0);
  });

  it('needs least room where the window is already widest', () => {
    // The window grows with scale but the font grows with it too, so a long
    // bark needs a little help at every size — most at 1x, least at 3x. This is
    // the property that says the estimate tracks the renderer's own font size
    // rather than being a fudge tuned at one scale.
    const columns = bubbleColumnsNeeded('7-day (all models): 85% used', 1);
    const [one, two, three] = [1, 2, 3].map((s) => bubbleExtraPx(columns, s, STAND));
    expect(one).toBeGreaterThan(0);
    expect(one).toBeGreaterThanOrEqual(two as number);
    expect(two).toBeGreaterThanOrEqual(three as number);
    // …and never past the cap: a one-line fit for the longest real bark is a
    // wider window than the two-line one was, and `BUBBLE_EXTRA_MAX_PX` is the
    // bound that matters — see the table below, which pins that it is not hit.
    expect(one).toBeLessThan(BUBBLE_EXTRA_MAX_PX);
  });

  it('widens the small window enough for a long bark', () => {
    const columns = bubbleColumnsNeeded('7-day (all models): 85% used', 1);
    const extra = bubbleExtraPx(columns, 1, STAND);
    expect(extra).toBeGreaterThan(0);

    // The widened window really does hold the text: the bubble's own chrome
    // plus `columns` columns has to fit inside it.
    const widened = boxMetrics(1, STAND, true, extra);
    expect(widened.width).toBeGreaterThanOrEqual(
      columns * bubbleColumnPx(1) + BUBBLE_CHROME_PX
    );
  });

  it('is symmetric, so the dog does not move when a bubble appears', () => {
    const extra = bubbleExtraPx(bubbleColumnsNeeded('7-day (all models): 85% used', 1), 1, STAND);
    const rest = overlayMetrics(1, STAND);
    const wide = boxMetrics(1, STAND, true, extra);
    expect(wide.width - rest.width).toBe(2 * extra);
    // The sprite is centred in the window, so an equal widening either side
    // leaves it exactly where it was.
    const before = spriteOrigin(rest.width, rest.height, STAND.width, STAND.height, 1);
    const after = spriteOrigin(wide.width, wide.height, STAND.width, STAND.height, 1);
    expect(after.x - before.x).toBe(extra);
    expect(after.y).toBe(before.y);
  });

  it('is capped, so a pathological label cannot make a banner', () => {
    expect(bubbleExtraPx(10_000, 3, STAND)).toBe(BUBBLE_EXTRA_MAX_PX);
  });

  it('counts as transparent surround for the off-screen guard', () => {
    // The widening is empty pixels either side of the dog, so the clamp that
    // keeps him inside the screen must not measure it as part of him.
    const metrics = boxMetrics(1, STAND, true, 40);
    expect(inkInset(metrics)).toEqual({
      left: 48,
      right: 48,
      top: bubbleReservePx(1),
      bottom: 0
    });
  });
});

/**
 * A saved position is always the standing window's top-left, because that is
 * how startup reads it back. These are the shipped sheet's windows at Small
 * (scale 1): stand 88x120, sleep 87x62, lie 88x72 — the sleep and lie ones are
 * what the dog was in when a quit relaunched him 58 / 48 px lower.
 */
describe('restingRect', () => {
  const SHEET_STAND: BoxSize = { width: 72, height: 72 };
  const SHEET_SLEEP: BoxSize = { width: 71, height: 62 };
  const rest = boxMetrics(1, SHEET_STAND, true);
  const sleep = boxMetrics(1, SHEET_SLEEP, false);
  const lie = boxMetrics(1, SHEET_STAND, false);

  it('models the windows the bug report measured', () => {
    expect([rest.width, rest.height]).toEqual([88, 120]);
    expect([sleep.width, sleep.height]).toEqual([87, 62]);
    expect([lie.width, lie.height]).toEqual([88, 72]);
  });

  it('keeps the bottom-left of a sleeping window', () => {
    expect(restingRect({ x: 1609, y: 1009, width: 87, height: 62 }, sleep, rest)).toEqual({
      x: 1609,
      y: 951,
      width: 88,
      height: 120
    });
  });

  it('keeps the bottom-left of a lying window', () => {
    expect(restingRect({ x: 1609, y: 1009, width: 88, height: 72 }, lie, rest)).toEqual({
      x: 1609,
      y: 961,
      width: 88,
      height: 120
    });
  });

  it('is the identity on a standing window at rest', () => {
    const rect = { x: 300, y: 400, width: rest.width, height: rest.height };
    expect(restingRect(rect, rest, rest)).toEqual(rect);
  });

  it('undoes the bubble widening, which moved the left edge out', () => {
    const extra = 40;
    const widened = boxMetrics(1, SHEET_STAND, true, extra);
    const rect = { x: 300 - extra, y: 400, width: widened.width, height: widened.height };
    expect(restingRect(rect, widened, rest)).toEqual({
      x: 300,
      y: 400,
      width: rest.width,
      height: rest.height
    });
  });
});

describe('spriteOrigin', () => {
  it('centres the stand box horizontally and sits it on the bottom edge', () => {
    const { width, height } = overlayMetrics(3, STAND);
    const origin = spriteOrigin(width, height, 48, 40, 3);
    expect(origin).toEqual({ x: 24, y: height - 40 * 3 });
    // Padding is symmetric, so the left inset equals the metrics pad.
    expect(origin.x).toBe(overlayMetrics(3, STAND).pad);
  });

  it('centres the smaller sleep box in the same window', () => {
    const { width, height } = overlayMetrics(3, STAND);
    const origin = spriteOrigin(width, height, 32, 24, 3);
    expect(origin.x).toBe(Math.round((width - 32 * 3) / 2));
    expect(origin.y).toBe(height - 24 * 3);
    // Both boxes rest on the same floor.
    expect(origin.y + 24 * 3).toBe(spriteOrigin(width, height, 48, 40, 3).y + 40 * 3);
  });

  it('returns integers so pixels stay aligned', () => {
    const origin = spriteOrigin(191, 191, 48, 40, 3);
    expect(Number.isInteger(origin.x)).toBe(true);
    expect(Number.isInteger(origin.y)).toBe(true);
  });
});

/**
 * QA row 1.8 (owner, 125 % display scaling, 2026-10-03): the dog is drawn at a
 * whole number of device pixels per sprite pixel, which at a fractional scale
 * factor is not his nominal size — and the layout used the nominal size, so at
 * Small he was drawn 20 % smaller than the box he was placed by, from that box's
 * top-left, with his feet floating above the window's floor. `spriteLayout`
 * lays him out at the size he is drawn.
 */
describe('spriteLayout: the sprite laid out at the size it is drawn', () => {
  /** The shipped stand box: the case the owner saw. */
  const SHIPPED_STAND: BoxSize = { width: 72, height: 72 };
  const DPRS = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3] as const;
  const SCALES = [1, 2, 3] as const;

  function standLayout(scale: number, dpr: number, box: BoxSize = SHIPPED_STAND, bob = 0) {
    const win = overlayMetrics(scale, box);
    const pixelScale = devicePixelScale(scale, dpr, spriteFit(scale, box));
    return {
      win,
      layout: spriteLayout({
        viewWidth: win.width,
        viewHeight: win.height,
        box,
        scale,
        pixelScale,
        dpr,
        bob
      })
    };
  }

  it('stands him on the window floor at 125 % Small, where he used to float', () => {
    const { win, layout } = standLayout(1, 1.25);
    // 88 x 120 CSS px is 110 x 150 device px, and the dog is 72 x 72 of them.
    expect(win.width).toBe(88);
    expect(deviceExtent(win.width, 1.25)).toBe(110);
    expect(deviceExtent(win.height, 1.25)).toBe(150);
    expect(layout.pixelScale).toBe(1);
    expect(layout.cssScale).toBeCloseTo(0.8, 12);
    expect(layout.device).toEqual({ x: 19, y: 78 });
    // Feet on the floor: his bottom device row is the canvas's last.
    expect(layout.device.y + SHIPPED_STAND.height * layout.pixelScale).toBe(150);

    // The old placement — the nominal box, its CSS top-left multiplied out —
    // put the same 72-pixel bitmap's feet 18 device pixels above the floor.
    const old = spriteOrigin(win.width, win.height, SHIPPED_STAND.width, SHIPPED_STAND.height, 1);
    const oldFeet = Math.round(old.y * 1.25) + SHIPPED_STAND.height * layout.pixelScale;
    expect(150 - oldFeet).toBe(18);
  });

  it('is bottom-aligned and centred at every size and common scale factor', () => {
    for (const box of [SHIPPED_STAND, STAND]) {
      for (const scale of SCALES) {
        for (const dpr of DPRS) {
          const { win, layout } = standLayout(scale, dpr, box);
          const label = `${box.width}x${box.height} scale ${scale} dpr ${dpr}`;
          const viewW = deviceExtent(win.width, dpr);
          const viewH = deviceExtent(win.height, dpr);
          const drawnW = box.width * layout.pixelScale;
          const drawnH = box.height * layout.pixelScale;

          expect(layout.device.y + drawnH, label).toBe(viewH);
          const left = layout.device.x;
          const right = viewW - (layout.device.x + drawnW);
          expect(Math.abs(left - right), label).toBeLessThanOrEqual(1);
          // Never wider than the window (the fit cap), so neither gap is negative.
          expect(left, label).toBeGreaterThanOrEqual(0);
          expect(right, label).toBeGreaterThanOrEqual(0);

          // Whole device pixels; CSS is the same point divided by dpr, never rounded.
          expect(Number.isInteger(layout.device.x), label).toBe(true);
          expect(Number.isInteger(layout.device.y), label).toBe(true);
          expect(layout.css.x * dpr).toBeCloseTo(layout.device.x, 9);
          expect(layout.css.y * dpr).toBeCloseTo(layout.device.y, 9);
          expect(layout.cssScale * dpr).toBeCloseTo(layout.pixelScale, 12);
        }
      }
    }
  });

  it('is exactly the old placement at every whole ratio', () => {
    for (const scale of SCALES) {
      for (const dpr of [1, 2, 3]) {
        const { win, layout } = standLayout(scale, dpr);
        const old = spriteOrigin(win.width, win.height, SHIPPED_STAND.width, SHIPPED_STAND.height, scale);
        expect(layout.cssScale).toBe(scale);
        expect(layout.css).toEqual(old);
      }
    }
  });

  it('moves him down by whole sprite pixels for the pet bob', () => {
    const rest = standLayout(2, 1.25).layout;
    const bobbed = standLayout(2, 1.25, SHIPPED_STAND, 1).layout;
    expect(bobbed.device.y - rest.device.y).toBe(rest.pixelScale);
    expect(bobbed.device.x).toBe(rest.device.x);
    // The bubble does not ride the bob.
    expect(bobbed.bubbleFloor).toBe(rest.bubbleFloor);
  });

  it("brings the bubble down to a smaller dog, but never above a larger one's nominal top", () => {
    // Smaller (125 % Small, 0.8x): the floor is his drawn top, so the tail still
    // touches his head.
    const small = standLayout(1, 1.25);
    expect(small.layout.bubbleFloor).toBe(small.layout.device.y);
    // Larger (125 % Medium, 1.2x): following his drawn top would leave the
    // two-line reserve no room; the floor stays at the nominal box's top.
    const medium = standLayout(2, 1.25);
    const nominalTop = Math.floor((medium.win.height - SHIPPED_STAND.height * 2) * 1.25);
    expect(medium.layout.device.y).toBeLessThan(nominalTop);
    expect(medium.layout.bubbleFloor).toBe(nominalTop);
    // Exact sizes: one and the same row.
    const exact = standLayout(2, 2);
    expect(exact.layout.bubbleFloor).toBe(exact.layout.device.y);
  });

  it('caps the size to the stand window, with no bubble widening', () => {
    for (const scale of SCALES) {
      expect(spriteFit(scale, SHIPPED_STAND)).toEqual({
        room: boxMetrics(scale, SHIPPED_STAND, false).width,
        box: SHIPPED_STAND.width
      });
      // A bark widens the window; the dog must not grow because of it.
      expect(spriteFit(scale, SHIPPED_STAND).room).toBe(overlayMetrics(scale, SHIPPED_STAND).width);
    }
  });

  it('measures the view the way the canvas is sized', () => {
    expect(deviceExtent(88, 1.25)).toBe(110);
    // 130.5 rounds up, as Math.round does.
    expect(deviceExtent(87, 1.5)).toBe(131);
    expect(deviceExtent(0, 2)).toBe(1);
    expect(deviceExtent(100, 0)).toBe(100);
  });
});

/**
 * QA row 1.8, the follow-up: the clamps in main measured the dog's ink at his
 * nominal size, so at 125 % Medium — drawn 20 % larger, 172.8 of a 176 px
 * window — Size ▸ Medium at the default corner settled the nominal box flush
 * with the right edge and left 18 physical px of the drawn dog off the screen.
 * `drawnInkInset` measures the box as the renderer draws it.
 */
describe('drawnInkInset: the ink rect at the size he is drawn', () => {
  const SHIPPED_STAND: BoxSize = { width: 72, height: 72 };
  const SHIPPED_SLEEP: BoxSize = { width: 61, height: 58 };

  function standInset(scale: number, dpr: number, bubbleExtra = 0) {
    const metrics = boxMetrics(scale, SHIPPED_STAND, true, bubbleExtra);
    const inset = drawnInkInset({
      metrics,
      scale,
      box: SHIPPED_STAND,
      standBox: SHIPPED_STAND,
      dpr
    });
    const drawn = SHIPPED_STAND.width * spriteCssScale(scale, dpr, spriteFit(scale, SHIPPED_STAND));
    return { metrics, inset, drawn };
  }

  it('is the nominal inset, byte for byte, wherever he is drawn at his nominal size', () => {
    // dpr 1 is the pin: the behaviour every corner test in main was written
    // against. 2 and 3 are whole ratios, 1.5 Medium happens to be exact (3 / 1.5).
    for (const dpr of [1, 2, 3]) {
      for (const scale of [1, 2, 3]) {
        for (const extra of [0, 25, 76]) {
          const { metrics, inset } = standInset(scale, dpr, extra);
          expect(inset, `scale ${scale} dpr ${dpr} extra ${extra}`).toEqual(inkInset(metrics));
        }
        const sleep = boxMetrics(scale, SHIPPED_SLEEP, false);
        expect(
          drawnInkInset({
            metrics: sleep,
            scale,
            box: SHIPPED_SLEEP,
            standBox: SHIPPED_STAND,
            dpr
          }),
          `sleep scale ${scale} dpr ${dpr}`
        ).toEqual(inkInset(sleep));
      }
    }
    expect(standInset(2, 1.5).inset).toEqual(inkInset(standInset(2, 1.5).metrics));
  });

  it('narrows the side inset at 125 % Medium, where he is drawn 172.8 wide in 176', () => {
    const { metrics, inset, drawn } = standInset(2, 1.25);
    expect(metrics.width).toBe(176);
    expect(drawn).toBeCloseTo(172.8, 9);
    // 1.6 px of padding a side, not the nominal 16, floored to a whole pixel;
    // his drawn top is 25.6 px down the window where the nominal box's is 54.
    expect(inset).toEqual({ left: 1, right: 1, top: 25, bottom: 0 });
    expect(inkInset(metrics)).toEqual({ left: 16, right: 16, top: 54, bottom: 0 });
    // Never narrower than what is drawn, and less than a pixel a side wider.
    const inkWidth = metrics.width - inset.left - inset.right;
    expect(inkWidth).toBeGreaterThanOrEqual(drawn);
    expect(inkWidth - drawn).toBeLessThan(2);
  });

  it('widens the side inset at 125 % Small, where he is drawn 57.6 wide in 88', () => {
    const { metrics, inset, drawn } = standInset(1, 1.25);
    expect(metrics.width).toBe(88);
    expect(drawn).toBeCloseTo(57.6, 9);
    expect(inset).toEqual({ left: 15, right: 15, top: 62, bottom: 0 });
    expect(inset.left).toBeGreaterThan(inkInset(metrics).left);
    const inkWidth = metrics.width - inset.left - inset.right;
    expect(inkWidth).toBeGreaterThanOrEqual(drawn);
    expect(inkWidth - drawn).toBeLessThan(2);
  });

  it('measures 150 % Large, drawn at 5 device px (3.33 CSS) per sprite pixel', () => {
    const { metrics, inset, drawn } = standInset(3, 1.5);
    expect(metrics.width).toBe(264);
    expect(drawn).toBeCloseTo(240, 9);
    // Exactly 12 a side: the epsilon keeps 11.99999999999997 from flooring to 11.
    expect(inset).toEqual({ left: 12, right: 12, top: 34, bottom: 0 });
  });

  it('keeps the bubble widening in the side inset, as the nominal inset does', () => {
    const plain = standInset(2, 1.25).inset;
    const widened = standInset(2, 1.25, 40).inset;
    expect(widened).toEqual({ ...plain, left: plain.left + 40, right: plain.right + 40 });
  });

  it('never reaches above the window: a larger dog in a window with no reserve', () => {
    // 125 % Medium asleep: 58 sprite px drawn 139.2 tall in a 116 px window.
    const sleep = boxMetrics(2, SHIPPED_SLEEP, false);
    const inset = drawnInkInset({
      metrics: sleep,
      scale: 2,
      box: SHIPPED_SLEEP,
      standBox: SHIPPED_STAND,
      dpr: 1.25
    });
    expect(inset.top).toBe(0);
    expect(inset.bottom).toBe(0);
  });

  it('is whole pixels and never negative at every size and common scale factor', () => {
    for (const scale of [1, 2, 3]) {
      for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3]) {
        const { metrics, inset, drawn } = standInset(scale, dpr);
        const label = `scale ${scale} dpr ${dpr}`;
        for (const edge of [inset.left, inset.right, inset.top, inset.bottom]) {
          expect(Number.isInteger(edge), label).toBe(true);
          expect(edge, label).toBeGreaterThanOrEqual(0);
        }
        expect(metrics.width - inset.left - inset.right, label).toBeGreaterThanOrEqual(drawn - 1e-9);
      }
    }
  });

  /*
   * 2026-11-17 (review of the always-inside rule): a window read back from the
   * system can be a DIP or two larger than its metrics (125 % on Windows), and
   * the overlay measured his ink there as the metrics' inset plus the surplus.
   * That calls the extra rows air above his head, which they are only while
   * the box is not clipped by the window.
   */
  describe('in a window that is not the size it was laid out for (view)', () => {
    const SHIPPED_LIE: BoxSize = { width: 72, height: 72 };
    /** Where the renderer draws the box in a window of this size: its own arithmetic. */
    function rendered(box: BoxSize, scale: number, dpr: number, width: number, height: number) {
      const layout = spriteLayout({
        viewWidth: width,
        viewHeight: height,
        box,
        scale,
        pixelScale: devicePixelScale(scale, dpr, spriteFit(scale, SHIPPED_STAND)),
        dpr
      });
      return {
        left: layout.css.x,
        right: width - (layout.css.x + box.width * layout.cssScale),
        // The window clips what is drawn above it.
        top: Math.max(0, layout.css.y)
      };
    }

    it('is the plain answer when the view is the metrics own size', () => {
      for (const dpr of [1, 1.25, 1.5, 2]) {
        for (const scale of [1, 2, 3]) {
          const metrics = boxMetrics(scale, SHIPPED_STAND, true, 25);
          const input = { metrics, scale, box: SHIPPED_STAND, standBox: SHIPPED_STAND, dpr };
          expect(
            drawnInkInset({ ...input, view: { width: metrics.width, height: metrics.height } }),
            `scale ${scale} dpr ${dpr}`
          ).toEqual(drawnInkInset(input));
        }
      }
    });

    it('a clipped box in a taller window: the extra rows are dog until the window is taller than he is', () => {
      // 125 % Medium asleep: drawn 139.2 tall in a 116 px window, clipped by 23.2.
      const sleep = boxMetrics(2, SHIPPED_SLEEP, false);
      expect(sleep.height).toBe(116);
      const top = (surplus: number): number =>
        drawnInkInset({
          metrics: sleep,
          scale: 2,
          box: SHIPPED_SLEEP,
          standBox: SHIPPED_STAND,
          dpr: 1.25,
          view: { width: sleep.width, height: sleep.height + surplus }
        }).top;
      // Not the surplus: his head is at the window's top all the way.
      for (const surplus of [0, 1, 2, 10, 23]) expect(top(surplus), `+${surplus}`).toBe(0);
      // From 24 on the window is taller than the dog, and the rest is air.
      expect(top(24)).toBe(0); // 140 - 139.2 = 0.8
      expect(top(25)).toBe(1);
      expect(top(40)).toBe(16);
    });

    it('is never smaller ink than the renderer draws, and less than a pixel larger, at every surplus', () => {
      const cases: [string, BoxSize, boolean][] = [
        ['stand', SHIPPED_STAND, true],
        ['sleep', SHIPPED_SLEEP, false],
        ['sleep zzz', SHIPPED_SLEEP, true],
        ['lie', SHIPPED_LIE, false],
        ['lie bubble', SHIPPED_LIE, true]
      ];
      const wrong: string[] = [];
      for (const [name, box, reserve] of cases) {
        for (const scale of [1, 2, 3]) {
          for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.25]) {
            for (const extra of [0, 31]) {
              const metrics = boxMetrics(scale, box, reserve, extra);
              for (let wider = -2; wider <= 5; wider++) {
                for (let taller = -2; taller <= 60; taller++) {
                  // The window as laid out is the case above: where he is
                  // drawn at his nominal size it stays the nominal inset, with
                  // the half device pixel of centring that was always accepted.
                  if (wider === 0 && taller === 0) continue;
                  const view = { width: metrics.width + wider, height: metrics.height + taller };
                  const inset = drawnInkInset({
                    metrics,
                    scale,
                    box,
                    standBox: SHIPPED_STAND,
                    dpr,
                    view
                  });
                  const real = rendered(box, scale, dpr, view.width, view.height);
                  for (const edge of ['left', 'right', 'top'] as const) {
                    const ok =
                      Number.isInteger(inset[edge]) &&
                      inset[edge] <= real[edge] + 1e-6 &&
                      inset[edge] > real[edge] - 1 - 1e-6;
                    if (!ok || inset.bottom !== 0) {
                      wrong.push(
                        `${name} scale ${scale} dpr ${dpr} extra ${extra} +${wider}x+${taller} ` +
                          `${edge}: measured ${inset[edge]}, drawn ${real[edge]}`
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }
      expect(wrong).toEqual([]);
    });

    it('at a whole scale factor it is the nominal inset with the surplus where the renderer puts it', () => {
      // Centred across, so a wider window has half the surplus each side (the
      // odd pixel on the left, where `spriteOrigin` rounds it); feet on the
      // floor, so a taller one has all of it above him.
      const metrics = boxMetrics(2, SHIPPED_STAND, true);
      const nominal = inkInset(metrics);
      const at = (wider: number, taller: number) =>
        drawnInkInset({
          metrics,
          scale: 2,
          box: SHIPPED_STAND,
          standBox: SHIPPED_STAND,
          dpr: 1,
          view: { width: metrics.width + wider, height: metrics.height + taller }
        });
      expect(at(2, 1)).toEqual({
        left: nominal.left + 1,
        right: nominal.right + 1,
        top: nominal.top + 1,
        bottom: 0
      });
      expect(at(1, 0)).toEqual({ ...nominal, left: nominal.left + 1 });
      expect(at(0, 2)).toEqual({ ...nominal, top: nominal.top + 2 });
    });

    it('ignores a view that is no size at all', () => {
      const metrics = boxMetrics(2, SHIPPED_STAND, true);
      const input = { metrics, scale: 2, box: SHIPPED_STAND, standBox: SHIPPED_STAND, dpr: 1.25 };
      for (const view of [
        { width: 0, height: 0 },
        { width: Number.NaN, height: Number.NaN },
        { width: -5, height: Number.POSITIVE_INFINITY }
      ]) {
        expect(drawnInkInset({ ...input, view })).toEqual(drawnInkInset(input));
      }
    });
  });
});

/**
 * A dog drawn larger than nominal (up to +20 % at the common scale factors) is
 * still bottom-aligned, so he reaches *up*: into the bubble reserve in the
 * standing window, and — in the sleeping and lying windows, which have no
 * reserve — into the transparent rows above his ink. Whether those rows are
 * enough is a property of the art, so it is checked against the art the app
 * ships: every frame of every coat, at every size and scale factor, keeps its
 * ink inside its window. If re-authored art ever fails this, the dog's top
 * would be clipped; `devicePixelScale`'s fit would then need a vertical term.
 */
describe('the shipped art fits its window at the size it is drawn', () => {
  const sheet = validateSheet(shipped);
  const DOG_BOXES: readonly string[] = ['stand', 'sleep', 'lie', 'lie_down'] satisfies BoxName[];
  const stand = { width: sheet.boxes.stand?.[0] ?? 0, height: sheet.boxes.stand?.[1] ?? 0 };
  const frameLists = [sheet.frames, ...Object.values(sheet.frameSets)];

  it("keeps every frame's ink inside the window", () => {
    let checked = 0;
    for (const frames of frameLists) {
      for (const [name, frame] of Object.entries(frames)) {
        if (!DOG_BOXES.includes(frame.box)) continue;
        const { width, height } = frameSize(frame);
        const ink = maskBounds(frameAlphaMask(frame), width, height);
        if (ink === null) continue;
        for (const scale of [1, 2, 3]) {
          for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3]) {
            // The window main gives this box with no bubble up (`metricsFor`).
            const win = boxMetrics(scale, { width, height }, frame.box === 'stand');
            const layout = spriteLayout({
              viewWidth: win.width,
              viewHeight: win.height,
              box: { width, height },
              scale,
              pixelScale: devicePixelScale(scale, dpr, spriteFit(scale, stand)),
              dpr
            });
            const n = layout.pixelScale;
            const label = `${name} scale ${scale} dpr ${dpr}`;
            expect(layout.device.x + ink.minX * n, label).toBeGreaterThanOrEqual(0);
            expect(layout.device.y + ink.minY * n, label).toBeGreaterThanOrEqual(0);
            expect(layout.device.x + (ink.maxX + 1) * n, label).toBeLessThanOrEqual(
              deviceExtent(win.width, dpr)
            );
            expect(layout.device.y + (ink.maxY + 1) * n, label).toBeLessThanOrEqual(
              deviceExtent(win.height, dpr)
            );
            checked++;
          }
        }
      }
    }
    // A sheet with no dog frames must fail here, not pass by checking nothing.
    expect(checked).toBeGreaterThan(0);
  });
});


describe('the bubble is sized for reading, not for the dog', () => {
  /*
   * The owner's report (2026-09-11): "Have the speaking boubles be the same size
   * regardless of walders size, and have it be of normal size so it's noticeable
   * and takes your attention. It's too small at the moment."
   *
   * The font was `6 * scale` CSS pixels — 6 / 12 / 18, floored at 8 — so the
   * bubble was a *fraction of the dog*. Shrink the mascot to get him out of the
   * way and you shrink the only thing he uses to tell you something, which is
   * exactly backwards. Asked to choose, the owner picked 12 / 14 / 16: not
   * literally constant, but a flat ramp with a floor high enough to read at any
   * size, and no runaway at Large where 18 px was starting to dwarf him.
   */
  it('uses the owner\'s 12 / 14 / 16, not a multiple of the sprite scale', () => {
    expect(bubbleFontPx(1)).toBe(12);
    expect(bubbleFontPx(2)).toBe(14);
    expect(bubbleFontPx(3)).toBe(16);
  });

  it('never lets the bubble shrink below readable, whatever scale it is handed', () => {
    // Defensive: `scale` reaches here from an IPC payload. A junk or absent one
    // must not produce a 2 px bubble or a NaN one.
    for (const scale of [0, -3, 0.5, Number.NaN, 99]) {
      const px = bubbleFontPx(scale);
      expect(Number.isFinite(px), `scale ${scale}`).toBe(true);
      expect(px, `scale ${scale}`).toBeGreaterThanOrEqual(12);
    }
  });

  it('reserves room for exactly two lines of whatever font that size uses', () => {
    /*
     * The reserve is the window's own height above the dog, and the bubble is
     * drawn inside it — a window cannot grow once the renderer is drawing, so a
     * reserve that is a line short does not scroll, it silently drops the second
     * line (`rows` in `layoutBubble`). This is the arithmetic that stops that,
     * mirrored from `layoutBubble` at dpr 1: two lines, plus the box's outline and
     * padding top and bottom, plus the tail, plus a pixel of air.
     */
    /*
     * Re-derived from `layoutBubble` at every device ratio the app meets, not just
     * at dpr 1, because every term there rounds independently: `unit` is
     * `round(dpr)`, the font is `round(bubbleFontPx * dpr)` and the line height
     * is `round(font * 1.2)`, so a reserve that clears the requirement at dpr 1
     * can miss it at dpr 2 by a couple of pixels — and missing it costs the
     * whole second line, which on `7-day (all models): 85% used` is the half
     * with the number in it.
     *
     * This mirrors the renderer's own `rows` arithmetic exactly: given the
     * reserve as `spriteTopCss`, it must compute at least 2.
     */
    const rowsThatFit = (scale: number, dpr: number): number => {
      const unit = Math.max(1, Math.round(dpr));
      const outline = 2 * unit;
      const padY = 2 * unit;
      const tailHeight = 3 * (2 * unit);
      const font = Math.round(bubbleFontPx(scale) * dpr);
      const lineHeight = Math.max(1, Math.round(font * 1.2));
      const boxSpace =
        Math.floor(bubbleReservePx(scale) * dpr) - unit - tailHeight + outline;
      return Math.floor((boxSpace - 2 * (outline + padY)) / lineHeight);
    };

    for (const scale of [1, 2, 3]) {
      for (const dpr of [1, 1.5, 2, 2.25, 3]) {
        expect(rowsThatFit(scale, dpr), `scale ${scale} @ dpr ${dpr}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('grows the reserve far more slowly than the dog', () => {
    // The whole point: tripling the mascot must not triple the bubble.
    expect(bubbleReservePx(3)).toBeLessThan(bubbleReservePx(1) * 2);
    expect(bubbleReservePx(1)).toBeLessThan(bubbleReservePx(2));
    expect(bubbleReservePx(2)).toBeLessThan(bubbleReservePx(3));
  });

  it('estimates a column at 0.62 em of that size\'s own font', () => {
    // `bubbleExtraPx` predicts the window width from a column count, and the
    // renderer then measures the real font and wraps to whatever the window
    // turned out to be. The estimate only has to track the font it will use —
    // but it must not be *mean*, and 0.6 was: SF Mono's advance is 0.618 em, so
    // a 28-column bark was under-predicted by a whole column, which is one
    // wrapped or cut word.
    for (const scale of [1, 2, 3]) {
      expect(bubbleColumnPx(scale)).toBeCloseTo(bubbleFontPx(scale) * 0.62, 5);
      expect(bubbleColumnPx(scale)).toBeGreaterThanOrEqual(
        bubbleFontPx(scale) * SF_MONO_ADVANCE
      );
    }
  });
});

/**
 * How much wider than `displayColumns` counts it `text` is drawn, in `M`s: the
 * renderer's `measureText(text) / displayColumns(text)`, never under 1. A
 * Devanagari cluster comes from a fallback face, which Electron 45 on macOS
 * drew at up to 1.3 `M` per cluster across a real Hindi sentence (Mac QA
 * 2026-11-19, canvas at 12 to 16 px); everything else is one column per column.
 */
const DRAWN_DEVANAGARI = 1.3;
const drawnAdvance = (text: string): number => {
  const clusters = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.trim()));
  let counted = 0;
  let drawn = 0;
  for (const { segment } of clusters) {
    const width = displayColumns(segment);
    counted += width;
    drawn += /[\u0900-\u097F]/u.test(segment) ? width * DRAWN_DEVANAGARI : width;
  }
  return counted === 0 ? 1 : Math.max(1, drawn / counted);
};

/**
 * Columns `layoutBubble` gets between window-relative CSS offsets `left` and
 * `right` of a window `width` wide: `unit = max(1, round(dpr))`, a two-unit
 * outline and three-unit horizontal padding each side, one unit of breathing
 * room at each edge, and the font rounded to whole device pixels before the
 * advance is applied. With `text`, the advance is `layoutBubble`'s own
 * `max(M, measured / displayColumns(text))`, the measurement modelled by
 * `drawnAdvance`.
 */
const colsBetween = (
  left: number,
  right: number,
  width: number,
  scale: number,
  dpr: number,
  text?: string
): number => {
  const unit = Math.max(1, Math.round(dpr));
  const outline = 2 * unit;
  const padX = 3 * unit;
  const viewWidth = Math.round(width * dpr);
  const maxBoxWidth =
    Math.min(viewWidth, Math.round(right * dpr)) - unit - (Math.round(left * dpr) + unit);
  const charWidth = Math.round(bubbleFontPx(scale) * dpr) * SF_MONO_ADVANCE * (text === undefined ? 1 : drawnAdvance(text));
  return Math.floor((maxBoxWidth - 2 * (outline + padX)) / charWidth);
};

/**
 * Every sentence Walder can put in a bubble, and the one thing that must be true
 * of all of them: **none is ever ellipsised**.
 *
 * The owner received `7-day (all models): 80%…` on 2026-09-15 — the bark without
 * the word that says what the number means. The window had been widened for a
 * two-line fit, which holds only if `layoutBubble` derives `rows = 2` from the
 * reserve *and* the measured advance stays inside the estimate; either falling a
 * pixel short costs a line, and a lost line is an ellipsis.
 *
 * So `main/behaviour.ts` asks for a one-line fit, and this is the table that says
 * every real sentence gets one. Two assertions per text:
 *
 *  - `bubbleExtraPx` does not hit `BUBBLE_EXTRA_MAX_PX` — a bark that needed
 *    more than the cap would be silently back to being cut, and the cap would be
 *    the thing doing the cutting;
 *  - the window that comes out gives the *renderer* at least `text.length`
 *    columns, re-derived from `layoutBubble`'s own arithmetic at every device
 *    ratio the app meets. That is the assertion the 0.6 estimate and the missing
 *    edge units in `BUBBLE_CHROME_PX` both failed, each by exactly one column.
 */
describe('no bark Walder can produce is ever cut', () => {
  /*
   * The 0.2.6 wording (`core/bubble.ts`'s `barkLabel`), which answered the
   * question the old table's last entry was holding open: every Claude row now
   * names its service, so `Claude 5h` and `Codex 5h` read as a pair and neither
   * is ambiguous about which tool spent the allowance. The whole set is shorter
   * than what it replaced, so the widening has more slack than before, not less
   * — but it is the *set* that this table pins, and a future label is only safe
   * once it is in here.
   */
  const BARKS = [
    // Every Claude row at its worst case: 100 %, which is the longest number.
    'Claude 5h: 100% used',
    'Claude 7-day: 100% used',
    'Fable weekly: 100% used',
    'Opus weekly: 100% used',
    'Sonnet weekly: 100% used',
    'Claude credits: 100% used',
    // Codex/ChatGPT.
    'Codex 5h: 100% used',
    'Codex weekly: 100% used',
    'Codex credits: 100% used',
    // The app's own notices.
    'Walder 0.2.5 is out',
    "You're up to date",
    'Install Claude Code hooks',
    'Reinstall Claude Code hooks',
    'Install Codex hooks',
    'Reinstall Codex hooks',
    // The hook bubbles, which name their tool for the same reason the barks do.
    'Claude waiting',
    'Codex waiting',
    'Claude done',
    'Codex done',
    // The second intro bubble and the logged-out notice (`core/strings.ts`).
    'Accounts ▸ Claude ▸ Log in',
    'Claude Code logged out'
  ];
  /*
   * The first intro bubble is the longest thing Walder says, and the one bark
   * that is *not* promised one line: at Small it wants 121 px a side, one past
   * `BUBBLE_EXTRA_MAX_PX`, so at dpr 1.5 it wraps to two. Two lines is what the
   * reserve is for, so that is a wrap, not a cut — and the on-screen case below,
   * which asserts the two-line guarantee, covers it with everything else.
   */
  const HELLO = 'Hello. Click the bone in your menu bar.';

  /**
   * The widening for a one-line fit of `text`, and `layoutBubble`'s column count
   * across the whole widened window (`colsBetween`, mirrored arithmetic).
   */
  const widened = (text: string, scale: number): number =>
    bubbleExtraPx(bubbleReserveColumns(text, 1), scale, STAND);
  const rendererCols = (text: string, scale: number, dpr: number): number => {
    const width = boxMetrics(scale, STAND, true, widened(text, scale)).width;
    return colsBetween(0, width, width, scale, dpr, text);
  };

  for (const text of BARKS) {
    it(`fits "${text}" on one line at every size`, () => {
      const columns = bubbleColumnsNeeded(text, 1);
      // One line means the whole sentence, spaces included.
      expect(columns).toBe(text.length);

      for (const scale of [1, 2, 3]) {
        expect(
          bubbleExtraPx(columns, scale, STAND),
          `${text} @${scale}x is against the cap`
        ).toBeLessThan(BUBBLE_EXTRA_MAX_PX);

        for (const dpr of [1, 1.5, 2, 2.25, 3]) {
          expect(
            rendererCols(text, scale, dpr),
            `${text} @${scale}x dpr ${dpr}`
          ).toBeGreaterThanOrEqual(text.length);
        }
      }
    });
  }

  /*
   * The same table in every language, built from that language's own table.
   * Columns are display columns (`displayColumns`): a Han character takes two.
   */
  const barksIn = (lang: Language): string[] => {
    setLanguage(lang);
    try {
      const tools = ['Claude', 'Codex'];
      return [
        ...(['claudeFiveHour', 'claudeSevenDay', 'claudeCredits', 'codexFiveHour'] as const).map((key) =>
          t('bubble.nudge', { label: t(`bubble.barkLabel.${key}`), pct: 100 })
        ),
        ...['Fable', 'Opus', 'Sonnet'].map((model) =>
          t('bubble.nudge', { label: t('bubble.barkLabel.modelWeekly', { model }), pct: 100 })
        ),
        ...(['bucket.codexWeekly', 'bucket.codexCredits'] as const).map((key) =>
          t('bubble.nudge', { label: t(key), pct: 100 })
        ),
        t('bubble.update', { version: '0.2.5' }),
        t('bubble.upToDate'),
        t('bubble.hooksMissing'),
        t('bubble.hooksStale'),
        t('bubble.codexHooksMissing'),
        t('bubble.codexHooksStale'),
        t('bubble.hooksOutdated'),
        t('bubble.codexHooksOutdated'),
        ...tools.flatMap((tool) => [t('bubble.hookWaiting', { tool }), t('bubble.hookDone', { tool })]),
        t('bubble.introLogin'),
        t('bubble.claudeLoggedOut')
      ];
    } finally {
      setLanguage('en');
    }
  };

  for (const lang of LANGUAGES) {
    it(`${lang}: fits every bark on one line at every size, and the hello in two`, () => {
      for (const text of barksIn(lang)) {
        const columns = bubbleColumnsNeeded(text, 1);
        expect(columns, text).toBe(displayColumns(text));
        for (const scale of [1, 2, 3]) {
          expect(bubbleExtraPx(bubbleReserveColumns(text, 1), scale, STAND), `${text} @${scale}x`).toBeLessThan(
            BUBBLE_EXTRA_MAX_PX
          );
          for (const dpr of [1, 1.5, 2, 2.25, 3]) {
            expect(rendererCols(text, scale, dpr), `${text} @${scale}x dpr ${dpr}`).toBeGreaterThanOrEqual(columns);
          }
        }
      }
      for (const hello of [TABLES[lang]['bubble.introHello'], TABLES[lang]['bubble.introHelloTray']]) {
        for (const scale of [1, 2, 3]) {
          const width = boxMetrics(scale, STAND, true, bubbleExtraPx(bubbleReserveColumns(hello, 1), scale, STAND)).width;
          for (const dpr of [1, 2]) {
            expect(colsBetween(0, width, width, scale, dpr, hello), `${hello} @${scale}x`).toBeGreaterThanOrEqual(
              bubbleColumnsNeeded(hello, 2)
            );
          }
        }
      }
    });
  }

  /*
   * Mac QA 2026-11-19: the Hindi up-to-date notice took two lines at Small
   * (and `Walder {version} आ गया है` measured within a pixel of it). The window
   * was widened for 19 columns of `M` and the renderer, measuring the
   * Devanagari fallback face, found fewer. Pinned at Small with the shipped
   * stand box, in every language, as the owner reads them.
   */
  it('puts both update notices on one line at Small in every language', () => {
    const stand: BoxSize = { width: 72, height: 72 };
    try {
      for (const lang of LANGUAGES) {
        setLanguage(lang);
        for (const text of [t('bubble.update', { version: '0.3.2' }), t('bubble.upToDate')]) {
          const extra = bubbleExtraPx(bubbleReserveColumns(text, 1), 1, stand);
          expect(extra, `${lang}: ${text}`).toBeLessThan(BUBBLE_EXTRA_MAX_PX);
          const width = boxMetrics(1, stand, true, extra).width;
          for (const dpr of [1, 1.5, 2]) {
            expect(colsBetween(0, width, width, 1, dpr, text), `${lang}: ${text} dpr ${dpr}`).toBeGreaterThanOrEqual(
              displayColumns(text)
            );
          }
        }
      }
    } finally {
      setLanguage('en');
    }
  });

  /*
   * The window is clamped on the dog's ink, not on the widening, so at the
   * default spot (`defaultPosition`: bottom-right, 16 px in) the widened window
   * hangs off the work area and `layoutBubble` lays out inside `onScreenSpan`
   * instead. What is left on screen must still hold the text in two lines —
   * the reserve's promise — on either edge.
   */
  it('fits every bark in two lines inside the on-screen part of the window', () => {
    const area: Rect = { x: 0, y: 0, width: 1728, height: 1117 };
    const margin = 16;
    for (const text of [...BARKS, HELLO, introHelloText('win32')]) {
      for (const scale of [1, 2, 3]) {
        const rest = boxMetrics(scale, STAND, true, 0);
        const extra = widened(text, scale);
        const width = boxMetrics(scale, STAND, true, extra).width;
        const right = bottomRightOf(area, rest.width, rest.height, margin).x;
        for (const restX of [right, area.x + margin]) {
          // `resize(..., centred)` moves the left edge out by the widening.
          const span = onScreenSpan(restX - extra, width, area.x, area.width);
          for (const dpr of [1, 2]) {
            expect(
              colsBetween(span.left, span.right, width, scale, dpr),
              `${text} @${scale}x dpr ${dpr} at x ${restX}`
            ).toBeGreaterThanOrEqual(bubbleColumnsNeeded(text, 2));
          }
        }
      }
    }
  });

  /*
   * 0.2.8 QA, row 7a.3: the pet that dismisses the first intro bubble moves the
   * window twice in one tick (308 px at x 1514 -> 88 at 1624 -> 202 at 1567 at
   * Small, with the shipped 72 x 72 stand box), and the `resize` paint for the
   * hooks notice read the *first* x. These are those numbers. Against the real
   * x the notice gets two lines and fits; against the stale one the window looks
   * fully on screen, the notice gets one line, and that line runs past the
   * screen edge — the cut on screen. The span is only as right as the x it is
   * given, which is why the renderer repaints when `window.screenX` catches up
   * (`watchBubblePlacement` in `renderer/overlay.ts`).
   */
  it('lays the hooks notice out against where the window is, not where it was', () => {
    const area: Rect = { x: 0, y: 0, width: 1728, height: 1117 };
    const shipped: BoxSize = { width: 72, height: 72 };
    const notice = 'Install Claude Code hooks';
    const extraFor = (text: string): number =>
      bubbleExtraPx(bubbleColumnsNeeded(text, 1), 1, shipped);
    const rest = boxMetrics(1, shipped, true, 0);
    const restX = bottomRightOf(area, rest.width, rest.height, 16).x;
    const width = boxMetrics(1, shipped, true, extraFor(notice)).width;
    const realX = restX - extraFor(notice);
    const staleX = restX - extraFor(HELLO);
    expect([rest.width, restX, width, realX, staleX]).toEqual([88, 1624, 202, 1567, 1514]);

    const real = onScreenSpan(realX, width, area.x, area.width);
    const realCols = colsBetween(real.left, real.right, width, 1, 2);
    expect(realCols).toBeLessThan(notice.length);
    expect(realCols).toBeGreaterThanOrEqual(bubbleColumnsNeeded(notice, 2));

    const stale = onScreenSpan(staleX, width, area.x, area.width);
    expect(stale).toEqual({ left: 0, right: width });
    const staleCols = colsBetween(stale.left, stale.right, width, 1, 2);
    expect(staleCols).toBeGreaterThanOrEqual(notice.length);
    expect(realX + width).toBeGreaterThan(area.x + area.width);
  });
});

/*
 * 0.2.8 QA, row 5.9a2: fresh settings, so the dog stands at the default spot
 * for *Small* (x 1624 on a 1728 pt screen), the intro bubble is up, and Size ▸
 * Large is chosen. `resize` anchored the resting left edge then, so the Large
 * window rested at the same 1624 and only 104 px of it was on screen. These are
 * the logged numbers (308 at 1514, 356 at 1534, 404 at 1554), mirrored through
 * `layoutBubble`'s arithmetic at the Retina dpr the row was run on.
 *
 * History as a position: since 2026-11-14 a size change keeps him wholly on
 * screen, and since 2026-11-16 nothing can leave a dog hanging off an edge.
 * The arithmetic is still what is tested — `bubbleExtraPx` takes whatever
 * resting x it is given — and a *window* still hangs off wherever his ink is
 * near an edge, by its padding and its widening, which is the case `site`
 * goes on answering.
 */
describe('the intro bubble after a size change at the default spot', () => {
  const area: Rect = { x: 0, y: 0, width: 1728, height: 1117 };
  const shipped: BoxSize = { width: 72, height: 72 };
  const HELLO = 'Hello. Click the bone in your menu bar.';
  const columns = bubbleColumnsNeeded(HELLO, 1);
  const twoLines = bubbleColumnsNeeded(HELLO, 2);
  const restX = bottomRightOf(area, boxMetrics(1, shipped, true, 0).width, 120, 16).x;
  const dpr = 2;
  /** `layoutBubble`'s columns for a window at `x`, `width` wide, laid out in its span. */
  const colsOnScreen = (x: number, width: number, scale: number): number => {
    const span = onScreenSpan(x, width, area.x, area.width);
    return colsBetween(span.left, span.right, width, scale, dpr);
  };
  /** The window `resize` lays out at `scale`, with and without the site. */
  const windowAt = (scale: number, onScreen: boolean): { x: number; width: number } => {
    const site = { restX, areaX: area.x, areaWidth: area.width };
    const extra = bubbleExtraPx(columns, scale, shipped, onScreen ? site : undefined);
    return { x: restX - extra, width: boxMetrics(scale, shipped, true, extra).width };
  };

  it('was cut because there was no room, not because the reading was stale', () => {
    expect(restX).toBe(1624);
    expect(twoLines).toBe(21);
    const [small, medium, large] = [1, 2, 3].map((scale) => windowAt(scale, false));
    expect([small, medium, large]).toEqual([
      { x: 1514, width: 308 },
      { x: 1534, width: 356 },
      { x: 1554, width: 404 }
    ]);
    const l = large as { x: number; width: number };
    const m = medium as { x: number; width: number };
    // Consistent: x and width both from the Large window. 174 px on screen is
    // 16 columns, which is exactly `Hello. Click the / bone in your…`.
    expect(colsOnScreen(l.x, l.width, 3)).toBe(16);
    expect(wrapBubbleText(HELLO, 16, 2)).toEqual(['Hello. Click the', `bone in your${ELLIPSIS}`]);
    // One step stale either way — the Medium x against the Large width, or
    // the Large x against the Medium width — is no better: still short of 21.
    expect(colsOnScreen(m.x, l.width, 3)).toBeLessThan(twoLines);
    expect(colsOnScreen(l.x, m.width, 3)).toBeLessThan(twoLines);
  });

  it('gets the room a fully visible window would have, at every size', () => {
    for (const scale of [1, 2, 3]) {
      const now = windowAt(scale, true);
      // The dog has not moved: the widening is still symmetric about him.
      expect(now.x + (now.width - boxMetrics(scale, shipped, true, 0).width) / 2).toBe(restX);
      const whole = windowAt(scale, false).width;
      expect(Math.min(now.x + now.width, area.width) - now.x, `@${scale}x`).toBeGreaterThanOrEqual(
        Math.min(whole, columns * bubbleColumnPx(scale) + BUBBLE_CHROME_PX)
      );
      expect(colsOnScreen(now.x, now.width, scale), `@${scale}x`).toBeGreaterThanOrEqual(twoLines);
    }
    // At Large that is the whole sentence on one line, as on a fresh Large launch.
    const large = windowAt(3, true);
    expect(colsOnScreen(large.x, large.width, 3)).toBeGreaterThanOrEqual(HELLO.length);
  });

  it('still fits two lines against a one-step-stale reading', () => {
    // The poll re-lays the bubble out within 250 ms of either half landing,
    // but the frame in between must not be a cut one either.
    const medium = windowAt(2, true);
    const large = windowAt(3, true);
    expect(colsOnScreen(medium.x, large.width, 3)).toBeGreaterThanOrEqual(twoLines);
    expect(colsOnScreen(large.x, medium.width, 3)).toBeGreaterThanOrEqual(twoLines);
  });

  it('changes nothing for a dog who is fully on screen, or a bubble that fits', () => {
    const site = { restX: 600, areaX: area.x, areaWidth: area.width };
    for (const scale of [1, 2, 3]) {
      expect(bubbleExtraPx(columns, scale, shipped, site)).toBe(
        bubbleExtraPx(columns, scale, shipped)
      );
      // `woof` never resizes, even with the Large window hanging off the edge.
      const edge = { restX, areaX: area.x, areaWidth: area.width };
      expect(bubbleExtraPx(bubbleColumnsNeeded('woof', 1), scale, shipped, edge)).toBe(0);
    }
  });

  it('measures the left edge too, on a display that does not start at 0', () => {
    const left: Rect = { x: 1728, y: 0, width: 1920, height: 1080 };
    // Large, the resting window 160 px off the left edge of the second
    // display — further than his ink may be since 2026-11-16 (the padding is
    // 24), which only makes this the harder case for the arithmetic.
    const site = { restX: left.x - 160, areaX: left.x, areaWidth: left.width };
    const extra = bubbleExtraPx(columns, 3, shipped, site);
    const width = boxMetrics(3, shipped, true, extra).width;
    const span = onScreenSpan(site.restX - extra, width, left.x, left.width);
    expect(span.right - span.left).toBeGreaterThanOrEqual(
      columns * bubbleColumnPx(3) + BUBBLE_CHROME_PX
    );
    expect(span.left).toBeGreaterThan(0);
  });
});

/**
 * A bubble at the top of a work area (2026-11-17: `Codex waiting` drawn on the
 * Mac's menu bar, 27.5 pt above the work area). The window is clamped on the
 * sprite box, so there the whole reserve is above the area; the bubble is laid
 * out from the area's top down instead, over the transparent rows above him
 * and at most his ears.
 */
describe('a bubble at the top of a work area', () => {
  it('bubbleTop is how far down the window its work area begins', () => {
    // The measured case: Small, window y -15, work area from 33.
    expect(bubbleTop(-15, 120, 33)).toBe(48);
    // On the area, at its top, or below it: nothing to keep clear of.
    expect(bubbleTop(33, 120, 33)).toBe(0);
    expect(bubbleTop(500, 120, 33)).toBe(0);
    // A top taskbar or a display above, same arithmetic (above a display it is
    // an accepted loss: the bubble was visible there; `bubbleTop` has it).
    expect(bubbleTop(-1100, 120, -1080)).toBe(20);
    // Wholly above its area is a stale reading: the old layout.
    expect(bubbleTop(-400, 120, 33)).toBe(0);
  });

  it('bubbleBoxSpace leaves every other bubble exactly as it was', () => {
    for (const space of [-3, 0, 41, 47, 51]) {
      expect(bubbleBoxSpace(0, space, 73, 8)).toBe(space);
    }
    // Half the reserve still on the area: what is left of it, or his ears.
    expect(bubbleBoxSpace(10, 41, 73, 8)).toBe(71);
    expect(bubbleBoxSpace(10, 41, 20, 8)).toBe(31);
  });

  it('bubbleBoxAt rests the box on the reserve, or starts it at the area top', () => {
    // Not at a top edge: where it always was, with its tail, decorations kept.
    expect(bubbleBoxAt(0, 82, 45, 146, 8)).toEqual({ y: 37, tail: true, lowered: false });
    // A little over the top and the box still fits what is left of the reserve.
    expect(bubbleBoxAt(20, 82, 45, 146, 8)).toEqual({ y: 37, tail: true, lowered: false });
    // The measured case (Small, dpr 2): the whole reserve is off the area, so the
    // box starts at the area's top, 96, and ends 45 below it, over the `?`.
    expect(bubbleBoxAt(96, 82, 45, 146, 8)).toEqual({ y: 96, tail: false, lowered: true });
    // Lowered but clear of him by more than the tail: the tail stays.
    expect(bubbleBoxAt(60, 82, 45, 146, 8)).toEqual({ y: 60, tail: true, lowered: true });
  });

  /**
   * `layoutBubble`'s vertical arithmetic for a dog standing at the very top (the
   * sprite box's top on the area's top), against the shipped art: the dachshund
   * (ink from row 25 of the box) and a cat (row 16), resting pose.
   */
  const sheet = validateSheet(shipped);
  const stand = { width: sheet.boxes.stand?.[0] ?? 0, height: sheet.boxes.stand?.[1] ?? 0 };
  /** Where a coat's resting ink starts: row 25 for the dachshund, 16 for a cat. */
  const restRow = (palette: string): number => {
    const frame = framesFor(sheet, palette)[animationFor(sheet, palette, 'idle')?.frames[0] ?? ''];
    if (frame === undefined) throw new Error(`no idle for ${palette}`);
    const { width, height } = frameSize(frame);
    return maskBounds(frameAlphaMask(frame), width, height)?.minY ?? -1;
  };
  /** The margin main is handed for a coat (`sheetBoxes`). */
  const margins = new Map<string, InkMargin>();
  const marginOf = (palette: string): InkMargin => {
    const known = margins.get(palette);
    if (known !== undefined) return known;
    const margin = coatInkMargin(sheet, palette, ['stand', 'sleep', 'lie', 'lie_down']);
    margins.set(palette, margin);
    return margin;
  };
  const OVER_QMARK = ['ink 16 2 1.25'];
  const coats = ['golden', 'yuna-grey-tabby'].map((palette) => ({ palette, inkRow: restRow(palette) }));

  const layoutAtTop = (scale: number, dpr: number, inkRow: number, wanted: number, ink: InkMargin) => {
    const win = boxMetrics(scale, stand, true);
    const sprite = spriteLayout({
      viewWidth: win.width,
      viewHeight: win.height,
      box: stand,
      scale,
      pixelScale: devicePixelScale(scale, dpr, spriteFit(scale, stand)),
      dpr
    });
    const unit = Math.max(1, Math.round(dpr));
    const outline = 2 * unit;
    const chrome = 2 * (outline + 2 * unit);
    const tailHeight = 3 * 2 * unit;
    const lineHeight = Math.round(Math.round(bubbleFontPx(scale) * dpr) * 1.2);
    // As high as the clamp lets him with the margin `ink` (RECHECK e).
    const clamped = { ...stand, ink };
    const inset = drawnInkInset({ metrics: win, scale, box: clamped, standBox: stand, dpr });
    const top = Math.round(bubbleTop(-inset.top, win.height, 0) * dpr);
    // `spriteRectWindow().y`, in device pixels.
    const inkTop = Math.round(Math.round(sprite.css.y + inkRow * sprite.cssScale) * dpr);
    const usual = sprite.bubbleFloor - unit - tailHeight + outline;
    const space = bubbleBoxSpace(top, usual, inkTop, BUBBLE_EAR_ROWS * sprite.pixelScale);
    const rows = Math.min(wanted, Math.floor((space - chrome) / lineHeight));
    const boxHeight = rows * lineHeight + chrome;
    const box = bubbleBoxAt(top, usual, boxHeight, inkTop, tailHeight - outline);
    // The `?` by his ear: its ink starts on row 7 of his box (anchor y 6).
    const overQmark = box.y + boxHeight > sprite.device.y + 7 * sprite.pixelScale;
    return { top, box, rows, overQmark, covered: (box.y + boxHeight - inkTop) / sprite.pixelScale };
  };

  it('is drawn below the top of the area, over no more than his ears', () => {
    expect(coats.map((c) => c.inkRow)).toEqual([25, 16]);
    const none: string[] = [];
    const over: string[] = [];
    for (const { palette, inkRow } of coats) {
      for (const scale of [1, 2, 3]) {
        for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3]) {
          for (const wanted of [1, 2]) {
            const at = layoutAtTop(scale, dpr, inkRow, wanted, marginOf(palette));
            const label = `ink ${inkRow} scale ${scale} dpr ${dpr} lines ${wanted}`;
            expect(at.top, label).toBeGreaterThan(0);
            if (at.rows < 1) {
              if (wanted === 1) none.push(`ink ${inkRow} scale ${scale} dpr ${dpr}`);
              continue;
            }
            expect(at.box.y, label).toBeGreaterThanOrEqual(at.top);
            // Sprite rows of his resting ink under the box: never past his ears.
            expect(at.covered, label).toBeLessThanOrEqual(BUBBLE_EAR_ROWS);
            // A box on his ink has no tail.
            if (at.covered > 0) expect(at.box.tail, label).toBe(false);
            // Over the `?` by his ear without having come down for it.
            if (at.overQmark && !at.box.lowered) over.push(`ink ${inkRow} ${scale} ${dpr}`);
          }
        }
      }
    }
    // Where he is drawn smaller than Small (1 device pixel a sprite pixel on a
    // 125 % or 150 % display) one line would lie across his eyes — 12 rows of
    // the dachshund, 10 and 21 of a cat — so there is no bubble at a top edge.
    // The same list as before RECHECK e: the dachshund's four rows of clamp
    // cost him no line, and Yuna has no top margin (`coatInkMargin`).
    expect(none).toEqual([
      'ink 25 scale 1 dpr 1.5',
      'ink 16 scale 1 dpr 1.25',
      'ink 16 scale 1 dpr 1.5'
    ]);
    // A box over the `?` by his ear says so (`lowered`), which is what leaves
    // the `?` out — the case that was seen first, dachshund, Small, Retina.
    const seen = layoutAtTop(1, 2, 25, 1, marginOf('golden'));
    expect([seen.overQmark, seen.box.lowered, seen.box.tail]).toEqual([true, true, false]);
    // The one exception is not the top edge's: at Medium on a 125 % display he
    // is drawn larger than nominal, his box starts above the reserve's floor,
    // and a one-line bubble in its usual place is over the top three rows of
    // the `?` anywhere on the screen.
    expect([...new Set(over)]).toEqual(OVER_QMARK);
  });

  it('keeps two lines at Medium and Large and gives up the second at Small', () => {
    for (const { palette, inkRow } of coats) {
      for (const dpr of [1, 2, 3]) {
        const ink = marginOf(palette);
        expect(layoutAtTop(1, dpr, inkRow, 2, ink).rows, `Small dpr ${dpr}`).toBe(1);
        expect(layoutAtTop(2, dpr, inkRow, 2, ink).rows, `Medium dpr ${dpr}`).toBe(2);
        expect(layoutAtTop(3, dpr, inkRow, 2, ink).rows, `Large dpr ${dpr}`).toBe(2);
      }
    }
  });

  /**
   * Owner, 2026-11-19: "can you not just fix it for Yuna?" Every coat, every
   * size and ratio, one line asked and two: the lines a coat gets at a top
   * edge with the margin main is handed are the lines it got with the frame
   * clamp (margin 0, as on main before RECHECK e). The dachshund keeps his
   * four rows; Yuna has none, which is what gives her lines back.
   */
  it('gives every coat at a top edge the lines it had before the ink clamp', () => {
    const frameClamp: InkMargin = { top: 0, side: 0 };
    const fewer: string[] = [];
    let yunaCoats = 0;
    for (const palette of Object.keys(sheet.palettes)) {
      const yuna = characterOf(sheet, palette) === 'yuna';
      if (yuna) yunaCoats += 1;
      expect(marginOf(palette).top, palette).toBe(yuna ? 0 : 4);
      const inkRow = restRow(palette);
      for (const scale of [1, 2, 3]) {
        for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3]) {
          for (const wanted of [1, 2]) {
            const now = layoutAtTop(scale, dpr, inkRow, wanted, marginOf(palette)).rows;
            const before = layoutAtTop(scale, dpr, inkRow, wanted, frameClamp).rows;
            expect(now, `${palette} scale ${scale} dpr ${dpr} lines ${wanted}`).toBeLessThanOrEqual(before);
            if (now < before) fewer.push(`${palette} scale ${scale} dpr ${dpr} lines ${wanted}: ${now}`);
          }
        }
      }
    }
    expect(yunaCoats).toBe(5);
    // Literal, for Yuna, as on main a6b295e (the functions this reads differ
    // from main's by the margin alone): lines for a two-line text at a top
    // edge, Small / Medium / Large by dpr 1, 1.25, 1.5, 2, 2.5. None at Small
    // on 125 % and 150 %, where she is drawn smaller than Small (the black
    // coat, resting two rows lower, keeps one at 125 %).
    const yunaLines: Record<string, number[][]> = {};
    for (const palette of Object.keys(sheet.palettes)) {
      if (characterOf(sheet, palette) !== 'yuna') continue;
      expect(marginOf(palette), palette).toEqual({ top: 0, side: 0 });
      yunaLines[`${palette} ink ${restRow(palette)}`] = [1, 2, 3].map((scale) =>
        [1, 1.25, 1.5, 2, 2.5].map((dpr) => layoutAtTop(scale, dpr, restRow(palette), 2, marginOf(palette)).rows)
      );
    }
    const twos = [2, 2, 2, 2, 2];
    const cat = [[1, 0, 0, 1, 1], twos, twos];
    expect(yunaLines).toEqual({
      'yuna-black ink 18': [[1, 1, 0, 1, 1], twos, twos],
      'yuna-calico ink 16': cat,
      'yuna-grey-tabby ink 16': cat,
      'yuna-orange-tabby ink 16': cat,
      'yuna-tuxedo ink 16': cat
    });
    // What is left of the trade, the dachshund's only: at Small on a 175 % or
    // 250 % display he is drawn larger than Small, and a text that needs two
    // lines fitted them at a top edge under the frame clamp; four rows higher
    // it gets one and an ellipsis. Every other size and ratio, and every line
    // of every Yuna coat, is as it was.
    const dogs = Object.keys(sheet.palettes).filter((p) => characterOf(sheet, p) === 'walder');
    expect(fewer).toEqual(
      dogs.flatMap((p) => [`${p} scale 1 dpr 1.75 lines 2: 1`, `${p} scale 1 dpr 2.5 lines 2: 1`])
    );
  });
});

describe('onScreenSpan', () => {
  it('is the whole window when it is fully on screen', () => {
    expect(onScreenSpan(100, 300, 0, 1728)).toEqual({ left: 0, right: 300 });
  });
  it('trims the part hanging off the right edge', () => {
    expect(onScreenSpan(1500, 300, 0, 1728)).toEqual({ left: 0, right: 228 });
  });
  it('trims the part hanging off the left edge, on a display that does not start at 0', () => {
    expect(onScreenSpan(1400, 300, 1440, 1920)).toEqual({ left: 40, right: 300 });
  });
  it('falls back to the whole window when there is no overlap', () => {
    expect(onScreenSpan(2000, 300, 0, 1728)).toEqual({ left: 0, right: 300 });
  });
});

/**
 * Mac QA 2026-11-20: at Small the first frame of a bark showed the window wide
 * and the text on two lines for 85-100 ms (one bark frame). The renderer laid
 * the bubble out against `screenX`/`outerWidth`, which Chromium updates after
 * the resize, so that paint saw the old narrow window. Main now says where it
 * put the window; each field is main's until Chromium's own reading of it
 * moves from what it was when main's word arrived.
 */
describe('placementSince', () => {
  // Small, bottom-right: 88 wide at 1640, widened for a bark to 166 at 1601.
  const narrow: Rect = { x: 1640, y: 700, width: 88, height: 160 };
  const wide: Rect = { x: 1601, y: 700, width: 166, height: 160 };

  it('is the live reading when main has said nothing', () => {
    expect(placementSince(narrow, null)).toEqual(narrow);
  });
  it("is main's rect while Chromium still reads the old window", () => {
    expect(placementSince(narrow, { told: wide, seen: narrow })).toEqual(wide);
  });
  it("lays the bark out on one line on its first frame, not on main's word alone", () => {
    // What `layoutBubble` gets: the old reading spans 88 of the 166, the new 127
    // (the rest hangs off a 1728-wide screen) -- the difference between two lines and one.
    const stale = placementSince(narrow, null);
    const told = placementSince(narrow, { told: wide, seen: narrow });
    expect(onScreenSpan(stale.x, stale.width, 0, 1728)).toEqual({ left: 0, right: 88 });
    expect(onScreenSpan(told.x, told.width, 0, 1728)).toEqual({ left: 0, right: 127 });
  });
  it('is the live reading once it has caught up', () => {
    expect(placementSince(wide, { told: wide, seen: narrow })).toEqual(wide);
  });
  it('takes each field from Chromium as soon as that field moves, so half a landing is not undone', () => {
    const halfway = { ...narrow, width: 166 };
    expect(placementSince(halfway, { told: wide, seen: narrow })).toEqual(wide);
  });
  it('follows a later move main did not report (a drag, the OS), field by field', () => {
    const dragged = { ...wide, x: 1200, y: 500 };
    expect(placementSince(dragged, { told: wide, seen: narrow })).toEqual(dragged);
  });
  it('keeps the granted size main read back, not a rounded live one, until the live one moves (Windows 125 %)', () => {
    const granted = { ...wide, width: 167 };
    expect(placementSince(narrow, { told: granted, seen: narrow }).width).toBe(167);
  });
});

/**
 * RECHECK 2026-11-18, e: the clamp measured the 72 x 72 frame, so he rested
 * under the menu bar by the transparent rows above his head. The clamp now
 * adds the margin no frame of the box inks (`boxInkMargin`) — the true union,
 * so no frame's ink, nor a decoration's, can cross an edge at any size.
 */
describe('the clamp measures his ink, not the frame (RECHECK e)', () => {
  const sheet = validateSheet(shipped);
  const sets = [sheet.frames, ...Object.values(sheet.frameSets)];
  const boxOf = (name: string): BoxSize => ({
    width: sheet.boxes[name]?.[0] ?? 0,
    height: sheet.boxes[name]?.[1] ?? 0,
    ink: boxInkMargin(sheet, name)
  });

  it('is pinned for the shipped art: four rows above the stand box, five above sleep, none at the sides', () => {
    // Stand: a cat's ears in a jump and the pet heart (anchor y 3) reach row
    // 4; the dachshund at rest starts at row 25, so most of that gap stays.
    expect(boxInkMargin(sheet, 'stand')).toEqual({ top: 4, side: 0 });
    // Sleep: the `z z` (anchor y 4) is the highest thing drawn over him.
    expect(boxInkMargin(sheet, 'sleep')).toEqual({ top: 5, side: 0 });
    expect(boxInkMargin(sheet, 'no-such-box')).toEqual({ top: 0, side: 0 });
  });

  it('is never more than any frame of the box leaves, either way round', () => {
    for (const name of ['stand', 'sleep', 'lie', 'lie_down']) {
      const { width, ink } = boxOf(name);
      for (const set of sets) {
        for (const [frameName, frame] of Object.entries(set)) {
          if (frame.box !== name) continue;
          const { width: w, height: h } = frameSize(frame);
          const b = maskBounds(frameAlphaMask(frame), w, h);
          if (b === null) continue;
          expect(b.minY, `${name} ${frameName}`).toBeGreaterThanOrEqual(ink?.top ?? 0);
          expect(b.minX, `${name} ${frameName}`).toBeGreaterThanOrEqual(ink?.side ?? 0);
          expect(width - 1 - b.maxX, `${name} ${frameName}`).toBeGreaterThanOrEqual(ink?.side ?? 0);
        }
      }
    }
  });

  it('adds the margin, scaled with the layout, to the inset the clamp uses', () => {
    const stand = boxOf('stand');
    for (const scale of [1, 2, 3]) {
      const metrics = boxMetrics(scale, stand, true);
      const nominal = inkInset(metrics);
      expect(
        drawnInkInset({ metrics, scale, box: stand, standBox: stand, dpr: 1 }),
        `scale ${scale}`
      ).toEqual({ ...nominal, top: nominal.top + 4 * scale });
    }
  });

  it('is one margin for every box of the dog, the smallest, so a box change at a top edge does not hop him', () => {
    expect(boxInkMargin(sheet, 'lie')).toEqual({ top: 28, side: 0 });
    expect(boxInkMargin(sheet, 'lie_down')).toEqual({ top: 13, side: 0 });
    expect(sharedInkMargin(sheet, ['stand', 'sleep', 'lie', 'lie_down'])).toEqual({ top: 4, side: 0 });
    expect(sharedInkMargin(sheet, ['nothing'])).toEqual({ top: 0, side: 0 });
  });

  /**
   * Not from the margin: every real frame of each box, and every decoration
   * the app draws on it (`decorationPlacements`), both ways round, laid out as
   * the renderer lays it out and clamped flush with an edge at 0 by the inset
   * main uses — no ink pixel lands before that edge, at any size or ratio.
   */
  it.each(['golden', 'yuna-grey-tabby'])('keeps every frame and decoration of every box on screen at every size and ratio (%s)', (coat) => {
    // Each character's margin as main is handed it (`sheetBoxes`).
    const ink = coatInkMargin(sheet, coat, ['stand', 'sleep', 'lie', 'lie_down']);
    const stand = { ...boxOf('stand'), ink };
    const tables = [sheet.animations, ...Object.values(sheet.frameSetAnimations)];
    const frameNamed = (name: string) => sets.find((set) => Object.hasOwn(set, name))?.[name];
    /** Every ink rect drawn in `name`'s box, in sprite px, as [x, y, frame]. */
    const drawn = (name: string, width: number) => {
      const out: { x: number; y: number; frame: Frame; label: string }[] = [];
      for (const set of sets) {
        for (const [frameName, frame] of Object.entries(set)) {
          if (frame.box === name) out.push({ x: 0, y: 0, frame, label: frameName });
        }
      }
      for (const [animation, decors] of Object.entries(sheet.decorAnchors)) {
        for (const host of tables.flatMap((table) => table[animation]?.frames ?? [])) {
          if (frameNamed(host)?.box !== name) continue;
          for (const decor of Object.keys(decors)) {
            for (const { anchor, frameName } of decorationPlacements(sheet, decor as DecorName, animation, host)) {
              const frame = frameNamed(frameName);
              if (frame === undefined) continue;
              const w = frameSize(frame).width;
              for (const x of [anchor.x, mirrorAnchorX(anchor.x, width, w)]) {
                out.push({ x, y: anchor.y, frame, label: `${animation} ${host} ${decor}` });
              }
            }
          }
        }
      }
      return out;
    };
    for (const name of ['stand', 'sleep', 'lie', 'lie_down']) {
      const box = { ...boxOf(name), ink };
      const pieces = drawn(name, box.width);
      expect(pieces.length, name).toBeGreaterThan(0);
      for (const scale of [1, 2, 3]) {
        for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3]) {
          const metrics = boxMetrics(scale, box, name === 'stand');
          const inset = drawnInkInset({ metrics, scale, box, standBox: stand, dpr });
          const layout = spriteLayout({
            viewWidth: metrics.width,
            viewHeight: metrics.height,
            box,
            scale,
            pixelScale: devicePixelScale(scale, dpr, spriteFit(scale, stand)),
            dpr
          });
          const cs = layout.cssScale;
          for (const { x, y, frame, label } of pieces) {
            const size = frameSize(frame);
            const b = maskBounds(frameAlphaMask(frame), size.width, size.height);
            if (b === null) continue;
            const at = `${name} ${label} scale ${scale} dpr ${dpr}`;
            // Rows above the window's own top are clipped by it, never shown.
            const topRow = Math.max(0, layout.css.y + (y + b.minY) * cs);
            expect(topRow, at).toBeGreaterThanOrEqual((inset.top ?? 0) - 1e-9);
            // The dog is mirrored whole; a decoration's x already covers both.
            const lefts = x === 0 ? [b.minX, box.width - 1 - b.maxX] : [x + b.minX];
            const rights = x === 0 ? [b.maxX, box.width - 1 - b.minX] : [x + b.maxX];
            for (const col of lefts) {
              expect(layout.css.x + col * cs, at).toBeGreaterThanOrEqual((inset.left ?? 0) - 1e-9);
            }
            for (const col of rights) {
              expect(metrics.width - (layout.css.x + (col + 1) * cs), at).toBeGreaterThanOrEqual(
                (inset.right ?? 0) - 1e-9
              );
            }
          }
        }
      }
    }
  });
});

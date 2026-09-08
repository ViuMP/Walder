/**
 * Window geometry: the maths that keeps the mascot on a screen the user can see,
 * and that sizes the window around the sprite. Pure, so it is tested without
 * launching Electron — a dragged-off-screen dog is otherwise unrecoverable
 * except by editing the settings file by hand.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_VISIBLE_PX,
  bottomRightOf,
  clampRectToWorkAreas,
  inkInset,
  overlayMetrics,
  spriteOrigin,
  type Rect
} from '../src/core/geometry';

const LAPTOP: Rect = { x: 0, y: 25, width: 1440, height: 875 };
const EXTERNAL: Rect = { x: 1440, y: 0, width: 1920, height: 1080 };
const WIN: Rect = { x: 0, y: 0, width: 192, height: 192 };

describe('clampRectToWorkAreas', () => {
  it('leaves a fully visible window alone', () => {
    const rect = { ...WIN, x: 400, y: 300 };
    expect(clampRectToWorkAreas(rect, [LAPTOP])).toEqual({ x: 400, y: 300 });
  });

  it('leaves a window straddling two displays alone', () => {
    // Snapping this onto one display would fight the user on every drag across
    // the seam, so a straddling position counts as visible.
    const rect = { ...WIN, x: 1380, y: 400 };
    expect(clampRectToWorkAreas(rect, [LAPTOP, EXTERNAL])).toEqual({ x: 1380, y: 400 });
  });

  it('keeps a window peeking over the edge if enough of it shows', () => {
    const rect = { ...WIN, x: -WIN.width + MIN_VISIBLE_PX, y: 300 };
    expect(clampRectToWorkAreas(rect, [LAPTOP])).toEqual({ x: rect.x, y: 300 });
  });

  it('pulls a window fully off-screen back onto the nearest display', () => {
    const rect = { ...WIN, x: -5000, y: -5000 };
    const result = clampRectToWorkAreas(rect, [LAPTOP, EXTERNAL]);
    expect(result).toEqual({ x: LAPTOP.x, y: LAPTOP.y });
  });

  it('chooses the nearest display when recovering, not simply the first', () => {
    const rect = { ...WIN, x: 4000, y: 500 };
    const result = clampRectToWorkAreas(rect, [LAPTOP, EXTERNAL]);
    expect(result).toEqual({
      x: EXTERNAL.x + EXTERNAL.width - WIN.width,
      y: 500
    });
  });

  it('recovers a window from just past the far edge', () => {
    const rect = { ...WIN, x: LAPTOP.width + 500, y: 300 };
    const result = clampRectToWorkAreas(rect, [LAPTOP]);
    expect(result).toEqual({ x: LAPTOP.width - WIN.width, y: 300 });
  });

  it('respects a work area that does not start at the origin', () => {
    const rect = { ...WIN, x: -9999, y: -9999 };
    expect(clampRectToWorkAreas(rect, [LAPTOP])).toEqual({ x: 0, y: 25 });
  });

  it('pins a window larger than the work area to the work-area origin', () => {
    const huge = { x: -9999, y: -9999, width: 4000, height: 4000 };
    expect(clampRectToWorkAreas(huge, [LAPTOP])).toEqual({ x: LAPTOP.x, y: LAPTOP.y });
  });

  it('returns the rect untouched when there are no displays at all', () => {
    // A transient state while displays are being reconfigured; guessing is worse.
    const rect = { ...WIN, x: 123, y: 456 };
    expect(clampRectToWorkAreas(rect, [])).toEqual({ x: 123, y: 456 });
    // Same with an inset: no area to measure against, so nothing to decide.
    expect(clampRectToWorkAreas(rect, [], inkInset(overlayMetrics(3)))).toEqual({
      x: 123,
      y: 456
    });
  });
});

describe('clampRectToWorkAreas with an ink inset', () => {
  // The overlay window at scale 3: 192x192, with 24 px of padding either side
  // of the dog and 72 px of bubble reserve above it. The ink rect is therefore
  // 144x120 at (+24, +72) inside the window.
  const metrics = overlayMetrics(3);
  const inset = inkInset(metrics);
  const OVERLAY: Rect = { x: 0, y: 0, width: metrics.width, height: metrics.height };

  it('describes the sprite rect, not the window rect', () => {
    expect(inset).toEqual({ left: 24, right: 24, top: 72, bottom: 0 });
  });

  it('recovers a window whose visible sliver is only transparent padding', () => {
    // 30 px of window on screen at the left edge — enough for the old
    // window-rect test — but the first 24 of those are padding, so only 6 px of
    // dog shows. That is the bug: the guard passed while the dog was invisible.
    const rect = { ...OVERLAY, x: -(metrics.width - 30), y: 300 };
    expect(clampRectToWorkAreas(rect, [LAPTOP])).toEqual({ x: rect.x, y: 300 });

    const withInk = clampRectToWorkAreas(rect, [LAPTOP], inset);
    expect(withInk).not.toEqual({ x: rect.x, y: 300 });
    // Recovered by translating the *window* so the ink lands at the work-area
    // origin: ink.x = 0 means window.x = -24. Vertically it was already fine, so
    // y does not move.
    expect(withInk).toEqual({ x: -inset.left, y: 300 });
  });

  it('leaves a window alone when enough of the dog itself is on screen', () => {
    // 24 px of ink showing at the left edge is exactly MIN_VISIBLE_PX.
    const rect = { ...OVERLAY, x: -(inset.left + 144 - MIN_VISIBLE_PX), y: 300 };
    expect(clampRectToWorkAreas(rect, [LAPTOP], inset)).toEqual({ x: rect.x, y: 300 });
  });

  it('does not count the bubble reserve as vertical visibility', () => {
    // Pushed down past the bottom edge until only the window's top 80 px are on
    // the work area. 72 of those are bubble reserve, so just 8 px of dog shows —
    // the window-rect test is satisfied and the dog is all but gone.
    const rect = { ...OVERLAY, x: 400, y: LAPTOP.y + LAPTOP.height - 80 };
    expect(clampRectToWorkAreas(rect, [LAPTOP])).toEqual({ x: 400, y: rect.y });

    const withInk = clampRectToWorkAreas(rect, [LAPTOP], inset);
    expect(withInk.x).toBe(400);
    // Pulled back up until the whole 120 px-tall ink rect fits.
    expect(withInk.y).toBeLessThan(rect.y);
    expect(withInk.y + inset.top + 120).toBeLessThanOrEqual(LAPTOP.y + LAPTOP.height);
  });

  it('picks the nearest display by where the dog is, not where the window is', () => {
    const rect = { ...OVERLAY, x: 4000, y: 500 };
    const result = clampRectToWorkAreas(rect, [LAPTOP, EXTERNAL], inset);
    // Ink pinned to the external display's right edge, window offset back out.
    expect(result.x).toBe(EXTERNAL.x + EXTERNAL.width - 144 - inset.left);
    expect(result.y).toBe(500);
  });

  it('is identical to the un-inset call for a rect with no padding to trim', () => {
    const rect = { ...WIN, x: -5000, y: -5000 };
    const none = clampRectToWorkAreas(rect, [LAPTOP, EXTERNAL]);
    expect(clampRectToWorkAreas(rect, [LAPTOP, EXTERNAL], {})).toEqual(none);
  });

  it('survives an inset larger than the rect without inverting', () => {
    // A degenerate inset must not produce a zero-size ink rect whose overlap is
    // always 0 — that would pin the window to a work-area corner forever.
    const rect = { ...OVERLAY, x: 400, y: 300 };
    const silly = { left: 500, right: 500, top: 500, bottom: 500 };
    expect(clampRectToWorkAreas(rect, [LAPTOP], silly)).toEqual({ x: 400, y: 300 });
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
  it('sizes the window from the stand box plus padding and bubble reserve', () => {
    // width = 48*s + 2*(8*s), height = 40*s + 24*s
    expect(overlayMetrics(2)).toEqual({ width: 128, height: 128, pad: 16, bubbleReserve: 48 });
    expect(overlayMetrics(3)).toEqual({ width: 192, height: 192, pad: 24, bubbleReserve: 72 });
    expect(overlayMetrics(4)).toEqual({ width: 256, height: 256, pad: 32, bubbleReserve: 96 });
  });

  it('grows strictly with scale', () => {
    expect(overlayMetrics(2).width).toBeLessThan(overlayMetrics(3).width);
    expect(overlayMetrics(3).height).toBeLessThan(overlayMetrics(4).height);
  });
});

describe('spriteOrigin', () => {
  it('centres the stand box horizontally and sits it on the bottom edge', () => {
    const { width, height } = overlayMetrics(3);
    const origin = spriteOrigin(width, height, 48, 40, 3);
    expect(origin).toEqual({ x: 24, y: height - 40 * 3 });
    // Padding is symmetric, so the left inset equals the metrics pad.
    expect(origin.x).toBe(overlayMetrics(3).pad);
  });

  it('centres the smaller sleep box in the same window', () => {
    const { width, height } = overlayMetrics(3);
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

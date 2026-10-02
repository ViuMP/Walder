/**
 * Window geometry: the maths that keeps the mascot on a screen the user can see,
 * and that sizes the window around the sprite. Pure, so it is tested without
 * launching Electron — a dragged-off-screen dog is otherwise unrecoverable
 * except by editing the settings file by hand.
 */
import { describe, expect, it } from 'vitest';
import {
  BUBBLE_CHROME_PX,
  bubbleColumnPx,
  bubbleFontPx,
  bubbleReservePx,
  BUBBLE_EXTRA_MAX_PX,
  MIN_VISIBLE_PX,
  bottomRightOf,
  bubbleExtraPx,
  clampRectToWorkAreas,
  inkInset,
  boxMetrics,
  onScreenSpan,
  overlayMetrics,
  restingRect,
  spriteOrigin,
  type BoxSize,
  type Rect
} from '../src/core/geometry';
import { ELLIPSIS, bubbleColumnsNeeded, wrapBubbleText } from '../src/core/bubble';

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
    expect(clampRectToWorkAreas(rect, [], inkInset(overlayMetrics(3, STAND)))).toEqual({
      x: 123,
      y: 456
    });
  });
});

describe('clampRectToWorkAreas with an ink inset', () => {
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
    // Pushed down past the bottom edge until only the window's top 66 px are on
    // the work area. 58 of those are bubble reserve, so just 8 px of dog shows —
    // the window-rect test is satisfied and the dog is all but gone.
    const rect = { ...OVERLAY, x: 400, y: LAPTOP.y + LAPTOP.height - 66 };
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
    // keeps him reachable must not measure it as part of him.
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
     * line (`rows` in `drawBubble`). This is the arithmetic that stops that,
     * mirrored from `drawBubble` at dpr 1: two lines, plus the box's outline and
     * padding top and bottom, plus the tail, plus a pixel of air.
     */
    /*
     * Re-derived from `drawBubble` at every device ratio the app meets, not just
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
 * Columns `drawBubble` gets between window-relative CSS offsets `left` and
 * `right` of a window `width` wide: `unit = max(1, round(dpr))`, a two-unit
 * outline and three-unit horizontal padding each side, one unit of breathing
 * room at each edge, and the font rounded to whole device pixels before the
 * advance is applied.
 */
const colsBetween = (
  left: number,
  right: number,
  width: number,
  scale: number,
  dpr: number
): number => {
  const unit = Math.max(1, Math.round(dpr));
  const outline = 2 * unit;
  const padX = 3 * unit;
  const viewWidth = Math.round(width * dpr);
  const maxBoxWidth =
    Math.min(viewWidth, Math.round(right * dpr)) - unit - (Math.round(left * dpr) + unit);
  const charWidth = Math.round(bubbleFontPx(scale) * dpr) * SF_MONO_ADVANCE;
  return Math.floor((maxBoxWidth - 2 * (outline + padX)) / charWidth);
};

/**
 * Every sentence Walder can put in a bubble, and the one thing that must be true
 * of all of them: **none is ever ellipsised**.
 *
 * The owner received `7-day (all models): 80%…` on 2026-09-15 — the bark without
 * the word that says what the number means. The window had been widened for a
 * two-line fit, which holds only if `drawBubble` derives `rows = 2` from the
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
 *    columns, re-derived from `drawBubble`'s own arithmetic at every device
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
   * The widening for a one-line fit of `text`, and `drawBubble`'s column count
   * across the whole widened window (`colsBetween`, mirrored arithmetic).
   */
  const widened = (text: string, scale: number): number =>
    bubbleExtraPx(bubbleColumnsNeeded(text, 1), scale, STAND);
  const rendererCols = (text: string, scale: number, dpr: number): number => {
    const width = boxMetrics(scale, STAND, true, widened(text, scale)).width;
    return colsBetween(0, width, width, scale, dpr);
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
   * The window is clamped on the dog's ink, not on the widening, so at the
   * default spot (`defaultPosition`: bottom-right, 16 px in) the widened window
   * hangs off the work area and `drawBubble` lays out inside `onScreenSpan`
   * instead. What is left on screen must still hold the text in two lines —
   * the reserve's promise — on either edge.
   */
  it('fits every bark in two lines inside the on-screen part of the window', () => {
    const area: Rect = { x: 0, y: 0, width: 1728, height: 1117 };
    const margin = 16;
    for (const text of [...BARKS, HELLO]) {
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
 * Large is chosen. `resize` anchors the resting left edge, so the Large window
 * rests at the same 1624 and only 104 px of it is on screen. These are the
 * logged numbers (308 at 1514, 356 at 1534, 404 at 1554), mirrored through
 * `drawBubble`'s arithmetic at the Retina dpr the row was run on.
 */
describe('the intro bubble after a size change at the default spot', () => {
  const area: Rect = { x: 0, y: 0, width: 1728, height: 1117 };
  const shipped: BoxSize = { width: 72, height: 72 };
  const HELLO = 'Hello. Click the bone in your menu bar.';
  const columns = bubbleColumnsNeeded(HELLO, 1);
  const twoLines = bubbleColumnsNeeded(HELLO, 2);
  const restX = bottomRightOf(area, boxMetrics(1, shipped, true, 0).width, 120, 16).x;
  const dpr = 2;
  /** `drawBubble`'s columns for a window at `x`, `width` wide, laid out in its span. */
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
      // `woof` never resizes, even with the dog hanging off the edge at Large.
      const edge = { restX, areaX: area.x, areaWidth: area.width };
      expect(bubbleExtraPx(bubbleColumnsNeeded('woof', 1), scale, shipped, edge)).toBe(0);
    }
  });

  it('measures the left edge too, on a display that does not start at 0', () => {
    const left: Rect = { x: 1728, y: 0, width: 1920, height: 1080 };
    // Large, hanging 160 px off the left edge of the second display.
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

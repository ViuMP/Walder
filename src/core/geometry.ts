/**
 * Screen geometry for the overlay window: keeping it on a display the user can
 * actually see. Pure maths, no Electron — the main process supplies the work
 * areas it read from `screen`, so this stays unit-testable.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * How much of the window must overlap a work area, on both axes, for the
 * position to count as "visible". Small enough that deliberately parking the dog
 * half off the edge still works, large enough that there is always something to
 * grab.
 */
export const MIN_VISIBLE_PX = 24;

/**
 * Per-edge shrink applied to a window rect before the visibility test.
 *
 * The overlay window is mostly transparent — padding either side of the sprite
 * and a tall reserve above it for the speech bubble — so "24 px of the window is
 * on screen" can be satisfied entirely by empty pixels, leaving nothing visible
 * or grabbable. Callers pass the inset that turns the window rect into the
 * sprite's *ink* rect, and the clamp reasons about that instead. Omitted edges
 * are 0, so `{}` and `undefined` both mean "the whole window".
 */
export interface RectInset {
  readonly left?: number;
  readonly right?: number;
  readonly top?: number;
  readonly bottom?: number;
}

/**
 * Shrink `rect` by `inset`. Never smaller than 1x1: a degenerate rect would make
 * every overlap test zero and pin the window to a work-area origin forever.
 */
function applyInset(rect: Rect, inset: RectInset): Rect {
  const left = inset.left ?? 0;
  const right = inset.right ?? 0;
  const top = inset.top ?? 0;
  const bottom = inset.bottom ?? 0;
  return {
    x: rect.x + left,
    y: rect.y + top,
    width: Math.max(1, rect.width - left - right),
    height: Math.max(1, rect.height - top - bottom)
  };
}

function overlap(aStart: number, aSize: number, bStart: number, bSize: number): number {
  return Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart);
}

/** Is `rect` visible enough on `area` to be reachable? */
function visibleOn(rect: Rect, area: Rect): boolean {
  const needX = Math.min(MIN_VISIBLE_PX, rect.width);
  const needY = Math.min(MIN_VISIBLE_PX, rect.height);
  return (
    overlap(rect.x, rect.width, area.x, area.width) >= needX &&
    overlap(rect.y, rect.height, area.y, area.height) >= needY
  );
}

/** Squared distance between two rect centres. Used only to rank candidates. */
function centreDistanceSq(a: Rect, b: Rect): number {
  const dx = a.x + a.width / 2 - (b.x + b.width / 2);
  const dy = a.y + a.height / 2 - (b.y + b.height / 2);
  return dx * dx + dy * dy;
}

/** Move `rect` the shortest distance needed to sit fully inside `area`. */
function clampInto(rect: Rect, area: Rect): { x: number; y: number } {
  // A window larger than the work area cannot fit; pin it to the origin rather
  // than letting the max/min pair invert and push it off the far edge.
  const maxX = Math.max(area.x, area.x + area.width - rect.width);
  const maxY = Math.max(area.y, area.y + area.height - rect.height);
  return {
    x: Math.min(Math.max(rect.x, area.x), maxX),
    y: Math.min(Math.max(rect.y, area.y), maxY)
  };
}

/**
 * Clamp a window rect so it can never be lost off-screen.
 *
 * A position that is already reachable on *some* display is returned unchanged —
 * that matters on multi-monitor setups, where snapping a window fully onto one
 * display would fight the user every time they drag across the seam. Only a rect
 * that is effectively invisible gets pulled fully onto the nearest work area.
 *
 * `inset` shrinks the rect to the part that actually has to stay reachable (see
 * `RectInset`): the test, the nearest-display choice and the recovery are all
 * done on that inner rect, and the returned position is the *window* position
 * that puts it there. Omit it and the whole window counts, as before.
 *
 * With no work areas at all (a transient state while displays are being
 * reconfigured) the rect is returned untouched: guessing would be worse.
 */
export function clampRectToWorkAreas(
  rect: Rect,
  workAreas: readonly Rect[],
  inset?: RectInset
): { x: number; y: number } {
  if (workAreas.length === 0) return { x: rect.x, y: rect.y };

  const ink = inset === undefined ? rect : applyInset(rect, inset);
  if (workAreas.some((area) => visibleOn(ink, area))) return { x: rect.x, y: rect.y };

  let nearest = workAreas[0] as Rect;
  let best = centreDistanceSq(ink, nearest);
  for (let i = 1; i < workAreas.length; i++) {
    const area = workAreas[i] as Rect;
    const d = centreDistanceSq(ink, area);
    if (d < best) {
      best = d;
      nearest = area;
    }
  }

  // Recovery moves the ink rect; the window follows by the same translation, so
  // the sprite — not the transparent padding — is what lands on the display.
  const placed = clampInto(ink, nearest);
  return { x: rect.x + (placed.x - ink.x), y: rect.y + (placed.y - ink.y) };
}

/* ------------------------------------------------------------ overlay layout */

/**
 * Logical size of a sprite box, in sprite pixels.
 *
 * There is deliberately no constant for the standing box here. The winning
 * mascot design decides its own dimensions, so every consumer reads them from
 * the loaded sheet (`sheet.boxes.stand`) and passes them in — a hard-coded 48×40
 * would silently mis-frame the window the moment the art changed.
 */
export interface BoxSize {
  readonly width: number;
  readonly height: number;
}

export interface OverlayMetrics {
  /** Window size in logical pixels. */
  readonly width: number;
  readonly height: number;
  /** Horizontal breathing room either side of the sprite. */
  readonly pad: number;
  /** Vertical space above the sprite, reserved for the speech bubble. */
  readonly bubbleReserve: number;
  /**
   * Extra width *per side*, on top of `pad`, taken while a bubble is on screen.
   * `0` whenever there is none — the window shrinks straight back.
   */
  readonly bubbleExtra: number;
}

/**
 * Logical pixels per bubble column, per unit of sprite scale.
 *
 * The renderer draws the bubble in a monospace font of `6 * scale` CSS pixels
 * (`drawBubble`), and a monospace advance is close enough to 0.6 em that
 * `6 * 0.6 = 3.6` predicts the column width within a pixel across the stacks in
 * `BUBBLE_FONT_STACK`. It only has to be close: the renderer measures the real
 * font with `ctx.measureText` and wraps to whatever the window turned out to be,
 * so an estimate that is slightly generous costs a few transparent pixels and
 * one that is slightly mean costs one wrapped word.
 */
export const BUBBLE_COL_PX_PER_SCALE = 3.6;

/**
 * The bubble's own chrome — outline and inner padding, both sides — in logical
 * pixels. Mirrors `drawBubble`'s `2 * (outline + padX)` at dpr 1.
 */
export const BUBBLE_CHROME_PX = 10;

/**
 * Most extra width the window will take per side, in logical pixels.
 *
 * A cap, not a target. The window is always-on-top and click-through outside
 * the dog's ink, so extra width is invisible and harmless — but it is still
 * window area the compositor deals with, and the clamp that keeps the dog
 * reachable works on the window rect. 120 px is enough for the longest bark any
 * provider produces at every size, and small enough that a pathological label
 * cannot turn the mascot into a banner.
 */
export const BUBBLE_EXTRA_MAX_PX = 120;

/**
 * Extra window width **per side** so a bubble of `columns` columns fits.
 *
 * Symmetric on purpose: the sprite is centred in the window
 * (`spriteOrigin`), so widening both sides equally keeps the dog exactly where
 * he was standing and the bubble centred over him. Widening one side would slide
 * him sideways every time he barked.
 *
 * `0` for no bubble, and `0` whenever the text already fits — the common case,
 * which must not resize the window at all.
 */
export function bubbleExtraPx(columns: number, scale: number, box: BoxSize): number {
  const cols = Math.max(0, Math.floor(columns));
  if (cols === 0) return 0;

  const wanted = cols * BUBBLE_COL_PX_PER_SCALE * scale + BUBBLE_CHROME_PX;
  // What the window already offers the bubble: the sprite box plus its padding.
  const have = box.width * scale + 2 * (8 * scale);
  if (wanted <= have) return 0;
  return Math.min(BUBBLE_EXTRA_MAX_PX, Math.ceil((wanted - have) / 2));
}

/**
 * Window size for a given sprite scale and standing box.
 *
 * The window is padded around the dog for two reasons: the speech bubble (a
 * later stage) needs room *above* the sprite, and a click-through window cannot
 * grow on demand — whatever the bubble will need must already be part of the
 * window. The dog sits at the bottom, centred, so the reserve is all on top.
 *
 * `standBox` comes from the loaded sheet, so re-authored art resizes the window
 * with no code change.
 */
export function overlayMetrics(scale: number, standBox: BoxSize): OverlayMetrics {
  return boxMetrics(scale, standBox, true);
}

/**
 * Window size for any sprite box, with the bubble reserve made optional and an
 * optional per-side widening for a bubble that is currently on screen.
 *
 * The sleeping box normally gets `reserveBubble: false`. Walder only sleeps when
 * there is nothing to say — a bark or a perk wakes him into the standing box
 * first — so reserving 24 sprite-pixels of empty space above a curled-up dog
 * would make the tiny mode mostly transparent padding for a bubble that cannot
 * appear while he is in it. (The one exception is the `…zzz` a pet earns while
 * he stays asleep, and its caller passes `true`.)
 *
 * `bubbleExtra` comes from `bubbleExtraPx` and is `0` at rest, so an idle window
 * is exactly the size it always was.
 */
export function boxMetrics(
  scale: number,
  box: BoxSize,
  reserveBubble: boolean,
  bubbleExtra = 0
): OverlayMetrics {
  const pad = 8 * scale;
  const bubbleReserve = reserveBubble ? 24 * scale : 0;
  const extra = Math.max(0, Math.round(bubbleExtra));
  return {
    width: box.width * scale + 2 * pad + 2 * extra,
    height: box.height * scale + bubbleReserve,
    pad,
    bubbleReserve,
    bubbleExtra: extra
  };
}

/**
 * The inset that turns the overlay window rect into the sprite's ink rect: the
 * horizontal padding either side (including any bubble widening, which is
 * transparent too), and the bubble reserve above. The dog stands on the window's
 * bottom edge, so there is nothing to trim at the bottom.
 *
 * This is what `clampRectToWorkAreas` should be given for the overlay, so the
 * off-screen guard measures the dog rather than the transparent surround.
 */
export function inkInset(metrics: OverlayMetrics): Required<RectInset> {
  const side = metrics.pad + metrics.bubbleExtra;
  return { left: side, right: side, top: metrics.bubbleReserve, bottom: 0 };
}

/**
 * Top-left of the sprite inside a view of `viewWidth` x `viewHeight`: bottom
 * aligned, horizontally centred. Shared by the main process (for window sizing)
 * and the renderer (for drawing and hit-testing) so the two can never disagree
 * about where the dog is.
 */
export function spriteOrigin(
  viewWidth: number,
  viewHeight: number,
  boxWidth: number,
  boxHeight: number,
  scale: number
): { x: number; y: number } {
  return {
    x: Math.round((viewWidth - boxWidth * scale) / 2),
    y: Math.round(viewHeight - boxHeight * scale)
  };
}

/** Default resting spot: bottom-right of a work area, inset by `margin`. */
export function bottomRightOf(
  area: Rect,
  width: number,
  height: number,
  margin: number
): { x: number; y: number } {
  return clampInto(
    {
      x: area.x + area.width - width - margin,
      y: area.y + area.height - height - margin,
      width,
      height
    },
    area
  );
}

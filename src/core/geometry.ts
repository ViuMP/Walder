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

/** Logical size of the standing sprite box; the window is sized around it. */
export const STAND_BOX = { width: 48, height: 40 } as const;

export interface OverlayMetrics {
  /** Window size in logical pixels. */
  readonly width: number;
  readonly height: number;
  /** Horizontal breathing room either side of the sprite. */
  readonly pad: number;
  /** Vertical space above the sprite, reserved for the speech bubble. */
  readonly bubbleReserve: number;
}

/**
 * Window size for a given sprite scale.
 *
 * The window is padded around the dog for two reasons: the speech bubble (a
 * later stage) needs room *above* the sprite, and a click-through window cannot
 * grow on demand — whatever the bubble will need must already be part of the
 * window. The dog sits at the bottom, centred, so the reserve is all on top.
 */
export function overlayMetrics(scale: number): OverlayMetrics {
  const pad = 8 * scale;
  const bubbleReserve = 24 * scale;
  return {
    width: STAND_BOX.width * scale + 2 * pad,
    height: STAND_BOX.height * scale + bubbleReserve,
    pad,
    bubbleReserve
  };
}

/**
 * The inset that turns the overlay window rect into the sprite's ink rect: the
 * horizontal padding either side, and the bubble reserve above. The dog stands on
 * the window's bottom edge, so there is nothing to trim at the bottom.
 *
 * This is what `clampRectToWorkAreas` should be given for the overlay, so the
 * off-screen guard measures the dog rather than the transparent surround.
 */
export function inkInset(metrics: OverlayMetrics): Required<RectInset> {
  return { left: metrics.pad, right: metrics.pad, top: metrics.bubbleReserve, bottom: 0 };
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

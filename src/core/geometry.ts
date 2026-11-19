/**
 * Screen geometry for the overlay window: keeping the dog inside the screen.
 * Pure maths, no Electron — the main process supplies the work areas it read
 * from `screen`, so this stays unit-testable.
 *
 * **The rule (owner, 2026-11-16).** Walder cannot be outside the screen, no
 * exceptions: every part of his ink is on the work area of some display, at
 * all times and whichever way his position came about. With several displays
 * he may stand across the seam between two of them, as long as the work areas
 * together cover him; he never hangs into space that is on no display, and
 * never over a taskbar, the Dock or the menu bar. `coveredByWorkAreas` is the
 * test and `clampRectInsideWorkAreas` the correction; there is no second,
 * lenient clamp any more (until this rule a drag only had to leave 24 px of
 * him reachable, QA row 2.2 as it then was).
 */
import { devicePixelScale, usableDpr, type PixelFit } from '../sprites/raster';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Per-edge shrink that turns a window rect into the rect that has to stay on
 * screen.
 *
 * The overlay window is mostly transparent — padding either side of the sprite
 * and a tall reserve above it for the speech bubble — so the window rect says
 * little about where the dog is: all of the window can be on screen with
 * nothing but empty pixels showing, and the padding of a dog standing in a
 * corner hangs off the screen with every pixel of him on it. Callers pass the
 * inset that turns the window rect into the sprite's *ink* rect, and the clamp
 * reasons about that instead. Omitted edges are 0, so `{}` and `undefined` both
 * mean "the whole window".
 */
export interface RectInset {
  readonly left?: number;
  readonly right?: number;
  readonly top?: number;
  readonly bottom?: number;
}

/**
 * Shrink `rect` by `inset`. Never smaller than 1x1: a degenerate rect has no
 * extent to keep on screen, and the clamp would have nothing to hold there.
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
 * Absorbs floating-point noise in the coverage test: a rect placed flush with
 * a right edge at `right - width` has its own right edge at
 * `(right - width) + width`, which with a fractional width (172.8 at 125 %) is
 * not always `right` again. A sliver thinner than this is not a part of the
 * dog that is off the screen. With whole-number inputs — window positions and
 * work areas are whole DIPs — every comparison here is exact and it does
 * nothing.
 */
const COVER_EPSILON = 1e-6;

/** The work areas a rect can be on: a display that reports no area is none. */
function usableAreas(workAreas: readonly Rect[]): Rect[] {
  return workAreas.filter((area) => area.width > 0 && area.height > 0);
}

/**
 * The stretches `[start, start + size]` is cut into by the area edges that
 * fall strictly inside it, as their midpoints. Slivers thinner than
 * `COVER_EPSILON` are left out (float noise at an edge); a stretch with no
 * length at all is answered with its one point, so a degenerate rect is still
 * tested rather than waved through.
 */
function cutMidpoints(start: number, size: number, edges: readonly number[]): number[] {
  if (size <= COVER_EPSILON) return [start + size / 2];
  const end = start + size;
  const cuts = [start, ...edges.filter((edge) => edge > start && edge < end), end].sort(
    (a, b) => a - b
  );
  const mids: number[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const from = cuts[i] as number;
    const to = cuts[i + 1] as number;
    if (to - from > COVER_EPSILON) mids.push((from + to) / 2);
  }
  return mids;
}

/** `coveredByWorkAreas` for an ink rect and areas already filtered. */
function inkCovered(ink: Rect, areas: readonly Rect[]): boolean {
  if (areas.length === 0) return false;
  const xs = cutMidpoints(
    ink.x,
    ink.width,
    areas.flatMap((area) => [area.x, area.x + area.width])
  );
  const ys = cutMidpoints(
    ink.y,
    ink.height,
    areas.flatMap((area) => [area.y, area.y + area.height])
  );
  // A coordinate so large that `start + size` rounds back to `start` leaves no
  // stretch to test, and `every` over nothing is true: that is not "covered".
  if (xs.length === 0 || ys.length === 0) return false;
  return xs.every((x) =>
    ys.every((y) =>
      areas.some(
        (area) =>
          x >= area.x - COVER_EPSILON &&
          x <= area.x + area.width + COVER_EPSILON &&
          y >= area.y - COVER_EPSILON &&
          y <= area.y + area.height + COVER_EPSILON
      )
    )
  );
}

/**
 * Is the ink of `rect` — `rect` shrunk by `inset`, the whole of it when there
 * is none — wholly inside the **union** of the work areas?
 *
 * The union, not one area: a dog standing across the seam between two
 * displays is inside when the two work areas together cover him (the owner's
 * second decision, 2026-11-16). Rects are closed, so touching an edge is
 * inside. With no work areas at all the answer is `false`.
 *
 * **Method.** The ink is cut along every area edge that crosses it; each
 * piece is then either wholly inside an area or wholly outside every one, so
 * testing its centre is exact. That makes no assumption about how the areas
 * lie: side by side, stacked, of different sizes and offsets, touching at a
 * corner only, or overlapping (real displays' never do).
 *
 * **A strip between two work areas is in neither.** Where a taskbar, the Dock
 * or a menu bar sits on the seam, the work areas stop short of each other by
 * its thickness, and a rect across the strip is not covered: he cannot rest
 * over a taskbar, which is the owner's first decision. The same holds for two
 * displays that touch at a corner only — no rect with any size is covered by
 * both. `clampRectInsideWorkAreas` says how he gets across.
 */
export function coveredByWorkAreas(
  rect: Rect,
  workAreas: readonly Rect[],
  inset?: RectInset
): boolean {
  const ink = inset === undefined ? rect : applyInset(rect, inset);
  return inkCovered(ink, usableAreas(workAreas));
}

/** A place the ink could go, with what it costs to get there. */
interface Move {
  readonly x: number;
  readonly y: number;
  /** Squared length of the move from where the ink is. */
  readonly d: number;
  /** How far it moves him vertically, as a magnitude. */
  readonly dy: number;
}

/**
 * The order candidates are preferred in: the shortest move, then the one that
 * moves him least vertically (he keeps the floor he stands on and slides
 * sideways), then the leftmost, then the topmost. A strict order on distinct
 * points, so the answer does not depend on the order of the work areas.
 */
function byPreference(a: Move, b: Move): number {
  return a.d - b.d || a.dy - b.dy || a.x - b.x || a.y - b.y;
}

function moveTo(ink: Rect, x: number, y: number): Move {
  const dx = x - ink.x;
  const dy = y - ink.y;
  return { x, y, d: dx * dx + dy * dy, dy: Math.abs(dy) };
}

/**
 * The nearest window position at which the ink of `rect` is wholly inside the
 * union of the work areas (`coveredByWorkAreas`) — the one clamp, for every
 * way his position is set: a drag while it is moving, a drop, the position
 * restored at launch, Reset, a size or box change, a bubble, a display
 * change, a wake. `inset` means what it does there, and the answer is the
 * *window* position that puts the ink at the spot found.
 *
 * **Already inside is unchanged.** That is the fixed point everything else
 * rests on: clamping twice is clamping once, so nothing that re-validates a
 * position can move a dog who is where he should be; the anchors of a size
 * change (the bottom edge he stands on, the resting window's edge on his side
 * of the screen, audit X1) decide everything wherever there is room for them;
 * and a round trip between sizes comes home (QA rows 3.3 and 3.3a).
 *
 * **Otherwise the smallest move.** Among the positions where he is covered,
 * the one nearest to where he was asked to be, by straight-line distance;
 * ties go to the smaller vertical move, then left, then up (`byPreference`).
 *
 * **Why a handful of candidates is the whole search.** The positions at which
 * the ink is covered are the union of the work areas shrunk by the ink's
 * size: a closed region with straight sides, whose vertical sides lie only at
 * an area's left edge or at an area's right edge less the ink's width, and
 * its horizontal ones likewise. It is therefore a finite union of closed
 * boxes with corners on that grid, and the point of a box nearest to `p` has,
 * on each axis, either `p`'s own coordinate or a corner's. So the nearest
 * covered position is among `{ink.x, each area's x, each area's right - w}` x
 * `{ink.y, each area's y, each area's bottom - h}` — at most `(2n + 1)²`
 * points for `n` displays — and each is checked with the coverage test
 * before it is taken, so nothing rests on the argument alone
 * (`test/geometry.test.ts` also compares it with a brute-force search).
 *
 * **On one display** this is the per-axis clamp into the work area, exactly
 * what the size-change clamp was before 2026-11-16: left at the right edge,
 * up at the bottom, and during a drag the pinned axis stays pinned while the
 * other follows the pointer, so he slides along the edge.
 *
 * **Across a seam.** Where two work areas share an edge he passes straight
 * through, covered at every step. Where they do not quite — a taskbar on the
 * seam, or two displays touching at a corner — no position across the gap is
 * covered, so he stays on the near side until the place he is asked to be is
 * nearer to the far side, and then crosses in one hop of his own size plus
 * the strip's thickness.
 *
 * **The inner corner of an L.** Two displays of different heights side by
 * side make an L-shaped union, and the covered positions form an L too, with
 * one corner pointing inwards. For a spot in the dead quadrant behind that
 * corner — `dx` deep one way, `dy` deep the other — he goes to the arm that
 * needs the smaller move, and to the horizontal move when they are equal. So
 * a drag into the dead quadrant slides him along the nearer arm's wall, and
 * when the pointer crosses the diagonal he jumps to the other arm, by
 * `sqrt(2)` times how deep it is; passing close to the corner the jump is
 * nothing. That is the one discontinuity any nearest-point rule has on a
 * region that is not convex. It never traps him: a position that is covered
 * is always answered with itself, so wherever he may stand, the pointer can
 * take him by asking for exactly that.
 *
 * **Ink that fits nowhere** — larger than every work area, and not covered
 * across any seam either — cannot obey the rule. It is pinned as before: its
 * top-left to the top-left of the area that takes the smallest move
 * (`clampInto`), so his head and front are what stays visible. Stable too:
 * clamping that answer again returns it.
 *
 * **No work areas** (a transient state while displays are reconfigured, or
 * every display reporting an empty area): the position is returned untouched.
 * Guessing is worse than waiting for the `display-*` event that follows.
 */
export function clampRectInsideWorkAreas(
  rect: Rect,
  workAreas: readonly Rect[],
  inset?: RectInset
): { x: number; y: number } {
  const areas = usableAreas(workAreas);
  if (areas.length === 0) return { x: rect.x, y: rect.y };

  const ink = inset === undefined ? rect : applyInset(rect, inset);
  if (inkCovered(ink, areas)) return { x: rect.x, y: rect.y };

  const xs = [ink.x, ...areas.flatMap((a) => [a.x, a.x + a.width - ink.width])];
  const ys = [ink.y, ...areas.flatMap((a) => [a.y, a.y + a.height - ink.height])];
  const candidates = xs.flatMap((x) => ys.map((y) => moveTo(ink, x, y))).sort(byPreference);
  let best = candidates.find((c) => inkCovered({ ...ink, x: c.x, y: c.y }, areas));

  if (best === undefined) {
    // Fits nowhere: pin the top-left, on the area nearest to him.
    best = areas
      .map((area) => {
        const pinned = clampInto(ink, area);
        return moveTo(ink, pinned.x, pinned.y);
      })
      .sort(byPreference)[0] as Move;
  }

  // The ink moves; the window follows it by the same translation, so the
  // padding and the bubble reserve may still hang off the screen.
  // An axis he keeps is returned as it came. One he moves on is reckoned from
  // the spot found, not as a difference from where he was: from far enough off
  // (a hand-edited 1e20) that difference no longer holds the small number.
  return {
    x: best.x === ink.x ? rect.x : best.x - (inset?.left ?? 0),
    y: best.y === ink.y ? rect.y : best.y - (inset?.top ?? 0)
  };
}

function sameInset(a: RectInset, b: RectInset): boolean {
  return (
    (a.left ?? 0) === (b.left ?? 0) &&
    (a.right ?? 0) === (b.right ?? 0) &&
    (a.top ?? 0) === (b.top ?? 0) &&
    (a.bottom ?? 0) === (b.bottom ?? 0)
  );
}

/**
 * `clampRectInsideWorkAreas` for an inset that depends on where he ends up.
 *
 * His drawn ink depends on the scale factor of the display he is on
 * (`drawnInkInset`), and which display that is can change with the very move
 * the clamp makes — across a seam between a 100 % and a 125 % display. So the
 * inset is asked for at the rect, the clamp made with it, and the inset asked
 * for again where he landed; when it is the same, that is the answer. When it
 * is not, the *original* rect is clamped once more with the new inset (the
 * original, so the move stays the smallest one) and checked the same way.
 * Should the two insets each send him to the other's display, the largest ink
 * seen — the smallest inset on every edge — decides: wherever that lands he
 * is covered under either.
 *
 * At most three clamps, so it always ends, and what it returns it returns
 * again when asked about that position, as long as the inset takes no more
 * than two values on the way (two scale factors) and he fits at all. With one
 * scale factor it is a single clamp and one extra question.
 *
 * With no work areas the position is returned untouched and `insetAt` is not
 * called: what it would ask the screen has no answer then.
 */
export function clampRectInsideWorkAreasAt(
  rect: Rect,
  workAreas: readonly Rect[],
  insetAt: (at: Rect) => RectInset
): { x: number; y: number } {
  if (usableAreas(workAreas).length === 0) return { x: rect.x, y: rect.y };

  const first = insetAt(rect);
  const q1 = clampRectInsideWorkAreas(rect, workAreas, first);
  const second = insetAt({ ...rect, ...q1 });
  if (sameInset(first, second)) return q1;

  const q2 = clampRectInsideWorkAreas(rect, workAreas, second);
  const third = insetAt({ ...rect, ...q2 });
  if (sameInset(second, third)) return q2;

  const least = (edge: keyof RectInset): number =>
    Math.min(first[edge] ?? 0, second[edge] ?? 0, third[edge] ?? 0);
  return clampRectInsideWorkAreas(rect, workAreas, {
    left: least('left'),
    right: least('right'),
    top: least('top'),
    bottom: least('bottom')
  });
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
  /**
   * Transparent sprite pixels no frame leaves inked above him and either side
   * of him (`sharedInkMargin` in `sprites/contract`). Only the screen
   * clamp reads it (`drawnInkInset`); omitted, the box's edge is his ink's.
   */
  readonly ink?: InkMargin;
}

/** Sprite pixels of a box that no frame inks: above him, and either side (mirrored alike). */
export interface InkMargin {
  readonly top: number;
  readonly side: number;
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
 * The speech bubble's font size in CSS pixels, for a given sprite scale.
 *
 * **The bubble is sized for reading, not for the dog.** It used to be
 * `6 * scale` — 6 / 12 / 18 px, floored at 8 by the renderer — which made it a
 * fraction of the mascot: shrinking Walder to get him out of the way also shrank
 * the only thing he has for telling you something, which is exactly backwards.
 * The owner's report (2026-09-11) was "it's too small at the moment"; asked what
 * it should be, he chose **12 / 14 / 16**.
 *
 * Not literally constant, then, but a flat ramp — a 33 % spread where the sprite
 * has a 200 % one. The floor is high enough to read at Small and the ceiling low
 * enough that Large does not put a notification banner over a 216 px dog. Every
 * other bubble dimension (outline, padding, tail) was already scale-independent
 * and measured in device pixels; this was the last thing tied to the sprite.
 *
 * `10 + 2 * scale` rather than a lookup table so that any scale is answered,
 * including ones that are not 1/2/3 — and clamped, because `scale` arrives from
 * an IPC payload and a junk value must not produce a 2 px bubble or a NaN one.
 */
export function bubbleFontPx(scale: number): number {
  const s = Number.isFinite(scale) ? Math.min(Math.max(scale, 1), 3) : 1;
  return Math.round(10 + 2 * s);
}

/**
 * Logical pixels per bubble column at a given sprite scale.
 *
 * A monospace advance predicts the column width within a pixel across the stacks
 * in `BUBBLE_FONT_STACK`. It only has to be close: the renderer measures the real
 * font with `ctx.measureText` and wraps to whatever the window turned out to be,
 * so an estimate that is slightly generous costs a few transparent pixels and one
 * that is slightly mean costs one wrapped word.
 *
 * **0.62, not 0.6, since 0.2.5.** `ui-monospace` on macOS *is* SF Mono, whose
 * advance is 1266/2048 = 0.618 em — so 0.6 was mean by 3 %, which is a whole
 * column short on a 28-column bark and exactly one word wrapped or, before the
 * one-line widening in `main/behaviour.ts`, cut. Rounded up rather than to
 * 0.618: being generous here is the cheap direction.
 *
 * Was the constant `BUBBLE_COL_PX_PER_SCALE = 3.6` (i.e. `6 * 0.6`) multiplied
 * by the scale. It tracks `bubbleFontPx` now, for the same reason the reserve
 * does: both are predictions about what the renderer will draw, and a prediction
 * that keeps its own copy of the font size is a prediction that goes stale.
 */
export function bubbleColumnPx(scale: number): number {
  return bubbleFontPx(scale) * 0.62;
}

/**
 * Vertical space reserved above the sprite for the bubble, in logical pixels.
 *
 * Was `24 * scale`. It has to follow `bubbleFontPx` now, and the consequence is
 * worth stating because it is visible: at Small the window gets **taller** than
 * it used to be (44 px of reserve where there were 24) and at Large it gets
 * **shorter** (54 where there were 72). That asymmetry is the whole change — the
 * bubble stopped being a fraction of the dog.
 *
 * The number is not a guess. A window cannot grow once the renderer is drawing,
 * so a reserve one line short does not scroll — `layoutBubble` silently computes
 * `rows = 1` and the second line is dropped, which on `7-day (all models): 85%
 * used` is the half with the number in it. This mirrors `layoutBubble`'s own
 * arithmetic at dpr 1: two lines of `round(font * 1.2)`, the box's 2 px outline
 * and 2 px inner padding top and bottom, the three-step tail (6 px) less the
 * outline it overlaps, and one pixel of air above the dog — then a few pixels of
 * slack, because at dpr 2 and 3 every one of those terms rounds independently.
 * The `+ 20` is slack, and it is not a guess either — it was solved for. Every
 * term of `layoutBubble`'s layout rounds *independently*, and the worst case is a
 * fractional ratio rather than a large one: at dpr 1.5 the chrome's `unit` is
 * `round(1.5)` = **2**, so outline, padding and tail all jump to their 2x size
 * while the font has only grown by half — and 16 px of slack lost the second
 * line there while passing comfortably at dpr 1, 2 and 3. 20 is the smallest
 * value that clears two lines at every scale across the whole 1.0-3.0 range,
 * with a pixel in hand.
 *
 * `test/geometry.test.ts` re-derives `layoutBubble`'s own `rows` arithmetic and
 * asserts it comes out at 2 for every scale at dpr 1, 1.5, 2, 2.25 and 3 — the
 * check that caught the 1.5 case in the first place.
 */
export function bubbleReservePx(scale: number): number {
  return 2 * Math.round(bubbleFontPx(scale) * 1.2) + 20;
}

/**
 * Everything of the window's width the bubble's text does **not** get, in
 * logical pixels: the box's outline and inner padding both sides, plus the unit
 * of breathing room `layoutBubble` keeps at each window edge.
 *
 * In device pixels the renderer spends `2 * unit` on the edges and
 * `2 * (outline + padX)` = `2 * (2 * unit + 3 * unit)` on the chrome — twelve
 * units in all, with `unit = max(1, round(dpr))`. Twelve *logical* pixels is
 * therefore right only when `round(dpr) === dpr`.
 *
 * **16, because dpr 1.5 exists.** There the unit rounds up to 2 while the font
 * has grown by only half, so those twelve units cost `12 * 2 / 1.5` = 16 CSS
 * pixels — the same term that costs `bubbleReservePx` its slack, on the other
 * axis. It was 10 (the chrome alone, at dpr 1) and the two missing edge units
 * put the renderer's column count one short of the text at *every* scale and
 * every dpr, which the one-line widening then had no way to recover from.
 * 16 is the smallest value for which `test/geometry.test.ts` re-derives at least
 * `text.length` columns for every bark Walder produces; 15 is not.
 */
export const BUBBLE_CHROME_PX = 16;

/**
 * Most extra width the window will take per side, in logical pixels.
 *
 * A cap, not a target. The window is always-on-top and click-through outside
 * the dog's ink, so extra width is invisible and harmless — but it is still
 * window area the compositor deals with, and all of it that passes a screen
 * edge is room the bubble cannot use. 120 px is enough for the longest bark any
 * provider produces at every size, and small enough that a pathological label
 * cannot turn the mascot into a banner.
 */
export const BUBBLE_EXTRA_MAX_PX = 120;

/**
 * Where the dog's *resting* window stands on its work area, for
 * `bubbleExtraPx`: the resting window's left edge (the window's left edge plus
 * whatever bubble widening it has now) and the work area's x and width, all in
 * logical pixels on one axis.
 */
export interface BubbleSite {
  readonly restX: number;
  readonly areaX: number;
  readonly areaWidth: number;
}

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
 *
 * **`site`: room on the screen, not room in the window (0.2.8 QA, row 5.9a2).**
 * Without it the answer assumes the whole widened window is visible. It is not
 * when the *window* hangs off a work-area edge, and near an edge it always
 * does: only his ink has to be inside the screen (the rule of 2026-11-16,
 * `clampRectInsideWorkAreas`), so with his ink flush with an edge the padding
 * and the whole widening on that side are off it. The case this was found in
 * is history — then the dog himself could hang off, after a drag (24 px of him
 * on screen was enough until 2026-11-16) or after a size change at the default
 * spot (before 2026-11-14, audit X1, `resize` anchored the resting left edge
 * on both halves of the screen): the 88 px Small window at
 * x 1624 became a 264 px Large one at the same x, and on a 1728 pt screen only
 * 104 px of it — 80 px of dog — was on screen. Widened by 70 a side for
 * `Hello. Click the bone in your menu bar.`, the window ran from 1554 to 1958;
 * `layoutBubble` lays out inside `onScreenSpan`, which was 174 px, and 174 px at
 * a 16 px font is 16 columns: `Hello. Click the / bone in your…`. The reading
 * was not stale — x and width were from the same state and the arithmetic is
 * exact (`test/geometry.test.ts` re-derives the 16) — there simply was not the
 * room. Small and Medium passed only because the same 104 px shortfall is
 * smaller than their wider windows. No position that far off is reachable any
 * more; the arithmetic is the same for the smaller overhang that is.
 *
 * So with a `site` the widening grows until the window's **on-screen part** is
 * as wide as the bubble asks for, capped exactly as before — the room a fully
 * visible widened window would give it, to within the rounding of `ceil`. The
 * bubble therefore gets the same room wherever the dog stands — the room every
 * test below already proves is enough for one line of every bark and two of the
 * intro — and a dog fully on screen gets exactly the symmetric answer, because
 * the extra terms are then negative. Still symmetric: the dog does not move, the
 * transparent surplus just hangs further off the edge, where nobody sees it and
 * clicks pass through. The cap still bounds the *room* (`have + 2 * cap`), so a
 * pathological label is no wider on screen than it ever was, and the off-screen
 * surplus on top of it is never more than that room again.
 *
 * The visible width of a window widened by `e` either side is
 * `min(areaWidth, areaRight - restX + e, restX + have - areaX + e, have + 2e)`
 * — clipped by the area, by its right edge, by its left edge, or not at all —
 * so each term is solved for `e` separately and the largest answer wins.
 */
export function bubbleExtraPx(
  columns: number,
  scale: number,
  box: BoxSize,
  site?: BubbleSite
): number {
  const cols = Math.max(0, Math.floor(columns));
  if (cols === 0) return 0;

  const wanted = cols * bubbleColumnPx(scale) + BUBBLE_CHROME_PX;
  // What the window already offers the bubble: the sprite box plus its padding.
  const have = box.width * scale + 2 * (8 * scale);
  const symmetric =
    wanted <= have ? 0 : Math.min(BUBBLE_EXTRA_MAX_PX, Math.ceil((wanted - have) / 2));
  if (site === undefined) return symmetric;

  // The room a fully visible window would give, which is all this promises.
  const room = Math.min(wanted, have + 2 * symmetric, site.areaWidth);
  const clippedRight = room - (site.areaX + site.areaWidth - site.restX);
  const clippedLeft = room - (site.restX + have - site.areaX);
  return Math.max(symmetric, Math.ceil(clippedRight), Math.ceil(clippedLeft));
}

/**
 * The part of a window that lies on its work area, as window-relative
 * `{ left, right }` x offsets — the room the bubble may actually use.
 *
 * **Why the renderer needs this.** `bubbleExtraPx` widens the window
 * symmetrically so the dog stays put, but the window is clamped on the *dog's*
 * ink (`inkInset`), not on the widening. At the default spot, 16 px from the
 * right edge of the work area, a widened window therefore hangs off the screen,
 * and a box centred in the window and clamped only to the window put the end of
 * `Hello. Click the bone in your menu bar.` 74 px off screen at Medium. Moving
 * the window instead would move the sprite (it is centred in the window) and the
 * hover card anchored to his ink, which must not budge during a bark — so the
 * window stays where it is and the bubble is laid out inside this span.
 *
 * One axis, one area, CSS pixels throughout. Returns the whole window when it
 * does not overlap the area at all: that is a stale or bogus reading (the dog
 * is always kept on screen), and the old window-bounded layout is a better
 * answer to it than an empty span that would draw no bubble.
 *
 * **One area, also for a dog standing across a seam** (allowed since
 * 2026-11-16). The renderer hands in the display its window is assigned to,
 * so his bubble is laid out on that display's side of the seam and squeezed
 * there rather than spread over both — reckoned from the code, not seen on
 * two displays. This is the horizontal axis only; `bubbleTop` is the vertical
 * one, and what keeps a bubble below the top of a work area.
 */
export function onScreenSpan(
  windowX: number,
  width: number,
  areaX: number,
  areaWidth: number
): { left: number; right: number } {
  const left = Math.max(0, areaX - windowX);
  const right = Math.min(width, areaX + areaWidth - windowX);
  return right > left ? { left, right } : { left: 0, right: width };
}

/**
 * How far below the window's top edge its work area begins — the vertical
 * analogue of `onScreenSpan`: the bubble may not be drawn above this row. `0`
 * for a window that starts on its work area, which is every bubble that is not
 * at a top edge, and those are laid out exactly as before.
 *
 * **Why (2026-11-17).** The window is clamped on the sprite box (`inkInset`),
 * so a dog dragged to the top of a display stands with his box's top on the
 * work area's top and the **whole** bubble reserve above it. On the Mac that is
 * the menu bar: at Small, window y -15 under a work area starting at 33, a
 * `Codex waiting` bubble was drawn at y 5.5, on the menu bar. Moving the window
 * down instead would move him and the hover card anchored to his ink, the same
 * reason `onScreenSpan` gives; so the window stays and the bubble comes down.
 *
 * No platform in it: the menu bar is the case that was seen, a top taskbar on
 * Windows and the top of any display are the same arithmetic. `0` also for a
 * window that lies entirely above its area — a stale or bogus reading, answered
 * with the old layout as `onScreenSpan` answers its own.
 *
 * **A display above is the same arithmetic and not the same case — an accepted
 * loss.** `areaY` is the top of the one display the window is assigned to. The
 * clamp is on the union of the work areas, so where one window spans displays
 * (Windows; a Mac with "Displays have separate Spaces" off) he can stand at the
 * top of a lower display with a work area continuing above the seam. There the
 * reserve is visible screen and the bubble used to be drawn on it in full; now
 * it is brought down like any other, which at Small cuts a two-line text to one
 * and on a 125 % or 150 % display drops the bubble. Reckoned from the code, not
 * seen on two displays.
 * ponytail: the renderer sees one display. If stacked displays turn out to
 * matter, main sends the top of the union's column above him (the upgrade path
 * `watchBubblePlacement` in the renderer already names) in place of `areaY`.
 */
export function bubbleTop(windowY: number, height: number, areaY: number): number {
  const top = areaY - windowY;
  return top > 0 && top < height ? top : 0;
}

/**
 * Sprite rows of his resting ink a bubble pushed down by `bubbleTop` may
 * cover: his ears and the top of his head, not his face. Eight is the height
 * of the cats' ears (rows 16-23 of the standing box) and stops two rows short
 * of the dachshund's eye (ink from row 25, eye from row 35) — and it is the
 * overlap `spriteLayout` already accepts for a dog drawn larger than nominal.
 */
export const BUBBLE_EAR_ROWS = 8;

/**
 * The height `layoutBubble` may give the bubble's box when the top `top` rows of
 * the window are off its work area. One unit throughout (the renderer's device
 * pixels).
 *
 * `space` is what the reserve gives a box with its tail under it, and with
 * `top` 0 it is returned untouched. Otherwise the box starts at `top`, and it
 * gets the larger of what is left of the reserve and the room down to `ears`
 * rows into his resting ink (`inkTop`), where the box sits on his head with no
 * tail. At a top edge the reserve is gone entirely, so it is the second: the
 * transparent rows above his ink plus his ears.
 *
 * What that buys, with the shipped art (ink from row 25 of the box for the
 * dog, 16 for the cats) and a one-line box of 22 / 25 / 27 px and a two-line
 * one of 36 / 42 / 46 px at Small / Medium / Large: every bubble fits at Medium
 * and Large (the cats' two lines at Medium cover 5 rows of ear), one line fits
 * at Small (6 rows of the cats' ears, none of the dog), and **two lines do not
 * fit at Small** — they would reach row 36 or more, across his eyes. There the
 * renderer draws one line and a text that needed two ends in an ellipsis: a
 * cut message rather than a covered face. Main widens the window for a
 * one-line fit, so that is a text too long for the widening (the hooks notice
 * in a corner), not every bark.
 *
 * **Less for the cats since 2026-11-19 (RECHECK e).** The clamp now takes him
 * up to the highest ink any frame has (`sharedInkMargin`: four sprite rows
 * above the box's top), so at a top edge his resting ink is four rows nearer
 * the edge. The dachshund keeps all of the above; a cat keeps two lines only
 * at Large, one at Medium, and at Small no line fits at all (20 rows of room
 * against a 22 px box) but at 250 %. A trade awaiting the owner's call, in
 * `docs/DECISIONS.md`.
 *
 * **And where no line fits, there is no bubble.** That is Small on a 125 % or
 * 150 % display, where he is drawn at one device pixel a sprite pixel — smaller
 * than Small — under a bubble that is not: one line would cover 12 rows of the
 * dachshund and 10 to 21 of a cat, eyes included. `test/geometry.test.ts` has
 * the whole table, from the real clamp (`drawnInkInset`) and the shipped art.
 *
 * **Resting ink, not the frame on screen.** `inkTop` is the resting pose
 * (`spriteRectWindow` has why: measuring the frame showing made the anchor
 * twitch with every blink). A pose held under a bubble stands taller, and that
 * much more of it is under the box: the dachshund's held `perk_2` has ink from
 * row 12 (his raised tail tip, then the top of his head from row 19) against
 * 25 at rest, the calico's perk from row 7 (her tail) against 16, a held
 * `tilt_2` up to 5 rows above rest. Tail and head top, no eyes in the frames
 * measured (2026-11-17), so it is left.
 */
export function bubbleBoxSpace(top: number, space: number, inkTop: number, ears: number): number {
  return top > 0 ? Math.max(space - top, inkTop + ears - top) : space;
}

/**
 * Where the bubble's box goes once its height is known: its top row, whether it
 * keeps its tail, and whether it has come down from its usual place. The other
 * half of `bubbleBoxSpace`, same unit.
 *
 * `usual` is the row the box's bottom rests on in the reserve (`bubbleBoxSpace`'s
 * `space`), `tailReach` how far the tail hangs below that bottom. The box sits
 * on `usual` unless that would start it above `top`; then it starts at `top`.
 * A box that reaches his resting ink (`inkTop`) has no tail: it would point
 * into him.
 *
 * `lowered` is what the renderer leaves the decorations out for: a box that
 * ends below `usual` is over the top rows of his box, where the `?` by his ear
 * (rows 7-22) and the pet heart are drawn, and would cut them in half or hide
 * them — the `?` of the very `Codex waiting` it is saying. The words name the
 * tool, so the glyph is the one to go. `false` whenever `top` is 0, and for a
 * window only a little over the top whose box still fits what is left of the
 * reserve.
 */
export function bubbleBoxAt(
  top: number,
  usual: number,
  boxHeight: number,
  inkTop: number,
  tailReach: number
): { y: number; tail: boolean; lowered: boolean } {
  const y = Math.max(top, usual - boxHeight);
  return {
    y,
    tail: top === 0 || y + boxHeight + tailReach <= inkTop,
    lowered: top > 0 && y + boxHeight > usual
  };
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
  const bubbleReserve = reserveBubble ? bubbleReservePx(scale) : 0;
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
 * This is the inset at the dog's *nominal* size. The overlay's clamps are given
 * `drawnInkInset`, which is this whenever he is drawn at that size and the
 * renderer's drawn box when a fractional scale factor makes him larger or
 * smaller — so the off-screen guard measures the dog the owner sees rather than
 * the transparent surround.
 */
export function inkInset(metrics: OverlayMetrics): Required<RectInset> {
  const side = metrics.pad + metrics.bubbleExtra;
  return { left: side, right: side, top: metrics.bubbleReserve, bottom: 0 };
}

/**
 * Absorbs floating-point noise in `drawnInkInset` when an inset is a whole
 * number of CSS pixels: at 150 % Large the right inset is exactly 12, but
 * `264 - 12 - 72 * (5 / 1.5)` is 11.99999999999997, and flooring that would
 * hand the dog a pixel of his own padding for nothing. Far below any real
 * fraction of a pixel; the same idea as `FIT_EPSILON` in `sprites/raster.ts`.
 */
const INSET_EPSILON = 1e-9;

/** Everything `drawnInkInset` reads. */
export interface DrawnInkInput {
  /** The window's metrics, as `boxMetrics` laid it out (bubble widening included). */
  readonly metrics: OverlayMetrics;
  /** The nominal CSS pixels per sprite pixel the window was sized for. */
  readonly scale: number;
  /** The box showing in that window, in sprite pixels. */
  readonly box: BoxSize;
  /** The sheet's standing box: the renderer's size cap (`spriteFit`) is taken from it. */
  readonly standBox: BoxSize;
  /** The scale factor of the display the window is on. Sanitised by `usableDpr`. */
  readonly dpr: number;
  /**
   * The size the window **really has**, when that is not `metrics`' own —
   * bounds read back from a window the system granted a DIP or two larger (or
   * smaller) than was asked. Omitted, the window is `metrics.width` x
   * `metrics.height`, which is every rect main asks for.
   */
  readonly view?: { readonly width: number; readonly height: number };
}

/**
 * The inset that turns the overlay window rect into the rect the sprite box is
 * **drawn** in — `inkInset`, measured at the size the renderer actually draws
 * him rather than his nominal one (QA row 1.8, the follow-up).
 *
 * **Why `inkInset` is not enough.** `inkInset` assumes the box is drawn at
 * `scale` CSS pixels per sprite pixel, so the side padding (`8 * scale` a side)
 * is transparent and may hang off a screen edge. But the renderer draws at a
 * whole number of device pixels per sprite pixel (`devicePixelScale`) and lays
 * the box out at that size (`spriteLayout`), which at a fractional scale factor
 * is not `scale`: at 125 % Medium he is drawn at 2.4 CSS px per sprite pixel,
 * 172.8 of the 176 px window, so the "transparent" padding is 1.6 px a side, not
 * 16. Every clamp measured the nominal ink, so Size ▸ Medium at the default
 * corner settled the *nominal* box flush with the right edge and left 14.4 CSS
 * px — 18 physical — of the drawn dog off the screen (the owner's 125 %
 * report). The other way round, at 125 % Small he is drawn at 0.8, 57.6 of 88,
 * and the nominal inset under-counted the padding: the clamp kept 7.2 px of
 * transparent window a side on screen and called it dog.
 *
 * **The arithmetic is the renderer's**, not a re-derivation of it: the same
 * `devicePixelScale` with the same `spriteFit` cap, through the same
 * `spriteLayout`, so main's clamp and the renderer's blit cannot disagree about
 * where he is. From that layout:
 *
 *  - **Sides**: the drawn box's left edge (`css.x`), and the window width less
 *    its right edge. The bubble widening is part of the window width, so it is
 *    in both, exactly as `inkInset` counts it.
 *  - **Top**: the drawn box's top (`css.y`). Never negative — a box drawn taller
 *    than a window with no bubble reserve (125 % Medium asleep) is clipped by the
 *    window, so the ink that can be seen never starts above the window's top.
 *  - **Bottom**: 0. His feet are on the window's floor at every scale and ratio
 *    (`spriteLayout`'s anchoring rule).
 *
 * **Whole pixels, rounded towards a larger ink rect.** Window positions are
 * whole DIPs (Electron's `setPosition` takes integers), and an inset with a
 * fraction in it would make the clamps answer fractional positions. Flooring
 * the inset makes the measured rect at most a pixel *larger* than the drawn box
 * on each edge, never smaller, so "his ink is wholly on screen" stays true of
 * the drawn ink with up to a pixel of transparent window to spare — and it also
 * covers the half device pixel `spriteLayout` rounds the centring by.
 *
 * **Drawn at his nominal size it *is* `inkInset`**, returned as such rather than
 * recomputed: at dpr 1, 2 and 3 and at 150 % Medium the clamps, the saved
 * position and the corner behave byte-for-byte as they did before this existed
 * (`test/geometry.test.ts` pins it). The renderer's centring rounding there was
 * already accepted under the nominal inset, and recomputing it would move a
 * placement nobody has a complaint about.
 *
 * **In a window that is not the size it was laid out for** (`view`): the same
 * layout, run in the size the window really has — which is all the renderer
 * ever does, since it reads `window.innerWidth`/`innerHeight` and knows
 * nothing of the metrics. He stands on that window's floor and is centred in
 * its width, so extra height is air above his head *only as far as the box is
 * not clipped*: a box drawn taller than its window (125 % Medium asleep, 139.2
 * in 116) fills a taller window's extra rows with dog, and its visible top
 * stays the window's top until the window is taller than he is drawn. Adding
 * the surplus to the metrics' inset, which this replaced on 2026-11-17, called
 * those rows air and let a correction leave his head above a top edge by them.
 * The nominal shortcut is taken only when the window is exactly its metrics'
 * size, so nothing above changes for a rect main asked for.
 */
export function drawnInkInset(input: DrawnInkInput): Required<RectInset> {
  const { metrics, scale, box, standBox, dpr, view } = input;
  const usable = (size: number | undefined, laidOut: number): number =>
    size !== undefined && Number.isFinite(size) && size > 0 ? size : laidOut;
  const viewWidth = usable(view?.width, metrics.width);
  const viewHeight = usable(view?.height, metrics.height);
  const layout = spriteLayout({
    viewWidth,
    viewHeight,
    box,
    scale,
    pixelScale: devicePixelScale(scale, dpr, spriteFit(scale, standBox)),
    dpr
  });
  const asLaidOut = viewWidth === metrics.width && viewHeight === metrics.height;
  // The box's transparent margin is air, not dog (RECHECK 2026-11-18, e).
  const top = (box.ink?.top ?? 0) * layout.cssScale;
  const side = (box.ink?.side ?? 0) * layout.cssScale;
  if (asLaidOut && layout.cssScale === scale) {
    const nominal = inkInset(metrics);
    return { left: nominal.left + side, right: nominal.right + side, top: nominal.top + top, bottom: 0 };
  }
  const whole = (css: number): number => Math.max(0, Math.floor(css + INSET_EPSILON));
  const drawnRight = layout.css.x + box.width * layout.cssScale;
  return {
    left: whole(layout.css.x + side),
    right: whole(viewWidth - drawnRight + side),
    top: whole(layout.css.y + top),
    bottom: 0
  };
}

/**
 * The window rect the dog would have if he were standing at rest, given the
 * rect of a window currently laid out with `current` metrics. `rest` is the
 * standing box's metrics with no bubble (`metricsFor(scale, 'stand', 0)`).
 *
 * **Why this exists: a saved position has one meaning.** Startup reads the
 * stored point back as the top-left of the *standing* window
 * (`resolveStartPosition` is handed the stand metrics), but the window it was
 * saved from can be any box — curled up asleep, lying down at a high weekly
 * figure, or widened for a bark. Storing that window's top-left verbatim meant a
 * quit while asleep relaunched him a whole bubble reserve plus the difference in
 * box height *lower* (58 px at Small with the current sheet), and the
 * visibility clamp of the time let it through because 24 px of him was still
 * on screen (the clamp is strict since 2026-11-16; the meaning of a saved
 * point is still this function's to keep).
 * Normalising here, once, gives every caller of the save the same answer the
 * wake-up resize already gives:
 *
 *  - **Bottom kept.** The dog stands on the window's bottom edge in every box,
 *    and `resize` holds that edge still when he changes box, so the standing
 *    window he would wake into has the same bottom.
 *  - **Bubble widening undone.** The widening is symmetric and transparent;
 *    the window's left edge sits `bubbleExtra` further left than the dog's
 *    resting window does, so it is added back.
 *  - **Left edge otherwise kept**, matching `resize`, which anchors the left
 *    edge on a box change. (A scale change can keep the right edge instead,
 *    2026-11-14, but this never crosses scales: `rest` is at the current one.)
 */
export function restingRect(rect: Rect, current: OverlayMetrics, rest: OverlayMetrics): Rect {
  return {
    x: rect.x + current.bubbleExtra,
    y: rect.y + rect.height - rest.height,
    width: rest.width,
    height: rest.height
  };
}

/**
 * Top-left of the sprite inside a view of `viewWidth` x `viewHeight`: bottom
 * aligned, horizontally centred. Unit-agnostic — the view and `scale` just have
 * to be in the same pixels. The renderer calls it in **device** pixels, with the
 * whole number of device pixels per sprite pixel the bitmap is drawn at
 * (`spriteLayout`), which is what makes the bottom alignment exact.
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

/**
 * A CSS length in whole device pixels, never 0: `max(1, round(css * dpr))`.
 *
 * The overlay's canvas backing store is sized with exactly this, and
 * `spriteLayout` measures the view with it too, so "the window's floor" is the
 * canvas's last device row in both — one formula, or the dog's feet and the
 * bottom of the canvas could disagree by a device pixel.
 */
export function deviceExtent(css: number, dpr: number): number {
  return Math.max(1, Math.round(css * usableDpr(dpr)));
}

/**
 * The room the sprite has across, for `devicePixelScale`'s cap: the standing
 * window's width at the nominal scale with no bubble widening (the stand box
 * plus `boxMetrics`'s side padding), against the stand box's width.
 *
 * The standing box, whatever box is up, so the dog is the same size standing,
 * sleeping and lying down — a cap per box would shrink him by a device pixel per
 * sprite pixel the moment he lay down in a window it happened to be tighter in.
 * The stand box is the one the window is laid out around and is the widest the
 * sheet has; every box gets the same side padding, so one no wider than the
 * stand box fits its own window whenever the stand box fits its own.
 *
 * No bubble widening, on purpose: the widening comes and goes with every bark,
 * and the dog must not change size when he speaks.
 */
export function spriteFit(scale: number, standBox: BoxSize): PixelFit {
  return { room: boxMetrics(scale, standBox, false).width, box: standBox.width };
}

/** Where and how large the sprite is drawn — see `spriteLayout`. */
export interface SpriteLayout {
  /** Whole device pixels per sprite pixel: the size the bitmap is drawn at. */
  readonly pixelScale: number;
  /** CSS pixels per sprite pixel, `pixelScale / dpr` — fractional in general. */
  readonly cssScale: number;
  /** The box's top-left in device pixels, bob included. Whole numbers. */
  readonly device: { readonly x: number; readonly y: number };
  /** The same point in CSS pixels, `device / dpr`. Fractional in general. */
  readonly css: { readonly x: number; readonly y: number };
  /**
   * The device row the speech bubble's tail rests on: the dog's *unbobbed* top,
   * but never above the top of the box at its nominal size. See `spriteLayout`.
   */
  readonly bubbleFloor: number;
}

/** Everything `spriteLayout` reads. */
export interface SpriteLayoutInput {
  /** The view (window) size in CSS pixels. */
  readonly viewWidth: number;
  readonly viewHeight: number;
  /** The box being drawn, in sprite pixels. */
  readonly box: BoxSize;
  /** The nominal CSS pixels per sprite pixel — what main sized the window for. */
  readonly scale: number;
  /** Device pixels per sprite pixel the bitmap is drawn at (`devicePixelScale`). */
  readonly pixelScale: number;
  readonly dpr: number;
  /** The pet wiggle's dip, in sprite pixels. 0 when absent. */
  readonly bob?: number;
}

/**
 * The sprite's layout inside the overlay window, from the size it is actually
 * drawn at (QA row 1.8).
 *
 * **Why this exists.** The bitmap is drawn at a whole number of device pixels
 * per sprite pixel (`devicePixelScale`), which is not `scale * dpr` whenever
 * that product is fractional — at 125 % Small it is 1 device pixel where the
 * nominal size is 1.25. Everything else (the placement, the hit test, the hover
 * rect, the decorations, the debug outline) was laid out at the nominal `scale`,
 * so the dog was drawn 20 % smaller than the box he was laid out in, from that
 * box's top-left: he floated above the window's floor and the hit test missed
 * him. Every one of those now reads this one layout.
 *
 * **The anchoring rule.** Computed in device pixels, the unit the bitmap is
 * blitted in, and converted to CSS by dividing by `dpr` (never by rounding a CSS
 * value, which is what would put a device pixel of air under his feet):
 *
 *  - **Bottom on the floor.** The box's bottom device row is the canvas's last
 *    one (`deviceExtent(viewHeight)`), at every scale and ratio — he stands on
 *    the window's bottom edge, as at 100 %. A dog smaller than nominal has more
 *    air above him; one larger than nominal reaches higher, into the bubble
 *    reserve of the standing window and, for the boxes that have no reserve
 *    (sleeping, lying), into the transparent rows above his ink —
 *    `test/geometry.test.ts` checks the shipped art's ink stays inside its
 *    window at every size and common display scale.
 *  - **Centred across**, rounded to a whole device pixel, exactly as before. A
 *    larger dog uses some of the side padding; `spriteFit` keeps it from using
 *    more than there is.
 *  - **The bob** moves the box down `bob` whole sprite pixels, so the wiggle
 *    stays on the dog's pixel grid.
 *
 * **The bubble floor** is the unbobbed top of the drawn box, except that it
 * never rises above the nominal box's top. When the dog is drawn smaller, the
 * bubble comes down to him, so its tail still touches his head. When he is drawn
 * larger, it stays where main budgeted it: the window's reserve is sized for two
 * lines of text above a nominal dog (`bubbleReservePx`), and following the taller
 * box up would leave no room for even one line at 125 % Medium (+20 %) or 150 %
 * Large (+11 %) — the bubble would silently not draw. The price is that at those
 * sizes the bottom of the bubble can sit over the top of his head while he
 * speaks — at worst the top 8 sprite pixels of the tallest coat's ears, at 125 %
 * Medium and 250 % Small — which is a bubble doing what bubbles do rather than a
 * message that never appears. The real cure for both is a window sized from the
 * drawn scale, which is main's decision (`metricsFor`) and not this function's.
 */
export function spriteLayout(input: SpriteLayoutInput): SpriteLayout {
  const { box, scale, pixelScale } = input;
  const ratio = usableDpr(input.dpr);
  const bob = input.bob ?? 0;
  const origin = spriteOrigin(
    deviceExtent(input.viewWidth, ratio),
    deviceExtent(input.viewHeight, ratio),
    box.width,
    box.height,
    pixelScale
  );
  const device = { x: origin.x, y: origin.y + bob * pixelScale };
  const nominalTop = Math.floor((input.viewHeight - box.height * scale) * ratio);
  return {
    pixelScale,
    cssScale: pixelScale / ratio,
    device,
    css: { x: device.x / ratio, y: device.y / ratio },
    bubbleFloor: Math.max(origin.y, nominalTop)
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

/**
 * The overlay's interaction state machines, as pure functions.
 *
 * Two things in the renderer used to be tangled up with DOM events and could
 * only be checked by hand in a running app, yet both are exactly the kind of
 * logic that breaks quietly:
 *
 *  - **Hover / click-through.** The window is click-through by default and only
 *    accepts clicks where the dog has ink. Main flips that window flag, which is
 *    expensive, so the renderer must report *crossings* and not every mouse
 *    move — and must stay silent mid-drag, because the window slides under a
 *    stationary cursor and "no longer on ink" is then expected rather than a
 *    reason to drop the drag.
 *  - **Dragging.** A press-and-release on the dog is a pet; a press, a move and
 *    a release is a drag. The distinction is a distance threshold, measured
 *    straight-line from where the press landed, and the delta handed to main is
 *    cumulative (not incremental) so a dropped message cannot make the window
 *    drift away from the cursor.
 *
 * Everything here is DOM-free and side-effect-free: state in, new state plus a
 * decision out. `src/renderer/overlay.ts` is the only caller and holds the two
 * state values; the tests drive the same functions without an Electron window.
 */
import { CLICK_SLOP_PX } from '../main/ipc';
import type { Rect } from './geometry';

/* ------------------------------------------------------------------- hover */

export interface HoverState {
  /** Last reported verdict: is the cursor on ink, as far as main knows? */
  readonly inside: boolean;
  /** Cursor position in CSS pixels, or `null` when it is outside the window. */
  readonly at: { readonly x: number; readonly y: number } | null;
}

/** The next hover state, and whether main has to be told about it. */
export interface HoverDecision {
  readonly state: HoverState;
  readonly notify: boolean;
}

/** Answers "is this CSS-pixel point on the dog's ink right now?". */
export type InkProbe = (x: number, y: number) => boolean;

export const HOVER_INITIAL: HoverState = { inside: false, at: null };

function decide(state: HoverState, inside: boolean, at: HoverState['at']): HoverDecision {
  return { state: { inside, at }, notify: inside !== state.inside };
}

/**
 * The cursor moved to (x, y).
 *
 * Mid-drag the position is still recorded — the drag needs it when it ends — but
 * no verdict is derived and nothing is sent: the window is moving under the
 * cursor, so the ink test is meaningless until it stops.
 */
export function hoverMove(
  state: HoverState,
  x: number,
  y: number,
  dragging: boolean,
  onInk: InkProbe
): HoverDecision {
  const at = { x, y };
  if (dragging) return { state: { inside: state.inside, at }, notify: false };
  return decide(state, onInk(x, y), at);
}

/**
 * The cursor left the window. Forget the position, and stop holding clicks
 * hostage — unless a drag is in flight, which owns the pointer via capture and
 * legitimately continues outside the window.
 */
export function hoverLeave(state: HoverState, dragging: boolean): HoverDecision {
  if (dragging) return { state: { inside: state.inside, at: null }, notify: false };
  return decide(state, false, null);
}

/**
 * The sprite changed under a stationary cursor (new animation frame, a resize, a
 * size change), so the same point may now be on ink or off it. Re-derive, and
 * report only if the answer moved.
 */
export function hoverRetest(
  state: HoverState,
  dragging: boolean,
  onInk: InkProbe
): HoverDecision {
  if (dragging || state.at === null) return { state, notify: false };
  return decide(state, onInk(state.at.x, state.at.y), state.at);
}

/**
 * Main changed the click-through flag itself (the force-interactive hatch), so
 * its copy of the answer and ours have diverged. Re-derive and report
 * *unconditionally* — this is the one case where "unchanged" still has to be
 * sent, or the window would stay wrong until the cursor next crossed the
 * outline.
 */
export function hoverResync(state: HoverState, onInk: InkProbe): HoverDecision {
  const inside = state.at !== null && onInk(state.at.x, state.at.y);
  return { state: { inside, at: state.at }, notify: true };
}

/**
 * Where the cursor is inside a window, as main reads it off the screen: the
 * point in the window's client coordinates, and the client size that point
 * belongs to. Main -> renderer, on `CH.hoverCursor`.
 *
 * **Why main has to send this at all (0.2.8 QA, row 5.9h).** The renderer only
 * learns where the cursor is from pointer events, in *client* coordinates, and
 * caches the last one (`HoverState.at`). A bubble widens the window
 * symmetrically, so its left edge moves under a cursor that does not move — and
 * no pointer event says so. The cached point is then stale by exactly the shift:
 * at Small a pet that clears a bark shrinks the window 166 -> 88 and moves its
 * left edge 39 px right, the retest after the resize probes 39 px to the right
 * of the real cursor, lands off the ink, and the hover card comes down for as
 * long as the hand stays still (45 s observed; a 1 px move brings it straight
 * back). Only main knows both halves — the cursor's screen position and the
 * window's new bounds — so main converts and the renderer re-tests the fresh
 * point (`hoverMove`) instead of the stale one (`hoverRetest`).
 *
 * `width`/`height` ride along because the renderer's ink probe lays the sprite
 * out from `window.innerWidth`/`innerHeight`: the point is only meaningful once
 * the renderer's viewport is that size, and the renderer holds it until then.
 */
export interface HoverCursorPayload {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The cursor's screen position in the client coordinates of a window at
 * `bounds`. A plain subtraction: Electron hands both values over in the same
 * unit (points on macOS, DIPs on Windows), and the overlay never zooms, so one
 * of them is one CSS pixel. The device pixel ratio does not enter into it —
 * that is the renderer's concern when it maps CSS pixels onto the canvas.
 */
export function cursorInWindow(
  cursor: { readonly x: number; readonly y: number },
  bounds: Rect
): HoverCursorPayload {
  return {
    x: cursor.x - bounds.x,
    y: cursor.y - bounds.y,
    width: bounds.width,
    height: bounds.height
  };
}

/**
 * Is the cursor of `reading` outside the window it was measured against?
 *
 * **What it is for (Windows QA, the stuck card).** While the cursor is on ink
 * the overlay is interactive, so the renderer only hears that the cursor has
 * gone from `mouseleave`/`pointerleave` — and on Windows Chromium's leave
 * tracking (`TrackMouseEvent`) is armed by a mouse move *inside* the window.
 * A cursor that exits without one (straight after a drag released its pointer
 * capture, or across an edge his ink touches) produces no leave at all, and the
 * card stayed up for over a minute with the cursor far away. So main polls the
 * cursor while the card is wanted (`hover-panel.ts`) and asks this.
 *
 * And the renderer asks it of the same reading, because an off-window point
 * needs none of the layout the exact-size hold in `applyPendingCursor` waits
 * for: outside the window is off the ink whatever the sprite looks like, so it
 * is a leave, applied at once. Waiting would be wrong here, not just slow — at
 * a fractional Windows scale factor `innerWidth` can differ from the DIP bounds
 * by one (`SAME_WINDOW_SLACK_PX`), and a reading held for a size the viewport
 * never takes is a card that never comes down.
 *
 * Half-open, like every client rect: `x === width` is the first pixel past the
 * right edge.
 */
export function cursorOffWindow(reading: HoverCursorPayload): boolean {
  return reading.x < 0 || reading.y < 0 || reading.x >= reading.width || reading.y >= reading.height;
}

/**
 * How far the renderer's viewport may differ from the window's bounds, per axis
 * in points, and still be the same window state.
 *
 * Not zero, unlike `applyPendingCursor`'s exact match, because the failure modes
 * are not alike: a cursor that is held there is only a fix not applied, while a
 * rect dropped here is a card that never appears. On Windows at a fractional
 * scale factor the DIP bounds and Chromium's `innerWidth` can be rounded from
 * the same pixel rect in different directions, one apart. A real resize is tens
 * of points (a bark widens the window by 78 at Small), so one point cannot
 * mistake one window state for another.
 */
export const SAME_WINDOW_SLACK_PX = 1;

/**
 * The dog's ink rect, measured by the renderer in the client coordinates of a
 * `viewport`-sized window, in screen coordinates for a window at `bounds` — or
 * `null` when the two are not the same window state. The inverse of
 * `cursorInWindow`, and the hover card's anchor.
 *
 * **Why main converts, not the renderer (0.2.8 QA, row 5.9h).** The renderer
 * used to add `window.screenX`/`screenY` itself, and in Chromium those lag a
 * resize: a bark widened the window symmetrically and, for 63–100 ms, the rect
 * was the new layout against the old left edge, so the card jumped sideways by
 * the whole widening and snapped back. `bounds` comes from `getBounds()`, which
 * is current the moment `setBounds` returns.
 *
 * **Why the size check.** Converting from the current bounds is only right if
 * the rect was measured in the current window. A resize that lands after the
 * renderer measured (between send and receive, or before its `resize` event)
 * would put the old layout against the new position: the same jump, from the
 * other side. The viewport size is what the renderer laid the sprite out from,
 * so a mismatch means "measured in another window"; the caller drops it and the
 * renderer re-sends once its viewport catches up (`syncPanel` keys on it).
 */
export function inkRectOnScreen(
  rect: Rect,
  viewport: { readonly width: number; readonly height: number },
  bounds: Rect
): Rect | null {
  if (
    Math.abs(viewport.width - bounds.width) > SAME_WINDOW_SLACK_PX ||
    Math.abs(viewport.height - bounds.height) > SAME_WINDOW_SLACK_PX
  ) {
    return null;
  }
  return { x: bounds.x + rect.x, y: bounds.y + rect.y, width: rect.width, height: rect.height };
}

/**
 * Validated on the renderer side, like `parseBarkSoundPayload`: main is not an
 * attacker, but a `NaN` here would sit in `HoverState.at` and answer "off ink"
 * to every retest until the cursor next moved. A point outside the window is
 * valid — the window can shrink out from under the cursor — and `onInk` simply
 * answers no for it.
 */
export function parseHoverCursorPayload(raw: unknown): HoverCursorPayload | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { x, y, width, height } = raw as Record<string, unknown>;
  const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/* -------------------------------------------------------------------- drag */

export interface DragState {
  /** Where the press landed, in screen pixels. The delta origin. */
  readonly startX: number;
  readonly startY: number;
  /** Greatest straight-line distance from the press so far, in screen pixels. */
  readonly moved: number;
  readonly pointerId: number;
}

/** Cumulative delta to send to main, plus the updated drag state. */
export interface DragDelta {
  readonly state: DragState;
  readonly dxScreen: number;
  readonly dyScreen: number;
}

export function dragBegin(screenX: number, screenY: number, pointerId: number): DragState {
  return { startX: screenX, startY: screenY, moved: 0, pointerId };
}

/**
 * The pointer is now at (screenX, screenY).
 *
 * The delta is measured from the press, not from the previous move, so it is
 * idempotent: a dropped or reordered `drag:move` cannot accumulate error and
 * leave the window offset from the cursor for the rest of the drag.
 *
 * `moved` keeps the *maximum* distance reached, and it is straight-line
 * (Euclidean): Manhattan distance would count a 2x2 px hand tremor as 4 and
 * swallow the pet.
 */
export function dragTo(state: DragState, screenX: number, screenY: number): DragDelta {
  const dxScreen = screenX - state.startX;
  const dyScreen = screenY - state.startY;
  const moved = Math.max(state.moved, Math.hypot(dxScreen, dyScreen));
  return { state: { ...state, moved }, dxScreen, dyScreen };
}

/**
 * Was this press-and-release a click (a pet) rather than a drag?
 *
 * Strictly below the threshold: 3.99 px is a pet, 4.0 px is a drag. The boundary
 * is pinned by a test because it is the difference between "the dog ignores my
 * click" and "the dog jumps when I try to pet it".
 */
export function isClick(state: DragState): boolean {
  return state.moved < CLICK_SLOP_PX;
}

/** The primary (left) button's bit in `PointerEvent.buttons`. */
export const PRIMARY_BUTTON = 1;

/**
 * Has the press that started this drag already been let go of, unheard?
 *
 * **The lost mouse-up (0.2.8 QA).** Three times in the loop a click logged
 * `drag start` with no `drag end` and no `pet`: the release never reached the
 * renderer — it can land while the window is being moved under the cursor, or
 * go to whatever took the pointer from us — and the drag state machine has no
 * other way out. From there every move was a drag move, so the dog followed
 * the bare cursor around the screen and ignored clicks until another full
 * press-and-release happened to end it.
 *
 * Every pointer move carries the buttons that are down *now*, so the first move
 * after a lost release says so: the primary bit is clear while we still think
 * it is held. That is a drag end, and never a pet — nobody saw the release, so
 * there is no click to count, and a pet that fired on the next mouse move
 * would be a dog reacting to nothing. `CLICK_SLOP_PX` decides pets only for a
 * release that was actually heard.
 */
export function dragShouldEnd(buttons: number, dragging: boolean): boolean {
  return dragging && (buttons & PRIMARY_BUTTON) === 0;
}

/**
 * Where the window wants to be, given the rect it had when the drag started and
 * the cumulative cursor delta. The caller clamps this against the live work
 * areas (`clampRectToWorkAreas`) before moving anything — dragging the dog off
 * the edge of the world must not be possible.
 */
export function dragTargetRect(origin: Rect, dxScreen: number, dyScreen: number): Rect {
  return {
    x: origin.x + dxScreen,
    y: origin.y + dyScreen,
    width: origin.width,
    height: origin.height
  };
}

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

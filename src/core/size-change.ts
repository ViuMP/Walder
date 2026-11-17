/**
 * The size-change handshake: how a tray Size pick resizes the overlay window
 * on Windows without a frame of the old-size dog in the wrong place.
 *
 * **The defect (Windows QA row 3.3).** A Size change resizes the window in
 * main (`setBounds`) and the renderer follows a few frames later: it hears the
 * new scale on `mode:set`, the new viewport on its `resize` event, and
 * repaints. In between, Windows composites the last surface the renderer
 * presented — the old-size dog, unscaled — against the top-left of the window
 * that has already moved and grown: 76–78 px too high, and 88 px to the left
 * on the right half of the screen. No order of operations in main closes that:
 * on a grow the window has to be large before a large dog can be drawn in it.
 *
 * **What was tried first, and what was measured (2026-11-16).** The fix of
 * 2026-11-15 made the window fully transparent (`setOpacity(0)`) before
 * `setBounds` and opaque again when the renderer reported a paint at the new
 * scale and viewport. Measured on screen, on the owner's PC:
 *  - at 100 %, on 7 of 8 grows one or two frames still showed the old-size dog
 *    displaced, 20–30 ms *after* the window had been made opaque again. Shrinks
 *    were clean. So a paint at the new size, plus two frames, is not enough:
 *    the compositor can present a stale old-size surface once more.
 *  - at 125 %, on many changes the renderer's report never arrived and the
 *    window stayed blank for the whole 300 ms fallback. Why was not
 *    established. The guess — unproven — is that the viewport Chromium reports
 *    differs from the DIP size main sent ahead by more than the one point of
 *    slack the match allowed (Large asks for 264 × 274, which is 330 × 342.5
 *    physical; the window observed was 330 × 344).
 *
 * **This design: make the stale surface harmless instead of racing it.** The
 * renderer blanks its own picture *before* main resizes. Whatever old surface
 * Windows then shows has no dog in it, and main never makes the window
 * invisible at all. In order:
 *  1. main asks for a blank picture (`{ phase: 'blank', id }`) and resizes
 *     nothing;
 *  2. the renderer paints nothing for `SIZE_BLANK_PAINTS` consecutive frames
 *     and reports `{ phase: 'blank', id }`;
 *  3. main resizes — or resizes anyway after `SIZE_BLANK_GRACE_MS` — and sends
 *     `{ phase: 'resized', id, scale, from, to }`, then `mode:set`;
 *  4. the renderer keeps painting nothing until a paint is at the new scale
 *     *and* in the new viewport (`paintedAtSize`), draws him in that paint and
 *     reports `{ phase: 'shown', … }`; or draws him regardless once
 *     `SIZE_BLANK_MAX_MS` have passed since step 1;
 *  5. until that report is in, main sends `resized` again, with the same id
 *     and `from` and a new `to`, after any other resize it makes (below).
 *
 * None of this has been seen on screen yet. That three blank paints leave no
 * surface with a dog in it for Windows to re-present is the assumption the
 * design rests on, and it is reckoned, not measured.
 *
 * **Why the match needs no exact size.** `from` and `to` are both what
 * `win.getBounds()` answered, immediately before and immediately after the
 * resize: what Windows granted, in one rounding, with nothing sent ahead. And
 * the renderer never compares its viewport with either for equality. It only
 * asks which of the two the viewport is *nearer* (`nearer`), and for the size
 * change's own resize the two are a whole size step apart — tens of points on
 * both axes — so a point or two of rounding at 125 % or 150 % cannot move a
 * viewport from one side to the other. The 125 % guess above may be right or
 * wrong; the rule does not depend on it.
 *
 * **A resize that is not the size change's own.** The window is also resized
 * for a bubble (up to 120 points a side) and for a box change, by calls that
 * know nothing of a size change, and one can land in the few frames between
 * main's resize and the renderer's matching paint: a bark, a bubble running
 * out, him curling up. `to` is then no longer the window's size, and the
 * viewport the renderer ends up in can be nearer `from` — after
 * Large → Small (264 → 88 wide) a 30-column bark makes the window 240 wide.
 * As first written the rule had no answer to that and he, and the bubble that
 * had just barked, stayed blank until `SIZE_BLANK_MAX_MS` (review of
 * 2026-11-16). So main remembers the change it has sent `resized` for until
 * its `shown` report comes back (`SettlingSize`), and after every other
 * resize in between sends `resized` again: the same id, the same `from`, and
 * as `to` the size the window has now (`resizedMessage`). The renderer
 * replaces its target with it (`onSizeMessage`).
 *
 * `from` stays the size from before the size change, and is never the size
 * between two resizes, because it is the one viewport that must not match:
 * the picture from before the scale changed. A viewport at the *intermediate*
 * size may match or not, whichever it is nearer; if it does he is drawn at
 * the new scale one resize behind the window, which is what every bubble
 * change looks like with no size change near it.
 *
 * With a follow-up, though, `to` need not be a size step from `from` on both
 * axes any more: a Small window with a 33-column bubble is 262 wide and a
 * Large one without is 264. An axis like that says nothing, and must not be
 * allowed to say "old" because the viewport was rounded a point the wrong
 * way. So `nearer` gives every axis `SIZE_VIEW_SLACK` points: a viewport
 * within that of `to` on an axis is at `to` on it, wherever `from` is, and the
 * other axis decides. For a dog who is standing before and after, the height
 * always can: a scale change moves it by a size step (120, 198, 274 on the
 * 72 px box), which no bubble touches, and from it the old viewport is still
 * told apart.
 *
 * A box change as well can bring *both* axes close: Small, standing, with an
 * 18-column bubble is 150 × 120, and Medium, asleep, is 154 × 116 — four
 * points on each axis, the nearest any two windows at different scales come
 * on the 72 × 72 and 61 × 58 boxes. Then a viewport a point off the old one
 * can pass. It is also, to those few points, the size the window has, so a
 * paint at the new scale in it is the right picture to within them; the
 * half-updated paint this rule exists to stop is a size step out.
 *
 * **Why the half-updated paints cannot open it.** The scale and the viewport
 * reach the renderer on separate channels, in no promised order, and it
 * paints between them:
 *  - *new viewport, old scale* (the `resize` event won): the scale is not the
 *    target's — and before `resized` arrives there is no target at all;
 *  - *new scale, old viewport* (`mode:set` won): the viewport is still at
 *    `from`, a size step from `to`, so it is nearer `from` on both axes — or,
 *    after a follow-up, on at least the one that is still a size step out. The
 *    new scale cannot arrive early either: main sends `resized` and then
 *    `mode:set` on the same pipe, and any `mode:set` sent before the resize
 *    carries the old scale, because main's own scale does not change until
 *    the resize does;
 *  - *old scale, old viewport*: both fail;
 *  - *a message of another id*: ignored (`onSizeMessage`).
 *
 * Both axes must be nearer `to`, not either: if one axis happened to be the
 * same before and after — or within the slack of it, after a follow-up — an
 * "either" would pass on the old viewport.
 *
 * Pure, like everything in `core/`: the renderer cannot be unit-tested and
 * main's wiring is thin, so every decision — is this the paint, when to
 * acknowledge, when to give up, whether to defer at all — lives here, where
 * it can be.
 */

/**
 * How many consecutive blank paints, one per frame, before the renderer tells
 * main the blank picture is up.
 *
 * The report is sent from inside the last of them, which has not been handed
 * to the compositor yet. What that is *meant* to give, with three, is two
 * blank frames committed and a third in flight when main resizes. More than
 * one because the 2026-11-16 measurement was of a stale surface shown *after*
 * a newer one had been painted and given two frames — one blank frame may
 * well leave an older buffer with a dog in it.
 *
 * **Whether paints two and three commit anything is not known.** Only the
 * first changes the picture. The later ones are a `clearRect` over a canvas
 * that is already clear and the same size (`resizeCanvas` reassigns the
 * canvas's size only when the viewport changed), and Chromium may well submit
 * no compositor frame for a paint that changed nothing. If so they are not
 * blank frames at all, only two frames of waiting between the first blank
 * paint and the report — which may be all that is needed, or not. Nothing
 * here has been measured on screen.
 *
 * So three is reckoned, and it is the knob to turn first if an on-screen run
 * still shows him displaced — with that caveat: a higher count certainly
 * costs a frame of blank each, and may add only that delay and no blank
 * frame. If raising it does not help, the paints have to be made to damage
 * the canvas, not counted higher.
 */
export const SIZE_BLANK_PAINTS = 3;

/**
 * How long main waits for the renderer to say the blank picture is up before
 * it resizes anyway.
 *
 * A healthy answer is the message across, three frames and the report back:
 * reckoned at about 50 ms on a 60 Hz panel and about 110 ms at 30 Hz. 200 ms
 * is clear of both, and short enough that a renderer which cannot answer
 * (dead, reloading, stuck) costs a Size pick a fifth of a second and not the
 * pick itself. When it runs out the window is resized under whatever picture
 * is up — the displaced frame of before 2026-11-15, never a size change that
 * did not happen.
 */
export const SIZE_BLANK_GRACE_MS = 200;

/**
 * The longest the renderer paints nothing for one size change, measured from
 * the `blank` message.
 *
 * The renderer's own ceiling, independent of main: if the `resized` message is
 * lost, or no paint ever matches it, he is drawn again at this point whatever
 * the window looks like — at worst displaced for a frame, never invisible
 * with nothing on screen to click. It is not restarted by `resized`, so it is
 * a strict bound on one change; only a `blank` with a newer id, which is a new
 * pick from the menu, starts another. It must outlast main's whole wait plus
 * the frames the renderer needs to follow a resize, or a slow acknowledgement
 * would have him drawn before the window is resized: a test pins it at
 * `SIZE_BLANK_GRACE_MS` + 250 or more.
 */
export const SIZE_BLANK_MAX_MS = 500;

/** A window or viewport size. Points / CSS px. */
export interface ViewSize {
  readonly width: number;
  readonly height: number;
}

/** Main -> renderer, on `size:change`. */
export type SizeChangeMessage =
  | {
      /** Paint nothing from now on, and say when that is on screen. */
      readonly phase: 'blank';
      /** Which size change this is: a positive integer, larger for each new one. */
      readonly id: number;
    }
  | {
      /** The window has been resized: this is what to wait for before drawing him. */
      readonly phase: 'resized';
      readonly id: number;
      /** The scale the `mode:set` that follows carries. */
      readonly scale: number;
      /** The window's size as read just before the resize… */
      readonly from: ViewSize;
      /** …and just after it: what was granted, not what was asked for. */
      readonly to: ViewSize;
    };

/** Renderer -> main, on `size:report`. */
export type SizeReport =
  | {
      /** `SIZE_BLANK_PAINTS` blank frames have been painted for change `id`. */
      readonly phase: 'blank';
      readonly id: number;
    }
  | {
      /** He is drawn again. Main only logs this. */
      readonly phase: 'shown';
      readonly id: number;
      /** A paint matched (`true`), or `SIZE_BLANK_MAX_MS` ran out (`false`). */
      readonly matched: boolean;
      /** The viewport he was drawn in. */
      readonly width: number;
      readonly height: number;
    };

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

const isPositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const isId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function parseViewSize(raw: unknown): ViewSize | null {
  if (!isRecord(raw)) return null;
  const { width, height } = raw;
  if (!isPositive(width) || !isPositive(height)) return null;
  return { width, height };
}

/**
 * Validate a `size:change` message. Main is not an attacker, but the renderer
 * validates every cross-process value, and a junk target would be one no
 * paint ever matches. `null` for anything malformed; unknown fields dropped.
 */
export function parseSizeChangeMessage(raw: unknown): SizeChangeMessage | null {
  if (!isRecord(raw) || !isId(raw['id'])) return null;
  const id = raw['id'];
  if (raw['phase'] === 'blank') return { phase: 'blank', id };
  if (raw['phase'] !== 'resized') return null;
  const scale = raw['scale'];
  const from = parseViewSize(raw['from']);
  const to = parseViewSize(raw['to']);
  if (!isPositive(scale) || from === null || to === null) return null;
  return { phase: 'resized', id, scale, from, to };
}

/**
 * Validate a `size:report`. This one crosses from the renderer, which is
 * untrusted (`main/ipc.ts`): `null` for anything malformed, and main drops it.
 */
export function parseSizeReport(raw: unknown): SizeReport | null {
  if (!isRecord(raw) || !isId(raw['id'])) return null;
  const id = raw['id'];
  if (raw['phase'] === 'blank') return { phase: 'blank', id };
  if (raw['phase'] !== 'shown') return null;
  const { matched, width, height } = raw;
  if (typeof matched !== 'boolean' || !isPositive(width) || !isPositive(height)) return null;
  return { phase: 'shown', id, matched, width, height };
}

/* ------------------------------------------------------------ the match rule */

/** What a paint has to be drawn at to end the blank. */
export interface SizeTarget {
  readonly scale: number;
  readonly from: ViewSize;
  readonly to: ViewSize;
}

/**
 * How far, in points, a viewport may be from `to` on one axis and still be at
 * `to` on it whatever `from` is (`nearer`).
 *
 * Two, for the rounding at a fractional scale factor: `to` is `getBounds`, a
 * whole number of points for a window that is a whole number of *physical*
 * pixels, and the viewport is that window divided back by the factor — the
 * one case seen is 274 asked, 344 physical granted at 125 %, which is 275.2.
 * Reckoned from that one case, not measured across factors. It is needed only
 * where `from` and `to` are within a point or two of each other on an axis,
 * which only a follow-up `resized` can make them (the file header); on an
 * axis a size step apart it moves the midpoint by one point and changes
 * nothing. It must stay well under half a size step, or the old viewport
 * would pass: a test pins the rejection at the smallest step there is.
 */
export const SIZE_VIEW_SLACK = 2;

/**
 * Is `v` at least as near `to` as it is to `from`, give or take
 * `SIZE_VIEW_SLACK`?
 *
 * `<=`, so equal distances count as near — which is what makes `from === to`
 * work: Small → Large → Small picked inside one wait resizes the window to the
 * size it already has, and the next paint must end the blank rather than wait
 * out the whole ceiling for a viewport that is never going to move.
 *
 * The slack makes the same true of a `from` and a `to` that are a point or
 * two apart: anything within the slack of `to` is near it. Far from both, it
 * is neither here nor there.
 */
export function nearer(v: number, to: number, from: number): boolean {
  return Math.abs(v - to) <= Math.abs(v - from) + SIZE_VIEW_SLACK;
}

/**
 * Was a paint at `scale`, in a `viewWidth` × `viewHeight` viewport, the
 * picture `target` asks for? The scale exactly — it is one of main's three
 * and crosses unchanged — and the viewport nearer `to` than `from` on *both*
 * axes. Never with no target: before `resized` arrives nothing can match.
 * The file header has why this cannot be fooled by a half-updated paint.
 */
export function paintedAtSize(
  target: SizeTarget | null,
  scale: number,
  viewWidth: number,
  viewHeight: number
): boolean {
  return (
    target !== null &&
    scale === target.scale &&
    nearer(viewWidth, target.to.width, target.from.width) &&
    nearer(viewHeight, target.to.height, target.from.height)
  );
}

/* ------------------------------------------------------- the renderer's side */

/**
 * The renderer's state between two calls: `null` when it draws normally, or
 * the size change it is painting nothing for.
 */
export type SizeBlank = null | {
  /** The size change being blanked for. */
  readonly id: number;
  /** Blank paints made for it so far, counted up to `SIZE_BLANK_PAINTS`. */
  readonly paints: number;
  /** What ends the blank, once main has resized and said so. */
  readonly target: SizeTarget | null;
};

/** What a `size:change` message does. */
export interface SizeMessageStep {
  readonly state: SizeBlank;
  /** Arm the `SIZE_BLANK_MAX_MS` timeout for this id, replacing any other. */
  readonly armTimeoutForId: number | null;
  /** Ask for a paint: the picture has to change, or may now match. */
  readonly repaint: boolean;
}

/**
 * A `size:change` message has arrived while `state` was the state.
 *
 * `blank` starts a blank only for an id newer than the one held: a repeat or
 * an older one is a message that was overtaken, and restarting on it would
 * re-arm the ceiling for a change that is already under way. A newer one
 * replaces the state outright — the count starts again, because main is
 * waiting for *that* id's blank frames, and the old target is dropped, because
 * the window is about to be resized again.
 *
 * `resized` sets the target of the change it belongs to and nothing else. It
 * neither restarts the count nor arms a timer: the ceiling runs from the
 * `blank`. A second one for the same id — main resized the window again, for
 * a bubble or a box, before he was drawn (`resizedMessage`) — replaces the
 * target the same way, and asks for a paint, since the viewport it names may
 * be the one already painted in. One for another id, or with nothing being
 * blanked (the ceiling ran out first, or he is drawn and the follow-up
 * crossed with the report), is ignored — he is already drawn, at a
 * consistent state.
 */
export function onSizeMessage(state: SizeBlank, raw: unknown): SizeMessageStep {
  const message = parseSizeChangeMessage(raw);
  if (message === null) return { state, armTimeoutForId: null, repaint: false };
  if (message.phase === 'blank') {
    if (state !== null && message.id <= state.id) {
      return { state, armTimeoutForId: null, repaint: false };
    }
    return {
      state: { id: message.id, paints: 0, target: null },
      armTimeoutForId: message.id,
      repaint: true
    };
  }
  if (state === null || message.id !== state.id) {
    return { state, armTimeoutForId: null, repaint: false };
  }
  const { scale, from, to } = message;
  return { state: { ...state, target: { scale, from, to } }, armTimeoutForId: null, repaint: true };
}

/** What a paint does. */
export interface SizePaintStep {
  readonly state: SizeBlank;
  /** Clear the canvas and draw nothing in this paint. */
  readonly blank: boolean;
  /** Report `{ phase: 'blank', id }` to main from this paint. */
  readonly ackId: number | null;
  /** Ask for another paint on the next frame: more blank frames are owed. */
  readonly repaint: boolean;
  /** This paint drew him again: report `{ phase: 'shown', matched: true }`. */
  readonly shownId: number | null;
}

/**
 * A paint is about to be made at `scale`, in a `viewWidth` × `viewHeight`
 * viewport, while `state` was the state. Called once per paint, before the
 * canvas is drawn, so the answer decides what that paint draws.
 *
 * With a target and a matching paint the blank is over: this paint draws him.
 * Otherwise it is one more blank paint. The acknowledgement goes out on
 * exactly the step where the count first reaches `SIZE_BLANK_PAINTS` — the
 * count is capped there so it cannot be reached twice — and until then each
 * blank paint asks for the next, so the frames are consecutive whether or not
 * anything else is animating (still mode arms no timer of its own).
 */
export function onSizePaint(
  state: SizeBlank,
  scale: number,
  viewWidth: number,
  viewHeight: number
): SizePaintStep {
  if (state === null) {
    return { state: null, blank: false, ackId: null, repaint: false, shownId: null };
  }
  if (paintedAtSize(state.target, scale, viewWidth, viewHeight)) {
    return { state: null, blank: false, ackId: null, repaint: false, shownId: state.id };
  }
  const paints = Math.min(state.paints + 1, SIZE_BLANK_PAINTS);
  const reached = state.paints < SIZE_BLANK_PAINTS && paints === SIZE_BLANK_PAINTS;
  return {
    state: { ...state, paints },
    blank: true,
    ackId: reached ? state.id : null,
    repaint: paints < SIZE_BLANK_PAINTS,
    shownId: null
  };
}

/** What the `SIZE_BLANK_MAX_MS` timeout does. */
export interface SizeTimeoutStep {
  readonly state: SizeBlank;
  /** The blank it ended: report `{ phase: 'shown', matched: false }`. */
  readonly shownId: number | null;
}

/**
 * The ceiling armed for change `id` has run out. It ends the blank only if
 * that change is still the one being blanked: a timeout whose change already
 * matched, or was replaced by a newer pick with its own ceiling, does nothing.
 */
export function onSizeTimeout(state: SizeBlank, id: number): SizeTimeoutStep {
  if (state === null || state.id !== id) return { state, shownId: null };
  return { state: null, shownId: id };
}

/* ------------------------------------------------------------- main's side */

/** The size change main has asked a blank picture for and not yet made. */
export interface PendingSize {
  readonly id: number;
  /** The scale to resize to when the wait ends: the latest pick. */
  readonly scale: number;
}

/** What a Size pick does in main. */
export type SizeRequest =
  | {
      /** Resize now, synchronously, with no message: the behaviour everywhere but Windows. */
      readonly kind: 'now';
    }
  | {
      /** Ask the renderer for a blank picture and wait: `pending` is the new wait. */
      readonly kind: 'start';
      readonly pending: PendingSize;
    }
  | {
      /** A wait is already running: it now ends at this scale. */
      readonly kind: 'retarget';
      readonly pending: PendingSize;
    };

/**
 * The owner picked `nextScale` while `pending` was main's state.
 *
 * A second pick during a wait only changes where the wait ends: the same id,
 * no second message, and the caller does not restart its timer — a blank
 * picture is already being painted for this id, and restarting would let a
 * run of clicks postpone the resize for as long as they kept coming.
 *
 * With no wait running, `deferring` says whether there is anything to wait
 * for: it is false off Windows, before the window is on screen, while it is
 * hidden, and once it is destroyed. And picking the size he already has
 * resizes to the rect he is at, so there is no gap to cover.
 */
export function sizeRequest(
  pending: PendingSize | null,
  deferring: boolean,
  currentScale: number,
  nextScale: number,
  nextId: number
): SizeRequest {
  if (pending !== null) return { kind: 'retarget', pending: { id: pending.id, scale: nextScale } };
  if (!deferring || nextScale === currentScale) return { kind: 'now' };
  return { kind: 'start', pending: { id: nextId, scale: nextScale } };
}

/**
 * Is `report` the acknowledgement main is waiting for? Only a `blank` report
 * for the id pending: a late one (the timer already resized), a duplicate, one
 * for an earlier change, or a `shown` report must not resize anything.
 */
export function acceptsBlankReport(pending: PendingSize | null, report: SizeReport): boolean {
  return pending !== null && report.phase === 'blank' && report.id === pending.id;
}

/**
 * The size change main has resized the window for and sent `resized` for, and
 * has not yet heard `shown` for: the renderer may still be painting nothing
 * and comparing its viewport with the `to` it was last sent.
 */
export interface SettlingSize {
  readonly id: number;
  /**
   * The window's size just before the size change's own resize. Fixed for the
   * whole of the change: it is the viewport of the old picture, the one that
   * must never match, however many times the window is resized after it.
   */
  readonly from: ViewSize;
}

/**
 * The `resized` message for `settling`, with the window now `to` in size and
 * main's scale `scale`: the first one, straight after the size change's own
 * resize, and every follow-up after another resize while the change settles.
 * One builder, so a follow-up cannot differ from the first in anything but
 * `to` — the id and `from` are the change's, and the scale is whatever main
 * has, which is the one the next `mode:set` carries. Only the two numbers are
 * taken from `to` and `from`, which callers may hand over as whole window
 * rects.
 */
export function resizedMessage(
  settling: SettlingSize,
  scale: number,
  to: ViewSize
): Extract<SizeChangeMessage, { phase: 'resized' }> {
  return {
    phase: 'resized',
    id: settling.id,
    scale,
    from: { width: settling.from.width, height: settling.from.height },
    to: { width: to.width, height: to.height }
  };
}

/**
 * Does `report` end the settling? Only a `shown` report for the change that
 * is settling, matched or at the renderer's time limit: either way he is
 * drawn, and a `resized` sent after it would be ignored. A `shown` for an
 * earlier change — one that a newer pick replaced — and any `blank` report
 * leave it as it is.
 */
export function endsSettling(settling: SettlingSize | null, report: SizeReport): boolean {
  return settling !== null && report.phase === 'shown' && report.id === settling.id;
}

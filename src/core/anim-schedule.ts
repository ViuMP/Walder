/**
 * The animation clock, and the small amount of life on top of it.
 *
 * Everything here is pure and DOM-free, for two reasons. It is the logic that
 * decides which frame of the dog is on screen at any instant, which is exactly
 * the kind of thing that is impossible to check by eye and easy to check by
 * arithmetic. And it is used by *two* renderers — the overlay window and the
 * animation gallery (`npm run sprites`, the page the owner approves the motion
 * on) — so it has to live somewhere neither of them owns, or the gallery would be
 * approving a second implementation of the timing.
 *
 * Three separate things, in order of how much of the picture they decide:
 *
 *  1. **The frame clock** (`advanceFrames`, `nextFrameDueAt`). Given an
 *     animation's durations and the current time, which frame should be showing —
 *     and when the next one is due, so the caller can sleep exactly that long
 *     instead of waking sixty times a second to find nothing has changed.
 *  2. **Idle interjections** (`onIdleLoop`). The idle loop on its own is a
 *     four-frame breathe forever; the art also ships a `blink` and an
 *     `idle_rare` ear-flick, and this decides when to slip one in.
 *  3. **How a one-shot ends** (`resolveThen`, `playOutcome`). Whether the dog
 *     falls back to his idle loop, curls back up asleep, or *parks* on the last
 *     frame — the art itself asks for the last one with `hold: true`.
 */
import type { Animation } from '../sprites/types';

/* -------------------------------------------------------------- frame clock */

/**
 * Duration used for a frame whose own duration is somehow missing.
 *
 * `validateSheet` proves every animation has one duration per frame, so this is
 * unreachable through a validated sheet. It exists because the alternative to a
 * default is `undefined` arithmetic, which produces a `NaN` deadline and a dog
 * that freezes silently.
 */
export const DEFAULT_FRAME_MS = 600;

/**
 * How many frames one `advanceFrames` call will step through to catch up.
 *
 * A wake can be very late — a busy machine, a laptop coming out of sleep — and
 * the frame that should be showing may be several on. Catching up matters (the
 * blink must not stick), but replaying a minute of idle loop does not, so past
 * this many frames the clock resynchronises to now instead.
 */
export const MAX_CATCH_UP_FRAMES = 64;

/** Which frame of an animation is showing, and since when. */
export interface FrameClock {
  readonly index: number;
  /**
   * Timestamp (same clock as `now`) when `index` began, or `null` before the
   * animation has been given a first tick. A fresh clock starts `null` so that
   * the first paint after a switch does not immediately consume a frame's worth
   * of a duration that had not started yet.
   */
  readonly startedAt: number | null;
  /**
   * A non-looping animation has run out and is parked on `index`.
   *
   * Explicit state rather than "index is the last one", so that finishing is
   * reported exactly once. Without it, every later repaint — a mouse move, a
   * resize — would re-derive "the last frame's duration has elapsed" and report
   * the animation as finishing again, and each of those would release a held
   * pose or fire a queued follow-up a second time.
   */
  readonly done: boolean;
}

/** A clock for an animation that is about to start. */
export const FRESH_CLOCK: FrameClock = { index: 0, startedAt: null, done: false };

/** The timing half of an `Animation` — all `advanceFrames` needs. */
export interface FrameTiming {
  readonly durationsMs: readonly number[];
  readonly frameCount: number;
  readonly loop: boolean;
}

/** Read the timing out of a sheet animation. */
export function timingOf(animation: Animation): FrameTiming {
  return {
    durationsMs: animation.durationsMs,
    frameCount: animation.frames.length,
    loop: animation.loop
  };
}

export interface FrameStep {
  readonly clock: FrameClock;
  /** The frame index moved, so the picture must be repainted. */
  readonly changed: boolean;
  /**
   * A non-looping animation reached its last frame and parked there. Reported
   * once: stepping a clock that is already parked reports `false`.
   */
  readonly finished: boolean;
  /** A looping animation completed a lap and is back on frame 0. */
  readonly wrapped: boolean;
}

function durationAt(timing: FrameTiming, index: number): number {
  const ms = timing.durationsMs[index];
  return ms === undefined || !Number.isFinite(ms) || ms <= 0 ? DEFAULT_FRAME_MS : ms;
}

/**
 * Advance `clock` to `now`.
 *
 * Steps as many frames as are due rather than one per call, so a late wake lands
 * on the frame that should be showing rather than running the whole animation in
 * slow motion. A one-shot that runs out parks on its last frame and reports
 * `finished`; a loop reports `wrapped` each time it passes frame 0, which is what
 * `onIdleLoop` counts.
 */
export function advanceFrames(clock: FrameClock, timing: FrameTiming, now: number): FrameStep {
  const still = { clock, changed: false, finished: false, wrapped: false };
  if (timing.frameCount <= 0) return still;
  // Parked. Nothing moves until a new animation is started.
  if (clock.done) return still;

  // First tick: start the stopwatch, do not consume a frame.
  if (clock.startedAt === null) {
    return {
      clock: {
        index: Math.min(Math.max(0, clock.index), timing.frameCount - 1),
        startedAt: now,
        done: false
      },
      changed: false,
      finished: false,
      wrapped: false
    };
  }

  let index = Math.min(Math.max(0, clock.index), timing.frameCount - 1);
  let startedAt = clock.startedAt;
  let changed = false;
  let finished = false;
  let wrapped = false;

  for (let guard = 0; guard < MAX_CATCH_UP_FRAMES; guard++) {
    const duration = durationAt(timing, index);
    if (now - startedAt < duration) break;

    const next = index + 1;
    if (next >= timing.frameCount && !timing.loop) {
      // Out of frames: park on the one showing. The picture does not change —
      // the last frame simply stays — so `changed` is left alone.
      finished = true;
      startedAt = now;
      return { clock: { index, startedAt, done: true }, changed, finished, wrapped };
    }

    startedAt += duration;
    index = next >= timing.frameCount ? 0 : next;
    if (index === 0) wrapped = true;
    changed = true;
  }

  // Reached only when the guard ran out, i.e. we are still hopelessly behind
  // after `MAX_CATCH_UP_FRAMES`. Comparing against the *current* frame's own
  // duration matters: a flat "more than a second late" test would also fire on a
  // paint triggered halfway through a long frame and silently stretch it.
  if (now - startedAt >= durationAt(timing, index)) startedAt = now;

  return { clock: { index, startedAt, done: false }, changed, finished, wrapped };
}

/**
 * When the picture can next change on its own, or `null` for "not until
 * something happens" — the state a finished one-shot sits in, at zero wakeups.
 */
export function nextFrameDueAt(clock: FrameClock, timing: FrameTiming): number | null {
  if (clock.startedAt === null || clock.done || timing.frameCount <= 0) return null;
  return clock.startedAt + durationAt(timing, clock.index);
}

/* ------------------------------------------------------- idle interjections */

/** The rare ear-flick, played once in a while instead of a plain idle lap. */
export const IDLE_RARE = 'idle_rare';

/** The two-frame blink, slipped between idle laps. */
export const BLINK = 'blink';

/** `idle_rare` plays after this many completed idle laps. */
export const RARE_EVERY_IDLE_LOOPS = 4;

/** A blink becomes due somewhere in this window after the last one. */
export const BLINK_MIN_MS = 3_000;
export const BLINK_MAX_MS = 5_000;

/**
 * Base loops an interjection may be slipped into.
 *
 * Only the neutral idles. `blink` and `idle_rare` are drawn from the master
 * pose, so playing one over the worried or exhausted idle would flash a neutral
 * face for a fifth of a second — the dog would look like he had stopped being
 * worried and started again. The sleeping loop is excluded for the same reason:
 * a curled dog has no ears to flick.
 */
export const INTERJECTABLE_LOOPS: readonly string[] = ['idle', 'idle_neutral'];

/** May a blink or an ear-flick be slipped into this base loop? */
export function canInterject(baseAnimation: string): boolean {
  return INTERJECTABLE_LOOPS.includes(baseAnimation);
}

/** What the loaded sheet actually offers. Both are optional art. */
export interface IdleExtras {
  readonly hasRare: boolean;
  readonly hasBlink: boolean;
}

/** Read the extras out of a sheet by name. */
export function idleExtras(has: (name: string) => boolean): IdleExtras {
  return { hasRare: has(IDLE_RARE), hasBlink: has(BLINK) };
}

export interface IdleState {
  /** Completed idle laps since the last `idle_rare`. */
  readonly loopsSinceRare: number;
  /**
   * Earliest time a blink may be inserted, or `null` when the sheet has no
   * blink. Absolute, not a countdown, so a laptop that slept for an hour blinks
   * once on the way back rather than working through an hour of backlog.
   */
  readonly blinkDueAt: number | null;
}

/** Uniform millisecond count in `[BLINK_MIN_MS, BLINK_MAX_MS]`. */
function blinkGap(random: () => number): number {
  const r = random();
  const clamped = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0.5;
  return Math.round(BLINK_MIN_MS + clamped * (BLINK_MAX_MS - BLINK_MIN_MS));
}

/** A fresh idle state: no laps yet, first blink 3–5 s out. */
export function initIdle(
  extras: IdleExtras,
  now: number,
  random: () => number = Math.random
): IdleState {
  return {
    loopsSinceRare: 0,
    blinkDueAt: extras.hasBlink ? now + blinkGap(random) : null
  };
}

export interface IdleDecision {
  readonly state: IdleState;
  /** The animation to play once, or `null` to just keep breathing. */
  readonly play: string | null;
}

/**
 * The base idle loop just completed a lap. Slip something in, or not.
 *
 * `idle_rare` wins over a due blink, and does *not* reset the blink timer — the
 * ear-flick already has two motion ticks of its own, and the blink then lands on
 * one of the next laps, which reads as two unrelated bits of life rather than a
 * single scripted routine. The blink timer is only re-armed when a blink is
 * actually played, so a stretch spent worried (where nothing is interjected)
 * leaves a blink due the moment he is neutral again.
 */
export function onIdleLoop(
  state: IdleState,
  extras: IdleExtras,
  now: number,
  random: () => number = Math.random
): IdleDecision {
  const loops = state.loopsSinceRare + 1;

  if (extras.hasRare && loops >= RARE_EVERY_IDLE_LOOPS) {
    return { state: { ...state, loopsSinceRare: 0 }, play: IDLE_RARE };
  }

  const advanced: IdleState = { ...state, loopsSinceRare: loops };

  if (extras.hasBlink && state.blinkDueAt !== null && now >= state.blinkDueAt) {
    return {
      state: { ...advanced, blinkDueAt: now + blinkGap(random) },
      play: BLINK
    };
  }

  return { state: advanced, play: null };
}

/* --------------------------------------------------------- how a play ends */

/**
 * Where the dog is left when a one-shot finishes.
 *
 * `idle` and `sleep` both mean "back to the loop for the box you are in"; which
 * one is sent says what the behaviour coordinator believes the box to be.
 * `hold` parks on the last frame. Mirrors `PlayThen` in `core/behaviour.ts`,
 * which is where the coordinator's side of the vocabulary lives; kept as its own
 * type here so this module does not depend on the coordinator.
 */
export type ThenWhat = 'idle' | 'hold' | 'sleep';

/**
 * Reconcile what the caller asked for with what the art says.
 *
 * The sheet's `hold` flag wins, because it is a property of the *drawing*: the
 * last frame of `perk` is ears-up and the last frame of `tilt` is head-cocked,
 * and snapping out of either the instant the frames run out would undo the
 * gesture while the speech bubble that goes with it is still on screen. The
 * coordinator does not have to know which animations are like that.
 */
export function resolveThen(requested: ThenWhat, sheetHold: boolean): ThenWhat {
  return sheetHold ? 'hold' : requested;
}

/** What the renderer should do with a one-shot that has just finished. */
export type PlayOutcome = 'park' | 'release';

/**
 * `park` freezes on the last frame until something releases it — the next
 * animation, or the bubble it belongs to being cleared. `release` hands back to
 * the normal per-box, per-expression loop.
 */
export function playOutcome(then: ThenWhat): PlayOutcome {
  return then === 'hold' ? 'park' : 'release';
}

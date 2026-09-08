/**
 * The animation clock and the life on top of it (`src/core/anim-schedule.ts`).
 *
 * This is the module that decides which frame of the dog is on screen at any
 * instant, and it is used by two renderers — the overlay window and the gallery
 * the owner approves the motion on — so its behaviour is pinned here rather than
 * judged by eye. Four things matter and each has its own group below: stepping
 * frames (including a late wake), when the clock next needs waking, when a blink
 * or an ear-flick is slipped into the idle loop, and how a one-shot ends.
 */
import { describe, expect, it } from 'vitest';
import {
  BLINK,
  BLINK_MAX_MS,
  BLINK_MIN_MS,
  DEFAULT_FRAME_MS,
  FRESH_CLOCK,
  IDLE_RARE,
  MAX_CATCH_UP_FRAMES,
  RARE_EVERY_IDLE_LOOPS,
  advanceFrames,
  canInterject,
  idleExtras,
  initIdle,
  nextFrameDueAt,
  onIdleLoop,
  playOutcome,
  resolveThen,
  timingOf,
  type FrameClock,
  type FrameTiming,
  type IdleState
} from '../src/core/anim-schedule';
import type { Animation } from '../src/sprites/types';

/** A looping animation of `count` frames, `ms` each. */
function loopOf(count: number, ms = 100): FrameTiming {
  return { frameCount: count, durationsMs: Array.from({ length: count }, () => ms), loop: true };
}

/** A one-shot of `count` frames, `ms` each. */
function shotOf(count: number, ms = 100): FrameTiming {
  return { frameCount: count, durationsMs: Array.from({ length: count }, () => ms), loop: false };
}

/** A clock that has already been ticked once, so stepping starts immediately. */
function running(index: number, startedAt: number): FrameClock {
  return { index, startedAt, done: false };
}

describe('timingOf', () => {
  it('reads the timing half out of a sheet animation', () => {
    const animation: Animation = {
      frames: ['a', 'b', 'c'],
      durationsMs: [125, 125, 250],
      loop: true,
      hold: false
    };
    expect(timingOf(animation)).toEqual({
      frameCount: 3,
      durationsMs: [125, 125, 250],
      loop: true
    });
  });
});

describe('advanceFrames', () => {
  it('starts the stopwatch on the first tick without consuming a frame', () => {
    // Otherwise the frame showing at the moment an animation is switched would
    // be charged for however long the *previous* one had been up.
    const step = advanceFrames(FRESH_CLOCK, loopOf(4), 1_000);
    expect(step.clock).toEqual({ index: 0, startedAt: 1_000, done: false });
    expect(step.changed).toBe(false);
    expect(step.finished).toBe(false);
    expect(step.wrapped).toBe(false);
  });

  it('does not move before the frame is due', () => {
    const step = advanceFrames(running(0, 1_000), loopOf(4, 100), 1_099);
    expect(step.clock.index).toBe(0);
    expect(step.changed).toBe(false);
  });

  it('steps exactly one frame when exactly one is due', () => {
    const step = advanceFrames(running(0, 1_000), loopOf(4, 100), 1_100);
    expect(step.clock).toEqual({ index: 1, startedAt: 1_100, done: false });
    expect(step.changed).toBe(true);
    expect(step.wrapped).toBe(false);
  });

  it('keeps the frame boundary rather than the wake time, so the loop does not drift', () => {
    // Woken 30 ms late: frame 1 still ends 100 ms after frame 0 *began*, not
    // 100 ms after we happened to notice.
    const step = advanceFrames(running(0, 1_000), loopOf(4, 100), 1_130);
    expect(step.clock.startedAt).toBe(1_100);
  });

  it('catches up several frames after a late wake', () => {
    // A busy machine, or a laptop resuming: the frame that should be showing may
    // be two or three on, and replaying them in slow motion would leave a blink
    // stuck open.
    const step = advanceFrames(running(0, 1_000), loopOf(4, 100), 1_250);
    expect(step.clock.index).toBe(2);
    expect(step.changed).toBe(true);
  });

  it('reports a completed lap of a loop', () => {
    const step = advanceFrames(running(3, 1_000), loopOf(4, 100), 1_100);
    expect(step.clock.index).toBe(0);
    expect(step.wrapped).toBe(true);
    expect(step.laps).toBe(1);
  });

  it('counts every lap it catches up through, not just that it wrapped', () => {
    // Two frames of 100 ms, 500 ms late: two full laps and half of a third.
    // `wrapped` stays the "did it come round" flag; `laps` is what `onIdleLoop`
    // counts, and reading it as 1 here is what let the ear-flick drift.
    const step = advanceFrames(running(0, 1_000), loopOf(2, 100), 1_500);
    expect(step.wrapped).toBe(true);
    expect(step.laps).toBe(2);
  });

  it('reports no laps when nothing moved', () => {
    expect(advanceFrames(running(0, 1_000), loopOf(4, 100), 1_050).laps).toBe(0);
    expect(advanceFrames(FRESH_CLOCK, loopOf(4), 1_000).laps).toBe(0);
  });

  it('reports no laps for a one-shot, which has none to complete', () => {
    const step = advanceFrames(running(2, 1_000), shotOf(3, 100), 1_100);
    expect(step.finished).toBe(true);
    expect(step.laps).toBe(0);
  });

  it('gives up catching up once the guard runs out, and resynchronises to now', () => {
    // An hour asleep: there is no value in replaying an hour of idle loop, and
    // leaving `startedAt` an hour in the past would spin the guard on every
    // subsequent wake.
    const late = 1_000 + MAX_CATCH_UP_FRAMES * 100 + 10_000;
    const step = advanceFrames(running(0, 1_000), loopOf(4, 100), late);
    expect(step.clock.startedAt).toBe(late);
  });

  describe('a one-shot running out', () => {
    it('parks on the last frame and reports finishing', () => {
      const step = advanceFrames(running(2, 1_000), shotOf(3, 100), 1_100);
      expect(step.clock).toEqual({ index: 2, startedAt: 1_100, done: true });
      expect(step.finished).toBe(true);
      // The picture does not change — the last frame simply stays up.
      expect(step.changed).toBe(false);
    });

    it('reports finishing exactly once', () => {
      // The whole reason `done` is explicit state. Without it, every later
      // repaint (a mouse move, a resize) would re-derive "the last frame's
      // duration has elapsed" and release a held pose, or fire a queued
      // follow-up, a second and third time.
      const first = advanceFrames(running(2, 1_000), shotOf(3, 100), 1_100);
      const second = advanceFrames(first.clock, shotOf(3, 100), 5_000);
      expect(second.finished).toBe(false);
      expect(second.changed).toBe(false);
      expect(second.clock).toBe(first.clock);
    });

    it('runs through to the end from the first frame in one late wake', () => {
      const step = advanceFrames(running(0, 1_000), shotOf(3, 100), 9_000);
      expect(step.clock.index).toBe(2);
      expect(step.clock.done).toBe(true);
      expect(step.finished).toBe(true);
    });
  });

  describe('defensive cases', () => {
    it('does nothing for an animation with no frames', () => {
      const clock = running(0, 1_000);
      const step = advanceFrames(clock, { frameCount: 0, durationsMs: [], loop: true }, 9_000);
      expect(step.clock).toBe(clock);
      expect(step.changed).toBe(false);
    });

    it('substitutes the default duration for a missing or nonsensical one', () => {
      // Unreachable through a validated sheet; the alternative to a default is
      // NaN arithmetic and a dog that freezes with no error anywhere.
      const timing: FrameTiming = { frameCount: 2, durationsMs: [], loop: true };
      expect(advanceFrames(running(0, 0), timing, DEFAULT_FRAME_MS - 1).changed).toBe(false);
      expect(advanceFrames(running(0, 0), timing, DEFAULT_FRAME_MS).clock.index).toBe(1);

      const bad: FrameTiming = { frameCount: 2, durationsMs: [0, -5], loop: true };
      expect(advanceFrames(running(0, 0), bad, DEFAULT_FRAME_MS).clock.index).toBe(1);
    });

    it('clamps an index that is past the end of a shorter animation', () => {
      // Happens if an animation is swapped without resetting the clock.
      const step = advanceFrames(running(9, 1_000), loopOf(2, 100), 1_000);
      expect(step.clock.index).toBeLessThan(2);
    });
  });
});

describe('nextFrameDueAt', () => {
  it('is null before the first tick', () => {
    expect(nextFrameDueAt(FRESH_CLOCK, loopOf(4))).toBeNull();
  });

  it('is the current frame start plus its own duration', () => {
    expect(nextFrameDueAt(running(1, 1_000), loopOf(4, 125))).toBe(1_125);
  });

  it('still asks to be woken on the last frame of a one-shot', () => {
    // The wake that turns the last frame into "finished". Without it the dog
    // holds the final bark frame until some unrelated event repaints him, which
    // on a quiet afternoon is a long time.
    expect(nextFrameDueAt(running(2, 1_000), shotOf(3, 100))).toBe(1_100);
  });

  it('is null once a one-shot has parked — zero wakeups', () => {
    expect(nextFrameDueAt({ index: 2, startedAt: 1_100, done: true }, shotOf(3, 100))).toBeNull();
  });
});

describe('idle interjections', () => {
  const both = { hasRare: true, hasBlink: true };
  const neither = { hasRare: false, hasBlink: false };

  /** A random source that always returns the same point in [0, 1]. */
  const fixed = (value: number) => () => value;

  describe('idleExtras', () => {
    it('reads both names out of the sheet', () => {
      expect(idleExtras((name) => name === IDLE_RARE)).toEqual({
        hasRare: true,
        hasBlink: false
      });
      expect(idleExtras(() => true)).toEqual(both);
      expect(idleExtras(() => false)).toEqual(neither);
    });
  });

  describe('canInterject', () => {
    it('allows the neutral idles only', () => {
      expect(canInterject('idle')).toBe(true);
      expect(canInterject('idle_neutral')).toBe(true);
    });

    it('refuses the moody idles, so a blink cannot flash a neutral face', () => {
      expect(canInterject('idle_worried')).toBe(false);
      expect(canInterject('idle_exhausted')).toBe(false);
      expect(canInterject('idle_happy')).toBe(false);
      expect(canInterject('out')).toBe(false);
      expect(canInterject('confused')).toBe(false);
    });

    it('refuses the sleeping loop — a curled dog has no ears to flick', () => {
      expect(canInterject('sleep')).toBe(false);
    });
  });

  describe('initIdle', () => {
    it('arms the first blink 3-5 s out', () => {
      const state = initIdle(both, 1_000, fixed(0));
      expect(state.loopsSinceRare).toBe(0);
      expect(state.blinkDueAt).toBe(1_000 + BLINK_MIN_MS);
      expect(initIdle(both, 1_000, fixed(1)).blinkDueAt).toBe(1_000 + BLINK_MAX_MS);
      expect(initIdle(both, 1_000, fixed(0.5)).blinkDueAt).toBe(
        1_000 + (BLINK_MIN_MS + BLINK_MAX_MS) / 2
      );
    });

    it('leaves the blink unarmed when the art has no blink', () => {
      expect(initIdle({ hasRare: true, hasBlink: false }, 1_000).blinkDueAt).toBeNull();
    });

    it('survives a random source that misbehaves', () => {
      const at = initIdle(both, 1_000, () => Number.NaN).blinkDueAt;
      expect(at).not.toBeNull();
      expect(at as number).toBeGreaterThanOrEqual(1_000 + BLINK_MIN_MS);
      expect(at as number).toBeLessThanOrEqual(1_000 + BLINK_MAX_MS);
      expect(initIdle(both, 1_000, () => 5).blinkDueAt).toBe(1_000 + BLINK_MAX_MS);
      expect(initIdle(both, 1_000, () => -5).blinkDueAt).toBe(1_000 + BLINK_MIN_MS);
    });
  });

  describe('the rare ear-flick', () => {
    it('plays on the fourth completed lap, and not before', () => {
      let state: IdleState = { loopsSinceRare: 0, blinkDueAt: null };
      const played: (string | null)[] = [];
      for (let lap = 0; lap < RARE_EVERY_IDLE_LOOPS; lap++) {
        const decision = onIdleLoop(state, { hasRare: true, hasBlink: false }, 0);
        state = decision.state;
        played.push(decision.play);
      }
      expect(played).toEqual([null, null, null, IDLE_RARE]);
    });

    it('resets the lap count, so it is every fourth lap and not just the fourth', () => {
      let state: IdleState = { loopsSinceRare: 0, blinkDueAt: null };
      const extras = { hasRare: true, hasBlink: false };
      const played: (string | null)[] = [];
      for (let lap = 0; lap < RARE_EVERY_IDLE_LOOPS * 2; lap++) {
        const decision = onIdleLoop(state, extras, 0);
        state = decision.state;
        played.push(decision.play);
      }
      expect(played.filter((name) => name === IDLE_RARE)).toHaveLength(2);
      expect(played[RARE_EVERY_IDLE_LOOPS * 2 - 1]).toBe(IDLE_RARE);
    });

    it('stays on every fourth lap when one wake crosses several', () => {
      // The drift this fixes: a busy machine catches up through three laps in
      // one `advanceFrames` call, and counting that as one lap pushed the
      // ear-flick further out every time it happened.
      const extras = { hasRare: true, hasBlink: false };
      let state: IdleState = { loopsSinceRare: 0, blinkDueAt: null };

      const first = onIdleLoop(state, extras, 0, Math.random, 3);
      expect(first.play).toBeNull();
      state = first.state;

      // Two more laps: the fourth is reached inside this step, so it plays.
      const second = onIdleLoop(state, extras, 0, Math.random, 2);
      expect(second.play).toBe(IDLE_RARE);
      // And the fifth lap is carried, so the next flick is four laps away, not
      // five — the overshoot is not thrown away.
      expect(second.state.loopsSinceRare).toBe(1);
    });

    it('treats a nonsense lap count as one lap', () => {
      const extras = { hasRare: true, hasBlink: false };
      const state: IdleState = { loopsSinceRare: RARE_EVERY_IDLE_LOOPS - 1, blinkDueAt: null };
      for (const laps of [0, -4, 0.5, Number.NaN]) {
        expect(onIdleLoop(state, extras, 0, Math.random, laps).play, String(laps)).toBe(IDLE_RARE);
      }
    });

    it('never plays when the art has no idle_rare', () => {
      let state: IdleState = { loopsSinceRare: 0, blinkDueAt: null };
      for (let lap = 0; lap < 20; lap++) {
        const decision = onIdleLoop(state, neither, 0);
        state = decision.state;
        expect(decision.play).toBeNull();
      }
      // The counter still runs, so switching art in mid-session does not have
      // to reason about a stale count.
      expect(state.loopsSinceRare).toBe(20);
    });
  });

  describe('the blink', () => {
    it('waits until it is due, then plays on the next completed lap', () => {
      const extras = { hasRare: false, hasBlink: true };
      const state = initIdle(extras, 0, fixed(0)); // due at 3000
      expect(onIdleLoop(state, extras, 2_999).play).toBeNull();
      expect(onIdleLoop(state, extras, 3_000).play).toBe(BLINK);
    });

    it('re-arms itself 3-5 s past the blink that just played', () => {
      const extras = { hasRare: false, hasBlink: true };
      const state: IdleState = { loopsSinceRare: 0, blinkDueAt: 3_000 };
      const decision = onIdleLoop(state, extras, 3_200, fixed(0));
      expect(decision.play).toBe(BLINK);
      // From *now*, not from when it was due: a laptop that slept for an hour
      // blinks once on the way back rather than working through a backlog.
      expect(decision.state.blinkDueAt).toBe(3_200 + BLINK_MIN_MS);
    });

    it('never plays when the art has no blink', () => {
      const state: IdleState = { loopsSinceRare: 0, blinkDueAt: 1 };
      expect(onIdleLoop(state, { hasRare: false, hasBlink: false }, 9_999).play).toBeNull();
    });
  });

  describe('when both are due at once', () => {
    it('plays the ear-flick, which is the bigger gesture', () => {
      const state: IdleState = { loopsSinceRare: RARE_EVERY_IDLE_LOOPS - 1, blinkDueAt: 0 };
      expect(onIdleLoop(state, both, 9_999).play).toBe(IDLE_RARE);
    });

    it('leaves the blink still due, so it lands on one of the next laps', () => {
      // Two unrelated bits of life rather than one scripted routine — and the
      // blink is not silently skipped for four more laps.
      const state: IdleState = { loopsSinceRare: RARE_EVERY_IDLE_LOOPS - 1, blinkDueAt: 500 };
      const decision = onIdleLoop(state, both, 9_999);
      expect(decision.state.blinkDueAt).toBe(500);
      expect(onIdleLoop(decision.state, both, 10_100).play).toBe(BLINK);
    });
  });

  it('does not mutate the state it is given', () => {
    const state: IdleState = { loopsSinceRare: 1, blinkDueAt: 3_000 };
    onIdleLoop(state, both, 9_999);
    expect(state).toEqual({ loopsSinceRare: 1, blinkDueAt: 3_000 });
  });
});

describe('how a one-shot ends', () => {
  describe('resolveThen', () => {
    it('passes the request through when the art does not hold', () => {
      expect(resolveThen('idle', false)).toBe('idle');
      expect(resolveThen('sleep', false)).toBe('sleep');
      expect(resolveThen('hold', false)).toBe('hold');
    });

    it('lets the art override the request', () => {
      // `perk` is asked for with `then: 'idle'` but declares `hold: true`: ears
      // that lift for "Claude is done" have to stay up while the woof is up.
      expect(resolveThen('idle', true)).toBe('hold');
      expect(resolveThen('sleep', true)).toBe('hold');
    });
  });

  describe('playOutcome', () => {
    it('parks on hold and releases otherwise', () => {
      expect(playOutcome('hold')).toBe('park');
      expect(playOutcome('idle')).toBe('release');
      // `sleep` releases too: which of the two arrives says what the coordinator
      // believes the box to be, and the box decides what the loop is.
      expect(playOutcome('sleep')).toBe('release');
    });
  });
});

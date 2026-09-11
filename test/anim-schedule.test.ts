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
  NEUTRAL_IDLES,
  RARE_EVERY_IDLE_LOOPS,
  advanceFrames,
  blinkFor,
  canInterject,
  idleExtras,
  initIdle,
  nextFrameDueAt,
  onIdleLoop,
  playOutcome,
  rareFor,
  resolveThen,
  timingOf,
  type FrameClock,
  type FrameTiming,
  type IdleExtras,
  type IdleState
} from '../src/core/anim-schedule';
import type { Animation } from '../src/sprites/types';
import shipped from '../src/sprites/walder.json';

/**
 * `has` over the sheet the app actually loads.
 *
 * The predicates below are hand-written miniatures of two sheets, which is what
 * makes them readable — and also what makes them unable to catch the 0.1.2 bug,
 * because a miniature says whatever its author believed the art contained. The
 * shipped sheet says what it contains.
 */
const shippedHas = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(shipped.animations, name);

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
  it('asks to be woken now when the clock has not been started', () => {
    // THE 0.2.1 FREEZE, and all three of the owner's animation reports are this
    // one line.
    //
    // A clock is reset to `FRESH_CLOCK` whenever the running animation is
    // swapped, and the renderer does that *inside* a paint, after it has already
    // advanced the outgoing animation. The wake it arms at the end of that paint
    // is therefore computed from a clock that has never been ticked — and
    // answering `null` there means "nothing will ever change on its own", so no
    // timer was armed, nothing repainted, and the dog stopped dead.
    //
    // Two places do it, and each produced one of the reports:
    //  - `advance` starts a blink mid-paint (`startPlay`). The shipped `blink` is
    //    `[idle_3, idle_4, idle_3]` and `idle_3` is the HALF-CLOSED eye, so the
    //    dog froze on the first frame of his own blink: "idle animations end on a
    //    half closed blink".
    //  - `onPlayFinished` releases a finished one-shot back to the idle loop. The
    //    pet wiggle a click plays is one, so a click left him parked on `idle_0`
    //    and never moving again: "after clicking to refresh… it just freezes".
    //
    // An unstarted clock *can* change on its own — it only needs one tick to
    // start its stopwatch — so the honest answer is "now", not "never".
    expect(nextFrameDueAt(FRESH_CLOCK, loopOf(4), 1_000)).toBe(1_000);
    expect(nextFrameDueAt(FRESH_CLOCK, shotOf(3), 2_500)).toBe(2_500);
  });

  it('is the current frame start plus its own duration', () => {
    expect(nextFrameDueAt(running(1, 1_000), loopOf(4, 125), 1_000)).toBe(1_125);
  });

  it('still asks to be woken on the last frame of a one-shot', () => {
    // The wake that turns the last frame into "finished". Without it the dog
    // holds the final bark frame until some unrelated event repaints him, which
    // on a quiet afternoon is a long time.
    expect(nextFrameDueAt(running(2, 1_000), shotOf(3, 100), 1_000)).toBe(1_100);
  });

  it('is null once a one-shot has parked — zero wakeups', () => {
    expect(
      nextFrameDueAt({ index: 2, startedAt: 1_100, done: true }, shotOf(3, 100), 1_100)
    ).toBeNull();
  });

  it('is null for an empty animation, started or not', () => {
    const empty: FrameTiming = { frameCount: 0, durationsMs: [], loop: true };
    expect(nextFrameDueAt(FRESH_CLOCK, empty, 1_000)).toBeNull();
  });
});

describe('idle interjections', () => {
  /**
   * A sheet with the new art: the neutral idle's own blink and ear-flick, and a
   * blink for each mood. `has` is a predicate over animation names, which is
   * exactly what the renderer hands in.
   */
  const newArt = (name: string): boolean =>
    ['idle', 'idle_neutral', 'idle_happy', 'idle_worried', 'idle_exhausted', 'sleep',
     'out', 'confused', 'blink', 'blink_neutral', 'blink_happy', 'blink_worried',
     'blink_exhausted', 'idle_rare'].includes(name);

  /** The 0.1.2 sheet: one blink, drawn from the neutral pose, and no mood blinks. */
  const oldArt = (name: string): boolean =>
    ['idle', 'idle_neutral', 'idle_happy', 'idle_worried', 'idle_exhausted', 'sleep',
     'out', 'confused', 'blink', 'idle_rare'].includes(name);

  const both: IdleExtras = { rare: IDLE_RARE, blink: BLINK };
  const neither: IdleExtras = { rare: null, blink: null };
  const blinkOnly: IdleExtras = { rare: null, blink: BLINK };
  const rareOnly: IdleExtras = { rare: IDLE_RARE, blink: null };

  /** A random source that always returns the same point in [0, 1]. */
  const fixed = (value: number) => () => value;

  describe('blinkFor', () => {
    it('gives each idle loop the blink drawn in its own face', () => {
      // The 2026-09-09 fix. Every mood strip now carries its own blink pair, so
      // a worried dog blinks worried instead of flashing a neutral face for a
      // fifth of a second — which is why the old code refused to blink him at
      // all, and why three of the four healthy moods were unblinking stares.
      expect(blinkFor('idle', newArt)).toBe('blink');
      expect(blinkFor('idle_neutral', newArt)).toBe('blink_neutral');
      expect(blinkFor('idle_happy', newArt)).toBe('blink_happy');
      expect(blinkFor('idle_worried', newArt)).toBe('blink_worried');
      expect(blinkFor('idle_exhausted', newArt)).toBe('blink_exhausted');
    });

    it('gives nothing to a loop that is not an idle loop', () => {
      // Excluded by the naming rather than by a list: a curled dog has no ears
      // to flick and no eyes on show, and `out`/`confused` are states rather
      // than moods. None of them start with `idle`.
      for (const name of ['sleep', 'out', 'confused', 'bark', 'pet', 'wake', '']) {
        expect(blinkFor(name, newArt), name).toBeNull();
      }
      // `idle_` with nothing after it would derive `blink_`, which is not a name.
      expect(blinkFor('idle_', newArt)).toBeNull();
    });

    it('gives nothing when the art has no blink for that loop', () => {
      // The old sheet: `blink` exists, `blink_worried` does not. So a worried
      // dog on old art still does not blink — degradation, not a regression.
      expect(blinkFor('idle', oldArt)).toBe('blink');
      expect(blinkFor('idle_worried', oldArt)).toBeNull();
      expect(blinkFor('idle_happy', oldArt)).toBeNull();
      // And on a sheet with no blink at all, not even the neutral one.
      expect(blinkFor('idle', () => false)).toBeNull();
    });

    it('falls back to the plain blink for both neutral names', () => {
      // The 2026-09-10 fix. `idle` and `idle_neutral` are one loop with two
      // names, and no sheet has ever carried a `blink_neutral` drawn separately
      // — the legacy table deliberately omits it. Deriving `blink_neutral` and
      // stopping there left the app's DEFAULT loop unblinking: `pickAnimation`
      // answers `idle_neutral` for the middle usage band, so the dog stared
      // through the state he is in most of the day while every mood blinked.
      expect(blinkFor('idle_neutral', oldArt)).toBe('blink');
      // The mood's own blink still wins where the art has one.
      expect(blinkFor('idle_neutral', newArt)).toBe('blink_neutral');
      // ... and the fallback is neutral-only: a mood with no blink of its own
      // still does not borrow the neutral face.
      expect(blinkFor('idle_exhausted', oldArt)).toBeNull();
    });

    it('blinks in the default state on the REAL shipped sheet', () => {
      // Against `src/sprites/walder.json` itself, not a hand-written predicate.
      // The hand-written `oldArt` above is only ever as honest as whoever typed
      // it; this one fails the moment the shipped art stops carrying a blink the
      // neutral band can use, which is the regression that shipped in 0.1.2.
      const neutralBlink = blinkFor('idle_neutral', shippedHas);
      expect(neutralBlink).not.toBeNull();
      expect((shipped.animations as Record<string, { frames: string[] }>)[neutralBlink!]?.frames)
        .toEqual(shipped.animations.blink.frames);
      expect(blinkFor('idle', shippedHas)).toBe(BLINK);
      expect(idleExtras('idle_neutral', shippedHas).blink).not.toBeNull();
      expect(canInterject('idle_neutral', shippedHas)).toBe(true);
    });

    it('holds the first frame in every shipped idle and schedules only blinks', () => {
      // Exercise the actual generated sheet: checking a miniature would miss
      // a breathing table or rare head-lift accidentally coming back in the
      // art generator, including the default happy alias before its art lands.
      const animations: Record<string, { frames: string[] }> = shipped.animations;
      for (const base of ['idle', 'idle_neutral', 'idle_happy', 'idle_worried', 'idle_exhausted']) {
        const animation = animations[base]!;
        expect(animation.frames, base).toHaveLength(1);
        expect(animation.frames[0], base).toMatch(/_0$/);
        const extras = idleExtras(base, shippedHas);
        expect(extras.rare, base).toBeNull();
        expect(extras.blink, base).not.toBeNull();
        let state = initIdle(extras, 0, fixed(0.5));
        const played: string[] = [];
        for (let now = 1_000; now <= 30_000; now += 1_000) {
          const decision = onIdleLoop(state, extras, now, fixed(0.5));
          state = decision.state;
          if (decision.play !== null) played.push(decision.play);
        }
        expect(played.length, base).toBeGreaterThan(0);
        expect(new Set(played), base).toEqual(new Set([extras.blink]));
      }
    });
  });

  describe('rareFor', () => {
    it('gives the ear-flick to the neutral idles only', () => {
      // Deliberately not derived per mood: there is no `idle_rare_happy` in the
      // art and there is not meant to be. Moods blink but never ear-flick.
      for (const name of NEUTRAL_IDLES) expect(rareFor(name, newArt), name).toBe(IDLE_RARE);
      for (const name of ['idle_happy', 'idle_worried', 'idle_exhausted', 'sleep', 'out']) {
        expect(rareFor(name, newArt), name).toBeNull();
      }
    });

    it('gives nothing when the art has no idle_rare', () => {
      expect(rareFor('idle', () => false)).toBeNull();
    });
  });

  describe('idleExtras', () => {
    it('reads the pair that belongs to one loop', () => {
      expect(idleExtras('idle', newArt)).toEqual({ rare: IDLE_RARE, blink: 'blink' });
      expect(idleExtras('idle_worried', newArt)).toEqual({ rare: null, blink: 'blink_worried' });
      expect(idleExtras('idle_worried', oldArt)).toEqual({ rare: null, blink: null });
      expect(idleExtras('sleep', newArt)).toEqual(neither);
    });
  });

  describe('canInterject', () => {
    it('allows a loop that has something of its own to slip in', () => {
      expect(canInterject('idle', newArt)).toBe(true);
      expect(canInterject('idle_neutral', newArt)).toBe(true);
      // The change the owner asked for: the moods now blink.
      expect(canInterject('idle_happy', newArt)).toBe(true);
      expect(canInterject('idle_worried', newArt)).toBe(true);
      expect(canInterject('idle_exhausted', newArt)).toBe(true);
    });

    it('refuses the moody idles on art that has no blink for them', () => {
      // The 0.1.2 behaviour, and still correct on the 0.1.2 sheet: a neutral
      // blink over a worried face would read as him cheering up and back.
      expect(canInterject('idle_worried', oldArt)).toBe(false);
      expect(canInterject('idle_happy', oldArt)).toBe(false);
      // The neutral idles keep theirs.
      expect(canInterject('idle', oldArt)).toBe(true);
    });

    it('refuses the sleeping loop, and everything that is not an idle', () => {
      for (const name of ['sleep', 'out', 'confused', 'bark']) {
        expect(canInterject(name, newArt), name).toBe(false);
      }
    });

    it('refuses everything on a sheet with no interjections at all', () => {
      expect(canInterject('idle', () => false)).toBe(false);
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

    it('leaves the blink unarmed when the running loop has none', () => {
      expect(initIdle(rareOnly, 1_000).blinkDueAt).toBeNull();
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
        const decision = onIdleLoop(state, rareOnly, 0);
        state = decision.state;
        played.push(decision.play);
      }
      expect(played).toEqual([null, null, null, IDLE_RARE]);
    });

    it('resets the lap count, so it is every fourth lap and not just the fourth', () => {
      let state: IdleState = { loopsSinceRare: 0, blinkDueAt: null };
      const played: (string | null)[] = [];
      for (let lap = 0; lap < RARE_EVERY_IDLE_LOOPS * 2; lap++) {
        const decision = onIdleLoop(state, rareOnly, 0);
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
      let state: IdleState = { loopsSinceRare: 0, blinkDueAt: null };

      const first = onIdleLoop(state, rareOnly, 0, Math.random, 3);
      expect(first.play).toBeNull();
      state = first.state;

      // Two more laps: the fourth is reached inside this step, so it plays.
      const second = onIdleLoop(state, rareOnly, 0, Math.random, 2);
      expect(second.play).toBe(IDLE_RARE);
      // And the fifth lap is carried, so the next flick is four laps away, not
      // five — the overshoot is not thrown away.
      expect(second.state.loopsSinceRare).toBe(1);
    });

    it('treats a nonsense lap count as one lap', () => {
      const state: IdleState = { loopsSinceRare: RARE_EVERY_IDLE_LOOPS - 1, blinkDueAt: null };
      for (const laps of [0, -4, 0.5, Number.NaN]) {
        expect(onIdleLoop(state, rareOnly, 0, Math.random, laps).play, String(laps)).toBe(IDLE_RARE);
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
      const state = initIdle(blinkOnly, 0, fixed(0)); // due at 3000
      expect(onIdleLoop(state, blinkOnly, 2_999).play).toBeNull();
      expect(onIdleLoop(state, blinkOnly, 3_000).play).toBe(BLINK);
    });

    it('plays whichever blink the running loop owns', () => {
      // The whole point of deriving the name: the scheduler does not know what
      // a mood is, it just plays the animation the loop named.
      const worried: IdleExtras = { rare: null, blink: 'blink_worried' };
      const state: IdleState = { loopsSinceRare: 0, blinkDueAt: 3_000 };
      expect(onIdleLoop(state, worried, 3_000).play).toBe('blink_worried');
    });

    it('re-arms itself 3-5 s past the blink that just played', () => {
      const state: IdleState = { loopsSinceRare: 0, blinkDueAt: 3_000 };
      const decision = onIdleLoop(state, blinkOnly, 3_200, fixed(0));
      expect(decision.play).toBe(BLINK);
      // From *now*, not from when it was due: a laptop that slept for an hour
      // blinks once on the way back rather than working through a backlog.
      expect(decision.state.blinkDueAt).toBe(3_200 + BLINK_MIN_MS);
    });

    it('never plays when the running loop has no blink', () => {
      const state: IdleState = { loopsSinceRare: 0, blinkDueAt: 1 };
      expect(onIdleLoop(state, rareOnly, 9_999).play).toBeNull();
      // And an armed timer is left alone rather than cleared, so switching back
      // to a loop that does have one does not start the wait again.
      expect(onIdleLoop(state, rareOnly, 9_999).state.blinkDueAt).toBe(1);
    });

    describe('arming itself', () => {
      it('arms an unarmed timer and plays nothing that lap', () => {
        // The bug this fixes: `initIdle` runs once, when the sheet arrives, and
        // whether a blink exists depends on which mood is running. A dog who
        // happened to be worried at that moment — on art with no
        // `blink_worried` — got `blinkDueAt: null` and kept it, so he never
        // blinked again in ANY mood for the rest of the session.
        const state: IdleState = { loopsSinceRare: 0, blinkDueAt: null };
        const decision = onIdleLoop(state, blinkOnly, 5_000, fixed(0));
        expect(decision.play).toBeNull();
        expect(decision.state.blinkDueAt).toBe(5_000 + BLINK_MIN_MS);
        // And then it behaves like any armed timer.
        expect(onIdleLoop(decision.state, blinkOnly, 5_000 + BLINK_MIN_MS).play).toBe(BLINK);
      });

      it('still counts the lap while it arms', () => {
        const state: IdleState = { loopsSinceRare: 1, blinkDueAt: null };
        expect(onIdleLoop(state, blinkOnly, 0).state.loopsSinceRare).toBe(2);
      });

      it('lets the ear-flick go first, and arms on the lap after', () => {
        // Rare wins over anything, including its own arming: it is the bigger
        // gesture and it is already due.
        const state: IdleState = { loopsSinceRare: RARE_EVERY_IDLE_LOOPS - 1, blinkDueAt: null };
        const flick = onIdleLoop(state, both, 1_000, fixed(0));
        expect(flick.play).toBe(IDLE_RARE);
        expect(flick.state.blinkDueAt).toBeNull();
        const armed = onIdleLoop(flick.state, both, 1_100, fixed(0));
        expect(armed.play).toBeNull();
        expect(armed.state.blinkDueAt).toBe(1_100 + BLINK_MIN_MS);
      });
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

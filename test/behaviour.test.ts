/**
 * The behaviour coordinator: what Walder does, and in which order.
 *
 * Four sources want the dog's attention — usage thresholds, Claude Code hooks,
 * the owner's clicks, and a fullscreen video — and the whole value of this class
 * is that they cannot contradict each other. So the tests are written as
 * *sequences*, not as unit assertions on single calls: the interesting bugs are
 * all "a perk arrived while a bark was up", "a pet dismissed the bark and the
 * dog forgot to go back to sleep", "the wake fired but the window was still the
 * tiny one".
 *
 * Two invariants are asserted throughout, because breaking either is invisible
 * on screen until it is not:
 *  - `mode` and `expression` are never emitted twice in a row with the same
 *    value (a `mode` is a window resize);
 *  - `mode` always precedes the `play` that belongs with it, so a stand-box
 *    animation never starts while the window is still sleep-sized.
 */
import { describe, expect, it } from 'vitest';
import {
  ANIM_SLEEP_PET,
  Behaviour,
  NUDGE_TTL_MS,
  PERK_TTL_MS,
  SLEEP_PET_TTL_MS,
  type SceneEvent
} from '../src/core/behaviour';
import type { Bucket } from '../src/core/buckets';
import { expressionForBuckets, type UsageSnapshot } from '../src/core/usage';

const T0 = Date.parse('2026-09-08T12:00:00.000Z');

function bucket(
  id: string,
  label: string,
  pct: number | null,
  priority = 0,
  service: 'claude' | 'chatgpt' = 'claude'
): Bucket {
  return {
    id,
    service,
    key: id.split('.')[1] ?? id,
    label,
    pct,
    resetsAt: '2026-09-08T17:00:00.000Z',
    priority
  };
}

/** A snapshot carrying exactly these buckets. */
function snapshot(buckets: Bucket[]): UsageSnapshot {
  const report = {
    buckets,
    status: 'ok' as const,
    via: 'test',
    viaLabel: 'test'
  };
  const empty = { buckets: [], status: 'unavailable' as const, via: 'none', viaLabel: 'no source' };
  return {
    fetchedAt: new Date(T0).toISOString(),
    services: { claude: report, chatgpt: empty },
    buckets,
    expression: expressionForBuckets(buckets),
    intervalMs: 180_000
  };
}

/** The five-hour Claude window at `pct` — the bucket that drives the face. */
function fiveHour(pct: number | null): UsageSnapshot {
  return snapshot([bucket('claude.five_hour', '5-hour', pct)]);
}

/** `['expression:worried', 'mode:stand', 'play:wake', …]` — readable sequences. */
function shape(events: readonly SceneEvent[]): string[] {
  return events.map((event) => {
    switch (event.type) {
      case 'expression':
        return `expression:${event.expression}`;
      case 'mode':
        return `mode:${event.box}`;
      case 'play':
        return `play:${event.animation}>${event.then}`;
      case 'bubble':
        return `bubble:${event.kind}`;
    }
  });
}

function bubbleTexts(events: readonly SceneEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'bubble' && event.kind !== 'none' ? [event.text] : []));
}

/** Assert the two structural invariants over a whole session's events. */
function assertInvariants(all: readonly SceneEvent[]): void {
  let lastMode: string | null = null;
  let lastExpression: string | null = null;
  for (const event of all) {
    if (event.type === 'mode') {
      expect(event.box, 'duplicate consecutive mode').not.toBe(lastMode);
      lastMode = event.box;
    }
    if (event.type === 'expression') {
      expect(event.expression, 'duplicate consecutive expression').not.toBe(lastExpression);
      lastExpression = event.expression;
    }
  }
}

describe('expression', () => {
  it('emits the first face even when it is the confused one', () => {
    const walder = new Behaviour();
    expect(shape(walder.onUsage(snapshot([]), T0))).toEqual(['expression:confused']);
  });

  it('never repeats the same face', () => {
    const walder = new Behaviour();
    walder.onUsage(fiveHour(20), T0);
    expect(shape(walder.onUsage(fiveHour(21), T0 + 1000))).toEqual([]);
    expect(shape(walder.onUsage(fiveHour(60), T0 + 2000))).toEqual(['expression:neutral']);
  });

  it('is confused, not cheerful, when there is no data at all', () => {
    const walder = new Behaviour();
    walder.onUsage(fiveHour(10), T0);
    expect(shape(walder.onUsage(snapshot([]), T0 + 1000))).toEqual(['expression:confused']);
    expect(walder.expression).toBe('confused');
  });

  it('goes to `out` at 100 %, and barks about it', () => {
    const walder = new Behaviour();
    const events = walder.onUsage(fiveHour(100), T0);
    expect(shape(events)).toEqual(['expression:out', 'play:bark>idle', 'bubble:nudge']);
    expect(bubbleTexts(events)).toEqual(['5-hour: 100% used']);
    assertInvariants(events);
  });
});

describe('usage barks', () => {
  it('barks once per threshold, with the bucket label and the observed percentage', () => {
    const walder = new Behaviour();
    const first = walder.onUsage(fiveHour(82), T0);
    expect(shape(first)).toEqual(['expression:worried', 'play:bark>idle', 'bubble:nudge']);
    expect(bubbleTexts(first)).toEqual(['5-hour: 82% used']);

    // Same window, no new threshold: nothing more to say.
    expect(shape(walder.onUsage(fiveHour(83), T0 + 1000))).toEqual([]);
  });

  it('uses each provider’s own label', () => {
    const walder = new Behaviour();
    const events = walder.onUsage(
      snapshot([
        bucket('claude.seven_day', '7-day (all models)', 85, 3),
        bucket('chatgpt.primary', 'Codex 5-hour', 90, 4, 'chatgpt')
      ]),
      T0
    );
    // One bark shows; the other is queued behind it by the machine.
    expect(bubbleTexts(events)).toEqual(['7-day (all models): 85% used']);
    const next = walder.onPet(T0 + 500);
    expect(bubbleTexts(next)).toEqual(['Codex 5-hour: 90% used']);
  });

  it('auto-dismisses a bark after its ttl and reports that deadline', () => {
    const walder = new Behaviour();
    walder.onUsage(fiveHour(82), T0);
    expect(walder.nextDeadlineAt()).toBe(T0 + NUDGE_TTL_MS);

    expect(shape(walder.onTick(T0 + NUDGE_TTL_MS - 1))).toEqual([]);
    expect(shape(walder.onTick(T0 + NUDGE_TTL_MS))).toEqual(['bubble:none']);
    expect(walder.nextDeadlineAt()).toBeNull();
  });
});

describe('petting', () => {
  it('wiggles with nothing to dismiss', () => {
    const walder = new Behaviour();
    expect(shape(walder.onPet(T0))).toEqual(['play:pet>idle']);
  });

  it('dismisses the bark it was clicked on', () => {
    const walder = new Behaviour();
    walder.onUsage(fiveHour(82), T0);
    expect(shape(walder.onPet(T0 + 500))).toEqual(['play:pet>idle', 'bubble:none']);
    expect(walder.bubble).toBeNull();
  });

  /**
   * Petting a *sleeping* dog used to do nothing at all: the wiggle is skipped
   * in the sleeping box (a stand-box animation would be clipped by the much
   * smaller window) and nothing took its place. A mascot that visibly ignores a
   * click is indistinguishable from one that has stopped working, which is the
   * single worst thing this app can look like.
   */
  describe('while asleep', () => {
    /** Asleep in the sleeping box, with nothing on screen. */
    function sleeping(opts: { hasSleepPet?: boolean } = {}): Behaviour {
      const walder = new Behaviour(
        opts.hasSleepPet === true ? { hasAnimation: (name) => name === ANIM_SLEEP_PET } : {}
      );
      walder.setFullscreen(true, T0);
      expect(walder.box).toBe('sleep');
      return walder;
    }

    it('mumbles, and stays asleep, when the art has no sleeping-pet frames', () => {
      const walder = sleeping();
      const events = walder.onPet(T0 + 1_000);
      expect(shape(events)).toEqual(['bubble:sleepy']);
      expect(bubbleTexts(events)).toEqual(['…zzz']);
      // The whole point: he does *not* stand up. No `mode` event at all.
      expect(walder.box).toBe('sleep');
      expect(walder.nextDeadlineAt()).toBe(T0 + 1_000 + SLEEP_PET_TTL_MS);
    });

    it('clears the mumble on its own, still asleep', () => {
      const walder = sleeping();
      walder.onPet(T0 + 1_000);
      const tick = walder.onTick(T0 + 1_000 + SLEEP_PET_TTL_MS);
      expect(shape(tick)).toEqual(['bubble:none']);
      expect(walder.box).toBe('sleep');
      expect(walder.bubble).toBeNull();
      expect(walder.nextDeadlineAt()).toBeNull();
    });

    it('refreshes the mumble rather than strobing it when petted again', () => {
      const walder = sleeping();
      walder.onPet(T0 + 1_000);
      // No `bubble:none` first: a second click while it is up must not blink.
      expect(shape(walder.onPet(T0 + 1_500))).toEqual(['bubble:sleepy']);
      expect(walder.nextDeadlineAt()).toBe(T0 + 1_500 + SLEEP_PET_TTL_MS);
    });

    it('twitches instead when the sheet has the frames for it', () => {
      const walder = sleeping({ hasSleepPet: true });
      // An animation beats words for "he stirred without waking", and it must
      // resolve back into the sleep loop rather than the standing idle.
      expect(shape(walder.onPet(T0 + 1_000))).toEqual(['play:sleep_pet>sleep']);
      expect(walder.bubble).toBeNull();
      expect(walder.box).toBe('sleep');
      expect(walder.nextDeadlineAt()).toBeNull();
    });

    it('does not mumble when the click was dismissing a bark', () => {
      // The click's visible effect was the bubble going away, and it is what
      // sent him back to sleep. Adding a `…zzz` on top would read as a reply to
      // something the owner did not do.
      const walder = new Behaviour();
      walder.setFullscreen(true, T0);
      walder.onUsage(fiveHour(82), T0 + 60_000);
      expect(walder.box).toBe('stand');
      expect(shape(walder.onPet(T0 + 61_000))).toEqual([
        'bubble:none',
        'mode:sleep',
        'play:sleep>sleep'
      ]);
      expect(walder.bubble).toBeNull();
    });

    it('stands up normally once the film ends', () => {
      const walder = sleeping();
      walder.onPet(T0 + 1_000);
      // Leaving fullscreen with the mumble still up: he stands, and the next
      // pet is an ordinary wiggle again.
      expect(shape(walder.setFullscreen(false, T0 + 1_200))).toEqual([
        'mode:stand',
        'play:wake>idle'
      ]);
      expect(shape(walder.onPet(T0 + 1_300))).toEqual(['play:pet>idle', 'bubble:none']);
    });
  });
});

/**
 * The invariant that ties this class to the bark machine:
 *
 *     machine.active !== null  ⟺  activeBubble?.kind === 'nudge'
 *
 * Both directions matter. A bark the machine still believes is on screen, whose
 * bubble this class has replaced, will have its 12 s auto-dismiss clear
 * somebody else's bubble — and its threshold is already recorded as "warned
 * about", so the warning is lost. A `nudge` bubble with no active bark is a
 * bubble nothing will ever dismiss, because only the machine emits the `clear`
 * for one.
 */
describe('the bark-machine invariant', () => {
  function check(walder: Behaviour, where: string): void {
    expect(walder.nudgeMachineActive, `${where}: machine vs bubble disagree`).toBe(
      walder.bubble?.kind === 'nudge'
    );
  }

  it('holds through every transition that touches a bark', () => {
    const walder = new Behaviour();
    check(walder, 'fresh');

    walder.onUsage(fiveHour(82), T0);
    check(walder, 'after a bark');

    // A perk arriving over a live bark is queued, not shown — the bark keeps
    // the screen, and both halves must still agree.
    walder.onHook('done', T0 + 1_000);
    check(walder, 'perk queued behind a bark');

    // Petting routes to the machine, which clears and promotes the perk.
    walder.onPet(T0 + 2_000);
    check(walder, 'bark petted away, perk promoted');
    expect(walder.bubble?.kind).toBe('perk');

    // The perk times out on this class's own clock, not the machine's.
    walder.onTick(T0 + 2_000 + PERK_TTL_MS);
    check(walder, 'perk expired');

    // A bark taking the screen from a live head-tilt.
    walder.onHook('waiting', T0 + 20_000);
    check(walder, 'waiting shown');
    walder.onUsage(fiveHour(96), T0 + 21_000);
    check(walder, 'bark took the screen from the tilt');
    expect(walder.bubble?.kind).toBe('nudge');

    // Auto-dismiss.
    walder.onTick(T0 + 21_000 + NUDGE_TTL_MS);
    check(walder, 'bark auto-dismissed');
  });

  it('holds across the sleep transitions, including the sleeping pet', () => {
    const walder = new Behaviour();
    walder.setFullscreen(true, T0);
    check(walder, 'asleep');

    // The `…zzz` is not a nudge, and the machine knows nothing about it.
    walder.onPet(T0 + 1_000);
    check(walder, 'mumbling');
    expect(walder.bubble?.kind).toBe('sleepy');

    // A bark mid-film wakes him and takes the screen from the mumble.
    walder.onUsage(fiveHour(91), T0 + 2_000);
    check(walder, 'bark mid-film');
    expect(walder.bubble?.kind).toBe('nudge');

    walder.onPet(T0 + 3_000);
    check(walder, 'petted back to sleep');
    walder.setFullscreen(false, T0 + 4_000);
    check(walder, 'film over');
  });

  it('holds when two thresholds cross at once and are shown in turn', () => {
    const walder = new Behaviour();
    walder.onUsage(
      snapshot([
        bucket('claude.five_hour', '5-hour', 96, 0),
        bucket('claude.seven_day', '7-day', 86, 1)
      ]),
      T0
    );
    check(walder, 'first of two');
    walder.onPet(T0 + 1_000);
    check(walder, 'second of two');
    expect(walder.bubble?.kind).toBe('nudge');
    walder.onPet(T0 + 2_000);
    check(walder, 'both dismissed');
    expect(walder.bubble).toBeNull();
  });
});

describe('Claude Code hooks', () => {
  it('perks and woofs when a reply finishes, then clears itself', () => {
    const walder = new Behaviour();
    const events = walder.onHook('done', T0);
    expect(shape(events)).toEqual(['play:perk>idle', 'bubble:perk']);
    expect(bubbleTexts(events)).toEqual(['woof']);
    expect(walder.nextDeadlineAt()).toBe(T0 + PERK_TTL_MS);

    expect(shape(walder.onTick(T0 + PERK_TTL_MS - 1))).toEqual([]);
    expect(shape(walder.onTick(T0 + PERK_TTL_MS))).toEqual(['bubble:none']);
  });

  it('holds the head-tilt until a prompt arrives, however long that is', () => {
    const walder = new Behaviour();
    const events = walder.onHook('waiting', T0);
    expect(shape(events)).toEqual(['play:tilt>hold', 'bubble:waiting']);
    expect(bubbleTexts(events)).toEqual(['?']);

    // No deadline at all: a "waiting" bubble is not on a clock.
    expect(walder.nextDeadlineAt()).toBeNull();
    expect(shape(walder.onTick(T0 + 10 * 60_000))).toEqual([]);
    expect(walder.bubble?.kind).toBe('waiting');

    expect(shape(walder.onHook('prompt', T0 + 10 * 60_000))).toEqual(['bubble:none']);
    expect(walder.bubble).toBeNull();
  });

  it('lets a pet dismiss the head-tilt too', () => {
    const walder = new Behaviour();
    walder.onHook('waiting', T0);
    expect(shape(walder.onPet(T0 + 100))).toEqual(['play:pet>idle', 'bubble:none']);
  });

  it('ignores a prompt when nothing is waiting', () => {
    const walder = new Behaviour();
    expect(shape(walder.onHook('prompt', T0))).toEqual([]);
  });

  it('queues a second perk rather than stacking or dropping it', () => {
    const walder = new Behaviour();
    walder.onHook('done', T0);
    // Nothing on screen changes: the queue holds one perk, latest wins.
    expect(shape(walder.onHook('done', T0 + 1000))).toEqual([]);
    expect(shape(walder.onHook('done', T0 + 2000))).toEqual([]);

    const events = walder.onTick(T0 + PERK_TTL_MS);
    expect(shape(events)).toEqual(['bubble:none', 'play:perk>idle', 'bubble:perk']);
    // …and only one was queued, so the next tick clears for good.
    expect(shape(walder.onTick(T0 + PERK_TTL_MS + PERK_TTL_MS))).toEqual(['bubble:none']);
  });

  it('queues a perk and a wait independently, in the order they arrived', () => {
    const walder = new Behaviour();
    walder.onUsage(fiveHour(82), T0);
    expect(shape(walder.onHook('done', T0 + 100))).toEqual([]);
    expect(shape(walder.onHook('waiting', T0 + 200))).toEqual([]);

    expect(shape(walder.onPet(T0 + 300))).toEqual([
      'play:pet>idle',
      'bubble:none',
      'play:perk>idle',
      'bubble:perk'
    ]);
    expect(shape(walder.onPet(T0 + 400))).toEqual([
      'play:pet>idle',
      'bubble:none',
      'play:tilt>hold',
      'bubble:waiting'
    ]);
  });
});

describe('usage outranks hooks', () => {
  it('shows a queued perk only after the bark has been dismissed', () => {
    const walder = new Behaviour();
    const bark = walder.onUsage(fiveHour(82), T0);
    expect(shape(bark)).toEqual(['expression:worried', 'play:bark>idle', 'bubble:nudge']);

    // The perk waits: a threshold warning must not be pushed off screen by a
    // "woof" that means nothing in comparison.
    expect(shape(walder.onHook('done', T0 + 1000))).toEqual([]);
    expect(walder.bubble?.kind).toBe('nudge');

    const afterPet = walder.onPet(T0 + 2000);
    expect(shape(afterPet)).toEqual([
      'play:pet>idle',
      'bubble:none',
      'play:perk>idle',
      'bubble:perk'
    ]);
    expect(bubbleTexts(afterPet)).toEqual(['woof']);
  });

  it('shows a queued perk after the bark times out too', () => {
    const walder = new Behaviour();
    walder.onUsage(fiveHour(82), T0);
    walder.onHook('done', T0 + 1000);
    expect(shape(walder.onTick(T0 + NUDGE_TTL_MS))).toEqual([
      'bubble:none',
      'play:perk>idle',
      'bubble:perk'
    ]);
  });

  /**
   * The priority runs the other way round too: a bark arriving over a live perk
   * takes the screen immediately. A "woof" that has already been seen has done
   * its whole job, while a threshold warning delayed by five seconds is a
   * warning shown after the thing it warns about.
   */
  it('takes the screen from a live perk, and does not re-queue it', () => {
    const walder = new Behaviour();
    walder.onHook('done', T0);
    const bark = walder.onUsage(fiveHour(82), T0 + 100);
    expect(shape(bark)).toEqual(['expression:worried', 'play:bark>idle', 'bubble:nudge']);
    expect(bubbleTexts(bark)).toEqual(['5-hour: 82% used']);
    expect(walder.bubble?.kind).toBe('nudge');
    // The perk is gone for good, not waiting behind the bark.
    expect(shape(walder.onPet(T0 + 200))).toEqual(['play:pet>idle', 'bubble:none']);
  });
});

describe('fullscreen sleep', () => {
  it('curls up when a video starts and stretches when it ends', () => {
    const walder = new Behaviour();
    const asleep = walder.setFullscreen(true, T0);
    expect(shape(asleep)).toEqual(['mode:sleep', 'play:sleep>sleep']);
    expect(walder.box).toBe('sleep');

    // Redundant reports change nothing.
    expect(shape(walder.setFullscreen(true, T0 + 1000))).toEqual([]);

    const awake = walder.setFullscreen(false, T0 + 2000);
    expect(shape(awake)).toEqual(['mode:stand', 'play:wake>idle']);
    expect(walder.box).toBe('stand');
    assertInvariants([...asleep, ...awake]);
  });

  it('emits nothing on leaving fullscreen he never fell asleep in', () => {
    const walder = new Behaviour();
    walder.onHook('waiting', T0);
    // A bubble was up, so entering fullscreen did not put him to sleep.
    expect(shape(walder.setFullscreen(true, T0 + 100))).toEqual([]);
    expect(walder.box).toBe('stand');
    expect(shape(walder.setFullscreen(false, T0 + 200))).toEqual([]);
  });

  it('goes to sleep as soon as the bubble that kept him up is dismissed', () => {
    const walder = new Behaviour();
    walder.onHook('done', T0);
    expect(shape(walder.setFullscreen(true, T0 + 100))).toEqual([]);
    expect(shape(walder.onTick(T0 + PERK_TTL_MS))).toEqual([
      'bubble:none',
      'mode:sleep',
      'play:sleep>sleep'
    ]);
  });

  /**
   * The headline sequence, and the one the stage exists for: a threshold is
   * crossed while a film is playing.
   */
  it('wakes for a bark mid-video, then goes back to sleep when petted', () => {
    const walder = new Behaviour();
    const all: SceneEvent[] = [];

    const asleep = walder.setFullscreen(true, T0);
    all.push(...asleep);
    expect(shape(asleep)).toEqual(['mode:sleep', 'play:sleep>sleep']);

    const bark = walder.onUsage(fiveHour(82), T0 + 60_000);
    all.push(...bark);
    // `mode:stand` before `play:wake`: the window has to be the standing size
    // before a standing animation starts in it.
    expect(shape(bark)).toEqual([
      'expression:worried',
      'mode:stand',
      'play:wake>idle',
      'play:bark>idle',
      'bubble:nudge'
    ]);
    expect(bubbleTexts(bark)).toEqual(['5-hour: 82% used']);
    expect(walder.box).toBe('stand');

    const pet = walder.onPet(T0 + 61_000);
    all.push(...pet);
    // No `play:pet`: the same click sends him straight back to the tiny box, and
    // a stand-box wiggle in a sleep-sized window would be clipped.
    expect(shape(pet)).toEqual(['bubble:none', 'mode:sleep', 'play:sleep>sleep']);
    expect(walder.box).toBe('sleep');

    assertInvariants(all);
  });

  it('wakes for a perk mid-video and sleeps again when it times out', () => {
    const walder = new Behaviour();
    walder.setFullscreen(true, T0);
    expect(shape(walder.onHook('done', T0 + 1000))).toEqual([
      'mode:stand',
      'play:wake>idle',
      'play:perk>idle',
      'bubble:perk'
    ]);
    expect(shape(walder.onTick(T0 + 1000 + PERK_TTL_MS))).toEqual([
      'bubble:none',
      'mode:sleep',
      'play:sleep>sleep'
    ]);
  });

  it('stays awake for a wait that has no ttl, however long the film is', () => {
    const walder = new Behaviour();
    walder.setFullscreen(true, T0);
    walder.onHook('waiting', T0 + 1000);
    expect(walder.box).toBe('stand');
    expect(shape(walder.onTick(T0 + 60 * 60_000))).toEqual([]);
    expect(walder.box).toBe('stand');
  });
});

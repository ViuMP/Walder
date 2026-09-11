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
 * Three invariants are asserted throughout, because breaking any of them is
 * invisible on screen until it is not:
 *  - `mode` and `expression` are never emitted twice in a row with the same
 *    value (a `mode` is a window resize);
 *  - `visible` likewise — it is an *edge*, and a duplicate would either hide an
 *    already-hidden window or, worse, re-show a deliberately hidden one;
 *  - `mode` always precedes the `play` that belongs with it, so a stand-box
 *    animation never starts while the window is still sleep-sized.
 */
import { describe, expect, it } from 'vitest';
import {
  ANIM_SLEEP_PET,
  Behaviour,
  LINGER_MS,
  NUDGE_TTL_MS,
  PERK_TTL_MS,
  SLEEP_PET_TTL_MS,
  UPDATE_TTL_MS,
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
      case 'visible':
        return `visible:${String(event.shown)}`;
    }
  });
}

function bubbleTexts(events: readonly SceneEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'bubble' && event.kind !== 'none' ? [event.text] : []));
}

/** Assert the three structural invariants over a whole session's events. */
function assertInvariants(all: readonly SceneEvent[]): void {
  let lastMode: string | null = null;
  let lastExpression: string | null = null;
  let lastVisible: boolean | null = null;
  for (const event of all) {
    if (event.type === 'mode') {
      expect(event.box, 'duplicate consecutive mode').not.toBe(lastMode);
      lastMode = event.box;
    }
    if (event.type === 'expression') {
      expect(event.expression, 'duplicate consecutive expression').not.toBe(lastExpression);
      lastExpression = event.expression;
    }
    if (event.type === 'visible') {
      expect(event.shown, 'duplicate consecutive visible').not.toBe(lastVisible);
      lastVisible = event.shown;
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

  /**
   * A derived bucket is a second view of a window that is already in the list —
   * the "7-day Fable" row mirrors `seven_day` at the same percentage and reset
   * (see `withDerivedFableRow`). Letting it reach the `NudgeMachine` would mean
   * two crossings of one threshold, so the dog barks about the weekly pool and
   * then, twelve seconds later, about the same pool under its other name.
   */
  it('never barks about a derived bucket', () => {
    const walder = new Behaviour();
    const weekly = bucket('claude.seven_day', '7-day (all models)', 90, 3);
    const events = walder.onUsage(
      snapshot([
        weekly,
        {
          ...weekly,
          id: 'claude.seven_day_fable',
          key: 'seven_day_fable',
          label: '7-day Fable',
          priority: 1,
          derived: true
        }
      ]),
      T0
    );

    // One bark, about the reported row — and nothing queued behind it.
    expect(bubbleTexts(events)).toEqual(['7-day (all models): 90% used']);
    expect(shape(walder.onPet(T0 + 1_000))).toEqual(['play:pet>idle', 'bubble:none']);
    expect(walder.bubble).toBeNull();
    expect(walder.nudgeMachineActive).toBe(false);
  });

  /**
   * The Codex spend-limit row looks barkable — a plain window with a real
   * percentage — and is deliberately not. `NudgeMachine`'s once-per-crossing
   * memory lives in this process only, so it is empty again at every launch;
   * fine for a window that rolls over within days, wrong for a monthly cap the
   * owner blew through weeks ago (his live value is 455 %), which would
   * otherwise greet him at every launch until the 1st.
   */
  it('never barks about the Codex spend-limit row, at any percentage', () => {
    const walder = new Behaviour();
    const events = walder.onUsage(
      snapshot([bucket('chatgpt.codex_spend_limit', 'Codex credit limit', 455, 4.5)]),
      T0
    );
    expect(bubbleTexts(events)).toEqual([]);
    expect(walder.nudgeMachineActive).toBe(false);
  });

  /**
   * The money row is a percentage of a real cap, so it barks like a window —
   * that is the whole reason `extraUsageBucket` computes `spent / limit`
   * rather than inventing a new kind of alert. The credits row is the
   * opposite: a balance with no denominator, no thresholds, and exactly one
   * moment worth interrupting the owner for.
   */
  it('barks about an Extra usage row at the usual thresholds', () => {
    const walder = new Behaviour();
    const money = {
      ...bucket('claude.extra_usage', 'Extra usage', 87, 6),
      kind: 'money' as const,
      money: { spent: 43.5, limit: 50, currency: 'DKK' }
    };
    expect(bubbleTexts(walder.onUsage(snapshot([money]), T0))).toEqual(['Extra usage: 87% used']);
    // Once per window, like any other bark.
    walder.onPet(T0 + 1_000);
    expect(bubbleTexts(walder.onUsage(snapshot([money]), T0 + 2_000))).toEqual([]);
  });

  it('says nothing at all about a capless Extra usage row', () => {
    /*
     * The owner's own account: extra usage on, `monthly_limit: null`, so
     * `pct: null`. `NudgeMachine.onUsage` skips a row with no number, which is
     * what makes "no cap" mean "nothing to warn about" rather than a division
     * by zero barking 100 % every three minutes. Checked rather than assumed —
     * the row does reach the machine (only credits rows are filtered out), so
     * this is the machine's own `pct === null` guard doing the work.
     */
    const walder = new Behaviour();
    const capless: Bucket = {
      ...bucket('claude.extra_usage', 'Extra usage', null, 6),
      resetsAt: null,
      kind: 'money',
      money: { spent: 9.62, limit: null, currency: 'USD' }
    };
    expect(bubbleTexts(walder.onUsage(snapshot([capless]), T0))).toEqual([]);
    expect(walder.nudgeMachineActive).toBe(false);
    // …and still nothing when the amount grows, because there is nothing for
    // it to grow towards.
    const more: Bucket = { ...capless, money: { spent: 999, limit: null, currency: 'USD' } };
    expect(bubbleTexts(walder.onUsage(snapshot([more]), T0 + 2_000))).toEqual([]);
  });

  it('barks once when claude.ai reports the spend limit reached, and re-arms only when it clears', () => {
    // The money row's own edge, and on a capless account the only thing that
    // row can ever say. `spend_limit_reached` is claude.ai's statement, not a
    // threshold Walder computes, so it is detected here rather than in the
    // machine — exactly like a credits pool emptying.
    const walder = new Behaviour();
    const row = (limitReached: boolean): Bucket => ({
      ...bucket('claude.extra_usage', 'Extra usage', null, 6),
      resetsAt: null,
      kind: 'money',
      money: { spent: 9.62, limit: null, currency: 'USD', ...(limitReached ? { limitReached } : {}) }
    });

    // Spending, but not stopped: nothing to say.
    expect(bubbleTexts(walder.onUsage(snapshot([row(false)]), T0))).toEqual([]);

    // The false -> true edge, once.
    expect(bubbleTexts(walder.onUsage(snapshot([row(true)]), T0 + 1_000))).toEqual([
      'Extra usage: limit reached'
    ]);
    walder.onPet(T0 + 2_000);
    // Still reached three minutes later: he has already said it.
    expect(bubbleTexts(walder.onUsage(snapshot([row(true)]), T0 + 3_000))).toEqual([]);
    // A row that vanishes (a failed poll) must not re-arm the edge.
    expect(bubbleTexts(walder.onUsage(snapshot([]), T0 + 4_000))).toEqual([]);
    expect(bubbleTexts(walder.onUsage(snapshot([row(true)]), T0 + 5_000))).toEqual([]);
    // Only the cap being raised — the flag going back to false — re-arms it.
    expect(bubbleTexts(walder.onUsage(snapshot([row(false)]), T0 + 6_000))).toEqual([]);
    expect(bubbleTexts(walder.onUsage(snapshot([row(true)]), T0 + 7_000))).toEqual([
      'Extra usage: limit reached'
    ]);
  });

  it('promotes a second external exhaustion alert after the first is petted', () => {
    const walder = new Behaviour();
    const credits = (exhausted: boolean): Bucket => ({
      ...bucket('chatgpt.codex_credits', 'Codex credits', null, 5, 'chatgpt'),
      resetsAt: null,
      kind: 'credits',
      credits: { balance: exhausted ? 0 : 1240, unlimited: false, exhausted }
    });
    const extraUsage = (limitReached: boolean): Bucket => ({
      ...bucket('claude.extra_usage', 'Extra usage', null, 6),
      resetsAt: null,
      kind: 'money',
      money: { spent: 9.62, limit: null, currency: 'USD', ...(limitReached ? { limitReached } : {}) }
    });

    // Both are external `nudge`s. The latter takes the screen and the former
    // waits, which used to be discarded by the generic same-kind cleanup.
    walder.onUsage(snapshot([credits(false), extraUsage(false)]), T0);
    expect(bubbleTexts(walder.onUsage(snapshot([credits(true), extraUsage(true)]), T0 + 1_000))).toEqual([
      'Extra usage: limit reached'
    ]);
    expect(bubbleTexts(walder.onPet(T0 + 2_000))).toEqual(['Codex credits: none left']);
    expect(walder.bubble?.machine).not.toBe(true);
  });

  it('barks once when the Codex credits run out, and re-arms only when they come back', () => {
    const walder = new Behaviour();
    const credits = (exhausted: boolean): Bucket => ({
      ...bucket('chatgpt.codex_credits', 'Codex credits', null, 5, 'chatgpt'),
      resetsAt: null,
      kind: 'credits',
      credits: { balance: exhausted ? 0 : 1240, unlimited: false, exhausted }
    });

    // Plenty left: nothing to say.
    expect(bubbleTexts(walder.onUsage(snapshot([credits(false)]), T0))).toEqual([]);

    // The false -> true edge.
    const out = walder.onUsage(snapshot([credits(true)]), T0 + 1_000);
    expect(bubbleTexts(out)).toEqual(['Codex credits: none left']);
    expect(shape(out)).toContain('play:bark>idle');
    expect(shape(out)).toContain('bubble:nudge');

    // Still empty three minutes later: he has already said it.
    walder.onPet(T0 + 2_000);
    expect(bubbleTexts(walder.onUsage(snapshot([credits(true)]), T0 + 180_000))).toEqual([]);

    // Topped up, then empty again: that is a new fact.
    expect(bubbleTexts(walder.onUsage(snapshot([credits(false)]), T0 + 360_000))).toEqual([]);
    expect(bubbleTexts(walder.onUsage(snapshot([credits(true)]), T0 + 540_000))).toEqual([
      'Codex credits: none left'
    ]);
  });

  it('never barks about a credits row crossing a threshold — it has none', () => {
    const walder = new Behaviour();
    // `pct: 100` would be five thresholds at once for a window.
    const full = {
      ...bucket('chatgpt.codex_credits', 'Codex credits', 100, 5, 'chatgpt'),
      kind: 'credits' as const,
      credits: { balance: 4, unlimited: false, exhausted: false }
    };
    expect(bubbleTexts(walder.onUsage(snapshot([full]), T0))).toEqual([]);
  });

  it('lets a window bark go first and shows the credits one after it', () => {
    const walder = new Behaviour();
    const events = walder.onUsage(
      snapshot([
        bucket('claude.five_hour', '5-hour', 91),
        {
          ...bucket('chatgpt.codex_credits', 'Codex credits', null, 5, 'chatgpt'),
          resetsAt: null,
          kind: 'credits' as const,
          credits: { balance: 0, unlimited: false, exhausted: true }
        }
      ]),
      T0
    );
    // The threshold warning takes the screen; "none left" waits behind it
    // rather than overwriting a warning nobody has read yet.
    expect(bubbleTexts(events)).toEqual(['5-hour: 91% used']);
    expect(bubbleTexts(walder.onTick(T0 + NUDGE_TTL_MS))).toEqual(['Codex credits: none left']);
  });

  it('does not re-bark the credits edge after one failed poll drops the row', () => {
    const walder = new Behaviour();
    const empty = {
      ...bucket('chatgpt.codex_credits', 'Codex credits', null, 5, 'chatgpt'),
      resetsAt: null,
      kind: 'credits' as const,
      credits: { balance: 0, unlimited: false, exhausted: true }
    };
    expect(bubbleTexts(walder.onUsage(snapshot([empty]), T0))).toEqual(['Codex credits: none left']);
    walder.onPet(T0 + 1_000);
    // A poll where the ChatGPT source failed: the row is simply absent.
    expect(bubbleTexts(walder.onUsage(snapshot([]), T0 + 2_000))).toEqual([]);
    expect(bubbleTexts(walder.onUsage(snapshot([empty]), T0 + 3_000))).toEqual([]);
  });

  it('still barks about a real Fable window, which is not derived', () => {
    // The filter reads the flag, never the label: a Fable key Anthropic actually
    // reports is an allowance of its own and barks like any other.
    const walder = new Behaviour();
    const events = walder.onUsage(
      snapshot([bucket('claude.seven_day_fable', '7-day Fable', 95, 1)]),
      T0
    );
    expect(bubbleTexts(events)).toEqual(['7-day Fable: 95% used']);
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
 *     machine.active !== null  ⟺  activeBubble?.machine === true
 *
 * Both directions matter. A bark the machine still believes is on screen, whose
 * bubble this class has replaced, will have its 12 s auto-dismiss clear
 * somebody else's bubble — and its threshold is already recorded as "warned
 * about", so the warning is lost. A machine-owned bubble with no active bark is
 * a bubble nothing will ever dismiss, because only the machine emits the
 * `clear` for one.
 *
 * **The right-hand side is the `machine` flag, not the kind.** It was written
 * as `kind === 'nudge'`, which happened to be equivalent until the Codex
 * credits notice shipped: that bubble wears `kind: 'nudge'` on purpose (same
 * class of interruption, same styling) and never enters the machine, because a
 * balance has no thresholds to bookkeep. Stated on the kind, the invariant
 * reports a violation on a completely healthy credits bark — and an invariant
 * that fails on the healthy case is one somebody eventually deletes. The
 * sequence below now walks a credits bark on purpose, so the two statements
 * cannot silently diverge again: run it against `kind === 'nudge'` and the
 * "credits bark up, machine idle" step fails.
 */
describe('the bark-machine invariant', () => {
  function check(walder: Behaviour, where: string): void {
    expect(walder.nudgeMachineActive, `${where}: machine vs bubble disagree`).toBe(
      walder.bubble?.machine === true
    );
  }

  /** A Codex credits row, exhausted or not — the one non-machine `nudge`. */
  function creditsRow(exhausted: boolean): Bucket {
    return {
      ...bucket('chatgpt.codex_credits', 'Codex credits', null, 5, 'chatgpt'),
      kind: 'credits',
      credits: { balance: exhausted ? 0 : 1240, unlimited: false, exhausted }
    };
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

    /*
     * The credits bark: `kind === 'nudge'` and `machine !== true`, which is the
     * whole reason the invariant is stated on the flag. Seeded not-exhausted
     * first, because the bark fires on the false→true edge.
     */
    walder.onUsage(snapshot([creditsRow(false)]), T0 + 40_000);
    check(walder, 'credits row seeded, nothing said');
    walder.onUsage(snapshot([creditsRow(true)]), T0 + 41_000);
    check(walder, 'credits bark up, machine idle');
    expect(walder.bubble?.kind).toBe('nudge');
    expect(walder.bubble?.machine).not.toBe(true);
    expect(walder.nudgeMachineActive).toBe(false);

    // And it dismisses on this class's own clock, never the machine's — the
    // second half of why the flag has to be the test.
    walder.onTick(T0 + 41_000 + NUDGE_TTL_MS);
    check(walder, 'credits bark expired');
    expect(walder.bubble).toBeNull();
  });

  it('holds when a real bark and a credits bark are on screen in turn', () => {
    // The interesting collision: one bubble the machine owns and one it does
    // not, back to back on the same screen. Both `check`s below are false-vs-
    // false and true-vs-true only if the flag is what is being read.
    const walder = new Behaviour();
    walder.onUsage(snapshot([creditsRow(false)]), T0);
    check(walder, 'seeded');

    walder.onUsage(
      snapshot([bucket('claude.five_hour', '5-hour', 96, 0), creditsRow(true)]),
      T0 + 1_000
    );
    // The threshold bark goes first (it is the machine's), credits queued behind.
    check(walder, 'window bark shown, credits queued');
    expect(walder.bubble?.machine).toBe(true);

    walder.onPet(T0 + 2_000);
    // Petting routes to the machine, which clears — and the queued credits
    // notice is promoted into a bubble the machine has never heard of.
    check(walder, 'credits promoted over the petted bark');
    expect(walder.bubble?.kind).toBe('nudge');
    expect(walder.bubble?.machine).not.toBe(true);

    walder.onPet(T0 + 3_000);
    check(walder, 'credits petted away');
    expect(walder.bubble).toBeNull();
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

/**
 * The hide-when-idle mode: he is not on screen unless he has something to say.
 *
 * Written as sequences for the same reason as everything above, and with one
 * extra worry of its own: every bug in here is a dog who is *not there*. A
 * missed `visible:true` is a mascot that has silently stopped working, and there
 * is nothing on screen to hint at why — so each trigger for "appear" gets its
 * own case, including the two that have no bubble to ride on (`out` and
 * `confused`).
 */
describe('presence: hide when idle', () => {
  /** The mode on and the dog already gone — the starting point for most cases. */
  function hidden(opts: { levels?: number[]; lingerMs?: number } = {}): {
    walder: Behaviour;
    all: SceneEvent[];
  } {
    const walder = new Behaviour(opts);
    const all: SceneEvent[] = [];
    all.push(...walder.setHideWhenIdle(true, T0));
    expect(shape(all)).toEqual(['visible:false']);
    expect(walder.hidden).toBe(true);
    return { walder, all };
  }

  it('emits nothing at all while the mode is off', () => {
    const walder = new Behaviour();
    const all: SceneEvent[] = [
      ...walder.onUsage(fiveHour(20), T0),
      ...walder.onHook('done', T0 + 1000),
      ...walder.onPet(T0 + 2000),
      ...walder.onTick(T0 + 60_000)
    ];
    expect(all.filter((event) => event.type === 'visible')).toEqual([]);
    expect(walder.hidden).toBe(false);
    expect(walder.hideWhenIdleEnabled).toBe(false);
    // Nothing on the clock either: the linger must not run while the mode is off.
    expect(walder.nextDeadlineAt()).toBeNull();
    assertInvariants(all);
  });

  it('turning the mode on with nothing to say hides him immediately', () => {
    // A keypress or a menu tick has to act now. Eight seconds of nothing
    // happening would read as a shortcut that did not register.
    const { walder } = hidden();
    expect(walder.hideWhenIdleEnabled).toBe(true);
  });

  it('turning it on while a bubble is up waits for the bubble, then lingers', () => {
    const walder = new Behaviour();
    const all: SceneEvent[] = [];
    all.push(...walder.onHook('done', T0));

    all.push(...walder.setHideWhenIdle(true, T0 + 1000));
    // Nothing: cutting a `woof` short is the same mistake as hiding him late.
    expect(shape(walder.setHideWhenIdle(true, T0 + 1000))).toEqual([]);
    expect(walder.hidden).toBe(false);

    const cleared = walder.onTick(T0 + PERK_TTL_MS);
    all.push(...cleared);
    expect(shape(cleared)).toEqual(['bubble:none']);
    expect(walder.nextDeadlineAt()).toBe(T0 + PERK_TTL_MS + LINGER_MS);

    const gone = walder.onTick(T0 + PERK_TTL_MS + LINGER_MS);
    all.push(...gone);
    expect(shape(gone)).toEqual(['visible:false']);
    assertInvariants(all);
  });

  it('shows him for a bark, wake animation first, bubble after, window last', () => {
    const { walder, all } = hidden();
    const bark = walder.onUsage(fiveHour(82), T0 + 60_000);
    all.push(...bark);
    // No `mode`: a hidden dog is a hidden *standing* dog unless something is
    // fullscreen, so there is no box change to make. The wake is emitted anyway —
    // appearing with no animation would be a dog materialising out of nothing.
    expect(shape(bark)).toEqual([
      'expression:worried',
      'play:wake>idle',
      'play:bark>idle',
      'bubble:nudge',
      'visible:true'
    ]);
    // The order that matters, spelled out: `bubble` widens the window and
    // `visible` puts it on screen, so a `visible:true` in front of the bubble
    // shows one frame of a narrow, bubble-less dog.
    expect(shape(bark).indexOf('visible:true')).toBeGreaterThan(
      shape(bark).indexOf('bubble:nudge')
    );
    expect(bubbleTexts(bark)).toEqual(['5-hour: 82% used']);
    expect(walder.hidden).toBe(false);
    // Nothing on the linger clock while a bubble is up.
    expect(walder.nextDeadlineAt()).toBe(T0 + 60_000 + NUDGE_TTL_MS);
    assertInvariants(all);
  });

  it('leaves 8 s after the bubble clears, and a pet restarts those 8 s', () => {
    const { walder, all } = hidden();
    const perk = walder.onHook('done', T0 + 1000);
    all.push(...perk);
    // The perk-while-hidden order, the same rule as the bark: bubble first, then
    // the window goes on screen around it.
    expect(shape(perk)).toEqual(['play:wake>idle', 'play:perk>idle', 'bubble:perk', 'visible:true']);

    const cleared = walder.onTick(T0 + 1000 + PERK_TTL_MS);
    all.push(...cleared);
    expect(shape(cleared)).toEqual(['bubble:none']);
    const firstDeadline = T0 + 1000 + PERK_TTL_MS + LINGER_MS;
    expect(walder.nextDeadlineAt()).toBe(firstDeadline);

    // Petting him two seconds before he would have gone.
    const pet = walder.onPet(firstDeadline - 2000);
    all.push(...pet);
    expect(shape(pet)).toEqual(['play:pet>idle']);
    expect(walder.nextDeadlineAt()).toBe(firstDeadline - 2000 + LINGER_MS);

    // The old deadline passes and he is still there.
    expect(shape(walder.onTick(firstDeadline))).toEqual([]);
    expect(walder.hidden).toBe(false);

    const gone = walder.onTick(firstDeadline - 2000 + LINGER_MS);
    all.push(...gone);
    expect(shape(gone)).toEqual(['visible:false']);
    assertInvariants(all);
  });

  it('leaves at exactly LINGER_MS, not a tick before', () => {
    const { walder } = hidden();
    walder.onHook('done', T0 + 1000);
    walder.onTick(T0 + 1000 + PERK_TTL_MS);
    const due = T0 + 1000 + PERK_TTL_MS + LINGER_MS;
    expect(shape(walder.onTick(due - 1))).toEqual([]);
    expect(walder.hidden).toBe(false);
    expect(shape(walder.onTick(due))).toEqual(['visible:false']);
  });

  it('a bark during the linger keeps him up and restarts the countdown', () => {
    const { walder, all } = hidden();
    // A `woof` brings him out, and its expiry starts the eight seconds.
    all.push(...walder.onHook('done', T0 + 1000));
    all.push(...walder.onTick(T0 + 1000 + PERK_TTL_MS));
    expect(walder.hidden).toBe(false);
    expect(walder.nextDeadlineAt()).toBe(T0 + 1000 + PERK_TTL_MS + LINGER_MS);

    const barkAt = T0 + 1000 + PERK_TTL_MS + 2000;
    const bark = walder.onUsage(fiveHour(82), barkAt);
    all.push(...bark);
    // Already on screen: no second `visible:true`, and no wake.
    expect(shape(bark)).toEqual(['expression:worried', 'play:bark>idle', 'bubble:nudge']);
    // The linger is off the clock entirely while the bark is up.
    expect(walder.nextDeadlineAt()).toBe(barkAt + NUDGE_TTL_MS);
    // …and starts again from the moment it clears, not from where it was.
    all.push(...walder.onTick(barkAt + NUDGE_TTL_MS));
    expect(walder.nextDeadlineAt()).toBe(barkAt + NUDGE_TTL_MS + LINGER_MS);
    assertInvariants(all);
  });

  it('a snapshot with nothing to say leaves a hidden dog hidden', () => {
    const { walder } = hidden();
    // No bubble, no "needs you" face: nothing here is a reason to appear, and a
    // dog who popped up for every three-minute poll would be the whole point of
    // the mode undone.
    expect(shape(walder.onUsage(fiveHour(20), T0 + 1000))).toEqual(['expression:happy']);
    expect(walder.hidden).toBe(true);
    expect(walder.nextDeadlineAt()).toBeNull();
  });

  it('shows him when the face turns *out*, which has no bubble of its own', () => {
    // `levels: []` removes the barks, so the only thing that could bring him
    // back is the face itself.
    const { walder, all } = hidden({ levels: [] });
    const spent = walder.onUsage(fiveHour(100), T0 + 1000);
    all.push(...spent);
    expect(shape(spent)).toEqual(['expression:out', 'play:wake>idle', 'visible:true']);
    expect(walder.nextDeadlineAt()).toBe(T0 + 1000 + LINGER_MS);
    assertInvariants(all);
  });

  it('shows him once when the face turns confused, and not again on every poll', () => {
    const { walder, all } = hidden({ levels: [] });

    const broken = walder.onUsage(snapshot([]), T0 + 1000);
    all.push(...broken);
    expect(shape(broken)).toEqual(['expression:confused', 'play:wake>idle', 'visible:true']);

    all.push(...walder.onTick(T0 + 1000 + LINGER_MS));
    expect(walder.hidden).toBe(true);

    // Three minutes later the login is still broken. He does not come back to
    // say so again: the face has not *changed*.
    expect(shape(walder.onUsage(snapshot([]), T0 + 200_000))).toEqual([]);
    expect(walder.hidden).toBe(true);
    assertInvariants(all);
  });

  it('does not show him for a face that is merely worrying', () => {
    const { walder } = hidden({ levels: [] });
    // 90 % is the worried face and 96 % the exhausted one. Both are bad news,
    // and both have a bark to announce them — which is suppressed here. Only
    // *out* and *confused* bring him back on the face alone: the first means the
    // allowance is gone, the second that he cannot read it at all.
    expect(shape(walder.onUsage(fiveHour(90), T0 + 1000))).toEqual(['expression:worried']);
    expect(walder.hidden).toBe(true);
    expect(shape(walder.onUsage(fiveHour(96), T0 + 2000))).toEqual(['expression:exhausted']);
    expect(walder.hidden).toBe(true);
  });

  it('turning the mode off shows him with no wake animation', () => {
    const { walder, all } = hidden();
    const back = walder.setHideWhenIdle(false, T0 + 1000);
    all.push(...back);
    // He was never asleep — the window was hidden — so a stretch-and-stand here
    // would read as an animation glitch.
    expect(shape(back)).toEqual(['visible:true']);
    expect(walder.hidden).toBe(false);
    expect(walder.nextDeadlineAt()).toBeNull();
    // Setting it to what it already is changes nothing.
    expect(shape(walder.setHideWhenIdle(false, T0 + 2000))).toEqual([]);
    assertInvariants(all);
  });

  it('sleeps on the hidden window during fullscreen, and stands to bark', () => {
    const { walder, all } = hidden();

    const film = walder.setFullscreen(true, T0 + 1000);
    all.push(...film);
    // The box changes on a window nobody can see, which is right: the resize has
    // to have happened before he is shown.
    expect(shape(film)).toEqual(['mode:sleep', 'play:sleep>sleep']);
    expect(walder.hidden).toBe(true);

    const bark = walder.onUsage(fiveHour(82), T0 + 2000);
    all.push(...bark);
    expect(shape(bark)).toEqual([
      'expression:worried',
      'mode:stand',
      'play:wake>idle',
      'play:bark>idle',
      'bubble:nudge',
      'visible:true'
    ]);

    // He does *not* curl up the instant the bark clears: he is still on screen,
    // and a dog on screen stands. The eight seconds run in the standing box.
    const cleared = walder.onTick(T0 + 2000 + NUDGE_TTL_MS);
    all.push(...cleared);
    expect(shape(cleared)).toEqual(['bubble:none']);
    expect(walder.box).toBe('stand');

    // And then both halves happen together, in this order: the window goes off
    // screen first, and the resize back to the tiny sleeping box happens behind
    // it rather than in front of the owner.
    const gone = walder.onTick(T0 + 2000 + NUDGE_TTL_MS + LINGER_MS);
    all.push(...gone);
    expect(shape(gone)).toEqual(['visible:false', 'mode:sleep', 'play:sleep>sleep']);
    expect(walder.box).toBe('sleep');
    assertInvariants(all);
  });

  it('a film that starts during the linger leaves him standing until he goes', () => {
    // The same rule from the other side. Curling him up under the owner's eyes
    // and *then* hiding him is two visible changes where one will do.
    const walder = new Behaviour();
    const all: SceneEvent[] = [];
    all.push(...walder.onHook('done', T0));
    all.push(...walder.setHideWhenIdle(true, T0 + 500));

    const cleared = walder.onTick(T0 + PERK_TTL_MS);
    all.push(...cleared);
    expect(shape(cleared)).toEqual(['bubble:none']);
    const lingerDue = T0 + PERK_TTL_MS + LINGER_MS;
    expect(walder.nextDeadlineAt()).toBe(lingerDue);

    const film = walder.setFullscreen(true, T0 + PERK_TTL_MS + 1000);
    all.push(...film);
    expect(shape(film)).toEqual([]);
    expect(walder.box).toBe('stand');
    // The film did not touch the countdown either.
    expect(walder.nextDeadlineAt()).toBe(lingerDue);

    const gone = walder.onTick(lingerDue);
    all.push(...gone);
    expect(shape(gone)).toEqual(['visible:false', 'mode:sleep', 'play:sleep>sleep']);
    assertInvariants(all);
  });

  it('nextDeadlineAt is the earlier of the bubble and the linger', () => {
    // A bubble cancels the linger, so in practice only one of the two clocks
    // runs at a time — what is pinned here is that whichever it is reaches the
    // single timer in `main/behaviour.ts`, and that the `min` never returns the
    // clock that is not running.
    const { walder } = hidden();
    walder.onHook('done', T0 + 1000);
    // Bubble up: its ttl is the only deadline, and the linger is off the clock.
    expect(walder.nextDeadlineAt()).toBe(T0 + 1000 + PERK_TTL_MS);

    walder.onTick(T0 + 1000 + PERK_TTL_MS);
    // Bubble gone: now the linger is the only deadline.
    expect(walder.nextDeadlineAt()).toBe(T0 + 1000 + PERK_TTL_MS + LINGER_MS);

    walder.onTick(T0 + 1000 + PERK_TTL_MS + LINGER_MS);
    // Hidden with nothing to say: no clock at all, which is what keeps an idle
    // Walder from waking the CPU.
    expect(walder.hidden).toBe(true);
    expect(walder.nextDeadlineAt()).toBeNull();
  });

  /**
   * The expression path, which is the one trigger for "appear" with no bubble to
   * ride on — and the one that used to get the box wrong.
   */
  it('stands up before appearing when the face turns confused mid-film', () => {
    const { walder, all } = hidden({ levels: [] });
    all.push(...walder.setFullscreen(true, T0 + 500));
    expect(walder.box).toBe('sleep');

    const broken = walder.onUsage(fiveHour(null), T0 + 1000);
    all.push(...broken);
    // `mode:stand` before `play:wake` before `visible:true`. Any other order is
    // a stand-box animation inside the tiny sleeping window, drawn on top of the
    // video the owner is watching.
    const order = shape(broken);
    expect(order).toEqual([
      'expression:confused',
      'mode:stand',
      'play:wake>idle',
      'visible:true'
    ]);
    expect(order.indexOf('mode:stand')).toBeLessThan(order.indexOf('play:wake>idle'));
    expect(order.indexOf('play:wake>idle')).toBeLessThan(order.indexOf('visible:true'));
    expect(walder.box).toBe('stand');
    expect(walder.hidden).toBe(false);

    // He lingers standing — not curled up again a millisecond after standing —
    // and then leaves and sleeps in the same batch.
    expect(walder.nextDeadlineAt()).toBe(T0 + 1000 + LINGER_MS);
    const gone = walder.onTick(T0 + 1000 + LINGER_MS);
    all.push(...gone);
    expect(shape(gone)).toEqual(['visible:false', 'mode:sleep', 'play:sleep>sleep']);
    expect(walder.box).toBe('sleep');
    expect(walder.hidden).toBe(true);
    assertInvariants(all);
  });

  it('does not stand a visible dog up when the face turns confused mid-film', () => {
    // The other half of `askForAttention`: with the mode off there is nothing to
    // appear for, so the face must not produce a stand-up-and-sit-down flicker.
    const walder = new Behaviour({ levels: [] });
    walder.onUsage(fiveHour(20), T0);
    const all: SceneEvent[] = [...walder.setFullscreen(true, T0 + 1000)];
    expect(shape(all)).toEqual(['mode:sleep', 'play:sleep>sleep']);

    const broken = walder.onUsage(fiveHour(null), T0 + 2000);
    all.push(...broken);
    expect(shape(broken)).toEqual(['expression:confused']);
    expect(walder.box).toBe('sleep');
    assertInvariants(all);
  });

  it('constructing with the mode on lingers rather than hiding at once', () => {
    // Which is exactly why `main/behaviour.ts` constructs with the mode *off* and
    // then calls the setter: only the setter makes the first batch hide him.
    const walder = new Behaviour({ hideWhenIdle: true });
    expect(walder.hideWhenIdleEnabled).toBe(true);
    expect(walder.hidden).toBe(false);
    expect(shape(walder.onUsage(fiveHour(20), T0))).toEqual(['expression:happy']);
    expect(walder.nextDeadlineAt()).toBe(T0 + LINGER_MS);
    expect(shape(walder.onTick(T0 + LINGER_MS))).toEqual(['visible:false']);
  });

  it('honours a shortened linger, so the wiring can be tested quickly', () => {
    const { walder } = hidden({ lingerMs: 500 });
    walder.setHideWhenIdle(false, T0 + 1);
    walder.onUsage(fiveHour(20), T0 + 2);
    walder.setHideWhenIdle(true, T0 + 3);
    expect(walder.hidden).toBe(true);
  });
});

/**
 * The once-per-version "a new Walder is out" bubble.
 *
 * The *decision* to say it at all lives in `index.ts` (it remembers the version
 * it has notified about); what is pinned here is that it is the politest bubble
 * in the app — last in the queue, never re-queued once a bark has taken the
 * screen from it, and gone after twelve seconds.
 */
describe('the update notice', () => {
  it('says the version and perks his ears', () => {
    const walder = new Behaviour();
    const events = walder.onUpdateAvailable('0.1.3', T0);
    expect(shape(events)).toEqual(['play:perk>idle', 'bubble:update']);
    expect(bubbleTexts(events)).toEqual(['0.1.3 is out']);
    expect(walder.bubble?.kind).toBe('update');
  });

  it('is gone after 12 seconds', () => {
    const walder = new Behaviour();
    walder.onUpdateAvailable('0.1.3', T0);
    expect(walder.nextDeadlineAt()).toBe(T0 + UPDATE_TTL_MS);
    expect(shape(walder.onTick(T0 + UPDATE_TTL_MS - 1))).toEqual([]);
    expect(shape(walder.onTick(T0 + UPDATE_TTL_MS))).toEqual(['bubble:none']);
  });

  it('waits behind a `woof` that is already on screen', () => {
    const walder = new Behaviour();
    walder.onHook('done', T0);
    expect(shape(walder.onUpdateAvailable('0.1.3', T0 + 100))).toEqual([]);
    expect(shape(walder.onTick(T0 + PERK_TTL_MS))).toEqual([
      'bubble:none',
      'play:perk>idle',
      'bubble:update'
    ]);
  });

  it('lets a hook that arrives later jump ahead of it in the queue', () => {
    // The reason: a `woof` or a `?` is about what the owner is doing this second,
    // and the update notice has already waited six hours.
    const walder = new Behaviour();
    walder.onHook('waiting', T0);
    walder.onUpdateAvailable('0.1.3', T0 + 1000);
    walder.onHook('done', T0 + 2000);

    const typed = walder.onHook('prompt', T0 + 3000);
    expect(shape(typed)).toEqual(['bubble:none', 'play:perk>idle', 'bubble:perk']);
    expect(bubbleTexts(typed)).toEqual(['woof']);

    // And the notice is still there, behind it.
    const later = walder.onTick(T0 + 3000 + PERK_TTL_MS);
    expect(bubbleTexts(later)).toEqual(['0.1.3 is out']);
  });

  it('queues at most one, and the newest version wins', () => {
    const walder = new Behaviour();
    walder.onHook('waiting', T0);
    walder.onUpdateAvailable('0.1.3', T0 + 1000);
    walder.onUpdateAvailable('0.2.0', T0 + 2000);
    const promoted = walder.onHook('prompt', T0 + 3000);
    expect(bubbleTexts(promoted)).toEqual(['0.2.0 is out']);
    // One bubble, not two: the older notice was replaced, not stacked.
    expect(shape(walder.onTick(T0 + 3000 + UPDATE_TTL_MS))).toEqual(['bubble:none']);
  });

  it('is outranked by a bark, and is not re-queued afterwards', () => {
    const walder = new Behaviour();
    walder.onUsage(fiveHour(20), T0);
    walder.onUpdateAvailable('0.1.3', T0 + 1000);

    const bark = walder.onUsage(fiveHour(82), T0 + 2000);
    expect(shape(bark)).toEqual(['expression:worried', 'play:bark>idle', 'bubble:nudge']);

    // A notice shown after the fact is worse than none: the menu carries it
    // permanently, so the bubble has done all the work it is going to do.
    expect(shape(walder.onTick(T0 + 2000 + NUDGE_TTL_MS))).toEqual(['bubble:none']);
    expect(walder.bubble).toBeNull();
  });

  it('is dismissed by a click like any other bubble', () => {
    const walder = new Behaviour();
    walder.onUpdateAvailable('0.1.3', T0);
    expect(shape(walder.onPet(T0 + 1000))).toEqual(['play:pet>idle', 'bubble:none']);
    expect(walder.bubble).toBeNull();
    expect(walder.nextDeadlineAt()).toBeNull();
  });

  it('brings a hidden dog back for it', () => {
    const walder = new Behaviour();
    const all: SceneEvent[] = [...walder.setHideWhenIdle(true, T0)];
    const shown = walder.onUpdateAvailable('0.1.3', T0 + 1000);
    all.push(...shown);
    expect(shape(shown)).toEqual([
      'play:wake>idle',
      'play:perk>idle',
      'bubble:update',
      'visible:true'
    ]);
    // The window is put on screen after the bubble it has to make room for.
    expect(shape(shown).indexOf('visible:true')).toBeGreaterThan(
      shape(shown).indexOf('bubble:update')
    );
    const gone = walder.onTick(T0 + 1000 + UPDATE_TTL_MS + LINGER_MS);
    all.push(...walder.onTick(T0 + 1000 + UPDATE_TTL_MS), ...gone);
    assertInvariants(all);
  });
});

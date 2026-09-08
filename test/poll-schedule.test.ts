/**
 * Poll scheduling: the arithmetic that keeps Walder from becoming a nuisance to
 * the services it reads.
 *
 * All of it is pure, which is the point — "does a 429 really back off to fifteen
 * minutes" is a unit test here instead of a fifteen-minute wait with a stopwatch,
 * and the floor that stops a hand-edited settings file from polling every second
 * is provable rather than hoped for.
 */
import { describe, expect, it } from 'vitest';
import {
  ERROR_CAP_MS,
  JITTER_SEC,
  MANUAL_COOLDOWN_MS,
  MIN_POLL_SEC,
  RATE_LIMIT_CAP_MS,
  advanceSchedule,
  backsOff,
  baseIntervalMs,
  delayForStatus,
  initialSchedule,
  isDue,
  jitter,
  manualAllowed,
  manualCooldownRemainingMs,
  nextTickDelayMs,
  scheduleNow
} from '../src/core/poll-schedule';

const BASE = MIN_POLL_SEC * 1000;
const NOW = 1_700_000_000_000;

describe('baseIntervalMs', () => {
  it('uses the stored preference when it is above the floor', () => {
    expect(baseIntervalMs(600)).toBe(600_000);
  });

  it('floors anything faster at 180 s', () => {
    // These are unofficial endpoints on the owner's own account: polling every
    // ten seconds looks like abuse and gets the account rate-limited, which is
    // the one failure the owner cannot fix.
    expect(baseIntervalMs(10)).toBe(BASE);
    expect(baseIntervalMs(0)).toBe(BASE);
    expect(baseIntervalMs(-500)).toBe(BASE);
  });

  it('falls back to the floor for a value that is not a number', () => {
    // Never to something *faster*: a corrupt setting must fail safe.
    expect(baseIntervalMs(undefined)).toBe(BASE);
    expect(baseIntervalMs('fast')).toBe(BASE);
    expect(baseIntervalMs(Number.NaN)).toBe(BASE);
    expect(baseIntervalMs(Number.POSITIVE_INFINITY)).toBe(BASE);
  });
});

describe('jitter', () => {
  it('spreads a delay by at most ±10 s', () => {
    expect(jitter(BASE, 0)).toBe(BASE - JITTER_SEC * 1000);
    expect(jitter(BASE, 0.5)).toBe(BASE);
    expect(jitter(BASE, 0.999)).toBeLessThanOrEqual(BASE + JITTER_SEC * 1000);
  });

  it('never returns a delay under a second', () => {
    // A negative or zero delay in a re-arming timer is a tight loop.
    expect(jitter(500, 0)).toBe(1000);
    expect(jitter(0, 0)).toBe(1000);
  });
});

describe('delayForStatus', () => {
  it('is the plain interval for ok', () => {
    expect(delayForStatus(BASE, 'ok', 0)).toBe(BASE);
  });

  it('does not back off for auth-needed or endpoint-changed', () => {
    // Both are fixed by something outside this process — the owner logging in,
    // or the endpoint coming back — and both are cheap 401/404 answers. Backing
    // off would leave the panel saying "logged out" for a quarter of an hour
    // after the owner had logged in.
    expect(backsOff('auth-needed')).toBe(false);
    expect(backsOff('endpoint-changed')).toBe(false);
    expect(backsOff('unavailable')).toBe(false);
    expect(delayForStatus(BASE, 'auth-needed', 3)).toBe(BASE);
    expect(delayForStatus(BASE, 'endpoint-changed', 3)).toBe(BASE);
  });

  it('doubles from the first rate-limited answer, capped at 15 min', () => {
    // Waiting the normal interval after being told "too many requests" is not a
    // backoff, so failure #1 already doubles.
    expect(delayForStatus(BASE, 'rate-limited', 1)).toBe(BASE * 2);
    expect(delayForStatus(BASE, 'rate-limited', 2)).toBe(BASE * 4);
    expect(delayForStatus(BASE, 'rate-limited', 3)).toBe(RATE_LIMIT_CAP_MS);
    expect(delayForStatus(BASE, 'rate-limited', 50)).toBe(RATE_LIMIT_CAP_MS);
  });

  it('doubles on error, capped at 10 min', () => {
    expect(delayForStatus(BASE, 'error', 1)).toBe(BASE * 2);
    expect(delayForStatus(BASE, 'error', 2)).toBe(ERROR_CAP_MS);
    expect(delayForStatus(BASE, 'error', 99)).toBe(ERROR_CAP_MS);
  });

  it('caps lower for error than for rate-limited', () => {
    expect(ERROR_CAP_MS).toBeLessThan(RATE_LIMIT_CAP_MS);
  });
});

describe('advanceSchedule', () => {
  const mid = 0.5; // no jitter, for readable arithmetic

  it('schedules the plain interval after a good poll', () => {
    const next = advanceSchedule(initialSchedule(NOW), 'ok', BASE, NOW, mid);
    expect(next).toEqual({ failures: 0, nextDueAt: NOW + BASE });
  });

  it('counts consecutive failures and backs off further each time', () => {
    let schedule = initialSchedule(NOW);
    schedule = advanceSchedule(schedule, 'rate-limited', BASE, NOW, mid);
    expect(schedule).toEqual({ failures: 1, nextDueAt: NOW + BASE * 2 });

    schedule = advanceSchedule(schedule, 'rate-limited', BASE, NOW, mid);
    expect(schedule).toEqual({ failures: 2, nextDueAt: NOW + BASE * 4 });
  });

  it('shares one counter between rate-limited and error', () => {
    // A service that alternates between the two is failing continuously;
    // resetting the count on each switch would let it be polled at the base
    // rate forever.
    let schedule = initialSchedule(NOW);
    schedule = advanceSchedule(schedule, 'error', BASE, NOW, mid);
    schedule = advanceSchedule(schedule, 'rate-limited', BASE, NOW, mid);
    expect(schedule.failures).toBe(2);
  });

  it('clears the failure count as soon as a poll succeeds', () => {
    let schedule = { failures: 4, nextDueAt: NOW };
    schedule = advanceSchedule(schedule, 'ok', BASE, NOW, mid);
    expect(schedule).toEqual({ failures: 0, nextDueAt: NOW + BASE });
  });

  it('clears it on auth-needed too, so a login is picked up promptly', () => {
    let schedule = { failures: 4, nextDueAt: NOW };
    schedule = advanceSchedule(schedule, 'auth-needed', BASE, NOW, mid);
    expect(schedule).toEqual({ failures: 0, nextDueAt: NOW + BASE });
  });

  it('applies jitter to the scheduled time', () => {
    const early = advanceSchedule(initialSchedule(NOW), 'ok', BASE, NOW, 0);
    const late = advanceSchedule(initialSchedule(NOW), 'ok', BASE, NOW, 1);
    expect(early.nextDueAt).toBeLessThan(late.nextDueAt);
    expect(late.nextDueAt - early.nextDueAt).toBeLessThanOrEqual(2 * JITTER_SEC * 1000);
  });
});

describe('due times and the next tick', () => {
  it('makes a fresh service due immediately', () => {
    expect(isDue(initialSchedule(NOW), NOW)).toBe(true);
  });

  it('is not due before its time', () => {
    expect(isDue({ failures: 0, nextDueAt: NOW + 1000 }, NOW)).toBe(false);
    expect(isDue({ failures: 0, nextDueAt: NOW + 1000 }, NOW + 1000)).toBe(true);
  });

  it('sleeps until the earliest due service', () => {
    // One timer, two independently scheduled services: a backed-off ChatGPT
    // must not drag Claude's cadence with it.
    const schedules = [
      { failures: 3, nextDueAt: NOW + RATE_LIMIT_CAP_MS },
      { failures: 0, nextDueAt: NOW + BASE }
    ];
    expect(nextTickDelayMs(schedules, NOW)).toBe(BASE);
  });

  it('never returns zero or a negative delay', () => {
    expect(nextTickDelayMs([{ failures: 0, nextDueAt: NOW - 99_999 }], NOW)).toBe(1);
  });

  it('is null with no services at all', () => {
    expect(nextTickDelayMs([], NOW)).toBeNull();
  });

  it('scheduleNow makes a service due while keeping its failure count', () => {
    // A manual refresh should poll immediately without pretending the service
    // has recovered.
    expect(scheduleNow({ failures: 3, nextDueAt: NOW + 1e6 }, NOW)).toEqual({
      failures: 3,
      nextDueAt: NOW
    });
  });
});

describe('manual refresh cooldown', () => {
  it('allows the first refresh', () => {
    expect(manualAllowed(null, NOW)).toBe(true);
    expect(manualCooldownRemainingMs(null, NOW)).toBe(0);
  });

  it('blocks a second refresh inside 60 s', () => {
    expect(manualAllowed(NOW, NOW + 1000)).toBe(false);
    expect(manualCooldownRemainingMs(NOW, NOW + 1000)).toBe(MANUAL_COOLDOWN_MS - 1000);
  });

  it('allows one again exactly on the boundary', () => {
    expect(manualAllowed(NOW, NOW + MANUAL_COOLDOWN_MS)).toBe(true);
    expect(manualCooldownRemainingMs(NOW, NOW + MANUAL_COOLDOWN_MS)).toBe(0);
  });

  it('never reports a negative remaining time', () => {
    expect(manualCooldownRemainingMs(NOW, NOW + 10 * MANUAL_COOLDOWN_MS)).toBe(0);
  });
});

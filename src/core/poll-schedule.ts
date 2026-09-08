/**
 * When to poll next. Pure arithmetic — no timers, no clock of its own.
 *
 * Every number here exists to keep Walder from becoming a nuisance to the
 * services it reads:
 *
 *  - **A floor of 180 s**, whatever the settings file says. These are unofficial
 *    endpoints on the owner's own account; a mascot that polled every ten
 *    seconds would look like abuse and get the account rate-limited, which is
 *    the one failure the owner cannot fix.
 *  - **±10 s of jitter**, so that a machine which wakes several Walders (or one
 *    Walder after a long sleep) does not fire every service at the same instant
 *    forever.
 *  - **Exponential backoff per service**, doubling from the base interval: to 15
 *    minutes on `rate-limited` (the service has explicitly told us to stop) and
 *    to 10 minutes on `error` (a server problem that is probably transient).
 *  - **No backoff on `auth-needed` or `endpoint-changed`.** Both are fixed by
 *    something outside this process — the owner logging in, or the endpoint
 *    coming back — and both are cheap 401/404 answers. Backing off would mean
 *    the panel keeps saying "logged out" for a quarter of an hour after the
 *    owner has logged in.
 *  - **A 60 s floor on manual refresh**, so the tray item cannot be used to
 *    hammer the endpoints by hand.
 *
 * Backoff is per service, so a rate-limited ChatGPT does not slow Claude down.
 * The poller keeps one `ServiceSchedule` each and arms a single timer for the
 * earliest due time.
 */
import type { SourceStatus } from './buckets';

/** Never poll faster than this, whatever the settings say. */
export const MIN_POLL_SEC = 180;
/** Half-width of the jitter window, in seconds. */
export const JITTER_SEC = 10;

export const RATE_LIMIT_CAP_MS = 15 * 60_000;
export const ERROR_CAP_MS = 10 * 60_000;

/** Manual "Refresh now" may not run more often than this. */
export const MANUAL_COOLDOWN_MS = 60_000;

/**
 * The base interval in milliseconds: the stored preference, floored at
 * `MIN_POLL_SEC`. A missing, non-finite or absurd value falls back to the floor
 * rather than to something faster.
 */
export function baseIntervalMs(pollIntervalSec: unknown): number {
  const seconds =
    typeof pollIntervalSec === 'number' && Number.isFinite(pollIntervalSec)
      ? pollIntervalSec
      : MIN_POLL_SEC;
  return Math.max(MIN_POLL_SEC, Math.floor(seconds)) * 1000;
}

/**
 * Apply jitter to a delay. `rand` is a value in [0, 1) — injected rather than
 * taken from `Math.random`, so the spread is testable.
 *
 * Clamped at 1 s: with jitter wider than the delay (only possible if a caller
 * passes a tiny base), a negative delay would fire in a tight loop.
 */
export function jitter(delayMs: number, rand: number): number {
  const offset = (rand * 2 - 1) * JITTER_SEC * 1000;
  return Math.max(1000, Math.round(delayMs + offset));
}

/**
 * Consecutive-failure counter, and the cap that applies to it.
 *
 * `rate-limited` and `error` share one counter deliberately: a service that
 * alternates between the two is failing continuously, and resetting the count on
 * each switch would let it be polled at the base rate forever.
 */
export interface ServiceSchedule {
  /** Consecutive backoff-worthy failures; 0 when the last poll was fine. */
  readonly failures: number;
  /** Epoch ms when this service may next be polled. */
  readonly nextDueAt: number;
}

/** Does this status double the delay? */
export function backsOff(status: SourceStatus): boolean {
  return status === 'rate-limited' || status === 'error';
}

/** The ceiling for a status's backoff. */
function capFor(status: SourceStatus): number {
  return status === 'rate-limited' ? RATE_LIMIT_CAP_MS : ERROR_CAP_MS;
}

/**
 * The delay after a poll that ended with `status`, having failed `failures`
 * times in a row *including* this one.
 *
 * `failures = 1` is the first failure and already doubles: waiting the normal
 * interval after being told "too many requests" is not a backoff.
 */
export function delayForStatus(baseMs: number, status: SourceStatus, failures: number): number {
  if (!backsOff(status) || failures <= 0) return baseMs;
  const doubled = baseMs * 2 ** failures;
  return Math.min(doubled, capFor(status));
}

/** A service that has never been polled: due immediately. */
export function initialSchedule(now: number): ServiceSchedule {
  return { failures: 0, nextDueAt: now };
}

/**
 * The schedule after a poll finished with `status` at `now`.
 *
 * A success (or a non-backoff failure) clears the failure count, so one 429
 * cannot leave a service throttled after it recovers.
 */
export function advanceSchedule(
  previous: ServiceSchedule,
  status: SourceStatus,
  baseMs: number,
  now: number,
  rand: number
): ServiceSchedule {
  const failures = backsOff(status) ? previous.failures + 1 : 0;
  const delay = jitter(delayForStatus(baseMs, status, failures), rand);
  return { failures, nextDueAt: now + delay };
}

/** Force a service to be polled on the next tick (manual refresh). */
export function scheduleNow(previous: ServiceSchedule, now: number): ServiceSchedule {
  return { failures: previous.failures, nextDueAt: now };
}

/** Is this service due? */
export function isDue(schedule: ServiceSchedule, now: number): boolean {
  return schedule.nextDueAt <= now;
}

/**
 * How long to sleep before the next tick: until the earliest due service, never
 * negative, and never zero (a zero-delay timer in a loop starves the event
 * loop). `null` when there are no services at all.
 */
export function nextTickDelayMs(
  schedules: readonly ServiceSchedule[],
  now: number
): number | null {
  if (schedules.length === 0) return null;
  let earliest = Number.POSITIVE_INFINITY;
  for (const schedule of schedules) {
    if (schedule.nextDueAt < earliest) earliest = schedule.nextDueAt;
  }
  return Math.max(1, earliest - now);
}

/* ------------------------------------------------------------ manual refresh */

/** May a manual refresh run now? `null` = never refreshed manually yet. */
export function manualAllowed(lastManualAt: number | null, now: number): boolean {
  if (lastManualAt === null) return true;
  return now - lastManualAt >= MANUAL_COOLDOWN_MS;
}

/** Milliseconds left on the manual cooldown; 0 when a refresh is allowed. */
export function manualCooldownRemainingMs(lastManualAt: number | null, now: number): number {
  if (lastManualAt === null) return 0;
  return Math.max(0, MANUAL_COOLDOWN_MS - (now - lastManualAt));
}

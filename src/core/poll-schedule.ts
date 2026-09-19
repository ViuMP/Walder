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
 *  - **`Retry-After` as a floor, never a ceiling.** A server that names a wait
 *    longer than our own backoff gets it; one that names a shorter wait (or
 *    `Retry-After: 0`, which is what Anthropic answers) does not get to shorten
 *    ours — obeying that literally would poll straight back into the limit and
 *    keep it alive.
 *  - **Backoff survives a relaunch** (`restoreSchedules`). Held only in memory,
 *    a penalty was cleared by quitting the app, so a rate-limited owner who
 *    restarted Walder to "fix" it was re-arming the very limit he was waiting
 *    out.
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

/**
 * The longest wait a server may talk us into, and the longest stored penalty
 * that is still believed at launch.
 *
 * ponytail: six hours is a flat ceiling on `Retry-After`, chosen because a
 * server that says "come back in a week" is either wrong or hostile and Walder
 * is a mascot, not a batch job. The cost is that a genuine week-long lockout is
 * re-probed every six hours. Upgrade path: surface the remaining wait on the
 * card, and the ceiling stops being a guess the owner cannot see.
 */
export const RETRY_AFTER_CEILING_MS = 6 * 60 * 60_000;

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
 *
 * `serverFloorMs` is what the response's `Retry-After` asked for, and it can
 * only ever push the delay *up* — past the cap, if the server wants a longer
 * wait than ours, and up to `RETRY_AFTER_CEILING_MS` but no further. It is
 * ignored for a status that does not back off at all: a 401 carrying a
 * `Retry-After` must not keep the panel saying "logged out" after the owner has
 * logged in.
 */
export function delayForStatus(
  baseMs: number,
  status: SourceStatus,
  failures: number,
  serverFloorMs = 0
): number {
  if (!backsOff(status) || failures <= 0) return baseMs;
  const doubled = baseMs * 2 ** failures;
  const floor = Math.min(Math.max(0, serverFloorMs), RETRY_AFTER_CEILING_MS);
  return Math.max(Math.min(doubled, capFor(status)), floor);
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
  rand: number,
  retryAfterMs?: number
): ServiceSchedule {
  const failures = backsOff(status) ? previous.failures + 1 : 0;
  const delay = jitter(delayForStatus(baseMs, status, failures, retryAfterMs), rand);
  return { failures, nextDueAt: now + delay };
}

/**
 * The two schedules read back from the settings file at launch.
 *
 * A backoff that lives only in memory is a backoff the owner clears by quitting
 * — and quitting is exactly what someone does when the app seems stuck, so
 * Walder was re-arming the rate limit it was meant to be waiting out. Restoring
 * it means a relaunch mid-penalty simply waits.
 *
 * Everything else here is distrust of a user-writable file, and each rejection
 * costs at most one early poll: a penalty whose time has already passed, a
 * `nextDueAt` further out than the ceiling (a hand-typed year, or a clock that
 * has moved backwards), a failure count that is not a positive whole number —
 * all fall back to "due now", which is what a fresh install does anyway.
 */
export function restoreSchedules(
  raw: unknown,
  now: number
): Record<'claude' | 'chatgpt', ServiceSchedule> {
  const stored = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const one = (name: string): ServiceSchedule => {
    const entry = stored[name];
    if (typeof entry !== 'object' || entry === null) return initialSchedule(now);
    const { failures, nextDueAt } = entry as { failures?: unknown; nextDueAt?: unknown };
    if (typeof failures !== 'number' || !Number.isInteger(failures) || failures <= 0) {
      return initialSchedule(now);
    }
    if (typeof nextDueAt !== 'number' || !Number.isFinite(nextDueAt)) return initialSchedule(now);
    if (nextDueAt <= now || nextDueAt > now + RETRY_AFTER_CEILING_MS) return initialSchedule(now);
    return { failures, nextDueAt };
  };
  return { claude: one('claude'), chatgpt: one('chatgpt') };
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

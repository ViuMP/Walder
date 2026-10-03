/**
 * The poll loop: one timer, two independently scheduled services.
 *
 * Structure worth knowing before changing anything here:
 *
 *  - **The arithmetic is not in this file.** Intervals, jitter, backoff and the
 *    manual-refresh cooldown are pure functions in `core/poll-schedule.ts`;
 *    this is the timer, the state and the I/O around them. That split is what
 *    makes "does a 429 really back off to 15 minutes" a unit test rather than a
 *    15-minute wait.
 *  - **One timer, not one per service.** Each service has its own `nextDueAt`,
 *    and the single timer is armed for the earliest of them. A tick polls only
 *    what is due, so a ChatGPT that is backed off to ten minutes does not drag
 *    Claude's three-minute cadence with it, and there is still only one wakeup
 *    source to reason about.
 *  - **Every tick emits a full snapshot**, merging the *last known* report for
 *    the service that was not due with the fresh one for the service that was.
 *    Emitting only the polled half would blank the other service's rows in the
 *    panel every other tick.
 *  - **Every service's poll has a ceiling** (`RESOLVE_DEADLINE_MS`). A chain
 *    that never answers becomes a visible `error` instead of an `inFlight` flag
 *    that silently skips every later tick.
 *  - **A failed read keeps the last good numbers** (`carryLastGood`), dated
 *    by their own `fetchedAt`, and **a wake retries an `error` quickly**
 *    instead of backing off (`wakeNow`, `advanceSchedule`'s `wakeUntil`). Both
 *    are QA row 4.8: the poll a wake fires lands before DNS is back, and it
 *    used to cost the owner his numbers *and* six minutes of backoff.
 *  - **The last snapshot is persisted** (trimmed — see `trimSnapshot`) and
 *    restored on launch, so Walder shows a real face immediately instead of the
 *    confused one for the first three minutes of every session.
 *  - **Nothing here sees a credential.** Providers read their own at poll time;
 *    what comes back is percentages, labels and reset timestamps.
 *
 * Electron-free: the provider chains and the clock are injected, which is what
 * lets the whole loop be driven with fake timers in a test.
 */
import { mergeBuckets, type Bucket, type SourceStatus } from '../core/buckets';
import { tokensBucket } from '../core/local-tokens';
import {
  advanceSchedule,
  baseIntervalMs,
  carryLastGood,
  initialSchedule,
  isDue,
  manualAllowed,
  manualCooldownRemainingMs,
  nextResetDelayMs,
  nextTickDelayMs,
  resetCrossed,
  restoreSchedules,
  scheduleNow,
  WAKE_WINDOW_MS,
  type ServiceSchedule
} from '../core/poll-schedule';
import {
  expressionForBuckets,
  restoreSnapshot,
  trimSnapshot,
  type ServiceReport,
  type UsageSnapshot
} from '../core/usage';
import {
  forgetLoginCheck,
  resolveService,
  VIA_NONE,
  type ProviderChains
} from '../providers/registry';
import { perService, type ServiceName } from '../core/services';
import { readPrimaryService, type WalderStore } from './store';
import { vlog, warn } from './log';

/**
 * How long one service's whole chain may take before the poll gives up on it.
 *
 * A ceiling over `resolveService`, not over a single request: each provider has
 * its own 15 s HTTP timeout, but a chain walks several of them and
 * `chatgpt-web` walks a list of candidates inside that. Without a ceiling here,
 * one wedged endpoint holds `inFlight` true and every later tick is skipped —
 * the numbers freeze and nothing says why, which is the failure mode this
 * deadline exists to convert into a visible `error` status.
 *
 * Generous on purpose: 45 s of candidate walk plus a couple of 15 s timeouts is
 * a legitimately slow poll, and reporting an error for one would be worse than
 * waiting.
 */
export const RESOLVE_DEADLINE_MS = 90_000;

/**
 * Race a promise against a deadline, answering with `onTimeout` if it wins.
 *
 * The abandoned work is left to finish on its own: it holds no lock (the
 * `inFlight` flag is released by the caller either way) and its result is
 * simply dropped, which is preferable to threading an `AbortSignal` through
 * every provider for a case that means "something is broken" regardless.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expiry = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** The placeholder report for a service that has not been polled yet. */
function pendingReport(): ServiceReport {
  return {
    buckets: [],
    status: 'unavailable',
    message: 'not checked yet',
    via: 'none',
    viaLabel: 'no source'
  };
}

export interface PollerDeps {
  readonly store: WalderStore;
  readonly chains: ProviderChains;
  /** Called with every snapshot, including the one restored from disk on start. */
  readonly onSnapshot: (snapshot: UsageSnapshot) => void;
  /** Injected clock and RNG, so the schedule can be driven deterministically. */
  readonly now?: () => number;
  readonly random?: () => number;
  /**
   * Today's local token counts per service (`main/local-tokens.ts`), read on
   * every publish. Optional: a poller built without it simply has no such rows,
   * which is what every existing test expects.
   */
  readonly localTokens?: () => Partial<Record<ServiceName, number | null>>;
}

export interface Poller {
  /** Restore the stored snapshot, then poll everything immediately. */
  start(): void;
  stop(): void;
  /**
   * Poll both services now. Returns `false` when the 60 s cooldown blocks it,
   * so the caller can leave the tray item disabled rather than lying about it.
   */
  refreshNow(): boolean;
  /** Milliseconds until `refreshNow` will be allowed; 0 when it is allowed. */
  cooldownRemainingMs(): number;
  /**
   * Poll every service now, for housekeeping rather than the owner clicking —
   * today the poll that follows a logout's `forget`.
   *
   * It does not spend the 60 s manual cooldown: the owner who has just logged
   * out should still get his one Refresh. And it is one poll, not a pardon:
   * `scheduleNow` keeps the failure count, so a service that is still
   * rate-limited backs off from where it was.
   */
  pokeNow(): void;
  /**
   * `pokeNow` for the machine waking up, plus a short window of quick retries.
   *
   * Same poll, same untouched cooldown, same kept failure count. The
   * difference is what an `error` costs in the `WAKE_WINDOW_MS` that follows:
   * a retry in `WAKE_RETRY_MS` instead of a doubled interval, because the poll
   * a wake fires usually runs before Wi-Fi and DNS are back — every service
   * answered `ERR_NAME_NOT_RESOLVED` in the QA case, and the backoff then held
   * the confused face up for six minutes on a network that was back in
   * seconds (QA row 4.8). A separate method, not a flag on every poke, so a
   * logout's poll cannot open the window by accident.
   */
  wakeNow(): void;
  /**
   * Drop everything known about one service, right now.
   *
   * For a logout. A logout is a *fact about the account*, not a poll result, so
   * it must not wait for one — and `refreshNow` is refused for 60 s after a
   * manual refresh, which is exactly when an owner who has just checked his
   * numbers decides to log out. Without this, the logged-out account's buckets
   * sat in `lastSnapshot`, were persisted, and came back at the next launch as
   * if the login were still there.
   *
   * Publishes immediately, so the card, the store and the coordinator all stop
   * showing those numbers in the same beat.
   */
  forget(service: ServiceName): void;
  /**
   * Re-emit the numbers already in hand, without going near the network.
   *
   * For a setting that changes how a snapshot is *presented* rather than what
   * is in it — today only `primaryService`, which `publish` reads to decide the
   * bucket order and the card's section order (`snapshot.primary`). Without
   * this the tray's radio would not reach the card until the next three-minute
   * poll, and a menu item that visibly does nothing for minutes reads as broken.
   *
   * Deliberately not `refreshNow`: that one goes to the network for numbers
   * nobody asked to have re-fetched, and its 60 s manual cooldown refuses
   * outright if the owner has just pressed Refresh — so the menu item would
   * work or not depending on what he did a moment ago.
   *
   * The re-published snapshot keeps its ORIGINAL `fetchedAt`. Stamping it with
   * `now()` would make an hour-old snapshot claim to be fresh, which is exactly
   * the lie `isStale` and the card's "3 min ago" exist to prevent.
   */
  republish(): void;
  /** The most recent snapshot, or `null` before the first one. */
  last(): UsageSnapshot | null;
}

export function createPoller(deps: PollerDeps): Poller {
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? (() => Math.random());

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  /** Guards against a tick starting while the previous one is still awaiting. */
  let inFlight = false;
  let lastManualAt: number | null = null;
  let lastSnapshot: UsageSnapshot | null = null;
  /**
   * When the quick-retry window the last wake opened closes (`wakeNow`), or
   * `undefined` when no wake has opened one. Never cleared: a stamp in the
   * past is simply a closed window, and `advanceSchedule` compares it with the
   * poll's own finish time.
   */
  let wakeUntil: number | undefined;

  /**
   * The services this poller polls, taken from the chains it was handed.
   *
   * The chains object **is** the service list: a service Walder can ask about
   * is exactly one with a chain to ask down, so deriving the list here removes
   * the second place it could be written and the chance of the two
   * disagreeing. It is also what lets a test drive this loop with a third,
   * invented service.
   *
   * `schedules` and `reports` are plain mutable records rather than
   * `ServiceMap`s, because every tick writes a key back and a `ServiceMap` is
   * readonly by construction. `perService` still builds the initial shape, so
   * "one entry per name" stays in the one helper.
   */
  const services: readonly string[] = Object.keys(deps.chains);
  const schedules: Record<string, ServiceSchedule> = {
    ...perService(services, () => initialSchedule(now()))
  };
  const reports: Record<string, ServiceReport> = { ...perService(services, pendingReport) };

  const intervalMs = (): number => baseIntervalMs(deps.store.get('pollIntervalSec'));

  /**
   * The service's report plus its "Tokens today" row, when there is one.
   *
   * A **copy**: `reports[service]` is the provider's answer and is overwritten
   * by the next poll, so appending in place would stack a second tokens row on
   * it every three minutes.
   *
   * **Any tokens row already in the report is dropped first**, so this is the
   * one place a report gains one and no report can ever carry two. The report
   * is not always a provider's: until a service's first poll after launch it is
   * the one restored from disk, and that came back *with* the row it was
   * persisted with (the file stores the merged list, tokens rows included, and
   * `restoreSnapshot` hands each service its share). Appending to it showed
   * "Tokens today" twice until the first poll (0.2.8 QA, F-3.4f) — and since
   * the merged list is sorted by a priority the restore had already biased
   * once, the stale row could even come back at the *top* of the section.
   * Replacing rather than keeping the stored row also puts the count where a
   * live poll puts it, last, and makes it today's count rather than the one
   * from whenever the file was written.
   *
   * The row is added whatever the service's status is, and that is the point of
   * reading it here rather than inside a provider. A Claude login that has
   * expired says nothing at all about how many tokens Claude Code spent this
   * morning — the transcripts are on this disk and are as true during an
   * `auth-needed` as during an `ok`. Tying the count to the web status would
   * blank the one number still knowable exactly when the others go missing.
   */
  function reportWithTokens(
    service: string,
    totals: Partial<Record<ServiceName, number | null>> | undefined
  ): ServiceReport {
    const stored = reports[service] ?? pendingReport();
    const report = { ...stored, buckets: stored.buckets.filter((b) => b.kind !== 'tokens') };
    // Cast once: a name that is not one the local-token reader knows simply has
    // no entry, so the row is skipped a line later and nothing is invented.
    const name = service as ServiceName;
    const total = totals?.[name];
    if (total === undefined || total === null) return report;
    return { ...report, buckets: [...report.buckets, tokensBucket(name, total)] };
  }

  /** The snapshot the current reports describe, stamped `at`; nothing is stored or sent. */
  function compose(at: number): UsageSnapshot {
    const totals = deps.localTokens?.();
    // Built once and read twice — as the snapshot's per-service sections and
    // as the bucket lists `mergeBuckets` folds together. Calling
    // `reportWithTokens` again for the merge would append a second "Tokens
    // today" row built from the same count.
    const published = perService(services, (service) => reportWithTokens(service, totals));
    const perReport = services.map((service) => published[service] ?? pendingReport());
    // Read per publish, not captured: the tray can change it between polls,
    // and this is the one place the ordering is decided for both the card and
    // the barks — `mergeBuckets` writes the bias into `priority` itself, which
    // is what `Behaviour` reads a moment later. See its comment.
    // Read once and used twice — for the rows' priorities and for the card's
    // section order (`cardRowsFor` reads `snapshot.primary`) — so the two can
    // never disagree within one snapshot.
    const primary = readPrimaryService(deps.store);
    const buckets: Bucket[] = mergeBuckets(
      primary,
      ...perReport.map((report) => report.buckets)
    );
    return {
      fetchedAt: new Date(at).toISOString(),
      services: published,
      buckets,
      expression: expressionForBuckets(buckets),
      intervalMs: intervalMs(),
      primary
    };
  }

  /** Build, remember, persist and publish a snapshot from the current reports. */
  function publish(at: number): void {
    const snapshot = compose(at);
    lastSnapshot = snapshot;

    try {
      deps.store.set('lastSnapshot', trimSnapshot(snapshot));
    } catch (error) {
      // A settings file that cannot be written must not stop the dog updating.
      warn('could not persist the usage snapshot:', error);
    }

    deps.onSnapshot(snapshot);
  }

  function arm(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!running) return;
    const at = now();
    // Due times, plus the nearest window reset: a backed-off service still has
    // to be woken the moment its limit lifts. Every one of these is at least 1,
    // so the timer can never be armed for zero.
    const delays = [
      nextTickDelayMs(Object.values(schedules), at),
      ...Object.values(reports).map((report) => nextResetDelayMs(report.buckets, at))
    ].filter((ms): ms is number => ms !== null);
    if (delays.length === 0) return;
    const delay = Math.min(...delays);
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, delay);
  }

  /**
   * Poll one service, remember its report, and hand back what the schedule
   * needs: the status, and whatever wait the server asked for.
   *
   * The `Retry-After` travels no further than the scheduler — it is not part of
   * the report, because it says nothing about the owner's allowance.
   */
  async function pollOne(
    service: string
  ): Promise<{ status: SourceStatus; retryAfterMs?: number }> {
    // No fallback: this used to be `service === 'claude' ? … : chains.chatgpt`,
    // which silently polled ChatGPT for any name that was not `'claude'`.
    const chain = deps.chains[service] ?? [];
    const result = await withDeadline(
      resolveService(service, chain, new Date(now())),
      RESOLVE_DEADLINE_MS,
      () => {
        warn(`poll ${service} exceeded ${RESOLVE_DEADLINE_MS} ms; reporting an error`);
        return {
          buckets: [],
          status: 'error' as SourceStatus,
          message: 'the source did not answer in time',
          via: VIA_NONE
        };
      }
    );
    const provider = chain.find((p) => p.id === result.via);
    const report: ServiceReport = {
      buckets: result.buckets,
      status: result.status,
      via: result.via,
      viaLabel: provider?.label ?? 'no source',
      // This service's own poll time, not the tick's — a service left out of
      // this tick (not due yet, backed off) keeps its earlier stamp instead
      // of borrowing the other service's.
      fetchedAt: new Date(now()).toISOString(),
      ...(result.message === undefined ? {} : { message: result.message })
    };
    // Merged against the report as it is *now*, after the await, not as it
    // was when the poll set out: a `forget` (logout) that landed meanwhile has
    // already emptied it, and must leave nothing to keep.
    const kept = carryLastGood(reports[service], report, now());
    reports[service] = kept;
    vlog(
      `poll ${service}: ${result.status} via ${result.via} (${result.buckets.length} buckets)` +
        (kept === report ? '' : `; kept ${kept.buckets.length} buckets from the last good read`)
    );
    return { status: result.status, retryAfterMs: result.retryAfterMs };
  }

  async function tick(): Promise<void> {
    if (!running || inFlight) return;
    inFlight = true;
    try {
      const at = now();
      const due = services.filter((service) => {
        const schedule = schedules[service] ?? initialSchedule(at);
        const report = reports[service] ?? pendingReport();
        return (
          isDue(schedule, at) ||
          // Or its window reset since it was last read: an expired number is
          // wrong, and a backoff is no reason to keep showing it.
          resetCrossed(report.buckets, Date.parse(report.fetchedAt ?? ''), at)
        );
      });
      if (due.length === 0) return;

      const base = intervalMs();
      // Concurrent: the two services share no state, and serialising them would
      // make one slow endpoint delay the other's numbers by a whole timeout.
      const outcomes = await Promise.all(due.map((service) => pollOne(service)));
      // A result that arrives after `stop()` belongs to a poller that no longer
      // exists: the store and the windows `publish` would notify are being torn down.
      if (!running) return;

      const finishedAt = now();
      due.forEach((service, index) => {
        const outcome = outcomes[index] as { status: SourceStatus; retryAfterMs?: number };
        schedules[service] = advanceSchedule(
          schedules[service] ?? initialSchedule(finishedAt),
          outcome.status,
          base,
          finishedAt,
          random(),
          outcome.retryAfterMs,
          // The quick retry after a wake, when one is open. Its due time is
          // what `arm()` below reads, so the timer fires at the retry rather
          // than at the base interval.
          wakeUntil
        );
      });

      try {
        // Written on every tick that polled, not only on a failure: the recovery
        // has to be persisted too, or a relaunch would restore a penalty the
        // service has already forgiven.
        deps.store.set('pollSchedules', { ...schedules });
      } catch (error) {
        // Same trade as the snapshot below: an unwritable settings file costs a
        // backoff across a relaunch, not the poll loop.
        warn('could not persist the poll backoff:', error);
      }

      publish(finishedAt);
    } catch (error) {
      // resolveService already catches per-provider failures, so reaching here
      // means a bug in this file — never a reason to stop polling.
      warn('poll tick failed:', error);
    } finally {
      inFlight = false;
      arm();
    }
  }

  /** Make every service due and tick — `pokeNow`, and the poll inside `wakeNow`. */
  function poke(): void {
    const at = now();
    for (const service of services) {
      schedules[service] = scheduleNow(schedules[service] ?? initialSchedule(at), at);
    }
    // `lastManualAt` deliberately untouched — see the interface comment.
    void tick();
  }

  return {
    start(): void {
      if (running) return;
      running = true;

      // Show the last known numbers before the network is touched at all.
      //
      // The stored reports are seeded into `reports` and the snapshot is then
      // re-composed from them, exactly as every later publish is, rather than
      // emitted as read. Emitted as read it skipped `reportWithTokens`, so the
      // first card after a launch showed the persisted "Tokens today" rows
      // wherever the persisted merge order had left them — at the top of a
      // section, in the 0.2.8 QA screenshot — and the first `republish` a
      // moment later moved them. One path means the card painted before the
      // first poll has the shape a poll gives it. It also stamps `primary`
      // from the live setting (it is not persisted, see
      // `UsageSnapshot.primary`); without it the sections would come up in
      // `SERVICES` order and swap a few seconds after launch for a ChatGPT
      // owner.
      //
      // Kept from the file: the stamp — `restoreSnapshot` only returns one
      // that parses, and replacing it with now() would make a day-old card
      // look fresh — and the interval it was polled at, which is what its
      // staleness is judged against.
      const stored = restoreSnapshot(deps.store.get('lastSnapshot'), intervalMs());
      if (stored !== null) {
        for (const service of services) {
          const report = stored.services[service];
          if (report !== undefined) reports[service] = report;
        }
        const restored: UsageSnapshot = {
          ...compose(Date.parse(stored.fetchedAt)),
          intervalMs: stored.intervalMs
        };
        lastSnapshot = restored;
        deps.onSnapshot(restored);
        vlog('restored the stored usage snapshot from', restored.fetchedAt);
      }

      const at = now();
      // A backoff that lived only in memory was cleared by quitting — and
      // quitting is what the owner does when the app looks stuck, so Walder was
      // re-arming the limit it was waiting out.
      const restoredSchedules = restoreSchedules(deps.store.get('pollSchedules'), at, services);
      for (const service of services) {
        const schedule = restoredSchedules[service] ?? initialSchedule(at);
        schedules[service] = schedule;
        if (!isDue(schedule, at)) {
          vlog(
            `restored a ${service} backoff: waiting ${Math.round(
              (schedule.nextDueAt - at) / 1000
            )} s before the first poll`
          );
        }
      }
      // Poll straight away rather than arming a zero-delay timer: the owner
      // opens the app to find out where they stand, and `tick` re-arms itself.
      void tick();
    },

    stop(): void {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },

    refreshNow(): boolean {
      const at = now();
      if (!manualAllowed(lastManualAt, at)) {
        vlog('manual refresh refused: cooldown');
        return false;
      }
      lastManualAt = at;
      for (const service of services) {
        schedules[service] = scheduleNow(schedules[service] ?? initialSchedule(at), at);
      }
      // If a tick is already in flight this returns immediately; that tick's own
      // `arm()` then picks the new due times up.
      void tick();
      return true;
    },

    cooldownRemainingMs(): number {
      return manualCooldownRemainingMs(lastManualAt, now());
    },

    pokeNow: poke,

    wakeNow(): void {
      // Opened before the poke, so the wake's own poll is the first one the
      // window covers. A second wake inside the window restarts it: that is a
      // second sleep, and its network is as missing as the first one's.
      wakeUntil = now() + WAKE_WINDOW_MS;
      vlog(`wake: polling now, quick retries on error for ${WAKE_WINDOW_MS / 1000} s`);
      poke();
    },

    forget(service: ServiceName): void {
      const at = now();
      // The Accounts line too, not only the numbers: both Log out paths (tray
      // and card) come through here, and a check made before the logout is an
      // answer about a session that has just been cleared. Without this the
      // tray kept `Logged in (checked …)` after ChatGPT ▸ Log out (0.2.8 QA).
      forgetLoginCheck(deps.chains[service] ?? [], service);
      reports[service] = {
        buckets: [],
        status: 'unavailable',
        message: 'logged out',
        via: VIA_NONE,
        viaLabel: 'no source',
        // Stamped now: this *is* when we learned it, and leaving the old stamp
        // would let `resetCrossed` re-poll against a window that no longer has
        // an account behind it.
        fetchedAt: new Date(at).toISOString()
      };
      publish(at);
    },

    republish(): void {
      const snapshot = lastSnapshot;
      if (snapshot === null) return;
      // The time the numbers were actually fetched, not the time the menu was
      // clicked — see the interface comment. An unparseable stamp can only come
      // from a hand-edited settings file; falling back to now() there is worse
      // than useless, so the re-sort is simply skipped.
      const at = Date.parse(snapshot.fetchedAt);
      if (!Number.isFinite(at)) return;
      publish(at);
    },

    last(): UsageSnapshot | null {
      return lastSnapshot;
    }
  };
}

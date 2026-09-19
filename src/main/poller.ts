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
  initialSchedule,
  isDue,
  manualAllowed,
  manualCooldownRemainingMs,
  nextResetDelayMs,
  nextTickDelayMs,
  resetCrossed,
  restoreSchedules,
  scheduleNow,
  type ServiceSchedule
} from '../core/poll-schedule';
import {
  expressionForBuckets,
  restoreSnapshot,
  trimSnapshot,
  type ServiceReport,
  type UsageSnapshot
} from '../core/usage';
import { resolveService, VIA_NONE, type ProviderChains } from '../providers/registry';
import type { ServiceName } from './ipc';
import { readPrimaryService, type WalderStore } from './store';
import { vlog, warn } from './log';

const SERVICES: readonly ServiceName[] = ['claude', 'chatgpt'];

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
  readonly localTokens?: () => Readonly<Record<ServiceName, number | null>>;
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
   * Poll both services now, for the machine waking rather than the owner
   * clicking.
   *
   * A wake is not someone hammering the endpoint, so it does not spend the 60 s
   * manual cooldown — the owner opening the lid should still get his one
   * Refresh. And it is one poll, not a pardon: `scheduleNow` keeps the failure
   * count, so a service that is still rate-limited backs off from where it was.
   */
  pokeNow(): void;
  /**
   * Re-emit the numbers already in hand, without going near the network.
   *
   * For a setting that changes how a snapshot is *presented* rather than what
   * is in it — today only `primaryService`, which `publish` reads to decide the
   * bucket order. Without this the tray's radio would not reach the card until
   * the next three-minute poll, and a menu item that visibly does nothing for
   * minutes reads as broken.
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

  const schedules: Record<ServiceName, ServiceSchedule> = {
    claude: initialSchedule(now()),
    chatgpt: initialSchedule(now())
  };
  const reports: Record<ServiceName, ServiceReport> = {
    claude: pendingReport(),
    chatgpt: pendingReport()
  };

  const intervalMs = (): number => baseIntervalMs(deps.store.get('pollIntervalSec'));

  /**
   * The service's report plus its "Tokens today" row, when there is one.
   *
   * A **copy**: `reports[service]` is the provider's answer and is overwritten
   * by the next poll, so appending in place would stack a second tokens row on
   * it every three minutes.
   *
   * The row is added whatever the service's status is, and that is the point of
   * reading it here rather than inside a provider. A Claude login that has
   * expired says nothing at all about how many tokens Claude Code spent this
   * morning — the transcripts are on this disk and are as true during an
   * `auth-needed` as during an `ok`. Tying the count to the web status would
   * blank the one number still knowable exactly when the others go missing.
   */
  function reportWithTokens(
    service: ServiceName,
    totals: Readonly<Record<ServiceName, number | null>> | undefined
  ): ServiceReport {
    const report = reports[service];
    const total = totals?.[service];
    if (total === undefined || total === null) return report;
    return { ...report, buckets: [...report.buckets, tokensBucket(service, total)] };
  }

  /** Build, remember, persist and publish a snapshot from the current reports. */
  function publish(at: number): void {
    const totals = deps.localTokens?.();
    const claude = reportWithTokens('claude', totals);
    const chatgpt = reportWithTokens('chatgpt', totals);
    // Read per publish, not captured: the tray can change it between polls,
    // and this is the one place the ordering is decided for both the card and
    // the barks — `mergeBuckets` writes the bias into `priority` itself, which
    // is what `Behaviour` reads a moment later. See its comment.
    const buckets: Bucket[] = mergeBuckets(
      readPrimaryService(deps.store),
      claude.buckets,
      chatgpt.buckets
    );
    const snapshot: UsageSnapshot = {
      fetchedAt: new Date(at).toISOString(),
      services: { claude, chatgpt },
      buckets,
      expression: expressionForBuckets(buckets),
      intervalMs: intervalMs()
    };
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
      nextTickDelayMs([schedules.claude, schedules.chatgpt], at),
      nextResetDelayMs(reports.claude.buckets, at),
      nextResetDelayMs(reports.chatgpt.buckets, at)
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
    service: ServiceName
  ): Promise<{ status: SourceStatus; retryAfterMs?: number }> {
    const chain = service === 'claude' ? deps.chains.claude : deps.chains.chatgpt;
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
    reports[service] = report;
    vlog(`poll ${service}: ${result.status} via ${result.via} (${result.buckets.length} buckets)`);
    return { status: result.status, retryAfterMs: result.retryAfterMs };
  }

  async function tick(): Promise<void> {
    if (!running || inFlight) return;
    inFlight = true;
    try {
      const at = now();
      const due = SERVICES.filter(
        (service) =>
          isDue(schedules[service], at) ||
          // Or its window reset since it was last read: an expired number is
          // wrong, and a backoff is no reason to keep showing it.
          resetCrossed(reports[service].buckets, Date.parse(reports[service].fetchedAt ?? ''), at)
      );
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
          schedules[service],
          outcome.status,
          base,
          finishedAt,
          random(),
          outcome.retryAfterMs
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

  return {
    start(): void {
      if (running) return;
      running = true;

      // Show the last known numbers before the network is touched at all.
      const restored = restoreSnapshot(deps.store.get('lastSnapshot'), intervalMs());
      if (restored !== null) {
        lastSnapshot = restored;
        for (const service of SERVICES) reports[service] = restored.services[service];
        deps.onSnapshot(restored);
        vlog('restored the stored usage snapshot from', restored.fetchedAt);
      }

      const at = now();
      // A backoff that lived only in memory was cleared by quitting — and
      // quitting is what the owner does when the app looks stuck, so Walder was
      // re-arming the limit it was waiting out.
      const restoredSchedules = restoreSchedules(deps.store.get('pollSchedules'), at);
      for (const service of SERVICES) {
        schedules[service] = restoredSchedules[service];
        if (!isDue(schedules[service], at)) {
          vlog(
            `restored a ${service} backoff: waiting ${Math.round(
              (schedules[service].nextDueAt - at) / 1000
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
      for (const service of SERVICES) schedules[service] = scheduleNow(schedules[service], at);
      // If a tick is already in flight this returns immediately; that tick's own
      // `arm()` then picks the new due times up.
      void tick();
      return true;
    },

    cooldownRemainingMs(): number {
      return manualCooldownRemainingMs(lastManualAt, now());
    },

    pokeNow(): void {
      const at = now();
      for (const service of SERVICES) schedules[service] = scheduleNow(schedules[service], at);
      // `lastManualAt` deliberately untouched — see the interface comment.
      void tick();
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

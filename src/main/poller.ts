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
import {
  advanceSchedule,
  baseIntervalMs,
  initialSchedule,
  isDue,
  manualAllowed,
  manualCooldownRemainingMs,
  nextTickDelayMs,
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
import type { WalderStore } from './store';
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

  /** Build, remember, persist and publish a snapshot from the current reports. */
  function publish(at: number): void {
    const buckets: Bucket[] = mergeBuckets(reports.claude.buckets, reports.chatgpt.buckets);
    const snapshot: UsageSnapshot = {
      fetchedAt: new Date(at).toISOString(),
      services: { claude: reports.claude, chatgpt: reports.chatgpt },
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
    const delay = nextTickDelayMs([schedules.claude, schedules.chatgpt], now());
    if (delay === null) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, delay);
  }

  async function pollOne(service: ServiceName): Promise<SourceStatus> {
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
      ...(result.message === undefined ? {} : { message: result.message })
    };
    reports[service] = report;
    vlog(`poll ${service}: ${result.status} via ${result.via} (${result.buckets.length} buckets)`);
    return result.status;
  }

  async function tick(): Promise<void> {
    if (!running || inFlight) return;
    inFlight = true;
    try {
      const at = now();
      const due = SERVICES.filter((service) => isDue(schedules[service], at));
      if (due.length === 0) return;

      const base = intervalMs();
      // Concurrent: the two services share no state, and serialising them would
      // make one slow endpoint delay the other's numbers by a whole timeout.
      const statuses = await Promise.all(due.map((service) => pollOne(service)));

      const finishedAt = now();
      due.forEach((service, index) => {
        const status = statuses[index] as SourceStatus;
        schedules[service] = advanceSchedule(
          schedules[service],
          status,
          base,
          finishedAt,
          random()
        );
      });

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
      schedules.claude = initialSchedule(at);
      schedules.chatgpt = initialSchedule(at);
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

    last(): UsageSnapshot | null {
      return lastSnapshot;
    }
  };
}

/**
 * The update check's timer and its one request.
 *
 * Built like `main/poller.ts` and for the same reason: **the arithmetic is not
 * in this file**. Intervals, the retry floor, the parsing, the URL pin and every
 * word of the menu line are pure functions in `core/update-check.ts`, so
 * "does a 403 really back off to an hour" is a unit test rather than an hour's
 * wait. What is here is the timer, the state and the I/O.
 *
 * Electron-free: the `HttpFetch` is injected (`fromFetch(net.fetch.bind(net),
 * 'omit')` from `index.ts`, the same adapter the providers use, which brings the
 * timeout, the 1 MB body cap and `redirect: 'manual'` with it). `'omit'` and not
 * `'include'`: this request goes to GitHub and has no business carrying the
 * owner's cookies for any site.
 *
 * **A failed check is not a warning.** Offline laptops, captive-portal wifi and
 * GitHub's own rate limit are all normal, and none of them is something the
 * owner should be asked to do anything about — so every failure is a `vlog` and
 * a `failed` state that the menu reports as "Last check failed (12:03)". Nothing
 * here ever calls `warn`, which is reserved for things that are actually broken.
 */
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_LATEST_URL,
  UPDATE_STATE_NEVER,
  UPDATE_TIMEOUT_MS,
  nextCheckAt,
  parseLatestRelease,
  updateUserAgent,
  type UpdateState
} from '../core/update-check';
import { isNewerVersion } from '../core/semver';
import { manualAllowed, manualCooldownRemainingMs } from '../core/poll-schedule';
import {
  classifyHttp,
  describeResponse,
  describeThrow,
  parseJson,
  type HttpFetch
} from '../providers/types';
import { vlog } from './log';

export interface UpdateCheckDeps {
  readonly http: HttpFetch;
  /** The running app's version, from `app.getVersion()`. */
  readonly currentVersion: string;
  /**
   * Is the check switched on? Read at check time rather than captured, so
   * unticking the menu item takes effect on the next due check instead of at
   * the next restart.
   */
  readonly enabled: () => boolean;
  /** Every state change, including a failure. */
  readonly onState: (state: UpdateState) => void;
  readonly now?: () => number;
}

export interface UpdateChecker {
  /** Arm the timer. The first check is a minute out — see the core constants. */
  start(): void;
  stop(): void;
  /**
   * Check now, from the menu. `false` when nothing was started — the 60 s
   * cooldown blocked it, or a check is still awaiting an answer — so the caller
   * can leave the item disabled rather than lying about it.
   *
   * **A manual check does not consult the on/off setting.** The owner has just
   * asked, explicitly, by clicking an item in a menu he opened; refusing because
   * the *automatic* checks are switched off would be answering a different
   * question. The setting's promise is about traffic Walder generates on its own
   * (see the README), and this is not that.
   */
  checkNow(): boolean;
  /** Milliseconds until `checkNow` is allowed; 0 when it is. */
  cooldownRemainingMs(): number;
  /** What the last check found. */
  state(): UpdateState;
}

export function createUpdateChecker(deps: UpdateCheckDeps): UpdateChecker {
  const now = deps.now ?? ((): number => Date.now());

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  /** Guards against a second check starting while one is still awaiting. */
  let inFlight = false;
  let lastManualAt: number | null = null;
  let state: UpdateState = UPDATE_STATE_NEVER;
  let startedAt = now();

  function publish(next: UpdateState): void {
    state = next;
    deps.onState(next);
  }

  /**
   * Arm the single timer for the next due check.
   *
   * `dueAt` overrides the schedule `state` implies, and exists for exactly one
   * caller: a check skipped because the setting is off, which must push the next
   * wakeup out *without* touching `state` (see `check`). Left out, the answer
   * comes from `nextCheckAt`.
   */
  function arm(dueAt?: number): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!running) return;
    // Armed even while the check is switched off, and `check` returns without
    // making a request: that way ticking the item back on takes effect without
    // a restart, and the timer costs one wakeup every six hours.
    const delay = Math.max(1, (dueAt ?? nextCheckAt(state, startedAt)) - now());
    timer = setTimeout(() => {
      timer = null;
      void check();
    }, delay);
  }

  /**
   * One check. `manual` is the owner having clicked the menu item.
   *
   * The `finally` re-arms whatever happened, which is what makes every exit
   * path — disabled, refused, failed, answered — leave a live timer behind.
   */
  async function check(manual = false): Promise<void> {
    if (!running || inFlight) return;
    if (!manual && !deps.enabled()) {
      // No request at all. The README promises this: untick the item and Walder
      // makes no GitHub call of its own accord.
      vlog('update check skipped: switched off');
      /*
       * **`state` is left exactly as it was**, and the next wakeup is pushed one
       * interval out by hand.
       *
       * It used to be assigned `{kind: 'up-to-date'}` here, straight past
       * `publish()` — which quietly threw away an `available` state: a scheduled
       * wakeup six hours after Walder found 0.1.3 would overwrite it, and the
       * menu's "Update available: 0.1.3 — Download…" reverted to "Check for
       * updates now" with the update still un-installed. The owner would have
       * had to happen to look at the menu inside that window to ever see it.
       *
       * The interval is passed explicitly because `nextCheckAt` cannot help
       * here: with `state` still `never` it returns a moment that is already in
       * the past, and the timer would re-fire every millisecond for the rest of
       * the run.
       */
      arm(now() + UPDATE_CHECK_INTERVAL_MS);
      return;
    }

    inFlight = true;
    try {
      const response = await deps.http(UPDATE_LATEST_URL, {
        timeoutMs: UPDATE_TIMEOUT_MS,
        headers: {
          // GitHub's documented pair. The version header pins the response
          // shape, so a future API change cannot silently alter what
          // `parseLatestRelease` is reading.
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': updateUserAgent(deps.currentVersion)
        }
      });

      const problem = classifyHttp(response);
      if (problem !== null) {
        publish({ kind: 'failed', detail: describeResponse(response), at: now() });
        vlog(`update check failed: ${problem} (${describeResponse(response)})`);
        return;
      }

      const release = parseLatestRelease(parseJson(response.body));
      if (release === null) {
        publish({ kind: 'failed', detail: 'an answer we could not read', at: now() });
        vlog('update check failed: the release could not be read');
        return;
      }

      if (!isNewerVersion(release.version, deps.currentVersion)) {
        publish({ kind: 'up-to-date', at: now() });
        vlog(`update check: ${deps.currentVersion} is current (newest ${release.version})`);
        return;
      }

      publish({ kind: 'available', version: release.version, url: release.url, at: now() });
      vlog(`update available: ${release.version}`);
    } catch (error) {
      publish({ kind: 'failed', detail: describeThrow(error), at: now() });
      vlog('update check failed:', describeThrow(error));
    } finally {
      inFlight = false;
      arm();
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      startedAt = now();
      arm();
    },

    stop(): void {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },

    checkNow(): boolean {
      /*
       * A check that is still awaiting an answer is not a refusal to check —
       * there is one happening. So it returns `false` (the caller must not
       * pretend it started a second one) *before* the cooldown is looked at, and
       * above all without stamping it: charging the owner a minute's wait for a
       * click that did nothing is the one outcome that would need explaining,
       * and there would be nothing in the menu to explain it with.
       */
      if (inFlight) {
        vlog('manual update check ignored: one is already in flight');
        return false;
      }
      const at = now();
      if (!manualAllowed(lastManualAt, at)) {
        vlog('manual update check refused: cooldown');
        return false;
      }
      lastManualAt = at;
      // A manual check ignores both `state`'s schedule and the on/off setting —
      // see `checkNow` on `UpdateChecker`. The cooldown above is the only thing
      // that governs it.
      void check(true);
      return true;
    },

    cooldownRemainingMs(): number {
      return manualCooldownRemainingMs(lastManualAt, now());
    },

    state(): UpdateState {
      return state;
    }
  };
}

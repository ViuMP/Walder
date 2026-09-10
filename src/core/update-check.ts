/**
 * "Is there a newer Walder?" — the arithmetic, the parsing and the wording.
 *
 * ## What this feature is, and what it deliberately is not
 *
 * It **checks**. It does not download and it does not install. The owner
 * decided that (2026-09-09) after the reason became clear: an unsigned macOS
 * app cannot replace itself usefully, because every new copy has to be let
 * through Gatekeeper by hand (**Open Anyway** in System Settings) — so a
 * self-updater would download 130 MB, swap the app, and leave the owner with a
 * Walder macOS refuses to launch. A menu line saying "0.1.3 available —
 * Download…" and a browser tab is the honest version of the same thing.
 *
 * ## The repository is public and separate
 *
 * The code lives in a private repo; releases go to `ViuMP/walder-releases`,
 * which holds nothing but installers. That is what lets the check be an
 * unauthenticated GitHub API call — no token in the app, nothing to leak — and
 * `scripts/publish-release.ts` imports `UPDATE_REPO` from here so the app and
 * the release script cannot end up naming different repositories.
 *
 * ## The one security rule
 *
 * **`html_url` from the API is pinned to the release repository's own prefix.**
 * `shell.openExternal` hands a URL to whatever the OS has registered for its
 * scheme, so a URL chosen by a remote response is a way out of the app and into
 * anything. The API is GitHub's and the repo is ours, but "the response told us
 * where to send the owner" is not a sentence that should be true of any app.
 * Anything that does not start with the prefix falls back to the constant
 * releases page — which is where the installers are anyway.
 *
 * Pure and Electron-free; `main/update-check.ts` is the timer and the request.
 */
import { clockTime } from './last-check';
import { isNewerVersion, parseSemver } from './semver';

/** The public releases repository. `owner/name`, as GitHub writes it. */
export const UPDATE_REPO = 'ViuMP/walder-releases';

/** The unauthenticated "newest release" endpoint. */
export const UPDATE_LATEST_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

/** Where the owner is sent to download. The fallback, and usually the answer. */
export const UPDATE_RELEASES_URL = `https://github.com/${UPDATE_REPO}/releases`;

/**
 * Every URL Walder may open must start with this.
 *
 * The check is a `startsWith` on a constant rather than a URL-parsing exercise,
 * because it has to be obviously right when read: the host, the owner and the
 * repository name are all fixed by it, and there is no room for a lookalike.
 */
export const UPDATE_URL_PREFIX = `https://github.com/${UPDATE_REPO}/`;

/**
 * Six hours between checks.
 *
 * Walder releases arrive a few times a year at most, so this is already far more
 * often than it needs to be — it is chosen to be *unnoticeable* rather than
 * timely: four unauthenticated requests a day is nothing against GitHub's 60/h
 * per-IP allowance, and a machine that is asleep most of the day still checks
 * within a session or two.
 */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * A minute after launch before the first check.
 *
 * Deliberately *not* part of the launch burst. Startup already fires two
 * provider polls, a sheet load, a window and a hook server, and the one thing
 * that is certainly not urgent is whether a new version exists — the owner has
 * just started the one he has.
 */
export const UPDATE_FIRST_CHECK_DELAY_MS = 60_000;

/**
 * Wait at least an hour after a failed check.
 *
 * Failures here are offline laptops and captive-portal wifi, which resolve on
 * their own timescale. Retrying hard would turn a coffee-shop network into a
 * request every few seconds for no benefit at all, since nothing about the
 * answer is time-critical.
 */
export const UPDATE_RETRY_FLOOR_MS = 60 * 60_000;

/** Shorter than the providers' 15 s: nothing waits on this. */
export const UPDATE_TIMEOUT_MS = 10_000;

/** How long a manual "Check for updates now" is refused for afterwards. */
export { MANUAL_COOLDOWN_MS } from './poll-schedule';

/** A release worth mentioning: its version, and where to get it. */
export interface LatestRelease {
  /** Without the leading `v`, so it reads as a version and not as a tag. */
  readonly version: string;
  /** Always inside `UPDATE_URL_PREFIX`. */
  readonly url: string;
}

/** A record with unknown values — the shape remote JSON arrives in. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The status GitHub answers with when a repository has published no releases.
 *
 * Observed live on 2026-09-10: `ViuMP/walder-releases` exists and is public,
 * holds no release yet, and `GET /repos/…/releases/latest` therefore answers
 * **404**. The generic provider mapping calls a 404 `endpoint-changed`, so the
 * check recorded `{kind: 'failed', detail: 'HTTP 404'}` and the tray read
 * "Last check failed (12:03)" — permanently, until the first release. That is
 * a lie about a perfectly healthy app: there is nothing newer to install, which
 * is precisely `up-to-date`.
 *
 * **The ambiguity we accept.** GitHub returns the same 404 for "this repo has
 * no releases" and for "this repo does not exist" (and for one renamed or made
 * private). We cannot tell them apart, and we do not try: the repository is
 * `UPDATE_REPO`, a compile-time constant in this file that `scripts/publish-
 * release.ts` imports too, so the "wrong repo" reading can only become true if
 * someone deletes or renames the releases repo — at which point the honest
 * report is still "no newer Walder to offer you", and the release script would
 * fail loudly long before the owner noticed a menu line.
 *
 * **This is a special case for this one endpoint only.** `describeResponse` and
 * `classifyHttp` in `providers/types.ts` must keep treating 404 as
 * `endpoint-changed`: for a usage provider a 404 really does mean the API moved,
 * and reporting that as "everything is fine" would hide a broken source behind
 * a confident 0 %.
 */
export const NO_RELEASES_STATUS = 404;

/** The parts of an HTTP response this decision needs. `HttpResponse` fits. */
export interface LatestResponseFacts {
  readonly status: number;
  readonly body: string;
  readonly redirected?: boolean;
  readonly truncated?: boolean;
}

/**
 * Is this GitHub saying "that repository has published nothing yet"?
 *
 * Deliberately narrow, so that only the one real case slips through:
 *
 *  - **the status is exactly 404** — every other non-200 (403 rate limit, 5xx,
 *    anything else) stays a failure;
 *  - **not redirected and not truncated** — either of those means we are not
 *    talking to the endpoint we addressed, whatever status came back;
 *  - **the body is a JSON object** — GitHub's 404 is `{"message":"Not Found",
 *    …}`. A captive portal's 404 sign-in page is HTML, and a check that
 *    silently reported a coffee-shop hotspot as "up to date" would be the same
 *    bug in the other direction.
 */
export function isNoReleasesResponse(res: LatestResponseFacts): boolean {
  if (res.status !== NO_RELEASES_STATUS) return false;
  if (res.redirected === true || res.truncated === true) return false;
  try {
    return isRecord(JSON.parse(res.body));
  } catch {
    return false;
  }
}

/**
 * The newest release from a GitHub `releases/latest` body, or `null`.
 *
 * Four conditions, and each one has a specific thing it prevents:
 *
 *  - **a parseable semver `tag_name`** — a tag like `nightly` or `v0.2` names no
 *    version the comparison can use;
 *  - **`draft !== true`** — a draft is visible to the repository owner's own
 *    token and is not a release anybody can download. It cannot appear on this
 *    unauthenticated endpoint today, and asserting it costs one line;
 *  - **`prerelease !== true`** — Walder's owner is not a beta tester of his own
 *    mascot, and `releases/latest` is documented to exclude these anyway;
 *  - **`html_url` inside `UPDATE_URL_PREFIX`** — see the file header. A foreign
 *    one is *not* a reason to reject the release; the version is still true, so
 *    the releases-page constant is used instead.
 */
export function parseLatestRelease(json: unknown): LatestRelease | null {
  if (!isRecord(json)) return null;
  if (json['draft'] === true || json['prerelease'] === true) return null;

  const parsed = parseSemver(json['tag_name']);
  if (parsed === null) return null;
  const version = `${parsed.major}.${parsed.minor}.${parsed.patch}${
    parsed.prerelease === null ? '' : `-${parsed.prerelease}`
  }`;

  const claimed = json['html_url'];
  const url =
    typeof claimed === 'string' && claimed.startsWith(UPDATE_URL_PREFIX)
      ? claimed
      : UPDATE_RELEASES_URL;

  return { version, url };
}

/**
 * What the last check found.
 *
 * `failed` carries a *shape* rather than a message — `HTTP 403`, `timeout`, `a
 * web page, not JSON` — exactly as `core/last-check.ts` does, and for the same
 * reason: it is printed in a menu, and nothing from a response body belongs
 * there.
 */
export type UpdateState =
  | { readonly kind: 'never' }
  | { readonly kind: 'up-to-date'; readonly at: number }
  | {
      readonly kind: 'available';
      readonly version: string;
      readonly url: string;
      readonly at: number;
    }
  | { readonly kind: 'failed'; readonly detail: string; readonly at: number };

/** Nothing has been checked yet this run. */
export const UPDATE_STATE_NEVER: UpdateState = { kind: 'never' };

/**
 * When the next check is due, given what the last one produced.
 *
 * `startedAt` is when the app started, and is only used before the first check:
 * afterwards the schedule hangs off the last answer, so a laptop that sleeps for
 * a day checks once when it wakes rather than making up the checks it missed.
 */
export function nextCheckAt(state: UpdateState, startedAt: number): number {
  switch (state.kind) {
    case 'never':
      return startedAt + UPDATE_FIRST_CHECK_DELAY_MS;
    case 'failed':
      return state.at + UPDATE_RETRY_FLOOR_MS;
    case 'available':
    case 'up-to-date':
    default:
      return state.at + UPDATE_CHECK_INTERVAL_MS;
  }
}

/**
 * The menu line, which is also the button.
 *
 * Four states in one item, because they are four answers to the same question
 * and the owner should not have to hunt between two menu entries for whichever
 * one is live today:
 *
 *  - a newer version exists → `Update available: 0.1.3 — Download…` (the
 *    ellipsis is the platform's promise that something opens);
 *  - the cooldown is running → `Check for updates now (wait 42s)`, disabled,
 *    the same pattern as `refreshLabel`;
 *  - the last check failed → `Last check failed (12:03)`. The *time* is the
 *    point: it tells "we asked and could not" apart from "we have not asked
 *    since you were on a plane";
 *  - otherwise → `Check for updates now`.
 *
 * Availability comes first, before the cooldown: that item opens a page rather
 * than making a request, so no cooldown applies to it.
 */
export function updateMenuLine(state: UpdateState, cooldownMs = 0): string {
  if (state.kind === 'available') return `Update available: ${state.version} — Download…`;
  if (cooldownMs > 0) return `Check for updates now (wait ${Math.ceil(cooldownMs / 1000)}s)`;
  if (state.kind === 'failed') return `Last check failed (${clockTime(state.at)})`;
  return 'Check for updates now';
}

/**
 * Should the dog say something about this version?
 *
 * Once per version, and the memory is persisted (`updateNotifiedVersion`), so
 * an owner who leaves 0.1.3 uninstalled for a month is told once rather than
 * four times a day forever — the menu carries it permanently, which is the
 * right place for a message with no deadline.
 *
 * A stored value that cannot be parsed counts as "not notified": the cost is one
 * extra bubble, and the alternative (treating garbage as "already told him")
 * would silently suppress the notice for good.
 */
export function shouldNotify(latest: string, notifiedVersion: unknown): boolean {
  if (parseSemver(latest) === null) return false;
  if (typeof notifiedVersion !== 'string') return true;
  if (parseSemver(notifiedVersion) === null) return true;
  return isNewerVersion(latest, notifiedVersion);
}

/**
 * The `User-Agent` GitHub's API asks every client to send.
 *
 * Named after the app and carrying its version, and nothing else — no machine
 * name, no OS build, no account. R7 of the plan's review notes that Chromium
 * may drop a custom `User-Agent` on a `fetch` from the main process, in which
 * case the process-wide Chrome UA is sent instead and GitHub accepts that too;
 * either way the request identifies a browser-ish client and not a person.
 */
export function updateUserAgent(version: string): string {
  const parsed = parseSemver(version);
  return `Walder/${parsed === null ? '0.0.0' : version.replace(/^v/, '')}`;
}

/**
 * Learning which endpoint carries the *chat* limits, by watching the site do it.
 *
 * The problem this exists for (BUILD_LOG, 2026-09-08): the only ChatGPT usage
 * endpoint we have verified — `/backend-api/wham/usage` — reports the **Codex**
 * allowance, not the ChatGPT chat allowance. There is no documented endpoint for
 * the latter, and guessing produces confidently wrong numbers, which is worse
 * than a "?".
 *
 * So while the owner is logged in through Walder's own login window, this module
 * listens to what chatgpt.com asks for and keeps the URLs whose *path* looks
 * quota-related. Those become the first candidates `chatgpt-web` tries on the
 * next poll. It is a hint list, not an oracle: a recorded candidate that yields
 * no buckets is simply skipped.
 *
 * **What is recorded, and what is not.** The **path only** — never the query,
 * never a fragment, never a header, never a request or response body, never a
 * cookie. Only requests to `https://chatgpt.com/*` are observed at all, and the
 * list is capped.
 *
 * The query string is the interesting exclusion (it used to be kept, until the
 * 2026-09-08 security gate). This list is written to the plain, unencrypted
 * settings file, and a site's own XHR routinely carries tokens, ids and
 * one-time codes in its query — `?token=eyJ…` on a request whose path happens
 * to contain "usage" would have been persisted verbatim and then *replayed* on
 * every poll. A path is all the hint list needs, so a path is all it holds; and
 * anything already stored with a query is scrubbed on load
 * (`sanitizePaths`).
 */

/**
 * Paths worth remembering. Broad on purpose — the point is to catch a name we
 * have not thought of — and matched against the path, not the whole URL, so a
 * query parameter cannot smuggle a match in.
 */
export const DISCOVERY_RE = /usage|rate.?limit|conversation_limit|model_limit|limits/i;

/** How many candidates to keep per service. Newest wins on overflow. */
export const MAX_DISCOVERED = 10;

/**
 * Reduce a URL to the only part we are willing to store: its path.
 *
 * Returns `null` for a URL that is not on `expectedOrigin`, which is what stops
 * a redirect chain or an embedded third-party request from putting somebody
 * else's host into the list — and, since `chatgpt-web` rebuilds the request URL
 * by prepending the origin itself, keeps a stored value from ever being able to
 * redirect a *token-bearing* request to another host.
 *
 * A doubled leading slash is refused separately, and the origin check is not
 * what catches it: `https://chatgpt.com//evil.example/usage` parses with the
 * *expected* origin and a `pathname` of `//evil.example/usage`, which would
 * concatenate into a different host if it were ever replayed. `sanitizePaths`
 * drops that shape on read; this stops it being written down at all, so the
 * two ends agree.
 *
 * The query and the fragment are dropped, not kept: see the file header.
 */
export function pathOnly(url: string, expectedOrigin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== expectedOrigin) return null;
  if (parsed.pathname.startsWith('//')) return null;
  return parsed.pathname;
}

/** Does this path look like it might carry a quota? */
export function isCandidatePath(path: string, re: RegExp = DISCOVERY_RE): boolean {
  // Query-stripped defensively: `pathOnly` has already done it for anything
  // this module recorded, but a hand-edited settings file has not.
  const bare = path.split(/[?#]/)[0] ?? path;
  return re.test(bare);
}

/**
 * Clean a stored list down to plain, replayable paths.
 *
 * The settings file is user-writable and older versions of Walder wrote query
 * strings into it, so everything read back gets this treatment before it is
 * used or re-saved:
 *
 *  - a query or fragment is stripped (`/usage?token=eyJ…` -> `/usage`);
 *  - anything not starting with a single `/` is dropped, which rejects both an
 *    absolute `https://evil.example/usage` and the protocol-relative
 *    `//evil.example/usage` that would otherwise concatenate onto the origin;
 *  - duplicates created by the stripping collapse.
 */
export function sanitizePaths(paths: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const entry of paths) {
    if (typeof entry !== 'string') continue;
    const bare = (entry.split(/[?#]/)[0] ?? '').trim();
    if (!bare.startsWith('/') || bare.startsWith('//')) continue;
    if (out.includes(bare)) continue;
    out.push(bare);
  }
  return out;
}

/**
 * Add newly seen paths to the stored list: existing order preserved, duplicates
 * dropped, capped at `cap` by discarding the *oldest*. Pure, so the cap and the
 * dedupe are tested without a browser.
 */
export function mergeDiscovered(
  existing: readonly string[],
  found: readonly string[],
  cap: number = MAX_DISCOVERED
): string[] {
  const out: string[] = [];
  for (const path of [...existing, ...found]) {
    if (typeof path !== 'string' || path.length === 0) continue;
    if (out.includes(path)) continue;
    out.push(path);
  }
  return out.length <= cap ? out : out.slice(out.length - cap);
}

/* ------------------------------------------------------- electron plumbing */

/** The slice of an Electron `Session` this needs. */
export interface WebRequestSession {
  readonly webRequest: {
    onCompleted(
      filter: { urls: string[] },
      listener: ((details: { url: string }) => void) | null
    ): void;
  };
}

/** The slice of the settings store this needs. */
export interface DiscoveryStore {
  get(key: string): unknown;
  set(key: string, value: string[]): void;
}

export interface DiscoveryOptions {
  readonly session: WebRequestSession;
  readonly store: DiscoveryStore;
  /** Store key: `chatgptDiscoveredEndpoints` / `claudeDiscoveredEndpoints`. */
  readonly storeKey: string;
  /** Origin to watch, e.g. `https://chatgpt.com`. */
  readonly origin: string;
  readonly re?: RegExp;
  readonly onFound?: (path: string) => void;
}

/**
 * Start recording quota-ish request paths on a session. Returns a function that
 * stops recording — call it when the login window closes, so a session that is
 * later used for polling is not still being watched.
 *
 * `onCompleted` (not `onBeforeRequest`) so only requests the site actually
 * completed are learned; a cancelled or blocked request is not evidence of a
 * live endpoint.
 */
export function attachDiscovery(options: DiscoveryOptions): () => void {
  const { session, store, storeKey, origin, re, onFound } = options;

  const listener = (details: { url: string }): void => {
    const path = pathOnly(details.url, origin);
    if (path === null) return;
    if (!isCandidatePath(path, re ?? DISCOVERY_RE)) return;

    const raw = store.get(storeKey);
    const stored = Array.isArray(raw) ? raw : [];
    // Scrubbed on read as well as on write: an entry left by an older version
    // may still carry a query string, and this is where it gets cleaned up.
    const existing = sanitizePaths(stored);
    const merged = mergeDiscovered(existing, [path]);

    // Only write on a change: the settings file is on disk, and a chatty page
    // would otherwise rewrite it dozens of times during one login. Compared
    // against what is *stored*, not against the scrubbed list, so a cleanup
    // that removed a query string is itself a change worth saving.
    const changed =
      merged.length !== stored.length || merged.some((value, index) => value !== stored[index]);
    if (changed) store.set(storeKey, merged);
    if (!existing.includes(path)) onFound?.(path);
  };

  session.webRequest.onCompleted({ urls: [`${origin}/*`] }, listener);

  return () => {
    // Electron's webRequest allows exactly one listener per event per session,
    // and `null` is how it is removed.
    session.webRequest.onCompleted({ urls: [`${origin}/*`] }, null);
  };
}

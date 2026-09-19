/**
 * The provider contract: one way to ask "how much of my allowance is left?".
 *
 * A *provider* is one (credential source, endpoint) pair — the Claude Code
 * keychain token against `api.anthropic.com`, a claude.ai browser session
 * against `claude.ai/api`, and so on. Several providers can answer for the same
 * service, which is why `registry.ts` arranges them into ordered chains.
 *
 * Deliberately free of any `electron` import. Providers take an injected
 * `HttpFetch` (and, for the session-cookie ones, an injected session), so the
 * exact same code runs inside Electron with `net.fetch` / `session.fetch` and
 * outside it under `npm run probe` with Node's `fetch`.
 *
 * **Credentials never touch this layer's outputs.** A token is read at poll
 * time, used as a header, and dropped when the call returns. Nothing in
 * `ProviderResult` carries one, and no provider logs a header, a cookie value or
 * a response body.
 */
import type { Bucket, SourceStatus } from '../core/buckets';
import type { AuthCheck } from '../core/last-check';

/**
 * Re-exported from `core/buckets` rather than redeclared: the parsers and the
 * providers must agree on this union, and two identical unions drift.
 */
export type { SourceStatus };

/** Re-exported for the same reason: `core/last-check.ts` owns the shape. */
export type { AuthCheck };

export interface ProviderResult {
  readonly buckets: Bucket[];
  readonly status: SourceStatus;
  /** One short human sentence, shown in the panel when the status is not `ok`. */
  readonly message?: string;
  /** The provider id that produced this. */
  readonly via: string;
  /**
   * How each optional extra request went — see `ClaudeSupplement`.
   *
   * **Diagnostics, not state.** A supplement is a second GET that enriches the
   * answer (claude.ai's Extra usage figure) and must never be able to spoil
   * it: the windows this result carries are already correct whether every
   * supplement succeeded or all of them 404'd. So its outcome lives in a field
   * of its own, and `poller.ts` copies named fields into `ServiceReport`
   * rather than spreading — which is what keeps a failed supplement from
   * turning the card's Claude section red about numbers that are perfectly
   * fine. Read by the verbose log, and by nothing else.
   */
  readonly supplements?: readonly SupplementStatus[];
  /**
   * The server's own floor for the next poll, from a `Retry-After` header.
   *
   * A floor and nothing more: the scheduler may only ever *raise* its delay with
   * it. Anthropic answers `Retry-After: 0` on a 429, and a scheduler that obeyed
   * that literally would poll again immediately and keep the limit alive — the
   * app sustaining its own punishment.
   */
  readonly retryAfterMs?: number;
}

/** One supplement's outcome for one poll. */
export interface SupplementStatus {
  /** The supplement's own id, e.g. `extra-usage`. */
  readonly id: string;
  readonly status: SourceStatus;
  /** A shape, never a value — the same vocabulary `describeResponse` uses. */
  readonly message?: string;
  /** How many rows it contributed. */
  readonly buckets: number;
}

export type ServiceName = 'claude' | 'chatgpt';

export interface UsageProvider {
  readonly id: string;
  readonly service: ServiceName;
  /** Human label for the panel: "Claude Code login", "chatgpt.com login". */
  readonly label: string;
  /**
   * Cheap, local check for "could this provider possibly answer?" — a keychain
   * item exists, a cookie jar has a session cookie. Never a network call: the
   * registry uses it to decide whether a failure is worth reporting, so it must
   * not itself be able to fail slowly.
   */
  isAvailable(): Promise<boolean>;
  /**
   * Network check for "is this login real *and* authenticated?".
   *
   * Only the cookie-session (web) providers implement it, and only they can:
   * `isAvailable` on those is a cookie-jar test, and a cookie jar holds
   * analytics and consent cookies for a site nobody has ever logged in to. That
   * distinction is what the login window turns on — it closes itself when this
   * says yes — so guessing from a cookie's existence would close the window
   * before the owner had typed anything (which is precisely the bug this
   * method exists to fix).
   *
   * Optional because the token providers have nothing to add: for them a
   * credential either exists and works or comes back 401 from `fetch`. Absent
   * here means "not a web login", and `isWebLoginAuthenticated` in
   * `registry.ts` reads it that way.
   */
  isAuthenticated?(): Promise<boolean>;
  /**
   * The outcome of the most recent `isAuthenticated` call, or `null` before the
   * first one — for the tray's Accounts submenu.
   *
   * Synchronous and in-memory on purpose. It is read while an Electron `Menu` is
   * being built, which cannot await anything, and it must never cause a request
   * of its own: a menu that polls the owner's account every time he opens it
   * would be both slow and rude. So the provider simply remembers what it
   * already found out.
   *
   * Implemented by the web providers only, alongside `isAuthenticated`. Nothing
   * in the record is persisted, and `detail` carries shapes (`HTTP 401`,
   * `timeout`) rather than values — see `core/last-check.ts`.
   */
  lastCheck?(): AuthCheck | null;
  fetch(now: Date): Promise<ProviderResult>;
}

/* ------------------------------------------------------------------- http */

/**
 * The minimum of an HTTP response the providers need, already read to text.
 *
 * Text, not JSON: an endpoint that has been replaced by a login page returns
 * `200 text/html`, and telling that apart from a real payload is the difference
 * between `endpoint-changed` and a crash. Providers parse the JSON themselves.
 */
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
  /**
   * The endpoint answered with a redirect the HTTP layer would not follow (a
   * cross-origin `Location`, or a second hop). Credential-bearing requests are
   * never re-issued to another origin — see `http.ts` — so this is reported
   * rather than chased, and it means the endpoint has moved.
   */
  readonly redirected?: boolean;
  /** The body passed the 1 MB cap and was cut short, so it cannot be parsed. */
  readonly truncated?: boolean;
  /**
   * `Retry-After`, already in milliseconds — parsed once in `http.ts` so no
   * provider has to know that the header comes in two forms.
   *
   * A *shape*, like everything else on this interface: a duration the server
   * stated, never logged and never shown, and absent whenever the header was
   * missing or unreadable.
   */
  readonly retryAfterMs?: number;
}

export interface HttpInit {
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/**
 * An injected HTTP call. Implementations: `fromFetch(net.fetch)` in main,
 * `fromFetch(session.fromPartition(...).fetch)` for the cookie providers,
 * `fromFetch(fetch)` in the probe script, and a plain stub in the tests.
 */
export type HttpFetch = (url: string, init?: HttpInit) => Promise<HttpResponse>;

/** Default request timeout. The endpoints are small JSON documents. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/* ----------------------------------------------------- session (cookie jar) */

/** Just enough of an Electron cookie record to test for a login. */
export interface CookieInfo {
  readonly name: string;
  readonly domain: string;
}

/**
 * A named browser session (an Electron `persist:` partition) whose cookies are
 * sent automatically. Injected so the cookie-based providers can be unit-tested
 * and can degrade gracefully outside Electron, where there is no such thing.
 */
export interface PartitionSession {
  /** Sends the partition's cookies with every request. */
  readonly http: HttpFetch;
  cookies(filter: { url?: string; domain?: string; name?: string }): Promise<CookieInfo[]>;
}

/** `null` when there is no Electron session to use (the probe script). */
export type SessionSource = () => PartitionSession | null;

/** What the web providers say when run outside the app. */
export const NEEDS_APP_SESSION = "needs the app's login session";

/* --------------------------------------------------------- status helpers */

/** Does this body look like a web page rather than a JSON document? */
export function looksLikeHtml(res: HttpResponse): boolean {
  if (res.contentType !== null && /text\/html/i.test(res.contentType)) return true;
  return /^\s*(<!doctype|<html)/i.test(res.body);
}

/**
 * Map a response onto a failure status, or `null` when it looks usable.
 *
 * The mapping is the same for every provider, and each case means something
 * different to the owner:
 *  - 401/403 — the login is gone or expired: a *human* action fixes it.
 *  - 429 — we are asking too often: back off, do not tell the owner anything.
 *  - 404, HTML where JSON was promised, an unfollowed redirect, or a body over
 *    the size cap — the endpoint moved: nothing the owner can do, but Walder
 *    must say so rather than showing a confident 0 %.
 *  - anything else non-2xx — a transient server problem: retry with backoff.
 *
 * `redirected` is checked first: a 3xx carries none of the statuses below, and
 * falling through to `!res.ok` would report a moved endpoint as a transient
 * server error and retry it forever.
 */
export function classifyHttp(res: HttpResponse): SourceStatus | null {
  if (res.redirected === true) return 'endpoint-changed';
  if (res.status === 401 || res.status === 403) return 'auth-needed';
  if (res.status === 429) return 'rate-limited';
  if (res.status === 404) return 'endpoint-changed';
  // A body we could not read whole is not a payload, whatever the status said.
  if (res.truncated === true) return 'endpoint-changed';
  if (looksLikeHtml(res)) return 'endpoint-changed';
  if (!res.ok) return 'error';
  return null;
}

/** Parse a JSON body, or `null` if it is not JSON at all. */
export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/**
 * The top-level keys of an unexpected payload — the *only* thing that may be
 * logged about a response body. Key names describe a shape; values are the
 * owner's data (and, on the session endpoints, a token).
 */
export function topLevelKeys(json: unknown): string[] {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return [];
  return Object.keys(json as Record<string, unknown>);
}

/** Shorthand for a result with no buckets. */
export function failure(
  via: string,
  status: SourceStatus,
  message?: string,
  retryAfterMs?: number
): ProviderResult {
  return {
    buckets: [],
    status,
    via,
    ...(message === undefined ? {} : { message }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs })
  };
}

/**
 * A response in the few words a menu line can hold — a *shape*, never a value.
 *
 * Feeds `AuthCheck.detail`, which the tray prints verbatim, so the vocabulary is
 * fixed and small: a status code, "the endpoint moved", "a web page, not JSON".
 * Nothing from the body, nothing from a header, and in particular never the
 * account the response describes.
 */
export function describeResponse(res: HttpResponse): string {
  if (res.redirected === true) return 'the endpoint moved';
  if (res.truncated === true) return 'an oversized response';
  if (res.status !== 200) return `HTTP ${res.status}`;
  if (looksLikeHtml(res)) return 'a web page, not JSON';
  return 'an answer we could not read';
}

/**
 * A thrown request, in the same few words.
 *
 * The abort case is called out by name because it is the common one and the
 * least obvious: `fromFetch` aborts on its own timeout, and the DOMException
 * that produces says "the operation was aborted", which reads like a mystery
 * rather than "the site did not answer in time".
 */
export function describeThrow(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'timeout';
  const message = errorMessage(error);
  return /abort/i.test(message) ? 'timeout' : message;
}

/**
 * Turn a thrown value into a message that cannot leak a credential.
 *
 * Only `Error.message` is used, never a stack and never a cause chain: a
 * `fetch` rejection can quote the request it failed on, and a stack can quote
 * local variables. The message is additionally run through the log redactor at
 * the point it is printed.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'request failed';
}

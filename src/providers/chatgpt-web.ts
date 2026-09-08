/**
 * ChatGPT usage via a chatgpt.com browser session.
 *
 * Two steps, because the site's own API is bearer-authenticated even though the
 * *login* is a cookie:
 *   1. `GET /api/auth/session` with the partition's cookies, which hands back a
 *      short-lived `accessToken` (and, on some accounts, the account id).
 *   2. that token, as `Authorization: Bearer`, against a usage endpoint.
 *
 * Step 2 is the honest problem in this file. **No documented endpoint reports
 * the ChatGPT chat allowance.** The one endpoint we have verified —
 * `/backend-api/wham/usage` — reports the *Codex* allowance (BUILD_LOG,
 * 2026-09-08). So this provider tries a list of candidates in order, takes the
 * first that yields at least one bucket, and if none does it reports
 * `endpoint-changed` naming the paths it tried. Candidates learned by watching
 * the real site (`endpoint-discovery.ts`) come first, because they are evidence
 * rather than guesses.
 *
 * The access token is held in a local variable for the length of one poll and is
 * never stored, logged or returned.
 */
import { parseChatGptUsage } from '../core/buckets';
import { authCheck, type AuthCheck } from '../core/last-check';
import { mergeDiscovered, sanitizePaths } from './endpoint-discovery';
import {
  classifyHttp,
  describeResponse,
  describeThrow,
  errorMessage,
  failure,
  parseJson,
  topLevelKeys,
  DEFAULT_TIMEOUT_MS,
  NEEDS_APP_SESSION,
  type HttpResponse,
  type ProviderResult,
  type SessionSource,
  type UsageProvider
} from './types';

export const CHATGPT_WEB_ID = 'chatgpt-web';
export const CHATGPT_WEB_LABEL = 'chatgpt.com login';
export const CHATGPT_WEB_PARTITION = 'persist:chatgpt';

export const CHATGPT_ORIGIN = 'https://chatgpt.com';
export const CHATGPT_SESSION_URL = `${CHATGPT_ORIGIN}/api/auth/session`;
/**
 * The second opinion for `isAuthenticated`, and only for it.
 *
 * `/api/auth/session` is NextAuth's endpoint and OpenAI has reshaped it before.
 * A logged-out browser gets `{}` there — and so would a logged-in one if the
 * token moved to a different key, which is indistinguishable from the outside.
 * That ambiguity is expensive: it is exactly the state in which the login window
 * never closes and the tray keeps saying "login needed" to an owner who is
 * demonstrably logged in (his report, 2026-09-08). So a 200 without a token is
 * followed by one request to `/backend-api/me`, and a 200 there carrying an
 * `id` or an `email` **field** settles it.
 *
 * Only the presence of those keys is read. Their values are the owner's
 * identity, and nothing in Walder needs it.
 */
export const CHATGPT_ME_URL = `${CHATGPT_ORIGIN}/backend-api/me`;

/**
 * Fallback candidates, tried after anything discovery has learned.
 *
 * Stored as paths, not URLs, and joined onto `CHATGPT_ORIGIN` at request time:
 * the same rule the discovered ones follow, so no stored string can ever send a
 * bearer token to another host.
 */
export const CHATGPT_CANDIDATE_PATHS: readonly string[] = [
  '/backend-api/wham/usage',
  '/backend-api/conversation_limit',
  '/backend-api/models'
];

export const LOGGED_OUT_MESSAGE = 'not logged in to chatgpt.com';

/** Timeout for `isAuthenticated`; the login window asks every 2 s. */
export const AUTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * The whole candidate walk's budget, and how many candidates it may try.
 *
 * Both bounds exist for the same reason: the walk is a *search*, and a search
 * with no ceiling is what turns one poll into an hour of requests. With ten
 * discovered paths plus three built-ins and a 15 s timeout each, an endpoint
 * that hangs would have kept the poller busy for three minutes and hammered the
 * owner's account on every tick. Five candidates inside 45 s, then report what
 * was tried and let the next poll continue from a different starting point (the
 * last success is remembered and goes first).
 */
export const CHATGPT_CANDIDATE_BUDGET_MS = 45_000;
export const CHATGPT_MAX_CANDIDATES = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Pull the bearer token, and an account id if one is offered, out of the session
 * response. Nothing else in that payload is read: it also carries the owner's
 * name, email and picture.
 */
export function parseSession(json: unknown): { accessToken: string; accountId: string | null } | null {
  if (!isRecord(json)) return null;
  const accessToken = nonEmptyString(json['accessToken']);
  if (accessToken === null) return null;

  let accountId: string | null = null;
  const account = json['account'];
  if (isRecord(account)) {
    accountId = nonEmptyString(account['account_id']) ?? nonEmptyString(account['accountId']);
    // Some responses nest it one deeper, under `account.account.id`.
    if (accountId === null) {
      const inner = account['account'];
      if (isRecord(inner)) accountId = nonEmptyString(inner['id']);
    }
  }
  return { accountId, accessToken };
}

/**
 * The candidate list for this poll: the last path that worked, then discovered
 * paths, then the built-in fallbacks — deduped and order-preserving.
 *
 * `sanitizePaths` is what makes a stored string safe to concatenate onto the
 * origin: it drops anything that is not a plain, query-free, non
 * protocol-relative path. Without it `//evil.example/usage` would build
 * `https://chatgpt.com//evil.example/usage` and a stored `?token=…` would be
 * replayed on every poll.
 */
export function candidatePaths(
  discovered: readonly string[],
  lastGood: string | null = null
): string[] {
  const clean = sanitizePaths([...(lastGood === null ? [] : [lastGood]), ...discovered]);
  return mergeDiscovered(
    clean,
    CHATGPT_CANDIDATE_PATHS,
    clean.length + CHATGPT_CANDIDATE_PATHS.length
  );
}

/**
 * Does a `/backend-api/me` body identify somebody?
 *
 * Presence, not value: `id` or `email` being *there* is the signal, and neither
 * is read out. An empty object, or one carrying only feature flags, is not a
 * login.
 */
export function identifiesAccount(json: unknown): boolean {
  if (!isRecord(json)) return false;
  return nonEmptyString(json['id']) !== null || nonEmptyString(json['email']) !== null;
}

export interface ChatGptWebDeps {
  /** `null` outside Electron — the probe script has no cookie jar. */
  readonly session: SessionSource;
  /** Paths learned by `endpoint-discovery`, from the settings store. */
  readonly discoveredPaths?: () => readonly string[];
  /** Told which path finally worked, so the caller can note it. */
  readonly onEndpointFound?: (path: string) => void;
  readonly onUnexpectedShape?: (keys: string[]) => void;
  /** Injected monotonic-ish clock, so the walk's budget is testable. */
  readonly clock?: () => number;
}

export function createChatGptWebProvider(deps: ChatGptWebDeps): UsageProvider {
  const clock = deps.clock ?? ((): number => Date.now());
  /**
   * The last authentication verdict, for the tray. Memory only, never
   * persisted, and never anything from a response body — see
   * `core/last-check.ts`.
   */
  let checked: AuthCheck | null = null;
  function remember(loggedIn: boolean, detail: string, failed = false): boolean {
    checked = authCheck(loggedIn, detail, clock(), failed);
    return loggedIn;
  }
  /**
   * The path that last yielded buckets, tried first next time.
   *
   * Held in the provider (not only in the settings store) so the memory also
   * works for a caller that persists nothing — `scripts/probe.ts`, the tests —
   * and so a successful poll cannot be followed by a walk that starts again
   * from the built-ins.
   */
  let lastGood: string | null = null;

  return {
    id: CHATGPT_WEB_ID,
    service: 'chatgpt',
    label: CHATGPT_WEB_LABEL,

    /**
     * Any cookie for chatgpt.com. Deliberately looser than the claude.ai check
     * (which names `sessionKey`): OpenAI has renamed its session cookie more
     * than once, and a login the provider refuses to even try is invisible to
     * the owner.
     */
    async isAvailable(): Promise<boolean> {
      const session = deps.session();
      if (session === null) return false;
      try {
        return (await session.cookies({ url: CHATGPT_ORIGIN })).length > 0;
      } catch {
        return false;
      }
    },

    /**
     * A real, authenticated chatgpt.com session: `GET /api/auth/session` answers
     * 200 with a non-empty `accessToken` — or, failing that,
     * `GET /backend-api/me` answers 200 with an `id` or `email` field.
     *
     * The login window waits for exactly this, and the looseness of
     * `isAvailable` above is why it cannot wait for that instead: chatgpt.com
     * sets `oai-did` and friends on the login page itself, so "has a cookie" is
     * true the moment the window opens.
     *
     * The fallback covers the shape risk. `{}` from the session endpoint means
     * "logged out" *today*; if OpenAI renames `accessToken` it will mean "logged
     * out" for a logged-in owner, and the symptom is precisely what was reported
     * on 2026-09-08 — the login goes through, the window stays, the tray says
     * login needed. Skipped after a 401 or 403, which is an unambiguous answer
     * and would only double the traffic while the window polls every 2 s.
     */
    async isAuthenticated(): Promise<boolean> {
      const session = deps.session();
      if (session === null) return remember(false, NEEDS_APP_SESSION, true);

      let response: HttpResponse;
      try {
        response = await session.http(CHATGPT_SESSION_URL, {
          headers: { Accept: 'application/json' },
          timeoutMs: AUTH_CHECK_TIMEOUT_MS
        });
      } catch (error) {
        return remember(false, describeThrow(error), true);
      }

      if (response.status === 200 && classifyHttp(response) === null) {
        if (parseSession(parseJson(response.body)) !== null) return remember(true, '');
      } else if (response.status === 401 || response.status === 403) {
        return remember(false, `HTTP ${response.status}`);
      }
      const reason =
        response.status === 200 && classifyHttp(response) === null
          ? 'no access token'
          : describeResponse(response);

      try {
        const me = await session.http(CHATGPT_ME_URL, {
          headers: { Accept: 'application/json' },
          timeoutMs: AUTH_CHECK_TIMEOUT_MS
        });
        if (
          me.status === 200 &&
          classifyHttp(me) === null &&
          identifiesAccount(parseJson(me.body))
        ) {
          return remember(true, '');
        }
      } catch {
        // The fallback failing tells us nothing new; the first answer stands.
      }
      return remember(false, reason);
    },

    lastCheck(): AuthCheck | null {
      return checked;
    },

    async fetch(now: Date): Promise<ProviderResult> {
      const session = deps.session();
      if (session === null) {
        return failure(CHATGPT_WEB_ID, 'unavailable', NEEDS_APP_SESSION);
      }

      try {
        /* ---- step 1: the cookie-authenticated session endpoint ---------- */
        const sessionResponse = await session.http(CHATGPT_SESSION_URL, {
          headers: { Accept: 'application/json' }
        });
        const problem = classifyHttp(sessionResponse);
        if (problem === 'auth-needed') {
          return failure(CHATGPT_WEB_ID, 'auth-needed', LOGGED_OUT_MESSAGE);
        }
        if (problem === 'rate-limited') {
          return failure(CHATGPT_WEB_ID, 'rate-limited', 'chatgpt.com asked us to slow down');
        }
        if (problem !== null) {
          return failure(
            CHATGPT_WEB_ID,
            problem,
            `the chatgpt.com session endpoint answered ${sessionResponse.status}`
          );
        }

        const sessionJson = parseJson(sessionResponse.body);
        const credentials = parseSession(sessionJson);
        if (credentials === null) {
          // An empty `{}` is what a logged-out browser gets here, so this is
          // "log in", not "the endpoint moved".
          const keys = topLevelKeys(sessionJson);
          deps.onUnexpectedShape?.(keys);
          return failure(CHATGPT_WEB_ID, 'auth-needed', LOGGED_OUT_MESSAGE);
        }

        /* ---- step 2: whichever usage endpoint answers ------------------- */
        const authHeaders: Record<string, string> = {
          Authorization: `Bearer ${credentials.accessToken}`,
          Accept: 'application/json'
        };
        if (credentials.accountId !== null) {
          authHeaders['ChatGPT-Account-Id'] = credentials.accountId;
        }

        const paths = candidatePaths(deps.discoveredPaths?.() ?? [], lastGood).slice(
          0,
          CHATGPT_MAX_CANDIDATES
        );
        const deadline = clock() + CHATGPT_CANDIDATE_BUDGET_MS;
        const tried: string[] = [];
        let ranOut = false;

        for (const path of paths) {
          // Each request also gets no more than the budget that is left, so a
          // single hung candidate cannot overrun the whole walk's ceiling.
          const remaining = deadline - clock();
          if (remaining <= 0) {
            ranOut = true;
            break;
          }
          tried.push(path);
          let response;
          try {
            response = await session.http(`${CHATGPT_ORIGIN}${path}`, {
              headers: authHeaders,
              timeoutMs: Math.min(DEFAULT_TIMEOUT_MS, remaining)
            });
          } catch {
            // One dead candidate must not end the search.
            continue;
          }
          if (classifyHttp(response) !== null) continue;

          const json = parseJson(response.body);
          if (json === null) continue;
          const buckets = parseChatGptUsage(json, now);
          if (buckets.length === 0) continue;

          lastGood = path;
          deps.onEndpointFound?.(path);
          return { buckets, status: 'ok', via: CHATGPT_WEB_ID };
        }

        // The path that worked last time evidently does not any more.
        lastGood = null;
        const ceiling = ranOut ? ', and ran out of time' : '';
        return failure(
          CHATGPT_WEB_ID,
          'endpoint-changed',
          `no chatgpt.com endpoint reported usage; tried ${tried.join(', ')}${ceiling}`
        );
      } catch (error) {
        return failure(CHATGPT_WEB_ID, 'error', errorMessage(error));
      }
    }
  };
}

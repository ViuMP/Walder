/**
 * Claude usage via a claude.ai browser session.
 *
 * The fallback for when the Claude Code token is expired or absent — and the
 * only source for someone who uses claude.ai but not the CLI. It works by
 * holding a real logged-in browser session in an Electron partition
 * (`persist:claude`), exactly as `login-window.ts` created it, and letting
 * Chromium attach that partition's cookies to the request. There is no token
 * handling here at all: the `sessionKey` cookie stays inside the partition, is
 * never read for its value, and is only ever tested for existence.
 *
 * Two requests, because usage is per-organisation: list the organisations, then
 * ask the chosen one. Both are unofficial endpoints — nothing about them is
 * promised — so an unexpected shape is reported as `endpoint-changed` and, when
 * it is logged at all, only its top-level *key names* are.
 */
import { parseClaudeUsage } from '../core/buckets';
import { authCheck, type AuthCheck } from '../core/last-check';
import {
  classifyHttp,
  describeResponse,
  describeThrow,
  errorMessage,
  failure,
  parseJson,
  topLevelKeys,
  NEEDS_APP_SESSION,
  type HttpResponse,
  type ProviderResult,
  type SessionSource,
  type UsageProvider
} from './types';

export const CLAUDE_WEB_ID = 'claude-web';
export const CLAUDE_WEB_LABEL = 'claude.ai login';
export const CLAUDE_WEB_PARTITION = 'persist:claude';

export const CLAUDE_AI_ORIGIN = 'https://claude.ai';
export const CLAUDE_ORGS_URL = `${CLAUDE_AI_ORIGIN}/api/organizations`;
/**
 * The second opinion for `isAuthenticated`, and only for it.
 *
 * `/api/organizations` is unofficial and has changed shape before; if it ever
 * answers 200 with something we cannot read as a list of organisations, the
 * honest question is "is this a logged-out browser, or an endpoint that moved?"
 * — and answering it wrong is what leaves the login window open forever with the
 * owner already logged in. So a 200 we cannot read is followed by one request to
 * `/api/account`, which is a much simpler thing to be sure about: 200 means the
 * cookie is live. Nothing is read out of its body; the status is the whole
 * signal (that body carries the owner's name and email).
 *
 * Never consulted by `fetch`: usage genuinely needs the organisation id, so a
 * broken organisation list is still `endpoint-changed` there.
 */
export const CLAUDE_ACCOUNT_URL = `${CLAUDE_AI_ORIGIN}/api/account`;
/** The cookie whose presence means "logged in to claude.ai". */
export const CLAUDE_SESSION_COOKIE = 'sessionKey';

/** Same `Accept` as the site's own XHRs; cookies do the authenticating. */
const WEB_HEADERS: Readonly<Record<string, string>> = { Accept: 'application/json' };

export const LOGGED_OUT_MESSAGE = 'not logged in to claude.ai';

/**
 * Timeout for `isAuthenticated`. Shorter than a poll's: the login window asks
 * every 2 s while it is open, so a slow answer must not queue up behind itself.
 */
export const AUTH_CHECK_TIMEOUT_MS = 5_000;

/** `GET /api/organizations/{uuid}/usage`. */
export function usageUrlFor(orgId: string): string {
  return `${CLAUDE_AI_ORIGIN}/api/organizations/${encodeURIComponent(orgId)}/usage`;
}

interface Org {
  readonly uuid: string;
  readonly capabilities: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the organisation list.
 *
 * Only `uuid` and `capabilities` are looked at; everything else in those objects
 * (names, member lists, billing) is the owner's data and is deliberately not
 * touched.
 */
export function parseOrgs(json: unknown): Org[] {
  if (!Array.isArray(json)) return [];
  const out: Org[] = [];
  for (const entry of json) {
    if (!isRecord(entry)) continue;
    const uuid = entry['uuid'];
    if (typeof uuid !== 'string' || uuid.length === 0) continue;
    const rawCaps = entry['capabilities'];
    const capabilities = Array.isArray(rawCaps)
      ? rawCaps.filter((c): c is string => typeof c === 'string')
      : [];
    out.push({ uuid, capabilities });
  }
  return out;
}

/**
 * Which organisation to ask.
 *
 * An account can carry several — a personal one plus a team — and only some can
 * chat. Prefer the first that declares a `chat` capability, because that is the
 * one whose allowance the owner is actually spending; fall back to the first
 * listed when nothing declares capabilities at all (an older response shape, or
 * a single-org account).
 */
export function chooseOrg(orgs: readonly Org[]): Org | null {
  const chatty = orgs.find((org) =>
    org.capabilities.some((c) => c.toLowerCase().includes('chat'))
  );
  return chatty ?? orgs[0] ?? null;
}

/**
 * What one `GET /api/organizations` said about the login, in the words the tray
 * can print. `authFailure` is separated out because it is the one verdict that
 * needs no second opinion — a 401 is not ambiguous.
 */
interface Verdict {
  readonly ok: boolean;
  readonly detail: string;
  readonly authFailure: boolean;
}

export function judgeOrgsResponse(response: HttpResponse): Verdict {
  if (response.status === 401 || response.status === 403) {
    return { ok: false, detail: `HTTP ${response.status}`, authFailure: true };
  }
  if (response.status !== 200 || classifyHttp(response) !== null) {
    return { ok: false, detail: describeResponse(response), authFailure: false };
  }
  if (parseOrgs(parseJson(response.body)).length === 0) {
    return { ok: false, detail: 'no organisation listed', authFailure: false };
  }
  return { ok: true, detail: '', authFailure: false };
}

export interface ClaudeWebDeps {
  /** `null` outside Electron — the probe script has no cookie jar. */
  readonly session: SessionSource;
  readonly onUnexpectedShape?: (keys: string[]) => void;
  /** Injected clock, so the tray's "(checked 12:03)" is testable. */
  readonly clock?: () => number;
}

export function createClaudeWebProvider(deps: ClaudeWebDeps): UsageProvider {
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

  return {
    id: CLAUDE_WEB_ID,
    service: 'claude',
    label: CLAUDE_WEB_LABEL,

    /** A `sessionKey` cookie for claude.ai exists. Existence only — never the value. */
    async isAvailable(): Promise<boolean> {
      const session = deps.session();
      if (session === null) return false;
      try {
        const cookies = await session.cookies({
          url: CLAUDE_AI_ORIGIN,
          name: CLAUDE_SESSION_COOKIE
        });
        return cookies.length > 0;
      } catch {
        return false;
      }
    },

    /**
     * A real, authenticated claude.ai session: `GET /api/organizations` answers
     * 200 with at least one organisation we can read — or, failing that,
     * `GET /api/account` answers 200.
     *
     * This is what the login window waits for, and why it is not the cookie
     * check above: claude.ai sets a cookie jar for a visitor who has not logged
     * in, and an expired `sessionKey` is still a `sessionKey`. The organisation
     * list is asked first because it is the same request `fetch` starts with, so
     * a yes from it means "polling will work" and not merely "a session exists".
     *
     * The fallback exists because these are unofficial endpoints and the failure
     * it covers is expensive: if `/api/organizations` changes shape, every
     * answer becomes "not logged in", the login window never closes, and the
     * owner is told to log in to an account he is already logged in to. It is
     * *not* tried after a 401 or 403 — that is a clear answer, and asking twice
     * would only double the traffic while the login window polls every 2 s.
     */
    async isAuthenticated(): Promise<boolean> {
      const session = deps.session();
      if (session === null) return remember(false, NEEDS_APP_SESSION, true);

      let verdict: Verdict;
      try {
        verdict = judgeOrgsResponse(
          await session.http(CLAUDE_ORGS_URL, {
            headers: WEB_HEADERS,
            timeoutMs: AUTH_CHECK_TIMEOUT_MS
          })
        );
      } catch (error) {
        return remember(false, describeThrow(error), true);
      }
      if (verdict.ok) return remember(true, '');
      if (verdict.authFailure) return remember(false, verdict.detail);

      try {
        const account = await session.http(CLAUDE_ACCOUNT_URL, {
          headers: WEB_HEADERS,
          timeoutMs: AUTH_CHECK_TIMEOUT_MS
        });
        // Status only. That body is the owner's profile and nothing in it is
        // read, logged or returned.
        if (account.status === 200 && classifyHttp(account) === null) return remember(true, '');
      } catch {
        // The fallback failing tells us nothing new; the first answer stands.
      }
      return remember(false, verdict.detail);
    },

    lastCheck(): AuthCheck | null {
      return checked;
    },

    async fetch(now: Date): Promise<ProviderResult> {
      const session = deps.session();
      if (session === null) {
        return failure(CLAUDE_WEB_ID, 'unavailable', NEEDS_APP_SESSION);
      }

      // One GET, returning either the parsed JSON or the finished failure the
      // caller should hand straight back. A discriminated union rather than
      // "JSON or a ProviderResult", so no runtime sniffing decides which it is.
      type Step = { readonly ok: true; readonly json: unknown } | { readonly ok: false; readonly result: ProviderResult };

      const step = async (url: string): Promise<Step> => {
        const response = await session.http(url, { headers: WEB_HEADERS });
        const problem = classifyHttp(response);
        if (problem === 'auth-needed') {
          return { ok: false, result: failure(CLAUDE_WEB_ID, 'auth-needed', LOGGED_OUT_MESSAGE) };
        }
        if (problem === 'rate-limited') {
          return {
            ok: false,
            result: failure(CLAUDE_WEB_ID, 'rate-limited', 'claude.ai asked us to slow down')
          };
        }
        if (problem === 'endpoint-changed') {
          return {
            ok: false,
            result: failure(
              CLAUDE_WEB_ID,
              'endpoint-changed',
              `claude.ai answered ${response.status} and not JSON`
            )
          };
        }
        if (problem !== null) {
          return {
            ok: false,
            result: failure(CLAUDE_WEB_ID, problem, `claude.ai answered ${response.status}`)
          };
        }
        const json = parseJson(response.body);
        if (json === null) {
          return {
            ok: false,
            result: failure(CLAUDE_WEB_ID, 'endpoint-changed', 'claude.ai returned unreadable JSON')
          };
        }
        return { ok: true, json };
      };

      try {
        const orgsStep = await step(CLAUDE_ORGS_URL);
        if (!orgsStep.ok) return orgsStep.result;

        const org = chooseOrg(parseOrgs(orgsStep.json));
        if (org === null) {
          deps.onUnexpectedShape?.(topLevelKeys(orgsStep.json));
          return failure(
            CLAUDE_WEB_ID,
            'endpoint-changed',
            'claude.ai listed no organisation we could read'
          );
        }

        const usageStep = await step(usageUrlFor(org.uuid));
        if (!usageStep.ok) return usageStep.result;
        const usageJson = usageStep.json;

        const buckets = parseClaudeUsage(usageJson, { scale: 'percent' });
        if (buckets.length === 0) {
          deps.onUnexpectedShape?.(topLevelKeys(usageJson));
          return failure(
            CLAUDE_WEB_ID,
            'endpoint-changed',
            'claude.ai returned no usage windows we recognise'
          );
        }
        // `now` is unused for this payload (its resets are ISO strings), but the
        // signature is the provider contract's clock and stays honest about it.
        void now;
        return { buckets, status: 'ok', via: CLAUDE_WEB_ID };
      } catch (error) {
        return failure(CLAUDE_WEB_ID, 'error', errorMessage(error));
      }
    }
  };
}

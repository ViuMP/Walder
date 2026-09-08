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
import {
  classifyHttp,
  errorMessage,
  failure,
  parseJson,
  topLevelKeys,
  NEEDS_APP_SESSION,
  type ProviderResult,
  type SessionSource,
  type UsageProvider
} from './types';

export const CLAUDE_WEB_ID = 'claude-web';
export const CLAUDE_WEB_LABEL = 'claude.ai login';
export const CLAUDE_WEB_PARTITION = 'persist:claude';

export const CLAUDE_AI_ORIGIN = 'https://claude.ai';
export const CLAUDE_ORGS_URL = `${CLAUDE_AI_ORIGIN}/api/organizations`;
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

export interface ClaudeWebDeps {
  /** `null` outside Electron — the probe script has no cookie jar. */
  readonly session: SessionSource;
  readonly onUnexpectedShape?: (keys: string[]) => void;
}

export function createClaudeWebProvider(deps: ClaudeWebDeps): UsageProvider {
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
     * 200 with at least one organisation we can read.
     *
     * This is what the login window waits for, and why it is not the cookie
     * check above: claude.ai sets a cookie jar for a visitor who has not logged
     * in, and an expired `sessionKey` is still a `sessionKey`. Only the
     * organisation list proves the session is live — and it is the same request
     * `fetch` starts with, so "authenticated" cannot mean anything other than
     * "polling will work".
     */
    async isAuthenticated(): Promise<boolean> {
      const session = deps.session();
      if (session === null) return false;
      try {
        const response = await session.http(CLAUDE_ORGS_URL, {
          headers: WEB_HEADERS,
          timeoutMs: AUTH_CHECK_TIMEOUT_MS
        });
        if (response.status !== 200 || classifyHttp(response) !== null) return false;
        return parseOrgs(parseJson(response.body)).length > 0;
      } catch {
        return false;
      }
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

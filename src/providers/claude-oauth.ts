/**
 * Claude usage via the Claude Code CLI's own OAuth token.
 *
 * The preferred Claude source: it is the allowance the owner actually spends in
 * Claude Code, it needs no browser login, and the endpoint returns exactly the
 * buckets the panel wants. Verified live on 2026-09-08 (BUILD_LOG): the request
 * shape below is what the CLI itself sends, and the response is an object keyed
 * by bucket name with `{ utilization, resets_at }` — utilization in **percent**,
 * which is why `parseClaudeUsage` is called with `scale: 'percent'` and never
 * left to guess.
 *
 * The token is read fresh on every poll and never refreshed (see
 * `credentials.ts`). When it is stale the provider says so in words the owner
 * can act on — which is, deliberately, "do nothing, Claude Code will fix it".
 * Since 2026-09-19 `onExpiresAt` reports each read's expiry onwards to
 * `main/claude-renew.ts`, which nudges the CLI into fixing it by itself — and a
 * 401 buys one re-read of the keychain before `auth-needed` is believed, because
 * the CLI's rotations leave several items to pick from (see `fetch`).
 */
import { parseClaudeUsage, type IgnoredWindow } from '../core/buckets';
import type { ClaudeCredentialsResult } from './credentials';
import { readClaudeCodeCredentials } from './credentials';
import {
  classifyHttp,
  errorMessage,
  failure,
  parseJson,
  topLevelKeys,
  type HttpFetch,
  type ProviderResult,
  type UsageProvider
} from './types';

export const CLAUDE_OAUTH_ID = 'claude-oauth';
export const CLAUDE_OAUTH_LABEL = 'Claude Code login';
export const CLAUDE_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/**
 * Exactly the headers Claude Code sends. The `anthropic-beta` opt-in is what
 * makes the OAuth usage route answer at all, and the `User-Agent` is pinned
 * because an unrecognised client is a plausible way for this route to start
 * refusing. No cookies are involved: this call is authenticated purely by the
 * bearer token, so it goes through `net.fetch` and not a session partition.
 */
export const CLAUDE_OAUTH_HEADERS: Readonly<Record<string, string>> = {
  'anthropic-beta': 'oauth-2025-04-20',
  'User-Agent': 'claude-code/2.1.0',
  Accept: 'application/json'
};

/**
 * What the panel says when the CLI token has expired.
 *
 * Phrased as reassurance rather than an instruction on purpose: the fix is for
 * the owner to keep using Claude Code, and telling them to "log in again" would
 * invite them to do something that is not needed.
 */
export const EXPIRED_MESSAGE =
  'Claude Code token expired — Claude Code will refresh it next time you use it';

/**
 * What the panel says when Claude Code's own keychain item has been emptied by
 * a logout rather than merely gone stale — there is no refresh token left for
 * `main/claude-renew.ts` to act on, so this is the one Claude auth-needed
 * sentence that names something the owner has to go and do.
 */
export const LOGGED_OUT_MESSAGE = 'Claude Code: logged out — run claude and log in';

export interface ClaudeOauthDeps {
  readonly http: HttpFetch;
  /** Injected for tests; defaults to the real keychain/file read. */
  readonly readCredentials?: () => Promise<ClaudeCredentialsResult>;
  /**
   * Told the expiry of every credential read, live or stale, with `null` for
   * "no login on this machine". A *shape*, never logged and never compared to
   * anything but itself — `main/claude-renew.ts` uses it to decide whether the
   * CLI is worth nudging, and to make sure it nudges once per expiry.
   */
  readonly onExpiresAt?: (expiresAt: number | null) => void;
  /** Called with the top-level keys of a payload we could not parse. */
  readonly onUnexpectedShape?: (keys: string[]) => void;
  /**
   * Told about every Claude window key `parseClaudeUsage`'s whitelist dropped
   * (`amber_ladder`, or the next codename) — shape only, see `IgnoredWindow`.
   */
  readonly onIgnoredWindow?: (window: IgnoredWindow) => void;
  /**
   * Called with the sorted top-level keys of every payload this provider does
   * turn into buckets — the "key dump" a developer needs to confirm a new
   * shape (`limits[]`, `extra_usage`) before writing a parser for it, without
   * ever having to look at a value.
   */
  readonly onUsageKeys?: (keys: string[]) => void;
}

export function createClaudeOauthProvider(deps: ClaudeOauthDeps): UsageProvider {
  const readCredentials = deps.readCredentials ?? (() => readClaudeCodeCredentials());

  return {
    id: CLAUDE_OAUTH_ID,
    service: 'claude',
    label: CLAUDE_OAUTH_LABEL,

    /**
     * True even for an expired token: a login that exists but is stale is worth
     * reporting to the owner, so the registry must see this provider as
     * available and let its `auth-needed` stand when nothing better answers.
     */
    async isAvailable(): Promise<boolean> {
      try {
        return (await readCredentials()) !== null;
      } catch {
        return false;
      }
    },

    async fetch(): Promise<ProviderResult> {
      let credentials: ClaudeCredentialsResult;
      try {
        credentials = await readCredentials();
      } catch (error) {
        return failure(CLAUDE_OAUTH_ID, 'error', errorMessage(error));
      }

      // Before the branches, so renewal hears about a *live* token too: that is
      // how it knows the last attempt worked, and how it arms itself for the
      // next expiry without waiting for the panel to go red first.
      deps.onExpiresAt?.(credentials === null ? null : credentials.expiresAt);

      if (credentials === null) {
        return failure(CLAUDE_OAUTH_ID, 'unavailable', 'no Claude Code login found');
      }
      if (credentials.expired) {
        // `onExpiresAt` above already got `null` for a logged-out credential,
        // so `shouldRenew` answers `no-login` and `claude-renew.ts` spawns
        // nothing — there is no refresh token left to act on either way.
        return failure(
          CLAUDE_OAUTH_ID,
          'auth-needed',
          credentials.loggedOut ? LOGGED_OUT_MESSAGE : EXPIRED_MESSAGE
        );
      }

      const get = (token: string) =>
        deps.http(CLAUDE_OAUTH_USAGE_URL, {
          headers: { ...CLAUDE_OAUTH_HEADERS, Authorization: `Bearer ${token}` }
        });

      let response;
      try {
        response = await get(credentials.accessToken);

        if (classifyHttp(response) === 'auth-needed') {
          // Claude Code files a *new* keychain item on every rotation instead of
          // updating the old one, and `security find-generic-password` returns
          // an arbitrary one of them — so the read above can hand back a stale
          // sibling while the live token sits right beside it. One re-read, and
          // only on a 401: the happy path never pays for it, and a genuinely
          // expired login costs one extra request before the same sentence.
          //
          // The refresh token is not touched. Re-*reading* the keychain is not
          // spending a refresh; renewal stays the CLI's job (see AGENTS.md).
          const second = await readCredentials();
          deps.onExpiresAt?.(second === null ? null : second.expiresAt);
          if (
            second !== null &&
            !second.expired &&
            second.accessToken !== credentials.accessToken
          ) {
            response = await get(second.accessToken);
          }
        }
      } catch (error) {
        return failure(CLAUDE_OAUTH_ID, 'error', errorMessage(error));
      }

      const problem = classifyHttp(response);
      if (problem === 'auth-needed') {
        // A 401 on a token that had not yet expired by the clock, and the
        // re-read above found nothing better: same cause as an expiry, same
        // remedy, so it gets the same sentence.
        return failure(CLAUDE_OAUTH_ID, 'auth-needed', EXPIRED_MESSAGE);
      }
      if (problem === 'rate-limited') {
        return failure(
          CLAUDE_OAUTH_ID,
          'rate-limited',
          'Anthropic asked us to slow down',
          response.retryAfterMs
        );
      }
      if (problem === 'endpoint-changed') {
        return failure(
          CLAUDE_OAUTH_ID,
          'endpoint-changed',
          `the usage endpoint answered ${response.status} and not JSON`
        );
      }
      if (problem !== null) {
        return failure(CLAUDE_OAUTH_ID, problem, `the usage endpoint answered ${response.status}`);
      }

      const json = parseJson(response.body);
      // `percent`, never `auto`: the endpoint returns 0-100, and a genuine 1 %
      // read as a fraction becomes 100 % — the false alarm the M2a review
      // caught.
      const buckets =
        json === null
          ? []
          : parseClaudeUsage(json, { scale: 'percent', onIgnored: deps.onIgnoredWindow });
      if (buckets.length === 0) {
        deps.onUnexpectedShape?.(topLevelKeys(json));
        return failure(
          CLAUDE_OAUTH_ID,
          'endpoint-changed',
          'the usage endpoint returned no windows we recognise'
        );
      }

      deps.onUsageKeys?.(topLevelKeys(json).sort());
      return { buckets, status: 'ok', via: CLAUDE_OAUTH_ID };
    }
  };
}

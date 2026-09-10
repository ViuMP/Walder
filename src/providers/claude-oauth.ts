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

export interface ClaudeOauthDeps {
  readonly http: HttpFetch;
  /** Injected for tests; defaults to the real keychain/file read. */
  readonly readCredentials?: () => Promise<ClaudeCredentialsResult>;
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

      if (credentials === null) {
        return failure(CLAUDE_OAUTH_ID, 'unavailable', 'no Claude Code login found');
      }
      if (credentials.expired) {
        return failure(CLAUDE_OAUTH_ID, 'auth-needed', EXPIRED_MESSAGE);
      }

      let response;
      try {
        response = await deps.http(CLAUDE_OAUTH_USAGE_URL, {
          headers: {
            ...CLAUDE_OAUTH_HEADERS,
            Authorization: `Bearer ${credentials.accessToken}`
          }
        });
      } catch (error) {
        return failure(CLAUDE_OAUTH_ID, 'error', errorMessage(error));
      }

      const problem = classifyHttp(response);
      if (problem === 'auth-needed') {
        // A 401 on a token that had not yet expired by the clock: same cause,
        // same remedy, so it gets the same sentence.
        return failure(CLAUDE_OAUTH_ID, 'auth-needed', EXPIRED_MESSAGE);
      }
      if (problem === 'rate-limited') {
        return failure(CLAUDE_OAUTH_ID, 'rate-limited', 'Anthropic asked us to slow down');
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

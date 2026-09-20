/**
 * GitHub Copilot usage via the GitHub CLI's own token.
 *
 * **The credential is `gh`'s, never ours.** `gh auth token` prints the token
 * the owner's own `gh auth login` already put there, and that is the whole
 * authentication story for this service: Walder runs no OAuth flow against
 * github.com, writes nothing into `gh`'s config, and never refreshes or
 * rotates anything — the same rule the Codex CLI is read under
 * (`credentials.ts`, rule 2). Spending someone else's refresh token logs them
 * out of the tool this mascot is supposed to be watching.
 *
 * **So there is no Copilot login window anywhere in Walder** (`LOGIN.copilot`
 * is `null`). There is nothing for one to do: a github.com sign-in in an
 * Electron window would create a browser session beside the CLI's, not fix a
 * `gh` that is logged out. `gh auth login`, in the owner's own terminal, is
 * the one remedy — which is what `COPILOT_LOGGED_OUT_MESSAGE` says.
 *
 * `GET copilot_internal/user` is the endpoint every open-source Copilot usage
 * tracker reads, and it answers with a user record whose `quota_snapshots`
 * object carries one percentage per quota. `parseCopilotUsage` in
 * `core/buckets.ts` turns those into rows — see its header for which snapshots
 * become rows and when a row is skipped.
 *
 * **A 404 here means "no Copilot on this account", not "the endpoint moved".**
 * `classifyHttp` maps every 404 to `endpoint-changed`, which is the right
 * reading for an endpoint that might have been renamed — but this one is
 * GitHub's documented answer for an account with no Copilot subscription at
 * all, and it is the answer most GitHub accounts give. Telling that owner the
 * endpoint changed would send him looking for a bug in Walder over a card that
 * is simply not for him, so the 404 is mapped explicitly to `unavailable` with
 * a sentence that says the true thing, before `classifyHttp` ever sees the
 * response. Only for this one endpoint.
 */
import { parseCopilotUsage } from '../core/buckets';
import { keyTreeLines } from '../core/usage-shape';
import { readCopilotCredentials, type CopilotCredentials } from './credentials';
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

export const COPILOT_ID = 'copilot';
export const COPILOT_LABEL = 'GitHub CLI login';
export const COPILOT_USER_URL = 'https://api.github.com/copilot_internal/user';

/**
 * api.github.com rejects a request with no `User-Agent`. There is no Walder UA
 * constant to reuse — `core/user-agent.ts` is the login windows' UA *stripper*,
 * and the one thing it strips is the `Walder/<version>` product token — so this
 * is the plain product name, with no version to announce.
 */
export const COPILOT_USER_AGENT = 'walder';

export const COPILOT_LOGGED_OUT_MESSAGE = 'GitHub CLI is not logged in — run gh auth login';
export const COPILOT_NOT_ENABLED_MESSAGE = 'GitHub Copilot is not enabled on this account';
export const COPILOT_UNREADABLE_MESSAGE =
  'GitHub Copilot answered with a payload Walder could not read (run npm run probe -- --keys)';

export interface CopilotDeps {
  readonly http: HttpFetch;
  readonly readCredentials?: () => Promise<CopilotCredentials | null>;
  /** Top-level keys of a payload we could not read as usage. Shape, never values. */
  readonly onUnexpectedShape?: (keys: string[]) => void;
  /** Top-level keys of every JSON answer, for `npm run probe -- --keys`. */
  readonly onUsageKeys?: (keys: string[]) => void;
  /** Nested key names and types (`keyTreeLines`), never values. Same audience. */
  readonly onUsageShape?: (lines: string[]) => void;
}

export function createCopilotProvider(deps: CopilotDeps): UsageProvider {
  const readCredentials = deps.readCredentials ?? (() => readCopilotCredentials());

  return {
    id: COPILOT_ID,
    service: 'copilot',
    label: COPILOT_LABEL,

    async isAvailable(): Promise<boolean> {
      try {
        return (await readCredentials()) !== null;
      } catch {
        return false;
      }
    },

    async fetch(): Promise<ProviderResult> {
      let credentials: CopilotCredentials | null;
      try {
        credentials = await readCredentials();
      } catch (error) {
        return failure(COPILOT_ID, 'error', errorMessage(error));
      }
      if (credentials === null) {
        return failure(COPILOT_ID, 'unavailable', COPILOT_LOGGED_OUT_MESSAGE);
      }

      let response;
      try {
        response = await deps.http(COPILOT_USER_URL, {
          headers: {
            Authorization: `token ${credentials.accessToken}`,
            Accept: 'application/json',
            'User-Agent': COPILOT_USER_AGENT
          }
        });
      } catch (error) {
        return failure(COPILOT_ID, 'error', errorMessage(error));
      }

      // Before `classifyHttp`, and only here: see the header — a 404 from this
      // endpoint is "no Copilot on this account", not "the endpoint moved".
      if (response.status === 404) {
        return failure(COPILOT_ID, 'unavailable', COPILOT_NOT_ENABLED_MESSAGE);
      }

      const bad = classifyHttp(response);
      if (bad !== null) {
        return failure(
          COPILOT_ID,
          bad,
          bad === 'auth-needed' ? COPILOT_LOGGED_OUT_MESSAGE : `HTTP ${response.status}`,
          response.retryAfterMs
        );
      }

      const json = parseJson(response.body);
      if (json === null) return failure(COPILOT_ID, 'endpoint-changed', 'response was not JSON');

      const keys = topLevelKeys(json);
      deps.onUsageKeys?.(keys);
      deps.onUsageShape?.(keyTreeLines(json));

      const buckets = parseCopilotUsage(json);
      if (buckets.length === 0) {
        // Not `ok` with no rows: a 200 whose `quota_snapshots` has gone is the
        // endpoint having moved, and reporting it as a healthy empty account
        // would put a calm face on a payload nobody can read.
        deps.onUnexpectedShape?.(keys);
        return failure(COPILOT_ID, 'endpoint-changed', COPILOT_UNREADABLE_MESSAGE);
      }
      return { buckets, status: 'ok', via: COPILOT_ID };
    }
  };
}

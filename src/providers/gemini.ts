/**
 * Gemini usage via the **Gemini CLI's** login, not the consumer Gemini app.
 *
 * **Why the CLI.** gemini.google.com shows the owner a usage dashboard, but the
 * only thing behind it is a private RPC of that web app's own — undocumented,
 * unversioned, and reachable only with a browser session Walder would have to
 * hold open in an Electron partition. The CLI's Code Assist quota call is the
 * other kind of endpoint: it is in the CLI's own source
 * (`packages/core/src/code_assist/server.ts`), every open-source Gemini usage
 * tracker reads it, and it authenticates with a token the owner's own
 * `gemini` login already put on disk. So the CLI is the source, and the
 * consumer app is not a fallback — it is a different product with no usable
 * endpoint (gap analysis §4, P2-2).
 *
 * **The token is used exactly as found, and never refreshed.**
 * `~/.gemini/oauth_creds.json` carries a `refresh_token` beside the access
 * token, and Walder never reads it — spending it rotates the pair and logs the
 * owner out of the CLI this mascot is watching (`credentials.ts`, rule 2, the
 * same rule Claude Code and Codex are read under). The CLI renews its own pair
 * the next time it runs, so an expired token is reported as `auth-needed` with
 * the sentence that names that: run `gemini` once.
 *
 * **Why two calls.** `:retrieveUserQuota` needs a Cloud project id, and a
 * personal-account login does not state one anywhere — not in the credential
 * file, not in the CLI's settings. `:loadCodeAssist` is the call that answers
 * with it (`cloudaicompanionProject`), which is exactly what the CLI itself
 * does on startup. A managed account names its project in `GOOGLE_CLOUD_PROJECT`
 * / `GOOGLE_CLOUD_PROJECT_ID` instead, and then there is nothing to ask for and
 * the first call is skipped.
 *
 * **The parser is not here yet — on purpose.** Walder's rule (CONTRIBUTING,
 * "Record the shape before writing anything") is that a parser follows a live
 * `npm run probe -- --keys` capture, never a document about one, and the owner
 * has not installed Gemini CLI yet. The documented shape (2026-09-20) is:
 *
 *   buckets [ { remainingAmount, remainingFraction, resetTime,
 *               tokenType, modelId } ]
 *
 * — but Cursor's live capture already disagreed with what the public trackers
 * documented, which is why the rule exists. So a 200 is reported as
 * `endpoint-changed` with its key names handed to `onUsageKeys` and its key
 * tree to `onUsageShape`, the probe prints both, and the buckets land in
 * `core/buckets.ts` the commit after the capture. Until then this provider is
 * in the probe's list and not in the app's chains.
 */
import { keyTreeLines } from '../core/usage-shape';
import { readGeminiCredentials, type GeminiCredentialsResult } from './credentials';
import {
  classifyHttp,
  errorMessage,
  failure,
  parseJson,
  topLevelKeys,
  type HttpFetch,
  type HttpResponse,
  type ProviderResult,
  type UsageProvider
} from './types';

export const GEMINI_ID = 'gemini';
export const GEMINI_LABEL = 'Gemini CLI login';

/** Code Assist's internal API, the one the CLI itself talks to. */
export const GEMINI_BASE_URL = 'https://cloudcode-pa.googleapis.com/v1internal';
export const GEMINI_LOAD_URL = `${GEMINI_BASE_URL}:loadCodeAssist`;
export const GEMINI_QUOTA_URL = `${GEMINI_BASE_URL}:retrieveUserQuota`;

/**
 * The `:loadCodeAssist` message. The three `metadata` fields are required and
 * the two `*_UNSPECIFIED` values are what a non-IDE client sends — Walder is
 * not an editor plugin and says so rather than claiming to be one.
 *
 * The CLI also puts `cloudaicompanionProject` in here when it already knows the
 * project. Walder only makes this call when it does *not* know one (see the
 * header), so that field never appears in Walder's copy of the message.
 */
export const GEMINI_LOAD_MESSAGE = JSON.stringify({
  metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
});

/** The `:retrieveUserQuota` message: the project, and nothing else. */
export function geminiQuotaMessage(project: string): string {
  return JSON.stringify({ project });
}

export const GEMINI_LOGGED_OUT_MESSAGE =
  'Gemini CLI is not logged in — run gemini once to sign in';
export const GEMINI_EXPIRED_MESSAGE = 'Gemini CLI login expired — run gemini once to renew it';
export const GEMINI_NOT_ONBOARDED_MESSAGE =
  'Gemini CLI has not been used yet — send it one prompt so Google sets up the account';
export const GEMINI_NO_PROJECT_MESSAGE = 'Gemini CLI: no project id from loadCodeAssist';
export const GEMINI_SHAPE_PENDING_MESSAGE =
  'Gemini CLI answered; its payload shape is not confirmed yet (run npm run probe -- --keys)';

export interface GeminiDeps {
  readonly http: HttpFetch;
  readonly readCredentials?: () => Promise<GeminiCredentialsResult>;
  /** Top-level keys of a payload we could not read as usage. Shape, never values. */
  readonly onUnexpectedShape?: (keys: string[]) => void;
  /** Top-level keys of every JSON answer, for `npm run probe -- --keys`. */
  readonly onUsageKeys?: (keys: string[]) => void;
  /** Nested key names and types (`keyTreeLines`), never values. Same audience. */
  readonly onUsageShape?: (lines: string[]) => void;
}

/** `cloudaicompanionProject` out of a `:loadCodeAssist` answer, if it has one. */
function projectFrom(json: unknown): string | null {
  const value = (json as { cloudaicompanionProject?: unknown } | null)?.cloudaicompanionProject;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function createGeminiProvider(deps: GeminiDeps): UsageProvider {
  const readCredentials = deps.readCredentials ?? (() => readGeminiCredentials());

  return {
    id: GEMINI_ID,
    // ponytail: the service is not in `SERVICES` until the parser exists, so
    // the card never grows a red Gemini section over a shape nobody confirmed.
    // The cast goes the day the four registration rows land with the parser.
    service: 'gemini' as UsageProvider['service'],
    label: GEMINI_LABEL,

    /**
     * True for an expired login too: it exists, and saying `auth-needed` about
     * it is more use to the owner than staying quiet. The same reading as
     * `claude-oauth.ts`.
     */
    async isAvailable(): Promise<boolean> {
      try {
        return (await readCredentials()) !== null;
      } catch {
        return false;
      }
    },

    async fetch(): Promise<ProviderResult> {
      let credentials: GeminiCredentialsResult;
      try {
        credentials = await readCredentials();
      } catch (error) {
        return failure(GEMINI_ID, 'error', errorMessage(error));
      }
      if (credentials === null) return failure(GEMINI_ID, 'unavailable', GEMINI_LOGGED_OUT_MESSAGE);
      if ('expired' in credentials) {
        // Never a refresh — see the header. The CLI renews its own pair, and
        // this sentence is how the owner learns to let it.
        return failure(GEMINI_ID, 'auth-needed', GEMINI_EXPIRED_MESSAGE);
      }

      const token = credentials.accessToken;
      const post = (url: string, message: string): Promise<HttpResponse> =>
        deps.http(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          post: message
        });

      /** Either the failure to return, or the parsed JSON body. */
      const send = async (
        url: string,
        message: string
      ): Promise<{ failed: ProviderResult } | { json: unknown }> => {
        let response: HttpResponse;
        try {
          response = await post(url, message);
        } catch (error) {
          return { failed: failure(GEMINI_ID, 'error', errorMessage(error)) };
        }
        const bad = classifyHttp(response);
        if (bad !== null) {
          return {
            failed: failure(
              GEMINI_ID,
              bad,
              // A 401 on a token the file said was live is that token having
              // died early, and the remedy is the same one: run `gemini`. A 403
              // is different — the token is fine and the *project* refuses the
              // call, which is what a login the CLI has never used looks like
              // (the CLI onboards the account on its first prompt). Same
              // status, so the code is kept in the sentence for the tray.
              bad === 'auth-needed'
                ? response.status === 403
                  ? GEMINI_NOT_ONBOARDED_MESSAGE
                  : GEMINI_EXPIRED_MESSAGE
                : `HTTP ${response.status}`,
              response.retryAfterMs
            )
          };
        }
        const json = parseJson(response.body);
        if (json === null) {
          return { failed: failure(GEMINI_ID, 'endpoint-changed', 'response was not JSON') };
        }
        return { json };
      };

      // The `:loadCodeAssist` key tree, kept so the probe can print it beside
      // the quota one — the shape of *both* calls is what the capture needs.
      // Empty when the environment named the project and the call was skipped.
      const shape: string[] = [];

      let project = credentials.project;
      if (project === null) {
        const loaded = await send(GEMINI_LOAD_URL, GEMINI_LOAD_MESSAGE);
        if ('failed' in loaded) return loaded.failed;
        shape.push('loadCodeAssist:', ...keyTreeLines(loaded.json));
        project = projectFrom(loaded.json);
        if (project === null) {
          // No project, so there is no second call to make. The keys of the
          // answer that should have carried one are the whole diagnostic.
          const keys = topLevelKeys(loaded.json);
          deps.onUsageKeys?.(keys);
          deps.onUsageShape?.(shape);
          deps.onUnexpectedShape?.(keys);
          return failure(GEMINI_ID, 'endpoint-changed', GEMINI_NO_PROJECT_MESSAGE);
        }
      }

      const quota = await send(GEMINI_QUOTA_URL, geminiQuotaMessage(project));
      if ('failed' in quota) return quota.failed;

      const keys = topLevelKeys(quota.json);
      deps.onUsageKeys?.(keys);
      // The lines after the `loadCodeAssist:` block are the quota answer's.
      deps.onUsageShape?.([...shape, ...keyTreeLines(quota.json)]);
      // See the header: the parser follows the capture, so every answer is
      // "the endpoint answered, and here is its shape" until then.
      deps.onUnexpectedShape?.(keys);
      return failure(GEMINI_ID, 'endpoint-changed', GEMINI_SHAPE_PENDING_MESSAGE);
    }
  };
}

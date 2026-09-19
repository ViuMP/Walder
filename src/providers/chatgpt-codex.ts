/**
 * ChatGPT usage via the Codex CLI's stored token.
 *
 * The one ChatGPT source verified end-to-end (BUILD_LOG, 2026-09-08): the token
 * in `~/.codex/auth.json` against `GET /backend-api/wham/usage` returns 200 with
 * `rate_limit.primary_window` (5 hours) and `rate_limit.secondary_window` (7
 * days).
 *
 * **These are the Codex allowance, not the ChatGPT chat allowance**, and the
 * labels say so — `parseChatGptUsage` names them "Codex 5-hour" and "Codex
 * weekly". Relabelling them as generic ChatGPT limits would be the single most
 * misleading thing this app could do, because the owner would ration the wrong
 * budget. If `chatgpt-web` ever finds the real chat endpoint, it sits ahead of
 * this provider in the chain and wins.
 *
 * No cookies, no session partition: pure bearer auth, so it works from the probe
 * script outside Electron.
 */
import { parseChatGptUsage } from '../core/buckets';
import { readCodexCredentials, type CodexCredentials } from './credentials';
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

export const CHATGPT_CODEX_ID = 'chatgpt-codex';
export const CHATGPT_CODEX_LABEL = 'Codex CLI login';
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/** The Codex CLI's own user agent; an unrecognised client may be refused. */
export const CODEX_USER_AGENT = 'codex_cli_rs/0.50.0';

export const LOGGED_OUT_MESSAGE = 'Codex CLI is not logged in — run `codex login`';

export interface ChatGptCodexDeps {
  readonly http: HttpFetch;
  readonly readCredentials?: () => Promise<CodexCredentials | null>;
  readonly onUnexpectedShape?: (keys: string[]) => void;
}

export function createChatGptCodexProvider(deps: ChatGptCodexDeps): UsageProvider {
  const readCredentials = deps.readCredentials ?? (() => readCodexCredentials());

  return {
    id: CHATGPT_CODEX_ID,
    service: 'chatgpt',
    label: CHATGPT_CODEX_LABEL,

    async isAvailable(): Promise<boolean> {
      try {
        return (await readCredentials()) !== null;
      } catch {
        return false;
      }
    },

    async fetch(now: Date): Promise<ProviderResult> {
      let credentials: CodexCredentials | null;
      try {
        credentials = await readCredentials();
      } catch (error) {
        return failure(CHATGPT_CODEX_ID, 'error', errorMessage(error));
      }
      if (credentials === null) {
        return failure(CHATGPT_CODEX_ID, 'unavailable', 'no Codex CLI login found');
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${credentials.accessToken}`,
        'User-Agent': CODEX_USER_AGENT,
        Accept: 'application/json'
      };
      // Sent only when the file carried one: an empty header value is a request
      // this endpoint rejects outright.
      if (credentials.accountId !== null) {
        headers['ChatGPT-Account-Id'] = credentials.accountId;
      }

      let response;
      try {
        response = await deps.http(CODEX_USAGE_URL, { headers });
      } catch (error) {
        return failure(CHATGPT_CODEX_ID, 'error', errorMessage(error));
      }

      const problem = classifyHttp(response);
      if (problem === 'auth-needed') {
        return failure(CHATGPT_CODEX_ID, 'auth-needed', LOGGED_OUT_MESSAGE);
      }
      if (problem === 'rate-limited') {
        return failure(
          CHATGPT_CODEX_ID,
          'rate-limited',
          'chatgpt.com asked us to slow down',
          response.retryAfterMs
        );
      }
      if (problem === 'endpoint-changed') {
        return failure(
          CHATGPT_CODEX_ID,
          'endpoint-changed',
          `the Codex usage endpoint answered ${response.status} and not JSON`
        );
      }
      if (problem !== null) {
        return failure(
          CHATGPT_CODEX_ID,
          problem,
          `the Codex usage endpoint answered ${response.status}`
        );
      }

      const json = parseJson(response.body);
      const buckets = json === null ? [] : parseChatGptUsage(json, now);
      if (buckets.length === 0) {
        deps.onUnexpectedShape?.(topLevelKeys(json));
        return failure(
          CHATGPT_CODEX_ID,
          'endpoint-changed',
          'the Codex usage endpoint returned no windows we recognise'
        );
      }

      return { buckets, status: 'ok', via: CHATGPT_CODEX_ID };
    }
  };
}

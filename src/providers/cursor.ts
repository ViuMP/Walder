/**
 * Cursor usage via the editor's own stored token.
 *
 * Cursor keeps a bearer JWT in its state database (`credentials.ts`,
 * `readCursorCredentials`) and its dashboard is a Connect-RPC service on
 * `api2.cursor.sh`: `GetCurrentPeriodUsage` is a POST with an empty JSON
 * message and answers with the billing cycle and three percentages. Every
 * open-source Cursor tracker reads this endpoint; none of them needed a
 * browser session, and neither does this — which is why there is no Cursor
 * login window anywhere in Walder (a cursor.com sign-in creates a second,
 * empty account; gap analysis §4, P2-2).
 *
 * **The parser is not here yet — on purpose.** The response shape below is what
 * the public trackers document (2026-09-20):
 *
 *   billingCycleStart, billingCycleEnd            RFC 3339
 *   planUsage { totalSpend, includedSpend, bonusSpend, limit }   cents
 *   totalPercentUsed, autoPercentUsed, apiPercentUsed
 *   spendLimitUsage { pooledLimit, pooledUsed, pooledRemaining, individualUsed }
 *
 * with `limit` 0 on free plans, where `autoPercentUsed` is the real number.
 * Walder's rule (CONTRIBUTING, "Record the shape before writing anything") is
 * that a parser follows a live `npm run probe -- --keys` capture, never a
 * document about one. So a 200 with JSON is reported as `endpoint-changed`
 * with the key names handed to `onUsageKeys` — exactly what the probe prints —
 * and the buckets land in `core/buckets.ts` the commit after the capture.
 * Until then this provider is in the probe's list and not in the app's chains.
 */
import { keyTreeLines } from '../core/usage-shape';
import { readCursorCredentials, type CursorCredentials } from './credentials';
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

export const CURSOR_ID = 'cursor';
export const CURSOR_LABEL = 'Cursor login';
export const CURSOR_USAGE_URL =
  'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';

/** Connect-RPC: the request message is a JSON object, empty for this method. */
export const CURSOR_USAGE_MESSAGE = '{}';

export const CURSOR_LOGGED_OUT_MESSAGE = 'Cursor is not logged in — sign in inside the editor';
export const CURSOR_SHAPE_PENDING_MESSAGE =
  'Cursor answered; its payload shape is not confirmed yet (run npm run probe -- --keys)';

export interface CursorDeps {
  readonly http: HttpFetch;
  readonly readCredentials?: () => Promise<CursorCredentials | null>;
  /** Top-level keys of a payload we could not read as usage. Shape, never values. */
  readonly onUnexpectedShape?: (keys: string[]) => void;
  /** Top-level keys of every JSON answer, for `npm run probe -- --keys`. */
  readonly onUsageKeys?: (keys: string[]) => void;
  /** Nested key names and types (`keyTreeLines`), never values. Same audience. */
  readonly onUsageShape?: (lines: string[]) => void;
}

export function createCursorProvider(deps: CursorDeps): UsageProvider {
  const readCredentials = deps.readCredentials ?? (() => readCursorCredentials());

  return {
    id: CURSOR_ID,
    // ponytail: the service is not in `SERVICES` until the parser exists, so
    // the card never grows a red Cursor section over a shape nobody confirmed.
    // The cast goes the day the four registration rows land with the parser.
    service: 'cursor' as UsageProvider['service'],
    label: CURSOR_LABEL,

    async isAvailable(): Promise<boolean> {
      try {
        return (await readCredentials()) !== null;
      } catch {
        return false;
      }
    },

    async fetch(): Promise<ProviderResult> {
      let credentials: CursorCredentials | null;
      try {
        credentials = await readCredentials();
      } catch (error) {
        return failure(CURSOR_ID, 'error', errorMessage(error));
      }
      if (credentials === null) return failure(CURSOR_ID, 'unavailable', CURSOR_LOGGED_OUT_MESSAGE);

      let response;
      try {
        response = await deps.http(CURSOR_USAGE_URL, {
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          post: CURSOR_USAGE_MESSAGE
        });
      } catch (error) {
        return failure(CURSOR_ID, 'error', errorMessage(error));
      }

      const bad = classifyHttp(response);
      if (bad !== null) {
        return failure(
          CURSOR_ID,
          bad,
          bad === 'auth-needed' ? CURSOR_LOGGED_OUT_MESSAGE : `HTTP ${response.status}`,
          response.retryAfterMs
        );
      }

      const json = parseJson(response.body);
      if (json === null) return failure(CURSOR_ID, 'endpoint-changed', 'response was not JSON');

      const keys = topLevelKeys(json);
      deps.onUsageKeys?.(keys);
      deps.onUsageShape?.(keyTreeLines(json));
      // See the header: the parser follows the capture, so every answer is
      // "the endpoint answered, and here is its shape" until then.
      deps.onUnexpectedShape?.(keys);
      return failure(CURSOR_ID, 'endpoint-changed', CURSOR_SHAPE_PENDING_MESSAGE);
    }
  };
}

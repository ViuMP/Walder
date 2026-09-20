/**
 * Cursor usage via the editor's own stored token.
 *
 * Cursor keeps a bearer JWT in its state database (`credentials.ts`,
 * `readCursorCredentials`) and its dashboard is a Connect-RPC service on
 * `api2.cursor.sh`: `GetCurrentPeriodUsage` is a POST with an empty JSON
 * message and answers with the billing cycle, the plan percentages and the
 * on-demand spend cap. Every open-source Cursor tracker reads this endpoint;
 * none of them needed a browser session, and neither does this — which is why
 * there is no Cursor login window anywhere in Walder (a cursor.com sign-in
 * creates a second, empty account; gap analysis §4, P2-2).
 *
 * The shape is the **captured** one, not the documented one. `npm run probe --
 * --keys` on the owner's Mac (2026-09-20, Free plan) returned:
 *
 *   billingCycleStart, billingCycleEnd            RFC 3339
 *   planUsage { autoPercentUsed, apiPercentUsed, totalPercentUsed,
 *               remainingBonus, bonusTooltip }
 *   spendLimitUsage { pooledLimit, pooledRemaining, individualLimit,
 *                     limitType, overallLimit, overallRemaining }
 *   displayThreshold, displayMessage, autoModelSelectedDisplayMessage,
 *   namedModelSelectedDisplayMessage, autoBucketModels
 *
 * The trackers' `planUsage.limit`, `totalSpend` and top-level percentages do
 * not exist on this account, so `parseCursorUsage` in `core/buckets.ts` parses
 * only what is above and nothing else — see its header for the three rows and
 * the rules that decide whether each one appears.
 *
 * An **empty parse is `endpoint-changed`, never a confident 0 %**: a payload
 * that no longer carries `planUsage` is Cursor having moved the shape, and the
 * key names go to `onUnexpectedShape` so the log says which. `onUsageKeys` and
 * `onUsageShape` stay for `npm run probe -- --keys`, which is how the next
 * change to this payload gets read before anything is written against it.
 */
import { parseCursorUsage } from '../core/buckets';
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
export const CURSOR_UNREADABLE_MESSAGE =
  'Cursor answered with a payload Walder could not read (run npm run probe -- --keys)';

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
    service: 'cursor',
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

      const buckets = parseCursorUsage(json);
      if (buckets.length === 0) {
        // Not `ok` with no rows: a 200 whose `planUsage` has gone is the
        // endpoint having moved, and reporting it as a healthy empty account
        // would put a calm face on a payload nobody can read.
        deps.onUnexpectedShape?.(keys);
        return failure(CURSOR_ID, 'endpoint-changed', CURSOR_UNREADABLE_MESSAGE);
      }
      return { buckets, status: 'ok', via: CURSOR_ID };
    }
  };
}

/**
 * Everything the main process needs to know about a service *by name*, in one
 * table.
 *
 * This is one of the **four registration points for a new service**:
 *
 *  1. `core/services.ts` — the `SERVICES` tuple and its `SERVICE_INFO` row
 *     (label, card title, no-login remedy);
 *  2. **this table** — where its login page is, which origin its endpoints are
 *     discovered on, which store key those discoveries go to, which `persist:`
 *     partition holds its cookies, and what its login window is called;
 *  3. the chain literal in `provider-chains.ts`'s `createChains` — which
 *     providers answer for it, best first;
 *  4. the provider modules themselves.
 *
 * It lives in its own file rather than in `login-window.ts` for one dull
 * reason: `login-window.ts` imports `sessionFor` from `provider-chains.ts`, and
 * `provider-chains.ts` needs the partitions out of this table, so keeping the
 * table in either of them makes the two import each other. A leaf module both
 * can read has no such problem — and nothing here touches `electron`.
 */
import { CLAUDE_AI_ORIGIN, CLAUDE_WEB_PARTITION } from '../providers/claude-web';
import { CHATGPT_ORIGIN, CHATGPT_WEB_PARTITION } from '../providers/chatgpt-web';
import type { ServiceName } from '../core/services';

/**
 * Where a service's browser login lives — or `null` for a service that has no
 * browser login at all.
 *
 * `null` is Cursor, and it is a design decision rather than a gap: the token is
 * read out of the editor's own state database, and a cursor.com sign-in in a
 * Walder window would create a second, empty Cursor account rather than
 * authenticate the one the editor is using (gap analysis §4, P2-2). So there is
 * no URL, no partition, no discovery key and no login window — and the three
 * consumers of this table (`sessionFor`, `createLoginWindows`, the tray's
 * Accounts submenu) each say in place what they do with a `null` row.
 */
export interface LoginInfo {
  /** Where the login window starts, and where `did-navigate` reverts to. */
  readonly url: string;
  /** The origin `endpoint-discovery` watches while that window is open. */
  readonly origin: string;
  /**
   * Store key the discovered endpoints go to. These strings are **persisted
   * settings keys**, not derived from the service name: renaming one
   * silently discards every endpoint an owner's app has learned.
   */
  readonly discoveryKey: string;
  /** The `persist:` partition holding this service's cookies. */
  readonly partition: string;
  /** Title bar of the login window. */
  readonly title: string;
}

export const LOGIN: Readonly<Record<ServiceName, LoginInfo | null>> = {
  claude: {
    url: 'https://claude.ai/login',
    origin: CLAUDE_AI_ORIGIN,
    discoveryKey: 'claudeDiscoveredEndpoints',
    partition: CLAUDE_WEB_PARTITION,
    title: 'Log in to Claude'
  },
  chatgpt: {
    url: 'https://chatgpt.com/auth/login',
    origin: CHATGPT_ORIGIN,
    discoveryKey: 'chatgptDiscoveredEndpoints',
    partition: CHATGPT_WEB_PARTITION,
    title: 'Log in to ChatGPT'
  },
  // No web login by design — see `LoginInfo` above.
  cursor: null
};

/**
 * The Electron half of the provider layer: builds the chains the poller uses.
 *
 * Everything Electron-specific about fetching usage is here, and nowhere else:
 *
 *  - **`net.fetch`** for the bearer-token providers (`claude-oauth`,
 *    `chatgpt-codex`). Chromium's network stack, with **no** cookie jar — those
 *    calls authenticate with a header, and attaching the owner's browsing
 *    cookies to them would be both pointless and a way to leak a session into a
 *    request that did not need one.
 *  - **`session.fromPartition('persist:…').fetch`** for the two web providers,
 *    which is the entire mechanism behind them: the partition holds the cookies
 *    that `login-window.ts` created, and Chromium attaches them.
 *  - **Two separate partitions**, `persist:claude` and `persist:chatgpt`, so
 *    neither site can see the other's cookies and logging out of one cannot
 *    touch the other.
 *
 * Nothing here logs a header, a cookie or a body. The `onUnexpectedShape` hooks
 * log *key names only* — enough to tell "they renamed the field" from "they
 * moved the endpoint", with none of the values.
 */
import { net, session } from 'electron';
import type { Session } from 'electron';
import { fromFetch, type FetchLike } from '../providers/http';
import { createClaudeOauthProvider } from '../providers/claude-oauth';
import { createClaudeWebProvider, CLAUDE_WEB_PARTITION } from '../providers/claude-web';
import { createChatGptWebProvider, CHATGPT_WEB_PARTITION } from '../providers/chatgpt-web';
import { createChatGptCodexProvider } from '../providers/chatgpt-codex';
import { mergeDiscovered, sanitizePaths } from '../providers/endpoint-discovery';
import type { PartitionSession } from '../providers/types';
import type { ProviderChains } from '../providers/registry';
import type { WalderStore } from './store';
import { vlog } from './log';

/** The partition each web provider lives in. */
export const PARTITIONS = {
  claude: CLAUDE_WEB_PARTITION,
  chatgpt: CHATGPT_WEB_PARTITION
} as const;

export function sessionFor(service: 'claude' | 'chatgpt'): Session {
  return session.fromPartition(PARTITIONS[service]);
}

/**
 * Wrap an Electron `Session` as the providers' `PartitionSession`.
 *
 * `session.fetch` is the cookie-bearing call; `session.cookies.get` is only ever
 * asked whether a cookie *exists*. The returned records are reduced to
 * `{name, domain}` here so no value can travel further into the app even by
 * accident.
 */
export function partitionSession(electronSession: Session): PartitionSession {
  return {
    http: fromFetch(electronSession.fetch.bind(electronSession) as unknown as FetchLike),
    async cookies(filter) {
      const found = await electronSession.cookies.get(filter);
      return found.map((cookie) => ({ name: cookie.name, domain: cookie.domain ?? '' }));
    }
  };
}

/**
 * Read a discovered-endpoints list out of the store, defensively — and scrub it.
 *
 * `sanitizePaths` strips any query string and drops anything that is not a
 * plain path. Walder used to store path *and query*, so a settings file written
 * before the 2026-09-08 security gate can hold `/usage?token=…`; the cleaned
 * list is written straight back, so the stale value stops being replayed on
 * every poll and stops sitting in a plain JSON file.
 */
function discovered(store: WalderStore, key: 'chatgptDiscoveredEndpoints'): string[] {
  const raw = store.get(key);
  const stored = Array.isArray(raw) ? raw : [];
  const clean = sanitizePaths(stored);
  const changed =
    clean.length !== stored.length || clean.some((value, index) => value !== stored[index]);
  if (changed) {
    store.set(key, clean);
    vlog('scrubbed stored discovered endpoints down to paths');
  }
  return clean;
}

export interface ChainDeps {
  readonly store: WalderStore;
}

/**
 * Build both chains, best source first.
 *
 * Claude: the CLI token, then the browser session. The CLI token is preferred
 * because it is the allowance actually spent in Claude Code and needs no login
 * window.
 *
 * ChatGPT: the browser session, then the Codex CLI token. This order is
 * deliberate and is the opposite of Claude's — the Codex endpoint reports the
 * *Codex* allowance, not the chat allowance (BUILD_LOG, 2026-09-08), so as soon
 * as the web provider finds an endpoint carrying real chat limits it should win.
 * Until it does, the Codex buckets are shown with honest "Codex …" labels.
 */
export function createChains(deps: ChainDeps): ProviderChains {
  const { store } = deps;
  // Bound: `net.fetch` is a method on the `net` module object, and an unbound
  // reference is a way to break on an Electron upgrade for no reason.
  const httpNoCookies = fromFetch(net.fetch.bind(net) as unknown as FetchLike);

  const claudeSession = partitionSession(sessionFor('claude'));
  const chatgptSession = partitionSession(sessionFor('chatgpt'));

  return {
    claude: [
      createClaudeOauthProvider({
        http: httpNoCookies,
        onUnexpectedShape: (keys) => vlog('claude-oauth: unexpected payload keys', keys.join(','))
      }),
      createClaudeWebProvider({
        session: () => claudeSession,
        onUnexpectedShape: (keys) => vlog('claude-web: unexpected payload keys', keys.join(','))
      })
    ],
    chatgpt: [
      createChatGptWebProvider({
        session: () => chatgptSession,
        discoveredPaths: () => discovered(store, 'chatgptDiscoveredEndpoints'),
        onEndpointFound: (path) => {
          // Promote the endpoint that actually worked to the front of the stored
          // list, so the next poll tries it first instead of walking the
          // candidates again.
          const existing = discovered(store, 'chatgptDiscoveredEndpoints');
          const promoted = mergeDiscovered([path], existing.filter((p) => p !== path));
          store.set('chatgptDiscoveredEndpoints', promoted);
          vlog('chatgpt-web: usage came from', path);
        },
        onUnexpectedShape: (keys) => vlog('chatgpt-web: unexpected payload keys', keys.join(','))
      }),
      createChatGptCodexProvider({
        http: httpNoCookies,
        onUnexpectedShape: (keys) => vlog('chatgpt-codex: unexpected payload keys', keys.join(','))
      })
    ]
  };
}

/**
 * The Electron half of the provider layer: builds the chains the poller uses.
 *
 * Everything Electron-specific about fetching usage is here, and nowhere else:
 *
 *  - **`net.fetch`** for the bearer-token providers (`claude-oauth`,
 *    `chatgpt-codex`), with `credentials: 'omit'`. Chromium's network stack,
 *    with **no** cookie jar — those calls authenticate with a header, and
 *    attaching the owner's browsing cookies to them would be both pointless and
 *    a way to leak a session into a request that did not need one.
 *  - **`session.fromPartition('persist:…').fetch`** for the two web providers,
 *    with `credentials: 'include'` — the entire mechanism behind them: the
 *    partition holds the cookies that `login-window.ts` created, and Chromium
 *    attaches them. **`'include'` is not a belt-and-braces flag** (2026-09-08):
 *    without it the WHATWG default of `same-origin` applies, a main-process
 *    request has no origin for that to match, and Chromium sends no cookies at
 *    all — which is why the owner could log in to ChatGPT inside Walder's own
 *    window and still be told he was not logged in.
 *  - **Two separate partitions**, `persist:claude` and `persist:chatgpt`, so
 *    neither site can see the other's cookies and logging out of one cannot
 *    touch the other.
 *
 * Nothing here logs a header, a cookie or a body. The `onUnexpectedShape` hooks
 * log *key names only* — enough to tell "they renamed the field" from "they
 * moved the endpoint", with none of the values.
 */
import { app, net, session } from 'electron';
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
import { chromeUserAgent } from '../core/user-agent';
import { vlog } from './log';

/** The partition each web provider lives in. */
export const PARTITIONS = {
  claude: CLAUDE_WEB_PARTITION,
  chatgpt: CHATGPT_WEB_PARTITION
} as const;

/** Partitions whose User-Agent has already been set; see `sessionFor`. */
const uaApplied = new Set<string>();

/** Has the process-wide default been cleaned yet? See below. */
let fallbackApplied = false;

/**
 * Clean the **process-wide default** User-Agent, once.
 *
 * `session.setUserAgent` covers the partition's own network requests, and that
 * is most of them — but not all, which the 2026-09-08 dev run showed plainly:
 * hCaptcha's proof-of-work script runs in a *worker*, and every request that
 * worker made still carried the untouched Electron default
 * (`… walder/0.1.0 Chrome/152 Electron/44.2.0 …`). Workers snapshot the app's
 * fallback rather than the session's UA, so a captcha vendor — the one piece of
 * a login page whose whole job is deciding whether a visitor is a real browser —
 * was being told "Electron" while the page around it said "Chrome". That is a
 * worse signal than either answer on its own.
 *
 * Setting the fallback fixes the workers and, incidentally, `net.fetch` for the
 * two bearer providers. It is a *subtraction* like `chromeUserAgent` itself: no
 * version invented, no platform changed.
 */
function applyChromeUserAgentFallback(): void {
  if (fallbackApplied) return;
  fallbackApplied = true;
  const cleaned = chromeUserAgent(app.userAgentFallback);
  if (cleaned === app.userAgentFallback) return;
  app.userAgentFallback = cleaned;
  vlog('default user agent set to', cleaned);
}

/**
 * The session for a service's partition, with its User-Agent fixed.
 *
 * Electron's default UA carries `Electron/44.2.0` and `Walder/0.1.1`, and
 * `Electron/…` is exactly what Google looks for when it refuses OAuth from an
 * embedded browser ("this browser or app may not be secure") — the login page
 * would render and the "continue with Google" button would then dead-end. The
 * anti-bot layers in front of both login pages treat an unknown UA the same way.
 * `chromeUserAgent` strips the two app tokens and leaves the genuine Chrome UA
 * of the Chromium this build embeds.
 *
 * Set on the **session**, not the window, so it covers three things at once: the
 * login window, the widget frames inside it, and the provider `session.fetch`
 * polls that later run on the same partition. `applyChromeUserAgentFallback`
 * covers the fourth — workers, which inherit the app-wide default instead.
 *
 * Idempotent by construction — this function is called on every poll, and the
 * guard keeps it to one `setUserAgent` per partition per run.
 */
export function sessionFor(service: 'claude' | 'chatgpt'): Session {
  // First, and before any window exists: workers inherit the app-wide fallback
  // rather than the session's UA.
  applyChromeUserAgentFallback();
  const partition = PARTITIONS[service];
  const target = session.fromPartition(partition);
  if (!uaApplied.has(partition)) {
    uaApplied.add(partition);
    const ua = chromeUserAgent(target.getUserAgent());
    target.setUserAgent(ua);
    vlog('user agent for', partition, 'set to', ua);
  }
  return target;
}

/**
 * Wrap an Electron `Session` as the providers' `PartitionSession`.
 *
 * `session.fetch` is the cookie-bearing call — but only with
 * `credentials: 'include'`, which is why that argument is here and not
 * defaulted. `session.cookies.get` is only ever asked whether a cookie *exists*;
 * the returned records are reduced to `{name, domain}` here so no value can
 * travel further into the app even by accident.
 */
export function partitionSession(electronSession: Session): PartitionSession {
  return {
    http: fromFetch(
      electronSession.fetch.bind(electronSession) as unknown as FetchLike,
      'include'
    ),
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
  const httpNoCookies = fromFetch(net.fetch.bind(net) as unknown as FetchLike, 'omit');

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

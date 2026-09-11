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
 * moved the endpoint", with none of the values. `onIgnoredWindow` and
 * `onUsageKeys` are the same idea applied to a payload that *did* parse: which
 * Claude key the whitelist dropped, and which top-level keys a successful
 * payload carried — both wired through `emitIgnoredWindow`/`emitKeySet` below,
 * which reuse `sessionFor`'s "once per run, not once per poll" shape (see
 * `uaApplied`) so three-minute polling does not turn one fact into an endless
 * repeat of the same log line.
 *
 * `onUsageShape` is the one exception, and the only thing here that prints a
 * value at all: nested field names with their *numbers*, for whoever is
 * writing the `limits[]` and `extra_usage` parsers against a shape that is
 * still researched rather than observed. It is off unless
 * `WALDER_DUMP_USAGE_SHAPE=1`, refused outright in a packaged build, and
 * silent without verbose logging — three gates, because it is a development
 * tool and not a feature.
 */
import { app, net, session } from 'electron';
import type { Session } from 'electron';
import { fromFetch, type FetchLike } from '../providers/http';
import { createClaudeOauthProvider, CLAUDE_OAUTH_ID } from '../providers/claude-oauth';
import {
  createClaudeWebProvider,
  CLAUDE_WEB_ID,
  CLAUDE_WEB_PARTITION
} from '../providers/claude-web';
import {
  createChatGptWebProvider,
  CHATGPT_WEB_ID,
  CHATGPT_WEB_PARTITION
} from '../providers/chatgpt-web';
import { createChatGptCodexProvider } from '../providers/chatgpt-codex';
import { mergeDiscovered, sanitizePaths } from '../providers/endpoint-discovery';
import type { PartitionSession } from '../providers/types';
import type { ProviderChains } from '../providers/registry';
import type { IgnoredWindow } from '../core/buckets';
import type { WalderStore } from './store';
import { chromeUserAgent } from '../core/user-agent';
import { vlog, verbose } from './log';
import { ignoredWindowLine, keySetLine, once } from './usage-diagnostics';

/**
 * The two usage-shape diagnostics, gated so each shows up once per run rather
 * than once per three-minute poll. See `usage-diagnostics.ts` for why they
 * exist at all — the short version is `amber_ladder`, found on the owner's own
 * account 2026-09-10 with no way to have seen it coming.
 *
 * `emitIgnoredWindow` dedupes on the **key alone**, deliberately not
 * `(provider, key)`: the same unknown key showing up via both `claude-oauth`
 * and `claude-web` is one fact ("Anthropic added/renamed a window"), not two,
 * and the owner does not need to read it twice just because both Claude
 * providers happened to run this poll. `emitKeySet` dedupes on the provider
 * *and* the sorted key set together, so a provider that starts returning a
 * different shape — the actual signal a key dump exists to catch — logs
 * again rather than being silenced by the first run's line.
 *
 * Both pass `verbose` as `once`'s `shouldEmit`: a key must not be marked
 * "seen" while diagnostics are off, or turning **Developer ▸ Verbose log** on
 * later and pressing **Refresh now** finds every key already consumed and
 * says nothing — see `once`'s doc comment for the 2026-09-10 bug this closed.
 */
const emitIgnoredWindow = once(
  (arg: { readonly provider: string; readonly window: IgnoredWindow }) => arg.window.key,
  (arg) => vlog(ignoredWindowLine(arg.provider, arg.window)),
  verbose
);

const emitKeySet = once(
  (arg: { readonly provider: string; readonly keys: readonly string[] }) =>
    `${arg.provider}:${[...arg.keys].sort().join(',')}`,
  (arg) => vlog(keySetLine(arg.provider, arg.keys)),
  verbose
);

/**
 * Is the developer values dump switched on?
 *
 * Read **once**, at module load, and deliberately not per poll: an environment
 * variable is a decision made when the app was started, and re-reading it
 * every three minutes only invites the belief that it can be flipped in a
 * running app (it cannot — nothing mutates `process.env` here) while making
 * the gate's behaviour depend on when it was asked.
 *
 * Two conditions, and the second is the important one. `app.isPackaged` refuses
 * the dump in a shipped build **whatever the environment says**, because the
 * flag is not a feature the owner should be able to turn on: it prints the
 * structure of his own account payload, and its whole justification is that a
 * developer runs `npm run dev` on his own machine while writing the `limits[]`
 * parser. An env var alone would be a one-line instruction away from being on
 * in a packaged app — and `usageShapeLines` is careful, but "careful about
 * strings" is a much weaker promise than "not present in the product".
 *
 * On top of both, `dumpUsageShape` below still checks `verbose()` per call:
 * without **Developer ▸ Verbose log** ticked, `vlog` writes nothing anyway, and
 * `once` must not consume the key set while it does not (the 2026-09-10 bug in
 * `once`'s doc comment).
 */
const DUMP_USAGE_SHAPE =
  process.env['WALDER_DUMP_USAGE_SHAPE'] === '1' && !app.isPackaged;

/**
 * The values dump: once per distinct set of line *shapes*, not once per poll.
 *
 * Keyed on the joined lines themselves, which is the right key for exactly the
 * reason `emitKeySet` is keyed on the sorted key set: a payload whose structure
 * has not changed is not news the second time, and a payload whose structure
 * *has* changed — a renamed `limits[]` field, an `extra_usage` object that
 * appeared — is the one thing this exists to show, and must not be swallowed
 * by the first poll's line. Numbers move between polls, so this does re-log
 * when a utilization changes; that is the honest cost of dumping values at all,
 * and it is why the whole thing is behind an env var rather than on by default.
 */
const dumpUsageShape = once(
  (arg: { readonly provider: string; readonly lines: readonly string[] }) =>
    `${arg.provider}:${arg.lines.join('|')}`,
  (arg) => {
    for (const line of arg.lines) vlog('usage shape: ' + line);
  },
  verbose
);

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
 * **Claude: the browser session, then the CLI token** — reversed on 2026-09-10,
 * and the reason is worth stating because the old order looked more sensible.
 * `resolveService` takes the *first `ok`* provider and never calls the rest, so
 * whichever comes first is the only one that runs on a healthy machine. The two
 * routes do not report the same thing: `claude.ai/api/organizations/{org}/usage`
 * carries the per-model `limits[]` array (where the real Fable weekly number
 * lives) and the `extra_usage` spend figure, and it is the only route with a
 * supplement endpoint behind it; `api.anthropic.com/api/oauth/usage` carries the
 * plain windows. With the CLI token first, the richer route was reached only
 * when the token had expired — which is exactly how the Fable row spent a month
 * being a mirror of the weekly one that nobody could explain.
 *
 * What this costs: the card says "via claude.ai login" where it used to say
 * "via Claude Code login". Cosmetic — both describe the same account and the
 * same allowance. What it does not cost: anything for an owner with no
 * claude.ai session, whose `isAvailable` is false and who therefore falls
 * straight through to the token route, unchanged.
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
      createClaudeWebProvider({
        session: () => claudeSession,
        onUnexpectedShape: (keys) => vlog('claude-web: unexpected payload keys', keys.join(',')),
        onIgnoredWindow: (window) => emitIgnoredWindow({ provider: CLAUDE_WEB_ID, window }),
        onUsageKeys: (keys) => emitKeySet({ provider: CLAUDE_WEB_ID, keys }),
        // Left `undefined` when the flag is off, so the provider never even
        // walks the payload — the gate is the absence of the callback, not a
        // no-op inside it.
        onUsageShape: DUMP_USAGE_SHAPE
          ? (lines): void => dumpUsageShape({ provider: CLAUDE_WEB_ID, lines })
          : undefined,
        // Not gated by `once`, unlike the two above: a supplement's outcome is
        // about *this* poll (it can be paused after a 429 and then recover),
        // where a key set and an unknown window are facts about the payload's
        // shape that do not change between polls.
        onSupplement: (status) =>
          vlog(
            `claude-web supplement ${status.id}: ${status.status}` +
              ` (${status.buckets} rows)${status.message === undefined ? '' : ` — ${status.message}`}`
          )
      }),
      createClaudeOauthProvider({
        http: httpNoCookies,
        onUnexpectedShape: (keys) => vlog('claude-oauth: unexpected payload keys', keys.join(',')),
        onIgnoredWindow: (window) => emitIgnoredWindow({ provider: CLAUDE_OAUTH_ID, window }),
        onUsageKeys: (keys) => emitKeySet({ provider: CLAUDE_OAUTH_ID, keys })
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
        onUnexpectedShape: (keys) => vlog('chatgpt-web: unexpected payload keys', keys.join(',')),
        onUsageKeys: (keys) => emitKeySet({ provider: CHATGPT_WEB_ID, keys }),
        onUsageShape: DUMP_USAGE_SHAPE
          ? (lines): void => dumpUsageShape({ provider: CHATGPT_WEB_ID, lines })
          : undefined
      }),
      createChatGptCodexProvider({
        http: httpNoCookies,
        onUnexpectedShape: (keys) => vlog('chatgpt-codex: unexpected payload keys', keys.join(','))
      })
    ]
  };
}

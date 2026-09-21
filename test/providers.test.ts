/**
 * The four providers, against a stubbed HTTP layer.
 *
 * What matters about a provider is not "does it parse the happy path" — that is
 * `buckets.test.ts`' job — but **what it says when things are wrong**, because
 * that sentence is the only thing the owner sees. So every provider is checked
 * against the same five responses (valid, 401, 429, 404, HTML) plus its own
 * failure modes, and the assertions are about the resulting `SourceStatus`:
 *
 *  - `auth-needed` — a human must act.
 *  - `rate-limited` — back off, say nothing.
 *  - `endpoint-changed` — the shape moved; show "?" rather than a made-up 0 %.
 *  - `error` — transient, retry.
 *  - `unavailable` — there is no login here at all; let the next provider answer.
 *
 * Also pinned: the exact request headers (each one is load-bearing — the
 * `anthropic-beta` opt-in, the two pinned user agents, `ChatGPT-Account-Id`),
 * and that no token ever appears in a `ProviderResult`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createClaudeOauthProvider,
  CLAUDE_OAUTH_USAGE_URL,
  EXPIRED_MESSAGE,
  LOGGED_OUT_MESSAGE
} from '../src/providers/claude-oauth';
import type { ClaudeCredentialsResult } from '../src/providers/credentials';
import {
  createClaudeWebProvider,
  CLAUDE_ACCOUNT_URL,
  CLAUDE_ORGS_URL,
  CLAUDE_SUPPLEMENTS,
  SUPPLEMENT_PAUSE_MS,
  chooseOrg,
  parseOrgs,
  usageUrlFor,
  type ClaudeSupplement
} from '../src/providers/claude-web';
import {
  createChatGptWebProvider,
  CHATGPT_CANDIDATE_BUDGET_MS,
  CHATGPT_CANDIDATE_PATHS,
  CHATGPT_MAX_CANDIDATES,
  CHATGPT_ME_URL,
  CHATGPT_SESSION_URL,
  candidatePaths,
  identifiesAccount,
  parseSession
} from '../src/providers/chatgpt-web';
import {
  createChatGptCodexProvider,
  CODEX_USAGE_URL,
  CODEX_USER_AGENT
} from '../src/providers/chatgpt-codex';
import {
  CURSOR_ID,
  CURSOR_LOGGED_OUT_MESSAGE,
  CURSOR_UNREADABLE_MESSAGE,
  CURSOR_USAGE_MESSAGE,
  CURSOR_USAGE_URL,
  createCursorProvider
} from '../src/providers/cursor';
import {
  COPILOT_ID,
  COPILOT_LOGGED_OUT_MESSAGE,
  COPILOT_NOT_ENABLED_MESSAGE,
  COPILOT_UNREADABLE_MESSAGE,
  COPILOT_USER_AGENT,
  COPILOT_USER_URL,
  createCopilotProvider
} from '../src/providers/copilot';
import {
  ANTIGRAVITY_CSRF_HEADER,
  ANTIGRAVITY_ID,
  ANTIGRAVITY_NOT_RUNNING_MESSAGE,
  ANTIGRAVITY_NO_ANSWER_MESSAGE,
  ANTIGRAVITY_PROCESS,
  ANTIGRAVITY_RPC_MESSAGE,
  ANTIGRAVITY_UNREADABLE_MESSAGE,
  LSOF_BIN,
  PGREP_BIN,
  PS_BIN,
  antigravityUrl,
  createAntigravityProvider
} from '../src/providers/antigravity';
import { NEEDS_APP_SESSION, type HttpFetch, type HttpResponse } from '../src/providers/types';
import { EXTRA_USAGE_ID, extraUsageBucket, parseExtraUsage } from '../src/core/buckets';
import EXTRA_USAGE_ON from './fixtures/claude-web-extra-usage.json';
import EXTRA_USAGE_OFF from './fixtures/claude-web-extra-usage-off.json';

const NOW = new Date('2026-09-08T15:00:00Z');

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const CLAUDE_USAGE = fixture('claude-oauth-usage.json');
const CODEX_USAGE = fixture('codex-wham-usage.json');
const CURSOR_USAGE = fixture('cursor-usage.json');
const COPILOT_USER = fixture('copilot-user.json');
const ANTIGRAVITY_QUOTA = fixture('antigravity-quota.json');

/* ------------------------------------------------------------------- stubs */

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
  /** `undefined` when the caller left the adapter's default in place. */
  readonly timeoutMs: number | undefined;
  /** The POST body, when the provider sent one. */
  readonly post?: string;
}

function json(body: unknown, status = 200): HttpResponse {
  return { ok: status < 400, status, contentType: 'application/json', body: JSON.stringify(body) };
}

function html(status = 200): HttpResponse {
  return {
    ok: status < 400,
    status,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><body>Sign in</body></html>'
  };
}

function status(code: number): HttpResponse {
  return { ok: false, status: code, contentType: 'application/json', body: '{}' };
}

/** A stub `HttpFetch` that answers per URL and records what it was asked. */
function stub(routes: Record<string, HttpResponse | (() => HttpResponse)>): {
  http: HttpFetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const http: HttpFetch = async (url, init) => {
    calls.push({
      url,
      headers: { ...(init?.headers ?? {}) },
      timeoutMs: init?.timeoutMs,
      ...(init?.post === undefined ? {} : { post: init.post })
    });
    const route = routes[url];
    if (route === undefined) throw new Error(`no stub route for ${url}`);
    return typeof route === 'function' ? route() : route;
  };
  return { http, calls };
}

/** A `PartitionSession` over a stub, with a settable cookie jar. */
function fakeSession(
  routes: Record<string, HttpResponse | (() => HttpResponse)>,
  cookies: { name: string; domain: string }[] = [{ name: 'sessionKey', domain: '.claude.ai' }]
) {
  const { http, calls } = stub(routes);
  return {
    calls,
    session: {
      http,
      cookies: async (filter: { name?: string }) =>
        filter.name === undefined ? cookies : cookies.filter((c) => c.name === filter.name)
    }
  };
}

/* ----------------------------------------------------------- claude-oauth */

describe('claude-oauth', () => {
  const live = { expired: false as const, accessToken: 'tok', expiresAt: Date.now() + 1e6, subscriptionType: 'team' };

  it('returns ok with the endpoint\'s buckets', async () => {
    const { http, calls } = stub({ [CLAUDE_OAUTH_USAGE_URL]: json(CLAUDE_USAGE) });
    const provider = createClaudeOauthProvider({ http, readCredentials: async () => live });

    const result = await provider.fetch(NOW);
    expect(result.status).toBe('ok');
    expect(result.via).toBe('claude-oauth');
    // Payload order: display ordering is `mergeBuckets`' job, in the poller.
    // The Fable row is last because the endpoint does not report it at all —
    // `parseClaudeUsage` appends it, derived from `seven_day`.
    expect(result.buckets.map((b) => b.label)).toEqual([
      '5-hour',
      '7-day (all models)',
      '7-day Opus',
      '7-day Fable'
    ]);
    expect(result.buckets.filter((b) => b.derived === true)).toHaveLength(1);
    expect(result.buckets[0]?.pct).toBe(42.5);
    expect(calls).toHaveLength(1);
  });

  it('sends exactly the headers Claude Code sends', async () => {
    const { http, calls } = stub({ [CLAUDE_OAUTH_USAGE_URL]: json(CLAUDE_USAGE) });
    await createClaudeOauthProvider({ http, readCredentials: async () => live }).fetch(NOW);

    // Each of these is load-bearing: the beta opt-in is what makes the OAuth
    // route answer, and an unrecognised user agent is a plausible way for it to
    // start refusing.
    expect(calls[0]?.headers).toEqual({
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1.0',
      Accept: 'application/json',
      Authorization: 'Bearer tok'
    });
  });

  it('reads utilization as percent, so 1 does not become 100 %', async () => {
    // The M2a review's false alarm: a quiet 1 % window read as a full one would
    // make Walder bark about an almost-empty allowance.
    const { http } = stub({
      [CLAUDE_OAUTH_USAGE_URL]: json({ five_hour: { utilization: 1, resets_at: null } })
    });
    const result = await createClaudeOauthProvider({
      http,
      readCredentials: async () => live
    }).fetch(NOW);
    expect(result.buckets[0]?.pct).toBe(1);
  });

  it('says auth-needed, in the owner\'s words, for an expired token', async () => {
    const { http, calls } = stub({});
    const provider = createClaudeOauthProvider({
      http,
      readCredentials: async () => ({ expired: true, expiresAt: NOW.getTime() - 1 })
    });
    const result = await provider.fetch(NOW);
    expect(result.status).toBe('auth-needed');
    expect(result.message).toBe(EXPIRED_MESSAGE);
    // And it does not even try the endpoint — there is nothing to send.
    expect(calls).toHaveLength(0);
  });

  it('says logged-out, not expired, when the keychain item has been emptied', async () => {
    // Distinct from a stale token: there is no refresh token left for
    // `main/claude-renew.ts` to act on, so `onExpiresAt` still gets `null` and
    // nothing gets spawned — only the owner logging in again fixes this.
    const seen: Array<number | null> = [];
    const { http, calls } = stub({});
    const provider = createClaudeOauthProvider({
      http,
      readCredentials: async () => ({ expired: true, expiresAt: null, loggedOut: true }),
      onExpiresAt: (expiresAt) => seen.push(expiresAt)
    });
    const result = await provider.fetch(NOW);
    expect(result.status).toBe('auth-needed');
    expect(result.message).toBe(LOGGED_OUT_MESSAGE);
    expect(seen).toEqual([null]);
    expect(calls).toHaveLength(0);
  });

  it('is still "available" with an expired token', async () => {
    // So the registry can report it rather than skipping past it silently.
    const provider = createClaudeOauthProvider({
      http: stub({}).http,
      readCredentials: async () => ({ expired: true, expiresAt: NOW.getTime() - 1 })
    });
    expect(await provider.isAvailable()).toBe(true);
  });

  it('reports every credential read\'s expiry, live, stale or absent', async () => {
    // The whole input to `main/claude-renew.ts`. It has to see the live case
    // too: that is how a successful renewal is noticed and how the next expiry
    // is armed, rather than waiting for the card to go red first.
    const stale = NOW.getTime() - 1;
    const cases: Array<[ClaudeCredentialsResult, number | null]> = [
      [live, live.expiresAt],
      [{ expired: true as const, expiresAt: stale }, stale],
      [{ expired: true as const, expiresAt: null }, null],
      [null, null]
    ];

    for (const [credentials, expected] of cases) {
      const seen: Array<number | null> = [];
      const { http } = stub({ [CLAUDE_OAUTH_USAGE_URL]: json(CLAUDE_USAGE) });
      await createClaudeOauthProvider({
        http,
        readCredentials: async () => credentials,
        onExpiresAt: (expiresAt) => seen.push(expiresAt)
      }).fetch(NOW);
      expect(seen).toEqual([expected]);
    }
  });

  it('does not report an expiry when the credential read throws', async () => {
    // There is no expiry to key a renewal attempt on, and inventing `null`
    // here would tell `claude-renew.ts` "no login" about a machine that may
    // well have one.
    const seen: Array<number | null> = [];
    const result = await createClaudeOauthProvider({
      http: stub({}).http,
      readCredentials: async () => {
        throw new Error('the keychain said no');
      },
      onExpiresAt: (expiresAt) => seen.push(expiresAt)
    }).fetch(NOW);
    expect(result.status).toBe('error');
    expect(seen).toEqual([]);
  });

  it('maps 401 to auth-needed with the same sentence', async () => {
    const { http } = stub({ [CLAUDE_OAUTH_USAGE_URL]: status(401) });
    const result = await createClaudeOauthProvider({
      http,
      readCredentials: async () => live
    }).fetch(NOW);
    expect(result.status).toBe('auth-needed');
    expect(result.message).toBe(EXPIRED_MESSAGE);
  });

  /*
   * Claude Code files a new keychain item per token rotation rather than
   * updating one, and `security find-generic-password` picks an arbitrary one —
   * so a 401 here does not prove the login is stale, only that *this* item was.
   * One re-read is spent on that, and never on the happy path.
   */
  describe('the 401 re-read', () => {
    const fresh = { ...live, accessToken: 'tok-2', expiresAt: live.expiresAt + 3_600_000 };

    /** `readCredentials` walking a script, so the second read can differ. */
    function reads(...script: ClaudeCredentialsResult[]) {
      const state = { n: 0 };
      return {
        read: async () => script[Math.min(state.n++, script.length - 1)] ?? null,
        get count() {
          return state.n;
        }
      };
    }

    it('retries with the newer token and returns its answer', async () => {
      const { http, calls } = stub({
        [CLAUDE_OAUTH_USAGE_URL]: (() => {
          let n = 0;
          return () => (n++ === 0 ? status(401) : json(CLAUDE_USAGE));
        })()
      });
      const result = await createClaudeOauthProvider({
        http,
        readCredentials: reads(live, fresh).read
      }).fetch(NOW);

      expect(result.status).toBe('ok');
      expect(calls).toHaveLength(2);
      expect(calls[1]?.headers['Authorization']).toBe('Bearer tok-2');
    });

    it('does not re-request when the re-read hands back the same token', async () => {
      // Nothing changed, so a second identical request would only be a second
      // 401 — one request, and the owner gets the sentence straight away.
      const { http, calls } = stub({ [CLAUDE_OAUTH_USAGE_URL]: status(401) });
      const result = await createClaudeOauthProvider({
        http,
        readCredentials: reads(live, live).read
      }).fetch(NOW);

      expect(calls).toHaveLength(1);
      expect(result.status).toBe('auth-needed');
      expect(result.message).toBe(EXPIRED_MESSAGE);
    });

    it('gives up after the retry also fails', async () => {
      const { http, calls } = stub({ [CLAUDE_OAUTH_USAGE_URL]: status(401) });
      const result = await createClaudeOauthProvider({
        http,
        readCredentials: reads(live, fresh).read
      }).fetch(NOW);

      expect(calls).toHaveLength(2);
      expect(result.status).toBe('auth-needed');
      expect(result.message).toBe(EXPIRED_MESSAGE);
    });

    it('reports the expiry of both reads, so renewal sees the newer one', async () => {
      const seen: Array<number | null> = [];
      const { http } = stub({ [CLAUDE_OAUTH_USAGE_URL]: status(401) });
      await createClaudeOauthProvider({
        http,
        readCredentials: reads(live, fresh).read,
        onExpiresAt: (expiresAt) => seen.push(expiresAt)
      }).fetch(NOW);
      expect(seen).toEqual([live.expiresAt, fresh.expiresAt]);
    });
  });

  it('maps 429 to rate-limited', async () => {
    const { http } = stub({ [CLAUDE_OAUTH_USAGE_URL]: status(429) });
    const result = await createClaudeOauthProvider({
      http,
      readCredentials: async () => live
    }).fetch(NOW);
    expect(result.status).toBe('rate-limited');
  });

  it('maps 404 and an HTML body to endpoint-changed', async () => {
    for (const response of [status(404), html(), html(200)]) {
      const { http } = stub({ [CLAUDE_OAUTH_USAGE_URL]: response });
      const result = await createClaudeOauthProvider({
        http,
        readCredentials: async () => live
      }).fetch(NOW);
      expect(result.status).toBe('endpoint-changed');
    }
  });

  it('maps a 500 to error, not to endpoint-changed', async () => {
    // Transient: the poller backs off and retries rather than telling the owner
    // something is permanently broken.
    const { http } = stub({ [CLAUDE_OAUTH_USAGE_URL]: status(503) });
    const result = await createClaudeOauthProvider({
      http,
      readCredentials: async () => live
    }).fetch(NOW);
    expect(result.status).toBe('error');
  });

  it('reports endpoint-changed, with the payload\'s key names, for a shape it cannot read', async () => {
    const seen: string[][] = [];
    const { http } = stub({
      [CLAUDE_OAUTH_USAGE_URL]: json({ windows: [], plan: 'team' })
    });
    const result = await createClaudeOauthProvider({
      http,
      readCredentials: async () => live,
      onUnexpectedShape: (keys) => seen.push(keys)
    }).fetch(NOW);
    expect(result.status).toBe('endpoint-changed');
    // Key names only — the values are the owner's data.
    expect(seen).toEqual([['windows', 'plan']]);
  });

  it('reports dropped unknown keys through onIgnoredWindow and still returns ok', async () => {
    const seen: unknown[] = [];
    const { http } = stub({
      [CLAUDE_OAUTH_USAGE_URL]: json({
        five_hour: { utilization: 40, resets_at: '2026-09-09T18:00:00Z' },
        amber_ladder: { utilization: 0, resets_at: '2026-10-02T00:00:00Z' }
      })
    });
    const result = await createClaudeOauthProvider({
      http,
      readCredentials: async () => live,
      onIgnoredWindow: (w) => seen.push(w)
    }).fetch(NOW);
    expect(result.status).toBe('ok');
    // The whitelist drops it before it ever reaches a bucket.
    expect(result.buckets.map((b) => b.key)).not.toContain('amber_ladder');
    expect(seen).toEqual([
      { key: 'amber_ladder', hasUtilization: true, resetsOn: '2026-10-02' }
    ]);
  });

  it('calls onUsageKeys with the sorted top-level keys of a payload it parsed', async () => {
    const seen: string[][] = [];
    const { http } = stub({ [CLAUDE_OAUTH_USAGE_URL]: json(CLAUDE_USAGE) });
    await createClaudeOauthProvider({
      http,
      readCredentials: async () => live,
      onUsageKeys: (keys) => seen.push(keys)
    }).fetch(NOW);
    expect(seen).toEqual([['five_hour', 'seven_day', 'seven_day_opus']]);
  });

  it('turns a thrown fetch into error rather than crashing the poll', async () => {
    const http: HttpFetch = async () => {
      throw new Error('network down');
    };
    const result = await createClaudeOauthProvider({
      http,
      readCredentials: async () => live
    }).fetch(NOW);
    expect(result.status).toBe('error');
    expect(result.message).toBe('network down');
  });

  it('is unavailable when there is no Claude Code login at all', async () => {
    const provider = createClaudeOauthProvider({
      http: stub({}).http,
      readCredentials: async () => null
    });
    expect(await provider.isAvailable()).toBe(false);
    expect((await provider.fetch(NOW)).status).toBe('unavailable');
  });

  it('never puts the token in its result', async () => {
    const { http } = stub({ [CLAUDE_OAUTH_USAGE_URL]: json(CLAUDE_USAGE) });
    const result = await createClaudeOauthProvider({
      http,
      readCredentials: async () => ({ ...live, accessToken: 'SUPER-SECRET' })
    }).fetch(NOW);
    expect(JSON.stringify(result)).not.toContain('SUPER-SECRET');
  });
});

/* -------------------------------------------------------------- claude-web */

describe('claude-web', () => {
  const ORG = 'org-uuid-1';
  const ORGS = [{ uuid: ORG, capabilities: ['chat', 'claude_pro'] }];

  it('lists organisations, then asks the chosen one for usage', async () => {
    const { session, calls } = fakeSession({
      [CLAUDE_ORGS_URL]: json(ORGS),
      [usageUrlFor(ORG)]: json(CLAUDE_USAGE)
    });
    // `supplements: []` keeps this a test of the two-request window flow;
    // the optional third GET has its own describe block below.
    const result = await createClaudeWebProvider({
      session: () => session,
      supplements: []
    }).fetch(NOW);

    expect(result.status).toBe('ok');
    expect(result.via).toBe('claude-web');
    // Three reported windows plus the derived Fable row, exactly as on the
    // OAuth route: both go through `parseClaudeUsage`.
    expect(result.buckets).toHaveLength(4);
    expect(calls.map((c) => c.url)).toEqual([CLAUDE_ORGS_URL, usageUrlFor(ORG)]);
    // Cookies do the authenticating: no Authorization header is sent.
    expect(calls[0]?.headers['Authorization']).toBeUndefined();
  });

  it('is available only when a sessionKey cookie exists for claude.ai', async () => {
    const withCookie = fakeSession({}, [{ name: 'sessionKey', domain: '.claude.ai' }]);
    expect(await createClaudeWebProvider({ session: () => withCookie.session }).isAvailable()).toBe(
      true
    );

    const withoutCookie = fakeSession({}, [{ name: 'ajs_anonymous_id', domain: '.claude.ai' }]);
    expect(
      await createClaudeWebProvider({ session: () => withoutCookie.session }).isAvailable()
    ).toBe(false);
  });

  it('is unavailable, with a reason, outside the app', async () => {
    // What `npm run probe` sees: there is no Electron partition to borrow.
    const provider = createClaudeWebProvider({ session: () => null });
    expect(await provider.isAvailable()).toBe(false);
    const result = await provider.fetch(NOW);
    expect(result.status).toBe('unavailable');
    expect(result.message).toBe(NEEDS_APP_SESSION);
  });

  it('maps 401/403 on either request to auth-needed', async () => {
    const onOrgs = fakeSession({ [CLAUDE_ORGS_URL]: status(403) });
    expect((await createClaudeWebProvider({ session: () => onOrgs.session }).fetch(NOW)).status).toBe(
      'auth-needed'
    );

    const onUsage = fakeSession({
      [CLAUDE_ORGS_URL]: json(ORGS),
      [usageUrlFor(ORG)]: status(401)
    });
    expect(
      (await createClaudeWebProvider({ session: () => onUsage.session }).fetch(NOW)).status
    ).toBe('auth-needed');
  });

  it('maps 429 to rate-limited and 404 to endpoint-changed', async () => {
    const limited = fakeSession({ [CLAUDE_ORGS_URL]: status(429) });
    expect(
      (await createClaudeWebProvider({ session: () => limited.session }).fetch(NOW)).status
    ).toBe('rate-limited');

    const gone = fakeSession({ [CLAUDE_ORGS_URL]: status(404) });
    expect((await createClaudeWebProvider({ session: () => gone.session }).fetch(NOW)).status).toBe(
      'endpoint-changed'
    );
  });

  it('treats an HTML login page as endpoint-changed, not as valid JSON', async () => {
    const { session } = fakeSession({ [CLAUDE_ORGS_URL]: html(200) });
    expect((await createClaudeWebProvider({ session: () => session }).fetch(NOW)).status).toBe(
      'endpoint-changed'
    );
  });

  it('reports endpoint-changed when no organisation can be read', async () => {
    const seen: string[][] = [];
    const { session } = fakeSession({ [CLAUDE_ORGS_URL]: json({ organizations: [] }) });
    const result = await createClaudeWebProvider({
      session: () => session,
      onUnexpectedShape: (keys) => seen.push(keys)
    }).fetch(NOW);
    expect(result.status).toBe('endpoint-changed');
    expect(seen).toEqual([['organizations']]);
  });

  it('reports endpoint-changed when usage parses to nothing', async () => {
    const { session } = fakeSession({
      [CLAUDE_ORGS_URL]: json(ORGS),
      [usageUrlFor(ORG)]: json({ quota: 'plenty' })
    });
    expect((await createClaudeWebProvider({ session: () => session }).fetch(NOW)).status).toBe(
      'endpoint-changed'
    );
  });

  it('reports dropped unknown keys through onIgnoredWindow and still returns ok', async () => {
    const seen: unknown[] = [];
    const { session } = fakeSession({
      [CLAUDE_ORGS_URL]: json(ORGS),
      [usageUrlFor(ORG)]: json({
        five_hour: { utilization: 40, resets_at: '2026-09-09T18:00:00Z' },
        amber_ladder: { utilization: 0, resets_at: '2026-10-02T00:00:00Z' }
      })
    });
    const result = await createClaudeWebProvider({
      session: () => session,
      onIgnoredWindow: (w) => seen.push(w)
    }).fetch(NOW);
    expect(result.status).toBe('ok');
    expect(result.buckets.map((b) => b.key)).not.toContain('amber_ladder');
    expect(seen).toEqual([
      { key: 'amber_ladder', hasUtilization: true, resetsOn: '2026-10-02' }
    ]);
  });

  it('calls onUsageKeys with the sorted top-level keys of a payload it parsed', async () => {
    const seen: string[][] = [];
    const { session } = fakeSession({
      [CLAUDE_ORGS_URL]: json(ORGS),
      [usageUrlFor(ORG)]: json(CLAUDE_USAGE)
    });
    await createClaudeWebProvider({ session: () => session, onUsageKeys: (keys) => seen.push(keys) }).fetch(
      NOW
    );
    expect(seen).toEqual([['five_hour', 'seven_day', 'seven_day_opus']]);
  });

  it('calls onUsageShape beside onUsageKeys, with the RAW payload', async () => {
    // Raw, not parsed: the point of the dump is what the parser did *not*
    // read, so a key the whitelist dropped must still be described.
    const order: string[] = [];
    const shape: string[][] = [];
    const { session } = fakeSession({
      [CLAUDE_ORGS_URL]: json(ORGS),
      [usageUrlFor(ORG)]: json({
        five_hour: { utilization: 40, resets_at: '2026-09-09T18:00:00Z' },
        seven_day_cowork: { utilization: 3, resets_at: null }
      })
    });
    await createClaudeWebProvider({
      session: () => session,
      onUsageKeys: () => order.push('keys'),
      onUsageShape: (lines) => {
        order.push('shape');
        shape.push(lines);
      }
    }).fetch(NOW);

    expect(order).toEqual(['keys', 'shape']);
    expect(shape[0]).toContain('five hour . utilization = 40');
    // The dropped key is in the dump, which is the whole reason it is raw.
    expect(shape[0]).toContain('seven day cowork: object');
  });

  it('does not walk the payload at all when onUsageShape is absent', async () => {
    // The gate is the missing callback, not a no-op inside it — so an
    // ordinary poll costs nothing. Pinned by the shape of the call: the
    // provider must not throw or misbehave with the hook left off, which is
    // every other test in this file, and this one states it on purpose.
    const { session } = fakeSession({
      [CLAUDE_ORGS_URL]: json(ORGS),
      [usageUrlFor(ORG)]: json(CLAUDE_USAGE)
    });
    const result = await createClaudeWebProvider({ session: () => session }).fetch(NOW);
    expect(result.status).toBe('ok');
  });

  it('turns a thrown fetch into error', async () => {
    const session = {
      http: async () => {
        throw new Error('socket hang up');
      },
      cookies: async () => [{ name: 'sessionKey', domain: '.claude.ai' }]
    };
    const result = await createClaudeWebProvider({ session: () => session }).fetch(NOW);
    expect(result.status).toBe('error');
    expect(result.message).toBe('socket hang up');
  });

  /*
   * `isAuthenticated` is a different question from `isAvailable`, and the login
   * window turns on the difference: it closes when this says yes. A cookie jar
   * for claude.ai exists for a visitor who never logged in, and an expired
   * `sessionKey` is still a `sessionKey` — so only a 200 with a readable
   * organisation counts.
   */
  describe('isAuthenticated', () => {
    const provider = (routes: Record<string, HttpResponse | (() => HttpResponse)>) =>
      createClaudeWebProvider({ session: () => fakeSession(routes).session });

    it('is true when the organisation list answers 200 with an org', async () => {
      expect(await provider({ [CLAUDE_ORGS_URL]: json(ORGS) }).isAuthenticated?.()).toBe(true);
    });

    it('is false when the list is empty, or holds nothing we can read', async () => {
      expect(await provider({ [CLAUDE_ORGS_URL]: json([]) }).isAuthenticated?.()).toBe(false);
      expect(
        await provider({ [CLAUDE_ORGS_URL]: json([{ name: 'no uuid' }]) }).isAuthenticated?.()
      ).toBe(false);
    });

    it('is false for 401, 403 and a login page served as 200 HTML', async () => {
      expect(await provider({ [CLAUDE_ORGS_URL]: status(401) }).isAuthenticated?.()).toBe(false);
      expect(await provider({ [CLAUDE_ORGS_URL]: status(403) }).isAuthenticated?.()).toBe(false);
      expect(await provider({ [CLAUDE_ORGS_URL]: html() }).isAuthenticated?.()).toBe(false);
    });

    it('is false when the request throws, and outside the app', async () => {
      expect(
        await provider({
          [CLAUDE_ORGS_URL]: () => {
            throw new Error('offline');
          }
        }).isAuthenticated?.()
      ).toBe(false);
      expect(
        await createClaudeWebProvider({ session: () => null }).isAuthenticated?.()
      ).toBe(false);
    });

    it('asks with a timeout, because the login window asks every 2 s', async () => {
      const { session, calls } = fakeSession({ [CLAUDE_ORGS_URL]: json(ORGS) });
      await createClaudeWebProvider({ session: () => session }).isAuthenticated?.();
      expect(calls[0]?.url).toBe(CLAUDE_ORGS_URL);
      expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
    });

    /*
     * The fallback, added 2026-09-08. These are unofficial endpoints, and the
     * failure it covers is expensive: if `/api/organizations` changes shape,
     * every answer becomes "not logged in", the login window never closes, and
     * the owner is told to log in to an account he is already logged in to.
     */
    describe('the /api/account fallback', () => {
      it('accepts a 200 there when the organisation list is unreadable', async () => {
        for (const orgsAnswer of [json({ organizations: [] }), json([]), status(404)]) {
          const { session, calls } = fakeSession({
            [CLAUDE_ORGS_URL]: orgsAnswer,
            [CLAUDE_ACCOUNT_URL]: json({ uuid: 'u' })
          });
          expect(
            await createClaudeWebProvider({ session: () => session }).isAuthenticated?.()
          ).toBe(true);
          expect(calls.map((c) => c.url)).toEqual([CLAUDE_ORGS_URL, CLAUDE_ACCOUNT_URL]);
        }
      });

      it('is not tried after a 401 or 403, which is already an answer', async () => {
        // Otherwise every 2 s tick of an open login window would make two
        // requests instead of one, for no new information.
        for (const code of [401, 403]) {
          const { session, calls } = fakeSession({
            [CLAUDE_ORGS_URL]: status(code),
            [CLAUDE_ACCOUNT_URL]: json({ uuid: 'u' })
          });
          expect(
            await createClaudeWebProvider({ session: () => session }).isAuthenticated?.()
          ).toBe(false);
          expect(calls.map((c) => c.url)).toEqual([CLAUDE_ORGS_URL]);
        }
      });

      it('does not turn a logged-out browser into a login', async () => {
        const { session } = fakeSession({
          [CLAUDE_ORGS_URL]: json([]),
          [CLAUDE_ACCOUNT_URL]: status(401)
        });
        expect(
          await createClaudeWebProvider({ session: () => session }).isAuthenticated?.()
        ).toBe(false);
      });

      it('reads nothing out of the account body', async () => {
        // That body is the owner's profile. The status is the whole signal.
        const { session } = fakeSession({
          [CLAUDE_ORGS_URL]: json([]),
          [CLAUDE_ACCOUNT_URL]: json({ email: 'victor@example.com', full_name: 'Victor' })
        });
        const provider = createClaudeWebProvider({ session: () => session });
        expect(await provider.isAuthenticated?.()).toBe(true);
        expect(JSON.stringify(provider.lastCheck?.())).not.toContain('victor@example.com');
      });
    });

    /* The record the tray's Accounts line reads. Memory only, never persisted. */
    describe('lastCheck', () => {
      it('is null until something has been checked', () => {
        const { session } = fakeSession({ [CLAUDE_ORGS_URL]: json(ORGS) });
        expect(createClaudeWebProvider({ session: () => session }).lastCheck?.()).toBeNull();
      });

      it('records the shape of the failure, not the response', async () => {
        const { session } = fakeSession({ [CLAUDE_ORGS_URL]: status(401) });
        const provider = createClaudeWebProvider({
          session: () => session,
          clock: () => 1_700_000_000_000
        });
        await provider.isAuthenticated?.();
        expect(provider.lastCheck?.()).toEqual({
          loggedIn: false,
          failed: false,
          detail: 'HTTP 401',
          at: 1_700_000_000_000
        });
      });

      it('separates "we could not ask" from "you are not logged in"', async () => {
        const { session } = fakeSession({
          [CLAUDE_ORGS_URL]: () => {
            throw new Error('net::ERR_INTERNET_DISCONNECTED');
          }
        });
        const provider = createClaudeWebProvider({ session: () => session });
        await provider.isAuthenticated?.();
        expect(provider.lastCheck?.()?.failed).toBe(true);
      });

      it('says so plainly when the list is empty', async () => {
        const { session } = fakeSession({
          [CLAUDE_ORGS_URL]: json([]),
          [CLAUDE_ACCOUNT_URL]: status(401)
        });
        const provider = createClaudeWebProvider({ session: () => session });
        await provider.isAuthenticated?.();
        expect(provider.lastCheck?.()?.detail).toBe('no organisation listed');
      });
    });
  });

  describe('organisation choice', () => {
    it('prefers an org that can chat', () => {
      const orgs = parseOrgs([
        { uuid: 'a', capabilities: ['api'] },
        { uuid: 'b', capabilities: ['chat'] }
      ]);
      expect(chooseOrg(orgs)?.uuid).toBe('b');
    });

    it('falls back to the first when nothing declares capabilities', () => {
      const orgs = parseOrgs([{ uuid: 'a' }, { uuid: 'b' }]);
      expect(chooseOrg(orgs)?.uuid).toBe('a');
    });

    it('skips entries with no usable uuid, and reads nothing else', () => {
      const orgs = parseOrgs([
        { name: 'Personal' },
        { uuid: '' },
        { uuid: 'c', name: 'Team', members: ['someone@example.com'] }
      ]);
      expect(orgs).toEqual([{ uuid: 'c', capabilities: [] }]);
    });

    it('is null for a payload that is not a list', () => {
      expect(chooseOrg(parseOrgs({ organizations: [] }))).toBeNull();
      expect(chooseOrg(parseOrgs(null))).toBeNull();
    });

    it('escapes the uuid into the usage URL', () => {
      expect(usageUrlFor('a/../b')).toBe('https://claude.ai/api/organizations/a%2F..%2Fb/usage');
    });
  });
});

/* ------------------------------------------- claude-web supplements (III) */

/**
 * The supplement machinery, driven by an **injected fake**.
 *
 * No supplement ships any more: the Extra usage figure the real one fetched
 * from `/overage_spend_limit` turned out to be in the primary usage payload
 * (confirmed 2026-09-10), so the URL, the supplement and the second request
 * per poll are gone, and `CLAUDE_SUPPLEMENTS` is empty.
 *
 * These tests stay, on a fake, because what they pin is not that one endpoint:
 * it is the four rules that make *any* extra request safe — same poll tick, a
 * failure that cannot touch `status`, a skip when the answer is already in
 * hand, and one 429 silencing every extra for fifteen minutes. Those rules are
 * not obvious enough to re-derive under pressure the next time Anthropic puts
 * something interesting behind a second URL, and untested machinery is
 * machinery nobody will trust enough to use.
 */
describe('claude-web supplements (driven by a fake)', () => {
  const ORG = 'org-uuid-1';
  const ORGS = [{ uuid: ORG, capabilities: ['chat'] }];
  const FAKE_URL = (orgId: string): string =>
    `https://claude.ai/api/organizations/${encodeURIComponent(orgId)}/fake_extra`;
  const FAKE = FAKE_URL(ORG);

  /** A stand-in for the supplement that used to ship, parsing the same rows. */
  const fake: ClaudeSupplement = {
    id: 'extra-usage',
    url: FAKE_URL,
    parse(json) {
      const money = parseExtraUsage(json);
      return money === null ? [] : [extraUsageBucket(money, Date.now())];
    },
    skip: (buckets) => buckets.some((bucket) => bucket.id === EXTRA_USAGE_ID)
  };

  /** The three routes a full poll walks, with a settable third answer. */
  const routes = (
    supplement: HttpResponse | (() => HttpResponse),
    usage: unknown = CLAUDE_USAGE
  ): Record<string, HttpResponse | (() => HttpResponse)> => ({
    [CLAUDE_ORGS_URL]: json(ORGS),
    [usageUrlFor(ORG)]: json(usage),
    [FAKE]: supplement
  });

  const extraRow = (result: { buckets: { id: string }[] }): { id: string } | undefined =>
    result.buckets.find((b) => b.id === EXTRA_USAGE_ID);

  it('asks the supplement endpoint and adds an Extra usage row', async () => {
    const { session, calls } = fakeSession(routes(json(EXTRA_USAGE_ON)));
    const result = await createClaudeWebProvider({
      session: () => session,
      supplements: [fake]
    }).fetch(NOW);

    expect(result.status).toBe('ok');
    expect(calls.map((c) => c.url)).toEqual([CLAUDE_ORGS_URL, usageUrlFor(ORG), FAKE]);
    expect(extraRow(result)).toMatchObject({
      label: 'Extra usage',
      kind: 'money',
      // The owner's own account: enabled, 962 minor units, no cap. So an
      // amount and no percentage — see `extraUsageBucket`.
      money: { spent: 9.62, limit: null, currency: 'USD' },
      pct: null
    });
    expect(result.supplements).toEqual([{ id: 'extra-usage', status: 'ok', buckets: 1 }]);
  });

  it('adds no row when the account has extra usage switched off', async () => {
    const { session } = fakeSession(routes(json(EXTRA_USAGE_OFF)));
    const result = await createClaudeWebProvider({
      session: () => session,
      supplements: [fake]
    }).fetch(NOW);
    expect(result.status).toBe('ok');
    expect(extraRow(result)).toBeUndefined();
    expect(result.supplements).toEqual([{ id: 'extra-usage', status: 'ok', buckets: 0 }]);
  });

  it('reads the figure out of the usage payload and skips the request entirely', async () => {
    // The live case, and the reason no supplement ships: the figure is in the
    // payload the provider already fetched.
    const { session, calls } = fakeSession(
      routes(json(EXTRA_USAGE_ON), {
        ...(CLAUDE_USAGE as Record<string, unknown>),
        extra_usage: {
          is_enabled: true,
          used_credits: 4000,
          monthly_limit: 20000,
          currency: 'USD',
          decimal_places: 2
        }
      })
    );
    const result = await createClaudeWebProvider({
      session: () => session,
      supplements: [fake]
    }).fetch(NOW);

    expect(calls.map((c) => c.url)).toEqual([CLAUDE_ORGS_URL, usageUrlFor(ORG)]);
    expect(extraRow(result)).toMatchObject({ money: { spent: 40, limit: 200, currency: 'USD' } });
    expect(result.supplements?.[0]).toMatchObject({ status: 'ok', buckets: 0 });
  });

  it('never lets a failing supplement spoil the windows', async () => {
    for (const answer of [status(404), status(500), html(200)]) {
      const { session } = fakeSession(routes(answer));
      const result = await createClaudeWebProvider({
        session: () => session,
        supplements: [fake]
      }).fetch(NOW);
      // The whole point: four reported windows, `ok`, every time.
      expect(result.status, JSON.stringify(answer.status)).toBe('ok');
      expect(result.buckets).toHaveLength(4);
      expect(extraRow(result)).toBeUndefined();
      expect(result.supplements?.[0]?.status).not.toBe('ok');
    }
  });

  it('treats a 200 it cannot make sense of as no row, not as a failure', async () => {
    // A well-formed answer that simply says nothing about extra usage is not
    // an error — the account may just not have it. Same rule as
    // `parseExtraUsage` returning null.
    const { session } = fakeSession(routes(json({ hello: 'world' })));
    const result = await createClaudeWebProvider({
      session: () => session,
      supplements: [fake]
    }).fetch(NOW);
    expect(result.status).toBe('ok');
    expect(extraRow(result)).toBeUndefined();
    expect(result.supplements?.[0]).toMatchObject({ status: 'ok', buckets: 0 });
  });

  it('survives a supplement whose request throws', async () => {
    const { session } = fakeSession({
      [CLAUDE_ORGS_URL]: json(ORGS),
      [usageUrlFor(ORG)]: json(CLAUDE_USAGE)
      // No route for the supplement URL at all: the stub throws.
    });
    const result = await createClaudeWebProvider({
      session: () => session,
      supplements: [fake]
    }).fetch(NOW);
    expect(result.status).toBe('ok');
    expect(result.buckets).toHaveLength(4);
    expect(result.supplements?.[0]?.status).toBe('error');
  });

  it('pauses supplements for 15 minutes after a 429, without a timer', async () => {
    let answer: HttpResponse = status(429);
    const { session, calls } = fakeSession(routes(() => answer));
    const provider = createClaudeWebProvider({ session: () => session, supplements: [fake] });

    const first = await provider.fetch(NOW);
    expect(first.status).toBe('ok');
    expect(first.supplements?.[0]?.status).toBe('rate-limited');

    // The endpoint has recovered, but Walder has not asked again.
    answer = json(EXTRA_USAGE_ON);
    const during = await provider.fetch(new Date(NOW.getTime() + SUPPLEMENT_PAUSE_MS - 1));
    expect(during.status).toBe('ok');
    expect(during.buckets).toHaveLength(4);
    expect(during.supplements?.[0]).toMatchObject({ status: 'rate-limited', buckets: 0 });
    expect(calls.filter((c) => c.url === FAKE)).toHaveLength(1);

    // …and the windows kept refreshing on schedule throughout.
    expect(calls.filter((c) => c.url === usageUrlFor(ORG))).toHaveLength(2);

    const after = await provider.fetch(new Date(NOW.getTime() + SUPPLEMENT_PAUSE_MS));
    expect(extraRow(after)).toBeDefined();
    expect(calls.filter((c) => c.url === FAKE)).toHaveLength(2);
  });

  it('reports each supplement, and hands the same statuses to onSupplement', async () => {
    const seen: { id: string; status: string }[] = [];
    const { session } = fakeSession(routes(json(EXTRA_USAGE_ON)));
    const result = await createClaudeWebProvider({
      session: () => session,
      supplements: [fake],
      onSupplement: (s) => seen.push({ id: s.id, status: s.status })
    }).fetch(NOW);
    expect(seen).toEqual([{ id: 'extra-usage', status: 'ok' }]);
    expect(result.supplements).toHaveLength(seen.length);
  });

  it('ships none by default, so a claude.ai poll is two requests', async () => {
    // The change the confirmed shape bought: no extra GET per poll against an
    // endpoint family known to 429, for a number the payload already carried.
    expect(CLAUDE_SUPPLEMENTS).toEqual([]);
    const { session, calls } = fakeSession(routes(json(EXTRA_USAGE_ON)));
    const result = await createClaudeWebProvider({ session: () => session }).fetch(NOW);
    expect(calls.map((c) => c.url)).toEqual([CLAUDE_ORGS_URL, usageUrlFor(ORG)]);
    // Absent, not an empty array: nothing was attempted, so there is nothing
    // to report.
    expect(result.supplements).toBeUndefined();
    expect(result.status).toBe('ok');
  });
});

/* ------------------------------------------------------------- chatgpt-web */

describe('chatgpt-web', () => {
  const SESSION_OK = { accessToken: 'web-token', account: { account_id: 'acct-1' }, user: {} };
  const WHAM = 'https://chatgpt.com/backend-api/wham/usage';

  it('gets a bearer token from the session endpoint, then polls a candidate', async () => {
    const { session, calls } = fakeSession(
      {
        [CHATGPT_SESSION_URL]: json(SESSION_OK),
        [WHAM]: json(CODEX_USAGE)
      },
      [{ name: '__Secure-next-auth.session-token', domain: 'chatgpt.com' }]
    );

    const found: string[] = [];
    const result = await createChatGptWebProvider({
      session: () => session,
      onEndpointFound: (path) => found.push(path)
    }).fetch(NOW);

    expect(result.status).toBe('ok');
    expect(result.buckets.map((b) => b.label)).toEqual([
      'Codex 5-hour',
      'Codex weekly',
      'Codex credit limit'
    ]);
    expect(calls.map((c) => c.url)).toEqual([CHATGPT_SESSION_URL, WHAM]);
    // The bearer token and the account id are both sent on step 2, and neither
    // on step 1 (which is cookie-authenticated).
    expect(calls[0]?.headers['Authorization']).toBeUndefined();
    expect(calls[1]?.headers['Authorization']).toBe('Bearer web-token');
    expect(calls[1]?.headers['ChatGPT-Account-Id']).toBe('acct-1');
    expect(found).toEqual(['/backend-api/wham/usage']);
  });

  it('tries the candidates in order and stops at the first with buckets', async () => {
    const { session, calls } = fakeSession({
      [CHATGPT_SESSION_URL]: json(SESSION_OK),
      [WHAM]: json({ nothing: 'useful' }),
      'https://chatgpt.com/backend-api/conversation_limit': json(CODEX_USAGE)
    });
    const result = await createChatGptWebProvider({ session: () => session }).fetch(NOW);
    expect(result.status).toBe('ok');
    expect(calls.map((c) => c.url)).toEqual([
      CHATGPT_SESSION_URL,
      WHAM,
      'https://chatgpt.com/backend-api/conversation_limit'
    ]);
  });

  it('skips a candidate whose rows carry no number, and promotes the one that does', async () => {
    /*
     * The 0.2.6 failure, end to end (Victor's Mac, 2026-09-21).
     * `/backend-api/models` had been promoted to the front of the discovered
     * list, and the walker mined four numberless rows out of its model
     * presets — a non-empty parse, so this loop called it a success and the
     * real Codex numbers, one candidate later, never got a turn. The card
     * read `ChatGPT 0 … ChatGPT 3` at `?` all day.
     *
     * The payload here parses to a real, non-empty row — a `rate_limit`
     * window with a reset and no percentage — so what skips it is the rule
     * under test and not merely an empty parse.
     */
    const MODELS = 'https://chatgpt.com/backend-api/models';
    const { session, calls } = fakeSession({
      [CHATGPT_SESSION_URL]: json(SESSION_OK),
      [MODELS]: json({ rate_limit: { primary_window: { reset_at: 1788894534 } } }),
      [WHAM]: json(CODEX_USAGE)
    });
    const found: string[] = [];
    const result = await createChatGptWebProvider({
      session: () => session,
      discoveredPaths: () => ['/backend-api/models'],
      onEndpointFound: (path) => found.push(path)
    }).fetch(NOW);

    expect(result.status).toBe('ok');
    expect(result.buckets.map((b) => b.label)).toEqual([
      'Codex 5-hour',
      'Codex weekly',
      'Codex credit limit'
    ]);
    // Tried first because it was discovered, and then passed over.
    expect(calls.map((c) => c.url)).toEqual([CHATGPT_SESSION_URL, MODELS, WHAM]);
    // And the promotion follows the winner, not the first non-empty parse —
    // which is how the wrong path got to the front of the stored list.
    expect(found).toEqual(['/backend-api/wham/usage']);
  });

  it('reports endpoint-changed when every candidate answers without a number', async () => {
    const routes: Record<string, HttpResponse> = { [CHATGPT_SESSION_URL]: json(SESSION_OK) };
    for (const path of CHATGPT_CANDIDATE_PATHS) {
      routes[`https://chatgpt.com${path}`] = json({
        rate_limit: { primary_window: { reset_at: 1788894534 } }
      });
    }
    const { session } = fakeSession(routes);
    const result = await createChatGptWebProvider({ session: () => session }).fetch(NOW);
    expect(result.status).toBe('endpoint-changed');
  });

  it('accepts a candidate whose only row is a credit pool', async () => {
    // The other side of the same rule: a balance has no denominator, so
    // `pct: null` on a `credits` row is the row working as designed and not
    // a walker's guess. An account whose whole answer is a credit pool must
    // not read as "the endpoint moved".
    const { session } = fakeSession({
      [CHATGPT_SESSION_URL]: json(SESSION_OK),
      [WHAM]: json({ credits: { has_credits: true, unlimited: true } })
    });
    const result = await createChatGptWebProvider({ session: () => session }).fetch(NOW);
    expect(result.status).toBe('ok');
    expect(result.buckets.map((b) => b.id)).toEqual(['chatgpt.codex_credits']);
  });

  it('tries a discovered path before the built-in candidates', async () => {
    // Discovery is evidence (the real site asked for it); the built-ins are
    // guesses, so evidence goes first.
    const { session, calls } = fakeSession({
      [CHATGPT_SESSION_URL]: json(SESSION_OK),
      'https://chatgpt.com/backend-api/my/usage': json(CODEX_USAGE)
    });
    const result = await createChatGptWebProvider({
      session: () => session,
      discoveredPaths: () => ['/backend-api/my/usage']
    }).fetch(NOW);
    expect(result.status).toBe('ok');
    expect(calls[1]?.url).toBe('https://chatgpt.com/backend-api/my/usage');
  });

  it('keeps going when one candidate throws or 404s', async () => {
    const { session } = fakeSession({
      [CHATGPT_SESSION_URL]: json(SESSION_OK),
      [WHAM]: () => {
        throw new Error('reset by peer');
      },
      'https://chatgpt.com/backend-api/conversation_limit': status(404),
      'https://chatgpt.com/backend-api/models': json(CODEX_USAGE)
    });
    const result = await createChatGptWebProvider({ session: () => session }).fetch(NOW);
    expect(result.status).toBe('ok');
  });

  it('lists the paths it tried when none reports usage', async () => {
    // The honest answer to "we do not know which endpoint has the chat limits":
    // say what was tried, so the next person does not repeat it.
    const routes: Record<string, HttpResponse> = { [CHATGPT_SESSION_URL]: json(SESSION_OK) };
    for (const path of CHATGPT_CANDIDATE_PATHS) {
      routes[`https://chatgpt.com${path}`] = json({ irrelevant: true });
    }
    const { session } = fakeSession(routes);
    const result = await createChatGptWebProvider({ session: () => session }).fetch(NOW);

    expect(result.status).toBe('endpoint-changed');
    for (const path of CHATGPT_CANDIDATE_PATHS) expect(result.message).toContain(path);
    // Paths, never full URLs with query strings that could carry anything.
    expect(result.message).not.toContain('https://');
  });

  it('says auth-needed for an empty session payload', async () => {
    // What a logged-out browser gets from `/api/auth/session`: `{}`.
    const { session } = fakeSession({ [CHATGPT_SESSION_URL]: json({}) });
    const result = await createChatGptWebProvider({ session: () => session }).fetch(NOW);
    expect(result.status).toBe('auth-needed');
  });

  it('maps 401 and 429 on the session endpoint', async () => {
    const out = fakeSession({ [CHATGPT_SESSION_URL]: status(401) });
    expect(
      (await createChatGptWebProvider({ session: () => out.session }).fetch(NOW)).status
    ).toBe('auth-needed');

    const limited = fakeSession({ [CHATGPT_SESSION_URL]: status(429) });
    expect(
      (await createChatGptWebProvider({ session: () => limited.session }).fetch(NOW)).status
    ).toBe('rate-limited');
  });

  it('is available on any chatgpt.com cookie', async () => {
    // Looser than the claude.ai check on purpose: OpenAI has renamed its
    // session cookie before, and a login the provider refuses to try is
    // invisible to the owner.
    const some = fakeSession({}, [{ name: 'oai-did', domain: 'chatgpt.com' }]);
    expect(await createChatGptWebProvider({ session: () => some.session }).isAvailable()).toBe(true);

    const none = fakeSession({}, []);
    expect(await createChatGptWebProvider({ session: () => none.session }).isAvailable()).toBe(
      false
    );
  });

  it('is unavailable, with a reason, outside the app', async () => {
    const result = await createChatGptWebProvider({ session: () => null }).fetch(NOW);
    expect(result.status).toBe('unavailable');
    expect(result.message).toBe(NEEDS_APP_SESSION);
  });

  it('omits the account header when no account id is offered', async () => {
    const { session, calls } = fakeSession({
      [CHATGPT_SESSION_URL]: json({ accessToken: 'web-token' }),
      [WHAM]: json(CODEX_USAGE)
    });
    await createChatGptWebProvider({ session: () => session }).fetch(NOW);
    expect(calls[1]?.headers['ChatGPT-Account-Id']).toBeUndefined();
  });

  /*
   * The candidate walk is a *search*, and this is its ceiling. Ten discovered
   * paths plus three built-ins at a 15 s timeout each would have kept one poll
   * busy for minutes and hammered the owner's account every tick.
   */
  describe('the per-poll ceiling', () => {
    it('tries at most five candidates, then reports what it tried', async () => {
      const discovered = ['/a/usage', '/b/usage', '/c/usage', '/d/usage', '/e/usage', '/f/usage'];
      // No routes for the candidates: each throws inside the stub, which is one
      // of the two ways a candidate can be dead, and the walk continues.
      const { session, calls } = fakeSession({ [CHATGPT_SESSION_URL]: json(SESSION_OK) });
      const result = await createChatGptWebProvider({
        session: () => session,
        discoveredPaths: () => discovered
      }).fetch(NOW);

      expect(result.status).toBe('endpoint-changed');
      // One session call plus exactly five candidates.
      expect(calls).toHaveLength(1 + CHATGPT_MAX_CANDIDATES);
      expect(result.message).toContain('/e/usage');
      expect(result.message).not.toContain('/f/usage');
    });

    it('gives up when the budget runs out, and says so', async () => {
      // A clock that jumps 20 s per reading: the third look at it is past the
      // 45 s budget, so the walk stops there rather than working through the
      // rest of the list.
      let ticks = 0;
      const clock = (): number => {
        const at = ticks * 20_000;
        ticks++;
        return at;
      };
      const { session, calls } = fakeSession({ [CHATGPT_SESSION_URL]: json(SESSION_OK) });
      const result = await createChatGptWebProvider({
        session: () => session,
        discoveredPaths: () => ['/a/usage', '/b/usage', '/c/usage', '/d/usage'],
        clock
      }).fetch(NOW);

      expect(result.status).toBe('endpoint-changed');
      expect(result.message).toContain('ran out of time');
      expect(calls).toHaveLength(1 + 2);
      expect(CHATGPT_CANDIDATE_BUDGET_MS).toBe(45_000);
    });

    it('gives each request no more than the budget that is left', async () => {
      const { session, calls } = fakeSession({
        [CHATGPT_SESSION_URL]: json(SESSION_OK),
        [WHAM]: json(CODEX_USAGE)
      });
      await createChatGptWebProvider({ session: () => session, clock: () => 0 }).fetch(NOW);
      // A single hung candidate must not be able to overrun the whole ceiling.
      expect(calls[1]?.timeoutMs).toBeGreaterThan(0);
      expect(calls[1]?.timeoutMs).toBeLessThanOrEqual(CHATGPT_CANDIDATE_BUDGET_MS);
    });

    it('tries the path that worked last time first on the next poll', async () => {
      const found = 'https://chatgpt.com/backend-api/my/usage';
      const { session, calls } = fakeSession({
        [CHATGPT_SESSION_URL]: json(SESSION_OK),
        [found]: json(CODEX_USAGE)
      });
      // The store forgets between polls (`discoveredPaths` keeps returning the
      // same one hint); the provider must remember by itself.
      const provider = createChatGptWebProvider({
        session: () => session,
        discoveredPaths: () => ['/x/dead-usage', '/backend-api/my/usage']
      });

      expect((await provider.fetch(NOW)).status).toBe('ok');
      const firstWalk = calls.length;
      expect((await provider.fetch(NOW)).status).toBe('ok');

      // Second poll: session, then straight to the endpoint that answered —
      // the dead hint is not walked again.
      expect(calls.slice(firstWalk).map((c) => c.url)).toEqual([CHATGPT_SESSION_URL, found]);
    });
  });

  /*
   * `isAuthenticated` is what the login window waits for, and it cannot be the
   * cookie check above: chatgpt.com sets cookies on the login page itself, so
   * "has a cookie" is true the moment the window opens.
   */
  describe('isAuthenticated', () => {
    const provider = (routes: Record<string, HttpResponse | (() => HttpResponse)>) =>
      createChatGptWebProvider({ session: () => fakeSession(routes).session });

    it('is true only when the session endpoint hands back an access token', async () => {
      expect(
        await provider({ [CHATGPT_SESSION_URL]: json(SESSION_OK) }).isAuthenticated?.()
      ).toBe(true);
      // `{}` is what a logged-out browser gets there.
      expect(await provider({ [CHATGPT_SESSION_URL]: json({}) }).isAuthenticated?.()).toBe(false);
      expect(
        await provider({ [CHATGPT_SESSION_URL]: json({ user: { email: 'a@b.c' } }) }).isAuthenticated?.()
      ).toBe(false);
    });

    it('is false for 401, an HTML login page, a throw, and outside the app', async () => {
      expect(await provider({ [CHATGPT_SESSION_URL]: status(401) }).isAuthenticated?.()).toBe(
        false
      );
      expect(await provider({ [CHATGPT_SESSION_URL]: html() }).isAuthenticated?.()).toBe(false);
      expect(
        await provider({
          [CHATGPT_SESSION_URL]: () => {
            throw new Error('offline');
          }
        }).isAuthenticated?.()
      ).toBe(false);
      expect(await createChatGptWebProvider({ session: () => null }).isAuthenticated?.()).toBe(
        false
      );
    });

    it('never returns the token it read', async () => {
      const { session } = fakeSession({ [CHATGPT_SESSION_URL]: json(SESSION_OK) });
      const provider = createChatGptWebProvider({ session: () => session });
      const answer = await provider.isAuthenticated?.();
      expect(answer).toBe(true);
      expect(JSON.stringify(answer)).not.toContain('web-token');
      expect(JSON.stringify(provider.lastCheck?.())).not.toContain('web-token');
    });

    /*
     * The fallback, added 2026-09-08. `{}` from the session endpoint means
     * "logged out" today; if OpenAI renames `accessToken` it will mean "logged
     * out" for a logged-in owner, and the symptom is exactly what was reported —
     * the login goes through, the window stays open, the tray says login needed.
     */
    describe('the /backend-api/me fallback', () => {
      it('accepts a 200 there when the session endpoint hands back no token', async () => {
        for (const me of [{ id: 'user-1' }, { email: 'a@b.c' }]) {
          const { session, calls } = fakeSession({
            [CHATGPT_SESSION_URL]: json({}),
            [CHATGPT_ME_URL]: json(me)
          });
          expect(
            await createChatGptWebProvider({ session: () => session }).isAuthenticated?.()
          ).toBe(true);
          expect(calls.map((c) => c.url)).toEqual([CHATGPT_SESSION_URL, CHATGPT_ME_URL]);
        }
      });

      it('is not tried after a 401 or 403, which is already an answer', async () => {
        for (const code of [401, 403]) {
          const { session, calls } = fakeSession({
            [CHATGPT_SESSION_URL]: status(code),
            [CHATGPT_ME_URL]: json({ id: 'user-1' })
          });
          expect(
            await createChatGptWebProvider({ session: () => session }).isAuthenticated?.()
          ).toBe(false);
          expect(calls.map((c) => c.url)).toEqual([CHATGPT_SESSION_URL]);
        }
      });

      it('does not turn a logged-out browser into a login', async () => {
        for (const me of [json({}), json({ features: ['a'] }), status(401), html()]) {
          const { session } = fakeSession({
            [CHATGPT_SESSION_URL]: json({}),
            [CHATGPT_ME_URL]: me
          });
          expect(
            await createChatGptWebProvider({ session: () => session }).isAuthenticated?.()
          ).toBe(false);
        }
      });

      it('reads only whether the fields are there, never their values', async () => {
        const { session } = fakeSession({
          [CHATGPT_SESSION_URL]: json({}),
          [CHATGPT_ME_URL]: json({ id: 'user-1', email: 'victor@example.com' })
        });
        const provider = createChatGptWebProvider({ session: () => session });
        expect(await provider.isAuthenticated?.()).toBe(true);
        expect(JSON.stringify(provider.lastCheck?.())).not.toContain('victor@example.com');
      });
    });

    describe('lastCheck', () => {
      it('is null until something has been checked', () => {
        const { session } = fakeSession({ [CHATGPT_SESSION_URL]: json(SESSION_OK) });
        expect(createChatGptWebProvider({ session: () => session }).lastCheck?.()).toBeNull();
      });

      it('distinguishes "no access token" from an HTTP failure', async () => {
        const noToken = fakeSession({
          [CHATGPT_SESSION_URL]: json({}),
          [CHATGPT_ME_URL]: status(401)
        });
        const a = createChatGptWebProvider({ session: () => noToken.session });
        await a.isAuthenticated?.();
        expect(a.lastCheck?.()?.detail).toBe('no access token');

        const refused = fakeSession({ [CHATGPT_SESSION_URL]: status(403) });
        const b = createChatGptWebProvider({ session: () => refused.session });
        await b.isAuthenticated?.();
        expect(b.lastCheck?.()).toMatchObject({ loggedIn: false, failed: false, detail: 'HTTP 403' });
      });

      it('marks an aborted request as a failed check, not a failed login', async () => {
        const { session } = fakeSession({
          [CHATGPT_SESSION_URL]: () => {
            const error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            throw error;
          }
        });
        const provider = createChatGptWebProvider({ session: () => session });
        await provider.isAuthenticated?.();
        expect(provider.lastCheck?.()).toMatchObject({ failed: true, detail: 'timeout' });
      });
    });
  });

  describe('identifiesAccount', () => {
    it('is presence, not value', () => {
      expect(identifiesAccount({ id: 'user-1' })).toBe(true);
      expect(identifiesAccount({ email: 'a@b.c' })).toBe(true);
      expect(identifiesAccount({ id: '' })).toBe(false);
      expect(identifiesAccount({})).toBe(false);
      expect(identifiesAccount({ features: ['a'] })).toBe(false);
      expect(identifiesAccount([{ id: 'x' }])).toBe(false);
      expect(identifiesAccount(null)).toBe(false);
      expect(identifiesAccount('id')).toBe(false);
    });
  });

  describe('parseSession', () => {
    it('reads the token and, when present, the account id', () => {
      expect(parseSession({ accessToken: 't', account: { account_id: 'a' } })).toEqual({
        accessToken: 't',
        accountId: 'a'
      });
      expect(parseSession({ accessToken: 't', account: { accountId: 'a' } })?.accountId).toBe('a');
      expect(parseSession({ accessToken: 't', account: { account: { id: 'a' } } })?.accountId).toBe(
        'a'
      );
      expect(parseSession({ accessToken: 't' })?.accountId).toBeNull();
    });

    it('is null without a token', () => {
      expect(parseSession({})).toBeNull();
      expect(parseSession({ accessToken: '' })).toBeNull();
      expect(parseSession(null)).toBeNull();
    });

    it('reads nothing but the token and account id', () => {
      // The payload also carries the owner's name, email and picture.
      const parsed = parseSession({
        accessToken: 't',
        user: { email: 'someone@example.com', name: 'Someone' }
      });
      expect(JSON.stringify(parsed)).not.toContain('example.com');
    });
  });

  describe('candidatePaths', () => {
    it('puts discovered paths first and dedupes against the built-ins', () => {
      expect(candidatePaths(['/backend-api/wham/usage', '/x/usage'])).toEqual([
        '/backend-api/wham/usage',
        '/x/usage',
        '/backend-api/conversation_limit',
        '/backend-api/models'
      ]);
    });

    it('ignores a stored value that is not a path', () => {
      // Nothing stored can turn into an absolute URL and send a bearer token to
      // another host: the origin is always prepended by the provider.
      expect(candidatePaths(['https://evil.example/usage'])).toEqual([
        ...CHATGPT_CANDIDATE_PATHS
      ]);
    });

    it('rejects a protocol-relative path', () => {
      // `https://chatgpt.com` + `//evil.example/usage` is a URL whose host is
      // not the one the reader expects, and it would carry a bearer token.
      expect(candidatePaths(['//evil.example/usage'])).toEqual([...CHATGPT_CANDIDATE_PATHS]);
      expect(candidatePaths(['///evil.example/usage'])).toEqual([...CHATGPT_CANDIDATE_PATHS]);
      expect(candidatePaths([], '//evil.example/usage')).toEqual([...CHATGPT_CANDIDATE_PATHS]);
    });

    it('strips a query string off a stored path', () => {
      // Old settings files hold path *and* query; a stored `?token=…` must not
      // be replayed on every poll.
      expect(candidatePaths(['/backend-api/usage?token=eyJabc'])[0]).toBe('/backend-api/usage');
    });

    it('puts the remembered successful path ahead of everything', () => {
      expect(candidatePaths(['/a/usage'], '/b/usage').slice(0, 2)).toEqual([
        '/b/usage',
        '/a/usage'
      ]);
      // And does not duplicate it when it is also in the discovered list.
      expect(candidatePaths(['/a/usage'], '/a/usage')[0]).toBe('/a/usage');
      expect(candidatePaths(['/a/usage'], '/a/usage').filter((p) => p === '/a/usage')).toHaveLength(
        1
      );
    });
  });

  it('calls onUsageKeys with the sorted keys of the winning candidate only', async () => {
    const winning = { rate_limit: { primary_window: { used_percent: 10 } }, plan: 'plus' };
    const { session } = fakeSession({
      [CHATGPT_SESSION_URL]: json(SESSION_OK),
      [WHAM]: json({ nothing: 'useful' }),
      'https://chatgpt.com/backend-api/conversation_limit': json(winning)
    });
    const seen: string[][] = [];
    const result = await createChatGptWebProvider({
      session: () => session,
      onUsageKeys: (keys) => seen.push(keys)
    }).fetch(NOW);
    expect(result.status).toBe('ok');
    // Not the dead WHAM candidate's keys — only the one that actually
    // answered — and sorted regardless of the payload's own key order.
    expect(seen).toEqual([['plan', 'rate_limit']]);
  });

  it('walker output is capped at MAX_WALKED_BUCKETS', async () => {
    // An unrecognised payload with six usage-shaped children — more than the
    // whitelist-free walker is allowed to surface on one card.
    const manyBuckets: Record<string, unknown> = {};
    for (let i = 0; i < 6; i += 1) {
      manyBuckets[`feature_${i}`] = { used_percent: i * 10, reset_at: '2026-09-20T00:00:00Z' };
    }
    const { session } = fakeSession({
      [CHATGPT_SESSION_URL]: json(SESSION_OK),
      [WHAM]: json(manyBuckets)
    });
    const result = await createChatGptWebProvider({ session: () => session }).fetch(NOW);
    expect(result.status).toBe('ok');
    expect(result.buckets.length).toBeLessThanOrEqual(4);
  });
});

/* ----------------------------------------------------------- chatgpt-codex */

describe('chatgpt-codex', () => {
  const creds = { accessToken: 'codex-token', accountId: 'acct-9' };

  it('returns the two Codex windows, honestly labelled', async () => {
    // "Codex", not "ChatGPT": this endpoint reports the Codex allowance, and
    // relabelling it would make the owner ration the wrong budget.
    const { http } = stub({ [CODEX_USAGE_URL]: json(CODEX_USAGE) });
    const result = await createChatGptCodexProvider({
      http,
      readCredentials: async () => creds
    }).fetch(NOW);

    expect(result.status).toBe('ok');
    // The same payload's `credits` and `spend_control` blocks are now rows of
    // their own.
    expect(result.buckets.map((b) => b.label)).toEqual([
      'Codex 5-hour',
      'Codex weekly',
      'Codex credit limit'
    ]);
    expect(result.buckets.map((b) => b.pct)).toEqual([37, 12, 42.5]);
    // The absolute `reset_at` wins over the relative `reset_after_seconds` that
    // sits beside it, so the window does not appear to move on every poll.
    expect(result.buckets[0]?.resetsAt).toBe(new Date(1788894534 * 1000).toISOString());
  });

  it('sends the Codex CLI\'s own headers', async () => {
    const { http, calls } = stub({ [CODEX_USAGE_URL]: json(CODEX_USAGE) });
    await createChatGptCodexProvider({ http, readCredentials: async () => creds }).fetch(NOW);
    expect(calls[0]?.headers).toEqual({
      Authorization: 'Bearer codex-token',
      'User-Agent': CODEX_USER_AGENT,
      Accept: 'application/json',
      'ChatGPT-Account-Id': 'acct-9'
    });
  });

  it('omits an empty account header rather than sending one', async () => {
    const { http, calls } = stub({ [CODEX_USAGE_URL]: json(CODEX_USAGE) });
    await createChatGptCodexProvider({
      http,
      readCredentials: async () => ({ accessToken: 't', accountId: null })
    }).fetch(NOW);
    expect(calls[0]?.headers['ChatGPT-Account-Id']).toBeUndefined();
  });

  it('maps 401, 429, 404 and HTML the same way as the others', async () => {
    const cases: [HttpResponse, string][] = [
      [status(401), 'auth-needed'],
      [status(429), 'rate-limited'],
      [status(404), 'endpoint-changed'],
      [html(200), 'endpoint-changed'],
      [status(502), 'error']
    ];
    for (const [response, expected] of cases) {
      const { http } = stub({ [CODEX_USAGE_URL]: response });
      const result = await createChatGptCodexProvider({
        http,
        readCredentials: async () => creds
      }).fetch(NOW);
      expect(result.status).toBe(expected);
    }
  });

  it('reports endpoint-changed for a payload with no windows', async () => {
    const { http } = stub({ [CODEX_USAGE_URL]: json({ plan_type: 'team', credits: {} }) });
    const result = await createChatGptCodexProvider({
      http,
      readCredentials: async () => creds
    }).fetch(NOW);
    expect(result.status).toBe('endpoint-changed');
  });

  it('is unavailable when Codex is not logged in', async () => {
    const provider = createChatGptCodexProvider({
      http: stub({}).http,
      readCredentials: async () => null
    });
    expect(await provider.isAvailable()).toBe(false);
    expect((await provider.fetch(NOW)).status).toBe('unavailable');
  });

  it('never puts the token in its result', async () => {
    const { http } = stub({ [CODEX_USAGE_URL]: json(CODEX_USAGE) });
    const result = await createChatGptCodexProvider({
      http,
      readCredentials: async () => ({ accessToken: 'SUPER-SECRET', accountId: null })
    }).fetch(NOW);
    expect(JSON.stringify(result)).not.toContain('SUPER-SECRET');
  });
});

/* ------------------------------------------------------------------ cursor */

describe('cursor', () => {
  const creds = { accessToken: 'cursor-jwt' };

  it('POSTs the empty Connect message with a bearer token and JSON headers', async () => {
    const { http, calls } = stub({ [CURSOR_USAGE_URL]: json(CURSOR_USAGE) });
    await createCursorProvider({ http, readCredentials: async () => creds }).fetch(NOW);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({
      Authorization: 'Bearer cursor-jwt',
      'Content-Type': 'application/json',
      Accept: 'application/json'
    });
    expect(calls[0]?.post).toBe(CURSOR_USAGE_MESSAGE);
  });

  it('returns the rows for a real-shape payload, and still reports the key names', async () => {
    const { http } = stub({ [CURSOR_USAGE_URL]: json(CURSOR_USAGE) });
    const keys: string[][] = [];
    const result = await createCursorProvider({
      http,
      readCredentials: async () => creds,
      onUsageKeys: (k) => keys.push(k)
    }).fetch(NOW);
    expect(result.status).toBe('ok');
    expect(result.via).toBe(CURSOR_ID);
    expect(result.buckets.map((b) => b.label)).toEqual([
      'Cursor plan',
      'Cursor Auto',
      'Cursor on-demand'
    ]);
    // The key dump stays on the happy path: it is how the *next* shape change
    // gets noticed, and a provider that only reports keys when it fails would
    // report them exactly when it is too late.
    expect(keys).toEqual([Object.keys(CURSOR_USAGE as Record<string, unknown>)]);
  });

  it('an object with no planUsage is endpoint-changed and reports the keys', async () => {
    const { http } = stub({ [CURSOR_USAGE_URL]: json({ billingCycleEnd: '2026-10-04T00:00:00Z' }) });
    const unexpected: string[][] = [];
    const result = await createCursorProvider({
      http,
      readCredentials: async () => creds,
      onUnexpectedShape: (k) => unexpected.push(k)
    }).fetch(NOW);
    expect(result.status).toBe('endpoint-changed');
    expect(result.message).toBe(CURSOR_UNREADABLE_MESSAGE);
    expect(result.buckets).toEqual([]);
    expect(unexpected).toEqual([['billingCycleEnd']]);
  });

  it('maps 401, 429, 404, HTML and 5xx the same way as the others', async () => {
    const cases: [HttpResponse, string][] = [
      [status(401), 'auth-needed'],
      [status(429), 'rate-limited'],
      [status(404), 'endpoint-changed'],
      [html(200), 'endpoint-changed'],
      [status(502), 'error']
    ];
    for (const [response, expected] of cases) {
      const { http } = stub({ [CURSOR_USAGE_URL]: response });
      const result = await createCursorProvider({ http, readCredentials: async () => creds }).fetch(NOW);
      expect(result.status).toBe(expected);
      expect(result.via).toBe(CURSOR_ID);
    }
  });

  it('names the editor as the fix on a 401', async () => {
    const { http } = stub({ [CURSOR_USAGE_URL]: status(401) });
    const result = await createCursorProvider({ http, readCredentials: async () => creds }).fetch(NOW);
    expect(result.message).toBe(CURSOR_LOGGED_OUT_MESSAGE);
  });

  it('is unavailable without the editor login, and never opens a browser', async () => {
    const provider = createCursorProvider({ http: stub({}).http, readCredentials: async () => null });
    expect(await provider.isAvailable()).toBe(false);
    expect((await provider.fetch(NOW)).status).toBe('unavailable');
    // No `isAuthenticated`: the registry hands the login window only to
    // providers that implement it, and a cursor.com sign-in makes an empty
    // second account.
    expect(provider.isAuthenticated).toBeUndefined();
  });

  it('never puts the token in its result', async () => {
    const { http } = stub({ [CURSOR_USAGE_URL]: json(CURSOR_USAGE) });
    const result = await createCursorProvider({
      http,
      readCredentials: async () => ({ accessToken: 'SUPER-SECRET' })
    }).fetch(NOW);
    expect(JSON.stringify(result)).not.toContain('SUPER-SECRET');
  });
});

/* ----------------------------------------------------------------- copilot */

describe('copilot', () => {
  const creds = { accessToken: 'gho_fake' };

  it('GETs the user endpoint with gh\'s token and a User-Agent', async () => {
    // api.github.com rejects a request with no `User-Agent`, and the scheme is
    // `token`, not `Bearer` — both are easy to get wrong and silent when you do.
    const { http, calls } = stub({ [COPILOT_USER_URL]: json(COPILOT_USER) });
    await createCopilotProvider({ http, readCredentials: async () => creds }).fetch(NOW);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({
      Authorization: 'token gho_fake',
      Accept: 'application/json',
      'User-Agent': COPILOT_USER_AGENT
    });
    // A GET: no Connect-RPC message here, unlike Cursor.
    expect(calls[0]?.post).toBeUndefined();
  });

  it('returns the three rows for a real-shape payload, and reports the keys', async () => {
    const { http } = stub({ [COPILOT_USER_URL]: json(COPILOT_USER) });
    const keys: string[][] = [];
    const result = await createCopilotProvider({
      http,
      readCredentials: async () => creds,
      onUsageKeys: (k) => keys.push(k)
    }).fetch(NOW);
    expect(result.status).toBe('ok');
    expect(result.via).toBe(COPILOT_ID);
    expect(result.buckets.map((b) => b.label)).toEqual([
      'Copilot premium',
      'Copilot chat',
      'Copilot completions'
    ]);
    // The key dump stays on the happy path: it is how the *next* shape change
    // gets noticed, and keys-only-on-failure reports them too late.
    expect(keys).toEqual([Object.keys(COPILOT_USER as Record<string, unknown>)]);
  });

  it('reads a 404 as "no Copilot on this account", not as a moved endpoint', async () => {
    // `classifyHttp` would say `endpoint-changed` for any other 404. This is
    // the answer most GitHub accounts give, and it is about the account.
    const { http } = stub({ [COPILOT_USER_URL]: status(404) });
    const result = await createCopilotProvider({ http, readCredentials: async () => creds }).fetch(
      NOW
    );
    expect(result.status).toBe('unavailable');
    expect(result.message).toBe(COPILOT_NOT_ENABLED_MESSAGE);
    expect(result.buckets).toEqual([]);
  });

  it('maps 401, 429, HTML and 5xx the same way as the others', async () => {
    const cases: [HttpResponse, string][] = [
      [status(401), 'auth-needed'],
      [status(403), 'auth-needed'],
      [status(429), 'rate-limited'],
      [html(200), 'endpoint-changed'],
      [status(502), 'error']
    ];
    for (const [response, expected] of cases) {
      const { http } = stub({ [COPILOT_USER_URL]: response });
      const result = await createCopilotProvider({
        http,
        readCredentials: async () => creds
      }).fetch(NOW);
      expect(result.status).toBe(expected);
      expect(result.via).toBe(COPILOT_ID);
    }
  });

  it('names `gh auth login` as the fix on a 401', async () => {
    const { http } = stub({ [COPILOT_USER_URL]: status(401) });
    const result = await createCopilotProvider({ http, readCredentials: async () => creds }).fetch(
      NOW
    );
    expect(result.message).toBe(COPILOT_LOGGED_OUT_MESSAGE);
  });

  it('an object with no quota_snapshots is endpoint-changed and reports the keys', async () => {
    const { http } = stub({ [COPILOT_USER_URL]: json({ copilot_plan: 'free' }) });
    const unexpected: string[][] = [];
    const result = await createCopilotProvider({
      http,
      readCredentials: async () => creds,
      onUnexpectedShape: (k) => unexpected.push(k)
    }).fetch(NOW);
    expect(result.status).toBe('endpoint-changed');
    expect(result.message).toBe(COPILOT_UNREADABLE_MESSAGE);
    expect(result.buckets).toEqual([]);
    expect(unexpected).toEqual([['copilot_plan']]);
  });

  it('is unavailable when gh has no token, and never opens a browser', async () => {
    const provider = createCopilotProvider({
      http: stub({}).http,
      readCredentials: async () => null
    });
    expect(await provider.isAvailable()).toBe(false);
    const result = await provider.fetch(NOW);
    expect(result.status).toBe('unavailable');
    expect(result.message).toBe(COPILOT_LOGGED_OUT_MESSAGE);
    // No `isAuthenticated`: the registry hands the login window only to
    // providers that implement it, and `gh auth login` is the only remedy.
    expect(provider.isAuthenticated).toBeUndefined();
  });

  it('never puts the token in its result', async () => {
    const { http } = stub({ [COPILOT_USER_URL]: json(COPILOT_USER) });
    const result = await createCopilotProvider({
      http,
      readCredentials: async () => ({ accessToken: 'SUPER-SECRET' })
    }).fetch(NOW);
    expect(JSON.stringify(result)).not.toContain('SUPER-SECRET');
  });
});

/* ------------------------------------------------------------ antigravity */

/**
 * The discovery half is what is new here, so it is what these drive: three
 * child processes (`pgrep`, `ps`, `lsof`), two loopback ports of which only
 * one speaks HTTP, and a cached `{port, token}` that has to survive a good
 * poll and be dropped by a bad one.
 *
 * The exec table is keyed on the binary, which is also the assertion that the
 * absolute paths are the ones being run: a `pgrep` found on the owner's PATH
 * would simply not be in the table.
 */
describe('antigravity', () => {
  const PID = 4242;
  const TOKEN = 'csrf-secret-token';
  const HTTP_PORT = 51010;
  const HTTPS_PORT = 51011;

  const lsofOutput = (...ports: number[]): string =>
    [
      'COMMAND     PID        USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME',
      ...ports.map((p) => `language_ ${PID} owner    7u  IPv4  0x1234      0t0  TCP 127.0.0.1:${p} (LISTEN)`)
    ].join('\n');

  /** The default machine: Antigravity running, token on the argv, two ports. */
  function execTable(overrides: Partial<Record<string, string>> = {}) {
    const calls: { bin: string; args: readonly string[] }[] = [];
    const table: Record<string, string> = {
      [PGREP_BIN]: `${PID}\n`,
      [PS_BIN]: `/Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/${ANTIGRAVITY_PROCESS} --csrf_token ${TOKEN} --other 1\n`,
      [LSOF_BIN]: lsofOutput(HTTPS_PORT, HTTP_PORT),
      ...overrides
    };
    const exec = async (bin: string, args: readonly string[]): Promise<string> => {
      calls.push({ bin, args });
      return table[bin] ?? '';
    };
    return { exec, calls };
  }

  /** An HTTPS port answering a plain request, as the real one does. */
  const wrongProtocol = (): HttpResponse => ({
    ok: false,
    status: 400,
    contentType: 'text/plain',
    body: 'Client sent an HTTP request to an HTTPS server.'
  });

  it('walks pgrep, ps and lsof, then keeps the port that answers 200', async () => {
    const { exec, calls } = execTable();
    const { http, calls: requests } = stub({
      [antigravityUrl(HTTPS_PORT)]: wrongProtocol(),
      [antigravityUrl(HTTP_PORT)]: json(ANTIGRAVITY_QUOTA)
    });
    const provider = createAntigravityProvider({ http, exec });

    const result = await provider.fetch(NOW);
    expect(result.status).toBe('ok');
    expect(result.via).toBe(ANTIGRAVITY_ID);
    expect(result.buckets.map((b) => b.label)).toEqual(['Gemini weekly', 'Claude & GPT weekly']);

    // Absolute binaries, one process each, and never a shell.
    expect(calls.map((c) => c.bin)).toEqual([PGREP_BIN, PS_BIN, LSOF_BIN]);
    expect(calls[0]?.args).toEqual(['-f', ANTIGRAVITY_PROCESS]);
    expect(calls[1]?.args).toEqual(['-o', 'args=', '-p', String(PID)]);
    expect(calls[2]?.args).toEqual(['-nP', '-a', '-p', String(PID), '-iTCP', '-sTCP:LISTEN']);

    // The CSRF argument travels as the header the server checks, on both tries.
    expect(requests.map((r) => r.url)).toEqual([
      antigravityUrl(HTTPS_PORT),
      antigravityUrl(HTTP_PORT)
    ]);
    expect(requests[1]?.headers[ANTIGRAVITY_CSRF_HEADER]).toBe(TOKEN);
    expect(requests[1]?.post).toBe(ANTIGRAVITY_RPC_MESSAGE);
  });

  it('reuses the cached port on the next poll, and runs no child process', async () => {
    // The three `exec` calls are the only expensive part of this provider, and
    // the answer does not change while the IDE stays open.
    const { exec, calls } = execTable();
    const { http, calls: requests } = stub({
      [antigravityUrl(HTTPS_PORT)]: wrongProtocol(),
      [antigravityUrl(HTTP_PORT)]: json(ANTIGRAVITY_QUOTA)
    });
    const provider = createAntigravityProvider({ http, exec });

    await provider.fetch(NOW);
    expect(await provider.fetch(NOW)).toMatchObject({ status: 'ok' });
    expect(calls).toHaveLength(3);
    expect(requests.map((r) => r.url)).toEqual([
      antigravityUrl(HTTPS_PORT),
      antigravityUrl(HTTP_PORT),
      antigravityUrl(HTTP_PORT)
    ]);
  });

  it('is unavailable when Antigravity is not running, and asks nothing else', async () => {
    // `pgrep` exits 1 with no output when nothing matches, which the injected
    // exec models as an empty answer rather than a throw.
    const { exec, calls } = execTable({ [PGREP_BIN]: '' });
    const provider = createAntigravityProvider({ http: stub({}).http, exec });

    expect(await provider.isAvailable()).toBe(false);
    const result = await provider.fetch(NOW);
    expect(result.status).toBe('unavailable');
    expect(result.message).toBe(ANTIGRAVITY_NOT_RUNNING_MESSAGE);
    expect(result.buckets).toEqual([]);
    // One `pgrep` for `isAvailable` and one for the fetch; no `ps`, no `lsof`.
    expect(calls.map((c) => c.bin)).toEqual([PGREP_BIN, PGREP_BIN]);
    // No `isAuthenticated`: there is no web login, and no window to hand it.
    expect(provider.isAuthenticated).toBeUndefined();
  });

  it('errors and drops the cache when no port answers', async () => {
    const { exec, calls } = execTable();
    const { http } = stub({
      [antigravityUrl(HTTPS_PORT)]: wrongProtocol(),
      [antigravityUrl(HTTP_PORT)]: status(503)
    });
    const provider = createAntigravityProvider({ http, exec });

    const result = await provider.fetch(NOW);
    expect(result.status).toBe('error');
    expect(result.message).toBe(ANTIGRAVITY_NO_ANSWER_MESSAGE);
    // Nothing cached, so the next poll goes back to the process table — which
    // is what a restarted IDE on a new port needs.
    await provider.fetch(NOW);
    expect(calls.map((c) => c.bin)).toEqual([PGREP_BIN, PS_BIN, LSOF_BIN, PGREP_BIN, PS_BIN, LSOF_BIN]);
  });

  it('drops a cached port that has stopped answering', async () => {
    let healthy = true;
    const { exec, calls } = execTable({ [LSOF_BIN]: lsofOutput(HTTP_PORT) });
    const { http } = stub({
      [antigravityUrl(HTTP_PORT)]: () => (healthy ? json(ANTIGRAVITY_QUOTA) : status(500))
    });
    const provider = createAntigravityProvider({ http, exec });

    expect((await provider.fetch(NOW)).status).toBe('ok');
    healthy = false;
    expect((await provider.fetch(NOW)).status).toBe('error');
    healthy = true;
    expect((await provider.fetch(NOW)).status).toBe('ok');
    // Discovered twice: once at the start, once after the cache was dropped.
    expect(calls.filter((c) => c.bin === PGREP_BIN)).toHaveLength(2);
  });

  it('gives up without a request when the argv carries no token', async () => {
    const { exec } = execTable({ [PS_BIN]: `/path/to/${ANTIGRAVITY_PROCESS} --quiet\n` });
    const { http, calls: requests } = stub({});
    const result = await createAntigravityProvider({ http, exec }).fetch(NOW);
    expect(result.status).toBe('error');
    expect(result.message).toBe(ANTIGRAVITY_NO_ANSWER_MESSAGE);
    // An unauthenticated call would only turn "did not answer" into a 401.
    expect(requests).toEqual([]);
  });

  it('accepts the `--csrf_token=value` spelling too', async () => {
    const { exec } = execTable({
      [PS_BIN]: `/path/to/${ANTIGRAVITY_PROCESS} --csrf_token=${TOKEN}\n`,
      [LSOF_BIN]: lsofOutput(HTTP_PORT)
    });
    const { http, calls: requests } = stub({ [antigravityUrl(HTTP_PORT)]: json(ANTIGRAVITY_QUOTA) });
    expect((await createAntigravityProvider({ http, exec }).fetch(NOW)).status).toBe('ok');
    expect(requests[0]?.headers[ANTIGRAVITY_CSRF_HEADER]).toBe(TOKEN);
  });

  it('is endpoint-changed for a 200 with no groups, and reports the keys', async () => {
    const { exec } = execTable({ [LSOF_BIN]: lsofOutput(HTTP_PORT) });
    const { http } = stub({ [antigravityUrl(HTTP_PORT)]: json({ response: { description: 'hi' } }) });
    const unexpected: string[][] = [];
    const result = await createAntigravityProvider({
      http,
      exec,
      onUnexpectedShape: (k) => unexpected.push(k)
    }).fetch(NOW);
    expect(result.status).toBe('endpoint-changed');
    expect(result.message).toBe(ANTIGRAVITY_UNREADABLE_MESSAGE);
    expect(result.buckets).toEqual([]);
    expect(unexpected).toEqual([['response']]);
  });

  it('reports the keys of a healthy answer too', async () => {
    const { exec } = execTable({ [LSOF_BIN]: lsofOutput(HTTP_PORT) });
    const { http } = stub({ [antigravityUrl(HTTP_PORT)]: json(ANTIGRAVITY_QUOTA) });
    const keys: string[][] = [];
    await createAntigravityProvider({ http, exec, onUsageKeys: (k) => keys.push(k) }).fetch(NOW);
    // The key dump stays on the happy path: it is how the next shape change
    // gets noticed, and keys-only-on-failure reports them too late.
    expect(keys).toEqual([['response']]);
  });

  it('survives a request that throws and a body that is not JSON', async () => {
    const { exec } = execTable();
    const { http } = stub({
      [antigravityUrl(HTTPS_PORT)]: () => {
        throw new Error('socket hang up');
      },
      [antigravityUrl(HTTP_PORT)]: {
        ok: true,
        status: 200,
        contentType: 'text/plain',
        body: 'not json at all'
      }
    });
    const result = await createAntigravityProvider({ http, exec }).fetch(NOW);
    expect(result.status).toBe('error');
    expect(result.message).toBe(ANTIGRAVITY_NO_ANSWER_MESSAGE);
  });

  it('never puts the CSRF token in its result', async () => {
    const { exec } = execTable({
      [PS_BIN]: `/path/to/${ANTIGRAVITY_PROCESS} --csrf_token SUPER-SECRET`,
      [LSOF_BIN]: lsofOutput(HTTP_PORT)
    });
    const { http } = stub({ [antigravityUrl(HTTP_PORT)]: json(ANTIGRAVITY_QUOTA) });
    const provider = createAntigravityProvider({ http, exec });
    for (const result of [await provider.fetch(NOW), await provider.fetch(NOW)]) {
      expect(JSON.stringify(result)).not.toContain('SUPER-SECRET');
    }
    // And it is in nothing the provider hands a caller to log, either.
    const said: string[] = [];
    const talkative = createAntigravityProvider({
      http,
      exec,
      onUsageKeys: (k) => said.push(...k),
      onUsageShape: (l) => said.push(...l),
      onUnexpectedShape: (k) => said.push(...k)
    });
    await talkative.fetch(NOW);
    expect(said.join('\n')).not.toContain('SUPER-SECRET');
  });
});

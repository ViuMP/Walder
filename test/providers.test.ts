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
  EXPIRED_MESSAGE
} from '../src/providers/claude-oauth';
import {
  createClaudeWebProvider,
  CLAUDE_ORGS_URL,
  chooseOrg,
  parseOrgs,
  usageUrlFor
} from '../src/providers/claude-web';
import {
  createChatGptWebProvider,
  CHATGPT_CANDIDATE_BUDGET_MS,
  CHATGPT_CANDIDATE_PATHS,
  CHATGPT_MAX_CANDIDATES,
  CHATGPT_SESSION_URL,
  candidatePaths,
  parseSession
} from '../src/providers/chatgpt-web';
import {
  createChatGptCodexProvider,
  CODEX_USAGE_URL,
  CODEX_USER_AGENT
} from '../src/providers/chatgpt-codex';
import { NEEDS_APP_SESSION, type HttpFetch, type HttpResponse } from '../src/providers/types';

const NOW = new Date('2026-09-08T15:00:00Z');

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const CLAUDE_USAGE = fixture('claude-oauth-usage.json');
const CODEX_USAGE = fixture('codex-wham-usage.json');

/* ------------------------------------------------------------------- stubs */

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
  /** `undefined` when the caller left the adapter's default in place. */
  readonly timeoutMs: number | undefined;
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
    calls.push({ url, headers: { ...(init?.headers ?? {}) }, timeoutMs: init?.timeoutMs });
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
    expect(result.buckets.map((b) => b.label)).toEqual([
      '5-hour',
      '7-day (all models)',
      '7-day Opus'
    ]);
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
      readCredentials: async () => ({ expired: true })
    });
    const result = await provider.fetch(NOW);
    expect(result.status).toBe('auth-needed');
    expect(result.message).toBe(EXPIRED_MESSAGE);
    // And it does not even try the endpoint — there is nothing to send.
    expect(calls).toHaveLength(0);
  });

  it('is still "available" with an expired token', async () => {
    // So the registry can report it rather than skipping past it silently.
    const provider = createClaudeOauthProvider({
      http: stub({}).http,
      readCredentials: async () => ({ expired: true })
    });
    expect(await provider.isAvailable()).toBe(true);
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
    const result = await createClaudeWebProvider({ session: () => session }).fetch(NOW);

    expect(result.status).toBe('ok');
    expect(result.via).toBe('claude-web');
    expect(result.buckets).toHaveLength(3);
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
    expect(result.buckets.map((b) => b.label)).toEqual(['Codex 5-hour', 'Codex weekly']);
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
      const answer = await createChatGptWebProvider({ session: () => session }).isAuthenticated?.();
      expect(answer).toBe(true);
      expect(JSON.stringify(answer)).not.toContain('web-token');
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
    expect(result.buckets.map((b) => b.label)).toEqual(['Codex 5-hour', 'Codex weekly']);
    expect(result.buckets.map((b) => b.pct)).toEqual([37, 12]);
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

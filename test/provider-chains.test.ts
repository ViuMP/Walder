/**
 * The Electron half of the provider layer: which fetch stack each chain gets,
 * and what that stack is allowed to carry.
 *
 * Two of the three 2026-09-08 login bugs are decided in this one file, and both
 * of them are invisible in the providers themselves — a provider only sees an
 * injected `HttpFetch` and cannot tell what it was built from. So they are
 * pinned here:
 *
 *  1. **Cookies.** The web providers' adapter must be built with
 *     `credentials: 'include'`, and the bearer providers' with `'omit'`. Without
 *     `'include'` the WHATWG default of `same-origin` applies, a main-process
 *     request has no origin for that to match, and Chromium attaches no cookies
 *     at all — which is why the owner could log in to ChatGPT inside Walder's
 *     own window and be told he was not logged in.
 *  2. **User agent.** Both login partitions must present the Chrome UA, not the
 *     Electron one, because Google refuses OAuth sign-in from a UA naming an
 *     embedded browser and the anti-bot layers in front of both login pages
 *     score an unknown one as suspicious. It is set on the *session*, which is
 *     what makes it cover the window, its widget frames and the provider polls
 *     at once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Request {
  readonly stack: 'net' | string;
  readonly url: string;
  readonly credentials: string;
}

const host = vi.hoisted(() => ({
  requests: [] as Request[],
  /** `[partition, userAgent]` for every `setUserAgent`, in order. */
  userAgents: [] as [string, string][],
  /** Every `session.fromPartition` argument, in order. */
  partitions: [] as string[],
  /** A per-test answer by URL; `undefined` falls back to the 401 below. */
  answer: undefined as ((url: string) => { status: number; body: string } | undefined) | undefined
}));

/** A `fetch` that records the credentials mode and answers 401, unless `host.answer` says otherwise. */
function recorder(stack: string) {
  return (url: string, init: { credentials: string }) => {
    host.requests.push({ stack, url, credentials: init.credentials });
    const { status, body } = host.answer?.(url) ?? { status: 401, body: '{}' };
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => body
    });
  };
}

/** Electron's real default UA on this Mac, carrying both app tokens. */
const ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) walder/0.1.1 Chrome/142.0.0.0 Electron/44.2.0 Safari/537.36';

vi.mock('electron', () => ({
  app: { userAgentFallback: ELECTRON_UA },
  net: { fetch: recorder('net') },
  session: {
    fromPartition: (partition: string) => {
      host.partitions.push(partition);
      return {
        getUserAgent: () => ELECTRON_UA,
        setUserAgent: (ua: string) => host.userAgents.push([partition, ua]),
        setPermissionRequestHandler: () => undefined,
        setPermissionCheckHandler: () => undefined,
        clearStorageData: async () => undefined,
        cookies: { get: async () => [] },
        fetch: recorder(partition)
      };
    }
  }
}));

const { createChains, partitionSession, sessionFor } = await import(
  '../src/main/provider-chains'
);
const { LOGIN } = await import('../src/main/services-main');
/**
 * The partitions, as they were before `LOGIN` folded them into one table. Only
 * the two web services have one — Cursor's row is `null` (no browser login).
 */
const PARTITIONS = {
  // `?? ''` rather than an assertion: a row that went `null` by mistake would
  // then fail the "at least one request on this partition" check below with
  // the partition name in the message, instead of throwing here.
  claude: LOGIN.claude?.partition ?? '',
  chatgpt: LOGIN.chatgpt?.partition ?? ''
};

/** The settings slice `createChains` reads. */
function fakeStore() {
  const data: Record<string, unknown> = {};
  return {
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => {
      data[key] = value;
    },
    path: '/tmp/walder-test/walder.json'
  } as never;
}

beforeEach(() => {
  host.requests.length = 0;
  host.partitions.length = 0;
  host.answer = undefined;
});

describe('sessionFor', () => {
  it('strips the Electron and Walder tokens from the partition user agent', () => {
    sessionFor('claude');
    sessionFor('chatgpt');
    for (const partition of [PARTITIONS.claude, PARTITIONS.chatgpt]) {
      const set = host.userAgents.find(([p]) => p === partition);
      expect(set, `no user agent set on ${partition}`).toBeDefined();
      expect(set?.[1]).not.toMatch(/electron\//i);
      expect(set?.[1]).not.toMatch(/walder\//i);
      // Not spoofing: the real Chrome and platform tokens are left alone.
      expect(set?.[1]).toMatch(/Chrome\/\d/);
      expect(set?.[1]).toContain('Macintosh');
    }
  });

  it('also cleans the process-wide fallback, which workers inherit', async () => {
    // Found in the 2026-09-08 dev run, not by a test: hCaptcha's
    // proof-of-work script runs in a *worker*, and every request it made
    // carried the untouched Electron default while the page around it said
    // Chrome. A captcha vendor is the last place to send a contradictory
    // answer about what kind of browser this is.
    sessionFor('claude');
    const { app } = await import('electron');
    expect(app.userAgentFallback).not.toMatch(/electron\//i);
    expect(app.userAgentFallback).not.toMatch(/walder\//i);
    expect(app.userAgentFallback).toMatch(/Chrome\/\d/);
  });

  it('sets the user agent once per partition, not once per poll', () => {
    // This runs on every poll; a `setUserAgent` per call would be pointless
    // churn on a session Chromium is already using.
    const before = host.userAgents.length;
    sessionFor('claude');
    sessionFor('chatgpt');
    sessionFor('claude');
    expect(host.userAgents).toHaveLength(before);
  });

  it('keeps the two services in separate persist: partitions', () => {
    expect(PARTITIONS.claude).toBe('persist:claude');
    expect(PARTITIONS.chatgpt).toBe('persist:chatgpt');
    expect(PARTITIONS.claude).not.toBe(PARTITIONS.chatgpt);
  });
});

describe('partitionSession', () => {
  it('asks for the partition\'s cookies explicitly', async () => {
    // The bug: without `include`, `session.fetch` from the main process sends
    // no cookies, and the two web providers have no other way to authenticate.
    const wrapped = partitionSession(sessionFor('claude'));
    await wrapped.http('https://claude.ai/api/organizations');
    expect(host.requests.at(-1)).toMatchObject({
      stack: PARTITIONS.claude,
      credentials: 'include'
    });
  });

  it('never lets a cookie value out of the session', async () => {
    const wrapped = partitionSession(sessionFor('chatgpt'));
    expect(await wrapped.cookies({ url: 'https://chatgpt.com' })).toEqual([]);
  });
});

describe('createChains', () => {
  it('gives each provider the fetch stack it should have', async () => {
    const chains = createChains({ store: fakeStore() });
    for (const provider of [...chains.claude, ...chains.chatgpt]) {
      await provider.fetch(new Date());
    }

    const byStack = new Map<string, string[]>();
    for (const request of host.requests) {
      byStack.set(request.stack, [...(byStack.get(request.stack) ?? []), request.credentials]);
    }
    // Bearer providers: Chromium's stack, no cookie jar. Attaching the owner's
    // browsing cookies to a request that authenticates with a header would be
    // pointless and a way to leak a session into a call that did not need one.
    //
    // `?? []` because these two read a real credential file before they make a
    // request, so whether they make one at all depends on the machine the suite
    // runs on. The assertion is "never `include`", which is the part that
    // matters and is true either way.
    expect((byStack.get('net') ?? []).every((mode) => mode === 'omit')).toBe(true);
    // Web providers: their partition's stack, cookies included.
    for (const partition of [PARTITIONS.claude, PARTITIONS.chatgpt]) {
      const modes = byStack.get(partition) ?? [];
      expect(modes.length, `no request on ${partition}`).toBeGreaterThan(0);
      expect(modes.every((mode) => mode === 'include')).toBe(true);
    }
  });

  it('forwards onClaudeExpiresAt to the claude-oauth provider', async () => {
    // The wire between `claude-oauth` and `main/claude-renew.ts`. There is no
    // seam for injecting a fake credential reader here — `createChains` builds
    // the provider itself — so this drives the real provider and asserts on
    // what is true whatever this machine's keychain holds: the callback fires
    // once per credential read — one on the ordinary path, two when a 401 buys
    // the re-read (P1-13) — with a number or `null` and nothing else.
    const seen: Array<number | null> = [];
    const chains = createChains({
      store: fakeStore(),
      onClaudeExpiresAt: (expiresAt) => seen.push(expiresAt)
    });
    const oauth = chains.claude.find((provider) => provider.id === 'claude-oauth');
    expect(oauth).toBeDefined();
    await oauth?.fetch(new Date());

    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.length).toBeLessThanOrEqual(2);
    for (const value of seen) expect(value === null || typeof value === 'number').toBe(true);
  });

  it('leaves the chain silent when no renewal callback is given', async () => {
    // The dep is optional, and a build without it must not start reaching for
    // one: renewal off is the pre-2026-09-19 behaviour, unchanged.
    const chains = createChains({ store: fakeStore() });
    const oauth = chains.claude.find((provider) => provider.id === 'claude-oauth');
    await expect(oauth?.fetch(new Date())).resolves.toBeDefined();
  });

  it('orders each chain best-source-first', () => {
    // Claude: the browser session first (2026-09-10). `resolveService` takes
    // the first `ok` provider and never calls the rest, and only the claude.ai
    // route carries the per-model `limits[]` array and the `extra_usage`
    // figure — with the CLI token first, the richer route was reached only
    // when that token had expired. ChatGPT: the browser session first too,
    // because the Codex endpoint reports the *Codex* allowance, not the chat one.
    const chains = createChains({ store: fakeStore() });
    expect(chains.claude.map((p) => p.id)).toEqual(['claude-web', 'claude-oauth']);
    expect(chains.chatgpt.map((p) => p.id)).toEqual(['chatgpt-web', 'chatgpt-codex']);
  });

  it('gives both web providers a lastCheck, and the token providers none', () => {
    // `webProviderFor` identifies a web login by these two methods rather than
    // by an id string, so their presence is part of the contract.
    const chains = createChains({ store: fakeStore() });
    for (const id of ['claude-web', 'chatgpt-web']) {
      const provider = [...chains.claude, ...chains.chatgpt].find((p) => p.id === id);
      expect(provider?.isAuthenticated, id).toBeDefined();
      expect(provider?.lastCheck?.(), id).toBeNull();
    }
    for (const id of ['claude-oauth', 'chatgpt-codex']) {
      const provider = [...chains.claude, ...chains.chatgpt].find((p) => p.id === id);
      expect(provider?.isAuthenticated, id).toBeUndefined();
      expect(provider?.lastCheck, id).toBeUndefined();
    }
  });

  it('promotes the chatgpt path that answered to the front of the stored list (2026-11-14)', async () => {
    // The wire from onEndpointFound to the store: the next poll, and the one
    // after a restart, walks the remembered working path first. Swapping the
    // mergeDiscovered arguments would leave /c/usage third. The middle entry
    // is a built-in so /c/usage is still inside candidatePaths' two
    // discovered slots.
    const store = fakeStore() as {
      get: (key: string) => unknown;
      set: (key: string, value: unknown) => void;
    };
    store.set('chatgptDiscoveredEndpoints', ['/a/usage', '/backend-api/wham/usage', '/c/usage']);
    host.answer = (url) => {
      if (url.endsWith('/api/auth/session')) return { status: 200, body: '{"accessToken":"t"}' };
      if (url.endsWith('/c/usage')) {
        return { status: 200, body: '{"rate_limit":{"primary_window":{"used_percent":10}}}' };
      }
      return undefined;
    };
    const chains = createChains({ store: store as never });
    const web = chains.chatgpt.find((p) => p.id === 'chatgpt-web');
    const result = await web?.fetch(new Date());
    expect(result?.status).toBe('ok');
    expect(store.get('chatgptDiscoveredEndpoints')).toEqual([
      '/c/usage',
      '/a/usage',
      '/backend-api/wham/usage'
    ]);
  });
});

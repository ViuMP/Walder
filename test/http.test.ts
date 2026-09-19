/**
 * The HTTP adapter's bounds, against a mock `fetch`.
 *
 * Every provider request carries a credential — the partition's cookies, or an
 * `Authorization: Bearer` header — so what this layer refuses to do matters
 * more than what it does:
 *
 *  - it never follows a redirect to another origin, because that would hand the
 *    credential to whoever the `Location` names;
 *  - it follows a same-origin redirect at most once, so a redirect loop cannot
 *    become a request loop;
 *  - it never buffers more than 1 MB, so an endpoint that has been replaced by
 *    something enormous cannot eat the main process;
 *  - it aborts on the timeout, so a hung endpoint cannot stall a poll;
 *
 * and in the two cases where it gives up on a response, the result is shaped so
 * that `classifyHttp` calls it `endpoint-changed` — which is the truth (the
 * endpoint has moved, or is not what we think it is) and is what stops the
 * panel showing a confident 0 %.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  MAX_BODY_BYTES,
  fromFetch,
  parseRetryAfter,
  sameOriginRedirect,
  type FetchLike
} from '../src/providers/http';
import { classifyHttp } from '../src/providers/types';

const URL_ = 'https://chatgpt.com/backend-api/wham/usage';

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly redirect: string;
  readonly credentials: string;
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal;
}

interface FakeResponse {
  status?: number;
  ok?: boolean;
  headers?: Record<string, string>;
  body?: string;
  /** Byte chunks, to exercise the streaming path. */
  chunks?: Uint8Array[];
}

/** A mock `fetch` that answers per call and records what it was asked. */
function mock(answers: (FakeResponse | 'hang')[]): {
  fetchImpl: FetchLike;
  calls: Recorded[];
  textReads: number;
} {
  const calls: Recorded[] = [];
  const state = { textReads: 0 };
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init.method,
      redirect: init.redirect,
      credentials: init.credentials,
      headers: init.headers,
      signal: init.signal
    });
    const answer = answers[calls.length - 1] ?? answers.at(-1) ?? {};
    if (answer === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('the request was aborted')));
      });
    }
    const status = answer.status ?? 200;
    const headers = new Map(
      Object.entries(answer.headers ?? { 'content-type': 'application/json' }).map(([k, v]) => [
        k.toLowerCase(),
        v
      ])
    );
    const chunks = answer.chunks;
    return Promise.resolve({
      ok: answer.ok ?? (status >= 200 && status < 300),
      status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => {
        state.textReads++;
        return answer.body ?? '';
      },
      ...(chunks === undefined
        ? {}
        : {
            body: {
              getReader: () => {
                let index = 0;
                return {
                  read: async () =>
                    index < chunks.length
                      ? { done: false, value: chunks[index++] }
                      : { done: true, value: undefined },
                  cancel: () => undefined
                };
              }
            }
          })
    });
  };
  return {
    fetchImpl,
    calls,
    get textReads() {
      return state.textReads;
    }
  } as { fetchImpl: FetchLike; calls: Recorded[]; textReads: number };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('fromFetch: the request itself', () => {
  it('is always a GET, with manual redirects and the given headers', async () => {
    const { fetchImpl, calls } = mock([{ body: '{}' }]);
    await fromFetch(fetchImpl)(URL_, { headers: { Accept: 'application/json' } });

    expect(calls[0]?.method).toBe('GET');
    // `follow` would let a repointed endpoint decide where a bearer token goes.
    expect(calls[0]?.redirect).toBe('manual');
    expect(calls[0]?.headers).toEqual({ Accept: 'application/json' });
  });

  it('returns the status, content type and body as text', async () => {
    const { fetchImpl } = mock([
      { status: 200, headers: { 'content-type': 'application/json' }, body: '{"a":1}' }
    ]);
    const response = await fromFetch(fetchImpl)(URL_);
    expect(response).toEqual({
      ok: true,
      status: 200,
      contentType: 'application/json',
      body: '{"a":1}'
    });
  });

  it('does not throw for an HTTP status: a 401 is a result', async () => {
    const { fetchImpl } = mock([{ status: 401, ok: false, body: '{}' }]);
    const response = await fromFetch(fetchImpl)(URL_);
    expect(response.status).toBe(401);
    expect(classifyHttp(response)).toBe('auth-needed');
  });

  /*
   * The 2026-09-08 bug, and the reason this parameter exists at all.
   *
   * `session.fetch` follows the WHATWG default of `credentials: 'same-origin'`,
   * and a request issued by the *main process* has no origin for that to be the
   * same as — so Chromium sent no cookies, `chatgpt-web.isAuthenticated()` saw
   * the logged-out `{}` while the owner sat in front of a logged-in login
   * window, and Walder never registered the login. It is set once per adapter,
   * not per call, so that no provider can forget it.
   */
  describe('credentials', () => {
    it('sends the partition\'s cookies only when the adapter says to', async () => {
      const cookieJar = mock([{ body: '{}' }]);
      await fromFetch(cookieJar.fetchImpl, 'include')(URL_);
      expect(cookieJar.calls[0]?.credentials).toBe('include');

      const bearer = mock([{ body: '{}' }]);
      await fromFetch(bearer.fetchImpl, 'omit')(URL_);
      expect(bearer.calls[0]?.credentials).toBe('omit');
    });

    it('omits them by default, so a caller has to ask', async () => {
      const { fetchImpl, calls } = mock([{ body: '{}' }]);
      await fromFetch(fetchImpl)(URL_);
      expect(calls[0]?.credentials).toBe('omit');
    });

    it('keeps the mode across a same-origin redirect hop', async () => {
      // The hop re-issues the request; a cookie-bearing call that lost its
      // cookies on the second leg would fail in the least obvious way possible.
      const { fetchImpl, calls } = mock([
        { status: 302, headers: { location: '/backend-api/wham/usage/' } },
        { body: '{}' }
      ]);
      await fromFetch(fetchImpl, 'include')(URL_);
      expect(calls).toHaveLength(2);
      expect(calls.map((c) => c.credentials)).toEqual(['include', 'include']);
    });
  });
});

describe('fromFetch: the timeout', () => {
  it('aborts a hung request when the timeout expires', async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = mock(['hang']);
    const pending = fromFetch(fetchImpl)(URL_, { timeoutMs: 5_000 });
    const assertion = expect(pending).rejects.toThrow(/aborted/);

    expect(calls[0]?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls[0]?.signal.aborted).toBe(true);
    await assertion;
  });

  it('does not abort a request that finished in time', async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = mock([{ body: '{}' }]);
    await fromFetch(fetchImpl)(URL_, { timeoutMs: 5_000 });
    // The timer is cleared, so nothing aborts the (already-read) response.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls[0]?.signal.aborted).toBe(false);
  });
});

describe('sameOriginRedirect', () => {
  it('resolves a relative location against the request URL', () => {
    expect(sameOriginRedirect(URL_, '/backend-api/v2/usage')).toBe(
      'https://chatgpt.com/backend-api/v2/usage'
    );
    expect(sameOriginRedirect(URL_, 'https://chatgpt.com/x')).toBe('https://chatgpt.com/x');
  });

  it('refuses another origin, a scheme downgrade and a missing location', () => {
    expect(sameOriginRedirect(URL_, 'https://evil.example/usage')).toBeNull();
    expect(sameOriginRedirect(URL_, 'https://api.chatgpt.com/usage')).toBeNull();
    expect(sameOriginRedirect(URL_, 'http://chatgpt.com/usage')).toBeNull();
    expect(sameOriginRedirect(URL_, null)).toBeNull();
    expect(sameOriginRedirect(URL_, '   ')).toBeNull();
  });
});

describe('fromFetch: redirects', () => {
  it('never re-issues the request to another origin', async () => {
    const { fetchImpl, calls } = mock([
      { status: 302, ok: false, headers: { location: 'https://evil.example/usage' } }
    ]);
    const response = await fromFetch(fetchImpl)(URL_, {
      headers: { Authorization: 'Bearer secret-token' }
    });

    expect(response.redirected).toBe(true);
    expect(response.ok).toBe(false);
    expect(response.status).toBe(302);
    expect(response.body).toBe('');
    // The whole point: exactly one request, and the token went nowhere else.
    expect(calls).toHaveLength(1);
    expect(classifyHttp(response)).toBe('endpoint-changed');
  });

  it('follows a same-origin location exactly once', async () => {
    const { fetchImpl, calls } = mock([
      { status: 307, ok: false, headers: { location: '/backend-api/v2/usage' } },
      { status: 200, body: '{"ok":true}' }
    ]);
    const response = await fromFetch(fetchImpl)(URL_, { headers: { Accept: 'application/json' } });

    expect(calls.map((c) => c.url)).toEqual([URL_, 'https://chatgpt.com/backend-api/v2/usage']);
    expect(response.status).toBe(200);
    expect(response.body).toBe('{"ok":true}');
    expect(response.redirected).toBeUndefined();
    expect(classifyHttp(response)).toBeNull();
  });

  it('stops at one hop, however many the endpoint offers', async () => {
    const { fetchImpl, calls } = mock([
      { status: 302, ok: false, headers: { location: '/a' } },
      { status: 302, ok: false, headers: { location: '/b' } },
      { status: 200, body: 'never reached' }
    ]);
    const response = await fromFetch(fetchImpl)(URL_);

    expect(calls).toHaveLength(2);
    expect(response.redirected).toBe(true);
    expect(classifyHttp(response)).toBe('endpoint-changed');
  });

  it('reports a 3xx with no location at all rather than following it', async () => {
    const { fetchImpl, calls } = mock([{ status: 303, ok: false, headers: {} }]);
    const response = await fromFetch(fetchImpl)(URL_);
    expect(calls).toHaveLength(1);
    expect(response.redirected).toBe(true);
  });
});

describe('fromFetch: the body cap', () => {
  it('refuses a body the endpoint declares as oversized, without reading it', async () => {
    const host = mock([
      {
        headers: { 'content-type': 'application/json', 'content-length': String(MAX_BODY_BYTES + 1) },
        body: 'x'.repeat(10)
      }
    ]);
    const response = await fromFetch(host.fetchImpl)(URL_);

    expect(response.truncated).toBe(true);
    expect(response.body).toBe('');
    expect(host.textReads).toBe(0);
    expect(classifyHttp(response)).toBe('endpoint-changed');
  });

  it('accepts a declared length inside the cap', async () => {
    const { fetchImpl } = mock([
      { headers: { 'content-type': 'application/json', 'content-length': '7' }, body: '{"a":1}' }
    ]);
    const response = await fromFetch(fetchImpl)(URL_);
    expect(response.truncated).toBeUndefined();
    expect(response.body).toBe('{"a":1}');
  });

  it('stops reading the stream once the cap is passed', async () => {
    // 12 chunks of 100 KB: the cap is hit part-way, and the rest is abandoned
    // rather than buffered.
    const chunk = new Uint8Array(100_000).fill(0x61);
    const { fetchImpl } = mock([{ headers: { 'content-type': 'application/json' }, chunks: Array.from({ length: 12 }, () => chunk) }]);
    const response = await fromFetch(fetchImpl)(URL_);

    expect(response.truncated).toBe(true);
    expect(response.body.length).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(classifyHttp(response)).toBe('endpoint-changed');
  });

  it('reads a streamed body whole when it fits', async () => {
    const encoder = new TextEncoder();
    const { fetchImpl } = mock([
      { chunks: [encoder.encode('{"a":'), encoder.encode('1}')] }
    ]);
    const response = await fromFetch(fetchImpl)(URL_);
    expect(response.body).toBe('{"a":1}');
    expect(response.truncated).toBeUndefined();
  });

  it('truncates an undeclared oversized body read through text()', async () => {
    // The stub path: no `content-length`, no stream. Measured after the fact.
    const { fetchImpl } = mock([
      { headers: { 'content-type': 'application/json' }, body: 'x'.repeat(MAX_BODY_BYTES + 10) }
    ]);
    const response = await fromFetch(fetchImpl)(URL_);
    expect(response.truncated).toBe(true);
    expect(response.body).toHaveLength(MAX_BODY_BYTES);
    expect(classifyHttp(response)).toBe('endpoint-changed');
  });
});

/**
 * `Retry-After` is parsed here, once, so no provider has to know the header
 * comes in two forms — and so `Retry-After: 0`, which is what Anthropic answers
 * on a 429, arrives at the scheduler as the number 0 rather than as "absent".
 * What the scheduler does with it (floor only, never a shortcut) is
 * `poll-schedule`'s business.
 */
describe('parseRetryAfter', () => {
  const NOW = Date.parse('2026-09-08T15:00:00Z');

  it('reads a delay in seconds, including a literal zero', () => {
    expect(parseRetryAfter('30', NOW)).toBe(30_000);
    expect(parseRetryAfter('  30  ', NOW)).toBe(30_000);
    // Not "absent": the server really did say "immediately", and the scheduler
    // has to see that to refuse to obey it.
    expect(parseRetryAfter('0', NOW)).toBe(0);
  });

  it('reads an HTTP-date as the wait from the clock it was given', () => {
    expect(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90_000);
  });

  it('never returns a negative wait for a date already past', () => {
    expect(parseRetryAfter(new Date(NOW - 600_000).toUTCString(), NOW)).toBe(0);
  });

  it('ignores anything it cannot read', () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter('soon', NOW)).toBeUndefined();
    expect(parseRetryAfter('', NOW)).toBeUndefined();
  });

  it('does not let Date.parse read a malformed number as a date', () => {
    // `Date.parse` reads `"-5"` and `"1.5"` as days in 2001 and `"30"` as a
    // year; an HTTP-date always carries a month or weekday name, so a value
    // with no letter in it is either seconds or nothing.
    expect(parseRetryAfter('-5', NOW)).toBeUndefined();
    expect(parseRetryAfter('1.5', NOW)).toBeUndefined();
    expect(parseRetryAfter('30', NOW)).toBe(30_000);
  });
});

describe('fromFetch: Retry-After', () => {
  const NOW = Date.parse('2026-09-08T15:00:00Z');

  function rateLimited(retryAfter?: string) {
    return mock([
      {
        status: 429,
        ok: false,
        headers: {
          'content-type': 'application/json',
          ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter })
        },
        body: '{}'
      }
    ]);
  }

  it('carries a seconds header through as milliseconds', async () => {
    const response = await fromFetch(rateLimited('30').fetchImpl)(URL_);
    expect(response.retryAfterMs).toBe(30_000);
    expect(classifyHttp(response)).toBe('rate-limited');
  });

  it('carries a zero through rather than dropping it', async () => {
    const response = await fromFetch(rateLimited('0').fetchImpl)(URL_);
    expect(response.retryAfterMs).toBe(0);
  });

  it('measures an HTTP-date against the wall clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const header = new Date(NOW + 90_000).toUTCString();
    const response = await fromFetch(rateLimited(header).fetchImpl)(URL_);
    expect(response.retryAfterMs).toBe(90_000);

    const past = new Date(NOW - 90_000).toUTCString();
    expect((await fromFetch(rateLimited(past).fetchImpl)(URL_)).retryAfterMs).toBe(0);
  });

  it('leaves the field off entirely when the header is absent or junk', async () => {
    expect(await fromFetch(rateLimited().fetchImpl)(URL_)).not.toHaveProperty('retryAfterMs');
    expect(await fromFetch(rateLimited('soon').fetchImpl)(URL_)).not.toHaveProperty(
      'retryAfterMs'
    );
  });
});

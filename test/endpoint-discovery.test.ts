/**
 * Endpoint discovery: learning which URL carries the chat limits by watching the
 * real site ask for it.
 *
 * Two things need proving. First that it *works* — quota-ish paths are kept,
 * deduped and capped. Second, and more importantly, that it cannot become a
 * leak: only the watched origin's paths are stored, and the store is a plain
 * JSON settings file that `chatgpt-web` later turns back into a *token-bearing*
 * request, so a foreign origin getting in there would send a bearer token
 * somewhere it does not belong.
 */
import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_RE,
  MAX_DISCOVERED,
  attachDiscovery,
  isCandidatePath,
  mergeDiscovered,
  pathOnly,
  sanitizePaths
} from '../src/providers/endpoint-discovery';

const ORIGIN = 'https://chatgpt.com';

describe('pathOnly', () => {
  it('keeps the path, and nothing else', () => {
    expect(pathOnly(`${ORIGIN}/backend-api/wham/usage?x=1`, ORIGIN)).toBe(
      '/backend-api/wham/usage'
    );
    // No origin, no query, no fragment: nothing that could be a header, a body
    // or a credential.
    expect(pathOnly(`${ORIGIN}/a/b#frag`, ORIGIN)).toBe('/a/b');
  });

  it('never keeps a token-shaped query string', () => {
    // The reason the query was dropped: this list goes to a plain JSON settings
    // file and is replayed on every poll, and a site's own XHR happily carries
    // one-time codes in its query.
    const url = `${ORIGIN}/backend-api/usage?token=eyJhbGciOiJIUzI1NiJ9.abc.def&id=42`;
    const path = pathOnly(url, ORIGIN);
    expect(path).toBe('/backend-api/usage');
    expect(path).not.toContain('eyJ');
    expect(path).not.toContain('token');
    expect(path).not.toContain('?');
  });

  it('rejects any other origin', () => {
    // This is the guard that matters: `chatgpt-web` prepends the origin itself,
    // so a stored foreign host could otherwise receive a bearer token.
    expect(pathOnly('https://evil.example/usage', ORIGIN)).toBeNull();
    expect(pathOnly('https://api.chatgpt.com/usage', ORIGIN)).toBeNull();
    expect(pathOnly('http://chatgpt.com/usage', ORIGIN)).toBeNull();
  });

  it('rejects a protocol-relative URL, which has no origin at all', () => {
    expect(pathOnly('//evil.example/usage', ORIGIN)).toBeNull();
  });

  it('rejects a doubled leading slash, which the origin check does not catch', () => {
    // The origin here is the expected one — it is the *pathname* that carries
    // the foreign host, and `${ORIGIN}${path}` would rebuild a URL pointing at
    // it. `sanitizePaths` drops this on read; the point of the check here is
    // that it never gets written.
    expect(pathOnly(`${ORIGIN}//evil.example/usage`, ORIGIN)).toBeNull();
    expect(pathOnly(`${ORIGIN}/\\evil.example/usage`, ORIGIN)).toBeNull();
  });

  it('rejects a malformed URL rather than throwing', () => {
    expect(pathOnly('not a url', ORIGIN)).toBeNull();
  });
});

describe('sanitizePaths', () => {
  it('strips a query string off a stored entry', () => {
    // Settings files written before the 2026-09-08 gate hold path *and* query.
    expect(sanitizePaths(['/backend-api/usage?token=eyJabc.def'])).toEqual([
      '/backend-api/usage'
    ]);
    expect(sanitizePaths(['/usage#frag'])).toEqual(['/usage']);
  });

  it('drops anything that is not a plain path', () => {
    expect(
      sanitizePaths([
        'https://evil.example/usage',
        '//evil.example/usage',
        'backend-api/usage',
        '',
        42,
        null,
        undefined
      ])
    ).toEqual([]);
  });

  it('collapses duplicates the stripping created', () => {
    expect(sanitizePaths(['/usage?a=1', '/usage?a=2', '/usage'])).toEqual(['/usage']);
  });
});

describe('isCandidatePath', () => {
  it('matches the quota-ish names, including ones we have not seen', () => {
    for (const path of [
      '/backend-api/wham/usage',
      '/backend-api/conversation_limit',
      '/backend-api/model_limits',
      '/backend-api/rate-limit',
      '/backend-api/rate_limits',
      '/api/limits'
    ]) {
      expect(isCandidatePath(path)).toBe(true);
    }
  });

  it('ignores the rest of the site', () => {
    for (const path of [
      '/backend-api/conversation',
      '/_next/static/chunks/main.js',
      '/api/auth/session',
      '/favicon.ico'
    ]) {
      expect(isCandidatePath(path)).toBe(false);
    }
  });

  it('matches on the path, not the query', () => {
    // Otherwise `?redirect=/usage` on an unrelated request would be recorded.
    expect(isCandidatePath('/backend-api/conversation?next=/usage')).toBe(false);
    expect(isCandidatePath('/backend-api/usage?next=/conversation')).toBe(true);
  });

  it('accepts a caller-supplied pattern', () => {
    expect(isCandidatePath('/quota', /quota/)).toBe(true);
    expect(isCandidatePath('/quota', DISCOVERY_RE)).toBe(false);
  });
});

describe('mergeDiscovered', () => {
  it('appends new paths, keeping existing order', () => {
    expect(mergeDiscovered(['/a'], ['/b'])).toEqual(['/a', '/b']);
  });

  it('dedupes', () => {
    expect(mergeDiscovered(['/a', '/b'], ['/a'])).toEqual(['/a', '/b']);
  });

  it('caps by dropping the oldest', () => {
    const existing = Array.from({ length: MAX_DISCOVERED }, (_, i) => `/p${i}`);
    const merged = mergeDiscovered(existing, ['/new']);
    expect(merged).toHaveLength(MAX_DISCOVERED);
    expect(merged.at(-1)).toBe('/new');
    expect(merged).not.toContain('/p0');
  });

  it('honours a custom cap and skips junk entries', () => {
    expect(mergeDiscovered(['/a', '/b', '/c'], [], 2)).toEqual(['/b', '/c']);
    expect(mergeDiscovered(['', '/a'], [null as unknown as string, '/b'])).toEqual(['/a', '/b']);
  });
});

describe('attachDiscovery', () => {
  /** A minimal stand-in for an Electron session's `webRequest.onCompleted`. */
  function fakeSession() {
    let listener: ((details: { url: string }) => void) | null = null;
    const filters: string[][] = [];
    return {
      filters,
      emit(url: string): void {
        listener?.({ url });
      },
      get attached(): boolean {
        return listener !== null;
      },
      session: {
        webRequest: {
          onCompleted(
            filter: { urls: string[] },
            next: ((details: { url: string }) => void) | null
          ): void {
            filters.push(filter.urls);
            listener = next;
          }
        }
      }
    };
  }

  function fakeStore(initial: string[] = []) {
    const data: Record<string, unknown> = { chatgptDiscoveredEndpoints: initial };
    return {
      writes: 0,
      store: {
        get: (key: string) => data[key],
        set(key: string, value: string[]) {
          data[key] = value;
          this.writes = (this.writes ?? 0) + 1;
        }
      } as { get(k: string): unknown; set(k: string, v: string[]): void; writes?: number },
      read: () => data['chatgptDiscoveredEndpoints']
    };
  }

  function attach(host: ReturnType<typeof fakeSession>, holder: ReturnType<typeof fakeStore>) {
    const found: string[] = [];
    const stop = attachDiscovery({
      session: host.session,
      store: holder.store,
      storeKey: 'chatgptDiscoveredEndpoints',
      origin: ORIGIN,
      onFound: (path) => found.push(path)
    });
    return { stop, found };
  }

  it('records a quota-ish path it sees, as the path alone', () => {
    const host = fakeSession();
    const holder = fakeStore();
    const { found } = attach(host, holder);

    host.emit(`${ORIGIN}/backend-api/wham/usage?a=1`);
    expect(holder.read()).toEqual(['/backend-api/wham/usage']);
    expect(found).toEqual(['/backend-api/wham/usage']);
  });

  it('stores nothing but the path when the query carries a token', () => {
    const host = fakeSession();
    const holder = fakeStore();
    attach(host, holder);

    host.emit(`${ORIGIN}/backend-api/usage?token=eyJhbGciOiJIUzI1NiJ9.payload.sig`);
    expect(holder.read()).toEqual(['/backend-api/usage']);
    expect(JSON.stringify(holder.read())).not.toContain('eyJ');
  });

  it('scrubs a stored entry that still carries a query, on the next write', () => {
    const host = fakeSession();
    const holder = fakeStore(['/backend-api/usage?token=eyJabc']);
    attach(host, holder);

    host.emit(`${ORIGIN}/backend-api/wham/usage`);
    expect(holder.read()).toEqual(['/backend-api/usage', '/backend-api/wham/usage']);
  });

  it('records nothing for a protocol-relative URL', () => {
    // `//evil.example/usage` parses as no origin at all, so it can never reach
    // the store and be concatenated onto chatgpt.com by the provider.
    const host = fakeSession();
    const holder = fakeStore();
    attach(host, holder);

    host.emit('//evil.example/usage');
    expect(holder.read()).toEqual([]);
  });

  it('watches only the given origin', () => {
    const host = fakeSession();
    expect(host.filters).toEqual([]);
    const holder = fakeStore();
    attach(host, holder);
    expect(host.filters).toEqual([[`${ORIGIN}/*`]]);

    host.emit('https://evil.example/usage');
    expect(holder.read()).toEqual([]);
  });

  it('ignores requests that are not quota-shaped', () => {
    const host = fakeSession();
    const holder = fakeStore();
    attach(host, holder);

    host.emit(`${ORIGIN}/api/auth/session`);
    host.emit(`${ORIGIN}/_next/static/main.js`);
    expect(holder.read()).toEqual([]);
  });

  it('does not rewrite the settings file for a path it already has', () => {
    // A chatty page would otherwise rewrite the file dozens of times per login.
    const host = fakeSession();
    const holder = fakeStore(['/backend-api/wham/usage']);
    const { found } = attach(host, holder);

    host.emit(`${ORIGIN}/backend-api/wham/usage`);
    expect(holder.store.writes ?? 0).toBe(0);
    expect(found).toEqual([]);
  });

  it('tolerates a hand-mangled stored value', () => {
    const host = fakeSession();
    const holder = fakeStore('not an array' as unknown as string[]);
    attach(host, holder);
    host.emit(`${ORIGIN}/backend-api/usage`);
    expect(holder.read()).toEqual(['/backend-api/usage']);
  });

  it('stops recording when the login window closes', () => {
    // A session that is later used for polling must not still be watched.
    const host = fakeSession();
    const holder = fakeStore();
    const { stop } = attach(host, holder);

    stop();
    expect(host.attached).toBe(false);
    host.emit(`${ORIGIN}/backend-api/usage`);
    expect(holder.read()).toEqual([]);
  });
});

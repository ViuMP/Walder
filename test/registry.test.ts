/**
 * The provider-chain ordering rule.
 *
 * This is the logic that decides *which* answer the owner sees when several
 * sources disagree, so every branch is pinned with fake providers rather than
 * real ones:
 *
 *  - the first `ok` wins, and nothing after it is even asked;
 *  - a provider that is not available is skipped silently — an absent login is
 *    not a failure and must not be reported as one;
 *  - with no `ok`, the **last available** provider's result is what shows;
 *  - with nothing available at all, `unavailable` — the state that makes the
 *    tray offer "Log in…";
 *  - a provider that throws becomes `error` and still counts as available,
 *    because a source that blows up is a real problem worth showing.
 */
import { describe, expect, it } from 'vitest';
import {
  isWebLoginAuthenticated,
  resolveAll,
  resolveService,
  webProviderFor,
  VIA_NONE
} from '../src/providers/registry';
import type { Bucket } from '../src/core/buckets';
import type {
  ProviderResult,
  ServiceName,
  SourceStatus,
  UsageProvider
} from '../src/providers/types';

const NOW = new Date('2026-09-08T15:00:00Z');

function bucket(id: string): Bucket {
  return {
    id,
    service: 'claude',
    key: 'five_hour',
    label: '5-hour',
    pct: 10,
    resetsAt: null,
    priority: 0
  };
}

interface Fake {
  readonly provider: UsageProvider;
  /** 'available' / 'fetch' in call order, so skipping can be asserted. */
  readonly calls: string[];
}

function fake(
  id: string,
  options: {
    available?: boolean | 'throws';
    status?: SourceStatus | 'throws';
    message?: string;
    buckets?: Bucket[];
  } = {}
): Fake {
  const calls: string[] = [];
  const provider: UsageProvider = {
    id,
    service: 'claude',
    label: `${id} label`,
    async isAvailable() {
      calls.push('available');
      if (options.available === 'throws') throw new Error(`${id} availability blew up`);
      return options.available ?? true;
    },
    async fetch() {
      calls.push('fetch');
      if (options.status === 'throws') throw new Error(`${id} fetch blew up`);
      const result: ProviderResult = {
        buckets: options.buckets ?? (options.status === 'ok' ? [bucket(id)] : []),
        status: options.status ?? 'ok',
        via: id,
        ...(options.message === undefined ? {} : { message: options.message })
      };
      return result;
    }
  };
  return { provider, calls };
}

describe('resolveService', () => {
  it('returns the first ok and never asks the rest', async () => {
    const first = fake('first', { status: 'ok' });
    const second = fake('second', { status: 'ok' });

    const result = await resolveService('claude', [first.provider, second.provider], NOW);
    expect(result.status).toBe('ok');
    expect(result.via).toBe('first');
    expect(second.calls).toEqual([]);
  });

  it('falls through an unavailable provider without reporting it', async () => {
    const absent = fake('absent', { available: false });
    const present = fake('present', { status: 'ok' });

    const result = await resolveService('claude', [absent.provider, present.provider], NOW);
    expect(result.via).toBe('present');
    // Not even asked for numbers: there is no login there to ask about.
    expect(absent.calls).toEqual(['available']);
  });

  it('falls through a failing provider to one that works', async () => {
    // The real Claude case today: the CLI token is expired, so claude.ai answers.
    const expired = fake('claude-oauth', { status: 'auth-needed', message: 'expired' });
    const web = fake('claude-web', { status: 'ok' });

    const result = await resolveService('claude', [expired.provider, web.provider], NOW);
    expect(result.status).toBe('ok');
    expect(result.via).toBe('claude-web');
  });

  it('reports the LAST available provider when nothing is ok', async () => {
    // Last, not first: the chain is ordered best-to-worst, so the deepest source
    // that could actually be reached is the most informative thing to show.
    const first = fake('first', { status: 'auth-needed' });
    const second = fake('second', { status: 'endpoint-changed', message: 'shape moved' });

    const result = await resolveService('claude', [first.provider, second.provider], NOW);
    expect(result.status).toBe('endpoint-changed');
    expect(result.via).toBe('second');
    expect(result.message).toBe('shape moved');
  });

  it('skips an unavailable provider when choosing the last available one', async () => {
    const reachable = fake('reachable', { status: 'rate-limited' });
    const absent = fake('absent', { available: false });

    const result = await resolveService('claude', [reachable.provider, absent.provider], NOW);
    expect(result.via).toBe('reachable');
    expect(result.status).toBe('rate-limited');
  });

  it('is unavailable, with a "log in" hint, when nothing is available', async () => {
    const a = fake('a', { available: false });
    const b = fake('b', { available: false });

    const result = await resolveService('claude', [a.provider, b.provider], NOW);
    expect(result.status).toBe('unavailable');
    expect(result.via).toBe(VIA_NONE);
    expect(result.message).toContain('Log in');
  });

  it('is unavailable for an empty chain', async () => {
    const result = await resolveService('chatgpt', [], NOW);
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('ChatGPT');
  });

  it('catches a throwing fetch and reports error', async () => {
    const boom = fake('boom', { status: 'throws' });
    const result = await resolveService('claude', [boom.provider], NOW);
    expect(result.status).toBe('error');
    expect(result.via).toBe('boom');
    expect(result.message).toBe('boom fetch blew up');
  });

  it('keeps going past a throwing provider to one that works', async () => {
    const boom = fake('boom', { status: 'throws' });
    const good = fake('good', { status: 'ok' });
    const result = await resolveService('claude', [boom.provider, good.provider], NOW);
    expect(result.status).toBe('ok');
    expect(result.via).toBe('good');
  });

  it('treats a throwing availability check as available-and-failing', async () => {
    // Not silently skipped: a broken source the owner has logged in to must not
    // become invisible.
    const broken = fake('broken', { available: 'throws' });
    const result = await resolveService('claude', [broken.provider], NOW);
    expect(result.status).toBe('error');
    expect(result.via).toBe('broken');
    expect(broken.calls).toEqual(['available']);
  });

  it('prefers a later ok over an earlier throw', async () => {
    const broken = fake('broken', { available: 'throws' });
    const good = fake('good', { status: 'ok' });
    const result = await resolveService('claude', [broken.provider, good.provider], NOW);
    expect(result.via).toBe('good');
  });
});

describe('resolveAll', () => {
  it('resolves both services independently', async () => {
    const claude = fake('claude-oauth', { status: 'ok' });
    const chatgpt = fake('chatgpt-web', { status: 'auth-needed', message: 'logged out' });

    const result = await resolveAll(
      { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [], copilot: [], gemini: [] },
      NOW
    );
    expect(result.claude.status).toBe('ok');
    expect(result.chatgpt.status).toBe('auth-needed');
    expect(result.chatgpt.message).toBe('logged out');
  });

  it('does not let a failure in one service affect the other', async () => {
    const claude = fake('claude-oauth', { status: 'throws' });
    const chatgpt = fake('chatgpt-codex', { status: 'ok' });

    const result = await resolveAll(
      { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [], copilot: [], gemini: [] },
      NOW
    );
    expect(result.claude.status).toBe('error');
    expect(result.chatgpt.status).toBe('ok');
  });
});

/**
 * `isWebLoginAuthenticated` — the login window's close condition.
 *
 * The bug it replaces: the window used to close when *any* provider in the
 * chain said `isAvailable`, so on a machine with Claude Code or Codex installed
 * the token provider answered yes and the window shut about two seconds after
 * opening, before the owner could type anything. So the rule is narrow on both
 * axes — only the web provider for that service, and only its *authenticated*
 * check — and both halves are pinned here with fakes.
 */
describe('isWebLoginAuthenticated', () => {
  interface WebFakeOptions {
    readonly service?: ServiceName;
    readonly available?: boolean;
    readonly authenticated?: boolean | 'throws';
    readonly web?: boolean;
  }

  function webFake(id: string, options: WebFakeOptions = {}): Fake {
    const calls: string[] = [];
    const base: UsageProvider = {
      id,
      service: options.service ?? 'claude',
      label: `${id} label`,
      async isAvailable() {
        calls.push('available');
        return options.available ?? true;
      },
      async fetch() {
        calls.push('fetch');
        return { buckets: [], status: 'ok' as SourceStatus, via: id };
      }
    };
    const provider: UsageProvider =
      options.web === false
        ? base
        : {
            ...base,
            async isAuthenticated() {
              calls.push('authenticated');
              if (options.authenticated === 'throws') throw new Error(`${id} check blew up`);
              return options.authenticated ?? true;
            }
          };
    return { provider, calls };
  }

  it('asks the web provider, and only about authentication', async () => {
    const token = webFake('claude-oauth', { web: false });
    const web = webFake('claude-web', { authenticated: true });

    expect(
      await isWebLoginAuthenticated([token.provider, web.provider], 'claude')
    ).toBe(true);
    expect(web.calls).toEqual(['authenticated']);
    // The token provider is not consulted at all: it knows nothing about the
    // browser session being created.
    expect(token.calls).toEqual([]);
  });

  it('is false when the web provider is not authenticated, however available it is', async () => {
    const web = webFake('claude-web', { available: true, authenticated: false });
    expect(await isWebLoginAuthenticated([web.provider], 'claude')).toBe(false);
  });

  it('ignores an available token provider for the same service', async () => {
    // The reported bug, in one assertion: Claude Code installed, claude.ai not
    // logged in, and the window must stay open.
    const token = webFake('claude-oauth', { web: false, available: true });
    const web = webFake('claude-web', { authenticated: false });
    expect(await isWebLoginAuthenticated([token.provider, web.provider], 'claude')).toBe(false);
  });

  it('ignores the other service\'s web provider', async () => {
    const other = webFake('chatgpt-web', { service: 'chatgpt', authenticated: true });
    expect(await isWebLoginAuthenticated([other.provider], 'claude')).toBe(false);
    expect(other.calls).toEqual([]);
  });

  it('is false when there is no web provider in the chain', async () => {
    const token = webFake('claude-oauth', { web: false });
    expect(await isWebLoginAuthenticated([token.provider], 'claude')).toBe(false);
    expect(await isWebLoginAuthenticated([], 'claude')).toBe(false);
  });

  it('is false for a token-only service: no web provider, no login window', async () => {
    // Each of these chains is one provider that deliberately does not
    // implement `isAuthenticated` — which is what keeps the login window away
    // from a service whose sign-in happens in the Cursor editor, in the
    // owner's own `gh auth login`, or (for Gemini) nowhere at all, because
    // Antigravity's language server authenticates with its own argument.
    for (const service of ['cursor', 'copilot', 'gemini'] as const) {
      const token = webFake(service, { service, web: false });
      expect(webProviderFor([token.provider], service), service).toBeNull();
      expect(await isWebLoginAuthenticated([token.provider], service), service).toBe(false);
    }
  });

  it('is false when the check throws: a failed check is not a login', async () => {
    const web = webFake('claude-web', { authenticated: 'throws' });
    expect(await isWebLoginAuthenticated([web.provider], 'claude')).toBe(false);
  });

  it('finds the web provider by its authenticated check, not by an id list', async () => {
    const web = webFake('chatgpt-web', { service: 'chatgpt' });
    const token = webFake('chatgpt-codex', { web: false, service: 'chatgpt' });
    expect(webProviderFor([token.provider, web.provider], 'chatgpt')?.id).toBe('chatgpt-web');
    expect(webProviderFor([token.provider], 'chatgpt')).toBeNull();
  });
});

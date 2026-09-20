/**
 * The poll loop, driven with fake timers and fake providers.
 *
 * The behaviours pinned here are the ones that would be invisible in a screenshot
 * but obvious in use:
 *
 *  - every tick emits a **full** snapshot, merging the last known report for the
 *    service that was not due — otherwise the panel's other half would blank out
 *    every other tick;
 *  - a service backed off by a 429 does **not** hold the other one up;
 *  - the last snapshot is persisted trimmed, and restored on launch, so the dog
 *    has a real face immediately instead of a confused one for three minutes;
 *  - "Refresh now" is limited to once a minute;
 *  - nothing in the loop can put a credential in the store.
 *
 * `electron` is not involved: the chains, the clock and the RNG are injected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * `poller.ts` imports `readPrimaryService` from `./store`, and `store.ts` imports
 * `electron` and `electron-store` at module level. Nothing here calls either —
 * every store is the fake below — but without these mocks the import chain
 * loads the real `electron` package, whose index.js (44.x) tries to *download*
 * the binary when `dist/` is absent. That is how this suite came to be the one
 * test that needed a 130 MB download to run, found 2026-09-19 when GitHub's
 * release CDN answered 500 in CI.
 */
vi.mock('electron', () => ({ app: {}, screen: {} }));
vi.mock('electron-store', () => ({ default: class {} }));
import { RESOLVE_DEADLINE_MS, createPoller } from '../src/main/poller';
import { MANUAL_COOLDOWN_MS, MIN_POLL_SEC, restoreSchedules } from '../src/core/poll-schedule';
import type { ServiceName } from '../src/core/services';
import type { UsageSnapshot } from '../src/core/usage';
import type { Bucket } from '../src/core/buckets';
import type { ProviderResult, SourceStatus, UsageProvider } from '../src/providers/types';
import type { WalderStore } from '../src/main/store';

const BASE = MIN_POLL_SEC * 1000;

function bucket(id: string, service: ServiceName, pct: number, raw?: unknown): Bucket {
  return {
    id,
    service,
    key: service === 'claude' ? 'five_hour' : 'codex_primary',
    label: service === 'claude' ? '5-hour' : 'Codex 5-hour',
    pct,
    resetsAt: null,
    priority: service === 'claude' ? 0 : 4,
    ...(raw === undefined ? {} : { raw })
  };
}

/** A provider whose answer the test can change between polls. */
function scripted(
  id: string,
  service: ServiceName,
  answers: (() => ProviderResult)[]
): { provider: UsageProvider; polls: number } {
  const state = { polls: 0 };
  const provider: UsageProvider = {
    id,
    service,
    label: `${id} label`,
    isAvailable: async () => true,
    fetch: async () => {
      const answer = answers[Math.min(state.polls, answers.length - 1)];
      state.polls++;
      return answer?.() ?? { buckets: [], status: 'error' as SourceStatus, via: id };
    }
  };
  return {
    provider,
    get polls() {
      return state.polls;
    }
  } as { provider: UsageProvider; polls: number };
}

function ok(id: string, service: ServiceName, pct: number, raw?: unknown) {
  return (): ProviderResult => ({
    buckets: [bucket(service === 'claude' ? 'claude.five_hour' : `${service}.b`, service, pct, raw)],
    status: 'ok',
    via: id
  });
}

function failing(id: string, status: SourceStatus, message = 'nope') {
  return (): ProviderResult => ({ buckets: [], status, message, via: id });
}

/** A store-shaped object recording what was written. */
function fakeStore(initial: Record<string, unknown> = {}): WalderStore & {
  data: Record<string, unknown>;
} {
  const data: Record<string, unknown> = { pollIntervalSec: MIN_POLL_SEC, ...initial };
  return {
    data,
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => {
      data[key] = value;
    },
    path: '/tmp/walder-test/walder.json'
  } as unknown as WalderStore & { data: Record<string, unknown> };
}

/** Let queued promises settle; the tick body awaits provider calls. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Advance the fake clock and let the resulting tick finish. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-08T15:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createPoller', () => {
  it('polls both services on start and emits one merged snapshot', async () => {
    const claude = scripted('claude-oauth', 'claude', [ok('claude-oauth', 'claude', 30)]);
    const chatgpt = scripted('chatgpt-codex', 'chatgpt', [ok('chatgpt-codex', 'chatgpt', 70)]);
    const emitted: UsageSnapshot[] = [];

    const poller = createPoller({
      store: fakeStore(),
      chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [] },
      onSnapshot: (s) => emitted.push(s),
      random: () => 0.5
    });

    poller.start();
    await settle();

    expect(emitted).toHaveLength(1);
    const snapshot = emitted[0] as UsageSnapshot;
    expect(snapshot.buckets.map((b) => b.id)).toEqual(['claude.five_hour', 'chatgpt.b']);
    expect(snapshot.services.claude.status).toBe('ok');
    expect(snapshot.services.chatgpt.status).toBe('ok');
    // The provider's own label, so the panel can print "via Claude Code login".
    expect(snapshot.services.claude.viaLabel).toBe('claude-oauth label');
    // The face comes from Claude's 5-hour window: 30 % is happy.
    expect(snapshot.expression).toBe('happy');
    poller.stop();
  });

  /**
   * A `ProviderResult` can carry a `supplements` array — per-poll diagnostics
   * about the optional extra GETs `claude-web` makes (see `ClaudeSupplement`).
   * `ServiceReport` is what reaches the panel, the settings file and the bark
   * machine, and it must NOT carry them: they are about requests, not about
   * the owner's allowance, and a report built by spreading the result would
   * quietly persist them to disk on every poll.
   */
  it('copies named fields into the report, so supplements never reach it', async () => {
    const claude = scripted('claude-web', 'claude', [
      () => ({
        buckets: [bucket('claude.five_hour', 'claude', 30)],
        status: 'ok' as SourceStatus,
        via: 'claude-web',
        supplements: [{ id: 'extra-usage', status: 'ok' as SourceStatus, buckets: 1 }]
      })
    ]);
    const chatgpt = scripted('g', 'chatgpt', [ok('g', 'chatgpt', 10)]);
    const emitted: UsageSnapshot[] = [];
    const store = fakeStore();

    const poller = createPoller({
      store,
      chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [] },
      onSnapshot: (s) => emitted.push(s),
      random: () => 0.5
    });
    poller.start();
    await settle();

    expect(emitted[0]?.services.claude).not.toHaveProperty('supplements');
    expect(JSON.stringify(store.data['lastSnapshot'])).not.toContain('extra-usage');
    poller.stop();
  });

  it('polls again after the interval', async () => {
    const claude = scripted('c', 'claude', [ok('c', 'claude', 30), ok('c', 'claude', 90)]);
    const chatgpt = scripted('g', 'chatgpt', [ok('g', 'chatgpt', 10)]);
    const emitted: UsageSnapshot[] = [];

    const poller = createPoller({
      store: fakeStore(),
      chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [] },
      onSnapshot: (s) => emitted.push(s),
      random: () => 0.5
    });
    poller.start();
    await settle();

    await advance(BASE + 1);
    expect(emitted).toHaveLength(2);
    expect((emitted[1] as UsageSnapshot).expression).toBe('worried');
    poller.stop();
  });

  it('does not poll a service that is not due, but still reports it', async () => {
    // ChatGPT is rate-limited into a long backoff; Claude keeps its cadence, and
    // the snapshot still carries ChatGPT's last known status rather than blanking
    // that half of the panel.
    const claude = scripted('c', 'claude', [ok('c', 'claude', 30)]);
    const chatgpt = scripted('g', 'chatgpt', [failing('g', 'rate-limited', 'slow down')]);
    const emitted: UsageSnapshot[] = [];

    const poller = createPoller({
      store: fakeStore(),
      chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [] },
      onSnapshot: (s) => emitted.push(s),
      random: () => 0.5
    });
    poller.start();
    await settle();
    expect(chatgpt.polls).toBe(1);

    await advance(BASE + 1);
    expect(claude.polls).toBe(2);
    expect(chatgpt.polls).toBe(1); // backed off to 2x the interval

    const latest = emitted.at(-1) as UsageSnapshot;
    expect(latest.services.claude.status).toBe('ok');
    expect(latest.services.chatgpt.status).toBe('rate-limited');
    expect(latest.services.chatgpt.message).toBe('slow down');
    poller.stop();
  });

  it('polls a backed-off service the moment its window resets', async () => {
    // The P1 case: a 429 backs ChatGPT off to twice the base interval — six
    // minutes — but the window it is waiting on rolls over in two. Waiting out
    // the backoff would leave an exhausted face up for four minutes after the
    // limit had lifted.
    const resetsAt = new Date(Date.now() + 2 * 60_000).toISOString();
    const claude = scripted('c', 'claude', [ok('c', 'claude', 30)]);
    const chatgpt = scripted('g', 'chatgpt', [
      (): ProviderResult => ({
        buckets: [{ ...bucket('chatgpt.b', 'chatgpt', 100), resetsAt }],
        status: 'rate-limited',
        message: 'slow down',
        via: 'g'
      })
    ]);

    const poller = createPoller({
      store: fakeStore(),
      chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [] },
      onSnapshot: () => {},
      random: () => 0.5
    });
    poller.start();
    await settle();
    expect(chatgpt.polls).toBe(1);

    await advance(2 * 60_000 + 5_000);
    expect(chatgpt.polls).toBe(2);
    // And only the service whose window reset: Claude is not due for another
    // minute, so the boundary is not a blanket poll of everything.
    expect(claude.polls).toBe(1);
    poller.stop();
  });

  it('pokeNow polls without spending the manual cooldown', async () => {
    // What a wake does. The owner who opens the lid should still have his one
    // Refresh in hand, so the machine's poll must not stamp the cooldown.
    const claude = scripted('c', 'claude', [ok('c', 'claude', 30)]);
    const chatgpt = scripted('g', 'chatgpt', [ok('g', 'chatgpt', 70)]);

    const poller = createPoller({
      store: fakeStore(),
      chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [] },
      onSnapshot: () => {},
      random: () => 0.5
    });
    poller.start();
    await settle();
    expect(poller.refreshNow()).toBe(true);
    await advance(10);
    expect(claude.polls).toBe(2);

    poller.pokeNow();
    await advance(10);
    expect(claude.polls).toBe(3);
    expect(chatgpt.polls).toBe(3);

    // The cooldown is still the one `refreshNow` armed 20 ms ago, not a fresh
    // minute started by the wake.
    expect(poller.refreshNow()).toBe(false);
    expect(poller.cooldownRemainingMs()).toBe(MANUAL_COOLDOWN_MS - 20);
    poller.stop();
  });

  it('stamps each service with its own poll time, so a backed-off one does not borrow the other\'s', async () => {
    const claude = scripted('c', 'claude', [ok('c', 'claude', 30), ok('c', 'claude', 40)]);
    const chatgpt = scripted('g', 'chatgpt', [failing('g', 'rate-limited', 'slow down')]);
    const emitted: UsageSnapshot[] = [];

    const poller = createPoller({
      store: fakeStore(),
      chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [] },
      onSnapshot: (s) => emitted.push(s),
      random: () => 0.5
    });
    poller.start();
    await settle();

    const first = emitted.at(-1) as UsageSnapshot;
    const claudeFirstStamp = first.services.claude.fetchedAt;
    const chatgptFirstStamp = first.services.chatgpt.fetchedAt;

    // ChatGPT is rate-limited, so it backed off to 2x the base interval;
    // Claude keeps its plain cadence and is due again after one base interval.
    await advance(BASE + 1);

    const latest = emitted.at(-1) as UsageSnapshot;
    expect(claude.polls).toBe(2);
    expect(chatgpt.polls).toBe(1); // still backed off, not due yet

    // Claude was actually re-polled: its own stamp moved on.
    expect(latest.services.claude.fetchedAt).not.toBe(claudeFirstStamp);
    // ChatGPT was not: it keeps the stamp from its one and only poll, rather
    // than borrowing the tick's — a stale reading must not look as fresh as
    // the service that was actually just polled.
    expect(latest.services.chatgpt.fetchedAt).toBe(chatgptFirstStamp);
    // The snapshot-level stamp is the tick time, newer than ChatGPT's own.
    expect(Date.parse(latest.fetchedAt)).toBeGreaterThan(Date.parse(latest.services.chatgpt.fetchedAt as string));
    poller.stop();
  });

  it('backs off further on repeated failures and recovers after a success', async () => {
    const claude = scripted('c', 'claude', [
      failing('c', 'error'),
      failing('c', 'error'),
      ok('c', 'claude', 20)
    ]);
    const chatgpt = scripted('g', 'chatgpt', [failing('g', 'unavailable')]);

    const poller = createPoller({
      store: fakeStore(),
      chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [] },
      onSnapshot: () => {},
      random: () => 0.5
    });
    poller.start();
    await settle();
    expect(claude.polls).toBe(1);

    // First failure: 2x the base interval, so nothing at 1x.
    await advance(BASE + 1);
    expect(claude.polls).toBe(1);
    await advance(BASE);
    expect(claude.polls).toBe(2);

    // Second failure: 4x. Nothing until then, then the success.
    await advance(2 * BASE + 1);
    expect(claude.polls).toBe(2);
    await advance(2 * BASE);
    expect(claude.polls).toBe(3);

    // Recovered: back to the plain interval.
    await advance(BASE + 1);
    expect(claude.polls).toBe(4);
    poller.stop();
  });

  it('does not back off an auth-needed service', async () => {
    // Fixed by the owner logging in, and cheap to ask; a backoff would leave the
    // panel saying "logged out" long after they had.
    const claude = scripted('c', 'claude', [failing('c', 'auth-needed', 'log in')]);
    const chatgpt = scripted('g', 'chatgpt', [failing('g', 'unavailable')]);

    const poller = createPoller({
      store: fakeStore(),
      chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [] },
      onSnapshot: () => {},
      random: () => 0.5
    });
    poller.start();
    await settle();

    await advance(BASE + 1);
    expect(claude.polls).toBe(2);
    poller.stop();
  });

  it('persists the snapshot trimmed, with no raw payload', async () => {
    const store = fakeStore();
    const claude = scripted('c', 'claude', [
      ok('c', 'claude', 30, { account_id: 'acct-1', email: 'someone@example.com' })
    ]);
    const chatgpt = scripted('g', 'chatgpt', [failing('g', 'unavailable')]);

    const poller = createPoller({
      store,
      chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [] },
      onSnapshot: () => {},
      random: () => 0.5
    });
    poller.start();
    await settle();

    const stored = store.data['lastSnapshot'] as Record<string, unknown>;
    expect(stored).toBeDefined();
    // The settings file is plain JSON in the user's library folder.
    expect(JSON.stringify(stored)).not.toContain('example.com');
    expect(JSON.stringify(stored)).not.toContain('account_id');
    poller.stop();
  });

  it('emits the stored snapshot before touching the network', async () => {
    // So the dog has a real face the instant he appears.
    const store = fakeStore({
      lastSnapshot: {
        fetchedAt: '2026-09-08T14:00:00Z',
        intervalMs: BASE,
        buckets: [
          { id: 'claude.five_hour', service: 'claude', key: 'five_hour', label: '5-hour', pct: 96 }
        ],
        services: {
          claude: { status: 'ok', via: 'c', viaLabel: 'stored label' },
          chatgpt: { status: 'unavailable', via: 'none', viaLabel: 'no source' }
        }
      }
    });

    let polled = false;
    const claude: UsageProvider = {
      id: 'c',
      service: 'claude',
      label: 'c label',
      isAvailable: async () => true,
      fetch: async () => {
        polled = true;
        return { buckets: [bucket('claude.five_hour', 'claude', 10)], status: 'ok', via: 'c' };
      }
    };
    const emitted: UsageSnapshot[] = [];

    const poller = createPoller({
      store,
      chains: { claude: [claude], chatgpt: [], cursor: [] },
      onSnapshot: (s) => emitted.push(s),
      random: () => 0.5
    });

    poller.start();
    // The restored snapshot is emitted synchronously, before any provider ran.
    expect(polled).toBe(false);
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as UsageSnapshot).expression).toBe('exhausted');
    expect((emitted[0] as UsageSnapshot).services.claude.viaLabel).toBe('stored label');

    await settle();
    expect(emitted).toHaveLength(2);
    expect((emitted[1] as UsageSnapshot).expression).toBe('happy');
    poller.stop();
  });

  it('starts with no snapshot when the stored one is unreadable', async () => {
    const store = fakeStore({ lastSnapshot: { garbage: true } });
    const emitted: UsageSnapshot[] = [];
    const poller = createPoller({
      store,
      chains: { claude: [], chatgpt: [], cursor: [] },
      onSnapshot: (s) => emitted.push(s),
      random: () => 0.5
    });
    poller.start();
    expect(poller.last()).toBeNull();
    await settle();
    // Both chains empty, so the first live snapshot is two `unavailable`s.
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as UsageSnapshot).services.claude.status).toBe('unavailable');
    poller.stop();
  });

  it('keeps polling when the store cannot be written', async () => {
    const store = fakeStore();
    (store as unknown as { set: (k: string, v: unknown) => void }).set = () => {
      throw new Error('disk full');
    };
    const claude = scripted('c', 'claude', [ok('c', 'claude', 30)]);
    const emitted: UsageSnapshot[] = [];

    const poller = createPoller({
      store,
      chains: { claude: [claude.provider], chatgpt: [], cursor: [] },
      onSnapshot: (s) => emitted.push(s),
      random: () => 0.5
    });
    poller.start();
    await settle();

    expect(emitted).toHaveLength(1);
    poller.stop();
  });

  /*
   * Two ways a slow source used to be able to freeze the dog, both now bounded.
   */
  describe('a source that does not answer', () => {
    it('skips a tick that arrives while the previous one is still in flight', async () => {
      // Re-entrancy: without the `inFlight` guard the second tick would poll
      // the same providers again, double every request against the owner's
      // account, and publish two snapshots out of order.
      let release: (() => void) | null = null;
      let polls = 0;
      const claude: UsageProvider = {
        id: 'slow',
        service: 'claude',
        label: 'slow label',
        isAvailable: async () => true,
        fetch: async () => {
          polls++;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { buckets: [bucket('claude.five_hour', 'claude', 20)], status: 'ok', via: 'slow' };
        }
      };
      const emitted: UsageSnapshot[] = [];
      const poller = createPoller({
        store: fakeStore(),
        chains: { claude: [claude], chatgpt: [], cursor: [] },
        onSnapshot: (s) => emitted.push(s),
        random: () => 0.5
      });

      poller.start();
      await settle();
      expect(polls).toBe(1);
      expect(emitted).toHaveLength(0);

      // A manual refresh makes both services due and calls `tick` straight
      // away — the most direct way a second tick can land mid-flight.
      expect(poller.refreshNow()).toBe(true);
      await settle();
      expect(polls).toBe(1);

      // Same for a timer wakeup while the first poll is still outstanding.
      await advance(1_000);
      expect(polls).toBe(1);
      expect(emitted).toHaveLength(0);

      // Once it answers, exactly one snapshot comes out of the first tick.
      (release as unknown as () => void)();
      await settle();
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.services.claude.status).toBe('ok');
      poller.stop();
    });

    it('reports an error once a service passes the poll deadline', async () => {
      // The failure this converts: a chain that never resolves held `inFlight`
      // true forever, so every later tick was skipped and the panel simply
      // froze with no explanation anywhere.
      let polls = 0;
      const claude: UsageProvider = {
        id: 'wedged',
        service: 'claude',
        label: 'wedged label',
        isAvailable: async () => true,
        fetch: async () => {
          polls++;
          return new Promise<ProviderResult>(() => {
            /* never settles */
          });
        }
      };
      const emitted: UsageSnapshot[] = [];
      const poller = createPoller({
        store: fakeStore(),
        chains: { claude: [claude], chatgpt: [], cursor: [] },
        onSnapshot: (s) => emitted.push(s),
        random: () => 0.5
      });

      poller.start();
      await settle();
      expect(polls).toBe(1);
      expect(emitted).toHaveLength(0);

      await advance(RESOLVE_DEADLINE_MS);
      expect(emitted).toHaveLength(1);
      const report = (emitted[0] as UsageSnapshot).services.claude;
      expect(report.status).toBe('error');
      expect(report.message).toBe('the source did not answer in time');
      expect(report.buckets).toEqual([]);

      // And the loop keeps going: the deadline released `inFlight`.
      await advance(BASE * 2 + 1);
      expect(polls).toBeGreaterThan(1);
      poller.stop();
    });

    it('does not let a late answer overwrite a newer snapshot', async () => {
      // The abandoned promise from the timed-out poll can still resolve later —
      // `withDeadline` has already moved on, and its answer must go nowhere.
      let release: ((result: ProviderResult) => void) | null = null;
      let polls = 0;
      const claude: UsageProvider = {
        id: 'slow',
        service: 'claude',
        label: 'slow label',
        isAvailable: async () => true,
        fetch: async () => {
          polls++;
          if (polls === 1) {
            return new Promise<ProviderResult>((resolve) => {
              release = resolve;
            });
          }
          return { buckets: [bucket('claude.five_hour', 'claude', 55)], status: 'ok', via: 'slow' };
        }
      };
      const emitted: UsageSnapshot[] = [];
      const store = fakeStore();
      const poller = createPoller({
        store,
        chains: { claude: [claude], chatgpt: [], cursor: [] },
        onSnapshot: (s) => emitted.push(s),
        random: () => 0.5
      });

      poller.start();
      await settle();
      expect(polls).toBe(1);

      // Snapshot 1: the deadline fires first.
      await advance(RESOLVE_DEADLINE_MS);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.services.claude.status).toBe('error');
      expect(emitted[0]?.services.claude.message).toBe('the source did not answer in time');

      // Snapshot 2: the next poll answers straight away. (Chatgpt's own,
      // unrelated schedule may squeeze in an extra tick here — irrelevant to
      // this test, which only cares about claude's reports.)
      await advance(BASE * 2 + 1);
      expect(poller.last()?.services.claude.status).toBe('ok');
      expect(poller.last()?.services.claude.buckets[0]?.pct).toBe(55);
      const countBeforeLateAnswer = emitted.length;
      const storedBeforeLateAnswer = store.data.lastSnapshot;

      // The late answer, from the very first (abandoned) fetch, finally arrives.
      (release as unknown as (result: ProviderResult) => void)({
        buckets: [bucket('claude.five_hour', 'claude', 99)],
        status: 'ok',
        via: 'slow'
      });
      await settle();

      // No snapshot came out of the late answer, and the store was not rewritten.
      expect(emitted).toHaveLength(countBeforeLateAnswer);
      expect(poller.last()?.services.claude.buckets[0]?.pct).toBe(55);
      expect(store.data.lastSnapshot).toBe(storedBeforeLateAnswer);
      poller.stop();
    });

    it('discards the result of a poll stopped mid-flight', async () => {
      // Quitting mid-poll must not write to the store or notify a window that
      // `before-quit` is already tearing down.
      let release: ((result: ProviderResult) => void) | null = null;
      const claude: UsageProvider = {
        id: 'slow',
        service: 'claude',
        label: 'slow label',
        isAvailable: async () => true,
        fetch: async () =>
          new Promise<ProviderResult>((resolve) => {
            release = resolve;
          })
      };
      const emitted: UsageSnapshot[] = [];
      const store = fakeStore();
      const poller = createPoller({
        store,
        chains: { claude: [claude], chatgpt: [], cursor: [] },
        onSnapshot: (s) => emitted.push(s),
        random: () => 0.5
      });

      poller.start();
      await settle();
      poller.stop();
      (release as unknown as (result: ProviderResult) => void)({
        buckets: [bucket('claude.five_hour', 'claude', 20)],
        status: 'ok',
        via: 'slow'
      });
      await settle();

      expect(emitted).toHaveLength(0);
      expect(store.data.lastSnapshot).toBeUndefined();
      expect(store.data.pollSchedules).toBeUndefined();
      expect(poller.last()).toBeNull();
    });
  });

  describe('forget', () => {
    it('drops a logged-out service at once, and persists the drop', async () => {
      // A logout right after a manual refresh: `refreshNow` would be refused
      // for a minute, and the logged-out account's numbers would sit in the
      // snapshot — and in the store, and so at the next launch.
      const claude = scripted('claude-oauth', 'claude', [ok('claude-oauth', 'claude', 30)]);
      const chatgpt = scripted('chatgpt-codex', 'chatgpt', [ok('chatgpt-codex', 'chatgpt', 70)]);
      const emitted: UsageSnapshot[] = [];
      const store = fakeStore();
      const poller = createPoller({
        store,
        chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [] },
        onSnapshot: (s) => emitted.push(s),
        random: () => 0.5
      });

      poller.start();
      await settle();
      expect(emitted).toHaveLength(1);

      poller.forget('claude');
      expect(emitted).toHaveLength(2);
      const after = emitted[1] as UsageSnapshot;
      expect(after.services.claude.status).toBe('unavailable');
      expect(after.services.claude.buckets).toEqual([]);
      expect(after.buckets.map((b) => b.id)).toEqual(['chatgpt.b']);
      expect(after.services.chatgpt.status).toBe('ok');
      // No poll happened: this is a fact about the account, not a fetch.
      expect(claude.polls).toBe(1);
      const persisted = store.data['lastSnapshot'] as { buckets: { id: string }[] };
      expect(persisted.buckets.map((b) => b.id)).toEqual(['chatgpt.b']);
      poller.stop();
    });
  });

  describe('refreshNow', () => {
    it('polls immediately and then blocks for a minute', async () => {
      const claude = scripted('c', 'claude', [ok('c', 'claude', 30)]);
      const chatgpt = scripted('g', 'chatgpt', [failing('g', 'unavailable')]);

      const poller = createPoller({
        store: fakeStore(),
        chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [] },
        onSnapshot: () => {},
        random: () => 0.5
      });
      poller.start();
      await settle();
      expect(claude.polls).toBe(1);

      expect(poller.refreshNow()).toBe(true);
      await advance(10);
      expect(claude.polls).toBe(2);

      // A second attempt inside the cooldown is refused, and polls nothing.
      expect(poller.refreshNow()).toBe(false);
      await advance(10);
      expect(claude.polls).toBe(2);
      expect(poller.cooldownRemainingMs()).toBeGreaterThan(0);

      await advance(MANUAL_COOLDOWN_MS);
      expect(poller.cooldownRemainingMs()).toBe(0);
      expect(poller.refreshNow()).toBe(true);
      poller.stop();
    });

    it('overrides an active backoff', async () => {
      // What the owner does after logging in: they should not have to wait out a
      // fifteen-minute backoff to see it worked.
      const claude = scripted('c', 'claude', [
        failing('c', 'rate-limited'),
        ok('c', 'claude', 30)
      ]);
      const poller = createPoller({
        store: fakeStore(),
        chains: { claude: [claude.provider], chatgpt: [], cursor: [] },
        onSnapshot: () => {},
        random: () => 0.5
      });
      poller.start();
      await settle();
      expect(claude.polls).toBe(1);

      poller.refreshNow();
      await advance(10);
      expect(claude.polls).toBe(2);
      poller.stop();
    });
  });

  describe('republish', () => {
    /*
     * The menu's own escape hatch. `primaryService` is read inside `publish`, so
     * a tray change would otherwise not reach the card until the next three-
     * minute poll — a radio button that visibly does nothing for minutes reads
     * as broken, and `refreshNow` is the wrong tool for it: it goes to the
     * network for numbers nobody asked to be re-fetched, and its 60 s cooldown
     * refuses outright if the owner has just pressed Refresh.
     */
    it('re-emits the numbers already in hand, without polling', async () => {
      const claude = scripted('c', 'claude', [ok('c', 'claude', 40)]);
      const chatgpt = scripted('g', 'chatgpt', [ok('g', 'chatgpt', 10)]);
      const emitted: UsageSnapshot[] = [];
      const poller = createPoller({
        store: fakeStore(),
        chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [] },
        onSnapshot: (s) => emitted.push(s),
        random: () => 0.5
      });
      poller.start();
      await settle();
      expect(emitted).toHaveLength(1);
      const polls = claude.polls;

      poller.republish();
      expect(emitted).toHaveLength(2);
      // No provider was asked anything.
      expect(claude.polls).toBe(polls);
    });

    it('keeps the original fetch time, so a re-sort cannot look like a refresh', async () => {
      /*
       * The whole card is stamped with `fetchedAt`, and `formatRefreshedAgo`
       * turns it into "3 min ago" — and `isStale` into the warning the owner
       * relies on when a login has quietly expired. Re-publishing with `now()`
       * would reset both, so changing a menu setting would make an hour-old
       * snapshot claim to be fresh. That is the one thing this must not do.
       */
      const claude = scripted('c', 'claude', [ok('c', 'claude', 40)]);
      const chatgpt = scripted('g', 'chatgpt', [ok('g', 'chatgpt', 10)]);
      const emitted: UsageSnapshot[] = [];
      const poller = createPoller({
        store: fakeStore(),
        chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [] },
        onSnapshot: (s) => emitted.push(s),
        random: () => 0.5
      });
      poller.start();
      await settle();
      const first = emitted[0] as UsageSnapshot;
      // An hour on the clock, and no poll in it: the numbers are an hour old and
      // the card must go on saying so.
      vi.setSystemTime(new Date(Date.parse(first.fetchedAt) + 3_600_000));
      poller.republish();
      expect((emitted[1] as UsageSnapshot).fetchedAt).toBe(first.fetchedAt);
    });

    it('is a no-op before there is anything to re-publish', () => {
      const emitted: UsageSnapshot[] = [];
      const poller = createPoller({
        store: fakeStore(),
        chains: { claude: [], chatgpt: [], cursor: [] },
        onSnapshot: (s) => emitted.push(s),
        random: () => 0.5
      });
      poller.republish();
      expect(emitted).toEqual([]);
    });
  });

  describe('stop', () => {
    it('stops polling', async () => {
      const claude = scripted('c', 'claude', [ok('c', 'claude', 30)]);
      const poller = createPoller({
        store: fakeStore(),
        chains: { claude: [claude.provider], chatgpt: [], cursor: [] },
        onSnapshot: () => {},
        random: () => 0.5
      });
      poller.start();
      await settle();
      poller.stop();

      await advance(10 * BASE);
      expect(claude.polls).toBe(1);
    });

    it('is idempotent, and start after start does not double up', async () => {
      const claude = scripted('c', 'claude', [ok('c', 'claude', 30)]);
      const poller = createPoller({
        store: fakeStore(),
        chains: { claude: [claude.provider], chatgpt: [], cursor: [] },
        onSnapshot: () => {},
        random: () => 0.5
      });
      poller.start();
      poller.start();
      await settle();
      expect(claude.polls).toBe(1);

      poller.stop();
      poller.stop();
      await advance(10 * BASE);
      expect(claude.polls).toBe(1);
    });
  });

  it('honours a longer stored interval', async () => {
    const claude = scripted('c', 'claude', [ok('c', 'claude', 30)]);
    const poller = createPoller({
      store: fakeStore({ pollIntervalSec: 600 }),
      chains: { claude: [claude.provider], chatgpt: [], cursor: [] },
      onSnapshot: () => {},
      random: () => 0.5
    });
    poller.start();
    await settle();

    await advance(BASE + 1);
    expect(claude.polls).toBe(1);
    await advance(600_000);
    expect(claude.polls).toBe(2);
    poller.stop();
  });

  it('floors a too-fast stored interval at 180 s', async () => {
    const claude = scripted('c', 'claude', [ok('c', 'claude', 30)]);
    const poller = createPoller({
      store: fakeStore({ pollIntervalSec: 5 }),
      chains: { claude: [claude.provider], chatgpt: [], cursor: [] },
      onSnapshot: () => {},
      random: () => 0.5
    });
    poller.start();
    await settle();

    await advance(60_000);
    expect(claude.polls).toBe(1);
    await advance(BASE);
    expect(claude.polls).toBe(2);
    poller.stop();
  });

  /**
   * The "Tokens today" row is read off this machine's CLI transcripts, not off
   * the wire, so it is appended here rather than by a provider — and a service
   * whose CLI is not installed reports `null` and gets no row at all, which is
   * the difference between "nothing to say" and a confident "0 tokens".
   */
  it('appends a local tokens row per service, and none for a null total', async () => {
    const claude = scripted('c', 'claude', [ok('c', 'claude', 30)]);
    const chatgpt = scripted('g', 'chatgpt', [ok('g', 'chatgpt', 10)]);
    const emitted: UsageSnapshot[] = [];

    const poller = createPoller({
      store: fakeStore(),
      chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [] },
      onSnapshot: (s) => emitted.push(s),
      random: () => 0.5,
      localTokens: () => ({ claude: 1200, chatgpt: null })
    });
    poller.start();
    await settle();

    const snapshot = emitted[0] as UsageSnapshot;
    expect(snapshot.services.claude.buckets.map((b) => b.id)).toEqual([
      'claude.five_hour',
      'claude.tokens_today'
    ]);
    expect(snapshot.services.chatgpt.buckets.map((b) => b.id)).toEqual(['chatgpt.b']);
    // Priority 7 puts it last *within Claude*, under every Claude allowance —
    // and the whole Claude block sits ahead of ChatGPT's because the default
    // `primaryService` is 'claude' and the poller passes it to `mergeBuckets`.
    expect(snapshot.buckets.map((b) => b.id)).toEqual([
      'claude.five_hour',
      'claude.tokens_today',
      'chatgpt.b'
    ]);
    expect(snapshot.buckets[1]?.tokens).toEqual({ total: 1200 });
    poller.stop();
  });

  it('survives a provider that throws, and keeps its schedule', async () => {
    let polls = 0;
    const claude: UsageProvider = {
      id: 'c',
      service: 'claude',
      label: 'c',
      isAvailable: async () => true,
      fetch: async () => {
        polls++;
        throw new Error('boom');
      }
    };
    const emitted: UsageSnapshot[] = [];
    const poller = createPoller({
      store: fakeStore(),
      chains: { claude: [claude], chatgpt: [], cursor: [] },
      onSnapshot: (s) => emitted.push(s),
      random: () => 0.5
    });
    poller.start();
    await settle();

    expect(polls).toBe(1);
    expect((emitted[0] as UsageSnapshot).services.claude.status).toBe('error');
    expect((emitted[0] as UsageSnapshot).services.claude.message).toBe('boom');

    // An `error` backs off to 2x: no *Claude* poll at 1x, one at 2x. (A snapshot
    // is still published at 1x, because the empty ChatGPT chain is due then and
    // reports `unavailable` at the plain interval.)
    await advance(BASE + 1);
    expect(polls).toBe(1);
    await advance(BASE);
    expect(polls).toBe(2);
    poller.stop();
  });
});

/**
 * `Retry-After`, and the backoff that has to outlive a quit.
 *
 * Both exist for the same failure: a rate limit the app was keeping alive. It
 * obeyed `Retry-After: 0` (Anthropic's answer on a 429) as if it meant "now",
 * and it forgot every penalty the moment the owner quit — which is exactly what
 * the owner does when the dog looks stuck.
 */
describe('createPoller: server floors and stored backoff', () => {
  const NOW = Date.parse('2026-09-08T15:00:00Z');

  function limited(id: string, retryAfterMs: number) {
    return (): ProviderResult => ({
      buckets: [],
      status: 'rate-limited' as SourceStatus,
      message: 'slow down',
      via: id,
      retryAfterMs
    });
  }

  it('waits out an hour-long Retry-After instead of our 15-minute cap', async () => {
    const claude = scripted('c', 'claude', [limited('c', 3_600_000), ok('c', 'claude', 20)]);
    const chatgpt = scripted('g', 'chatgpt', [failing('g', 'unavailable')]);

    const poller = createPoller({
      store: fakeStore(),
      chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [] },
      onSnapshot: () => {},
      random: () => 0.5
    });
    poller.start();
    await settle();
    expect(claude.polls).toBe(1);

    // Our own doubling would have re-polled at 6 min and capped at 15; the
    // server asked for an hour, and a floor may only ever raise the wait.
    await advance(15 * 60_000 + 1);
    expect(claude.polls).toBe(1);

    await advance(45 * 60_000 + 20_000); // the rest of the hour, plus jitter slack
    expect(claude.polls).toBe(2);
    poller.stop();
  });

  it('persists the backoff so a relaunch mid-penalty keeps waiting', async () => {
    const store = fakeStore();
    const claude = scripted('c', 'claude', [limited('c', 600_000)]);
    const chatgpt = scripted('g', 'chatgpt', [ok('g', 'chatgpt', 10)]);

    const poller = createPoller({
      store,
      chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [] },
      onSnapshot: () => {},
      random: () => 0.5
    });
    poller.start();
    await settle();

    const stored = store.data['pollSchedules'] as Record<string, { failures: number }>;
    expect(stored['claude']?.failures).toBe(1);
    // The service that answered fine is recorded as fine, or a relaunch would
    // restore a penalty it had already worked off.
    expect(stored['chatgpt']?.failures).toBe(0);
    poller.stop();
  });

  it('polls, backs off and persists a third service independently', async () => {
    /*
     * P2-1's proof. `SERVICES` is closed, so a service the app does not ship
     * cannot be typed as one — but the poller reads its list from the chains
     * object it is handed, and this test hands it three. If any of these
     * assertions fails, some path still spells the two names out by hand.
     */
    const FAKE = 'fake' as ServiceName;
    const store = fakeStore();
    const claude = scripted('c', 'claude', [ok('c', 'claude', 20)]);
    const chatgpt = scripted('g', 'chatgpt', [ok('g', 'chatgpt', 10)]);
    const fake = scripted('f', FAKE, [failing('f', 'error'), failing('f', 'error'), ok('f', FAKE, 50)]);
    const emitted: UsageSnapshot[] = [];

    const poller = createPoller({
      store,
      chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], fake: [fake.provider], cursor: [] },
      onSnapshot: (snapshot) => emitted.push(snapshot),
      random: () => 0.5
    });
    poller.start();
    await settle();

    // The snapshot carries the third section, and its own status.
    const first = emitted[0] as UsageSnapshot;
    expect(Object.keys(first.services).sort()).toEqual(['chatgpt', 'claude', 'cursor', 'fake']);
    expect(first.services['fake']?.status).toBe('error');
    expect(first.services.claude.status).toBe('ok');

    // Its failure is its own: persisted under its name, and nobody else's.
    const stored = store.data['pollSchedules'] as Record<
      string,
      { failures: number; nextDueAt: number }
    >;
    expect(stored['fake']?.failures).toBe(1);
    expect(stored['claude']?.failures).toBe(0);
    expect(stored['chatgpt']?.failures).toBe(0);

    // A restore reads the third entry only when asked for that name — a file
    // from a build that knew more services never invents one here.
    const at = Date.now(); // the fake clock
    expect(
      restoreSchedules(stored, at, ['claude', 'chatgpt', 'cursor', 'fake'])['fake']?.failures
    ).toBe(1);
    expect(restoreSchedules(stored, at)['fake']).toBeUndefined();

    // At the base interval the healthy two poll again; the third is still in
    // its 2x penalty and is not touched.
    await advance(BASE + 1);
    expect(claude.polls).toBe(2);
    expect(chatgpt.polls).toBe(2);
    expect(fake.polls).toBe(1);
    poller.stop();
  });

  it('honours a stored penalty on start, without holding the other service up', async () => {
    const claude = scripted('c', 'claude', [ok('c', 'claude', 20)]);
    const chatgpt = scripted('g', 'chatgpt', [ok('g', 'chatgpt', 10)]);
    const store = fakeStore({
      pollSchedules: {
        claude: { failures: 2, nextDueAt: NOW + 600_000 },
        chatgpt: { failures: 0, nextDueAt: NOW }
      }
    });

    const poller = createPoller({
      store,
      chains: { claude: [claude.provider], chatgpt: [chatgpt.provider], cursor: [] },
      onSnapshot: () => {},
      random: () => 0.5
    });
    poller.start();
    await settle();

    // The whole point: relaunching is not a way to clear a rate limit.
    expect(claude.polls).toBe(0);
    expect(chatgpt.polls).toBe(1);

    await advance(600_000 + 1);
    expect(claude.polls).toBe(1);
    poller.stop();
  });
});

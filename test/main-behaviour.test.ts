/**
 * The main-process shell around the behaviour coordinator — specifically the
 * one thing in it that reaches outside the coordinator: a pet asks the poller
 * for fresh numbers.
 *
 * The coordinator's own decisions (which bubble, which box, which animation) are
 * tested in `behaviour.test.ts` against the pure class. What is tested here is
 * the *wiring*: that `onPet` calls the refresh at all, that it does so after the
 * visible reaction rather than instead of it, and that the poller's 60 s manual
 * cooldown — not a second copy of the rule in this file — is what stops a burst
 * of petting from hammering the endpoints.
 *
 * Both a hand-written fake poller (to count the calls the shell makes) and the
 * real `createPoller` (to prove the cooldown actually blocks the second one) are
 * used, because either alone would leave the interesting half unproven.
 *
 * `electron` is not involved: `main/behaviour.ts` takes the overlay through a
 * getter and imports its type only, and `main/poller.ts` takes its chains, clock
 * and RNG the same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBehaviour } from '../src/main/behaviour';
import { createPoller } from '../src/main/poller';
import { MANUAL_COOLDOWN_MS, MIN_POLL_SEC } from '../src/core/poll-schedule';
import type { Overlay } from '../src/main/overlay-window';
import type { WalderStore } from '../src/main/store';
import type { ProviderChains } from '../src/providers/registry';
import type { ProviderResult, UsageProvider } from '../src/providers/types';
import type { UsageSnapshot } from '../src/core/usage';

/** An overlay that records the scene messages sent to it and nothing else. */
function fakeOverlay(): { overlay: Overlay; sent: unknown[] } {
  const sent: unknown[] = [];
  const overlay = {
    win: { isDestroyed: () => false, webContents: {} },
    applyBox: () => undefined,
    applyBubble: () => undefined,
    send: (_channel: string, payload: unknown) => {
      sent.push(payload);
    }
  } as unknown as Overlay;
  return { overlay, sent };
}

/** A store-shaped object with just the key the poller reads. */
function fakeStore(): WalderStore {
  const data: Record<string, unknown> = { pollIntervalSec: MIN_POLL_SEC };
  return {
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => {
      data[key] = value;
    },
    path: '/tmp/walder-test/walder.json'
  } as unknown as WalderStore;
}

/** A provider that answers `ok` with no buckets and counts its calls. */
function counting(service: 'claude' | 'chatgpt', calls: { n: number }): UsageProvider {
  return {
    id: `${service}-test`,
    service,
    label: `${service} test`,
    isAvailable: async () => true,
    fetch: async (): Promise<ProviderResult> => {
      calls.n++;
      return { buckets: [], status: 'ok', via: `${service}-test` };
    }
  };
}

/** Let the poller's awaited provider calls settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-09T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createBehaviour — a pet refreshes the usage', () => {
  it('asks for a refresh on every pet, and after the visible reaction', () => {
    const { overlay, sent } = fakeOverlay();
    const order: string[] = [];
    const behaviour = createBehaviour({
      getOverlay: () => {
        order.push('scene');
        return overlay;
      },
      refreshUsage: () => order.push('refresh')
    });

    behaviour.onPet();
    // The wiggle went out before the request did: the reaction must not wait on
    // anything, even something that returns immediately.
    expect(order).toEqual(['scene', 'refresh']);
    expect(sent).toHaveLength(1);

    behaviour.onPet();
    expect(order.filter((step) => step === 'refresh')).toHaveLength(2);

    behaviour.stop();
  });

  it('works with no refresh wired to it at all', () => {
    // The optional dep is what lets the coordinator be built before the poller
    // exists — and what keeps a pet working in a build with no poller.
    const { overlay, sent } = fakeOverlay();
    const behaviour = createBehaviour({ getOverlay: () => overlay });
    expect(() => behaviour.onPet()).not.toThrow();
    expect(sent).toHaveLength(1);
    behaviour.stop();
  });

  it('polls on the first pet and is refused by the cooldown on the second', async () => {
    const claude = { n: 0 };
    const chatgpt = { n: 0 };
    const chains: ProviderChains = {
      claude: [counting('claude', claude)],
      chatgpt: [counting('chatgpt', chatgpt)]
    };
    const snapshots: UsageSnapshot[] = [];
    const poller = createPoller({
      store: fakeStore(),
      chains,
      onSnapshot: (snapshot) => snapshots.push(snapshot)
    });

    const { overlay } = fakeOverlay();
    const behaviour = createBehaviour({
      getOverlay: () => overlay,
      refreshUsage: () => void poller.refreshNow()
    });

    // `start()` is the app's own first poll. The manual cooldown counts manual
    // refreshes only, so it does not make the owner wait a minute after launch
    // before his first pet does anything.
    poller.start();
    await settle();
    expect(claude.n).toBe(1);
    const afterStart = snapshots.length;

    // The first pet polls, and the fresh snapshot is what moves the panel's
    // "refreshed …" line back to "just now".
    vi.setSystemTime(new Date(Date.now() + 5_000));
    behaviour.onPet();
    await settle();
    expect(claude.n).toBe(2);
    expect(chatgpt.n).toBe(2);
    expect(snapshots.length).toBeGreaterThan(afterStart);
    expect(Date.parse(snapshots[snapshots.length - 1]?.fetchedAt ?? '')).toBe(Date.now());

    // A second pet inside the cooldown: no fetch, no snapshot, no throw. This is
    // the case that matters — the dog is petted repeatedly, and the endpoints
    // must not see one request per click.
    const afterFirstPet = snapshots.length;
    const petAt = Date.now();
    for (const offset of [1, 1_000, MANUAL_COOLDOWN_MS - 1]) {
      vi.setSystemTime(new Date(petAt + offset));
      behaviour.onPet();
      await settle();
    }
    expect(claude.n).toBe(2);
    expect(chatgpt.n).toBe(2);
    expect(snapshots).toHaveLength(afterFirstPet);

    // Exactly on the cooldown boundary, a pet polls again.
    vi.setSystemTime(new Date(petAt + MANUAL_COOLDOWN_MS));
    behaviour.onPet();
    await settle();
    expect(claude.n).toBe(3);

    behaviour.stop();
    poller.stop();
  });
});

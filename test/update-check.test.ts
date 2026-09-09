/**
 * The update check: the parsing, the schedule, the wording, and the loop.
 *
 * Three things here are worth a test each for reasons that are not about
 * correctness in the ordinary sense:
 *
 *  - **The URL pin.** `shell.openExternal` hands a URL to whatever the OS has
 *    registered for its scheme, so an `html_url` chosen by a remote response is
 *    a way out of the app. The fixture is a real-shaped GitHub body; the test
 *    beside it swaps in a foreign `html_url` and asserts the releases-page
 *    constant comes back instead.
 *  - **No `console.warn`, ever.** Offline laptops, captive portals and GitHub's
 *    rate limit are all normal, and a mascot that logged a warning for each
 *    would fill the log file the owner is asked to send when something is
 *    *actually* broken.
 *  - **Nothing is requested when the setting is off.** README promises exactly
 *    that in its Privacy section, and a promise about network traffic is worth
 *    pinning with a request counter.
 *
 * `main/update-check.ts` is Electron-free, so the loop is driven with an
 * injected `HttpFetch`, an injected clock and vitest's fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MANUAL_COOLDOWN_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_FIRST_CHECK_DELAY_MS,
  UPDATE_LATEST_URL,
  UPDATE_RELEASES_URL,
  UPDATE_REPO,
  UPDATE_RETRY_FLOOR_MS,
  UPDATE_TIMEOUT_MS,
  UPDATE_URL_PREFIX,
  nextCheckAt,
  parseLatestRelease,
  shouldNotify,
  updateMenuLine,
  updateUserAgent,
  type UpdateState
} from '../src/core/update-check';
import { createUpdateChecker } from '../src/main/update-check';
import type { HttpFetch, HttpInit, HttpResponse } from '../src/providers/types';

const here = dirname(fileURLToPath(import.meta.url));
const LATEST = JSON.parse(
  readFileSync(join(here, 'fixtures', 'github-release-latest.json'), 'utf8')
) as Record<string, unknown>;

const T0 = Date.parse('2026-09-09T12:00:00.000Z');

/* ------------------------------------------------------------------- pure */

describe('the constants', () => {
  it('name the public releases repository, and only it', () => {
    expect(UPDATE_REPO).toBe('ViuMP/walder-releases');
    expect(UPDATE_LATEST_URL).toBe(
      'https://api.github.com/repos/ViuMP/walder-releases/releases/latest'
    );
    expect(UPDATE_RELEASES_URL).toBe('https://github.com/ViuMP/walder-releases/releases');
    expect(UPDATE_URL_PREFIX).toBe('https://github.com/ViuMP/walder-releases/');
    // The fallback must itself pass the pin, or "Download…" would open nothing.
    expect(UPDATE_RELEASES_URL.startsWith(UPDATE_URL_PREFIX)).toBe(true);
  });

  it('checks rarely, starts late and retries slowly', () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60_000);
    // Not part of the launch burst: two provider polls, a sheet, a window and a
    // hook server already happen at startup, and this is the least urgent thing
    // in the app.
    expect(UPDATE_FIRST_CHECK_DELAY_MS).toBe(60_000);
    expect(UPDATE_RETRY_FLOOR_MS).toBe(60 * 60_000);
    expect(UPDATE_TIMEOUT_MS).toBeLessThan(15_000);
  });
});

describe('parseLatestRelease', () => {
  it('reads a real GitHub release body', () => {
    expect(parseLatestRelease(LATEST)).toEqual({
      // Without the leading `v`: it is shown to the owner as a version.
      version: '0.1.3',
      url: 'https://github.com/ViuMP/walder-releases/releases/tag/v0.1.3'
    });
  });

  it('falls back to the releases page for an html_url outside the repository', () => {
    // The security case. GitHub's API is not the threat here — "the response
    // told us where to send the owner" is simply not a sentence that should be
    // true of any app.
    for (const foreign of [
      'https://evil.example/walder',
      'https://github.com/someone-else/walder-releases/releases/tag/v0.1.3',
      'https://github.com.evil.example/ViuMP/walder-releases/',
      'file:///Applications',
      '',
      // `shell.openExternal` hands this to whatever the OS registered for the
      // scheme; a `javascript:` URL is the classic way through such a door.
      'javascript:alert(1)//https://github.com/ViuMP/walder-releases/',
      // Scheme-relative: `startsWith` on a constant that includes `https://` is
      // what makes this fail, and it is why the pin is not a host comparison.
      '//github.com/ViuMP/walder-releases/x',
      // The prefix is case-sensitive on purpose: hosts are not, so an uppercase
      // one is a different string that means the same place — and "looks like
      // ours but is not spelled like ours" is not a call this pin makes.
      'HTTPS://GITHUB.COM/ViuMP/walder-releases/x',
      // The lookalike the trailing slash in `UPDATE_URL_PREFIX` exists for:
      // `walder-releases.evil` starts with `walder-releases`.
      'https://github.com/ViuMP/walder-releases.evil/x'
    ]) {
      const parsed = parseLatestRelease({ ...LATEST, html_url: foreign });
      expect(parsed?.version, foreign).toBe('0.1.3');
      expect(parsed?.url, foreign).toBe(UPDATE_RELEASES_URL);
    }
    expect(parseLatestRelease({ ...LATEST, html_url: 42 })?.url).toBe(UPDATE_RELEASES_URL);
  });

  it('refuses a draft or a prerelease', () => {
    expect(parseLatestRelease({ ...LATEST, draft: true })).toBeNull();
    expect(parseLatestRelease({ ...LATEST, prerelease: true })).toBeNull();
  });

  it('refuses a tag that names no version', () => {
    expect(parseLatestRelease({ ...LATEST, tag_name: 'nightly' })).toBeNull();
    expect(parseLatestRelease({ ...LATEST, tag_name: undefined })).toBeNull();
    expect(parseLatestRelease({})).toBeNull();
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease([LATEST])).toBeNull();
    expect(parseLatestRelease('v0.1.3')).toBeNull();
  });
});

describe('nextCheckAt', () => {
  it('waits a minute after launch, then six hours between answers', () => {
    expect(nextCheckAt({ kind: 'never' }, T0)).toBe(T0 + UPDATE_FIRST_CHECK_DELAY_MS);
    expect(nextCheckAt({ kind: 'up-to-date', at: T0 }, T0 - 999_999)).toBe(
      T0 + UPDATE_CHECK_INTERVAL_MS
    );
    expect(
      nextCheckAt({ kind: 'available', version: '0.1.3', url: UPDATE_RELEASES_URL, at: T0 }, T0)
    ).toBe(T0 + UPDATE_CHECK_INTERVAL_MS);
  });

  it('waits an hour after a failure, not six', () => {
    // Failures are coffee-shop wifi, which resolves on its own timescale — but
    // an hour is far short of six, so a laptop that comes back online is not
    // stuck with a stale "last check failed" all afternoon.
    expect(nextCheckAt({ kind: 'failed', detail: 'timeout', at: T0 }, T0)).toBe(
      T0 + UPDATE_RETRY_FLOOR_MS
    );
    expect(UPDATE_RETRY_FLOOR_MS).toBeLessThan(UPDATE_CHECK_INTERVAL_MS);
  });

  it('hangs the schedule off the last answer, not off launch', () => {
    // A laptop asleep for a day checks once when it wakes, rather than making
    // up the four checks it missed.
    const long = nextCheckAt({ kind: 'up-to-date', at: T0 }, T0 - 24 * 60 * 60_000);
    expect(long).toBe(T0 + UPDATE_CHECK_INTERVAL_MS);
  });
});

describe('updateMenuLine', () => {
  const available: UpdateState = {
    kind: 'available',
    version: '0.1.3',
    url: UPDATE_RELEASES_URL,
    at: T0
  };

  it('offers the download when there is one, cooldown or not', () => {
    // That item opens a page rather than making a request, so no cooldown
    // applies to it.
    expect(updateMenuLine(available)).toBe('Update available: 0.1.3 — Download…');
    expect(updateMenuLine(available, 42_000)).toBe('Update available: 0.1.3 — Download…');
  });

  it('offers a check otherwise, and says how long to wait', () => {
    expect(updateMenuLine({ kind: 'never' })).toBe('Check for updates now');
    expect(updateMenuLine({ kind: 'up-to-date', at: T0 })).toBe('Check for updates now');
    expect(updateMenuLine({ kind: 'never' }, 41_500)).toBe('Check for updates now (wait 42s)');
  });

  it('dates a failure, which is the whole point of mentioning it', () => {
    // "We asked and could not" versus "we have not asked since you were on a
    // plane" are different problems, and only the time tells them apart.
    const line = updateMenuLine({ kind: 'failed', detail: 'timeout', at: T0 });
    expect(line).toMatch(/^Last check failed \(\d{2}:\d{2}\)$/);
    // No jargon and no detail: the shape belongs in the log, not the menu bar.
    expect(line).not.toContain('timeout');
  });
});

describe('shouldNotify', () => {
  it('says yes once per version', () => {
    expect(shouldNotify('0.1.3', null)).toBe(true);
    expect(shouldNotify('0.1.3', '0.1.3')).toBe(false);
    expect(shouldNotify('0.1.3', '0.1.2')).toBe(true);
    expect(shouldNotify('0.1.3', '0.2.0')).toBe(false);
  });

  it('treats an unreadable memory as "not told him yet"', () => {
    // The cost is one extra bubble; the opposite mistake would suppress the
    // notice for good.
    expect(shouldNotify('0.1.3', 'nonsense')).toBe(true);
    expect(shouldNotify('0.1.3', 42)).toBe(true);
    expect(shouldNotify('0.1.3', undefined)).toBe(true);
  });

  it('says nothing about a version it cannot read', () => {
    expect(shouldNotify('nightly', null)).toBe(false);
  });
});

describe('updateUserAgent', () => {
  it('names the app and its version, and nothing else', () => {
    expect(updateUserAgent('0.1.2')).toBe('Walder/0.1.2');
    expect(updateUserAgent('v0.1.2')).toBe('Walder/0.1.2');
    // No machine name, no OS build, no account.
    expect(updateUserAgent('0.1.2')).not.toMatch(/darwin|mac|win|node|electron/i);
  });

  it('does not put a garbled version in a header', () => {
    expect(updateUserAgent('nonsense')).toBe('Walder/0.0.0');
  });
});

/* ------------------------------------------------------------------- loop */

/** A response the adapter would have produced. */
function ok(body: unknown): HttpResponse {
  return {
    ok: true,
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body)
  };
}

interface Harness {
  readonly checker: ReturnType<typeof createUpdateChecker>;
  readonly requests: { url: string; init?: HttpInit }[];
  readonly states: UpdateState[];
  enabled: boolean;
}

/**
 * An answer that has not arrived yet, so a test can hold a check *in flight*.
 *
 * Real requests are awaited; the only way to observe what the checker does
 * while one is outstanding is to be the thing that decides when it lands.
 */
function pending(): { answer: Promise<HttpResponse>; resolve: () => void } {
  let release: (response: HttpResponse) => void = () => undefined;
  const answer = new Promise<HttpResponse>((r) => {
    release = r;
  });
  return { answer, resolve: () => release(ok(LATEST)) };
}

function harness(
  answers: (HttpResponse | Error | Promise<HttpResponse>)[],
  options: { currentVersion?: string; enabled?: boolean } = {}
): Harness {
  const requests: { url: string; init?: HttpInit }[] = [];
  const states: UpdateState[] = [];
  const box = { enabled: options.enabled ?? true };

  const http: HttpFetch = async (url, init) => {
    requests.push(init === undefined ? { url } : { url, init });
    const answer = answers.shift() ?? ok(LATEST);
    if (answer instanceof Error) throw answer;
    return answer;
  };

  const checker = createUpdateChecker({
    http,
    currentVersion: options.currentVersion ?? '0.1.2',
    enabled: () => box.enabled,
    onState: (state) => states.push(state)
  });

  return {
    checker,
    requests,
    states,
    get enabled(): boolean {
      return box.enabled;
    },
    set enabled(next: boolean) {
      box.enabled = next;
    }
  };
}

/** Let the checker's awaited request settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0));
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createUpdateChecker', () => {
  it('asks nothing for the first minute, then asks once', async () => {
    const h = harness([ok(LATEST)]);
    h.checker.start();
    expect(h.requests).toHaveLength(0);

    vi.advanceTimersByTime(UPDATE_FIRST_CHECK_DELAY_MS - 1);
    await settle();
    expect(h.requests).toHaveLength(0);

    vi.advanceTimersByTime(1);
    await settle();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.url).toBe(UPDATE_LATEST_URL);
    h.checker.stop();
  });

  it('sends the headers GitHub asks for, and a short timeout', async () => {
    const h = harness([ok(LATEST)]);
    h.checker.start();
    vi.advanceTimersByTime(UPDATE_FIRST_CHECK_DELAY_MS);
    await settle();

    const init = h.requests[0]?.init;
    expect(init?.headers?.['Accept']).toBe('application/vnd.github+json');
    expect(init?.headers?.['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(init?.headers?.['User-Agent']).toBe('Walder/0.1.2');
    expect(init?.timeoutMs).toBe(UPDATE_TIMEOUT_MS);
    // Nothing that identifies the owner, and no credential of any kind.
    expect(Object.keys(init?.headers ?? {})).not.toContain('Authorization');
    expect(Object.keys(init?.headers ?? {})).not.toContain('Cookie');
    h.checker.stop();
  });

  it('reports an available version, with the pinned URL', async () => {
    const h = harness([ok(LATEST)]);
    h.checker.start();
    vi.advanceTimersByTime(UPDATE_FIRST_CHECK_DELAY_MS);
    await settle();

    expect(h.states).toHaveLength(1);
    expect(h.states[0]).toEqual({
      kind: 'available',
      version: '0.1.3',
      url: 'https://github.com/ViuMP/walder-releases/releases/tag/v0.1.3',
      at: T0 + UPDATE_FIRST_CHECK_DELAY_MS
    });
    expect(h.checker.state().kind).toBe('available');
    h.checker.stop();
  });

  it('reports up-to-date when the release is the version we are running', async () => {
    const h = harness([ok(LATEST)], { currentVersion: '0.1.3' });
    h.checker.start();
    vi.advanceTimersByTime(UPDATE_FIRST_CHECK_DELAY_MS);
    await settle();
    expect(h.states[0]?.kind).toBe('up-to-date');
    h.checker.stop();
  });

  it('reports up-to-date when we are somehow ahead of the release', async () => {
    const h = harness([ok(LATEST)], { currentVersion: '0.2.0' });
    h.checker.start();
    vi.advanceTimersByTime(UPDATE_FIRST_CHECK_DELAY_MS);
    await settle();
    expect(h.states[0]?.kind).toBe('up-to-date');
    h.checker.stop();
  });

  it('fails quietly on a 403, an HTML page and a timeout — never a warning', async () => {
    const rateLimited: HttpResponse = {
      ok: false,
      status: 403,
      contentType: 'application/json',
      body: '{"message":"API rate limit exceeded"}'
    };
    const loginPage: HttpResponse = {
      ok: true,
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body>Sign in</body></html>'
    };
    const aborted = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError'
    });

    const h = harness([rateLimited, loginPage, aborted]);
    h.checker.start();

    for (const _ of [0, 1, 2]) {
      vi.advanceTimersByTime(
        h.states.length === 0 ? UPDATE_FIRST_CHECK_DELAY_MS : UPDATE_RETRY_FLOOR_MS
      );
      await settle();
    }

    expect(h.states.map((state) => state.kind)).toEqual(['failed', 'failed', 'failed']);
    expect(h.states.map((state) => (state.kind === 'failed' ? state.detail : ''))).toEqual([
      'HTTP 403',
      'a web page, not JSON',
      'timeout'
    ]);
    // The point: none of these is something the owner can do anything about, and
    // the log file he is asked to send must not be full of them.
    expect(console.warn).not.toHaveBeenCalled();
    h.checker.stop();
  });

  it('fails on a body that is not a release, without throwing', async () => {
    const h = harness([ok({ message: 'Not Found' })]);
    h.checker.start();
    vi.advanceTimersByTime(UPDATE_FIRST_CHECK_DELAY_MS);
    await settle();
    expect(h.states[0]).toMatchObject({ kind: 'failed' });
    expect(console.warn).not.toHaveBeenCalled();
    h.checker.stop();
  });

  it('makes no request at all while the setting is off', async () => {
    // The README's Privacy section promises exactly this.
    const h = harness([ok(LATEST)], { enabled: false });
    h.checker.start();
    vi.advanceTimersByTime(UPDATE_FIRST_CHECK_DELAY_MS + UPDATE_CHECK_INTERVAL_MS * 3);
    await settle();
    expect(h.requests).toHaveLength(0);
    expect(h.states).toHaveLength(0);

    // And ticking it back on takes effect without a restart: the timer is armed
    // either way, it is the request that is skipped.
    h.enabled = true;
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
    await settle();
    expect(h.requests).toHaveLength(1);
    h.checker.stop();
  });

  it('keeps an available version through every skipped check', async () => {
    // The bug this pins: the skip used to assign `{kind:'up-to-date'}` directly,
    // past `publish()`. So a Walder that had found 0.1.3 and then had its checks
    // switched off lost the menu's "Update available: 0.1.3 — Download…" at the
    // next six-hour wakeup, with the update still un-installed and nothing on
    // screen to say it had ever existed.
    const h = harness([ok(LATEST)]);
    h.checker.start();
    vi.advanceTimersByTime(UPDATE_FIRST_CHECK_DELAY_MS);
    await settle();
    expect(h.checker.state()).toMatchObject({ kind: 'available', version: '0.1.3' });

    h.enabled = false;
    for (const _ of [0, 1, 2, 3]) {
      vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
      await settle();
    }

    // No request, no state change, and the menu line is still the one that
    // matters.
    expect(h.requests).toHaveLength(1);
    expect(h.checker.state()).toMatchObject({ kind: 'available', version: '0.1.3' });
    expect(updateMenuLine(h.checker.state())).toBe('Update available: 0.1.3 — Download…');
    h.checker.stop();
  });

  it('keeps re-arming on a sane interval while switched off, from "never"', async () => {
    // The trap in leaving `state` alone: `nextCheckAt({kind:'never'}, startedAt)`
    // is a moment already in the past by the time the first check is skipped, so
    // a re-arm computed from it would fire again in a millisecond, and again,
    // for the rest of the run. The skip therefore names its own due time.
    const h = harness([], { enabled: false });
    h.checker.start();
    vi.advanceTimersByTime(UPDATE_FIRST_CHECK_DELAY_MS);
    await settle();
    expect(h.checker.state()).toEqual({ kind: 'never' });

    // A minute of clock with no wakeups worth mentioning: if the timer were
    // spinning, this would be tens of thousands of skips.
    const before = h.requests.length;
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(h.requests).toHaveLength(before);
    expect(vi.getTimerCount()).toBe(1);
    h.checker.stop();
  });

  it('checks anyway when the owner asks, even with automatic checks off', async () => {
    // The owner clicked "Check for updates now" in a menu he opened himself.
    // Refusing that because the *automatic* checks are unticked would answer a
    // question nobody asked; the setting is about traffic Walder starts on its
    // own.
    const h = harness([ok(LATEST)], { enabled: false });
    h.checker.start();

    expect(h.checker.checkNow()).toBe(true);
    await settle();
    expect(h.requests).toHaveLength(1);
    expect(h.checker.state()).toMatchObject({ kind: 'available', version: '0.1.3' });
    h.checker.stop();
  });

  it('does not spend the cooldown on a click that lands mid-check', async () => {
    const slow = pending();
    const h = harness([slow.answer, ok(LATEST)]);
    h.checker.start();

    expect(h.checker.checkNow()).toBe(true);
    await settle();
    expect(h.requests).toHaveLength(1);

    // Still awaiting the answer. A second click starts nothing…
    vi.setSystemTime(new Date(T0 + MANUAL_COOLDOWN_MS + 1_000));
    expect(h.checker.checkNow()).toBe(false);
    await settle();
    expect(h.requests).toHaveLength(1);
    // …and, the point of the test, it did not stamp the cooldown either: the
    // owner is not made to wait another minute for a click that did nothing.
    expect(h.checker.cooldownRemainingMs()).toBe(0);

    // Once the answer lands, the next click works.
    slow.resolve();
    await settle();
    expect(h.checker.checkNow()).toBe(true);
    await settle();
    expect(h.requests).toHaveLength(2);
    h.checker.stop();
  });

  it('checks again six hours after an answer', async () => {
    const h = harness([ok(LATEST), ok(LATEST)], { currentVersion: '0.1.3' });
    h.checker.start();
    vi.advanceTimersByTime(UPDATE_FIRST_CHECK_DELAY_MS);
    await settle();
    expect(h.requests).toHaveLength(1);

    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS - 1);
    await settle();
    expect(h.requests).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await settle();
    expect(h.requests).toHaveLength(2);
    h.checker.stop();
  });

  it('honours the 60 s cooldown on a manual check', async () => {
    const h = harness([ok(LATEST), ok(LATEST)]);
    h.checker.start();

    expect(h.checker.cooldownRemainingMs()).toBe(0);
    expect(h.checker.checkNow()).toBe(true);
    await settle();
    expect(h.requests).toHaveLength(1);
    expect(h.checker.cooldownRemainingMs()).toBe(MANUAL_COOLDOWN_MS);

    // A second click a moment later must not reach GitHub.
    vi.setSystemTime(new Date(T0 + 1_000));
    expect(h.checker.checkNow()).toBe(false);
    await settle();
    expect(h.requests).toHaveLength(1);

    vi.setSystemTime(new Date(T0 + MANUAL_COOLDOWN_MS));
    expect(h.checker.checkNow()).toBe(true);
    await settle();
    expect(h.requests).toHaveLength(2);
    h.checker.stop();
  });

  it('stops asking after stop()', async () => {
    const h = harness([ok(LATEST)]);
    h.checker.start();
    h.checker.stop();
    vi.advanceTimersByTime(UPDATE_FIRST_CHECK_DELAY_MS + UPDATE_CHECK_INTERVAL_MS * 3);
    await settle();
    expect(h.requests).toHaveLength(0);
  });

  it('starts at "never", so nothing is claimed before the first check', () => {
    const h = harness([]);
    expect(h.checker.state()).toEqual({ kind: 'never' });
    expect(updateMenuLine(h.checker.state())).toBe('Check for updates now');
  });
});

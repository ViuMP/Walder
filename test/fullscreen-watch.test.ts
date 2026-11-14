/**
 * The fullscreen watch: the polling shell around the pure decision.
 *
 * The probe is injected, so none of this touches `get-windows`, PowerShell or
 * the OS. What is asserted is the behaviour that only exists at this level:
 *
 *  - **fail-soft.** A probe that throws — a missing binary, an unsupported
 *    platform, a refused spawn — means "we cannot tell", which must eventually
 *    read as *not* fullscreen. The worst case is then that the dog stays visible
 *    over a film, which is the status quo; a crash or a repeated system prompt
 *    is not.
 *  - **it never gives up.** The earlier version stopped polling for the whole
 *    session after three consecutive failures, and that is what killed this
 *    feature in the field: entering a macOS full-screen Space makes the probe
 *    answer `undefined` about three times in a row, so the *first real
 *    fullscreen video* broke the watch permanently. Failures now only slow the
 *    cadence down, and any success clears them.
 *  - **unknown is not "no".** While the probe is failing, the last known state
 *    is held for ten seconds before it decays — otherwise the same three-sample
 *    Space transition stands a sleeping dog up and lies him back down.
 *  - **unknown is not always a failure** (2026-11-14, audit decision 13). A
 *    probe that answers "no window for the app in front" while it lists other
 *    windows is alive: the same hold and decay, but no back-off to the slow
 *    cadence and no warning, so the next fullscreen window is read 2 s later
 *    rather than up to 20.
 *  - **the tray switch really switches it off** — timer included, not just the
 *    probing — and switching it off wakes a dog that is already curled up
 *    rather than leaving him asleep.
 *  - **the Windows helper's lifecycle**: spawned once, its lines parsed, stdin
 *    closed on stop, a death reported as a failure. The PowerShell script
 *    itself cannot be run on this machine, so the child process is a fake and
 *    `fullscreen-win.ps1` is unverified — see the handover note.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron-store', () => ({ default: class {} }));

vi.mock('electron', () => ({
  app: { getName: () => 'Walder', isPackaged: false, getAppPath: () => '/app' },
  screen: { getAllDisplays: () => [] }
}));

const {
  BACKOFF_AFTER_FAILURES,
  BACKOFF_POLL_MS,
  HELPER_MAX_AGE_MS,
  NoActiveWindowError,
  POLL_MS,
  UNKNOWN_HOLD_MS,
  WARN_AFTER_FAILURES,
  createFullscreenWatch,
  createWinProbe,
  frontmostWindows,
  parseWinLine,
  winSampleToDip
} = await import('../src/main/fullscreen-watch');
const { SHELL_HOLD_MAX_MS } = await import('../src/core/fullscreen');

type Rect = { x: number; y: number; width: number; height: number };

const DISPLAY: Rect = { x: 0, y: 0, width: 1440, height: 900 };
const OTHER: Rect = { x: 1440, y: 0, width: 1920, height: 1080 };
const SELF = { names: ['Walder'], processId: 1 };

/**
 * What `get-windows` lists (`openWindows()`) while the app in front has no
 * window: somebody else's, in the package's own shape.
 */
const LISTED = [{ bounds: { x: 0, y: 25, width: 1440, height: 700 }, owner: { name: 'Notes', processId: 4242 } }];

/**
 * One entry of a probe script: some windows, none, a failure, or `'nofront'` —
 * the answer of a probe that is alive and found no window for the app in front
 * (`activeWindow()` undefined, `openWindows()` listing others).
 */
type Step =
  | { bounds: Rect; owner?: string }
  | { windows: Rect[]; owner?: string }
  | null
  | 'throw'
  | 'nofront';

/** Both kinds of unknown: a probe that failed, and one that answered "no window in front". */
const UNKNOWNS = ['throw', 'nofront'] as const;

/** A watch whose probe answers from a script, one entry per poll. */
function watcher(
  script: readonly Step[],
  opts: {
    enabled?: () => boolean;
    displays?: () => Rect[];
    dogDisplay?: () => Rect | null;
    now?: () => number;
  } = {}
): {
  poll: () => Promise<void>;
  setEnabled: (on: boolean) => void;
  flips: boolean[];
  polls: () => number;
  isFullscreen: () => boolean;
} {
  const flips: boolean[] = [];
  let index = 0;

  const watch = createFullscreenWatch({
    onChange: (fullscreen) => flips.push(fullscreen),
    enabled: opts.enabled ?? ((): boolean => true),
    displays: opts.displays ?? ((): Rect[] => [DISPLAY]),
    ...(opts.dogDisplay === undefined ? {} : { dogDisplay: opts.dogDisplay }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
    self: () => SELF,
    probe: async () => {
      // The last entry repeats, so a script says "then keep answering this".
      const step = script[Math.min(index, script.length - 1)] ?? null;
      index++;
      if (step === 'throw') throw new Error('no such binary');
      // Through the real judgement, so the script says what the OS said.
      if (step === 'nofront') return frontmostWindows(undefined, LISTED);
      if (step === null) return null;
      const owner = step.owner ?? 'Safari';
      // Both probe shapes are exercised: one window (the Windows helper) and a
      // list of them (macOS, every window of the frontmost app).
      if ('windows' in step) {
        return step.windows.map((bounds) => ({ bounds, ownerName: owner, ownerProcessId: 999 }));
      }
      return { bounds: step.bounds, ownerName: owner, ownerProcessId: 999 };
    }
  });

  return {
    poll: () => watch.pollNow(),
    setEnabled: (on: boolean) => watch.setEnabled(on),
    flips,
    polls: () => index,
    isFullscreen: () => watch.isFullscreen()
  };
}

const FULL = { bounds: DISPLAY };
const WINDOWED = { bounds: { x: 0, y: 25, width: 1440, height: 700 } };

describe('createFullscreenWatch', () => {
  it('reports a fullscreen window after the debounce, once', async () => {
    const w = watcher([FULL]);
    await w.poll();
    expect(w.flips).toEqual([]);
    await w.poll();
    expect(w.flips).toEqual([true]);
    expect(w.isFullscreen()).toBe(true);
    // Steady state reports nothing more.
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([true]);
  });

  it('does not report an ordinary window', async () => {
    const w = watcher([WINDOWED]);
    await w.poll();
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([]);
    expect(w.isFullscreen()).toBe(false);
  });

  it('treats a probe failure as "not fullscreen" instead of crashing', async () => {
    const w = watcher(['throw']);
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([]);
    expect(w.isFullscreen()).toBe(false);
  });

  it.each(UNKNOWNS)('holds the last state while the probe cannot answer (%s), then lets it decay', async (unknown) => {
    let clock = 0;
    const w = watcher([FULL, FULL, unknown], { now: () => clock });
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([true]);

    // Failing, but only just: the dog stays asleep rather than standing up over
    // a film because one probe stumbled.
    clock += UNKNOWN_HOLD_MS;
    await w.poll();
    await w.poll();
    expect(w.flips, 'woke inside the hold window').toEqual([true]);
    expect(w.isFullscreen()).toBe(true);

    // Past the hold, "unknown" decays to "not fullscreen" — two samples, per
    // the debounce — so he can never be stuck asleep behind a broken probe.
    clock += 1;
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([true, false]);
  });

  it('keeps probing after a run of failures instead of giving up', async () => {
    const w = watcher(['throw']);
    for (let i = 0; i < WARN_AFTER_FAILURES * 2; i++) await w.poll();
    // The old code stopped at three. A missing binary can be fixed while the
    // app is running (a reinstall, a permission, a Space that finished
    // switching) and nothing else would ever notice.
    expect(w.polls()).toBe(WARN_AFTER_FAILURES * 2);
    expect(w.isFullscreen()).toBe(false);
  });

  it('recovers on its own once the probe starts working again', async () => {
    // The bug the owner hit: three `undefined` in a row during the Space
    // transition, and detection was dead for the rest of the session.
    const w = watcher(['throw', 'throw', 'throw', FULL, FULL]);
    for (let i = 0; i < 5; i++) await w.poll();
    expect(w.polls()).toBe(5);
    expect(w.flips).toEqual([true]);
    expect(w.isFullscreen()).toBe(true);
  });

  it('forgets the failures as soon as one probe succeeds', async () => {
    const w = watcher(['throw', 'throw', WINDOWED, 'throw', 'throw', FULL, FULL]);
    for (let i = 0; i < 7; i++) await w.poll();
    expect(w.polls()).toBe(7);
    expect(w.isFullscreen()).toBe(true);
  });

  it('does not probe at all while the tray switch is off', async () => {
    let on = false;
    const w = watcher([FULL], { enabled: () => on });
    await w.poll();
    await w.poll();
    expect(w.polls()).toBe(0);
    expect(w.flips).toEqual([]);

    on = true;
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([true]);
  });

  it('wakes a sleeping dog when the switch is turned off', async () => {
    let on = true;
    const w = watcher([FULL], { enabled: () => on });
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([true]);

    on = false;
    await w.poll();
    expect(w.flips).toEqual([true, false]);
    expect(w.isFullscreen()).toBe(false);
    // …and does not repeat itself on every later poll.
    await w.poll();
    expect(w.flips).toEqual([true, false]);
  });

  it('treats "no active window" as not fullscreen', async () => {
    const w = watcher([null]);
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([]);
  });

  /** M4: the decision is against the dog's display, not the whole machine. */
  it('ignores a video on a display the dog is not on', async () => {
    const video = { bounds: OTHER };
    const w = watcher([video], {
      displays: () => [DISPLAY, OTHER],
      dogDisplay: () => DISPLAY
    });
    for (let i = 0; i < 4; i++) await w.poll();
    expect(w.flips).toEqual([]);
    expect(w.isFullscreen()).toBe(false);
  });

  it('sleeps for a video on the display the dog is on', async () => {
    const video = { bounds: OTHER };
    const w = watcher([video], {
      displays: () => [DISPLAY, OTHER],
      dogDisplay: () => OTHER
    });
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([true]);
  });

  it('follows the dog when he is dragged to the display with the film on it', async () => {
    let dog = DISPLAY;
    const w = watcher([{ bounds: OTHER }], {
      displays: () => [DISPLAY, OTHER],
      dogDisplay: () => dog
    });
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([]);

    dog = OTHER;
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([true]);
  });
});

/**
 * The owner's own recording, replayed through the watch.
 *
 * A 1 Hz probe ran for about two minutes on macOS 26 (one display, 1728×1117,
 * Dock visible, menu bar 33 px) while a YouTube video played fullscreen in
 * Chrome. What it caught is the whole bug in one sequence: the *active* window
 * was Chrome's hidden toolbar strip, the video was one entry further down the
 * same app's list, and the Space transition produced exactly three `undefined`
 * answers in a row — which under the old rules was precisely enough to stop the
 * watch for the rest of the session.
 */
describe('createFullscreenWatch: the recorded Chrome fullscreen session', () => {
  const MAC: Rect = { x: 0, y: 0, width: 1728, height: 1117 };
  const TOOLBAR: Rect = { x: 0, y: 33, width: 1728, height: 115 };
  const VIDEO: Rect = { x: 0, y: 33, width: 1728, height: 1084 };
  const SLIDING: Rect = { x: -1786, y: 33, width: 1728, height: 1084 };
  const DESKTOP: Rect = { x: 0, y: 33, width: 1433, height: 901 };

  const chrome = (...windows: Rect[]): Step => ({ windows, owner: 'Google Chrome' });

  function mac(script: readonly Step[], now?: () => number): ReturnType<typeof watcher> {
    return watcher(script, {
      displays: () => [MAC],
      dogDisplay: () => MAC,
      ...(now === undefined ? {} : { now })
    });
  }

  it('sleeps for the recorded fullscreen pair', async () => {
    const w = mac([chrome(TOOLBAR, VIDEO)]);
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([true]);
  });

  it('would never have slept on the active window alone', async () => {
    // The regression, stated as a test: the strip is all the old code could see.
    const w = mac([chrome(TOOLBAR)]);
    for (let i = 0; i < 4; i++) await w.poll();
    expect(w.flips).toEqual([]);
  });

  it.each(UNKNOWNS)('rides out the three-sample Space transition without flapping or dying (%s)', async (unknown) => {
    let clock = 0;
    // Exactly what was recorded: an ordinary window, the transition (three
    // `undefined` in a row), the sliding animation, then the settled pair.
    const w = mac(
      [
        { bounds: DESKTOP, owner: 'Google Chrome' },
        { bounds: DESKTOP, owner: 'Google Chrome' },
        unknown,
        unknown,
        unknown,
        chrome(TOOLBAR, SLIDING),
        chrome(TOOLBAR, VIDEO),
        chrome(TOOLBAR, VIDEO)
      ],
      () => clock
    );

    for (let i = 0; i < 8; i++) {
      await w.poll();
      clock += 1_000;
    }

    // Every sample was taken — the watch is not broken — and the only flip is
    // the one that matters: he went to sleep, once, when the video settled.
    expect(w.polls()).toBe(8);
    expect(w.flips).toEqual([true]);
    expect(w.isFullscreen()).toBe(true);
  });

  it.each(UNKNOWNS)('wakes once the video leaves fullscreen, transition and all (%s)', async (unknown) => {
    let clock = 0;
    const w = mac(
      [
        chrome(TOOLBAR, VIDEO),
        chrome(TOOLBAR, VIDEO),
        unknown,
        unknown,
        unknown,
        { bounds: DESKTOP, owner: 'Google Chrome' },
        { bounds: DESKTOP, owner: 'Google Chrome' }
      ],
      () => clock
    );

    for (let i = 0; i < 7; i++) {
      await w.poll();
      clock += 1_000;
    }
    // Asleep, then awake — and not a stand-up-and-lie-down in the middle, which
    // is what "unknown holds the last state" buys.
    expect(w.flips).toEqual([true, false]);
    expect(w.isFullscreen()).toBe(false);
  });
});

/**
 * L2/L3: the tray switch owns the timer, not just the probing.
 *
 * The earlier version kept the 2 s timer running while the feature was off,
 * "so switching it back on takes effect without a restart" — which meant a
 * disabled feature woke the CPU every two seconds for the life of the app, on
 * a mascot whose budget is under 1 % idle. And a watch that had given up after
 * three failures stayed given up forever: switching the feature off and on was
 * the one action that looked like it should retry, and did not.
 */
describe('createFullscreenWatch: the tray switch', () => {
  it('stops the timer when switched off and restarts it when switched on', async () => {
    vi.useFakeTimers();
    try {
      let on = true;
      let polls = 0;
      const flips: boolean[] = [];
      const watch = createFullscreenWatch({
        onChange: (fullscreen) => flips.push(fullscreen),
        enabled: () => on,
        displays: () => [DISPLAY],
        self: () => SELF,
        intervalMs: 2_000,
        probe: async () => {
          polls++;
          return { bounds: DISPLAY, ownerName: 'Safari', ownerProcessId: 999 };
        }
      });

      watch.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(polls).toBeGreaterThanOrEqual(2);
      expect(flips).toEqual([true]);

      // Off: one last sample reports the wake, then nothing is armed.
      on = false;
      watch.setEnabled(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(flips).toEqual([true, false]);
      const settled = polls;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(polls, 'polled while switched off').toBe(settled);
      expect(vi.getTimerCount(), 'a timer stayed armed while switched off').toBe(0);

      // On again: the loop resumes without an app restart.
      on = true;
      watch.setEnabled(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(polls).toBeGreaterThan(settled);
      expect(flips).toEqual([true, false, true]);

      watch.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a backed-off watch to the fast cadence when switched on', async () => {
    vi.useFakeTimers();
    try {
      let failing = true;
      let polls = 0;
      const watch = createFullscreenWatch({
        onChange: () => undefined,
        enabled: () => true,
        displays: () => [DISPLAY],
        self: () => SELF,
        intervalMs: 2_000,
        probe: async () => {
          polls++;
          if (failing) throw new Error('no such binary');
          return { bounds: DISPLAY, ownerName: 'Safari', ownerProcessId: 999 };
        }
      });

      watch.start();
      // Three failures and it is on the slow clock: a minute buys six polls,
      // not thirty. It has emphatically not stopped, which is the old bug.
      await vi.advanceTimersByTimeAsync(6 * BACKOFF_POLL_MS);
      expect(polls).toBeGreaterThan(BACKOFF_AFTER_FAILURES);
      expect(polls, 'still polling at the fast cadence').toBeLessThan(
        (6 * BACKOFF_POLL_MS) / 2_000
      );

      // The switch is the owner's "try again now", so it must not leave him
      // waiting out the slow cadence.
      failing = false;
      const backedOff = polls;
      watch.setEnabled(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(polls - backedOff).toBeGreaterThanOrEqual(2);
      expect(watch.isFullscreen()).toBe(true);
      watch.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never polls on a platform with no probe at all', async () => {
    let polls = 0;
    const watch = createFullscreenWatch({
      onChange: () => undefined,
      enabled: () => true,
      displays: () => [DISPLAY],
      self: () => SELF,
      platform: 'linux',
      // No `probe`: the real per-platform default is what is being tested, and
      // on linux there is none — so nothing must be spawned or attempted.
      intervalMs: 2_000
    });
    watch.start();
    await watch.pollNow();
    expect(polls).toBe(0);
    expect(watch.isFullscreen()).toBe(false);
    watch.stop();
  });
});

/**
 * Audit decision 13 (2026-11-14): an app with no window in front.
 *
 * Seen on the Mac that day: `activeWindow()` answered `undefined` for a long
 * stretch (an app in front with no window, inferred), every poll was counted as
 * a failed probe, the watch backed off to one probe per 10 s and logged its
 * thirty-failures warning, and a fullscreen browser window brought forward then
 * took about 22 s to put the dog to sleep. The probe was fine the whole time —
 * `openWindows()` was listing windows in the same sample.
 */
describe('createFullscreenWatch: an app with no window in front (audit decision 13)', () => {
  const FILM = { bounds: DISPLAY, owner: { name: 'Google Chrome', processId: 999 } };

  /** A watch on the real timer loop, with the WARN lines of the log captured. */
  async function onTimers(
    probe: () => Promise<never[] | ReturnType<typeof frontmostWindows>>,
    body: (seen: { polls: () => number; flips: boolean[]; warnings: () => string[] }) => Promise<void>
  ): Promise<void> {
    const { setLogSink } = await import('../src/main/log');
    const lines: string[] = [];
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    setLogSink((line) => lines.push(line));
    let polls = 0;
    const flips: boolean[] = [];
    const watch = createFullscreenWatch({
      onChange: (fullscreen) => flips.push(fullscreen),
      enabled: () => true,
      displays: () => [DISPLAY],
      self: () => SELF,
      intervalMs: POLL_MS,
      probe: () => {
        polls++;
        return probe();
      }
    });
    try {
      watch.start();
      await body({ polls: () => polls, flips, warnings: () => lines.filter((l) => l.includes(' WARN ')) });
    } finally {
      watch.stop();
      setLogSink(null);
      vi.useRealTimers();
      quiet.mockRestore();
    }
  }

  const FIVE_MINUTES = 5 * 60_000;

  it('is not a failed probe: no back-off, no warning, and the next film is caught at the normal cadence', async () => {
    let film = false;
    await onTimers(
      async () => frontmostWindows(film ? FILM : undefined, film ? [FILM] : LISTED),
      async (seen) => {
        await vi.advanceTimersByTimeAsync(FIVE_MINUTES);
        // Every 2 s for the whole stretch. Backed off, it was three polls and
        // then one per 10 s — about 33 — and the thirtieth of them warned.
        expect(seen.polls(), 'backed off to the slow cadence').toBeGreaterThanOrEqual(FIVE_MINUTES / POLL_MS);
        expect(seen.warnings()).toEqual([]);
        expect(seen.flips).toEqual([]);

        // The film comes forward: two readings at 2 s and he is asleep, where
        // the slow cadence made the first of them up to 10 s late.
        film = true;
        await vi.advanceTimersByTimeAsync(2 * POLL_MS + POLL_MS / 2);
        expect(seen.flips).toEqual([true]);
      }
    );
  });

  it('still backs off and warns, once, for a probe that really is broken', async () => {
    await onTimers(
      async () => {
        throw new Error('spawn ENOENT');
      },
      async (seen) => {
        await vi.advanceTimersByTimeAsync(2 * FIVE_MINUTES);
        expect(seen.polls()).toBeGreaterThan(WARN_AFTER_FAILURES);
        expect(seen.polls(), 'still polling at the fast cadence').toBeLessThan(FIVE_MINUTES / POLL_MS);
        expect(seen.warnings()).toHaveLength(1);
      }
    );
  });
});

describe('frontmostWindows', () => {
  const WALDER = { bounds: { x: 1300, y: 760, width: 88, height: 120 }, owner: { name: 'Walder', processId: 1 } };
  const STRIP = { bounds: { x: 0, y: 33, width: 1440, height: 115 }, owner: { name: 'Google Chrome', processId: 7 } };
  const VIDEO = { bounds: DISPLAY, owner: { name: 'Google Chrome', processId: 7 } };

  it('keeps every window of the frontmost app, or the active one alone when it is not listed', () => {
    expect(frontmostWindows(STRIP, [WALDER, STRIP, VIDEO]).map((win) => win.bounds)).toEqual([
      STRIP.bounds,
      VIDEO.bounds
    ]);
    expect(frontmostWindows(STRIP, [WALDER]).map((win) => win.bounds)).toEqual([STRIP.bounds]);
    expect(frontmostWindows(STRIP, undefined)).toHaveLength(1);
  });

  it('tells an app with no window from a probe that saw nothing at all', () => {
    // Alive: the binary ran and listed somebody's windows.
    expect(() => frontmostWindows(undefined, LISTED)).toThrow(NoActiveWindowError);
    // Nothing usable listed either: no evidence the binary can see the screen,
    // so it stays the ordinary failure that backs off and warns.
    for (const open of [[], undefined, [{ owner: { name: 'Notes' } }]]) {
      let caught: unknown = null;
      try {
        frontmostWindows(undefined, open);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(NoActiveWindowError);
    }
  });
});

/* ------------------------------------------------------ the Windows helper */

describe('parseWinLine', () => {
  it('converts a helper line into the shape the decision takes', () => {
    const line =
      '{"pid":4712,"name":"vlc","rect":{"l":0,"t":0,"r":1920,"b":1080},' +
      '"monitor":{"l":0,"t":0,"r":1920,"b":1080}}';
    expect(parseWinLine(line)).toEqual({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      ownerName: 'vlc',
      ownerProcessId: 4712,
      monitor: { x: 0, y: 0, width: 1920, height: 1080 }
    });
  });

  it('handles a window on a secondary monitor, where the origin is not 0,0', () => {
    // Win32 reports virtual-screen coordinates, so a left-hand second monitor
    // has negative ones — and `r`/`b` are edges, not extents.
    const line =
      '{"pid":9,"name":"chrome","rect":{"l":-1920,"t":-120,"r":0,"b":960},' +
      '"monitor":{"l":-1920,"t":-120,"r":0,"b":960}}';
    expect(parseWinLine(line)).toEqual({
      bounds: { x: -1920, y: -120, width: 1920, height: 1080 },
      ownerName: 'chrome',
      ownerProcessId: 9,
      monitor: { x: -1920, y: -120, width: 1920, height: 1080 }
    });
  });

  it('carries the helper’s physical-pixels flag only when it is exactly 1 or true (audit M3)', () => {
    const base = '{"pid":9,"name":"vlc","rect":{"l":0,"t":0,"r":1920,"b":1200}';
    expect(parseWinLine(`${base},"physical":1}`)?.physical).toBe(true);
    expect(parseWinLine(`${base},"physical":true}`)?.physical).toBe(true);
    for (const other of ['', ',"physical":0', ',"physical":"1"', ',"physical":2']) {
      expect(parseWinLine(`${base}${other}}`), other).not.toHaveProperty('physical');
    }
  });

  it('reads the helper’s own "nothing is focused" line as no window', () => {
    const none =
      '{"pid":0,"name":"","rect":{"l":0,"t":0,"r":0,"b":0},' +
      '"monitor":{"l":0,"t":0,"r":0,"b":0}}';
    expect(parseWinLine(none)).toBeNull();
  });

  it('drops a line it cannot use, rather than throwing', () => {
    for (const line of [
      '',
      '   ',
      'not json',
      '{',
      '[]',
      'null',
      '{"pid":1}',
      '{"pid":1,"rect":{"l":0,"t":0}}',
      '{"pid":1,"rect":{"l":0,"t":0,"r":"x","b":10}}',
      // Zero and negative area: a minimised window reports a rect like this.
      '{"pid":1,"rect":{"l":10,"t":10,"r":10,"b":400}}',
      '{"pid":1,"rect":{"l":400,"t":10,"r":10,"b":400}}'
    ]) {
      expect(parseWinLine(line), JSON.stringify(line)).toBeNull();
    }
  });

  it('tolerates a missing name, pid or monitor', () => {
    expect(parseWinLine('{"rect":{"l":0,"t":0,"r":100,"b":50}}')).toEqual({
      bounds: { x: 0, y: 0, width: 100, height: 50 },
      ownerName: ''
    });
    // A zero-area monitor rect (GetMonitorInfo failed) is dropped, not kept.
    expect(
      parseWinLine('{"pid":3,"name":"x","rect":{"l":0,"t":0,"r":100,"b":50},"monitor":{"l":0,"t":0,"r":0,"b":0}}')
    ).toEqual({
      bounds: { x: 0, y: 0, width: 100, height: 50 },
      ownerName: 'x',
      ownerProcessId: 3
    });
  });

  it('carries the window class when the helper reports one (M5), and only then', () => {
    const line =
      '{"pid":5100,"name":"explorer","cls":"Shell_TrayWnd","rect":{"l":0,"t":1152,"r":1920,"b":1200},' +
      '"monitor":{"l":0,"t":0,"r":1920,"b":1200}}';
    expect(parseWinLine(line)).toEqual({
      bounds: { x: 0, y: 1152, width: 1920, height: 48 },
      ownerName: 'explorer',
      ownerProcessId: 5100,
      monitor: { x: 0, y: 0, width: 1920, height: 1200 },
      windowClass: 'Shell_TrayWnd'
    });
    // An empty class (GetClassName failed) and a non-string one read as none,
    // exactly like a line from a helper that predates the field.
    for (const cls of ['""', '7', 'null']) {
      const info = parseWinLine(`{"pid":5,"name":"explorer","cls":${cls},"rect":{"l":0,"t":0,"r":10,"b":10}}`);
      expect(info, cls).not.toBeNull();
      expect(info).not.toHaveProperty('windowClass');
    }
  });
});

describe('createFullscreenWatch: a Windows shell surface over a film (M5)', () => {
  const FILM_WIN = { bounds: DISPLAY, ownerName: 'chrome', ownerProcessId: 999, windowClass: 'Chrome_WidgetWin_1' };
  const FLYOUT = {
    bounds: { x: 1100, y: 700, width: 300, height: 160 },
    ownerName: 'explorer',
    ownerProcessId: 5100,
    windowClass: 'TopLevelWindowForOverflowXamlIsland'
  };
  const TASKBAR = {
    bounds: { x: 0, y: 852, width: 1440, height: 48 },
    ownerName: 'explorer',
    ownerProcessId: 5100,
    windowClass: 'Shell_TrayWnd'
  };
  const DESKTOP_WIN = { bounds: DISPLAY, ownerName: 'explorer', ownerProcessId: 5100, windowClass: 'Progman' };

  /** A watch over a scripted Windows-shaped probe and an injected clock. */
  function shellWatcher(): {
    show: (win: unknown) => void;
    poll: () => Promise<void>;
    flips: boolean[];
  } {
    let clock = 0;
    let current: unknown = FILM_WIN;
    const flips: boolean[] = [];
    const watch = createFullscreenWatch({
      onChange: (fullscreen) => flips.push(fullscreen),
      enabled: () => true,
      displays: () => [DISPLAY],
      dogDisplay: () => DISPLAY,
      self: () => SELF,
      now: () => clock,
      probe: async () => current as never
    });
    return {
      show: (win) => (current = win),
      poll: async () => {
        clock += POLL_MS;
        await watch.pollNow();
      },
      flips
    };
  }

  async function pollFor(w: { poll: () => Promise<void> }, ms: number): Promise<void> {
    for (let t = 0; t < ms; t += POLL_MS) await w.poll();
  }

  it('stays asleep with the overflow flyout open for 10 s, and through the return to the film', async () => {
    const w = shellWatcher();
    await pollFor(w, 2 * POLL_MS);
    expect(w.flips).toEqual([true]);
    w.show(FLYOUT);
    await pollFor(w, 10_000);
    expect(w.flips).toEqual([true]);
    w.show(FILM_WIN);
    await pollFor(w, 10_000);
    expect(w.flips).toEqual([true]);
  });

  it('still wakes for the real desktop after two polls', async () => {
    const w = shellWatcher();
    await pollFor(w, 2 * POLL_MS);
    w.show(DESKTOP_WIN);
    await w.poll();
    expect(w.flips).toEqual([true]);
    await w.poll();
    expect(w.flips).toEqual([true, false]);
  });

  it('wakes within the bound when the player closes onto the taskbar', async () => {
    const w = shellWatcher();
    await pollFor(w, 2 * POLL_MS);
    w.show(TASKBAR);
    await pollFor(w, SHELL_HOLD_MAX_MS - POLL_MS);
    expect(w.flips, 'woke inside the shell hold').toEqual([true]);
    await pollFor(w, SHELL_HOLD_MAX_MS);
    expect(w.flips).toEqual([true, false]);
  });

  it('logs the hold once per episode and the expiry once, not every poll', async () => {
    const { setLogSink, setVerbose } = await import('../src/main/log');
    const lines: string[] = [];
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setVerbose(true);
    setLogSink((line) => lines.push(line));
    try {
      const w = shellWatcher();
      await pollFor(w, 2 * POLL_MS);
      w.show(TASKBAR);
      await pollFor(w, 3 * SHELL_HOLD_MAX_MS);
    } finally {
      setLogSink(null);
      setVerbose(false);
      quiet.mockRestore();
    }
    const shellLines = lines.filter((l) => l.includes('shell surface'));
    expect(shellLines).toHaveLength(2);
    expect(shellLines[0]).toContain('Shell_TrayWnd');
    expect(shellLines[0]).toContain('holding fullscreen');
    expect(shellLines[1]).toContain('not fullscreen');
  });

  /** Run `body` with verbose logging captured into an array of lines. */
  async function captureLog(body: () => Promise<void>): Promise<string[]> {
    const { setLogSink, setVerbose } = await import('../src/main/log');
    const lines: string[] = [];
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setVerbose(true);
    setLogSink((line) => lines.push(line));
    try {
      await body();
    } finally {
      setLogSink(null);
      setVerbose(false);
      quiet.mockRestore();
    }
    return lines.filter((l) => l.includes('shell surface') && l.includes('is in front'));
  }

  it('names a long listed class readably, and never prints an unlisted class (M5b)', async () => {
    // A host-owned window whose class is secret-shaped: still held (the owner
    // decides), but its class must never reach the log verbatim.
    const secret = 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const smuggler = { ...FLYOUT, ownerName: 'ShellHost', windowClass: secret };
    const lines = await captureLog(async () => {
      const w = shellWatcher();
      await pollFor(w, 2 * POLL_MS);
      w.show(FLYOUT);
      await w.poll();
      w.show(FILM_WIN);
      await w.poll();
      w.show(smuggler);
      await w.poll();
    });
    expect(lines).toHaveLength(2);
    // Before M5b this line read `([redacted])`.
    expect(lines[0]).not.toContain('[redacted]');
    expect(lines[0]).toContain('Top Level Window For Overflow Xaml Island');
    expect(lines[0]).toContain('owner explorer');
    expect(lines[1]).not.toContain(secret);
    expect(lines[1]).not.toContain('sk-ant');
    expect(lines[1]).toContain(`an unlisted class of ${secret.length} characters`);
    expect(lines[1]).toContain('owner ShellHost');
  });

  it('logs each distinct surface once within an episode, not every poll (M5b)', async () => {
    // Win+B, then Enter: taskbar -> overflow flyout without leaving the shell,
    // then back to the taskbar. Before M5b only the taskbar was ever named.
    const lines = await captureLog(async () => {
      const w = shellWatcher();
      await pollFor(w, 2 * POLL_MS);
      w.show(TASKBAR);
      await pollFor(w, 3 * POLL_MS);
      w.show(FLYOUT);
      await pollFor(w, 3 * POLL_MS);
      w.show(TASKBAR);
      await pollFor(w, 3 * POLL_MS);
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Shell_TrayWnd');
    expect(lines[1]).toContain('Top Level Window For Overflow Xaml Island');
  });

  it('every listed class and owner survives the real redactor on the hold line (M5b)', async () => {
    // The lists in core/fullscreen.ts, spelled out: a name added there that the
    // redactor would still mask after spacing (one word of 20+ characters) must
    // fail here rather than quietly log as "an unlisted class".
    const { redact } = await import('../src/main/log');
    const { logSafeName, shellSurfaceLabel } = await import('../src/main/fullscreen-watch');
    const { knownShellSurface } = await import('../src/core/fullscreen');
    const explorerClasses = [
      'Shell_TrayWnd',
      'Shell_SecondaryTrayWnd',
      'NotifyIconOverflowWindow',
      'TopLevelWindowForOverflowXamlIsland',
      'XamlExplorerHostIslandWindow',
      'MultitaskingViewFrame',
      'TaskListThumbnailWnd',
      'ForegroundStaging'
    ];
    const hosts = [
      'StartMenuExperienceHost',
      'SearchHost',
      'SearchApp',
      'ShellExperienceHost',
      'ShellHost',
      'TextInputHost',
      'WidgetBoard'
    ];
    const hostClasses = ['Windows.UI.Core.CoreWindow', 'ControlCenterWindow', 'WindowsDashboard'];
    const pairs = [
      ...explorerClasses.map((cls) => ['explorer', cls] as const),
      ...hosts.flatMap((host) => hostClasses.map((cls) => [host, cls] as const))
    ];
    for (const [owner, cls] of pairs) {
      // Reported in another case, as a window might: the label is the listed spelling.
      const surface = knownShellSurface({
        ...FLYOUT,
        ownerName: ` ${owner.toUpperCase()} `,
        windowClass: ` ${cls.toLowerCase()} `
      });
      expect(surface, `${owner}/${cls}`).toEqual({ owner, windowClass: cls, classLength: cls.length });
      if (surface === null) continue;
      const line = `a shell surface (${shellSurfaceLabel(surface)}) is in front`;
      expect(redact(line), `${owner}/${cls}`).toBe(line);
      expect(line).not.toContain('unlisted');
      expect(logSafeName(cls)?.replace(/ /g, '')).toBe(cls);
      expect(logSafeName(owner)?.replace(/ /g, '')).toBe(owner);
    }
  });
});

/** A stand-in for the PowerShell child process. */
function fakeChild(): {
  child: Parameters<typeof createWinProbe>[0] extends { spawn: () => infer C } ? C : never;
  emit: (text: string) => void;
  exit: (code: number) => void;
  fail: (message: string) => void;
  stdinEnded: () => boolean;
  killed: () => number;
} {
  const listeners = { data: [] as ((chunk: unknown) => void)[] };
  const lifecycle = new Map<string, ((...args: unknown[]) => void)[]>();
  let stdinEnded = false;
  let kills = 0;

  const child = {
    stdout: {
      on: (_event: 'data', listener: (chunk: unknown) => void) => listeners.data.push(listener)
    },
    stderr: { on: (): unknown => undefined },
    stdin: {
      end: (): void => {
        stdinEnded = true;
      }
    },
    on: (event: 'exit' | 'error' | 'close', listener: (...args: unknown[]) => void): unknown => {
      const list = lifecycle.get(event) ?? [];
      list.push(listener);
      lifecycle.set(event, list);
      return undefined;
    },
    kill: (): unknown => {
      kills++;
      return true;
    }
  };

  return {
    child: child as never,
    emit: (text: string) => listeners.data.forEach((fn) => fn(Buffer.from(text))),
    exit: (code: number) => (lifecycle.get('exit') ?? []).forEach((fn) => fn(code)),
    fail: (message: string) =>
      (lifecycle.get('error') ?? []).forEach((fn) => fn(new Error(message))),
    stdinEnded: () => stdinEnded,
    killed: () => kills
  };
}

const FULL_LINE =
  '{"pid":4712,"name":"vlc","rect":{"l":0,"t":0,"r":1440,"b":900},' +
  '"monitor":{"l":0,"t":0,"r":1440,"b":900}}';

describe('createWinProbe', () => {
  it('spawns the helper once, however many times it is probed', async () => {
    const fake = fakeChild();
    let spawns = 0;
    let clock = 1_000;
    const probe = createWinProbe({
      spawn: () => {
        spawns++;
        return fake.child;
      },
      now: () => clock
    });

    // The first probe starts the helper and has nothing to report yet.
    expect(await probe.probe()).toBeNull();
    expect(spawns).toBe(1);

    fake.emit(`${FULL_LINE}\n`);
    for (let i = 0; i < 5; i++) {
      clock += 2_000;
      fake.emit(`${FULL_LINE}\n`);
      expect(await probe.probe()).toEqual({
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        ownerName: 'vlc',
        ownerProcessId: 4712,
        monitor: { x: 0, y: 0, width: 1440, height: 900 }
      });
    }
    expect(spawns, 'the helper was respawned').toBe(1);
    probe.stop();
  });

  it('reassembles lines split across chunks, and keeps only the newest', async () => {
    const fake = fakeChild();
    const probe = createWinProbe({ spawn: () => fake.child, now: () => 0 });
    await probe.probe();

    // A stream, not a message queue: one line can arrive in three writes.
    fake.emit('{"pid":1,"name":"a","rect":{"l":0,"t":0,');
    expect(await probe.probe()).toBeNull();
    fake.emit('"r":100,"b":50}}');
    // Still no newline, so still nothing.
    expect(await probe.probe()).toBeNull();
    fake.emit('\n');
    expect(await probe.probe()).toEqual({
      bounds: { x: 0, y: 0, width: 100, height: 50 },
      ownerName: 'a',
      ownerProcessId: 1
    });

    // Two lines in one chunk: the last one wins, because the watch wants the
    // *current* state and not a backlog.
    fake.emit(`{"pid":2,"name":"b","rect":{"l":0,"t":0,"r":10,"b":10}}\n${FULL_LINE}\n`);
    expect((await probe.probe())?.ownerName).toBe('vlc');
    probe.stop();
  });

  it('reports a helper that died as a probe failure', async () => {
    const fake = fakeChild();
    const probe = createWinProbe({ spawn: () => fake.child, now: () => 0 });
    await probe.probe();
    fake.emit(`${FULL_LINE}\n`);
    expect(await probe.probe()).not.toBeNull();

    fake.exit(1);
    await expect(probe.probe()).rejects.toThrow(/exited/u);
    // And it stays failed rather than respawning every two seconds forever.
    await expect(probe.probe()).rejects.toThrow(/exited/u);
    probe.stop();
  });

  it('reports a helper that could not be started at all', async () => {
    const fake = fakeChild();
    const probe = createWinProbe({ spawn: () => fake.child, now: () => 0 });
    await probe.probe();
    fake.fail('spawn powershell.exe ENOENT');
    await expect(probe.probe()).rejects.toThrow(/ENOENT/u);
    probe.stop();
  });

  it('treats a helper that stops reporting as wedged', async () => {
    const fake = fakeChild();
    let clock = 0;
    const probe = createWinProbe({ spawn: () => fake.child, now: () => clock });
    await probe.probe();
    fake.emit(`${FULL_LINE}\n`);
    expect(await probe.probe()).not.toBeNull();

    clock += HELPER_MAX_AGE_MS;
    expect(await probe.probe(), 'still fresh at exactly the limit').not.toBeNull();
    clock += 1;
    await expect(probe.probe()).rejects.toThrow(/wedged/u);
    probe.stop();
  });

  it('treats a helper that never speaks as wedged, measured from the spawn', async () => {
    const fake = fakeChild();
    let clock = 0;
    const probe = createWinProbe({ spawn: () => fake.child, now: () => clock });
    expect(await probe.probe()).toBeNull();
    clock += HELPER_MAX_AGE_MS;
    expect(await probe.probe()).toBeNull();
    clock += 1;
    await expect(probe.probe()).rejects.toThrow(/wedged/u);
    probe.stop();
  });

  it('closes stdin and then kills, and refuses to probe after that', async () => {
    const fake = fakeChild();
    const probe = createWinProbe({ spawn: () => fake.child, now: () => 0 });
    await probe.probe();
    expect(fake.stdinEnded()).toBe(false);

    probe.stop();
    // Closing stdin is how the script is meant to exit; the kill is a backstop.
    expect(fake.stdinEnded()).toBe(true);
    expect(fake.killed()).toBe(1);

    await expect(probe.probe()).rejects.toThrow(/stopped/u);
    // Stopping twice is safe and does not kill twice.
    probe.stop();
    expect(fake.killed()).toBe(1);
  });

  it('is a no-op to stop a probe that never spawned anything', () => {
    const fake = fakeChild();
    const probe = createWinProbe({ spawn: () => fake.child, now: () => 0 });
    probe.stop();
    expect(fake.killed()).toBe(0);
    expect(fake.stdinEnded()).toBe(false);
  });
});

describe('the Windows probe, wired into the watch (audit M3)', () => {
  // One 1920 × 1200 display at 125 %: 1536 × 960 in Electron's DIPs.
  const DIP: Rect = { x: 0, y: 0, width: 1536, height: 960 };
  const PHYSICAL: Rect = { x: 0, y: 0, width: 1920, height: 1200 };
  const line = (r: number, b: number, flag: string): string =>
    `{"pid":4712,"name":"vlc","rect":{"l":0,"t":0,"r":${r},"b":${b}},` +
    `"monitor":{"l":0,"t":0,"r":${r},"b":${b}}${flag}}\n`;

  function winWatch(): {
    fake: ReturnType<typeof fakeChild>;
    flips: boolean[];
    poll: () => Promise<void>;
    stop: () => void;
  } {
    const fake = fakeChild();
    const flips: boolean[] = [];
    const watch = createFullscreenWatch({
      onChange: (fullscreen) => flips.push(fullscreen),
      enabled: () => true,
      platform: 'win32',
      spawnWinHelper: () => fake.child,
      displays: () => [DIP],
      winDisplays: () => [{ dip: DIP, physical: PHYSICAL }],
      dogDisplay: () => DIP,
      self: () => SELF
    });
    return { fake, flips, poll: () => watch.pollNow(), stop: () => watch.stop() };
  }

  it('maps a physical-pixel film onto the dog’s DIP display, and he sleeps', async () => {
    const w = winWatch();
    await w.poll(); // spawns the helper; nothing to read yet
    w.fake.emit(line(1920, 1200, ',"physical":1'));
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([true]);
    w.stop();
  });

  it('does not sleep for a physical window that only covers the display in raw numbers', async () => {
    const w = winWatch();
    await w.poll();
    // 1600 × 1000 physical is 1280 × 800 DIPs: a window, not a film. Unmapped,
    // its raw numbers would cover the 1536 × 960 display and sleep him.
    w.fake.emit(line(1600, 1000, ',"physical":1'));
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([]);
    w.stop();
  });

  it('leaves an unflagged (logical) line unscaled, so an old helper still works', async () => {
    const w = winWatch();
    await w.poll();
    w.fake.emit(line(1536, 960, ''));
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([true]);
    w.stop();
  });
});

describe('the Windows probe: DPI mapping and the shell-surface hold together (audit M3 x M5)', () => {
  // One 1920 × 1200 display at 125 %: 1536 × 960 in Electron's DIPs.
  const DIP: Rect = { x: 0, y: 0, width: 1536, height: 960 };
  const PHYSICAL: Rect = { x: 0, y: 0, width: 1920, height: 1200 };
  /** A display list that does not contain the monitor the helper reports. */
  const ELSEWHERE = [
    { dip: { x: 0, y: 0, width: 1280, height: 720 }, physical: { x: 5000, y: 0, width: 1280, height: 720 } }
  ];
  type Edges = { l: number; t: number; r: number; b: number };
  const SCREEN: Edges = { l: 0, t: 0, r: 1920, b: 1200 };
  const ZERO: Edges = { l: 0, t: 0, r: 0, b: 0 };

  /** One helper line as the combined helper writes it: `cls` *and* `physical`. */
  const helperLine = (o: { name: string; cls: string; rect: Edges }): string =>
    JSON.stringify({ pid: 4712, name: o.name, cls: o.cls, rect: o.rect, monitor: SCREEN, physical: 1 }) + '\n';

  const FILM = helperLine({ name: 'vlc', cls: 'Qt5QWindowIcon', rect: SCREEN });
  // The Windows 11 tray overflow flyout, in physical pixels near the clock.
  const FLYOUT = helperLine({
    name: 'explorer',
    cls: 'TopLevelWindowForOverflowXamlIsland',
    rect: { l: 1500, t: 900, r: 1860, b: 1130 }
  });
  const TASKBAR = helperLine({ name: 'explorer', cls: 'Shell_TrayWnd', rect: { l: 0, t: 1140, r: 1920, b: 1200 } });
  const DESKTOP = helperLine({ name: 'explorer', cls: 'Progman', rect: SCREEN });

  /** The full wired path — fake helper, M3's mapping, M5's hold — on an injected clock. */
  function comboWatch(): {
    fake: ReturnType<typeof fakeChild>;
    flips: boolean[];
    poll: () => Promise<void>;
    pollFor: (ms: number) => Promise<void>;
    setDisplays: (d: { dip: Rect; physical: Rect }[]) => void;
    stop: () => void;
  } {
    const fake = fakeChild();
    const flips: boolean[] = [];
    let clock = 0;
    let units = [{ dip: DIP, physical: PHYSICAL }];
    const watch = createFullscreenWatch({
      onChange: (fullscreen) => flips.push(fullscreen),
      enabled: () => true,
      platform: 'win32',
      spawnWinHelper: () => fake.child,
      displays: () => [DIP],
      winDisplays: () => units,
      dogDisplay: () => DIP,
      self: () => SELF,
      now: () => clock
    });
    const poll = async (): Promise<void> => {
      clock += POLL_MS;
      await watch.pollNow();
    };
    return {
      fake,
      flips,
      poll,
      pollFor: async (ms) => {
        for (let t = 0; t < ms; t += POLL_MS) await poll();
      },
      setDisplays: (d) => (units = d),
      stop: () => watch.stop()
    };
  }

  /** Spawn the helper and fall asleep over the physical-pixel film. */
  async function asleep(): Promise<ReturnType<typeof comboWatch>> {
    const w = comboWatch();
    await w.poll(); // spawns the helper; nothing to read yet
    w.fake.emit(FILM);
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([true]);
    return w;
  }

  it('holds a physical-flagged shell-class line over a film on a 125 % display', async () => {
    const w = await asleep();
    w.fake.emit(FLYOUT);
    await w.pollFor(10_000);
    expect(w.flips).toEqual([true]);
    w.fake.emit(FILM);
    await w.pollFor(10_000);
    expect(w.flips).toEqual([true]);
    w.stop();
  });

  it('ends fullscreen for a physical-flagged Progman line after the usual two polls', async () => {
    const w = await asleep();
    w.fake.emit(DESKTOP);
    await w.poll();
    expect(w.flips).toEqual([true]);
    await w.poll();
    expect(w.flips).toEqual([true, false]);
    w.stop();
  });

  it('keeps the hold when the shell surface cannot be placed on any known display', async () => {
    const w = await asleep();
    // Electron's display list no longer contains the monitor the helper
    // reported (mid-reconfiguration): M3 alone reads that as "no window".
    w.setDisplays(ELSEWHERE);
    w.fake.emit(FLYOUT);
    await w.pollFor(10_000);
    expect(w.flips, 'an unplaceable shell surface woke him').toEqual([true]);
    w.stop();
  });

  it('still reads an ordinary window on no known display as no window', async () => {
    const w = await asleep();
    w.setDisplays(ELSEWHERE);
    w.fake.emit(FILM);
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([true, false]);
    w.stop();
  });

  it('keeps an unplaceable shell hold bounded: the taskbar still wakes him after the bound', async () => {
    const w = await asleep();
    w.setDisplays(ELSEWHERE);
    w.fake.emit(TASKBAR);
    await w.pollFor(SHELL_HOLD_MAX_MS - POLL_MS);
    expect(w.flips).toEqual([true]);
    await w.pollFor(SHELL_HOLD_MAX_MS);
    expect(w.flips).toEqual([true, false]);
    w.stop();
  });

  it('holds for a shell surface whose rect could not be read (zero rect), but not for an ordinary one', async () => {
    const w = await asleep();
    w.fake.emit(helperLine({ name: 'explorer', cls: 'ForegroundStaging', rect: ZERO }));
    await w.pollFor(10_000);
    expect(w.flips).toEqual([true]);
    w.fake.emit(helperLine({ name: 'vlc', cls: 'Qt5QWindowIcon', rect: ZERO }));
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([true, false]);
    w.stop();
  });
});

describe('parseWinLine and winSampleToDip with both fields (audit M3 x M5)', () => {
  const TRAY_LINE =
    '{"pid":5100,"name":"explorer","cls":"Shell_TrayWnd","rect":{"l":0,"t":1140,"r":1920,"b":1200},' +
    '"monitor":{"l":0,"t":0,"r":1920,"b":1200},"physical":1}';

  it('reads cls and physical off the same line', () => {
    expect(parseWinLine(TRAY_LINE)).toEqual({
      bounds: { x: 0, y: 1140, width: 1920, height: 60 },
      ownerName: 'explorer',
      ownerProcessId: 5100,
      monitor: { x: 0, y: 0, width: 1920, height: 1200 },
      windowClass: 'Shell_TrayWnd',
      physical: true
    });
  });

  it('keeps the class through the physical-to-DIP mapping', () => {
    const dip = winSampleToDip(parseWinLine(TRAY_LINE), () => [
      { dip: { x: 0, y: 0, width: 1536, height: 960 }, physical: { x: 0, y: 0, width: 1920, height: 1200 } }
    ]);
    expect(dip).toEqual({
      bounds: { x: 0, y: 912, width: 1536, height: 48 },
      ownerName: 'explorer',
      ownerProcessId: 5100,
      monitor: { x: 0, y: 0, width: 1536, height: 960 },
      windowClass: 'Shell_TrayWnd'
    });
  });

  it('passes an unplaceable shell sample through unmapped, and drops an unplaceable ordinary one', () => {
    const elsewhere = () => [
      { dip: { x: 0, y: 0, width: 1280, height: 720 }, physical: { x: 5000, y: 0, width: 1280, height: 720 } }
    ];
    expect(winSampleToDip(parseWinLine(TRAY_LINE), elsewhere)?.windowClass).toBe('Shell_TrayWnd');
    expect(winSampleToDip(parseWinLine(TRAY_LINE.replace('Shell_TrayWnd', 'CabinetWClass')), elsewhere)).toBeNull();
  });

  it('drops a zero-rect line unless it is a shell surface', () => {
    const zero = '"rect":{"l":0,"t":0,"r":0,"b":0}';
    expect(parseWinLine(`{"pid":7,"name":"vlc","cls":"Qt5QWindowIcon",${zero},"physical":1}`)).toBeNull();
    expect(parseWinLine(`{"pid":7,"name":"explorer","cls":"CabinetWClass",${zero},"physical":1}`)).toBeNull();
    expect(parseWinLine(`{"pid":7,"name":"explorer",${zero},"physical":1}`)).toBeNull();
    expect(parseWinLine(`{"pid":7,"name":"explorer","cls":"Shell_TrayWnd",${zero},"physical":1}`)?.windowClass).toBe(
      'Shell_TrayWnd'
    );
    // The helper's own no-window line is still no window.
    expect(
      parseWinLine('{"pid":0,"name":"","rect":{"l":0,"t":0,"r":0,"b":0},"monitor":{"l":0,"t":0,"r":0,"b":0}}')
    ).toBeNull();
  });
});

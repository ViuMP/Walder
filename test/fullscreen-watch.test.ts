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
  UNKNOWN_HOLD_MS,
  WARN_AFTER_FAILURES,
  createFullscreenWatch,
  createWinProbe,
  parseWinLine
} = await import('../src/main/fullscreen-watch');

type Rect = { x: number; y: number; width: number; height: number };

const DISPLAY: Rect = { x: 0, y: 0, width: 1440, height: 900 };
const OTHER: Rect = { x: 1440, y: 0, width: 1920, height: 1080 };
const SELF = { names: ['Walder'], processId: 1 };

/** One entry of a probe script: some windows, none, or a failure. */
type Step = { bounds: Rect; owner?: string } | { windows: Rect[]; owner?: string } | null | 'throw';

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

  it('holds the last state while the probe cannot answer, then lets it decay', async () => {
    let clock = 0;
    const w = watcher([FULL, FULL, 'throw'], { now: () => clock });
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

  it('rides out the three-sample Space transition without flapping or dying', async () => {
    let clock = 0;
    // Exactly what was recorded: an ordinary window, the transition (three
    // `undefined` in a row), the sliding animation, then the settled pair.
    const w = mac(
      [
        { bounds: DESKTOP, owner: 'Google Chrome' },
        { bounds: DESKTOP, owner: 'Google Chrome' },
        'throw',
        'throw',
        'throw',
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

  it('wakes once the video leaves fullscreen, transition and all', async () => {
    let clock = 0;
    const w = mac(
      [
        chrome(TOOLBAR, VIDEO),
        chrome(TOOLBAR, VIDEO),
        'throw',
        'throw',
        'throw',
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

/**
 * The fullscreen watch: the polling shell around the pure decision.
 *
 * The probe is injected, so none of this touches `get-windows`, PowerShell or
 * the OS. What is asserted is the behaviour that only exists at this level:
 *
 *  - **fail-soft.** A probe that throws — a missing binary, an unsupported
 *    platform, a refused spawn — means "we cannot tell", which must read as *not*
 *    fullscreen. The worst case is then that the dog stays visible over a film,
 *    which is the status quo; a crash or a repeated system prompt is not.
 *  - **it gives up.** Three consecutive failures stop the polling for the
 *    session: a missing binary will not appear halfway through an afternoon, and
 *    a probe firing every two seconds forever is exactly the idle wakeup this
 *    project measures. Turning the tray switch off and on again resets that.
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
  HELPER_MAX_AGE_MS,
  MAX_FAILURES,
  createFullscreenWatch,
  createWinProbe,
  parseWinLine
} = await import('../src/main/fullscreen-watch');

const DISPLAY = { x: 0, y: 0, width: 1440, height: 900 };
const OTHER = { x: 1440, y: 0, width: 1920, height: 1080 };
const SELF = { names: ['Walder'], processId: 1 };

/** A watch whose probe answers from a script, one entry per poll. */
function watcher(
  script: readonly (
    | { bounds: typeof DISPLAY; owner?: string }
    | null
    | 'throw'
  )[],
  opts: {
    enabled?: () => boolean;
    displays?: () => (typeof DISPLAY)[];
    dogDisplay?: () => typeof DISPLAY | null;
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
    displays: opts.displays ?? ((): (typeof DISPLAY)[] => [DISPLAY]),
    ...(opts.dogDisplay === undefined ? {} : { dogDisplay: opts.dogDisplay }),
    self: () => SELF,
    probe: async () => {
      // The last entry repeats, so a script says "then keep answering this".
      const step = script[Math.min(index, script.length - 1)] ?? null;
      index++;
      if (step === 'throw') throw new Error('no such binary');
      if (step === null) return null;
      return {
        bounds: step.bounds,
        ownerName: step.owner ?? 'Safari',
        ownerProcessId: 999
      };
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

  it('reports the way back out when the probe starts failing mid-video', async () => {
    const w = watcher([FULL, FULL, 'throw', 'throw']);
    await w.poll();
    await w.poll();
    expect(w.flips).toEqual([true]);
    await w.poll();
    await w.poll();
    // Two failures debounce out of fullscreen, so the dog comes back rather
    // than staying asleep on the strength of a reading we can no longer take.
    expect(w.flips).toEqual([true, false]);
  });

  it('gives up after a run of failures instead of polling forever', async () => {
    const w = watcher(['throw']);
    for (let i = 0; i < MAX_FAILURES + 4; i++) await w.poll();
    expect(w.polls()).toBe(MAX_FAILURES);
  });

  it('forgets the failures as soon as one probe succeeds', async () => {
    const w = watcher(['throw', 'throw', WINDOWED, 'throw', 'throw', FULL, FULL]);
    for (let i = 0; i < 7; i++) await w.poll();
    expect(w.polls()).toBe(7);
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

  it('clears a given-up watch when switched on again', async () => {
    let broken = true;
    let polls = 0;
    const watch = createFullscreenWatch({
      onChange: () => undefined,
      enabled: () => true,
      displays: () => [DISPLAY],
      self: () => SELF,
      probe: async () => {
        polls++;
        if (broken) throw new Error('no such binary');
        return { bounds: DISPLAY, ownerName: 'Safari', ownerProcessId: 999 };
      }
    });

    // Break it: three failures and it stops trying.
    for (let i = 0; i < MAX_FAILURES + 3; i++) await watch.pollNow();
    expect(polls).toBe(MAX_FAILURES);

    // Whatever fixed it (a login, a permission, a reinstall) is invisible from
    // here, so the switch has to be what retries.
    broken = false;
    watch.setEnabled(true);
    await watch.pollNow();
    expect(polls).toBe(MAX_FAILURES + 1);
    await watch.pollNow();
    expect(watch.isFullscreen()).toBe(true);
    watch.stop();
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

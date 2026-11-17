/**
 * The fullscreen decision: bounds arithmetic and the debounce.
 *
 * The bugs this is written against are all false positives, because a false
 * positive is the expensive direction — it makes Walder disappear while the
 * owner is working, which is indistinguishable from a crash:
 *  - an ordinary maximised window (menu bar or taskbar still visible) is not
 *    fullscreen;
 *  - nor is one on Windows with the taskbar on auto-hide, which covers the whole
 *    display and hangs off every edge of it by its resize border (W6);
 *  - the *desktop* covers the whole display by definition and must not count;
 *  - Walder's own always-on-top window can genuinely be the active window on
 *    macOS, and counting it would be a loop;
 *  - a single sample taken mid-animation, while a video is halfway into
 *    fullscreen, must not flip anything.
 */
import { describe, expect, it } from 'vitest';
import {
  DEBOUNCE_INITIAL,
  DEBOUNCE_POLLS,
  FULLSCREEN_TOLERANCE_PX,
  MAXIMISED_OVERHANG_MIN_PX,
  MENU_BAR_MAX_PX,
  coversDisplay,
  coversDisplayAllowingMenuBar,
  debounceFullscreen,
  displayFor,
  isDesktopOwner,
  isFullscreenWindow,
  isFullscreenWindows,
  overhangsEveryEdge,
  readFullscreen,
  SHELL_HOLD_INITIAL,
  SHELL_HOLD_MAX_MS,
  boundShellHold,
  isShellSurface,
  knownShellSurface,
  shellInFront,
  type ActiveWindowInfo,
  type DebounceState,
  type SelfIdentity,
  type ShellHoldState
} from '../src/core/fullscreen';
import type { Rect } from '../src/core/geometry';

const LAPTOP: Rect = { x: 0, y: 0, width: 1440, height: 900 };
const EXTERNAL: Rect = { x: 1440, y: 0, width: 1920, height: 1080 };
const DISPLAYS = [LAPTOP, EXTERNAL];

const SELF: SelfIdentity = { names: ['Walder', 'Electron'], processId: 4242 };

function win(bounds: Rect, ownerName = 'Safari', ownerProcessId = 999): ActiveWindowInfo {
  return { bounds, ownerName, ownerProcessId };
}

describe('coversDisplay', () => {
  it('accepts an exact match', () => {
    expect(coversDisplay(LAPTOP, LAPTOP)).toBe(true);
  });

  it('accepts a window short by the tolerance on every edge', () => {
    const short = {
      x: FULLSCREEN_TOLERANCE_PX,
      y: FULLSCREEN_TOLERANCE_PX,
      width: LAPTOP.width - 2 * FULLSCREEN_TOLERANCE_PX,
      height: LAPTOP.height - 2 * FULLSCREEN_TOLERANCE_PX
    };
    expect(coversDisplay(short, LAPTOP)).toBe(true);
  });

  it('rejects a window one pixel past the tolerance', () => {
    const nearly = {
      x: 0,
      y: 0,
      width: LAPTOP.width,
      height: LAPTOP.height - FULLSCREEN_TOLERANCE_PX - 1
    };
    expect(coversDisplay(nearly, LAPTOP)).toBe(false);
  });

  it('rejects an ordinary maximised window that leaves the menu bar showing', () => {
    // 25 px of menu bar: the common false positive.
    expect(coversDisplay({ x: 0, y: 25, width: 1440, height: 875 }, LAPTOP)).toBe(false);
  });

  it('accepts a window larger than the display', () => {
    expect(coversDisplay({ x: -10, y: -10, width: 1500, height: 950 }, LAPTOP)).toBe(true);
  });

  it('measures against the display it is on, on the second monitor', () => {
    expect(coversDisplay(EXTERNAL, EXTERNAL)).toBe(true);
    expect(coversDisplay(EXTERNAL, LAPTOP)).toBe(false);
  });
});

/**
 * The shape of a maximised Windows window with no taskbar reserved: past every
 * edge of the display by its resize border (W6). Pure arithmetic here; the
 * measured windows are further down, under "a maximised Windows window…".
 */
describe('overhangsEveryEdge', () => {
  /** `display` grown by `by` on every side. */
  const grown = (display: Rect, by: number): Rect => ({
    x: display.x - by,
    y: display.y - by,
    width: display.width + 2 * by,
    height: display.height + 2 * by
  });

  it('is true from the threshold up, on all four edges at once', () => {
    expect(overhangsEveryEdge(grown(LAPTOP, MAXIMISED_OVERHANG_MIN_PX), LAPTOP)).toBe(true);
    expect(overhangsEveryEdge(grown(LAPTOP, 8), LAPTOP)).toBe(true);
  });

  it('is false for a window exactly on the display, or past it by less than the threshold', () => {
    expect(overhangsEveryEdge(LAPTOP, LAPTOP)).toBe(false);
    expect(overhangsEveryEdge(grown(LAPTOP, MAXIMISED_OVERHANG_MIN_PX - 1), LAPTOP)).toBe(false);
  });

  it('sits above the coverage tolerance, so a fullscreen window may overscan by it', () => {
    expect(MAXIMISED_OVERHANG_MIN_PX).toBeGreaterThan(FULLSCREEN_TOLERANCE_PX);
    expect(overhangsEveryEdge(grown(LAPTOP, FULLSCREEN_TOLERANCE_PX), LAPTOP)).toBe(false);
  });

  it('is false as soon as any one edge is on the display or inside it', () => {
    const big = grown(LAPTOP, 8);
    const pulledIn: Rect[] = [
      { ...big, x: LAPTOP.x, width: big.width - 8 }, // left edge on the display
      { ...big, y: LAPTOP.y, height: big.height - 8 }, // top
      { ...big, width: big.width - 8 }, // right
      { ...big, height: big.height - 8 } // bottom
    ];
    for (const rect of pulledIn) expect(overhangsEveryEdge(rect, LAPTOP), JSON.stringify(rect)).toBe(false);
  });

  it('is false for a window spanning two displays, which overhangs each on one side only', () => {
    const both: Rect = { x: 0, y: 0, width: 3360, height: 1080 };
    expect(overhangsEveryEdge(both, LAPTOP)).toBe(false);
    expect(overhangsEveryEdge(both, EXTERNAL)).toBe(false);
  });

  it('measures against the display it is given, wherever that display is', () => {
    expect(overhangsEveryEdge(grown(EXTERNAL, 8), EXTERNAL)).toBe(true);
    expect(overhangsEveryEdge(grown(EXTERNAL, 8), LAPTOP)).toBe(false);
  });

  it('leaves coversDisplay itself alone: larger than the display still covers it', () => {
    // The exclusion is applied where the two are combined (`isFullscreenWindows`),
    // not inside `coversDisplay`, whose own answer is unchanged.
    expect(coversDisplay(grown(LAPTOP, 8), LAPTOP)).toBe(true);
  });
});

describe('displayFor', () => {
  it('picks the display the window overlaps most', () => {
    expect(displayFor({ x: 1400, y: 0, width: 800, height: 600 }, DISPLAYS)).toBe(EXTERNAL);
    expect(displayFor({ x: 100, y: 0, width: 800, height: 600 }, DISPLAYS)).toBe(LAPTOP);
  });

  it('returns null for a window on no display at all', () => {
    expect(displayFor({ x: -5000, y: -5000, width: 100, height: 100 }, DISPLAYS)).toBeNull();
    expect(displayFor(LAPTOP, [])).toBeNull();
  });
});

describe('isDesktopOwner', () => {
  it('knows the desktop shells, case-insensitively', () => {
    for (const name of ['Finder', 'finder', ' Dock ', 'WindowServer', 'Windows Explorer']) {
      expect(isDesktopOwner(name), name).toBe(true);
    }
  });

  it('does not mistake an app for the desktop', () => {
    for (const name of ['Safari', 'Google Chrome', 'IINA', 'Keynote']) {
      expect(isDesktopOwner(name), name).toBe(false);
    }
  });
});

describe('isFullscreenWindow', () => {
  it('says yes for a video filling the second monitor', () => {
    expect(isFullscreenWindow(win(EXTERNAL), DISPLAYS, SELF)).toBe(true);
  });

  it('says no when there is no active window', () => {
    expect(isFullscreenWindow(null, DISPLAYS, SELF)).toBe(false);
  });

  it('says no for the desktop, which always fills its display', () => {
    expect(isFullscreenWindow(win(LAPTOP, 'Finder'), DISPLAYS, SELF)).toBe(false);
  });

  it('says no for our own window, by pid and by name', () => {
    expect(isFullscreenWindow(win(LAPTOP, 'Something', SELF.processId), DISPLAYS, SELF)).toBe(false);
    expect(isFullscreenWindow(win(LAPTOP, 'Electron', 5), DISPLAYS, SELF)).toBe(false);
    expect(isFullscreenWindow(win(LAPTOP, 'walder', 5), DISPLAYS, SELF)).toBe(false);
  });

  it('says no while displays are being reconfigured and nothing overlaps', () => {
    expect(isFullscreenWindow(win(LAPTOP), [], SELF)).toBe(false);
  });

  it('tolerates a report with no pid', () => {
    expect(isFullscreenWindow({ bounds: EXTERNAL, ownerName: 'IINA' }, DISPLAYS, SELF)).toBe(true);
  });

  /**
   * Fullscreen is per display.
   *
   * Without the dog's own display in the decision, a film on the external
   * monitor put a dog sitting on the laptop screen to sleep: he vanished from a
   * screen nobody was watching a film on, which is both useless and impossible
   * for the owner to explain.
   */
  describe('per display', () => {
    it('says no for a video on another display than the dog', () => {
      // Video fills the external monitor; the dog is on the laptop screen.
      expect(isFullscreenWindow(win(EXTERNAL), DISPLAYS, SELF, LAPTOP)).toBe(false);
      // …and the mirror image.
      expect(isFullscreenWindow(win(LAPTOP), DISPLAYS, SELF, EXTERNAL)).toBe(false);
    });

    it('says yes for a video on the dog’s own display', () => {
      expect(isFullscreenWindow(win(EXTERNAL), DISPLAYS, SELF, EXTERNAL)).toBe(true);
      expect(isFullscreenWindow(win(LAPTOP), DISPLAYS, SELF, LAPTOP)).toBe(true);
    });

    it('says yes for a window that spans both displays', () => {
      // Covering everything covers the dog's display too, whichever it is.
      const both: Rect = { x: 0, y: 0, width: 3360, height: 1080 };
      expect(isFullscreenWindow(win(both), DISPLAYS, SELF, LAPTOP)).toBe(true);
      expect(isFullscreenWindow(win(both), DISPLAYS, SELF, EXTERNAL)).toBe(true);
    });

    it('falls back to the overlapped display when there is no overlay window', () => {
      // `null` is "the overlay is momentarily gone" (it is being rebuilt), and
      // the old whole-machine behaviour is the right answer then.
      expect(isFullscreenWindow(win(EXTERNAL), DISPLAYS, SELF, null)).toBe(true);
    });

    it('falls back to the probe’s own monitor rect as a last resort', () => {
      // No dog display and no display list: the Windows helper reports the
      // monitor it measured the window against, which is better than a guess.
      const report: ActiveWindowInfo = {
        bounds: EXTERNAL,
        ownerName: 'vlc',
        monitor: EXTERNAL
      };
      expect(isFullscreenWindow(report, [], SELF, null)).toBe(true);
      // A monitor rect the window does *not* fill is still not fullscreen.
      expect(isFullscreenWindow({ ...report, monitor: { x: 0, y: 0, width: 3360, height: 1080 } }, [], SELF, null)).toBe(
        false
      );
    });

    it('still refuses our own window and the desktop, per display', () => {
      expect(isFullscreenWindow(win(LAPTOP, 'Finder'), DISPLAYS, SELF, LAPTOP)).toBe(false);
      expect(isFullscreenWindow(win(LAPTOP, 'Walder', 5), DISPLAYS, SELF, LAPTOP)).toBe(false);
    });
  });
});

/**
 * The real numbers, off a real Mac.
 *
 * Every rect below was recorded by a 1 Hz probe on macOS 26 — one display,
 * 1728×1117 at the origin, Dock visible, menu bar 33 px — while the owner played
 * a YouTube video fullscreen in Chrome for about two minutes. They are the
 * evidence for both halves of the bug: the *active* window was never the video,
 * and the video did not cover the display by the old strict rule.
 */
const MAC: Rect = { x: 0, y: 0, width: 1728, height: 1117 };

/** What `activeWindow()` kept returning: Chrome's hidden fullscreen toolbar. */
const CHROME_TOOLBAR: Rect = { x: 0, y: 33, width: 1728, height: 115 };
/** The video itself, which only ever appeared in `openWindows()`. */
const CHROME_VIDEO: Rect = { x: 0, y: 33, width: 1728, height: 1084 };
/** The same window mid-animation, sliding in from the next Space. */
const CHROME_SLIDING: Rect = { x: -1786, y: 33, width: 1728, height: 1084 };
/** The omnibox popup, which `activeWindow()` also reported at times. */
const CHROME_POPUP: Rect = { x: 0, y: 33, width: 451, height: 50 };
/** NOT fullscreen: Safari maximised. Same top edge; the Dock holds the bottom. */
const SAFARI_MAXIMISED: Rect = { x: 0, y: 33, width: 1728, height: 1018 };
/** NOT fullscreen: an ordinary app window. */
const CLAUDE_WINDOW: Rect = { x: 0, y: 109, width: 1433, height: 901 };
/** Windows, where a fullscreen window really does cover the display exactly. */
const WIN_DISPLAY: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

describe('coversDisplayAllowingMenuBar', () => {
  it('accepts the measured macOS fullscreen window, 33 px short at the top', () => {
    expect(coversDisplayAllowingMenuBar(CHROME_VIDEO, MAC)).toBe(true);
  });

  it('rejects a maximised window, which is short at the bottom instead', () => {
    // The whole distinction: same top edge, 66 px of Dock at the bottom.
    expect(coversDisplayAllowingMenuBar(SAFARI_MAXIMISED, MAC)).toBe(false);
  });

  it('rejects a window that is not the display’s width', () => {
    expect(coversDisplayAllowingMenuBar(CLAUDE_WINDOW, MAC)).toBe(false);
    // A window spanning two displays is wider, and is `coversDisplay`'s case.
    expect(coversDisplayAllowingMenuBar({ ...CHROME_VIDEO, width: 3456 }, MAC)).toBe(false);
  });

  it('rejects a window at the wrong left edge, which is how the slide is caught', () => {
    expect(coversDisplayAllowingMenuBar(CHROME_SLIDING, MAC)).toBe(false);
  });

  it('rejects a top gap one pixel past the menu-bar allowance', () => {
    const tooLow = { x: 0, y: MENU_BAR_MAX_PX + 1, width: 1728, height: 1117 };
    expect(coversDisplayAllowingMenuBar(tooLow, MAC)).toBe(false);
    expect(
      coversDisplayAllowingMenuBar({ ...tooLow, y: MENU_BAR_MAX_PX }, MAC)
    ).toBe(true);
  });
});

/**
 * The list form: every window of the frontmost app, not just the active one.
 *
 * This is the fix for the bug the owner reported — "Walder never curls up when
 * YouTube is fullscreen in Chrome". Both causes are exercised here: the active
 * window is the wrong window, and the coverage rule was too strict for macOS.
 */
describe('isFullscreenWindows', () => {
  const CHROME = 'Google Chrome';
  const list = (...rects: Rect[]): ActiveWindowInfo[] =>
    rects.map((bounds) => ({ bounds, ownerName: CHROME, ownerProcessId: 555 }));

  it('finds the video behind the toolbar strip that activeWindow() reports', () => {
    // The recorded pair, in the recorded order: the strip is first.
    expect(isFullscreenWindows(list(CHROME_TOOLBAR, CHROME_VIDEO), [MAC], SELF, MAC)).toBe(true);
  });

  it('says no for the toolbar strip on its own', () => {
    // Which is all the old code ever saw, and why the dog never slept.
    expect(isFullscreenWindows(list(CHROME_TOOLBAR), [MAC], SELF, MAC)).toBe(false);
    expect(isFullscreenWindows(list(CHROME_TOOLBAR, CHROME_POPUP), [MAC], SELF, MAC)).toBe(false);
  });

  it('says no while the Space is still sliding in', () => {
    expect(isFullscreenWindows(list(CHROME_TOOLBAR, CHROME_SLIDING), [MAC], SELF, MAC)).toBe(false);
  });

  it('says no for a maximised window with the Dock showing', () => {
    expect(isFullscreenWindows(list(SAFARI_MAXIMISED), [MAC], SELF, MAC)).toBe(false);
  });

  it('says no for an ordinary app window', () => {
    expect(isFullscreenWindows(list(CLAUDE_WINDOW), [MAC], SELF, MAC)).toBe(false);
  });

  it('says yes for a Windows-style exact cover', () => {
    expect(isFullscreenWindows(list(WIN_DISPLAY), [WIN_DISPLAY], SELF, WIN_DISPLAY)).toBe(true);
  });

  /**
   * Known and accepted: with the Dock hidden, a maximised window is reported at
   * exactly the fullscreen geometry and there is nothing left to tell them
   * apart. Walder sleeps for it. Documented in `docs/QA-CHECKLIST.md` §6.
   */
  it('cannot tell a Dock-hidden maximised window from a fullscreen one', () => {
    expect(isFullscreenWindows(list(CHROME_VIDEO), [MAC], SELF, MAC)).toBe(true);
  });

  it('says no for an empty list', () => {
    expect(isFullscreenWindows([], [MAC], SELF, MAC)).toBe(false);
  });

  it('still ignores our own windows and the desktop, however many there are', () => {
    const ours: ActiveWindowInfo[] = [
      { bounds: CHROME_VIDEO, ownerName: 'Walder', ownerProcessId: SELF.processId },
      { bounds: CHROME_VIDEO, ownerName: 'Electron', ownerProcessId: 7 }
    ];
    expect(isFullscreenWindows(ours, [MAC], SELF, MAC)).toBe(false);
    expect(
      isFullscreenWindows([{ bounds: CHROME_VIDEO, ownerName: 'Finder' }], [MAC], SELF, MAC)
    ).toBe(false);
  });

  it('still refuses a video on a display the dog is not on', () => {
    const second: Rect = { x: 1728, y: 0, width: 1728, height: 1117 };
    const video = [{ bounds: { ...CHROME_VIDEO, x: 1728 }, ownerName: CHROME }];
    expect(isFullscreenWindows(video, [MAC, second], SELF, MAC)).toBe(false);
    expect(isFullscreenWindows(video, [MAC, second], SELF, second)).toBe(true);
  });
});

describe('debounceFullscreen', () => {
  /** Feed a run of samples and collect every flip. */
  function run(samples: readonly boolean[]): { flips: boolean[]; state: DebounceState } {
    let state = DEBOUNCE_INITIAL;
    const flips: boolean[] = [];
    for (const sample of samples) {
      const next = debounceFullscreen(state, sample);
      state = next.state;
      if (next.changed) flips.push(state.fullscreen);
    }
    return { flips, state };
  }

  it('needs two agreeing samples to enter', () => {
    expect(run([true]).flips).toEqual([]);
    expect(run([true, true]).flips).toEqual([true]);
  });

  it('needs two agreeing samples to leave', () => {
    expect(run([true, true, false]).flips).toEqual([true]);
    expect(run([true, true, false, false]).flips).toEqual([true, false]);
  });

  it('ignores a single sample taken mid-animation', () => {
    // The window is briefly neither size while a video goes fullscreen.
    expect(run([false, true, false, false, true, true]).flips).toEqual([true]);
  });

  it('clears a part-built streak as soon as the state is confirmed again', () => {
    const { state } = run([true]);
    expect(state.streak).toBe(1);
    expect(debounceFullscreen(state, false).state.streak).toBe(0);
  });

  it('flips on the first sample when only one is required', () => {
    expect(debounceFullscreen(DEBOUNCE_INITIAL, true, 1)).toEqual({
      state: { fullscreen: true, streak: 0 },
      changed: true
    });
  });
});

/**
 * QA 6.3: petting a sleeping dog over a fullscreen film makes Walder the
 * frontmost app, and the probe then reports only his own 88×120 overlay. That
 * must read as "unknown, hold", not as "the film is over".
 */
describe('readFullscreen with Walder in front', () => {
  /** The recorded report after a pet: our own overlay, nothing else. */
  const OVERLAY: ActiveWindowInfo = {
    bounds: { x: 1624, y: 932, width: 88, height: 120 },
    ownerName: 'Walder',
    ownerProcessId: SELF.processId
  };
  /** Safari's video fullscreen is the same 1728×1084 at (0, 33) as Chrome's. */
  const SAFARI_VIDEO: ActiveWindowInfo = win(CHROME_VIDEO);
  const SAFARI_NORMAL: ActiveWindowInfo = win(SAFARI_MAXIMISED);
  /** Comfortably past both the debounce and a 10 s unknown-hold at 2 s polls. */
  const LONG_PET = 30;

  /** Feed poll reports through the reading and the debounce; collect flips. */
  function polls(
    reports: readonly (readonly ActiveWindowInfo[])[],
    start: DebounceState = DEBOUNCE_INITIAL
  ): { flips: boolean[]; state: DebounceState } {
    let state = start;
    const flips: boolean[] = [];
    for (const report of reports) {
      const next = debounceFullscreen(state, readFullscreen(report, [MAC], SELF, MAC));
      state = next.state;
      if (next.changed) flips.push(state.fullscreen);
    }
    return { flips, state };
  }
  const repeat = (report: ActiveWindowInfo, n: number): ActiveWindowInfo[][] =>
    Array.from({ length: n }, () => [report]);

  it('reads our own overlay as unknown, matched by pid or by name', () => {
    expect(readFullscreen([OVERLAY], [MAC], SELF, MAC)).toBeNull();
    expect(readFullscreen([{ ...OVERLAY, ownerProcessId: 1 }], [MAC], SELF, MAC)).toBeNull();
    expect(readFullscreen([{ ...OVERLAY, ownerName: 'x' }], [MAC], SELF, MAC)).toBeNull();
  });

  it('still answers for every other report, including an empty one', () => {
    expect(readFullscreen([SAFARI_VIDEO], [MAC], SELF, MAC)).toBe(true);
    expect(readFullscreen([SAFARI_NORMAL], [MAC], SELF, MAC)).toBe(false);
    expect(readFullscreen([], [MAC], SELF, MAC)).toBe(false);
  });

  it('holds fullscreen through a long pet, survives the video again, then leaves after the debounce', () => {
    const settled = polls(repeat(SAFARI_VIDEO, DEBOUNCE_POLLS));
    expect(settled.flips).toEqual([true]);

    // (1) Walder frontmost for many polls: still asleep, no `left`.
    const petted = polls(repeat(OVERLAY, LONG_PET), settled.state);
    expect(petted.flips).toEqual([]);
    expect(petted.state.fullscreen).toBe(true);

    // (2) The owner clicks the video again: no flap either way.
    const back = polls(repeat(SAFARI_VIDEO, LONG_PET), petted.state);
    expect(back.flips).toEqual([]);
    expect(back.state.fullscreen).toBe(true);

    // (3) The video leaves fullscreen: `left`, after the ordinary debounce.
    expect(polls(repeat(SAFARI_NORMAL, DEBOUNCE_POLLS - 1), back.state).flips).toEqual([]);
    expect(polls(repeat(SAFARI_NORMAL, DEBOUNCE_POLLS), back.state).flips).toEqual([false]);
  });

  it('holds not-fullscreen just the same', () => {
    // (4) Awake over an ordinary window, petted for a while: stays awake.
    const awake = polls([[SAFARI_NORMAL], ...repeat(OVERLAY, LONG_PET)]);
    expect(awake.flips).toEqual([]);
    expect(awake.state.fullscreen).toBe(false);
  });
});

/**
 * M5 (F11 in the 0.2.8 Windows report): with a film fullscreen and the dog
 * asleep, the tray overflow flyout — or Alt+Tab, Task View, Start — taking the
 * foreground for two polls read as "fullscreen left" and woke him, because every
 * explorer-owned window counted as the desktop. Geometry and class names below
 * are the ones measured headlessly on Windows 11 26200 at 1920×1200.
 */
describe('Windows shell surfaces over a film (M5)', () => {
  const SCREEN: Rect = { x: 0, y: 0, width: 1920, height: 1200 };
  /** The poll cadence of `main/fullscreen-watch.ts` (POLL_MS), in core terms. */
  const POLL = 2_000;

  function winWith(
    windowClass: string | undefined,
    ownerName: string,
    bounds: Rect = SCREEN
  ): ActiveWindowInfo {
    return {
      bounds,
      ownerName,
      ownerProcessId: 7000,
      monitor: SCREEN,
      ...(windowClass === undefined ? {} : { windowClass })
    };
  }

  const FILM = winWith('Chrome_WidgetWin_1', 'chrome');
  /** The Windows 11 overflow flyout: a small XAML island above the tray. */
  const OVERFLOW = winWith('TopLevelWindowForOverflowXamlIsland', 'explorer', {
    x: 1500, y: 980, width: 300, height: 160
  });
  const TASKBAR = winWith('Shell_TrayWnd', 'explorer', { x: 0, y: 1152, width: 1920, height: 48 });
  const TASK_VIEW = winWith('XamlExplorerHostIslandWindow', 'explorer', { x: 0, y: 0, width: 1920, height: 1152 });
  const START = winWith('Windows.UI.Core.CoreWindow', 'StartMenuExperienceHost', {
    x: 560, y: 300, width: 800, height: 850
  });
  /** Start or Search measured as a full-display CoreWindow, as TextInputHost's is. */
  const START_FULL = winWith('Windows.UI.Core.CoreWindow', 'StartMenuExperienceHost');
  const DESKTOP = winWith('Progman', 'explorer');
  const WORKER = winWith('WorkerW', 'explorer');
  const FOLDER = winWith('CabinetWClass', 'explorer', { x: 200, y: 100, width: 1200, height: 800 });
  const NOTEPAD = winWith('Notepad', 'notepad', { x: 200, y: 100, width: 1200, height: 800 });

  /**
   * The watch's pipeline, step for step: read, bound the shell hold, debounce.
   * One report per poll, `POLL` ms apart, starting at `t0`.
   */
  function run(
    reports: readonly ActiveWindowInfo[],
    start: { state: DebounceState; hold: ShellHoldState; t: number } = {
      state: DEBOUNCE_INITIAL,
      hold: SHELL_HOLD_INITIAL,
      t: 0
    }
  ): { flips: boolean[]; state: DebounceState; hold: ShellHoldState; t: number } {
    let { state, hold, t } = start;
    const flips: boolean[] = [];
    for (const report of reports) {
      t += POLL;
      const windows = [report];
      const read = readFullscreen(windows, [SCREEN], SELF, SCREEN);
      const bounded = boundShellHold(hold, read, shellInFront(windows, SELF), t);
      hold = bounded.hold;
      const next = debounceFullscreen(state, bounded.reading);
      state = next.state;
      if (next.changed) flips.push(state.fullscreen);
    }
    return { flips, state, hold, t };
  }
  const times = (report: ActiveWindowInfo, n: number): ActiveWindowInfo[] =>
    Array.from({ length: n }, () => report);
  /** Polls that fit in `ms`. */
  const pollsIn = (ms: number): number => Math.ceil(ms / POLL);

  function asleep(): { state: DebounceState; hold: ShellHoldState; t: number } {
    const settled = run(times(FILM, DEBOUNCE_POLLS));
    expect(settled.flips).toEqual([true]);
    return settled;
  }

  it('classifies the shell surfaces by class, never by the explorer owner alone', () => {
    for (const surface of [OVERFLOW, TASKBAR, TASK_VIEW, START, START_FULL]) {
      expect(isShellSurface(surface), surface.windowClass).toBe(true);
    }
    for (const cls of ['NotifyIconOverflowWindow', 'MultitaskingViewFrame', 'Shell_SecondaryTrayWnd']) {
      expect(isShellSurface(winWith(cls, 'explorer')), cls).toBe(true);
    }
    for (const owner of ['SearchHost', 'ShellExperienceHost', 'ShellHost', 'TextInputHost']) {
      expect(isShellSurface(winWith('Windows.UI.Core.CoreWindow', owner)), owner).toBe(true);
    }
    // The real desktop, a folder window and an ordinary app are not.
    for (const other of [DESKTOP, WORKER, FOLDER, NOTEPAD, FILM]) {
      expect(isShellSurface(other), other.windowClass).toBe(false);
    }
    // No class (macOS, or a helper line from before the field): unchanged.
    expect(isShellSurface(winWith(undefined, 'explorer'))).toBe(false);
    expect(isShellSurface(winWith(undefined, 'StartMenuExperienceHost'))).toBe(false);
  });

  it('reads a shell surface as hold, and everything else as before', () => {
    expect(readFullscreen([OVERFLOW], [SCREEN], SELF, SCREEN)).toBeNull();
    expect(readFullscreen([START_FULL], [SCREEN], SELF, SCREEN)).toBeNull();
    expect(readFullscreen([DESKTOP], [SCREEN], SELF, SCREEN)).toBe(false);
    expect(readFullscreen([FOLDER], [SCREEN], SELF, SCREEN)).toBe(false);
    expect(readFullscreen([FILM], [SCREEN], SELF, SCREEN)).toBe(true);
    expect(readFullscreen([], [SCREEN], SELF, SCREEN)).toBe(false);
    // The old explorer behaviour, class-less, is untouched.
    expect(readFullscreen([winWith(undefined, 'explorer')], [SCREEN], SELF, SCREEN)).toBe(false);
    expect(shellInFront([OVERFLOW], SELF)).toBe(true);
    expect(shellInFront([DESKTOP], SELF)).toBe(false);
    expect(shellInFront([], SELF)).toBe(false);
  });

  it('keeps him asleep with the overflow flyout open for 10 s over a film', () => {
    const flyout = run(times(OVERFLOW, pollsIn(10_000)), asleep());
    expect(flyout.flips).toEqual([]);
    expect(flyout.state.fullscreen).toBe(true);
    // Back to the film: no flap either way.
    const back = run(times(FILM, 5), flyout);
    expect(back.flips).toEqual([]);
    expect(back.state.fullscreen).toBe(true);
  });

  it('holds just the same through the taskbar, Task View / Alt+Tab and Start', () => {
    for (const surface of [TASKBAR, TASK_VIEW, START, START_FULL]) {
      const held = run(times(surface, pollsIn(10_000)), asleep());
      expect(held.flips, surface.windowClass).toEqual([]);
      expect(held.state.fullscreen).toBe(true);
    }
  });

  it('ends fullscreen once the real desktop has been in front for two polls', () => {
    for (const desktop of [DESKTOP, WORKER]) {
      const from = asleep();
      expect(run(times(desktop, DEBOUNCE_POLLS - 1), from).flips).toEqual([]);
      expect(run(times(desktop, DEBOUNCE_POLLS), from).flips).toEqual([false]);
    }
  });

  it('ends fullscreen for an ordinary non-fullscreen app, and a folder window', () => {
    for (const app of [NOTEPAD, FOLDER]) {
      expect(run(times(app, DEBOUNCE_POLLS), asleep()).flips).toEqual([false]);
    }
  });

  it('a flyout in the middle does not reset the way to the desktop', () => {
    // Win+D with the flyout briefly in between: the desktop still wins.
    const result = run([OVERFLOW, DESKTOP, DESKTOP], asleep());
    expect(result.flips).toEqual([false]);
  });

  it('wakes him within the bound when the player closes onto the taskbar', () => {
    const from = asleep();
    // Inside the bound: still held.
    const inside = run(times(TASKBAR, pollsIn(SHELL_HOLD_MAX_MS) - 1), from);
    expect(inside.flips).toEqual([]);
    // Past it, the ordinary two-poll debounce wakes him.
    const past = run(times(TASKBAR, pollsIn(SHELL_HOLD_MAX_MS) + DEBOUNCE_POLLS), from);
    expect(past.flips).toEqual([false]);
    expect(past.state.fullscreen).toBe(false);
  });

  it('holds over a film with the Widgets board open (Win+W, M5b)', () => {
    // As measured on Windows 11 26200: class WindowsDashboard, owner WidgetBoard
    // (the helper's ProcessName — no `.exe`), a panel down the left of the screen.
    const widgets = winWith('WindowsDashboard', 'WidgetBoard', { x: 0, y: 0, width: 760, height: 1152 });
    expect(isShellSurface(widgets)).toBe(true);
    expect(isShellSurface(winWith('WindowsDashboard', 'widgetboard'))).toBe(true);
    const held = run(times(widgets, pollsIn(10_000)), asleep());
    expect(held.flips, 'Widgets woke him over a film').toEqual([]);
    expect(held.state.fullscreen).toBe(true);
    // And, like every shell surface, only within the bound.
    const past = run(times(widgets, pollsIn(SHELL_HOLD_MAX_MS) + DEBOUNCE_POLLS), asleep());
    expect(past.flips).toEqual([false]);
  });

  it('names a recognised surface only from its own lists, never the reported string', () => {
    // Case is whatever the window reported; the name returned is the listed one.
    expect(knownShellSurface(winWith('xamlexplorerhostislandwindow', 'Explorer'))).toEqual({
      owner: 'explorer',
      windowClass: 'XamlExplorerHostIslandWindow',
      classLength: 'XamlExplorerHostIslandWindow'.length
    });
    expect(knownShellSurface(winWith('WindowsDashboard', 'widgetboard'))).toEqual({
      owner: 'WidgetBoard',
      windowClass: 'WindowsDashboard',
      classLength: 'WindowsDashboard'.length
    });
    // A host-owned window with an unlisted class is still a surface, but its
    // class is not handed back — only its length.
    const odd = 'sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect(knownShellSurface(winWith(odd, 'ShellHost'))).toEqual({
      owner: 'ShellHost',
      windowClass: null,
      classLength: odd.length
    });
    expect(knownShellSurface(FOLDER)).toBeNull();
    expect(knownShellSurface(winWith(undefined, 'WidgetBoard'))).toBeNull();
  });

  it('a full-display Start on an empty desktop does not put him to sleep', () => {
    const awake = run([NOTEPAD, ...times(START_FULL, pollsIn(SHELL_HOLD_MAX_MS) * 2)]);
    expect(awake.flips).toEqual([]);
    expect(awake.state.fullscreen).toBe(false);
  });

  it('bounds an episode in time, and starts a fresh one after any other sample', () => {
    const first = boundShellHold(SHELL_HOLD_INITIAL, null, true, 1_000);
    expect(first).toEqual({ hold: { since: 1_000 }, reading: null, expired: false });
    const later = boundShellHold(first.hold, null, true, 1_000 + SHELL_HOLD_MAX_MS - 1);
    expect(later.reading).toBeNull();
    const done = boundShellHold(first.hold, null, true, 1_000 + SHELL_HOLD_MAX_MS);
    expect(done).toEqual({ hold: { since: 1_000 }, reading: false, expired: true });
    // A non-shell sample passes through untouched and ends the episode.
    expect(boundShellHold(done.hold, true, false, 99_000)).toEqual({
      hold: SHELL_HOLD_INITIAL,
      reading: true,
      expired: false
    });
    // ...including Walder in front, whose hold stays unbounded.
    expect(boundShellHold(done.hold, null, false, 99_000).reading).toBeNull();
  });
});

/**
 * W6 (audit 2026-11): with **Automatically hide the taskbar** on, any maximised
 * ordinary window in front read as fullscreen and the dog slept through the
 * working day. Confirmed on screen on Windows 11 26200 on 2026-11-16.
 *
 * The rects were read with the helper's own calls (per-monitor-DPI-aware
 * `GetWindowRect`) on one 1920 × 1200 display at 125 %, in physical pixels, and
 * are written here the way the decision sees them: in Electron DIPs, each edge
 * mapped through the display's 0.8 and rounded, exactly as `physicalToDip` does.
 * The physical rect is in each case's name; `test/win-dpi.test.ts` runs the same
 * physical numbers through the real mapping and arrives at these.
 *
 * The 125 % rows are measured, and so is the 8 px border at 100 % (the same
 * day, same apps: 8 px on all four edges for every one). The 7 px row is a
 * margin, not a measurement, and 150 % and 200 % are *reckoned* from the border growing
 * with the DPI, with the 8 px it has at 96 DPI as the pessimistic floor.
 */
describe('a maximised Windows window with no taskbar reserved (W6)', () => {
  const edges = (l: number, t: number, r: number, b: number): Rect => ({
    x: l,
    y: t,
    width: r - l,
    height: b - t
  });
  /** The 1920 × 1200 panel as Electron's DIP display, per scale. */
  const AT_100 = edges(0, 0, 1920, 1200);
  const AT_125 = edges(0, 0, 1536, 960);
  const AT_150 = edges(0, 0, 1280, 800);
  const AT_200 = edges(0, 0, 960, 600);

  /** A helper report, already in DIPs, for a window on `display`. */
  function report(
    bounds: Rect,
    display: Rect,
    ownerName = 'Notepad',
    windowClass: string | undefined = 'Notepad'
  ): ActiveWindowInfo {
    return {
      bounds,
      ownerName,
      ownerProcessId: 7000,
      monitor: display,
      ...(windowClass === undefined ? {} : { windowClass })
    };
  }
  /** What the watch reads for that window in front, the dog on the same display. */
  const reads = (info: ActiveWindowInfo, display: Rect): boolean | null =>
    readFullscreen([info], [display], SELF, display);

  /**
   * Measured, maximised: [what and its physical rect, DIP rect, owner, class].
   * A class that was not recorded is left out. The scratch Electron windows are
   * given an owner of their own: a bare `electron` is one of Walder's own names
   * in a dev run and would be held as "Walder in front" before any geometry.
   */
  const MAXIMISED_AT_125: readonly (readonly [string, Rect, string, string | undefined])[] = [
    ['Notepad, taskbar hidden: -9,-9 – 1929,1209', edges(-7, -7, 1543, 967), 'Notepad', 'Notepad'],
    ['Notepad, taskbar slid into view: the identical rect', edges(-7, -7, 1543, 967), 'Notepad', 'Notepad'],
    ['a WinForms bordered window: -10,-10 – 1930,1210', edges(-8, -8, 1544, 968), 'powershell', undefined],
    ['the Claude desktop app, its own frame: -8,-8 – 1928,1208', edges(-6, -6, 1542, 966), 'claude', 'Chrome_WidgetWin_1'],
    ['an Electron framed window: -9,-9 – 1929,1209', edges(-7, -7, 1543, 967), 'scratch', 'Chrome_WidgetWin_1'],
    ['an Electron frame:false window: -9,-9 – 1929,1209', edges(-7, -7, 1543, 967), 'scratch', 'Chrome_WidgetWin_1']
  ];

  it.each(MAXIMISED_AT_125)('125 %, measured — %s — is not fullscreen', (_what, bounds, owner, cls) => {
    const info = report(bounds, AT_125, owner, cls);
    // It does cover the display, which is all the old rule asked…
    expect(coversDisplay(bounds, AT_125)).toBe(true);
    // …and it is the overhang on every edge that says "maximised".
    expect(overhangsEveryEdge(bounds, AT_125)).toBe(true);
    expect(reads(info, AT_125)).toBe(false);
    expect(isFullscreenWindow(info, [AT_125], SELF, AT_125)).toBe(false);
    // Neither does the display list or the helper's own monitor rect let it in
    // while there is momentarily no overlay window to name the dog's display.
    expect(isFullscreenWindow(info, [AT_125], SELF, null)).toBe(false);
    expect(isFullscreenWindow(info, [], SELF, null)).toBe(false);
  });

  it('125 %, measured — File Explorer maximised (-9,-9 – 1929,1209) — is the desktop owner, as before', () => {
    const folder = report(edges(-7, -7, 1543, 967), AT_125, 'explorer', 'CabinetWClass');
    expect(isShellSurface(folder)).toBe(false);
    expect(reads(folder, AT_125)).toBe(false);
  });

  /** Measured, fullscreen: every one of them is the display's own rect. */
  const FULLSCREEN_AT_125: readonly (readonly [string, string, string | undefined])[] = [
    ['a borderless full-display window (a film)', 'vlc', undefined],
    ['Electron HTML element fullscreen (requestFullscreen, a browser video)', 'scratch', 'Chrome_WidgetWin_1'],
    ['Electron setFullScreen(true) (a browser’s F11)', 'scratch', 'Chrome_WidgetWin_1']
  ];

  it.each(FULLSCREEN_AT_125)('125 %, measured — %s, 0,0 – 1920,1200 — is still fullscreen', (_what, owner, cls) => {
    const info = report(AT_125, AT_125, owner, cls);
    expect(overhangsEveryEdge(info.bounds, AT_125)).toBe(false);
    expect(reads(info, AT_125)).toBe(true);
  });

  it('sleeps over none of a day of maximised windows, and still over the film between them', () => {
    const notepad = report(edges(-7, -7, 1543, 967), AT_125);
    const claude = report(edges(-6, -6, 1542, 966), AT_125, 'claude', 'Chrome_WidgetWin_1');
    const film = report(AT_125, AT_125, 'vlc', undefined);
    let state = DEBOUNCE_INITIAL;
    const flips: boolean[] = [];
    const poll = (info: ActiveWindowInfo, times: number): void => {
      for (let i = 0; i < times; i++) {
        const next = debounceFullscreen(state, reads(info, AT_125));
        state = next.state;
        if (next.changed) flips.push(state.fullscreen);
      }
    };
    poll(notepad, 10);
    poll(claude, 10);
    expect(flips, 'a maximised window put him to sleep').toEqual([]);
    poll(film, DEBOUNCE_POLLS);
    expect(flips).toEqual([true]);
    // Leaving the film for a maximised window wakes him after the usual debounce.
    poll(notepad, DEBOUNCE_POLLS);
    expect(flips).toEqual([true, false]);
  });

  it('125 % — a maximised window with the taskbar *not* on auto-hide stays not fullscreen', () => {
    // Not measured in the W6 pass; composed from the measured 9 px border and
    // the 60 px (48 DIP) taskbar: -9,-9 – 1929,1149 physical. Wider and taller
    // at the top than the display, 41 DIPs short at the bottom.
    const bounds = edges(-7, -7, 1543, 919);
    expect(coversDisplay(bounds, AT_125)).toBe(false);
    expect(reads(report(bounds, AT_125), AT_125)).toBe(false);
  });

  it('125 % — restored windows, which fall short of the display, are not fullscreen', () => {
    for (const bounds of [edges(160, 80, 1120, 720), edges(0, 0, 1536, 912), edges(-7, 0, 775, 967)]) {
      expect(reads(report(bounds, AT_125), AT_125), JSON.stringify(bounds)).toBe(false);
    }
  });

  /**
   * Known and accepted, out of scope for W6. A *restored* captioned window that
   * happens to be the display's size — measured at 0,0 – 1920,1200, overhang
   * 0/0/0/0 — has a film's geometry and reads as one. No rect can separate
   * them; it needs the window's maximised state, which this change does not add.
   */
  it('125 %, measured — cannot tell a display-sized restored window from a fullscreen one', () => {
    expect(reads(report(AT_125, AT_125), AT_125)).toBe(true);
  });

  it.each([
    ['an 8 px border (measured)', edges(-8, -8, 1928, 1208)],
    ['a 7 px border (a margin, not measured)', edges(-7, -7, 1927, 1207)]
  ])('100 % — maximised with %s — is not fullscreen', (_what, bounds) => {
    expect(reads(report(bounds, AT_100), AT_100)).toBe(false);
    expect(reads(report(AT_100, AT_100, 'vlc', undefined), AT_100)).toBe(true);
  });

  it.each([
    // 12 px is the border grown with the DPI: -12,-12 – 1932,1212 physical.
    ['a 12 px border (grown with the DPI)', edges(-8, -8, 1288, 808)],
    // 8 px is the floor, a border that did not grow: -8,-8 – 1928,1208 is
    // -5.33 … 1285.33 / 805.33 in DIPs, rounded edge by edge.
    ['an 8 px border (the floor)', edges(-5, -5, 1285, 805)]
  ])('150 %, reckoned — maximised with %s — is not fullscreen', (_what, bounds) => {
    expect(reads(report(bounds, AT_150), AT_150)).toBe(false);
    expect(reads(report(AT_150, AT_150, 'vlc', undefined), AT_150)).toBe(true);
  });

  it.each([
    // -16,-16 – 1936,1216 physical.
    ['a 16 px border (grown with the DPI)', edges(-8, -8, 968, 608)],
    // -8,-8 – 1928,1208 physical: 4 DIPs, the smallest overhang reckoned at
    // any of the four scales, one above the threshold.
    ['an 8 px border (the floor)', edges(-4, -4, 964, 604)]
  ])('200 %, reckoned — maximised with %s — is not fullscreen', (_what, bounds) => {
    expect(overhangsEveryEdge(bounds, AT_200)).toBe(true);
    expect(reads(report(bounds, AT_200), AT_200)).toBe(false);
    expect(reads(report(AT_200, AT_200, 'vlc', undefined), AT_200)).toBe(true);
  });

  it('a fullscreen window that overscans by a pixel or two is still fullscreen', () => {
    // Below the threshold on purpose: some borderless games sit a pixel or two
    // outside the display on every side.
    for (const by of [1, 2]) {
      const bounds = edges(-by, -by, 1920 + by, 1200 + by);
      expect(reads(report(bounds, AT_100, 'game', undefined), AT_100), `${by} px`).toBe(true);
    }
    // At the threshold it is taken for a maximised window, which is the safe
    // direction: a dog that stays up, never one asleep all day.
    const at = MAXIMISED_OVERHANG_MIN_PX;
    expect(reads(report(edges(-at, -at, 1920 + at, 1200 + at), AT_100, 'game', undefined), AT_100)).toBe(false);
  });

  describe('two displays', () => {
    // Two 1920 × 1200 displays at 100 %, side by side; only the left one has a taskbar.
    const LEFT = edges(0, 0, 1920, 1200);
    const RIGHT = edges(1920, 0, 3840, 1200);
    const BOTH = [LEFT, RIGHT];

    it('a window spanning both still reads as fullscreen, whichever the dog is on', () => {
      // It overhangs each display on one side only, never on all four.
      const spanning = report(edges(0, 0, 3840, 1200), LEFT, 'vlc', undefined);
      expect(readFullscreen([spanning], BOTH, SELF, LEFT)).toBe(true);
      expect(readFullscreen([spanning], BOTH, SELF, RIGHT)).toBe(true);
      expect(readFullscreen([spanning], BOTH, SELF, null)).toBe(true);
    });

    it('a window maximised on the display without a taskbar is not fullscreen there', () => {
      // The other way to have no taskbar reserved (expected, not measured):
      // 1912,-8 – 3848,1208.
      const maximised = report(edges(1912, -8, 3848, 1208), RIGHT);
      expect(coversDisplay(maximised.bounds, RIGHT)).toBe(true);
      expect(readFullscreen([maximised], BOTH, SELF, RIGHT)).toBe(false);
      expect(readFullscreen([maximised], BOTH, SELF, LEFT)).toBe(false);
      expect(readFullscreen([maximised], BOTH, SELF, null)).toBe(false);
    });

    it('a film on that display still sleeps a dog on it, and only on it', () => {
      const film = report(RIGHT, RIGHT, 'vlc', undefined);
      expect(readFullscreen([film], BOTH, SELF, RIGHT)).toBe(true);
      expect(readFullscreen([film], BOTH, SELF, LEFT)).toBe(false);
    });
  });

  it('leaves the shell-surface hold and the desktop exactly as they were (M5)', () => {
    const maximisedRect = edges(-7, -7, 1543, 967);
    // A shell surface is held by class and owner before any geometry is read…
    const taskView = report(maximisedRect, AT_125, 'explorer', 'XamlExplorerHostIslandWindow');
    expect(reads(taskView, AT_125)).toBeNull();
    expect(shellInFront([taskView], SELF)).toBe(true);
    expect(reads(report(AT_125, AT_125, 'StartMenuExperienceHost', 'Windows.UI.Core.CoreWindow'), AT_125)).toBeNull();
    // …the real desktop is not fullscreen whatever its rect…
    expect(reads(report(AT_125, AT_125, 'explorer', 'Progman'), AT_125)).toBe(false);
    expect(reads(report(maximisedRect, AT_125, 'explorer', 'WorkerW'), AT_125)).toBe(false);
    // …and Walder himself in front is still "unknown, hold".
    expect(reads({ ...report(maximisedRect, AT_125), ownerProcessId: SELF.processId ?? 0 }, AT_125)).toBeNull();
  });
});

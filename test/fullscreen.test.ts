/**
 * The fullscreen decision: bounds arithmetic and the debounce.
 *
 * The bugs this is written against are all false positives, because a false
 * positive is the expensive direction — it makes Walder disappear while the
 * owner is working, which is indistinguishable from a crash:
 *  - an ordinary maximised window (menu bar or taskbar still visible) is not
 *    fullscreen;
 *  - the *desktop* covers the whole display by definition and must not count;
 *  - Walder's own always-on-top window can genuinely be the active window on
 *    macOS, and counting it would be a loop;
 *  - a single sample taken mid-animation, while a video is halfway into
 *    fullscreen, must not flip anything.
 */
import { describe, expect, it } from 'vitest';
import {
  DEBOUNCE_INITIAL,
  FULLSCREEN_TOLERANCE_PX,
  MENU_BAR_MAX_PX,
  coversDisplay,
  coversDisplayAllowingMenuBar,
  debounceFullscreen,
  displayFor,
  isDesktopOwner,
  isFullscreenWindow,
  isFullscreenWindows,
  type ActiveWindowInfo,
  type DebounceState,
  type SelfIdentity
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

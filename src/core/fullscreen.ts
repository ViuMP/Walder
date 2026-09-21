/**
 * "Is a fullscreen video playing?" — the decision half, as pure arithmetic.
 *
 * Walder sits above everything, including full-screen video, which is exactly
 * where a mascot is least welcome. So he curls up and sleeps instead. The
 * question is answered from the *active* window's geometry rather than from any
 * platform "is fullscreen" flag, because the flag differs per OS and misses the
 * common case of a browser video maximised over the whole display.
 *
 * The I/O half — asking the OS which window is active — is
 * `main/fullscreen-watch.ts`. Keeping the maths here is what makes "does a
 * window 1 px short of the bottom edge still count" a unit test.
 */
import type { Rect } from './geometry';

/**
 * How far a window's edges may fall short of the display's and still count as
 * covering it.
 *
 * Two pixels, not zero: window managers round, and a fractional display scale
 * can leave a maximised window a pixel shy on one edge. Two is also far tighter
 * than any real window that is *not* fullscreen — an ordinary maximised window
 * still leaves the menu bar or taskbar visible, which is tens of pixels.
 */
export const FULLSCREEN_TOLERANCE_PX = 2;

/**
 * How far below the display's top edge a fullscreen window may start.
 *
 * macOS does not put a fullscreen window at the display origin. The menu bar is
 * *hidden*, not removed, and the window server keeps its strip of the display:
 * measured on macOS 26 at 1728×1117, a YouTube video fullscreen in Chrome is
 * reported as **1728×1084 at (0, 33)** — full width, bottom edge exactly on the
 * display bottom, and 33 px short at the top, which is precisely the height of
 * the menu bar. Under the old "covers all four edges within 2 px" rule that read
 * as an ordinary window, and Walder never once curled up over a film.
 *
 * 44 px, rather than the 33 measured here, because the menu bar is taller on a
 * display with a notch and taller again at some scale factors. It is still an
 * order of magnitude below the gap any *windowed* app leaves: a maximised Safari
 * window on the same display was 1728×1018 at (0, 33) — same top, but 66 px
 * short at the bottom, where the Dock is — so the bottom edge, not the top, is
 * what separates the two cases.
 */
export const MENU_BAR_MAX_PX = 44;

/** Consecutive agreeing polls needed before the state flips. */
export const DEBOUNCE_POLLS = 2;

/** The part of an active-window report this module needs. */
export interface ActiveWindowInfo {
  readonly bounds: Rect;
  /** The owning application's name, e.g. `Safari`, `Finder`, `Walder`. */
  readonly ownerName: string;
  /** The owning application's pid, when the platform reports one. */
  readonly ownerProcessId?: number;
  /**
   * The owning application's bundle, e.g. `/Applications/iTerm.app`, when the
   * platform reports one.
   *
   * Nothing in this module reads it, deliberately: the fullscreen decision is
   * geometry and identity, and an application's path says nothing about
   * whether a window covers a screen. It rides along because the macOS probe
   * already has it in hand (`get-windows` reports `owner.path`) and the
   * frontmost watch is the only thing polling the OS often enough to answer
   * "which app is he looking at now" for free — see `onFrontmost` in
   * `main/fullscreen-watch.ts`. macOS only; the Windows helper has no path.
   */
  readonly ownerPath?: string;
  /**
   * The display the *OS* says the window is on, when the probe reports one.
   *
   * The Windows helper gets this for free from `MonitorFromWindow`, and it is
   * the last-resort display when Electron's own list is momentarily empty (a
   * display being reconfigured). Never preferred over the dog's display — see
   * `isFullscreenWindow`.
   */
  readonly monitor?: Rect;
}

/** Who *we* are, so Walder's own window never puts him to sleep. */
export interface SelfIdentity {
  readonly names: readonly string[];
  readonly processId?: number;
}

/**
 * Owners that are the desktop rather than an app.
 *
 * On macOS the desktop is Finder and, with nothing else focused, the active
 * "window" can be reported as the Dock or the window server; on Windows it is
 * Explorer. Each of those legitimately spans the whole display, so treating
 * them as fullscreen would put Walder to sleep on an empty desktop — the one
 * moment the owner is most likely to be looking at him.
 */
const DESKTOP_OWNERS: readonly string[] = [
  'finder',
  'dock',
  'windowserver',
  'window server',
  'explorer',
  'windows explorer',
  'desktop window manager',
  'desktop'
];

/** Is this owner the desktop shell rather than an application? */
export function isDesktopOwner(name: string): boolean {
  return DESKTOP_OWNERS.includes(name.trim().toLowerCase());
}

/** Overlap area between two rects; 0 when they do not intersect. */
function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

/**
 * Which display the window is on: the one it overlaps most.
 *
 * `null` when it overlaps none of them, which happens while displays are being
 * reconfigured. "No display" is deliberately not fullscreen: guessing would put
 * the dog to sleep for a window nobody can see.
 */
export function displayFor(bounds: Rect, displays: readonly Rect[]): Rect | null {
  let best: Rect | null = null;
  let bestArea = 0;
  for (const display of displays) {
    const area = intersectionArea(bounds, display);
    if (area > bestArea) {
      bestArea = area;
      best = display;
    }
  }
  return best;
}

/** Does `bounds` cover `display` on all four edges, within `tolerance`? */
export function coversDisplay(
  bounds: Rect,
  display: Rect,
  tolerance: number = FULLSCREEN_TOLERANCE_PX
): boolean {
  return (
    bounds.x <= display.x + tolerance &&
    bounds.y <= display.y + tolerance &&
    bounds.x + bounds.width >= display.x + display.width - tolerance &&
    bounds.y + bounds.height >= display.y + display.height - tolerance
  );
}

/**
 * The macOS-shaped coverage rule: full width, on the bottom edge, and starting
 * no lower than the hidden menu bar.
 *
 * Four separate conditions rather than "covers all four edges", because on macOS
 * a fullscreen window does *not* reach the top of the display (see
 * `MENU_BAR_MAX_PX`) and relaxing `coversDisplay`'s top edge alone would let in
 * every maximised window there is. What is asserted instead is the shape only a
 * fullscreen window has:
 *
 *  - **exactly** the display's width (±2), not merely at least it — a window
 *    spanning two monitors is caught by `coversDisplay` instead;
 *  - the display's left edge (±2), which is what rejects the window *sliding*
 *    into a Space: the same 1728×1084 content window was measured at x = −1786
 *    mid-animation;
 *  - the display's bottom edge (within 2), which is what rejects a maximised
 *    window, since the Dock keeps one 66 px clear of it;
 *  - a top edge no more than `menuBarMax` below the display's.
 *
 * **Known false positive, accepted.** With the Dock hidden *and* auto-hide on,
 * a merely maximised window is reported at exactly the fullscreen geometry —
 * 1728×1084 at (0, 33) — and there is nothing left in the numbers to tell the
 * two apart. Walder will sleep for it. That is the right trade: with the Dock
 * hidden and a window filling the screen the owner is, to any useful definition,
 * looking at a fullscreen window, and the alternative (missing every real
 * fullscreen video) is the bug this rule exists to fix. Recorded in
 * `docs/QA-CHECKLIST.md` §6 as known behaviour.
 */
export function coversDisplayAllowingMenuBar(
  bounds: Rect,
  display: Rect,
  tolerance: number = FULLSCREEN_TOLERANCE_PX,
  menuBarMax: number = MENU_BAR_MAX_PX
): boolean {
  return (
    Math.abs(bounds.width - display.width) <= tolerance &&
    Math.abs(bounds.x - display.x) <= tolerance &&
    bounds.y + bounds.height >= display.y + display.height - tolerance &&
    bounds.y <= display.y + menuBarMax
  );
}

/** Is this window ours? Walder's own overlay must never put him to sleep. */
function isSelfWindow(win: ActiveWindowInfo, self: SelfIdentity): boolean {
  if (self.processId !== undefined && win.ownerProcessId === self.processId) return true;
  const owner = win.ownerName.trim().toLowerCase();
  return self.names.some((name) => name.trim().toLowerCase() === owner);
}

/**
 * Does this one window read as fullscreen on any display worth measuring
 * against?
 *
 * Either rule counts. `coversDisplay` is the strict, platform-neutral one — it
 * is what a Windows fullscreen window satisfies exactly, and what a window
 * *larger* than the display or spanning two of them satisfies — and
 * `coversDisplayAllowingMenuBar` is the macOS shape. Neither implies the other,
 * so both are asked.
 */
function windowCoversAnyDisplay(
  win: ActiveWindowInfo,
  displays: readonly Rect[],
  dogDisplay: Rect | null,
  tolerance: number
): boolean {
  // The dog's display, when we know it, is the *only* one that counts: a film
  // on the external monitor must not put a dog sitting on the laptop screen to
  // sleep. Without it, every display is a candidate, with the probe's own
  // monitor rect (which only the Windows helper reports) as the last resort.
  const candidates: readonly Rect[] =
    dogDisplay !== null
      ? [dogDisplay]
      : displays.length > 0
        ? displays
        : win.monitor === undefined
          ? []
          : [win.monitor];

  return candidates.some(
    (display) =>
      coversDisplay(win.bounds, display, tolerance) ||
      coversDisplayAllowingMenuBar(win.bounds, display, tolerance)
  );
}

/**
 * The verdict for one sample, given **every window of the frontmost app**.
 *
 * Asking about the *active* window alone is what made this feature look broken
 * for its whole life. macOS reports the topmost window of the frontmost app, and
 * for a browser playing a video fullscreen that is not the video: with YouTube
 * fullscreen in Chrome, `activeWindow()` returned the hidden toolbar strip —
 * **1728×115 at (0, 33)** — or, while the omnibox was up, a 451×50 popup. The
 * video itself was there the whole time, one entry further down the same app's
 * window list, at 1728×1084. So the caller hands over the whole list for that
 * app and any one of them may carry the verdict.
 *
 * The list is expected to be a single app's windows (`main/fullscreen-watch.ts`
 * filters it by the frontmost owner); ours and the desktop shell's are dropped
 * here anyway, since Walder's always-on-top overlay is genuinely reported as a
 * window and the desktop covers its display by definition. An empty list — no
 * active window at all — is not fullscreen: that is a locked screen or a moment
 * between focus changes, not a video.
 */
export function isFullscreenWindows(
  windows: readonly ActiveWindowInfo[],
  displays: readonly Rect[],
  self: SelfIdentity,
  dogDisplay: Rect | null = null,
  tolerance: number = FULLSCREEN_TOLERANCE_PX
): boolean {
  return windows.some((win) => {
    if (isSelfWindow(win, self)) return false;
    if (isDesktopOwner(win.ownerName)) return false;
    return windowCoversAnyDisplay(win, displays, dogDisplay, tolerance);
  });
}

/**
 * The whole verdict for one sample: a window that covers **the dog's** display,
 * is not ours, and is not the desktop.
 *
 * `null` (no active window at all) is not fullscreen — that is a locked screen
 * or a moment between focus changes, not a video.
 *
 * **Fullscreen is per display, not per machine.** `dogDisplay` is the display
 * the overlay window currently sits on, and when it is given it is the *only*
 * display that counts. Without it, a film playing fullscreen on the external
 * monitor put a dog sitting on the laptop screen to sleep — he vanished from a
 * screen nobody was watching a film on, which is both useless and impossible to
 * explain. A window that spans both displays covers the dog's too, so the
 * genuinely-everywhere case still reads as fullscreen.
 *
 * `dogDisplay` is `null` while there is momentarily no overlay window (it is
 * being rebuilt), and every display is then a candidate, with the probe's own
 * `monitor` after that.
 *
 * This is the one-window form of `isFullscreenWindows`, kept because the Windows
 * helper genuinely reports one window (`GetForegroundWindow`) and has no list to
 * offer. On macOS the list form is the one that must be used — see its comment
 * for why the *active* window is the wrong window to ask about.
 */
export function isFullscreenWindow(
  win: ActiveWindowInfo | null,
  displays: readonly Rect[],
  self: SelfIdentity,
  dogDisplay: Rect | null = null,
  tolerance: number = FULLSCREEN_TOLERANCE_PX
): boolean {
  return isFullscreenWindows(win === null ? [] : [win], displays, self, dogDisplay, tolerance);
}

/* ------------------------------------------------------------------ debounce */

export interface DebounceState {
  /** The state currently believed. */
  readonly fullscreen: boolean;
  /** How many consecutive samples have disagreed with it. */
  readonly streak: number;
}

export const DEBOUNCE_INITIAL: DebounceState = { fullscreen: false, streak: 0 };

/**
 * Require `needed` consecutive disagreeing samples before flipping.
 *
 * Without this, a single poll landing during a window animation — a video going
 * fullscreen takes a few hundred milliseconds, and the window is briefly neither
 * size — would make the dog vanish and reappear. Two polls at 2 s is a 4 s
 * commitment either way, which is imperceptible for something whose whole job is
 * "stay out of the way of a film".
 */
export function debounceFullscreen(
  state: DebounceState,
  raw: boolean,
  needed: number = DEBOUNCE_POLLS
): { state: DebounceState; changed: boolean } {
  if (raw === state.fullscreen) {
    if (state.streak === 0) return { state, changed: false };
    return { state: { fullscreen: state.fullscreen, streak: 0 }, changed: false };
  }

  const streak = state.streak + 1;
  if (streak < Math.max(1, needed)) {
    return { state: { fullscreen: state.fullscreen, streak }, changed: false };
  }
  return { state: { fullscreen: raw, streak: 0 }, changed: true };
}

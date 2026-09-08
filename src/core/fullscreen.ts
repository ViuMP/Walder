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
 * being rebuilt), and the old behaviour — the display the active window overlaps
 * most — is then the fallback, with the probe's own `monitor` after that.
 */
export function isFullscreenWindow(
  win: ActiveWindowInfo | null,
  displays: readonly Rect[],
  self: SelfIdentity,
  dogDisplay: Rect | null = null,
  tolerance: number = FULLSCREEN_TOLERANCE_PX
): boolean {
  if (win === null) return false;

  // Ours: Walder's own overlay is always-on-top and, on macOS, visible on
  // full-screen spaces, so it can genuinely be reported as the active window.
  // Sleeping because of it would be a loop: sleep, become active, stay asleep.
  if (self.processId !== undefined && win.ownerProcessId === self.processId) return false;
  const owner = win.ownerName.trim().toLowerCase();
  if (self.names.some((name) => name.trim().toLowerCase() === owner)) return false;

  if (isDesktopOwner(win.ownerName)) return false;

  const display = dogDisplay ?? displayFor(win.bounds, displays) ?? win.monitor ?? null;
  if (display === null) return false;
  return coversDisplay(win.bounds, display, tolerance);
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

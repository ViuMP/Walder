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
 *
 * That last sentence is only true while a menu bar or taskbar is *reserved*.
 * With the Windows taskbar on auto-hide nothing is, a maximised window reaches
 * past every edge of the display, and this tolerance alone lets it through;
 * `overhangsEveryEdge` is the rule that catches it (audit finding W6).
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
  /**
   * The window's Win32 class name (`GetClassName`), e.g. `Shell_TrayWnd`,
   * `Progman`, `CabinetWClass`, when the probe reports one.
   *
   * Windows only, and optional on purpose: macOS has no such thing, and a helper
   * line from before the field existed must still mean exactly what it meant
   * then. It is what lets `shellSurfaceOf` tell a *transient* shell surface (the
   * tray overflow flyout, Alt+Tab, Start) from the *real* desktop and from a
   * File Explorer folder window — all three are owned by `explorer.exe`, so the
   * owner name alone cannot. Absent, nothing in this module treats the window
   * any differently from before (M5, 2026-11).
   */
  readonly windowClass?: string;
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

/* ------------------------------------------------------- Windows shell surfaces */

/**
 * Windows window classes, owned by `explorer.exe`, that are a *transient shell
 * surface* rather than the desktop or a folder window.
 *
 * WHY THIS EXISTS (M5, F11 in the 0.2.8 Windows report). The Windows helper
 * reports the foreground window only, and before this every `explorer`-owned
 * window counted as "the desktop", i.e. not fullscreen. So with a film playing
 * and the dog asleep, opening the tray overflow flyout, Alt+Tab or Task View for
 * two polls (about four seconds) logged `fullscreen left` and stood him up over
 * a film that was still playing; he lay back down two polls after the film had
 * focus again. Those surfaces sit *on top of* whatever was in front and say
 * nothing about it, which is the same "unknown, hold" case as Walder himself in
 * front (`readFullscreen`).
 *
 * AN ALLOWLIST OF CLASSES, NEVER THE OWNER ALONE. File Explorer's folder windows
 * (`CabinetWClass`), the Run dialog (`#32770`) and Control Panel are explorer.exe
 * too, and a film closed onto a folder window must wake him — holding every
 * explorer window would leave him asleep indefinitely. The real desktop
 * (`Progman`, `WorkerW` — after Win+D or once the player is closed) is
 * deliberately *not* here either: it is the plainest "the film is over" there is.
 *
 * Written in their real Win32 spelling and compared case-insensitively
 * (`isShellSurface`). The spelling matters since M5b: the verbose hold line
 * prints the *entry from this list*, never the string the window reported, so
 * the list doubles as the set of class names that are safe to log — see
 * `knownShellSurface`.
 *
 * Confirmed on screen on Windows 11 26200 (2026-11-14): `Shell_TrayWnd` (the
 * taskbar), `TopLevelWindowForOverflowXamlIsland` (the tray overflow flyout),
 * `XamlExplorerHostIslandWindow` and `ForegroundStaging` (Alt+Tab, Task View).
 * The rest are the documented names of surfaces not seen on that build:
 * `NotifyIconOverflowWindow` for the Windows 10 overflow, `MultitaskingViewFrame`
 * for Task View and Alt+Tab on builds that still use it, `TaskListThumbnailWnd`
 * for the taskbar's hover thumbnails, `Shell_SecondaryTrayWnd` for the taskbar
 * on a second display. An unlisted class simply keeps the old behaviour (reads
 * as not fullscreen), which is the safe direction: a dog that wakes, never one
 * stuck asleep. See `docs/QA-CHECKLIST.md` §6 for the on-screen check.
 */
const SHELL_SURFACE_CLASSES: readonly string[] = [
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'NotifyIconOverflowWindow',
  'TopLevelWindowForOverflowXamlIsland',
  'XamlExplorerHostIslandWindow',
  'MultitaskingViewFrame',
  'TaskListThumbnailWnd',
  // Explorer parks the foreground on this invisible window for an instant
  // while it hands activation to something else; it is never a destination.
  'ForegroundStaging'
];

/**
 * Processes whose *every* window is a transient shell surface: Start
 * (`StartMenuExperienceHost`), Search (`SearchHost`, `SearchApp` on Windows 10),
 * the notification centre and Quick Settings (`ShellExperienceHost`,
 * `ShellHost`), the emoji panel / touch keyboard (`TextInputHost`), and the
 * Widgets board (`WidgetBoard`, Win+W).
 *
 * These are judged by owner because none of them ever shows an application
 * window — there is no folder-window trap like explorer's. Holding is also what
 * keeps a full-display host window from the opposite mistake: the TextInputHost
 * CoreWindow measures 0,0–1920,1200 on the test machine, and Start or Search may
 * be the same, so judged by geometry four seconds of Start on an empty desktop
 * would have put the dog to sleep.
 *
 * Keyed the way the Windows helper reports an owner: the .NET `ProcessName`,
 * which never carries `.exe`, compared case-insensitively. Written in the real
 * spelling for the same reason as `SHELL_SURFACE_CLASSES`: the hold line logs
 * the entry from this list, not the reported name.
 *
 * `WidgetBoard` (M5b): confirmed on screen on 26200 — the Widgets board's
 * foreground window is class `WindowsDashboard`, owner `WidgetBoard`, and before
 * this it read as an ordinary window, so Win+W over a film woke him in about
 * four seconds. Any program that happened to be *called* WidgetBoard and went
 * fullscreen would only ever be held, never slept over — bounded by
 * `SHELL_HOLD_MAX_MS`, after which it reads as not fullscreen — which is the
 * same safe direction as an unlisted class: a dog that wakes, never one stuck
 * asleep.
 */
const SHELL_HOST_OWNERS: readonly string[] = [
  'StartMenuExperienceHost',
  'SearchHost',
  'SearchApp',
  'ShellExperienceHost',
  'ShellHost',
  'TextInputHost',
  'WidgetBoard'
];

/**
 * Window classes seen in front for the `SHELL_HOST_OWNERS` processes.
 *
 * Not used to decide anything — a host owner is a shell surface whatever its
 * class. It exists only so that the verbose hold line can *name* the class: the
 * line prints an entry from a list in this file and never the reported string
 * (see `knownShellSurface`), so a class the line should name has to be listed.
 * Confirmed on screen on 26200: `Windows.UI.Core.CoreWindow` (Start and Search
 * under SearchHost, the notification centre under ShellExperienceHost),
 * `ControlCenterWindow` (Quick Settings under ShellHost), `WindowsDashboard`
 * (Widgets under WidgetBoard).
 */
const SHELL_HOST_CLASSES: readonly string[] = ['Windows.UI.Core.CoreWindow', 'ControlCenterWindow', 'WindowsDashboard'];

/** The entry of `list` that `value` names, case-insensitively, or `null`. */
function listed(list: readonly string[], value: string): string | null {
  const key = value.trim().toLowerCase();
  return list.find((entry) => entry.toLowerCase() === key) ?? null;
}

/**
 * Is this window a transient Windows shell surface — something that sits over
 * whatever was in front without saying anything about it?
 *
 * Only ever true for a report that carries a `windowClass`, i.e. the Windows
 * helper: macOS reports and old-shape helper lines are untouched.
 */
export function isShellSurface(win: ActiveWindowInfo): boolean {
  return knownShellSurface(win) !== null;
}

/**
 * A recognised shell surface, named *from this module's own lists*.
 *
 * `owner` and `windowClass` are entries of `SHELL_HOST_OWNERS` /
 * `SHELL_SURFACE_CLASSES` / `SHELL_HOST_CLASSES` (or the literal `explorer`) —
 * constants in this file, never the string the window reported. That is the
 * whole point (M5b): the hold line wants to name the class so an on-screen check
 * can read it, and window classes are chosen by whoever wrote the window, so
 * logging the reported string would let any program put text of its choosing
 * into the log. `windowClass` is `null` for a host-owned window whose class is
 * not listed; `classLength` is then the only thing said about it.
 */
export interface KnownShellSurface {
  readonly owner: string;
  readonly windowClass: string | null;
  readonly classLength: number;
}

/** The recognised shell surface this window is, or `null` — see `KnownShellSurface`. */
export function knownShellSurface(win: ActiveWindowInfo): KnownShellSurface | null {
  if (win.windowClass === undefined) return null;
  const classLength = win.windowClass.trim().length;
  const host = listed(SHELL_HOST_OWNERS, win.ownerName);
  if (host !== null) return { owner: host, windowClass: listed(SHELL_HOST_CLASSES, win.windowClass), classLength };
  if (win.ownerName.trim().toLowerCase() !== 'explorer') return null;
  const cls = listed(SHELL_SURFACE_CLASSES, win.windowClass);
  return cls === null ? null : { owner: 'explorer', windowClass: cls, classLength };
}

/**
 * How long a shell surface may hold the last state before it is read for what
 * it is — not fullscreen.
 *
 * The hold has to be bounded, unlike the Walder-in-front one. That hold is safe
 * because it ends the moment any other app is activated; a shell surface can be
 * where the foreground *lands* when the player closes or minimises — very often
 * the taskbar (`Shell_TrayWnd`) rather than the desktop — and an unbounded hold
 * there would leave the dog asleep with no film at all.
 *
 * Fifteen seconds: comfortably longer than anyone keeps a flyout, Alt+Tab or
 * Start open over a film (a few seconds), and short enough that the worst case
 * — player closed onto the taskbar — wakes him within this plus the ordinary
 * two-poll debounce, about twenty seconds, without anybody touching anything.
 */
export const SHELL_HOLD_MAX_MS = 15_000;

/** Where a shell-surface hold stands: when the current episode began, or `null`. */
export interface ShellHoldState {
  readonly since: number | null;
}

export const SHELL_HOLD_INITIAL: ShellHoldState = { since: null };

/**
 * Bound a shell-surface hold in time.
 *
 * `reading` is what `readFullscreen` said for this sample and `shell` whether
 * the sample was a shell surface (`windows.some(isShellSurface)` — see
 * `readFullscreen`). Inside the bound the reading is `null` (hold, exactly as
 * `debounceFullscreen` already treats Walder in front); once the same unbroken
 * episode has lasted `maxMs` it becomes `false`, and the ordinary debounce then
 * wakes him. Any sample that is *not* a shell surface ends the episode and
 * passes through untouched.
 *
 * Measured in time, not in polls, on purpose: the helper and the watch run on
 * two independent 2 s clocks, so one helper line can be read twice or skipped,
 * and a poll count would mean a different number of seconds every time.
 */
export function boundShellHold(
  hold: ShellHoldState,
  reading: boolean | null,
  shell: boolean,
  now: number,
  maxMs: number = SHELL_HOLD_MAX_MS
): { hold: ShellHoldState; reading: boolean | null; expired: boolean } {
  if (!shell) return { hold: SHELL_HOLD_INITIAL, reading, expired: false };
  const since = hold.since ?? now;
  const expired = now - since >= maxMs;
  return { hold: { since }, reading: expired ? false : null, expired };
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
 * How far past **every** edge of the display a window must reach to be a
 * *maximised* window rather than a fullscreen one. In the units the decision
 * runs in, which on Windows are Electron DIPs (see "THE SPACE" below).
 *
 * WHY THIS EXISTS (audit 2026-11, finding W6; confirmed on screen on Windows 11
 * 26200, 2026-11-16). With **Automatically hide the taskbar** on, the taskbar
 * reserves nothing, so the work area is the whole monitor and a maximised window
 * covers the display. `coversDisplay` accepts anything that reaches or passes
 * every edge, so any maximised ordinary window in front logged `fullscreen
 * entered` within about four seconds and the dog slept — for most of the working
 * day. The same holds on a second monitor that carries no taskbar.
 *
 * WHAT SEPARATES THE TWO. Windows does not place a maximised window *on* the
 * monitor. It places it so that the window's invisible resize border hangs off
 * all four sides, and that border is in `GetWindowRect`. A fullscreen window has
 * no such border and sits on the monitor exactly. Measured in physical pixels on
 * one 1920 × 1200 display at 125 % (120 DPI), auto-hide on, with the helper's
 * own calls (`main/fullscreen-win.ps1`); overhang is left/top/right/bottom:
 *
 *   maximised — all read as fullscreen before this rule
 *     Notepad                               -9,-9 – 1929,1209     9/9/9/9
 *       (identical with the taskbar slid into view)
 *     a WinForms bordered window            -10,-10 – 1930,1210   10/10/10/10
 *     Claude desktop (Electron, own frame)  -8,-8 – 1928,1208     8/8/8/8
 *     Electron, framed                      -9,-9 – 1929,1209     9/9/9/9
 *     Electron, `frame: false`              -9,-9 – 1929,1209     9/9/9/9
 *     File Explorer                         -9,-9 – 1929,1209     9/9/9/9
 *       (a desktop owner, so never fullscreen whatever its rect)
 *   fullscreen — must stay fullscreen
 *     a borderless full-display window      0,0 – 1920,1200       0/0/0/0
 *     Electron HTML element fullscreen      0,0 – 1920,1200       0/0/0/0
 *       (`requestFullscreen`, the path a browser video takes)
 *     Electron `setFullScreen(true)`        0,0 – 1920,1200       0/0/0/0
 *       (the path a browser's F11 takes)
 *
 * So the rule is geometry and nothing else: a window that sticks out past all
 * four edges by at least this much is maximised. One edge is not enough, and
 * that is deliberate — a window spanning two monitors overhangs the dog's
 * display on one side only and must go on reading as fullscreen, as must a
 * window that is merely larger than the display on some sides.
 *
 * THE SPACE. `isFullscreenWindows` is handed DIPs. On Windows
 * `main/fullscreen-watch.ts` puts every helper sample through `winSampleToDip`
 * before the decision sees it (M3): a `"physical":1` line is mapped edge by edge
 * through its monitor's scale and each edge rounded (`main/win-dpi.ts`,
 * `physicalToDip`), and the display it is compared with is Electron's
 * `Display.bounds`. So the overhang this constant is compared with is the
 * physical border divided by the display scale, give or take half a DIP:
 *
 *   scale   border, physical px             overhang as the decision sees it
 *   100 %   8  (measured, same day)       8         (7 is tested too, as a margin)
 *   125 %   8, 9, 10  (measured, above)     6, 7, 8   (6.4, 7.2 and 8.0, rounded)
 *   150 %   8–12  (reckoned)                5–8       (5.33 … 8.0)
 *   200 %   8–16  (reckoned)                4–8       (4.0 … 8.0)
 *
 * The border grows with the DPI — about 8 px at 96 DPI, 9–10 at 120 — so 12 px
 * at 150 % and 16 px at 200 % are what is reckoned, which is 8 DIPs at any
 * scale. The low end of each reckoned row is the pessimistic case of a window
 * whose border does *not* grow and stays at the 8 px the Claude desktop app
 * showed at 125 %. Nothing at 150 % or 200 % has been measured.
 *
 * A helper too old to report physical pixels (no `"physical":1`) is passed
 * through in Windows' own 96-DPI logical units, where the same border is already
 * divided by the scale; the table holds for it too.
 *
 * WHY THREE. It has to sit above everything a *fullscreen* window can show and
 * below everything a *maximised* one can:
 *
 *  - above `FULLSCREEN_TOLERANCE_PX` (2), so the slack that rule grants inwards
 *    is granted outwards as well: a fullscreen window that overscans the
 *    display by a pixel or two — some borderless games do — still reads as
 *    fullscreen. Rounding adds nothing to that: `physicalToDip` maps edges, so a
 *    window exactly on its monitor lands exactly on the DIP display, and 2
 *    physical pixels are at most 2 DIPs at any scale of 100 % or more;
 *  - below the smallest overhang in the table, 4 (reckoned; the smallest
 *    measured is 6), with a DIP to spare for the rounding.
 *
 * Three is one above the first and one below the second.
 *
 * NOT WINDOWS-ONLY, although only Windows produces the shape. The rule is
 * arithmetic on two rects, and this module has no notion of platform. On macOS
 * it changes nothing measured: a fullscreen window there is the display's width
 * at the display's left edge and never overhangs (see `MENU_BAR_MAX_PX`), and
 * neither does a maximised one.
 *
 * WHAT IT DOES NOT CATCH, accepted. A window that is *restored* (not maximised)
 * and happens to have been sized to the display exactly — measured: a captioned
 * window at 0,0 – 1920,1200, overhang 0/0/0/0 — has the geometry of a film and
 * still reads as fullscreen; nothing in a rect can tell them apart. The same
 * goes for an application that clamps its own maximised window to the work area
 * instead of letting Windows overhang it. Out of scope here: it needs a second
 * signal (the window's maximised state), not more geometry.
 */
export const MAXIMISED_OVERHANG_MIN_PX = 3;

/**
 * Does `bounds` stick out past **all four** edges of `display` by at least
 * `min`? That is the shape of a maximised Windows window with no taskbar
 * reserved, and of nothing fullscreen — see `MAXIMISED_OVERHANG_MIN_PX`.
 */
export function overhangsEveryEdge(
  bounds: Rect,
  display: Rect,
  min: number = MAXIMISED_OVERHANG_MIN_PX
): boolean {
  return (
    display.x - bounds.x >= min &&
    display.y - bounds.y >= min &&
    bounds.x + bounds.width - (display.x + display.width) >= min &&
    bounds.y + bounds.height - (display.y + display.height) >= min
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
 *
 * One shape is taken back out of `coversDisplay`'s "larger than the display":
 * larger on **every** side by a resize border's worth, which is a maximised
 * Windows window with no taskbar reserved and not a fullscreen one (W6 — see
 * `MAXIMISED_OVERHANG_MIN_PX`). It is asked per display, like the coverage
 * itself, so a window maximised on one monitor says nothing about another. The
 * macOS rule needs no such exception: it demands the display's own width, which
 * a window overhanging both sides cannot have.
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
      (coversDisplay(win.bounds, display, tolerance) && !overhangsEveryEdge(win.bounds, display)) ||
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
 * The verdict for one sample, **or `null` when Walder himself is in front**.
 *
 * Clicking the dog makes Walder the frontmost app — Electron's panel window
 * still activates its app on a click — so a pet over a fullscreen film hands
 * the probe nothing but our own 88×120 overlay. `isFullscreenWindows` rightly
 * refuses to count our own window, but a plain `false` then reads as "the film
 * is over": two polls later the debounce logged `fullscreen left` and stood a
 * sleeping dog up while the video was still playing (QA 6.3, seen twice on
 * 0.2.8), and he stayed up until the owner clicked the video again.
 *
 * Walder in front says nothing about what is behind him, so it is *unknown*,
 * and unlike a probe failure it is an unknown with no time limit: it lasts for
 * as long as the dog stays frontmost, which can be until the owner touches
 * another app — and that activation is itself the next reading. Holding,
 * rather than decaying after `UNKNOWN_HOLD_MS` the way a failing probe does,
 * is safe precisely because the hold ends the moment anything else is in
 * front. `debounceFullscreen` treats `null` as "hold".
 *
 * Only a list that is *entirely* ours counts: the probe returns one app's
 * windows, so a mixed list is not expected, and if one ever arrived the other
 * windows are real evidence and the ordinary verdict should decide.
 *
 * **A Windows shell surface in front is the same kind of unknown** (M5): the
 * tray overflow flyout, Alt+Tab, Start and the rest sit over the film without
 * saying anything about it — see `isShellSurface`. Unlike Walder in front, that
 * hold has no natural end (the foreground can *land* on the taskbar when the
 * player closes), so the caller bounds it with `boundShellHold`; `shellInFront`
 * is how it knows which kind of `null` this was.
 */
export function readFullscreen(
  windows: readonly ActiveWindowInfo[],
  displays: readonly Rect[],
  self: SelfIdentity,
  dogDisplay: Rect | null = null,
  tolerance: number = FULLSCREEN_TOLERANCE_PX
): boolean | null {
  if (
    windows.length > 0 &&
    windows.every((win) => isSelfWindow(win, self) || isShellSurface(win))
  ) {
    return null;
  }
  return isFullscreenWindows(windows, displays, self, dogDisplay, tolerance);
}

/**
 * Was this sample's `null` from `readFullscreen` a shell surface in front
 * (bounded hold) rather than Walder alone (unbounded hold)?
 */
export function shellInFront(windows: readonly ActiveWindowInfo[], self: SelfIdentity): boolean {
  return (
    windows.some((win) => !isSelfWindow(win, self) && isShellSurface(win)) &&
    windows.every((win) => isSelfWindow(win, self) || isShellSurface(win))
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
 *
 * A `null` sample holds — see `readFullscreen`.
 */
export function debounceFullscreen(
  state: DebounceState,
  raw: boolean | null,
  needed: number = DEBOUNCE_POLLS
): { state: DebounceState; changed: boolean } {
  // `null` is "Walder, or a Windows shell surface, is in front, so this sample
  // saw nothing" (see `readFullscreen`): neither agreement nor disagreement, so
  // the state *and* any part-built streak are left exactly as they were.
  if (raw === null) return { state, changed: false };
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

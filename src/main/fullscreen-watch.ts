/**
 * Watching for a fullscreen window, so Walder can get out of the way.
 *
 * The decision is `core/fullscreen.ts`; this is the polling and the OS call
 * around it. There are two OS calls, one per platform, and they answer the same
 * question in deliberately different ways:
 *
 * **macOS — `get-windows`, the window *list*, not the active window.** Sindre
 * Sorhus's maintained successor to `active-win` reports window bounds and
 * owners. On macOS it runs a small bundled Swift binary. Asking it for the
 * *active* window is the obvious thing to do and is wrong: it answers with the
 * topmost window of the frontmost app, and for a browser playing a video
 * fullscreen that is not the video. Measured on macOS 26 with YouTube fullscreen
 * in Chrome, `activeWindow()` reported Chrome's hidden toolbar strip —
 * 1728×115 at (0, 33) — while `openWindows()` listed that *and* the video, at
 * 1728×1084. So `activeWindow()` is used only to learn **which app** is in
 * front, and `openWindows()` supplies every window that app has; the decision
 * takes the lot (`core/fullscreen.ts`, `isFullscreenWindows`).
 *
 * `openWindows()`'s own front-to-back order is deliberately *not* used to find
 * the frontmost app, tempting though it is (it would halve the cost): Walder's
 * overlay is always-on-top, so it is reliably the *first* entry in that list and
 * would be mistaken for the frontmost app on every single poll.
 *
 * Cost of the extra call, measured over ten samples on the development machine:
 * `activeWindow()` 50 ms median, `openWindows()` 50 ms, both together in
 * parallel 77 ms (sequentially, 98 ms). So a poll went from ~50 ms to ~77 ms
 * every 2 s, and nearly all of it is this process waiting on a spawned Swift
 * binary rather than burning CPU. The cadence therefore stays at 2 s — see
 * `POLL_MS`. Window *titles* need the Screen Recording
 * permission and the browser *URL* needs Accessibility — and asking for either
 * would pop a system dialog from an app with no visible window, which is exactly
 * the experience this project refuses to inflict. We need neither: bounds and
 * owner name come back without any permission at all. So both checks are turned
 * off explicitly (`screenRecordingPermission: false`,
 * `accessibilityPermission: false`), which the package documents as suppressing
 * the prompts; `title` then always arrives as an empty string, and we never read
 * it.
 *
 * **Windows — a PowerShell helper.** `get-windows` on Windows is a compiled
 * N-API addon, and a build produced on a Mac ships no Windows binary: the
 * packaged Windows app could not load it. Rather than take on a per-platform
 * native build for one geometry question, `fullscreen-win.ps1` answers it with
 * P/Invoke against `user32.dll` — no compilation, no dependency, present on
 * every supported Windows. It is spawned **once** and streams one JSON line per
 * sample; this file parses the lines and feeds the same pure decision function.
 * The `get-windows` import is therefore guarded by platform and never evaluated
 * on Windows, so its addon is never required (and packaging excludes it from the
 * Windows build).
 *
 * **Fail-soft, and never permanently.** A probe that throws means "we cannot
 * tell" — *unknown*, which is not the same as "not fullscreen". The earlier
 * version conflated the two and then gave up for good after three consecutive
 * failures, which is exactly how this feature died in practice: switching into a
 * macOS full-screen Space makes `activeWindow()` return `undefined` for about
 * three seconds, so the *first real fullscreen video of the session* produced
 * three failures in a row and killed the watch for the rest of the app's life.
 * Now: failures are counted only consecutively and reset on any success; after
 * three the cadence backs off from 2 s to 10 s but the probing never stops;
 * after thirty a single warning is logged; and an unknown holds the previous
 * state for up to ten seconds before falling back to "not fullscreen", so a
 * Space transition cannot flap a sleeping dog awake and back. The only
 * deterministic, permanent give-up left is a platform with no probe at all.
 *
 * **Unknown is not always a failure (2026-11-14, audit decision 13).**
 * `activeWindow()` answers `undefined` whenever it finds no window for the app
 * in front. That is the Space transition above, and it is also an app in front
 * that has no window at all, for as long as it stays there — seen on the Mac
 * that day (the cause inferred), where every poll of a long stretch was counted
 * as a failed probe: the cadence dropped to 10 s, the thirty-failures warning
 * blamed a missing get-windows build that was answering every call, and the fullscreen
 * window brought forward next took about 22 s to put the dog to sleep. So an
 * `undefined` from a sample in which `openWindows()` did list windows is still
 * *unknown* — the same hold and the same decay — but it is not a failure:
 * nothing is counted, nothing is warned about, and the next reading comes at
 * 2 s. See `NoActiveWindowError`. It is deliberately not read as "nothing in
 * front", which is "not fullscreen": two polls of that inside a Space
 * transition are enough to stand a sleeping dog up.
 */
import { spawn } from 'node:child_process';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, screen } from 'electron';
import {
  DEBOUNCE_INITIAL,
  SHELL_HOLD_INITIAL,
  SHELL_HOLD_MAX_MS,
  boundShellHold,
  debounceFullscreen,
  isShellSurface,
  knownShellSurface,
  readFullscreen,
  shellInFront,
  type ActiveWindowInfo,
  type DebounceState,
  type KnownShellSurface,
  type SelfIdentity,
  type ShellHoldState
} from '../core/fullscreen';
import type { Rect } from '../core/geometry';
import { info, redact, vlog, warn } from './log';
import { sampleToDip, type DisplayUnits } from './win-dpi';

/** How often the active window is sampled. */
export const POLL_MS = 2_000;

/**
 * Consecutive failures after which the cadence backs off. Not a give-up: the
 * watch keeps probing at `BACKOFF_POLL_MS` until something answers.
 */
export const BACKOFF_AFTER_FAILURES = 3;

/**
 * The slow cadence used while the probe is failing. Slow enough that a genuinely
 * broken probe costs nothing measurable, fast enough that a transient one — a
 * display being reconfigured — is picked back up long before the owner could
 * notice. (Since 2026-11-14 a probe that answers "no active window" while it
 * still lists windows in the same sample is unknown without being a failure,
 * and stays on the fast cadence — see `NoActiveWindowError`. A Space transition
 * is expected to be that case, since Walder's own overlay should be listed, but
 * that is not yet checked on screen; one that lists nothing is still a failure
 * here.)
 */
export const BACKOFF_POLL_MS = 10_000;

/** Consecutive failures after which exactly one warning is logged. */
export const WARN_AFTER_FAILURES = 30;

/**
 * How long an unreadable probe keeps the state it last knew.
 *
 * A failure is "unknown", and the honest answer to unknown is the previous
 * answer — for a while. Ten seconds covers the ~3 s of `undefined` that a macOS
 * Space transition produces, so a dog asleep over a film does not stand up and
 * lie down again as the video enters or leaves fullscreen. Past that, "unknown"
 * decays to "not fullscreen", because the failure mode that must never happen is
 * a dog stuck asleep forever behind a broken probe.
 */
export const UNKNOWN_HOLD_MS = 10_000;

/** Platforms with a probe. Anything else never polls at all. */
export const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'win32'];

export interface FullscreenWatchDeps {
  /** Called only when the debounced state actually flips. */
  readonly onChange: (fullscreen: boolean) => void;
  /**
   * Which application is in front, as its bundle path — on every successful
   * poll, not only on a change.
   *
   * A second question answered by a probe that is already running. The owner
   * coming back to a terminal is what should take that session's `done` and
   * `?` off the screen (Victor, 2026-09-21), and this watch is the only thing
   * in the app that asks the OS what is in front. Adding a second poller for
   * it would be a second Swift binary spawned every two seconds to learn
   * something this one already knows.
   *
   * Not called when the probe reports no path, which is every Windows sample
   * (the PowerShell helper has a name and no bundle) and any macOS answer with
   * an empty `owner.path`.
   *
   * ponytail: it rides on the fullscreen poll, so it stops when the owner
   * unticks **Sleep during fullscreen video**. Ceiling: with that off, a `done`
   * waits for a click or a prompt as it always did. Upgrade path: give the
   * watch its own `enabled` for this half, once anyone minds.
   */
  readonly onFrontmost?: (app: string) => void;
  /** The tray checkbox. `false` stops the polling entirely. */
  readonly enabled: () => boolean;
  readonly intervalMs?: number;
  /**
   * Injected in tests; defaults to the per-platform probe below.
   *
   * A list, one window, or `null`. The macOS probe returns every window of the
   * frontmost app (which is the whole point — see the note at the top of this
   * file); the Windows helper has only `GetForegroundWindow` and returns one.
   * All three shapes are normalised to a list before the decision sees them.
   * A probe that throws is "unknown"; one that throws `NoActiveWindowError` is
   * unknown from a probe that is plainly alive, which is not a failure.
   */
  readonly probe?: () => Promise<ActiveWindowInfo | readonly ActiveWindowInfo[] | null>;
  /** Injected in tests; defaults to the live display bounds. */
  readonly displays?: () => Rect[];
  /**
   * Windows only: every display in DIPs *and* physical pixels, which is what a
   * physical-pixel helper sample is mapped through (`main/win-dpi.ts`).
   * Injected in tests; defaults to `screen.getAllDisplays()` with each bounds
   * put through `screen.dipToScreenRect`, which is win32-only and therefore
   * never called on macOS.
   */
  readonly winDisplays?: () => readonly DisplayUnits[];
  /**
   * Windows only: start the helper. Injected in tests, so the path from a
   * helper line to the decision (the mapping above included) can be driven
   * with a fake child process; defaults to spawning `fullscreen-win.ps1`.
   */
  readonly spawnWinHelper?: () => HelperProcess;
  /**
   * The display the overlay window is currently on, or `null` when there is
   * momentarily no window. Fullscreen is decided against *this* display — see
   * `isFullscreenWindow`.
   */
  readonly dogDisplay?: () => Rect | null;
  readonly self?: () => SelfIdentity;
  /** Injected in tests; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Injected in tests, so the unknown-hold window can be crossed instantly. */
  readonly now?: () => number;
}

export interface FullscreenWatch {
  start(): void;
  stop(): void;
  isFullscreen(): boolean;
  /** Poll once now, rather than waiting for the next tick. */
  pollNow(): Promise<void>;
  /**
   * The tray switch was flipped. Stops the timer when off and restarts it (and
   * clears a `broken` watch) when on — see the note on the implementation.
   */
  setEnabled(on: boolean): void;
}

/* ------------------------------------------------------------------- macOS */

/** One `get-windows` entry point. */
type WindowQuery = (options?: unknown) => Promise<unknown>;

/** Cached module handles; `null` until the first successful import. */
let macWindows: { active: WindowQuery; open: WindowQuery } | null = null;

/**
 * Which file of `get-windows` to load — always `lib/macos.js`, by absolute path.
 *
 * Two separate traps here, and the second one cost a working feature in every
 * release until it was found by launching a real packaged build (2026-09-08).
 *
 * **1. The unpacked copy, not the archived one.** `get-windows` locates its
 * Swift helper as `path.join(__dirname, '../main')`, derived from its own
 * `import.meta.url`. Loaded from inside the asar, that resolves to
 * `…/app.asar/node_modules/get-windows/main` — a path *through* a file — so
 * `execFile` fails with `ENOTDIR`, the watch fail-softs three times and gives
 * up. `asarUnpack` is necessary but not sufficient: it puts a real copy on disk,
 * while the module still *resolves* to the archived path, and `import.meta.url`
 * reports where a module was resolved from rather than where its bytes came
 * from. So the unpacked copy is imported by absolute path, and the package's own
 * `__dirname` then points at the real directory next to the real binary.
 *
 * **2. `lib/macos.js`, never `index.js`.** The package entry point *statically*
 * imports `./lib/windows.js` for its sync variants, and that file requires
 * `@mapbox/node-pre-gyp`. A static ESM import is resolved whatever the platform,
 * so importing the entry point on **macOS** demands the Windows addon's build
 * tooling too. In a packaged app that fails outright: `node-pre-gyp` is an
 * optional dependency that lands *inside* `app.asar`, while `get-windows` is
 * unpacked beside it — and Node resolves a dependency relative to the importing
 * file, so from `app.asar.unpacked/node_modules/get-windows/` the archived copy
 * is invisible. Result, in every packaged mac build: `Cannot find package
 * '@mapbox/node-pre-gyp'`, three failures, watch abandoned, dog never sleeps
 * over video. `lib/macos.js` imports nothing but node built-ins and the sibling
 * `../main` binary, so going straight to it sidesteps the whole problem and
 * needs no extra `asarUnpack` entries.
 *
 * The package's `exports` map does not expose `lib/`, so this cannot be a bare
 * specifier (`ERR_PACKAGE_PATH_NOT_EXPORTED`) — hence a file URL in dev as well,
 * which has the happy side effect of making both paths the same shape. In dev
 * `app.getAppPath()` is the project root; packaged it is `…/Resources/app.asar`,
 * and electron-builder writes the unpacked tree beside it as `app.asar.unpacked`.
 */
function getWindowsSpecifier(): string {
  const root = app.isPackaged ? `${app.getAppPath()}.unpacked` : app.getAppPath();
  return pathToFileURL(join(root, 'node_modules', 'get-windows', 'lib', 'macos.js')).href;
}

/** The permissions note at the top of this file, as an options object. */
const MAC_OPTIONS = {
  screenRecordingPermission: false,
  accessibilityPermission: false
} as const;

/**
 * One `get-windows` report -> the shape the decision takes, or `null` when it
 * carries no usable geometry.
 */
function toWindowInfo(raw: unknown): ActiveWindowInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const win = raw as {
    bounds?: Rect;
    owner?: { name?: unknown; processId?: unknown; path?: unknown };
  };
  const bounds = win.bounds;
  if (
    typeof bounds !== 'object' ||
    bounds === null ||
    !['x', 'y', 'width', 'height'].every(
      (key) => typeof (bounds as unknown as Record<string, unknown>)[key] === 'number'
    )
  ) {
    return null;
  }

  const name = typeof win.owner?.name === 'string' ? win.owner.name : '';
  const pid = typeof win.owner?.processId === 'number' ? win.owner.processId : undefined;
  // `owner.path` is the `.app` bundle on macOS, which is the same string the
  // raise walk produces for a session's pid — see `onFrontmost` below.
  const path = typeof win.owner?.path === 'string' && win.owner.path !== '' ? win.owner.path : undefined;
  return {
    bounds,
    ownerName: name,
    ...(pid === undefined ? {} : { ownerProcessId: pid }),
    ...(path === undefined ? {} : { ownerPath: path })
  };
}

/** Are these two reports from the same application? */
function sameOwner(a: ActiveWindowInfo, b: ActiveWindowInfo): boolean {
  if (a.ownerProcessId !== undefined && b.ownerProcessId !== undefined) {
    return a.ownerProcessId === b.ownerProcessId;
  }
  return a.ownerName.trim().toLowerCase() === b.ownerName.trim().toLowerCase();
}

/**
 * The probe ran and answered, but found no window for the app in front:
 * *unknown*, and not a failure.
 *
 * WHY (2026-11-14, audit decision 13). `get-windows` turns its binary's "no
 * result" into `undefined` (`lib/macos.js`), and "no result" is what was
 * recorded mid Space transition and what was seen, for minutes on end, with an
 * app in front that has no window (inferred). A binary that ran and listed
 * other windows in the same sample is not a missing or unsupported build, so
 * the watch must not back off or warn as if it were (see the note at the top of
 * this file for what that cost). It is a subclass rather than a return value
 * because it *is* still an unknown: it takes the same hold and the same decay
 * as any other throw, and only the failure count treats it differently.
 */
export class NoActiveWindowError extends Error {}

/**
 * The two `get-windows` answers -> every window of the frontmost app.
 *
 * Apart from the I/O so that the one judgement in here the OS cannot be made to
 * produce on demand — "`undefined`, but the probe is alive" — is a unit test.
 */
export function frontmostWindows(rawActive: unknown, rawOpen: unknown): ActiveWindowInfo[] {
  const all = Array.isArray(rawOpen)
    ? rawOpen.map(toWindowInfo).filter((win): win is ActiveWindowInfo => win !== null)
    : [];

  // `undefined` is the package's "I could not determine the active window", and
  // it is never read as an empty desktop: switching Spaces produces a few
  // seconds of it, and the caller's unknown-hold is what makes that harmless.
  // Whether it also counts as a *failed probe* depends on the other answer. A
  // list with windows in it proves the binary ran and can see the screen; an
  // empty one proves nothing, and stays the failure it always was — which is
  // what keeps a build that answers "nothing" to everything backing off and
  // being warned about.
  if (rawActive === undefined) {
    if (all.length > 0) {
      throw new NoActiveWindowError('get-windows found no window for the frontmost app');
    }
    throw new Error('get-windows returned undefined: the active window could not be determined');
  }
  // `null` is different: a genuine "nothing is focused".
  if (rawActive === null) return [];

  const active = toWindowInfo(rawActive);
  if (active === null) {
    throw new Error('get-windows reported an active window with no bounds');
  }

  // Every window the frontmost app owns, including the one the OS calls active.
  // A list that somehow contains none of them (or no list at all) falls back to
  // the active window on its own, which is strictly the old behaviour.
  const owned = all.filter((win) => sameOwner(win, active));
  return owned.length > 0 ? owned : [active];
}

/**
 * Ask macOS for every window belonging to the app that is in front.
 *
 * Two calls, in parallel: `activeWindow()` names the frontmost app and
 * `openWindows()` lists everything, from which that app's windows are kept.
 * Measured at ~64 ms and ~56 ms respectively on the development machine, issued
 * together, so a poll costs roughly one of them. See the note at the top of this
 * file for why the active window alone is the wrong question, and why the list's
 * own ordering cannot stand in for `activeWindow()`.
 *
 * The import is dynamic so a platform where the package cannot load at all costs
 * a caught rejection rather than a failure to start the app, and so the
 * (few hundred ms) first-call cost is not paid during launch. It is only ever
 * reached on darwin (see the probe selection in `createFullscreenWatch`), and it
 * loads `lib/macos.js` rather than the package entry — which is what keeps the
 * Windows addon and its build tooling out of the picture on *both* platforms.
 * See `getWindowsSpecifier` for why that distinction is load-bearing.
 */
async function probeFrontmostWindows(): Promise<ActiveWindowInfo[]> {
  if (macWindows === null) {
    const mod = (await import(getWindowsSpecifier())) as {
      activeWindow: WindowQuery;
      openWindows: WindowQuery;
    };
    macWindows = { active: mod.activeWindow, open: mod.openWindows };
  }

  const [rawActive, rawOpen] = await Promise.all([
    macWindows.active(MAC_OPTIONS),
    macWindows.open(MAC_OPTIONS)
  ]);
  return frontmostWindows(rawActive, rawOpen);
}

/* ----------------------------------------------------------------- Windows */

/** One `l/t/r/b` rect from the helper. */
interface EdgeRect {
  readonly l: number;
  readonly t: number;
  readonly r: number;
  readonly b: number;
}

function isEdgeRect(value: unknown): value is EdgeRect {
  if (typeof value !== 'object' || value === null) return false;
  const rect = value as Record<string, unknown>;
  return (['l', 't', 'r', 'b'] as const).every(
    (key) => typeof rect[key] === 'number' && Number.isFinite(rect[key])
  );
}

/** `{l, t, r, b}` (Win32) -> `{x, y, width, height}` (everything else here). */
function toRect(edges: EdgeRect): Rect {
  return {
    x: edges.l,
    y: edges.t,
    width: edges.r - edges.l,
    height: edges.b - edges.t
  };
}

/**
 * One helper sample: an `ActiveWindowInfo`, plus whether its rects are in
 * physical pixels.
 *
 * `physical` is present (and `true`) only when the helper says so with
 * `"physical":1` — that is, when it managed to make its sampling thread
 * per-monitor DPI aware. A line without it is in the 96-DPI logical space of a
 * DPI-unaware process, which is what every helper wrote before audit finding
 * M3 and what one still writes on a Windows too old for per-monitor awareness.
 * The two need different handling — see `main/win-dpi.ts` — so the flag is
 * carried rather than guessed from the numbers.
 */
export interface WinWindowInfo extends ActiveWindowInfo {
  readonly physical?: true;
}

/**
 * A helper sample in the units the decision uses (Electron DIPs).
 *
 * A physical-pixel sample is mapped through the display Windows put the window
 * on (`sampleToDip`); a logical one is passed through untouched, because it is
 * already in DIP-compatible units on a single display and scaling it again would
 * break the case that works (see `main/win-dpi.ts`). The `physical` flag is
 * dropped either way: past this point every rect is in DIPs.
 *
 * `displays` is a function so the live display list — and its
 * `dipToScreenRect` calls — is only read for a sample that needs it.
 *
 * **A shell surface is never dropped here** (M3 x M5). `sampleToDip` answers a
 * physical sample that lands on no known display with `null` — "no window",
 * read as not fullscreen — which is the right call for an ordinary window. But
 * a transient shell surface (taskbar, tray flyout, Alt+Tab, Start…) is judged by
 * its class and owner alone, never by its rect (`isShellSurface`), and its
 * reading is a bounded *hold*. Turning it into "no window" would turn a hold
 * into a `left` whenever the displays are mid-reconfiguration or the surface's
 * rect is off every display — exactly the wake-over-a-film M5 exists to stop.
 * So an unplaceable shell sample is passed through unmapped: its rects are
 * never looked at, because `readFullscreen` holds before any geometry is read.
 */
export function winSampleToDip(
  sample: WinWindowInfo | null,
  displays: () => readonly DisplayUnits[]
): ActiveWindowInfo | null {
  if (sample === null) return null;
  // `rest`, not `info`: that name is the log function in this file.
  const { physical, ...rest } = sample;
  if (physical !== true) return rest;
  const mapped = sampleToDip(rest, displays());
  if (mapped === null && isShellSurface(rest)) return rest;
  return mapped;
}

/**
 * A listed name, spelled so the log redactor leaves it readable.
 *
 * WHY (M5b). `log.ts` masks any run of 20 or more base64-ish characters as a
 * catch-all for token shapes it does not know, and several real shell classes
 * are exactly that shape (`XamlExplorerHostIslandWindow`,
 * `TopLevelWindowForOverflowXamlIsland`), so the hold line printed
 * `([redacted])` — useless for the on-screen check that reads the class off it.
 * Weakening the redactor (an exemption list, a bypass argument) would make every
 * log line's safety depend on that exemption being used right; instead the name
 * is *spelled* differently: a name the redactor would mask is printed with a
 * space between its CamelCase words (`Top Level Window For Overflow Xaml
 * Island`), which is still one obvious class to a reader and is documented in
 * `docs/QA-CHECKLIST.md` §6. The line still goes through `redact` like every
 * other; this only changes what reaches it.
 *
 * Only ever called with an entry from a list in `core/fullscreen.ts`, never the
 * string a window reported — see `KnownShellSurface` — so no window can choose
 * what this prints. Should a listed name ever still not survive (one word of 20+
 * characters), `null` tells the caller to fall back to its length.
 */
export function logSafeName(name: string): string | null {
  if (redact(name) === name) return name;
  const spaced = name.replace(/([a-z0-9])(?=[A-Z])/g, '$1 ');
  return redact(spaced) === spaced ? spaced : null;
}

/**
 * What the hold line says about a recognised shell surface: its class and owner
 * when both are listed, the class's length in place of a class that is not.
 *
 * The length is the most that is said about an unlisted class because the class
 * is window-supplied text (see `KnownShellSurface`); it is still enough to tell
 * two unlisted classes apart in one episode, and the on-screen check that would
 * add one to the list reads the real name with a separate tool anyway.
 */
export function shellSurfaceLabel(surface: KnownShellSurface): string {
  const cls = surface.windowClass === null ? null : logSafeName(surface.windowClass);
  const named = cls ?? `an unlisted class of ${surface.classLength} characters`;
  return `${named}; owner ${logSafeName(surface.owner) ?? 'unlisted'}`;
}

/**
 * One line from `fullscreen-win.ps1` -> an `ActiveWindowInfo`, or `null`.
 *
 * `null` covers every "nothing to report" case with one answer: a blank line, a
 * line that is not JSON, the helper's own no-window line (`pid: 0` and a zero
 * rect), and a rect with no area (unless the window is a shell surface, whose
 * hold is decided by class and not by rect). None of those is a *failure* — the helper is
 * alive and telling us the truth — so they read as "no active window", which
 * `isFullscreenWindow` treats as not fullscreen.
 *
 * Anything unparseable is dropped rather than thrown on, because stdout is a
 * stream: a partial line arriving on a chunk boundary must cost one sample, not
 * the whole watch. (The reader below only ever hands complete lines here, so
 * that is belt and braces.)
 */
export function parseWinLine(line: string): WinWindowInfo | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  if (!isEdgeRect(record['rect'])) return null;

  const bounds = toRect(record['rect']);

  const pid = record['pid'];
  const name = record['name'];
  // The window class (M5). Optional: a helper from before the field existed
  // writes none, and an empty string is the helper's "GetClassName failed",
  // both of which must read exactly as an old line did.
  const cls = record['cls'];
  const windowClass = typeof cls === 'string' && cls.length > 0 ? cls : undefined;
  const ownerName = typeof name === 'string' ? name : '';
  // A rect with no area is "no window" — except for a shell surface, whose
  // hold is decided by class and owner and must not hinge on a rect (the
  // helper writes a zero rect when `GetWindowRect` fails; some shell windows,
  // such as `ForegroundStaging`, are tiny or empty by nature).
  if (
    (bounds.width <= 0 || bounds.height <= 0) &&
    !(windowClass !== undefined && isShellSurface({ bounds, ownerName, windowClass }))
  ) {
    return null;
  }
  const monitor = isEdgeRect(record['monitor']) ? toRect(record['monitor']) : null;

  return {
    bounds,
    ownerName,
    ...(typeof pid === 'number' && Number.isFinite(pid) && pid > 0
      ? { ownerProcessId: pid }
      : {}),
    ...(monitor !== null && monitor.width > 0 && monitor.height > 0 ? { monitor } : {}),
    ...(windowClass === undefined ? {} : { windowClass }),
    // Strictly `1` (or `true`): anything else, including a missing field, is
    // the unaware helper's logical units, which is the safe reading — see
    // `WinWindowInfo`.
    ...(record['physical'] === 1 || record['physical'] === true ? { physical: true as const } : {})
  };
}

/** The slice of `ChildProcess` the helper reader uses. Injected in tests. */
export interface HelperProcess {
  readonly stdout: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null;
  readonly stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null;
  readonly stdin?: { end(): void } | null;
  on(event: 'exit' | 'error' | 'close', listener: (...args: unknown[]) => void): unknown;
  kill(): unknown;
}

export interface WinProbeDeps {
  /** Start the helper. Called at most once per probe object. */
  readonly spawn: () => HelperProcess;
  readonly now?: () => number;
  /**
   * How old the newest line may be before the helper counts as wedged. The
   * helper writes every 2 s, so three missed writes is generous.
   */
  readonly maxAgeMs?: number;
}

export interface WinProbe {
  probe(): Promise<WinWindowInfo | null>;
  /** Close the helper's stdin (which is how it exits) and then kill it. */
  stop(): void;
}

/** Default staleness limit: three missed 2 s writes. */
export const HELPER_MAX_AGE_MS = 3 * POLL_MS;

/**
 * The Windows probe: a long-running helper whose newest line is the answer.
 *
 * Deliberately *not* request/response. The helper samples on its own 2 s clock
 * and the watch reads whatever is newest, so a probe never waits on a child
 * process — which means a wedged helper cannot wedge the main process, only go
 * stale. Staleness is a probe failure, and a run of those backs the watch off to
 * the slow cadence through the normal failure path — it never stops it.
 *
 * The helper is spawned lazily on the first probe (so nothing is started when
 * the tray switch is off) and never respawned: a helper that died once died for
 * a reason — no PowerShell, an execution policy we cannot get past, a missing
 * script in the packaged app — and respawning it every two seconds forever is
 * precisely the idle wakeup this project measures.
 */
export function createWinProbe(deps: WinProbeDeps): WinProbe {
  const now = deps.now ?? ((): number => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? HELPER_MAX_AGE_MS;

  let child: HelperProcess | null = null;
  let stopped = false;
  /** Why the helper is no longer usable, or `null` while it is. */
  let dead: string | null = null;
  let latest: WinWindowInfo | null = null;
  /**
   * When `latest` was read, and whether there has been a line at all. The flag
   * is separate from the timestamp on purpose: `0` is a legitimate reading of
   * an injected clock, so it cannot double as "never".
   */
  let latestAt = 0;
  let hasLine = false;
  /** When the helper was spawned, so a helper that never speaks also goes stale. */
  let startedAt = 0;
  /** Partial line held over from the previous chunk. */
  let buffer = '';

  function onLine(line: string): void {
    latest = parseWinLine(line);
    latestAt = now();
    hasLine = true;
  }

  function onData(chunk: unknown): void {
    buffer += String(chunk);
    // Cap the buffer: a helper that somehow writes without newlines must not
    // grow the main process's heap.
    if (buffer.length > 64 * 1024) buffer = buffer.slice(-1024);
    const parts = buffer.split('\n');
    // The last piece is either empty (the chunk ended on a newline) or a
    // partial line; either way it waits for the next chunk.
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      if (part.length > 0) onLine(part);
    }
  }

  function start(): void {
    const started = deps.spawn();
    child = started;
    started.stdout?.on('data', onData);
    // The helper writes nothing to stderr in normal operation; a line here is
    // PowerShell complaining, which is worth exactly one log line.
    started.stderr?.on('data', (chunk: unknown) => {
      const text = String(chunk).trim();
      if (text.length > 0) warn('fullscreen helper:', text);
    });
    started.on('error', (error: unknown) => {
      dead = `the fullscreen helper could not be started: ${String(error)}`;
    });
    started.on('exit', (code: unknown) => {
      dead = `the fullscreen helper exited (code ${String(code)})`;
    });
  }

  return {
    probe: async (): Promise<WinWindowInfo | null> => {
      if (stopped) throw new Error('the fullscreen helper has been stopped');
      if (dead !== null) throw new Error(dead);
      if (child === null) {
        startedAt = now();
        start();
        // Nothing has arrived yet — the first line is up to 2 s away. That is
        // "no active window", not a failure: counting it would burn a third of
        // the failure budget on a helper that is starting up normally.
        return null;
      }

      // Age is measured from the newest line, or from the spawn while there has
      // never been one — so a helper that starts and then says nothing at all
      // (a script that failed to compile its P/Invoke class, say) goes stale
      // rather than reading as a permanently empty desktop.
      const since = hasLine ? latestAt : startedAt;
      const age = now() - since;
      if (age > maxAgeMs) {
        throw new Error(
          `the fullscreen helper has not reported for ${age} ms; treating it as wedged`
        );
      }
      if (!hasLine) return null;
      return latest;
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      if (child === null) return;
      // Closing stdin is the documented way out for the helper; the kill is the
      // backstop for a PowerShell that is somehow not reading it.
      try {
        child.stdin?.end();
      } catch {
        // Already closed.
      }
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      child = null;
    }
  };
}

/**
 * Where `fullscreen-win.ps1` lives. Packaged it is an `extraResource`; in a dev
 * run it is still in the source tree next to this file's own source.
 */
export function winHelperScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'fullscreen-win.ps1')
    : join(app.getAppPath(), 'src', 'main', 'fullscreen-win.ps1');
}

/**
 * Every display, in DIPs and in physical pixels. Win32 only: that is the one
 * platform with `dipToScreenRect`, and the only one with a helper to map.
 *
 * `dipToScreenRect(null, bounds)` scales through the display nearest the rect,
 * which for a display's own bounds is that display — so this is each display's
 * physical rect exactly as Chromium itself places it.
 */
function liveWinDisplays(): DisplayUnits[] {
  return screen.getAllDisplays().map((display) => ({
    dip: display.bounds,
    physical: screen.dipToScreenRect(null, display.bounds)
  }));
}

/**
 * Windows PowerShell by absolute path (2026-11 audit, W-7): a bare
 * `powershell.exe` is looked up in the current directory and on PATH, which
 * belong to the user, not to Walder (the same rule as `raise.ts`).
 */
export function winPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  // `||`, not `??`: an empty SystemRoot is no more usable than a missing one.
  const root = env['SystemRoot'] || 'C:\\Windows';
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function spawnWinHelper(): HelperProcess {
  const script = winHelperScriptPath();
  vlog('spawning the fullscreen helper:', script);
  return spawn(
    winPowerShellPath(),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  ) as unknown as HelperProcess;
}

/* -------------------------------------------------------------------- watch */

/**
 * Walder's own identity, so his always-on-top overlay never reads as a
 * fullscreen video. Both are checked: the pid is exact on macOS (the OS reports
 * the app's main process), and the name covers `npm run dev`, where the active
 * window's owner is "Electron".
 */
function selfIdentity(): SelfIdentity {
  return { names: [app.getName(), 'Walder', 'Electron'], processId: process.pid };
}

export function createFullscreenWatch(deps: FullscreenWatchDeps): FullscreenWatch {
  const intervalMs = Math.max(250, deps.intervalMs ?? POLL_MS);
  const backoffMs = Math.max(intervalMs, BACKOFF_POLL_MS);
  const platform = deps.platform ?? process.platform;
  const displays = deps.displays ?? ((): Rect[] => screen.getAllDisplays().map((d) => d.bounds));
  const self = deps.self ?? selfIdentity;
  const dogDisplay = deps.dogDisplay ?? ((): Rect | null => null);
  const now = deps.now ?? ((): number => Date.now());
  const winDisplays = deps.winDisplays ?? liveWinDisplays;

  /** The Windows helper, created on first use and torn down by `stop`. */
  let winProbe: WinProbe | null = null;

  // On Windows the helper's sample is put into DIPs before the decision sees
  // it, so the window and the dog's display are in the same units on every
  // display layout (audit finding M3; see `main/win-dpi.ts`).
  const probe =
    deps.probe ??
    (platform === 'win32'
      ? async (): Promise<ActiveWindowInfo | null> => {
          winProbe ??= createWinProbe({ spawn: deps.spawnWinHelper ?? spawnWinHelper });
          return winSampleToDip(await winProbe.probe(), winDisplays);
        }
      : probeFrontmostWindows);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let inFlight = false;
  /**
   * `true` when this platform has no probe at all, so nothing is ever spawned
   * and no failure is ever logged: on Linux `get-windows` needs X11 libraries
   * we do not ship and there is no PowerShell path, and three timed-out probes
   * to establish that is three probes too many.
   *
   * This is the *only* permanent give-up left, and deliberately so: it is a hard
   * fact about the platform, known before a single probe runs, and it cannot
   * change while the app is open. Every other failure is transient until proven
   * otherwise — see the note at the top of this file.
   */
  let unsupported = deps.probe === undefined && !SUPPORTED_PLATFORMS.includes(platform);
  let failures = 0;
  /**
   * When a probe last gave a reading, which is what the unknown-hold is
   * measured from. A `NoActiveWindowError` is an answer but not a reading, and
   * does not move it.
   */
  let lastSuccessAt = now();
  /** Whether any probe has succeeded, so the "armed" line is logged once. */
  let probed = false;
  let state: DebounceState = DEBOUNCE_INITIAL;
  /**
   * Whether the last reading was "Walder is in front", so the hold is logged
   * once per episode rather than every two seconds for as long as he is petted.
   */
  let selfFront = false;
  /**
   * Whether the last sample was "no window for the app in front"
   * (`NoActiveWindowError`), so that is logged once per episode too.
   */
  let noWindowFront = false;
  /**
   * The Windows shell-surface hold (M5): when the current episode began, so it
   * can be bounded — see `boundShellHold`. Logged once per distinct surface
   * and once on expiry, like `selfFront`, never every two seconds.
   */
  let shellHold: ShellHoldState = SHELL_HOLD_INITIAL;
  /**
   * The surfaces already named in the current shell episode (M5b).
   *
   * Once per *surface*, not once per episode: Win+B then Enter goes taskbar ->
   * overflow flyout without ever leaving the shell, and an episode-only line
   * named `Shell_TrayWnd` and never the flyout — the very class the on-screen
   * check was there to read. Keyed by the label that was logged, so an unlisted
   * class is keyed by its length and nothing window-supplied is kept. Bounded by
   * the lists in `core/fullscreen.ts` plus the possible lengths, and cleared
   * whenever the episode ends.
   */
  let shellNamed = new Set<string>();
  /** Whether the expiry of the current shell episode has been logged. */
  let shellExpired = false;

  if (unsupported) vlog(`fullscreen watch not supported on ${platform}; the dog will never sleep`);

  function arm(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    // Not armed while the tray switch is off: the earlier version kept the
    // timer running so that switching it back on took effect without a
    // restart, which meant a disabled feature still woke the CPU every two
    // seconds for the life of the app. `setEnabled` now restarts it instead.
    if (!running || unsupported || !deps.enabled()) return;
    // A failing probe is polled slowly rather than abandoned: what broke it
    // may fix itself (a display being reconfigured, a helper that went quiet),
    // and the one thing the watch must never do is stop looking. A probe that
    // answered "no active window" while still listing windows resets
    // `failures` and so stays on the fast cadence (2026-11-14) — see
    // `NoActiveWindowError`; one that listed nothing still counts and backs off.
    const delay = failures >= BACKOFF_AFTER_FAILURES ? backoffMs : intervalMs;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, delay);
  }

  /** Feed one sample through the debounce and report a flip. */
  function commit(raw: boolean | null): void {
    const next = debounceFullscreen(state, raw);
    state = next.state;
    if (!next.changed) return;
    // `info`, not `vlog`: this is the one line anyone asks for after the fact
    // ("did he curl up over that film?"), so it goes in the packaged app's log
    // file whether or not the verbose checkbox happened to be ticked.
    info(state.fullscreen ? 'fullscreen entered' : 'fullscreen left');
    deps.onChange(state.fullscreen);
  }

  /**
   * Take one sample.
   *
   * Separate from `tick` so an explicit `pollNow` — which is what the tray's
   * switch uses, to take effect at the click rather than up to two seconds
   * later — does not depend on the timer loop being armed, and does not re-arm
   * it either.
   */
  /**
   * The switch is off: forget the episode and wake him. Called straight from
   * `setEnabled(false)`, not through `sample`, whose in-flight guard would
   * skip it while a probe is pending (2026-11 audit, W-3).
   */
  function disable(): void {
    // A shell episode does not survive the switch: turned back on, the
    // bound starts again from the first shell sample rather than from one
    // seen before the owner switched the feature off.
    shellHold = SHELL_HOLD_INITIAL;
    shellExpired = false;
    shellNamed = new Set<string>();
    // Switched off: report "not fullscreen" once so a sleeping dog wakes.
    if (state.fullscreen || state.streak !== 0) {
      state = DEBOUNCE_INITIAL;
      vlog('fullscreen watch disabled; waking');
      deps.onChange(false);
    }
  }

  async function sample(): Promise<void> {
    if (unsupported || inFlight) return;
    inFlight = true;
    try {
      if (!deps.enabled()) {
        disable();
        return;
      }

      const raw = await probe();
      // Switched off while the probe ran: its reading belongs to a feature
      // that is no longer on, and must not put him to sleep.
      if (!deps.enabled()) return;
      // One window, a list of them, or nothing — all three normalise here, so
      // the decision only ever sees a list. See `FullscreenWatchDeps.probe`.
      const windows: readonly ActiveWindowInfo[] =
        raw === null ? [] : Array.isArray(raw) ? raw : [raw as ActiveWindowInfo];

      failures = 0;
      lastSuccessAt = now();
      noWindowFront = false;
      // Every window in the list belongs to the frontmost app (that is what
      // the probe returns), so the first one's owner is the answer. Never
      // logged: an application path is the owner's data.
      const front = windows[0]?.ownerPath;
      if (front !== undefined) deps.onFrontmost?.(front);
      if (!probed) {
        probed = true;
        // One line, once: it is the only positive evidence that the watch is
        // working at all — a healthy watch is otherwise silent until a flip,
        // which is indistinguishable from a probe that never ran.
        vlog(
          'fullscreen watch armed; the frontmost app reports',
          windows.length,
          windows.length === 1 ? 'window' : 'windows'
        );
      }
      // `null` is "Walder himself is in front" — a pet activates the app — and
      // holds the settled state for as long as it lasts, with no
      // `UNKNOWN_HOLD_MS` decay: a probe that answers is not a broken probe,
      // and the owner activating any other app ends the hold with a real
      // reading. See `readFullscreen` for the QA 6.3 defect this closes.
      const who = self();
      const read = readFullscreen(windows, displays(), who, dogDisplay());
      // A Windows shell surface in front (tray overflow, Alt+Tab, Start…) is
      // also `null`, but bounded in time: the foreground can *land* on the
      // taskbar when the player closes, and that must not keep him asleep for
      // good. See `boundShellHold` and M5 in docs/handoffs/.
      const shell = shellInFront(windows, who);
      const bounded = boundShellHold(shellHold, read, shell, now());
      if (!shell) shellNamed = new Set<string>();
      shellHold = bounded.hold;
      const reading = bounded.reading;
      const held = state.fullscreen ? 'fullscreen' : 'not fullscreen';
      if (shell) {
        // Named from core's own lists, never from the reported class string —
        // see `KnownShellSurface` and `shellSurfaceLabel` for why. Taken from
        // the shell window itself rather than `windows[0]`, which in a mixed
        // list could be Walder's own.
        const surface = windows.map(knownShellSurface).find((s) => s !== null) ?? null;
        const label = surface === null ? 'unknown' : shellSurfaceLabel(surface);
        if (!shellNamed.has(label)) {
          shellNamed.add(label);
          // Past the bound a new surface is no longer held, and saying so would
          // misreport what the watch is doing.
          const doing = bounded.expired ? 'reading it as not fullscreen' : `holding ${held}`;
          vlog(`fullscreen watch: a shell surface (${label}) is in front; ${doing}`);
        }
      }
      if (bounded.expired && !shellExpired) {
        vlog(
          `fullscreen watch: a shell surface has been in front for ${SHELL_HOLD_MAX_MS} ms; ` +
            'reading it as not fullscreen'
        );
      }
      shellExpired = bounded.expired;
      if (reading === null && !shell && !selfFront) {
        vlog(`fullscreen watch: Walder is frontmost; holding ${held}`);
      }
      selfFront = reading === null && !shell;
      commit(reading);
    } catch (error) {
      // The probe stopped by the switch going off fails here: not a failure.
      if (!deps.enabled()) return;
      // 2026-11-14 (audit decision 13): a probe that answered "the app in
      // front has no window" is alive, so it ends a run of failures instead of
      // extending one — no slow cadence and no warning for an app that merely
      // has nothing open, and the next real window is read 2 s later, not 10.
      // It is still unknown, and falls through to the same hold and decay as
      // a failure below. `lastSuccessAt` is deliberately left alone: the hold
      // is measured from the last *reading*, or it would never run out.
      const alive = error instanceof NoActiveWindowError;
      failures = alive ? 0 : failures + 1;
      if (alive && !noWindowFront) {
        vlog('fullscreen watch: no window found for the frontmost app; treating that as unknown');
      }
      noWindowFront = alive;
      // The first failure of a run is a diagnostic, not a problem. Only a run
      // long enough to mean something really is broken earns a warning —
      // exactly one, since `failures` only ever reaches this number once per
      // run.
      if (failures === 1) vlog('could not read the active window; holding the last state:', error);
      if (failures === WARN_AFTER_FAILURES) {
        warn(
          `could not read the active window ${WARN_AFTER_FAILURES} times in a row; the dog ` +
            'will not sleep over fullscreen video until this clears. Still trying every ' +
            `${backoffMs} ms. On macOS this needs no permission — bounds and owner are ` +
            'enough — so it means a missing or unsupported get-windows build; on Windows ' +
            'it means the PowerShell helper could not run:',
          error
        );
      }
      // Unknown, not "no". Holding the last known state is what stops a macOS
      // Space transition — about three seconds of `undefined` — from standing a
      // sleeping dog up and lying him back down around every fullscreen video.
      // Past the hold it decays to "not fullscreen", because a dog stuck asleep
      // behind a broken probe is the one outcome worse than never sleeping.
      // The decay applies to an app with no window in front as well, although
      // that probe answered: unlike Walder in front (above), it is where the
      // foreground can *land* when a film is closed, and can stay for good.
      if (now() - lastSuccessAt > UNKNOWN_HOLD_MS) commit(false);
    } finally {
      inFlight = false;
    }
  }

  /** One sample plus the re-arm. Only the timer loop uses this. */
  async function tick(): Promise<void> {
    if (!running) return;
    try {
      await sample();
    } finally {
      arm();
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      void tick();
    },

    stop(): void {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      winProbe?.stop();
      winProbe = null;
    },

    isFullscreen(): boolean {
      return state.fullscreen;
    },

    pollNow: async (): Promise<void> => {
      await sample();
    },

    /**
     * The tray switch was flipped.
     *
     * Turning it **off** takes one last sample (which reports the wake, so a
     * curled-up dog stands back up at the click) and leaves nothing armed —
     * `arm` refuses while `enabled()` is false. Turning it **on** clears the
     * failure count, so a watch that had backed off to the slow cadence returns
     * to 2 s immediately: a switch the owner just turned on must visibly do
     * something. (It no longer has a permanent give-up to clear — that is the
     * point of the rework — but the reset still matters for the cadence, and
     * `unsupported` is recomputed for symmetry with construction.)
     */
    setEnabled(on: boolean): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (on) {
        unsupported = deps.probe === undefined && !SUPPORTED_PLATFORMS.includes(platform);
        failures = 0;
        lastSuccessAt = now();
      } else {
        winProbe?.stop();
        winProbe = null;
      }
      if (!running) return;
      if (on) void tick();
      else if (!unsupported) disable();
    }
  };
}

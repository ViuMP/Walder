/**
 * Watching for a fullscreen window, so Walder can get out of the way.
 *
 * The decision is `core/fullscreen.ts`; this is the polling and the OS call
 * around it. There are two OS calls, one per platform, and they answer the same
 * question in deliberately different ways:
 *
 * **macOS — `get-windows`.** Sindre Sorhus's maintained successor to
 * `active-win` reports the active window's bounds and owner. On macOS it runs a
 * small bundled Swift binary. Window *titles* need the Screen Recording
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
 * **Fail-soft, and quietly.** A missing binary, an unsupported platform, a spawn
 * that is refused — any of it means "we cannot tell", which is treated as *not*
 * fullscreen: the worst case is that the dog stays visible over a film, which is
 * the status quo, rather than an app that crashes or nags. The failure is logged
 * once, and after three consecutive failures the watch stops trying (until the
 * tray switch is turned off and on again, which resets it).
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, screen } from 'electron';
import {
  DEBOUNCE_INITIAL,
  debounceFullscreen,
  isFullscreenWindow,
  type ActiveWindowInfo,
  type DebounceState,
  type SelfIdentity
} from '../core/fullscreen';
import type { Rect } from '../core/geometry';
import { vlog, warn } from './log';

/** How often the active window is sampled. */
export const POLL_MS = 2_000;

/** Consecutive probe failures after which the watch gives up for this session. */
export const MAX_FAILURES = 3;

/** Platforms with a probe. Anything else never polls at all. */
export const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'win32'];

export interface FullscreenWatchDeps {
  /** Called only when the debounced state actually flips. */
  readonly onChange: (fullscreen: boolean) => void;
  /** The tray checkbox. `false` stops the polling entirely. */
  readonly enabled: () => boolean;
  readonly intervalMs?: number;
  /** Injected in tests; defaults to the per-platform probe below. */
  readonly probe?: () => Promise<ActiveWindowInfo | null>;
  /** Injected in tests; defaults to the live display bounds. */
  readonly displays?: () => Rect[];
  /**
   * The display the overlay window is currently on, or `null` when there is
   * momentarily no window. Fullscreen is decided against *this* display — see
   * `isFullscreenWindow`.
   */
  readonly dogDisplay?: () => Rect | null;
  readonly self?: () => SelfIdentity;
  /** Injected in tests; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
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

/** Cached module handle; `null` until the first successful import. */
let activeWindow: ((options?: unknown) => Promise<unknown>) | null = null;

/**
 * Which copy of `get-windows` to load.
 *
 * `get-windows` locates its Swift helper as `path.join(__dirname, '../main')`,
 * derived from its own `import.meta.url`. Loaded from inside the asar that
 * resolves to `…/app.asar/node_modules/get-windows/main`, which is a path
 * *through* a file, so `execFile` fails with `ENOTDIR` — and the watch then
 * fail-softs three times and gives up. Verified on a packaged build: the dog
 * never slept over video in any release, only in `npm run dev`.
 *
 * `asarUnpack` is necessary but not sufficient: it puts a real copy on disk,
 * but the module still *resolves* to the archived path, and `import.meta.url`
 * reports where a module was resolved from rather than where its bytes came
 * from. So when packaged we import the unpacked copy by absolute path, and the
 * package's own `__dirname` then points at the real directory next to the real
 * binary. `app.getAppPath()` is `…/Resources/app.asar`, and electron-builder
 * writes the unpacked tree beside it as `app.asar.unpacked`.
 */
function getWindowsSpecifier(): string {
  if (!app.isPackaged) return 'get-windows';
  const unpacked = join(
    `${app.getAppPath()}.unpacked`,
    'node_modules',
    'get-windows',
    'index.js'
  );
  return pathToFileURL(unpacked).href;
}

/**
 * Ask macOS which window is active.
 *
 * The import is dynamic so a platform where the package cannot load at all
 * costs a caught rejection rather than a failure to start the app, and so the
 * (few hundred ms) first-call cost is not paid during launch. It is only ever
 * reached on darwin (see the probe selection in `createFullscreenWatch`), which
 * is what keeps the package's Windows addon out of the picture entirely —
 * `get-windows`' own entry point imports `lib/windows.js` eagerly for its sync
 * variants, so importing the package at all on Windows would demand the addon.
 */
async function probeActiveWindow(): Promise<ActiveWindowInfo | null> {
  if (activeWindow === null) {
    const mod = (await import(getWindowsSpecifier())) as {
      activeWindow: (options?: unknown) => Promise<unknown>;
    };
    activeWindow = mod.activeWindow;
  }

  const raw = await activeWindow({
    // See the permissions note at the top of this file.
    screenRecordingPermission: false,
    accessibilityPermission: false
  });

  // `undefined` is the package's "I could not determine the active window",
  // which is a *probe failure* and must be counted as one. Reading it as "no
  // active window" (i.e. not fullscreen) is how a permanently broken probe used
  // to look identical to a healthy one reporting an empty desktop — the failure
  // counter never advanced, so the watch never gave up and never warned.
  // `null` is different: that is a genuine "nothing is focused".
  if (raw === undefined) {
    throw new Error('get-windows returned undefined: the active window could not be determined');
  }
  if (raw === null) return null;

  const win = raw as {
    bounds?: Rect;
    owner?: { name?: unknown; processId?: unknown };
  };
  const bounds = win.bounds;
  // A report with no bounds is the same class of answer: we were told
  // something, but not the one thing the decision needs.
  if (bounds === undefined) {
    throw new Error('get-windows reported an active window with no bounds');
  }

  const name = typeof win.owner?.name === 'string' ? win.owner.name : '';
  const pid = typeof win.owner?.processId === 'number' ? win.owner.processId : undefined;
  return { bounds, ownerName: name, ...(pid === undefined ? {} : { ownerProcessId: pid }) };
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
 * One line from `fullscreen-win.ps1` -> an `ActiveWindowInfo`, or `null`.
 *
 * `null` covers every "nothing to report" case with one answer: a blank line, a
 * line that is not JSON, the helper's own no-window line (`pid: 0` and a zero
 * rect), and a rect with no area. None of those is a *failure* — the helper is
 * alive and telling us the truth — so they read as "no active window", which
 * `isFullscreenWindow` treats as not fullscreen.
 *
 * Anything unparseable is dropped rather than thrown on, because stdout is a
 * stream: a partial line arriving on a chunk boundary must cost one sample, not
 * the whole watch. (The reader below only ever hands complete lines here, so
 * that is belt and braces.)
 */
export function parseWinLine(line: string): ActiveWindowInfo | null {
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
  if (bounds.width <= 0 || bounds.height <= 0) return null;

  const pid = record['pid'];
  const name = record['name'];
  const monitor = isEdgeRect(record['monitor']) ? toRect(record['monitor']) : null;

  return {
    bounds,
    ownerName: typeof name === 'string' ? name : '',
    ...(typeof pid === 'number' && Number.isFinite(pid) && pid > 0
      ? { ownerProcessId: pid }
      : {}),
    ...(monitor !== null && monitor.width > 0 && monitor.height > 0 ? { monitor } : {})
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
  probe(): Promise<ActiveWindowInfo | null>;
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
 * stale. Staleness is a probe failure, and three of those stop the watch through
 * the normal `MAX_FAILURES` path.
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
  let latest: ActiveWindowInfo | null = null;
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
    probe: async (): Promise<ActiveWindowInfo | null> => {
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

function spawnWinHelper(): HelperProcess {
  const script = winHelperScriptPath();
  vlog('spawning the fullscreen helper:', script);
  return spawn(
    'powershell.exe',
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
  const platform = deps.platform ?? process.platform;
  const displays = deps.displays ?? ((): Rect[] => screen.getAllDisplays().map((d) => d.bounds));
  const self = deps.self ?? selfIdentity;
  const dogDisplay = deps.dogDisplay ?? ((): Rect | null => null);

  /** The Windows helper, created on first use and torn down by `stop`. */
  let winProbe: WinProbe | null = null;

  const probe =
    deps.probe ??
    (platform === 'win32'
      ? (): Promise<ActiveWindowInfo | null> => {
          winProbe ??= createWinProbe({ spawn: spawnWinHelper });
          return winProbe.probe();
        }
      : probeActiveWindow);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let inFlight = false;
  /**
   * `true` when this platform has no probe at all, so nothing is ever spawned
   * and no failure is ever logged: on Linux `get-windows` needs X11 libraries
   * we do not ship and there is no PowerShell path, and three timed-out probes
   * to establish that is three probes too many.
   */
  let broken = deps.probe === undefined && !SUPPORTED_PLATFORMS.includes(platform);
  let failures = 0;
  let warned = false;
  /** Whether any probe has succeeded, so the "armed" line is logged once. */
  let probed = false;
  let state: DebounceState = DEBOUNCE_INITIAL;

  if (broken) vlog(`fullscreen watch not supported on ${platform}; the dog will never sleep`);

  function arm(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    // Not armed while the tray switch is off: the earlier version kept the
    // timer running so that switching it back on took effect without a
    // restart, which meant a disabled feature still woke the CPU every two
    // seconds for the life of the app. `setEnabled` now restarts it instead.
    if (!running || broken || !deps.enabled()) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, intervalMs);
  }

  /** Feed one sample through the debounce and report a flip. */
  function commit(raw: boolean): void {
    const next = debounceFullscreen(state, raw);
    state = next.state;
    if (!next.changed) return;
    vlog('fullscreen ->', state.fullscreen);
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
  async function sample(): Promise<void> {
    if (broken || inFlight) return;
    inFlight = true;
    try {
      if (!deps.enabled()) {
        // Switched off: report "not fullscreen" once so a sleeping dog wakes.
        if (state.fullscreen || state.streak !== 0) {
          state = DEBOUNCE_INITIAL;
          vlog('fullscreen watch disabled; waking');
          deps.onChange(false);
        }
        return;
      }

      const win = await probe();
      failures = 0;
      if (!probed) {
        probed = true;
        // One line, once: it is the only positive evidence that the watch is
        // working at all — a healthy watch is otherwise silent until a flip,
        // which is indistinguishable from a probe that never ran.
        vlog('fullscreen watch armed; the active window reads as', win === null ? 'none' : 'a window');
      }
      commit(isFullscreenWindow(win, displays(), self(), dogDisplay()));
    } catch (error) {
      failures++;
      if (!warned) {
        warned = true;
        warn(
          'could not read the active window; treating it as "no fullscreen video". ' +
            'On macOS this needs no permission — bounds and owner are enough — so this ' +
            'is a missing or unsupported get-windows build; on Windows it means the ' +
            'PowerShell helper could not run:',
          error
        );
      }
      commit(false);
      if (failures >= MAX_FAILURES) {
        broken = true;
        warn(`giving up on the fullscreen watch after ${MAX_FAILURES} failures`);
      }
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
     * `arm` refuses while `enabled()` is false. Turning it **on** clears a
     * `broken` watch and restarts the loop: the failures that broke it were
     * three probes in six seconds, possibly hours ago and possibly for a reason
     * that is now fixed, and a switch the owner just turned on must actually do
     * something. Without this reset, switching the feature off and on again was
     * the one action that looked like it should retry and did not.
     */
    setEnabled(on: boolean): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (on) {
        if (broken) vlog('fullscreen watch re-armed by the tray switch');
        broken = deps.probe === undefined && !SUPPORTED_PLATFORMS.includes(platform);
        failures = 0;
        warned = false;
      } else {
        winProbe?.stop();
        winProbe = null;
      }
      if (!running) return;
      if (on) void tick();
      else void sample();
    }
  };
}

/**
 * Give key focus back to the app the owner was typing in after he clicks or
 * drags the dog (macOS only; RECHECK 2026-11-18 c, Mac QA 2026-11-19).
 *
 * A mouse-down on the overlay makes Walder the active app, so the window under
 * the dog loses key status and the next letters typed go nowhere. That is
 * Electron/AppKit, not an overlay option: a bare `{ type: 'panel', focusable:
 * false }` window activates its app on a click (Electron 45.3.4, macOS 27.2),
 * and `app.setActivationPolicy('prohibited')` does not stop it. So when an
 * activation follows a press on the dog, Walder re-activates the app that was
 * in front before it:
 *
 *  - `lsappinfo visibleProcessList` lists the visible apps front to back.
 *    Walder is a UI element (`LSUIElement`, `dock.hide()`), so it is never in
 *    that list; if it ever is, the app right after it is taken instead.
 *  - `lsappinfo info -only pid <ASN>` gives its process id, and
 *    `NSRunningApplication` activates that exact process, through JXA
 *    (`osascript -l JavaScript`, the pid passed as an argument, never spliced
 *    into the script). That is the ObjC bridge, not an Apple Event, so no
 *    Automation permission and no prompt, and an activation sends no reopen
 *    event.
 *
 *    Two earlier versions failed on the Mac mini (macOS 27.2.1). `open -b
 *    <bundle id>` gave the key back but, for a running app, sends a reopen
 *    event like a Dock click: a Finder with no window open opened a new Finder
 *    window on every pet, and TextEdit with none an Open panel (PR #38
 *    review). `lsappinfo setfront <ASN>` is refused with `ERROR #-54
 *    permErr`, printed to stderr while the exit code stays 0, so it looked
 *    done and Walder kept the key (QA 1.5a, 2026-11-20). `lsappinfo front` is
 *    read 300 ms after the activation and logged, so a refusal shows.
 *
 * Skipped whenever a Walder window that takes the keyboard is open (the Walder
 * window, a login window, the hook question's host): there Walder being active
 * is wanted. Also skipped when the previous app cannot be read: nothing is
 * guessed. A press with no activation does nothing, and one press gives back
 * focus at most once. A press while Walder is already the active app (a
 * hand-back that failed, a dialog that activated it) counts as its own
 * activation: `did-become-active` does not fire again while Walder stays
 * active, so it is tracked with `did-resign-active`.
 *
 * No Electron import, so the bookkeeping is unit-tested (`test/focus-return.test.ts`);
 * `index.ts` wires it to the app's `did-become-active` / `did-resign-active` and the overlay's
 * drag-start / drag-end messages.
 */

import { execFile } from 'node:child_process';

/** How long after a press on the dog an activation still counts as caused by it. */
export const PRESS_WINDOW_MS = 1500;

/** The pure decision: should this activation be handed back? */
export function shouldReturnFocus(opts: {
  readonly isMac: boolean;
  readonly pressAt: number | null;
  readonly activatedAt: number | null;
  readonly now: number;
  readonly handled: boolean;
  readonly focusWindowOpen: boolean;
}): boolean {
  if (!opts.isMac || opts.handled || opts.focusWindowOpen) return false;
  if (opts.pressAt === null || opts.activatedAt === null) return false;
  // The activation is the press's own: it comes with the mouse-down, a few ms
  // either side of the renderer's drag-start message.
  if (opts.activatedAt < opts.pressAt - 250) return false;
  return opts.now - opts.pressAt <= PRESS_WINDOW_MS;
}

const ASN = /ASN:0x[0-9a-f]+-0x[0-9a-f]+/gi;

/**
 * The app in front of the list that is not Walder. `visibleProcessList` prints
 * `ASN:0x0-0x34034-"Finder": ASN:…`, front to back; `mine` is Walder's own ASN
 * when it could be read.
 */
export function previousAsnFrom(visibleList: string, mine: string | null): string | null {
  const asns: readonly string[] = visibleList.match(ASN) ?? [];
  const at = mine === null ? -1 : asns.indexOf(mine);
  const prev = at >= 0 ? asns[at + 1] : asns[0];
  return prev ?? null;
}

export interface FocusReturnDeps {
  readonly isMac: boolean;
  readonly now: () => number;
  readonly pid: number;
  /** A visible Walder window that takes the keyboard is open. */
  readonly focusWindowOpen: () => boolean;
  /** Runs a command with arguments (never a shell); resolves its stdout, or null on any failure. */
  readonly exec: (file: string, args: readonly string[]) => Promise<string | null>;
  readonly log: (msg: string) => void;
  /** Waits before `lsappinfo front` is read back; a real timer unless a test passes one. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface FocusReturn {
  /** A press on the dog (the overlay's drag start). */
  onPress(): void;
  /** Walder became the active app. */
  onActivated(): void;
  /** Walder stopped being the active app. */
  onResigned(): void;
}

/** `FocusReturnDeps.exec` for real: `execFile` (no shell), 1.5 s at most, stdout or null. */
export function execForStdout(file: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: 1500 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/**
 * `lsappinfo info -only pid` prints `pid = 9019` (or `"pid"=9019`); null when
 * there is none or it is not a plain positive number.
 */
export function pidFrom(info: string): number | null {
  const m = info.match(/"?pid"?\s*=\s*(\d+)\b/);
  const pid = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Activates the process whose pid is the first argument and prints `true`
 * when AppKit accepted it. The pid arrives as `argv`, so nothing read from
 * `lsappinfo` ever becomes script text.
 */
export const ACTIVATE_JXA =
  'function run(argv) { ObjC.import("AppKit"); try { ' +
  'const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0])); ' +
  'return app.activateWithOptions(0) ? "true" : "false"; } catch (e) { return "false"; } }';

/**
 * How long after the activation `lsappinfo front` is read back for the log.
 * The switch is asynchronous: read at once it still named Walder although
 * TextEdit was in front about 120 ms later (Mac mini, 2026-11-20).
 */
export const FRONT_CHECK_MS = 300;

const LSAPPINFO = '/usr/bin/lsappinfo';
const OSASCRIPT = '/usr/bin/osascript';

export function createFocusReturn(deps: FocusReturnDeps): FocusReturn {
  let pressAt: number | null = null;
  let activatedAt: number | null = null;
  let handled = false;
  let active = false;

  const giveBack = async (): Promise<void> => {
    const list = await deps.exec(LSAPPINFO, ['visibleProcessList']);
    if (list === null) return deps.log('focus return: could not list apps; leaving focus');
    const found = await deps.exec(LSAPPINFO, ['find', `pid=${deps.pid}`]);
    const mine = found?.match(ASN)?.[0] ?? null;
    const prev = previousAsnFrom(list, mine);
    if (prev === null) return deps.log('focus return: no previous app; leaving focus');
    const pid = pidFrom((await deps.exec(LSAPPINFO, ['info', '-only', 'pid', prev])) ?? '');
    if (pid === null || pid === deps.pid) return deps.log(`focus return: no pid for ${prev}; leaving focus`);
    // Checked again: a window may have opened while the lookups ran.
    if (deps.focusWindowOpen()) return;
    const ok = (await deps.exec(OSASCRIPT, ['-l', 'JavaScript', '-e', ACTIVATE_JXA, String(pid)]))?.trim();
    await (deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(FRONT_CHECK_MS);
    const front = (await deps.exec(LSAPPINFO, ['front']))?.match(ASN)?.[0] ?? null;
    deps.log(
      `focus return: activate ${prev} (pid ${pid}) ${ok === 'true' ? 'accepted' : 'refused'}; ` +
        `front is now ${front ?? 'unknown'}${front === prev ? '' : ' (not the app asked for)'}`
    );
  };

  const maybe = (): void => {
    const go = shouldReturnFocus({
      isMac: deps.isMac,
      pressAt,
      activatedAt,
      now: deps.now(),
      handled,
      focusWindowOpen: deps.isMac && deps.focusWindowOpen()
    });
    if (!go) return;
    handled = true;
    void giveBack();
  };

  return {
    onPress() {
      pressAt = deps.now();
      handled = false;
      // Already active: no did-become-active will come, so this press is the activation.
      if (active) activatedAt = pressAt;
      maybe();
    },
    onActivated() {
      active = true;
      activatedAt = deps.now();
      maybe();
    },
    onResigned() {
      active = false;
    }
  };
}

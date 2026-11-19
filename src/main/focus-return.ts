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
 *  - `lsappinfo info -only bundleid <ASN>` names it, and `open -b <bundle id>`
 *    activates it through LaunchServices. No Automation (Apple Events)
 *    permission is involved, so no prompt. Measured in a scratch app: key back
 *    44–50 ms after Walder's activation, 5 of 5, and letters typed straight
 *    after the click all landed.
 *
 * Skipped whenever a Walder window that takes the keyboard is open (the Walder
 * window, a login window, the hook question's host): there Walder being active
 * is wanted. Also skipped when the previous app cannot be read: nothing is
 * guessed. A press with no activation does nothing, and one press gives back
 * focus at most once.
 *
 * No Electron import, so the bookkeeping is unit-tested (`test/focus-return.test.ts`);
 * `index.ts` wires it to the app's `did-become-active` and the overlay's
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

/** `lsappinfo info -only bundleid` prints `"CFBundleIdentifier"="com.apple.TextEdit"` (or `bundleID=`). */
export function bundleIdFrom(info: string): string | null {
  const m = info.match(/"?(?:CFBundleIdentifier|bundleID)"?\s*=\s*"([A-Za-z0-9.-]+)"/);
  return m?.[1] ?? null;
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
}

export interface FocusReturn {
  /** A press on the dog (the overlay's drag start). */
  onPress(): void;
  /** Walder became the active app. */
  onActivated(): void;
}

/** `FocusReturnDeps.exec` for real: `execFile` (no shell), 1.5 s at most, stdout or null. */
export function execForStdout(file: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: 1500 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

const LSAPPINFO = '/usr/bin/lsappinfo';
const OPEN = '/usr/bin/open';

export function createFocusReturn(deps: FocusReturnDeps): FocusReturn {
  let pressAt: number | null = null;
  let activatedAt: number | null = null;
  let handled = false;

  const giveBack = async (): Promise<void> => {
    const list = await deps.exec(LSAPPINFO, ['visibleProcessList']);
    if (list === null) return deps.log('focus return: could not list apps; leaving focus');
    const found = await deps.exec(LSAPPINFO, ['find', `pid=${deps.pid}`]);
    const mine = found?.match(ASN)?.[0] ?? null;
    const prev = previousAsnFrom(list, mine);
    if (prev === null) return deps.log('focus return: no previous app; leaving focus');
    const info = await deps.exec(LSAPPINFO, ['info', '-only', 'bundleid', prev]);
    const bundle = info === null ? null : bundleIdFrom(info);
    if (bundle === null) return deps.log('focus return: previous app has no bundle id; leaving focus');
    // Checked again: a window may have opened while the lookups ran.
    if (deps.focusWindowOpen()) return;
    const ok = await deps.exec(OPEN, ['-b', bundle]);
    deps.log(ok === null ? `focus return: open -b ${bundle} failed` : `focus return: gave key back to ${bundle}`);
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
      maybe();
    },
    onActivated() {
      activatedAt = deps.now();
      maybe();
    }
  };
}

/**
 * A message box that does not stop the main process while it is up.
 *
 * **Why this exists (0.2.8 QA, rows 7a.3, 7.12, 7.13).** The launch's hook
 * offers were asked with the *async* `dialog.showMessageBox` precisely so that
 * starting up could never block on a dialog — and it blocked anyway. The log
 * went silent for as long as the question was up (no poll, no update check, no
 * fullscreen watch), a dog petted during intro beat 3 kept a bubble laid out
 * against a stale window position, a non-intro launch showed the dialog before
 * the dog, and when the last dialog closed everything that had been waiting
 * landed at once (`update check failed: timeout`, `poll cursor: error`).
 *
 * The cause is in Electron, not in us. On macOS, `showMessageBox` **without a
 * parent window** is `[NSAlert runModal]` — Electron's own comment says it uses
 * runModal "since we don't have a window to wait for" — and `runModal` is a
 * nested native run loop. Chromium runs no application tasks inside one, and
 * Node's timers and I/O reach the main thread *as* such tasks, so the whole
 * main process stops until the alert is answered. The promise is async; the
 * alert under it is not. Only with a parent does Electron take the other
 * branch, `beginSheetModalForWindow`, which returns at once and leaves the run
 * loop alone.
 *
 * So the dialog gets a parent: a window that exists for nothing else. Not the
 * overlay — a sheet hangs from the top of its parent, and the overlay is a
 * transparent, unfocusable panel in a screen corner that moves when he is
 * dragged and is hidden outright in the hide-when-idle mode. And not a hidden
 * window: the async path does not check, and a sheet on an invisible window
 * cannot be seen or dismissed (electron#22671). The host is shown, transparent
 * and frameless, so what the owner sees is the alert on its own, centred on
 * his screen, much as before. It is destroyed as soon as the answer is in.
 *
 * **One at a time still holds**: the promise settles when the sheet is
 * answered, exactly as the parentless one did, so `checkHookInstall` asking
 * Claude before Codex never stacks two questions, and the `hooksOffered` flag
 * written before the offer is untouched by any of this.
 *
 * **macOS and Windows (2026-11-19, re-check g).** On Windows a parentless async
 * message box already ran on a thread of its own and blocked nothing, so it used
 * to be passed straight through, but with no owner it could slip behind any
 * other window, and a second hook click then found `hookDialogUp` set and did
 * nothing visible. It now gets the same host, so the box is owned by it; a
 * parented async box on Windows is still non-blocking. On both platforms the
 * host is always-on-top at the `floating` level, so the question stays above the
 * window the owner clicks next, and `raiseOpenDialog` brings it back to the
 * front. On Windows the host is also click-through (`setIgnoreMouseEvents`):
 * a transparent window there is hit on its clear pixels, so without it the
 * invisible rectangle around the box would block clicks to every app. Other platforms pass straight through, as before.
 */
import {
  BrowserWindow,
  dialog,
  type MessageBoxOptions,
  type MessageBoxReturnValue
} from 'electron';

/**
 * The host's size. Invisible — it is transparent and has no frame — so all it
 * decides is the strip the sheet slides out of: wider than any alert Walder
 * asks, so the sheet is never wider than its parent, and tall enough that the
 * longest of them (the Codex install detail, path included) hangs inside it.
 */
export const HOST_WIDTH = 520;
export const HOST_HEIGHT = 420;

/** The host of the dialog that is up right now, if any; see `raiseOpenDialog`. */
let openHost: BrowserWindow | null = null;

/**
 * Bring the open dialog's host (and so the dialog it owns) to the front.
 * `false` when no dialog is up. For a second hook click while the first
 * question is still unanswered: the owner gets the question back, not nothing.
 */
export function raiseOpenDialog(): boolean {
  const host = openHost;
  if (host === null || host.isDestroyed()) return false;
  host.show();
  host.moveTop();
  host.focus();
  return true;
}

/**
 * `dialog.showMessageBox(options)`, without the nested run loop.
 *
 * Resolves with the answer once the sheet is dismissed; the host window is
 * destroyed whether it was answered or the dialog call threw, so a failure
 * cannot leave an invisible window behind to swallow clicks.
 */
export async function showMessageBoxWithoutBlocking(
  options: MessageBoxOptions,
  platform: NodeJS.Platform = process.platform
): Promise<MessageBoxReturnValue> {
  if (platform !== 'darwin' && platform !== 'win32') return dialog.showMessageBox(options);

  const host = new BrowserWindow({
    width: HOST_WIDTH,
    height: HOST_HEIGHT,
    center: true,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    // Nothing is ever loaded into it, but a window is a renderer, and a
    // renderer gets the same locked-down defaults as every other one here.
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  openHost = host;
  try {
    // Above the window the owner clicks next; `floating` is the level a
    // utility window uses, under the menu bar and the dog's own panel.
    host.setAlwaysOnTop(true, 'floating');
    // On Windows a transparent window still takes the mouse on its clear
    // pixels; click-through keeps the invisible 520x420 from eating clicks
    // meant for other apps. The box is its own owned window and still gets input.
    if (platform === 'win32') host.setIgnoreMouseEvents(true);
    // `show`, not `showInactive`: the alert is a question the owner has to
    // answer, so it takes the focus the parentless one took — and the sheet
    // needs a key window for Return to press its default button.
    host.show();
    return await dialog.showMessageBox(host, options);
  } finally {
    if (openHost === host) openHost = null;
    if (!host.isDestroyed()) host.destroy();
  }
}

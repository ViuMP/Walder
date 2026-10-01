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
 * **macOS only.** On Windows a parentless async message box already runs on a
 * thread of its own and blocks nothing, so it is passed straight through.
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
  if (platform !== 'darwin') return dialog.showMessageBox(options);

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
  try {
    // `show`, not `showInactive`: the alert is a question the owner has to
    // answer, so it takes the focus the parentless one took — and the sheet
    // needs a key window for Return to press its default button.
    host.show();
    return await dialog.showMessageBox(host, options);
  } finally {
    if (!host.isDestroyed()) host.destroy();
  }
}

/**
 * Walder — main process.
 *
 * Assembles the three pieces of the app: the persisted settings, the overlay
 * window, and the tray menu that is its only user interface. Walder has no dock
 * icon and no closable window, so it never quits on its own — the Quit item in
 * the tray menu is the single way out.
 */
import { app, BrowserWindow, session, Tray } from 'electron';
import { createStore, applyLaunchAtLogin, type WalderStore } from './store';
import { createOverlay, type Overlay } from './overlay-window';
import { createTray, initialScale } from './tray';
import { registerIpc, unregisterIpc } from './ipc-bridge';
import { loadSheet } from './sheet';
import { vlog, warn } from './log';
import type { SpriteSheet } from '../sprites/types';

/**
 * Only ever one Walder. A mascot is a singleton by nature — two overlays would
 * fight over the same screen corner, double every provider poll and bark twice
 * about the same threshold. The lock must be requested before `whenReady`, so
 * the second copy exits before it can build a window.
 */
const gotTheLock = app.requestSingleInstanceLock();

// Module-scope handles: a `Tray` that is garbage-collected disappears from the
// menu bar, so these must outlive the function that made them.
let tray: Tray | null = null;
let overlay: Overlay | null = null;
let store: WalderStore | null = null;
let sheet: SpriteSheet | null = null;

/**
 * Refuse every permission the renderer could ask for, before any window exists.
 *
 * Walder's renderer draws a dog: it has no use for the camera, the microphone,
 * geolocation, notifications, clipboard reads, media-key capture or anything else
 * on that list. Electron's default is to *grant* several of them, and a
 * permission dialog attributed to an app with no visible window would be both
 * alarming and unexplainable. Both handlers are needed — `RequestHandler` covers
 * the asking APIs, `CheckHandler` the synchronous availability checks — and they
 * must be installed before the window loads, or a fast page could slip a request
 * in first.
 */
function denyAllPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  vlog('permission handlers installed (deny all)');
}

function start(): void {
  store = createStore();

  try {
    sheet = loadSheet();
  } catch (error) {
    // A malformed sheet leaves nothing to draw, and silently showing an empty
    // window would look identical to a crash. Fail loudly instead.
    warn('sprite sheet failed validation:', error);
    app.exit(1);
    return;
  }

  vlog('userData:', app.getPath('userData'));
  vlog('settings file:', store.path);

  // Keep the OS login item in step with the stored preference: the user may have
  // removed it in System Settings since the last run. A no-op unless packaged —
  // see `applyLaunchAtLogin`.
  applyLaunchAtLogin(store.get('launchAtLogin') === true);

  denyAllPermissions();

  overlay = createOverlay(store, initialScale(store));
  // `getOverlay`, not `overlay`: `ensureOverlay` replaces the window without
  // rebuilding the tray, and a captured handle would leave every menu item
  // pointing at a destroyed window.
  tray = createTray({ getOverlay: () => overlay, store, sheet, onQuit: () => app.quit() });
  registerIpc({ overlay, store, sheet, getTray: () => tray });
}

/** Rebuild the overlay if it was somehow destroyed; the tray and store persist. */
function ensureOverlay(): void {
  if (store === null || sheet === null) return;
  if (overlay !== null && !overlay.win.isDestroyed()) return;

  unregisterIpc();
  overlay = createOverlay(store, initialScale(store));
  // registerIpc pushes the sheet itself once the new page finishes loading. The
  // tray needs no rebuild: it reads `overlay` through the closure above.
  registerIpc({ overlay, store, sheet, getTray: () => tray });
  vlog('overlay rebuilt');
}

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Nothing to focus — the overlay is always visible and deliberately never
    // takes focus. Just make sure it is actually there.
    ensureOverlay();
    if (overlay !== null && !overlay.win.isVisible()) overlay.win.showInactive();
  });

  void app.whenReady().then(() => {
    // No dock icon: Walder lives in the menu bar and on top of other windows.
    // Must run after ready and before the first window, or macOS briefly
    // bounces an icon into the dock.
    app.dock?.hide();

    start();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) ensureOverlay();
    });
  });

  /**
   * Never auto-quit. Electron's default is to quit once the last window closes;
   * registering a listener that does nothing suppresses that on every platform,
   * so the app survives even if the overlay is momentarily gone. Quit is the
   * tray item, and nothing else.
   */
  app.on('window-all-closed', () => {
    vlog('all windows closed; staying alive (quit is a tray action)');
  });
}

/**
 * Walder — main process.
 *
 * Assembles the pieces of the app: the persisted settings, the overlay window,
 * the hover panel, the poll loop that feeds both, the login windows, and the
 * tray menu that is the app's only user interface. Walder has no dock icon and
 * no closable window, so it never quits on its own — the Quit item in the tray
 * menu is the single way out.
 *
 * Wiring order matters and is not arbitrary:
 *   store → sheet → overlay → panel → poller → login windows → tray → IPC.
 * The poller needs the store (interval, stored snapshot) and something to send
 * snapshots to; the login windows need the poller (to refresh after a login) and
 * the chains (to know when a login has taken); the tray needs all of them; and
 * the IPC bridge is registered last because it hands renderer messages to every
 * one of them.
 */
import { app, BrowserWindow, session } from 'electron';
import { createStore, applyLaunchAtLogin, type WalderStore } from './store';
import { createOverlay, type Overlay } from './overlay-window';
import { createHoverPanel, type HoverPanel } from './hover-panel';
import { createTray, initialScale, type TrayHandle } from './tray';
import { registerIpc, unregisterIpc } from './ipc-bridge';
import { boxSize, loadSheet } from './sheet';
import { createPoller, type Poller } from './poller';
import { createChains } from './provider-chains';
import { createLoginWindows, type LoginWindows } from './login-window';
import { CH, type ServiceName } from './ipc';
import { chainFor, isWebLoginAuthenticated, type ProviderChains } from '../providers/registry';
import { forIpc, type UsageSnapshot } from '../core/usage';
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
let trayHandle: TrayHandle | null = null;
let overlay: Overlay | null = null;
let panel: HoverPanel | null = null;
let store: WalderStore | null = null;
let sheet: SpriteSheet | null = null;
let poller: Poller | null = null;
let chains: ProviderChains | null = null;
let logins: LoginWindows | null = null;

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
 *
 * The login partitions get the same treatment in `login-window.ts`; this covers
 * the default session, which is the overlay's and the panel's.
 */
function denyAllPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  vlog('permission handlers installed (deny all)');
}

/**
 * Push a snapshot to both windows and refresh the menu's account lines.
 *
 * `forIpc` first: the renderers get the trimmed snapshot, without each bucket's
 * original provider payload. Nothing in either window reads it, and it is
 * unvalidated remote JSON that on the ChatGPT route can carry account metadata.
 */
function publishSnapshot(snapshot: UsageSnapshot): void {
  const payload = forIpc(snapshot);
  overlay?.send(CH.usageUpdate, payload);
  panel?.send(CH.usageUpdate, payload);
  trayHandle?.refresh();
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

  overlay = createOverlay(store, initialScale(store), boxSize(sheet, 'stand'));
  panel = createHoverPanel();

  chains = createChains({ store });
  poller = createPoller({ store, chains, onSnapshot: publishSnapshot });

  logins = createLoginWindows({
    store,
    /*
     * "Logged in" means the *web* provider for this service is authenticated —
     * one request that has to come back with an organisation list or an access
     * token. Not "any provider in the chain is available": that is what closed
     * the login window two seconds after it opened for anyone with Claude Code
     * or Codex installed, because their token providers are available for the
     * same service and know nothing about the browser session being created.
     * And not "a cookie exists" either: both sites set cookies on the login
     * page itself.
     */
    isLoggedIn: async (service: ServiceName) => {
      if (chains === null) return false;
      return isWebLoginAuthenticated(chainFor(chains, service), service);
    },
    onLoggedIn: () => {
      poller?.refreshNow();
      trayHandle?.refresh();
    }
  });

  // `getOverlay`, not `overlay`: `ensureOverlay` replaces the window without
  // rebuilding the tray, and a captured handle would leave every menu item
  // pointing at a destroyed window.
  trayHandle = createTray({
    getOverlay: () => overlay,
    store,
    sheet,
    onQuit: () => app.quit(),
    getUsage: () => poller?.last() ?? null,
    onRefreshNow: () => poller?.refreshNow() ?? false,
    refreshCooldownMs: () => poller?.cooldownRemainingMs() ?? 0,
    onLogin: (service) => logins?.openLogin(service),
    onLogout: (service) => {
      void logins?.logout(service).then(() => {
        // A logout changes what the panel should say immediately, not in three
        // minutes: poll again so the status line and the dog's face follow.
        poller?.refreshNow();
        trayHandle?.refresh();
      });
    },
    // Size and Reset position both move the dog out from under the hover card.
    onGeometryChanged: () => panel?.hoverLeave()
  });

  registerIpcBridge();

  // Last, so the first snapshot has somewhere to go.
  poller.start();
}

/** Register the IPC table against the current windows. */
function registerIpcBridge(): void {
  if (overlay === null || store === null || sheet === null) return;
  registerIpc({
    overlay,
    store,
    sheet,
    getTray: () => trayHandle?.tray ?? null,
    getPanel: () => panel,
    getUsage: () => poller?.last() ?? null,
    onRefreshNow: () => poller?.refreshNow() ?? false,
    onLogin: (service) => logins?.openLogin(service),
    onLogout: (service) => {
      void logins?.logout(service).then(() => poller?.refreshNow());
    }
  });
}

/** Rebuild the overlay if it was somehow destroyed; the tray and store persist. */
function ensureOverlay(): void {
  if (store === null || sheet === null) return;
  if (overlay !== null && !overlay.win.isDestroyed()) return;

  unregisterIpc();
  overlay = createOverlay(store, initialScale(store), boxSize(sheet, 'stand'));
  // registerIpc pushes the sheet itself once the new page finishes loading. The
  // tray needs no rebuild: it reads `overlay` through the closure above.
  registerIpcBridge();
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

  app.on('before-quit', () => {
    // Stop the timer before the windows go: a poll that lands mid-teardown would
    // try to send to a destroyed webContents.
    poller?.stop();
    logins?.closeAll();
    panel?.destroy();
  });

  /**
   * Never auto-quit. Electron's default is to quit once the last window closes;
   * registering a listener that does nothing suppresses that on every platform,
   * so the app survives even if the overlay is momentarily gone. Quit is the
   * tray item, and nothing else.
   *
   * This matters more now than in M3: a login window closing is the *normal*
   * end of a login, and it must not take the app with it.
   */
  app.on('window-all-closed', () => {
    vlog('all windows closed; staying alive (quit is a tray action)');
  });
}

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
import { app, BrowserWindow, dialog, screen, session } from 'electron';
import { createStore, applyLaunchAtLogin, type WalderStore } from './store';
import { createOverlay, type BoxSizes, type Overlay } from './overlay-window';
import { createHoverPanel, type HoverPanel } from './hover-panel';
import { createTray, initialScale, type TrayHandle } from './tray';
import { registerIpc, unregisterIpc } from './ipc-bridge';
import { boxSize, loadSheet } from './sheet';
import { createPoller, type Poller } from './poller';
import { createChains } from './provider-chains';
import { createLoginWindows, type LoginWindows } from './login-window';
import { createBehaviour, type BehaviourHandle } from './behaviour';
import { createFullscreenWatch, type FullscreenWatch } from './fullscreen-watch';
import { startHookServer, type HookServer } from './hook-server';
import { DEFAULT_HOOK_PORT, applyHooks, claudeSettingsPath } from './claude-hooks';
import { CH, type ServiceName } from './ipc';
import { chainFor, isWebLoginAuthenticated, type ProviderChains } from '../providers/registry';
import { injectedSnapshot } from '../core/usage';
import { forIpc, type UsageSnapshot } from '../core/usage';
import { setLogSink, setVerbose, vlog, warn } from './log';
import { createFileLog } from './log-file';
import { galleryRequested, openGallery } from './gallery-window';
import type { SpriteSheet } from '../sprites/types';

/**
 * Only ever one Walder. A mascot is a singleton by nature — two overlays would
 * fight over the same screen corner, double every provider poll and bark twice
 * about the same threshold. The lock must be requested before `whenReady`, so
 * the second copy exits before it can build a window.
 */
const isGallery = galleryRequested();

/**
 * The gallery run is exempt: it is a different app (a titled, focusable window
 * with no tray, no poller and no overlay), and refusing to open it because the
 * real mascot happens to be running would be maddening — reviewing the artwork
 * with the dog still on screen is the normal case, not an accident.
 */
const gotTheLock = isGallery || app.requestSingleInstanceLock();

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
let behaviour: BehaviourHandle | null = null;
let fullscreenWatch: FullscreenWatch | null = null;
let hookServer: HookServer | null = null;
/** Where `warn`/`vlog` are being written, for the tray caption. */
let logPath: string | undefined;

/**
 * Start writing the log file, before anything else can have something to say.
 *
 * `app.getPath('logs')` is the OS's own place for this — `~/Library/Logs/Walder`
 * on macOS, `%APPDATA%\Walder\logs` on Windows — so an owner asked for "the log
 * file" can be told a location that is the same on every machine. It must be
 * called after `whenReady`, like every other `getPath`.
 *
 * The verbose *level* comes from the store, which is opened a moment later in
 * `start()`; until then only warnings are recorded, which is the right default
 * for the handful of lines that could arrive in between.
 */
function startFileLog(): void {
  try {
    const file = createFileLog({ dir: app.getPath('logs') });
    setLogSink(file.write);
    logPath = file.path;
  } catch (error) {
    // No file, console only. Never fatal: a mascot that refused to start
    // because it could not open its log would be absurd.
    warn('could not open the log file:', error);
  }
}

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
  // Last: the coordinator may bark about this snapshot, and the bubble should
  // land after the numbers it is about.
  behaviour?.onUsage(snapshot);
}

/**
 * Both of the sheet's box dimensions, for the overlay window.
 *
 * Read from the loaded art rather than hard-coded: the winning mascot design
 * chooses its own grid (the 2026-09-08 gate moved it once already), and the
 * window is sized from whichever box is showing.
 */
function sheetBoxes(loaded: SpriteSheet): BoxSizes {
  return { stand: boxSize(loaded, 'stand'), sleep: boxSize(loaded, 'sleep') };
}

/**
 * Start the Claude Code hook listener and remember the port it got.
 *
 * Failure is not fatal and not reported to the owner: the only consequence is
 * that the dog never perks when a reply finishes. Everything else — usage,
 * barks, the panel — is untouched.
 */
async function startHooks(): Promise<void> {
  if (store === null) return;
  const preferred = store.get('hookPort');
  hookServer = await startHookServer({
    port: typeof preferred === 'number' ? preferred : DEFAULT_HOOK_PORT,
    onEvent: (kind) => behaviour?.onHook(kind),
    onPort: (port) => {
      try {
        store?.set('hookPortActual', port);
      } catch (error) {
        warn('could not persist the hook port:', error);
      }
    }
  });
}

/**
 * Install or remove the hooks in `~/.claude/settings.json`, asking first.
 *
 * **Why it asks.** This is the only thing in the whole app that writes to a file
 * the owner did not give it — a file Claude Code itself depends on — and the tray
 * is a menu with no undo, one slip of the mouse away from Quit. So both
 * directions confirm, and the confirmation names the *path* and says a backup is
 * written, because "Install Claude Code hooks…" on its own does not tell anyone
 * which file is about to change. The trailing ellipsis in both labels is the
 * platform convention promising exactly this dialog.
 *
 * Removal is a menu item rather than a README instruction for the same reason:
 * an owner who installed from a `.dmg` has no project folder to run `npm run
 * install-hooks -- --remove` in, so the documented uninstall step was one only a
 * developer could perform. `applyHooks({remove: true})` was already there and
 * already tested; nothing but a way to reach it was missing.
 */
function applyClaudeHooks(remove: boolean): void {
  const path = claudeSettingsPath();
  const verb = remove ? 'Remove' : 'Install';

  const confirmed = dialog.showMessageBoxSync({
    type: 'question',
    title: 'Walder',
    message: `${verb} Walder's Claude Code hooks?`,
    detail: remove
      ? `This takes Walder's three entries out of\n${path}\n\n` +
        'Nothing else in the file is touched, and a dated copy of it is saved ' +
        'beside it first. Claude Code stops telling Walder when a reply is done, ' +
        'and is otherwise unaffected.'
      : `This adds three entries to\n${path}\n\n` +
        'They send a short message to Walder on this machine when Claude Code ' +
        'finishes a reply or waits for you, and do nothing else. A dated copy of ' +
        'the file is saved beside it first.',
    buttons: [verb, 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  if (confirmed !== 0) {
    vlog(`${verb.toLowerCase()}-hooks: cancelled at the confirmation`);
    return;
  }

  // The port actually bound first: the listener walks to `hookPort + 1` when the
  // preferred one is taken, and a hook pointing at the unbound preferred port
  // would look installed and do nothing. Irrelevant to a removal, which matches
  // on the marker rather than the port, but harmless to pass.
  const port = store?.get('hookPortActual') ?? store?.get('hookPort') ?? DEFAULT_HOOK_PORT;
  void applyHooks({ port: typeof port === 'number' ? port : DEFAULT_HOOK_PORT, remove })
    .then((outcome) => {
      vlog(`${verb.toLowerCase()}-hooks:`, outcome.summary);
      const detail =
        outcome.backupPath === null
          ? outcome.summary
          : `${outcome.summary}\n\nThe original file was copied to ${outcome.backupPath}.`;
      // A dialog is the only channel there is: Walder has no window and the
      // owner never sees a terminal.
      void dialog.showMessageBox({
        type: outcome.changed ? 'info' : 'none',
        title: 'Walder',
        message: 'Claude Code hooks',
        detail,
        buttons: ['OK'],
        noLink: true
      });
    })
    .catch((error: unknown) => {
      warn(`${verb.toLowerCase()}-hooks failed:`, error);
      void dialog.showMessageBox({
        type: 'error',
        title: 'Walder',
        message: 'Could not update the Claude Code settings',
        detail: 'Nothing was changed. See the log for details.',
        buttons: ['OK'],
        noLink: true
      });
    });
}

function start(): void {
  store = createStore();

  // Before the first `vlog` that could matter, and after the store exists,
  // because the store is where the owner's choice lives.
  setVerbose(store.get('verboseLog') === true);
  vlog('walder starting; log file:', logPath ?? '(console only)');

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

  // No `denyAllPermissions()` here any more: it is installed in the `whenReady`
  // handler, above both this and the gallery branch. Calling it twice was
  // harmless (the second `setPermissionRequestHandler` simply replaced the
  // first) but it logged "permission handlers installed" twice on every start,
  // which reads like a restart that did not happen.
  overlay = createOverlay(store, initialScale(store), sheetBoxes(sheet));
  panel = createHoverPanel();

  behaviour = createBehaviour({
    getOverlay: () => overlay,
    // Only the sleeping-box pet consults this: it picks between a twitch and a
    // `…zzz` bubble, and the renderer's usual "fall back to idle" would be no
    // visible reaction at all there.
    hasAnimation: (name) => sheet?.animations[name] !== undefined
  });

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
    ...(logPath === undefined ? {} : { logPath }),
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
    onGeometryChanged: () => panel?.hoverLeave(),
    onSleepInFullscreen: (on) => {
      // Turning it off must wake a dog that is already curled up, without
      // waiting for the next poll of a watch that is now idle. `setEnabled`
      // also stops the 2 s timer when off (and restarts it, clearing a
      // given-up watch, when on) — see `fullscreen-watch.ts`.
      if (!on) behaviour?.setFullscreen(false);
      fullscreenWatch?.setEnabled(on);
    },
    onInstallHooks: () => applyClaudeHooks(false),
    onRemoveHooks: () => applyClaudeHooks(true),
    onInjectUsage: (pct) => {
      // Through `publishSnapshot`, so the panel, the tray and the dog all see
      // the same fake poll — see `injectedSnapshot`.
      publishSnapshot(injectedSnapshot(pct, Date.now(), poller?.last()?.intervalMs ?? 180_000));
    },
    onSimulateHook: (kind) => behaviour?.onHook(kind),
    onToggleFullscreen: () => behaviour?.setFullscreen(behaviour.isFullscreen() !== true),
    isFullscreen: () => behaviour?.isFullscreen() ?? false
  });

  fullscreenWatch = createFullscreenWatch({
    onChange: (fullscreen) => behaviour?.setFullscreen(fullscreen),
    enabled: () => store?.get('sleepInFullscreen') !== false,
    // Fullscreen is per display: a film on the external monitor must not put a
    // dog sitting on the laptop screen to sleep. Read on every poll rather than
    // captured, because the owner can drag him between displays.
    dogDisplay: () => {
      const win = overlay?.win;
      if (win === undefined || win.isDestroyed()) return null;
      return screen.getDisplayMatching(win.getBounds()).bounds;
    }
  });
  fullscreenWatch.start();

  void startHooks();

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
    },
    onPet: () => behaviour?.onPet()
  });
}

/** Rebuild the overlay if it was somehow destroyed; the tray and store persist. */
function ensureOverlay(): void {
  if (store === null || sheet === null) return;
  if (overlay !== null && !overlay.win.isDestroyed()) return;

  unregisterIpc();
  overlay = createOverlay(store, initialScale(store), sheetBoxes(sheet));
  // registerIpc pushes the sheet itself once the new page finishes loading. The
  // tray needs no rebuild: it reads `overlay` through the closure above.
  registerIpcBridge();
  vlog('overlay rebuilt');
}

/**
 * `npm run sprites`: be the animation gallery instead of the mascot.
 *
 * A wholesale replacement, not an extra window. None of the machinery in
 * `start()` runs — no tray, no store write, no provider poll, no hook listener —
 * because the owner is reviewing artwork, and a review session that silently
 * polled his account or moved his dog would be a surprise. See
 * `gallery-window.ts`.
 */
function startGallery(): void {
  const win = openGallery();
  // An ordinary window, so ordinary window rules: closing it ends the run. This
  // is the exact opposite of the mascot's "never quit on your own", which is why
  // it is wired here and not in the shared handler below.
  win.on('closed', () => app.quit());
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
    // First, so that anything below which fails has somewhere to say so.
    // `app.getPath` is only meaningful after `whenReady`.
    startFileLog();

    // Before *any* window, mascot or gallery. It used to live inside `start()`,
    // which the gallery run returns before ever reaching — so the one window in
    // this app that renders a whole sheet of artwork was the one running on
    // Electron's permissive defaults. Nothing about a gallery needs a camera
    // either, and "no window has permissions" is a rule that is only worth
    // having if it has no exceptions.
    denyAllPermissions();

    if (isGallery) {
      // No `dock.hide()`: the gallery is a normal window and wants its icon.
      startGallery();
      return;
    }

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
    // Stop every timer and the listener before the windows go: a poll, a tick or
    // a hook that lands mid-teardown would try to send to a destroyed
    // webContents.
    poller?.stop();
    behaviour?.stop();
    fullscreenWatch?.stop();
    void hookServer?.close();
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

/**
 * Wires the channel table in `ipc.ts` to `ipcMain`.
 *
 * Two rules hold for every handler here:
 *  1. **Check the sender.** Only the app's own windows may drive the app, and
 *     each channel names which one: the overlay owns hit/drag/hover, the panel
 *     owns `panel:size`, and either may ask for settings or a refresh. Anything
 *     else is dropped. (The login windows have no preload at all, so they cannot
 *     reach these channels even in principle.)
 *  2. **Validate the payload.** The renderers are treated as untrusted, so a
 *     malformed message is discarded rather than coerced into something the
 *     window API — or, now, a *login flow* — will accept. See the note at the
 *     top of `ipc.ts`.
 */
import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent, Tray } from 'electron';
import type { SpriteSheet } from '../sprites/types';
import {
  CH,
  parseDragMovePayload,
  parseHitPayload,
  parseHoverEnterPayload,
  parsePanelSizePayload,
  parseServicePayload,
  type ServiceName,
  type SettingsPayload
} from './ipc';
import type { Overlay } from './overlay-window';
import type { HoverPanel } from './hover-panel';
import { resolvePalette } from './sheet';
import { readCardSize, type WalderStore } from './store';
import { forIpc, type UsageSnapshot } from '../core/usage';
import { vlog, warn } from './log';

export interface BridgeDeps {
  readonly overlay: Overlay;
  readonly store: WalderStore;
  readonly sheet: SpriteSheet;
  /** Looked up lazily: the tray is built after the window it controls. */
  readonly getTray: () => Tray | null;
  /** Looked up lazily for the same reason; `null` before the panel exists. */
  readonly getPanel: () => HoverPanel | null;
  /** The last snapshot, for `settings:get` — so a reloaded page keeps its numbers. */
  readonly getUsage: () => UsageSnapshot | null;
  /** Manual refresh. `false` when the cooldown blocked it. */
  readonly onRefreshNow: () => boolean;
  readonly onLogin: (service: ServiceName) => void;
  readonly onLogout: (service: ServiceName) => void;
  /**
   * The owner clicked the dog. Optional so the bridge still registers without a
   * behaviour coordinator wired to it (the renderer's own wiggle is unaffected).
   */
  readonly onPet?: () => void;
}

/** All renderer -> main channels, so `unregisterIpc` can undo the whole table. */
const RENDERER_CHANNELS: readonly string[] = [
  CH.settingsGet,
  CH.hitSet,
  CH.dragStart,
  CH.dragMove,
  CH.dragEnd,
  CH.pet,
  CH.menuOpen,
  CH.hoverEnter,
  CH.hoverLeave,
  CH.refreshNow,
  CH.authLogin,
  CH.authLogout,
  CH.panelSize
];

export function registerIpc(deps: BridgeDeps): void {
  const { overlay, store, sheet, getTray, getPanel } = deps;

  /** Is this message really from the overlay renderer? */
  const fromOverlay = (event: IpcMainInvokeEvent, channel: string): boolean => {
    if (event.sender === overlay.win.webContents) return true;
    warn(`ignored ${channel} from an unexpected sender`);
    return false;
  };

  /** Is this message from the hover panel's renderer? */
  const fromPanel = (event: IpcMainInvokeEvent, channel: string): boolean => {
    const panel = getPanel();
    if (panel !== null && !panel.win.isDestroyed() && event.sender === panel.win.webContents) {
      return true;
    }
    warn(`ignored ${channel} from an unexpected sender`);
    return false;
  };

  /** Either of the app's own renderers. */
  const fromEitherWindow = (event: IpcMainInvokeEvent, channel: string): boolean => {
    if (event.sender === overlay.win.webContents) return true;
    const panel = getPanel();
    if (panel !== null && !panel.win.isDestroyed() && event.sender === panel.win.webContents) {
      return true;
    }
    warn(`ignored ${channel} from an unexpected sender`);
    return false;
  };

  const settingsPayload = (): SettingsPayload => {
    const usage = deps.getUsage();
    return {
      sheet,
      mode: overlay.currentMode(),
      palette: resolvePalette(sheet, store.get('palette')),
      forceInteractive: store.get('forceInteractive') === true,
      // Trimmed, exactly as `publishSnapshot` trims a live one: `Bucket.raw`
      // never crosses IPC, whether the snapshot is pushed or pulled.
      usage: usage === null ? null : forIpc(usage),
      // Pulled with the first frame rather than pushed afterwards: the panel
      // would otherwise draw itself Large once and report *that* height to
      // main, which sizes the window around a card that is about to change.
      cardSize: readCardSize(store)
    };
  };

  // Everything the renderer needs for its first frame, in one round trip. Asking
  // for it beats waiting to be pushed to: it removes the race between the page
  // finishing load and main deciding to send.
  ipcMain.handle(CH.settingsGet, (event) => {
    if (!fromEitherWindow(event, CH.settingsGet)) return null;
    // Also the cheapest liveness probe there is: if this line never appears, the
    // renderer bundle failed before `boot()` and the window is blank.
    vlog('settings:get');
    return settingsPayload();
  });

  ipcMain.handle(CH.hitSet, (event, raw: unknown) => {
    if (!fromOverlay(event, CH.hitSet)) return;
    const payload = parseHitPayload(raw);
    if (payload === null) {
      warn('dropped malformed hit:set payload');
      return;
    }
    vlog('hit:set', payload.inside);
    overlay.setInteractive(payload.inside);
  });

  ipcMain.handle(CH.dragStart, (event) => {
    if (!fromOverlay(event, CH.dragStart)) return;
    // A drag means the card is in the way of what the owner is doing.
    getPanel()?.hoverLeave();
    overlay.dragStart();
  });

  ipcMain.handle(CH.dragMove, (event, raw: unknown) => {
    if (!fromOverlay(event, CH.dragMove)) return;
    const payload = parseDragMovePayload(raw);
    if (payload === null) {
      warn('dropped malformed drag:move payload');
      return;
    }
    overlay.dragMove(payload.dxScreen, payload.dyScreen);
  });

  ipcMain.handle(CH.dragEnd, (event) => {
    if (!fromOverlay(event, CH.dragEnd)) return;
    overlay.dragEnd();
  });

  // The renderer does its own wiggle; this is the half that dismisses whatever
  // bubble is up and plays the `pet` animation (`core/behaviour.ts`).
  ipcMain.handle(CH.pet, (event) => {
    if (!fromOverlay(event, CH.pet)) return;
    vlog('pet');
    deps.onPet?.();
  });

  ipcMain.handle(CH.menuOpen, (event) => {
    if (!fromOverlay(event, CH.menuOpen)) return;
    const tray = getTray();
    if (tray === null) {
      warn('menu:open with no tray');
      return;
    }
    vlog('menu:open');
    tray.popUpContextMenu();
  });

  /*
   * Both hover edges are logged, permanently.
   *
   * They are the first half of the diagnosis for "the card does not appear over
   * a macOS full-screen page": no `hover:enter` line at all, while the owner is
   * hovering the dog on a full-screen Space, means the *renderer* never saw the
   * mouse there (an ignore-mouse window not being delivered mouse-moved events
   * on that Space) — a completely different fault from a card that is shown and
   * lands on the wrong Space, which `panel shown` in `hover-panel.ts` reports.
   * The rect is included because it is what the placement is computed from.
   */
  ipcMain.handle(CH.hoverEnter, (event, raw: unknown) => {
    if (!fromOverlay(event, CH.hoverEnter)) return;
    const payload = parseHoverEnterPayload(raw);
    if (payload === null) {
      warn('dropped malformed hover:enter payload');
      return;
    }
    vlog('hover:enter', payload.spriteRectScreen);
    getPanel()?.hoverEnter(payload.spriteRectScreen);
  });

  ipcMain.handle(CH.hoverLeave, (event) => {
    if (!fromOverlay(event, CH.hoverLeave)) return;
    vlog('hover:leave');
    getPanel()?.hoverLeave();
  });

  ipcMain.handle(CH.refreshNow, (event) => {
    if (!fromEitherWindow(event, CH.refreshNow)) return false;
    return deps.onRefreshNow();
  });

  /*
   * Login and logout are the two most consequential things a renderer can ask
   * for — one opens a browser window on a real login page, the other destroys a
   * session. The service name is therefore validated against a closed enum and
   * a bad payload is dropped, never defaulted.
   */
  ipcMain.handle(CH.authLogin, (event, raw: unknown) => {
    if (!fromEitherWindow(event, CH.authLogin)) return;
    const payload = parseServicePayload(raw);
    if (payload === null) {
      warn('dropped malformed auth:login payload');
      return;
    }
    deps.onLogin(payload.service);
  });

  ipcMain.handle(CH.authLogout, (event, raw: unknown) => {
    if (!fromEitherWindow(event, CH.authLogout)) return;
    const payload = parseServicePayload(raw);
    if (payload === null) {
      warn('dropped malformed auth:logout payload');
      return;
    }
    deps.onLogout(payload.service);
  });

  ipcMain.handle(CH.panelSize, (event, raw: unknown) => {
    if (!fromPanel(event, CH.panelSize)) return;
    const payload = parsePanelSizePayload(raw);
    if (payload === null) {
      warn('dropped malformed panel:size payload');
      return;
    }
    getPanel()?.setContentHeight(payload.height);
  });

  // Push the initial state on every load (including a dev-server reload), so a
  // renderer that reloads without asking still ends up drawing the right thing.
  overlay.win.webContents.on('did-finish-load', () => {
    const state = settingsPayload();
    overlay.send(CH.sheetSet, { sheet: state.sheet });
    overlay.send(CH.modeSet, state.mode);
    overlay.send(CH.paletteSet, state.palette);
    if (state.usage !== null) overlay.send(CH.usageUpdate, state.usage);
    vlog('pushed sheet/mode/palette after load');
  });
}

/** Remove every handler. Used when the overlay is rebuilt (macOS `activate`). */
export function unregisterIpc(): void {
  for (const channel of RENDERER_CHANNELS) ipcMain.removeHandler(channel);
}

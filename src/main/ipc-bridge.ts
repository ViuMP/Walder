/**
 * Wires the channel table in `ipc.ts` to `ipcMain`.
 *
 * Two rules hold for every handler here:
 *  1. **Check the sender.** Only the overlay's own `webContents` may drive the
 *     window. Anything else is dropped.
 *  2. **Validate the payload.** The renderer is treated as untrusted, so a
 *     malformed message is discarded rather than coerced into something the
 *     window API will accept. See the note at the top of `ipc.ts`.
 */
import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent, Tray } from 'electron';
import type { SpriteSheet } from '../sprites/types';
import {
  CH,
  parseDragMovePayload,
  parseHitPayload,
  type SettingsPayload
} from './ipc';
import type { Overlay } from './overlay-window';
import { resolvePalette } from './sheet';
import type { WalderStore } from './store';
import { vlog, warn } from './log';

export interface BridgeDeps {
  readonly overlay: Overlay;
  readonly store: WalderStore;
  readonly sheet: SpriteSheet;
  /** Looked up lazily: the tray is built after the window it controls. */
  readonly getTray: () => Tray | null;
}

/** All renderer -> main channels, so `unregisterIpc` can undo the whole table. */
const RENDERER_CHANNELS: readonly string[] = [
  CH.settingsGet,
  CH.hitSet,
  CH.dragStart,
  CH.dragMove,
  CH.dragEnd,
  CH.pet,
  CH.menuOpen
];

export function registerIpc(deps: BridgeDeps): void {
  const { overlay, store, sheet, getTray } = deps;

  /** Is this message really from the overlay renderer? */
  const fromOverlay = (event: IpcMainInvokeEvent, channel: string): boolean => {
    if (event.sender === overlay.win.webContents) return true;
    warn(`ignored ${channel} from an unexpected sender`);
    return false;
  };

  const settingsPayload = (): SettingsPayload => ({
    sheet,
    mode: overlay.currentMode(),
    palette: resolvePalette(sheet, store.get('palette')),
    forceInteractive: store.get('forceInteractive') === true
  });

  // Everything the renderer needs for its first frame, in one round trip. Asking
  // for it beats waiting to be pushed to: it removes the race between the page
  // finishing load and main deciding to send.
  ipcMain.handle(CH.settingsGet, (event) => {
    if (!fromOverlay(event, CH.settingsGet)) return null;
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

  // M3 has nothing to do on a pet beyond the renderer's own wiggle; the reaction
  // (mood, a bubble) arrives with the behaviour stage.
  ipcMain.handle(CH.pet, (event) => {
    if (!fromOverlay(event, CH.pet)) return;
    vlog('pet');
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

  // Push the initial state on every load (including a dev-server reload), so a
  // renderer that reloads without asking still ends up drawing the right thing.
  overlay.win.webContents.on('did-finish-load', () => {
    const state = settingsPayload();
    overlay.send(CH.sheetSet, { sheet: state.sheet });
    overlay.send(CH.modeSet, state.mode);
    overlay.send(CH.paletteSet, state.palette);
    vlog('pushed sheet/mode/palette after load');
  });
}

/** Remove every handler. Used when the overlay is rebuilt (macOS `activate`). */
export function unregisterIpc(): void {
  for (const channel of RENDERER_CHANNELS) ipcMain.removeHandler(channel);
}

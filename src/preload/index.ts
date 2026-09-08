/**
 * Walder — preload. Runs sandboxed, bundled as CJS (Electron cannot load an ESM
 * preload into a sandboxed renderer).
 *
 * This is the entire surface the renderer gets: seven calls out and three
 * subscriptions in, all on the fixed channel table in `../main/ipc`. Nothing
 * generic is exposed — no `invoke(channel, ...)`, no `ipcRenderer` — so a
 * compromised renderer can only say the things listed here, and main still
 * validates every one of them.
 *
 * `on*` returns its own unsubscribe function: nothing re-subscribes today, but a
 * listener that cannot be removed is a leak waiting for the first component that
 * does.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { CH } from '../main/ipc';
import type { ModePayload, PalettePayload, SettingsPayload, SheetPayload } from '../main/ipc';

/** Subscribe to a main -> renderer channel; the return value unsubscribes. */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api = {
  /** Everything needed for the first frame: sheet, scale, box, palette, flags. */
  getSettings: async (): Promise<SettingsPayload | null> =>
    (await ipcRenderer.invoke(CH.settingsGet)) as SettingsPayload | null,

  /** Report a hover crossing: `true` when the cursor is on opaque sprite pixels. */
  setHit: async (inside: boolean): Promise<void> => {
    await ipcRenderer.invoke(CH.hitSet, { inside });
  },

  dragStart: async (): Promise<void> => {
    await ipcRenderer.invoke(CH.dragStart);
  },

  /** Cumulative cursor movement since `dragStart`, in screen pixels. */
  dragMove: async (dxScreen: number, dyScreen: number): Promise<void> => {
    await ipcRenderer.invoke(CH.dragMove, { dxScreen, dyScreen });
  },

  dragEnd: async (): Promise<void> => {
    await ipcRenderer.invoke(CH.dragEnd);
  },

  pet: async (): Promise<void> => {
    await ipcRenderer.invoke(CH.pet);
  },

  /** Right-click on the dog: open the tray menu. */
  openMenu: async (): Promise<void> => {
    await ipcRenderer.invoke(CH.menuOpen);
  },

  onSheet: (callback: (payload: SheetPayload) => void): (() => void) =>
    subscribe(CH.sheetSet, callback),

  onMode: (callback: (payload: ModePayload) => void): (() => void) =>
    subscribe(CH.modeSet, callback),

  onPalette: (callback: (payload: PalettePayload) => void): (() => void) =>
    subscribe(CH.paletteSet, callback),

  /** Main changed the click-through flag itself: re-derive and re-send the hover state. */
  onHitResync: (callback: () => void): (() => void) =>
    subscribe(CH.hitResync, () => callback())
};

contextBridge.exposeInMainWorld('walder', api);

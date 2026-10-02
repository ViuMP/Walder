/**
 * Walder — preload. Runs sandboxed, bundled as CJS (Electron cannot load an ESM
 * preload into a sandboxed renderer).
 *
 * This is the entire surface the renderer gets: a fixed list of calls out and
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
import type {
  BarkSoundPayload,
  CardSizePayload,
  FacingPayload,
  HoverCursorPayload,
  HoverEnterPayload,
  ModePayload,
  PalettePayload,
  ResetStylePayload,
  ScenePayload,
  ServiceName,
  SessionsPayload,
  SettingsPayload,
  SheetPayload,
  UsagePayload
} from '../main/ipc';
import type { Rect } from '../core/geometry';

/** Subscribe to a main -> renderer channel; the return value unsubscribes. */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/**
 * Run `callback` once the frame after the next one has begun.
 *
 * Two frames, not one, because of where this is called from: `getSettings`
 * schedules it *before* it returns the settings, so the first callback runs no
 * later than the renderer's own paint request for the sheet (its `await`
 * continuation queues that a moment after) and may run ahead of it in the same
 * frame. By the second, the frame that drew the dog has been produced.
 */
function afterNextPaint(callback: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

const api = {
  /**
   * Everything needed for the first frame: sheet, scale, box, palette, flags.
   *
   * Also the one place that knows when that first frame exists — the renderer
   * draws the dog right after this resolves — so it reports it to main
   * (`CH.overlayPainted`), which is what the launch's hook offer waits for.
   * Here rather than in the renderer so the renderer did not need to change; a
   * refused `null` reports nothing, since nothing will be drawn.
   */
  getSettings: async (): Promise<SettingsPayload | null> => {
    const settings = (await ipcRenderer.invoke(CH.settingsGet)) as SettingsPayload | null;
    if (settings !== null) afterNextPaint(() => void ipcRenderer.invoke(CH.overlayPainted));
    return settings;
  },

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

  /**
   * The cursor came to rest on the dog's ink. `spriteRectWindow` is the sprite's
   * opaque bounds in *window* coordinates — only the renderer can know them —
   * and `viewport` the client size they were measured in. Main adds the
   * window's position itself (`HoverEnterPayload` in `main/ipc` has why).
   */
  hoverEnter: async (
    spriteRectWindow: Rect,
    viewport: HoverEnterPayload['viewport']
  ): Promise<void> => {
    const payload: HoverEnterPayload = { spriteRectWindow, viewport };
    await ipcRenderer.invoke(CH.hoverEnter, payload);
  },

  /** The cursor left the dog, or a drag began. */
  hoverLeave: async (): Promise<void> => {
    await ipcRenderer.invoke(CH.hoverLeave);
  },

  /** Poll every provider now. Resolves `false` when the cooldown blocked it. */
  refreshNow: async (): Promise<boolean> =>
    (await ipcRenderer.invoke(CH.refreshNow)) as boolean,

  login: async (service: ServiceName): Promise<void> => {
    await ipcRenderer.invoke(CH.authLogin, { service });
  },

  logout: async (service: ServiceName): Promise<void> => {
    await ipcRenderer.invoke(CH.authLogout, { service });
  },

  /** Panel only: report the measured card height so main can size the window. */
  reportPanelSize: async (height: number): Promise<void> => {
    await ipcRenderer.invoke(CH.panelSize, { height });
  },

  onSheet: (callback: (payload: SheetPayload) => void): (() => void) =>
    subscribe(CH.sheetSet, callback),

  onMode: (callback: (payload: ModePayload) => void): (() => void) =>
    subscribe(CH.modeSet, callback),

  onPalette: (callback: (payload: PalettePayload) => void): (() => void) =>
    subscribe(CH.paletteSet, callback),

  /** Main changed the click-through flag itself: re-derive and re-send the hover state. */
  onHitResync: (callback: () => void): (() => void) =>
    subscribe(CH.hitResync, () => callback()),

  /** Main moved the window under a still cursor: here is where the cursor is now. */
  onHoverCursor: (callback: (payload: HoverCursorPayload) => void): (() => void) =>
    subscribe(CH.hoverCursor, callback),

  /**
   * The dog crossed the middle of his display and should look the other way.
   * Overlay only; main decides (see `core/facing.ts`) because only main knows
   * which display the window is on.
   */
  onFacing: (callback: (payload: FacingPayload) => void): (() => void) =>
    subscribe(CH.facingSet, callback),

  /**
   * The owner picked another card layout in the tray menu. Panel only — the
   * overlay has no card. A channel of its own rather than a field on
   * `usage:update`, which also feeds the bark machine.
   */
  onCardSize: (callback: (payload: CardSizePayload) => void): (() => void) =>
    subscribe(CH.cardSizeSet, callback),

  /** The owner picked another reset wording in the tray menu. Panel only. */
  onResetStyle: (callback: (payload: ResetStylePayload) => void): (() => void) =>
    subscribe(CH.resetStyleSet, callback),

  /** Overlay only: whether an opted-in threshold nudge may make a sound. */
  onBarkSound: (callback: (payload: BarkSoundPayload) => void): (() => void) =>
    subscribe(CH.barkSoundSet, callback),

  /**
   * The live coding sessions changed. Panel only — the SESSIONS block is part
   * of the card, and the overlay has no card.
   */
  onSessions: (callback: (payload: SessionsPayload) => void): (() => void) =>
    subscribe(CH.sessionsSet, callback),

  /** A fresh (or restored) usage snapshot. Sent to both windows. */
  onUsage: (callback: (payload: UsagePayload) => void): (() => void) =>
    subscribe(CH.usageUpdate, callback),

  /**
   * One behaviour event: a face, a speech bubble, or an animation to play.
   * Overlay only — the panel has no dog to animate.
   */
  onScene: (callback: (payload: ScenePayload) => void): (() => void) =>
    subscribe(CH.scene, callback)
};

contextBridge.exposeInMainWorld('walder', api);

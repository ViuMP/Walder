/**
 * The mascot window: transparent, frameless, always on top, and click-through
 * everywhere except the dog's own opaque pixels.
 *
 * The central trick is that the window is click-through *by default*
 * (`setIgnoreMouseEvents(true, { forward: true })`), which lets the user work
 * normally with the dog sitting on top of everything. `forward: true` keeps mouse
 * *move* messages arriving even while clicks pass through, so the renderer can
 * hit-test the cursor against the current frame's alpha mask and tell us the
 * moment it crosses onto ink. Only then does the window start accepting clicks —
 * and it goes back to ignoring them as soon as the cursor leaves. Nothing here
 * polls; the state changes only when the renderer reports a crossing.
 *
 * Consequences worth knowing before changing anything in this file:
 *  - While click-through, `mousedown` never reaches the renderer. A click on the
 *    dog therefore always arrives *after* a `hit:set true` for the same pixel.
 *  - During a drag the window moves under a stationary cursor, so the cursor can
 *    end up over transparent pixels. Going click-through then would drop the drag
 *    on the floor, so hit updates are suppressed until the drag ends.
 *  - `focusable: false` means we never steal keyboard focus. Do not call
 *    `win.focus()`: on macOS that would activate a dockless app and hide the
 *    window the user was actually typing into.
 */
import { BrowserWindow, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import {
  inkInset,
  overlayMetrics,
  type BoxSize,
  type OverlayMetrics,
  type Rect,
  type RectInset
} from '../core/geometry';
import { dragTargetRect } from '../core/interaction';
import type { BoxName, ModePayload } from './ipc';
import { CH } from './ipc';
import { clampToDisplays, defaultPosition, resolveStartPosition, savePosition } from './store';
import type { WalderStore } from './store';
import { vlog, warn } from './log';

const PRELOAD = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));

export interface Overlay {
  readonly win: BrowserWindow;
  /** Resize for a new sprite scale, keeping the bottom-left corner anchored. */
  applySize(scale: number): void;
  /** Apply the renderer's hit-test verdict. `inside` = cursor is on ink. */
  setInteractive(inside: boolean): void;
  /** Debug escape hatch: when on, the window never becomes click-through. */
  setForceInteractive(on: boolean): void;
  /** Escape hatch: put the dog back in the primary display's bottom-right corner. */
  resetPosition(): void;
  dragStart(): void;
  /** Cumulative cursor delta since `dragStart`, in screen pixels. */
  dragMove(dxScreen: number, dyScreen: number): void;
  dragEnd(): void;
  isDragging(): boolean;
  /** Current scale + sprite box, for `mode:set` and `settings:get`. */
  currentMode(): ModePayload;
  /** Send a main -> renderer message, ignoring a torn-down window. */
  send(channel: string, payload: unknown): void;
}

/**
 * Where the overlay page lives: the Vite dev server under `npm run dev`, the
 * bundled file otherwise. `WALDER_DEBUG=1` adds `?debug=1`, which makes the
 * renderer draw a one-pixel outline around the hit area.
 */
function pageUrl(): string {
  const query = process.env['WALDER_DEBUG'] === '1' ? '?debug=1' : '';
  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (devServer !== undefined && devServer !== '') return `${devServer}/overlay.html${query}`;
  return new URL(`../renderer/overlay.html${query}`, import.meta.url).href;
}

/**
 * Refuse in-window navigation away from the page we loaded. The renderer holds
 * the preload bridge, so replacing its document with remote content would hand
 * that bridge to whatever loaded.
 *
 * The blocked URL is dropped, not handed to the OS browser. There is no legitimate
 * link in this window — it draws a dog and has no text, let alone anchors — so a
 * navigation attempt is either a bug or a compromised renderer, and
 * `shell.openExternal` on a URL that a compromised renderer chose is a way out of
 * the sandbox and into whatever handles that scheme. Log it and stay put.
 */
function lockNavigation(win: BrowserWindow, allowedUrl: string): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.webContents.on('will-navigate', (event, url) => {
    if (url === allowedUrl) return;
    event.preventDefault();
    warn('blocked in-window navigation to', url);
  });
}

/**
 * Build the overlay window.
 *
 * `standBox` is the loaded sheet's own `stand` dimensions (`boxSize(sheet,
 * 'stand')`): the window is sized around it, so the art decides its size and no
 * dimension is hard-coded here.
 */
export function createOverlay(store: WalderStore, scale: number, standBox: BoxSize): Overlay {
  const metrics = overlayMetrics(scale, standBox);
  const start = resolveStartPosition(store, metrics.width, metrics.height, inkInset(metrics));

  const isMac = process.platform === 'darwin';

  const win = new BrowserWindow({
    x: start.x,
    y: start.y,
    width: metrics.width,
    height: metrics.height,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    // The window is moved with `setPosition` during a drag; `movable: false`
    // only blocks the OS's own window-drag affordances, which we do not want.
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    ...(isMac ? { type: 'panel' as const, roundedCorners: false } : {}),
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      // The animation loop must keep running while the window is occluded or
      // the app is in the background — that is the mascot's whole job.
      backgroundThrottling: false
    }
  });

  // 'screen-saver' is the highest normal level: it keeps the dog above other
  // always-on-top windows and above full-screen video.
  win.setAlwaysOnTop(true, 'screen-saver');
  if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setMenuBarVisibility(false);
  if (process.platform === 'win32') win.setSkipTaskbar(true);

  let ignoring = false;
  let forceInteractive = store.get('forceInteractive') === true;
  let dragging = false;
  let dragOrigin: Rect | null = null;
  let currentScale = scale;
  let currentMetrics: OverlayMetrics = metrics;

  /**
   * The inset for the *current* size. Every clamp in this file goes through it:
   * the window is mostly transparent, so clamping the window rect would happily
   * leave 24 px of empty padding on screen and the dog itself off it.
   */
  const currentInkInset = (): RectInset => inkInset(currentMetrics);
  // Only the standing box is used in M3; the sleeping box arrives with the
  // idle/away behaviour, which is what decides when to switch.
  const box: BoxName = 'stand';

  function setIgnore(next: boolean): void {
    if (next === ignoring) return;
    win.setIgnoreMouseEvents(next, { forward: true });
    ignoring = next;
    vlog('ignoreMouseEvents ->', next);
  }

  // Default state: clicks pass straight through to whatever is behind.
  setIgnore(!forceInteractive);
  vlog(
    `window created ${metrics.width}x${metrics.height} at (${start.x}, ${start.y}), scale ${scale}`
  );

  const url = pageUrl();
  lockNavigation(win, url);
  void win.loadURL(url);

  win.once('ready-to-show', () => {
    // `showInactive`, never `show`/`focus`: the dog must never take focus from
    // whatever the user is typing into.
    win.showInactive();
  });

  /** Re-clamp after a display change so the dog cannot end up on a dead screen. */
  function reclamp(): void {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    const clamped = clampToDisplays(b, currentInkInset());
    if (clamped.x !== b.x || clamped.y !== b.y) {
      win.setPosition(clamped.x, clamped.y);
      savePosition(store, { ...b, ...clamped });
      vlog('re-clamped after display change ->', clamped);
    }
  }

  const onDisplayChange = (): void => reclamp();
  screen.on('display-removed', onDisplayChange);
  screen.on('display-added', onDisplayChange);
  screen.on('display-metrics-changed', onDisplayChange);
  win.on('closed', () => {
    screen.removeListener('display-removed', onDisplayChange);
    screen.removeListener('display-added', onDisplayChange);
    screen.removeListener('display-metrics-changed', onDisplayChange);
  });

  const overlay: Overlay = {
    win,

    applySize(nextScale: number): void {
      if (win.isDestroyed()) return;
      const next = overlayMetrics(nextScale, standBox);
      const before = win.getBounds();
      // Anchor the bottom-left corner: the dog stands on the bottom edge, so
      // holding that edge still is what makes a size change look like the dog
      // growing rather than the window jumping.
      const target = {
        x: before.x,
        y: before.y + before.height - next.height,
        width: next.width,
        height: next.height
      };
      // Clamp against the *new* size's inset: the padding grows with the scale.
      const clamped = clampToDisplays(target, inkInset(next));

      // `resizable: false` makes some platforms refuse a programmatic resize, so
      // lift the flag for the duration of the call and put it straight back.
      const wasResizable = win.isResizable();
      if (!wasResizable) win.setResizable(true);
      win.setBounds({ ...target, ...clamped });
      if (!wasResizable) win.setResizable(false);

      currentScale = nextScale;
      currentMetrics = next;
      savePosition(store, { ...target, ...clamped });
      vlog(`applySize scale ${nextScale} -> ${next.width}x${next.height} at`, clamped);
    },

    setInteractive(inside: boolean): void {
      if (win.isDestroyed()) return;
      // Mid-drag the window slides under the cursor, so "not on ink" is
      // expected and must not end the drag.
      if (dragging) return;
      if (forceInteractive) {
        setIgnore(false);
        return;
      }
      setIgnore(!inside);
    },

    setForceInteractive(on: boolean): void {
      forceInteractive = on;
      if (win.isDestroyed()) return;

      // Turning it ON is unconditional — that is the whole point of the hatch,
      // and taking clicks everywhere is the safe direction.
      //
      // Turning it OFF must NOT go click-through here. The renderer knows where
      // the cursor is and we do not; `setIgnore(true)` would drop clicks on a
      // dog the cursor is sitting on until it crossed the outline again — which
      // is the exact bug the hatch exists to work around. So ask for a resync
      // and let the `hit:set` that comes back decide, through the normal path.
      if (on) setIgnore(false);
      overlay.send(CH.hitResync, {});
      vlog('forceInteractive ->', on);
    },

    resetPosition(): void {
      if (win.isDestroyed()) return;
      const b = win.getBounds();
      const spot = defaultPosition(b.width, b.height);
      win.setPosition(spot.x, spot.y);
      savePosition(store, { ...b, ...spot });
      vlog('reset position ->', spot);
    },

    dragStart(): void {
      if (win.isDestroyed()) return;
      dragging = true;
      dragOrigin = win.getBounds();
      vlog('drag start at', dragOrigin);
    },

    dragMove(dxScreen: number, dyScreen: number): void {
      if (win.isDestroyed() || !dragging || dragOrigin === null) return;
      // The delta is cumulative from the press, so this is absolute positioning
      // and a dropped message cannot make the window drift from the cursor.
      const target = dragTargetRect(dragOrigin, dxScreen, dyScreen);
      const clamped = clampToDisplays(target, currentInkInset());
      win.setPosition(clamped.x, clamped.y);
    },

    dragEnd(): void {
      if (!dragging) return;
      dragging = false;
      dragOrigin = null;
      if (win.isDestroyed()) return;
      savePosition(store, win.getBounds());
      vlog('drag end');
    },

    isDragging(): boolean {
      return dragging;
    },

    currentMode(): ModePayload {
      return { scale: currentScale, box };
    },

    send(channel: string, payload: unknown): void {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      try {
        win.webContents.send(channel, payload);
      } catch (error) {
        warn(`failed to send ${channel}:`, error);
      }
    }
  };

  win.webContents.on('render-process-gone', (_event, details) => {
    warn('renderer process gone:', details.reason);
  });

  return overlay;
}

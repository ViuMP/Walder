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
import { ART_FACING, facingFor, type Facing } from '../core/facing';
import {
  boxMetrics,
  bubbleExtraPx,
  inkInset,
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
  /**
   * Switch sprite box (`stand` <-> `sleep`) and resize the window to that box's
   * own metrics, keeping the bottom-left corner anchored. Sends `mode:set`, so
   * the renderer follows without a second call.
   */
  applyBox(box: BoxName): void;
  /**
   * A bubble of `columns` monospace columns is on screen, or `0` for none.
   *
   * Widens the window symmetrically so the text fits without being ellipsised,
   * and shrinks it straight back when the bubble clears. Idempotent: the same
   * column count twice is one resize.
   */
  applyBubble(columns: number): void;
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
  /** Current scale + sprite box + facing, for `mode:set` and `settings:get`. */
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

/** The sheet's own dimensions for both boxes, keyed by box name. */
export type BoxSizes = Readonly<Record<BoxName, BoxSize>>;

/**
 * Build the overlay window.
 *
 * `boxes` are the loaded sheet's own `stand` and `sleep` dimensions
 * (`boxSize(sheet, …)`): the window is sized around whichever box is showing,
 * so the art decides its size and no dimension is hard-coded here.
 */
export function createOverlay(store: WalderStore, scale: number, boxes: BoxSizes): Overlay {
  /**
   * The window size for a scale, a box and a bubble.
   *
   * Only the standing box normally reserves room for a speech bubble: Walder
   * never sleeps with something to say (a bark wakes him first), so the
   * sleeping window is exactly the curled-up dog plus its side padding. The
   * exception is a bubble that is *deliberately* shown while he stays asleep —
   * the `…zzz` a pet earns — and `columns > 0` is what says so.
   *
   * The widening is symmetric, so the dog does not move when a bubble appears.
   */
  const metricsFor = (
    nextScale: number,
    nextBox: BoxName,
    columns: number
  ): OverlayMetrics =>
    boxMetrics(
      nextScale,
      boxes[nextBox],
      nextBox === 'stand' || columns > 0,
      bubbleExtraPx(columns, nextScale, boxes[nextBox])
    );

  const metrics = metricsFor(scale, 'stand', 0);
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
  /** Which box is showing. Driven by the behaviour coordinator's `mode` events. */
  let box: BoxName = 'stand';
  /** Columns the bubble on screen needs, or `0` for no bubble. */
  let bubbleColumns = 0;
  /**
   * Which way the dog is looking. Starts at the art's own direction so the very
   * first `syncFacing()` below is the only thing that can turn him, and a dog on
   * the right half of the screen never sends a `facing:set` at all.
   */
  let facing: Facing = ART_FACING;

  /**
   * Send to the overlay's renderer, ignoring a torn-down window.
   *
   * `overlay.send` is this function; it exists separately because `syncFacing`
   * runs during window construction, before the `overlay` object literal below
   * has been evaluated.
   */
  function sendToRenderer(channel: string, payload: unknown): void {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    try {
      win.webContents.send(channel, payload);
    } catch (error) {
      warn(`failed to send ${channel}:`, error);
    }
  }

  /**
   * Re-decide which way the dog looks, and tell the renderer if it changed.
   *
   * Called from every place the window moves or is resized, because "which half
   * of which display is he on" is a function of the window rect and nothing else.
   * The display comes from `getDisplayNearestPoint` on the window's *centre* —
   * the same lookup `savePosition` uses, so a dog straddling two monitors is
   * always judged against the one the rest of him is on.
   *
   * Cheap enough to call on every drag message: two synchronous Electron reads
   * and a comparison, and the IPC send happens only on an actual change, which
   * during a drag across the middle of a screen is once.
   */
  function syncFacing(): void {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    const centre = {
      x: Math.round(b.x + b.width / 2),
      y: Math.round(b.y + b.height / 2)
    };
    const next = facingFor(centre.x, screen.getDisplayNearestPoint(centre).bounds, facing);
    if (next === facing) return;
    facing = next;
    sendToRenderer(CH.facingSet, { facing });
    vlog('facing ->', next);
  }

  function setIgnore(next: boolean): void {
    if (next === ignoring) return;
    win.setIgnoreMouseEvents(next, { forward: true });
    ignoring = next;
    vlog('ignoreMouseEvents ->', next);
  }

  // Default state: clicks pass straight through to whatever is behind.
  setIgnore(!forceInteractive);
  // Chokepoint 1 of 5: creation. The restored position may already be on the
  // left half of a display, and `currentMode()` has to carry the right answer
  // before the renderer's first paint — a dog who turns after one frame reads as
  // a glitch rather than as a decision.
  syncFacing();
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
    // Chokepoint 2 of 5, and unconditional: this also runs on
    // `display-metrics-changed`, where the window has not moved at all but the
    // display it sits on may have been resized around it — so the *centre* of
    // the screen moved and he is now on the other half of it.
    syncFacing();
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

  /**
   * Resize to a scale/box/bubble triple.
   *
   * The bottom edge is what the dog stands on, so holding it still is what makes
   * a size change (or a curl-up into the sleeping box) look like the dog
   * changing rather than the window jumping. The clamp uses the *new* metrics'
   * inset, because the padding, the bubble reserve and the bubble widening all
   * change with them.
   *
   * `centred` decides what happens horizontally. A scale change anchors the
   * left edge, as it always has — that is the size menu, and the dog growing
   * rightwards from where he stood reads correctly. A *bubble* change must
   * anchor the dog instead: the widening is symmetric, so the window's left edge
   * moves out by half of it and the sprite, which is centred in the window,
   * stays exactly where it was. Without this the dog jumped sideways on every
   * bark and back again twelve seconds later.
   */
  function resize(
    nextScale: number,
    nextBox: BoxName,
    nextColumns: number,
    centred = false
  ): void {
    if (win.isDestroyed()) return;
    const next = metricsFor(nextScale, nextBox, nextColumns);
    const before = win.getBounds();
    const dx = centred ? Math.round((next.width - before.width) / 2) : 0;
    const target = {
      x: before.x - dx,
      y: before.y + before.height - next.height,
      width: next.width,
      height: next.height
    };
    const clamped = clampToDisplays(target, inkInset(next));

    // `resizable: false` makes some platforms refuse a programmatic resize, so
    // lift the flag for the duration of the call and put it straight back.
    const wasResizable = win.isResizable();
    if (!wasResizable) win.setResizable(true);
    win.setBounds({ ...target, ...clamped });
    if (!wasResizable) win.setResizable(false);

    currentScale = nextScale;
    currentMetrics = next;
    bubbleColumns = nextColumns;
    // The bubble is transient, and its widening moves the window's left edge.
    // Remembering that as the dog's position would drift him half a bubble
    // every bark, so only a real (scale or box) resize is persisted.
    if (!centred) savePosition(store, { ...target, ...clamped });
    // Chokepoint 3 of 5. A resize moves the window's centre even when its
    // position is unchanged — a 3x dog is 216 px wide where a 1x dog was 72 —
    // and a clamp at a screen edge can move it further.
    syncFacing();
    vlog(`resize scale ${nextScale} box ${nextBox} -> ${next.width}x${next.height} at`, clamped);
  }

  const overlay: Overlay = {
    win,

    applySize(nextScale: number): void {
      resize(nextScale, box, bubbleColumns);
    },

    applyBox(nextBox: BoxName): void {
      if (nextBox === box) return;
      box = nextBox;
      resize(currentScale, nextBox, bubbleColumns);
      // The renderer picks its animation from the box, and `mode:set` is the one
      // message that carries it — sending it here means a box change is a single
      // call for every caller.
      overlay.send(CH.modeSet, overlay.currentMode());
    },

    applyBubble(columns: number): void {
      const next = Math.max(0, Math.floor(columns));
      if (next === bubbleColumns) return;
      // No `mode:set`: neither the scale nor the box changed, and the renderer
      // re-derives its layout from `window.innerWidth` on the resize event the
      // `setBounds` below produces.
      resize(currentScale, box, next, true);
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
      // Chokepoint 4 of 5: the escape hatch teleports him to the primary
      // display's bottom-right corner, which is the far side of the screen from
      // wherever he was.
      syncFacing();
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
      // Chokepoint 5 of 5, and the one the owner will actually see: dragging him
      // across the middle of the screen turns him, once, at the far edge of the
      // dead band. The renderer suppresses hit verdicts during a drag, so the
      // momentary mismatch between the cursor and the mirrored ink cannot drop it.
      syncFacing();
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
      return { scale: currentScale, box, facing };
    },

    send: sendToRenderer
  };

  win.webContents.on('render-process-gone', (_event, details) => {
    warn('renderer process gone:', details.reason);
  });

  return overlay;
}

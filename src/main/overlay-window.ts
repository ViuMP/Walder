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
 * polls; the state changes only when the renderer reports a crossing. The one
 * exception is not in this file: while the hover card is wanted, the panel's
 * watchdog asks `reportCursorIfOutside` every `HOVER_WATCH_INTERVAL_MS`, for
 * the leave Windows does not deliver (see that constant).
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
  drawnInkInset,
  restingRect,
  type BoxSize,
  type BubbleSite,
  type OverlayMetrics,
  type Rect,
  type RectInset
} from '../core/geometry';
import { cursorInWindow, cursorOffWindow, dragTargetRect } from '../core/interaction';
import type { BoxName, ModePayload } from './ipc';
import { CH } from './ipc';
import {
  clampInsideDisplays,
  clampToDisplays,
  defaultPosition,
  resolveStartPosition,
  savePosition
} from './store';
import type { WalderStore } from './store';
import { vlog, warn } from './log';

const PRELOAD = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));

/**
 * How long after `ready-to-show` `painted` settles even if the renderer never
 * says it has drawn the dog.
 *
 * `painted` gates the launch's hook offer, and the signal it now waits for is a
 * message from the renderer (`CH.overlayPainted`) — a message that a renderer
 * which failed before `getSettings`, was refused its settings, or lost the IPC
 * in a reload simply never sends. Without a ceiling the offer would wait
 * forever, and an offer that never comes is worse than one that comes a little
 * early: the `hooksOffered` flag is only written when it is made, so a lost
 * signal would quietly cost every launch its offer. Two seconds is several
 * times the ~0.45 s the 0.2.8 QA launch took from `ready-to-show` to the dog,
 * so a healthy renderer always beats it, and short enough that an owner whose
 * renderer is broken still gets the question while he is looking at the
 * screen.
 */
export const PAINT_SIGNAL_GRACE_MS = 2_000;

export interface Overlay {
  readonly win: BrowserWindow;
  /**
   * Settles once the renderer has drawn its first frame *with the dog in it*
   * (`notePainted`), at `ready-to-show` if presence says hidden by then, or
   * when the window closes first.
   *
   * What the launch's hook offer waits for (see `startHooks` in `index.ts`):
   * a question about a dog nobody can see yet is a dialog from nowhere.
   *
   * It used to settle at `ready-to-show`, and that is too early. That event is
   * the page's first paint, which can be an empty transparent canvas: the dog
   * is drawn only after `settings:get` has carried the sprite sheet across. On
   * the 0.2.8 QA launch the offer was logged at .139, the alert was on screen
   * at .460 and the dog only at .596. Only the renderer can say when it has
   * drawn him, so the preload says it, from `getSettings` (see
   * `CH.overlayPainted`).
   *
   * A dog who is hidden at `ready-to-show` is the exception, kept from the old
   * rule: nobody is going to see him either way, and his owner must still be
   * asked, so there is nothing worth waiting for. And it never waits forever:
   * `PAINT_SIGNAL_GRACE_MS` after `ready-to-show` it settles regardless, for a
   * renderer whose signal is lost. Never rejects, and `closed`
   * settles it too, so nothing awaiting it can hang on a window that died
   * before its first frame — or whose renderer never got far enough to draw.
   */
  readonly painted: Promise<void>;
  /**
   * The renderer has drawn its first frame with the sheet: settle `painted`.
   * Called by the IPC bridge on `CH.overlayPainted`; idempotent, since a
   * reload paints a first frame again and the promise can only settle once.
   */
  notePainted(): void;
  /** Resize for a new sprite scale, keeping the bottom-left corner anchored. */
  applySize(scale: number): void;
  /**
   * Switch sprite box and resize the window to that box's
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
  /**
   * Show or hide the whole window — the hide-when-idle mode (`core/behaviour`).
   *
   * `showInactive`, never `show`/`focus`: the same rule as `ready-to-show`
   * below, and it matters more here because this can fire while the owner is
   * typing. Idempotent, so a repeated call is not a repeated window operation.
   *
   * Safe to call before the page is ready: the intent is remembered and
   * `ready-to-show` honours it, which is what keeps a Walder that starts hidden
   * from flashing on screen for one frame at launch.
   */
  setVisible(shown: boolean): void;
  /**
   * Turn still mode on or off (tray ▸ **Still mode**).
   *
   * Resends `mode:set` the way `applyBox` does, because `mode` is the one
   * message that carries the flag — there is no `still:set` channel, and adding
   * one would be a second way for main and the renderer to disagree about a
   * boolean that already rides on every mode payload.
   */
  setStill(on: boolean): void;
  /** Push the persisted threshold-bark preference to the overlay. */
  setBarkSound(on: boolean): void;
  /**
   * Should the window be on screen? The *intent*, not `win.isVisible()` — which
   * is still false in the moment between construction and `ready-to-show`.
   */
  isShown(): boolean;
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
  /**
   * Current scale, sprite box, facing and presence, for `mode:set` and `settings:get`.
   *
   * Presence is on it because a `visible` scene event is an edge that a renderer
   * which was not yet loaded can miss entirely — see `ModePayload.hidden`.
   */
  currentMode(): ModePayload;
  /**
   * One tick of the hover card's watchdog (`HoverPanelOptions.cursorLeft`):
   * if the cursor is outside this window, send the renderer where it is
   * (`CH.hoverCursor`), which it turns into a leave — `hit:set false`, then
   * `hover:leave` and the card comes down — and answer `true`, so the watch
   * stops. `true` too for a destroyed window, which has nothing left to
   * watch. `false`, sending nothing, while the cursor is inside the window,
   * where the renderer's own pointer events are the truth, and mid-drag,
   * where the drag owns the pointer.
   */
  reportCursorIfOutside(): boolean;
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

/** The sheet's required boxes, plus optional posture art. */
export type BoxSizes = Readonly<{
  stand: BoxSize;
  sleep: BoxSize;
  lie?: BoxSize;
  lie_down?: BoxSize;
}>;

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
   * `site` is where he stands, so a dog hanging off a screen edge is widened
   * until the part of the window that is on screen holds the bubble
   * (`bubbleExtraPx` has the 0.2.8 numbers); omitted, the whole window counts.
   */
  const metricsFor = (
    nextScale: number,
    nextBox: BoxName,
    columns: number,
    site?: BubbleSite
  ): OverlayMetrics => {
    const boxSize = boxes[nextBox] ?? boxes.stand;
    return boxMetrics(
      nextScale,
      boxSize,
      nextBox === 'stand' || columns > 0,
      bubbleExtraPx(columns, nextScale, boxSize, site)
    );
  };

  /**
   * The scale factor of the display a window rect is on: the one the renderer
   * will draw him at once the window is there. `getDisplayMatching` answers the
   * display the rect overlaps most, which is the one Windows takes a window's
   * DPI from. A display that reports no usable factor counts as 1 —
   * `drawnInkInset` sanitises it through `usableDpr`.
   */
  const dprAt = (rect: Rect): number => screen.getDisplayMatching(rect).scaleFactor;

  /**
   * The ink inset of a window laid out with `m` for `boxName` at `inkScale`, on
   * a display at `dpr` — the *drawn* ink (`drawnInkInset`), which is what every
   * clamp, the start position and the strict "wholly on screen" test in this
   * file measure. At a fractional scale factor the renderer draws the dog at a
   * whole number of device pixels per sprite pixel, up to 20 % larger or
   * smaller than his nominal box, and the nominal inset let 18 physical px of a
   * 125 % Medium dog hang off the right edge after Size ▸ Medium at the default
   * corner. At dpr 1 it is the nominal inset, unchanged.
   */
  const inkInsetFor = (
    m: OverlayMetrics,
    inkScale: number,
    boxName: BoxName,
    dpr: number
  ): RectInset =>
    drawnInkInset({
      metrics: m,
      scale: inkScale,
      box: boxes[boxName] ?? boxes.stand,
      standBox: boxes.stand,
      dpr
    });

  const metrics = metricsFor(scale, 'stand', 0);
  // The scale factor is that of the display the *saved* point lands on, so the
  // inset is asked for per candidate rect rather than computed up front.
  const start = resolveStartPosition(store, metrics.width, metrics.height, (rect) =>
    inkInsetFor(metrics, scale, 'stand', dprAt(rect))
  );

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
   * The box `currentMetrics` were laid out for. Not `box` below: `applyBox`
   * sets that *before* it resizes, and the drawn ink of the window still on
   * screen is the old box's — its width is part of the inset (`drawnInkInset`).
   */
  let metricsBox: BoxName = 'stand';
  /**
   * The scale factor the dog was last placed at. `reclamp` compares it with the
   * display's factor after a display change, to tell a scale change — which
   * changes the size he is drawn at — from one that leaves his size alone.
   */
  let placedDpr = dprAt({ ...start, width: metrics.width, height: metrics.height });

  /**
   * The inset for the *current* size and box, on the display of `at` — where
   * the window is about to go. Every clamp in this file goes through it or
   * `inkInsetFor`: the window is mostly transparent, so clamping the window rect
   * would happily leave 24 px of empty padding on screen and the dog itself off
   * it.
   */
  const currentInkInset = (at: Rect): RectInset =>
    inkInsetFor(currentMetrics, currentScale, metricsBox, dprAt(at));

  /**
   * The only way this file persists a position. Startup reads the saved point
   * back as the *standing* window's top-left, so whatever box or bubble the
   * window is showing right now is translated to that first (`restingRect`).
   * Every caller must hand it a rect laid out with `currentMetrics` — `resize`
   * updates them before it saves for exactly that reason.
   */
  const remember = (rect: Rect): void =>
    savePosition(store, restingRect(rect, currentMetrics, metricsFor(currentScale, 'stand', 0)));
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
   * Still mode, as the tray last set it. Held here rather than read from the
   * store on every `currentMode()` because this is the value the renderer is
   * believed to have: one flag, written by `setStill` and by nothing else, so
   * the `mode:set` a box change sends cannot contradict the one still mode sent.
   */
  let still = false;

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
   * Called from every place the window moves or is resized, because "which side
   * of the main display is he on" is a function of the window rect and nothing
   * else.
   *
   * **He faces the *primary* display's centre, not the centre of whichever
   * screen he is standing on** (Victor, 2026-09-21). It used to be
   * `getDisplayNearestPoint`, which is defensible with one monitor and wrong
   * with two: parked on the right-hand edge of the left-hand screen, he turned
   * away from the main display to look at the empty half of the monitor he
   * happened to be on — away from the owner, who is looking at the main one.
   * A dog dragged anywhere on any screen now turns towards where the work is.
   * The dead band in `facingFor` is untouched, so a dog near the middle still
   * does not flip on a one-pixel drag.
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
    const next = facingFor(centre.x, screen.getPrimaryDisplay().bounds, facing);
    if (next === facing) return;
    facing = next;
    sendToRenderer(CH.facingSet, { facing });
    vlog('facing ->', next);
  }

  /**
   * Tell the renderer where the cursor is in a window about to sit at `rect`.
   *
   * Every move or resize this file makes happens under a cursor that has not
   * moved, so the renderer gets no pointer event for it and its cached point is
   * left stale by however far the window's corner went — the reason a pet that
   * cleared a bark brought the hover card down (`HoverCursorPayload` in
   * `core/interaction` has the 0.2.8 numbers). Main is the side that knows both
   * the cursor's screen position and the new bounds, so it converts and sends.
   *
   * Sent *before* the window op, against the rect being asked for: the resize
   * reaches the renderer on a channel of its own, and the point has to be there
   * when it lands, or the paint that follows the `resize` event re-tests the
   * stale point first and the card blinks once. The renderer holds the point
   * until its viewport is the size it was measured for, so arriving early is
   * safe and arriving late is not.
   *
   * Not during a drag: the drag's own pointer events are the truth then, and
   * the window is moving under the cursor on purpose (see the file header).
   */
  function sendCursor(rect: Rect): void {
    if (dragging || win.isDestroyed()) return;
    sendToRenderer(CH.hoverCursor, cursorInWindow(screen.getCursorScreenPoint(), rect));
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

  /**
   * Presence: what the behaviour coordinator wants, and whether the page is far
   * enough along to act on it.
   *
   * Two flags rather than one, because `setVisible` can be called before the
   * first paint — the coordinator's very first batch carries `visible:false`
   * when the owner has the hide-when-idle mode on — and `showInactive()` on a
   * window that has not rendered shows an empty transparent rectangle. So the
   * intent is recorded and `ready-to-show` consults it.
   */
  let wantShown = true;
  let ready = false;
  let markPainted: () => void = () => undefined;
  const painted = new Promise<void>((resolve) => {
    markPainted = resolve;
  });
  win.once('closed', () => markPainted());

  win.once('ready-to-show', () => {
    ready = true;
    // The ceiling on waiting for the renderer's signal; see
    // `PAINT_SIGNAL_GRACE_MS`. Not cleared when the signal wins: settling a
    // settled promise is a no-op, and a two-second timer is not worth a handle.
    setTimeout(markPainted, PAINT_SIGNAL_GRACE_MS);
    // A dog who is meant to be hidden must not appear for a single frame at
    // launch: that flash is the whole reason `wantShown` is checked here rather
    // than hiding the window again immediately afterwards.
    if (!wantShown) {
      vlog('ready-to-show while presence says hidden; staying off screen');
      // Settled here, not left to `notePainted`: an unseen dog has no first
      // frame worth waiting for, and the hook offer must still be asked. See
      // `Overlay.painted`.
      markPainted();
      return;
    }
    // `showInactive`, never `show`/`focus`: the dog must never take focus from
    // whatever the user is typing into.
    win.showInactive();
  });

  /**
   * Re-clamp after a display change so the dog cannot end up on a dead screen.
   *
   * Measured with the scale factor the display has *now*: the
   * `display-metrics-changed` a scale change (Settings ▸ Display ▸ Scale)
   * raises changes how large the renderer draws him, and with it his drawn ink
   * (`drawnInkInset`), so the inset the window was last clamped with is stale.
   *
   * **Which rule.** The drag rule (reachable is enough) as before, with one
   * exception: when the scale factor changed and his drawn ink was wholly on
   * screen at the old one, it must be wholly on screen at the new one. That is
   * the size-change rule of `resize` — he grew where he stood, nobody parked
   * him across the edge — and without it 100 % → 125 % at Medium in the default
   * corner, where Size ▸ Medium had settled his ink flush with the right edge,
   * left the 14 px a side he grew by hanging off it. A dog the owner parked half
   * off an edge was not wholly on screen at the old factor, so he keeps the
   * drag rule he was parked under, as he does on a box change. A display change
   * that leaves the factor alone (a monitor unplugged, a taskbar moved) is
   * exactly what it was.
   */
  function reclamp(): void {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    const dpr = dprAt(b);
    const insideAt = (factor: number): boolean => {
      const held = clampInsideDisplays(
        b,
        inkInsetFor(currentMetrics, currentScale, metricsBox, factor)
      );
      return held.x === b.x && held.y === b.y;
    };
    const rescaled = dpr !== placedDpr && insideAt(placedDpr);
    const settle = rescaled ? clampInsideDisplays : clampToDisplays;
    const clamped = settle(b, inkInsetFor(currentMetrics, currentScale, metricsBox, dpr));
    placedDpr = dpr;
    if (clamped.x !== b.x || clamped.y !== b.y) {
      sendCursor({ ...b, ...clamped });
      win.setPosition(clamped.x, clamped.y);
      remember({ ...b, ...clamped });
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
   *
   * "Anchors the left edge" means the *resting* left edge — the dog's, not the
   * window's. With a bubble up the window's left edge sits `bubbleExtra` left
   * of it, and the widening is a different width at every scale, so keeping
   * `before.x` as it stood put the new window at old rest − old extra; the
   * save then added back the *new* extra and the dog (and the stored x)
   * drifted by the difference on every size change mid-bark (0.2.8 QA:
   * 1324 → 1319 → 1335 → 1365 across Small/Medium/Large). So the
   * non-centred shift is the change in widening: the target's left edge is
   * rest − next extra, and `remember` lands back on the same rest.
   *
   * **Two clamps, one per path (Windows QA, row 3.3).** A size or box change
   * keeps those anchors only while there is room for them: the dog has to end
   * up *wholly* on the work area (`clampInsideDisplays`), not merely reachable.
   * The reachability clamp is the drag rule — the owner parked him half off an
   * edge on purpose — and under it Small → Large at the default bottom-right
   * spot ran the window to x 2102 on a 1920 px screen with only his head left
   * on it. So the non-centred path settles the resting rect inside first, on
   * the new box laid out as if fully on screen (the ink does not depend on the
   * bubble widening: the widening is transparent and symmetric), and only then
   * measures the widening from where he actually landed — measuring it from
   * the pre-clamp spot would widen for a dog hanging off an edge he no longer
   * hangs off.
   *
   * The centred path (a bubble appearing or clearing) keeps the drag rule. The
   * dog's ink does not change on a bubble change — the widening is symmetric
   * and the reserve, where one is added, grows upwards from a bottom that does
   * not move — so the only thing the strict clamp could do there is move a dog
   * the owner deliberately parked half off an edge, on a bark, and back again
   * twelve seconds later. That is exactly the jump this path exists to avoid;
   * the bubble already lays itself out in the room on screen (`bubbleExtraPx`'s
   * `site`, `onScreenSpan`).
   *
   * **A box change of a parked dog keeps the drag rule too.** A box change is
   * not something the owner picks — it is him curling up for a fullscreen app
   * or lying down at a high weekly figure — and for a dog the owner dragged
   * half off an edge, the strict clamp would hop him fully onto the screen the
   * first time he fell asleep, and store that, undoing the placement row 2.2
   * promises to respect. So the rule is "a resize never takes him off the
   * screen", not "a resize always puts him on it": a box change of a dog who
   * was wholly on screen keeps him wholly on screen (the sleep box at the
   * default corner included), a box change of a dog who was not keeps the
   * reachability rule he was parked under, and a *size* change — the menu
   * pick row 3.3 is about, which grows him by up to three times — always ends
   * with him wholly on screen.
   */
  function resize(
    nextScale: number,
    nextBox: BoxName,
    nextColumns: number,
    centred = false
  ): void {
    if (win.isDestroyed()) return;
    const before = win.getBounds();
    // The resting left edge is the anchor of every path below, so it is also
    // where the widening measures the room on screen from — and the display he
    // stands on is the one whose scale factor sizes his drawn ink, before and
    // after (`inkInsetFor`).
    const display = screen.getDisplayMatching(before);
    const area = display.workArea;
    const dpr = display.scaleFactor;
    const whollyOnScreen = (() => {
      const held = clampInsideDisplays(
        before,
        inkInsetFor(currentMetrics, currentScale, metricsBox, dpr)
      );
      return held.x === before.x && held.y === before.y;
    })();
    const strict = !centred && (nextScale !== currentScale || whollyOnScreen);
    const settle = strict ? clampInsideDisplays : clampToDisplays;
    let restX = before.x + currentMetrics.bubbleExtra;
    let bottom = before.y + before.height;
    if (!centred) {
      const probe = metricsFor(nextScale, nextBox, nextColumns);
      const inside = settle(
        {
          x: restX - probe.bubbleExtra,
          y: bottom - probe.height,
          width: probe.width,
          height: probe.height
        },
        inkInsetFor(probe, nextScale, nextBox, dpr)
      );
      restX = inside.x + probe.bubbleExtra;
      bottom = inside.y + probe.height;
    }
    const next = metricsFor(nextScale, nextBox, nextColumns, {
      restX,
      areaX: area.x,
      areaWidth: area.width
    });
    const target = {
      x: centred ? before.x - Math.round((next.width - before.width) / 2) : restX - next.bubbleExtra,
      y: bottom - next.height,
      width: next.width,
      height: next.height
    };
    // A no-op on the non-centred path, whose ink was settled above and is the
    // same ink at the measured widening; kept so that path can never be looser
    // than its rule if `metricsFor` ever lets the widening move the ink.
    const clamped = settle(target, inkInsetFor(next, nextScale, nextBox, dpr));

    // `resizable: false` makes some platforms refuse a programmatic resize, so
    // lift the flag for the duration of the call and put it straight back.
    const wasResizable = win.isResizable();
    if (!wasResizable) win.setResizable(true);
    sendCursor({ ...target, ...clamped });
    win.setBounds({ ...target, ...clamped });
    if (!wasResizable) win.setResizable(false);

    currentScale = nextScale;
    currentMetrics = next;
    metricsBox = nextBox;
    placedDpr = dprAt({ ...target, ...clamped });
    bubbleColumns = nextColumns;
    // The bubble is transient, and its widening moves the window's left edge.
    // Remembering that as the dog's position would drift him half a bubble
    // every bark, so only a real (scale or box) resize is persisted.
    if (!centred) remember({ ...target, ...clamped });
    // Chokepoint 3 of 5. A resize moves the window's centre even when its
    // position is unchanged — a 3x dog is 216 px wide where a 1x dog was 72 —
    // and a clamp at a screen edge can move it further.
    syncFacing();
    vlog(`resize scale ${nextScale} box ${nextBox} -> ${next.width}x${next.height} at`, clamped);
  }

  const overlay: Overlay = {
    win,
    painted,

    notePainted(): void {
      markPainted();
    },

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
      // `setBounds` below produces — and from `window.screenX` whenever that
      // catches up, which can be after the resize (`watchBubblePlacement`).
      resize(currentScale, box, next, true);
    },

    setVisible(shown: boolean): void {
      if (shown === wantShown) return;
      wantShown = shown;
      if (win.isDestroyed()) return;
      // Before the first paint there is nothing to show; `ready-to-show` reads
      // `wantShown` and does the right thing when it arrives.
      if (!ready) {
        vlog('presence ->', shown, '(before ready-to-show)');
        return;
      }
      if (shown) win.showInactive();
      else win.hide();
      vlog('presence ->', shown);
    },

    setStill(on: boolean): void {
      if (on === still) return;
      still = on;
      overlay.send(CH.modeSet, overlay.currentMode());
      vlog('stillMode ->', on);
    },

    setBarkSound(on: boolean): void {
      sendToRenderer(CH.barkSoundSet, { barkSound: on });
      vlog('barkSound ->', on);
    },

    isShown(): boolean {
      return wantShown;
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
      // The home corner is where the *resting* window goes — standing, no
      // bubble — because that is the window he spends his time in and the one
      // a fresh install puts there. It used to be computed for `b`, which with
      // a bubble up is the widened window: the 98 px box landed 16 px from the
      // edge, and when the bubble cleared it narrowed about its centre to 88 px
      // at 21 px from the edge (Windows QA, row 2.4). The same held for a reset
      // while asleep, whose shorter, narrower box is not the window he wakes
      // into. So the spot is computed for the resting rect, and the current
      // window is placed so that its resting rect — `restingRect`, inverted:
      // the widening added back on the left, the bottom kept — is at it.
      const rest = metricsFor(currentScale, 'stand', 0);
      const spot = defaultPosition(rest.width, rest.height);
      const placed = {
        x: spot.x - currentMetrics.bubbleExtra,
        y: spot.y + rest.height - b.height
      };
      sendCursor({ ...b, ...placed });
      win.setPosition(placed.x, placed.y);
      placedDpr = dprAt({ ...b, ...placed });
      remember({ ...b, ...placed });
      // Chokepoint 4 of 5: the escape hatch teleports him to the primary
      // display's bottom-right corner, which is the far side of the screen from
      // wherever he was.
      syncFacing();
      vlog('reset position ->', spot, 'window at', placed);
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
      // Measured on the display he is being dragged onto, whose scale factor is
      // the one he will be drawn at there.
      const clamped = clampToDisplays(target, currentInkInset(target));
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
      const dropped = win.getBounds();
      placedDpr = dprAt(dropped);
      remember(dropped);
      vlog('drag end');
    },

    isDragging(): boolean {
      return dragging;
    },

    currentMode(): ModePayload {
      // `wantShown`, not `win.isVisible()`: the intent is the truth here, and it
      // is already correct in the window between construction and
      // `ready-to-show` — which is precisely when a renderer booting into a
      // hidden dog asks for it.
      return { scale: currentScale, box, facing, hidden: !wantShown, still };
    },

    reportCursorIfOutside(): boolean {
      if (win.isDestroyed()) return true;
      if (dragging) return false;
      // The same reading `sendCursor` makes, against the bounds as they are
      // now, so the renderer handles it on the path it already has.
      const reading = cursorInWindow(screen.getCursorScreenPoint(), win.getBounds());
      if (!cursorOffWindow(reading)) return false;
      vlog('hover watchdog: cursor outside the window with no leave heard; resyncing');
      sendToRenderer(CH.hoverCursor, reading);
      return true;
    },

    send: sendToRenderer
  };

  win.webContents.on('render-process-gone', (_event, details) => {
    warn('renderer process gone:', details.reason);
  });

  return overlay;
}

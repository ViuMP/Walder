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
 * and it goes back to ignoring them as soon as the cursor leaves. The clicks
 * flag changes only when the renderer reports a crossing. Two things poll: the
 * forward gate (`watchForward`, Windows and macOS), which keeps the forward on
 * only while the cursor is in his own column of the window, and, while the
 * hover card is wanted, the panel's watchdog, which asks
 * `reportCursorIfOutside` every `HOVER_WATCH_INTERVAL_MS` for the leave
 * Windows does not deliver (see that constant).
 *
 * Consequences worth knowing before changing anything in this file:
 *  - While click-through, `mousedown` never reaches the renderer. A click on the
 *    dog therefore always arrives *after* a `hit:set true` for the same pixel.
 *  - During a drag the window moves under a stationary cursor, so the cursor can
 *    end up over transparent pixels. Going click-through then would drop the drag
 *    on the floor, so hit updates are suppressed until the drag ends.
 *  - **He is never outside the screen** (owner, 2026-11-16): all of his ink is
 *    on the displays' work areas, whichever way his position was set. Every
 *    placement in this file goes through `insideFor`; a new one must too. A
 *    consequence for drags: held at a screen edge he stays there while the
 *    pointer goes on, so mid-drag the cursor is routinely outside the window —
 *    the renderer's pointer capture is what keeps the moves and the release
 *    coming (and `dragShouldEnd` is the way out if the release is lost anyway).
 *  - Nothing listens for the window moving or resizing, and nothing may: every
 *    correction here answers something outside (the owner, the behaviour, a
 *    display event, a show, a wake), never the window system's own answer to a
 *    call this file made. That is what keeps a correction from looping at a
 *    display scale where Windows grants bounds a DIP or two off the ones asked.
 *  - `focusable: false` means we never steal keyboard focus. Do not call
 *    `win.focus()`: on macOS that would activate a dockless app and hide the
 *    window the user was actually typing into.
 */
import { BrowserWindow, screen } from 'electron';
import { ART_FACING, facingFor, type Facing } from '../core/facing';
import {
  BUBBLE_SIDE_HOLD_PX,
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
import {
  CLICK_SLOP_PX,
  cursorDistanceOutside,
  cursorInWindow,
  cursorOffWindow,
  dragTargetRect,
  FORWARD_MARGIN_PX,
  forwardWatchDelay
} from '../core/interaction';
import {
  SIZE_BLANK_GRACE_MS,
  acceptsBlankReport,
  endsSettling,
  parseSizeReport,
  resizedMessage,
  sizeRequest,
  type PendingSize,
  type SettlingSize,
  type SizeChangeMessage
} from '../core/size-change';
import type { BoxName, ModePayload } from './ipc';
import { CH } from './ipc';
import { clampInsideDisplays, defaultPosition, resolveStartPosition, savePosition } from './store';
import type { WalderStore } from './store';
import { MAX_RENDERER_RELOADS } from './hover-panel';
import { vlog, warn } from './log';
import { PRELOAD, lockNavigation, pageUrl } from './window-page';
import { language } from '../core/strings';

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

/** What `createOverlay` can be told beyond the store, the scale and the art. */
export interface OverlayOptions {
  /**
   * The platform whose Size change waits for a blank picture,
   * `process.platform` by default. `'win32'` and, since 2026-11-17,
   * `'darwin'` wait (`applySize`, `flushSizeChange`). It decides nothing else
   * here but the forward gate, which runs on the same two (`watchForward`) —
   * the window's own platform options still read `process.platform` — and it
   * is a parameter so the tests can drive the waiting path from any
   * host and pin that Linux resizes at once, sends nothing and registers no
   * handler.
   */
  readonly platform?: NodeJS.Platform;
}

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
  /**
   * Resize for a new sprite scale, keeping the bottom edge and, horizontally,
   * the resting window's edge on the side of the screen he stands on.
   *
   * **On Windows and macOS the resize is deferred** while he is on screen: this call
   * only asks the renderer for a blank picture, and the window is resized when
   * that is up or `SIZE_BLANK_GRACE_MS` later (`flushSizeChange` in
   * `createOverlay`, `core/size-change` for why). Until then the bounds, the
   * saved position and `currentMode()` are all still the old size's, and
   * consistent with each other; a caller that sends `mode:set` straight after
   * this, as the tray does, sends the old scale, and the new one follows with
   * the resize. Everywhere else, and on those two before the window is shown
   * or while it is hidden, it has resized by the time it returns.
   */
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
  /**
   * Check that all of him is inside the screen where he stands now, and move
   * him the shortest way back if not (owner, 2026-11-16: never outside it).
   *
   * For the moments his position can have gone stale with no event of this
   * window's own to say so: the machine waking from sleep or being unlocked,
   * when the displays may have been rearranged, re-scaled or lost a taskbar
   * while nobody was listening. The display events, `ready-to-show` and a
   * `setVisible(true)` already do the same thing themselves. Nothing at all —
   * no window call, no save — when he is inside, which is nearly always; never
   * throws.
   */
  revalidatePosition(): void;
  /**
   * The boxes for another coat (`sheetBoxes`): the same sizes, but Yuna's
   * clamp margin is not the dog's (`coatInkMargin`). Then the same check as
   * `revalidatePosition`, so a cat chosen while the dog is at a top edge comes
   * down to where her bubble has its lines.
   */
  setBoxes(next: BoxSizes): void;
  dragStart(): void;
  /**
   * Cumulative cursor delta since `dragStart`, in screen pixels. He follows it
   * once the press has travelled `CLICK_SLOP_PX` (under it, a pet, he stays
   * put), and only as far as the screen goes: past an edge he slides along it,
   * all of him still inside (`dragMove` in `createOverlay`).
   */
  dragMove(dxScreen: number, dyScreen: number): void;
  /**
   * The release: where he is is checked once more against the screen, his side
   * of it decided, and the spot saved.
   */
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
  /**
   * Tell the renderer where the cursor is now (`CH.hoverCursor`), against the
   * bounds as they are, so it re-derives hover from the real point with no
   * pointer event. For the moment the dog's menu closes (QA row 3.17): on
   * Windows the renderer reported `hover:leave` about 30 ms after `menu:open`
   * although the cursor never moved, and nothing but a real mouse move brought
   * the hover back. Why is inferred, not traced (the menu window opening
   * under the pointer, most likely a `mouseleave`); the reading is right
   * whichever it was. A no-op in the renderer when its hover already agrees
   * with the reading. Nothing mid-drag (the drag owns the pointer), for a
   * destroyed window, or while he is hidden.
   */
  resyncCursor(): void;
  /**
   * Order the dog above the hover card, which the card's own `showInactive`
   * has just put above him (owner, 2026-11-14, audit X2): both windows sit at
   * the 'screen-saver' level, where the last one ordered in draws on top, so at
   * Small the card covered the first word of a bark. `moveTop` re-orders without
   * focusing or activating anything. Nothing while he is hidden: on macOS an
   * order-above brings an ordered-out window back on screen, and the hide-when-
   * idle mode and a hidden window must stay hidden.
   */
  orderAboveCard(): void;
  /**
   * The bounds of the display he stands on: matched on his own column of the
   * window, not the held window, which can overlap a neighbour more. What the
   * fullscreen watch asks.
   */
  standingDisplay(): Rect;
  /** Send a main -> renderer message, ignoring a torn-down window. */
  send(channel: string, payload: unknown): void;
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
export function createOverlay(
  store: WalderStore,
  scale: number,
  boxes: BoxSizes,
  options: OverlayOptions = {}
): Overlay {
  // Windows since 2026-11-16, macOS since 2026-11-17 (`core/size-change`).
  const platform = options.platform ?? process.platform;
  const hidesSizeChange = platform === 'win32' || platform === 'darwin';
  /**
   * The *resting* metrics for a scale, a box and a bubble: the window as it
   * would be with no side hold. What the saved position, home, the launch
   * spot, his ink and every anchor are reckoned in; the window itself is laid
   * out with `windowFor`.
   *
   * Every box but the sleeping one reserves room for a speech bubble: Walder
   * never sleeps with something to say (a bark wakes him first), so the
   * sleeping window is exactly the curled-up dog plus its side padding. The
   * exception is a bubble that is *deliberately* shown while he stays asleep —
   * the `…zzz` a pet earns — and `columns > 0` is what says so. The lie boxes
   * reserve it always, since a bark can play over them (`core/behaviour`), so
   * a bark there changes no height either (owner, 2026-11-20).
   *
   * The widening is symmetric, so the dog does not move when a bubble appears.
   * `site` is where he stands: near a screen edge the widened window hangs off
   * it (only his ink has to be inside the screen), so it is widened until the
   * part of the window that is on screen holds the bubble (`bubbleExtraPx` has
   * the 0.2.8 numbers); omitted, the whole window counts.
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
      nextBox !== 'sleep' || columns > 0,
      bubbleExtraPx(columns, nextScale, boxSize, site)
    );
  };
  /**
   * The window's own metrics: `metricsFor` with at least `BUBBLE_SIDE_HOLD_PX`
   * a side, so a bark that fits the hold makes no window call (`applyBubble`;
   * Mac and Windows QA 5.9i, owner 2026-11-20). Only the window is laid out
   * with these; the hold is the same at every scale, so it cancels out of
   * every resting reckoning that `metricsFor` still does.
   */
  const windowFor = (
    nextScale: number,
    nextBox: BoxName,
    columns: number,
    site?: BubbleSite
  ): OverlayMetrics => {
    const boxSize = boxes[nextBox] ?? boxes.stand;
    return boxMetrics(
      nextScale,
      boxSize,
      nextBox !== 'sleep' || columns > 0,
      Math.max(BUBBLE_SIDE_HOLD_PX, bubbleExtraPx(columns, nextScale, boxSize, site))
    );
  };

  /**
   * The display he stands on, for a window rect laid out with `m`: matched on
   * his own column of it, the side widening (the hold, or a bubble's) taken
   * off. Matched on the whole held window, a dog flush with the top of a
   * display beside one that reaches higher was put on the neighbour, whose
   * overlap the 432 px of hold won (review 2026-11-20): a Size round trip came
   * back 43 px lower, or across the seam. Only the matching narrows; the work
   * areas and the clamp are the same.
   */
  const columnOf = (rect: Rect, m: OverlayMetrics): Rect => ({
    ...rect,
    x: rect.x + m.bubbleExtra,
    width: rect.width - 2 * m.bubbleExtra
  });
  const displayOf = (rect: Rect, m: OverlayMetrics) => screen.getDisplayMatching(columnOf(rect, m));
  /**
   * The scale factor of the display he stands on (`displayOf`): the one the
   * renderer draws him at once the window is there, wherever the window is
   * mostly on that display. The OS takes a window's DPI from the display the
   * *whole* window overlaps most, so where the held window overlaps a
   * neighbour more (a dog flush with a top edge beside a display reaching
   * higher) Windows may draw him at the neighbour's scale while this reckons
   * his own: not seen on screen (OPEN_ITEMS, QA 5.9i). A display that reports no usable factor counts as 1 —
   * `drawnInkInset` sanitises it through `usableDpr`.
   */
  const dprAt = (rect: Rect, m: OverlayMetrics): number => displayOf(rect, m).scaleFactor;

  /**
   * The ink inset of a window laid out with `m` for `boxName` at `inkScale`, on
   * a display at `dpr` — the *drawn* ink (`drawnInkInset`), which is what every
   * clamp in this file and the start position measure (through `inkInsetOf`).
   * At a fractional scale factor the renderer draws the dog at a
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

  /**
   * The ink inset of the window rect `rect`, laid out with `m`: his drawn ink
   * on the display the rect is on, **in a window of the rect's own size**.
   *
   * A rect this file asks for is exactly `m.width` x `m.height`, and this is
   * `inkInsetFor`. A rect read back from the window need not be: at a
   * fractional scale factor Windows grants a DIP or two more than was asked
   * (measured on the QA machine at 125 %: 1–2 DIP of height; the cause of the
   * drift that comes with it is a hypothesis, stated at `moveTo`, and is not
   * this function's to cure).
   * The renderer lays him out in the window it actually has — feet on its
   * floor, centred in its width — so that is the size the layout is run in
   * here too (`DrawnInkInput.view`): the renderer's own arithmetic, not the
   * metrics' inset with the surplus added on. The two differ exactly where it
   * matters. A box drawn *taller* than its window (asleep or lying at a
   * fractional scale factor: 125 % Medium asleep is drawn 139.2 tall in 116)
   * is clipped by it, and in a window granted taller the extra rows are dog,
   * not air: his visible top is still the window's top. Until 2026-11-17 the
   * surplus was added to the top inset unconditionally, and a correction at a
   * top edge left his head above it by the surplus (review of that date).
   * Reckoned from `spriteLayout`'s anchoring rule, not measured on screen.
   *
   * The bottom inset is 0 either way, so his feet are measured at the granted
   * window's floor — that is what holds them on a bottom edge. It is right for
   * a rect that *is* the window, as read back, and that is what it is used
   * for: to decide whether he is inside where he stands (`reclamp`, the drop,
   * the grant check in `resize`). Where he is then *moved to* is another
   * matter when the window is not the size that was asked: the move restates
   * the asked size (`moveTo`) and what the window will be afterwards is not
   * known, so that is measured for both (`settleFor`), as a drag's target is
   * (`insideHeld`).
   */
  const inkInsetOf = (
    rect: Rect,
    m: OverlayMetrics,
    inkScale: number,
    boxName: BoxName
  ): RectInset =>
    drawnInkInset({
      metrics: m,
      scale: inkScale,
      box: boxes[boxName] ?? boxes.stand,
      standBox: boxes.stand,
      dpr: dprAt(rect, m),
      view: rect
    });

  /**
   * **The one rule for where he may be (owner, 2026-11-16): inside the
   * screen, no exceptions.** The position nearest to `rect` at which all of
   * his drawn ink, for a window laid out with `m`, lies on the displays' work
   * areas — clear of the taskbar, the Dock and the menu bar; across the seam
   * between two displays if both cover him; never over space that is on no
   * display (`clampRectInsideWorkAreas` in `core/geometry` has the geometry
   * and the two honest fallbacks: no displays reported, and ink larger than
   * every work area). `rect` itself when he is inside already.
   *
   * Every path that sets his position, or on which it can have gone stale,
   * goes through this: the launch (`resolveStartPosition`), `ready-to-show`, a
   * drag on every move and at the drop, Reset, every `resize` (size, box,
   * bubble, and the deferred Windows size change, which is `resize` run
   * later), the display events, `setVisible(true)` and a wake
   * (`revalidatePosition`). It replaced two rules: a lenient one for drags,
   * the launch and display changes (24 px of him reachable; QA row 2.2 as it
   * was) and this strict one for size and box changes only.
   *
   * The inset is asked for where he lands, not where he was: his drawn ink
   * depends on the scale factor of the display he ends up on.
   *
   * **Why this cannot fight the window system.** It is a pure function of the
   * rect and the work areas, and a position it answers it answers again, so
   * asking twice moves nothing. And nothing in this file asks because the
   * window moved — there is no `move`, `moved` or `resize` listener on the
   * window, and none may be added — only because the owner, the behaviour, a
   * display event, a show or a wake did something. Each of those makes at most
   * two `setBounds`: one that resizes and one that moves (`moveTo`).
   */
  const insideFor = (
    rect: Rect,
    m: OverlayMetrics,
    inkScale: number,
    boxName: BoxName
  ): { x: number; y: number } =>
    clampInsideDisplays(rect, (at) => inkInsetOf(at, m, inkScale, boxName));

  // The saved point is the *resting* window's top-left (`remember`), so it is
  // resolved in resting metrics and the window, held wider, is put around it:
  // a position saved by a build without the hold lands him on the same pixel.
  const launchRest = metricsFor(scale, 'stand', 0);
  const metrics = windowFor(scale, 'stand', 0);
  // The scale factor is that of the display the *saved* point lands on, so the
  // inset is asked for per candidate rect rather than computed up front. The
  // store clamps with it, strictly: he starts inside the screen.
  const startRest = resolveStartPosition(store, launchRest.width, launchRest.height, (rect) =>
    inkInsetOf(rect, launchRest, scale, 'stand')
  );
  const start = { x: startRest.x - metrics.bubbleExtra, y: startRest.y };

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
    // The window is moved by this file during a drag (`moveTo`); `movable:
    // false` only blocks the OS's own window-drag affordances, which we do not
    // want.
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

  /**
   * The size main last **asked** the window to be: the constructor's, then
   * whatever `resize` last passed to `setBounds`. Never a size read back from
   * the window. Every move restates it (`moveTo`).
   */
  let askedSize = { width: metrics.width, height: metrics.height };
  /**
   * The whole rect of the last window call this file made (the constructor's,
   * a `resize`, a `moveTo`). Only `dragMove` reads it, and only to tell "I
   * have asked exactly this already" from "this has not been asked yet" when
   * the window is where the pointer wants it but not the size asked for.
   */
  let lastAsked: Rect = { ...start, ...askedSize };

  /**
   * **The only way this file moves the window**: the position, and with it the
   * size main last asked for, in one `setBounds`. Never `setPosition`.
   *
   * Why. On Windows at 125 % the window grew on every step of a drag (Small:
   * 110 x 150 physical px to 847 x 708 within one drag, measured on screen,
   * and the same on code from before the inside-the-screen rule), and a drag
   * is the one place this file called `setPosition` once per pointer event.
   * The hypothesis — **not confirmed on screen; only a run at 125 % can
   * confirm or refute it** — is that `setPosition` is itself a round trip.
   * Electron implements it as `SetBounds(Rect(position, GetSize()))`: the
   * size is the one the window *reports*. On Windows that report is the
   * physical rect turned into DIPs by Chromium's `ScreenWin::ScreenToDIPRect`,
   * whose size is `gfx::ScaleToEnclosingRect` of the rect *at its screen
   * origin*. Where the physical origin is not a multiple of the scale the
   * enclosing rect is a DIP wider and taller than the window: Small, 110 px
   * wide at x 101 px, is 80.8 to 168.8 DIP, enclosed by 80 to 169 — 89 DIP
   * for a window asked to be 88. `SetBounds` turns those 89 DIP back into
   * physical pixels (enclosing again, at least 112 px), so every move keeps
   * what the last read added and the next read adds to it. At 100 % both
   * conversions are exact, which fits "nothing like it at 100 %". (The
   * Electron and Chromium code paths are recalled from their sources, not
   * checked against Electron 45 as shipped here; the QA probe
   * `Walder-qa/2026-11-18-win/tools/probe-grow` is the on-screen check: 40
   * `setPosition` and then 40 `setBounds` moves of an 88 x 120 window, each
   * read back.) Restating the size that was *asked*
   * takes the read-back out of the move: what the window gets then depends
   * on where it is and on nothing before, so the rounding has nothing to
   * accumulate in.
   *
   * If it is not the cause, this is still one window call per move, and
   * everything that held him inside the screen under a window granted larger
   * than asked is still here and still tested (the read-back in `resize`,
   * `insideHeld`'s largest-seen size in `dragMove`, `inkInsetOf` at the
   * drop, a Reset and a re-clamp). That it is then no worse than
   * `setPosition` was is expected, not verified.
   *
   * On every platform, not only Windows. Where the window keeps the size it
   * was asked to have — expected of macOS, Linux and Windows at 100 % — the
   * rect passed here is the one the window already has but for its position,
   * so it should be the same move as `setPosition` was. **Not checked on
   * screen on any of the three since this change**; the first run at 100 %
   * is that check for Windows.
   *
   * The non-resizable flag is not lifted as `resize` lifts it: nothing is
   * being resized unless the window has drifted from the size asked, and this
   * runs once per pointer event. What a platform does with a `setBounds` on
   * a non-resizable window whose size it would have to change — restore the
   * size, keep the old one and move, or refuse the call altogether — has not
   * been observed. Only the last would be worse than `setPosition`: a window
   * that did not follow the pointer, which the on-screen run would show at
   * once.
   */
  function moveTo(x: number, y: number): void {
    lastAsked = { x, y, width: askedSize.width, height: askedSize.height };
    win.setBounds(lastAsked);
  }

  /**
   * Where a correcting move puts a window that was read back as `live` and
   * found not inside (`reclamp`, the drop, the grant check in `resize`), or
   * that is being placed afresh (Reset): the top-left to hand `moveTo`.
   *
   * A window that is the size that was asked is simply the rule, measured in
   * that size (`insideFor`). One that is not — larger, at 125 % — is about to
   * be asked for the asked size again by the very move that corrects it, and
   * which size it has afterwards is not known: the one asked, if restating it
   * works, or the larger one again, if the system grants that whatever is
   * asked (it did after a resize, measured). The two put his ink in different
   * rows: his feet are on the window's floor. So he is placed where he is
   * inside under both (`insideEitherSize`, over the larger of the two sizes
   * each way) — the same choice a drag makes on every move.
   *
   * The price is flushness, never the rule: if the window keeps its surplus
   * he ends that much short of a top edge and half the surplus in width short
   * of a side edge, and if it gives the surplus up, that much short of the
   * bottom edge. A DIP or two under the grant that was measured. Reckoned and
   * pinned in the tests under both outcomes; neither seen on screen yet.
   */
  const settleFor = (
    live: Rect,
    m: OverlayMetrics,
    inkScale: number,
    boxName: BoxName
  ): { x: number; y: number } => {
    if (live.width === askedSize.width && live.height === askedSize.height) {
      return insideFor(live, m, inkScale, boxName);
    }
    return insideEitherSize(
      {
        ...live,
        width: Math.max(live.width, askedSize.width),
        height: Math.max(live.height, askedSize.height)
      },
      m,
      inkScale,
      boxName
    );
  };

  let ignoring = false;
  let forceInteractive = store.get('forceInteractive') === true;
  let dragging = false;
  let dragOrigin: Rect | null = null;
  /**
   * Has this press changed his place, at any point? With `dragTravel`, what
   * `dragEnd` asks before it re-decides his side of the screen
   * (`decideAnchor`).
   */
  let dragMoved = false;
  /**
   * The furthest the pointer has been from where this press landed, in screen
   * pixels, straight-line: the renderer's own measure (`dragTo` in
   * `core/interaction`), kept here from the same deltas. Under
   * `CLICK_SLOP_PX` the release is a pet, and `dragMove` does not move the
   * window (a dead zone). The renderer still sends every pointer move of a
   * press, so main does the slop check. A pet decides no side and saves no
   * position.
   */
  let dragTravel = 0;
  let currentScale = scale;
  let currentMetrics: OverlayMetrics = metrics;
  /**
   * The box `currentMetrics` were laid out for. Not `box` below: `applyBox`
   * sets that *before* it resizes, and the drawn ink of the window still on
   * screen is the old box's — its width is part of the inset (`drawnInkInset`).
   */
  let metricsBox: BoxName = 'stand';
  /**
   * Is he on the right half of the work area he stands on? Decides which edge
   * of his resting window a size change keeps (`resize`), unless he is flush
   * with a side (`flushSide`).
   */
  const onRightHalf = (rect: Rect, m: OverlayMetrics): boolean => {
    const area = displayOf(rect, m).workArea;
    return rect.x + rect.width / 2 > area.x + area.width / 2;
  };
  /**
   * Which edge a size change keeps: the right one on the right half of the
   * screen, the left one on the left (owner, 2026-11-14, audit X1). Decided
   * where the dog is *put* — at launch, on a drop, a Reset, or a display change
   * that moves him sideways or onto another display (`reclamp`)
   * — and not at each size change, because growing from one edge moves his
   * centre: decided per resize, a dog within half the growth of the middle
   * grew from one edge and shrank back to the other, and a round trip no
   * longer came home. ponytail: not persisted, so a relaunch between two size
   * changes of a dog standing across the middle decides afresh from where he
   * is; store it beside the position if that is ever reported.
   */
  let anchorRight = onRightHalf(
    { ...start, width: metrics.width, height: metrics.height },
    metrics
  );
  /**
   * Is he on the top half of the work area he stands on? The vertical twin of
   * `onRightHalf`, decided at the same moments (`decideAnchor`).
   */
  const onTopHalf = (rect: Rect, m: OverlayMetrics): boolean => {
    const area = displayOf(rect, m).workArea;
    return rect.y + rect.height / 2 < area.y + area.height / 2;
  };
  /**
   * Which edge a size change keeps vertically: his feet on the bottom half, the
   * top of his ink on the top half (RECHECK 2026-11-18, d — the X1 fix turned
   * on its side). Keeping his feet at a top edge grew his head past it, the
   * clamp pushed him down, and the shrink kept the pushed feet: Small → Large
   * → Small ended 144 pt lower. The top of his *ink*, as the clamp measures it
   * (`inkInsetFor`), not the window's: the bubble reserve above it changes
   * with the scale, so keeping the window's top would still clamp a Large dog
   * shrunk at the edge. Not persisted, like `anchorRight`.
   */
  let anchorTop = onTopHalf({ ...start, width: metrics.width, height: metrics.height }, metrics);
  /**
   * The display `anchorRight` was decided on. A display change that moves him
   * straight up or down on the same display keeps his side (`reclamp`); one
   * that lands him on another display decides it afresh, and this is how the
   * two are told apart when the display he stood on is no longer there to ask.
   */
  let anchorDisplayId = displayOf(
    { ...start, width: metrics.width, height: metrics.height },
    metrics
  ).id;
  /**
   * Is his ink, in the window `rect` laid out with `m` for `boxName` at the
   * current scale, flush with a side
   * of the screen — within a pixel of a left or right edge the clamp would
   * stop him at? Asked of the clamp itself: his ink nudged 2 px outwards is
   * moved back. So a seam between two displays that both cover him is not a
   * side (he may stand across it), and where the neighbour covers only part of
   * his height it is. Measured at each scale change, not decided with
   * `anchorRight`: flush is a fact of where he stands now, which a launch, a
   * drag, a display change or a box change's clamp can each make true, and
   * kept true by the size change it governs, so it needs no state of its own.
   */
  const flushSide = (rect: Rect, m: OverlayMetrics, boxName: BoxName): 'left' | 'right' | null => {
    const inset = inkInsetOf(rect, m, currentScale, boxName);
    const ink = {
      x: rect.x + (inset.left ?? 0),
      y: rect.y + (inset.top ?? 0),
      width: rect.width - (inset.left ?? 0) - (inset.right ?? 0),
      height: rect.height - (inset.top ?? 0) - (inset.bottom ?? 0)
    };
    // Which way the clamp moves it, not only whether: ink that already hangs
    // past a right side (the standing ink of a dog asleep near it) is pulled
    // left from either nudge, and is still at the right side.
    const moved = (dx: number): number => clampInsideDisplays({ ...ink, x: ink.x + dx }).x - (ink.x + dx);
    if (moved(-2) > 0) return 'left';
    return moved(2) < 0 ? 'right' : null;
  };
  /** Decide his side of the screen from where he has just been put. */
  const decideAnchor = (rect: Rect): void => {
    anchorRight = onRightHalf(rect, currentMetrics);
    anchorTop = onTopHalf(rect, currentMetrics);
    anchorDisplayId = displayOf(rect, currentMetrics).id;
  };

  /**
   * `insideFor` for the window as it is now: the current size, box and bubble.
   * Every clamp of a rect that keeps the current layout goes through it — the
   * window is mostly transparent, so clamping the window rect instead would
   * keep empty padding on screen and say nothing about the dog.
   */
  const insideNow = (rect: Rect): { x: number; y: number } =>
    insideFor(rect, currentMetrics, currentScale, metricsBox);
  /**
   * `insideFor` for a rect whose size is not known to be the one the window
   * will have: his head and sides are measured as in a window of the metrics'
   * own size and his feet at the floor of the rect given (`inkInsetOf`, which
   * lays him out in the rect's real size, is for a rect read back from the
   * window), so the ink measured is every row and column he could be drawn in
   * at any size from the one to the other.
   */
  const insideEitherSize = (
    rect: Rect,
    m: OverlayMetrics,
    inkScale: number,
    boxName: BoxName
  ): { x: number; y: number } =>
    clampInsideDisplays(rect, (at) => inkInsetFor(m, inkScale, boxName, dprAt(at, m)));
  /**
   * `insideEitherSize` for the window as it is laid out now: a drag's target,
   * which `dragMove` lays out as large as the window has been during the
   * drag. `dragMove` has why, and what it costs.
   */
  const insideHeld = (rect: Rect): { x: number; y: number } =>
    insideEitherSize(rect, currentMetrics, currentScale, metricsBox);

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
    // Taking clicks means the cursor is on him, in his column: the leave that
    // follows is forwarded at once, not a gate tick later.
    if (!next) forwarding = true;
    win.setIgnoreMouseEvents(next, { forward: forwarding });
    ignoring = next;
    vlog('ignoreMouseEvents ->', next);
  }

  /**
   * **The forward gate** (Windows QA of the side hold, 2026-11-20). With
   * `forward: true` the OS hands the renderer every mouse move over the whole
   * window, and the 216 px side hold made the window six times wider than the
   * dog: circling the pointer beside him cost 12.5 % of a core against 3.7 %
   * before the hold. A move off the ink sends nothing and paints nothing in the
   * renderer (`hoverMove` notifies only on a change); the cost is the delivery
   * itself — main to renderer, the event dispatch, the frame it wakes — so the
   * only cut is fewer moves. Ink is only ever in his own column (`columnOf`,
   * the window as it was before the hold, give or take `FORWARD_MARGIN_PX`), so
   * the forward is on only while the cursor is in it, read every
   * `forwardWatchDelay`: the moves the renderer
   * hears are the ones it heard before the hold. Turning it on under a cursor
   * that may not move again sends the renderer the reading (`sendCursor`), so
   * a cursor already on ink is entered at the tick, not at the next wiggle.
   * Only while ignoring: on ink, mid-drag and under `forceInteractive` the
   * window takes the mouse itself. Not on Linux, where Electron forwards
   * nothing.
   */
  let forwarding = true;
  let forwardTimer: ReturnType<typeof setTimeout> | null = null;
  const gatesForward = platform === 'win32' || platform === 'darwin';

  function watchForward(): void {
    forwardTimer = null;
    if (win.isDestroyed() || !wantShown) return;
    const bounds = win.getBounds();
    const away = cursorDistanceOutside(
      screen.getCursorScreenPoint(),
      columnOf(bounds, currentMetrics)
    );
    const near = away <= FORWARD_MARGIN_PX;
    if (ignoring && near !== forwarding) {
      forwarding = near;
      win.setIgnoreMouseEvents(true, { forward: forwarding });
      vlog('forward mouse moves ->', forwarding);
      if (forwarding) sendCursor(bounds);
    }
    forwardTimer = setTimeout(watchForward, forwardWatchDelay(away));
  }

  /** Start the gate when he is shown; a tick now, so the first one is not a delay away. */
  function armForwardWatch(): void {
    if (gatesForward && forwardTimer === null) watchForward();
  }

  function stopForwardWatch(): void {
    if (forwardTimer !== null) clearTimeout(forwardTimer);
    forwardTimer = null;
  }
  win.on('closed', stopForwardWatch);

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

  // `WALDER_DEBUG=1` adds `?debug=1`, which makes the renderer draw a
  // one-pixel outline around the hit area.
  // The boot-time language, not the stored setting: every window agrees until the restart.
  const url = pageUrl(
    'overlay.html',
    `?lang=${language()}${process.env['WALDER_DEBUG'] === '1' ? '&debug=1' : ''}`
  );
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
    // Before he is seen for the first time, and whether or not he is about to
    // be: the constructor was handed a position that was inside the screen,
    // but the window system places the window, and the displays can have
    // changed in the time the page took to load. Nothing when he is inside.
    safeReclamp();
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
    armForwardWatch();
  });

  /**
   * Put him back inside the screen if where he stands no longer is — after a
   * display was added, removed, rearranged, re-scaled or given a different
   * work area (a taskbar shown, hidden or moved; the Dock resized), and from
   * the other moments his position can have gone stale: `ready-to-show`,
   * `setVisible(true)` and a wake (`revalidatePosition`). Shown or hidden, a
   * Size change waiting or not: the state is one consistent size either way.
   *
   * **Always the one rule** (`insideFor`; owner, 2026-11-16). Until then this
   * used the lenient drag rule, with the strict one only when the scale factor
   * had changed under a dog who was wholly on screen before it. A dog parked
   * half off an edge no longer exists, so there is nothing left to tell apart.
   * Measured with the scale factor the display has *now*: the
   * `display-metrics-changed` a scale change (Settings ▸ Display ▸ Scale)
   * raises changes how large the renderer draws him, and with it his drawn ink
   * (`drawnInkInset`) — 100 % → 125 % at Medium with his ink flush with the
   * right edge leaves the 14 px a side he grew by hanging off it until this
   * moves him.
   *
   * **No displays at all** — a transient state while they are reconfigured —
   * and nothing is done, not even the facing: there is no screen to measure
   * against, and the `display-*` event that follows the reconfiguration runs
   * this again. (What Electron's `screen` answers in that state has not been
   * observed here; that is the reason for not asking it anything.)
   *
   * **Inside already is nothing**: no window call, no save, no new decision
   * about his side. So a `display-metrics-changed` that leaves him where he
   * is (2026-11-14, audit X1 review: the Dock or menu bar resizing the work
   * area) cannot flip the side of a dog grown across the middle and break
   * Small → Large → Small.
   *
   * **Moved** — one `moveTo`, then the save, in that order, so a settings
   * file that cannot be written costs the saved spot and not the correction.
   * It is saved under the display he landed on; the entry of a display that
   * was unplugged is not touched, so he goes back there on a replug at launch.
   * His side is decided afresh only when the move had a horizontal part or
   * took him to another display. A nudge straight up — the taskbar appearing
   * under him, or the bottom edge taking back a DIP of the 125 % drift — is
   * not the owner putting him somewhere, and re-deciding on it would break the
   * same round trip.
   */
  function reclamp(): void {
    if (win.isDestroyed()) return;
    if (screen.getAllDisplays().length === 0) return;
    const b = win.getBounds();
    const inside = insideNow(b);
    if (inside.x !== b.x || inside.y !== b.y) {
      // Whether he is inside was asked of the window as it is; where he goes
      // allows for the size the move may leave it (`settleFor`).
      const q = settleFor(b, currentMetrics, currentScale, metricsBox);
      const moved = { ...b, ...q };
      if (q.x !== b.x || displayOf(moved, currentMetrics).id !== anchorDisplayId) {
        decideAnchor(moved);
      }
      sendCursor(moved);
      moveTo(q.x, q.y);
      vlog('moved back inside the screen ->', q);
      remember(moved);
    }
    // Chokepoint 2 of 5, and unconditional: this also runs on
    // `display-metrics-changed`, where the window has not moved at all but the
    // display it sits on may have been resized around it — so the *centre* of
    // the screen moved and he is now on the other half of it.
    syncFacing();
  }

  /**
   * `reclamp` for callers nothing above would catch a throw for: a screen
   * event, a window event, a power event. The save inside it throws when the
   * settings file cannot be written; by then he has been moved, so all that
   * is lost is the saved spot — and the next launch computes the same
   * correction from the stale one.
   */
  function safeReclamp(): void {
    try {
      reclamp();
    } catch (error) {
      warn('overlay: could not finish moving him back inside the screen:', error);
      // The save is `reclamp`'s last step but one; the facing it settles last
      // is settled here instead, as `flushSizeChange` does for `resize`.
      syncFacing();
    }
  }

  const onDisplayChange = (): void => safeReclamp();
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
   * changing rather than the window jumping — on the bottom half of the screen.
   * On the top half a *scale* change keeps the top of his ink instead
   * (`anchorTop`), so a dog at a top edge grows downwards and a round trip
   * comes home (RECHECK 2026-11-18, d). The clamp uses the *new* metrics'
   * inset, because the padding, the bubble reserve and the bubble widening all
   * change with them.
   *
   * `centred` decides what happens horizontally. A scale change anchors the
   * resting window's left edge on the left half of the screen and its right
   * edge on the right half (`anchorRight`), so he grows away from the nearer
   * side. It used to be the left edge everywhere, and at the home corner that
   * grew him off the right edge, the clamp pulled him back, and the shrink kept
   * the left edge he had been pulled to: Small → Large → Small left him 136 pt
   * left of home (owner, 2026-11-14, audit X1). The window's edge, not his
   * ink's: the home corner is `EDGE_MARGIN` from the window's edge at every
   * size (`defaultPosition`), so keeping that edge carries the home spot of one
   * size onto the home spot of the next, exactly, and a Reset at any size
   * followed by any size change is still home. **Flush with a side** of the
   * screen (`flushSide`: his ink within a pixel of a left or right edge of the
   * work areas, not a seam) a scale change keeps his *ink's* edge on that side
   * instead (owner, 2026-11-20): his side inset grows with the size, so keeping
   * the window's edge put a shrunk dog's ink past the side, the clamp pulled
   * him in, and the grow kept the pulled-in edge — Large → Small → Large at the
   * left edge ended 16 px in. Asleep, the narrower box he fell asleep in where
   * he stood flush is short of a right side, so there the ink he will stand in
   * is asked as well, and its edge kept. Home is `EDGE_MARGIN` in, never flush, so it is
   * untouched. A dog nearer a side than that growth but not flush is still
   * pulled flush by the shrink and stays flush. A box change keeps the left
   * edge everywhere, as before: it is the edge `restingRect` and
   * `resetPosition` keep between boxes, so the window he wakes into and the
   * spot that is saved stay the same thing. A *bubble* change — only one
   * wider than the side hold reaches here since 2026-11-20 (`applyBubble`) —
   * must anchor the dog instead: the widening is symmetric, so the window's left edge
   * moves out by half of it and the sprite, which is centred in the window,
   * stays exactly where it was. Without this the dog jumped sideways on every
   * bark and back again twelve seconds later.
   *
   * "Anchors the left edge" means the *resting* left edge — the dog's, not the
   * window's. The window's left edge sits `bubbleExtra` left of it (the side
   * hold, `windowFor`, or more for a bubble wider than it), and the widening
   * is a different width at every scale for a bubble past the hold, so keeping
   * `before.x` as it stood put the new window at old rest − old extra; the
   * save then added back the *new* extra and the dog (and the stored x)
   * drifted by the difference on every size change mid-bark (0.2.8 QA:
   * 1324 → 1319 → 1335 → 1365 across Small/Medium/Large). So the
   * non-centred shift is the change in widening: the target's left edge is
   * rest − next extra, and `remember` lands back on the same rest.
   *
   * **Inside the screen, on every path (owner, 2026-11-16).** The anchors
   * above hold only while there is room for them: whatever the change, all of
   * his ink ends up on the work areas (`insideFor`). Where it already would,
   * the clamp answers the position it was given and the anchors decide; where
   * it would not, he is moved the shortest way — left at the right edge, up at
   * the bottom. The case that asked for this first was Windows QA row 3.3:
   * Small → Large at the default bottom-right spot ran the window to x 2102 on
   * a 1920 px screen with only his head left on it.
   *
   * Until 2026-11-16 that held for a size change only, and for a box change of
   * a dog who was wholly on screen; a bubble, and a box change of a dog the
   * owner had dragged half off an edge, kept the lenient drag rule, so that a
   * bark or a curl-up would not hop a deliberately parked dog back on screen.
   * Nobody is parked off an edge any more, so there is nothing left for a
   * second rule to protect. For a dog who is inside, a bubble changes nothing
   * about his ink — the widening is symmetric and transparent, and the reserve,
   * where one is added, grows upwards from a bottom that does not move — so on
   * that path the clamp is the no-op it has to be: he must not move when he
   * barks. (One case does move him, once: asleep hard against the top of a
   * work area at a fractional scale factor where he is drawn taller than his
   * window, a `…zzz` gives the window the rows the top of him was clipped by,
   * and those rows have to be on screen too — 24 px down at 125 % Medium, and
   * he stays there when the bubble clears. Reckoned from `drawnInkInset` and
   * pinned in the tests, not seen on screen.)
   *
   * The non-centred path settles the resting rect inside first, on the new
   * box laid out as if fully on screen (the ink does not depend on the bubble
   * widening), and only then measures the widening from where he actually
   * landed and on the display he landed on — measuring it from the pre-clamp
   * spot would widen for an edge he no longer stands at.
   *
   * **What the window is granted (the one second call).** At a fractional
   * scale factor Windows gives the window a DIP or two more than was asked
   * (measured at 125 %: height, with the window drifting down 1–3 DIP per
   * resize; the cause is not established — `moveTo` has the hypothesis). His
   * feet are on the floor of the window he actually has, so at the bottom
   * edge of a work area a granted surplus puts them past it. So the bounds
   * are read back **once**; if they are not the ones asked for, they are
   * checked against the rule with the real size (`inkInsetOf`), and if he is
   * not inside he is moved, once, with `moveTo` — which restates the size
   * just asked for. Nothing is read again after that: whatever the second
   * call is granted waits for the next thing that happens. Two `setBounds` at
   * most per call of this function, by construction, so it cannot chase the
   * window system. Where the grant is exact — every other scale factor
   * measured, and macOS — the read is the whole cost.
   *
   * This does not cure that drift and is not meant to hide it. Away from an
   * edge a surplus the window is *read back* with is carried down by the next
   * resize exactly as before (`bottom` below is the granted window's), and he
   * sinks by it; the rule only says where that has to stop. What `moveTo`
   * removes is the surplus a move added; whether any is left at 125 % with no
   * `setPosition` in the file has not been seen on screen.
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
    // where the widening measures the room on screen from.
    let restX = before.x + currentMetrics.bubbleExtra;
    let bottom = before.y + before.height;
    // Where he will be standing, for the display whose work area that room is
    // measured on: where he is, unless this change moves him.
    let standing: Rect = before;
    let standingMetrics = currentMetrics;
    if (!centred) {
      // Flush with a side of the screen, a scale change keeps that side of his
      // ink (owner, 2026-11-20); elsewhere the standing window's edge (X1).
      // Flush as he is drawn, or, asleep in the narrower box, flush as he will
      // stand when he wakes (he fell asleep where he stood flush): that ink's edge.
      let flush: { side: 'left' | 'right'; from: BoxName; to: BoxName } | null = null;
      if (nextScale !== currentScale) {
        const shown = flushSide(before, currentMetrics, metricsBox);
        if (shown !== null) {
          flush = { side: shown, from: metricsBox, to: nextBox };
        } else {
          const stand = metricsFor(currentScale, 'stand', 0);
          const woken = flushSide(restingRect(before, currentMetrics, stand), stand, 'stand');
          if (woken !== null) flush = { side: woken, from: 'stand', to: 'stand' };
        }
      }
      if (flush !== null) {
        const { side, from, to } = flush;
        const dpr = dprAt(before, currentMetrics);
        // His ink's edge on that side, from the resting window's left edge.
        const inkEdge = (s: number, boxName: BoxName): number => {
          const m = metricsFor(s, boxName, 0);
          const inset = inkInsetFor(m, s, boxName, dpr);
          return side === 'left' ? (inset.left ?? 0) : m.width - (inset.right ?? 0);
        };
        restX += inkEdge(currentScale, from) - inkEdge(nextScale, to);
      } else if (anchorRight) {
        // Keep the standing window's right edge: zero for a box change, which
        // keeps the scale.
        restX += metricsFor(currentScale, 'stand', 0).width - metricsFor(nextScale, 'stand', 0).width;
      }
      // Keep the top of his ink in the box he is showing (`anchorTop`), so a
      // dog asleep or lying at a top edge stays flush: zero for a box change too.
      if (anchorTop) {
        const dpr = dprAt(before, currentMetrics);
        const inkHeight = (s: number): number => {
          const m = metricsFor(s, metricsBox, 0);
          return m.height - (inkInsetFor(m, s, metricsBox, dpr).top ?? 0);
        };
        bottom += inkHeight(nextScale) - inkHeight(currentScale);
      }
      // Every reckoning above and the probe are in resting metrics (no side
      // hold): the hold is the same at every scale, so it would cancel anyway,
      // and only `next` below, the window itself, carries it (`windowFor`).
      const probe = metricsFor(nextScale, nextBox, nextColumns);
      const probed = {
        x: restX - probe.bubbleExtra,
        y: bottom - probe.height,
        width: probe.width,
        height: probe.height
      };
      const inside = insideFor(probed, probe, nextScale, nextBox);
      restX = inside.x + probe.bubbleExtra;
      bottom = inside.y + probe.height;
      standing = { ...probed, ...inside };
      standingMetrics = probe;
    }
    const area = displayOf(standing, standingMetrics).workArea;
    const next = windowFor(nextScale, nextBox, nextColumns, {
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
    // On the non-centred path the ink was settled above and is the same ink at
    // the measured widening, so this answers `target`; on the centred one it
    // is the rule itself, and answers `target` for every dog who was inside.
    const asked = { ...target, ...insideFor(target, next, nextScale, nextBox) };

    // `resizable: false` makes some platforms refuse a programmatic resize, so
    // lift the flag for the duration of the call and put it straight back.
    const wasResizable = win.isResizable();
    if (!wasResizable) win.setResizable(true);
    sendCursor(asked);
    // Remembered before the call, as the size every later move restates.
    askedSize = { width: asked.width, height: asked.height };
    lastAsked = asked;
    win.setBounds(asked);
    if (!wasResizable) win.setResizable(false);

    // The one read-back, and the one correction it may lead to (see above).
    // `placed` is the rect the rest of this function reasons about: the size
    // that was asked for — what the metrics, the saved spot and a drag in
    // progress are all laid out in — at the top-left he really has.
    let placed: Rect = asked;
    const granted = win.getBounds();
    if (
      granted.x !== asked.x ||
      granted.y !== asked.y ||
      granted.width !== asked.width ||
      granted.height !== asked.height
    ) {
      const inside = insideFor(granted, next, nextScale, nextBox);
      if (inside.x !== granted.x || inside.y !== granted.y) {
        const held = settleFor(granted, next, nextScale, nextBox);
        sendCursor({ ...granted, ...held });
        moveTo(held.x, held.y);
        placed = { ...asked, ...held };
        vlog('resize: the window was granted', granted, 'and moved back inside ->', held);
      }
    }

    // Mid-drag, rebase the drag's origin by the move this resize made and give
    // it the new size (2026-11-13 audit, M2). `dragMove` positions absolutely
    // from the origin, so a bubble arriving or clearing under a held dog made
    // him jump by the widening on the next move, and the clamp then measured an
    // old-width rect against the new ink inset.
    if (dragOrigin !== null) {
      dragOrigin = {
        x: dragOrigin.x + placed.x - before.x,
        y: dragOrigin.y + placed.y - before.y,
        width: placed.width,
        height: placed.height
      };
    }

    currentScale = nextScale;
    currentMetrics = next;
    metricsBox = nextBox;
    bubbleColumns = nextColumns;
    // The renderer may still be painting nothing for a Size change, waiting
    // for a viewport this resize has just made out of date: tell it the size
    // the window has now (`followSizeChange`). After the correction above, so
    // the size it reads is final, and before the save below, which can throw.
    // Nothing on Linux, and nothing elsewhere outside the few frames a size
    // change takes to settle.
    followSizeChange();
    // Where the window now is, read back: the bubble's first paint is laid out
    // from it, and the `scene` that carries the bubble comes after this on the
    // same pipe (`placementSince`).
    sendToRenderer(CH.windowBounds, win.getBounds());
    // The bubble is transient, and its widening moves the window's left edge.
    // Remembering that as the dog's position would drift him half a bubble
    // every bark, so only a real (scale or box) resize is persisted. A resize
    // never re-decides his side of the screen (`anchorRight`): it is the dog
    // changing where he stands, not the owner putting him somewhere.
    // Caught (2026-11 audit, W-1): a settings file that cannot be written must
    // not throw out of a box change, or the `mode:set` and the rest of the
    // behaviour batch after it never go out. The window has moved; only the
    // saved spot is lost, as in `safeReclamp`.
    if (!centred) {
      try {
        remember(placed);
      } catch (error) {
        warn('overlay: could not save the position after a resize:', error);
      }
    }
    // Chokepoint 3 of 5. A resize moves the window's centre even when its
    // position is unchanged — a 3x dog is 216 px wide where a 1x dog was 72 —
    // and a clamp at a screen edge can move it further.
    syncFacing();
    vlog(`resize scale ${nextScale} box ${nextBox} -> ${next.width}x${next.height} at`, {
      x: placed.x,
      y: placed.y
    });
  }

  /**
   * A tray Size change on Windows or macOS, waiting for the renderer's blank
   * picture (QA row 3.3; the whole story is in `core/size-change`). Written
   * for Windows and told as it happened there; the Mac runs the same code
   * since 2026-11-17, for its own one bad frame between the two sizes.
   *
   * Between `setBounds` and the renderer's first paint at the new size,
   * Windows shows the last surface the renderer presented — the old-size dog
   * — at the new window's top-left. The fix of 2026-11-15 covered that gap by
   * making the window transparent (`setOpacity`) and was measured on
   * 2026-11-16 not to be enough: on 7 of 8 grows at 100 % the displaced dog
   * still showed for a frame or two, 20–30 ms after the window had been made
   * opaque again. So main no longer hides anything. It asks the renderer to
   * paint nothing, resizes only when that is on screen, and leaves it to the
   * renderer to draw him again once it paints at the new scale in the new
   * viewport. Whatever old surface Windows then shows should have no dog in
   * it — reckoned; this design has not been run on screen yet.
   *
   * `pending` is the change waited for: its id and the scale it will resize
   * to. **Nothing else changes until the wait ends** — `currentScale`,
   * `currentMetrics`, `metricsBox`, `anchorRight`, the bounds and
   * the saved position are all still the old size's, so every other operation
   * in this file (a drag, a Reset, a re-clamp, a box change, a bubble
   * widening, `currentMode()`) acts on one consistent state and is honoured
   * by the flush, which reads the live state. The flush is `applySize` as it
   * always was, run a few frames later.
   *
   * `sizeGapId` numbers the changes, so an answer can be matched to its
   * question: a late acknowledgement — one that crossed with the timer — must
   * not be taken for the next change's and resize that one before its blank
   * picture is up.
   */
  let pending: PendingSize | null = null;
  let sizeGapId = 0;
  let sizeBlankTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The change the window *has* been resized for, while the renderer may
   * still be painting nothing for it: from the `resized` message until its
   * `shown` report (`endsSettling`). The wait above is over by then, and
   * everything in this file is at the new size; what is not over is the
   * renderer's own wait for a paint in the viewport that message named.
   *
   * A bubble or a box change in those few frames resizes the window again,
   * through calls that send no `size:change`, and the renderer would go on
   * waiting for a viewport the window no longer has — nothing drawn, the dog
   * and the bubble that had just barked, until its 500 ms limit (review of
   * 2026-11-16). So `resize` calls `followSizeChange`, which sends `resized`
   * again with the size the window has now.
   *
   * Dropped by anything after which no page is waiting on that id: the
   * report, a new pick (the renderer drops the old change for the new
   * `blank`), a page load or a dead renderer (a fresh page waits for nothing),
   * and the window closing. A report that never comes costs a message the
   * renderer ignores after each resize until one of the others happens;
   * nothing is resized or held back on its account.
   */
  let settling: SettlingSize | null = null;

  /** Typed, so the two messages cannot drift from what the renderer parses. */
  const sendSizeChange = (message: SizeChangeMessage): void =>
    sendToRenderer(CH.sizeChange, message);

  /**
   * The window has just been resized by something other than the flush of a
   * Size change — a bubble, a box change, or a Size pick that had nothing to
   * wait for (`resize` calls this every time). If a change is still settling,
   * send its `resized` again: the same id and `from`, and as `to` the size
   * the window has now, read back rather than taken from what was asked for.
   * The scale is main's own; `resize` has set it by the time this runs, and
   * whoever resized sends `mode:set` after, where the scale or the box
   * changed, so the order on the pipe is the flush's: sizes, then scale.
   *
   * Nothing when no change is settling — always, on Linux — and nothing
   * during the flush's own resize, which runs with `settling` already dropped
   * by the pick that started the wait and sends the first `resized` itself.
   */
  function followSizeChange(): void {
    if (settling === null || win.isDestroyed()) return;
    const now = win.getBounds();
    sendSizeChange(resizedMessage(settling, currentScale, now));
    vlog(`size change ${settling.id}: resized again meanwhile (-> ${now.width}x${now.height})`);
  }

  /**
   * End the wait and make the size change, for whatever `reason` — the blank
   * picture is up, the renderer did not answer in time, or something happened
   * that cannot wait for either. Nothing when no change is pending, so every
   * caller may call it unconditionally, and on Linux, where nothing is ever
   * pending, it never does anything.
   *
   * `before` and `after` are the window's size as `getBounds` reports it on
   * each side of the resize: what the renderer tells the old viewport from the
   * new one by (`paintedAtSize`). Read here, not computed — they include a
   * box change or a bubble widening made during the wait, and at a fractional
   * scale factor they are what Windows granted rather than what was asked
   * for, which is the point of sending them after instead of ahead.
   *
   * `resize` is caught because this runs from a timer and from window events,
   * where nothing above would catch it, and the save inside it throws when
   * the settings file cannot be written (as `dragEnd`'s does below). The
   * window has been resized by then and the state updated, so the renderer
   * must still be told, or he stays blank until its own time limit; only the
   * facing, which `resize` settles last, is settled again here.
   *
   * `resized` goes first and `mode:set` second, on one pipe, so the renderer
   * cannot have the new scale without the sizes to check its viewport
   * against. The scale sent is the one `resize` actually left.
   */
  function flushSizeChange(reason: string): void {
    if (pending === null) return;
    const { id, scale: nextScale } = pending;
    pending = null;
    if (sizeBlankTimer !== null) {
      clearTimeout(sizeBlankTimer);
      sizeBlankTimer = null;
    }
    if (win.isDestroyed()) return;
    const before = win.getBounds();
    try {
      resize(nextScale, box, bubbleColumns);
    } catch (error) {
      warn('overlay: the size change did not finish cleanly:', error);
      syncFacing();
    }
    const after = win.getBounds();
    // From here until the renderer says he is drawn, any other resize is
    // followed by another `resized` for this id (`followSizeChange`).
    settling = { id, from: { width: before.width, height: before.height } };
    sendSizeChange(resizedMessage(settling, currentScale, after));
    sendToRenderer(CH.modeSet, overlay.currentMode());
    vlog(
      `size change ${id}: resized after ${reason} ` +
        `(${before.width}x${before.height} -> ${after.width}x${after.height})`
    );
  }

  if (hidesSizeChange) {
    /*
     * The renderer's answers. Registered on this window's own `webContents.ipc`
     * and not in `ipc-bridge.ts` (`CH.sizeReport` in `ipc.ts` has why): only
     * this window's page can reach it, and it is gone with the window, so an
     * overlay rebuilt after its window was destroyed registers its own without
     * tripping over this one. The sender is the overlay by construction; the
     * payload is still the renderer's and is still parsed.
     *
     * Only a `blank` report for the change that is pending resizes anything.
     * A `shown` report resizes nothing — the renderer un-blanks itself. It
     * ends the settling of the change it is for (`settling`), and it is
     * logged, so that an on-screen run can be timed from the log, and so a
     * report at the renderer's time limit, which means no paint ever matched,
     * is visible there with the viewport it gave up in.
     */
    win.webContents.ipc.handle(CH.sizeReport, (_event, raw: unknown) => {
      const report = parseSizeReport(raw);
      if (report === null) {
        warn('dropped malformed size:report payload');
        return;
      }
      if (report.phase === 'shown') {
        // He is drawn: later resizes are no longer this change's business.
        // Only for the change that is settling — a `shown` for one that a
        // newer pick replaced must not end the newer one's.
        if (endsSettling(settling, report)) settling = null;
        vlog(
          report.matched
            ? `size change ${report.id}: shown, matched at ${report.width}x${report.height}`
            : `size change ${report.id}: shown at the renderer's time limit, ` +
                `at ${report.width}x${report.height}`
        );
        return;
      }
      if (!acceptsBlankReport(pending, report)) {
        vlog(`size change ${report.id}: a blank report with nothing waiting for it; ignored`);
        return;
      }
      flushSizeChange('the blank picture is up');
    });
    // A fresh page boots through `settings:get` at whatever scale main has, in
    // whatever viewport the window has, and knows nothing of a blank it was
    // asked for before the load: resize now, so it boots into the new size.
    // Registered here, in `createOverlay`, which is before the bridge adds its
    // own `did-finish-load` listener — so this `mode:set` precedes that push.
    // And a fresh page is painting nothing for no one: whatever change was
    // settling, or has just been flushed into settling, is over for it.
    win.webContents.on('did-finish-load', () => {
      flushSizeChange('the page loaded');
      settling = null;
    });
    // Quit goes through `app.quit`, which closes the window: make the change
    // first, so the position saved is the one that belongs to the saved size.
    win.on('close', () => flushSizeChange('the window is closing'));
    // The timer holds nothing but the window; do not let it outlive it.
    win.on('closed', () => {
      if (sizeBlankTimer !== null) clearTimeout(sizeBlankTimer);
      sizeBlankTimer = null;
      pending = null;
      settling = null;
    });
  }

  const overlay: Overlay = {
    win,
    painted,

    notePainted(): void {
      markPainted();
    },

    applySize(nextScale: number): void {
      // Is there a picture on screen to blank first? Windows and macOS only,
      // and only a window that is ready and shown: before `ready-to-show` there is no
      // page to answer, and a hidden dog has no stale frame anyone can see.
      const deferring = hidesSizeChange && ready && wantShown && !win.isDestroyed();
      const request = sizeRequest(pending, deferring, currentScale, nextScale, sizeGapId + 1);
      switch (request.kind) {
        case 'now':
          // Linux always, exactly as before 2026-11-15.
          resize(nextScale, box, bubbleColumns);
          return;
        case 'start': {
          const { id } = request.pending;
          sizeGapId = id;
          pending = request.pending;
          // The renderer drops whatever change it was still blank for when
          // this `blank` arrives, so there is nothing left to follow up on:
          // until the flush, the window is resized at the old scale, with no
          // target on the other side to keep current.
          settling = null;
          sendSizeChange({ phase: 'blank', id });
          sizeBlankTimer = setTimeout(() => {
            sizeBlankTimer = null;
            flushSizeChange(`no answer from the renderer in ${SIZE_BLANK_GRACE_MS} ms`);
          }, SIZE_BLANK_GRACE_MS);
          vlog(
            `size change ${id}: asked the renderer for a blank picture ` +
              `(scale ${currentScale} -> ${nextScale})`
          );
          return;
        }
        case 'retarget':
          // A second pick during the wait: the same wait, ending at this
          // scale. No second message and the timer is not restarted
          // (`sizeRequest` has why).
          pending = request.pending;
          vlog(`size change ${request.pending.id}: now for scale ${nextScale}, same wait`);
          // He was hidden, or the window went, since the wait began: nothing
          // is left to wait for.
          if (!deferring) flushSizeChange('it can no longer wait');
          return;
      }
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
      if (next === bubbleColumns || win.isDestroyed()) return;
      // A bubble that fits the window as it is makes no window call at all
      // (Mac and Windows QA 5.9i, owner 2026-11-20): a resize commits the frame
      // and its content separately, and for a frame or two the dog stood off
      // his place or the text was clipped or wrapped. The side hold
      // (`windowFor`) makes this every bark but a few notices. Metrics, never
      // rects, are compared: at a fractional scale factor Windows grants a DIP
      // or two off what was asked, and `currentMetrics` still describes the
      // window. `<=`, so the clear after a bark wider than the hold does not
      // shrink it either; the next box or Size change lays it out afresh.
      const before = win.getBounds();
      const area = displayOf(before, currentMetrics).workArea;
      const fit = windowFor(currentScale, box, next, {
        restX: before.x + currentMetrics.bubbleExtra,
        areaX: area.x,
        areaWidth: area.width
      });
      if (fit.width <= currentMetrics.width && fit.height === currentMetrics.height) {
        bubbleColumns = next;
        return;
      }
      // No `mode:set`: neither the scale nor the box changed, and the renderer
      // re-derives its layout from `window.innerWidth` on the resize event the
      // `setBounds` below produces, and where the window is from the
      // `window:bounds` that `resize` sends ahead of the bubble (`placementSince`).
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
      if (shown) {
        // A hidden window hears the display events too, and is corrected by
        // them; this is for whatever changed without one. Before the show, so
        // he is never seen outside the screen for a frame. Nothing — no window
        // call at all — when he is inside.
        safeReclamp();
        win.showInactive();
        armForwardWatch();
      } else {
        win.hide();
        stopForwardWatch();
      }
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
      // Through the rule like every other placement (owner, 2026-11-16). The
      // home corner is `EDGE_MARGIN` inside the primary work area, so on any
      // display the resting window fits this answers the spot itself, at
      // every size, box and bubble; it is here for the display it does not
      // fit, and for a window Windows has granted taller than its metrics.
      //
      // Reckoned in the size that was *asked*, not the one read back: that is
      // the size `moveTo` restates. Until 2026-11-17 (review) the window's
      // floor was put on home's from the height read back, so a window read
      // taller than asked whose move then gave the surplus up ended that much
      // *above* home, and the next Reset somewhere else again. Now the window
      // asked for is the same one every time; a window that keeps a surplus
      // stands that much below home instead (inside: home is `EDGE_MARGIN`
      // in), which is where a resize would have left it too. The size read
      // back still goes to `settleFor`, which holds him inside under either.
      const placed = settleFor(
        {
          x: spot.x - currentMetrics.bubbleExtra,
          y: spot.y + rest.height - askedSize.height,
          width: b.width,
          height: b.height
        },
        currentMetrics,
        currentScale,
        metricsBox
      );
      const at: Rect = { ...placed, ...askedSize };
      sendCursor(at);
      moveTo(placed.x, placed.y);
      decideAnchor(at);
      // Caught for the same reason as in `resize`: he has been moved home.
      try {
        remember(at);
      } catch (error) {
        warn('overlay: could not save the reset position:', error);
      }
      // Chokepoint 4 of 5: the escape hatch teleports him to the primary
      // display's bottom-right corner, which is the far side of the screen from
      // wherever he was.
      syncFacing();
      vlog('reset position ->', spot, 'window at', placed);
    },

    revalidatePosition(): void {
      safeReclamp();
    },

    setBoxes(next: BoxSizes): void {
      boxes = next;
      safeReclamp();
    },

    dragStart(): void {
      if (win.isDestroyed()) return;
      dragging = true;
      dragMoved = false;
      dragTravel = 0;
      dragOrigin = win.getBounds();
      vlog('drag start at', dragOrigin);
    },

    dragMove(dxScreen: number, dyScreen: number): void {
      if (win.isDestroyed() || !dragging || dragOrigin === null) return;
      /*
       * **He cannot be dragged out of the screen (owner, 2026-11-16), and it
       * is this move that stops him, not the release.** Until then a drag only
       * had to leave 24 px of him reachable, and he could be parked half off
       * an edge (QA row 2.2 as it was).
       *
       * The delta is cumulative from the press, so this is absolute
       * positioning: the place the pointer asks for is always origin plus
       * delta, never the window's last position plus a step. That is what
       * makes the clamp a slide. While the pointer is past an edge, the axis
       * across that edge stays pinned and the other still follows; when the
       * pointer comes back he picks it up at the same grab point, with no
       * drift to work off. The origin is deliberately *not* rebased while he
       * is held at an edge. On one display the nearest inside position is the
       * per-axis clamp, so there is nothing for him to jitter between; across
       * displays, `clampRectInsideWorkAreas` says what happens at a seam.
       *
       * **It does not answer the window system.** One window call per
       * pointer event at most (`moveTo`: the position, and the size main last
       * asked for — never `setPosition`, never a size read back), and none
       * when nothing would change — a pointer wandering further outside the
       * screen moves nothing. The position asked for comes from the pointer
       * and the origin alone; the bounds are read for the clamp's size and to
       * skip that no-op, never to chase a position the system granted
       * differently. On macOS, should AppKit place the frame further in than
       * asked, nothing reads that back during the drag and `dragEnd` finds
       * him inside.
       *
       * **When a call is skipped.** When the window is at the position wanted
       * *and* is the size asked for: nothing to do. And when it is at the
       * position wanted, is not the size asked for, but this very rect is the
       * last thing asked of it: the system has already answered that request
       * with the size it has, and asking again on every pointer event would
       * be chasing it. Otherwise one call. So a window found larger than
       * asked has its size restated once even if the pointer has not moved
       * him — that is the correction this change exists for — and once only
       * per place: the rect asked is recorded before the call, there is no
       * listener on the window, and the same pointer position asks nothing
       * more, so it cannot loop. A position that differs from the live one is
       * always asked for, as it was before.
       *
       * **Whatever size the next move is granted.** At 125 % the window was
       * measured larger than it has metrics for: a DIP or two after a resize,
       * and growing on every step of a drag while moves were `setPosition`
       * calls. The cause is a hypothesis (`moveTo`), and whether `moveTo`
       * ends the growth is not yet seen on screen. So the drag still does not
       * rely on it. His feet are on the window's floor, so which rows are dog
       * depends on a size this call cannot know: the one the call below will
       * leave. The drag measures him as large as he could be either way
       * (`insideHeld`): the window as tall and wide as it has been since the
       * origin was last set (`resize` resets it), with nothing taken off for
       * that surplus — his feet at the largest window's floor, his head where
       * it is in the smallest. Inside under that, he is inside under
       * whichever he gets. It is also what keeps him from wobbling: the size
       * only grows, so the answer at an edge does not flip with a height that
       * does.
       *
       * **The price of that fallback, where it is needed.** While the window
       * is larger than its metrics he stops short of the top edge by all it
       * is taller, and of a side edge by half of what it is wider. If moves
       * no longer grow the window, that is nothing, or the constant 1–2 DIP
       * measured after a resize if that grant remains. If the window still
       * grew on each move despite `moveTo`, it would be everything it has
       * grown since the drag began (46 DIP in the test that pins that model),
       * until a resize gives the window its metrics' size back. Never above
       * the edge, never a breach of the rule. Measuring his head in the
       * window as it stands instead would put it above the edge whenever a
       * move left the window smaller again. Reckoned, and pinned in the tests
       * under both models; not yet seen on screen (the on-screen list has
       * "drag a long way, then to the top edge, at 125 %").
       *
       * Measured on the display he is being dragged onto, whose scale factor
       * is the one he will be drawn at there.
       */
      dragTravel = Math.max(dragTravel, Math.hypot(dxScreen, dyScreen));
      // A pet has a dead zone (2026-11-19, Windows QA): while the press stays
      // under the renderer's click slop (`isClick`) he does not follow the
      // hand at all. Once it is past, the move is origin plus delta as ever,
      // so the grab point is back under the cursor on that first step.
      if (dragTravel < CLICK_SLOP_PX) return;
      const live = win.getBounds();
      // The size asked counts too: it is the one this move restates, so a
      // window read back smaller than it may be that large after the call.
      const widest = Math.max(dragOrigin.width, live.width, askedSize.width);
      const tallest = Math.max(dragOrigin.height, live.height, askedSize.height);
      if (widest > dragOrigin.width || tallest > dragOrigin.height) {
        dragOrigin = { ...dragOrigin, width: widest, height: tallest };
      }
      const held = insideHeld(dragTargetRect(dragOrigin, dxScreen, dyScreen));
      if (held.x === live.x && held.y === live.y) {
        const sized = live.width === askedSize.width && live.height === askedSize.height;
        const askedAlready =
          lastAsked.x === held.x &&
          lastAsked.y === held.y &&
          lastAsked.width === askedSize.width &&
          lastAsked.height === askedSize.height;
        if (sized || askedAlready) return;
      } else {
        // Only a change of place: a call that restates the size where he
        // already is has not put him anywhere.
        dragMoved = true;
      }
      moveTo(held.x, held.y);
      // Chokepoint 5 of 5, and the one the owner will actually see: dragging him
      // across the middle of the screen turns him, once, at the far edge of the
      // dead band. The renderer suppresses hit verdicts during a drag, so the
      // momentary mismatch between the cursor and the mirrored ink cannot drop it.
      // (Not reached when he did not move: the facing is a function of where
      // the window is and of nothing else.)
      syncFacing();
    },

    dragEnd(): void {
      if (!dragging) return;
      dragging = false;
      dragOrigin = null;
      if (win.isDestroyed()) return;
      // Every move already held him inside; this is for what the moves did not
      // see — the window system granting the last one differently (the 125 %
      // surplus row at the bottom edge), or a display changing mid-drag. One
      // `moveTo` at most, and the bounds are not read again after it: the
      // spot saved is the one asked for. A press and release that stayed in
      // the click slop (a pet) finds him inside and moves nothing. After the drag
      // flags are dropped, so the cursor reading goes out as for any other
      // move this file makes.
      const live = win.getBounds();
      const inside = insideNow(live);
      // As in `reclamp`: inside or not is asked of the window as it is, and
      // where he goes allows for the size the move may leave it.
      const dropped =
        inside.x !== live.x || inside.y !== live.y
          ? { ...live, ...settleFor(live, currentMetrics, currentScale, metricsBox) }
          : live;
      // A drag, by the renderer's own rule for a pet (`isClick`): the press
      // travelled the click slop or more, and it changed his place.
      let put = dragMoved && dragTravel >= CLICK_SLOP_PX;
      dragMoved = false;
      dragTravel = 0;
      if (dropped.x !== live.x || dropped.y !== live.y) {
        sendCursor(dropped);
        moveTo(dropped.x, dropped.y);
        put = true;
        vlog('drag end: moved back inside the screen ->', { x: dropped.x, y: dropped.y });
      }
      // His side of the screen is decided, and his spot saved, where he is
      // *put*, and a pet does not put him anywhere (2026-11-19, Windows QA
      // 3.3c): re-deciding on every release let a pet at Medium, whose centre
      // a grow from the left edge had carried past the middle, flip the edge
      // the next size change kept, and the round trip ended 88 px to the left.
      // A pet cannot move him either (`dragMove`'s dead zone), so it saves
      // nothing: the spot on disk is the one he already stands on.
      if (put) {
        decideAnchor(dropped);
        remember(dropped);
      }
      // The facing follows the window, and the correction above may have moved
      // it; a no-op otherwise, `dragMove` having settled it on the last move.
      syncFacing();
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

    resyncCursor(): void {
      // `sendCursor` already stays out of a drag and a destroyed window.
      if (win.isDestroyed() || !wantShown) return;
      sendCursor(win.getBounds());
    },

    standingDisplay(): Rect {
      return displayOf(win.getBounds(), currentMetrics).bounds;
    },

    orderAboveCard(): void {
      if (win.isDestroyed() || !win.isVisible()) return;
      win.moveTop();
    },

    send: sendToRenderer
  };

  /*
   * A dead overlay renderer is recovered here, not by `ensureOverlay`
   * (2026-11-13 audit, M1): the window survives the crash, and everything that
   * rebuilds the overlay acts only on a destroyed or missing window, so the dog
   * stayed gone until Restart. The renderer reports hit changes only on change,
   * so a death while the cursor was on him or mid-drag would also leave the
   * window catching clicks over whatever is behind it, or a drag half-held:
   * both go back to the state the window was built in. A reload is a full boot
   * — `ipc-bridge.ts` re-pushes sheet, mode, palette and usage and resyncs the
   * behaviour on every `did-finish-load` — and it is bounded the way the hover
   * panel's is (`MAX_RENDERER_RELOADS`), so a renderer that dies on load cannot
   * loop forever.
   */
  let reloads = 0;
  win.webContents.on('render-process-gone', (_event, details) => {
    warn('renderer process gone:', details.reason);
    if (win.isDestroyed()) return;
    // Through `dragEnd`, not by clearing the flags (2026-11-13, R12): a drag cut
    // short by the crash still ends where the dog now is, so that spot is
    // checked against the screen and saved, and his side of the screen follows
    // it — otherwise the next launch put him back at the pre-drag position. A
    // no-op when no drag is held. Caught, because the save
    // throws when the settings file cannot be written and the reload below
    // must still happen; `dragEnd` drops the drag before it saves.
    try {
      overlay.dragEnd();
    } catch (error) {
      warn('overlay: could not save the dragged position:', error);
    }
    setIgnore(!forceInteractive);
    // A dead renderer paints no blank picture and answers nothing: make a
    // pending Size change now rather than wait out the grace for it. Here and
    // not on the load that follows, because after the last allowed reload no
    // load follows. Nothing pending (always, on Linux) is nothing to do.
    flushSizeChange('the renderer died');
    // Nor does it wait for a viewport: the change that flush made, or one that
    // was still settling, is nothing to the page that is loaded next.
    settling = null;
    if (reloads >= MAX_RENDERER_RELOADS) {
      warn('overlay: renderer died again; not reloading again this run');
      return;
    }
    reloads++;
    win.webContents.reload();
  });

  return overlay;
}

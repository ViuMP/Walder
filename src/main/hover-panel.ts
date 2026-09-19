/**
 * The hover panel: the card that appears beside Walder while the cursor rests on
 * him, listing every usage bucket.
 *
 * A second window rather than part of the overlay, for one hard reason: the
 * overlay is sized around the sprite and cannot grow (a click-through window's
 * bounds are fixed at creation, and growing it would change where the dog sits).
 * The card is 380 / 370 / 250 px wide depending on the chosen card size
 * (`cardWidthFor` in `core/card-layout.ts`) and as tall as its content, so it
 * needs its own frame.
 *
 * Its properties are all consequences of "this is a tooltip, not a window":
 *  - `focusable: false` — it must never take focus from what the owner is typing
 *    into. That also means it must never be `show()`n, only `showInactive()`.
 *  - `setIgnoreMouseEvents(true)` — fully click-through, no `forward`. Nothing on
 *    the card is interactive, and a card that swallowed clicks would be
 *    infuriating: it appears *next to* where the cursor already is.
 *  - `alwaysOnTop(true, 'screen-saver')` and, on macOS, visible on all
 *    workspaces including full-screen ones — the same level as the dog, so the
 *    two never separate.
 *  - `transparent` with a semi-transparent card (the owner's request at the
 *    2026-09-08 design gate): full-screen video stays visible behind it.
 *
 * Timing lives here rather than in the renderer: the 250 ms delay is what stops
 * the card flickering as the cursor crosses the dog on its way somewhere else,
 * and hiding is immediate because a card that lingers after the cursor has left
 * reads as a bug.
 *
 * **The width is main's business, the layout is the renderer's.** Main owns the
 * window (it must know the width before the page has drawn anything, to place
 * the window), so a size change here is two things: a new window width, and a
 * `cardSize:set` push telling the renderer to redraw. It deliberately does
 * *not* hide the card — the owner is switching sizes to compare them, and a card
 * that vanishes on each click cannot be compared.
 *
 * **Two logging obligations**, both permanent (they were added to diagnose the
 * card not appearing over a macOS full-screen Space, and they are what any
 * future report of the same shape will be read against):
 *  - every `showInactive()` is followed by what the window server thinks
 *    happened — `isVisible`, the bounds, which display, where the cursor is,
 *    whether we believe a full-screen app is up;
 *  - hiding and the already-visible re-show path say so too.
 *
 * **The stranded card, and the recovery that now exists.** That logging found
 * the fault it was added for: a log full of "panel re-placed (already visible)"
 * while the owner saw no card is a window ordered in on the *wrong Space*.
 * `isVisible()` is true for it, so the old early return re-placed it forever and
 * never ordered it in again. Two things fix that, and both are in this file now:
 *  - `hoverEnter` on an "already visible" window places *and* shows. A
 *    `showInactive()` on a window macOS already considers visible is what
 *    re-orders it onto the current Space — the one call the early return was
 *    skipping.
 *  - `showCard` re-asserts the two collection-behaviour flags on every show, so
 *    a window whose behaviour was lost (a Space change, a display change, a
 *    process-type transform) recovers at the next hover instead of at the next
 *    launch. The launch-time pre-show is still `once`; it no longer has to be
 *    the only thing that establishes this.
 */
import { BrowserWindow, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import {
  cardWidthFor,
  DEFAULT_CARD_SIZE,
  DEFAULT_RESET_STYLE,
  type CardSize,
  type ResetStyle
} from '../core/card-layout';
import type { Rect } from '../core/geometry';
import { placePanel, workAreaFor } from '../core/panel-place';
import { CH } from './ipc';
import { vlog, warn } from './log';

const PRELOAD = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));

/** How long the cursor must rest on the dog before the card appears. */
export const HOVER_SHOW_DELAY_MS = 250;

/** Height used until the renderer reports its real content height. */
export const PANEL_INITIAL_HEIGHT = 220;

/**
 * How many times a dead panel renderer is reloaded before Walder stops trying.
 *
 * Per window, per run. Three is "a crash, a bad moment, one more chance" — see
 * the handler for why there is a bound at all.
 */
export const MAX_RENDERER_RELOADS = 3;

/**
 * macOS assigns a new window's Space on its first order-in. The hover panel is
 * pre-shown invisibly while the desktop Space is frontmost, so its later hover
 * card remains available over Safari's full-screen Space.
 *
 * The sequence is macOS-only. The owner verified it on 2026-09-11; Windows and
 * Linux already show the card in full-screen apps.
 */
/* ------------------------------------------------------------------- the panel */

export interface HoverPanelOptions {
  /** Which card layout the renderer will draw, and therefore how wide the window is. */
  readonly cardSize?: CardSize;
  /**
   * Do we believe a full-screen app is in front right now? Read at every show,
   * for the log line only — this is the state the diagnosis turns on, and
   * reconstructing it afterwards from the behaviour log's own timestamps proved
   * unreliable.
   */
  readonly isFullscreen?: () => boolean;
}

export interface HoverPanel {
  readonly win: BrowserWindow;
  /** The cursor came to rest on the dog's ink. Arms the show timer. */
  hoverEnter(spriteRectScreen: Rect): void;
  /** The cursor left, or a drag started. Hides immediately. */
  hoverLeave(): void;
  /** The renderer measured its card. Resizes, and re-places if visible. */
  setContentHeight(height: number): void;
  /** The owner picked another card size in the tray menu. */
  setCardSize(next: CardSize): void;
  /**
   * The owner picked another reset wording. A push and nothing else — unlike a
   * size change it cannot alter the window's width, only the text inside it.
   */
  setResetStyle(next: ResetStyle): void;
  send(channel: string, payload: unknown): void;
  isShowing(): boolean;
  destroy(): void;
}

function pageUrl(): string {
  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (devServer !== undefined && devServer !== '') return `${devServer}/panel.html`;
  return new URL('../renderer/panel.html', import.meta.url).href;
}

export function createHoverPanel(options: HoverPanelOptions = {}): HoverPanel {
  const isMac = process.platform === 'darwin';

  let cardSize: CardSize = options.cardSize ?? DEFAULT_CARD_SIZE;
  let width = cardWidthFor(cardSize);
  /*
   * Not a `HoverPanelOptions` field, unlike `cardSize`: that one is an option
   * because main must know the window's *width* before the page has drawn
   * anything, and the wording changes no pixel main owns. The renderer's own
   * starting value comes from `settings:get`; this is only here so a repeat
   * click on the style already showing costs nothing.
   */
  let resetStyle: ResetStyle = DEFAULT_RESET_STYLE;

  const win = new BrowserWindow({
    width,
    height: PANEL_INITIAL_HEIGHT,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    // A non-activating panel keeps the card separate from the app the owner is
    // using; square corners match the card's own visual shape.
    ...(isMac
      ? {
          type: 'panel' as const,
          roundedCorners: false
        }
      : {}),
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (process.platform === 'win32') win.setSkipTaskbar(true);
  // No `{forward: true}`: unlike the overlay, this window never needs to hear
  // about mouse moves — the overlay is what decides when it should be visible.
  win.setIgnoreMouseEvents(true);
  win.setMenuBarVisibility(false);

  // Same rule as the overlay: this window holds the preload bridge, so it may
  // not be navigated away from the page we loaded.
  const url = pageUrl();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, target) => {
    if (target === url) return;
    event.preventDefault();
    warn('blocked in-window navigation in the hover panel to', target);
  });
  void win.loadURL(url);

  /*
   * A dead renderer here is silent in a way the overlay's is not: the card only
   * exists while the cursor rests on the dog, so a blank one reads as "the card
   * is broken today", and the window itself survives — nothing rebuilds it.
   * Reloading costs one page load on a window that is hidden at the time.
   *
   * Nothing has to be re-pushed afterwards: `panel.ts`'s `boot()` ends with a
   * `settings:get` round trip ("Ask rather than wait"), and that payload carries
   * the last snapshot, the card size and the credit price — the same reason a
   * panel that loads after a restored snapshot is not empty. A reload is just
   * another boot.
   *
   * **And it is bounded, which nothing else in the app has to be.** The
   * overlay's own `render-process-gone` handler only *warns*; this is the one
   * place Walder retries itself. A renderer that dies during load — a broken
   * asset in a bad build, a GPU fault the page trips on every boot — would
   * otherwise crash, reload, crash, reload forever, spawning renderer processes
   * behind a window that is hidden at the time, so nobody would see anything
   * except a machine getting slower. Three attempts per window per run, then the
   * card stays blank and says so once in the log: a blank card the owner can
   * report beats an invisible process loop he cannot.
   */
  let reloads = 0;
  win.webContents.on('render-process-gone', (_event, details) => {
    warn('hover panel renderer process gone:', details.reason);
    if (reloads >= MAX_RENDERER_RELOADS) {
      warn('hover panel: renderer died again; not reloading again this run');
      return;
    }
    reloads++;
    win.webContents.reload();
  });

  let height = PANEL_INITIAL_HEIGHT;
  /** The dog's ink rect from the last `hover:enter`, for re-placing on resize. */
  let anchor: Rect | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (showTimer === null) return;
    clearTimeout(showTimer);
    showTimer = null;
  }

  function place(dog: Rect): void {
    if (win.isDestroyed()) return;
    const areas = screen.getAllDisplays().map((display) => display.workArea);
    const area = workAreaFor(dog, areas);
    const at = placePanel(dog, { width, height }, area);

    // `resizable: false` makes some platforms refuse a programmatic resize, so
    // lift the flag for the call and put it straight back — the same dance the
    // overlay does in `applySize`.
    const wasResizable = win.isResizable();
    if (!wasResizable) win.setResizable(true);
    win.setBounds({ x: at.x, y: at.y, width, height });
    if (!wasResizable) win.setResizable(false);
    vlog(`panel placed ${at.side} of the dog at (${at.x}, ${at.y}) ${width}x${height}`);
  }

  function sendTo(channel: string, payload: unknown): void {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    try {
      win.webContents.send(channel, payload);
    } catch (error) {
      warn(`failed to send ${channel} to the panel:`, error);
    }
  }

  /**
   * What the window server made of the show we just asked for.
   *
   * Read *after* the call, never predicted: the whole reason this line exists is
   * that `isVisible()` can be true for a window the owner cannot see (it was
   * ordered in on another Space), and only the combination of that flag with the
   * bounds, the display and the cursor position tells the two apart.
   */
  function logShown(at: Rect): void {
    const point = { x: at.x, y: at.y };
    vlog('panel shown', {
      isVisible: win.isVisible(),
      bounds: win.getBounds(),
      display: screen.getDisplayNearestPoint(point).bounds,
      cursor: screen.getCursorScreenPoint(),
      fullscreen: options.isFullscreen?.() ?? null
    });
  }

  /**
   * Show the card, having already placed it.
   *
   * `showInactive`, never `show`: this window must not take focus.
   *
   * The two macOS calls before it re-assert what was set once at construction.
   * They are here, per show, because the failure they answer is exactly "the
   * window kept its bounds but lost the behaviour that puts it over a
   * full-screen Space", which no app-side state can observe.
   *
   * Verified against the Electron 44 BrowserWindow docs
   * (https://www.electronjs.org/docs/latest/api/browser-window):
   *  - The docs do **not** say either call is a no-op when the value is already
   *    set, so this deliberately runs only on a real show, not on every
   *    `hover:enter` (the renderer sends one per animation frame).
   *  - `setVisibleOnAllWorkspaces` documents a side effect that would break this
   *    outright: it "will by default transform the process type between
   *    UIElementApplication and ForegroundApplication … this will hide the
   *    window and dock for a short time every time it is called", with
   *    `skipTransformProcessType: true` as the documented bypass "if your window
   *    is already of type UIElementApplication". Walder is: `LSUIElement: true`
   *    in `electron-builder.yml` plus `app.dock.hide()`. So the flag is passed —
   *    without it, every hover would briefly hide the very card it is showing.
   *  - `setAlwaysOnTop` goes **first**. The docs pin the level to the flag ("the
   *    level is reset to normal when the flag is false") and say nothing about
   *    preserving the workspace collection behaviour across a level change, so
   *    the fullscreen-auxiliary assertion is made last and cannot be clobbered
   *    by the level call. The reverse order is the one with a known Electron
   *    history of dropping `visibleOnFullScreen`.
   */
  function showCard(at: Rect): void {
    if (isMac) {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true
      });
    }
    win.showInactive();
    logShown(at);
  }

  /*
   * Wait for the page's first paint: ordering in immediately can flash a white
   * rectangle. Opacity returns only after the hide, so the first real hover is
   * visible rather than silently inheriting the pre-show's transparent state.
   */
  if (isMac) {
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      // First paint can land after a fast hover has already shown the card;
      // hiding it then would erase a card the user is looking at.
      if (win.isVisible()) return;
      win.setOpacity(0);
      win.showInactive();
      win.hide();
      win.setOpacity(1);
      vlog('panel pre-shown off-Space');
    });
  }

  return {
    win,

    hoverEnter(spriteRectScreen: Rect): void {
      if (win.isDestroyed()) return;
      anchor = spriteRectScreen;
      if (win.isVisible()) {
        /*
         * Already up: follow the dog rather than waiting out the delay again —
         * and show it again anyway.
         *
         * The second half is the fix for the stranded card (see the file
         * header). `isVisible()` is true for a window ordered in on *another*
         * Space, so "already up" can mean "on screen, following the dog" or
         * "invisible on the Space the owner left an hour ago", and nothing here
         * can tell the two apart. `showInactive()` re-orders the window into the
         * current Space, and on a card that really is up it is a no-op the owner
         * cannot see — so it is run for both readings rather than guessed at.
         */
        place(spriteRectScreen);
        // Said before the show, so the log reads in the order it happened: this
        // line, then `showCard`'s own "panel shown" with the window server's
        // answer.
        vlog('panel re-shown (was visible)');
        showCard(spriteRectScreen);
        return;
      }
      /*
       * A timer that is already armed is left alone.
       *
       * It used to be cleared and re-armed on every `hover:enter`, and the
       * renderer sends one whenever the *rect* changes — which it does on every
       * animation frame that moves the ink: `blink` runs at 83 ms and
       * `tail_wag` at 100 ms, both comfortably shorter than this 250 ms delay.
       * The card therefore never appeared at all while the dog was blinking or
       * wagging: each frame pushed the deadline further out. The timer reads
       * `anchor` when it fires, so keeping it costs nothing — the card still
       * lands at the dog's *current* position.
       *
       * The cancel-and-rearm case that matters is a real *leave*, and
       * `hoverLeave` clears the timer itself.
       */
      if (showTimer !== null) return;
      showTimer = setTimeout(() => {
        showTimer = null;
        if (win.isDestroyed() || anchor === null) return;
        place(anchor);
        showCard(anchor);
      }, HOVER_SHOW_DELAY_MS);
    },

    hoverLeave(): void {
      clearTimer();
      anchor = null;
      if (win.isDestroyed()) return;
      /*
       * Hidden unconditionally, without asking `isVisible()` first.
       *
       * On macOS that flag is not "the owner can see this": it is false for a
       * window that is merely *occluded*, and true for one ordered in on another
       * Space. Both readings are wrong for this decision, and the wrong one
       * leaves a card on screen with the cursor nowhere near the dog. `hide()`
       * on an already-hidden window is a no-op, so there is nothing to save by
       * guarding it.
       */
      win.hide();
      vlog('panel hidden');
    },

    setContentHeight(next: number): void {
      if (next === height) return;
      height = next;
      if (win.isDestroyed()) return;
      // Re-place, not just resize: the card is top-aligned with the dog and
      // clamped to the work area, so a taller card can need a new y.
      if (anchor !== null) place(anchor);
    },

    setCardSize(next: CardSize): void {
      if (next === cardSize) return;
      cardSize = next;
      width = cardWidthFor(next);
      if (win.isDestroyed()) return;
      /*
       * Re-placed but never hidden. The owner is switching sizes to see the
       * difference, and the renderer only re-sends `hover:enter` when the dog's
       * ink rect changes — so a card hidden here would stay hidden until he
       * moved the cursor off the dog and back on again.
       *
       * The height is left as it is: the renderer will report the new one a
       * frame later (`reportPanelSize`), and guessing it here would put a
       * visibly wrong window on screen in the meantime.
       */
      if (anchor !== null) place(anchor);
      sendTo(CH.cardSizeSet, { cardSize: next });
    },

    setResetStyle(next: ResetStyle): void {
      if (next === resetStyle) return;
      resetStyle = next;
      if (win.isDestroyed()) return;
      // No `place`: the reset line is one line either way, so the card cannot
      // change height and the anchor cannot go stale. Just the push.
      sendTo(CH.resetStyleSet, { resetStyle: next });
    },

    send: sendTo,

    isShowing(): boolean {
      return !win.isDestroyed() && win.isVisible();
    },

    destroy(): void {
      clearTimer();
      if (!win.isDestroyed()) win.destroy();
    }
  };
}

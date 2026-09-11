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
 *  - hiding and the already-visible re-place path say so too. A log full of
 *    "panel re-placed (already visible)" while the owner sees no card is the
 *    signature of a window ordered in on the *wrong Space*, which no amount of
 *    app-side state can detect.
 */
import { BrowserWindow, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import { cardWidthFor, DEFAULT_CARD_SIZE, type CardSize } from '../core/card-layout';
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
   */
  function showCard(at: Rect): void {
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
        // Already up: follow the dog rather than waiting out the delay again.
        place(spriteRectScreen);
        vlog('panel re-placed (already visible)');
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

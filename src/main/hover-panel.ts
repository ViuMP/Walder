/**
 * The hover panel: the card that appears beside Walder while the cursor rests on
 * him, listing every usage bucket.
 *
 * A second window rather than part of the overlay, for one hard reason: the
 * overlay is sized around the sprite and cannot grow (a click-through window's
 * bounds are fixed at creation, and growing it would change where the dog sits).
 * The card is 300 px wide and as tall as its content, so it needs its own frame.
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
 */
import { BrowserWindow, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import type { Rect } from '../core/geometry';
import { placePanel, workAreaFor } from '../core/panel-place';
import { PANEL_WIDTH } from './ipc';
import { vlog, warn } from './log';

const PRELOAD = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));

/** How long the cursor must rest on the dog before the card appears. */
export const HOVER_SHOW_DELAY_MS = 250;

/** Height used until the renderer reports its real content height. */
export const PANEL_INITIAL_HEIGHT = 220;

function pageUrl(): string {
  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (devServer !== undefined && devServer !== '') return `${devServer}/panel.html`;
  return new URL('../renderer/panel.html', import.meta.url).href;
}

export interface HoverPanel {
  readonly win: BrowserWindow;
  /** The cursor came to rest on the dog's ink. Arms the show timer. */
  hoverEnter(spriteRectScreen: Rect): void;
  /** The cursor left, or a drag started. Hides immediately. */
  hoverLeave(): void;
  /** The renderer measured its card. Resizes, and re-places if visible. */
  setContentHeight(height: number): void;
  send(channel: string, payload: unknown): void;
  isShowing(): boolean;
  destroy(): void;
}

export function createHoverPanel(): HoverPanel {
  const isMac = process.platform === 'darwin';

  const win = new BrowserWindow({
    width: PANEL_WIDTH,
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
    ...(isMac ? { type: 'panel' as const, roundedCorners: false } : {}),
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
    const at = placePanel(dog, { width: PANEL_WIDTH, height }, area);

    // `resizable: false` makes some platforms refuse a programmatic resize, so
    // lift the flag for the call and put it straight back — the same dance the
    // overlay does in `applySize`.
    const wasResizable = win.isResizable();
    if (!wasResizable) win.setResizable(true);
    win.setBounds({ x: at.x, y: at.y, width: PANEL_WIDTH, height });
    if (!wasResizable) win.setResizable(false);
    vlog(`panel placed ${at.side} of the dog at (${at.x}, ${at.y}) ${PANEL_WIDTH}x${height}`);
  }

  return {
    win,

    hoverEnter(spriteRectScreen: Rect): void {
      if (win.isDestroyed()) return;
      anchor = spriteRectScreen;
      if (win.isVisible()) {
        // Already up: follow the dog rather than waiting out the delay again.
        place(spriteRectScreen);
        return;
      }
      clearTimer();
      showTimer = setTimeout(() => {
        showTimer = null;
        if (win.isDestroyed() || anchor === null) return;
        place(anchor);
        // `showInactive`, never `show`: this window must not take focus.
        win.showInactive();
      }, HOVER_SHOW_DELAY_MS);
    },

    hoverLeave(): void {
      clearTimer();
      anchor = null;
      if (win.isDestroyed()) return;
      if (win.isVisible()) win.hide();
    },

    setContentHeight(next: number): void {
      if (next === height) return;
      height = next;
      if (win.isDestroyed()) return;
      // Re-place, not just resize: the card is top-aligned with the dog and
      // clamped to the work area, so a taller card can need a new y.
      if (anchor !== null) place(anchor);
    },

    send(channel: string, payload: unknown): void {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      try {
        win.webContents.send(channel, payload);
      } catch (error) {
        warn(`failed to send ${channel} to the panel:`, error);
      }
    },

    isShowing(): boolean {
      return !win.isDestroyed() && win.isVisible();
    },

    destroy(): void {
      clearTimer();
      if (!win.isDestroyed()) win.destroy();
    }
  };
}

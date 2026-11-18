/**
 * The Walder window: a category rail with an Overview page (model, coat and
 * card size staged against a preview until Apply, plus a Refresh button) and
 * one page per settings group from `core/settings-spec`. Opened from the tray's **Settings…** item.
 *
 * An ordinary framed, resizable window — unlike the overlay and the card, which
 * are frameless click-through tool windows — so it shows in the taskbar and the
 * Dock while open, closes with the system close button, and works the same on
 * Windows and macOS. Only one exists; opening it again focuses it.
 *
 * Security, the same as every Walder window: sandboxed, context-isolated, no
 * Node, the page locked to itself (`lockNavigation`). It gets its own preload
 * (`preload/settings.ts`) with five calls and nothing else, and main answers
 * those calls only for this window's `webContents`, so neither the overlay nor
 * the card can write a setting. Every write goes through `main/settings.ts`,
 * which refuses app-state keys and validates each value.
 */
import { BrowserWindow, Menu, app, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { fileURLToPath } from 'node:url';
import { lockNavigation, pageUrl } from './window-page';
import {
  SETTINGS_CH,
  parseSetRequest,
  type CoatPreview,
  type SettingsSetReply,
  type SettingsWindowState
} from './settings-ipc';
import type { Settings } from './settings';
import { paletteLabel } from '../core/settings-spec';
import type { CreditPrice, UsageSnapshot } from '../core/usage';
import type { SessionEntry } from '../core/sessions';
import type { ShortcutStatus } from '../core/shortcuts';
import { warn } from './log';

const SETTINGS_PRELOAD = fileURLToPath(new URL('../preload/settings.cjs', import.meta.url));

export interface SettingsWindowDeps {
  readonly settings: Settings;
  readonly palettes: () => readonly string[];
  readonly shortcutStatus: () => ShortcutStatus;
  readonly usage: () => UsageSnapshot | null;
  readonly sessions: () => readonly SessionEntry[];
  readonly creditPrice: () => CreditPrice | null;
  /** Every coat's idle frame and colours, for the Overview's preview. */
  readonly previews: () => readonly CoatPreview[];
  /** Poll now; returns the services still waiting out a server's rate limit. */
  readonly refreshNow: () => readonly string[];
}

export interface SettingsWindow {
  /** Open the window, or focus it if it is already open. */
  open(): void;
  /** Send the current state to an open window (after any change, from any UI). */
  push(): void;
  /** The open window, for screenshots and tests; `null` when closed. */
  current(): BrowserWindow | null;
}

export function createSettingsWindow(deps: SettingsWindowDeps): SettingsWindow {
  let win: BrowserWindow | null = null;

  function state(): SettingsWindowState {
    return {
      settings: deps.settings.snapshot(),
      locked: deps.settings.locked(),
      palettes: deps.palettes().map((id) => ({ value: id, label: paletteLabel(id) })),
      shortcutStatus: deps.shortcutStatus(),
      platform: process.platform,
      version: app.getVersion(),
      usage: deps.usage(),
      sessions: [...deps.sessions()],
      creditPrice: deps.creditPrice()
    };
  }

  /** True only for this window's own page. */
  function fromWindow(event: IpcMainInvokeEvent): boolean {
    return win !== null && !win.isDestroyed() && event.sender === win.webContents;
  }

  ipcMain.handle(SETTINGS_CH.get, (event) => (fromWindow(event) ? state() : null));

  ipcMain.handle(SETTINGS_CH.set, (event, raw: unknown): SettingsSetReply | null => {
    if (!fromWindow(event)) return null;
    const request = parseSetRequest(raw);
    if (request === null) return { ok: false, error: 'Malformed request.', state: state() };
    const result = deps.settings.set(request.key, request.value);
    return result.ok
      ? { ok: true, saved: result.saved, state: state() }
      : { ok: false, error: result.error, state: state() };
  });

  ipcMain.handle(SETTINGS_CH.refresh, (event) => (fromWindow(event) ? deps.refreshNow() : null));

  ipcMain.handle(SETTINGS_CH.previews, (event) => (fromWindow(event) ? deps.previews() : null));

  function push(): void {
    if (win === null || win.isDestroyed()) return;
    win.webContents.send(SETTINGS_CH.changed, state());
  }

  function open(): void {
    if (win !== null && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      // Walder has no Dock icon on macOS, so it is never the active app on its
      // own; without this the window can open behind the one in front.
      if (process.platform === 'darwin') app.focus({ steal: true });
      return;
    }
    win = new BrowserWindow({
      // Rail (about 170 px) beside the Overview's preview: the sprite and a
      // Large card, which `paint` pins at 377 px. Below 640 px the rail folds
      // into a row on top (settings.html), so 440 still fits a Large card.
      width: 820,
      height: 700,
      minWidth: 440,
      minHeight: 420,
      show: false,
      title: 'Walder',
      backgroundColor: '#fbf7ee',
      autoHideMenuBar: true,
      fullscreenable: false,
      webPreferences: {
        preload: SETTINGS_PRELOAD,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false
      }
    });
    /*
     * No Electron default menu: it carries Reload and Toggle Developer Tools.
     * Windows gets no menu at all (Ctrl+C/V work in the fields without one).
     * macOS routes Cmd+C/V/X/A/Z through the application menu, so it gets
     * one with only the Edit and Window menus. Walder has no other window
     * that uses a menu, so setting it here costs nothing elsewhere.
     */
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          { role: 'appMenu', submenu: [{ role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
          { role: 'editMenu' },
          { role: 'windowMenu' }
        ])
      );
    } else {
      win.removeMenu();
    }
    const url = pageUrl('settings.html');
    lockNavigation(win, url, ' in the settings window');
    win.once('ready-to-show', () => {
      win?.show();
      if (process.platform === 'darwin') app.focus({ steal: true });
    });
    win.on('closed', () => {
      win = null;
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      warn('settings window renderer gone:', details.reason);
    });
    void win.loadURL(url);
  }

  return { open, push, current: () => (win !== null && !win.isDestroyed() ? win : null) };
}

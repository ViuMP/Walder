/**
 * The page plumbing the overlay and the hover panel share (2026-11 audit,
 * W-5): the preload path, where a renderer page lives, and the navigation
 * lock. One copy, so the security-relevant lock cannot drift between windows.
 *
 * The gallery keeps its own stricter lock (it blocks every navigation and has
 * no preload) but resolves its page here too.
 */
import { app, type BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { warn } from './log';

/** The bundled preload, next to the main bundle as `../preload/index.cjs`. */
export const PRELOAD = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));

/**
 * Where a renderer page lives: the Vite dev server under `npm run dev`, the
 * bundled file otherwise. `query` (with its `?`) is appended to either.
 */
export function pageUrl(page: string, query = ''): string {
  const devServer = devServerUrl();
  if (devServer !== null) return `${devServer}/${page}${query}`;
  return new URL(`../renderer/${page}${query}`, import.meta.url).href;
}

/**
 * The Vite dev server the pages load from under `npm run dev`, or `null`.
 * Never in an installed app (audit S7): a packaged Walder started from a
 * shell that happens to export this would otherwise load its pages, preload
 * bridge and all, from whatever server the variable names.
 */
export function devServerUrl(): string | null {
  const devServer = process.env['ELECTRON_RENDERER_URL'];
  // `app?.`: unit tests mock `electron` without an `app`; that is a dev run.
  return app?.isPackaged !== true && devServer !== undefined && devServer !== '' ? devServer : null;
}

/**
 * Refuse in-window navigation away from the page we loaded. The renderer holds
 * the preload bridge, so replacing its document with remote content would hand
 * that bridge to whatever loaded.
 *
 * The blocked URL is dropped, not handed to the OS browser. There is no
 * legitimate link in these windows, so a navigation attempt is either a bug or
 * a compromised renderer, and `shell.openExternal` on a URL that a compromised
 * renderer chose is a way out of the sandbox and into whatever handles that
 * scheme. Log it and stay put. `where` names the window in that log line
 * (`''` for the overlay, `' in the hover panel'`).
 */
export function lockNavigation(win: BrowserWindow, allowedUrl: string, where = ''): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.webContents.on('will-navigate', (event, url) => {
    if (url === allowedUrl) return;
    event.preventDefault();
    warn(`blocked in-window navigation${where} to`, url);
  });
}

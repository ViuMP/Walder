/**
 * Walder — main process. M2a placeholder: one window that loads a renderer page
 * and nothing else. The transparent, always-on-top, click-through mascot window
 * (and the tray, panel and providers) land in later stages.
 */
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, shell } from 'electron';

/** Which renderer page to open. `npm run sprites` sets this to 'sprites-dev'. */
const PAGES = ['overlay', 'panel', 'sprites-dev'] as const;
type Page = (typeof PAGES)[number];

function requestedPage(): Page {
  const raw = process.env['WALDER_PAGE'];
  return (PAGES as readonly string[]).includes(raw ?? '') ? (raw as Page) : 'overlay';
}

const PRELOAD = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));

/**
 * Only ever one Walder. A mascot is a singleton by nature — two overlays would
 * fight over the same screen corner, double every provider poll and bark twice
 * about the same threshold. The lock must be requested before `whenReady`, so
 * the second copy exits before it can build a window.
 */
const gotTheLock = app.requestSingleInstanceLock();

/** Parse a URL's protocol without throwing on garbage input. */
function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

/**
 * Refuse in-window navigation away from the page we loaded.
 *
 * The renderer is a local file under a strict CSP, but a stray link, a
 * `window.location` assignment or (later) a dropped URL would replace it with
 * remote content that then inherits this window's preload bridge. Real
 * external URLs are handed to the OS browser instead; `window.open` is denied
 * outright, since nothing in Walder legitimately opens a second window.
 */
function lockNavigation(win: BrowserWindow, allowedUrl: string): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.webContents.on('will-navigate', (event, url) => {
    if (url === allowedUrl) return;
    event.preventDefault();
    if (/^https?:$/.test(safeProtocol(url))) void shell.openExternal(url);
  });
}

function createWindow(): BrowserWindow {
  const page = requestedPage();

  const win = new BrowserWindow({
    width: 360,
    height: 320,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  });

  win.once('ready-to-show', () => win.show());

  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (devServer) {
    const url = `${devServer}/${page}.html`;
    lockNavigation(win, url);
    void win.loadURL(url);
  } else {
    const pageUrl = new URL(`../renderer/${page}.html`, import.meta.url);
    // `will-navigate` reports a file:// URL, not the path `loadFile` was given.
    lockNavigation(win, pageUrl.href);
    void win.loadFile(fileURLToPath(pageUrl));
  }

  return win;
}

if (!gotTheLock) {
  app.quit();
} else {
  // A second launch attempt: surface the copy that is already running.
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win === undefined) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  void app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

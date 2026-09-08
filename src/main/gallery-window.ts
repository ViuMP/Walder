/**
 * The animation gallery window — `npm run sprites`.
 *
 * This is the page the owner approves the *motion* on. The PNG contact sheets
 * under `art/out/` show every frame, but a contact sheet cannot show whether the
 * idle breathe is too fast, whether the tail wag reads as a wag, or whether the
 * hop lands. Only the thing playing at the real frame durations can, and until
 * now the only way to see that was to run the whole app and wait for the mascot
 * to happen to do it.
 *
 * So: an ordinary window. Titled, resizable, in the Dock, 1100x800 — everything
 * the overlay deliberately is not. That is also why the gallery cannot simply be
 * a second page in the running app: since M3 the main process is a single-purpose
 * overlay host (transparent, frameless, click-through, no Dock icon), and a
 * gallery in a click-through window that cannot be focused or scrolled would be
 * useless.
 *
 * `WALDER_GALLERY=1` therefore replaces the whole app rather than adding to it —
 * see `index.ts`. No tray, no poller, no login windows, no hook server, no store:
 * nothing that could poll a provider or write a setting while the owner is
 * reviewing artwork.
 *
 * **No preload, and no IPC.** The page reads the sheet itself, as a static import
 * of the same `src/sprites/walder.json` the app draws (`chooseSheetSource` is
 * shared, so it is the same choice, not a second opinion). That leaves this
 * window with no bridge into the main process at all, which for a dev tool is
 * both simpler and strictly safer than granting it one.
 */
import { BrowserWindow } from 'electron';
import { vlog } from './log';

/** Big enough to show several animation cards at 4x without scrolling sideways. */
export const GALLERY_WIDTH = 1_100;
export const GALLERY_HEIGHT = 800;

/**
 * The env var that turns this run into a gallery run. Set by `scripts/sprites.ts`
 * rather than typed by hand, so it works the same on macOS and Windows.
 */
export const GALLERY_ENV = 'WALDER_GALLERY';

/** Is this a gallery run? */
export function galleryRequested(env: Record<string, string | undefined> = process.env): boolean {
  return env[GALLERY_ENV] === '1';
}

function pageUrl(): string {
  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (devServer !== undefined && devServer !== '') return `${devServer}/sprites-dev.html`;
  return new URL('../renderer/sprites-dev.html', import.meta.url).href;
}

/** Open the gallery. Returns the window so the caller can quit when it closes. */
export function openGallery(): BrowserWindow {
  const win = new BrowserWindow({
    width: GALLERY_WIDTH,
    height: GALLERY_HEIGHT,
    title: 'Walder — animation gallery',
    show: false,
    backgroundColor: '#1b1714',
    webPreferences: {
      // Deliberately no preload: the page needs nothing from the main process.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  });

  // Same locks the overlay has. The page is local and static, but a dev tool
  // that could be navigated somewhere is still a window with no reason to be.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  void win.loadURL(pageUrl());
  vlog('gallery window opened', `${GALLERY_WIDTH}x${GALLERY_HEIGHT}`);
  return win;
}

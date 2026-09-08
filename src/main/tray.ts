/**
 * The tray / menu-bar icon — the app's only user interface.
 *
 * Walder has no dock icon, no window chrome and no settings dialog, so this menu
 * is the whole of it: size, colour, launch at login, the two escape hatches
 * (reset position, force interactive), and Quit. It is also what the dog's own
 * right-click opens (via `menu:open`), which is why the `Tray` handle is kept and
 * the menu is rebuilt on every change — `Menu` items cache their checked state at
 * build time, so radio and checkbox marks would go stale otherwise.
 *
 * The overlay is reached through `deps.getOverlay()` on every click, never
 * captured: `ensureOverlay` in `index.ts` can replace the window (macOS
 * `activate`, a renderer crash) without rebuilding the tray, and a captured
 * handle would then point at a destroyed window — every menu action silently
 * doing nothing, with no error anywhere.
 */
import { Menu, Tray, app, nativeImage } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import type { Overlay } from './overlay-window';
import { SCALE_BY_SIZE, SIZE_NAMES, type SizeName } from './ipc';
import { CH } from './ipc';
import { resolvePalette } from './sheet';
import type { SpriteSheet } from '../sprites/types';
import { applyLaunchAtLogin, launchAtLoginState, readSize, type WalderStore } from './store';
import { vlog, warn } from './log';

/** Coat variants offered in the menu, in menu order. */
const PALETTES: readonly { id: string; label: string }[] = [
  { id: 'golden', label: 'Golden' },
  { id: 'red', label: 'Red' },
  { id: 'cream', label: 'Cream' },
  { id: 'black-and-tan', label: 'Black and tan' },
  { id: 'chocolate', label: 'Chocolate' }
];

const SIZE_LABELS: Readonly<Record<SizeName, string>> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large'
};

export interface TrayDeps {
  /**
   * Resolved on every click, not captured: the overlay window can be rebuilt
   * under a tray that is not. `null` means there is momentarily no window.
   */
  readonly getOverlay: () => Overlay | null;
  readonly store: WalderStore;
  readonly sheet: SpriteSheet;
  readonly onQuit: () => void;
}

/**
 * Load the generated tray icon for this platform.
 *
 * macOS wants a *template* image: shape in the alpha channel, drawn black, and
 * tinted by the system so it works on a light or dark menu bar. Windows and Linux
 * do no such tinting — a black-on-alpha icon there is invisible on the usual dark
 * taskbar — so they get the light variant, a white bone with a dark outline that
 * reads on either background.
 *
 * `app.getAppPath()` is the project root in dev and the asar root when packaged,
 * and `nativeImage` reads straight out of an asar, so one path covers both.
 * Electron picks up the `@2x` companion automatically.
 */
function loadIcon(): Electron.NativeImage {
  const isMac = process.platform === 'darwin';
  const name = isMac ? 'trayTemplate.png' : 'tray-win.png';
  const file = join(app.getAppPath(), 'build', name);
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) {
    warn(`tray icon missing or unreadable at ${file} — run "npm run gen:tray"`);
    return image;
  }
  if (isMac) image.setTemplateImage(true);
  return image;
}

export function createTray(deps: TrayDeps): Tray {
  const { getOverlay, store, sheet, onQuit } = deps;

  /**
   * The live overlay, or `null` with a log line. Every menu action goes through
   * this, so a rebuilt (or momentarily missing) window cannot turn the menu into
   * a set of buttons that quietly do nothing.
   */
  function overlayOrWarn(action: string): Overlay | null {
    const overlay = getOverlay();
    if (overlay === null || overlay.win.isDestroyed()) {
      warn(`tray "${action}" ignored: no overlay window`);
      return null;
    }
    return overlay;
  }

  const icon = loadIcon();
  const tray = new Tray(icon);
  tray.setToolTip('Walder');
  if (icon.isEmpty() && process.platform === 'darwin') {
    // Without this the menu bar would show nothing clickable at all.
    tray.setTitle('W');
  }

  function applySize(size: SizeName): void {
    // The preference is stored even if the window has gone: the next one to be
    // built reads it, so the click is never simply lost.
    store.set('size', size);
    const scale = SCALE_BY_SIZE[size];
    const overlay = overlayOrWarn('Size');
    if (overlay !== null) {
      overlay.applySize(scale);
      overlay.send(CH.modeSet, overlay.currentMode());
    }
    vlog('size ->', size, 'scale', scale);
    refresh();
  }

  function applyPalette(name: string): void {
    store.set('palette', name);
    overlayOrWarn('Colour')?.send(CH.paletteSet, resolvePalette(sheet, name));
    vlog('palette ->', name);
    refresh();
  }

  function applyLaunch(on: boolean): void {
    store.set('launchAtLogin', on);
    applyLaunchAtLogin(on);
    refresh();
  }

  function applyForceInteractive(on: boolean): void {
    store.set('forceInteractive', on);
    overlayOrWarn('Force interactive')?.setForceInteractive(on);
    refresh();
  }

  function applyResetPosition(): void {
    overlayOrWarn('Reset position')?.resetPosition();
  }

  function buildMenu(): Menu {
    const currentSize = readSize(store);
    const currentPalette = store.get('palette');
    const launch = launchAtLoginState(store);

    const sizeItems: MenuItemConstructorOptions[] = SIZE_NAMES.map((size) => ({
      label: SIZE_LABELS[size],
      type: 'radio',
      checked: size === currentSize,
      click: () => applySize(size)
    }));

    const paletteItems: MenuItemConstructorOptions[] = PALETTES.map(({ id, label }) => ({
      label,
      type: 'radio',
      checked: id === currentPalette,
      click: () => applyPalette(id)
    }));

    return Menu.buildFromTemplate([
      { label: 'Walder', enabled: false },
      { type: 'separator' },
      { label: 'Size', submenu: sizeItems },
      { label: 'Colour', submenu: paletteItems },
      {
        // Reflects the OS when there is an OS setting to reflect (the user can
        // remove the login item in System Settings); disabled in an unpackaged
        // dev run, where the login-item API cannot work at all.
        label: launch.editable ? 'Launch at login' : 'Launch at login (packaged app only)',
        type: 'checkbox',
        enabled: launch.editable,
        checked: launch.on,
        click: (item) => applyLaunch(item.checked)
      },
      { type: 'separator' },
      // The escape hatch for a dog that cannot be reached with the mouse — on a
      // monitor that is gone, or dragged somewhere a drag cannot undo.
      { label: 'Reset position', click: applyResetPosition },
      {
        label: 'Force interactive (debug)',
        type: 'checkbox',
        checked: store.get('forceInteractive') === true,
        click: (item) => applyForceInteractive(item.checked)
      },
      { type: 'separator' },
      { label: 'Quit', click: onQuit }
    ]);
  }

  /** Rebuild so radio dots and checkmarks reflect the store. */
  function refresh(): void {
    tray.setContextMenu(buildMenu());
  }

  refresh();

  // Left-clicking the icon opens the same menu — there is no other UI to show.
  tray.on('click', () => tray.popUpContextMenu());

  return tray;
}

/** Read the persisted size as a scale, for the initial window. */
export function initialScale(store: WalderStore): number {
  return SCALE_BY_SIZE[readSize(store)];
}

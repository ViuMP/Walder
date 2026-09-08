/**
 * The tray menu — the app's only user interface.
 *
 * The bug this exists to prevent: the menu used to capture the `Overlay` handle
 * once, at construction. `ensureOverlay` in `index.ts` can replace the overlay
 * window (macOS `activate`, a renderer crash) *without* rebuilding the tray, and
 * from that moment every menu item drove a destroyed window — size, colour and
 * the escape hatch all silently doing nothing, with no error printed anywhere.
 * The fix is `getOverlay()` resolved per click, and the tests below assert that
 * by swapping the overlay behind a menu template that was already built.
 *
 * `electron` is mocked: `Menu.buildFromTemplate` records the template, so the
 * items can be clicked without a running app.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import type { WalderSettings, WalderStore } from '../src/main/store';
import type { Overlay } from '../src/main/overlay-window';

const host = vi.hoisted(() => ({
  /** Every menu template built, in order; the last is the live one. */
  templates: [] as unknown[][],
  /** Path each `nativeImage.createFromPath` was given. */
  iconPaths: [] as string[],
  /** Arguments each `setTemplateImage` call received. */
  templateImage: [] as boolean[],
  iconEmpty: false,
  isPackaged: false,
  openAtLogin: false,
  trayTitles: [] as string[],
  popUps: 0
}));

vi.mock('electron-store', () => ({ default: class {} }));

vi.mock('electron', () => {
  class FakeTray {
    setToolTip(): void {}
    setTitle(title: string): void {
      host.trayTitles.push(title);
    }
    setContextMenu(): void {}
    on(): void {}
    popUpContextMenu(): void {
      host.popUps++;
    }
    isDestroyed(): boolean {
      return false;
    }
  }

  return {
    Tray: FakeTray,
    Menu: {
      buildFromTemplate: (template: unknown[]) => {
        host.templates.push(template);
        return { template };
      }
    },
    app: {
      getAppPath: () => '/app',
      get isPackaged(): boolean {
        return host.isPackaged;
      },
      getLoginItemSettings: () => ({ openAtLogin: host.openAtLogin }),
      setLoginItemSettings: () => {},
      getPath: () => '/tmp/walder-test'
    },
    nativeImage: {
      createFromPath: (file: string) => {
        host.iconPaths.push(file);
        return {
          isEmpty: () => host.iconEmpty,
          setTemplateImage: (on: boolean) => {
            host.templateImage.push(on);
          }
        };
      }
    },
    screen: {
      getAllDisplays: () => [],
      getPrimaryDisplay: () => ({
        id: 1,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 25, width: 1440, height: 875 }
      }),
      getDisplayNearestPoint: () => ({
        id: 1,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 25, width: 1440, height: 875 }
      })
    }
  };
});

const { createTray, initialScale } = await import('../src/main/tray');
const { DEFAULTS } = await import('../src/main/store');
const { loadSheet } = await import('../src/main/sheet');
const { CH } = await import('../src/main/ipc');

const sheet = loadSheet();

function fakeStore(overrides: Partial<WalderSettings> = {}): WalderStore {
  const data: Record<string, unknown> = { ...DEFAULTS, ...overrides };
  return {
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => {
      data[key] = value;
    },
    path: '/tmp/walder-test/walder.json'
  } as unknown as WalderStore;
}

function read(store: WalderStore, key: string): unknown {
  return (store as unknown as { get: (k: string) => unknown }).get(key);
}

interface Spy {
  readonly overlay: Overlay;
  readonly calls: string[];
  destroyed: boolean;
}

/** An `Overlay` that records which of its methods the menu reached for. */
function spyOverlay(): Spy {
  const calls: string[] = [];
  const spy = {
    calls,
    destroyed: false
  } as unknown as Spy;
  const overlay = {
    win: { isDestroyed: () => spy.destroyed },
    applySize: (scale: number) => calls.push(`applySize:${scale}`),
    setInteractive: () => calls.push('setInteractive'),
    setForceInteractive: (on: boolean) => calls.push(`setForceInteractive:${String(on)}`),
    resetPosition: () => calls.push('resetPosition'),
    dragStart: () => calls.push('dragStart'),
    dragMove: () => calls.push('dragMove'),
    dragEnd: () => calls.push('dragEnd'),
    isDragging: () => false,
    currentMode: () => ({ scale: 3, box: 'stand' as const }),
    send: (channel: string) => calls.push(`send:${channel}`)
  } as unknown as Overlay;
  (spy as { overlay: Overlay }).overlay = overlay;
  return spy;
}

/** The menu template most recently built. */
function template(): MenuItemConstructorOptions[] {
  const last = host.templates.at(-1);
  if (last === undefined) throw new Error('no menu template was built');
  return last as MenuItemConstructorOptions[];
}

function item(label: string, items = template()): MenuItemConstructorOptions {
  const found = items.find((entry) => entry.label === label);
  if (found === undefined) {
    throw new Error(`no menu item "${label}" in ${items.map((i) => i.label).join(' | ')}`);
  }
  return found;
}

function submenu(label: string): MenuItemConstructorOptions[] {
  const parent = item(label);
  return (parent.submenu ?? []) as MenuItemConstructorOptions[];
}

/** Click an item the way Electron does: it passes the (already toggled) MenuItem. */
function click(entry: MenuItemConstructorOptions, checked = false): void {
  const handler = entry.click;
  if (handler === undefined) throw new Error(`item "${String(entry.label)}" has no click handler`);
  (handler as unknown as (item: { checked: boolean }) => void)({ checked });
}

beforeEach(() => {
  host.templates = [];
  host.iconPaths = [];
  host.templateImage = [];
  host.trayTitles = [];
  host.popUps = 0;
  host.iconEmpty = false;
  host.isPackaged = false;
  host.openAtLogin = false;
});

describe('the overlay is resolved per click, not captured', () => {
  it('drives whichever overlay is current when the item is clicked', () => {
    // This is the regression. The template is built once, at construction; the
    // overlay is then replaced (as `ensureOverlay` does) and the *same* menu
    // item must reach the new window.
    const first = spyOverlay();
    const second = spyOverlay();
    let live: Overlay | null = first.overlay;

    createTray({
      getOverlay: () => live,
      store: fakeStore(),
      sheet,
      onQuit: () => {}
    });

    const reset = item('Reset position');
    click(reset);
    expect(first.calls).toEqual(['resetPosition']);

    live = second.overlay;
    click(reset);
    expect(first.calls).toEqual(['resetPosition']); // untouched
    expect(second.calls).toEqual(['resetPosition']);
  });

  it('reaches the current overlay from every action, not just one', () => {
    const first = spyOverlay();
    const second = spyOverlay();
    let live: Overlay | null = first.overlay;
    const store = fakeStore();

    createTray({ getOverlay: () => live, store, sheet, onQuit: () => {} });

    const size = submenu('Size');
    const colour = submenu('Colour');
    const force = item('Force interactive (debug)');

    live = second.overlay;
    click(item('Large', size));
    click(item('Red', colour));
    click(force, true);
    click(item('Reset position'));

    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual([
      'applySize:4',
      `send:${CH.modeSet}`,
      `send:${CH.paletteSet}`,
      'setForceInteractive:true',
      'resetPosition'
    ]);
  });

  it('survives a null overlay without throwing, and still stores the preference', () => {
    const store = fakeStore();
    createTray({ getOverlay: () => null, store, sheet, onQuit: () => {} });

    expect(() => click(item('Large', submenu('Size')))).not.toThrow();
    expect(() => click(item('Reset position'))).not.toThrow();
    expect(() => click(item('Force interactive (debug)'), true)).not.toThrow();

    // The click is not simply lost: the next window built reads these.
    expect(read(store, 'size')).toBe('large');
    expect(read(store, 'forceInteractive')).toBe(true);
  });

  it('treats a destroyed overlay as absent', () => {
    const spy = spyOverlay();
    spy.destroyed = true;
    createTray({ getOverlay: () => spy.overlay, store: fakeStore(), sheet, onQuit: () => {} });

    click(item('Reset position'));
    expect(spy.calls).toEqual([]);
  });
});

describe('menu shape', () => {
  it('offers Reset position as an escape hatch, next to the debug one', () => {
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {}
    });
    const labels = template().map((entry) => entry.label);
    expect(labels).toContain('Reset position');
    // Grouped with the other recovery item, after a separator.
    expect(labels.indexOf('Reset position')).toBeLessThan(
      labels.indexOf('Force interactive (debug)')
    );
  });

  it('marks the stored size and colour, and re-marks them after a change', () => {
    const store = fakeStore({ size: 'small', palette: 'cream' });
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store,
      sheet,
      onQuit: () => {}
    });

    expect(item('Small', submenu('Size')).checked).toBe(true);
    expect(item('Large', submenu('Size')).checked).toBe(false);
    expect(item('Cream', submenu('Colour')).checked).toBe(true);

    click(item('Large', submenu('Size')));
    // The menu is rebuilt on every change, because MenuItems cache `checked`.
    expect(item('Large', submenu('Size')).checked).toBe(true);
    expect(item('Small', submenu('Size')).checked).toBe(false);
  });

  it('calls onQuit from the Quit item and nothing else', () => {
    let quits = 0;
    const spy = spyOverlay();
    createTray({
      getOverlay: () => spy.overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {
        quits++;
      }
    });
    click(item('Quit'));
    expect(quits).toBe(1);
    expect(spy.calls).toEqual([]);
  });
});

describe('launch at login item', () => {
  it('is disabled and labelled in an unpackaged build', () => {
    host.isPackaged = false;
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore({ launchAtLogin: true }),
      sheet,
      onQuit: () => {}
    });

    const entry = item('Launch at login (packaged app only)');
    expect(entry.enabled).toBe(false);
    expect(entry.checked).toBe(true); // the stored preference, all there is to show
    expect(template().map((e) => e.label)).not.toContain('Launch at login');
  });

  it('is enabled and reflects the OS when packaged', () => {
    // The user can remove the login item in System Settings; the store would lie.
    host.isPackaged = true;
    host.openAtLogin = false;
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore({ launchAtLogin: true }),
      sheet,
      onQuit: () => {}
    });

    const entry = item('Launch at login');
    expect(entry.enabled).toBe(true);
    expect(entry.checked).toBe(false);
  });
});

describe('tray icon', () => {
  it('picks the variant this platform can actually display', () => {
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {}
    });

    const isMac = process.platform === 'darwin';
    const expected = isMac ? 'trayTemplate.png' : 'tray-win.png';
    expect(host.iconPaths).toHaveLength(1);
    expect(host.iconPaths[0]).toBe(`/app/build/${expected}`);
    // `setTemplateImage` is a macOS concept: Windows and Linux do no tinting,
    // which is exactly why they get the light icon instead.
    expect(host.templateImage).toEqual(isMac ? [true] : []);
  });

  it('falls back to a text title on macOS when the icon is missing', () => {
    // Without this there would be nothing clickable in the menu bar at all.
    host.iconEmpty = true;
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {}
    });
    expect(host.trayTitles).toEqual(process.platform === 'darwin' ? ['W'] : []);
  });
});

describe('initialScale', () => {
  it('maps the stored size to the sprite scale', () => {
    expect(initialScale(fakeStore({ size: 'small' }))).toBe(2);
    expect(initialScale(fakeStore({ size: 'medium' }))).toBe(3);
    expect(initialScale(fakeStore({ size: 'large' }))).toBe(4);
  });

  it('falls back to the default for a corrupt stored size', () => {
    expect(initialScale(fakeStore({ size: 'huge' as never }))).toBe(3);
  });
});

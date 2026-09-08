/**
 * Position memory and the login item.
 *
 * These are the two places the main process reads the outside world — `screen`
 * and the OS login-item API — and both have failure modes the owner would feel
 * and could not diagnose: a remembered position that lands the dog on a monitor
 * that is no longer there, or on the external display of a docked laptop rather
 * than the one in front of them; and a login-item write that macOS refuses from
 * an unsigned dev build while the menu cheerfully shows a tick.
 *
 * `electron` is mocked, so this runs under vitest's node environment with no app
 * and no window. `electron-store` is mocked too — `createStore` needs a real
 * userData directory and is not what is being tested; the functions here take a
 * store-shaped object.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalderSettings, WalderStore } from '../src/main/store';

const os = vi.hoisted(() => ({
  displays: [] as { id: number; bounds: unknown; workArea: unknown }[],
  primaryIndex: 0,
  nearestIndex: 0,
  isPackaged: false,
  openAtLogin: false,
  writes: [] as boolean[]
}));

vi.mock('electron-store', () => ({ default: class {} }));

vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return os.isPackaged;
    },
    getLoginItemSettings: () => ({ openAtLogin: os.openAtLogin }),
    setLoginItemSettings: (options: { openAtLogin: boolean }) => {
      os.writes.push(options.openAtLogin);
    },
    getPath: () => '/tmp/walder-test'
  },
  screen: {
    getAllDisplays: () => os.displays,
    getPrimaryDisplay: () => os.displays[os.primaryIndex],
    getDisplayNearestPoint: () => os.displays[os.nearestIndex]
  }
}));

const {
  EDGE_MARGIN,
  applyLaunchAtLogin,
  clampToDisplays,
  defaultPosition,
  displayKey,
  launchAtLoginState,
  readSize,
  resolveStartPosition,
  savePosition
} = await import('../src/main/store');
const { DEFAULTS } = await import('../src/main/store');

/** A display as `screen` reports one: an id, full bounds, and a smaller work area. */
function display(
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
  menuBar = 25
): { id: number; bounds: unknown; workArea: unknown } {
  return {
    id,
    bounds: { x, y, width, height },
    workArea: { x, y: y + menuBar, width, height: height - menuBar }
  };
}

const LAPTOP = display(1, 0, 0, 1440, 900);
const EXTERNAL = display(2, 1440, 0, 1920, 1080, 0);

/** A store-shaped object. Only `get`/`set`/`path` are ever touched. */
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

/** Read a key back off a fake store without fighting electron-store's types. */
function read(store: WalderStore, key: string): unknown {
  return (store as unknown as { get: (k: string) => unknown }).get(key);
}

const WIN = { width: 192, height: 192 };

beforeEach(() => {
  os.displays = [LAPTOP, EXTERNAL];
  os.primaryIndex = 0;
  os.nearestIndex = 0;
  os.isPackaged = false;
  os.openAtLogin = false;
  os.writes = [];
});

describe('displayKey', () => {
  it('combines the id with the display size', () => {
    expect(displayKey(LAPTOP as never)).toBe('1:1440x900');
    expect(displayKey(EXTERNAL as never)).toBe('2:1920x1080');
  });

  it('changes when the resolution changes, even for the same monitor', () => {
    // Deliberate: the same panel at a different resolution is a different
    // canvas, and a corner remembered at 1440x900 is the wrong corner at
    // 1280x800 — possibly off-screen.
    const rescaled = display(1, 0, 0, 1280, 800);
    expect(displayKey(rescaled as never)).not.toBe(displayKey(LAPTOP as never));
    expect(displayKey(rescaled as never)).toBe('1:1280x800');
  });

  it('uses full bounds, not the work area, so a menu bar cannot change it', () => {
    const noMenuBar = display(1, 0, 0, 1440, 900, 0);
    expect(displayKey(noMenuBar as never)).toBe(displayKey(LAPTOP as never));
  });
});

describe('resolveStartPosition', () => {
  it('prefers the primary display when several have a saved position', () => {
    // A docked laptop enumerates the external monitor too; the dog belongs on
    // the screen the owner is looking at.
    const store = fakeStore({
      positions: {
        '1:1440x900': { x: 100, y: 200 },
        '2:1920x1080': { x: 2000, y: 300 }
      }
    });
    expect(resolveStartPosition(store, WIN.width, WIN.height)).toEqual({ x: 100, y: 200 });

    // Make the external display primary and the answer follows it.
    os.primaryIndex = 1;
    expect(resolveStartPosition(store, WIN.width, WIN.height)).toEqual({ x: 2000, y: 300 });
  });

  it('falls back to another attached display when the primary has none saved', () => {
    const store = fakeStore({ positions: { '2:1920x1080': { x: 2000, y: 300 } } });
    expect(resolveStartPosition(store, WIN.width, WIN.height)).toEqual({ x: 2000, y: 300 });
  });

  it('falls back to the primary corner when the saved display is gone', () => {
    // The monitor the dog was on has been unplugged.
    os.displays = [LAPTOP];
    const store = fakeStore({ positions: { '2:1920x1080': { x: 2000, y: 300 } } });
    expect(resolveStartPosition(store, WIN.width, WIN.height)).toEqual(
      defaultPosition(WIN.width, WIN.height)
    );
  });

  it('falls back when the display is attached but its resolution changed', () => {
    const store = fakeStore({ positions: { '1:1280x800': { x: 100, y: 200 } } });
    os.displays = [LAPTOP];
    expect(resolveStartPosition(store, WIN.width, WIN.height)).toEqual(
      defaultPosition(WIN.width, WIN.height)
    );
  });

  it('falls back on a first run with nothing saved at all', () => {
    expect(resolveStartPosition(fakeStore(), WIN.width, WIN.height)).toEqual(
      defaultPosition(WIN.width, WIN.height)
    );
  });

  it('ignores a hand-edited non-finite saved position', () => {
    const store = fakeStore({
      positions: { '1:1440x900': { x: Number.NaN, y: 10 } }
    });
    expect(resolveStartPosition(store, WIN.width, WIN.height)).toEqual(
      defaultPosition(WIN.width, WIN.height)
    );
  });

  it('clamps a saved position that predates a work-area change', () => {
    os.displays = [LAPTOP];
    const store = fakeStore({ positions: { '1:1440x900': { x: -5000, y: -5000 } } });
    const at = resolveStartPosition(store, WIN.width, WIN.height);
    expect(at).toEqual({ x: 0, y: 25 });
  });

  it('applies the ink inset to a saved position when one is given', () => {
    os.displays = [LAPTOP];
    // 30 px of a 192 px window on screen: fine by the window rect, but the
    // first 24 are transparent padding, so the dog is all but invisible.
    const store = fakeStore({ positions: { '1:1440x900': { x: -162, y: 300 } } });
    const inset = { left: 24, right: 24, top: 72, bottom: 0 };
    expect(resolveStartPosition(store, WIN.width, WIN.height)).toEqual({ x: -162, y: 300 });
    expect(resolveStartPosition(store, WIN.width, WIN.height, inset)).toEqual({
      x: -24,
      y: 300
    });
  });
});

describe('defaultPosition', () => {
  it('is the bottom-right of the primary work area, inset by the margin', () => {
    expect(defaultPosition(WIN.width, WIN.height)).toEqual({
      x: 1440 - 192 - EDGE_MARGIN,
      y: 25 + 875 - 192 - EDGE_MARGIN
    });
  });

  it('follows the primary display, not the first one enumerated', () => {
    os.primaryIndex = 1;
    expect(defaultPosition(WIN.width, WIN.height)).toEqual({
      x: 1440 + 1920 - 192 - EDGE_MARGIN,
      y: 1080 - 192 - EDGE_MARGIN
    });
  });
});

describe('savePosition', () => {
  it('files the position under the display the window centre is on', () => {
    const store = fakeStore();
    os.nearestIndex = 1;
    savePosition(store, { x: 2000, y: 300, width: 192, height: 192 });
    expect(read(store, 'positions')).toEqual({ '2:1920x1080': { x: 2000, y: 300 } });
  });

  it('rounds, and keeps positions for displays that are not attached', () => {
    const store = fakeStore({ positions: { '2:1920x1080': { x: 2000, y: 300 } } });
    savePosition(store, { x: 100.6, y: 200.4, width: 192, height: 192 });
    expect(read(store, 'positions')).toEqual({
      '1:1440x900': { x: 101, y: 200 },
      '2:1920x1080': { x: 2000, y: 300 }
    });
  });
});

describe('clampToDisplays', () => {
  it('reads the live work areas', () => {
    os.displays = [LAPTOP];
    expect(clampToDisplays({ x: -5000, y: -5000, width: 192, height: 192 })).toEqual({
      x: 0,
      y: 25
    });
  });

  it('passes the inset through', () => {
    os.displays = [LAPTOP];
    const rect = { x: -162, y: 300, width: 192, height: 192 };
    expect(clampToDisplays(rect)).toEqual({ x: -162, y: 300 });
    expect(clampToDisplays(rect, { left: 24, right: 24, top: 72, bottom: 0 })).toEqual({
      x: -24,
      y: 300
    });
  });
});

describe('launch at login', () => {
  it('is not editable, and reads the store, in an unpackaged build', () => {
    // `npm run dev`: there is no login item to reflect, and the menu shows the
    // item disabled rather than offering a tick that cannot take effect.
    os.isPackaged = false;
    os.openAtLogin = true;
    expect(launchAtLoginState(fakeStore({ launchAtLogin: false }))).toEqual({
      on: false,
      editable: false
    });
    expect(launchAtLoginState(fakeStore({ launchAtLogin: true }))).toEqual({
      on: true,
      editable: false
    });
  });

  it('reflects the OS, not the store, when packaged', () => {
    // The user can remove the login item in System Settings; a checkbox reading
    // the store would then be a lie.
    os.isPackaged = true;
    os.openAtLogin = false;
    expect(launchAtLoginState(fakeStore({ launchAtLogin: true }))).toEqual({
      on: false,
      editable: true
    });
    os.openAtLogin = true;
    expect(launchAtLoginState(fakeStore({ launchAtLogin: false }))).toEqual({
      on: true,
      editable: true
    });
  });

  it('writes nothing at all from an unpackaged build', () => {
    // macOS refuses the write from an unsigned dev build and Electron logs it as
    // a native ERROR line, which would appear on every dev run.
    os.isPackaged = false;
    applyLaunchAtLogin(true);
    applyLaunchAtLogin(false);
    expect(os.writes).toEqual([]);
  });

  it('writes only when the OS disagrees, when packaged', () => {
    os.isPackaged = true;
    os.openAtLogin = false;

    applyLaunchAtLogin(false);
    expect(os.writes).toEqual([]); // already off: no write, no error line

    applyLaunchAtLogin(true);
    expect(os.writes).toEqual([true]);
  });

  it('re-applies a stored true that the user removed in System Settings', () => {
    os.isPackaged = true;
    os.openAtLogin = false;
    applyLaunchAtLogin(true);
    expect(os.writes).toEqual([true]);
  });
});

describe('readSize', () => {
  it('passes a valid size through', () => {
    expect(readSize(fakeStore({ size: 'large' }))).toBe('large');
  });

  it('falls back to the default for a value the schema somehow let through', () => {
    expect(readSize(fakeStore({ size: 'enormous' as never }))).toBe(DEFAULTS.size);
    expect(readSize(fakeStore({ size: undefined as never }))).toBe(DEFAULTS.size);
  });
});

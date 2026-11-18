/**
 * The Walder window's IPC and its preload.
 *
 *  - main answers the window's four channels only for the window's own page,
 *    so the overlay, the card or anything else gets nothing back and can write
 *    nothing;
 *  - a set request reaches the settings writer, which refuses app state;
 *  - the preload exposes exactly four calls, on exactly those channels.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: unknown }, raw?: unknown) => unknown>(),
  windows: [] as { webContents: object; destroyed: boolean }[],
  exposed: new Map<string, Record<string, unknown>>(),
  invoked: [] as unknown[][]
}));

vi.mock('electron', () => {
  class FakeBrowserWindow {
    webContents = { on: () => {}, setWindowOpenHandler: () => {}, send: () => {} };
    destroyed = false;
    constructor() {
      host.windows.push(this);
    }
    setMenuBarVisibility(): void {}
    removeMenu(): void {}
    once(): void {}
    on(): void {}
    loadURL(): Promise<void> {
      return Promise.resolve();
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isMinimized(): boolean {
      return false;
    }
    show(): void {}
    focus(): void {}
  }
  return {
    BrowserWindow: FakeBrowserWindow,
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
    app: { isPackaged: false, getVersion: () => '0.0.0-test', focus: () => {} },
    ipcMain: {
      handle: (channel: string, listener: (event: { sender: unknown }, raw?: unknown) => unknown) =>
        host.handlers.set(channel, listener)
    },
    contextBridge: {
      exposeInMainWorld: (name: string, api: Record<string, unknown>) => host.exposed.set(name, api)
    },
    ipcRenderer: {
      invoke: (...args: unknown[]) => {
        host.invoked.push(args);
        return Promise.resolve(null);
      },
      on: () => {},
      removeListener: () => {}
    }
  };
});

const { createSettingsWindow } = await import('../src/main/settings-window');
const { SETTINGS_CH } = await import('../src/main/settings-ipc');

const sets: [string, unknown][] = [];
const fakeSettings = {
  snapshot: () => ({ size: 'medium' }),
  locked: () => ({}),
  get: () => undefined,
  onChange: () => () => {},
  set: (key: string, value: unknown) => {
    sets.push([key, value]);
    return key === 'positions'
      ? { ok: false as const, error: '"positions" is not a setting.' }
      : { ok: true as const, value, saved: true };
  }
};

function makeWindow() {
  const window = createSettingsWindow({
    settings: fakeSettings as never,
    palettes: () => ['golden'],
    shortcutStatus: () => 'registered',
    usage: () => null,
    sessions: () => [],
    creditPrice: () => null,
    refreshNow: () => []
  });
  window.open();
  const own = host.windows.at(-1) as { webContents: object };
  return { window, own: { sender: own.webContents }, foreign: { sender: {} } };
}

const call = (channel: string, event: { sender: unknown }, raw?: unknown): unknown =>
  host.handlers.get(channel)?.(event, raw);

beforeEach(() => {
  sets.length = 0;
  host.handlers.clear();
  host.windows.length = 0;
});

describe('the Walder window IPC', () => {
  it('answers its own page', () => {
    const { own } = makeWindow();
    expect(call(SETTINGS_CH.get, own)).toMatchObject({ settings: { size: 'medium' }, version: '0.0.0-test' });
    expect(call(SETTINGS_CH.set, own, { key: 'size', value: 'large' })).toMatchObject({ ok: true, saved: true });
    expect(call(SETTINGS_CH.refresh, own)).toEqual([]);
    expect(sets).toEqual([['size', 'large']]);
  });

  it('answers nothing to any other page, and writes nothing for it', () => {
    const { foreign } = makeWindow();
    expect(call(SETTINGS_CH.get, foreign)).toBeNull();
    expect(call(SETTINGS_CH.set, foreign, { key: 'size', value: 'large' })).toBeNull();
    expect(call(SETTINGS_CH.refresh, foreign)).toBe(null);
    expect(sets).toEqual([]);
  });

  it('passes app state to the writer, which refuses it, and drops a malformed request', () => {
    const { own } = makeWindow();
    expect(call(SETTINGS_CH.set, own, { key: 'positions', value: {} })).toMatchObject({ ok: false });
    expect(call(SETTINGS_CH.set, own, 'size=large')).toMatchObject({ ok: false, error: 'Malformed request.' });
    expect(call(SETTINGS_CH.set, own, { key: 'x'.repeat(65), value: 1 })).toMatchObject({ ok: false });
    expect(sets).toEqual([['positions', {}]]);
  });
});

describe('the Walder window preload', () => {
  it('exposes exactly four calls, on the window channels', async () => {
    await import('../src/preload/settings');
    const api = host.exposed.get('walderSettings');
    expect(Object.keys(api ?? {}).sort()).toEqual(['get', 'onChanged', 'refresh', 'set']);
    await (api?.['get'] as () => Promise<unknown>)();
    await (api?.['set'] as (k: string, v: unknown) => Promise<unknown>)('size', 'large');
    await (api?.['refresh'] as () => Promise<unknown>)();
    expect(host.invoked).toEqual([
      [SETTINGS_CH.get],
      [SETTINGS_CH.set, { key: 'size', value: 'large' }],
      [SETTINGS_CH.refresh]
    ]);
  });
});

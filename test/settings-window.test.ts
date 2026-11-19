/**
 * The Walder window's IPC and its preload.
 *
 *  - main answers the window's five channels only for the window's own page,
 *    so the overlay, the card or anything else gets nothing back and can write
 *    nothing;
 *  - a set request reaches the settings writer, which refuses app state;
 *  - the preview call hands back every coat's idle frame and colours, with
 *    Yuna's coats as the cat and every other coat (silver dapple too) as the dog;
 *  - the preload exposes exactly five calls, on exactly those channels;
 *  - on macOS Cmd-W closes the window (the Window menu role has no Close),
 *    and no other key does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: unknown }, raw?: unknown) => unknown>(),
  windows: [] as { webContents: object; destroyed: boolean; closed: number }[],
  inputListeners: [] as ((event: { preventDefault: () => void }, input: object) => void)[],
  exposed: new Map<string, Record<string, unknown>>(),
  invoked: [] as unknown[][]
}));

vi.mock('electron', () => {
  class FakeBrowserWindow {
    webContents = {
      on: (name: string, listener: (event: { preventDefault: () => void }, input: object) => void) => {
        if (name === 'before-input-event') host.inputListeners.push(listener);
      },
      setWindowOpenHandler: () => {},
      send: () => {}
    };
    destroyed = false;
    closed = 0;
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
    close(): void {
      this.closed += 1;
    }
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

const { createSettingsWindow, isCloseShortcut } = await import('../src/main/settings-window');
const { SETTINGS_CH } = await import('../src/main/settings-ipc');
const { coatPreviews, loadSheet } = await import('../src/main/sheet');
const sheet = loadSheet();

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
    refreshNow: () => [],
    previews: () => coatPreviews(sheet)
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
  host.inputListeners.length = 0;
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
    expect(call(SETTINGS_CH.previews, foreign)).toBeNull();
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

describe('the Walder window previews', () => {
  type Preview = { id: string; character: string; rows: string[]; colors: Record<string, string> };
  const previews = (): Preview[] => call(SETTINGS_CH.previews, makeWindow().own) as Preview[];

  it('hand back a frame and its colours for every coat in the sheet', () => {
    const list = previews();
    expect(list.map((p) => p.id)).toEqual(Object.keys(sheet.palettes));
    for (const preview of list) {
      expect(preview.rows.length, preview.id).toBeGreaterThan(0);
      for (const ch of new Set(preview.rows.join('').replace(/\./g, ''))) {
        expect(preview.colors[ch], `${preview.id} ${ch}`).toMatch(/^#/);
      }
    }
  });

  it("mark Yuna's coats as the cat and every other coat, silver dapple too, as the dog", () => {
    const character = Object.fromEntries(previews().map((p) => [p.id, p.character]));
    expect(character['silver-dapple']).toBe('walder');
    expect(character['golden']).toBe('walder');
    for (const [id, who] of Object.entries(character)) {
      expect(who, id).toBe(id.startsWith('yuna-') ? 'yuna' : 'walder');
    }
    expect(Object.values(character)).toContain('yuna');
  });
});

describe('the Walder window preload', () => {
  it('exposes exactly five calls, on the window channels', async () => {
    await import('../src/preload/settings');
    const api = host.exposed.get('walderSettings');
    expect(Object.keys(api ?? {}).sort()).toEqual(['get', 'onChanged', 'previews', 'refresh', 'set']);
    await (api!['get'] as () => Promise<unknown>)();
    await (api!['set'] as (k: string, v: unknown) => Promise<unknown>)('size', 'large');
    await (api!['refresh'] as () => Promise<unknown>)();
    await (api!['previews'] as () => Promise<unknown>)();
    expect(host.invoked).toEqual([
      [SETTINGS_CH.get],
      [SETTINGS_CH.set, { key: 'size', value: 'large' }],
      [SETTINGS_CH.refresh],
      [SETTINGS_CH.previews]
    ]);
  });
});

describe('the Walder window close shortcut', () => {
  const key = (over: Partial<Parameters<typeof isCloseShortcut>[0]> = {}) => ({
    type: 'keyDown',
    key: 'w',
    meta: true,
    control: false,
    alt: false,
    shift: false,
    ...over
  });

  it('is Cmd-W alone, on the key going down', () => {
    expect(isCloseShortcut(key())).toBe(true);
    expect(isCloseShortcut(key({ key: 'W' }))).toBe(true);
    expect(isCloseShortcut(key({ type: 'keyUp' }))).toBe(false);
    expect(isCloseShortcut(key({ meta: false }))).toBe(false);
    expect(isCloseShortcut(key({ shift: true }))).toBe(false);
    expect(isCloseShortcut(key({ alt: true }))).toBe(false);
    expect(isCloseShortcut(key({ control: true }))).toBe(false);
    // The Edit menu's keys stay with the Edit menu.
    for (const other of ['c', 'v', 'x', 'a', 'z', 'q']) expect(isCloseShortcut(key({ key: other })), other).toBe(false);
  });

  it('closes the window on macOS and lets every other key through', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      makeWindow();
    } finally {
      Object.defineProperty(process, 'platform', platform!);
    }
    const own = host.windows.at(-1)!;
    expect(host.inputListeners).toHaveLength(1);
    const press = (input: object): boolean => {
      let prevented = false;
      host.inputListeners[0]!({ preventDefault: () => (prevented = true) }, input);
      return prevented;
    };
    expect(press(key({ key: 'c' }))).toBe(false);
    expect(press(key({ key: 'a' }))).toBe(false);
    expect(own.closed).toBe(0);
    expect(press(key())).toBe(true);
    expect(own.closed).toBe(1);
  });
});

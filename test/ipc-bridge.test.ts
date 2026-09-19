/**
 * The sender check on every renderer -> main channel.
 *
 * `ipc-payloads.test.ts` already pins the validators; what is only testable here
 * is the *other* half of the rule at the top of `ipc-bridge.ts` — which window
 * is allowed to say which thing — and it is the half with no visible symptom
 * when it breaks. Every handler is registered on a process-wide `ipcMain`, so a
 * missing `fromOverlay` guard does not fail, does not warn, and does not look
 * wrong in review: it just means any `webContents` in the process (a login
 * window that later grows a preload, a devtools extension, a `<webview>`) can
 * drag the dog, open the tray menu, or — the one that matters — invoke
 * `auth:login` and put a real login page on screen.
 *
 * So each channel is exercised from three distinct senders, and the bug this
 * file exists to prevent is a channel that accepts one it should not:
 *  - the overlay-only channels must refuse the *panel*, not merely strangers,
 *    because the panel is a real app window and the sloppy guard ("is this one
 *    of ours") would let it through;
 *  - `panel:size` must refuse the overlay, and must refuse the panel once its
 *    window is destroyed — the point at which `webContents` identity is stale;
 *  - the either-window channels must still refuse a foreign sender, and must
 *    return the *refusal* value (`null`, `false`) rather than falling through;
 *  - a refusal must warn, since a silent drop is indistinguishable from a
 *    renderer that never sent;
 *  - and `unregisterIpc()` must remove exactly the set that was registered, or
 *    a macOS `activate` rebuild leaves a handler bound to the dead overlay.
 */
import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { IpcMainInvokeEvent, Tray } from 'electron';
import type { ModePayload } from '../src/main/ipc';
import type { Overlay } from '../src/main/overlay-window';
import type { HoverPanel } from '../src/main/hover-panel';
import type { WalderStore } from '../src/main/store';

const host = vi.hoisted(() => ({
  /** Every `ipcMain.handle` registration, by channel. */
  handlers: new Map<string, (event: unknown, payload?: unknown) => unknown>(),
  /** Every channel `ipcMain.removeHandler` was called with, in order. */
  removed: [] as string[]
}));

vi.mock('electron-store', () => ({ default: class {} }));

vi.mock('electron', () => {
  const display = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 25, width: 1440, height: 875 }
  };
  return {
    ipcMain: {
      handle: (channel: string, fn: (event: unknown, payload?: unknown) => unknown): void => {
        host.handlers.set(channel, fn);
      },
      removeHandler: (channel: string): void => {
        host.removed.push(channel);
      }
    },
    // `store.ts` is a real (unmocked) import of `ipc-bridge.ts` and touches both
    // of these at module load; nothing here reads them back.
    app: {
      isPackaged: false,
      getAppPath: () => '/app',
      getPath: () => '/tmp/walder-test',
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: () => {}
    },
    screen: {
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
      getDisplayNearestPoint: () => display
    }
  };
});

const { registerIpc, unregisterIpc } = await import('../src/main/ipc-bridge');
const { CH, PANEL_MAX_HEIGHT, PANEL_MIN_HEIGHT } = await import('../src/main/ipc');
const { loadSheet } = await import('../src/main/sheet');
const { DEFAULTS } = await import('../src/main/store');

const sheet = loadSheet();

/**
 * The three senders, as distinct object identities — which is exactly what the
 * guards compare. `OVERLAY` also carries `on`, because `registerIpc` subscribes
 * to `did-finish-load` on it.
 */
const OVERLAY = {
  name: 'overlay',
  on: (event: string, listener: () => void): void => {
    if (event === 'did-finish-load') loadListeners.push(listener);
  }
};
/** `did-finish-load` listeners the bridge registered, so a test can fire one. */
const loadListeners: Array<() => void> = [];
const PANEL = { name: 'panel' };
const FOREIGN = { name: 'foreign' };

/** Every channel the bridge is meant to own, i.e. `RENDERER_CHANNELS`. */
const EXPECTED_CHANNELS: readonly string[] = [
  CH.settingsGet,
  CH.hitSet,
  CH.dragStart,
  CH.dragMove,
  CH.dragEnd,
  CH.pet,
  CH.menuOpen,
  CH.hoverEnter,
  CH.hoverLeave,
  CH.refreshNow,
  CH.authLogin,
  CH.authLogout,
  CH.panelSize
];

interface Spies {
  readonly setInteractive: Mock;
  readonly dragStart: Mock;
  readonly dragMove: Mock;
  readonly dragEnd: Mock;
  readonly send: Mock;
  readonly hoverEnter: Mock;
  readonly hoverLeave: Mock;
  readonly setContentHeight: Mock;
  readonly popUpContextMenu: Mock;
  readonly onRendererLoad: Mock;
  readonly onPet: Mock;
  readonly onLogin: Mock;
  readonly onLogout: Mock;
  readonly onRefreshNow: Mock;
}

let spies: Spies;
/** What the panel window claims about itself; flipped by the destroyed case. */
let panelDestroyed = false;
/** `null` models "the panel has not been built yet". */
let panelExists = true;
let warnSpy: Mock;

function fakeStore(): WalderStore {
  const data: Record<string, unknown> = { ...DEFAULTS };
  return {
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => {
      data[key] = value;
    },
    path: '/tmp/walder-test/walder.json'
  } as unknown as WalderStore;
}

function setup(): void {
  spies = {
    setInteractive: vi.fn(),
    dragStart: vi.fn(),
    dragMove: vi.fn(),
    dragEnd: vi.fn(),
    send: vi.fn(),
    hoverEnter: vi.fn(),
    hoverLeave: vi.fn(),
    setContentHeight: vi.fn(),
    popUpContextMenu: vi.fn(),
    onRendererLoad: vi.fn(),
    onPet: vi.fn(),
    onLogin: vi.fn(),
    onLogout: vi.fn(),
    onRefreshNow: vi.fn(() => true)
  };

  const overlay = {
    win: { webContents: OVERLAY },
    setInteractive: spies.setInteractive,
    dragStart: spies.dragStart,
    dragMove: spies.dragMove,
    dragEnd: spies.dragEnd,
    send: spies.send,
    // Annotated rather than inferred: the `as unknown as Overlay` below would
    // happily hide a missing field, and `settings:get` returns this payload
    // verbatim — so a field added to `ModePayload` must break here.
    currentMode: (): ModePayload => ({
      scale: 2,
      box: 'stand',
      facing: 'left',
      hidden: false,
      still: false
    })
  } as unknown as Overlay;

  const panel = {
    win: { webContents: PANEL, isDestroyed: () => panelDestroyed },
    hoverEnter: spies.hoverEnter,
    hoverLeave: spies.hoverLeave,
    setContentHeight: spies.setContentHeight
  } as unknown as HoverPanel;

  registerIpc({
    overlay,
    store: fakeStore(),
    sheet,
    getTray: () => ({ popUpContextMenu: spies.popUpContextMenu }) as unknown as Tray,
    getPanel: () => (panelExists ? panel : null),
    getUsage: () => null,
    onRefreshNow: () => spies.onRefreshNow() as boolean,
    onLogin: (service) => spies.onLogin(service),
    onLogout: (service) => spies.onLogout(service),
    onPet: () => spies.onPet(),
    onRendererLoad: () => spies.onRendererLoad()
  });
}

/** Drive a handler the way `ipcMain` would, from a chosen sender. */
function invoke(channel: string, sender: object, payload?: unknown): unknown {
  const handler = host.handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
  return handler({ sender } as unknown as IpcMainInvokeEvent, payload);
}

/** Everything `warn` printed, one string per call. */
function warnings(): string[] {
  return warnSpy.mock.calls.map((call: unknown[]) => call.join(' '));
}

beforeEach(() => {
  host.handlers.clear();
  host.removed = [];
  loadListeners.length = 0;
  panelDestroyed = false;
  panelExists = true;
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) as unknown as Mock;
  setup();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the renderer loading', () => {
  it('pushes the state and then asks for the scene again, on every load', () => {
    // Scene events sent before the page loaded are lost — the first-run
    // "Hello" was, on 2026-09-19 — so the load is where they are replayed.
    expect(loadListeners).toHaveLength(1);
    loadListeners[0]?.();
    loadListeners[0]?.();
    expect(spies.onRendererLoad).toHaveBeenCalledTimes(2);
    // After the sheet/mode/palette, so the replayed bubble lands on a page
    // that already knows how to draw it.
    const order = spies.send.mock.invocationCallOrder[0] ?? Infinity;
    const load = spies.onRendererLoad.mock.invocationCallOrder[0] ?? 0;
    expect(load).toBeGreaterThan(order);
  });
});

describe('the registered table', () => {
  it('registers exactly the renderer -> main channel set, and nothing else', () => {
    expect([...host.handlers.keys()].sort()).toEqual([...EXPECTED_CHANNELS].sort());
  });

  it('registers only channels that exist in the CH table', () => {
    const known = new Set<string>(Object.values(CH));
    for (const channel of host.handlers.keys()) expect(known.has(channel)).toBe(true);
  });

  it('removes exactly the channels it registered when unregisterIpc runs', () => {
    unregisterIpc();
    expect([...host.removed].sort()).toEqual([...host.handlers.keys()].sort());
  });
});

/**
 * The overlay-only half. `FOREIGN` is the stranger; `PANEL` is the app's own
 * other window, which is the sender a too-loose guard would wave through.
 */
const OVERLAY_ONLY: readonly {
  channel: string;
  payload: unknown;
  dep: (s: Spies) => Mock;
}[] = [
  { channel: CH.hitSet, payload: { inside: true }, dep: (s) => s.setInteractive },
  { channel: CH.dragStart, payload: undefined, dep: (s) => s.dragStart },
  { channel: CH.dragMove, payload: { dxScreen: 4, dyScreen: 7 }, dep: (s) => s.dragMove },
  { channel: CH.dragEnd, payload: undefined, dep: (s) => s.dragEnd },
  { channel: CH.pet, payload: undefined, dep: (s) => s.onPet },
  { channel: CH.menuOpen, payload: undefined, dep: (s) => s.popUpContextMenu },
  {
    channel: CH.hoverEnter,
    payload: { spriteRectScreen: { x: 10, y: 20, width: 30, height: 40 } },
    dep: (s) => s.hoverEnter
  },
  { channel: CH.hoverLeave, payload: undefined, dep: (s) => s.hoverLeave }
];

describe('overlay-only channels', () => {
  it.each(OVERLAY_ONLY)('acts on $channel when the overlay sends it', ({ channel, payload, dep }) => {
    invoke(channel, OVERLAY, payload);
    expect(dep(spies)).toHaveBeenCalled();
  });

  it.each(OVERLAY_ONLY)('ignores $channel from a foreign sender', ({ channel, payload, dep }) => {
    invoke(channel, FOREIGN, payload);
    expect(dep(spies)).not.toHaveBeenCalled();
  });

  it.each(OVERLAY_ONLY)(
    'ignores $channel from the hover panel, which is not the overlay',
    ({ channel, payload, dep }) => {
      invoke(channel, PANEL, payload);
      expect(dep(spies)).not.toHaveBeenCalled();
    }
  );
});

describe('panel:size', () => {
  it('resizes the panel when the panel reports a height in range', () => {
    invoke(CH.panelSize, PANEL, { height: 300 });
    expect(spies.setContentHeight).toHaveBeenCalledWith(300);
  });

  it('ignores a panel:size from the overlay', () => {
    invoke(CH.panelSize, OVERLAY, { height: 300 });
    expect(spies.setContentHeight).not.toHaveBeenCalled();
  });

  it('ignores a panel:size from a foreign sender', () => {
    invoke(CH.panelSize, FOREIGN, { height: 300 });
    expect(spies.setContentHeight).not.toHaveBeenCalled();
  });

  it('ignores a panel:size once the panel window is destroyed', () => {
    panelDestroyed = true;
    invoke(CH.panelSize, PANEL, { height: 300 });
    expect(spies.setContentHeight).not.toHaveBeenCalled();
  });

  it('ignores a panel:size before the panel exists at all', () => {
    panelExists = false;
    invoke(CH.panelSize, PANEL, { height: 300 });
    expect(spies.setContentHeight).not.toHaveBeenCalled();
  });
});

describe('either-window channels', () => {
  it('answers settings:get for the overlay and for the panel', () => {
    expect(invoke(CH.settingsGet, OVERLAY)).toMatchObject({ sheet, forceInteractive: false });
    expect(invoke(CH.settingsGet, PANEL)).toMatchObject({ cardSize: DEFAULTS.cardSize });
  });

  it('returns null from settings:get for a foreign sender', () => {
    expect(invoke(CH.settingsGet, FOREIGN)).toBeNull();
  });

  it('runs refresh:now for either window and returns what the app said', () => {
    expect(invoke(CH.refreshNow, OVERLAY)).toBe(true);
    expect(invoke(CH.refreshNow, PANEL)).toBe(true);
    expect(spies.onRefreshNow).toHaveBeenCalledTimes(2);
  });

  it('returns false from refresh:now for a foreign sender, without refreshing', () => {
    expect(invoke(CH.refreshNow, FOREIGN)).toBe(false);
    expect(spies.onRefreshNow).not.toHaveBeenCalled();
  });

  it('starts a login for either window, with the validated service name', () => {
    invoke(CH.authLogin, OVERLAY, { service: 'claude' });
    expect(spies.onLogin).toHaveBeenCalledWith('claude');
    invoke(CH.authLogin, PANEL, { service: 'chatgpt' });
    expect(spies.onLogin).toHaveBeenLastCalledWith('chatgpt');
  });

  it('never starts a login for a foreign sender', () => {
    invoke(CH.authLogin, FOREIGN, { service: 'claude' });
    expect(spies.onLogin).not.toHaveBeenCalled();
  });

  it('logs out for either window and never for a foreign sender', () => {
    invoke(CH.authLogout, OVERLAY, { service: 'claude' });
    invoke(CH.authLogout, PANEL, { service: 'chatgpt' });
    invoke(CH.authLogout, FOREIGN, { service: 'claude' });
    expect(spies.onLogout.mock.calls).toEqual([['claude'], ['chatgpt']]);
  });
});

describe('malformed payloads from an accepted sender', () => {
  const BAD: readonly {
    name: string;
    channel: string;
    sender: object;
    payload: unknown;
    dep: (s: Spies) => Mock;
  }[] = [
    {
      name: 'hit:set with a non-boolean inside',
      channel: CH.hitSet,
      sender: OVERLAY,
      payload: { inside: 'yes' },
      dep: (s) => s.setInteractive
    },
    {
      name: 'hit:set with no payload at all',
      channel: CH.hitSet,
      sender: OVERLAY,
      payload: undefined,
      dep: (s) => s.setInteractive
    },
    {
      name: 'drag:move missing dyScreen',
      channel: CH.dragMove,
      sender: OVERLAY,
      payload: { dxScreen: 4 },
      dep: (s) => s.dragMove
    },
    {
      name: 'drag:move with a NaN delta',
      channel: CH.dragMove,
      sender: OVERLAY,
      payload: { dxScreen: Number.NaN, dyScreen: 0 },
      dep: (s) => s.dragMove
    },
    {
      name: 'hover:enter with a zero-width rect',
      channel: CH.hoverEnter,
      sender: OVERLAY,
      payload: { spriteRectScreen: { x: 0, y: 0, width: 0, height: 40 } },
      dep: (s) => s.hoverEnter
    },
    {
      name: 'auth:login for a service that does not exist',
      channel: CH.authLogin,
      sender: OVERLAY,
      payload: { service: 'gemini' },
      dep: (s) => s.onLogin
    },
    {
      name: 'panel:size one pixel over the maximum',
      channel: CH.panelSize,
      sender: PANEL,
      payload: { height: PANEL_MAX_HEIGHT + 1 },
      dep: (s) => s.setContentHeight
    },
    {
      name: 'panel:size one pixel under the minimum',
      channel: CH.panelSize,
      sender: PANEL,
      payload: { height: PANEL_MIN_HEIGHT - 1 },
      dep: (s) => s.setContentHeight
    }
  ];

  it.each(BAD)('drops $name without throwing', ({ channel, sender, payload, dep }) => {
    expect(() => invoke(channel, sender, payload)).not.toThrow();
    expect(dep(spies)).not.toHaveBeenCalled();
  });
});

describe('the record a refusal leaves', () => {
  it.each(EXPECTED_CHANNELS)('warns about an unexpected sender on %s', (channel) => {
    invoke(channel, FOREIGN, undefined);
    expect(warnings().some((line) => line.includes('unexpected sender'))).toBe(true);
  });

  it('names the channel in the warning, so a log line identifies the caller', () => {
    invoke(CH.authLogin, FOREIGN, { service: 'claude' });
    expect(warnings().join('\n')).toContain(CH.authLogin);
  });

  it('says nothing when the rightful sender speaks', () => {
    invoke(CH.hitSet, OVERLAY, { inside: true });
    invoke(CH.panelSize, PANEL, { height: 300 });
    expect(warnings()).toEqual([]);
  });
});

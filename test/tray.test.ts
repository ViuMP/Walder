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
import type { ServiceReport, UsageSnapshot } from '../src/core/usage';
import { expressionFor } from '../src/core/expression';
import { native } from './support/host';

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
  relaunches: 0,
  trayTitles: [] as string[],
  popUps: 0,
  /** What each `popUpContextMenu` call was given (`undefined`: the set menu). */
  popUpMenus: [] as unknown[],
  /** What each `setContextMenu` call was given. */
  contextMenus: [] as unknown[],
  /** Handlers registered with `tray.on`, by event name. */
  trayEvents: new Map<string, () => void>(),
  /** What each `setIgnoreDoubleClickEvents` call was given. */
  ignoreDoubleClicks: [] as boolean[]
}));

vi.mock('electron-store', () => ({ default: class {} }));

vi.mock('electron', () => {
  class FakeTray {
    setToolTip(): void {}
    setTitle(title: string): void {
      host.trayTitles.push(title);
    }
    setContextMenu(menu: unknown): void {
      host.contextMenus.push(menu);
    }
    on(event: string, handler: () => void): void {
      host.trayEvents.set(event, handler);
    }
    setIgnoreDoubleClickEvents(ignore: boolean): void {
      host.ignoreDoubleClicks.push(ignore);
    }
    popUpContextMenu(menu?: unknown): void {
      host.popUps++;
      host.popUpMenus.push(menu);
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
        const listeners = new Map<string, () => void>();
        return {
          template,
          once: (event: string, listener: () => void) => listeners.set(event, listener),
          /** Test-only: what Electron does when the menu closes. */
          emit: (event: string) => listeners.get(event)?.()
        };
      }
    },
    app: {
      getAppPath: () => '/app',
      get isPackaged(): boolean {
        return host.isPackaged;
      },
      getLoginItemSettings: () => ({ openAtLogin: host.openAtLogin }),
      setLoginItemSettings: () => {},
      relaunch: () => {
        host.relaunches++;
      },
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

const {
  INJECT_PERCENTS,
  INJECT_WEEKLY_FIVE_HOUR_PCT,
  INJECT_WEEKLY_PCTS,
  accountStatusLine,
  createTray,
  developerMenuVisible,
  hookConfirmVerb,
  hookStatusLine,
  initialScale,
  installItemLabel,
  paletteLabel,
    usageLine
} = await import('../src/main/tray');
const { MENU_CLOSE_LATE_RESYNC_MS } = await import('../src/main/ipc-bridge');
const { DEFAULTS } = await import('../src/main/store');
const { loadSheet } = await import('../src/main/sheet');
const { CH } = await import('../src/main/ipc');
const { defaultHideShortcut } = await import('../src/core/shortcuts');

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
    setStill: (on: boolean) => calls.push(`setStill:${String(on)}`),
    setForceInteractive: (on: boolean) => calls.push(`setForceInteractive:${String(on)}`),
    resetPosition: () => calls.push('resetPosition'),
    dragStart: () => calls.push('dragStart'),
    dragMove: () => calls.push('dragMove'),
    dragEnd: () => calls.push('dragEnd'),
    isDragging: () => false,
    // `facing` is part of `ModePayload`, and the `as unknown as Overlay` below
    // would happily hide its absence — a stub that omits it is a lie about the
    // shape the tray menu is built against, and the next field added to the
    // payload would be missed for the same reason.
    currentMode: () => ({
      scale: 3,
      box: 'stand' as const,
      facing: 'left' as const,
      hidden: false,
      still: false
    }),
    resyncCursor: () => {},
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
  host.popUpMenus = [];
  host.contextMenus = [];
  host.trayEvents = new Map();
  host.ignoreDoubleClicks = [];
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

    live = second.overlay;
    click(item('Large', size));
    click(item('Reset position'));

    // Colour and Force interactive live in the Walder window now; their overlay
    // effects are tested in `test/settings.test.ts` (`standardEffects`).
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual(['applySize:3', `send:${CH.modeSet}`, 'resetPosition']);
  });

  it('survives a null overlay without throwing, and still stores the preference', () => {
    const store = fakeStore();
    createTray({ getOverlay: () => null, store, sheet, onQuit: () => {} });

    expect(() => click(item('Large', submenu('Size')))).not.toThrow();
    expect(() => click(item('Reset position'))).not.toThrow();

    // The click is not simply lost: the next window built reads it.
    expect(read(store, 'size')).toBe('large');
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
  it('offers Reset position as an escape hatch, directly under Hooks', () => {
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {}
    });
    const labels = template().map((entry) => entry.label);
    expect(labels).toContain('Reset position');
    expect(labels.indexOf('Reset position')).toBe(labels.indexOf('Hooks') + 1);
  });

  it('marks the stored size, and re-marks it after a change', () => {
    const store = fakeStore({ size: 'small' });
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store,
      sheet,
      onQuit: () => {}
    });

    expect(item('Small', submenu('Size')).checked).toBe(true);
    expect(item('Large', submenu('Size')).checked).toBe(false);

    click(item('Large', submenu('Size')));
    // The menu is rebuilt on every change, because MenuItems cache `checked`.
    expect(item('Large', submenu('Size')).checked).toBe(true);
    expect(item('Small', submenu('Size')).checked).toBe(false);
  });

  /*
   * The Colour submenu is built from the *sheet*, not from a list in `tray.ts`.
   *
   * The bug that motivated it: the M3 menu hard-coded five coats while the
   * placeholder sheet defined one, so four of the five items were live, stored a
   * preference, and changed nothing on screen. The rule now is that the menu
   * cannot offer a coat the art does not have, and cannot omit one it does.
   */
  it('labels a hyphenated coat key as one sentence', () => {
    expect(paletteLabel('black-and-tan')).toBe('Black and tan');
    expect(paletteLabel('golden')).toBe('Golden');
    // Degenerate keys must not produce an empty menu item.
    expect(paletteLabel('')).toBe('');
    expect(paletteLabel('-')).toBe('-');
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

  it('relaunches and then quits from the Restart item', () => {
    const order: string[] = [];
    host.relaunches = 0;
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => order.push(`quit after ${host.relaunches} relaunch`)
    });
    click(item('Restart'));
    expect(order).toEqual(['quit after 1 relaunch']);
  });

  // Windows QA 2026-11-19, #2: electron-vite stops the dev server with this
  // process, so a relaunched dev run loaded its pages from a dead URL.
  it('under npm run dev, says so instead of relaunching onto a dead dev server', () => {
    const notices: string[] = [];
    let quits = 0;
    host.relaunches = 0;
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173');
    try {
      createTray({
        getOverlay: () => spyOverlay().overlay,
        store: fakeStore(),
        sheet,
        onQuit: () => quits++,
        onNotice: (text) => notices.push(text)
      });
      click(item('Restart'));
      expect([host.relaunches, quits]).toEqual([0, 0]);
      expect(notices).toEqual(['Dev build: quit, then npm run dev']);
      // An installed build ignores the variable and restarts as ever.
      host.isPackaged = true;
      click(item('Restart'));
      expect([host.relaunches, quits]).toEqual([1, 1]);
    } finally {
      host.isPackaged = false;
      vi.unstubAllEnvs();
    }
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
    // Host spelling: the tray joins `app.getAppPath()` with the host's
    // `path.join`, which is the right one at runtime (`test/support/host.ts`).
    expect(host.iconPaths[0]).toBe(native(`/app/build/${expected}`));
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

/**
 * Windows QA, rows 4.10 / 9.18: a right-click on the icon showed the menu the
 * last `setContextMenu` was given — "Refresh now (wait 60s)" twenty seconds
 * after the refresh, last poll's Accounts lines — because Electron's Windows
 * tray pops a set menu itself and never emits `'right-click'`. Every opening
 * must now show a menu built at that moment.
 *
 * macOS, row 4.10 again (2026-11-14): on macOS 27.2 the system opens a set menu
 * on the press and Electron emits no `'click'` at all, so the rebuild in the
 * click handler never ran and the label was as stale as it had been on Windows.
 * It takes the same path now: no set menu, and the press opens a fresh one.
 */
describe('opening the menu rebuilds it first', () => {
  /** Run `body` with `process.platform` pinned, restored even on a failure. */
  function onPlatform(platform: NodeJS.Platform, body: () => void): void {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
      body();
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  }

  /** The labels of a menu the fake `Menu.buildFromTemplate` returned. */
  function labelsOf(menu: unknown): string[] {
    const { template } = menu as { template: MenuItemConstructorOptions[] };
    return template.map((entry) => String(entry.label));
  }

  /** The update-check cooldown at construction, and by the time the menu is opened. */
  const AT_BUILD_MS = 60_000;
  const AT_OPEN_MS = 40_000;

  /** A tray whose update-check cooldown runs down between construction and opening. */
  function trayWithCooldown(): { readonly elapse: () => void; readonly openMenu: () => void } {
    let cooldown = AT_BUILD_MS;
    const handle = createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      getUsage: () => usageSnapshot(),
      onRefreshNow: () => {},
      updateState: () => ({ kind: 'never' }),
      updateCooldownMs: () => cooldown
    });
    return {
      elapse: () => {
        cooldown = AT_OPEN_MS;
      },
      openMenu: () => handle.openMenu()
    };
  }

  function fire(event: string): void {
    const handler = host.trayEvents.get(event);
    if (handler === undefined) throw new Error(`no tray "${event}" handler`);
    handler();
  }

  it.each([
    ['win32', 'right-click'],
    ['win32', 'click'],
    ['darwin', 'right-click'],
    ['darwin', 'click']
  ] as const)('on %s, a %s opens a menu built at that moment', (platform, event) => {
    onPlatform(platform, () => {
      const tray = trayWithCooldown();
      tray.elapse();
      fire(event);
    });

    expect(host.popUpMenus).toHaveLength(1);
    const opened = host.popUpMenus[0];
    // The fresh menu, passed explicitly — not `undefined` (the set menu) — and
    // the latest one built, i.e. built by the opening itself …
    expect(opened).toBeDefined();
    expect((opened as { template: unknown }).template).toBe(host.templates.at(-1));
    expect(labelsOf(opened)).toContain('Check for updates now (wait 40s)');
    expect(labelsOf(opened)).not.toContain('Check for updates now (wait 60s)');
    // … and no menu is ever handed to the icon, or that one would be shown on
    // the press instead of the event being emitted.
    expect(host.contextMenus.filter((menu) => menu !== null)).toEqual([]);
  });

  it('with Verbose log on, says which press arrived and whether our menu showed (QA 3.17)', async () => {
    const { setLogSink, setVerbose } = await import('../src/main/log');
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    setVerbose(true);
    try {
      onPlatform('win32', () => {
        trayWithCooldown();
        fire('right-click');
      });
      (host.popUpMenus[0] as { emit: (event: string) => void }).emit('menu-will-show');
      const said = lines.join('');
      expect(said).toContain('tray icon: right-click');
      expect(said).toContain('tray menu: shown');
    } finally {
      setVerbose(false);
      setLogSink(null);
    }
  });

  it('holds the hover card down while a menu opened from the icon is up (Windows QA 3.17)', () => {
    for (const [platform, event] of [
      ['win32', 'right-click'],
      ['win32', 'click'],
      ['darwin', 'click']
    ] as const) {
      host.popUpMenus = [];
      const calls: boolean[] = [];
      onPlatform(platform, () => {
        createTray({
          getOverlay: () => spyOverlay().overlay,
          store: fakeStore(),
          sheet,
          onQuit: () => {},
          holdCard: (on) => calls.push(on)
        });
        fire(event);
      });
      expect(calls, `${platform} ${event}`).toEqual([true]);
      (host.popUpMenus[0] as { emit: (event: string) => void }).emit('menu-will-close');
      expect(calls, `${platform} ${event}`).toEqual([true, false]);
    }
  });

  it('tells the renderer where the cursor is when an icon menu closes, now and a moment later (Windows QA 3.17)', () => {
    vi.useFakeTimers();
    try {
      host.popUpMenus = [];
      const spy = spyOverlay();
      let resyncs = 0;
      const overlay = { ...spy.overlay, resyncCursor: () => void resyncs++ };
      onPlatform('win32', () => {
        createTray({ getOverlay: () => overlay as never, store: fakeStore(), sheet, onQuit: () => {} });
        fire('right-click');
      });
      expect(resyncs).toBe(0);
      (host.popUpMenus[0] as { emit: (event: string) => void }).emit('menu-will-close');
      expect(resyncs).toBe(1);
      vi.advanceTimersByTime(MENU_CLOSE_LATE_RESYNC_MS);
      expect(resyncs).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('on darwin only, every press is a click, never a double-click that opens nothing', () => {
    // With no set menu, an older macOS reports a press with a click count of 2
    // as `'double-click'`, which no handler here answers.
    onPlatform('darwin', () => trayWithCooldown());
    expect(host.ignoreDoubleClicks).toEqual([true]);
    host.ignoreDoubleClicks = [];
    onPlatform('win32', () => trayWithCooldown());
    expect(host.ignoreDoubleClicks).toEqual([]);
  });

  it('on Windows, the dog\'s right-click (openMenu) shows the same fresh menu', () => {
    onPlatform('win32', () => {
      const tray = trayWithCooldown();
      tray.elapse();
      tray.openMenu();
    });

    expect(host.popUpMenus).toHaveLength(1);
    expect(labelsOf(host.popUpMenus[0])).toContain('Check for updates now (wait 40s)');
  });

  it.each(['win32', 'darwin'] as const)(
    'on %s, openMenu reports its own menu\'s close',
    (platform) => {
      // The dog's menu suppresses the hover card until this fires (re-check a).
      const closed = vi.fn();
      onPlatform(platform, () => {
        const handle = createTray({
          getOverlay: () => spyOverlay().overlay,
          store: fakeStore(),
          sheet,
          onQuit: () => {}
        });
        handle.openMenu(closed);
      });
      expect(closed).not.toHaveBeenCalled();
      (host.popUpMenus[0] as { emit: (event: string) => void }).emit('menu-will-close');
      expect(closed).toHaveBeenCalledTimes(1);
    }
  );

  it('on Linux, openMenu reports the close at once: there is no menu of ours to watch', () => {
    const closed = vi.fn();
    onPlatform('linux', () => {
      createTray({
        getOverlay: () => spyOverlay().overlay,
        store: fakeStore(),
        sheet,
        onQuit: () => {}
      }).openMenu(closed);
    });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('on Linux, the set menu is rebuilt before a click opens it, and right-click is left alone', () => {
    onPlatform('linux', () => {
      const tray = trayWithCooldown();
      tray.elapse();
      fire('click');
    });

    // The set menu is still the mechanism here: the fresh one is set, then
    // the icon is asked to open whatever it was given.
    expect(host.popUpMenus).toEqual([undefined]);
    expect(labelsOf(host.contextMenus.at(-1))).toContain('Check for updates now (wait 40s)');
    expect(host.trayEvents.has('right-click')).toBe(false);
  });
});

describe('initialScale', () => {
  it('maps the stored size to the sprite scale', () => {
    // Capped at 3x since the 2026-09-08 design gate; medium (2x) is the default.
    expect(initialScale(fakeStore({ size: 'small' }))).toBe(1);
    expect(initialScale(fakeStore({ size: 'medium' }))).toBe(2);
    expect(initialScale(fakeStore({ size: 'large' }))).toBe(3);
  });

  it('falls back to the default for a corrupt stored size', () => {
    expect(initialScale(fakeStore({ size: 'huge' as never }))).toBe(2);
  });
});

/* --------------------------------------------------------------- M4: usage */

/** A snapshot-shaped object; only `services` is read by the menu. */
function usageSnapshot(
  claude: Partial<ServiceReport> = {},
  chatgpt: Partial<ServiceReport> = {}
): UsageSnapshot {
  const report = (patch: Partial<ServiceReport>): ServiceReport => ({
    buckets: [],
    status: 'ok',
    via: 'x',
    viaLabel: 'x label',
    ...patch
  });
  return {
    fetchedAt: '2026-09-08T15:00:00Z',
    buckets: [],
    services: {
      claude: report(claude),
      chatgpt: report(chatgpt),
      cursor: report({ status: 'unavailable', via: 'none', viaLabel: 'no source' }),
      copilot: report({ status: 'unavailable', via: 'none', viaLabel: 'no source' }),
      gemini: report({ status: 'unavailable', via: 'none', viaLabel: 'no source' })
    },
    expression: 'happy',
    intervalMs: 180_000
  };
}

/**
 * A snapshot whose Claude 5-hour window reads `pct`, or that has no such window
 * at all when `pct` is `null` — the two states `usageLine` must tell apart.
 */
function usageSnapshotAt(pct: number | null): UsageSnapshot {
  const buckets =
    pct === null
      ? []
      : [
          {
            id: 'claude.five_hour',
            service: 'claude' as const,
            key: 'five_hour',
            label: '5-hour',
            pct,
            resetsAt: null,
            priority: 0
          }
        ];
  return { ...usageSnapshot({ buckets }), buckets };
}

describe('accountStatusLine', () => {
  it('names the live source when a service is ok', () => {
    expect(
      accountStatusLine('claude', {
        buckets: [],
        status: 'ok',
        via: 'claude-oauth',
        viaLabel: 'Claude Code login'
      })
    ).toBe('Claude: ok via Claude Code login');
  });

  it('phrases every other status as something the owner can act on', () => {
    const line = (status: ServiceReport['status']): string =>
      accountStatusLine('chatgpt', { buckets: [], status, via: 'x', viaLabel: 'x' });

    expect(line('auth-needed')).toBe('ChatGPT: login needed');
    expect(line('unavailable')).toBe('ChatGPT: not logged in');
    expect(line('rate-limited')).toBe('ChatGPT: rate limited, retrying');
    expect(line('endpoint-changed')).toBe('ChatGPT: endpoint changed — update Walder');
    expect(line('error')).toBe('ChatGPT: could not be reached — check the connection');
  });

  it('says so before the first poll has returned', () => {
    expect(accountStatusLine('claude', null)).toBe('Claude: checking…');
  });
});

describe('the usage half of the menu', () => {
  it('is absent when no poller is wired to the tray', () => {
    // The tray must still build — it is the app's only user interface, and a
    // poller failure must not take it with it.
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {}
    });
    const labels = template().map((entry) => entry.label);
    expect(labels).not.toContain('Refresh now');
    expect(labels).not.toContain('Accounts');
    expect(labels).toContain('Size');
  });

  it('offers Refresh now above Accounts, both above Size', () => {
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      getUsage: () => usageSnapshot(),
      onRefreshNow: () => {}
    });
    const labels = template().map((entry) => entry.label);
    expect(labels.indexOf('Refresh now')).toBeLessThan(labels.indexOf('Accounts'));
    expect(labels.indexOf('Accounts')).toBeLessThan(labels.indexOf('Size'));
  });

  it('drives the poller from Refresh now', () => {
    let refreshes = 0;
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      getUsage: () => usageSnapshot(),
      onRefreshNow: () => {
        refreshes++;
      }
    });

    expect(item('Refresh now').enabled).not.toBe(false);
    click(item('Refresh now'));
    click(item('Refresh now'));
    // No cooldown: every click asks the poller (which keeps a 429's wait itself).
    expect(refreshes).toBe(2);
  });

  it('shows two status lines per service, then its login and logout items', () => {
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      getUsage: () =>
        usageSnapshot(
          { status: 'ok', viaLabel: 'Claude Code login' },
          { status: 'auth-needed' }
        ),
      onRefreshNow: () => {}
    });

    const accounts = submenu('Accounts');
    const labels = accounts.map((entry) => entry.label);
    // Line 1 is about the usage poll; line 2 about the login itself. The second
    // was added on 2026-09-08, after the owner logged in to ChatGPT inside
    // Walder's own window and the menu went on saying "login needed" with
    // nothing to say why or when it had last looked. Under an ok header with
    // no check on record it is left out (2026-11-13 audit, X6): the login is
    // only checked for a service that is not ok, so it would read "not
    // checked yet" forever.
    expect(labels).toEqual([
      'Claude: ok via Claude Code login',
      'Log in…',
      'Log out',
      undefined, // the separator between the two services
      'ChatGPT: login needed',
      '  Login not checked yet',
      'Log in…',
      'Log out',
      undefined, // the separator before the third service
      // One line each: none of Cursor, Copilot and Gemini has a browser
      // login, so there is no login check to report and nothing for Log in…/
      // Log out to do.
      'Cursor: not logged in',
      undefined, // the separator before the fourth service
      'Copilot: not logged in',
      undefined, // the separator before the fifth service
      'Gemini: not logged in'
    ]);
    // The status lines are information, not actions.
    expect(accounts[0]?.enabled).toBe(false);
    expect(accounts[4]?.enabled).toBe(false);
    expect(accounts[5]?.enabled).toBe(false);
  });

  it('says in plain words what the last login check found, and when', () => {
    const at = new Date('2026-09-08T12:03:40').getTime();
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      getUsage: () => usageSnapshot({ status: 'ok' }, { status: 'auth-needed' }),
      onRefreshNow: () => {},
      getLastCheck: (service) =>
        service === 'claude'
          ? { loggedIn: true, failed: false, detail: '', at }
          : { loggedIn: false, failed: false, detail: 'HTTP 401', at }
    });

    const labels = submenu('Accounts').map((entry) => entry.label);
    expect(labels[1]).toBe('  Logged in (checked 12:03)');
    expect(labels[6]).toBe('  Not logged in — last check: HTTP 401 (12:03)');
  });

  it('never names the account in the Accounts menu', () => {
    // Walder knows which account is logged in and will not say: a menu bar is
    // read over the owner's shoulder, and "logged in" is the whole of what he
    // needs to know.
    const at = Date.now();
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      getUsage: () => usageSnapshot({ status: 'ok' }, { status: 'ok' }),
      onRefreshNow: () => {},
      getLastCheck: () => ({ loggedIn: true, failed: false, detail: '', at })
    });

    for (const entry of submenu('Accounts')) {
      expect(String(entry.label ?? '')).not.toMatch(/@/);
    }
  });

  it('routes login and logout to the right service', () => {
    const logins: string[] = [];
    const logouts: string[] = [];
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      getUsage: () => usageSnapshot(),
      onRefreshNow: () => {},
      onLogin: (service) => logins.push(service),
      onLogout: (service) => logouts.push(service)
    });

    const accounts = submenu('Accounts');
    // Positional, because both services offer identically-labelled items: the
    // first three entries are Claude's, the next three after the separator
    // ChatGPT's (both ok and unchecked, so neither has a login-check line).
    click(accounts[1] as MenuItemConstructorOptions);
    click(accounts[5] as MenuItemConstructorOptions);
    expect(logins).toEqual(['claude', 'chatgpt']);

    click(submenu('Accounts')[2] as MenuItemConstructorOptions);
    expect(logouts).toEqual(['claude']);
  });

  it('tells the app when a click moved the dog out from under the hover card', () => {
    // The card is anchored to the sprite's ink rect, measured in the renderer.
    // Size and Reset position both invalidate that anchor, and a card left
    // hanging beside where the dog used to be reads as a bug.
    const spy = spyOverlay();
    const geometryChanges: number[] = [];
    createTray({
      getOverlay: () => spy.overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      onGeometryChanged: () => geometryChanges.push(1)
    });

    click(item('Large', submenu('Size')));
    expect(geometryChanges).toHaveLength(1);
    click(item('Reset position'));
    expect(geometryChanges).toHaveLength(2);
  });

  it('does not report a geometry change when there is no window', () => {
    const store = fakeStore();
    const geometryChanges: number[] = [];
    createTray({
      getOverlay: () => null,
      store,
      sheet,
      onQuit: () => {},
      onGeometryChanged: () => geometryChanges.push(1)
    });

    click(item('Large', submenu('Size')));
    click(item('Reset position'));
    expect(geometryChanges).toEqual([]);
  });

  it('offers the hook installer, and the way back out of it', () => {
    // Both directions, because the removal used to exist only as an npm script:
    // an owner who installed from the .dmg could let Walder edit
    // ~/.claude/settings.json and then had no way to ask it to undo that.
    let installs = 0;
    let removals = 0;
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      onInstallHooks: () => {
        installs++;
      },
      onRemoveHooks: () => {
        removals++;
      }
    });

    click(item('Install Claude Code hooks…', submenu('Hooks')));
    expect([installs, removals]).toEqual([1, 0]);

    click(item('Remove Claude Code hooks…', submenu('Hooks')));
    expect([installs, removals]).toEqual([1, 1]);
  });

  /**
   * The status line above them — the whole 0.2.5 hook fix in one sentence.
   *
   * Until now the menu offered to install hooks and never said whether they
   * *were* installed, so the state the owner spent days in (listener up, hooks
   * absent, dog silent) looked exactly like the healthy one.
   */
  describe('the hook status line', () => {
    /** One tool's reading; the other is left uninstalled and irrelevant. */
    function lineFor(
      status: { installedPort: number | null; boundPort: number | null },
      tool: 'claude' | 'codex' = 'claude'
    ): string | undefined {
      const absent = { installedPort: null, boundPort: status.boundPort };
      createTray({
        getOverlay: () => spyOverlay().overlay,
        store: fakeStore(),
        sheet,
        onQuit: () => {},
        hookStatus: () =>
          tool === 'claude' ? { claude: status, codex: absent } : { claude: absent, codex: status }
      });
      const prefix = tool === 'claude' ? 'Claude Code hooks:' : 'Codex hooks:';
      return submenu('Hooks')
        .map((entry) => String(entry.label ?? ''))
        .find((label) => label.startsWith(prefix));
    }

    it('names the port when everything agrees', () => {
      expect(hookStatusLine({ installedPort: 47_811, boundPort: 47_811 })).toBe(
        'Claude Code hooks: installed (port 47811)'
      );
      expect(lineFor({ installedPort: 47_811, boundPort: 47_811 })).toBe(
        'Claude Code hooks: installed (port 47811)'
      );
    });

    it('says so when they are not installed at all', () => {
      expect(lineFor({ installedPort: null, boundPort: 47_811 })).toBe(
        'Claude Code hooks: not installed'
      );
    });

    it('tells an out-of-date command from a current one, and offers the update', () => {
      // 2026-11-19: an old command on the right port read "installed (port N)".
      const old = { installedPort: 47_811, boundPort: 47_811, outdated: true };
      expect(lineFor(old)).toBe('Claude Code hooks: installed (port 47811), out of date');
      expect(lineFor(old, 'codex')).toBe('Codex hooks: installed (port 47811), out of date');
      const hooks = submenu('Hooks').map((entry) => String(entry.label ?? ''));
      expect(hooks).toContain('Update Codex hooks…');
      expect(hooks).not.toContain('Install Codex hooks…');
      expect(hooks).toContain('Install Claude Code hooks…');
      // A wrong port still names both ports; a dead listener still comes first.
      expect(hookStatusLine({ ...old, boundPort: 47_812 })).toBe(
        'Claude Code hooks: installed for port 47811, Walder is on 47812'
      );
      expect(hookStatusLine({ ...old, boundPort: null })).toBe(
        "Claude Code hooks: Walder's listener is not running"
      );
      expect(installItemLabel({ ...old, boundPort: null }, 'claude')).toBe('Install Claude Code hooks…');
      expect(installItemLabel(old, 'claude')).toBe('Update Claude Code hooks…');
      expect(installItemLabel(undefined, 'codex')).toBe('Install Codex hooks…');
    });

    it('asks Update, not Install, when the item read Update (Windows QA 7.2a)', async () => {
      const { t } = await import('../src/core/strings');
      const old = { installedPort: 47_811, boundPort: 47_811, outdated: true };
      expect(hookConfirmVerb(false, old)).toBe('update');
      expect(t(`hooks.${hookConfirmVerb(false, old)}`)).toBe('Update');
      expect(t(`hooks.question.${hookConfirmVerb(false, old)}`, { tool: 'Codex' })).toBe(
        "Update Walder's Codex hooks?"
      );
      expect(hookConfirmVerb(false, { ...old, outdated: false })).toBe('install');
      expect(hookConfirmVerb(false, { ...old, boundPort: null })).toBe('install');
      expect(hookConfirmVerb(true, old)).toBe('remove');
    });

    it('names both ports when the hook posts to the wrong one', () => {
      expect(lineFor({ installedPort: 47_811, boundPort: 47_812 })).toBe(
        'Claude Code hooks: installed for port 47811, Walder is on 47812'
      );
    });

    it('reports a dead listener ahead of anything else', () => {
      // Installing hooks would only write a command pointing at nothing, so
      // this outranks "not installed".
      for (const installedPort of [null, 47_811]) {
        expect(hookStatusLine({ installedPort, boundPort: null })).toBe(
          "Claude Code hooks: Walder's listener is not running"
        );
      }
    });

    it('sits directly above the install item, and is not clickable', () => {
      createTray({
        getOverlay: () => spyOverlay().overlay,
        store: fakeStore(),
        sheet,
        onQuit: () => {},
        hookStatus: () => ({
          claude: { installedPort: null, boundPort: 47_811 },
          codex: { installedPort: 47_811, boundPort: 47_811 }
        })
      });
      const hooks = submenu('Hooks');
      const labels = hooks.map((entry) => String(entry.label ?? ''));
      // The status line heads the submenu, directly above its install item.
      expect(labels[0]).toBe('Claude Code hooks: not installed');
      expect(labels.indexOf('Claude Code hooks: not installed') + 1).toBe(
        labels.indexOf('Install Claude Code hooks…')
      );
      expect(item('Claude Code hooks: not installed', hooks).enabled).toBe(false);
      expect(item('Claude Code hooks: not installed', hooks).click).toBeUndefined();
      // And the Codex block in the same shape, after a separator under the Claude one.
      expect(hooks[labels.indexOf('Remove Claude Code hooks…') + 1]?.type).toBe('separator');
      expect(labels.indexOf('Codex hooks: installed (port 47811)')).toBe(
        labels.indexOf('Remove Claude Code hooks…') + 2
      );
      expect(labels.indexOf('Codex hooks: installed (port 47811)') + 1).toBe(
        labels.indexOf('Install Codex hooks…')
      );
      expect(labels.indexOf('Install Codex hooks…') + 1).toBe(
        labels.indexOf('Remove Codex hooks…')
      );
      expect(item('Codex hooks: installed (port 47811)', hooks).enabled).toBe(false);
    });

    it('names Codex in its own line, with the same four answers', () => {
      expect(hookStatusLine({ installedPort: 47_811, boundPort: 47_811 }, 'codex')).toBe(
        'Codex hooks: installed (port 47811)'
      );
      expect(lineFor({ installedPort: null, boundPort: 47_811 }, 'codex')).toBe(
        'Codex hooks: not installed'
      );
      expect(lineFor({ installedPort: 47_811, boundPort: 47_812 }, 'codex')).toBe(
        'Codex hooks: installed for port 47811, Walder is on 47812'
      );
      expect(hookStatusLine({ installedPort: 47_811, boundPort: null }, 'codex')).toBe(
        "Codex hooks: Walder's listener is not running"
      );
    });

    it('is absent entirely when no listener is wired to the menu', () => {
      createTray({
        getOverlay: () => spyOverlay().overlay,
        store: fakeStore(),
        sheet,
        onQuit: () => {}
      });
      const labels = submenu('Hooks').map((entry) => String(entry.label ?? ''));
      expect(labels.some((label) => label.startsWith('Claude Code hooks:'))).toBe(false);
      expect(labels.some((label) => label.startsWith('Codex hooks:'))).toBe(false);
    });
  });

  it('wires the two Codex hook items separately', () => {
    // A different file from the Claude pair (`~/.codex/hooks.json`), so a host
    // that swapped the two would quietly edit the wrong tool's config.
    let installs = 0;
    let removals = 0;
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      onInstallCodexHooks: () => {
        installs++;
      },
      onRemoveCodexHooks: () => {
        removals++;
      }
    });

    const hooks = submenu('Hooks');
    click(item('Install Codex hooks…', hooks));
    expect([installs, removals]).toEqual([1, 0]);
    click(item('Remove Codex hooks…', hooks));
    expect([installs, removals]).toEqual([1, 1]);
    // And the Claude items are not wired to them.
    expect(() => click(item('Install Claude Code hooks…', hooks))).not.toThrow();
    expect([installs, removals]).toEqual([1, 1]);
  });

  it('still builds when only one of the two hook actions is wired', () => {
    // Every tray dependency is optional so the menu survives a partial host;
    // clicking an unwired item must be a no-op, not a crash.
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {}
    });
    expect(() => click(item('Remove Claude Code hooks…', submenu('Hooks')))).not.toThrow();
  });

  it('rebuilds the menu when refresh() is called', () => {
    // Menu items cache their label and enabled state at build time, so a new
    // snapshot only reaches the owner if the menu is rebuilt.
    let status: ServiceReport['status'] = 'auth-needed';
    const handle = createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      getUsage: () => usageSnapshot({ status, viaLabel: 'Claude Code login' }),
      onRefreshNow: () => {}
    });

    expect(submenu('Accounts')[0]?.label).toBe('Claude: login needed');
    status = 'ok';
    handle.refresh();
    expect(submenu('Accounts')[0]?.label).toBe('Claude: ok via Claude Code login');
  });
});

/**
 * The Developer submenu.
 *
 * The fake-data items exist because none of the three things they drive can be
 * produced by hand in a reasonable time: usage percentages arrive every three
 * minutes, hook events only while Claude Code is running, and a fullscreen video
 * takes a film. Those three must NOT reach a normal install — a mascot that can
 * be told to say "100 % used" is a mascot nobody can trust.
 *
 * "Verbose log" used to keep the submenu alive in a packaged build. It lives
 * in the Walder window now, and the log file is a top-level "Reveal log file"
 * (beside "Report a bug…", which asks for it), so a packaged build without
 * WALDER_DEV=1 has no Developer item at all.
 */
describe('the Developer submenu', () => {
  it('gates the fake-data items: unpackaged always, packaged only with WALDER_DEV=1', () => {
    expect(developerMenuVisible({}, false)).toBe(true);
    expect(developerMenuVisible({}, true)).toBe(false);
    expect(developerMenuVisible({ WALDER_DEV: '1' }, true)).toBe(true);
    expect(developerMenuVisible({ WALDER_DEV: '0' }, true)).toBe(false);
  });

  it('is absent from a packaged build, and back with WALDER_DEV=1', () => {
    host.isPackaged = true;
    vi.stubEnv('WALDER_DEV', '');
    try {
      createTray({ getOverlay: () => spyOverlay().overlay, store: fakeStore(), sheet, onQuit: () => {} });
      expect(template().some((entry) => entry.label === 'Developer')).toBe(false);

      vi.stubEnv('WALDER_DEV', '1');
      createTray({ getOverlay: () => spyOverlay().overlay, store: fakeStore(), sheet, onQuit: () => {} });
      expect(submenu('Developer').map((entry) => entry.label)).toEqual([
        'Inject usage',
        'Simulate hook',
        'Simulate account state',
        'Toggle fullscreen mode',
        'Renew Claude Code login now'
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('Simulate account state is a radio of every state, checked on the one in force', () => {
    const chosen: string[] = [];
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      accountState: () => 'codex-credits-out',
      onSimulateAccountState: (state) => chosen.push(state)
    });
    const items = submenu('Developer').find((entry) => entry.label === 'Simulate account state')
      ?.submenu as MenuItemConstructorOptions[];
    expect(items.map((item) => item.type)).toEqual(Array(6).fill('radio'));
    expect(items.filter((item) => item.checked).map((item) => item.label)).toEqual([
      'Out of credit (Codex credits 0)'
    ]);
    (items[0]!.click as () => void)();
    expect(chosen).toEqual(['normal']);
  });

  it('injects each percentage, and the no-data case', () => {
    host.isPackaged = false;
    const injected: (number | null)[] = [];
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      onInjectUsage: (pct) => injected.push(pct)
    });

    const dev = submenu('Developer');
    const inject = (item('Inject usage', dev).submenu ?? []) as MenuItemConstructorOptions[];
    for (const pct of INJECT_PERCENTS) click(item(`${pct}%`, inject));
    click(item('no data', inject));
    expect(injected).toEqual([...INJECT_PERCENTS, null]);
  });

  it('offers an inject in the exhausted band as well as the out one', () => {
    // Rows 3.4k and 5.6 of the QA checklist need both faces; before 96 was
    // added nothing in the menu landed in the 95–99 `exhausted` band.
    const faces = INJECT_PERCENTS.map(expressionFor);
    expect(faces).toContain('exhausted');
    expect(faces).toContain('out');
  });

  it('injects a spent weekly pool beside a calm 5-hour row, for the posture', () => {
    host.isPackaged = false;
    const both: [number | null, number | undefined][] = [];
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      onInjectUsage: (pct, weeklyPct) => both.push([pct, weeklyPct])
    });
    const dev = submenu('Developer');
    const inject = (item('Inject usage', dev).submenu ?? []) as MenuItemConstructorOptions[];
    // One item per held posture: 92 lies with the head up, 96 with it on the paws.
    for (const weeklyPct of INJECT_WEEKLY_PCTS) click(item(`Weekly ${weeklyPct}% (5-hour 30%)`, inject));
    expect(both).toEqual(INJECT_WEEKLY_PCTS.map((weeklyPct) => [INJECT_WEEKLY_FIVE_HOUR_PCT, weeklyPct]));
  });

  it('simulates each hook event, for each tool', () => {
    // Two tools, because the bubbles now name them and the per-source queue is
    // the thing nobody can exercise by hand without both running at once.
    const fired: string[] = [];
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      onSimulateHook: (event) => fired.push(`${event.source}:${event.kind}`)
    });

    const tools = (item('Simulate hook', submenu('Developer')).submenu ??
      []) as MenuItemConstructorOptions[];
    for (const tool of ['Claude', 'Codex']) {
      const kinds = (item(tool, tools).submenu ?? []) as MenuItemConstructorOptions[];
      for (const kind of ['done', 'waiting', 'prompt']) click(item(kind, kinds));
    }
    expect(fired).toEqual([
      'claude:done',
      'claude:waiting',
      'claude:prompt',
      'codex:done',
      'codex:waiting',
      'codex:prompt'
    ]);
  });

  it('offers a forced Claude Code login renewal to a developer', () => {
    host.isPackaged = false;
    let forced = 0;
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      onRenewClaudeNow: () => forced++
    });

    click(item('Renew Claude Code login now', submenu('Developer')));
    expect(forced).toBe(1);
  });

  it('toggles the believed fullscreen state and shows it', () => {
    let fullscreen = false;
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      isFullscreen: () => fullscreen,
      onToggleFullscreen: () => {
        fullscreen = !fullscreen;
      }
    });

    expect(item('Toggle fullscreen mode', submenu('Developer')).checked).toBe(false);
    click(item('Toggle fullscreen mode', submenu('Developer')));
    expect(fullscreen).toBe(true);
    // The click rebuilds the menu, so the checkmark is not a poll behind.
    expect(item('Toggle fullscreen mode', submenu('Developer')).checked).toBe(true);
  });
});

/**
 * The hide-when-idle items: the checkbox, the shortcut list, and the
 * percentage line that only exists when the dog does not.
 *
 * Two things here are easy to break invisibly. The **percentage line** is the
 * whole compensation for hiding the dog — with him off screen there is no face
 * and nothing to hover, so the menu is the only place the number lives — and a
 * regression that dropped it would leave the mode with no way to read the usage
 * at all. And `registerAccelerator: false` is what stops an Electron menu item
 * binding the same keys a second time on Windows and Linux; nobody here can see
 * a tray menu, so the flag is asserted rather than looked at.
 */
describe('hide when idle', () => {
  it('shows the checkbox unticked by default, with the shortcut beside it', () => {
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {}
    });

    const entry = item('Hide when idle');
    expect(entry.type).toBe('checkbox');
    expect(entry.checked).toBe(false);
    // Display only: the keys are held by `globalShortcut`, which is what makes
    // them work with no menu open. `registerAccelerator: false` keeps the menu
    // from binding them a second time on Windows and Linux.
    expect(entry.accelerator).toBe(defaultHideShortcut(process.platform));
    expect(entry.registerAccelerator).toBe(false);
  });

  it('stores the toggle through the settings writer and reports it', () => {
    const toggles: boolean[] = [];
    const store = fakeStore();
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store,
      sheet,
      onQuit: () => {},
      onHideWhenIdle: (on) => toggles.push(on)
    });

    click(item('Hide when idle'), true);
    expect(toggles).toEqual([true]);
    // Written by the one settings writer (`main/settings.ts`), which the
    // global shortcut also goes through, so the two paths cannot drift.
    expect(read(store, 'hideWhenIdle')).toBe(true);
  });

  it('survives having no handler wired to it', () => {
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {}
    });
    expect(() => click(item('Hide when idle'), true)).not.toThrow();
  });

  it('sits directly under Size, above the Hooks submenu', () => {
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {}
    });
    const labels = template().map((entry) => entry.label);
    expect(labels.indexOf('Hide when idle')).toBe(labels.indexOf('Size') + 1);
    expect(labels.indexOf('Hide when idle')).toBeLessThan(labels.indexOf('Hooks'));
  });

  it('prints the Claude 5-hour percentage only while the mode is on', () => {
    const withUsage = {
      getOverlay: () => spyOverlay().overlay,
      sheet,
      onQuit: () => {},
      getUsage: () => usageSnapshotAt(63),
      onRefreshNow: () => {}
    };

    createTray({ ...withUsage, store: fakeStore() });
    expect(template().map((entry) => entry.label)).not.toContain('Claude 5-hour: 63% used');

    createTray({ ...withUsage, store: fakeStore({ hideWhenIdle: true }) });
    const labels = template().map((entry) => entry.label);
    // Directly under the header, where the eye lands first.
    expect(labels[0]).toBe('Walder');
    expect(labels[1]).toBe('Claude 5-hour: 63% used');
    // Nothing to click: it is a reading, not an action.
    expect(item('Claude 5-hour: 63% used').enabled).toBe(false);
  });

  it('says `?` rather than 0% when there is no number', () => {
    // "We could not find out" and "you have used none of it" must not look the
    // same — that is the whole reason `formatPct` exists.
    expect(usageLine(null)).toBe('Claude 5-hour: ?');
    expect(usageLine(usageSnapshotAt(null))).toBe('Claude 5-hour: ?');
    expect(usageLine(usageSnapshotAt(0))).toBe('Claude 5-hour: 0% used');
    expect(usageLine(usageSnapshotAt(63.4))).toBe('Claude 5-hour: 63% used');
  });
});

/**
 * The update block, just above Quit.
 *
 * One menu item is four different buttons depending on the state, and the two
 * that matter most are the ones nobody would notice being wrong: **"Download…"
 * must hand out the URL the checker holds** (so the pin in
 * `parseLatestRelease` is what decides where the owner goes, not the menu), and
 * **the automatic-check checkbox must write the store** (because that store key
 * is the whole of the promise in README's Privacy section — untick it and no
 * request is made).
 */
describe('the update block', () => {
  const AVAILABLE = {
    kind: 'available' as const,
    version: '0.1.3',
    url: 'https://github.com/ViuMP/Walder/releases/tag/v0.1.3',
    at: Date.parse('2026-09-09T12:00:00Z')
  };

  it('is absent when no checker is wired to the tray', () => {
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {}
    });
    const labels = template().map((entry) => entry.label);
    expect(labels).not.toContain('Check for updates now');
    expect(labels).not.toContain('Check for updates automatically');
    expect(labels).toContain('Quit');
  });

  it('sits below Developer, directly above Report a bug…', () => {
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      updateState: () => ({ kind: 'never' }),
      onCheckUpdateNow: () => true,
      updateCooldownMs: () => 0
    });
    const labels = template().map((entry) => entry.label);
    expect(labels.indexOf('Developer')).toBeGreaterThan(-1);
    expect(labels.indexOf('Developer')).toBeLessThan(labels.indexOf('Check for updates now'));
    expect(labels.indexOf('Check for updates now') + 1).toBe(labels.indexOf('Report a bug…'));
    // The automatic-check preference is in the Walder window only.
    expect(labels).not.toContain('Check for updates automatically');
  });

  it('asks the checker when clicked, and disables itself for the cooldown', () => {
    let checks = 0;
    let cooldown = 0;
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      updateState: () => ({ kind: 'never' }),
      onCheckUpdateNow: () => {
        checks++;
        cooldown = 60_000;
        return true;
      },
      updateCooldownMs: () => cooldown
    });

    expect(item('Check for updates now').enabled).toBe(true);
    click(item('Check for updates now'));
    expect(checks).toBe(1);
    // Rebuilt immediately, so the item shows as disabled rather than inviting a
    // second click it would refuse.
    expect(item('Check for updates now (wait 60s)').enabled).toBe(false);
  });

  it('hands the checker’s own URL to the opener, and nothing else', () => {
    const opened: string[] = [];
    let checks = 0;
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      updateState: () => AVAILABLE,
      onCheckUpdateNow: () => {
        checks++;
        return true;
      },
      updateCooldownMs: () => 0,
      onOpenUpdate: (url) => opened.push(url)
    });

    const entry = item('Update available: 0.1.3 — Download…');
    expect(entry.enabled).toBe(true);
    click(entry);
    expect(opened).toEqual([AVAILABLE.url]);
    // It opens a page; it does not also make a request.
    expect(checks).toBe(0);
  });

  it('offers the download even while the check cooldown is running', () => {
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      updateState: () => AVAILABLE,
      onCheckUpdateNow: () => true,
      updateCooldownMs: () => 42_000
    });
    expect(item('Update available: 0.1.3 — Download…').enabled).toBe(true);
  });

  it('dates a failed check in the menu', () => {
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      updateState: () => ({ kind: 'failed', detail: 'timeout', at: AVAILABLE.at }),
      onCheckUpdateNow: () => true,
      updateCooldownMs: () => 0
    });
    const labels = template().map((entry) => String(entry.label));
    expect(labels.some((label) => /^Last check failed \(\d{2}:\d{2}\)$/.test(label))).toBe(true);
  });

  it('survives having no handlers wired beyond the state', () => {
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      updateState: () => ({ kind: 'never' })
    });
    expect(() => click(item('Check for updates now'))).not.toThrow();
  });
});

/**
 * "Report a bug…".
 *
 * The item is unconditional — unlike the update block it needs nothing wired to
 * be *offered*, because an owner who cannot find it reports his bug by not
 * reporting it. What it must not do is move: it sits between the update block
 * and Quit, which is where a menu-bar app is looked in for concerns about the
 * app itself.
 */
describe('Report a bug…', () => {
  it('sits below the update block and above Quit', () => {
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      updateState: () => ({ kind: 'never' }),
      onCheckUpdateNow: () => true,
      updateCooldownMs: () => 0
    });
    const labels = template().map((entry) => entry.label);
    expect(labels.indexOf('Check for updates now')).toBeGreaterThan(-1);
    expect(labels.indexOf('Check for updates now')).toBeLessThan(labels.indexOf('Report a bug…'));
    expect(labels.indexOf('Report a bug…')).toBeLessThan(labels.indexOf('Quit'));
  });

  it('is there even with no update checker wired, and calls its handler', () => {
    let reports = 0;
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      onReportBug: () => {
        reports++;
      }
    });

    click(item('Report a bug…'));
    expect(reports).toBe(1);
  });

  it('survives having no handler wired to it', () => {
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {}
    });
    expect(() => click(item('Report a bug…'))).not.toThrow();
  });
});

describe('Reveal log file', () => {
  // "Report a bug…" asks the owner to *attach* the log, so the way to reach it
  // sits directly under it, in every build — not inside Developer.
  it('sits under Report a bug… in a packaged build, and reveals the file', () => {
    host.isPackaged = true;
    let reveals = 0;
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      logPath: '/Users/x/Library/Logs/Walder/walder.log',
      onRevealLog: () => {
        reveals++;
      }
    });

    const labels = template().map((entry) => entry.label);
    expect(labels.indexOf('Reveal log file')).toBe(labels.indexOf('Report a bug…') + 1);
    const reveal = item('Reveal log file');
    expect(reveal.enabled).toBe(true);
    click(reveal);
    expect(reveals).toBe(1);
    // The old path caption is gone: the button is the way to the file.
    expect(labels.some((label) => String(label ?? '').includes('Log:'))).toBe(false);
  });

  it('says there is no log file rather than offering to reveal one', () => {
    createTray({ getOverlay: () => spyOverlay().overlay, store: fakeStore(), sheet, onQuit: () => {} });

    const entry = item('Log file: none');
    expect(entry.enabled).toBe(false);
    expect(template().some((e) => e.label === 'Reveal log file')).toBe(false);
    expect(() => click(entry)).not.toThrow();
  });
});

/**
 * Every setting other than Size and Hide when idle moved to the Walder window
 * (2026-11-17), because the full menu was too tall for a Windows tray. Their
 * side effects are tested in `test/settings.test.ts`; here, that none of them
 * creeps back into the menu at any depth.
 */
describe('settings that live only in the Walder window', () => {
  const REMOVED = [
    'Card size',
    'Reset times',
    'Show in overview',
    'Barks',
    'Bark sound',
    'Primary service',
    'Colour',
    'Launch at login',
    'Launch at login (packaged app only)',
    'Sleep during fullscreen video',
    'Still mode (no animation)',
    'Shortcut',
    'Notify when hidden',
    'Force interactive (debug)',
    'Verbose log',
    'Check for updates automatically'
  ];

  /** Every label, walked through submenus. */
  function allLabels(items: readonly MenuItemConstructorOptions[]): string[] {
    return items.flatMap((entry) => [
      String(entry.label ?? ''),
      ...(Array.isArray(entry.submenu) ? allLabels(entry.submenu as MenuItemConstructorOptions[]) : [])
    ]);
  }

  it.each([false, true])('appear nowhere in the menu (packaged: %s)', (packaged) => {
    host.isPackaged = packaged;
    vi.stubEnv('WALDER_DEV', '');
    try {
      createTray({
        getOverlay: () => spyOverlay().overlay,
        store: fakeStore({ hideWhenIdle: true }),
        sheet,
        onQuit: () => {},
        getUsage: () => usageSnapshot(),
        onRefreshNow: () => {},
        hookStatus: () => ({
          claude: { installedPort: 47_811, boundPort: 47_811 },
          codex: { installedPort: 47_811, boundPort: 47_811 }
        }),
        updateState: () => ({ kind: 'never' }),
        onCheckUpdateNow: () => true,
        updateCooldownMs: () => 0,
        logPath: '/Users/x/Library/Logs/Walder/walder.log',
        onOpenSettings: () => {}
      });
    } finally {
      vi.unstubAllEnvs();
    }
    const labels = allLabels(template());
    // The menu really was built in full, so an absence means something.
    expect(labels).toContain('Hooks');
    expect(labels).toContain('Overview and settings…');
    expect(labels.includes('Developer')).toBe(!packaged);
    for (const label of REMOVED) expect(labels, label).not.toContain(label);
    expect(labels.some((label) => label.includes('Log:'))).toBe(false);
  });
});

describe('Overview and settings…', () => {
  it('opens the Walder window, and is left out when nothing can open it', () => {
    let opened = 0;
    createTray({ getOverlay: () => null, store: fakeStore(), sheet, onQuit: () => {}, onOpenSettings: () => opened++ });
    click(item('Overview and settings…'));
    expect(opened).toBe(1);

    createTray({ getOverlay: () => null, store: fakeStore(), sheet, onQuit: () => {} });
    expect(template().some((entry) => entry.label === 'Overview and settings…')).toBe(false);
  });
});

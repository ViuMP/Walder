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

const {
  INJECT_PERCENTS,
  accountStatusLine,
  createTray,
  developerMenuVisible,
  initialScale,
  refreshLabel
} = await import('../src/main/tray');
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
      'applySize:3',
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
    services: { claude: report(claude), chatgpt: report(chatgpt) },
    expression: 'happy',
    intervalMs: 180_000
  };
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
    expect(line('endpoint-changed')).toBe('ChatGPT: endpoint changed');
    expect(line('error')).toBe('ChatGPT: could not be reached');
  });

  it('says so before the first poll has returned', () => {
    expect(accountStatusLine('claude', null)).toBe('Claude: checking…');
  });
});

describe('refreshLabel', () => {
  it('is plain when a refresh is allowed', () => {
    expect(refreshLabel(0)).toBe('Refresh now');
  });

  it('says how long is left when it is not', () => {
    expect(refreshLabel(41_000)).toBe('Refresh now (wait 41s)');
    expect(refreshLabel(1)).toBe('Refresh now (wait 1s)');
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
      onRefreshNow: () => true,
      refreshCooldownMs: () => 0
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
        return true;
      },
      refreshCooldownMs: () => 0
    });

    expect(item('Refresh now').enabled).toBe(true);
    click(item('Refresh now'));
    expect(refreshes).toBe(1);
  });

  it('shows Refresh now disabled while the cooldown is running', () => {
    // The 60 s floor exists so the tray cannot be used to hammer the endpoints
    // by hand; a menu item that looks clickable and does nothing is worse.
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      getUsage: () => usageSnapshot(),
      onRefreshNow: () => false,
      refreshCooldownMs: () => 30_000
    });

    const entry = item('Refresh now (wait 30s)');
    expect(entry.enabled).toBe(false);
  });

  it('shows a status line per service, then its login and logout items', () => {
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
      onRefreshNow: () => true,
      refreshCooldownMs: () => 0
    });

    const accounts = submenu('Accounts');
    const labels = accounts.map((entry) => entry.label);
    expect(labels).toEqual([
      'Claude: ok via Claude Code login',
      'Log in…',
      'Log out',
      undefined, // the separator between the two services
      'ChatGPT: login needed',
      'Log in…',
      'Log out'
    ]);
    // The status lines are information, not actions.
    expect(accounts[0]?.enabled).toBe(false);
    expect(accounts[4]?.enabled).toBe(false);
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
      onRefreshNow: () => true,
      refreshCooldownMs: () => 0,
      onLogin: (service) => logins.push(service),
      onLogout: (service) => logouts.push(service)
    });

    const accounts = submenu('Accounts');
    // Positional, because both services offer identically-labelled items: the
    // first three entries are Claude's, the last three ChatGPT's.
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

    // Not for a change that leaves the dog where it is.
    click(item('Red', submenu('Colour')));
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

  it('offers the fullscreen-sleep switch, and remembers it', () => {
    const store = fakeStore();
    const changes: boolean[] = [];
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store,
      sheet,
      onQuit: () => {},
      onSleepInFullscreen: (on) => changes.push(on)
    });

    // On by default: above a film is the one place a mascot is in the way.
    expect(item('Sleep during fullscreen video').checked).toBe(true);
    click(item('Sleep during fullscreen video'), false);
    expect(read(store, 'sleepInFullscreen')).toBe(false);
    expect(changes).toEqual([false]);
    // Rebuilt, so the checkmark follows the store rather than going stale.
    expect(item('Sleep during fullscreen video').checked).toBe(false);
  });

  it('offers the hook installer', () => {
    let installs = 0;
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      onInstallHooks: () => {
        installs++;
      }
    });
    click(item('Install Claude Code hooks…'));
    expect(installs).toBe(1);
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
      onRefreshNow: () => true,
      refreshCooldownMs: () => 0
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
 * It exists because none of the three things it drives can be produced by hand
 * in a reasonable time: usage percentages arrive every three minutes, hook
 * events only while Claude Code is running, and a fullscreen video takes a film.
 * It is also the one part of the menu that must NOT reach a normal install — a
 * mascot that can be told to say "100% used" is a mascot nobody can trust.
 */
describe('the Developer submenu', () => {
  it('is shown unpackaged, and in a packaged build only with WALDER_DEV=1', () => {
    expect(developerMenuVisible({}, false)).toBe(true);
    expect(developerMenuVisible({}, true)).toBe(false);
    expect(developerMenuVisible({ WALDER_DEV: '1' }, true)).toBe(true);
    expect(developerMenuVisible({ WALDER_DEV: '0' }, true)).toBe(false);
  });

  it('is absent from a packaged build', () => {
    host.isPackaged = true;
    createTray({ getOverlay: () => spyOverlay().overlay, store: fakeStore(), sheet, onQuit: () => {} });
    expect(template().some((entry) => entry.label === 'Developer')).toBe(false);
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

  it('simulates each hook event', () => {
    const kinds: string[] = [];
    createTray({
      getOverlay: () => spyOverlay().overlay,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      onSimulateHook: (kind) => kinds.push(kind)
    });

    const hooks = (item('Simulate hook', submenu('Developer')).submenu ??
      []) as MenuItemConstructorOptions[];
    for (const kind of ['done', 'waiting', 'prompt']) click(item(kind, hooks));
    expect(kinds).toEqual(['done', 'waiting', 'prompt']);
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

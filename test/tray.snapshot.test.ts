/**
 * Every label the tray menu builds, for one representative state (both
 * services answering `ok`) — the tray half of the P2-6 string pin (see
 * `test/strings.snapshot.test.ts` for the rest and for the rule that step B
 * must never touch this snapshot either).
 *
 * A minimal copy of `test/tray.test.ts`'s own harness (the `electron` mock,
 * `fakeStore`) — pulling in the full harness (which also stubs the overlay for
 * click-driven tests) would be well past the ~40 lines this case needs, hence
 * the separate file. `createTray` never reads `getOverlay()` while building the
 * template — only from a menu-item's `click` handler — so `() => null` is
 * enough here; nothing in this file ever clicks anything.
 *
 * `process.platform` is pinned to `darwin` for the whole file: the shortcut
 * labels (`shortcutSubmenu` in `src/main/tray.ts`) and the default hide
 * shortcut are both derived from it, and a snapshot has to pick one wording
 * rather than drift with whatever machine or CI runner it happens to execute
 * on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import type { WalderSettings, WalderStore } from '../src/main/store';
import type { UsageSnapshot } from '../src/core/usage';

const host = vi.hoisted(() => ({
  templates: [] as unknown[][],
  isPackaged: false
}));

vi.mock('electron-store', () => ({ default: class {} }));

vi.mock('electron', () => {
  class FakeTray {
    setToolTip(): void {}
    setTitle(): void {}
    setContextMenu(): void {}
    on(): void {}
    popUpContextMenu(): void {}
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
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: () => {},
      getPath: () => '/tmp/walder-test'
    },
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => false,
        setTemplateImage: () => {}
      })
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

// `DEFAULT_HIDE_SHORTCUT` in `src/main/store.ts` is `defaultHideShortcut(process.platform)`,
// read once at module load — so the platform must be pinned before that module
// (reached through the dynamic `import` below) first evaluates.
const originalPlatform = process.platform;
beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
});
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

const { createTray } = await import('../src/main/tray');
const { DEFAULTS } = await import('../src/main/store');
const { loadSheet } = await import('../src/main/sheet');

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

/** Both services answering `ok`, one row each — a healthy, ordinary poll. */
function bothOk(): UsageSnapshot {
  return {
    fetchedAt: '2026-09-19T12:00:00.000Z',
    buckets: [],
    services: {
      claude: {
        buckets: [
          {
            id: 'claude.five_hour',
            service: 'claude',
            key: 'five_hour',
            label: '5-hour',
            pct: 63,
            resetsAt: null,
            priority: 0
          }
        ],
        status: 'ok',
        via: 'claude-oauth',
        viaLabel: 'Claude Code login'
      },
      chatgpt: {
        buckets: [
          {
            id: 'chatgpt.primary',
            service: 'chatgpt',
            key: 'primary',
            label: 'Codex 5-hour',
            pct: 91,
            resetsAt: null,
            priority: 0
          }
        ],
        status: 'ok',
        via: 'codex-cli',
        viaLabel: 'Codex CLI'
      },
      // Not logged in: the Accounts submenu still gets a Cursor status line,
      // which is the point of having it here, and the card draws no section.
      cursor: { buckets: [], status: 'unavailable', via: 'none', viaLabel: 'no source' }
    },
    expression: 'neutral',
    intervalMs: 180_000
  };
}

/** Every `label` in the template, walked recursively through `submenu`s, in order. */
function collectLabels(items: readonly MenuItemConstructorOptions[]): unknown[] {
  return items.flatMap((entry) => {
    const own = entry.label ?? (entry.type === 'separator' ? '---' : null);
    const nested = Array.isArray(entry.submenu)
      ? collectLabels(entry.submenu as MenuItemConstructorOptions[])
      : [];
    return own === null ? nested : [own, ...nested];
  });
}

beforeEach(() => {
  host.templates = [];
  host.isPackaged = false;
});

describe('the tray menu', () => {
  it('every label, both services ok, in order', () => {
    createTray({
      getOverlay: () => null,
      store: fakeStore(),
      sheet,
      onQuit: () => {},
      getUsage: () => bothOk(),
      onRefreshNow: () => true,
      refreshCooldownMs: () => 0
    });

    const template = host.templates.at(-1) as MenuItemConstructorOptions[];
    expect(collectLabels(template)).toMatchSnapshot();
  });
});

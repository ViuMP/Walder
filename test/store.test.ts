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
  SETTINGS_SCHEMA,
  applyLaunchAtLogin,
  clampToDisplays,
  defaultPosition,
  displayKey,
  launchAtLoginState,
  readCardSize,
  readCodexCreditPrice,
  DEFAULT_CODEX_CREDIT_PRICE,
  readHideShortcut,
  readPrimaryService,
  readSize,
  resolveStartPosition,
  savePosition
} = await import('../src/main/store');
const { DEFAULTS } = await import('../src/main/store');
const { DEFAULT_CARD_SIZE } = await import('../src/core/card-layout');
const { restoreSnapshot } = await import('../src/core/usage');
const { defaultHideShortcut } = await import('../src/core/shortcuts');
const { MAX_DISCOVERED } = await import('../src/providers/endpoint-discovery');

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

describe('the M4 settings additions', () => {
  it('defaults the discovered-endpoint lists to empty and the snapshot to null', () => {
    // First run must not look like "we already learned an endpoint" or "here is
    // a snapshot from before you installed this".
    expect(DEFAULTS.chatgptDiscoveredEndpoints).toEqual([]);
    expect(DEFAULTS.claudeDiscoveredEndpoints).toEqual([]);
    expect(DEFAULTS.lastSnapshot).toBeNull();
  });

  it('declares the hook port with a non-privileged default', () => {
    // Reserved now so the schema does not have to change again when the Claude
    // Code hook listener lands.
    expect(DEFAULTS.hookPort).toBeGreaterThan(1023);
    expect(DEFAULTS.hookPort).toBeLessThan(65_536);
  });

  it('keeps the poll interval default at the floor the scheduler enforces', () => {
    expect(DEFAULTS.pollIntervalSec).toBe(180);
  });

  it('describes the snapshot permissively in the schema, and strictly at runtime', () => {
    // `clearInvalidConfig` wipes the *whole* file when any value fails the
    // schema, so a snapshot shape that drifted by one field would also cost the
    // owner their position memory and colour choice. `restoreSnapshot` is what
    // validates it, dropping what it cannot read.
    const snapshotSchema = SETTINGS_SCHEMA['lastSnapshot'] as { type: string[] };
    expect(snapshotSchema.type).toEqual(['object', 'null']);

    expect(restoreSnapshot({ nonsense: true }, 180_000)).toBeNull();
  });

  it('defaults the behaviour keys the way the owner would expect', () => {
    // Sleeping over fullscreen video is on by default; the hook port has no
    // "actual" until the listener has really bound one.
    expect(DEFAULTS.sleepInFullscreen).toBe(true);
    expect(DEFAULTS.hookPortActual).toBeNull();
    expect(SETTINGS_SCHEMA['sleepInFullscreen']).toMatchObject({
      type: 'boolean',
      default: true
    });
    expect((SETTINGS_SCHEMA['hookPortActual'] as { type: string[] }).type).toEqual([
      'number',
      'null'
    ]);
  });

  it('defaults the hide-when-idle and update keys, and constrains neither string', () => {
    expect(DEFAULTS.hideWhenIdle).toBe(false);
    expect(DEFAULTS.checkForUpdates).toBe(true);
    expect(DEFAULTS.updateNotifiedVersion).toBeNull();
    expect(DEFAULTS.hideShortcut).toBe(defaultHideShortcut(process.platform));

    expect(SETTINGS_SCHEMA['hideWhenIdle']).toMatchObject({ type: 'boolean', default: false });
    expect(SETTINGS_SCHEMA['checkForUpdates']).toMatchObject({ type: 'boolean', default: true });

    /*
     * **No `pattern`, `minLength` or `enum` on either string.** This is the
     * assertion that stops a future edit from "tightening" the schema:
     * `clearInvalidConfig: true` wipes the *whole* settings file when any value
     * fails validation, so a pattern on the shortcut would mean one mistyped
     * accelerator also costs the owner his position memory, size and coat. The
     * real check is `readHideShortcut`, below.
     */
    const shortcut = SETTINGS_SCHEMA['hideShortcut'] as Record<string, unknown>;
    expect(shortcut['type']).toBe('string');
    expect(shortcut['pattern']).toBeUndefined();
    expect(shortcut['minLength']).toBeUndefined();
    expect(shortcut['enum']).toBeUndefined();
    expect(shortcut['default']).toBe(defaultHideShortcut(process.platform));

    const notified = SETTINGS_SCHEMA['updateNotifiedVersion'] as Record<string, unknown>;
    expect(notified['type']).toEqual(['string', 'null']);
    expect(notified['pattern']).toBeUndefined();
  });

  it('caps the stored endpoint lists in the schema at what discovery keeps', () => {
    const chatgpt = SETTINGS_SCHEMA['chatgptDiscoveredEndpoints'] as { maxItems: number };
    expect(chatgpt.maxItems).toBe(MAX_DISCOVERED);
  });

  it('describes the behaviour memory as permissively as the snapshot', () => {
    /*
     * The same trade, for the same reason: this is a blob the app writes whose
     * shape will drift as the coordinator grows, and `clearInvalidConfig` wipes
     * the *whole* file when any value fails the schema — so one drifted field
     * would cost the owner his position memory and his coat. `Behaviour`
     * validates it field by field instead, and a memory it cannot read costs
     * one duplicate bark.
     */
    expect(DEFAULTS.behaviourMemory).toBeNull();
    const entry = SETTINGS_SCHEMA['behaviourMemory'] as Record<string, unknown>;
    expect(entry['type']).toEqual(['object', 'null']);
    expect(entry['properties']).toBeUndefined();
    expect(entry['required']).toBeUndefined();
    expect(entry['default']).toBeNull();
  });

  it('round-trips a behaviour memory through a store-shaped object', () => {
    // Both values the schema admits: the `null` of a first run, and the object
    // written after the first poll.
    const store = fakeStore();
    expect(read(store, 'behaviourMemory')).toBeNull();

    const memory = {
      barks: {
        buckets: {
          'claude.five_hour': { lastFired: 80, lastPct: 81, resetsAt: '2026-09-15T15:00:00Z' }
        }
      },
      exhausted: { 'chatgpt.codex_credits': true }
    };
    store.set('behaviourMemory', memory);
    expect(read(store, 'behaviourMemory')).toEqual(memory);
  });

  it('round-trips a snapshot through a store-shaped object', () => {
    const store = fakeStore();
    const snapshot = {
      fetchedAt: '2026-09-08T15:00:00Z',
      intervalMs: 180_000,
      buckets: [
        {
          id: 'claude.five_hour',
          service: 'claude' as const,
          key: 'five_hour',
          label: '5-hour',
          pct: 42.5,
          resetsAt: null,
          priority: 0
        }
      ],
      services: {
        claude: { status: 'ok' as const, via: 'claude-oauth', viaLabel: 'Claude Code login' },
        chatgpt: { status: 'unavailable' as const, via: 'none', viaLabel: 'no source' }
      }
    };
    store.set('lastSnapshot', snapshot);
    const restored = restoreSnapshot(read(store, 'lastSnapshot'), 180_000);
    expect(restored?.buckets).toHaveLength(1);
    expect(restored?.services.claude.viaLabel).toBe('Claude Code login');
  });
});

describe('readSize', () => {
  it('passes a valid size through', () => {
    expect(readSize(fakeStore({ size: 'large' }))).toBe('large');
  });

  it('falls back to the default for anything the schema lets through', () => {
    for (const junk of ['enormous', 'Large', '', 42, null, undefined]) {
      expect(readSize(fakeStore({ size: junk as never })), String(junk)).toBe(DEFAULTS.size);
    }
  });

  it('is a bare string in the schema, so one typo cannot erase all settings', () => {
    const size = SETTINGS_SCHEMA['size'] as Record<string, unknown>;
    expect(size['type']).toBe('string');
    expect(size['enum']).toBeUndefined();
    expect(size['pattern']).toBeUndefined();
    expect(size['minLength']).toBeUndefined();
    expect(size['default']).toBe('medium');
  });
});

describe('readCardSize', () => {
  it('passes a valid card size through', () => {
    for (const size of ['large', 'medium', 'small'] as const) {
      expect(readCardSize(fakeStore({ cardSize: size }))).toBe(size);
    }
  });

  it('starts Large, which is the only layout that explains itself', () => {
    expect(DEFAULTS.cardSize).toBe(DEFAULT_CARD_SIZE);
    expect(DEFAULTS.cardSize).toBe('large');
  });

  it('falls back to Large for anything the schema let through', () => {
    // Which is *any* string, deliberately — see the schema assertion below.
    for (const junk of ['tiny', 'Large', '', 42, null, undefined]) {
      expect(readCardSize(fakeStore({ cardSize: junk as never })), String(junk)).toBe(
        DEFAULTS.cardSize
      );
    }
  });

  it('is a bare string in the schema: no enum, no pattern', () => {
    /*
     * The same trade `hideShortcut` makes, and the assertion that stops a future
     * edit from "tightening" it: `clearInvalidConfig: true` wipes the *whole*
     * settings file when any value fails validation, so an enum here would mean
     * one hand-typed `cardSize: "tiny"` also costs the owner his position
     * memory, his size and his coat. `readCardSize` is the real check.
     */
    const cardSize = SETTINGS_SCHEMA['cardSize'] as Record<string, unknown>;
    expect(cardSize['type']).toBe('string');
    expect(cardSize['enum']).toBeUndefined();
    expect(cardSize['pattern']).toBeUndefined();
    expect(cardSize['minLength']).toBeUndefined();
    expect(cardSize['default']).toBe('large');
  });

  it('is independent of the dog’s own size', () => {
    // A 3x dog with a Small card is a perfectly reasonable choice.
    const store = fakeStore({ size: 'large', cardSize: 'small' });
    expect(readSize(store)).toBe('large');
    expect(readCardSize(store)).toBe('small');
  });
});

describe('readPrimaryService', () => {
  it('round-trips either service', () => {
    for (const service of ['claude', 'chatgpt'] as const) {
      expect(readPrimaryService(fakeStore({ primaryService: service }))).toBe(service);
    }
  });

  it('starts on Claude', () => {
    expect(DEFAULTS.primaryService).toBe('claude');
    expect(readPrimaryService(fakeStore())).toBe('claude');
  });

  it('falls back to Claude for anything the schema let through', () => {
    for (const junk of ['gemini', 'Claude', '', 42, null, undefined]) {
      expect(readPrimaryService(fakeStore({ primaryService: junk as never })), String(junk)).toBe(
        DEFAULTS.primaryService
      );
    }
  });

  it('is a bare string in the schema: no enum, no pattern', () => {
    // The `cardSize` trade, for the same reason: `clearInvalidConfig: true`
    // wipes the whole settings file when one value fails validation, so an
    // enum here would make a hand-typed `primaryService: "gemini"` cost the
    // owner his positions, his coat and his card size too.
    const entry = SETTINGS_SCHEMA['primaryService'] as Record<string, unknown>;
    expect(entry['type']).toBe('string');
    expect(entry['enum']).toBeUndefined();
    expect(entry['pattern']).toBeUndefined();
    expect(entry['minLength']).toBeUndefined();
    expect(entry['default']).toBe('claude');
  });
});

describe('readCodexCreditPrice', () => {
  it('defaults to OpenAI\'s published list price', () => {
    expect(DEFAULTS.codexCreditPrice).toEqual({ amount: 0.04, currency: 'USD' });
    expect(readCodexCreditPrice(fakeStore())).toEqual(DEFAULT_CODEX_CREDIT_PRICE);
    // USD 40 per 1,000 credits, which is what 0.04 has to mean.
    expect(DEFAULT_CODEX_CREDIT_PRICE.amount * 1000).toBeCloseTo(40);
  });

  it('takes a price the owner set, normalising the currency', () => {
    expect(
      readCodexCreditPrice(fakeStore({ codexCreditPrice: { amount: 0.037, currency: 'eur' } }))
    ).toEqual({ amount: 0.037, currency: 'EUR' });
  });

  it('treats an explicit null as "do not estimate", not as a mistake', () => {
    // The row then shows the credit counts the provider stated, which is the
    // right answer for anyone who would rather see no number than a wrong one.
    expect(readCodexCreditPrice(fakeStore({ codexCreditPrice: null }))).toBeNull();
  });

  it('falls back to the list price for anything unusable', () => {
    // A mangled file is not the owner turning the estimate off — only a literal
    // `null` is — so these fall back to the price rather than to nothing.
    const junk = [
      'free',
      42,
      {},
      { amount: 0, currency: 'USD' },
      { amount: -0.04, currency: 'USD' },
      { amount: '0.04', currency: 'USD' },
      { amount: 0.04, currency: 'DOLLAR' },
      { amount: 0.04 },
      undefined
    ];
    for (const bad of junk) {
      expect(
        readCodexCreditPrice(fakeStore({ codexCreditPrice: bad as never })),
        JSON.stringify(bad)
      ).toEqual(DEFAULT_CODEX_CREDIT_PRICE);
    }
  });

  it('is a bare object-or-null in the schema: no properties, no required', () => {
    // The same trade `cardSize` makes above, and for a sharper reason: this is
    // the only setting with no UI behind it, so it is the one most likely to be
    // hand-edited — and `clearInvalidConfig` wipes the whole file on a failure.
    const price = SETTINGS_SCHEMA['codexCreditPrice'] as Record<string, unknown>;
    expect(price['type']).toEqual(['object', 'null']);
    expect(price['properties']).toBeUndefined();
    expect(price['required']).toBeUndefined();
    expect(price['default']).toEqual(DEFAULT_CODEX_CREDIT_PRICE);
  });
});

describe('readHideShortcut', () => {
  const fallback = defaultHideShortcut(process.platform);

  it('passes a usable accelerator through, trimmed', () => {
    expect(readHideShortcut(fakeStore({ hideShortcut: 'Shift+F9' }))).toBe('Shift+F9');
    expect(readHideShortcut(fakeStore({ hideShortcut: '  Shift+F9  ' }))).toBe('Shift+F9');
  });

  it('falls back to the platform default for anything the schema let through', () => {
    // The whole reason the validation is here and not in the schema: each of
    // these costs the owner his shortcut and nothing else.
    for (const stored of ['', '   ', 'Control+', 'Super+W', 'W', 'nonsense']) {
      expect(readHideShortcut(fakeStore({ hideShortcut: stored })), stored).toBe(fallback);
    }
    expect(readHideShortcut(fakeStore({ hideShortcut: undefined as never }))).toBe(fallback);
    expect(readHideShortcut(fakeStore({ hideShortcut: 42 as never }))).toBe(fallback);
  });
});

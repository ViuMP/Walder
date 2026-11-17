/**
 * The settings layer: the spec in `core/settings-spec`, the one writer in
 * `main/settings.ts`, and the round trip through the real settings file.
 *
 * Every setting is written through the controller into a real `walder.json`
 * in a temp directory, the store is opened again from disk, and a fresh
 * controller must read the same value back. Only `electron` is mocked.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loginItemWrites: boolean[] = [];
const app = {
  getPath: () => tmpdir(),
  getVersion: () => '0.0.0-test',
  isPackaged: false,
  getLoginItemSettings: () => ({ openAtLogin: false }),
  setLoginItemSettings: (s: { openAtLogin: boolean }) => loginItemWrites.push(s.openAtLogin)
};

vi.mock('electron', () => {
  const ipcMain = { on: () => {} };
  const screen = { getAllDisplays: () => [] };
  return { default: { app, ipcMain, shell: {} }, app, ipcMain, screen };
});

const { DEFAULTS, createStore } = await import('../src/main/store');
const { createSettings, standardEffects } = await import('../src/main/settings');
const { loadSheet } = await import('../src/main/sheet');
const { CH } = await import('../src/main/ipc');
const { setVerbose, verbose } = await import('../src/main/log');
type Overlay = import('../src/main/overlay-window').Overlay;
type EffectDeps = import('../src/main/settings').EffectDeps;
const spec = await import('../src/core/settings-spec');
const { SETTINGS, SETTING_KEYS, APP_STATE_KEYS, settingDefaults } = spec;
type UserSettings = import('../src/core/settings-spec').UserSettings;
type SettingKey = import('../src/core/settings-spec').SettingKey;

const PALETTES = ['golden', 'red', 'cream'];
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'walder-settings-'));
  app.isPackaged = false;
  loginItemWrites.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function controller(store = createStore(dir), effects = {}, verboseForced = false) {
  return createSettings({
    store,
    palettes: () => PALETTES,
    effects,
    verboseForced: () => verboseForced
  });
}

/** A valid value for each key that is not its default. */
const CHANGED: Omit<UserSettings, 'launchAtLogin' | 'verboseLog'> = {
  size: 'large',
  palette: 'cream',
  cardSize: 'small',
  resetStyle: 'countdown',
  stillMode: true,
  barkPreset: 'chatty',
  barkSound: true,
  primaryService: 'chatgpt',
  notifyWhenHidden: true,
  hiddenServices: ['cursor', 'gemini'],
  hideWhenIdle: true,
  hideShortcut: 'Alt+Shift+H',
  sleepInFullscreen: false,
  pollIntervalSec: 600,
  codexCreditPrice: { amount: 0.05, currency: 'EUR' },
  checkForUpdates: false,
  hookPort: 50_000,
  forceInteractive: true
};

describe('the spec', () => {
  it('names every key in the settings file exactly once, as a setting or as app state', () => {
    const named = [...SETTING_KEYS, ...APP_STATE_KEYS].sort();
    expect(named).toEqual(Object.keys(DEFAULTS).sort());
    expect(new Set(named).size).toBe(named.length);
  });

  it('is where the store takes its defaults from', () => {
    const defaults = settingDefaults(process.platform);
    for (const key of SETTING_KEYS) {
      // `hiddenServices` is stored as `null` until first set: the migration sentinel.
      if (key === 'hiddenServices') continue;
      expect(DEFAULTS[key], key).toEqual(defaults[key]);
    }
  });

  it('is listed in SETTINGS.md, one row per key', () => {
    const doc = readFileSync(new URL('../SETTINGS.md', import.meta.url), 'utf8');
    for (const key of SETTING_KEYS) expect(doc, key).toContain(`\`${key}\``);
  });

  it('accepts each default and rejects junk for every key', () => {
    const defaults = settingDefaults(process.platform);
    for (const entry of SETTINGS) {
      expect(entry.validate(defaults[entry.key], { palettes: PALETTES }).ok, entry.key).toBe(true);
      expect(entry.validate({ junk: true }, { palettes: PALETTES }).ok, entry.key).toBe(false);
    }
  });

  it('holds the numeric limits the app actually uses', () => {
    const poll = SETTINGS.find((s) => s.key === 'pollIntervalSec');
    expect(poll?.validate(179, { palettes: [] }).ok).toBe(false);
    expect(poll?.validate(180, { palettes: [] }).ok).toBe(true);
    expect(poll?.validate(90.5, { palettes: [] }).ok).toBe(false);
    const port = SETTINGS.find((s) => s.key === 'hookPort');
    expect(port?.validate(1023, { palettes: [] }).ok).toBe(false);
    expect(port?.validate(65_536, { palettes: [] }).ok).toBe(false);
  });
});

describe('the settings writer', () => {
  it.each(Object.entries(CHANGED))('saves %s and reads it back after the file is reopened', (key, value) => {
    const result = controller().set(key, value);
    expect(result).toMatchObject({ ok: true, saved: true });
    expect(controller(createStore(dir)).get(key as SettingKey)).toEqual(value);
  });

  it('upper-cases a currency and removes duplicate services', () => {
    const settings = controller();
    settings.set('codexCreditPrice', { amount: 1, currency: 'eur' });
    settings.set('hiddenServices', ['cursor', 'cursor']);
    expect(settings.get('codexCreditPrice')).toEqual({ amount: 1, currency: 'EUR' });
    expect(settings.get('hiddenServices')).toEqual(['cursor']);
  });

  it('turns the credit estimate off with null', () => {
    const settings = controller();
    expect(settings.set('codexCreditPrice', null).ok).toBe(true);
    expect(controller(createStore(dir)).get('codexCreditPrice')).toBeNull();
  });

  it('refuses app state, unknown keys and invalid values, and writes nothing', () => {
    const store = createStore(dir);
    const settings = controller(store);
    expect(settings.set('positions', {}).ok).toBe(false);
    expect(settings.set('lastSnapshot', null).ok).toBe(false);
    expect(settings.set('nope', 1).ok).toBe(false);
    expect(settings.set('size', 'huge').ok).toBe(false);
    expect(settings.set('palette', 'purple').ok).toBe(false);
    expect(settings.set('hideShortcut', 'W').ok).toBe(false);
    expect(store.get('size')).toBe(DEFAULTS.size);
    expect(store.get('palette')).toBe(DEFAULTS.palette);
  });

  it('runs the side effect with the checked value and tells every listener', () => {
    const sizes: string[] = [];
    const heard: string[] = [];
    const settings = controller(createStore(dir), { size: (s: string) => sizes.push(s) });
    settings.onChange((key, all) => heard.push(`${key}=${all.size}`));
    settings.set('size', 'small');
    expect(sizes).toEqual(['small']);
    expect(heard).toEqual(['size=small']);
  });

  it('applies a change it could not save, and says so', () => {
    const real = createStore(dir);
    // The real store for reads, a disk-full one for writes.
    const failing = {
      get: (key: string) => real.get(key as never),
      set: () => {
        throw new Error('EACCES');
      }
    } as unknown as typeof real;
    const applied: boolean[] = [];
    const settings = controller(failing, { stillMode: (on: boolean) => applied.push(on) });
    expect(settings.set('stillMode', true)).toMatchObject({ ok: true, saved: false });
    expect(applied).toEqual([true]);
  });

  it('keeps going when a side effect throws', () => {
    const settings = controller(createStore(dir), {
      barkSound: () => {
        throw new Error('no window');
      }
    });
    expect(settings.set('barkSound', true)).toMatchObject({ ok: true, saved: true });
  });

  it('locks Launch at login outside the installed app, and the verbose log when WALDER_LOG forces it', () => {
    expect(controller().set('launchAtLogin', true).ok).toBe(false);
    expect(controller().locked().launchAtLogin).toBeDefined();
    const forced = controller(createStore(dir), {}, true);
    expect(forced.set('verboseLog', false).ok).toBe(false);
  });

  it('shows the fallback for a hand-mangled value, not the junk', () => {
    writeFileSync(
      join(dir, 'walder.json'),
      JSON.stringify({ ...DEFAULTS, cardSize: 'gigantic', palette: 'plaid', pollIntervalSec: 31 })
    );
    const snapshot = controller().snapshot();
    expect(snapshot.cardSize).toBe(DEFAULTS.cardSize);
    expect(snapshot.palette).toBe(DEFAULTS.palette);
    expect(snapshot.pollIntervalSec).toBe(DEFAULTS.pollIntervalSec);
  });
});

describe('an older settings file', () => {
  it('opens a 0.2.9 file unchanged apart from the stale Claude discovery list', () => {
    const old = {
      ...DEFAULTS,
      size: 'small',
      hiddenServices: null,
      hiddenBuckets: ['cursor:plan'],
      claudeDiscoveredEndpoints: ['/api/organizations/abc/usage'],
      positions: { '1:1728x1117': { x: 10, y: 20 } }
    };
    writeFileSync(join(dir, 'walder.json'), JSON.stringify(old));
    const store = createStore(dir);
    expect(store.get('size')).toBe('small');
    expect(store.get('positions')).toEqual(old.positions);
    expect(store.get('claudeDiscoveredEndpoints')).toEqual([]);
    expect(controller(store).get('size')).toBe('small');
  });
});

/**
 * What each setting does once stored (`standardEffects`). These used to be
 * tested through the tray's menu items; the menu no longer offers most of them,
 * so they are driven here through the one writer, the way the settings window
 * drives them, and the store write is checked alongside the effect.
 */
describe('the standard side effects', () => {
  const sheet = loadSheet();

  /** An overlay that records what reached it, payloads included. */
  function spyOverlay(destroyed = false) {
    const calls: unknown[][] = [];
    const overlay = {
      win: { isDestroyed: () => destroyed },
      applySize: (scale: number) => calls.push(['applySize', scale]),
      setForceInteractive: (on: boolean) => calls.push(['setForceInteractive', on]),
      currentMode: () => ({ scale: 3, box: 'stand', facing: 'left', hidden: false, still: false }),
      send: (channel: string, payload: unknown) => calls.push(['send', channel, payload])
    } as unknown as Overlay;
    return { overlay, calls };
  }

  function wired(extra: Partial<EffectDeps> = {}, palettes: readonly string[] = PALETTES) {
    const store = createStore(dir);
    const settings = createSettings({
      store,
      palettes: () => palettes,
      effects: standardEffects({ getOverlay: () => null, sheet, ...extra })
    });
    return { store, settings };
  }

  it.each([
    ['cardSize', 'small', 'onCardSize'],
    ['resetStyle', 'countdown', 'onResetStyle'],
    ['barkPreset', 'chatty', 'onBarkPreset'],
    ['barkSound', true, 'onBarkSound'],
    ['primaryService', 'chatgpt', 'onPrimaryService'],
    ['hiddenServices', ['cursor', 'gemini'], 'onHiddenServices'],
    ['sleepInFullscreen', false, 'onSleepInFullscreen'],
    ['stillMode', true, 'onStillMode'],
    ['hideWhenIdle', true, 'onHideWhenIdle'],
    ['hideShortcut', 'Alt+Shift+H', 'onHideShortcut']
  ] as const)('%s: stores the value and hands it to its dep once', (key, value, dep) => {
    const heard: unknown[] = [];
    const { store, settings } = wired({ [dep]: (v: unknown) => heard.push(v) });
    expect(settings.set(key, value)).toMatchObject({ ok: true, saved: true });
    expect(heard).toEqual([value]);
    expect(store.get(key)).toEqual(value);
  });

  it('resizes the overlay, resends its mode and reports the geometry change', () => {
    const spy = spyOverlay();
    let moved = 0;
    const { store, settings } = wired({
      getOverlay: () => spy.overlay,
      onGeometryChanged: () => moved++
    });
    settings.set('size', 'large');
    expect(spy.calls.map((c) => c.slice(0, 2))).toEqual([
      ['applySize', 3],
      ['send', CH.modeSet]
    ]);
    expect(moved).toBe(1);
    expect(store.get('size')).toBe('large');
  });

  it('sends the resolved coat to the overlay, and colours null for a coat the sheet lacks', () => {
    const spy = spyOverlay();
    // `palettes: []` accepts any id, so a coat the sheet does not have reaches the effect.
    const { store, settings } = wired({ getOverlay: () => spy.overlay }, []);
    settings.set('palette', 'red');
    expect(spy.calls[0]).toEqual(['send', CH.paletteSet, { name: 'red', colors: sheet.palettes['red'] }]);
    settings.set('palette', 'merle');
    // `colors: null` is the renderer's cue to draw the golden fallback.
    expect(spy.calls[1]).toEqual(['send', CH.paletteSet, { name: 'merle', colors: null }]);
    expect(store.get('palette')).toBe('merle');
  });

  it('switches force interactive on the overlay', () => {
    const spy = spyOverlay();
    const { store, settings } = wired({ getOverlay: () => spy.overlay });
    settings.set('forceInteractive', true);
    expect(spy.calls).toEqual([['setForceInteractive', true]]);
    expect(store.get('forceInteractive')).toBe(true);
  });

  it.each([
    ['no overlay', null],
    ['a destroyed overlay', 'destroyed']
  ] as const)('survives %s and still stores the preference', (_, kind) => {
    const spy = spyOverlay(kind === 'destroyed');
    let moved = 0;
    const { store, settings } = wired({
      getOverlay: () => (kind === null ? null : spy.overlay),
      onGeometryChanged: () => moved++
    });
    expect(settings.set('size', 'large')).toMatchObject({ ok: true, saved: true });
    expect(settings.set('palette', 'red')).toMatchObject({ ok: true, saved: true });
    expect(settings.set('forceInteractive', true)).toMatchObject({ ok: true, saved: true });
    expect(spy.calls).toEqual([]);
    expect(moved).toBe(0);
    expect([store.get('size'), store.get('palette'), store.get('forceInteractive')]).toEqual([
      'large',
      'red',
      true
    ]);
  });

  it('still stores every preference with nothing wired', () => {
    const { store, settings } = wired();
    for (const [key, value] of Object.entries(CHANGED)) {
      expect(settings.set(key, value).ok, key).toBe(true);
      expect(store.get(key as SettingKey), key).toEqual(value);
    }
  });

  it('registers the login item in a packaged build', () => {
    app.isPackaged = true;
    const { settings } = wired();
    expect(settings.set('launchAtLogin', true).ok).toBe(true);
    expect(loginItemWrites).toEqual([true]);
  });

  it('turns the verbose log on and off', () => {
    const before = verbose();
    try {
      const { settings } = wired();
      settings.set('verboseLog', true);
      expect(verbose()).toBe(true);
      settings.set('verboseLog', false);
      expect(verbose()).toBe(false);
    } finally {
      setVerbose(before);
    }
  });
});

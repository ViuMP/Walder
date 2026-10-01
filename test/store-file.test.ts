/**
 * The settings file, opened for real.
 *
 * `test/store.test.ts` mocks `electron-store` to an empty class, which is right
 * for the functions it tests and means `SETTINGS_SCHEMA` and
 * `clearInvalidConfig` never run in the suite. Here they do: a real
 * `electron-store` against a real `walder.json` in a temp directory, reached by
 * `createStore(cwd)`. Only `electron` is mocked, with the three calls
 * electron-store makes at construction.
 *
 * The expensive thing being pinned is the second test. Left to itself,
 * `clearInvalidConfig` wipes the *whole* file when any single value fails the
 * schema — QA row 4.24 on 0.2.8 lost an owner's positions to one hand-typed
 * `codexCreditPrice`. `dropInvalidKeys` now drops only the offending keys before
 * conf validates, and that test fails loudly if the wipe ever comes back. A file
 * that is not JSON at all still resets, which the third test pins.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const app = {
  getPath: () => tmpdir(),
  getVersion: () => '0.0.0-test',
  isPackaged: false
};

// `electron-store` destructures the *default* export; `store.ts` imports the
// named ones. Both have to be here.
vi.mock('electron', () => {
  const ipcMain = { on: () => {} };
  const screen = { getAllDisplays: () => [] };
  return { default: { app, ipcMain, shell: {} }, app, ipcMain, screen };
});

const { DEFAULTS, createStore, readBarkSound, readCardSize, readResetStyle } = await import('../src/main/store');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'walder-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write `walder.json` by hand, the way an owner with an editor would. */
function writeFile(settings: Record<string, unknown>): void {
  writeFileSync(join(dir, 'walder.json'), JSON.stringify(settings));
}

describe('the settings file', () => {
  it('round-trips a valid file', () => {
    writeFile({ ...DEFAULTS, cardSize: 'small', positions: { 'd:1x1': { x: 1, y: 2 } } });

    const store = createStore(dir);
    expect(store.get('cardSize')).toBe('small');
    expect(store.get('positions')).toEqual({ 'd:1x1': { x: 1, y: 2 } });
    expect(store.get('schemaVersion')).toBe(1);

    store.set('cardSize', 'medium');
    expect(createStore(dir).get('cardSize')).toBe('medium');
  });

  it('drops only the key that fails the schema and keeps the rest of the file', () => {
    const positions = { 'd:1x1': { x: 1, y: 2 } };
    writeFile({
      ...DEFAULTS,
      // Three values that each fail their own schema entry.
      codexCreditPrice: 'abc',
      pollIntervalSec: 'fast',
      launchAtLogin: 'yes',
      // Five non-default values that must survive them.
      positions,
      introduced: true,
      verboseLog: true,
      size: 'large',
      hiddenServices: ['cursor']
    });

    const store = createStore(dir);
    expect(store.get('codexCreditPrice')).toEqual(DEFAULTS.codexCreditPrice);
    expect(store.get('pollIntervalSec')).toBe(DEFAULTS.pollIntervalSec);
    expect(store.get('launchAtLogin')).toBe(DEFAULTS.launchAtLogin);
    expect(store.get('positions')).toEqual(positions);
    expect(store.get('introduced')).toBe(true);
    expect(store.get('verboseLog')).toBe(true);
    expect(store.get('size')).toBe('large');
    expect(store.get('hiddenServices')).toEqual(['cursor']);

    // The dropped key is filled in memory only; the next write puts the default
    // on disk beside everything that was kept.
    store.set('cardSize', 'small');
    const onDisk = JSON.parse(readFileSync(join(dir, 'walder.json'), 'utf8'));
    expect(onDisk.codexCreditPrice).toEqual(DEFAULTS.codexCreditPrice);
    expect(onDisk.positions).toEqual(positions);
  });

  it('still resets a file that is not JSON at all', () => {
    writeFileSync(join(dir, 'walder.json'), '{ "positions": { "d:1x1": ');

    const store = createStore(dir);
    expect(store.get('positions')).toEqual(DEFAULTS.positions);
    expect(store.get('pollIntervalSec')).toBe(DEFAULTS.pollIntervalSec);
  });

  it('a schema-valid but reader-invalid value costs only that preference', () => {
    writeFile({ ...DEFAULTS, cardSize: 'tiny', resetStyle: 'sundial', positions: { 'd:1x1': { x: 1, y: 2 } } });

    const store = createStore(dir);
    expect(readCardSize(store)).toBe(DEFAULTS.cardSize);
    expect(readResetStyle(store)).toBe(DEFAULTS.resetStyle);
    expect(readBarkSound(store)).toBe(false);
    expect(store.get('positions')).toEqual({ 'd:1x1': { x: 1, y: 2 } });
  });

  it('stamps a fresh file with schemaVersion 1', () => {
    const store = createStore(dir);
    expect(store.get('schemaVersion')).toBe(1);

    store.set('cardSize', 'small');
    expect(JSON.parse(readFileSync(join(dir, 'walder.json'), 'utf8')).schemaVersion).toBe(1);
  });
});

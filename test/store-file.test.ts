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
 * The expensive thing being pinned is the second test. `clearInvalidConfig`
 * wipes the *whole* file when any single value fails the schema — that is the
 * cost the comments all over `SETTINGS_SCHEMA` keep citing as the reason a
 * `cardSize` or a `hideShortcut` is typed as a bare string, and it should fail
 * loudly here if a later edit tightens one of them.
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

  it('wipes to the defaults when a value fails the schema', () => {
    writeFile({ ...DEFAULTS, pollIntervalSec: 'fast', positions: { 'd:1x1': { x: 1, y: 2 } } });

    const store = createStore(dir);
    expect(store.get('pollIntervalSec')).toBe(DEFAULTS.pollIntervalSec);
    // The whole file went, not just the bad key.
    expect(store.get('positions')).toEqual(DEFAULTS.positions);
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

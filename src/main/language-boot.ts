/**
 * Fix main's language before the rest of main is evaluated.
 *
 * About three dozen constants in core call `t()` at import and are frozen from
 * then on (`core/strings.ts` has the list of reasons). Main is one entry and one
 * chunk, where evaluation order is import order, so this module is the FIRST
 * import of `index.ts` and calls `setLanguage` as it is evaluated.
 * `test/language-boot.test.ts` fails if it stops being first, or if it starts
 * importing anything that could itself call `t()` first.
 *
 * Read straight from `walder.json`, not through the store: the store needs
 * `app.getPath('userData')`, which must not be asked before `ready`. A missing
 * or unreadable file, or a value that is not one of ours, means `system`.
 *
 * shortcut: `app.getPreferredSystemLanguages()` is asked before `ready`; if
 * Electron ever refuses that, `System` falls back to English (an explicit
 * choice still works). Check on the first packaged run of each Electron major.
 */
import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { walderStorePath } from './store-path';
import { setLanguage } from '../core/strings';
import { resolveLanguage } from '../core/i18n';

let stored: unknown;
try {
  stored = (JSON.parse(readFileSync(walderStorePath(), 'utf8')) as { language?: unknown }).language;
} catch {
  // First run, or a file the store will repair: System.
}
let preferred: string[] = [];
try {
  preferred = app.getPreferredSystemLanguages();
} catch {
  // English.
}
setLanguage(resolveLanguage(stored, preferred));

/**
 * `t()`: how anything in Walder turns a key into words, in the active language.
 *
 * The words live in `src/core/i18n/<lang>.ts`, one flat table per language,
 * English the reference (`i18n/en.ts`). Dotted, flat keys (`'bubble.hookDone'`)
 * rather than nested objects: a nested `STRINGS.bubble.hookDone` reads the same
 * but makes `keyof` recursive and every call site's key a property-access chain
 * instead of one string a translator could grep for.
 *
 * **The language is fixed before anything else is evaluated**, because about
 * three dozen constants across core (`SOURCE_LABEL`, the bubble `*_TEXT`s,
 * `SETTINGS`' labels…) call `t()` at import and are frozen from then on. So:
 *  - in a renderer page, this module reads `?lang=` from its own URL as it is
 *    evaluated, and every frozen constant is a real import dependent of it;
 *  - in main, `src/main/language-boot.ts` is the first import of `index.ts` and
 *    calls `setLanguage` before the rest of main is evaluated;
 *  - in tests and the CLI scripts there is no `location` and no boot, so the
 *    frozen constants are English.
 * A change of the Language setting therefore applies after a restart.
 *
 * ponytail: no plurals, no gender, no ICU MessageFormat — `{name}` is a plain
 * substitution and nothing here counts or genders anything. The two counted
 * strings (`refreshed {n} min ago`, `{n} hours`) are written number-safe in
 * every table (abbreviated units). The upgrade path is one formatter behind `t`
 * that dispatches to `Intl.PluralRules`, not a rewrite of every call site.
 */
import { RTL, TABLES, en, parseLanguage, type Language, type StringKey } from './i18n';

export type { Language, StringKey } from './i18n';
/** The English table, under its historical name. */
export const STRINGS = en;

// The page URL carries the language main chose (`?lang=da`); absent in main and in tests.
const search = (globalThis as { location?: { search?: string } }).location?.search ?? '';
let active: Language = parseLanguage(new URLSearchParams(search).get('lang'));

/** Switch language. Main's boot calls it once; tests restore `'en'` after. */
export function setLanguage(language: Language): void {
  active = language;
}

export function language(): Language {
  return active;
}

export function isRtl(): boolean {
  return RTL.has(active);
}

/** Right-to-Left Isolate, First Strong Isolate and Pop Directional Isolate. */
const RLI = '\u2067';
const FSI = '\u2068';
const PDI = '\u2069';
/** Arabic script: a value with any of it is a right-to-left phrase, whatever letter it starts with. */
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u;

/**
 * Look up `key` and substitute `{name}` placeholders from `params`.
 *
 * One `replace`, as asked: a placeholder with no matching param is left
 * exactly as written rather than becoming `undefined` or throwing — a missing
 * param is a programming mistake worth seeing on screen (`{tool}` staring back
 * from a menu is a bug report waiting to happen), not a reason to crash the
 * one file that draws Walder's whole interface.
 *
 * In a right-to-left language every **string** parameter is wrapped in Unicode
 * isolates (right to left for an Arabic phrase, by its first letter otherwise), so a path, a shortcut, a version or a formatted `87%` keeps its own
 * left-to-right order inside an Arabic sentence. **Number** parameters stay
 * bare: in `{pct}%` an isolated number would come apart from its percent sign.
 */
export function t(key: StringKey, params?: Readonly<Record<string, string | number>>): string {
  const template = TABLES[active][key];
  if (params === undefined) return template;
  const rtl = RTL.has(active);
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
    const value = params[name];
    if (!rtl || typeof value !== 'string') return String(value);
    // `Claude 5 ساعات` starts with a Latin letter, so a first-strong isolate would
    // lay it out left to right, and an Arabic reader would meet `ساعات` last: an
    // Arabic phrase is isolated right to left, anything else (a path,
    // `Alt+Shift+W`) by its own first letter.
    return `${ARABIC.test(value) ? RLI : FSI}${value}${PDI}`;
  });
}

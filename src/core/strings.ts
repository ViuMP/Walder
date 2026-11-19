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
import { TABLES, en, parseLanguage, type Language, type StringKey } from './i18n';

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

/**
 * Look up `key` and substitute `{name}` placeholders from `params`.
 *
 * One `replace`, as asked: a placeholder with no matching param is left
 * exactly as written rather than becoming `undefined` or throwing — a missing
 * param is a programming mistake worth seeing on screen (`{tool}` staring back
 * from a menu is a bug report waiting to happen), not a reason to crash the
 * one file that draws Walder's whole interface.
 */
export function t(key: StringKey, params?: Readonly<Record<string, string | number>>): string {
  const template = TABLES[active][key];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!Object.hasOwn(params, name)) return match;
    return String(params[name]);
  });
}

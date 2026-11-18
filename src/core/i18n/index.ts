/**
 * The languages Walder speaks, and how one is chosen.
 *
 * Imports the tables and nothing else: `src/main/language-boot.ts` runs before
 * any other module of main is evaluated, and its import graph must stay this
 * small (`test/language-boot.test.ts`).
 */
import { en } from './en';
import { da } from './da';
import { es } from './es';
import { zhCN } from './zh-CN';
import { hi } from './hi';

export { en };

export type StringKey = keyof typeof en;
export type Table = Readonly<Record<StringKey, string>>;

/** Menu order. English first, the rest as added. */
export const LANGUAGES = ['en', 'da', 'zh-CN', 'hi', 'es'] as const;
export type Language = (typeof LANGUAGES)[number];

export const TABLES: Readonly<Record<Language, Table>> = { en, da, 'zh-CN': zhCN, hi, es };

/**
 * Each language's name in itself, never translated: an owner who lands in a
 * language he cannot read can still find his own in the list.
 */
export const ENDONYMS: Readonly<Record<Language, string>> = {
  en: 'English',
  da: 'Dansk',
  'zh-CN': '简体中文',
  hi: 'हिन्दी',
  es: 'Español'
};

/** The tag `Intl` gets when the system's own tag is for another language. */
const OWN_TAG: Readonly<Record<Language, string>> = {
  en: 'en-GB',
  da: 'da-DK',
  'zh-CN': 'zh-CN',
  hi: 'hi-IN',
  es: 'es-ES'
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/** A page's `?lang=` value: one of ours, or English. */
export function parseLanguage(value: unknown): Language {
  return isLanguage(value) ? value : 'en';
}

/**
 * The language of one BCP 47 tag from the OS, or `null` when Walder has none
 * for it. Chinese is Simplified only: `zh-TW`, `zh-HK` and `zh-Hant*` are
 * skipped, so a Traditional reader gets his next preference rather than a
 * script he did not ask for. Norwegian and Swedish are not Danish.
 */
export function languageOfTag(tag: string): Language | null {
  const lower = tag.toLowerCase().replace(/_/g, '-');
  const parts = lower.split('-');
  const base = parts[0] ?? '';
  if (base === 'zh') {
    if (parts.includes('hant') || parts.includes('tw') || parts.includes('hk') || parts.includes('mo')) {
      return null;
    }
    return 'zh-CN';
  }
  return isLanguage(base) ? base : null;
}

/**
 * The language to run in: an explicit setting wins; `system` (or anything
 * unreadable) walks the OS's preferred languages and takes the first Walder
 * has; nothing matching means English.
 */
export function resolveLanguage(setting: unknown, preferred: readonly string[]): Language {
  if (isLanguage(setting)) return setting;
  for (const tag of preferred) {
    if (typeof tag !== 'string') continue;
    const found = languageOfTag(tag);
    if (found !== null) return found;
  }
  return 'en';
}

/**
 * The locale `Intl` formats dates and numbers with, for `language`.
 *
 * The system's own tag when it is the same language (keeps `da-DK`, `es-MX`,
 * `en-US`), otherwise the language's own tag, so a date never comes out in a
 * language the sentence around it is not in. Western digits everywhere
 * (`-u-nu-latn`): Walder's hand-built `87%` is Western, and a row must not mix
 * two digit systems.
 */
export function intlLocale(language: Language, systemTag?: string): string {
  const own = systemTag !== undefined && languageOfTag(systemTag) === language ? systemTag : OWN_TAG[language];
  try {
    return Intl.getCanonicalLocales(`${own}-u-nu-latn`)[0] ?? OWN_TAG[language];
  } catch {
    return `${OWN_TAG[language]}-u-nu-latn`;
  }
}

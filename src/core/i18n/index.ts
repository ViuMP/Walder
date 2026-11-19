/**
 * The languages Walder speaks, and how one is chosen.
 *
 * Imports the tables and nothing else: `src/main/language-boot.ts` runs before
 * any other module of main is evaluated, and its import graph must stay this
 * small (`test/language-boot.test.ts`).
 */
import { en as enSource } from './en';
import { da } from './da';
import { es } from './es';
import { zhCN } from './zh-CN';
import { hi } from './hi';
import { fr } from './fr';
import { de } from './de';

export type StringKey = keyof typeof enSource;
export type Table = Readonly<Record<StringKey, string>>;

/** Menu order. English first, the rest as added. */
export const LANGUAGES = ['en', 'da', 'zh-CN', 'hi', 'es', 'fr', 'de'] as const;
export type Language = (typeof LANGUAGES)[number];

const NBSP = ' ';
const NNBSP = ' ';

/**
 * What goes between a number and `%`, per language: CLDR's percent pattern, as
 * `Intl.NumberFormat(…, { style: 'percent' })` prints it for the language's own
 * tag (`test/i18n.test.ts` holds the two together). Per language, not per
 * region: `es-MX` writes `95%` where `es-ES` writes `95 %`, and the tables are
 * written once per language. French is U+00A0 here, not U+202F: CLDR 48's `fr`
 * percent pattern uses the full no-break space (U+202F is its group separator).
 */
export const PERCENT_SPACE: Readonly<Record<Language, string>> = {
  en: '',
  da: NBSP,
  'zh-CN': '',
  hi: '',
  es: NBSP,
  fr: NBSP,
  de: NBSP
};

/**
 * The one typography pass every table goes through, so no translator types an
 * invisible character and none can be typed twice:
 *  - `95%`, `95 %`, `{pct}%` → the language's own `PERCENT_SPACE`;
 *  - French only: a no-break space before `:` and a narrow no-break space
 *    before `;`, `?` and `!` (Imprimerie nationale, as in CLDR's `fr` data).
 *    Only after a letter, digit, `}`, `)` or closing quote, and `:` only before
 *    a space or the end, so `10:30`, `https://` and `heures : ?` are left alone.
 *    An existing space is replaced, never added to: twice is the same as once.
 * The bubble wraps only at breakable spaces (`core/bubble.ts`), so a sign stays
 * on the line of the word before it.
 */
export function typeset(text: string, language: Language): string {
  let out = text.replace(/([\d}])[   ]?%/g, `$1${PERCENT_SPACE[language]}%`);
  if (language === 'fr') {
    out = out
      .replace(/([\p{L}\p{N}})»’"])[   ]?:(?=\s|$)/gu, `$1${NBSP}:`)
      .replace(/([\p{L}\p{N}})»’"])[   ]?([;?!])(?=\s|$|[)»’".,…])/gu, `$1${NNBSP}$2`);
  }
  return out;
}

function typesetTable<T extends Readonly<Record<string, string>>>(table: T, language: Language): T {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(table)) out[key] = typeset(value, language);
  return out as T;
}

/** The English table, typeset like the rest; its keys are `StringKey`. */
export const en = typesetTable(enSource, 'en');

export const TABLES: Readonly<Record<Language, Table>> = {
  en,
  da: typesetTable(da, 'da'),
  'zh-CN': typesetTable(zhCN, 'zh-CN'),
  hi: typesetTable(hi, 'hi'),
  es: typesetTable(es, 'es'),
  fr: typesetTable(fr, 'fr'),
  de: typesetTable(de, 'de')
};

/**
 * Each language's name in itself, never translated: an owner who lands in a
 * language he cannot read can still find his own in the list.
 */
export const ENDONYMS: Readonly<Record<Language, string>> = {
  en: 'English',
  da: 'Dansk',
  'zh-CN': '简体中文',
  hi: 'हिन्दी',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch'
};

/** The tag `Intl` gets when the system's own tag is for another language. */
const OWN_TAG: Readonly<Record<Language, string>> = {
  en: 'en-GB',
  da: 'da-DK',
  'zh-CN': 'zh-CN',
  hi: 'hi-IN',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE'
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

/**
 * The language tables and the rules that choose one.
 *
 * In a test process the constants that freeze a `t()` at import stay English
 * whatever `setLanguage` is later called with, so per-language checks read
 * `TABLES[lang][key]` directly, or switch language only around a function call
 * and switch back in `afterEach`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ENDONYMS,
  LANGUAGES,
  TABLES,
  en,
  intlLocale,
  isLanguage,
  parseLanguage,
  resolveLanguage,
  type Language,
  type StringKey
} from '../src/core/i18n';
import { setLanguage, t } from '../src/core/strings';
import { formatResetsIn } from '../src/core/buckets';
import { formatMoneyValue } from '../src/core/usage';
import { LANGUAGE_LABELS, LANGUAGE_SETTINGS } from '../src/core/settings-spec';

const KEYS = Object.keys(en) as StringKey[];
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();

afterEach(() => setLanguage('en'));

describe('every table', () => {
  for (const lang of LANGUAGES) {
    it(`${lang}: has exactly the English keys, none empty, with the same placeholders`, () => {
      const table = TABLES[lang];
      expect(Object.keys(table).sort()).toEqual([...KEYS].sort());
      for (const key of KEYS) {
        const text = table[key];
        expect(text.trim().length, `${lang} ${key}`).toBeGreaterThan(0);
        expect(placeholders(text), `${lang} ${key}`).toEqual(placeholders(en[key]));
      }
    });

    it(`${lang}: keeps the product names and the card's WALDER as they are`, () => {
      const table = TABLES[lang];
      expect(table['card.title']).toBe('WALDER');
      for (const key of KEYS.filter((k) => /^services\.\w+\.(label|title)$|^bubble\.sourceLabel|^tray\.tool/.test(k))) {
        expect(table[key], `${lang} ${key}`).toBe(en[key]);
      }
    });

    it(`${lang}: writes each menu path with its own menu's words`, () => {
      const table = TABLES[lang];
      const logIn = table['tray.logIn'].replace(/…$/u, '');
      for (const key of ['bubble.introLogin', 'services.claude.noLogin', 'services.chatgpt.noLogin'] as const) {
        expect(table[key], `${lang} ${key}`).toContain(table['tray.accounts']);
        expect(table[key], `${lang} ${key}`).toContain(logIn);
      }
      expect(table['hooks.offerLater']).toContain(table['tray.hooks']);
      // The offer names the very tray item, with Claude Code put in.
      expect(table['hooks.offerLater'].replace('{tool}', 'Claude Code')).toContain(table['tray.installClaudeHooks']);
    });
  }

  it('names every language in itself, and the setting lists System first', () => {
    expect(Object.keys(ENDONYMS).sort()).toEqual([...LANGUAGES].sort());
    expect(LANGUAGE_SETTINGS).toEqual(['system', ...LANGUAGES]);
    for (const lang of LANGUAGES) expect(LANGUAGE_LABELS[lang]).toBe(ENDONYMS[lang]);
  });
});

describe('choosing the language', () => {
  const cases: [unknown, string[], Language][] = [
    ['system', ['da-DK', 'en-US'], 'da'],
    ['system', ['es-419'], 'es'],
    ['system', ['es_MX'], 'es'],
    ['system', ['zh-Hans-CN'], 'zh-CN'],
    ['system', ['zh-SG'], 'zh-CN'],
    ['system', ['zh'], 'zh-CN'],
    ['system', ['zh-TW', 'zh-Hant-HK', 'en-US'], 'en'],
    ['system', ['zh-HK', 'hi-IN'], 'hi'],
    // Arabic was dropped (2026-11-18): an Arabic system gets its next preference.
    ['system', ['ar-EG', 'da-DK'], 'da'],
    ['system', ['nb-NO', 'sv-SE', 'en-GB'], 'en'],
    ['system', ['fr-CA'], 'fr'],
    ['system', ['de-AT', 'en-US'], 'de'],
    ['system', ['de_CH'], 'de'],
    ['system', ['it-IT'], 'en'],
    ['system', [], 'en'],
    ['system', ['', 'junk'], 'en'],
    ['da', ['es-ES'], 'da'],
    ['it', ['es-ES'], 'es'],
    ['fr', ['es-ES'], 'fr'],
    [42, ['da'], 'da'],
    [undefined, ['es'], 'es']
  ];
  for (const [setting, preferred, expected] of cases) {
    it(`${String(setting)} with [${preferred.join(', ')}] is ${expected}`, () => {
      expect(resolveLanguage(setting, preferred)).toBe(expected);
    });
  }

  it('parses a page URL value, English for anything unknown', () => {
    for (const lang of LANGUAGES) expect(parseLanguage(lang)).toBe(lang);
    for (const junk of [null, '', 'xx', 'EN', '../en']) expect(parseLanguage(junk)).toBe('en');
    expect(isLanguage('en')).toBe(true);
    expect(isLanguage('fr')).toBe(true);
    expect(isLanguage('it')).toBe(false);
  });

  it('formats with the system tag when it is the same language, else the language’s own', () => {
    expect(intlLocale('da', 'da-DK')).toBe('da-DK-u-nu-latn');
    expect(intlLocale('es', 'es-MX')).toBe('es-MX-u-nu-latn');
    expect(intlLocale('en', 'en-US')).toBe('en-US-u-nu-latn');
    // An Italian Mac under English: English dates, not Italian ones inside English text.
    expect(intlLocale('en', 'it-IT')).toBe('en-GB-u-nu-latn');
    expect(intlLocale('fr', 'fr-CA')).toBe('fr-CA-u-nu-latn');
    expect(intlLocale('de')).toBe('de-DE-u-nu-latn');
    expect(intlLocale('da', 'en-US')).toBe('da-DK-u-nu-latn');
    expect(intlLocale('es')).toBe('es-ES-u-nu-latn');
    expect(intlLocale('hi', 'hi-IN')).toBe('hi-IN-u-nu-latn');
    expect(intlLocale('zh-CN', 'zh-Hans-CN')).toBe('zh-Hans-CN-u-nu-latn');
    // A Traditional Chinese system under Simplified: the Simplified tag.
    expect(intlLocale('zh-CN', 'zh-TW')).toBe('zh-CN-u-nu-latn');
    // A tag Intl cannot take still gives a usable locale.
    expect(() => new Intl.DateTimeFormat(intlLocale('en', 'en-US-u-ca-gregory'))).not.toThrow();
  });
});

describe('Intl output', () => {
  const now = new Date('2026-11-18T12:00:00Z');
  const inThreeDays = new Date(now.getTime() + 3 * 86_400_000 + 2.5 * 3_600_000).toISOString();
  const nonLatinDigits = /[٠-٩۰-۹०-९〇一-九]/u;

  for (const lang of LANGUAGES) {
    it(`${lang}: reset lines and money use Western digits in the active language`, () => {
      setLanguage(lang);
      const locale = intlLocale(lang);
      const clock = formatResetsIn(inThreeDays, now, { style: 'clock', locale, timeZone: 'UTC' });
      const countdown = formatResetsIn(inThreeDays, now, { style: 'countdown', locale, timeZone: 'UTC' });
      expect(clock.length).toBeGreaterThan(0);
      expect(clock).not.toMatch(nonLatinDigits);
      expect(countdown).toContain('3');
      expect(countdown).toBe(t('reset.inDays', { days: 3, hours: 2 }));
      const money = formatMoneyValue({ spent: 9.62, limit: 20, currency: 'USD' }, 48, locale);
      expect(money).toMatch(/9[.,]62/u);
      expect(money).toContain('48%');
      expect(money).not.toMatch(nonLatinDigits);
    });
  }
});

describe('parameters', () => {
  it('are substituted as they are', () => {
    expect(t('shortcut.inUse', { label: 'Alt+Shift+W' })).toBe('Alt+Shift+W is already used by another app');
    expect(t('bubble.nudge', { label: 'Claude 5h', pct: 87 })).toBe('Claude 5h: 87% used');
  });
});

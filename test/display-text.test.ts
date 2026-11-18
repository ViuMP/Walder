/**
 * English data, translated where drawn (`src/core/display-text.ts`): every
 * label a parser emits and every message a provider sends has an entry, so a
 * new one cannot arrive on screen untranslated without this file saying so.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as buckets from '../src/core/buckets';
import { LOCAL_TOKENS_LABEL } from '../src/core/local-tokens';
import { displayLabel, displayMessage, displaySource } from '../src/core/display-text';
import { SERVICE_LABELS, flatRowLabel } from '../src/core/card-layout';
import { LANGUAGES, TABLES, type StringKey } from '../src/core/i18n';
import { setLanguage, t } from '../src/core/strings';
import * as antigravity from '../src/providers/antigravity';
import * as chatgptCodex from '../src/providers/chatgpt-codex';
import * as chatgptWeb from '../src/providers/chatgpt-web';
import * as claudeOauth from '../src/providers/claude-oauth';
import * as claudeWeb from '../src/providers/claude-web';
import * as copilot from '../src/providers/copilot';
import * as cursor from '../src/providers/cursor';

afterEach(() => setLanguage('en'));

/** Exported string constants whose name ends in `suffix`. */
function constants(mod: Record<string, unknown>, suffix: string): string[] {
  return Object.entries(mod)
    .filter(([name, value]) => name.endsWith(suffix) && typeof value === 'string')
    .map(([, value]) => value as string);
}

const LABELS = [
  ...constants(buckets, '_LABEL'),
  LOCAL_TOKENS_LABEL,
  ...Object.values(buckets.CLAUDE_WINDOW_MAP).map((spec) => spec.label)
];
const MESSAGES = [
  ...[antigravity, chatgptCodex, chatgptWeb, claudeOauth, claudeWeb, copilot, cursor].flatMap((mod) =>
    constants(mod as Record<string, unknown>, '_MESSAGE')
  ),
  'not checked yet',
  'the source did not answer in time',
  'logged out'
  // Request bodies share the suffix and are not messages.
].filter((text) => text !== '{}');

describe('display text', () => {
  it('has a key for every bucket label, and draws it in the active language', () => {
    expect(LABELS.length).toBeGreaterThan(15);
    const keyOf = new Map(
      (Object.keys(TABLES.en) as StringKey[]).filter((k) => k.startsWith('bucket.')).map((k) => [TABLES.en[k], k])
    );
    for (const label of LABELS) {
      if (label === buckets.LIMIT_LABEL_PREFIX) continue;
      const key = keyOf.get(label);
      // The per-model weekly rows are one key with the model put in.
      const model = label.startsWith(buckets.LIMIT_LABEL_PREFIX) ? label.slice(buckets.LIMIT_LABEL_PREFIX.length) : null;
      expect(key !== undefined || model !== null, label).toBe(true);
      for (const lang of LANGUAGES) {
        setLanguage(lang);
        const expected =
          key !== undefined ? TABLES[lang][key] : t('bucket.sevenDayModel', { model: model ?? '' });
        expect(displayLabel(label), `${lang}: ${label}`).toBe(expected);
      }
    }
  });

  it('has a translation for every provider and poller message', () => {
    expect(MESSAGES.length).toBeGreaterThan(12);
    const english = new Set(
      (Object.keys(TABLES.en) as StringKey[]).filter((k) => k.startsWith('status.')).map((k) => TABLES.en[k])
    );
    for (const message of MESSAGES) expect(english.has(message), message).toBe(true);
    setLanguage('es');
    for (const message of MESSAGES) expect(displayMessage(message), message).not.toBe(message);
  });

  it('names a row\'s service once in the card editor\'s list, in every language', () => {
    for (const lang of LANGUAGES) {
      setLanguage(lang);
      for (const row of buckets.KNOWN_ROWS) {
        const shown = flatRowLabel(row.service, displayLabel(row.label)).toLowerCase();
        const brand = SERVICE_LABELS[row.service].toLowerCase();
        expect(shown.split(brand).length - 1, `${lang}: ${shown}`).toBeLessThanOrEqual(1);
        if (row.service === 'chatgpt') expect(shown.includes('chatgpt') && shown.includes('codex'), shown).toBe(false);
      }
    }
  });

  it('draws where the numbers came from in the active language', () => {
    setLanguage('da');
    expect(displaySource('Claude Code login')).toBe(TABLES.da['source.claudeCode']);
    expect(displaySource('no source')).toBe(TABLES.da['source.none']);
    expect(displaySource('Antigravity')).toBe('Antigravity');
    // Every provider's label has a key, except the one that is only a product name.
    const providerLabels = [antigravity, chatgptCodex, chatgptWeb, claudeOauth, claudeWeb, copilot, cursor]
      .flatMap((mod) => constants(mod as Record<string, unknown>, '_LABEL'))
      .filter((label) => label !== antigravity.ANTIGRAVITY_LABEL);
    expect(providerLabels.length).toBe(6);
    setLanguage('es');
    for (const label of providerLabels) expect(displaySource(label), label).not.toBe(label);
  });

  it('passes anything unknown through unchanged', () => {
    setLanguage('da');
    expect(displayLabel('Codex 3h')).toBe('Codex 3h');
    expect(displayMessage('HTTP 503')).toBe('HTTP 503');
    expect(displayLabel('')).toBe('');
  });
});

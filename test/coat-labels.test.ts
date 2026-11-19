/**
 * Coat names fit their swatch cell (Mac QA 2026-11-20). A cell is about 70–80 px wide and
 * the name is drawn at 10 px, uppercase, 0.1em letter-spaced: about ten Latin capitals.
 * German Schokobraun / Silbergetigert ran into each other on screen. Longer words carry
 * soft hyphens (U+00AD) where they may break.
 */
import { describe, expect, it } from 'vitest';
import { TABLES, type StringKey } from '../src/core/i18n';

const LATIN = ['en', 'da', 'es', 'fr', 'de'] as const;
const MAX_UNBROKEN = 10;

describe('coat names', () => {
  for (const lang of LATIN) {
    it(`${lang}: no coat name has a run of more than ${MAX_UNBROKEN} letters with nowhere to break`, () => {
      const table = TABLES[lang];
      const coats = (Object.keys(table) as StringKey[]).filter((k) => k.startsWith('coat.'));
      expect(coats.length).toBeGreaterThan(0);
      for (const key of coats) {
        const runs = table[key].split(/[\s\-­]+/);
        for (const run of runs) expect(run.length, `${lang} ${key}: "${run}"`).toBeLessThanOrEqual(MAX_UNBROKEN);
      }
    });
  }
});

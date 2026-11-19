/**
 * English text that is data, translated only where it is drawn.
 *
 * A bucket's `label` and a report's `message` are English on purpose: labels
 * are matched (`startsWith(LIMIT_LABEL_PREFIX)`, `=== CODEX_FIVE_HOUR_LABEL`)
 * and persisted in `lastSnapshot`, and main compares a message against a
 * provider's constant. So the parsers, the snapshot and every match keep the
 * English, and the card asks here on the way to the screen.
 *
 * Keyed by the English text itself, which is the `en` table's value for each
 * `bucket.*` / `status.*` key: core may not import `src/providers`, and
 * `test/display-text.test.ts` keeps the tables in step with every exported
 * `*_LABEL` and `*_MESSAGE` constant. Unknown text (a window a provider adds
 * tomorrow, `HTTP 503`) passes through unchanged.
 *
 * Not in `i18n/index.ts`, so main's boot imports the tables and nothing else.
 */
import { LIMIT_LABEL_PREFIX } from './buckets';
import { STRINGS, t, type StringKey } from './strings';

function byEnglish(prefix: string): ReadonlyMap<string, StringKey> {
  return new Map(
    (Object.keys(STRINGS) as StringKey[])
      .filter((key) => key.startsWith(prefix))
      .map((key) => [STRINGS[key], key] as const)
  );
}

const LABELS = byEnglish('bucket.');
const MESSAGES = byEnglish('status.');
const SOURCES = byEnglish('source.');

/** A bucket label in the active language: `7-day (all models)` → `7 dage (alle modeller)`. */
export function displayLabel(label: string): string {
  const key = LABELS.get(label);
  if (key !== undefined) return t(key);
  // `7-day (all models)` wears the prefix too, and is found in LABELS first.
  if (label.startsWith(LIMIT_LABEL_PREFIX)) {
    const model = label.slice(LIMIT_LABEL_PREFIX.length).trim();
    if (model.length > 0) return t('bucket.sevenDayModel', { model });
  }
  return label;
}

/** A provider's label (`Claude Code login`) in the active language; `Antigravity` and anything unknown as sent. */
export function displaySource(label: string): string {
  const key = SOURCES.get(label);
  return key === undefined ? label : t(key);
}

/** A provider's or the poller's message in the active language; anything else as sent. */
export function displayMessage(message: string): string {
  const key = MESSAGES.get(message);
  return key === undefined ? message : t(key);
}

/**
 * The two usage-shape diagnostic lines, and the `once` gate they are printed
 * through.
 *
 * What matters about both lines is that they are provably safe to print at any
 * verbosity: a value from a Claude or ChatGPT usage payload must never be able
 * to reach them, however the shape changes. So alongside the three phrasings,
 * this file pins that `keySetLine` on the real 2026-09-10 `amber_ladder`
 * fixture carries none of that payload's own values, and that `redact` — the
 * filter every `vlog` argument goes through — leaves both lines untouched,
 * which is only true because neither one is built out of anything long enough
 * to look like a token.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ignoredWindowLine, keySetLine, once } from '../src/main/usage-diagnostics';
import { redact } from '../src/main/log';
import type { IgnoredWindow } from '../src/core/buckets';

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

describe('ignoredWindowLine', () => {
  it('names the provider, the key, and that a reset date was present', () => {
    const w: IgnoredWindow = { key: 'amber_ladder', hasUtilization: true, resetsOn: '2026-10-02' };
    expect(ignoredWindowLine('claude-web', w)).toBe(
      'usage: ignoring unknown claude window "amber_ladder" (utilization present, resets 2026-10-02) [claude-web]'
    );
  });

  it('says "utilization absent" when the window carried no usage number', () => {
    const w: IgnoredWindow = { key: 'mystery_thing', hasUtilization: false, resetsOn: '2026-09-16' };
    expect(ignoredWindowLine('claude-oauth', w)).toBe(
      'usage: ignoring unknown claude window "mystery_thing" (utilization absent, resets 2026-09-16) [claude-oauth]'
    );
  });

  it('says "no reset" when there was no reset date at all', () => {
    const w: IgnoredWindow = { key: 'nimbus_something', hasUtilization: true, resetsOn: null };
    expect(ignoredWindowLine('claude-web', w)).toBe(
      'usage: ignoring unknown claude window "nimbus_something" (utilization present, no reset) [claude-web]'
    );
  });
});

describe('keySetLine', () => {
  it('sorts and comma-joins the keys, naming the provider', () => {
    expect(keySetLine('claude-web', ['seven_day', 'five_hour', 'amber_ladder', 'nimbus_quill'])).toBe(
      'usage keys [claude-web]: amber_ladder,five_hour,nimbus_quill,seven_day'
    );
  });

  it('does not mutate the array it was given', () => {
    const keys = ['b', 'a'];
    keySetLine('x', keys);
    expect(keys).toEqual(['b', 'a']);
  });

  it('carries none of the real payload\'s own values, only its key names', () => {
    const payload = fixture('claude-web-usage-amber.json');
    const keys = Object.keys(payload as Record<string, unknown>);
    const line = keySetLine('claude-web', keys);
    // Every value in the fixture (percentages, ISO timestamps) stringified —
    // none of it should be a substring of the line the key names produced.
    const values = JSON.stringify(Object.values(payload as Record<string, unknown>));
    for (const digitRun of values.match(/\d+/g) ?? []) {
      expect(line).not.toContain(digitRun);
    }
  });

  it('survives the log redactor unchanged', () => {
    const line = keySetLine('claude-web', ['amber_ladder', 'five_hour', 'nimbus_quill', 'seven_day']);
    expect(redact(line)).toBe(line);
  });
});

describe('once', () => {
  it('emits the first call for a given key', () => {
    const seen: string[] = [];
    const emit = once(
      (n: number) => String(n),
      (n) => seen.push(`got ${n}`)
    );
    emit(1);
    expect(seen).toEqual(['got 1']);
  });

  it('drops a repeat of the same key', () => {
    const seen: number[] = [];
    const emit = once(
      (n: number) => String(n),
      (n) => seen.push(n)
    );
    emit(1);
    emit(1);
    emit(1);
    expect(seen).toEqual([1]);
  });

  it('treats a different key as a new thing to say', () => {
    const seen: number[] = [];
    const emit = once(
      (n: number) => String(n),
      (n) => seen.push(n)
    );
    emit(1);
    emit(2);
    emit(1);
    expect(seen).toEqual([1, 2]);
  });
});

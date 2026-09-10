/**
 * The usage-shape diagnostics, and the `once` gate they are printed through.
 *
 * What matters about both lines is that they are provably safe to print at any
 * verbosity: a value from a Claude or ChatGPT usage payload must never be able
 * to reach them, however the shape changes. So alongside the three phrasings,
 * this file pins that `keySetLine` on the real 2026-09-10 `amber_ladder`
 * fixture carries none of that payload's own values, and that `redact` — the
 * filter every `vlog` argument goes through — leaves both lines untouched,
 * which is only true because neither one is built out of anything long enough
 * to look like a token *on its own*. A single window key that is itself 20+
 * characters is the documented exception — see the "long key names" block
 * below, and both functions' own doc comments in `usage-diagnostics.ts`.
 *
 * `usageShapeLines` at the bottom is held to a *weaker* rule on purpose — it
 * prints numbers, because the `limits[]` and `extra_usage` parsers are still
 * written against researched field names — and to the *same* rule on strings:
 * not one string value, at any depth. Its fixture tags every string value
 * with `STRINGVALUE-` so a leak cannot pass unnoticed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ignoredWindowLine,
  keySetLine,
  once,
  usageShapeLines
} from '../src/main/usage-diagnostics';
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
  it('sorts and comma-space-joins the keys, naming the provider', () => {
    expect(keySetLine('claude-web', ['seven_day', 'five_hour', 'amber_ladder', 'nimbus_quill'])).toBe(
      'usage keys [claude-web]: amber_ladder, five_hour, nimbus_quill, seven_day'
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

  it('keeps two short keys apart through redact — the separator earns its keep here', () => {
    // Neither key is 20+ characters on its own (`five_hour` is 9,
    // `nimbus_quill` is 12), but concatenated with no separator at all they
    // would be one 21-character run — over `BASE64ISH_RE`'s threshold. The
    // comma+space between them in the real line stops that from happening.
    expect('five_hour' + 'nimbus_quill').toHaveLength(21);
    const line = keySetLine('claude-web', ['five_hour', 'nimbus_quill']);
    expect(redact(line)).toBe(line);
  });
});

/**
 * `BASE64ISH_RE` (`src/main/log.ts`) masks any 20+ character run of
 * letters/digits/`_`/`+`/`=`/`-`. A window key that is itself that long is a
 * single such run, and no separator or surrounding punctuation — a comma, a
 * space, the quotes `ignoredWindowLine` wraps it in — sits *inside* the run to
 * break it. So a single long key does not survive `redact` on its own: this is
 * a known, accepted limit (see both functions' doc comments in
 * `usage-diagnostics.ts`), not a case either format string is trying to solve.
 * Pinned here so a future change to either line notices if it silently starts
 * relying on this working.
 */
describe('a single 20+ character key is a known redact limitation', () => {
  const LONG_KEY = 'seven_day_claude_sonnet_4';
  it('is 25 characters — over the BASE64ISH_RE threshold', () => {
    expect(LONG_KEY.length).toBeGreaterThanOrEqual(20);
  });

  it('ignoredWindowLine: quoting the key does not stop redact from masking it', () => {
    const line = ignoredWindowLine('claude-web', {
      key: LONG_KEY,
      hasUtilization: true,
      resetsOn: '2026-10-02'
    });
    expect(redact(line)).not.toContain(LONG_KEY);
    expect(redact(line)).toContain('[redacted]');
  });

  it('keySetLine: alone, or beside a short key, it is still masked', () => {
    const alone = keySetLine('claude-web', [LONG_KEY]);
    expect(redact(alone)).not.toContain(LONG_KEY);
    const beside = keySetLine('claude-web', [LONG_KEY, 'five_hour']);
    expect(redact(beside)).not.toContain(LONG_KEY);
    // The short key beside it is unaffected — only the long run is touched.
    expect(redact(beside)).toContain('five_hour');
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

  describe('shouldEmit gate', () => {
    // The 2026-09-10 bug: `once` recorded a key as "seen" even while verbose
    // logging was off, so ticking Developer ▸ Verbose log and pressing
    // Refresh now (QA 4.16) never logged anything for a key already polled
    // once while quiet — which in practice is every key. The fix checks
    // `shouldEmit()` *before* touching `seen`, so a key seen while diagnostics
    // are off is never consumed.
    it('does not consume the key while shouldEmit is false', () => {
      const seen: number[] = [];
      let on = false;
      const emit = once(
        (n: number) => String(n),
        (n) => seen.push(n),
        () => on
      );
      emit(1);
      expect(seen).toEqual([]);
    });

    it('emits once, the first time after shouldEmit flips true', () => {
      const seen: number[] = [];
      let on = false;
      const emit = once(
        (n: number) => String(n),
        (n) => seen.push(n),
        () => on
      );
      emit(1); // dropped: shouldEmit false, and the key must not be recorded
      emit(1); // still false — still nothing
      on = true;
      emit(1); // now emits: the earlier calls never marked "1" as seen
      emit(1); // repeat while on: this one is genuinely deduped
      expect(seen).toEqual([1]);
    });

    it('defaults to always emitting when no shouldEmit is given', () => {
      const seen: number[] = [];
      const emit = once(
        (n: number) => String(n),
        (n) => seen.push(n)
      );
      emit(1);
      emit(1);
      expect(seen).toEqual([1]);
    });
  });
});

/**
 * The dev-only values dump.
 *
 * `keySetLine` answers "which keys are there?" and stops; this answers "and
 * what is *inside* the ones whose parsers are still written against guesses" —
 * `limits[]`, `extra_usage`, `spend`, `seven_day_breakdown`. It is the only
 * diagnostic in this file that prints a value, so the tests that matter most
 * are the ones proving it prints no *string* value: every identifier in a
 * claude.ai payload — org uuid, account slug, plan name — is a string, and a
 * dump with one string exception in it is a dump that leaks the first time
 * somebody misjudges a field name.
 */
describe('usageShapeLines', () => {
  const live = fixture('claude-web-usage-live-keys.json');
  const lines = usageShapeLines(live);
  const text = lines.join('\n');

  /** Every string value anywhere in the fixture, however deep. */
  function stringValues(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const v of value) stringValues(v, out);
    else if (typeof value === 'object' && value !== null) {
      for (const v of Object.values(value)) stringValues(v, out);
    }
    return out;
  }

  it('prints no string value from the payload, at any depth', () => {
    const values = stringValues(live);
    // Sanity: the fixture must actually contain strings, or this proves nothing.
    expect(values.length).toBeGreaterThan(10);
    for (const value of values) {
      expect(text, `leaked: ${value.slice(0, 40)}`).not.toContain(value);
    }
    // Not one STRINGVALUE- tag anywhere: the fixture marks every string value
    // with that prefix precisely so a single leak is unmissable.
    expect(text).not.toContain('STRINGVALUE');
  });

  it('renders a string as its length only, and says so for an ISO timestamp', () => {
    // `resets_at` is an ISO instant, which is a string, which means the dump
    // reports its length and never the time. Deliberate: a reset instant is
    // the owner's own schedule, and the shape question is only whether the
    // field is there.
    expect(lines).toContain('five hour . resets at = <string:27 chars>');
    expect(lines).toContain('five hour . utilization = 22.5');
  });

  it('does print the numbers, which is the whole point', () => {
    expect(lines).toContain('seven day . utilization = 47');
    expect(lines).toContain('seven day opus . utilization = 23');
    expect(lines).toContain('seven day sonnet . utilization = 9');
    expect(lines).toContain('spend . monthly limit = 200');
    expect(lines).toContain('spend . current = 30.5');
  });

  it('prints booleans, which are shape facts and not identifiers', () => {
    expect(lines).toContain('spend . enabled = true');
  });

  it('splits every key on underscores so the redactor cannot mask it', () => {
    // `seven_day_breakdown` is 19 characters and `seven_day_omelette` 18 —
    // one and two short of `BASE64ISH_RE`'s 20-character run. Nested paths get
    // longer than that immediately, so the split is what keeps the whole line
    // readable rather than a `<redacted>`.
    expect(lines).toContain('seven day breakdown: object');
    expect(lines).toContain('seven day omelette: object');
    expect(text).not.toContain('seven_day');
    // Every line built from an underscore-separated key survives `redact`
    // untouched — the point of the split, and not true of the raw key
    // (`seven_day_breakdown` plus a nested path is well past 20 characters).
    for (const line of lines) {
      if (/^[A-Za-z0-9]{20,}/.test(line)) continue; // see the next test
      expect(redact(line), line).toBe(line);
    }
  });

  it('is still beaten by a key that is one unbroken 20+ character run', () => {
    // The documented, accepted limit — the same one `keySetLine` and
    // `ignoredWindowLine` carry. Three keys on the owner's account are opaque
    // 24-character tokens with no underscore to split on, so `BASE64ISH_RE`
    // masks them whole and the line reads "[redacted]: object". That is the
    // redactor working, not failing: an unbroken 24-character token is exactly
    // what it exists to catch, and no separator placed *outside* a run can
    // break characters inside it. It is also why those keys are not on the
    // detail list — there is nothing useful to say about a key nobody can name.
    expect(redact('zqvXk8mTrb4Ld9pNs2Hf7Ac1: object')).toBe('[redacted]: object');
    expect(lines).toContain('zqvXk8mTrb4Ld9pNs2Hf7Ac1: object');
    expect(lines.filter((l) => l.startsWith('zqvXk8mTrb4Ld9pNs2Hf7Ac1 .'))).toEqual([]);
  });

  it('enumerates array elements with their index', () => {
    expect(lines).toContain('limits: array(2)');
    expect(lines).toContain('limits [0]: object');
    expect(lines).toContain('limits [0] . utilization = 78');
    expect(lines).toContain('limits [1] . utilization = 23');
    // Nested inside a detail key's object, too.
    expect(lines).toContain('seven day breakdown . buckets: array(2)');
    expect(lines).toContain('seven day breakdown . buckets [0] . utilization = 23');
  });

  it('names every top-level key with its type, including a null one', () => {
    expect(lines).toContain('extra usage: null');
    expect(lines).toContain('limits: array(2)');
    expect(lines).toContain('tangelo: object');
  });

  it('does not open a key that is not on the detail list', () => {
    // A codename's insides are of no use to anybody and are exactly the values
    // that should not be printed. One type line each, and nothing under it.
    for (const key of ['amber ladder', 'nimbus quill', 'tangelo', 'cinder cove']) {
      expect(lines).toContain(`${key}: object`);
      expect(lines.filter((l) => l.startsWith(`${key} .`))).toEqual([]);
    }
  });

  it('describes a payload that is not an object rather than throwing', () => {
    expect(usageShapeLines(null)).toEqual(['(payload is null, not an object)']);
    expect(usageShapeLines([1, 2])).toEqual(['(payload is array(2), not an object)']);
    expect(usageShapeLines('nope')).toEqual(['(payload is string, not an object)']);
  });

  it('stops at a bounded depth instead of walking a pathological payload', () => {
    // Build a 40-deep nest under a detail key; the walk must terminate.
    let nest: Record<string, unknown> = { utilization: 1 };
    for (let i = 0; i < 40; i += 1) nest = { deeper: nest };
    const out = usageShapeLines({ five_hour: nest });
    expect(out.length).toBeLessThan(20);
    expect(out[0]).toBe('five hour: object');
  });
});

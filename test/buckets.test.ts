import { describe, expect, it } from 'vitest';

import {
  CLAUDE_WINDOW_FAMILIES,
  IGNORED_KEYS,
  EXTRA_USAGE_ID,
  CODEX_CREDITS_ID,
  CODEX_SPEND_LIMIT_ID,
  claudeLimitKey,
  extraUsageBucket,
  formatResetsIn,
  nextMonthlyResetAt,
  humanize,
  isAllowedClaudeWindow,
  isFableRow,
  KNOWN_ROWS,
  mergeBuckets,
  parseChatGptUsage,
  parseClaudeLimits,
  parseClaudeUsage,
  parseCodexCredits,
  parseCodexSpendLimit,
  parseExtraUsage,
  withDerivedFableRow,
  type Bucket,
  type IgnoredWindow,
  type MoneyDetail
} from '../src/core/buckets.js';
import { barFill, formatPct, pctForFace, type ServiceReport } from '../src/core/usage.js';
import { cardRowsFor } from '../src/core/card-layout.js';

import claudeUsage from './fixtures/claude-oauth-usage.json';
import claudeUsageFraction from './fixtures/claude-oauth-usage-fraction.json';
import claudeUsageUnknownKey from './fixtures/claude-oauth-usage-unknown-key.json';
import claudeMalformed from './fixtures/claude-usage-malformed.json';
import codexUsage from './fixtures/codex-wham-usage.json';
import chatgptUnknown from './fixtures/chatgpt-unknown-shape.json';
import claudeWebUsageAmber from './fixtures/claude-web-usage-amber.json';
import claudeWebUsageLimits from './fixtures/claude-web-usage-limits.json';
import claudeExtraUsage from './fixtures/claude-web-extra-usage.json';
import claudeExtraUsageWithLimit from './fixtures/claude-web-extra-usage-with-limit.json';
import claudeExtraUsageOff from './fixtures/claude-web-extra-usage-off.json';
import claudeWebUsageLive from './fixtures/claude-web-usage-live-keys.json';
import codexUsageUnlimited from './fixtures/codex-wham-usage-unlimited.json';
import codexUsageNoCredits from './fixtures/codex-wham-usage-no-credits.json';

const byId = (buckets: Bucket[]): Map<string, Bucket> =>
  new Map(buckets.map((b) => [b.id, b] as const));

describe('humanize', () => {
  it('turns a snake_case key into a sentence', () => {
    expect(humanize('seven_day_haiku')).toBe('Seven day haiku');
    expect(humanize('five_hour')).toBe('Five hour');
    expect(humanize('PRIMARY')).toBe('Primary');
  });

  it('returns the key unchanged when there is nothing to humanize', () => {
    expect(humanize('')).toBe('');
  });
});

describe('parseClaudeUsage', () => {
  it('parses the realistic payload with known labels and priorities', () => {
    const buckets = parseClaudeUsage(claudeUsage);
    // The payload's three windows, plus the derived Fable row that `seven_day`
    // earns — see the 'derived Fable row' block below.
    expect(buckets).toHaveLength(4);

    const m = byId(buckets);
    expect(m.get('claude.five_hour')).toMatchObject({
      service: 'claude',
      key: 'five_hour',
      label: '5-hour',
      pct: 42.5,
      resetsAt: '2026-09-08T18:00:00Z',
      priority: 0
    });
    expect(m.get('claude.seven_day')).toMatchObject({
      label: '7-day (all models)',
      pct: 61,
      priority: 3
    });
    expect(m.get('claude.seven_day_opus')).toMatchObject({
      label: '7-day Opus',
      pct: 12,
      priority: 2
    });
  });

  it('keeps the raw payload for each bucket', () => {
    const [first] = parseClaudeUsage(claudeUsage);
    expect(first?.raw).toEqual({ utilization: 42.5, resets_at: '2026-09-08T18:00:00Z' });
  });

  it('reads utilizations as percentages by default', () => {
    // The endpoint returns 0-100, so a fractional-looking payload is taken at
    // face value unless the caller says otherwise.
    const buckets = byId(parseClaudeUsage(claudeUsageFraction));
    expect(buckets.get('claude.five_hour')?.pct).toBe(0.4); // 0.425 -> 1dp
    expect(buckets.get('claude.seven_day')?.pct).toBe(0.6);
    expect(buckets.get('claude.seven_day_opus')?.pct).toBe(0.1);
  });

  it("scales by 100 when the caller declares scale: 'fraction'", () => {
    const buckets = byId(parseClaudeUsage(claudeUsageFraction, { scale: 'fraction' }));
    expect(buckets.get('claude.five_hour')?.pct).toBe(42.5);
    expect(buckets.get('claude.seven_day')?.pct).toBe(61);
    expect(buckets.get('claude.seven_day_opus')?.pct).toBe(12);
  });

  it("scale: 'auto' rescales only on a non-integer fraction", () => {
    const buckets = byId(parseClaudeUsage(claudeUsageFraction, { scale: 'auto' }));
    expect(buckets.get('claude.five_hour')?.pct).toBe(42.5);
    expect(buckets.get('claude.seven_day')?.pct).toBe(61);
  });

  it('does not treat genuinely low percentages as fractions', () => {
    // 1 %, 0.6 % and 0 % — every value <= 1, so a naive detector would inflate
    // this to 100/60/0 and bark about a nearly-empty window.
    const low = {
      five_hour: { utilization: 1, resets_at: null },
      seven_day: { utilization: 0.6, resets_at: null },
      seven_day_opus: { utilization: 0, resets_at: null }
    };
    const buckets = byId(parseClaudeUsage(low));
    expect(buckets.get('claude.five_hour')?.pct).toBe(1);
    expect(buckets.get('claude.seven_day')?.pct).toBe(0.6);
    expect(buckets.get('claude.seven_day_opus')?.pct).toBe(0);
  });

  it("scale: 'auto' declines an all-integer payload of 1s and 0s", () => {
    const integers = {
      five_hour: { utilization: 1, resets_at: null },
      seven_day: { utilization: 0, resets_at: null }
    };
    const buckets = byId(parseClaudeUsage(integers, { scale: 'auto' }));
    expect(buckets.get('claude.five_hour')?.pct).toBe(1);
    expect(buckets.get('claude.seven_day')?.pct).toBe(0);
  });

  it("scale: 'auto' does not rescale when any single value exceeds 1", () => {
    const mixed = {
      five_hour: { utilization: 0.5, resets_at: null },
      seven_day: { utilization: 61, resets_at: null }
    };
    const buckets = byId(parseClaudeUsage(mixed, { scale: 'auto' }));
    expect(buckets.get('claude.five_hour')?.pct).toBe(0.5);
    expect(buckets.get('claude.seven_day')?.pct).toBe(61);
  });

  it('labels and prioritises unknown / newer model keys', () => {
    const buckets = byId(parseClaudeUsage(claudeUsageUnknownKey));
    expect(buckets.size).toBe(5);

    expect(buckets.get('claude.seven_day_fable')).toMatchObject({
      label: '7-day Fable',
      priority: 1,
      pct: 88.3 // 88.25 rounds to one decimal
    });
    expect(buckets.get('claude.seven_day_haiku')).toMatchObject({
      label: 'Seven day haiku',
      priority: 5,
      pct: 3.8,
      resetsAt: null
    });
  });

  it('skips every unreadable entry and clamps out-of-range percentages', () => {
    const buckets = parseClaudeUsage(claudeMalformed);
    // Only seven_day_fable carries a numeric utilization.
    expect(buckets.map((b) => b.id)).toEqual(['claude.seven_day_fable']);
    expect(buckets[0]?.pct).toBe(100);
    // resets_at was a number, not a timestamp.
    expect(buckets[0]?.resetsAt).toBeNull();
  });

  it('returns [] for non-object payloads', () => {
    expect(parseClaudeUsage(null)).toEqual([]);
    expect(parseClaudeUsage(undefined)).toEqual([]);
    expect(parseClaudeUsage('nope')).toEqual([]);
    expect(parseClaudeUsage(42)).toEqual([]);
    expect(parseClaudeUsage([])).toEqual([]);
    expect(parseClaudeUsage({})).toEqual([]);
  });

  it('clamps negative utilizations to zero', () => {
    const buckets = parseClaudeUsage({ five_hour: { utilization: -5, resets_at: null } });
    expect(buckets[0]?.pct).toBe(0);
  });
});

/**
 * Dropping the endpoint's internals.
 *
 * The live 2026-09-09 response on the owner's account carried `nimbus_quill`
 * beside the two real windows: `{utilization: 0, resets_at: null}`, matching
 * nothing on the dashboard. The rule has to remove that without also removing a
 * *real* window that happens to be quiet, or a real new one whose key Walder has
 * never heard of — hence a keep case for each.
 */
describe('parseClaudeUsage — non-window internals', () => {
  const ids = (json: unknown): string[] => parseClaudeUsage(json).map((b) => b.id);

  it('drops an unknown key with no reset time and no usage', () => {
    expect(
      ids({
        five_hour: { utilization: 40, resets_at: '2026-09-09T18:00:00Z' },
        mystery_thing: { utilization: 0, resets_at: null }
      })
    ).toEqual(['claude.five_hour']);
  });

  it('drops it whether resets_at is null, absent, blank or unparseable', () => {
    for (const resets of [null, undefined, '', '   ', 'not a date']) {
      expect(ids({ mystery_thing: { utilization: 0, resets_at: resets } })).toEqual([]);
    }
  });

  it('drops an unknown key even when it has a reset time', () => {
    // Inverted 2026-09-10: this used to be the "keep" rule that let
    // `amber_ladder` (0 %, a real month-end reset) onto the card as a
    // permanently-empty row about nothing. A reset time is no longer enough on
    // its own — only `CLAUDE_WINDOW_MAP`/`KNOWN_PATTERNS` are.
    const buckets = parseClaudeUsage({
      mystery_thing: { utilization: 0, resets_at: '2026-09-16T09:30:00Z' }
    });
    expect(buckets).toHaveLength(0);
  });

  it('drops an unknown key even when it carries usage', () => {
    const buckets = parseClaudeUsage({ mystery_thing: { utilization: 7.5, resets_at: null } });
    expect(buckets).toHaveLength(0);
  });

  it('keeps a known window that is quiet and has no reset time', () => {
    // 0 % with nothing else to say is a fact about a real allowance, not an
    // internal: plenty left.
    expect(ids({ seven_day_sonnet: { utilization: 0, resets_at: null } })).toEqual([
      'claude.seven_day_sonnet'
    ]);
  });

  it('drops an IGNORED_KEYS entry even when it carries a value', () => {
    // By name, not by shape: whatever `nimbus_quill` starts reporting, it still
    // corresponds to nothing the owner can see.
    expect(IGNORED_KEYS.has('nimbus_quill')).toBe(true);
    expect(
      ids({
        five_hour: { utilization: 40, resets_at: null },
        nimbus_quill: { utilization: 55, resets_at: '2026-09-16T09:30:00Z' }
      })
    ).toEqual(['claude.five_hour']);
  });

  it('returns [] when the payload was nothing but internals', () => {
    expect(parseClaudeUsage({ nimbus_quill: { utilization: 0, resets_at: null } })).toEqual([]);
  });

  it('keeps a seven_day_<family> key the map does not spell out, humanised at its priority', () => {
    // `seven_day_haiku` is allowed by `CLAUDE_WINDOW_FAMILIES` and falls to the
    // generic priority 5; `seven_day_fable_5` is allowed by the *Fable* pattern
    // (a versioned family name is not in the family list) and still gets
    // Fable's priority 1 via `claudePriority`'s substring check — being allowed
    // only decides whether the key is shown at all.
    const buckets = byId(
      parseClaudeUsage({
        seven_day_haiku: { utilization: 20, resets_at: null },
        seven_day_fable_5: { utilization: 10, resets_at: null }
      })
    );
    expect(buckets.get('claude.seven_day_haiku')).toMatchObject({
      label: 'Seven day haiku',
      priority: 5,
      pct: 20
    });
    expect(buckets.get('claude.seven_day_fable_5')).toMatchObject({
      label: 'Seven day fable 5',
      priority: 1,
      pct: 10
    });
  });

  it('does not let a codename ride the seven_day pattern', () => {
    // The pattern is anchored at both ends: a key that merely *contains*
    // "seven_day" — rather than starting with "seven_day_" — must not sneak
    // past the whitelist by association.
    expect(
      parseClaudeUsage({ prefix_seven_day_bonus: { utilization: 12, resets_at: null } })
    ).toEqual([]);
  });

  it('reports each dropped unknown key through onIgnored with shape only (and not nimbus_quill)', () => {
    const seen: IgnoredWindow[] = [];
    const buckets = parseClaudeUsage(
      {
        five_hour: { utilization: 40, resets_at: '2026-09-09T18:00:00Z' },
        nimbus_quill: { utilization: 0, resets_at: null },
        amber_ladder: { utilization: 0, resets_at: '2026-10-02T00:00:00Z' }
      },
      { onIgnored: (w) => seen.push(w) }
    );
    // nimbus_quill is IGNORED_KEYS: dropped before onIgnored is ever consulted.
    expect(seen).toEqual([{ key: 'amber_ladder', hasUtilization: true, resetsOn: '2026-10-02' }]);
    // And it never reaches the card either way.
    expect(buckets.map((b) => b.key)).not.toContain('amber_ladder');
    expect(buckets.map((b) => b.key)).not.toContain('nimbus_quill');
  });

  it('hasUtilization is always true from parseClaudeUsage — reserved wording, not production output', () => {
    // `IgnoredWindow.hasUtilization` exists in the shape (see its doc comment)
    // but `parseClaudeUsage` can never actually produce `false` for it: an
    // entry with no readable `utilization` is dropped as malformed *before*
    // the whitelist check that calls `onIgnored` is ever reached, whatever
    // resets_at it carries. This test is not "utilization absent happens in
    // practice" — it is the opposite, pinning that the field stays `true`
    // here so nobody mistakes `ignoredWindowLine`'s "utilization absent"
    // wording (exercised directly in usage-diagnostics.test.ts) for something
    // this parser emits today.
    const seen: IgnoredWindow[] = [];
    parseClaudeUsage(
      { no_number_at_all: { resets_at: '2026-09-16T00:00:00Z' }, amber_ladder: { utilization: 0, resets_at: null } },
      { onIgnored: (w) => seen.push(w) }
    );
    // `no_number_at_all` never reaches onIgnored at all — it has no
    // utilization, so it is silently dropped as malformed, not reported.
    expect(seen).toEqual([{ key: 'amber_ladder', hasUtilization: true, resetsOn: null }]);
    expect(seen.every((w) => w.hasUtilization === true)).toBe(true);
  });
});

/**
 * The `seven_day_…` family allow-list (H1).
 *
 * The first draft allowed `^seven_day_<word>$` outright, on the theory that a
 * new per-model window is a real event and should not need a release. The
 * owner's live payload killed that theory: it carries `seven_day_cowork`,
 * `seven_day_omelette` and `seven_day_breakdown` alongside the real
 * `seven_day_opus` / `seven_day_sonnet`, so the open pattern would have put
 * three rows on the card that correspond to nothing on the dashboard. Only a
 * named family is allowed now — and a `seven_day_<unknown>` must still be
 * *reported*, so a genuinely new family is one log line away rather than
 * silently gone.
 */
describe('the seven_day_ pattern is closed to named model families', () => {
  const ignoredFrom = (json: unknown): IgnoredWindow[] => {
    const seen: IgnoredWindow[] = [];
    parseClaudeUsage(json, { onIgnored: (w) => seen.push(w) });
    return seen;
  };

  it('lists exactly the shipped Anthropic families', () => {
    expect([...CLAUDE_WINDOW_FAMILIES]).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
  });

  it('drops the live payload’s non-allowance seven_day_ keys and reports each one', () => {
    const json = {
      five_hour: { utilization: 40, resets_at: '2026-09-10T18:00:00Z' },
      seven_day: { utilization: 12, resets_at: '2026-09-14T09:00:00Z' },
      // All three are real top-level keys on the owner's account, and none is
      // an allowance. `seven_day_breakdown` carries a utilization here on
      // purpose: shape alone cannot tell it from a window, which is the point.
      seven_day_cowork: { utilization: 3, resets_at: '2026-09-14T09:00:00Z' },
      seven_day_omelette: { utilization: 0, resets_at: null },
      seven_day_breakdown: { utilization: 55, resets_at: '2026-09-14T09:00:00Z' }
    };
    const seen: IgnoredWindow[] = [];
    const buckets = parseClaudeUsage(json, { onIgnored: (w) => seen.push(w) });

    expect(buckets.map((b) => b.key).sort()).toEqual(['five_hour', 'seven_day', 'seven_day_fable']);
    expect(seen).toEqual([
      { key: 'seven_day_cowork', hasUtilization: true, resetsOn: '2026-09-14' },
      { key: 'seven_day_omelette', hasUtilization: true, resetsOn: null },
      { key: 'seven_day_breakdown', hasUtilization: true, resetsOn: '2026-09-14' }
    ]);
  });

  it('reports rather than silently swallows a seven_day_ key for an unknown family', () => {
    // The whole reason the drop goes through `onIgnored`: the day Anthropic
    // ships a family this list has never heard of, the verbose log says which
    // word to add. Silence here would look identical to "no new window".
    expect(ignoredFrom({ seven_day_tangelo: { utilization: 9, resets_at: null } })).toEqual([
      { key: 'seven_day_tangelo', hasUtilization: true, resetsOn: null }
    ]);
  });

  it('keeps seven_day_haiku, the one family in the list the map does not name', () => {
    expect(isAllowedClaudeWindow('seven_day_haiku')).toBe(true);
    expect(ignoredFrom({ seven_day_haiku: { utilization: 20, resets_at: null } })).toEqual([]);
    expect(parseClaudeUsage({ seven_day_haiku: { utilization: 20, resets_at: null } })).toEqual([
      expect.objectContaining({ key: 'seven_day_haiku', pct: 20 })
    ]);
  });

  it('keeps seven_day_fable at priority 1, above the shared weekly row', () => {
    const buckets = byId(
      parseClaudeUsage({
        seven_day: { utilization: 12, resets_at: null },
        seven_day_fable: { utilization: 78, resets_at: null }
      })
    );
    expect(buckets.get('claude.seven_day_fable')).toMatchObject({
      label: '7-day Fable',
      priority: 1,
      pct: 78
    });
    // The real row, not the mirror: nothing was derived.
    expect(buckets.get('claude.seven_day_fable')?.derived).toBeUndefined();
    expect(buckets.get('claude.seven_day')?.priority).toBe(3);
  });

  it('accepts each named family and refuses look-alikes', () => {
    for (const family of CLAUDE_WINDOW_FAMILIES) {
      expect(isAllowedClaudeWindow(`seven_day_${family}`), family).toBe(true);
    }
    for (const key of ['seven_day_cowork', 'seven_day_breakdown', 'seven_day_opusx', 'seven_day_opus_5', 'seven_dayopus', 'prefix_seven_day_opus']) {
      // `seven_day_opus_5` is refused *by this pattern*; a versioned Opus key
      // is a release-note problem, not a silent one — it is reported.
      expect(isAllowedClaudeWindow(key), key).toBe(false);
    }
  });
});

/**
 * The live 2026-09-10 shape: `amber_ladder` beside the two real windows and
 * the already-known `nimbus_quill`. This is the exact payload that motivated
 * the whitelist inversion above — see `CLAUDE_WINDOW_MAP`'s doc comment.
 */
describe('parseClaudeUsage — the 2026-09-10 amber_ladder shape', () => {
  it('yields exactly five_hour, seven_day and the derived Fable row', () => {
    const buckets = parseClaudeUsage(claudeWebUsageAmber);
    expect(buckets.map((b) => b.key).sort()).toEqual(['five_hour', 'seven_day', 'seven_day_fable']);
  });

  it('feeds pctForFace from the real five_hour reading, unaffected by the drop', () => {
    const buckets = parseClaudeUsage(claudeWebUsageAmber);
    expect(pctForFace(buckets)).toBe(22.5);
  });
});

/**
 * The derived "7-day Fable" row.
 *
 * The dashboard shows a Fable weekly row with the same value and reset as "All
 * models"; the usage response has no Fable key at all. The owner's decision
 * (2026-09-09) is to show the row anyway, marked as the shared pool, because
 * Fable is the model he runs.
 */
describe('parseClaudeUsage — derived Fable row', () => {
  const LIVE = {
    five_hour: { utilization: 12, resets_at: '2026-09-09T18:00:00Z' },
    seven_day: { utilization: 33, resets_at: '2026-09-14T09:30:00Z' }
  };

  it('mirrors seven_day when no Fable key is reported', () => {
    const fable = byId(parseClaudeUsage(LIVE)).get('claude.seven_day_fable');
    expect(fable).toMatchObject({
      service: 'claude',
      key: 'seven_day_fable',
      label: '7-day Fable',
      pct: 33,
      resetsAt: '2026-09-14T09:30:00Z',
      priority: 1,
      derived: true
    });
  });

  it('carries no raw payload, because there was none', () => {
    const fable = byId(parseClaudeUsage(LIVE)).get('claude.seven_day_fable');
    expect(fable?.raw).toBeUndefined();
  });

  it('mirrors an unknown percentage rather than inventing one', () => {
    // `seven_day` at 0 % is the honest case; the derived row must not read as
    // anything else.
    const buckets = byId(parseClaudeUsage({ seven_day: { utilization: 0, resets_at: null } }));
    expect(buckets.get('claude.seven_day_fable')).toMatchObject({ pct: 0, resetsAt: null });
  });

  it('is not synthesised when there is no seven_day window', () => {
    const buckets = parseClaudeUsage({ five_hour: { utilization: 12, resets_at: null } });
    expect(buckets.map((b) => b.id)).toEqual(['claude.five_hour']);
  });

  it('defers to a real Fable key when the endpoint reports one', () => {
    const buckets = parseClaudeUsage(claudeUsageUnknownKey);
    const fable = buckets.filter((b) => /fable/i.test(b.key));
    expect(fable).toHaveLength(1);
    // The reported one: 88.25 %, not seven_day's 61 %.
    expect(fable[0]?.pct).toBe(88.3);
    expect(fable[0]?.derived).toBeUndefined();
  });

  it('defers to any spelling of a Fable key, not just seven_day_fable', () => {
    const buckets = parseClaudeUsage({
      seven_day: { utilization: 33, resets_at: null },
      fable_weekly: { utilization: 71, resets_at: null }
    });
    expect(buckets.filter((b) => /fable/i.test(b.key)).map((b) => b.pct)).toEqual([71]);
    expect(buckets.some((b) => b.derived === true)).toBe(false);
  });

  describe('the Fable pattern is anchored, not a bare substring match', () => {
    // `KNOWN_PATTERNS` used to include a bare `/fable/i`, which would let
    // `notfable_ladder` — a codename that merely contains the letters — ride
    // onto the card the same way `amber_ladder` did before the whitelist
    // existed at all. `(^|_)fable(_|$)` requires "fable" to be its own
    // underscore-delimited word (or the whole key, or its start/end).
    it.each(['fable_weekly', 'seven_day_fable', 'weekly_fable'])(
      'accepts %s',
      (key) => {
        expect(isAllowedClaudeWindow(key)).toBe(true);
      }
    );

    it('accepts a key that ends in _fable, even with an unrelated prefix', () => {
      // `amber_fable` ends with `_fable`, so the anchored pattern matches it —
      // a key literally ending in `_fable` is a Fable window, whatever the
      // rest of the name says. This is a deliberate acceptance, not an
      // oversight.
      expect(isAllowedClaudeWindow('amber_fable')).toBe(true);
    });

    it.each(['notfable_ladder', 'fablex'])('rejects %s', (key) => {
      expect(isAllowedClaudeWindow(key)).toBe(false);
    });
  });

  it('does not drive the face — that is still five_hour only', () => {
    // The derived row sits at 33 %; the 5-hour window at 12 %. `pctForFace`
    // must read the 5-hour one, or a shared weekly pool would silently become
    // the dog's expression.
    expect(pctForFace(parseClaudeUsage(LIVE))).toBe(12);
  });
});

describe('parseChatGptUsage', () => {
  const now = new Date('2026-09-08T12:00:00Z');

  it('parses the real wham/usage rate_limit payload', () => {
    const buckets = parseChatGptUsage(codexUsage, now);
    // Two windows plus the spend-limit row. The same payload's `credits`
    // block says a pool exists and nothing else, which is no row at all
    // (see `parseCodexCredits`).
    expect(buckets).toHaveLength(3);

    const m = byId(buckets);
    expect(m.get('chatgpt.codex_primary')).toMatchObject({
      service: 'chatgpt',
      key: 'codex_primary',
      label: 'Codex 5-hour',
      pct: 37,
      priority: 4,
      // reset_at 1788894534 (unix SECONDS), not now + reset_after_seconds.
      resetsAt: '2026-09-08T19:08:54.000Z'
    });
    expect(m.get('chatgpt.codex_secondary')).toMatchObject({
      service: 'chatgpt',
      key: 'codex_secondary',
      label: 'Codex weekly',
      pct: 12,
      priority: 4,
      resetsAt: '2026-09-15T14:08:54.000Z'
    });
  });

  it('mines nothing out of the account metadata beside rate_limit', () => {
    const ids = parseChatGptUsage(codexUsage, now).map((b) => b.id);
    // `rate_limit_reset_credits` and `model_usage` are not usage windows,
    // however usage-shaped their field names look. `credits` and
    // `spend_control` ARE read, but only by their own explicit parsers, into
    // their own rows — never mined by the tolerant walker, which would have
    // invented `chatgpt.spend_control.individual_limit` and friends.
    expect(ids).toEqual([
      'chatgpt.codex_primary',
      'chatgpt.codex_secondary',
      CODEX_SPEND_LIMIT_ID
    ]);
    for (const id of ids) {
      expect(id).not.toMatch(/model_usage|reset_credits|individual_limit/);
    }
  });

  it('labels an in-between Codex window in hours', () => {
    const buckets = parseChatGptUsage(
      {
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 86400, reset_at: 1788894534 }
        }
      },
      now
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.label).toBe('Codex 24h');
  });

  it('skips a rate_limit window that is missing or malformed', () => {
    const buckets = parseChatGptUsage(
      { rate_limit: { primary_window: { used_percent: 55, limit_window_seconds: 18000 } } },
      now
    );
    expect(buckets.map((b) => b.id)).toEqual(['chatgpt.codex_primary']);
    expect(buckets[0]?.resetsAt).toBeNull();
  });

  it('labels an in-between legacy window in hours', () => {
    const buckets = parseChatGptUsage(
      { rate_limits: { mid: { used_percent: 10, window_minutes: 1440 } } },
      now
    );
    expect(buckets[0]?.label).toBe('ChatGPT 24h');
  });

  it('walks an unknown shape and derives pct from remaining + limit', () => {
    const buckets = parseChatGptUsage(chatgptUnknown, now);
    expect(buckets).toHaveLength(2);

    const m = byId(buckets);
    expect(m.get('chatgpt.account.quotas.messages')).toMatchObject({
      service: 'chatgpt',
      key: 'account.quotas.messages',
      label: 'ChatGPT Messages',
      pct: 75, // (80 - 20) / 80
      resetsAt: '2026-09-08T21:15:00Z',
      priority: 4
    });
    expect(m.get('chatgpt.account.quotas.deep_research')).toMatchObject({
      label: 'ChatGPT Deep research',
      pct: 55.5,
      resetsAt: null
    });
  });

  it('does not emit a bucket for ancestor objects that only contain children', () => {
    const ids = parseChatGptUsage(chatgptUnknown, now).map((b) => b.id);
    expect(ids).not.toContain('chatgpt.root');
    expect(ids).not.toContain('chatgpt.account');
    expect(ids).not.toContain('chatgpt.account.quotas');
  });

  it('returns [] when nothing is recognisable', () => {
    expect(parseChatGptUsage(null, now)).toEqual([]);
    expect(parseChatGptUsage({ hello: 'world' }, now)).toEqual([]);
    expect(parseChatGptUsage({ nested: { deeper: { name: 'x' } } }, now)).toEqual([]);
    expect(parseChatGptUsage([], now)).toEqual([]);
  });

  it('survives a self-referencing payload', () => {
    const cyclic: Record<string, unknown> = { usage: 10 };
    cyclic['self'] = cyclic;
    expect(parseChatGptUsage(cyclic, now)).toHaveLength(1);
  });
});

describe('reset timestamps — absolute beats relative', () => {
  const now = new Date('2026-09-08T12:00:00Z');

  it('prefers an absolute reset_at over the reset_after_seconds beside it', () => {
    const buckets = parseChatGptUsage(
      { quota: { used_percent: 50, reset_after_seconds: 60, reset_at: 1788894534 } },
      now
    );
    // now + 60s would be 12:01:00Z; the absolute epoch must win.
    expect(buckets[0]?.resetsAt).toBe('2026-09-08T19:08:54.000Z');
  });

  it('prefers an ISO string over both an epoch and an offset', () => {
    const buckets = parseChatGptUsage(
      {
        quota: {
          used_percent: 50,
          resets_in_seconds: 60,
          reset_at: 1788894534,
          reset_time: '2026-09-10T08:00:00Z'
        }
      },
      now
    );
    expect(buckets[0]?.resetsAt).toBe('2026-09-10T08:00:00Z');
  });

  it('still falls back to a relative offset when that is all there is', () => {
    const buckets = parseChatGptUsage({ quota: { used_percent: 50, resets_in_seconds: 5400 } }, now);
    expect(buckets[0]?.resetsAt).toBe('2026-09-08T13:30:00.000Z');
  });

  it('reads a millisecond epoch as absolute', () => {
    const buckets = parseChatGptUsage(
      { quota: { used_percent: 50, reset_at: 1788894534000 } },
      now
    );
    expect(buckets[0]?.resetsAt).toBe('2026-09-08T19:08:54.000Z');
  });

  it('treats a named offset as relative even when the value is large', () => {
    const buckets = parseChatGptUsage(
      { quota: { used_percent: 50, reset_after_seconds: 604800 } },
      now
    );
    expect(buckets[0]?.resetsAt).toBe('2026-09-15T12:00:00.000Z');
  });

  it('ignores an unreadable reset value', () => {
    const buckets = parseChatGptUsage({ quota: { used_percent: 50, reset_at: null } }, now);
    expect(buckets[0]?.resetsAt).toBeNull();
  });
});

describe('percentage reading — window lengths are not percentages', () => {
  const now = new Date('2026-09-08T12:00:00Z');

  it('emits no bucket for a lone limit_window_seconds', () => {
    // 604800 read as a percentage would clamp to a fake 100 %.
    expect(parseChatGptUsage({ limit_window_seconds: 604800 }, now)).toEqual([]);
    expect(parseChatGptUsage({ window: { limit_window_seconds: 604800 } }, now)).toEqual([]);
  });

  it('emits no bucket for bare counts with no denominator', () => {
    expect(parseChatGptUsage({ window: { limit: 500 } }, now)).toEqual([]);
    expect(parseChatGptUsage({ window: { remaining: 12 } }, now)).toEqual([]);
  });

  it('does not read a window length as the ratio denominator', () => {
    const buckets = parseChatGptUsage(
      { window: { used: 40, limit_window_seconds: 18000, reset_at: 1788894534 } },
      now
    );
    // A reset made this a bucket, but 40/18000 is not a usage ratio; `used` is
    // read as a bare percentage instead.
    expect(buckets[0]?.pct).toBe(40);
  });

  it('still computes used/limit when a real denominator is present', () => {
    const buckets = parseChatGptUsage({ window: { used: 30, limit: 120 } }, now);
    expect(buckets[0]?.pct).toBe(25);
  });

  it('prefers used_percent over a used/limit pair in the same object', () => {
    const buckets = parseChatGptUsage(
      { window: { used_percent: 40, used: 90, limit: 100, reset_at: 1788894534 } },
      now
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.pct).toBe(40);
  });

  it('prefers utilization over a remaining/limit pair in the same object', () => {
    const buckets = parseChatGptUsage({ window: { utilization: 12, remaining: 20, limit: 80 } }, now);
    expect(buckets[0]?.pct).toBe(12);
  });
});

describe('formatResetsIn', () => {
  const now = new Date('2026-09-08T12:00:00Z');
  /** Every countdown pin below is explicitly that style now that it is not the default. */
  const down = { style: 'countdown' } as const;

  it('formats hours and minutes', () => {
    expect(formatResetsIn('2026-09-08T14:14:00Z', now, down)).toBe('resets in 2h 14m');
  });

  it('formats days and hours', () => {
    expect(formatResetsIn('2026-09-11T16:00:00Z', now, down)).toBe('resets in 3d 4h');
  });

  it('formats minutes only', () => {
    expect(formatResetsIn('2026-09-08T12:05:00Z', now, down)).toBe('resets in 5m');
  });

  it('rounds a sub-minute remainder up to 1m rather than showing 0m', () => {
    expect(formatResetsIn('2026-09-08T12:00:30Z', now, down)).toBe('resets in 1m');
  });

  it('reports a past or exactly-due reset as pending, whichever the style', () => {
    expect(formatResetsIn('2026-09-08T11:59:00Z', now, down)).toBe('reset pending');
    expect(formatResetsIn('2026-09-08T12:00:00Z', now, down)).toBe('reset pending');
    expect(formatResetsIn('2026-09-08T11:59:00Z', now)).toBe('reset pending');
    expect(formatResetsIn('2026-09-08T12:00:00Z', now)).toBe('reset pending');
  });

  it('returns an empty string for null or unparseable input, whichever the style', () => {
    expect(formatResetsIn(null, now, down)).toBe('');
    expect(formatResetsIn('not a date', now, down)).toBe('');
    expect(formatResetsIn(null, now)).toBe('');
    expect(formatResetsIn('not a date', now)).toBe('');
  });

  /*
   * The ladder. `timeZone` is pinned so the two formatted rungs say the same
   * thing on the owner's Mac and on a CI runner in another zone — the renderer
   * passes none and gets the host zone, which is the point of the feature.
   */
  describe('the clock ladder', () => {
    const clock = { locale: 'en-GB', timeZone: 'UTC' } as const;

    it('is the default, because the countdown is what this change exists to fix', () => {
      // No `style` at all: nine days out must already be a date, not "9d 0h".
      expect(formatResetsIn('2026-09-17T14:30:00Z', new Date('2026-09-08T12:00:00Z'))).not.toContain(
        'resets in'
      );
    });

    it('stays a countdown under an hour', () => {
      expect(formatResetsIn('2026-09-08T12:47:00Z', now, clock)).toBe('resets in 47m');
    });

    it('stays a countdown under a day', () => {
      expect(formatResetsIn('2026-09-08T15:20:00Z', now, clock)).toBe('resets in 3h 20m');
    });

    it('becomes a weekday and a time past a day', () => {
      // Monday 10:00 -> Thursday 14:30: three days out, and the weekday is the
      // answer the owner was doing the arithmetic to get to.
      const monday = new Date('2026-09-14T10:00:00Z');
      expect(formatResetsIn('2026-09-17T14:30:00Z', monday, clock)).toBe('resets Thu 14:30');
    });

    it('becomes a date once a weekday no longer identifies the day', () => {
      // Nine days out: "Mon" would be ambiguous between two Mondays.
      const monday = new Date('2026-09-14T10:00:00Z');
      // `en-GB` abbreviates September as "Sept"; the assertion follows Intl
      // rather than a hand-written month name, which is the whole reason Intl
      // is doing the formatting.
      expect(formatResetsIn('2026-09-28T09:00:00Z', monday, clock)).toBe('resets 28 Sept');
    });

    it('falls back to the countdown rather than throwing on an unusable locale', () => {
      // `navigator.language` is whatever the host says it is, and
      // `Intl.DateTimeFormat` throws `RangeError` on a tag it cannot parse. A
      // card that dies mid-paint is far worse than one wording a reset the old way.
      expect(formatResetsIn('2026-09-11T16:00:00Z', now, { locale: 'not a locale' })).toBe(
        'resets in 3d 4h'
      );
    });
  });
});

describe('mergeBuckets', () => {
  it('sorts by priority then id', () => {
    const merged = mergeBuckets(
      parseClaudeUsage(claudeUsageUnknownKey),
      parseChatGptUsage(codexUsage, new Date('2026-09-08T12:00:00Z'))
    );
    expect(merged.map((b) => b.id)).toEqual([
      'claude.five_hour',
      'claude.seven_day_fable',
      'claude.seven_day_opus',
      'claude.seven_day',
      'chatgpt.codex_primary',
      'chatgpt.codex_secondary',
      // Priority 4.5: a half-step that lands it between the Codex windows and
      // the credits row without renumbering either.
      'chatgpt.codex_spend_limit',
      // Priority 5, alongside the unmapped weekly window; `chatgpt.` sorts
      // before `claude.` at an equal priority.
      'claude.seven_day_haiku'
    ]);
  });

  it('handles empty and missing lists', () => {
    expect(mergeBuckets()).toEqual([]);
    expect(mergeBuckets([], [])).toEqual([]);
  });
});

describe('mergeBuckets with a primary service', () => {
  const claudeRows = (): Bucket[] => parseClaudeUsage(claudeUsageUnknownKey);
  const chatgptRows = (): Bucket[] =>
    parseChatGptUsage(codexUsage, new Date('2026-09-08T12:00:00Z'));

  it('is byte-identical to the old sort when no primary service is given', () => {
    const claude = claudeRows();
    const chatgpt = chatgptRows();
    // The literal sort this function had before the bias was added. Not a
    // paraphrase of the new implementation: the point is that an unbiased call
    // still produces exactly the rows, in exactly the order, with exactly the
    // priorities it always did.
    const asBefore = [...claude, ...chatgpt].sort(
      (a, b) => a.priority - b.priority || a.id.localeCompare(b.id)
    );
    expect(mergeBuckets(claude, chatgpt)).toEqual(asBefore);
  });

  it('puts the primary service first, keeping each service’s own order', () => {
    const claude = claudeRows();
    const chatgpt = chatgptRows();
    const plain = mergeBuckets(claude, chatgpt).map((b) => b.id);
    const biased = mergeBuckets('chatgpt', claude, chatgpt).map((b) => b.id);

    const only = (ids: string[], service: string): string[] =>
      ids.filter((id) => id.startsWith(`${service}.`));

    expect(only(biased, 'chatgpt').concat(only(biased, 'claude'))).toEqual(biased);
    expect(only(biased, 'chatgpt')).toEqual(only(plain, 'chatgpt'));
    expect(only(biased, 'claude')).toEqual(only(plain, 'claude'));
  });

  it('groups the other way round when claude is the primary service', () => {
    const claude = claudeRows();
    const chatgpt = chatgptRows();
    const plain = mergeBuckets(claude, chatgpt).map((b) => b.id);
    const biased = mergeBuckets('claude', claude, chatgpt).map((b) => b.id);
    const only = (ids: string[], service: string): string[] =>
      ids.filter((id) => id.startsWith(`${service}.`));

    expect(biased).toEqual(only(plain, 'claude').concat(only(plain, 'chatgpt')));
  });

  it('rewrites the priorities so the bark machine agrees with the card', () => {
    // The card reads the returned order; `Behaviour` reads `bucket.priority`
    // off the same buckets and hands it to `NudgeMachine`. If the two
    // disagreed, the row at the top of the card would not be the bark that
    // wins. Non-decreasing priorities down the list is exactly that agreement.
    const rows = mergeBuckets('chatgpt', claudeRows(), chatgptRows());
    const priorities = rows.map((b) => b.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    for (const row of rows) {
      expect(row.priority >= 100, row.id).toBe(row.service === 'claude');
    }
  });

  it('returns new bucket objects rather than mutating the caller’s', () => {
    const claude = claudeRows();
    const before = claude.map((b) => b.priority);
    mergeBuckets('chatgpt', claude, chatgptRows());
    expect(claude.map((b) => b.priority)).toEqual(before);
  });
});

/* ------------------------------------------------------------- Stage II */

describe('claudeLimitKey', () => {
  it('slugs the dashboard display name, and nothing more', () => {
    expect(claudeLimitKey('Fable')).toBe('seven_day_fable');
    // A name that carries a version keeps it: the payload sends a *display*
    // name, so this is the row the owner is looking at on claude.ai, and the
    // version digits are part of what he read there.
    expect(claudeLimitKey('Opus 4.5')).toBe('seven_day_opus_4_5');
    expect(claudeLimitKey('Claude Sonnet')).toBe('seven_day_claude_sonnet');
  });

  it('collapses case and punctuation so one model is one row across polls', () => {
    // The key is an identity for state that has to survive a poll — the bark
    // machine's `lastFired`, the panel's row order — so `"Fable"` and
    // `"fable"` must not become two rows with two bark histories.
    expect(claudeLimitKey('fable')).toBe(claudeLimitKey('FABLE'));
    expect(claudeLimitKey('Fable  5')).toBe('seven_day_fable_5');
    expect(claudeLimitKey('  Fable-5  ')).toBe('seven_day_fable_5');
  });

  it('refuses a name with nothing left after slugging', () => {
    // A key of `seven_day_` alone is not an identity.
    expect(claudeLimitKey('—')).toBeNull();
    expect(claudeLimitKey('?!')).toBeNull();
    expect(claudeLimitKey('')).toBeNull();
  });

  it('no longer consults CLAUDE_WINDOW_FAMILIES, and must not start again', () => {
    /*
     * The allow-list is for bare top-level keys, which arrive with nothing to
     * vouch for them. A scoped `limits[]` entry arrives with the dashboard's
     * own human name for the row, so gating it on a hardcoded word list could
     * only ever hide a row the owner can see on claude.ai — which is the exact
     * bug this area exists to fix. So a family nobody has taught Walder keys
     * cleanly and shows up.
     */
    expect(claudeLimitKey('Kingfisher')).toBe('seven_day_kingfisher');
    expect(CLAUDE_WINDOW_FAMILIES).not.toContain('kingfisher');
    // …and every family that *is* in the list keys the way it always did.
    for (const family of CLAUDE_WINDOW_FAMILIES) {
      expect(claudeLimitKey(family), family).toBe(`seven_day_${family}`);
    }
  });
});

describe('parseClaudeLimits', () => {
  it('reads only the entries scoped to a model, and names them as the dashboard does', () => {
    const rows = parseClaudeLimits(claudeWebUsageLimits);
    // Three entries in the payload; one row. The other two carry `scope: null`
    // and duplicate `five_hour` (41) and `seven_day` (62) exactly.
    expect(rows.map((b) => b.key)).toEqual(['seven_day_fable']);
    expect(rows[0]).toMatchObject({
      id: 'claude.seven_day_fable',
      label: '7-day Fable',
      priority: 1,
      pct: 78,
      resetsAt: '2026-09-14T09:00:00Z',
      kind: 'window'
    });
    // Never flagged derived: this one was reported, not invented.
    expect(rows[0]?.derived).toBeUndefined();
  });

  it('skips the unscoped duplicates silently — they are not unknown windows', () => {
    // A log line per poll saying "ignoring the 5-hour window, again" would be
    // pure noise: the row is already on the card from the top-level key.
    const seen: IgnoredWindow[] = [];
    parseClaudeLimits(claudeWebUsageLimits, { onIgnored: (w) => seen.push(w) });
    expect(seen).toEqual([]);
  });

  it('reads two scoped rows as two rows', () => {
    const rows = parseClaudeLimits({
      limits: [
        {
          percent: 80,
          resets_at: '2026-09-14T09:00:00Z',
          scope: { model: { id: null, display_name: 'Fable' }, surface: null }
        },
        {
          percent: 23,
          resets_at: '2026-09-14T09:00:00Z',
          scope: { model: { id: null, display_name: 'Opus 4.5' }, surface: null }
        }
      ]
    });
    expect(rows.map((b) => [b.key, b.label, b.pct])).toEqual([
      ['seven_day_fable', '7-day Fable', 80],
      ['seven_day_opus_4_5', '7-day Opus 4.5', 23]
    ]);
    // One priority for both: they are one class of row, and the card has no
    // basis for ordering two per-model weeklies against each other.
    expect(rows.every((b) => b.priority === 1)).toBe(true);
  });

  it('skips an entry whose display name is empty or missing, silently', () => {
    const seen: IgnoredWindow[] = [];
    const rows = parseClaudeLimits(
      {
        limits: [
          { percent: 10, scope: { model: { id: null, display_name: '' }, surface: null } },
          { percent: 20, scope: { model: { id: 'x', display_name: null }, surface: null } },
          { percent: 30, scope: { model: null, surface: null } },
          { percent: 40, scope: { surface: null } }
        ]
      },
      { onIgnored: (w) => seen.push(w) }
    );
    // There is no name to put on the row and `scope.model.id` is `null` on the
    // real payload, so there is nothing to invent one from either. Not
    // reported: an entry with no readable name is the same class of thing as a
    // window with no readable number — see `parseClaudeUsage`.
    expect(rows).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('does not read the three strings whose values are unknown', () => {
    // `kind`, `group` and `severity` are real fields whose VALUES were
    // withheld from the dump. Nothing may branch on them, so a row parses
    // identically with them absent, and with them set to nonsense.
    const scope = { model: { id: null, display_name: 'Fable' }, surface: null };
    const bare = parseClaudeLimits({ limits: [{ percent: 80, scope }] });
    const dressed = parseClaudeLimits({
      limits: [{ kind: 'zzz', group: 'zzz', severity: 'zzz', is_active: false, percent: 80, scope }]
    });
    expect(bare.map((b) => [b.key, b.pct])).toEqual([['seven_day_fable', 80]]);
    expect(dressed.map((b) => [b.key, b.pct])).toEqual(bare.map((b) => [b.key, b.pct]));
  });

  it('reads `percent`, and `utilization` as its one alias', () => {
    const scope = { model: { id: null, display_name: 'Fable' }, surface: null };
    expect(parseClaudeLimits({ limits: [{ percent: 44, scope }] })[0]?.pct).toBe(44);
    expect(parseClaudeLimits({ limits: [{ utilization: 44, scope }] })[0]?.pct).toBe(44);
    // No number at all is not a window, exactly as at the top level.
    expect(parseClaudeLimits({ limits: [{ scope }] })).toEqual([]);
  });

  it('adds no derived mirror of its own', () => {
    // Half a document; the mirror is a decision about the whole one.
    const rows = parseClaudeLimits({
      limits: [
        { percent: 5, scope: { model: { id: null, display_name: 'Opus' }, surface: null } }
      ]
    });
    expect(rows.some(isFableRow)).toBe(false);
  });

  it('returns nothing for a payload with no limits array', () => {
    expect(parseClaudeLimits(claudeUsage)).toEqual([]);
    expect(parseClaudeLimits(null)).toEqual([]);
    expect(parseClaudeLimits({ limits: 'not an array' })).toEqual([]);
    // The container name is exact now that the shape is confirmed: a guessed
    // `/limit/i` match used to accept anything limit-ish, which is one more
    // way for an unrelated field to become rows.
    expect(parseClaudeLimits({ model_limits: [{ percent: 1 }] })).toEqual([]);
  });
});

describe('parseClaudeUsage merging limits[]', () => {
  it('merges the per-model rows into the same result, from the same payload', () => {
    const m = byId(parseClaudeUsage(claudeWebUsageLimits));
    expect([...m.keys()].sort()).toEqual([
      'claude.five_hour',
      'claude.seven_day',
      'claude.seven_day_fable'
    ]);
  });

  it('suppresses the derived mirror when the scoped row exists', () => {
    // Three rows, not four: the `limits[]` entry scoped to "Fable" *is* the
    // Fable row, so `withDerivedFableRow` invents nothing and the card cannot
    // show two nearly-identically-named rows at two different percentages.
    const rows = parseClaudeUsage(claudeWebUsageLimits);
    expect(rows.filter(isFableRow)).toHaveLength(1);
    expect(rows.some((b) => b.derived === true)).toBe(false);
  });

  it('lets a real Fable row suppress the derived mirror', () => {
    const fable = byId(parseClaudeUsage(claudeWebUsageLimits)).get('claude.seven_day_fable');
    expect(fable?.derived).toBeUndefined();
    // The bug this whole stage exists to fix: 78 is Fable's own number, read
    // off the scoped `limits[]` entry, not the weekly pool's 62.
    expect(fable?.pct).toBe(78);
    expect(byId(parseClaudeUsage(claudeWebUsageLimits)).get('claude.seven_day')?.pct).toBe(62);
  });

  it('still derives the mirror when the payload carries no Fable row anywhere', () => {
    const fable = byId(parseClaudeUsage(claudeUsage)).get('claude.seven_day_fable');
    expect(fable?.derived).toBe(true);
  });

  it('drops the whitelist codenames from the top level as before', () => {
    const seen: IgnoredWindow[] = [];
    const keys = parseClaudeUsage(claudeWebUsageLimits, { onIgnored: (w) => seen.push(w) }).map(
      (b) => b.key
    );
    expect(keys).not.toContain('amber_ladder');
    expect(keys).not.toContain('nimbus_quill');
    expect(seen.map((w) => w.key)).toEqual(['amber_ladder']);
  });

  it('prefers a top-level window over a limits entry naming the same key', () => {
    // Cannot happen on the confirmed payload — no top-level key reports a
    // per-model weekly — but a `seven_day_opus` key arriving beside a
    // `display_name: "Opus"` entry is exactly the collision that would show
    // the owner one allowance twice.
    const buckets = parseClaudeUsage({
      seven_day_opus: { utilization: 11, resets_at: '2026-09-14T09:00:00Z' },
      limits: [
        { percent: 99, scope: { model: { id: null, display_name: 'Opus' }, surface: null } }
      ]
    });
    expect(buckets.filter((b) => b.key === 'seven_day_opus')).toHaveLength(1);
    expect(buckets.find((b) => b.key === 'seven_day_opus')?.pct).toBe(11);
  });

  it('applies one scale decision across both halves of the payload', () => {
    const buckets = parseClaudeUsage(
      {
        five_hour: { utilization: 0.5, resets_at: '2026-09-10T18:00:00Z' },
        limits: [
          { percent: 0.25, scope: { model: { id: null, display_name: 'Fable' }, surface: null } }
        ]
      },
      { scale: 'auto' }
    );
    expect(byId(buckets).get('claude.five_hour')?.pct).toBe(50);
    expect(byId(buckets).get('claude.seven_day_fable')?.pct).toBe(25);
  });

  it('honours derive:false for a caller that merges first', () => {
    const buckets = parseClaudeUsage(claudeUsage, { derive: false });
    expect(buckets.some(isFableRow)).toBe(false);
    // …and the caller gets the same answer by applying it afterwards.
    expect(withDerivedFableRow(buckets).some((b) => b.derived === true)).toBe(true);
  });
});

describe('isFableRow', () => {
  const row = (over: Partial<Bucket>): Bucket => ({
    id: 'x',
    service: 'claude',
    key: 'seven_day',
    label: '7-day (all models)',
    pct: 1,
    resetsAt: null,
    priority: 3,
    ...over
  });

  it('matches on the key, whatever the spelling', () => {
    expect(isFableRow(row({ key: 'seven_day_fable' }))).toBe(true);
    expect(isFableRow(row({ key: 'fable_weekly' }))).toBe(true);
    expect(isFableRow(row({ key: 'SEVEN_DAY_FABLE' }))).toBe(true);
  });

  it('matches on the label too', () => {
    expect(isFableRow(row({ key: 'seven_day_x', label: '7-day Fable' }))).toBe(true);
  });

  it('does not match an ordinary window', () => {
    expect(isFableRow(row({}))).toBe(false);
    expect(isFableRow(row({ key: 'seven_day_opus', label: '7-day Opus' }))).toBe(false);
  });
});

/* ------------------------------------------------------------ Stage III */

describe('parseExtraUsage', () => {
  it('reads the confirmed extra_usage block, in minor units', () => {
    // 962 at `decimal_places: 2` is **9.62**, and getting this wrong is a
    // hundredfold overstatement of the owner's bill on the card, silently.
    expect(parseExtraUsage(claudeExtraUsage)).toEqual({
      spent: 9.62,
      limit: null,
      currency: 'USD'
    });
  });

  it('reads a monthly cap when the account has one, on the same scale', () => {
    expect(parseExtraUsage(claudeExtraUsageWithLimit)).toEqual({
      spent: 9.62,
      limit: 50,
      currency: 'USD'
    });
  });

  it('honours decimal_places rather than assuming cents', () => {
    const block = (over: Record<string, unknown>): unknown => ({
      extra_usage: { is_enabled: true, used_credits: 962, currency: 'USD', ...over }
    });
    expect(parseExtraUsage(block({ decimal_places: 0 }))?.spent).toBe(962);
    expect(parseExtraUsage(block({ decimal_places: 3 }))?.spent).toBe(0.962);
    // Absent, or not a usable scale: two places, which is right for every
    // currency claude.ai bills in and is what the payload states anyway.
    expect(parseExtraUsage(block({}))?.spent).toBe(9.62);
    expect(parseExtraUsage(block({ decimal_places: 'two' }))?.spent).toBe(9.62);
    expect(parseExtraUsage(block({ decimal_places: -1 }))?.spent).toBe(9.62);
    expect(parseExtraUsage(block({ decimal_places: 99 }))?.spent).toBe(9.62);
  });

  it('is null when extra usage is switched off — no row, never a 0 one', () => {
    // The off fixture still carries a spend and a cap, which is exactly why
    // the flag is read strictly and the amounts are not trusted on their own.
    expect(parseExtraUsage(claudeExtraUsageOff)).toBeNull();
    expect(parseExtraUsage({ extra_usage: { used_credits: 962 } })).toBeNull();
    expect(parseExtraUsage({ extra_usage: { is_enabled: 'yes', used_credits: 962 } })).toBeNull();
  });

  it('carries spend_limit_reached, and only when it is literally true', () => {
    const withFlag = (value: unknown): unknown => ({
      extra_usage: {
        is_enabled: true,
        used_credits: 5000,
        monthly_limit: 5000,
        currency: 'USD',
        spend_limit_reached: value
      }
    });
    expect(parseExtraUsage(withFlag(true))?.limitReached).toBe(true);
    // Absent when false, so a `toEqual` on an ordinary block stays readable
    // and a truthy string cannot fire the bark. See `MoneyDetail.limitReached`.
    expect(parseExtraUsage(withFlag(false))).not.toHaveProperty('limitReached');
    expect(parseExtraUsage(withFlag('yes'))).not.toHaveProperty('limitReached');
  });

  it('falls back to the spend block, which is the same figure in another shape', () => {
    /*
     * This reverses half of the earlier M2 finding, on evidence: the values
     * dump shows `spend.used.amount_minor` is the **same 962** as
     * `extra_usage.used_credits`, so it is one fact in two shapes rather than
     * the organisation's separate bill. It is read only when the payload says
     * nothing about `extra_usage` at all — the state the owner's account was
     * observed in a day earlier.
     */
    expect(
      parseExtraUsage({
        five_hour: { utilization: 10, resets_at: null },
        extra_usage: null,
        spend: {
          used: { amount_minor: 962, currency: 'USD', exponent: 2 },
          limit: null,
          enabled: true
        }
      })
    ).toEqual({ spent: 9.62, limit: null, currency: 'USD' });
    // `cap` as the ceiling when `limit` is null, and `exponent` as the scale.
    expect(
      parseExtraUsage({
        spend: { used: { amount_minor: 500, currency: 'DKK', exponent: 2 }, cap: 20000 }
      })
    ).toEqual({ spent: 5, limit: 200, currency: 'DKK' });
  });

  it('never second-guesses an explicit "off" against the spend block (M2)', () => {
    // The M2 protection, restated as a rule about *ordering*: an account that
    // has extra usage switched off says so in `extra_usage`, and that answer
    // is final. Otherwise the card would show "Extra usage" — with barks —
    // for an account that never opted in, which is wrong in the one direction
    // that matters.
    expect(
      parseExtraUsage({
        extra_usage: { is_enabled: false, used_credits: 0, currency: 'USD' },
        spend: { used: { amount_minor: 962, currency: 'USD', exponent: 2 }, enabled: true }
      })
    ).toBeNull();
    // …and an explicitly disabled spend block is refused the same way.
    expect(
      parseExtraUsage({
        spend: { used: { amount_minor: 962, currency: 'USD', exponent: 2 }, enabled: false }
      })
    ).toBeNull();
  });

  it('is null when the payload does not mention extra usage in either shape', () => {
    expect(parseExtraUsage(claudeUsage)).toBeNull();
    expect(parseExtraUsage(claudeWebUsageLimits)).toBeNull();
    expect(parseExtraUsage({ extra_usage: { is_enabled: true } })).toBeNull();
    expect(parseExtraUsage({ spend: { limit: 5000 } })).toBeNull();
    expect(parseExtraUsage({ credits: { used_credits: 962, is_enabled: true } })).toBeNull();
    expect(parseExtraUsage({ billing: { used_credits: 962, is_enabled: true } })).toBeNull();
    expect(parseExtraUsage(null)).toBeNull();
  });

  it('rejects amounts and caps that would make the row nonsense', () => {
    const block = (over: Record<string, unknown>): unknown => ({
      extra_usage: { is_enabled: true, currency: 'USD', ...over }
    });
    expect(parseExtraUsage(block({ used_credits: -1 }))).toBeNull();
    expect(parseExtraUsage(block({ used_credits: 'lots' }))).toBeNull();
    // A cap of zero or less cannot be divided by, and is not something
    // claude.ai means by "your monthly limit": no cap, not a cap at nothing.
    expect(parseExtraUsage(block({ used_credits: 962, monthly_limit: 0 }))?.limit).toBeNull();
    expect(parseExtraUsage(block({ used_credits: 962, monthly_limit: -5 }))?.limit).toBeNull();
  });

  it('defaults the currency when none is readable, and ignores a junk one', () => {
    const block = (currency: unknown): unknown => ({
      extra_usage: { is_enabled: true, used_credits: 100, currency }
    });
    expect(parseExtraUsage(block(undefined))?.currency).toBe('USD');
    expect(parseExtraUsage(block('kroner'))?.currency).toBe('USD');
    expect(parseExtraUsage(block('dkk'))?.currency).toBe('DKK');
  });
});

describe('nextMonthlyResetAt', () => {
  /*
   * The billing anchor claude.ai does not state.
   *
   * `extra_usage` carries `monthly_limit`, `used_credits`, a currency and a
   * scale — and no date of any kind. The owner asked for the "resets in" line
   * back on that row (2026-09-11), so Walder computes it: the first instant of
   * the next calendar month, UTC. It is an inference, the card says so, and
   * these are the cases that make it a *correct* inference rather than a
   * plausible-looking one.
   */
  const at = (iso: string): string | null => nextMonthlyResetAt(Date.parse(iso));

  it('is midnight UTC on the first of the following month', () => {
    expect(at('2026-09-11T20:45:13.512Z')).toBe('2026-10-01T00:00:00.000Z');
    // A 31-day month, a 30-day month and February in a non-leap year: the
    // arithmetic must be the calendar's, not `+30 days`.
    expect(at('2026-01-31T23:59:59.999Z')).toBe('2026-02-01T00:00:00.000Z');
    expect(at('2026-02-28T12:00:00.000Z')).toBe('2026-03-01T00:00:00.000Z');
    expect(at('2026-04-30T00:00:00.000Z')).toBe('2026-05-01T00:00:00.000Z');
  });

  it('rolls the year over in December', () => {
    expect(at('2026-12-31T18:00:00.000Z')).toBe('2027-01-01T00:00:00.000Z');
  });

  it('is always in the future, including on the first of the month', () => {
    // The one instant a naive "start of this month" would produce a date in the
    // past, which `formatResetsIn` would render as "reset pending" forever.
    expect(at('2026-10-01T00:00:00.000Z')).toBe('2026-11-01T00:00:00.000Z');
    expect(at('2026-10-01T00:00:00.001Z')).toBe('2026-11-01T00:00:00.000Z');
  });

  it('answers null rather than throwing on a clock that is not a number', () => {
    // `toISOString` throws `RangeError` on an invalid Date, and this runs inside
    // the provider's own try/catch — so an exception here would not crash
    // anything visibly, it would quietly turn one poll into an error result. The
    // row simply loses its reset line, which is what it had before.
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(nextMonthlyResetAt(bad), String(bad)).toBeNull();
    }
    const row = extraUsageBucket({ spent: 1, limit: 2, currency: 'USD' }, Number.NaN);
    expect(row.resetsAt).toBeNull();
    // And no `(est.)` marker for a date that is not there.
    expect(row.resetsEstimated).toBeUndefined();
  });

  it('is UTC, so the line does not change when the user changes timezone', () => {
    // Local-time month ends would put two machines on different anchors for the
    // same account, and would shift the row by a day every daylight-saving jump.
    for (const iso of ['2026-09-30T23:30:00.000Z', '2026-10-01T00:30:00.000Z']) {
      expect((at(iso) as string).endsWith("T00:00:00.000Z"), iso).toBe(true);
    }
  });
});

describe('extraUsageBucket', () => {
  const NOW = Date.parse('2026-09-11T20:45:00.000Z');

  it('carries a derived monthly reset, flagged as an estimate', () => {
    /*
     * `resetsAt` used to be `null` here, and the comment on this function argued
     * for it: a date claude.ai never stated, shown in the provider's own voice,
     * is Walder's invention presented as fact. The owner asked for the line back
     * (2026-09-11) and he is right that a spend row with no horizon is close to
     * useless — so the fix is not to drop the argument but to answer it. The row
     * carries `resetsEstimated`, and the card renders `(est.)` after the figure,
     * the same way it already says `Est.` on the credit-price conversion. The
     * owner can now tell the difference, which is the whole thing the null was
     * protecting.
     */
    const bucket = extraUsageBucket({ spent: 9.62, limit: 50, currency: 'USD' }, NOW);
    expect(bucket.resetsAt).toBe('2026-10-01T00:00:00.000Z');
    expect(bucket.resetsEstimated).toBe(true);
  });

  it('never claims an estimate on a row that has a real reset', () => {
    // The flag is what makes `(est.)` honest, so nothing else may set it: an
    // ordinary window's reset comes from the provider and must read as such.
    for (const row of parseClaudeUsage(claudeUsage)) {
      expect(row.resetsEstimated, row.id).toBeUndefined();
    }
  });

  it('turns a capped spend into a percentage the rest of the app understands', () => {
    const bucket = extraUsageBucket({ spent: 9.62, limit: 50, currency: 'USD' }, NOW);
    expect(bucket).toMatchObject({
      id: EXTRA_USAGE_ID,
      service: 'claude',
      key: 'extra_usage',
      label: 'Extra usage',
      pct: 19.2,
      priority: 6,
      kind: 'money',
      money: { spent: 9.62, limit: 50, currency: 'USD' }
    });
  });

  it('has no percentage at all without a cap, rather than a made-up one', () => {
    // The owner's own account. `pct: null` is what stops the bar being drawn
    // and the thresholds being crossed — a `0` here would draw an empty bar
    // reading "you have used none of your allowance", and a division by zero
    // would bark 100 % forever.
    const bucket = extraUsageBucket({ spent: 9.62, limit: null, currency: 'USD' }, NOW);
    expect(bucket.pct).toBeNull();
    expect(bucket.kind).toBe('money');
  });

  it('states a reset time the payload does not, and never silently', () => {
    /*
     * This asserted `resetsAt === null` for two versions, and the reason was
     * good: "Extra usage · resets in 21d" is Walder's invention printed as the
     * provider's fact. What it got wrong is that saying nothing is not free —
     * `9.62 / 50.00` means something very different on the 2nd than on the 29th,
     * and the owner asked for the line back (2026-09-11).
     *
     * The date is therefore computed and *flagged*, and the two must stay
     * welded together: a reset here without the flag is the original lie, and
     * that is what this pins.
     */
    const row = extraUsageBucket({ spent: 1, limit: 2, currency: 'USD' }, NOW);
    expect(row.resetsAt).toBe(nextMonthlyResetAt(NOW));
    expect(row.resetsEstimated).toBe(true);
  });

  it('is not a face row: the dog still follows the 5-hour window', () => {
    const overspent = extraUsageBucket({ spent: 500, limit: 500, currency: 'DKK' }, NOW);
    expect(overspent.pct).toBe(100);
    expect(pctForFace([overspent])).toBeNull();
    expect(pctForFace([...parseClaudeUsage(claudeUsage), overspent])).toBe(42.5);
  });
});

/* --------------------------------------- the live claude.ai payload shape */

/**
 * The whole card, from the shape that actually exists.
 *
 * Every other test in this file pins one parser against one fragment; this one
 * asserts the finished rows for the payload the owner's own account returns,
 * because the failures worth catching here are the ones no single parser can
 * see — a derived Fable row appearing *beside* the reported one, a row that is
 * dropped because its family is not on a list, an Extra usage row with an
 * empty bar, or a dozen `onIgnored` lines a real one could hide in.
 */
describe('the live claude.ai payload (2026-09-10 shape)', () => {
  const NOW = Date.parse('2026-09-10T12:00:00.000Z');
  const ignored: IgnoredWindow[] = [];

  // Exactly what `providers/claude-web.ts` does with the payload, in order.
  const windows = parseClaudeUsage(claudeWebUsageLive, {
    scale: 'percent',
    onIgnored: (w) => ignored.push(w)
  });
  const money = parseExtraUsage(claudeWebUsageLive);
  const rows = mergeBuckets(windows, money === null ? [] : [extraUsageBucket(money, NOW)]);

  const claude: ServiceReport = {
    buckets: rows,
    status: 'ok',
    via: 'claude-web',
    viaLabel: 'claude.ai login'
  };
  const card = cardRowsFor(
    {
      fetchedAt: new Date(NOW - 60_000).toISOString(),
      intervalMs: 180_000,
      expression: 'neutral',
      buckets: rows,
      services: {
        claude,
        chatgpt: { buckets: [], status: 'unavailable', via: 'none', viaLabel: 'ChatGPT' }
      }
    },
    'large',
    NOW,
    'en-US'
  );
  const shown = card.sections.find((section) => section.service === 'claude')?.rows ?? [];

  it('builds exactly four rows, and these four', () => {
    expect(shown.map((r) => [r.label, r.pctText])).toEqual([
      ['5-hour', '25%'],
      ['7-day Fable', '80%'],
      ['7-day (all models)', '70%'],
      ['Extra usage', '$9.62 spent']
    ]);
  });

  it('reads the Fable row off limits[], and does not derive one', () => {
    // 80 is Fable's own number from the scoped `limits[]` entry; the weekly
    // pool is at 70. A derived mirror would have shown 70 under Fable's name.
    const fable = shown.find((r) => r.label === '7-day Fable');
    expect(fable?.shared).toBe(false);
    expect(rows.find((b) => isFableRow(b))?.derived).toBeUndefined();
  });

  it('draws no bar on the capless money row, but does state its month roll', () => {
    /*
     * No bar, because there is no cap to be a fraction of — that part has not
     * changed. The reset line has: it was `null` too, and the owner asked for it
     * back (2026-09-11). The two are not the same question. A bar with no
     * denominator would have to invent the denominator; the month roll is
     * inferred from a field literally called `monthly_limit` against a counter
     * literally called `used_credits`, and it is marked `(est.)` so the
     * inference is visible. "9,62 € spent" with no horizon is a number the owner
     * cannot act on; "9,62 € spent, resets in 20d" is one he can.
     */
    const extra = shown.find((r) => r.label === 'Extra usage');
    expect(extra?.kind).toBe('money');
    expect(extra?.bar).toBeNull();
    // `resets …` rather than `resets in …`: a month roll is always more than a
    // week out, so the default clock style words it as a date. The marker is
    // what this line is pinning, and it survives either wording.
    expect(extra?.resetsText).toMatch(/^resets .+ \(est\.\)$/u);
    // …while every window row's reset is the provider's own and unmarked.
    for (const row of shown.filter((r) => r.label !== 'Extra usage')) {
      expect(row.resetsText ?? '', row.label).not.toContain('est.');
    }
    expect(shown.filter((r) => r.bar !== null)).toHaveLength(3);
  });

  it('reports exactly one ignored key: amber_ladder', () => {
    /*
     * Twelve top-level keys come back as `null` (`seven_day_opus`,
     * `seven_day_sonnet`, `seven_day_cowork`, `seven_day_omelette`,
     * `seven_day_breakdown`, `tangelo`, `cinder_cove`, …) and one as a
     * boolean, and not one of them is an unknown window: a `null` is
     * Anthropic saying the allowance does not apply to this account. Routing
     * them through `onIgnored` would put a dozen lines in the verbose log
     * every poll and bury the one that matters. `nimbus_quill` is silent for a
     * different reason — it is in `IGNORED_KEYS`, identified and understood.
     */
    expect(ignored.map((w) => w.key)).toEqual(['amber_ladder']);
    expect(IGNORED_KEYS.has('nimbus_quill')).toBe(true);
  });
});

/* ---------------------------------------------------------- Stage III-b */

describe('parseCodexCredits', () => {
  it('gives no row for a pool whose size the endpoint will not state', () => {
    // The owner's own account: `has_credits: true, balance: null`. That used
    // to print `?` under a credit-limit row that has the real number, and a
    // row that says nothing is worse than no row (owner's request, 2026-09-19).
    expect(parseCodexCredits(codexUsage)).toBeNull();
  });

  it('reads a stated balance into a bar-less row', () => {
    const bucket = parseCodexCredits({ credits: { has_credits: true, balance: 1240 } });
    expect(bucket).toMatchObject({
      id: CODEX_CREDITS_ID,
      service: 'chatgpt',
      key: 'codex_credits',
      label: 'Codex credits',
      // Bar-less on purpose: a balance has no denominator here.
      pct: null,
      resetsAt: null,
      priority: 5,
      kind: 'credits',
      credits: { balance: 1240, unlimited: false, exhausted: false }
    });
  });

  it('reads an unlimited pool', () => {
    expect(parseCodexCredits(codexUsageUnlimited)?.credits).toMatchObject({
      unlimited: true,
      exhausted: false
    });
  });

  it('gives no row at all when the account has no credit pool', () => {
    expect(parseCodexCredits(codexUsageNoCredits)).toBeNull();
    // Two windows plus the spend-limit row — but no credits row. That fixture
    // IS the owner's own account: `has_credits: false` beside a blown cap.
    expect(parseChatGptUsage(codexUsageNoCredits, new Date('2026-09-08T12:00:00Z'))).toHaveLength(3);
    expect(parseCodexCredits({})).toBeNull();
    expect(parseCodexCredits(null)).toBeNull();
  });

  it('is exhausted when the endpoint says so, or when the balance is gone', () => {
    const of = (credits: Record<string, unknown>): boolean | undefined =>
      parseCodexCredits({ credits: { has_credits: true, ...credits } })?.credits?.exhausted;
    expect(of({ overage_limit_reached: true })).toBe(true);
    expect(of({ balance: 0 })).toBe(true);
    expect(of({ balance: -5 })).toBe(true);
    expect(of({ balance: 1240 })).toBe(false);
    // An unknown balance is not evidence of an empty one — and with nothing
    // else to say it is not a row either, so there is nothing to bark about.
    expect(of({ balance: null })).toBeUndefined();
    // An unlimited pool can never be exhausted, whatever else it says.
    expect(of({ unlimited: true, overage_limit_reached: true, balance: 0 })).toBe(false);
  });

  it('carries the cloud-message estimate when the payload gives one', () => {
    expect(
      parseCodexCredits({ credits: { has_credits: true, balance: 10, approx_cloud_messages: 42 } })
        ?.credits?.approxCloudMessages
    ).toBe(42);
    expect(parseCodexCredits(codexUsage)?.credits?.approxCloudMessages).toBeUndefined();
  });

  it('never barks through the window machinery: the row has no percentage', () => {
    const stated = { credits: { has_credits: true, balance: 10 } };
    expect(parseCodexCredits(stated)?.pct).toBeNull();
    expect(pctForFace([parseCodexCredits(stated) as Bucket])).toBeNull();
  });
});

describe('parseCodexSpendLimit', () => {
  const NOW = new Date('2026-09-11T12:00:00.000Z');

  it('reads the confirmed live shape, unclamped', () => {
    expect(parseCodexSpendLimit(codexUsageNoCredits, NOW)).toMatchObject({
      id: CODEX_SPEND_LIMIT_ID,
      service: 'chatgpt',
      key: 'codex_spend_limit',
      label: 'Codex credit limit',
      // 455, NOT 100: the cap was blown through four and a half times over and
      // that is what the card should print.
      pct: 455,
      // From `reset_at` (unix SECONDS), not now + reset_after_seconds.
      resetsAt: '2026-10-01T00:00:01.000Z',
      priority: 4.5
    });
  });

  it('reads used/limit out of their strings as a credits money row', () => {
    const row = parseCodexSpendLimit(codexUsageNoCredits, NOW);
    expect(row?.kind).toBe('money');
    expect(row?.money).toEqual({
      // Not rounded here: the card decides how many digits to show, and the
      // price conversion wants the full number.
      spent: 455.1234567890123,
      limit: 100,
      // ISO 4217 "no currency" — these are credits, and the price that turns
      // them into money is a setting applied at render time.
      currency: 'XXX',
      inCredits: true
    });
  });

  it('keeps the pct-only window row when the amounts are not usable', () => {
    // Every one of these is a real failure mode of `Number()`: '' and null both
    // coerce to 0, which would print a confident "0 / 600 credits".
    const junk = ['', ' ', 'lots', null, 42, undefined, {}];
    for (const bad of junk) {
      const row = parseCodexSpendLimit(
        { spend_control: { individual_limit: { used_percent: 455, used: bad, limit: '600' } } },
        NOW
      );
      expect(row?.pct, String(bad)).toBe(455);
      expect(row?.kind, String(bad)).toBeUndefined();
      expect(row?.money, String(bad)).toBeUndefined();
    }
    // A zero or negative cap is not a divisor, and a negative spend is not a
    // spend — both keep the row, both lose the amounts.
    for (const bad of ['0', '-1']) {
      const row = parseCodexSpendLimit(
        { spend_control: { individual_limit: { used_percent: 455, used: '10', limit: bad } } },
        NOW
      );
      expect(row?.kind, bad).toBeUndefined();
    }
    expect(
      parseCodexSpendLimit(
        { spend_control: { individual_limit: { used_percent: 1, used: '-1', limit: '600' } } },
        NOW
      )?.kind
    ).toBeUndefined();
  });

  it('gives no row when there is no cap, no block, or no number', () => {
    // `individual_limit: null` — an account with no spend cap at all.
    expect(parseCodexSpendLimit(codexUsageUnlimited, NOW)).toBeNull();
    expect(parseCodexSpendLimit({}, NOW)).toBeNull();
    expect(parseCodexSpendLimit({ spend_control: {} }, NOW)).toBeNull();
    expect(parseCodexSpendLimit(null, NOW)).toBeNull();
    // A block with everything BUT the one field the row is made of.
    expect(
      parseCodexSpendLimit({ spend_control: { individual_limit: { limit: '100' } } }, NOW)
    ).toBeNull();
    // A string percentage is not a percentage. Better no row than a `0%` one.
    for (const bad of ['455', null, NaN, Infinity, -1, {}]) {
      expect(
        parseCodexSpendLimit({ spend_control: { individual_limit: { used_percent: bad } } }, NOW)
      ).toBeNull();
    }
  });

  it('falls back to reset_after_seconds, and to no reset at all', () => {
    const of = (limit: Record<string, unknown>): string | null =>
      parseCodexSpendLimit({ spend_control: { individual_limit: limit } }, NOW)?.resetsAt ?? null;
    expect(of({ used_percent: 10, reset_after_seconds: 3600 })).toBe('2026-09-11T13:00:00.000Z');
    expect(of({ used_percent: 10 })).toBeNull();
  });

  it('sits between the Codex windows and the credits row, and coexists with it', () => {
    // The owner's fixture, with a balance the endpoint actually states, so
    // that the credits row exists — both rows, in display order.
    const stated = {
      ...codexUsage,
      credits: { ...(codexUsage as { credits: object }).credits, balance: 1240 }
    };
    const rows = parseChatGptUsage(stated, NOW);
    expect(rows.map((b) => [b.id, b.pct])).toEqual([
      ['chatgpt.codex_primary', 37],
      ['chatgpt.codex_secondary', 12],
      [CODEX_SPEND_LIMIT_ID, 42.5],
      [CODEX_CREDITS_ID, null]
    ]);
    // mergeBuckets sorts by priority, so the wiring order above is not what
    // pins the position — this is.
    expect(mergeBuckets(rows).map((b) => b.id)).toEqual(rows.map((b) => b.id));
  });

  it('reaches the card through the same entry point chatgpt-web calls', () => {
    // `providers/chatgpt-web.ts` hands the raw payload to `parseChatGptUsage`
    // and nothing else, so this IS its parse path.
    const row = parseChatGptUsage(codexUsageNoCredits, NOW).find(
      (b) => b.id === CODEX_SPEND_LIMIT_ID
    );
    expect(row?.pct).toBe(455);
    // A money row in credits: the amounts ride along, and `pct` still drives
    // the bar and the bark filter. The bar clamps even though the number does
    // not.
    expect(row?.kind).toBe('money');
    expect(row?.money).toEqual({
      spent: 455.1234567890123,
      limit: 100,
      currency: 'XXX',
      inCredits: true
    });
    expect(formatPct(row?.pct ?? null)).toBe('455%');
    expect(barFill(row?.pct ?? null)).toEqual({ filled: 20, tone: 'high' });
  });
});

describe('KNOWN_ROWS', () => {
  /*
   * The point of these tests: `KNOWN_ROWS` is the list the tray's "Show in
   * overview" checkboxes are built from, and a checkbox whose id does not match
   * what a parser emits toggles nothing at all — silently, with the row still on
   * the card. So every id is pinned against the ids the real fixtures produce,
   * rather than against a second hand-written list.
   */
  const NOW = new Date('2026-09-11T12:00:00.000Z');

  it('names the ten rows Walder can name up front, with their exact ids', () => {
    expect(KNOWN_ROWS.map((row) => row.id)).toEqual([
      'claude.five_hour',
      'claude.seven_day_fable',
      'claude.seven_day_opus',
      'claude.seven_day',
      'claude.seven_day_sonnet',
      'claude.extra_usage',
      'chatgpt.codex_primary',
      'chatgpt.codex_secondary',
      'chatgpt.codex_credits',
      'chatgpt.codex_spend_limit'
    ]);
    // Claude's rows first, then ChatGPT's — the order the submenu groups by.
    expect(KNOWN_ROWS.map((row) => row.service)).toEqual([
      ...Array<string>(6).fill('claude'),
      ...Array<string>(4).fill('chatgpt')
    ]);
  });

  it('matches the ids the live Claude payload actually produces', () => {
    const ids = new Set(KNOWN_ROWS.map((row) => row.id));
    const parsed = parseClaudeUsage(claudeWebUsageLive);
    const money = parseExtraUsage(claudeWebUsageLive);
    expect(money).not.toBeNull();
    const emitted = [...parsed, extraUsageBucket(money as MoneyDetail, NOW.getTime())];
    // Every row the live fixture produces is nameable: the 5-hour window, the
    // 7-day pool, the Fable row that arrives through `limits[]`, and the
    // Extra usage bill.
    expect(emitted.map((b) => b.id).filter((id) => !ids.has(id))).toEqual([]);
    expect(emitted.map((b) => b.id)).toContain('claude.seven_day_fable');
  });

  it('matches the id of the *derived* Fable row too', () => {
    // Two routes, one id — which is what lets one checkbox cover both. The
    // OAuth fixture has no Fable key, so this row is the mirror.
    const derived = parseClaudeUsage(claudeUsage).find((b) => b.derived === true);
    expect(derived?.id).toBe('claude.seven_day_fable');
    expect(KNOWN_ROWS.some((row) => row.id === derived?.id)).toBe(true);
  });

  it('matches every id the real Codex payload produces, labels included', () => {
    const rows = parseChatGptUsage(codexUsage, NOW);
    const named = new Map(KNOWN_ROWS.map((row) => [row.id, row.label] as const));
    expect(rows.map((b) => b.id).filter((id) => !named.has(id))).toEqual([]);
    // The two window ids are fixed by `CODEX_WINDOWS`; their labels are derived
    // from `limit_window_seconds`, so the menu's wording is only right for the
    // window lengths the fixture reports (18,000 s and 604,800 s). Pinned here
    // so a payload that changes them is a failing test rather than a menu that
    // quietly disagrees with the card.
    for (const row of rows) expect(named.get(row.id)).toBe(row.label);
  });

  it('has no duplicate ids', () => {
    expect(new Set(KNOWN_ROWS.map((row) => row.id)).size).toBe(KNOWN_ROWS.length);
  });
});

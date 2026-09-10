import { describe, expect, it } from 'vitest';

import {
  IGNORED_KEYS,
  EXTRA_USAGE_ID,
  CODEX_CREDITS_ID,
  claudeLimitKey,
  extraUsageBucket,
  formatResetsIn,
  humanize,
  isFableRow,
  mergeBuckets,
  monthEndIso,
  parseChatGptUsage,
  parseClaudeLimits,
  parseClaudeUsage,
  parseCodexCredits,
  parseExtraUsage,
  withDerivedFableRow,
  type Bucket,
  type IgnoredWindow
} from '../src/core/buckets.js';
import { pctForFace } from '../src/core/usage.js';

import claudeUsage from './fixtures/claude-oauth-usage.json';
import claudeUsageFraction from './fixtures/claude-oauth-usage-fraction.json';
import claudeUsageUnknownKey from './fixtures/claude-oauth-usage-unknown-key.json';
import claudeMalformed from './fixtures/claude-usage-malformed.json';
import codexUsage from './fixtures/codex-wham-usage.json';
import chatgptUnknown from './fixtures/chatgpt-unknown-shape.json';
import claudeWebUsageAmber from './fixtures/claude-web-usage-amber.json';
import claudeWebUsageLimits from './fixtures/claude-web-usage-limits.json';
import claudeExtraUsage from './fixtures/claude-web-extra-usage.json';
import claudeExtraUsageOff from './fixtures/claude-web-extra-usage-off.json';
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

  it('keeps a seven_day_<model> key it has never seen, humanised at its priority', () => {
    // `seven_day_haiku` falls to the generic priority 5; `seven_day_fable_5`
    // still gets Fable's priority 1, via `claudePriority`'s substring check —
    // matching the pattern only decides whether the key is shown at all.
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
    // Two windows plus the credits row the same payload carries.
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
    // `rate_limit_reset_credits`, `model_usage` and `spend_control` are not
    // usage windows, however usage-shaped their field names look. `credits`
    // IS read, but only by its own explicit parser and into its own
    // `kind: 'credits'` row — never mined as a window.
    expect(ids).toEqual([
      'chatgpt.codex_primary',
      'chatgpt.codex_secondary',
      'chatgpt.codex_credits'
    ]);
    for (const id of ids) {
      expect(id).not.toMatch(/model_usage|spend|reset_credits/);
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

  it('formats hours and minutes', () => {
    expect(formatResetsIn('2026-09-08T14:14:00Z', now)).toBe('resets in 2h 14m');
  });

  it('formats days and hours', () => {
    expect(formatResetsIn('2026-09-11T16:00:00Z', now)).toBe('resets in 3d 4h');
  });

  it('formats minutes only', () => {
    expect(formatResetsIn('2026-09-08T12:05:00Z', now)).toBe('resets in 5m');
  });

  it('rounds a sub-minute remainder up to 1m rather than showing 0m', () => {
    expect(formatResetsIn('2026-09-08T12:00:30Z', now)).toBe('resets in 1m');
  });

  it('reports a past or exactly-due reset as pending', () => {
    expect(formatResetsIn('2026-09-08T11:59:00Z', now)).toBe('reset pending');
    expect(formatResetsIn('2026-09-08T12:00:00Z', now)).toBe('reset pending');
  });

  it('returns an empty string for null or unparseable input', () => {
    expect(formatResetsIn(null, now)).toBe('');
    expect(formatResetsIn('not a date', now)).toBe('');
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
      // Priority 5, alongside the unmapped weekly window; `chatgpt.` sorts
      // before `claude.` at an equal priority.
      'chatgpt.codex_credits',
      'claude.seven_day_haiku'
    ]);
  });

  it('handles empty and missing lists', () => {
    expect(mergeBuckets()).toEqual([]);
    expect(mergeBuckets([], [])).toEqual([]);
  });
});

/* ------------------------------------------------------------- Stage II */

describe('claudeLimitKey', () => {
  it('reduces a model identifier to its family, prefixed as a weekly window', () => {
    expect(claudeLimitKey('fable-5')).toBe('seven_day_fable');
    expect(claudeLimitKey('Fable 5')).toBe('seven_day_fable');
    expect(claudeLimitKey('claude-opus-4-5')).toBe('seven_day_opus');
    // Version digits front and back: this is one row, not a new one per release.
    expect(claudeLimitKey('claude-3-5-sonnet-20241022')).toBe('seven_day_sonnet');
  });

  it('passes a name that is already a window key straight through', () => {
    expect(claudeLimitKey('seven_day_opus')).toBe('seven_day_opus');
    expect(claudeLimitKey('five_hour')).toBe('five_hour');
  });

  it('refuses a name with nothing left after normalisation', () => {
    expect(claudeLimitKey('4.5')).toBeNull();
    expect(claudeLimitKey('—')).toBeNull();
    expect(claudeLimitKey('')).toBeNull();
    expect(claudeLimitKey('claude')).toBeNull();
  });
});

describe('parseClaudeLimits (PLACEHOLDER SHAPE)', () => {
  it('reads the per-model weekly rows out of the limits array', () => {
    const m = byId(parseClaudeLimits(claudeWebUsageLimits));
    expect([...m.keys()].sort()).toEqual([
      'claude.seven_day_fable',
      'claude.seven_day_opus',
      'claude.seven_day_sonnet'
    ]);
    expect(m.get('claude.seven_day_fable')).toMatchObject({
      label: '7-day Fable',
      priority: 1,
      pct: 78,
      resetsAt: '2026-09-14T09:00:00Z',
      kind: 'window'
    });
    // Never flagged derived: this one was reported, not invented.
    expect(m.get('claude.seven_day_fable')?.derived).toBeUndefined();
  });

  it('finds the array under any limit-ish container name', () => {
    const buckets = parseClaudeLimits({
      model_limits: [{ model: 'fable', utilization: 30 }]
    });
    expect(buckets.map((b) => b.key)).toEqual(['seven_day_fable']);
  });

  it('reads the utilization by field-name regex, not by one spelling', () => {
    for (const field of ['utilization', 'utilisation', 'used_percent', 'usage_percent']) {
      const buckets = parseClaudeLimits({ limits: [{ model: 'fable', [field]: 44 }] });
      expect(buckets[0]?.pct, field).toBe(44);
    }
  });

  it('reads the model name by field-name regex, preferring `model`', () => {
    expect(parseClaudeLimits({ limits: [{ name: 'fable', utilization: 1 }] })[0]?.key).toBe(
      'seven_day_fable'
    );
    expect(
      parseClaudeLimits({ limits: [{ name: 'Opus', model: 'fable', utilization: 1 }] })[0]?.key
    ).toBe('seven_day_fable');
  });

  it('reports an entry it cannot key, and adds no row for it', () => {
    const seen: IgnoredWindow[] = [];
    const buckets = parseClaudeLimits(
      {
        limits: [
          { utilization: 10, resets_at: '2026-09-14T09:00:00Z' },
          { model: '4.5', utilization: 20 },
          { model: 'amber_ladder', utilization: 0 }
        ]
      },
      { onIgnored: (w) => seen.push(w) }
    );
    expect(buckets).toEqual([]);
    // The third is the interesting one: `KNOWN_PATTERNS` would allow
    // `seven_day_amber_ladder`, so prefixing a codename would smuggle it onto
    // the card. `claudeLimitKey` refuses a multi-word family that is not in
    // the map — see its comment.
    expect(seen.map((w) => w.key)).toEqual(['(unnamed limits entry)', '4.5', 'amber_ladder']);
  });

  it('refuses a codename in the limits array, however it is spelled', () => {
    expect(claudeLimitKey('amber_ladder')).toBeNull();
    expect(claudeLimitKey('Nimbus Quill')).toBeNull();
    // …while every real model family still keys cleanly.
    expect(claudeLimitKey('haiku')).toBe('seven_day_haiku');
  });

  it('adds no derived mirror of its own', () => {
    // Half a document; the mirror is a decision about the whole one.
    const buckets = parseClaudeLimits({ limits: [{ model: 'opus', utilization: 5 }] });
    expect(buckets.some(isFableRow)).toBe(false);
  });

  it('returns nothing for a payload with no limits array', () => {
    expect(parseClaudeLimits(claudeUsage)).toEqual([]);
    expect(parseClaudeLimits(null)).toEqual([]);
    expect(parseClaudeLimits({ limits: 'not an array' })).toEqual([]);
  });
});

describe('parseClaudeUsage merging limits[]', () => {
  it('merges the per-model rows into the same result, from the same payload', () => {
    const m = byId(parseClaudeUsage(claudeWebUsageLimits));
    expect([...m.keys()].sort()).toEqual([
      'claude.five_hour',
      'claude.seven_day',
      'claude.seven_day_fable',
      'claude.seven_day_opus',
      'claude.seven_day_sonnet'
    ]);
  });

  it('lets a real Fable row suppress the derived mirror', () => {
    const fable = byId(parseClaudeUsage(claudeWebUsageLimits)).get('claude.seven_day_fable');
    expect(fable?.derived).toBeUndefined();
    // The bug this whole stage exists to fix: 78 is Fable's own number, not
    // the weekly pool's 62.
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
    const buckets = parseClaudeUsage({
      seven_day_opus: { utilization: 11, resets_at: '2026-09-14T09:00:00Z' },
      limits: [{ model: 'claude-opus-4-5', utilization: 99 }]
    });
    expect(buckets.filter((b) => b.key === 'seven_day_opus')).toHaveLength(1);
    expect(buckets.find((b) => b.key === 'seven_day_opus')?.pct).toBe(11);
  });

  it('applies one scale decision across both halves of the payload', () => {
    const buckets = parseClaudeUsage(
      {
        five_hour: { utilization: 0.5, resets_at: '2026-09-10T18:00:00Z' },
        limits: [{ model: 'fable', utilization: 0.25 }]
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

describe('parseExtraUsage (PLACEHOLDER SHAPE)', () => {
  it('reads the supplement payload', () => {
    expect(parseExtraUsage(claudeExtraUsage)).toEqual({
      spent: 123,
      limit: 500,
      currency: 'DKK'
    });
  });

  it('reads a nested extra_usage container in the usage payload', () => {
    expect(
      parseExtraUsage({
        five_hour: { utilization: 10 },
        extra_usage: { spent: 4.5, limit: 20, currency: 'usd', enabled: true }
      })
    ).toEqual({ spent: 4.5, limit: 20, currency: 'USD' });
  });

  it('is null when extra usage is switched off — no row, never a 0% one', () => {
    expect(parseExtraUsage(claudeExtraUsageOff)).toBeNull();
    expect(parseExtraUsage({ extra_usage: { spend: 0, limit: 500, enabled: false } })).toBeNull();
  });

  it('is null when the payload does not mention it, or mentions it without amounts', () => {
    expect(parseExtraUsage(claudeUsage)).toBeNull();
    expect(parseExtraUsage(claudeWebUsageLimits)).toBeNull();
    expect(parseExtraUsage({ extra_usage: { enabled: true } })).toBeNull();
    // A cap with no spend cannot be drawn, and a spend with no cap has no
    // percentage to bar or bark about.
    expect(parseExtraUsage({ extra_usage: { limit: 500, currency: 'DKK' } })).toBeNull();
    expect(parseExtraUsage({ extra_usage: { spend: 12, currency: 'DKK' } })).toBeNull();
    expect(parseExtraUsage(null)).toBeNull();
  });

  it('rejects amounts that would make the bar nonsense', () => {
    expect(parseExtraUsage({ extra_usage: { spend: 12, limit: 0 } })).toBeNull();
    expect(parseExtraUsage({ extra_usage: { spend: -1, limit: 500 } })).toBeNull();
    expect(parseExtraUsage({ extra_usage: { spend: 'lots', limit: 500 } })).toBeNull();
  });

  it('converts minor units by field name, and never by magnitude', () => {
    expect(parseExtraUsage({ extra_usage: { spend_cents: 12300, limit_cents: 50000 } })).toEqual({
      spent: 123,
      limit: 500,
      currency: 'USD'
    });
    // 12 300 kr. against a 50 000 kr. cap is a perfectly plausible Team plan;
    // "the number is big" must never be read as "these are cents".
    expect(parseExtraUsage({ extra_usage: { spend: 12300, limit: 50000 } })).toEqual({
      spent: 12300,
      limit: 50000,
      currency: 'USD'
    });
  });

  it('defaults the currency when none is named, and ignores a junk one', () => {
    expect(parseExtraUsage({ extra_usage: { spend: 1, limit: 2 } })?.currency).toBe('USD');
    expect(
      parseExtraUsage({ extra_usage: { spend: 1, limit: 2, currency: 'kroner' } })?.currency
    ).toBe('USD');
  });
});

describe('extraUsageBucket', () => {
  const now = new Date('2026-09-10T12:00:00Z');

  it('turns money into a percentage the rest of the app already understands', () => {
    const bucket = extraUsageBucket({ spent: 123, limit: 500, currency: 'DKK' }, now);
    expect(bucket).toMatchObject({
      id: EXTRA_USAGE_ID,
      service: 'claude',
      key: 'extra_usage',
      label: 'Extra usage',
      pct: 24.6,
      priority: 6,
      kind: 'money',
      money: { spent: 123, limit: 500, currency: 'DKK' }
    });
  });

  it('resets at the end of the month', () => {
    expect(extraUsageBucket({ spent: 1, limit: 2, currency: 'USD' }, now).resetsAt).toBe(
      '2026-10-01T00:00:00.000Z'
    );
    expect(monthEndIso(new Date('2026-12-31T23:00:00Z'))).toBe('2027-01-01T00:00:00.000Z');
  });

  it('is not a face row: the dog still follows the 5-hour window', () => {
    const overspent = extraUsageBucket({ spent: 500, limit: 500, currency: 'DKK' }, now);
    expect(overspent.pct).toBe(100);
    expect(pctForFace([overspent])).toBeNull();
    expect(pctForFace([...parseClaudeUsage(claudeUsage), overspent])).toBe(42.5);
  });
});

/* ---------------------------------------------------------- Stage III-b */

describe('parseCodexCredits', () => {
  it('reads the credit pool the owner\'s own account reports', () => {
    const bucket = parseCodexCredits(codexUsage);
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
      credits: { balance: null, unlimited: false, exhausted: false }
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
    expect(parseChatGptUsage(codexUsageNoCredits, new Date('2026-09-08T12:00:00Z'))).toHaveLength(2);
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
    // An unknown balance is not evidence of an empty one.
    expect(of({ balance: null })).toBe(false);
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
    expect(parseCodexCredits(codexUsage)?.pct).toBeNull();
    expect(pctForFace([parseCodexCredits(codexUsage) as Bucket])).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import {
  formatResetsIn,
  humanize,
  mergeBuckets,
  parseChatGptUsage,
  parseClaudeUsage,
  type Bucket
} from '../src/core/buckets.js';

import claudeUsage from './fixtures/claude-oauth-usage.json';
import claudeUsageFraction from './fixtures/claude-oauth-usage-fraction.json';
import claudeUsageUnknownKey from './fixtures/claude-oauth-usage-unknown-key.json';
import claudeMalformed from './fixtures/claude-usage-malformed.json';
import codexUsage from './fixtures/codex-wham-usage.json';
import chatgptUnknown from './fixtures/chatgpt-unknown-shape.json';

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
    expect(buckets).toHaveLength(3);

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

describe('parseChatGptUsage', () => {
  const now = new Date('2026-09-08T12:00:00Z');

  it('parses the real wham/usage rate_limit payload', () => {
    const buckets = parseChatGptUsage(codexUsage, now);
    expect(buckets).toHaveLength(2);

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
    // credits / rate_limit_reset_credits / model_usage / spend_control are not
    // usage windows, however usage-shaped their field names look.
    expect(ids).toEqual(['chatgpt.codex_primary', 'chatgpt.codex_secondary']);
    for (const id of ids) {
      expect(id).not.toMatch(/credit|model_usage|spend/);
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
      'claude.seven_day_haiku'
    ]);
  });

  it('handles empty and missing lists', () => {
    expect(mergeBuckets()).toEqual([]);
    expect(mergeBuckets([], [])).toEqual([]);
  });
});

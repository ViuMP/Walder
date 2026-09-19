/**
 * The usage snapshot: what the dog's face is chosen from, what the panel draws,
 * and what is safe to write to disk.
 *
 * Three things here would be felt by the owner if they were wrong:
 *
 *  - **`pctForFace`** decides the expression. A dog that looks cheerful while
 *    the allowance is gone is worse than no dog.
 *  - **`trimSnapshot` / `restoreSnapshot`** decide what lands in a plain JSON
 *    file in the user's library folder. The raw provider payload must never get
 *    there, and a hand-mangled file must cost a stale face, not a crash.
 *  - **`barFill`** must match the design's own numbers, or the card the owner
 *    approved is not the card that ships.
 */
import { describe, expect, it } from 'vitest';
import type { Bucket } from '../src/core/buckets';
import {
  BAR_SEGMENTS,
  barFill,
  expressionForBuckets,
  formatCreditsValue,
  formatMoneyValue,
  isCreditPrice,
  formatTokensValue,
  formatPct,
  forIpc,
  isWindowKind,
  formatRefreshedAgo,
  injectedSnapshot,
  isStale,
  pctForFace,
  restoreSnapshot,
  trimSnapshot,
  visibleBuckets,
  type ServiceReport,
  type UsageSnapshot
} from '../src/core/usage';
import { pickAnimation } from '../src/core/expression';

const NOW = Date.parse('2026-09-08T15:00:00Z');
const INTERVAL = 180_000;

function bucket(patch: Partial<Bucket> = {}): Bucket {
  return {
    id: 'claude.five_hour',
    service: 'claude',
    key: 'five_hour',
    label: '5-hour',
    pct: 42.5,
    resetsAt: '2026-09-08T18:00:00Z',
    priority: 0,
    ...patch
  };
}

function report(patch: Partial<ServiceReport> = {}): ServiceReport {
  return {
    buckets: [],
    status: 'unavailable',
    via: 'none',
    viaLabel: 'no source',
    ...patch
  };
}

function snapshot(patch: Partial<UsageSnapshot> = {}): UsageSnapshot {
  const buckets = patch.buckets ?? [bucket()];
  return {
    fetchedAt: new Date(NOW).toISOString(),
    buckets,
    services: {
      claude: report({ status: 'ok', via: 'claude-oauth', viaLabel: 'Claude Code login', buckets }),
      chatgpt: report({ status: 'auth-needed', message: 'logged out', via: 'chatgpt-web', viaLabel: 'chatgpt.com login' })
    },
    expression: expressionForBuckets(buckets),
    intervalMs: INTERVAL,
    ...patch
  };
}

describe('pctForFace', () => {
  it('prefers Claude\'s 5-hour window', () => {
    // The allowance that actually runs out mid-afternoon, and the one the
    // expression thresholds were chosen for.
    const buckets = [
      bucket({ id: 'claude.seven_day', key: 'seven_day', pct: 99 }),
      bucket({ pct: 30 })
    ];
    expect(pctForFace(buckets)).toBe(30);
  });

  /**
   * The face means one specific thing, and must never quietly mean another.
   *
   * There used to be a fallback to the highest percentage of any bucket, so
   * that a ChatGPT-only setup did not show a permanently confused dog. The cost
   * was that the dog's expression — the whole product, and the only part
   * visible without hovering — silently started describing a different
   * allowance on a different clock and a different scale, with nothing on
   * screen to say so. An exhausted dog because Codex's weekly quota is at 91 %,
   * while Claude's 5-hour window sits at 12 %, is not a degraded reading but a
   * wrong one.
   */
  it('never uses a Codex or ChatGPT percentage', () => {
    const buckets = [
      bucket({ id: 'chatgpt.codex_primary', service: 'chatgpt', key: 'codex_primary', pct: 37 }),
      bucket({ id: 'chatgpt.codex_secondary', service: 'chatgpt', key: 'codex_secondary', pct: 88 })
    ];
    expect(pctForFace(buckets)).toBeNull();
    expect(expressionForBuckets(buckets)).toBe('confused');
  });

  it('never falls back to another Claude window either', () => {
    // A 7-day allowance at 85 % on a Tuesday is fine; the thresholds were
    // chosen for the 5-hour window and mean nothing applied to this one.
    const buckets = [bucket({ id: 'claude.seven_day', key: 'seven_day', pct: 85 })];
    expect(pctForFace(buckets)).toBeNull();
    expect(expressionForBuckets(buckets)).toBe('confused');
  });

  it('is null when the five-hour bucket is there but has no number', () => {
    const buckets = [bucket({ pct: null }), bucket({ id: 'claude.seven_day', key: 'seven_day', pct: 61 })];
    expect(pctForFace(buckets)).toBeNull();
    expect(expressionForBuckets(buckets)).toBe('confused');
  });

  it('is null with no buckets at all, which shows the confused face', () => {
    // An honest "I don't know" beats a confident 0 %.
    expect(pctForFace([])).toBeNull();
    expect(expressionForBuckets([])).toBe('confused');
  });

  it('is null when every bucket is unknown', () => {
    expect(pctForFace([bucket({ pct: null }), bucket({ id: 'b', pct: null })])).toBeNull();
  });

  it('reads the five-hour window whatever else is present', () => {
    const buckets = [
      bucket({ id: 'chatgpt.codex_primary', service: 'chatgpt', key: 'codex_primary', pct: 99 }),
      bucket({ id: 'claude.seven_day', key: 'seven_day', pct: 99 }),
      bucket({ pct: 12 })
    ];
    expect(pctForFace(buckets)).toBe(12);
    expect(expressionForBuckets(buckets)).toBe('happy');
  });
});

describe('pickAnimation', () => {
  const has = (...names: string[]) => (name: string) => names.includes(name);

  it('plays the sleep loop for the sleep box', () => {
    expect(pickAnimation('sleep', 'happy', has('idle', 'sleep'))).toBe('sleep');
  });

  it('prefers a per-expression idle loop when the art has one', () => {
    expect(pickAnimation('stand', 'worried', has('idle', 'idle_worried'))).toBe('idle_worried');
  });

  it('falls back to plain idle when it does not', () => {
    // Art that ships one idle loop and art that ships five must both work.
    expect(pickAnimation('stand', 'worried', has('idle'))).toBe('idle');
  });

  it('uses a whole-body out/confused animation when present', () => {
    // Those two are states ("no allowance left", "no idea"), not just faces.
    expect(pickAnimation('stand', 'out', has('idle', 'out'))).toBe('out');
    expect(pickAnimation('stand', 'confused', has('idle', 'confused'))).toBe('confused');
  });

  it('still prefers idle_out over out', () => {
    expect(pickAnimation('stand', 'out', has('idle', 'idle_out', 'out'))).toBe('idle_out');
  });

  it('does not use a bare animation named after any other expression', () => {
    // `happy` alone is a face, not a state; only out/confused get this treatment.
    expect(pickAnimation('stand', 'happy', has('idle', 'happy'))).toBe('idle');
  });

  it('falls back to idle even for a sleep box with no sleep loop', () => {
    expect(pickAnimation('sleep', 'happy', has('idle'))).toBe('idle');
  });
});

describe('barFill', () => {
  it('matches the segment counts in the design file', () => {
    // design/HoverPanel.dc.html draws these exact bars; if this drifts, the card
    // the owner approved is not the card that ships.
    expect(barFill(82).filled).toBe(16);
    expect(barFill(61).filled).toBe(12);
    expect(barFill(24).filled).toBe(5);
    expect(barFill(37).filled).toBe(7);
    expect(barFill(12).filled).toBe(2);
  });

  it('bands the colours as the design caption says', () => {
    expect(barFill(0).tone).toBe('low');
    expect(barFill(49.9).tone).toBe('low');
    expect(barFill(50).tone).toBe('mid');
    expect(barFill(80).tone).toBe('mid');
    expect(barFill(80.1).tone).toBe('high');
    expect(barFill(100).tone).toBe('high');
  });

  it('shows an empty grey bar for an unknown percentage', () => {
    expect(barFill(null)).toEqual({ filled: 0, tone: 'unknown' });
    expect(barFill(Number.NaN)).toEqual({ filled: 0, tone: 'unknown' });
  });

  it('draws 0 % as genuinely empty and 100 % as full', () => {
    expect(barFill(0).filled).toBe(0);
    expect(barFill(100).filled).toBe(BAR_SEGMENTS);
  });

  it('clamps out-of-range values instead of overflowing the bar', () => {
    expect(barFill(140).filled).toBe(BAR_SEGMENTS);
    expect(barFill(-20).filled).toBe(0);
  });
});

describe('formatPct', () => {
  it('prints a whole percentage', () => {
    expect(formatPct(42.5)).toBe('43%');
    expect(formatPct(0)).toBe('0%');
  });

  it('prints ? for unknown, never 0 %', () => {
    // "0 %" reads as "plenty left"; the truth is "we could not find out".
    expect(formatPct(null)).toBe('?');
    expect(formatPct(Number.NaN)).toBe('?');
  });
});

describe('isStale', () => {
  it('is fresh inside two poll intervals', () => {
    const at = new Date(NOW - INTERVAL).toISOString();
    expect(isStale(at, NOW, INTERVAL)).toBe(false);
  });

  it('is stale past two intervals', () => {
    // One missed poll is normal (a sleeping laptop, a backoff); two means the
    // numbers on screen no longer describe now.
    const at = new Date(NOW - 2 * INTERVAL - 1).toISOString();
    expect(isStale(at, NOW, INTERVAL)).toBe(true);
  });

  it('treats an unreadable timestamp as stale', () => {
    expect(isStale('whenever', NOW, INTERVAL)).toBe(true);
  });
});

describe('formatRefreshedAgo', () => {
  it('reads naturally at each scale', () => {
    expect(formatRefreshedAgo(new Date(NOW - 5_000).toISOString(), NOW)).toBe('refreshed just now');
    expect(formatRefreshedAgo(new Date(NOW - 65_000).toISOString(), NOW)).toBe('refreshed 1 min ago');
    expect(formatRefreshedAgo(new Date(NOW - 8 * 60_000).toISOString(), NOW)).toBe(
      'refreshed 8 min ago'
    );
    expect(formatRefreshedAgo(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe(
      'refreshed 3 hours ago'
    );
  });

  it('does not go negative for a clock that jumped backwards', () => {
    expect(formatRefreshedAgo(new Date(NOW + 60_000).toISOString(), NOW)).toBe('refreshed just now');
  });

  it('says so when there is no usable timestamp', () => {
    expect(formatRefreshedAgo('nonsense', NOW)).toBe('never refreshed');
  });
});

describe('an estimated reset survives being persisted', () => {
  /*
   * `resetsEstimated` is what licenses the Extra usage row to show a reset at
   * all — the date is Walder's arithmetic and the card says `(est.)` because of
   * this flag. Drop it on the way through the settings file and the *restored*
   * snapshot shows the same invented date in the provider's voice, for the three
   * minutes between launch and the first poll. That is precisely the lie the
   * flag exists to prevent, and it would appear only at launch, which is the
   * hardest place to notice it.
   */
  const estimated: Bucket = {
    id: 'claude.extra_usage',
    service: 'claude',
    key: 'extra_usage',
    label: 'Extra usage',
    pct: 19.2,
    resetsAt: '2026-10-01T00:00:00.000Z',
    resetsEstimated: true,
    priority: 6,
    kind: 'money',
    money: { spent: 9.62, limit: 50, currency: 'EUR' }
  };

  it('round-trips through trim and restore', () => {
    const trimmed = trimSnapshot(snapshot({ buckets: [estimated] }));
    const back = restoreSnapshot(JSON.parse(JSON.stringify(trimmed)), INTERVAL);
    const row = back?.buckets.find((b) => b.id === 'claude.extra_usage');
    expect(row?.resetsAt).toBe('2026-10-01T00:00:00.000Z');
    expect(row?.resetsEstimated).toBe(true);
  });

  it('is not conjured up by a hand-edited settings file', () => {
    // The file is plain JSON in the user's library folder, so the restore side
    // reads a literal `true` and nothing else — a truthy string must not be able
    // to stamp `(est.)` onto a row whose date really did come from a provider.
    const ordinary = { ...estimated, resetsEstimated: undefined };
    const trimmed = trimSnapshot(snapshot({ buckets: [ordinary as Bucket] }));
    const raw = JSON.parse(JSON.stringify(trimmed)) as { buckets: Record<string, unknown>[] };
    expect(raw.buckets[0]).not.toHaveProperty('resetsEstimated');
    (raw.buckets[0] as Record<string, unknown>)['resetsEstimated'] = 'yes';
    expect(restoreSnapshot(raw, INTERVAL)?.buckets[0]?.resetsEstimated).toBeUndefined();
  });
});

describe('trimSnapshot', () => {
  it('drops the provider\'s raw payload', () => {
    // The settings file is plain, unencrypted JSON in the user's library folder,
    // and `raw` is whatever the provider returned — on the ChatGPT session route
    // that can include account metadata.
    const withRaw = snapshot({
      buckets: [bucket({ raw: { account_id: 'acct-1', email: 'someone@example.com' } })]
    });
    const trimmed = trimSnapshot(withRaw);
    expect(JSON.stringify(trimmed)).not.toContain('example.com');
    expect(trimmed.buckets[0]).not.toHaveProperty('raw');
  });

  it('keeps exactly what the panel draws', () => {
    const trimmed = trimSnapshot(snapshot());
    expect(trimmed.buckets[0]).toEqual({
      id: 'claude.five_hour',
      service: 'claude',
      key: 'five_hour',
      label: '5-hour',
      pct: 42.5,
      resetsAt: '2026-09-08T18:00:00Z',
      priority: 0
    });
    expect(trimmed.services.claude).toEqual({
      status: 'ok',
      via: 'claude-oauth',
      viaLabel: 'Claude Code login'
    });
    expect(trimmed.services.chatgpt.message).toBe('logged out');
  });

  it('does not duplicate the per-service bucket lists', () => {
    // They are rebuilt by filtering the merged list on restore, so they cannot
    // drift from it.
    expect(trimSnapshot(snapshot()).services.claude).not.toHaveProperty('buckets');
  });
});

describe('forIpc', () => {
  it('drops the provider\'s raw payload before it crosses IPC', () => {
    // Same reason as the settings file, different destination: `raw` is
    // unvalidated remote JSON that on the ChatGPT session route can carry
    // account metadata, and neither renderer reads it.
    const withRaw = snapshot({
      buckets: [bucket({ raw: { account_id: 'acct-1', email: 'someone@example.com' } })]
    });
    const payload = forIpc(withRaw);

    expect(JSON.stringify(payload)).not.toContain('example.com');
    expect(payload.buckets[0]).not.toHaveProperty('raw');
    expect(payload.services.claude.buckets[0]).not.toHaveProperty('raw');
  });

  it('keeps everything the renderers actually draw', () => {
    const original = snapshot();
    const payload = forIpc(original);

    expect(payload.fetchedAt).toBe(original.fetchedAt);
    expect(payload.intervalMs).toBe(original.intervalMs);
    // Carried over, not recomputed: the dog's face and the panel's numbers must
    // describe the same poll.
    expect(payload.expression).toBe(original.expression);
    expect(payload.buckets.map((b) => b.id)).toEqual(original.buckets.map((b) => b.id));
    expect(payload.buckets[0]?.pct).toBe(original.buckets[0]?.pct);
    expect(payload.buckets[0]?.resetsAt).toBe(original.buckets[0]?.resetsAt);
    expect(payload.services.chatgpt.status).toBe(original.services.chatgpt.status);
    expect(payload.services.chatgpt.message).toBe(original.services.chatgpt.message);
    expect(payload.services.claude.viaLabel).toBe(original.services.claude.viaLabel);
  });

  it('rebuilds each service\'s list by filtering the merged one', () => {
    const payload = forIpc(
      snapshot({
        buckets: [
          bucket({ id: 'claude.five_hour', service: 'claude' }),
          bucket({ id: 'chatgpt.primary', service: 'chatgpt' })
        ]
      })
    );
    expect(payload.services.claude.buckets.map((b) => b.id)).toEqual(['claude.five_hour']);
    expect(payload.services.chatgpt.buckets.map((b) => b.id)).toEqual(['chatgpt.primary']);
  });

  it('does not mutate the snapshot main keeps', () => {
    const original = snapshot({ buckets: [bucket({ raw: { keep: true } })] });
    forIpc(original);
    expect(original.buckets[0]).toHaveProperty('raw');
  });
});

describe('restoreSnapshot', () => {
  it('round-trips a trimmed snapshot', () => {
    const original = snapshot();
    const restored = restoreSnapshot(trimSnapshot(original), INTERVAL);
    expect(restored?.fetchedAt).toBe(original.fetchedAt);
    expect(restored?.buckets).toEqual(original.buckets.map((b) => ({ ...b })));
    expect(restored?.expression).toBe(original.expression);
    expect(restored?.services.claude.status).toBe('ok');
    expect(restored?.services.claude.viaLabel).toBe('Claude Code login');
  });

  it('rebuilds each service\'s buckets by filtering the merged list', () => {
    const buckets = [
      bucket(),
      bucket({ id: 'chatgpt.codex_primary', service: 'chatgpt', key: 'codex_primary', label: 'Codex 5-hour', pct: 37 })
    ];
    const restored = restoreSnapshot(trimSnapshot(snapshot({ buckets })), INTERVAL);
    expect(restored?.services.claude.buckets.map((b) => b.id)).toEqual(['claude.five_hour']);
    expect(restored?.services.chatgpt.buckets.map((b) => b.id)).toEqual(['chatgpt.codex_primary']);
  });

  it('recomputes the expression rather than trusting the stored one', () => {
    const stored = { ...trimSnapshot(snapshot({ buckets: [bucket({ pct: 99 })] })) };
    expect(restoreSnapshot(stored, INTERVAL)?.expression).toBe('exhausted');
  });

  it('is null for anything with no usable timestamp', () => {
    // The file is user-writable; a mangled entry must cost a stale face, never a
    // crash on launch.
    expect(restoreSnapshot(null, INTERVAL)).toBeNull();
    expect(restoreSnapshot({}, INTERVAL)).toBeNull();
    expect(restoreSnapshot({ fetchedAt: 'whenever' }, INTERVAL)).toBeNull();
    expect(restoreSnapshot('a string', INTERVAL)).toBeNull();
  });

  it('drops individual malformed buckets and keeps the rest', () => {
    const restored = restoreSnapshot(
      {
        fetchedAt: new Date(NOW).toISOString(),
        buckets: [
          null,
          { id: 'ok.one', service: 'claude', key: 'five_hour', label: '5-hour', pct: 10 },
          { id: 'no-service', key: 'x', label: 'x' },
          { service: 'claude', key: 'x', label: 'x' }
        ]
      },
      INTERVAL
    );
    expect(restored?.buckets.map((b) => b.id)).toEqual(['ok.one']);
  });

  it('normalises a bucket\'s missing fields rather than rejecting it', () => {
    const restored = restoreSnapshot(
      {
        fetchedAt: new Date(NOW).toISOString(),
        buckets: [{ id: 'a', service: 'claude', key: 'five_hour', label: '5-hour' }]
      },
      INTERVAL
    );
    expect(restored?.buckets[0]).toMatchObject({ pct: null, resetsAt: null });
  });

  it('falls back for a missing or nonsense service entry', () => {
    const restored = restoreSnapshot(
      { fetchedAt: new Date(NOW).toISOString(), services: { claude: { status: 'nonsense' } } },
      INTERVAL
    );
    expect(restored?.services.claude.status).toBe('unavailable');
    expect(restored?.services.chatgpt.status).toBe('unavailable');
  });

  it('falls back to the caller\'s interval when none was stored', () => {
    const restored = restoreSnapshot({ fetchedAt: new Date(NOW).toISOString() }, 600_000);
    expect(restored?.intervalMs).toBe(600_000);
  });
});

/**
 * `Developer ▸ Inject usage`.
 *
 * The point of shaping this as a real Claude five-hour bucket, rather than
 * setting `expression` directly, is that the injected snapshot then travels the
 * *same* path as a real poll: the face, the hover card, the tray status line and
 * the bark thresholds all derive from it exactly as they would from Anthropic's
 * answer. A test hatch that bypasses the machinery it is meant to exercise
 * proves nothing.
 */
describe('injectedSnapshot', () => {
  it('looks exactly like a real Claude five-hour reading', () => {
    const snap = injectedSnapshot(82, NOW, INTERVAL);
    expect(snap.buckets).toHaveLength(1);
    expect(snap.buckets[0]).toMatchObject({
      id: 'claude.five_hour',
      service: 'claude',
      key: 'five_hour',
      label: '5-hour',
      pct: 82,
      priority: 0
    });
    expect(snap.services.claude.status).toBe('ok');
    expect(snap.intervalMs).toBe(INTERVAL);
    expect(snap.fetchedAt).toBe(new Date(NOW).toISOString());
  });

  it('drives the face through the same rule as a real poll', () => {
    expect(injectedSnapshot(45, NOW, INTERVAL).expression).toBe('happy');
    expect(injectedSnapshot(82, NOW, INTERVAL).expression).toBe('worried');
    expect(injectedSnapshot(91, NOW, INTERVAL).expression).toBe('worried');
    expect(injectedSnapshot(100, NOW, INTERVAL).expression).toBe('out');
  });

  it('is the confused, not the cheerful, face for "no data"', () => {
    const snap = injectedSnapshot(null, NOW, INTERVAL);
    expect(snap.buckets).toEqual([]);
    expect(snap.expression).toBe('confused');
    // An `ok` source that reported no windows — which is the honest shape of
    // "we reached it and it told us nothing".
    expect(snap.services.claude.status).toBe('ok');
  });

  it('survives the trim that every published snapshot goes through', () => {
    expect(forIpc(injectedSnapshot(91, NOW, INTERVAL)).buckets[0]?.pct).toBe(91);
  });
});

/* ------------------------------------------- money and credits value rows */

describe('formatMoneyValue', () => {
  const money = { spent: 9.62, limit: 50, currency: 'DKK' };
  // A fixed locale, or this asserts the machine it ran on rather than the
  // formatter. ICU puts a non-breaking space between number and symbol, so
  // every comparison here is NBSP-tolerant.
  const norm = (s: string): string => s.replace(/[\u00a0\u202f]/g, ' ');

  it('prints the amounts first and the percentage second', () => {
    expect(norm(formatMoneyValue(money, 19.2, 'da-DK'))).toBe('9,62 kr. / 50,00 kr.  (19%)');
  });

  it('puts the symbol on BOTH halves, in the locale\'s own place', () => {
    /*
     * It used to be on the cap alone — `9.62 / $50.00` — on the grounds that
     * that is how a price range reads. The owner reported it as a missing
     * symbol (2026-09-11), and he is right for this card: a row is read on its
     * own, at a glance, beside rows that are all percentages, and the number
     * the eye lands on first is the spend. A price range is read left to right
     * as one quantity; this is two facts side by side.
     */
    expect(norm(formatMoneyValue({ ...money, currency: 'USD' }, 19.2, 'en-US'))).toBe(
      '$9.62 / $50.00  (19%)'
    );
    // The symbol goes wherever the locale puts it, on both halves alike.
    expect(norm(formatMoneyValue({ ...money, currency: 'EUR' }, 19.2, 'de-DE'))).toBe(
      '9,62 € / 50,00 €  (19%)'
    );
  });

  it('gives both halves the same precision, and lets the currency choose it', () => {
    /*
     * This used to print whole units for a round number ("a cap is always
     * round, and 500,00 kr. is noise"), which produced `9.62 / 50` once the
     * real amounts arrived: two precisions in one row, reading like a bug. The
     * currency decides now — two places for USD, **none** for JPY, taken from
     * `Intl`'s own resolved options rather than hardcoded.
     */
    expect(norm(formatMoneyValue({ spent: 9.62, limit: 50, currency: 'USD' }, 19.2, 'en-US'))).toBe(
      '$9.62 / $50.00  (19%)'
    );
    expect(norm(formatMoneyValue({ spent: 962, limit: 5000, currency: 'JPY' }, 19.2, 'en-US'))).toBe(
      '¥962 / ¥5,000  (19%)'
    );
  });

  it('says only how much was spent when there is no cap', () => {
    // The owner's own account: `monthly_limit: null`. No fraction, because
    // there is no denominator — and the word "spent" instead, because a bare
    // `$9.62` beside rows that are all percentages reads as an allowance.
    expect(norm(formatMoneyValue({ spent: 9.62, limit: null, currency: 'USD' }, null, 'en-US'))).toBe(
      '$9.62 spent'
    );
    // A stray percentage cannot bring the fraction back: with no cap there is
    // nothing it could be a percentage of.
    expect(norm(formatMoneyValue({ spent: 9.62, limit: null, currency: 'USD' }, 42, 'en-US'))).toBe(
      '$9.62 spent'
    );
  });

  it('drops the percentage rather than printing a fake one', () => {
    expect(norm(formatMoneyValue(money, null, 'da-DK'))).toBe('9,62 kr. / 50,00 kr.');
  });

  it('degrades to bare numbers rather than throwing on a junk currency', () => {
    // `Intl` throws on a code that is not three letters; the numbers are still
    // the useful half, so both halves print plain and neither carries a symbol.
    expect(norm(formatMoneyValue({ spent: 1, limit: 2, currency: 'XX' }, 50, 'en-US'))).toBe(
      '1.00 / 2.00  (50%)'
    );
    expect(norm(formatMoneyValue({ spent: 1, limit: null, currency: 'XX' }, null, 'en-US'))).toBe(
      '1.00 spent'
    );
  });

  /* The Codex credit cap: a spend against a cap counted in something that is
   * not money. The numbers are the owner's real ones (dev dump, 2026-09-11). */
  describe('a credit row', () => {
    const credits = { spent: 2732.6146183013916, limit: 600, currency: 'XXX', inCredits: true } as const;

    it('prints the counts and the word when no price is configured', () => {
      expect(norm(formatMoneyValue(credits, 455, 'en-US'))).toBe('2,733 / 600 credits  (455%)');
      // Explicit `null` is the owner saying "do not estimate", and reads the
      // same as never having set one.
      expect(norm(formatMoneyValue(credits, 455, 'en-US', null))).toBe(
        '2,733 / 600 credits  (455%)'
      );
    });

    it('converts at the configured price, marked as the estimate it is', () => {
      expect(
        norm(formatMoneyValue(credits, 455, 'en-US', { amount: 0.04, currency: 'USD' }))
      ).toBe('Est. $109.30 / $24.00  (455%)');
      // The whole reason the price is a setting: OpenAI publishes no EUR list
      // price and the owner is billed in EUR.
      expect(
        norm(formatMoneyValue(credits, 455, 'en-US', { amount: 0.037, currency: 'EUR' }))
      ).toBe('Est. €101.11 / €22.20  (455%)');
    });

    it('puts the symbol on BOTH halves, unlike a real money row', () => {
      // `Est. 109.30 / $24.00` would read as "109.30 credits", which is the one
      // misreading this row exists to prevent.
      const priced = norm(formatMoneyValue(credits, 455, 'en-US', { amount: 0.04, currency: 'USD' }));
      expect(priced.split(' / ')[0]).toContain('$');
    });

    it('never scales an ordinary money row, price or no price', () => {
      expect(norm(formatMoneyValue(money, 19.2, 'da-DK', { amount: 0.04, currency: 'USD' }))).toBe(
        '9,62 kr. / 50,00 kr.  (19%)'
      );
    });

    it('degrades to the word "spent" with no cap, like a money row', () => {
      const capless = { ...credits, limit: null };
      expect(norm(formatMoneyValue(capless, null, 'en-US'))).toBe('2,733 credits spent');
      expect(
        norm(formatMoneyValue(capless, null, 'en-US', { amount: 0.04, currency: 'USD' }))
      ).toBe('Est. $109.30 spent');
    });

    // Large only (P1-16, owner's real numbers, 2026-09-19): the counts the
    // list price was applied to, so `228%` is not the only number on the row.
    it('adds the raw counts ahead of the percentage when showCredits is set', () => {
      const capped = { spent: 2732.6, limit: 1200, currency: 'XXX', inCredits: true } as const;
      expect(
        norm(
          formatMoneyValue(capped, 228, 'en-GB', { amount: 0.04, currency: 'USD' }, true)
        )
      ).toBe('Est. US$109.30 / US$48.00  (2,733 / 1,200 credits · 228%)');
    });

    it('drops the percentage but keeps the counts when pct is null', () => {
      const capped = { spent: 2732.6, limit: 1200, currency: 'XXX', inCredits: true } as const;
      expect(
        norm(formatMoneyValue(capped, null, 'en-GB', { amount: 0.04, currency: 'USD' }, true))
      ).toBe('Est. US$109.30 / US$48.00  (2,733 / 1,200 credits)');
    });

    it('leaves the row unchanged when showCredits is left at its default', () => {
      const capped = { spent: 2732.6, limit: 1200, currency: 'XXX', inCredits: true } as const;
      expect(
        norm(formatMoneyValue(capped, 228, 'en-GB', { amount: 0.04, currency: 'USD' }))
      ).toBe('Est. US$109.30 / US$48.00  (228%)');
    });
  });
});

describe('isCreditPrice', () => {
  it('accepts a usable price and nothing else', () => {
    expect(isCreditPrice({ amount: 0.04, currency: 'USD' })).toBe(true);
    for (const junk of [
      null,
      undefined,
      'USD',
      {},
      // A zero price would print `Est. $0.00 / $0.00` beside a 455% bar.
      { amount: 0, currency: 'USD' },
      { amount: -1, currency: 'USD' },
      { amount: NaN, currency: 'USD' },
      { amount: '0.04', currency: 'USD' },
      // Not three letters: `Intl.NumberFormat` throws on these.
      { amount: 0.04, currency: 'US' },
      { amount: 0.04, currency: 'DOLLAR' },
      { amount: 0.04 }
    ]) {
      expect(isCreditPrice(junk), JSON.stringify(junk)).toBe(false);
    }
  });
});

describe('formatCreditsValue', () => {
  it('says how many are left, in words that cannot be read as "used"', () => {
    expect(formatCreditsValue({ balance: 1240, unlimited: false, exhausted: false }, 'en-US')).toBe(
      '1,240 left'
    );
  });

  it('says unlimited, and does not go looking for a balance', () => {
    expect(formatCreditsValue({ balance: 5, unlimited: true, exhausted: false })).toBe('unlimited');
    expect(formatCreditsValue({ balance: null, unlimited: true, exhausted: false })).toBe(
      'unlimited'
    );
  });

  it('says `?` for a pool whose size is not stated — never 0', () => {
    expect(formatCreditsValue({ balance: null, unlimited: false, exhausted: false })).toBe('?');
  });

  it('still says zero when the pool really is empty', () => {
    expect(formatCreditsValue({ balance: 0, unlimited: false, exhausted: true }, 'en-US')).toBe(
      '0 left'
    );
  });
});

describe('formatTokensValue', () => {
  it('follows the design\'s k/M thresholds, one decimal above a thousand', () => {
    expect(formatTokensValue({ total: 0 })).toBe('0 tokens');
    expect(formatTokensValue({ total: 999 })).toBe('999 tokens');
    expect(formatTokensValue({ total: 1000 })).toBe('1k tokens');
    expect(formatTokensValue({ total: 1_240_000 })).toBe('1.2M tokens');
  });

  it('says `?` for a total that cannot be a real count', () => {
    expect(formatTokensValue({ total: -1 })).toBe('?');
    expect(formatTokensValue({ total: NaN })).toBe('?');
  });
});

describe('isWindowKind', () => {
  it('treats an absent kind as a window', () => {
    expect(isWindowKind(undefined)).toBe(true);
    expect(isWindowKind('window')).toBe(true);
    expect(isWindowKind('money')).toBe(false);
    expect(isWindowKind('credits')).toBe(false);
  });
});

describe('persisting money and credits rows', () => {
  const moneyBucket = bucket({
    id: 'claude.extra_usage',
    key: 'extra_usage',
    label: 'Extra usage',
    pct: 24.6,
    priority: 6,
    kind: 'money',
    money: { spent: 123, limit: 500, currency: 'DKK' },
    resetsAt: '2026-10-01T00:00:00.000Z'
  });
  const creditsBucket = bucket({
    id: 'chatgpt.codex_credits',
    service: 'chatgpt',
    key: 'codex_credits',
    label: 'Codex credits',
    pct: null,
    resetsAt: null,
    priority: 5,
    kind: 'credits',
    credits: { balance: 1240, unlimited: false, exhausted: false, approxCloudMessages: 42 }
  });

  it('survives a disk round trip unchanged', () => {
    const restored = restoreSnapshot(
      trimSnapshot(snapshot({ buckets: [moneyBucket, creditsBucket] })),
      INTERVAL
    );
    const byId = new Map((restored?.buckets ?? []).map((b) => [b.id, b] as const));
    expect(byId.get('claude.extra_usage')).toMatchObject({
      kind: 'money',
      money: { spent: 123, limit: 500, currency: 'DKK' },
      pct: 24.6
    });
    expect(byId.get('chatgpt.codex_credits')).toMatchObject({
      kind: 'credits',
      credits: { balance: 1240, unlimited: false, exhausted: false, approxCloudMessages: 42 }
    });
  });

  it('round-trips a credit money row with its flag intact', () => {
    // Without `inCredits`, a restored Codex credit row would come back claiming
    // its 2,733 credits are 2,733 XXX and print them as money.
    const creditCap = bucket({
      id: 'chatgpt.codex_spend_limit',
      service: 'chatgpt',
      key: 'codex_spend_limit',
      label: 'Codex credit limit',
      pct: 455,
      priority: 4.5,
      kind: 'money',
      money: { spent: 2732.6146183013916, limit: 600, currency: 'XXX', inCredits: true },
      resetsAt: '2026-10-01T00:00:01.000Z'
    });
    const restored = restoreSnapshot(
      trimSnapshot(snapshot({ buckets: [creditCap] })),
      INTERVAL
    );
    expect(restored?.buckets[0]).toMatchObject({
      kind: 'money',
      pct: 455,
      money: { spent: 2732.6146183013916, limit: 600, currency: 'XXX', inCredits: true }
    });
    // And it still renders as the row it was before the disk trip.
    const money = restored?.buckets[0]?.money;
    expect(money && formatMoneyValue(money, 455, 'en-US')).toBe('2,733 / 600 credits  (455%)');
  });

  it('drops an unusable inCredits, restoring an ordinary money row', () => {
    // The file is hand-editable, and this flag decides whether the two numbers
    // are money at all, so anything but literal `true` loses it, not the row.
    for (const bad of [42, '', 'credits', 'true', null, {}]) {
      const restored = restoreSnapshot(
        {
          fetchedAt: new Date().toISOString(),
          intervalMs: INTERVAL,
          buckets: [
            {
              id: 'x',
              service: 'chatgpt',
              key: 'k',
              label: 'L',
              pct: 50,
              resetsAt: null,
              priority: 1,
              kind: 'money',
              money: { spent: 1, limit: 2, currency: 'USD', inCredits: bad } as never
            }
          ],
          services: trimSnapshot(snapshot()).services
        },
        INTERVAL
      );
      expect(restored?.buckets[0]?.money?.inCredits, String(bad)).toBeUndefined();
      expect(restored?.buckets[0]?.money?.spent, String(bad)).toBe(1);
    }
  });

  it('leaves an ordinary window\'s persisted shape untouched', () => {
    const [only] = trimSnapshot(snapshot()).buckets;
    expect(only).not.toHaveProperty('kind');
    expect(only).not.toHaveProperty('money');
    expect(only).not.toHaveProperty('credits');
  });

  it('restores a capless money row as capless, not as a broken one', () => {
    // The owner's own account. A `null` cap is the normal state, so it must
    // round-trip as `null` rather than being read as a mangled block and
    // dropped — a restored row that lost its amounts would show "?" for three
    // minutes after every launch.
    const capless = bucket({
      id: 'claude.extra_usage',
      key: 'extra_usage',
      label: 'Extra usage',
      pct: null,
      resetsAt: null,
      priority: 6,
      kind: 'money',
      money: { spent: 9.62, limit: null, currency: 'USD', limitReached: true }
    });
    const restored = restoreSnapshot(
      trimSnapshot(snapshot({ buckets: [capless] })),
      INTERVAL
    );
    expect(restored?.buckets[0]).toMatchObject({
      kind: 'money',
      pct: null,
      money: { spent: 9.62, limit: null, currency: 'USD', limitReached: true }
    });
  });

  it('reads only a literal true out of a hand-edited limitReached', () => {
    const restored = restoreSnapshot(
      {
        fetchedAt: new Date(NOW).toISOString(),
        intervalMs: INTERVAL,
        buckets: [
          {
            ...trimSnapshot(snapshot({ buckets: [moneyBucket] })).buckets[0],
            money: { spent: 1, limit: 5, currency: 'USD', limitReached: 'yes' }
          }
        ],
        services: {}
      },
      INTERVAL
    );
    // A truthy string must not fire the "limit reached" bark on launch.
    expect(restored?.buckets[0]?.money).not.toHaveProperty('limitReached');
  });

  it('crosses IPC with its detail intact', () => {
    const sent = forIpc(snapshot({ buckets: [moneyBucket, creditsBucket] }));
    expect(sent.buckets.map((b) => b.kind)).toEqual(['money', 'credits']);
    expect(sent.services.chatgpt.buckets[0]?.credits?.balance).toBe(1240);
  });

  it('degrades a mangled money block to an ordinary row rather than crashing', () => {
    for (const money of [{ spent: 1, limit: 0, currency: 'DKK' }, { spent: -1, limit: 5, currency: 'DKK' }, { spent: 1, limit: 5, currency: 'kroner' }, 'nonsense', null]) {
      const restored = restoreSnapshot(
        {
          fetchedAt: new Date(NOW).toISOString(),
          intervalMs: INTERVAL,
          buckets: [{ ...trimSnapshot(snapshot({ buckets: [moneyBucket] })).buckets[0], money }],
          services: {}
        },
        INTERVAL
      );
      const row = restored?.buckets[0];
      expect(row, JSON.stringify(money)).toBeDefined();
      // The row survives with its percentage; only the amounts are lost.
      expect(row?.pct).toBe(24.6);
      expect(row?.kind).toBeUndefined();
      expect(row?.money).toBeUndefined();
    }
  });

  it('reads only literal booleans out of a hand-edited credits block', () => {
    const restored = restoreSnapshot(
      {
        fetchedAt: new Date(NOW).toISOString(),
        intervalMs: INTERVAL,
        buckets: [
          {
            ...trimSnapshot(snapshot({ buckets: [creditsBucket] })).buckets[0],
            credits: { balance: 'lots', unlimited: 'yes', exhausted: 1 }
          }
        ],
        services: {}
      },
      INTERVAL
    );
    expect(restored?.buckets[0]?.credits).toEqual({
      balance: null,
      unlimited: false,
      exhausted: false
    });
  });

  it('never lets a money row decide the dog\'s face', () => {
    // Even keyed like the 5-hour window, which no parser does — the guard is
    // for the row nobody thought to check.
    const disguised = bucket({ kind: 'money', money: { spent: 5, limit: 5, currency: 'USD' }, pct: 100 });
    expect(pctForFace([disguised])).toBeNull();
  });
});

describe('persisting tokens rows', () => {
  const tokensBucket = bucket({
    id: 'claude.tokens_today',
    key: 'tokens_today',
    label: 'Tokens today',
    pct: null,
    resetsAt: null,
    priority: 9,
    kind: 'tokens',
    tokens: { total: 1_240_000 }
  });

  it('survives a disk round trip unchanged', () => {
    const restored = restoreSnapshot(trimSnapshot(snapshot({ buckets: [tokensBucket] })), INTERVAL);
    expect(restored?.buckets[0]).toMatchObject({
      kind: 'tokens',
      tokens: { total: 1_240_000 }
    });
  });

  it('degrades a mangled tokens block to a plain window rather than crashing', () => {
    for (const tokens of [{ total: 'lots' }, { total: -5 }, 'nonsense', null]) {
      const restored = restoreSnapshot(
        {
          fetchedAt: new Date(NOW).toISOString(),
          intervalMs: INTERVAL,
          buckets: [{ ...trimSnapshot(snapshot({ buckets: [tokensBucket] })).buckets[0], tokens }],
          services: {}
        },
        INTERVAL
      );
      const row = restored?.buckets[0];
      expect(row, JSON.stringify(tokens)).toBeDefined();
      // The row survives; only the kind and its detail are lost, same rule as
      // a mangled money or credits block.
      expect(row?.kind).toBeUndefined();
      expect(row?.tokens).toBeUndefined();
    }
  });
});

describe('visibleBuckets', () => {
  const rows = [
    bucket(),
    bucket({ id: 'claude.seven_day', key: 'seven_day', label: '7-day (all models)', pct: 70 }),
    bucket({ id: 'chatgpt.codex_primary', service: 'chatgpt', key: 'codex_primary', label: 'Codex 5-hour', pct: 12 })
  ];

  it('drops exactly the ids it is given', () => {
    expect(visibleBuckets(rows, ['claude.seven_day']).map((b) => b.id)).toEqual([
      'claude.five_hour',
      'chatgpt.codex_primary'
    ]);
  });

  it('is a no-op for an empty list, and for ids nothing reports', () => {
    expect(visibleBuckets(rows, [])).toEqual(rows);
    expect(visibleBuckets(rows, ['claude.seven_day_haiku'])).toEqual(rows);
  });

  it('matches on the id, never on the label or the key', () => {
    // Two rows can share a label (the derived Fable mirror and a real Fable
    // window never coexist, but a walked `chatgpt.*` key can collide with
    // anything). The id is the only identity there is.
    expect(visibleBuckets(rows, ['5-hour', 'five_hour'])).toEqual(rows);
  });

  it('copies rather than aliasing, so a caller cannot mutate the snapshot', () => {
    const out = visibleBuckets(rows, []);
    expect(out).not.toBe(rows);
    out.pop();
    expect(rows).toHaveLength(3);
  });

  it('takes a hidden row out of each service section too, through forIpc', () => {
    // This is the whole reason the filter lives *inside* `forIpc`: the panel
    // draws per-service sections, `forIpc` rebuilds those from the merged list,
    // so one argument covers both — and both callers get it, which was not true
    // while `publishSnapshot` filtered and `settings:get` did not.
    const payload = forIpc(snapshot({ buckets: rows }), ['claude.seven_day']);
    expect(payload.buckets.map((b) => b.id)).toEqual(['claude.five_hour', 'chatgpt.codex_primary']);
    expect(payload.services.claude.buckets.map((b) => b.id)).toEqual(['claude.five_hour']);
    expect(payload.services.chatgpt.buckets.map((b) => b.id)).toEqual(['chatgpt.codex_primary']);
  });

  it('leaves the face alone when the row the face follows is hidden', () => {
    // The owner's decision: hiding the 5-hour row takes it off the card and
    // silences it, and the dog goes on describing it.
    const hidden = visibleBuckets(rows, ['claude.five_hour']);
    expect(pctForFace(hidden)).toBeNull();
    expect(pctForFace(rows)).toBe(42.5);
  });

  /**
   * `hiddenServices`: the one fact about hiding that the panel cannot work out
   * for itself, because by then "all hidden" and "reported nothing" are the
   * same empty list. `core/card-layout.ts` drops the named sections entirely;
   * this is the half that decides which names are on the list.
   */
  describe('hiddenServices', () => {
    const full = snapshot({ buckets: rows });

    it('names a service that reported rows and has none left', () => {
      expect(forIpc(full, ['claude.five_hour', 'claude.seven_day']).hiddenServices).toEqual([
        'claude'
      ]);
      expect(forIpc(full, ['chatgpt.codex_primary']).hiddenServices).toEqual(['chatgpt']);
    });

    it('is absent, not empty, while anything is left to show', () => {
      // `exactOptionalPropertyTypes`, and an empty array would read as a fact
      // rather than as the absence of one.
      expect(forIpc(full).hiddenServices).toBeUndefined();
      expect(forIpc(full, []).hiddenServices).toBeUndefined();
      expect(forIpc(full, ['claude.seven_day']).hiddenServices).toBeUndefined();
      expect(forIpc(full, ['claude.nonesuch']).hiddenServices).toBeUndefined();
    });

    it('never names a service that reported nothing in the first place', () => {
      // The distinction the field exists for: an `ok` source with no windows,
      // or a logged-out one, keeps its section and its "no limits reported".
      const claudeOnly = snapshot({ buckets: [rows[0] as Bucket] });
      expect(forIpc(claudeOnly).hiddenServices).toBeUndefined();
      expect(forIpc(claudeOnly, ['claude.five_hour']).hiddenServices).toEqual(['claude']);
      expect(forIpc(snapshot({ buckets: [] }), ['claude.five_hour']).hiddenServices).toBeUndefined();
    });

    it('is not written to disk, because hiding is a live setting', () => {
      // `trimSnapshot` is the disk shape, and a stale copy of this could only
      // disagree with the store the next publish reads.
      expect('hiddenServices' in trimSnapshot(forIpc(full, ['claude.five_hour']))).toBe(false);
    });
  });
});

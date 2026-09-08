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
  formatPct,
  forIpc,
  formatRefreshedAgo,
  isStale,
  pctForFace,
  restoreSnapshot,
  trimSnapshot,
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

  it('falls back to the highest known percentage', () => {
    // A ChatGPT-only setup would otherwise leave the dog permanently confused.
    const buckets = [
      bucket({ id: 'chatgpt.codex_primary', service: 'chatgpt', key: 'codex_primary', pct: 37 }),
      bucket({ id: 'chatgpt.codex_secondary', service: 'chatgpt', key: 'codex_secondary', pct: 88 })
    ];
    expect(pctForFace(buckets)).toBe(88);
    expect(expressionForBuckets(buckets)).toBe('worried');
  });

  it('ignores a five-hour bucket with no number and uses the next best thing', () => {
    const buckets = [bucket({ pct: null }), bucket({ id: 'claude.seven_day', key: 'seven_day', pct: 61 })];
    expect(pctForFace(buckets)).toBe(61);
  });

  it('is null with no buckets at all, which shows the confused face', () => {
    // An honest "I don't know" beats a confident 0 %.
    expect(pctForFace([])).toBeNull();
    expect(expressionForBuckets([])).toBe('confused');
  });

  it('is null when every bucket is unknown', () => {
    expect(pctForFace([bucket({ pct: null }), bucket({ id: 'b', pct: null })])).toBeNull();
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

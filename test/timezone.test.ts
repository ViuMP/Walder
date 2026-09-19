/**
 * Time zones and clock skew.
 *
 * Every date on the card is epoch arithmetic on ISO strings, except the two
 * clock rungs of `formatResetsIn`, which ask `Intl` for a weekday and a wall
 * time. Nothing in the suite ran under a zone other than the machine's until
 * this file, so a zone-dependent bug would have passed CI in UTC and shown up
 * in Kolkata (+05:30), on the Chatham Islands (+12:45, DST +13:45) or across a
 * New York clock change. Skew is the other half: a `fetchedAt` from a machine
 * whose clock ran ahead must read as "just now", never as a negative age.
 *
 * Node re-reads `process.env.TZ` on assignment, but only on the main thread; in
 * a worker the assignment is a no-op. The process-zone tests therefore check
 * that switching took effect and skip themselves honestly when it did not,
 * while the explicit-`timeZone` tests always run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatResetsIn, nextMonthlyResetAt, type Bucket } from '../src/core/buckets';
import { nextResetDelayMs, resetCrossed } from '../src/core/poll-schedule';
import { formatRefreshedAgo, isStale } from '../src/core/usage';

const ZONES = ['UTC', 'Asia/Kolkata', 'Pacific/Chatham', 'America/New_York'];
const GB = { locale: 'en-GB' } as const;

const originalTz = process.env['TZ'];
afterEach(() => {
  if (originalTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = originalTz;
});

function inZone<T>(tz: string, fn: () => T): T {
  process.env['TZ'] = tz;
  try {
    return fn();
  } finally {
    if (originalTz === undefined) delete process.env['TZ'];
    else process.env['TZ'] = originalTz;
  }
}

/** Does assigning `process.env.TZ` move the clock in this runtime? */
const tzSwitches =
  inZone('UTC', () => new Date('2026-09-10T12:00:00Z').getHours()) !==
  inZone('Asia/Kolkata', () => new Date('2026-09-10T12:00:00Z').getHours());

function resetting(resetsAt: string | null): Bucket {
  return { id: 'b', service: 'claude', key: 'five_hour', label: '5-hour', pct: 50, resetsAt, priority: 0 };
}

const NOW = new Date('2026-09-26T10:00:00Z'); // a Saturday
const THURSDAY = '2026-10-01T14:30:00Z';
const FAR = '2026-10-15T09:00:00Z';

describe('a past resetsAt', () => {
  it('is "reset pending", never a negative, in every zone and both styles', () => {
    for (const tz of ZONES) {
      inZone(tz, () => {
        for (const style of ['clock', 'countdown'] as const) {
          const past1s = new Date(NOW.getTime() - 1_000).toISOString();
          const past1d = new Date(NOW.getTime() - 86_400_000).toISOString();
          expect(formatResetsIn(past1s, NOW, { style, ...GB })).toBe('reset pending');
          expect(formatResetsIn(past1d, NOW, { style, ...GB })).toBe('reset pending');
        }
      });
    }
  });
});

describe('a fetchedAt ahead of the clock', () => {
  it('reads as just now and is not stale', () => {
    for (const skew of [1_000, 86_400_000]) {
      const future = new Date(NOW.getTime() + skew).toISOString();
      expect(formatRefreshedAgo(future, NOW.getTime())).toBe('refreshed just now');
      expect(isStale(future, NOW.getTime(), 180_000)).toBe(false);
    }
  });
});

describe('the countdown text', () => {
  it('is identical in every zone', () => {
    const cases = [47 * 60_000, (3 * 60 + 20) * 60_000, (3 * 24 + 4) * 3_600_000];
    for (const offset of cases) {
      const resetsAt = new Date(NOW.getTime() + offset).toISOString();
      const expected = formatResetsIn(resetsAt, NOW, { style: 'countdown' });
      for (const tz of ZONES) {
        expect(inZone(tz, () => formatResetsIn(resetsAt, NOW, { style: 'countdown' }))).toBe(expected);
      }
    }
    expect(formatResetsIn(new Date(NOW.getTime() + 47 * 60_000).toISOString(), NOW, GB)).toBe(
      'resets in 47m'
    );
  });
});

describe('the clock rungs with an explicit timeZone', () => {
  it('are identical whatever the process zone', () => {
    for (const tz of ZONES) {
      inZone(tz, () => {
        expect(formatResetsIn(THURSDAY, NOW, { ...GB, timeZone: 'UTC' })).toBe('resets Thu 14:30');
        expect(formatResetsIn(FAR, NOW, { ...GB, timeZone: 'UTC' })).toBe('resets 15 Oct');
      });
    }
  });

  it('follow the zone they are given', () => {
    expect(formatResetsIn(THURSDAY, NOW, { ...GB, timeZone: 'Asia/Kolkata' })).toBe('resets Thu 20:00');
    // +13:45 on the Chatham Islands in their summer: the reset is on Friday.
    expect(formatResetsIn(THURSDAY, NOW, { ...GB, timeZone: 'Pacific/Chatham' })).toBe('resets Fri 04:15');
  });

  it('across the New York fall-back name the same wall time twice, honestly', () => {
    // 2026-11-01: 02:00 EDT becomes 01:00 EST. 01:30 happens twice; the card
    // says "Sun 01:30" for both, and the countdown is what tells them apart.
    const now = new Date('2026-10-30T12:00:00Z');
    const beforeEdt = '2026-11-01T05:30:00Z';
    const afterEst = '2026-11-01T06:30:00Z';
    const ny = { ...GB, timeZone: 'America/New_York' };
    expect(formatResetsIn(beforeEdt, now, ny)).toBe('resets Sun 01:30');
    expect(formatResetsIn(afterEst, now, ny)).toBe('resets Sun 01:30');
    expect(formatResetsIn(beforeEdt, now, { style: 'countdown' })).toBe('resets in 1d 17h');
    expect(formatResetsIn(afterEst, now, { style: 'countdown' })).toBe('resets in 1d 18h');
  });
});

describe.skipIf(!tzSwitches)('the clock rungs without a timeZone', () => {
  it('follow the process zone, weekday included', () => {
    expect(inZone('UTC', () => formatResetsIn(THURSDAY, NOW, GB))).toBe('resets Thu 14:30');
    expect(inZone('Asia/Kolkata', () => formatResetsIn(THURSDAY, NOW, GB))).toBe('resets Thu 20:00');
    expect(inZone('Pacific/Chatham', () => formatResetsIn(THURSDAY, NOW, GB))).toBe('resets Fri 04:15');
  });
});

describe('reset boundaries', () => {
  it('are epoch arithmetic, the same in every zone', () => {
    const since = NOW.getTime() - 60_000;
    const crossed = resetting(new Date(NOW.getTime() - 30_000).toISOString());
    const ahead = resetting(new Date(NOW.getTime() + 120_000).toISOString());
    for (const tz of ZONES) {
      inZone(tz, () => {
        expect(resetCrossed([crossed], since, NOW.getTime())).toBe(true);
        expect(resetCrossed([ahead], since, NOW.getTime())).toBe(false);
        expect(nextResetDelayMs([ahead, crossed], NOW.getTime())).toBe(120_000);
      });
    }
  });
});

describe('the estimated monthly reset', () => {
  it('rolls on the UTC month, not the local one', () => {
    // 23:30 UTC on the 19th is already the 20th on the Chatham Islands; the
    // boundary is still the first of October in UTC, because the payload's
    // dates are UTC and the estimate must sit on the same scale.
    const late = Date.parse('2026-09-19T23:30:00Z');
    for (const tz of ZONES) {
      expect(inZone(tz, () => nextMonthlyResetAt(late))).toBe('2026-10-01T00:00:00.000Z');
    }
  });
});

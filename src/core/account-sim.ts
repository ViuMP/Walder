/**
 * Developer ▸ Simulate account state: the account states the QA checklist
 * needs (rows 3.4l, 4.24, 5.9b–5.9d) and the owner cannot produce on demand —
 * a Codex credit pool running dry, Extra usage near or at its limit, a blown
 * Codex spend cap.
 *
 * Each state is one row laid over every snapshot on its way to the card and
 * the barks, built by the same parsers a real payload goes through, so the
 * card and the bark machine see exactly the shape a real account would give
 * them. The poller's own snapshot, the one it persists, is never touched:
 * `index.ts` applies this after the poller has written its copy, so nothing
 * simulated reaches the settings file.
 */
import {
  extraUsageBucket,
  mergeBuckets,
  parseCodexCredits,
  parseCodexSpendLimit,
  type Bucket
} from './buckets';
import { perService } from './services';
import { expressionForBuckets, type ServiceReport, type UsageSnapshot } from './usage';

export const ACCOUNT_STATES = [
  'normal',
  'codex-credits-left',
  'codex-credits-out',
  'extra-usage-85',
  'extra-usage-limit-reached',
  'codex-spend-limit'
] as const;

export type AccountState = (typeof ACCOUNT_STATES)[number];

/** The row a state lays over the snapshot, or `null` for `normal`. */
export function simulatedBucket(state: AccountState, now: number): Bucket | null {
  switch (state) {
    case 'normal':
      return null;
    // A pool with credits in it: what re-arms the out-of-credit bark (5.9c).
    case 'codex-credits-left':
      return parseCodexCredits({ credits: { has_credits: true, unlimited: false, balance: 1240 } });
    case 'codex-credits-out':
      return parseCodexCredits({
        credits: { has_credits: true, unlimited: false, balance: 0, overage_limit_reached: true }
      });
    // Capped Extra usage past the 80 and 85 levels (5.9b).
    case 'extra-usage-85':
      return extraUsageBucket({ spent: 51, limit: 60, currency: 'EUR' }, now);
    // No monthly cap, and claude.ai says the spend limit is reached (5.9d).
    case 'extra-usage-limit-reached':
      return extraUsageBucket({ spent: 9.62, limit: null, currency: 'EUR', limitReached: true }, now);
    // The 455 % overrun of QA row 4.24: 2,733 credits used of a 600 cap.
    case 'codex-spend-limit':
      return parseCodexSpendLimit(
        {
          spend_control: {
            individual_limit: {
              unit: 'credit',
              limit: '600',
              used: '2733',
              used_percent: 455,
              reset_after_seconds: 10 * 24 * 60 * 60
            }
          }
        },
        new Date(now)
      );
  }
}

/**
 * `snapshot` with the state's row in place of any real row with the same id,
 * in its service's section and in the merged list. A new object; `snapshot`
 * is left as it was.
 */
export function simulateAccountState(
  snapshot: UsageSnapshot,
  state: AccountState,
  now: number
): UsageSnapshot {
  const row = simulatedBucket(state, now);
  if (row === null) return snapshot;
  const services = perService(Object.keys(snapshot.services), (service) => {
    // A key of the map itself, so always present.
    const report = snapshot.services[service] as ServiceReport;
    if (service !== row.service) return report;
    return { ...report, buckets: [...report.buckets.filter((b) => b.id !== row.id), row] };
  });
  const buckets = mergeBuckets(
    snapshot.primary,
    ...Object.values(services).map((report) => report.buckets)
  );
  return { ...snapshot, services, buckets, expression: expressionForBuckets(buckets) };
}

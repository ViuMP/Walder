/** Developer ▸ Simulate account state: the override laid over each snapshot. */
import { describe, expect, it } from 'vitest';
import { ACCOUNT_STATES, simulateAccountState } from '../src/core/account-sim';
import { perService } from '../src/core/services';
import { expressionForBuckets, type ServiceReport, type UsageSnapshot } from '../src/core/usage';
import type { Bucket } from '../src/core/buckets';
import { t } from '../src/core/strings';

const NOW = Date.parse('2026-11-18T12:00:00Z');

function snapshot(): UsageSnapshot {
  const claude: Bucket = {
    id: 'claude.five_hour',
    service: 'claude',
    key: 'five_hour',
    label: '5-hour',
    pct: 30,
    resetsAt: null,
    priority: 0
  };
  // A real credits row the simulation must replace, not duplicate.
  const credits: Bucket = {
    id: 'chatgpt.codex_credits',
    service: 'chatgpt',
    key: 'codex_credits',
    label: 'Codex credits',
    pct: null,
    resetsAt: null,
    priority: 5,
    kind: 'credits',
    credits: { balance: 500, unlimited: false, exhausted: false }
  };
  const report = (buckets: Bucket[]): ServiceReport => ({
    buckets,
    status: 'ok',
    via: 'test',
    viaLabel: 'test'
  });
  const services = perService(['claude', 'chatgpt', 'cursor', 'copilot', 'gemini'], (s) =>
    report(s === 'claude' ? [claude] : s === 'chatgpt' ? [credits] : [])
  );
  return {
    fetchedAt: new Date(NOW).toISOString(),
    services,
    buckets: [claude, credits],
    expression: expressionForBuckets([claude, credits]),
    intervalMs: 180_000
  };
}

describe('simulateAccountState', () => {
  it('hands the snapshot back untouched for normal', () => {
    const real = snapshot();
    expect(simulateAccountState(real, 'normal', NOW)).toBe(real);
  });

  it('replaces the real credits row with an exhausted one, in the section and the merged list', () => {
    const real = snapshot();
    const out = simulateAccountState(real, 'codex-credits-out', NOW);
    const rows = out.buckets.filter((b) => b.id === 'chatgpt.codex_credits');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.credits).toMatchObject({ balance: 0, exhausted: true });
    expect(out.services.chatgpt.buckets).toHaveLength(1);
    expect(out.services.chatgpt.buckets[0]?.credits?.exhausted).toBe(true);
    // Claude untouched, and the input not mutated.
    expect(out.services.claude).toBe(real.services.claude);
    expect(real.services.chatgpt.buckets[0]?.credits?.exhausted).toBe(false);
  });

  it('adds a capless Extra usage row that has reached its spend limit', () => {
    const out = simulateAccountState(snapshot(), 'extra-usage-limit-reached', NOW);
    const row = out.services.claude.buckets.find((b) => b.id === 'claude.extra_usage');
    expect(row?.kind).toBe('money');
    expect(row?.pct).toBeNull();
    expect(row?.money).toMatchObject({ limit: null, limitReached: true });
    expect(out.buckets.map((b) => b.id)).toContain('claude.extra_usage');
  });

  it('adds capped Extra usage at 85 % and the 455 % Codex credit limit', () => {
    const extra = simulateAccountState(snapshot(), 'extra-usage-85', NOW);
    expect(extra.buckets.find((b) => b.id === 'claude.extra_usage')?.pct).toBe(85);
    const spend = simulateAccountState(snapshot(), 'codex-spend-limit', NOW);
    const row = spend.buckets.find((b) => b.id === 'chatgpt.codex_spend_limit');
    expect(row?.pct).toBe(455);
    expect(row?.money).toMatchObject({ spent: 2733, limit: 600, inCredits: true });
  });

  it('gives every non-normal state a row and every state a menu label', () => {
    for (const state of ACCOUNT_STATES) {
      expect(t(`tray.accountState.${state}`)).not.toBe(`tray.accountState.${state}`);
      if (state === 'normal') continue;
      const out = simulateAccountState(snapshot(), state, NOW);
      expect(out).not.toEqual(snapshot());
    }
  });
});

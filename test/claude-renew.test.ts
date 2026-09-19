/**
 * The renewal decision, on its own.
 *
 * Everything worth getting wrong here is a boundary: the margin that must stay
 * under Claude Code's own, the cooldown's exact edge, and the order of the two
 * blocks — because one of them is permanent and the other is not, and reporting
 * the wrong one would tell whoever reads the log to wait ten minutes for a
 * retry that is never coming.
 */
import { describe, expect, it } from 'vitest';
import {
  RENEW_COOLDOWN_MS,
  RENEW_MARGIN_MS,
  shouldRenew,
  type RenewState
} from '../src/core/claude-renew';

const NOW = Date.parse('2026-09-19T09:00:00Z');

/** Nothing attempted yet — the state at launch. */
const FRESH_STATE: RenewState = { attemptedFor: null, lastAttemptAt: null };

describe('shouldRenew', () => {
  it('is no-login when there is no expiry to act on', () => {
    // No Claude Code credential on this machine at all. There is nothing for
    // the CLI to renew and nothing to key an attempt on.
    expect(shouldRenew(null, FRESH_STATE, NOW)).toBe('no-login');
  });

  it('leaves a token alone until it is inside the margin', () => {
    // Strictly: exactly `RENEW_MARGIN_MS` away is still fresh, and one
    // millisecond inside is the first moment worth acting on.
    expect(shouldRenew(NOW + RENEW_MARGIN_MS, FRESH_STATE, NOW)).toBe('fresh');
    expect(shouldRenew(NOW + RENEW_MARGIN_MS - 1, FRESH_STATE, NOW)).toBe('renew');
  });

  it('renews a token that has already expired', () => {
    // The whole reason this exists: the overnight lapse. The CLI renews an
    // expired credential from its refresh token perfectly well.
    expect(shouldRenew(NOW - 60 * 60_000, FRESH_STATE, NOW)).toBe('renew');
  });

  it('never attempts the same expiry twice, however long ago it was', () => {
    // The permanent block. A renewal that did not move the credential leaves
    // the same number behind, so a failure stops here instead of spawning a
    // process on every poll for the rest of the day.
    const expiresAt = NOW - 1;
    const state: RenewState = {
      attemptedFor: expiresAt,
      lastAttemptAt: NOW - 100 * RENEW_COOLDOWN_MS
    };
    expect(shouldRenew(expiresAt, state, NOW)).toBe('already-attempted');
  });

  it('holds a different expiry off until the cooldown is up', () => {
    const state: RenewState = { attemptedFor: NOW - 5, lastAttemptAt: NOW - RENEW_COOLDOWN_MS + 1 };
    expect(shouldRenew(NOW - 1, state, NOW)).toBe('cooldown');
    expect(
      shouldRenew(NOW - 1, { ...state, lastAttemptAt: NOW - RENEW_COOLDOWN_MS }, NOW)
    ).toBe('renew');
  });

  it('prefers already-attempted over cooldown when both hold', () => {
    // Order matters for the log line, not the outcome: "wait ten minutes" is a
    // lie about an expiry that will never be retried.
    const expiresAt = NOW - 1;
    const state: RenewState = { attemptedFor: expiresAt, lastAttemptAt: NOW - 1_000 };
    expect(shouldRenew(expiresAt, state, NOW)).toBe('already-attempted');
  });

  it('keeps the margin under Claude Code\'s own five minutes', () => {
    // Load-bearing, and the reason is not obvious: outside *its* margin the
    // CLI's launch is a no-op, we would read an unmoved expiry as a failure,
    // and `attemptedFor` would then block the attempt that would have worked.
    expect(RENEW_MARGIN_MS).toBeLessThan(5 * 60_000);
  });
});

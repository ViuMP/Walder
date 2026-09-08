/**
 * The Accounts menu's "what happened last time we looked" line.
 *
 * This wording exists because of one owner report: he logged in to ChatGPT
 * inside Walder's own window, and the tray still said "login needed" with
 * nothing else to say. The cause was a real bug (no cookies were being sent —
 * see `http.ts`), but what made it a *mystery* was a menu that could not
 * distinguish "we asked and got a 401" from "we have not asked since Tuesday".
 *
 * Two properties are pinned: the four states read differently, and no state
 * ever names the account. Walder knows who is logged in; a menu bar is read over
 * someone's shoulder.
 */
import { describe, expect, it } from 'vitest';
import {
  NOT_CHECKED_LINE,
  authCheck,
  clockTime,
  lastCheckLine,
  type AuthCheck
} from '../src/core/last-check';

/** 12:03:40 in the machine's own zone, which is what the line reports. */
const AT = new Date('2026-09-08T12:03:40').getTime();

describe('clockTime', () => {
  it('is local hours and minutes, zero-padded', () => {
    expect(clockTime(AT)).toBe('12:03');
    expect(clockTime(new Date('2026-09-08T09:07:00').getTime())).toBe('09:07');
    expect(clockTime(new Date('2026-09-08T00:00:00').getTime())).toBe('00:00');
  });

  it('drops the seconds', () => {
    // A poll is every three minutes; second-level precision would be noise.
    expect(clockTime(new Date('2026-09-08T12:03:00').getTime())).toBe(
      clockTime(new Date('2026-09-08T12:03:59').getTime())
    );
  });
});

describe('lastCheckLine', () => {
  it('says nothing has been checked before the first check', () => {
    expect(lastCheckLine(null)).toBe(NOT_CHECKED_LINE);
  });

  it('confirms a login with the time it was confirmed', () => {
    expect(lastCheckLine(authCheck(true, '', AT))).toBe('Logged in (checked 12:03)');
  });

  it('gives the reason when the answer was "not logged in"', () => {
    // The reason is what distinguishes "your session expired, log in again"
    // from "something odd is happening at chatgpt.com".
    expect(lastCheckLine(authCheck(false, 'HTTP 401', AT))).toBe(
      'Not logged in — last check: HTTP 401 (12:03)'
    );
    expect(lastCheckLine(authCheck(false, 'no access token', AT))).toBe(
      'Not logged in — last check: no access token (12:03)'
    );
  });

  it('distinguishes "we could not ask" from "you are not logged in"', () => {
    // A different thing to do about it: a network problem is not a password
    // problem, and the owner should not go hunting for one.
    expect(lastCheckLine(authCheck(false, 'timeout', AT, true))).toBe(
      'Check failed: timeout (12:03)'
    );
  });

  it('still reads as a sentence when there is no detail to give', () => {
    expect(lastCheckLine(authCheck(false, '', AT))).toBe('Not logged in (checked 12:03)');
    expect(lastCheckLine(authCheck(false, '', AT, true))).toBe('Check failed (12:03)');
  });

  it('never names the account, in any state', () => {
    const states: AuthCheck[] = [
      authCheck(true, '', AT),
      authCheck(false, 'HTTP 401', AT),
      authCheck(false, 'timeout', AT, true)
    ];
    for (const state of states) {
      const line = lastCheckLine(state);
      expect(line).not.toMatch(/@/);
      expect(line.toLowerCase()).not.toContain('as ');
    }
  });
});

describe('authCheck', () => {
  it('defaults to "the check completed"', () => {
    expect(authCheck(true, '', AT)).toEqual({
      loggedIn: true,
      failed: false,
      detail: '',
      at: AT
    });
  });
});

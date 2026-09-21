/**
 * The live-session list: the reducer behind the hover card's SESSIONS block.
 *
 * Every case here is a fixture array and a fixed `now`, which is the whole
 * point of keeping the fold pure — the alternative is a temporary directory, a
 * loopback port and a clock, and none of those is where the interesting
 * decisions are. The interesting decisions are: what merges into one row, what
 * an event without a `cwd` does to the row it lands on, and when a row stops
 * being worth showing.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_SESSION_CWD_CHARS,
  liveSessions,
  parseSessionsPayload,
  reduceSessionEntries,
  shortenCwd,
  type SessionEntry
} from '../src/core/sessions';
import { WAITING_STALE_MS } from '../src/core/behaviour';

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const MINUTE = 60_000;

describe('reduceSessionEntries', () => {
  it('maps the three hook kinds onto the three states', () => {
    const working = reduceSessionEntries([], { kind: 'prompt', source: 'claude' }, NOW);
    const waiting = reduceSessionEntries([], { kind: 'waiting', source: 'claude' }, NOW);
    const done = reduceSessionEntries([], { kind: 'done', source: 'claude' }, NOW);
    expect([working[0]?.state, waiting[0]?.state, done[0]?.state]).toEqual([
      'working',
      'waiting',
      'done'
    ]);
  });

  it('records what the event knew, and nothing it did not', () => {
    const [entry] = reduceSessionEntries(
      [],
      { kind: 'waiting', source: 'claude', cwd: '~/code', sessionId: 'abc', pid: 4321 },
      NOW
    );
    expect(entry).toEqual({
      source: 'claude',
      key: 'abc',
      cwd: '~/code',
      pid: 4321,
      state: 'waiting',
      at: NOW
    });
  });

  it('keys on the session id, then the pid, then the tool', () => {
    const bySession = reduceSessionEntries([], { kind: 'done', source: 'claude', sessionId: 'abc', pid: 9 }, NOW);
    const byPid = reduceSessionEntries([], { kind: 'done', source: 'claude', pid: 9 }, NOW);
    const bySource = reduceSessionEntries([], { kind: 'done', source: 'codex' }, NOW);
    expect([bySession[0]?.key, byPid[0]?.key, bySource[0]?.key]).toEqual(['abc', '9', 'codex']);
  });

  it('merges a second event about one session into the one row', () => {
    const first = reduceSessionEntries(
      [],
      { kind: 'prompt', source: 'claude', sessionId: 'abc', cwd: '~/code' },
      NOW
    );
    // The `Stop` hook that follows carries the id and no directory, which is
    // the case that used to invent a second session.
    const second = reduceSessionEntries(first, { kind: 'done', source: 'claude', sessionId: 'abc' }, NOW + MINUTE);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ key: 'abc', cwd: '~/code', state: 'done', at: NOW + MINUTE });
  });

  it('keeps the pid it already had when the new event has none', () => {
    const first = reduceSessionEntries([], { kind: 'prompt', source: 'claude', sessionId: 'abc', pid: 4321 }, NOW);
    const second = reduceSessionEntries(first, { kind: 'waiting', source: 'claude', sessionId: 'abc' }, NOW + 1);
    expect(second[0]?.pid).toBe(4321);
  });

  it('keeps two different sessions apart, newest first', () => {
    const one = reduceSessionEntries([], { kind: 'prompt', source: 'claude', sessionId: 'a' }, NOW);
    const two = reduceSessionEntries(one, { kind: 'waiting', source: 'codex', sessionId: 'b' }, NOW + MINUTE);
    expect(two.map((entry) => entry.key)).toEqual(['b', 'a']);

    // And the older one coming back moves it to the top, because the owner
    // reads this list to find what just changed.
    const three = reduceSessionEntries(two, { kind: 'done', source: 'claude', sessionId: 'a' }, NOW + 2 * MINUTE);
    expect(three.map((entry) => entry.key)).toEqual(['a', 'b']);
  });

  it('leaves the list it was given alone', () => {
    const before: readonly SessionEntry[] = [
      { source: 'claude', key: 'a', cwd: null, pid: null, state: 'done', at: NOW }
    ];
    reduceSessionEntries(before, { kind: 'waiting', source: 'claude', sessionId: 'a' }, NOW + 1);
    expect(before[0]?.state).toBe('done');
  });
});

describe('liveSessions', () => {
  const at = (age: number): SessionEntry => ({
    source: 'claude',
    key: String(age),
    cwd: null,
    pid: null,
    state: 'waiting',
    at: NOW - age
  });

  it('drops an entry older than the waiting clock and keeps a younger one', () => {
    // The same half hour after which the behaviour coordinator takes the `?`
    // down, so the card and the dog stop believing in a session together.
    expect(WAITING_STALE_MS).toBe(30 * MINUTE);
    const kept = liveSessions([at(31 * MINUTE), at(29 * MINUTE)], NOW);
    expect(kept.map((entry) => entry.key)).toEqual([String(29 * MINUTE)]);
  });

  it('is empty rather than null when everything has aged out', () => {
    expect(liveSessions([at(WAITING_STALE_MS + 1)], NOW)).toEqual([]);
  });
});

describe('shortenCwd', () => {
  it('leaves a path that already fits exactly as it is', () => {
    expect(shortenCwd('~/code/walder', 36)).toBe('~/code/walder');
  });

  it('keeps the last whole segments and marks the cut', () => {
    const long = '~/Desktop/Tree/06 Claude/Walder-p2/src/core';
    const short = shortenCwd(long, 20);
    expect(short).toBe('…/Walder-p2/src/core');
    expect(short.length).toBeLessThanOrEqual(20);
  });

  it('falls back to a character cut when no whole segment fits', () => {
    const cut = shortenCwd('~/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 10);
    expect(cut).toBe('…aaaaaaaaa');
    expect(cut.length).toBe(10);
  });

  it('does not mind the `~` main has already put there', () => {
    expect(shortenCwd('~/Desktop/Tree/Walder', 40)).toBe('~/Desktop/Tree/Walder');
  });
});

describe('parseSessionsPayload', () => {
  const good: SessionEntry = {
    source: 'claude',
    key: 'abc',
    cwd: '~/code',
    pid: 4321,
    state: 'waiting',
    at: NOW
  };

  it('accepts a well-formed list, and an empty one', () => {
    expect(parseSessionsPayload({ sessions: [good] })).toEqual({ sessions: [good] });
    expect(parseSessionsPayload({ sessions: [] })).toEqual({ sessions: [] });
  });

  it('accepts the nulls the entry allows', () => {
    const anonymous = { ...good, cwd: null, pid: null };
    expect(parseSessionsPayload({ sessions: [anonymous] })).toEqual({ sessions: [anonymous] });
  });

  it('rejects the whole payload on one bad entry', () => {
    // Strict like `parseServicePayload`: half a list is a worse answer than
    // the list the card is already showing.
    expect(parseSessionsPayload({ sessions: [good, { ...good, state: 'thinking' }] })).toBeNull();
    expect(parseSessionsPayload({ sessions: [{ ...good, source: 'ollama' }] })).toBeNull();
    expect(parseSessionsPayload({ sessions: [{ ...good, cwd: 'x'.repeat(MAX_SESSION_CWD_CHARS + 1) }] })).toBeNull();
    expect(parseSessionsPayload({ sessions: [{ ...good, key: '' }] })).toBeNull();
    expect(parseSessionsPayload({ sessions: [{ ...good, pid: 0 }] })).toBeNull();
    expect(parseSessionsPayload({ sessions: [{ ...good, pid: 1.5 }] })).toBeNull();
    expect(parseSessionsPayload({ sessions: [{ ...good, at: Number.NaN }] })).toBeNull();
  });

  it('rejects anything that is not a record holding an array', () => {
    expect(parseSessionsPayload({ sessions: 'none' })).toBeNull();
    expect(parseSessionsPayload({})).toBeNull();
    expect(parseSessionsPayload([good])).toBeNull();
    expect(parseSessionsPayload(null)).toBeNull();
    expect(parseSessionsPayload('sessions')).toBeNull();
  });
});

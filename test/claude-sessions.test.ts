/**
 * Claude Code's session registry as a source of hook events.
 *
 * Two halves, tested apart because they fail apart: the pure reducer decides
 * what a change *means* (and is the half with all the edges — a first pass, a
 * dead pid, a vanished session), while the wrapper decides what gets read and
 * when (and is the half with the clock and the broken files).
 *
 * The default `isAlive` is **not** tested. It is three lines against the real
 * kernel — `process.kill(pid, 0)`, `EPERM` means alive-but-not-ours, `ESRCH`
 * means dead — and a test of it would be a test of a mock of `process.kill`.
 * The same argument `index.ts` makes for `offerHooksOnFirstLaunch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseSessionRecord,
  reduceSessions,
  type SessionMap,
  type SessionRecord,
  type SessionStatus
} from '../src/core/claude-sessions';
import { SESSIONS_POLL_MS, createClaudeSessions } from '../src/main/claude-sessions';
import type { HookEvent } from '../src/main/hook-server';
import type { HookKind } from '../src/core/behaviour';

const alive = (): boolean => true;

/**
 * An event, reduced to its kind.
 *
 * The reducer's events carry the pid and whatever the file said about the
 * session (P2-8: the card's SESSIONS block is a list of *which* session is
 * doing what), and nearly every case below is about the kind alone. The two
 * that are about the rest say so.
 */
const kinds = (event: { kind: HookKind }): HookKind => event.kind;

/** `previous` from a plain object, so the cases read as before → after. */
function map(entries: Record<number, SessionStatus>): SessionMap {
  return new Map(Object.entries(entries).map(([pid, status]) => [Number(pid), status]));
}

function record(pid: number, status: SessionStatus): SessionRecord {
  return { pid, status };
}

describe('parseSessionRecord', () => {
  it.each([
    [
      'a real session file',
      JSON.stringify({
        pid: 4321,
        procStart: '2026-09-19T08:00:00.000Z',
        cwd: '/Users/someone/code',
        sessionId: 'abc-123',
        status: 'busy',
        statusUpdatedAt: '2026-09-19T08:04:00.000Z'
      }),
      { pid: 4321, status: 'busy', cwd: '/Users/someone/code', sessionId: 'abc-123' }
    ],
    // The card needs the directory and the id; neither is worth a guess, so a
    // field that is not a string is simply not a fact we have.
    [
      'a session file with a numeric cwd and no sessionId',
      JSON.stringify({ pid: 4321, status: 'busy', cwd: 17 }),
      { pid: 4321, status: 'busy' }
    ],
    [
      'a session file whose sessionId is an object',
      JSON.stringify({ pid: 4321, status: 'idle', sessionId: { id: 'abc' } }),
      { pid: 4321, status: 'idle' }
    ],
    ['not JSON at all', 'not json', null],
    // Half a file, which is what a sweep landing mid-write actually sees.
    ['a truncated write', '{"pid":4321,"stat', null],
    ['a JSON array', '[{"pid":1,"status":"busy"}]', null],
    ['a JSON string', '"busy"', null],
    ['no pid', JSON.stringify({ status: 'busy' }), null],
    ['pid 0', JSON.stringify({ pid: 0, status: 'busy' }), null],
    ['a negative pid', JSON.stringify({ pid: -4, status: 'busy' }), null],
    ['a fractional pid', JSON.stringify({ pid: 4.5, status: 'busy' }), null],
    ['a pid written as a string', JSON.stringify({ pid: '4321', status: 'busy' }), null],
    ['an unknown status', JSON.stringify({ pid: 4321, status: 'thinking' }), null],
    ['no status', JSON.stringify({ pid: 4321 }), null],
    // The sibling `<pid>.<hex>.key` file. The sweep filters it by extension, but
    // the parser must not depend on that being the only guard.
    ['the text of a .key sibling', 'd41d8cd98f00b204e9800998ecf8427e', null]
  ])('parses %s', (_what, text, expected) => {
    expect(parseSessionRecord(text as string)).toEqual(expected);
  });
});

describe('reduceSessions', () => {
  it('is silent on the first pass', () => {
    // Every session already open at launch has no history here, and a relaunch
    // after a crash must not perk once per terminal window.
    const { next, events } = reduceSessions(
      new Map(),
      [record(1, 'busy'), record(2, 'waiting'), record(3, 'idle')],
      alive
    );
    expect(events.map(kinds)).toEqual([]);
    expect([...next]).toEqual([
      [1, 'busy'],
      [2, 'waiting'],
      [3, 'idle']
    ]);
  });

  it('says nothing about a pid first seen mid-run either', () => {
    const { next, events } = reduceSessions(map({ 1: 'busy' }), [record(1, 'busy'), record(9, 'waiting')], alive);
    expect(events.map(kinds)).toEqual([]);
    expect(next.get(9)).toBe('waiting');
  });

  it('says nothing when a status has not moved', () => {
    expect(reduceSessions(map({ 1: 'busy' }), [record(1, 'busy')], alive).events.map(kinds)).toEqual([]);
  });

  it('turns busy → waiting into a waiting', () => {
    expect(reduceSessions(map({ 1: 'busy' }), [record(1, 'waiting')], alive).events.map(kinds)).toEqual([
      'waiting'
    ]);
  });

  it('turns busy → idle into a done', () => {
    expect(reduceSessions(map({ 1: 'busy' }), [record(1, 'idle')], alive).events.map(kinds)).toEqual(['done']);
  });

  it('turns anything → busy into a prompt', () => {
    // Work starting is what answers a `?`, whichever state it started from —
    // exactly what `UserPromptSubmit` means on the hook path.
    expect(reduceSessions(map({ 1: 'waiting' }), [record(1, 'busy')], alive).events.map(kinds)).toEqual([
      'prompt'
    ]);
    expect(reduceSessions(map({ 1: 'idle' }), [record(1, 'busy')], alive).events.map(kinds)).toEqual([
      'prompt'
    ]);
  });

  it('says nothing about waiting → idle, because the staleness clock covers it', () => {
    // The hook path has no event for this either: a wait that ends without a
    // prompt is an abandoned one, and `Behaviour.WAITING_STALE_MS` takes the
    // `?` down on its own half an hour later.
    expect(reduceSessions(map({ 1: 'waiting' }), [record(1, 'idle')], alive).events.map(kinds)).toEqual([]);
  });

  it('drops a dead pid and never announces it', () => {
    // Claude Code does not always remove its file on the way out, so a `done`
    // here would be about a session that ended hours ago.
    const { next, events } = reduceSessions(
      map({ 1: 'busy', 2: 'busy' }),
      [record(1, 'idle'), record(2, 'idle')],
      (pid) => pid !== 1
    );
    expect(events.map(kinds)).toEqual(['done']);
    expect(next.has(1)).toBe(false);
    expect(next.get(2)).toBe('idle');
  });

  it('never announces a session that vanished', () => {
    const { next, events } = reduceSessions(map({ 1: 'busy', 2: 'busy' }), [record(2, 'busy')], alive);
    expect(events.map(kinds)).toEqual([]);
    expect(next.has(1)).toBe(false);
  });

  it('carries the pid, the cwd and the sessionId of the record that moved', () => {
    // The kind alone perks the dog. The rest is what the SESSIONS block on the
    // card is a list of — see `core/sessions.ts`.
    const { events } = reduceSessions(
      map({ 7: 'busy' }),
      [{ pid: 7, status: 'waiting', cwd: '/Users/someone/code', sessionId: 'abc-123' }],
      alive
    );
    expect(events).toEqual([
      { kind: 'waiting', pid: 7, cwd: '/Users/someone/code', sessionId: 'abc-123' }
    ]);
  });

  it('omits a cwd and a sessionId the file did not have', () => {
    const { events } = reduceSessions(map({ 7: 'busy' }), [record(7, 'idle')], alive);
    expect(events).toEqual([{ kind: 'done', pid: 7 }]);
  });

  it('lets two sessions transition independently in one sweep', () => {
    const { events } = reduceSessions(
      map({ 1: 'busy', 2: 'idle' }),
      [record(1, 'waiting'), record(2, 'busy')],
      alive
    );
    expect(events.map(kinds)).toEqual(['waiting', 'prompt']);
  });
});

describe('createClaudeSessions', () => {
  /** A fake `~/.claude/sessions`: file name -> contents. */
  let files: Map<string, string>;
  let events: HookEvent[];
  let missing: boolean;

  function sessions(): ReturnType<typeof createClaudeSessions> {
    return createClaudeSessions({
      onEvent: (event) => events.push(event),
      dir: '/fake/sessions',
      readDir: () => {
        if (missing) throw new Error('ENOENT');
        return [...files.keys()];
      },
      readFile: (path) => {
        const name = path.slice('/fake/sessions/'.length);
        const text = files.get(name);
        if (text === undefined) throw new Error('ENOENT');
        return text;
      },
      isAlive: () => true
    });
  }

  function session(pid: number, status: SessionStatus): string {
    return JSON.stringify({ pid, status, cwd: '/somewhere' });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    files = new Map();
    events = [];
    missing = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweeps on start and every two seconds', () => {
    files.set('100.json', session(100, 'busy'));
    const watch = sessions();
    // The immediate sweep is the seed: it sees the open session and says
    // nothing, which is what makes the next one meaningful.
    watch.start();
    expect(events).toEqual([]);

    files.set('100.json', session(100, 'idle'));
    vi.advanceTimersByTime(SESSIONS_POLL_MS);
    expect(events).toEqual([{ kind: 'done', source: 'claude', pid: 100, cwd: '/somewhere' }]);

    files.set('100.json', session(100, 'busy'));
    vi.advanceTimersByTime(SESSIONS_POLL_MS);
    expect(events).toHaveLength(2);
    watch.stop();
  });

  it('emits hook events naming Claude as the source', () => {
    files.set('100.json', session(100, 'idle'));
    const watch = sessions();
    watch.start();
    files.set('100.json', session(100, 'waiting'));
    watch.sweepNow();
    expect(events).toEqual([{ kind: 'waiting', source: 'claude', pid: 100, cwd: '/somewhere' }]);
    watch.stop();
  });

  it('ignores the .key sibling and anything it cannot parse', () => {
    files.set('100.json', session(100, 'busy'));
    files.set('100.a3f9c1.key', 'd41d8cd98f00b204e9800998ecf8427e');
    files.set('101.json', '{"pid":101,"sta');
    const watch = sessions();
    watch.start();

    // The `.key` file is not even read; the half-written one parses to nothing
    // and is simply re-read on the next sweep.
    files.set('100.json', session(100, 'idle'));
    files.set('101.json', session(101, 'idle'));
    watch.sweepNow();
    // 100 transitioned; 101 was never seen before, so it is a first sighting.
    expect(events).toEqual([{ kind: 'done', source: 'claude', pid: 100, cwd: '/somewhere' }]);
    watch.stop();
  });

  it('treats a missing directory as a machine without Claude Code', () => {
    missing = true;
    const watch = sessions();
    expect(() => watch.start()).not.toThrow();
    vi.advanceTimersByTime(SESSIONS_POLL_MS * 3);
    expect(events).toEqual([]);
    watch.stop();
  });

  it('stops the polling, idempotently', () => {
    files.set('100.json', session(100, 'busy'));
    const watch = sessions();
    watch.start();
    watch.stop();
    watch.stop();

    files.set('100.json', session(100, 'idle'));
    vi.advanceTimersByTime(SESSIONS_POLL_MS * 5);
    expect(events).toEqual([]);
  });
});

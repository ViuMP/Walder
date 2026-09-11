import { describe, expect, it } from 'vitest';

import type { Bucket } from '../src/core/buckets.js';
import { NudgeMachine, type NudgeEvent } from '../src/core/nudge.js';

const FIVE_HOUR = 'claude.five_hour';
const OPUS = 'claude.seven_day_opus';
const SEVEN_DAY = 'claude.seven_day';

/** Same ordering the real bucket parser produces. */
function priority(bucketId: string): number {
  if (bucketId.includes('five_hour')) return 0;
  if (bucketId.includes('opus')) return 2;
  return 3;
}

/**
 * A real timestamp, not a sentinel: `resetMoved` parses these, and V8's
 * Date.parse is lenient enough to read a placeholder like 'window-1' as an
 * actual date, which would make these tests pass for the wrong reason.
 */
const WINDOW_1 = '2026-09-08T18:00:00.000Z';
/** The same window, five hours later — a genuine rollover. */
const WINDOW_2 = '2026-09-08T23:00:00.000Z';

/** WINDOW_1 nudged by `seconds`, to model per-request timestamp jitter. */
function jitter(seconds: number): string {
  return new Date(Date.parse(WINDOW_1) + seconds * 1_000).toISOString();
}

function bucket(id: string, pct: number | null, resetsAt: string | null = WINDOW_1): Bucket {
  return {
    id,
    service: 'claude',
    key: id,
    label: id,
    pct,
    resetsAt,
    priority: priority(id)
  };
}

function machine(): NudgeMachine {
  return new NudgeMachine({ priority });
}

const shown = (events: NudgeEvent[]): number[] =>
  events.filter((e) => e.type === 'show').map((e) => e.nudge.level);

describe('NudgeMachine — threshold firing', () => {
  it('fires once when a level is crossed and stays quiet afterwards', () => {
    const m = machine();
    expect(m.onUsage([bucket(FIVE_HOUR, 79)], 0)).toEqual([]);

    const first = m.onUsage([bucket(FIVE_HOUR, 81)], 1_000);
    expect(first).toEqual([
      { type: 'show', nudge: { bucketId: FIVE_HOUR, label: FIVE_HOUR, level: 80, pct: 81 } }
    ]);

    // Same window, still above 80 but below 85 — nothing more to say.
    expect(m.onUsage([bucket(FIVE_HOUR, 82)], 2_000)).toEqual([]);
    expect(m.onUsage([bucket(FIVE_HOUR, 84.9)], 3_000)).toEqual([]);
    expect(m.queued).toEqual([]);
  });

  it('fires only the highest newly crossed level on a jump (78 -> 96 barks 95)', () => {
    const m = machine();
    expect(m.onUsage([bucket(FIVE_HOUR, 78)], 0)).toEqual([]);

    const events = m.onUsage([bucket(FIVE_HOUR, 96)], 1_000);
    expect(shown(events)).toEqual([95]);
    expect(m.queued).toEqual([]);
    expect(m.active?.level).toBe(95);

    // 80, 85 and 90 are now considered spent for this window.
    m.onPet(2_000);
    expect(m.onUsage([bucket(FIVE_HOUR, 99)], 3_000)).toEqual([]);
    expect(shown(m.onUsage([bucket(FIVE_HOUR, 100)], 4_000))).toEqual([100]);
  });

  it('ignores buckets with no percentage', () => {
    const m = machine();
    expect(m.onUsage([bucket(FIVE_HOUR, null)], 0)).toEqual([]);
    expect(m.active).toBeNull();
  });

  it('fires on first sight of an already-high bucket', () => {
    const m = machine();
    expect(shown(m.onUsage([bucket(FIVE_HOUR, 96)], 0))).toEqual([95]);
  });

  it('respects a custom level list', () => {
    const m = new NudgeMachine({ priority, levels: [50, 90] });
    expect(m.onUsage([bucket(FIVE_HOUR, 60)], 0).length).toBe(1);
    expect(m.active?.level).toBe(50);
  });
});

describe('NudgeMachine — window resets', () => {
  it('re-arms when usage drops by more than 2 points', () => {
    const m = machine();
    expect(shown(m.onUsage([bucket(FIVE_HOUR, 81)], 0))).toEqual([80]);
    m.onPet(1_000);

    // A new 5-hour window: usage collapsed.
    expect(m.onUsage([bucket(FIVE_HOUR, 4)], 2_000)).toEqual([]);
    expect(shown(m.onUsage([bucket(FIVE_HOUR, 81)], 3_000))).toEqual([80]);
  });

  it('treats a 2-point-or-less dip as jitter, not a new window', () => {
    const m = machine();
    expect(shown(m.onUsage([bucket(FIVE_HOUR, 82)], 0))).toEqual([80]);
    m.onPet(1_000);
    expect(m.onUsage([bucket(FIVE_HOUR, 80)], 2_000)).toEqual([]);
    expect(m.onUsage([bucket(FIVE_HOUR, 82)], 3_000)).toEqual([]);
  });

  it('re-arms when the reset timestamp moves to a new window', () => {
    const m = machine();
    expect(shown(m.onUsage([bucket(FIVE_HOUR, 81, WINDOW_1)], 0))).toEqual([80]);
    m.onPet(1_000);
    expect(m.onUsage([bucket(FIVE_HOUR, 81, WINDOW_1)], 2_000)).toEqual([]);
    expect(shown(m.onUsage([bucket(FIVE_HOUR, 81, WINDOW_2)], 3_000))).toEqual([80]);
  });

  it('re-arms once when the reset moves 5 hours while usage stays at 96 %', () => {
    const m = machine();
    expect(shown(m.onUsage([bucket(FIVE_HOUR, 96, WINDOW_1)], 0))).toEqual([95]);
    m.onPet(1_000);

    // A real rollover: same high percentage, but a window five hours later.
    expect(shown(m.onUsage([bucket(FIVE_HOUR, 96, WINDOW_2)], 2_000))).toEqual([95]);
    m.onPet(3_000);
    // ...and then it settles again.
    expect(m.onUsage([bucket(FIVE_HOUR, 96, WINDOW_2)], 4_000)).toEqual([]);
  });

  it('barks exactly once through 30-second reset jitter at 96 %', () => {
    const m = machine();
    let shows = 0;

    // Four polls, each reporting a timestamp 30s later than the last — the
    // drift a provider produces by re-deriving the reset per request.
    shows += shown(m.onUsage([bucket(FIVE_HOUR, 96, jitter(0))], 0)).length;
    m.onPet(1_000);
    shows += shown(m.onUsage([bucket(FIVE_HOUR, 96, jitter(30))], 2_000)).length;
    shows += shown(m.onUsage([bucket(FIVE_HOUR, 96, jitter(60))], 3_000)).length;
    shows += shown(m.onUsage([bucket(FIVE_HOUR, 96, jitter(90))], 4_000)).length;

    expect(shows).toBe(1);
    expect(m.active).toBeNull();
    expect(m.queued).toEqual([]);
  });

  it('does not re-arm when resetsAt appears or disappears', () => {
    const m = machine();
    expect(shown(m.onUsage([bucket(FIVE_HOUR, 96, WINDOW_1)], 0))).toEqual([95]);
    m.onPet(1_000);

    // Provider stopped reporting the reset...
    expect(m.onUsage([bucket(FIVE_HOUR, 96, null)], 2_000)).toEqual([]);
    // ...and started again. Neither transition is evidence of a new window.
    expect(m.onUsage([bucket(FIVE_HOUR, 96, WINDOW_1)], 3_000)).toEqual([]);
    expect(m.onUsage([bucket(FIVE_HOUR, 96, null)], 4_000)).toEqual([]);
    expect(m.active).toBeNull();
  });

  it('does not re-arm when an unparseable reset changes', () => {
    const m = machine();
    expect(shown(m.onUsage([bucket(FIVE_HOUR, 96, 'not-a-date-at-all')], 0))).toEqual([95]);
    m.onPet(1_000);
    expect(m.onUsage([bucket(FIVE_HOUR, 96, 'still-not-a-date')], 2_000)).toEqual([]);
  });
});

describe('NudgeMachine — exact threshold boundaries', () => {
  it('fires at exactly 80.0 on first sight', () => {
    const m = machine();
    const events = m.onUsage([bucket(FIVE_HOUR, 80)], 0);
    expect(shown(events)).toEqual([80]);
    expect(m.active?.pct).toBe(80);
  });

  it('fires at exactly 100.0 on first sight, and only the top level', () => {
    const m = machine();
    const events = m.onUsage([bucket(FIVE_HOUR, 100)], 0);
    expect(shown(events)).toEqual([100]);
    expect(m.queued).toEqual([]);
  });

  it('stays quiet just below a threshold', () => {
    const m = machine();
    expect(m.onUsage([bucket(FIVE_HOUR, 79.9)], 0)).toEqual([]);
    expect(shown(m.onUsage([bucket(FIVE_HOUR, 80)], 1_000))).toEqual([80]);
  });

  it('has nothing left to say once 100 has fired', () => {
    const m = machine();
    m.onUsage([bucket(FIVE_HOUR, 100)], 0);
    m.onPet(1_000);
    expect(m.onUsage([bucket(FIVE_HOUR, 100)], 2_000)).toEqual([]);
    expect(m.onUsage([bucket(FIVE_HOUR, 120)], 3_000)).toEqual([]);
  });
});

describe('NudgeMachine — bucket state lifetime', () => {
  const T0 = Date.parse('2026-09-08T12:00:00.000Z');

  it('does not re-arm a bucket that vanishes and returns at the same pct', () => {
    const m = machine();
    expect(shown(m.onUsage([bucket(FIVE_HOUR, 96)], T0))).toEqual([95]);
    m.onPet(T0 + 1_000);

    // A provider poll failed, so the bucket is simply absent...
    expect(m.onUsage([], T0 + 2_000)).toEqual([]);
    expect(m.onUsage([bucket(SEVEN_DAY, 10)], T0 + 3_000)).toEqual([]);
    // ...and it comes back unchanged. Its state must have survived.
    expect(m.onUsage([bucket(FIVE_HOUR, 96)], T0 + 4_000)).toEqual([]);
    expect(m.active).toBeNull();
  });

  it('keeps the state of an absent bucket whose window has not long expired', () => {
    const m = machine();
    const soon = new Date(T0 + 3_600_000).toISOString();
    m.onUsage([bucket(FIVE_HOUR, 96, soon)], T0);
    m.onPet(T0 + 1_000);

    // Absent, and its window ended an hour ago — still inside the 24h grace.
    m.onUsage([], T0 + 2 * 3_600_000);
    expect(m.onUsage([bucket(FIVE_HOUR, 96, soon)], T0 + 3 * 3_600_000)).toEqual([]);
  });

  it('prunes an absent bucket whose window expired more than 24h ago', () => {
    const m = machine();
    const oldWindow = new Date(T0).toISOString();
    m.onUsage([bucket(FIVE_HOUR, 96, oldWindow)], T0);
    m.onPet(T0 + 1_000);

    // Absent two days later: the state is forgotten, so the bucket is treated
    // as brand new if it ever reappears.
    const twoDaysLater = T0 + 2 * 24 * 3_600_000;
    m.onUsage([], twoDaysLater);
    expect(shown(m.onUsage([bucket(FIVE_HOUR, 96, oldWindow)], twoDaysLater + 1_000))).toEqual([95]);
  });

  it('keeps the state of an absent bucket with no readable resetsAt', () => {
    const m = machine();
    m.onUsage([bucket(FIVE_HOUR, 96, null)], T0);
    m.onPet(T0 + 1_000);

    const muchLater = T0 + 30 * 24 * 3_600_000;
    m.onUsage([], muchLater);
    // No evidence the window ended, so nothing is pruned and nothing re-barks.
    expect(m.onUsage([bucket(FIVE_HOUR, 96, null)], muchLater + 1_000)).toEqual([]);
  });
});

describe('NudgeMachine — queueing and priority', () => {
  const allHigh = [bucket(SEVEN_DAY, 96), bucket(OPUS, 97), bucket(FIVE_HOUR, 98)];

  it('shows the highest-priority crossing and queues the rest in order', () => {
    const m = machine();
    const events = m.onUsage(allHigh, 0);

    expect(events).toHaveLength(1);
    expect(m.active?.bucketId).toBe(FIVE_HOUR);
    expect(m.queued.map((n) => n.bucketId)).toEqual([OPUS, SEVEN_DAY]);
  });

  it('drains the queue one pet at a time', () => {
    const m = machine();
    m.onUsage(allHigh, 0);

    const second = m.onPet(1_000);
    expect(second.map((e) => e.type)).toEqual(['clear', 'show']);
    expect(m.active?.bucketId).toBe(OPUS);

    const third = m.onPet(2_000);
    expect(third.map((e) => e.type)).toEqual(['clear', 'show']);
    expect(m.active?.bucketId).toBe(SEVEN_DAY);

    const last = m.onPet(3_000);
    expect(last).toEqual([{ type: 'clear' }]);
    expect(m.active).toBeNull();
    expect(m.queued).toEqual([]);
  });

  it('is a no-op when petted with nothing showing', () => {
    const m = machine();
    expect(m.onPet(0)).toEqual([]);
  });

  it('stays idle after a usage snapshot that crossed nothing', () => {
    /*
     * Was 'is a no-op when ticked before anything has ever been shown'. There is
     * no clock left to tick: the twelve-second auto-dismiss went in 0.2.2,
     * because the owner had never once seen the 80 % bark — twelve seconds out
     * of a three-minute poll, while he was looking at his editor.
     *
     * What survives of the original worry is its second half, and it is the half
     * that was always the real one: a poll below every threshold must not invent
     * a bark, and must leave nothing queued for the next pet to promote.
     */
    const m = machine();
    expect(m.onUsage([bucket(FIVE_HOUR, 10)], 0)).toEqual([]);
    expect(m.active).toBeNull();
    expect(m.queued).toEqual([]);
    // …and the only thing that retires a bark finds nothing to retire.
    expect(m.onPet(1_000_000)).toEqual([]);
  });

  it('supersedes a queued bark for the same bucket rather than queueing twice', () => {
    const m = machine();
    m.onUsage([bucket(FIVE_HOUR, 98), bucket(SEVEN_DAY, 81)], 0);
    expect(m.active?.bucketId).toBe(FIVE_HOUR);
    expect(m.queued).toEqual([{ bucketId: SEVEN_DAY, label: SEVEN_DAY, level: 80, pct: 81 }]);

    // seven_day climbs again while still queued.
    m.onUsage([bucket(FIVE_HOUR, 98), bucket(SEVEN_DAY, 96)], 1_000);
    expect(m.queued).toHaveLength(1);
    expect(m.queued[0]?.level).toBe(95);
  });
});

describe('NudgeMachine — a bark stays until it is dismissed or superseded', () => {
  /*
   * The machine used to own a twelve-second clock. It was removed in 0.2.2 —
   * see the note beside `NudgeMachineOptions`. The owner had never seen the 80 %
   * bark, which is the arithmetic working as designed (twelve seconds out of a
   * three-minute poll) rather than a bug, and the fix for that is to stop taking
   * the warning away from him.
   */
  it('keeps the bark up indefinitely — only a pet retires it', () => {
    const m = machine();
    m.onUsage([bucket(FIVE_HOUR, 81)], 1_000);
    expect(m.active?.level).toBe(80);

    // An hour of nothing happening.
    expect(m.onUsage([bucket(FIVE_HOUR, 81)], 3_601_000)).toEqual([]);
    expect(m.active?.level).toBe(80);

    expect(m.onPet(3_602_000)).toEqual([{ type: 'clear' }]);
    expect(m.active).toBeNull();
  });

  it('promotes the next queued bark on a pet, not on a clock', () => {
    const m = machine();
    m.onUsage([bucket(FIVE_HOUR, 96), bucket(SEVEN_DAY, 96)], 0);
    expect(m.active?.bucketId).toBe(FIVE_HOUR);

    const events = m.onPet(5_000);
    expect(events.map((e) => e.type)).toEqual(['clear', 'show']);
    expect(m.active?.bucketId).toBe(SEVEN_DAY);
  });

  it("lets a window's own later crossing take the screen from its older bark", () => {
    /*
     * The rule that keeps the queue bounded now that nothing expires. Without
     * it, an 80 % bark waiting for a click would sit on screen while 85, 90 and
     * 95 piled up behind it — the number shown getting staler the worse things
     * got.
     *
     * `show` with no `clear` before it, deliberately: the consumer overwrites
     * the bubble's text in place. There is nothing to dismiss, because the bark
     * being replaced is about the same allowance as the one replacing it.
     */
    const m = machine();
    m.onUsage([bucket(FIVE_HOUR, 81)], 0);
    expect(m.active?.level).toBe(80);

    const higher = m.onUsage([bucket(FIVE_HOUR, 86)], 180_000);
    expect(higher).toEqual([{ type: 'show', nudge: m.active }]);
    expect(m.active?.level).toBe(85);
    expect(m.queued).toEqual([]);
  });

  it('does not let a different window steal the screen', () => {
    // A second window is a second fact. It queues, and one pet at a time walks
    // through them — swallowing it would lose a warning nobody has seen.
    const m = machine();
    m.onUsage([bucket(FIVE_HOUR, 81)], 0);
    expect(m.onUsage([bucket(SEVEN_DAY, 96)], 180_000)).toEqual([]);
    expect(m.active?.bucketId).toBe(FIVE_HOUR);
    expect(m.queued.map((n) => n.bucketId)).toEqual([SEVEN_DAY]);
  });
});

describe('NudgeMachine — fullscreen sleep/wake', () => {
  it('sleeps on entering fullscreen with nothing to say, and wakes on leaving', () => {
    const m = machine();
    expect(m.setFullscreen(true, 0)).toEqual([{ type: 'sleep' }]);
    expect(m.setFullscreen(false, 1_000)).toEqual([{ type: 'wake' }]);
  });

  it('emits nothing for a repeated fullscreen state', () => {
    const m = machine();
    expect(m.setFullscreen(true, 0)).toEqual([{ type: 'sleep' }]);
    expect(m.setFullscreen(true, 1_000)).toEqual([]);
    expect(m.setFullscreen(false, 2_000)).toEqual([{ type: 'wake' }]);
    expect(m.setFullscreen(false, 3_000)).toEqual([]);
  });

  it('wakes before showing a bark that arrives during fullscreen', () => {
    const m = machine();
    m.setFullscreen(true, 0);

    const events = m.onUsage([bucket(FIVE_HOUR, 96)], 1_000);
    expect(events.map((e) => e.type)).toEqual(['wake', 'show']);
    expect(shown(events)).toEqual([95]);
  });

  it('goes back to sleep once the last bark is dismissed in fullscreen', () => {
    const m = machine();
    m.setFullscreen(true, 0);
    m.onUsage([bucket(FIVE_HOUR, 96)], 1_000);

    expect(m.onPet(2_000)).toEqual([{ type: 'clear' }, { type: 'sleep' }]);
    // Leaving fullscreen then wakes him exactly once.
    expect(m.setFullscreen(false, 3_000)).toEqual([{ type: 'wake' }]);
  });

  it('stays awake between queued barks in fullscreen and sleeps only at the end', () => {
    const m = machine();
    m.setFullscreen(true, 0);
    m.onUsage([bucket(FIVE_HOUR, 96), bucket(SEVEN_DAY, 96)], 1_000);

    expect(m.onPet(2_000).map((e) => e.type)).toEqual(['clear', 'show']);
    expect(m.onPet(3_000)).toEqual([{ type: 'clear' }, { type: 'sleep' }]);
  });

  it('does not sleep when fullscreen starts while a bark is showing', () => {
    const m = machine();
    m.onUsage([bucket(FIVE_HOUR, 96)], 0);
    expect(m.setFullscreen(true, 1_000)).toEqual([]);
    // Leaving fullscreen without ever sleeping emits no wake either.
    expect(m.setFullscreen(false, 2_000)).toEqual([]);
  });
});

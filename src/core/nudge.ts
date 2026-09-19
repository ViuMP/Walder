/**
 * The bark state machine: decides *when* Walder should bark about a usage
 * threshold, which bark wins when several cross at once, and when he goes to
 * sleep because a fullscreen video is playing.
 *
 * Pure: no timers, no electron, no I/O. The caller owns the clock and feeds
 * `now` (ms epoch) into every method, so the whole thing is deterministic and
 * testable.
 */
import type { Bucket } from './buckets.js';

export interface Nudge {
  bucketId: string;
  label: string;
  /** The threshold that was crossed, e.g. 95. */
  level: number;
  /** The percentage observed when it fired. */
  pct: number;
}

export type NudgeEvent =
  | { type: 'show'; nudge: Nudge }
  | { type: 'clear' }
  | { type: 'sleep' }
  | { type: 'wake' };

/**
 * How often Walder speaks up as a window climbs — wired end to end the same
 * way `ResetStyle` is (see `core/buckets.ts`): a settings-file value, a tray
 * radio group, and, here, the one consumer that actually reads it.
 *
 *  - **`'quiet'`** — only the two levels that are actually urgent: 95, 100.
 *  - **`'normal'`** — today's five, unchanged: 80, 85, 90, 95, 100.
 *  - **`'chatty'`** — every 10 %, for an owner who wants the whole climb.
 */
export type BarkPreset = 'quiet' | 'normal' | 'chatty';

/**
 * Menu order. Quietest to loudest, not default-first (contrast
 * `RESET_STYLES`, which leads with its default): there is no "reach for this
 * one" option here the way clock time is for reset wording, so the order that
 * reads best is the one that is already a scale.
 */
export const BARK_PRESETS: readonly BarkPreset[] = ['quiet', 'normal', 'chatty'];

/**
 * The thresholds each preset barks at. `normal` is exactly the levels this
 * machine has always used, read from here now instead of inlined in the
 * constructor below, so the shipped default and the menu's "Normal" option
 * can never quietly drift apart.
 */
export const BARK_LEVELS: Readonly<Record<BarkPreset, readonly number[]>> = {
  quiet: [95, 100],
  normal: [80, 85, 90, 95, 100],
  chatty: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
};

/** Same default this machine already had before presets existed. */
export const DEFAULT_BARK_PRESET: BarkPreset = 'normal';

export function isBarkPreset(value: unknown): value is BarkPreset {
  return value === 'quiet' || value === 'normal' || value === 'chatty';
}

export interface NudgeMachineOptions {
  /** Thresholds to bark at. Default `BARK_LEVELS.normal`. */
  levels?: number[];
  /** Display order for simultaneous crossings — lower wins. */
  priority: (bucketId: string) => number;
  /**
   * A `NudgeMemory` from a previous run, as it came off disk — hence `unknown`.
   *
   * The file it travels in is user-writable and its shape can drift between
   * versions, so nothing here trusts it: `restoreBuckets` validates every
   * field of every entry and silently drops whatever it cannot read. A junk
   * memory therefore costs at most one duplicate bark, never a throw at
   * startup.
   */
  memory?: unknown;
}

/**
 * The part of this machine that is worth surviving a quit: the per-bucket
 * once-per-threshold memory.
 *
 * The queue and the bark on screen are deliberately **not** in here. The owner
 * asked for the memory to persist, not for the app to re-open a bubble he was
 * looking at when he quit: a bark that was up at quit is simply not re-shown,
 * and the level it announced is recorded as announced, which is exactly what
 * stops it coming back. Anything still queued behind it is about a window whose
 * number is three minutes stale by the next launch anyway — the first poll
 * re-derives it, and re-derives it *current*.
 */
export interface NudgeMemory {
  buckets: Record<string, { lastFired: number; lastPct: number | null; resetsAt: string | null }>;
}

/*
 * There is deliberately no `autoDismissMs` and no `onTick`.
 *
 * A bark used to take itself down after twelve seconds. The owner reported
 * (2026-09-11) that he had never seen the 80 % bark at all — which is the
 * arithmetic working as designed rather than a bug: polls are three minutes
 * apart, the warning was up for twelve seconds of one of them, and the rest of
 * the time he was looking at his editor. A warning you have to be looking at the
 * corner of the screen to receive is not a warning.
 *
 * A bark now stays until `onPet`. The cost is that the queue no longer drains on
 * its own, which is what `onUsage`'s supersede rule below exists to bound.
 */

/** Per-bucket memory, so a bark fires once per window and not once per poll. */
interface BucketState {
  /** Highest level already barked in this window; -1 = nothing yet. */
  lastFired: number;
  lastPct: number | null;
  resetsAt: string | null;
}

/**
 * A drop larger than this is worth reconsidering at all; anything smaller is
 * jitter and changes nothing.
 *
 * Kept exactly as it was when a drop re-armed the whole bucket — see the rule
 * in `onUsage`, which now lowers `lastFired` to what the new reading justifies
 * instead of wiping it. The guard is still needed: without it, a rolling
 * window shedding a single point would walk `lastFired` down one level at a
 * time and bark its way back up.
 */
const WINDOW_RESET_DROP = 2;

/**
 * How far a reset timestamp must move before it counts as a new window.
 *
 * Providers re-derive these timestamps per request, so a stable window's
 * `resetsAt` wobbles by seconds between polls — and where only a relative
 * offset is available it re-anchors to poll time and drifts on *every*
 * refresh. A strict `!==` therefore re-armed the machine on every poll, so a
 * bucket parked at 96 % barked forever. One minute is far wider than any
 * jitter and far narrower than a real window rollover (5 hours at the
 * shortest).
 */
const RESET_MOVE_TOLERANCE_MS = 60_000;

/**
 * True only when both timestamps exist, both parse to finite epochs, and they
 * differ by more than the tolerance.
 *
 * A `null` on either side is "we do not know", not "the window changed": a
 * provider that starts or stops reporting `resets_at` — or a parser that
 * cannot read it this poll — must not be able to re-arm a bark. When a window
 * genuinely rolls over, usage collapses with it, and the pct-drop rule catches
 * that on its own.
 */
function resetMoved(oldResetsAt: string | null, newResetsAt: string | null): boolean {
  if (oldResetsAt === null || newResetsAt === null) return false;
  const before = Date.parse(oldResetsAt);
  const after = Date.parse(newResetsAt);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return false;
  return Math.abs(after - before) > RESET_MOVE_TOLERANCE_MS;
}

/** How far in the past a bucket's reset must be before its state is prunable. */
const STALE_STATE_MS = 24 * 60 * 60 * 1000;

/**
 * Rebuild the per-bucket map from whatever came off disk.
 *
 * Defensive at every level, because every level is user-writable: a `memory`
 * that is not an object, a `buckets` that is not a record (an array included —
 * `Object.entries` would happily hand back index keys), or an entry with a
 * field of the wrong type are all treated as "we have no memory of that",
 * silently. Nothing here throws and nothing warns: the worst case is a bark the
 * owner has already seen, which is precisely the cost this whole feature is
 * paid to reduce — spending a crash on it would be a bad trade.
 *
 * `lastFired` must be an integer >= -1 because that is the vocabulary the level
 * bookkeeping speaks (-1 = nothing barked yet); a fractional or negative value
 * would compare in ways no level ever produces.
 */
function restoreBuckets(memory: unknown): Map<string, BucketState> {
  const state = new Map<string, BucketState>();
  if (typeof memory !== 'object' || memory === null) return state;
  const buckets = (memory as { buckets?: unknown }).buckets;
  if (typeof buckets !== 'object' || buckets === null || Array.isArray(buckets)) return state;

  for (const [id, raw] of Object.entries(buckets as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as { lastFired?: unknown; lastPct?: unknown; resetsAt?: unknown };
    const { lastFired, lastPct, resetsAt } = entry;
    if (typeof lastFired !== 'number' || !Number.isInteger(lastFired) || lastFired < -1) continue;
    if (lastPct !== null && (typeof lastPct !== 'number' || !Number.isFinite(lastPct))) continue;
    if (resetsAt !== null && typeof resetsAt !== 'string') continue;
    state.set(id, { lastFired, lastPct, resetsAt });
  }
  return state;
}

export class NudgeMachine {
  private levels: number[];
  private readonly priority: (bucketId: string) => number;

  private readonly state: Map<string, BucketState>;
  private queue: Nudge[] = [];
  private activeNudge: Nudge | null = null;
  private fullscreen = false;
  private asleep = false;

  constructor(opts: NudgeMachineOptions) {
    this.levels = [...(opts.levels ?? BARK_LEVELS.normal)].sort((a, b) => a - b);
    this.priority = opts.priority;
    this.state = restoreBuckets(opts.memory);
  }

  get active(): Nudge | null {
    return this.activeNudge;
  }

  /**
   * What this machine would need to know after a relaunch to stay quiet about
   * levels it has already announced. See `NudgeMemory` for what is left out.
   */
  memory(): NudgeMemory {
    const buckets: NudgeMemory['buckets'] = {};
    for (const [id, st] of this.state) {
      buckets[id] = { lastFired: st.lastFired, lastPct: st.lastPct, resetsAt: st.resetsAt };
    }
    return { buckets };
  }

  get queued(): Nudge[] {
    return [...this.queue];
  }

  /**
   * Feed a fresh usage snapshot. Emits at most one `show` (preceded by `wake`
   * if asleep); everything else that crossed is queued behind it.
   */
  onUsage(buckets: Bucket[], now: number): NudgeEvent[] {
    const crossings: Nudge[] = [];

    for (const bucket of buckets) {
      if (bucket.pct === null || !Number.isFinite(bucket.pct)) continue;
      const pct = bucket.pct;

      const prev = this.state.get(bucket.id);
      const st: BucketState = prev ?? {
        lastFired: -1,
        lastPct: null,
        resetsAt: bucket.resetsAt
      };

      /*
       * A new window re-arms the machine — but a mere *drop* re-arms it only as
       * far as the new reading justifies.
       *
       * The owner reported (2026-09-15) a bark at 81 % moments after one at
       * 80 %. The 5-hour window is a rolling one: it sheds its oldest requests
       * continuously, so a reading wobbles down a few points and climbs back
       * inside a poll or two. The old rule — any drop over `WINDOW_RESET_DROP`
       * wipes `lastFired` — read 84 → 81 as a fresh window and re-announced 80
       * about an allowance he had already been warned about.
       *
       * So a drop lowers `lastFired` to the highest level the new reading is
       * still at or above, and no further:
       *   84 → 81 keeps 80 fired, so nothing is re-announced;
       *   96 → 81 lowers 95 to 80, so 85 barks again on the way back up —
       *        which it should, that is a level he has not been told about
       *        since the number was last below it;
       *   82 → 79 is below every level and re-arms completely.
       *
       * A *moved reset* is still a full reset, and stays a separate branch: it
       * is the provider stating a new window rather than a number wobbling, and
       * a genuine rollover starts from nothing whatever the last reading was.
       */
      const dropped = st.lastPct !== null && pct < st.lastPct - WINDOW_RESET_DROP;
      if (resetMoved(st.resetsAt, bucket.resetsAt)) st.lastFired = -1;
      else if (dropped) st.lastFired = Math.min(st.lastFired, this.highestLevelAtOrBelow(pct));

      st.lastPct = pct;
      st.resetsAt = bucket.resetsAt;

      // Fire only the highest newly crossed level: 78 -> 96 barks 95, not
      // 80, 85, 90 and 95 in a row.
      let highest = -1;
      for (const level of this.levels) {
        if (pct >= level && level > st.lastFired && level > highest) highest = level;
      }
      if (highest > -1) {
        st.lastFired = highest;
        crossings.push({ bucketId: bucket.id, label: bucket.label, level: highest, pct });
      }

      this.state.set(bucket.id, st);
    }

    this.pruneState(buckets, now);

    if (crossings.length === 0) return [];

    crossings.sort(
      (a, b) => this.priority(a.bucketId) - this.priority(b.bucketId) || b.level - a.level
    );

    for (const nudge of crossings) {
      // One pending bark per bucket — a later, higher level supersedes it.
      this.queue = this.queue.filter((q) => q.bucketId !== nudge.bucketId);
      this.queue.push(nudge);
    }

    /*
     * A fresh crossing of the window that is ALREADY barking takes the screen
     * from its own older bark.
     *
     * Only necessary since barks stopped expiring, and then unavoidable: an
     * 80 % bark that waits for a click would otherwise sit there while 85, 90
     * and 95 queued invisibly behind it, so the number on screen would get
     * staler the worse things got — the exact opposite of what a threshold
     * warning is for.
     *
     * Retired WITHOUT a `clear`, so the consumer overwrites the bubble's text
     * in place rather than taking one down and putting another up. The blink
     * that would cause is invisible at three-minute poll spacing and obvious on
     * a manual refresh, and there is nothing to dismiss anyway: the bark being
     * replaced is about the same allowance as the one replacing it.
     *
     * Only the row's OWN later reading supersedes it. Another window is a
     * different fact and stays queued for the next pet — swallowing it would
     * lose a warning the owner has never seen.
     */
    const active = this.activeNudge;
    if (active !== null && this.queue.some((q) => q.bucketId === active.bucketId)) {
      this.activeNudge = null;
    }

    const events: NudgeEvent[] = [];
    if (this.activeNudge === null) this.promote(now, events);
    return events;
  }

  /** The owner clicked/petted Walder: dismiss the current bark, show the next. */
  onPet(now: number): NudgeEvent[] {
    if (this.activeNudge === null) return [];
    return this.dismiss(now);
  }

  /**
   * Switch bark presets without losing what has already fired.
   *
   * Only `levels` changes here — `state` (`lastFired` per bucket) is untouched
   * — so a switch never re-announces a level the owner has already been told
   * about: quiet's 95 having fired stays fired on a switch back to normal, and
   * normal's 85 having fired at pct 87 stays fired on a switch to chatty at
   * that same reading.
   *
   * One case is worth naming rather than leaving as a surprise: switching to a
   * preset with MORE levels can expose thresholds *below* the current pct that
   * were never individually announced — chatty's 10/20/…/70 all sit below a
   * `lastFired` of 85. They stay silent, because `onUsage`'s crossing check is
   * `level > st.lastFired` and nothing here lowers `lastFired` to make room for
   * them. That is the desired behaviour, not a gap: the owner already knows the
   * number is past all of them, and re-barking seven levels at once on the very
   * next poll would be the storm this method exists to avoid, not a report.
   */
  setLevels(levels: readonly number[]): void {
    this.levels = [...levels].sort((a, b) => a - b);
  }

  /**
   * Fullscreen video started/stopped. Entering fullscreen with nothing to say
   * puts Walder to sleep; a bark that arrives later wakes him first.
   */
  setFullscreen(fs: boolean, _now: number): NudgeEvent[] {
    if (fs === this.fullscreen) return [];
    this.fullscreen = fs;

    if (fs) {
      if (this.activeNudge === null && !this.asleep) {
        this.asleep = true;
        return [{ type: 'sleep' }];
      }
      return [];
    }

    if (this.asleep) {
      this.asleep = false;
      return [{ type: 'wake' }];
    }
    return [];
  }

  /**
   * The highest configured level this reading is still at or above, or -1 when
   * it is below all of them. `levels` is sorted ascending in the constructor,
   * so the last match wins.
   */
  private highestLevelAtOrBelow(pct: number): number {
    let highest = -1;
    for (const level of this.levels) if (pct >= level) highest = level;
    return highest;
  }

  /**
   * Forget buckets that are both gone and long expired.
   *
   * Deliberately conservative on two axes. A bucket missing from *this*
   * snapshot is usually a provider that failed a single poll — dropping its
   * state would reset `lastFired` and make it bark again the moment it comes
   * back at the same percentage — so absence alone never prunes. And a state
   * whose `resetsAt` is unknown or unparseable is kept, because there is no
   * evidence it is stale. Only a bucket that is absent *and* whose window
   * demonstrably ended more than 24 h ago is dropped, which keeps the map from
   * growing without bound as providers rename their windows.
   */
  private pruneState(buckets: Bucket[], now: number): void {
    if (this.state.size === 0) return;
    const present = new Set(buckets.map((b) => b.id));

    for (const [id, st] of this.state) {
      if (present.has(id)) continue;
      if (st.resetsAt === null) continue;
      const resetsAt = Date.parse(st.resetsAt);
      if (!Number.isFinite(resetsAt)) continue;
      if (now - resetsAt > STALE_STATE_MS) this.state.delete(id);
    }
  }

  private promote(now: number, events: NudgeEvent[]): void {
    const next = this.queue.shift();
    if (next === undefined) return;
    if (this.asleep) {
      this.asleep = false;
      events.push({ type: 'wake' });
    }
    this.activeNudge = next;
    events.push({ type: 'show', nudge: next });
  }

  private dismiss(now: number): NudgeEvent[] {
    const events: NudgeEvent[] = [{ type: 'clear' }];
    this.activeNudge = null;

    if (this.queue.length > 0) {
      this.promote(now, events);
    } else if (this.fullscreen && !this.asleep) {
      this.asleep = true;
      events.push({ type: 'sleep' });
    }
    return events;
  }
}

// TODO(M3+): external, non-usage triggers — 'perk-done' when Claude Code
// finishes a reply and 'perk-waiting' when it wants input — belong in a
// separate coordinator that arbitrates between this machine and those events.
// Deliberately NOT an `injectExternal` method here: this class stays focused on
// usage-threshold nudges so its window/level bookkeeping stays provable.

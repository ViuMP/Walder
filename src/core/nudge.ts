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

export interface NudgeMachineOptions {
  /** Thresholds to bark at. Default [80, 85, 90, 95, 100]. */
  levels?: number[];
  /** Display order for simultaneous crossings — lower wins. */
  priority: (bucketId: string) => number;
  /** How long a bark stays up before `onTick` dismisses it. Default 12000. */
  autoDismissMs?: number;
}

/** Per-bucket memory, so a bark fires once per window and not once per poll. */
interface BucketState {
  /** Highest level already barked in this window; -1 = nothing yet. */
  lastFired: number;
  lastPct: number | null;
  resetsAt: string | null;
}

/** A drop larger than this counts as a fresh window rather than jitter. */
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

export class NudgeMachine {
  private readonly levels: number[];
  private readonly priority: (bucketId: string) => number;
  private readonly autoDismissMs: number;

  private readonly state = new Map<string, BucketState>();
  private queue: Nudge[] = [];
  private activeNudge: Nudge | null = null;
  private activeSince: number | null = null;
  private fullscreen = false;
  private asleep = false;

  constructor(opts: NudgeMachineOptions) {
    this.levels = [...(opts.levels ?? [80, 85, 90, 95, 100])].sort((a, b) => a - b);
    this.priority = opts.priority;
    this.autoDismissMs = opts.autoDismissMs ?? 12_000;
  }

  get active(): Nudge | null {
    return this.activeNudge;
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

      // A new window: usage fell materially, or the provider moved the reset
      // by more than timestamp jitter.
      const dropped = st.lastPct !== null && pct < st.lastPct - WINDOW_RESET_DROP;
      if (dropped || resetMoved(st.resetsAt, bucket.resetsAt)) st.lastFired = -1;

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

    const events: NudgeEvent[] = [];
    if (this.activeNudge === null) this.promote(now, events);
    return events;
  }

  /** The owner clicked/petted Walder: dismiss the current bark, show the next. */
  onPet(now: number): NudgeEvent[] {
    if (this.activeNudge === null) return [];
    return this.dismiss(now);
  }

  /** Call on a timer; auto-dismisses a bark that has been up long enough. */
  onTick(now: number): NudgeEvent[] {
    if (this.activeNudge === null || this.activeSince === null) return [];
    if (now - this.activeSince < this.autoDismissMs) return [];
    return this.dismiss(now);
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
    this.activeSince = now;
    events.push({ type: 'show', nudge: next });
  }

  private dismiss(now: number): NudgeEvent[] {
    const events: NudgeEvent[] = [{ type: 'clear' }];
    this.activeNudge = null;
    this.activeSince = null;

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

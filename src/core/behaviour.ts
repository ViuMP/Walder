/**
 * The behaviour coordinator: everything that decides what Walder is doing.
 *
 * Four independent things want the dog's attention — usage thresholds, Claude
 * Code hook events, the owner's clicks, and a fullscreen video — and they must
 * not fight. This class arbitrates between them and emits a flat list of
 * `SceneEvent`s describing the *result*: which face, which bubble, which
 * animation, which sprite box. `main/behaviour.ts` is the only thing that turns
 * those into IPC and window calls.
 *
 * Pure: no timers, no electron, no I/O. Every method takes `now` (ms epoch), so
 * the whole thing is driven deterministically in tests — and `nextDeadlineAt`
 * tells the caller when to come back rather than expecting a heartbeat.
 *
 * **Why the `NudgeMachine` is reused rather than absorbed.** All the hard usage
 * bookkeeping — one bark per threshold per window, window-rollover detection,
 * simultaneous crossings, the 12 s auto-dismiss — lives there and stays there.
 * What this class adds is arbitration with events the machine deliberately knows
 * nothing about (see the TODO at the end of `nudge.ts`).
 *
 * **Fullscreen is owned here, not by the machine.** The machine has its own
 * `setFullscreen`, but its sleep/wake decision can only see barks: it would put
 * Walder to sleep on top of a live perk bubble. So this class never calls it,
 * derives `asleep` from "fullscreen and nothing on screen", and ignores the
 * machine's `sleep`/`wake` events (which, with its fullscreen flag left false,
 * it never emits anyway).
 *
 * **Animation names, not animation indices.** Every `play` event names an
 * animation (`bark`, `pet`, `perk`, `tilt`, `wake`, `sleep`). The real art is
 * still being drawn, so the renderer falls back to `idle` — or `sleep` in the
 * sleep box — for any name the loaded sheet does not have. Nothing here needs to
 * know which frames exist.
 */
import { expressionFor, type Expression } from './expression';
import { NudgeMachine, type NudgeEvent } from './nudge';
import { PERK_TEXT, SLEEP_TEXT, WAITING_TEXT, nudgeText, type BubbleKind } from './bubble';
import type { Bucket } from './buckets';
import { pctForFace, type UsageSnapshot } from './usage';
// Type-only, and `main/ipc.ts` is itself deliberately electron-free: `BoxName`
// is the IPC vocabulary for the sprite box, and duplicating it here would let
// the two drift.
import type { BoxName } from '../main/ipc';

/**
 * Where the dog is left when a `play` finishes.
 *
 * `idle` and `sleep` both mean "release to the normal per-box, per-expression
 * loop" — which one is named says what the coordinator expects the box to be, so
 * a mismatch is visible in a test. `hold` parks on the animation's last frame,
 * which is what a head-tilt that must stay tilted needs.
 */
export type PlayThen = 'idle' | 'hold' | 'sleep';

export type SceneEvent =
  | { readonly type: 'expression'; readonly expression: Expression }
  | {
      readonly type: 'bubble';
      readonly text: string;
      readonly kind: BubbleKind;
      /** `null` = stays until dismissed. `0` accompanies a `none` (a clear). */
      readonly ttlMs: number | null;
    }
  | { readonly type: 'play'; readonly animation: string; readonly then: PlayThen }
  | { readonly type: 'mode'; readonly box: BoxName };

/** What the Claude Code hook server reports. */
export type HookKind = 'done' | 'waiting' | 'prompt';

/** How long a usage bark stays up. Must match the machine's auto-dismiss. */
export const NUDGE_TTL_MS = 12_000;

/** How long a perk ("woof") stays up. */
export const PERK_TTL_MS = 5_000;

/**
 * How long the `…zzz` a pet earns from a sleeping dog stays up. Short: it is an
 * acknowledgement, not a message.
 */
export const SLEEP_PET_TTL_MS = 1_500;

export const ANIM_BARK = 'bark';
export const ANIM_PET = 'pet';
export const ANIM_PERK = 'perk';
export const ANIM_TILT = 'tilt';
export const ANIM_WAKE = 'wake';
export const ANIM_SLEEP = 'sleep';
/** A twitch in the sleeping box. Optional art — see `onPet`. */
export const ANIM_SLEEP_PET = 'sleep_pet';

/** Priority used for a bucket whose snapshot has not been seen yet. */
const UNKNOWN_PRIORITY = 99;

/** The bubble currently on screen. */
export interface ActiveBubble {
  readonly kind: 'nudge' | 'perk' | 'waiting' | 'sleepy';
  readonly text: string;
  /** `null` for a bubble with no time limit (the waiting `?`). */
  readonly ttlMs: number | null;
  readonly shownAt: number;
}

/** An external event waiting for the screen to clear. */
interface PendingExternal {
  readonly kind: 'perk' | 'waiting';
  readonly text: string;
  readonly ttlMs: number | null;
  readonly animation: string;
}

export interface BehaviourOptions {
  /** Thresholds to bark at; passed through to the `NudgeMachine`. */
  readonly levels?: number[];
  readonly nudgeTtlMs?: number;
  readonly perkTtlMs?: number;
  readonly sleepPetTtlMs?: number;
  /**
   * Does the loaded sheet have this animation?
   *
   * The coordinator normally does not care — the renderer falls back to the
   * idle loop for any name it does not have, which is what makes behaviour and
   * art independent. The one place it must care is a pet in the sleeping box:
   * the fallback there would be "no visible reaction at all", so the *choice*
   * between an animation and a bubble has to be made here, where the bubble
   * can be emitted. Defaults to "the sheet has nothing", i.e. the bubble.
   */
  readonly hasAnimation?: (name: string) => boolean;
}

function play(animation: string, then: PlayThen): SceneEvent {
  return { type: 'play', animation, then };
}

function bubbleFor(active: ActiveBubble): SceneEvent {
  return { type: 'bubble', text: active.text, kind: active.kind, ttlMs: active.ttlMs };
}

function bubbleCleared(): SceneEvent {
  return { type: 'bubble', text: '', kind: 'none', ttlMs: 0 };
}

/**
 * The buckets that may bark: every reported window, and no derived one.
 *
 * A derived bucket (today only the "7-day Fable" row — see
 * `withDerivedFableRow`) is a *second view of a window that is already in this
 * list*, at the same percentage and the same reset. Feeding it to the
 * `NudgeMachine` would double every weekly bark: two crossings of the same
 * threshold at the same instant, one shown and one queued behind it, so the dog
 * barks "7-day (all models) at 90 %" and then, twelve seconds later, "7-day
 * Fable at 90 %" about the identical allowance.
 *
 * Filtered here, at the wiring between the snapshot and the machine, rather than
 * inside the machine: the machine's job is thresholds and windows, and it has no
 * business knowing which rows Walder invented. The panel still shows the row —
 * being quiet about it is not the same as hiding it.
 */
function barkableBuckets(buckets: readonly Bucket[]): Bucket[] {
  return buckets.filter((bucket) => bucket.derived !== true);
}

export class Behaviour {
  private readonly machine: NudgeMachine;
  private readonly nudgeTtlMs: number;
  private readonly perkTtlMs: number;
  private readonly sleepPetTtlMs: number;
  private readonly hasAnimation: (name: string) => boolean;

  /** `bucketId` -> display priority, learned from each snapshot. */
  private readonly priorities = new Map<string, number>();

  private fullscreen = false;
  private currentBox: BoxName = 'stand';
  private currentExpression: Expression = 'confused';
  /** `null` until the first expression is emitted, so the first one always is. */
  private sentExpression: Expression | null = null;
  private activeBubble: ActiveBubble | null = null;
  private pending: PendingExternal[] = [];

  constructor(opts: BehaviourOptions = {}) {
    this.nudgeTtlMs = opts.nudgeTtlMs ?? NUDGE_TTL_MS;
    this.perkTtlMs = opts.perkTtlMs ?? PERK_TTL_MS;
    this.sleepPetTtlMs = opts.sleepPetTtlMs ?? SLEEP_PET_TTL_MS;
    this.hasAnimation = opts.hasAnimation ?? ((): boolean => false);
    this.machine = new NudgeMachine({
      levels: opts.levels,
      autoDismissMs: this.nudgeTtlMs,
      // Read through the map on every call, so a snapshot that arrives later
      // still orders simultaneous crossings correctly.
      priority: (bucketId) => this.priorities.get(bucketId) ?? UNKNOWN_PRIORITY
    });
  }

  /** Which sprite box the renderer should be showing. */
  get box(): BoxName {
    return this.currentBox;
  }

  get bubble(): ActiveBubble | null {
    return this.activeBubble;
  }

  /**
   * **Invariant: `machine.active !== null` ⟺ `activeBubble?.kind === 'nudge'`.**
   *
   * The bark machine and this class each hold a piece of the same fact, and the
   * two must agree in both directions:
   *
   *  - a bark the machine believes is on screen and this class has replaced
   *    (with a perk, say) is a bark whose 12 s auto-dismiss will later fire and
   *    clear *somebody else's* bubble, and whose threshold is now recorded as
   *    "already warned about" although nobody saw it;
   *  - a `nudge` bubble here with no active bark in the machine is a bubble
   *    nothing will ever dismiss: only `machine.onTick`/`onPet` emit the
   *    `clear` for one, so it would sit on screen until the next bark.
   *
   * Every write to `activeBubble` therefore goes through one of two paths —
   * `applyNudgeEvents` (which is the only place a `nudge` bubble is created or
   * cleared, and only in response to the machine's own `show`/`clear`) and the
   * external/sleepy paths (which never produce `kind === 'nudge'`). `onPet` is
   * the one place the two meet, and it routes a live bark to `machine.onPet`
   * rather than clearing the bubble itself, precisely to keep this true.
   *
   * Exposed read-only so a test can assert it after every step of a sequence;
   * nothing in the app reads it.
   */
  get nudgeMachineActive(): boolean {
    return this.machine.active !== null;
  }

  get expression(): Expression {
    return this.currentExpression;
  }

  /** Whether a fullscreen window is believed to be up. */
  get fullscreenActive(): boolean {
    return this.fullscreen;
  }

  /**
   * When `onTick` next has something to do, or `null` for "nothing is on a
   * clock". The caller arms one timer for this instant instead of polling —
   * a mascot that must stay under 1 % idle CPU cannot afford a heartbeat.
   */
  nextDeadlineAt(): number | null {
    const active = this.activeBubble;
    if (active === null || active.ttlMs === null) return null;
    return active.shownAt + active.ttlMs;
  }

  /** A fresh usage snapshot: sets the face, and may bark. */
  onUsage(snapshot: UsageSnapshot, now: number): SceneEvent[] {
    const events: SceneEvent[] = [];

    for (const bucket of snapshot.buckets) this.priorities.set(bucket.id, bucket.priority);

    // Recomputed rather than read from `snapshot.expression`: the same rule, but
    // it cannot be out of step with the buckets the barks are derived from.
    this.pushExpression(expressionFor(pctForFace(snapshot.buckets)), events);

    this.applyNudgeEvents(
      this.machine.onUsage(barkableBuckets(snapshot.buckets), now),
      now,
      events
    );
    this.settle(now, events);
    return events;
  }

  /**
   * The owner clicked the dog. Dismisses whatever bubble is up and reacts.
   *
   * The reaction is emitted *first* so it reads as a consequence of the click,
   * and a stand-box wiggle is never emitted when the same click sends him back
   * to sleep: the sleep box is a much smaller window, and a stand-box animation
   * playing after the window has already shrunk would be clipped.
   *
   * **Petting a sleeping dog is not a no-op.** It used to be: the wiggle was
   * skipped in the sleeping box and nothing took its place, so a click on a
   * curled-up dog did visibly nothing — indistinguishable from a mascot that
   * had stopped responding, which is the single worst thing this app can look
   * like. He now twitches (`sleep_pet`) if the art has such a frame, and
   * otherwise mumbles `…zzz` for a moment. Either way he stays asleep: that is
   * what `sleepy` means to `settle`.
   */
  onPet(now: number): SceneEvent[] {
    const consequences: SceneEvent[] = [];
    const active = this.activeBubble;
    /**
     * Both read *before* `settle`, because the click can change either.
     *
     * `wasAsleep` distinguishes "he was curled up and the owner petted him"
     * from "he was standing with a bark up, and dismissing it is what sent him
     * back to sleep" — which ends in the same box but is not a pet of a
     * sleeping dog, and must not also mumble. `hadBubble` is the second half of
     * that: a click whose whole job was dismissing something has already had a
     * visible effect.
     */
    const wasAsleep = this.currentBox === 'sleep';
    /**
     * A `sleepy` bubble is left alone only while he is *still* asleep, because
     * `sleepyPet` below will refresh it in place — clearing and re-showing it
     * would blink. Once he is standing again (the film ended while it was up)
     * it is an ordinary bubble and a click dismisses it like any other.
     */
    const refreshesMumble = active?.kind === 'sleepy' && wasAsleep;
    const hadBubble = active !== null && !refreshesMumble;

    if (active !== null && !refreshesMumble) {
      if (active.kind === 'nudge') {
        this.applyNudgeEvents(this.machine.onPet(now), now, consequences);
      } else {
        this.activeBubble = null;
        this.pending = this.pending.filter((item) => item.kind !== active.kind);
        consequences.push(bubbleCleared());
      }
    }

    this.settle(now, consequences);

    const events: SceneEvent[] = [];
    if (this.currentBox === 'stand') events.push(play(ANIM_PET, 'idle'));
    else if (wasAsleep && !hadBubble) events.push(...this.sleepyPet(now));
    events.push(...consequences);
    return events;
  }

  /**
   * The reaction to a pet while he is in the sleeping box.
   *
   * A `play` if the sheet has the frames, because an animation is better than
   * words for something that is meant to read as "he stirred without waking".
   * Otherwise a short bubble — which is *not* run through `settle`'s wake path:
   * it is stored as the active bubble (so its own ttl expires it through
   * `onTick`, and `nextDeadlineAt` arms the one timer for it) but marked
   * `sleepy`, which `settle` ignores when deciding whether he should be asleep.
   *
   * Re-petting refreshes the same bubble rather than clearing and re-showing
   * it, so holding the mouse down and clicking repeatedly does not strobe.
   */
  private sleepyPet(now: number): SceneEvent[] {
    if (this.hasAnimation(ANIM_SLEEP_PET)) return [play(ANIM_SLEEP_PET, 'sleep')];

    this.activeBubble = {
      kind: 'sleepy',
      text: SLEEP_TEXT,
      ttlMs: this.sleepPetTtlMs,
      shownAt: now
    };
    return [bubbleFor(this.activeBubble)];
  }

  /** Call at `nextDeadlineAt`. Expires the bubble whose time is up. */
  onTick(now: number): SceneEvent[] {
    const events: SceneEvent[] = [];

    // The machine owns the bark's own 12 s clock, including promoting the next
    // queued bark in the same breath.
    this.applyNudgeEvents(this.machine.onTick(now), now, events);

    const active = this.activeBubble;
    if (
      active !== null &&
      active.kind !== 'nudge' &&
      active.ttlMs !== null &&
      now - active.shownAt >= active.ttlMs
    ) {
      this.activeBubble = null;
      events.push(bubbleCleared());
    }

    this.settle(now, events);
    return events;
  }

  /**
   * A fullscreen window appeared or went away.
   *
   * Entering with nothing on screen curls him up; entering with a bubble up
   * changes nothing until that bubble is dismissed, and `settle` then puts him
   * to sleep. Leaving always brings him back to the standing box.
   */
  setFullscreen(fullscreen: boolean, now: number): SceneEvent[] {
    if (fullscreen === this.fullscreen) return [];
    this.fullscreen = fullscreen;
    const events: SceneEvent[] = [];
    this.settle(now, events);
    return events;
  }

  /**
   * A Claude Code hook fired.
   *
   * `done` and `waiting` are queued rather than shown directly, because a usage
   * bark outranks them: the queue holds at most one of each kind and the latest
   * wins, so a burst of replies cannot back up into a minute of bubbles.
   * `prompt` is the *end* of a wait — it clears the `?` and never shows anything
   * of its own.
   */
  onHook(kind: HookKind, now: number): SceneEvent[] {
    const events: SceneEvent[] = [];

    if (kind === 'prompt') {
      this.pending = this.pending.filter((item) => item.kind !== 'waiting');
      if (this.activeBubble?.kind === 'waiting') {
        this.activeBubble = null;
        events.push(bubbleCleared());
      }
      this.settle(now, events);
      return events;
    }

    const item: PendingExternal =
      kind === 'done'
        ? { kind: 'perk', text: PERK_TEXT, ttlMs: this.perkTtlMs, animation: ANIM_PERK }
        : { kind: 'waiting', text: WAITING_TEXT, ttlMs: null, animation: ANIM_TILT };

    const at = this.pending.findIndex((queued) => queued.kind === item.kind);
    if (at >= 0) this.pending[at] = item;
    else this.pending.push(item);

    this.settle(now, events);
    return events;
  }

  /* -------------------------------------------------------------- internals */

  /**
   * Turn the machine's own events into scene events.
   *
   * `sleep`/`wake` are ignored by design — see the note at the top of this file.
   */
  private applyNudgeEvents(
    nudgeEvents: readonly NudgeEvent[],
    now: number,
    out: SceneEvent[]
  ): void {
    for (const event of nudgeEvents) {
      if (event.type === 'show') {
        this.wake(out);
        // A bark takes the screen from a live perk or head-tilt, and that one is
        // *not* re-queued: the priority runs both ways. A "woof" that has
        // already been seen has done its whole job, while a threshold warning
        // held back for five seconds is a warning shown after the fact.
        this.activeBubble = {
          kind: 'nudge',
          text: nudgeText(event.nudge.label, event.nudge.pct),
          ttlMs: this.nudgeTtlMs,
          shownAt: now
        };
        out.push(play(ANIM_BARK, 'idle'));
        out.push(bubbleFor(this.activeBubble));
      } else if (event.type === 'clear') {
        this.activeBubble = null;
        out.push(bubbleCleared());
      }
    }
  }

  /**
   * Bring him out of the sleep box because something is about to be said.
   *
   * `mode` precedes `play`: the box decides the window size, and a stand-box
   * animation must not start while the window is still the tiny sleeping one.
   */
  private wake(out: SceneEvent[]): void {
    if (this.currentBox === 'stand') return;
    this.currentBox = 'stand';
    out.push({ type: 'mode', box: 'stand' });
    out.push(play(ANIM_WAKE, 'idle'));
  }

  /**
   * Bring the scene into a consistent state after any input: promote a queued
   * external event if the screen is free, then reconcile the sprite box with
   * "fullscreen and nothing to say".
   */
  private settle(now: number, out: SceneEvent[]): void {
    // Barks outrank hooks, and the machine has already promoted its own queue by
    // the time we get here — so `activeBubble === null` means no bark is waiting.
    if (this.activeBubble === null && this.pending.length > 0) {
      const next = this.pending.shift() as PendingExternal;
      this.wake(out);
      this.activeBubble = {
        kind: next.kind,
        text: next.text,
        ttlMs: next.ttlMs,
        shownAt: now
      };
      // A head-tilt holds: the `?` has no time limit, so the pose must not snap
      // back to idle while the bubble is still up.
      out.push(play(next.animation, next.kind === 'waiting' ? 'hold' : 'idle'));
      out.push(bubbleFor(this.activeBubble));
    }

    // A `sleepy` bubble is the one bubble that does not keep him awake — it is
    // the acknowledgement of a pet *while* asleep, so treating it like any
    // other bubble would make petting a sleeping dog wake him, which is the
    // opposite of the intent.
    const wantsSleep =
      this.fullscreen && (this.activeBubble === null || this.activeBubble.kind === 'sleepy');

    if (wantsSleep && this.currentBox !== 'sleep') {
      this.currentBox = 'sleep';
      out.push({ type: 'mode', box: 'sleep' });
      out.push(play(ANIM_SLEEP, 'sleep'));
    } else if (!wantsSleep && this.currentBox !== 'stand') {
      // Only reached when fullscreen ended with nothing on screen; `wake` covers
      // the "something to say" route.
      this.currentBox = 'stand';
      out.push({ type: 'mode', box: 'stand' });
      out.push(play(ANIM_WAKE, 'idle'));
    }
  }

  /** Emit the face, but never the same one twice in a row. */
  private pushExpression(expression: Expression, out: SceneEvent[]): void {
    this.currentExpression = expression;
    if (this.sentExpression === expression) return;
    this.sentExpression = expression;
    out.push({ type: 'expression', expression });
  }
}

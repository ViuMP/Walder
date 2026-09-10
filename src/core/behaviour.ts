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
 *
 * ## Presence: the hide-when-idle mode
 *
 * With `hideWhenIdle` on, Walder is not on screen at all unless he has something
 * to say. That is one more thing the four sources could contradict each other
 * about, so it is decided *here* rather than by an observer watching the events
 * go past: every trigger for "he should appear" is a fact this class already
 * holds, and an observer would have to re-derive them from the outside and get
 * them subtly wrong.
 *
 * Three states, and every input moves between them:
 *
 *  - **VISIBLE-BUSY** — on screen with a bubble up, or with one queued behind a
 *    bark. No countdown runs.
 *  - **LINGERING** — on screen with nothing to say, counting down `LINGER_MS`.
 *    The linger exists because a bubble that vanishes *and takes the dog with it
 *    in the same instant* reads as a glitch; eight seconds is long enough to
 *    look at him, pet him, or read the number again.
 *  - **HIDDEN** — the window is hidden. Nothing is drawn, the renderer's own
 *    animation timer is stopped, and no hover card can appear.
 *
 * Transitions: VISIBLE-BUSY → LINGERING when the last bubble clears;
 * LINGERING → HIDDEN at the deadline; LINGERING + a pet → the deadline restarts;
 * HIDDEN → VISIBLE-BUSY on a bark, a hook, an update notice, or the face turning
 * to *out* or *confused* (`askForAttention`). Turning the mode off always shows
 * him, and turning it on with nothing to say hides him immediately — a keypress
 * must act now, not in eight seconds.
 *
 * `visible` events are the only thing that says so, and `main/behaviour.ts`
 * turns them into a window call *and* forwards them to the renderer.
 *
 * **A dog who is on screen in this mode is a dog who is standing.** The sleeping
 * box is the resting state of a dog nobody can see: he curls up *as he leaves*
 * (the `visible:false` and the `mode:sleep` come out of the same batch), and a
 * film that starts while he is lingering does not curl him up under the owner's
 * eyes. Without that rule the expression path was visibly wrong — see
 * `askForAttention`.
 *
 * **`visible:true` is emitted last in the batch, not at the moment it is
 * decided.** The window grows for a bubble and resizes for a box, and both are
 * main-process work that must be finished before the window is put on screen —
 * otherwise the owner sees one frame of a narrow, bubble-less dog. So `attention`
 * only records `pendingShow`, and `settle` flushes it as the final event of every
 * public method's batch.
 */
import { expressionFor, type Expression } from './expression';
import { NudgeMachine, type NudgeEvent } from './nudge';
import {
  PERK_TEXT,
  SLEEP_TEXT,
  WAITING_TEXT,
  nudgeText,
  updateText,
  type BubbleKind
} from './bubble';
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
  | { readonly type: 'mode'; readonly box: BoxName }
  /**
   * Is the dog on screen at all? Only ever emitted on a *change*, so a
   * consumer can treat each one as an edge.
   *
   * Both halves matter to the consumer: main hides or shows the window, and the
   * renderer stops its own animation timer (the window keeps ticking at full
   * cadence while hidden — `backgroundThrottling: false` — so nothing else
   * would).
   */
  | { readonly type: 'visible'; readonly shown: boolean };

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

/**
 * How long the "a new version is out" bubble stays up.
 *
 * The same 12 s as a usage bark, deliberately: it is the other bubble that is
 * *information the owner has to act on later*, and a shorter one could be missed
 * by someone who looked up a second too late. It is shown once per version, so
 * there is no nagging to trade against.
 */
export const UPDATE_TTL_MS = 12_000;

/**
 * How long Walder stays on screen after the last thing he had to say, in the
 * hide-when-idle mode.
 *
 * Eight seconds, from the owner's own request. The alternative — vanishing in
 * the same instant the bubble clears — was rejected on sight: it reads as the
 * app crashing rather than as the dog leaving, and it gives no chance to pet him
 * (which restarts this countdown) or to read the number one more time.
 */
export const LINGER_MS = 8_000;

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
  readonly kind: 'nudge' | 'perk' | 'waiting' | 'sleepy' | 'update';
  readonly text: string;
  /** `null` for a bubble with no time limit (the waiting `?`). */
  readonly ttlMs: number | null;
  readonly shownAt: number;
  /**
   * The `NudgeMachine` owns this bubble's clock and its dismissal.
   *
   * True for every threshold bark, and false for the one other thing that
   * wears the `nudge` kind: the Codex credits-exhausted notice, which is
   * detected here and never enters the machine (a balance has no thresholds
   * for it to bookkeep). Without this flag the two are indistinguishable, and
   * `onPet`/`onTick` would hand the credits bubble to a machine that has never
   * heard of it — leaving a bark that no click could dismiss and no ttl could
   * expire.
   */
  readonly machine?: boolean;
}

/** An external event waiting for the screen to clear. */
interface PendingExternal {
  readonly kind: 'perk' | 'waiting' | 'update' | 'nudge';
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
  readonly updateTtlMs?: number;
  /**
   * Start in the hide-when-idle mode.
   *
   * Off by default, which is what makes every existing caller and every test
   * that does not mention presence emit no `visible` events at all. The app
   * does *not* use this to restore the owner's setting — it constructs with the
   * mode off and then calls `setHideWhenIdle(true)`, because only the setter
   * hides him straight away (see `main/behaviour.ts`).
   */
  readonly hideWhenIdle?: boolean;
  /** How long he stays up with nothing to say. Overridable for tests. */
  readonly lingerMs?: number;
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
  return buckets.filter((bucket) => bucket.derived !== true && bucket.kind !== 'credits');
}

/**
 * What he says when the Codex credit pool runs dry.
 *
 * The one thing on a credits row worth interrupting the owner for. A balance
 * has no 80/85/90 semantics — there is no denominator to be a percentage of —
 * so the `NudgeMachine`'s whole vocabulary is inapplicable to it, which is why
 * `barkableBuckets` keeps credits rows out of the machine entirely and this
 * one transition is detected in `Behaviour` instead.
 */
const CREDITS_EMPTY_TEXT = (label: string): string => `${label}: none left`;

export class Behaviour {
  private readonly machine: NudgeMachine;
  private readonly nudgeTtlMs: number;
  private readonly perkTtlMs: number;
  private readonly sleepPetTtlMs: number;
  private readonly updateTtlMs: number;
  private readonly lingerMs: number;
  private readonly hasAnimation: (name: string) => boolean;

  /** `bucketId` -> display priority, learned from each snapshot. */
  private readonly priorities = new Map<string, number>();

  /**
   * `bucketId` -> the `exhausted` flag last seen on a credits row.
   *
   * The whole state of the credits bark: it fires on the false→true edge and
   * re-arms only when the flag goes back to false, which is what makes "you
   * are out of credits" a single sentence rather than one every three minutes
   * for as long as the account stays empty.
   *
   * A row that vanishes from a snapshot is deliberately *not* forgotten (the
   * same rule the `NudgeMachine` applies to its own state, and for the same
   * reason): one failed poll would otherwise re-arm the edge and bark again on
   * the next successful one, about a fact the owner was told an hour ago.
   */
  private readonly creditsExhausted = new Map<string, boolean>();

  private fullscreen = false;
  private currentBox: BoxName = 'stand';
  private currentExpression: Expression = 'confused';
  /** `null` until the first expression is emitted, so the first one always is. */
  private sentExpression: Expression | null = null;
  private activeBubble: ActiveBubble | null = null;
  private pending: PendingExternal[] = [];

  /* ------------------------------------------------------------- presence */

  private hideWhenIdle: boolean;
  /**
   * Is he on screen? `true` until told otherwise, because the window is built
   * visible and the mode is off by default.
   */
  private shown = true;
  /**
   * When the linger runs out, or `null` for "not counting down" — which is both
   * VISIBLE-BUSY (something is on screen) and HIDDEN (he already left).
   */
  private lingerUntil: number | null = null;
  /**
   * A `visible:true` that has been decided but not yet emitted.
   *
   * The batch it belongs to is still growing — a bubble to widen the window for,
   * a box to resize to — and every one of those is work that must happen while
   * the window is still off screen. `settle` flushes this last; see the file
   * header.
   */
  private pendingShow = false;

  constructor(opts: BehaviourOptions = {}) {
    this.nudgeTtlMs = opts.nudgeTtlMs ?? NUDGE_TTL_MS;
    this.perkTtlMs = opts.perkTtlMs ?? PERK_TTL_MS;
    this.sleepPetTtlMs = opts.sleepPetTtlMs ?? SLEEP_PET_TTL_MS;
    this.updateTtlMs = opts.updateTtlMs ?? UPDATE_TTL_MS;
    this.lingerMs = opts.lingerMs ?? LINGER_MS;
    this.hideWhenIdle = opts.hideWhenIdle === true;
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
   * Is the dog off screen right now?
   *
   * Read by `index.ts` before anything re-shows the window behind presence's
   * back — a second launch of the app, or a rebuilt overlay after a renderer
   * crash. Both used to `showInactive()` unconditionally, which would un-hide a
   * deliberately hidden dog with nothing to say and no way to explain itself.
   */
  get hidden(): boolean {
    return !this.shown;
  }

  /** Is the hide-when-idle mode on? For the tray checkmark. */
  get hideWhenIdleEnabled(): boolean {
    return this.hideWhenIdle;
  }

  /**
   * Turn the hide-when-idle mode on or off.
   *
   * **On with nothing to say hides him immediately**, and that is the whole
   * reason this is not simply a flag the next `settle` picks up: the owner has
   * either ticked a menu item or pressed a key, and a dog that waits eight
   * seconds before obeying reads as a shortcut that did not work. So the linger
   * is *pre-expired* rather than started. With a bubble up he waits for it —
   * cutting off a bark the owner is halfway through reading would be the same
   * mistake in the other direction — and then lingers normally.
   *
   * Off always shows him, with no wake animation: he was never asleep, the
   * window was hidden, and a stretch-and-stand for a window that simply
   * reappeared would look like an animation glitch.
   */
  setHideWhenIdle(on: boolean, now: number): SceneEvent[] {
    if (on === this.hideWhenIdle) return [];
    this.hideWhenIdle = on;
    this.lingerUntil = on ? now : null;
    const events: SceneEvent[] = [];
    this.settle(now, events);
    return events;
  }

  /**
   * When `onTick` next has something to do, or `null` for "nothing is on a
   * clock". The caller arms one timer for this instant instead of polling —
   * a mascot that must stay under 1 % idle CPU cannot afford a heartbeat.
   *
   * Two clocks exist: the bubble's own ttl and the presence linger. Only one of
   * them runs at a time today — `settlePresence` cancels the linger for as long
   * as there is anything to say — but the earliest of the two is the answer
   * either way, and writing it as a `min` means a future bubble that does *not*
   * cancel the linger cannot silently lose its deadline. Both are reached
   * through `onTick`, so the single timer in `main/behaviour.ts` still covers
   * everything.
   */
  nextDeadlineAt(): number | null {
    const active = this.activeBubble;
    const bubbleAt =
      active === null || active.ttlMs === null ? null : active.shownAt + active.ttlMs;
    const lingerAt = this.lingerUntil;
    if (bubbleAt === null) return lingerAt;
    if (lingerAt === null) return bubbleAt;
    return Math.min(bubbleAt, lingerAt);
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
    // After the thresholds, and only ever queued: if a real window bark took
    // the screen this tick, "none left" waits behind it and `settle` shows it
    // when that one clears, rather than overwriting a warning the owner has
    // had no time to read.
    this.queueCreditsBarks(snapshot.buckets);
    this.settle(now, events);
    return events;
  }

  /**
   * Queue one bark per credits row that has just become exhausted.
   *
   * Queued at the **front**, ahead of any waiting perk, `?` or update notice,
   * because it is the same class of thing as a threshold bark: something about
   * the owner's allowance that has changed and that he will otherwise discover
   * by a tool failing. At most one per bucket is ever queued — a second edge
   * cannot occur without the flag first going false, and the replace-in-place
   * below covers the case where it does so while the first is still waiting.
   */
  private queueCreditsBarks(buckets: readonly Bucket[]): void {
    for (const bucket of buckets) {
      if (bucket.kind !== 'credits' || bucket.credits === undefined) continue;
      const exhausted = bucket.credits.exhausted;
      const before = this.creditsExhausted.get(bucket.id);
      this.creditsExhausted.set(bucket.id, exhausted);
      if (!exhausted || before === true) continue;

      const item: PendingExternal = {
        kind: 'nudge',
        text: CREDITS_EMPTY_TEXT(bucket.label),
        ttlMs: this.nudgeTtlMs,
        animation: ANIM_BARK
      };
      const at = this.pending.findIndex(
        (queued) => queued.kind === 'nudge' && queued.text === item.text
      );
      if (at >= 0) this.pending[at] = item;
      else this.pending.unshift(item);
    }
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
      if (active.kind === 'nudge' && active.machine === true) {
        this.applyNudgeEvents(this.machine.onPet(now), now, consequences);
      } else {
        this.activeBubble = null;
        this.pending = this.pending.filter((item) => item.kind !== active.kind);
        consequences.push(bubbleCleared());
      }
    }

    /*
     * Petting restarts the eight seconds, so `settlePresence` must not find a
     * deadline that has already passed and hide him under the owner's cursor.
     * Cleared *before* `settle` rather than re-armed after it, so the one place
     * that starts a linger stays `settlePresence`.
     */
    this.lingerUntil = null;

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
      active.machine !== true &&
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
    // Ahead of a queued update notice: a `woof` or a `?` is about what the owner
    // is doing right now, and "0.1.3 is out" has waited six hours already and
    // can wait another five seconds.
    else this.pending.splice(this.updateQueuePosition(), 0, item);

    this.settle(now, events);
    return events;
  }

  /**
   * A newer version of Walder exists.
   *
   * The *decision* to say anything is not made here — `index.ts` records the
   * version it has notified about and calls this at most once per version, so
   * this method's own job is only to queue the bubble politely. It goes last in
   * the queue (see `updateQueuePosition`), at most one is ever queued and the
   * latest version wins, and a usage bark takes the screen from it outright the
   * way it does from a perk.
   *
   * Promotion runs through `settle` → `wake` → `attention`, so a dog hidden by
   * the hide-when-idle mode appears for it — once, for the one version.
   */
  onUpdateAvailable(version: string, now: number): SceneEvent[] {
    const events: SceneEvent[] = [];
    const item: PendingExternal = {
      kind: 'update',
      text: updateText(version),
      ttlMs: this.updateTtlMs,
      // Ears up, the same as a finished Claude Code reply: it is good news, and
      // there is no separate "look at this" pose in the sheet.
      animation: ANIM_PERK
    };

    const at = this.updateQueuePosition();
    if (this.pending[at]?.kind === 'update') this.pending[at] = item;
    else this.pending.push(item);

    this.settle(now, events);
    return events;
  }

  /* -------------------------------------------------------------- internals */

  /**
   * Where the queued update notice is, or the end of the queue when there is
   * none. Both "replace the queued one" and "insert a hook's bubble in front of
   * it" are the same index, which is why it is one helper.
   */
  private updateQueuePosition(): number {
    const at = this.pending.findIndex((queued) => queued.kind === 'update');
    return at === -1 ? this.pending.length : at;
  }

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
          shownAt: now,
          machine: true
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
   *
   * And `attention` comes last, so the *window* work — the resize, and the wake
   * animation's first frame — all happens while the window is still hidden. A
   * dog who appeared and then resized would flash at the wrong size for a frame.
   */
  private wake(out: SceneEvent[]): void {
    if (this.currentBox !== 'stand') {
      this.currentBox = 'stand';
      out.push({ type: 'mode', box: 'stand' });
      out.push(play(ANIM_WAKE, 'idle'));
      this.attention(out, true);
      return;
    }
    this.attention(out, false);
  }

  /**
   * Something needs the owner: make sure he is on screen for it.
   *
   * A no-op unless the hide-when-idle mode is on, apart from clearing the
   * linger — which is right in both modes, because whatever is about to be said
   * is exactly the thing that should stop him leaving.
   *
   * **`wakeAlreadyPlayed` is not a nicety.** `wake()` is a no-op when he is
   * already standing, which is the normal state of a *hidden* dog (nothing is
   * fullscreen, the window is simply not shown). Appearing with no animation at
   * all would be a dog materialising out of nothing, so when `wake()` had
   * nothing to do this emits the stretch itself — and when `wake()` did resize,
   * it must not emit a second one.
   *
   * The `visible:true` itself is *recorded*, not emitted: it is the last event of
   * the batch (see the file header and `flushPresence`).
   */
  private attention(out: SceneEvent[], wakeAlreadyPlayed: boolean): void {
    this.lingerUntil = null;
    if (!this.hideWhenIdle || this.shown) return;
    this.shown = true;
    this.pendingShow = true;
    if (!wakeAlreadyPlayed) out.push(play(ANIM_WAKE, 'idle'));
  }

  /**
   * Emit the deferred `visible:true`, if the batch decided on one.
   *
   * Called as the very last step of `settle`, which is the last step of every
   * public method — so the window is only put on screen once the resize for the
   * box and the widening for the bubble have already been asked for.
   *
   * The `shown` check keeps the "never two identical `visible` in a row"
   * invariant in the one case that could break it: a batch that showed him and
   * then hid him again (a zero-length linger) has moved from hidden to hidden,
   * and the honest number of events for that is none — `settlePresence` drops its
   * own `visible:false` for the same reason.
   */
  private flushPresence(out: SceneEvent[]): void {
    if (!this.pendingShow) return;
    this.pendingShow = false;
    if (this.shown) out.push({ type: 'visible', shown: true });
  }

  /**
   * Bring the scene into a consistent state after any input: promote a queued
   * external event if the screen is free, decide whether he is on screen at all
   * (`settlePresence`), reconcile the sprite box with that, and emit the
   * deferred `visible:true` last of all.
   *
   * **Presence is decided before the box, not after it.** The two are not
   * independent: the sleeping box is for a dog nobody is looking at, so "is he
   * on screen" has to be settled before "which box is he in" can be answered —
   * that ordering is what keeps a dog who has just appeared during a film
   * standing for his eight seconds instead of curling up in the same instant.
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

    // Whether he should be on screen at all, given what the promotion above
    // left to say. Before the box, deliberately — see this method's header.
    this.settlePresence(now, out);

    /*
     * A `sleepy` bubble is the one bubble that does not keep him awake — it is
     * the acknowledgement of a pet *while* asleep, so treating it like any
     * other bubble would make petting a sleeping dog wake him, which is the
     * opposite of the intent.
     *
     * `lingerUntil === null` is the presence half of the same question, and it
     * is the fix for a dog who *stood up and curled straight back down*: with
     * the hide-when-idle mode on, a live linger means he is on screen with
     * nothing to say, and a dog on screen stands. The moment the linger runs out
     * `settlePresence` clears it and hides him, and this then curls him up in
     * the same batch — which is the order that matters, because the resize must
     * happen behind a hidden window and not in front of the owner.
     */
    const wantsSleep =
      this.fullscreen &&
      (this.activeBubble === null || this.activeBubble.kind === 'sleepy') &&
      this.lingerUntil === null;

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

    // Truly last: the window is on screen only once every resize this batch
    // asked for has been asked for.
    this.flushPresence(out);
  }

  /**
   * Decide whether he is on screen, given what `settle` has just promoted. The
   * only place `shown` and `lingerUntil` are written outside `attention`.
   *
   * Ordered by how much each case is allowed to override the others:
   *
   *  1. **Mode off** — always visible, no countdown. Nothing else applies.
   *  2. **Something to say** (a bubble up, or one queued behind a bark) — stay,
   *     and cancel any countdown. This is what makes a bark that arrives during
   *     the linger reset it rather than being cut short by it.
   *  3. **Nothing to say, no countdown yet** — start one. This is the moment a
   *     bubble cleared.
   *  4. **Nothing to say, countdown expired** — leave.
   *
   * A dog who is already hidden falls through 3 and 4 untouched: `shown` is
   * false and `lingerUntil` is null, and only `attention` brings him back.
   */
  private settlePresence(now: number, out: SceneEvent[]): void {
    if (!this.hideWhenIdle) {
      this.lingerUntil = null;
      if (this.shown) return;
      this.shown = true;
      // Recorded like every other show, so it lands after the box the mode
      // change may have to reconcile (a film that was running while he was
      // hidden leaves him in the sleeping box).
      this.pendingShow = true;
      return;
    }

    if (this.activeBubble !== null || this.pending.length > 0) {
      this.lingerUntil = null;
      return;
    }

    if (!this.shown) return;

    if (this.lingerUntil === null) {
      this.lingerUntil = now + this.lingerMs;
      return;
    }

    if (now >= this.lingerUntil) {
      this.lingerUntil = null;
      this.shown = false;
      // A show decided earlier in this same batch never left the building, so
      // dropping both is the honest answer for hidden → hidden. See
      // `flushPresence`.
      if (this.pendingShow) this.pendingShow = false;
      else out.push({ type: 'visible', shown: false });
    }
  }

  /**
   * Emit the face, but never the same one twice in a row.
   *
   * **A transition to `out` or `confused` also asks for his attention.** Both
   * mean the owner has to do something — the 5-hour window is spent, or a login
   * has expired — and in the hide-when-idle mode neither has a bubble of its
   * own to appear for. A hidden dog whose face silently turned confused would be
   * a mascot that stopped working, indistinguishable from one that crashed. Only
   * on the *change*: the confused face can persist for hours while a login stays
   * broken, and re-appearing on every three-minute poll would be nagging. The
   * *first* face of a run counts as a change, deliberately — an owner who
   * launches Walder with an expired login must be told once, and that launch is
   * the only chance to tell him.
   */
  private pushExpression(expression: Expression, out: SceneEvent[]): void {
    this.currentExpression = expression;
    if (this.sentExpression === expression) return;
    this.sentExpression = expression;
    out.push({ type: 'expression', expression });
    if (expression === 'out' || expression === 'confused') this.askForAttention(out);
  }

  /**
   * The face alone is the reason he has to appear: bring him out properly.
   *
   * **Through `wake()`, not straight to `attention()`.** This used to call
   * `attention` directly, and `attention` does not touch `currentBox` — so with
   * the hide-when-idle mode on, a film running and the dog curled up and hidden,
   * a face turning *confused* emitted the stretch and the `visible:true` while
   * the box was still `sleep`: a stand-box animation inside the tiny sleeping
   * window, drawn on top of the video. That is precisely the mistake `wake()`'s
   * own comment exists to prevent, so this goes through `wake()` (box, then the
   * stretch, then the show) and `settle` afterwards leaves him standing for the
   * linger rather than curling him up again on the spot.
   *
   * Only a *hidden* dog needs any of that. With the mode off, or with him
   * already on screen, `wake()` would be a box change nobody asked for — a
   * stand-up-and-sit-down flicker mid-film — so those go to `attention`, whose
   * whole effect there is to cancel the linger.
   */
  private askForAttention(out: SceneEvent[]): void {
    if (this.hideWhenIdle && !this.shown) {
      this.wake(out);
      return;
    }
    this.attention(out, false);
  }
}

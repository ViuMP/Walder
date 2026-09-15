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
import { NudgeMachine, type NudgeEvent, type NudgeMemory } from './nudge';
import {
  SLEEP_TEXT,
  hookDoneText,
  hookWaitingText,
  nudgeText,
  updateText,
  type BubbleKind,
  type HookSource
} from './bubble';
import { CODEX_SPEND_LIMIT_KEY, type Bucket } from './buckets';
import { UP_TO_DATE_TEXT } from './update-check';
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

/*
 * ---------------------------------------------------------------------------
 * There are deliberately no `NUDGE_TTL_MS`, `PERK_TTL_MS` or `UPDATE_TTL_MS`
 * constants any more.
 *
 * Every bubble Walder puts up is now `ttlMs: null` — it stays until the owner
 * clicks him. His report (2026-09-11) was that he had never seen the 80 % bark:
 * polls are three minutes apart and the bubble was up for twelve seconds of one
 * of them, so receiving it meant happening to look at the corner of the screen
 * at the right second. That is not a warning, and the same argument retired the
 * five-second perk and the twelve-second update notice with it — a thing worth
 * interrupting him for is worth waiting for him.
 *
 * Two consequences, both accepted by the owner rather than worked around:
 *  - With the hide-when-idle mode on, an unclicked bubble keeps him on screen
 *    indefinitely. A bubble is exactly what `settlePresence` treats as
 *    "something to say", so he will not leave until it is dismissed.
 *  - The bark queue no longer drains on its own. `NudgeMachine.onUsage`'s
 *    supersede rule bounds it instead: a window's later crossing replaces its
 *    own older bark, so the queue can only hold one entry per window.
 *
 * `SLEEP_PET_TTL_MS` survives, and it is not an exception so much as a
 * consequence: the `…zzz` IS the acknowledgement of a click, and clicking a
 * sleeping dog refreshes it rather than clearing it, so "dismissed by a click"
 * is unreachable for that one bubble by construction.
 * ---------------------------------------------------------------------------
 */

/**
 * How long the `…zzz` a pet earns from a sleeping dog stays up. Short: it is an
 * acknowledgement, not a message.
 */
export const SLEEP_PET_TTL_MS = 1_500;

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
  /** `null` for a bubble with no time limit (a `waiting`). */
  readonly ttlMs: number | null;
  readonly shownAt: number;
  /**
   * Which tool this is about, for a `perk` or a `waiting`; absent on everything
   * else. It is what makes `prompt` clear Claude's `?` and leave Codex's — see
   * `onHook`.
   */
  readonly source?: HookSource;
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
  /** The tool a `perk` or a `waiting` is about; absent on the other kinds. */
  readonly source?: HookSource;
}

/**
 * Everything Walder must remember across a quit to avoid repeating himself.
 *
 * Two halves, because the two things that bark once per fact keep their memory
 * in two places: the `NudgeMachine`'s per-window level bookkeeping, and the
 * exhaustion edges detected here (a credits pool emptying, claude.ai refusing
 * further extra usage). Both have the same failure mode without this — the
 * process restarts, the map is empty, the persisted snapshot is re-fed, and the
 * owner is told again about something he acknowledged an hour ago.
 */
export interface BehaviourMemory {
  readonly barks: NudgeMemory;
  /** `bucketId` -> whether that row last said it had run out. */
  readonly exhausted: Record<string, boolean>;
}

export interface BehaviourOptions {
  /** Thresholds to bark at; passed through to the `NudgeMachine`. */
  readonly levels?: number[];
  /**
   * A `BehaviourMemory` from a previous run, as it came off disk — hence
   * `unknown`, and hence validated field by field rather than cast. `barks`
   * goes to the machine (which does its own checking) and `exhausted` is read
   * here, keeping only the entries that are actually booleans. Junk at any
   * level means "no memory", never a throw: the cost of a mangled settings
   * file has to stay one duplicate bark.
   */
  readonly memory?: unknown;
  readonly sleepPetTtlMs?: number;
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
 *
 * A **money** row is deliberately *not* filtered: a spend against a cap is a
 * real percentage and should bark 80/85/90/95 like any other. A **capless**
 * money row needs no filter either, because it has `pct: null` and
 * `NudgeMachine.onUsage` skips a row with no number — the same line that has
 * always protected it from a window whose percentage failed to parse. Pinned by
 * a test rather than assumed: it is the difference between "no cap, so nothing
 * to warn about" and a `0/0` row barking 100 % forever.
 *
 * The **Codex spend-limit** row is filtered too, and it is worth saying why,
 * because it is a plain window with a real percentage and looks barkable.
 *
 * The original reason was that `NudgeMachine`'s once-per-crossing memory was a
 * `Map` held in this process and nothing wrote it to disk, so every launch
 * re-announced whatever the persisted snapshot re-fed it. **That is no longer
 * true** — `BehaviourMemory` persists both this class's exhaustion edges and
 * the machine's levels across a quit (0.2.5), so the row would now be quiet
 * from the second launch onwards.
 *
 * The filter is kept anyway, deliberately. A monthly spend cap is not a
 * warning, it is a standing condition: the owner's live value is 455 %, blown
 * through weeks ago and not resetting until the 1st, and the honest cadence for
 * that fact is *never again this month*, not "once per month" — which is all
 * persistence would buy, plus a bark on the 1st about a cap that has just been
 * given back to him. A 5-hour or 7-day window is the opposite: it rolls over on
 * its own, so its bark is always current news. The row still shows on the card
 * with its bar and its reset — being quiet about it is not the same as hiding
 * it.
 */
function barkableBuckets(buckets: readonly Bucket[]): Bucket[] {
  return buckets.filter(
    (bucket) =>
      bucket.derived !== true &&
      bucket.kind !== 'credits' &&
      bucket.key !== CODEX_SPEND_LIMIT_KEY
  );
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

/**
 * What he says when claude.ai stops serving extra usage.
 *
 * The money row's version of the same edge, and it needs its own sentence for
 * the same reason it needs its own detection: `spend_limit_reached` is a fact
 * the *provider* states, not a threshold Walder computes. A capped money row
 * does bark 80/85/90/95 through the machine like any percentage — but a
 * **capless** one has `pct: null` and crosses nothing ever, so on the owner's
 * own account this is the only thing the Extra usage row can ever say. "Limit
 * reached" rather than "none left": the money is not gone, the cap is, and the
 * consequence he cares about is that claude.ai has stopped.
 */
const MONEY_LIMIT_TEXT = (label: string): string => `${label}: limit reached`;

/**
 * The one-shot "it has run out" sentence a row wants said, or `null`.
 *
 * Two kinds, one edge detector (`queueExhaustionBarks`). Both flags are the
 * provider's own statement rather than anything inferred from a number, which
 * is exactly why neither can be left to the `NudgeMachine`: it fires on
 * *crossings of a percentage*, and neither row necessarily has one.
 */
function exhaustionText(bucket: Bucket): string | null {
  if (bucket.kind === 'credits' && bucket.credits !== undefined) {
    return bucket.credits.exhausted ? CREDITS_EMPTY_TEXT(bucket.label) : null;
  }
  if (bucket.kind === 'money' && bucket.money !== undefined) {
    return bucket.money.limitReached === true ? MONEY_LIMIT_TEXT(bucket.label) : null;
  }
  return null;
}

export class Behaviour {
  private readonly machine: NudgeMachine;
  private readonly sleepPetTtlMs: number;
  private readonly lingerMs: number;
  private readonly hasAnimation: (name: string) => boolean;

  /** `bucketId` -> display priority, learned from each snapshot. */
  private readonly priorities = new Map<string, number>();

  /**
   * `bucketId` -> whether that row last said it had run out.
   *
   * The whole state of the exhaustion barks — a credits row's `exhausted`, a
   * money row's `limitReached`. Each fires on the false→true edge and re-arms
   * only when the flag goes back to false, which is what makes "you are out of
   * credits" a single sentence rather than one every three minutes for as long
   * as the account stays empty.
   *
   * A row that vanishes from a snapshot is deliberately *not* forgotten (the
   * same rule the `NudgeMachine` applies to its own state, and for the same
   * reason): one failed poll would otherwise re-arm the edge and bark again on
   * the next successful one, about a fact the owner was told an hour ago.
   */
  private readonly exhausted = new Map<string, boolean>();

  /**
   * Bucket ids the owner has taken off the hover card (tray ▸ **Show in
   * overview**), and which must therefore also stay quiet.
   *
   * Not persisted here: it is a *setting*, read from the store on every change
   * and pushed in through `setHiddenBuckets`, unlike the memory above which is
   * this class's own bookkeeping.
   */
  private hiddenBuckets: ReadonlySet<string> = new Set();

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
    this.sleepPetTtlMs = opts.sleepPetTtlMs ?? SLEEP_PET_TTL_MS;
    this.lingerMs = opts.lingerMs ?? LINGER_MS;
    this.hideWhenIdle = opts.hideWhenIdle === true;
    this.hasAnimation = opts.hasAnimation ?? ((): boolean => false);
    const memory = opts.memory;
    const stored =
      typeof memory === 'object' && memory !== null
        ? (memory as { barks?: unknown; exhausted?: unknown })
        : {};
    this.machine = new NudgeMachine({
      levels: opts.levels,
      // Read through the map on every call, so a snapshot that arrives later
      // still orders simultaneous crossings correctly.
      priority: (bucketId) => this.priorities.get(bucketId) ?? UNKNOWN_PRIORITY,
      memory: stored.barks
    });
    // Only booleans, and only from a plain record: an entry of any other type
    // is a fact we do not have rather than a fact we half-have. An array is
    // rejected outright — `Object.entries` would turn one into index keys that
    // match no bucket id and sit in the map forever.
    const exhausted = stored.exhausted;
    if (typeof exhausted === 'object' && exhausted !== null && !Array.isArray(exhausted)) {
      for (const [id, value] of Object.entries(exhausted as Record<string, unknown>)) {
        if (typeof value === 'boolean') this.exhausted.set(id, value);
      }
    }
  }

  /**
   * What he must remember across a quit. Written by `main/behaviour.ts` after
   * every poll, and handed back through `BehaviourOptions.memory` at the next
   * launch.
   */
  memory(): BehaviourMemory {
    return { barks: this.machine.memory(), exhausted: Object.fromEntries(this.exhausted) };
  }

  /** Which sprite box the renderer should be showing. */
  get box(): BoxName {
    return this.currentBox;
  }

  get bubble(): ActiveBubble | null {
    return this.activeBubble;
  }

  /**
   * **Invariant: `machine.active !== null` ⟺ `activeBubble?.machine === true`.**
   *
   * The bark machine and this class each hold a piece of the same fact, and the
   * two must agree in both directions:
   *
   *  - a bark the machine believes is on screen and this class has replaced
   *    (with a perk, say) is a bark whose 12 s auto-dismiss will later fire and
   *    clear *somebody else's* bubble, and whose threshold is now recorded as
   *    "already warned about" although nobody saw it;
   *  - a machine-owned bubble here with no active bark in the machine is a
   *    bubble nothing will ever dismiss: only `machine.onTick`/`onPet` emit the
   *    `clear` for one, so it would sit on screen until the next bark.
   *
   * **The test is `machine === true`, not `kind === 'nudge'`.** It used to be
   * the kind, and that was wrong from the moment the Codex credits notice
   * shipped: that bubble wears `kind: 'nudge'` deliberately (it is the same
   * class of interruption, and the renderer should style it identically) while
   * never entering the machine at all — a balance has no thresholds to
   * bookkeep. Stated on the kind, the invariant therefore *fails* on a
   * perfectly correct credits bark, which is the worst kind of invariant: one
   * that cries wolf on the healthy case and so gets weakened or deleted. The
   * `machine` flag is what actually distinguishes ownership, and it is already
   * what `onPet` branches on (line ~560) — this now says the same thing the
   * code does.
   *
   * Every write to `activeBubble` therefore goes through one of two paths —
   * `applyNudgeEvents` (the only place a `machine: true` bubble is created or
   * cleared, and only in response to the machine's own `show`/`clear`) and the
   * external/sleepy paths (which never set the flag, credits notice included).
   * `onPet` is the one place the two meet, and it routes a machine-owned bark
   * to `machine.onPet` rather than clearing the bubble itself, precisely to
   * keep this true.
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

  /**
   * The rows the owner has taken off the hover card, which never bark either.
   *
   * Pushed in whole rather than toggled one id at a time: the store holds the
   * list and the tray rewrites it, so a second copy of "which are hidden now"
   * assembled here could only ever drift from it.
   *
   * Emits nothing and changes no memory on purpose — see `onUsage`.
   */
  setHiddenBuckets(ids: readonly string[]): void {
    this.hiddenBuckets = new Set(ids);
  }

  /** A fresh usage snapshot: sets the face, and may bark. */
  onUsage(snapshot: UsageSnapshot, now: number): SceneEvent[] {
    const events: SceneEvent[] = [];

    for (const bucket of snapshot.buckets) this.priorities.set(bucket.id, bucket.priority);

    /*
     * The barks see only the rows the owner left on the card; the face sees all
     * of them.
     *
     * Both bark paths are filtered — the thresholds below and the exhaustion
     * edges after them — because "hidden" was sold to the owner as "off the card
     * and silent", and a hidden credits row announcing itself would be the one
     * exception nobody would think to look for.
     *
     * A hidden row's *memory* is untouched by this, which is the point of
     * filtering the input rather than the output: `NudgeMachine` never sees the
     * row, so its `lastFired` stays exactly where it was, and the exhaustion map
     * below keeps the edge it last recorded. Un-hiding therefore restores a row
     * that is already past the levels it announced, rather than one that barks
     * its way back up through all of them.
     */
    const audible = this.hiddenBuckets.size === 0
      ? snapshot.buckets
      : snapshot.buckets.filter((bucket) => !this.hiddenBuckets.has(bucket.id));

    // Recomputed rather than read from `snapshot.expression`: the same rule, but
    // it cannot be out of step with the buckets the barks are derived from.
    this.pushExpression(expressionFor(pctForFace(snapshot.buckets)), events);

    this.applyNudgeEvents(this.machine.onUsage(barkableBuckets(audible), now), now, events);
    // After the thresholds, and only ever queued: if a real window bark took
    // the screen this tick, "none left" waits behind it and `settle` shows it
    // when that one clears, rather than overwriting a warning the owner has
    // had no time to read.
    this.queueExhaustionBarks(audible);
    this.settle(now, events);
    return events;
  }

  /**
   * Queue one bark per row that has just said it ran out — a credits pool
   * emptying, or claude.ai refusing further extra usage.
   *
   * Queued at the **front**, ahead of any waiting perk, `?` or update notice,
   * because it is the same class of thing as a threshold bark: something about
   * the owner's allowance that has changed and that he will otherwise discover
   * by a tool failing. At most one per bucket is ever queued — a second edge
   * cannot occur without the flag first going false, and the replace-in-place
   * below covers the case where it does so while the first is still waiting.
   *
   * One detector for both kinds, not two: the edge rule, the front-queueing
   * and the "never forget a row that vanished" rule are the whole mechanism,
   * and duplicating them per kind is how the second copy quietly drifts from
   * the first. Only the sentence differs — see `exhaustionText`.
   */
  private queueExhaustionBarks(buckets: readonly Bucket[]): void {
    for (const bucket of buckets) {
      const text = exhaustionText(bucket);
      // Not an exhaustible row at all (an ordinary window, or a kind whose
      // detail object is missing) — nothing to remember either way.
      if (text === null && bucket.kind !== 'credits' && bucket.kind !== 'money') continue;
      const before = this.exhausted.get(bucket.id);
      this.exhausted.set(bucket.id, text !== null);
      if (text === null || before === true) continue;

      const item: PendingExternal = {
        kind: 'nudge',
        text,
        ttlMs: null,
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
        // Two external exhaustion alerts may be queued with different text.
        // Dismissing the one on screen must let the next one promote; unlike a
        // machine-owned nudge, it has no state machine to retire it for us.
        //
        // **Kind *and* source**: one click is one dismissal of one message, and
        // a queued `Codex done` is a different message from the `Claude done`
        // just clicked away — dropping it with its sibling would lose a reply
        // the owner was never told about. The source is `undefined` on both
        // sides for every kind that has none, so those behave as before.
        if (active.kind !== 'nudge') {
          this.pending = this.pending.filter(
            (item) => !(item.kind === active.kind && item.source === active.source)
          );
        }
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

  /**
   * Call at `nextDeadlineAt`. Expires the bubble whose time is up, and runs the
   * presence linger.
   *
   * The `NudgeMachine` is deliberately NOT ticked here any more — it no longer
   * has a clock. A bark is retired by `onPet` or by its own window crossing a
   * higher threshold, and by nothing else. The only bubble left with a ttl is
   * the `…zzz`, which is why the loop below is the whole of the bubble half.
   */
  onTick(now: number): SceneEvent[] {
    const events: SceneEvent[] = [];

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
   * A Claude Code (or Codex) hook fired.
   *
   * `done` and `waiting` are queued rather than shown directly, because a usage
   * bark outranks them: a burst of replies must not back up into a minute of
   * bubbles. `prompt` is the *end* of a wait — it clears that tool's bubble and
   * never shows anything of its own.
   *
   * **The queue holds one of each kind *per tool*** (0.2.5). It used to be one
   * per kind full stop, which was right while `woof` was the only sentence
   * there was: two `woof`s say nothing two do not. Now they name the tool, and
   * collapsing `Claude done` into `Codex done` would throw away the one fact
   * the owner asked for — he runs both, seconds apart, and needs to know which
   * finished. Same argument for `prompt`: typing at Claude Code says nothing
   * about whether Codex is still waiting for an approval, so it clears only its
   * own tool's `?`, queued or on screen.
   */
  onHook(kind: HookKind, source: HookSource, now: number): SceneEvent[] {
    const events: SceneEvent[] = [];

    if (kind === 'prompt') {
      this.pending = this.pending.filter(
        (item) => !(item.kind === 'waiting' && item.source === source)
      );
      if (this.activeBubble?.kind === 'waiting' && this.activeBubble.source === source) {
        this.activeBubble = null;
        events.push(bubbleCleared());
      }
      this.settle(now, events);
      return events;
    }

    const item: PendingExternal =
      kind === 'done'
        ? { kind: 'perk', text: hookDoneText(source), ttlMs: null, animation: ANIM_PERK, source }
        : {
            kind: 'waiting',
            text: hookWaitingText(source),
            ttlMs: null,
            animation: ANIM_TILT,
            source
          };

    const at = this.pending.findIndex(
      (queued) => queued.kind === item.kind && queued.source === item.source
    );
    if (at >= 0) this.pending[at] = item;
    // Ahead of a queued update notice: a finished reply or a wait is about what
    // the owner is doing right now, and "0.1.3 is out" has waited six hours
    // already and can wait another five seconds.
    else this.pending.splice(this.updateQueuePosition(), 0, item);

    this.settle(now, events);
    return events;
  }

  /**
   * **The one entry point for a low-priority notice about the app itself.**
   *
   * Everything Walder says about *himself* rather than about the owner's usage
   * arrives here: a new version, the answer to a manual update check, and (0.2.5)
   * the fact that his Claude Code hooks are not installed. They share every rule,
   * which is why they share one method rather than one method each drifting
   * apart:
   *
   *  - queued, never shown over something already on screen;
   *  - **last** in the queue (`updateQueuePosition`), behind any hook bubble —
   *    those are about what the owner is doing this second, and none of these is;
   *  - at most one is ever queued, the newest replacing the older, so a dog left
   *    running for a week cannot accumulate a stack of stale announcements;
   *  - a usage bark takes the screen from one outright, and it is *not* re-queued
   *    afterwards (see `applyNudgeEvents`).
   *
   * The *decision* to say any of them is never made here: the callers own the
   * "once" — `index.ts` records the version it has notified about, and only a
   * manual check reaches `onUpToDate`. This method's job is only to queue the
   * bubble politely.
   *
   * Promotion runs through `settle` → `wake` → `attention`, so a dog hidden by
   * the hide-when-idle mode appears for it.
   */
  onNotice(text: string, now: number): SceneEvent[] {
    const events: SceneEvent[] = [];
    const item: PendingExternal = {
      kind: 'update',
      text,
      ttlMs: null,
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

  /**
   * A newer version of Walder exists. `index.ts` calls this at most once per
   * version; the queueing rules are `onNotice`'s.
   */
  onUpdateAvailable(version: string, now: number): SceneEvent[] {
    return this.onNotice(updateText(version), now);
  }

  /**
   * A check the owner asked for found nothing.
   *
   * **Only ever after a manual check** — `main/update-check.ts` carries the flag
   * and `index.ts` spends it. A click that produces no visible answer at all is
   * indistinguishable from a click that did nothing, and the six-hourly check
   * saying the same thing forever would be nagging. See `UP_TO_DATE_TEXT`.
   */
  onUpToDate(now: number): SceneEvent[] {
    return this.onNotice(UP_TO_DATE_TEXT, now);
  }

  /* -------------------------------------------------------------- internals */

  /**
   * Where the queued app notice is, or the end of the queue when there is none.
   * Both "replace the queued one" and "insert a hook's bubble in front of it"
   * are the same index, which is why it is one helper — and it is why every
   * notice wears `kind: 'update'`, whatever it says (see `onNotice`).
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
        // *not* re-queued: the priority runs both ways. A "Claude done" that
        // has already been seen has done its whole job, while a threshold
        // warning held back for five seconds is a warning shown after the fact.
        this.activeBubble = {
          kind: 'nudge',
          text: nudgeText(event.nudge.label, event.nudge.pct),
          ttlMs: null,
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
        shownAt: now,
        // Carried through, not re-derived: a promoted `?` has to stay Claude's
        // or Codex's, or the next `prompt` clears the wrong one. Spread so the
        // field stays absent (never `undefined`) on the kinds that have none —
        // `exactOptionalPropertyTypes`.
        ...(next.source === undefined ? {} : { source: next.source })
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

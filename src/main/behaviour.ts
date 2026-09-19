/**
 * Wiring for the behaviour coordinator: the thin main-process shell around
 * `core/behaviour.ts`.
 *
 * Everything that decides *what* Walder does is in the pure coordinator. This
 * file does three things and nothing else:
 *
 *  - feeds it the real clock and the real inputs (a poll, a click, a hook, a
 *    fullscreen change);
 *  - turns each `SceneEvent` into either a window call (`mode` -> `applyBox`,
 *    which resizes and re-sends `mode:set`) or one IPC message to the overlay;
 *  - arms exactly one timer, for the coordinator's own next deadline.
 *
 * The single timer matters: it is armed only while a bubble with a time limit is
 * on screen, so an idle Walder wakes the CPU for this exactly never. Two bubbles
 * have one: the `…zzz` of a sleeping pet, for a second and a half, and — since
 * 0.2.6 — the `waiting` head-tilt, for thirty minutes (`WAITING_STALE_MS`). The
 * `?` is still normally dismissed by a pet or by the next prompt long before
 * that; the timer exists for the terminal that was closed with the question
 * unanswered, which can send no prompt ever. One `setTimeout` half an hour out
 * is not a wakeup anybody can measure.
 */
import { Behaviour, type BehaviourMemory, type SceneEvent } from '../core/behaviour';
import { BARK_LEVELS, DEFAULT_BARK_PRESET, type BarkPreset } from '../core/nudge';
import { bubbleColumnsNeeded } from '../core/bubble';
import { createNoticeGate } from '../core/notify';
import type { UsageSnapshot } from '../core/usage';
import type { HookEvent } from './hook-server';
import { CH } from './ipc';
import type { Overlay } from './overlay-window';
import { vlog, warn } from './log';

export interface BehaviourDeps {
  /**
   * Resolved per call, never captured: `ensureOverlay` can replace the window,
   * and a captured handle would leave every animation talking to a dead one.
   */
  readonly getOverlay: () => Overlay | null;
  readonly now?: () => number;
  /**
   * Does the loaded sheet have this animation? Only the sleeping-box pet needs
   * to know (see `Behaviour.onPet`); everything else relies on the renderer's
   * own fallback to the idle loop.
   */
  readonly hasAnimation?: (name: string) => boolean;
  /**
   * Ask for fresh numbers, because the owner just petted the dog.
   *
   * The owner's request (2026-09-09): a click on Walder is the gesture for "so
   * where am I?", and it used to dismiss the bubble and wiggle while the numbers
   * behind it stayed up to three minutes old. Wired to the poller's own
   * `refreshNow`, which already carries the 60 s manual cooldown — so a burst of
   * petting cannot be used to hammer the endpoints, and a refusal is not an
   * error here: within the cooldown this does nothing at all, and the panel keeps
   * the numbers it has (the poller logs one `vlog` line and no more).
   *
   * Optional, so the coordinator still runs — dismissing bubbles, playing the
   * pet animation — with no poller wired to it.
   */
  readonly refreshUsage?: () => void;
  /**
   * Is the hide-when-idle mode on, according to the settings file?
   *
   * Read once, at construction, and turned into a `setHideWhenIdle(true)` — see
   * `createBehaviour`. Optional, so a host that has no such setting simply gets
   * a Walder who is always on screen.
   */
  readonly hideWhenIdle?: () => boolean;
  /**
   * Which bark preset the owner has picked, straight off the settings file.
   *
   * Read **once**, at construction, like `hideWhenIdle`: this is the initial
   * `levels` the `NudgeMachine` is built with, not a value re-checked per
   * poll. Every later change comes through the tray, which writes the store
   * and then calls `BehaviourHandle.setBarkPreset` itself — the same split as
   * `hiddenBuckets`. Optional, so a host with no settings file simply gets the
   * machine's own default (`BARK_LEVELS.normal`).
   */
  readonly barkPreset?: () => BarkPreset;
  /**
   * He has just left the screen.
   *
   * Wired to hiding the hover card, and it has to be a separate call rather
   * than something the renderer notices: a hidden window sends no `mouseleave`,
   * so a card that was up when he vanished would hang there beside nothing at
   * all until the cursor happened to cross the space he used to occupy.
   */
  readonly onHidden?: () => void;
  /**
   * What he remembered when he was last quit, straight off the settings file.
   *
   * Read **once**, at construction, like `hideWhenIdle` — and `unknown` rather
   * than `BehaviourMemory` on purpose: this is a user-writable JSON blob, and
   * the coordinator validates it field by field. Optional, so a host with no
   * settings file simply gets a Walder who starts each run with a clean memory
   * (which is the 0.2.4 behaviour, bug and all).
   */
  readonly memory?: () => unknown;
  /**
   * Persist what he remembers now. Called after a poll, and only when the
   * memory actually changed — see `createBehaviour`.
   */
  readonly saveMemory?: (memory: BehaviourMemory) => void;
  /**
   * Which rows the owner has taken off the hover card, straight off the
   * settings file.
   *
   * Read **once**, at construction, like `hideWhenIdle` and `memory`: every
   * later change comes through the tray, which writes the store and then calls
   * `setHiddenBuckets` itself, so re-reading per poll would only ever hand the
   * coordinator back what it was already told.
   */
  readonly hiddenBuckets?: () => readonly string[];
  /**
   * Is the notification fallback on, according to the settings file?
   *
   * Read per batch rather than once at construction, unlike `hideWhenIdle`:
   * nothing here is the writer, the tray flips the key underneath us, and an
   * owner who ticks it because a film is starting means it for this film.
   */
  readonly notifyWhenHidden?: () => boolean;
  /**
   * Say it out loud, because the dog saying it cannot be seen.
   *
   * Injected rather than built here for two reasons. This file is deliberately
   * electron-free — it takes the overlay through a getter and imports its type
   * only — and a real `Notification` would make every test of it need a mocked
   * `electron`. And `index.ts`'s implementation constructs the notification at
   * the moment of delivery: macOS asks for permission the first time one is
   * *shown*, so a Walder that built one at launch would ask for a permission it
   * has a setting saying it must not use.
   */
  readonly notify?: (text: string) => void;
}

export interface BehaviourHandle {
  onUsage(snapshot: UsageSnapshot): void;
  onPet(): void;
  /** One mapped hook event — which tool it came from included. */
  onHook(event: HookEvent): void;
  setFullscreen(fullscreen: boolean): void;
  /** For the tray's developer toggle. */
  isFullscreen(): boolean;
  /**
   * Turn the hide-when-idle mode on or off. One entry point for both the menu
   * checkbox and the global shortcut — see `setHideWhenIdle` in `index.ts`.
   */
  setHideWhenIdle(on: boolean): void;
  /**
   * Is he off screen right now? Read before anything re-shows the window behind
   * presence's back (a second launch, a rebuilt overlay).
   */
  isHidden(): boolean;
  /** A newer version exists; say so once. `index.ts` owns the "once". */
  onUpdateAvailable(version: string): void;
  /** A check the owner asked for found nothing. Manual checks only. */
  onUpToDate(): void;
  /**
   * Any other low-priority notice about the app itself. One entry point, one set
   * of queueing rules — see `Behaviour.onNotice`.
   */
  onNotice(text: string): void;
  /** The renderer (re)loaded: send it the face and the bubble again. */
  resync(): void;
  /** The "Show in overview" ticks changed; hidden rows go quiet immediately. */
  setHiddenBuckets(ids: readonly string[]): void;
  /** The tray's Barks radio group changed. */
  setBarkPreset(preset: BarkPreset): void;
  stop(): void;
}

export function createBehaviour(deps: BehaviourDeps): BehaviourHandle {
  const now = deps.now ?? ((): number => Date.now());
  const behaviour = new Behaviour({
    // Read once, at construction: the coordinator is the only writer of this
    // value, so re-reading it per poll could only ever hand it back its own
    // last write — with one extra chance of reading a half-written file.
    memory: deps.memory?.(),
    levels: [...BARK_LEVELS[deps.barkPreset?.() ?? DEFAULT_BARK_PRESET]],
    ...(deps.hasAnimation === undefined ? {} : { hasAnimation: deps.hasAnimation })
  });
  // A setter rather than a constructor option, because the tray drives the same
  // call on every change and one entry point cannot drift from itself.
  const hidden = deps.hiddenBuckets?.();
  if (hidden !== undefined) behaviour.setHiddenBuckets(hidden);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  /*
   * The dog as the owner last saw him, tracked from the events themselves.
   *
   * Both `visible` and `mode` are edges — only ever emitted on a change — so
   * the pair as they stand at the *top* of a batch is exactly the state that
   * batch is about to interrupt. That is the state the notification asks about,
   * and it is why this is read before the loop rather than during it: a bark
   * stands the dog up and puts him back on screen in the same batch that
   * carries its bubble (`wake` then `flushPresence`), so anything read
   * alongside the bubble would answer "he is visible" for every bark there is.
   *
   * They start at "standing, on screen", which is what the coordinator starts
   * as — a stored hide-when-idle is applied below, through the same `apply`.
   */
  let offScreen = false;
  let curled = false;
  const notice = createNoticeGate();

  /**
   * The memory as it was last written, serialised — `undefined` until the first
   * save.
   *
   * Compared as JSON rather than by a dirty flag inside the coordinator, which
   * would be a second copy of "has anything changed" living next to the thing
   * that changed. A poll below every threshold still moves `lastPct`, so the
   * write is not rare; what this avoids is the case that *is* common — a
   * provider that failed, or a snapshot identical to the last one — costing a
   * settings-file write every three minutes for the rest of the day.
   */
  let savedMemory: string | undefined;

  /**
   * Persist the memory if it moved. Called after a poll and nowhere else: a
   * poll is the only input that can change what he must not repeat, and a pet
   * or a hook writing the file would be a disk touch per click.
   */
  function saveMemory(): void {
    if (deps.saveMemory === undefined) return;
    const memory = behaviour.memory();
    const json = JSON.stringify(memory);
    if (json === savedMemory) return;
    try {
      deps.saveMemory(memory);
      // Only after the write took: recording it first would mean one failed
      // write is never retried, and the memory silently stops persisting.
      savedMemory = json;
    } catch (error) {
      warn('could not persist the bark memory:', error);
    }
  }

  /** Apply one batch in order, then re-arm for whatever it left on the clock. */
  function apply(events: readonly SceneEvent[]): void {
    if (events.length > 0) vlog('scene:', events.map((event) => event.type).join(', '));

    const unseen = {
      hidden: offScreen,
      curled,
      enabled: deps.notifyWhenHidden?.() === true
    };

    for (const event of events) {
      /*
       * The presence bookkeeping and the notification, before the overlay is
       * even looked up: a batch applied while the window is being rebuilt still
       * happened as far as the coordinator is concerned, and a `visible` missed
       * there would leave this believing he is on screen for the rest of the
       * run.
       */
      if (event.type === 'visible') offScreen = !event.shown;
      else if (event.type === 'mode') curled = event.box === 'sleep';
      else if (event.type === 'bubble' && notice(event, unseen)) {
        try {
          deps.notify?.(event.text);
        } catch (error) {
          // A notification centre that refused is no reason to drop the rest of
          // the scene: the bubble is the real message, this is the fallback.
          warn('could not post the notification:', error);
        }
      }

      const overlay = deps.getOverlay();
      if (overlay === null) continue;

      if (event.type === 'mode') {
        // A box change is a window resize; `applyBox` does that and tells the
        // renderer through `mode:set`, which is also what carries the scale.
        overlay.applyBox(event.box);
        continue;
      }

      if (event.type === 'bubble') {
        /*
         * A bubble is also a window resize: the window cannot grow once the
         * renderer is drawing, so the room has to be taken before the text is
         * sent. Widen first, *then* send it, so the renderer's first paint
         * already has the width.
         *
         * **Widened for a ONE-line fit**, which is the 0.2.5 fix. It used to ask
         * for the two-line width, and the owner received `7-day (all models):
         * 80%…` on 2026-09-15 — the word that says what the number means, cut
         * off. Two lines only fit if two things hold at once: `drawBubble` must
         * derive `rows = 2` from the reserve (every term of that rounds
         * independently at dpr 1.5), and the measured glyph advance must not
         * exceed `bubbleColumnPx`'s estimate. Either falling short by a pixel
         * costs a whole line, and a lost line is an ellipsis. Asking for one line
         * removes both dependencies: the renderer may still *wrap* to two lines
         * when its own measurement is wider than the estimate — which is fine and
         * invisible — but it can no longer run out of columns and cut.
         */
        overlay.applyBubble(
          event.kind === 'none' ? 0 : bubbleColumnsNeeded(event.text, 1)
        );
      }

      if (event.type === 'visible') {
        overlay.setVisible(event.shown);
        // A hidden window sends no `mouseleave`, so nothing else would take the
        // hover card down.
        if (!event.shown) deps.onHidden?.();
        // And it is *also* forwarded, below: the renderer has its own animation
        // timer, and `backgroundThrottling: false` means a hidden window keeps
        // ticking at full cadence until it is told to stop.
      }

      overlay.send(CH.scene, event);
    }

    arm();
  }

  function arm(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (stopped) return;
    const at = behaviour.nextDeadlineAt();
    if (at === null) return;
    timer = setTimeout(
      () => {
        timer = null;
        apply(behaviour.onTick(now()));
      },
      Math.max(0, at - now())
    );
  }

  /*
   * The stored hide-when-idle preference, applied as a *setter call* rather than
   * a constructor option.
   *
   * Deliberate: the option alone would leave him on screen until the first
   * `settle` started an eight-second linger, so a Walder with the mode on would
   * appear at every launch and then wander off. Only `setHideWhenIdle` hides
   * immediately, which makes this first batch carry `visible:false` — and
   * `Overlay.setVisible` remembers it across `ready-to-show`, so there is no
   * frame in which he is visible at all.
   */
  if (deps.hideWhenIdle?.() === true) apply(behaviour.setHideWhenIdle(true, now()));

  return {
    onUsage(snapshot: UsageSnapshot): void {
      apply(behaviour.onUsage(snapshot, now()));
      // After the scene, never before it: what he says is worth more than what
      // he remembers about having said it, and the write can fail.
      saveMemory();
    },

    onPet(): void {
      // The visible reaction first, then the request. `refreshNow` returns
      // immediately either way (it starts a poll or declines on the cooldown),
      // but the wiggle should not wait on anything.
      apply(behaviour.onPet(now()));
      deps.refreshUsage?.();
    },

    onHook(event: HookEvent): void {
      apply(behaviour.onHook(event.kind, event.source, now()));
    },

    setFullscreen(fullscreen: boolean): void {
      apply(behaviour.setFullscreen(fullscreen, now()));
    },

    isFullscreen(): boolean {
      return behaviour.fullscreenActive;
    },

    setHideWhenIdle(on: boolean): void {
      apply(behaviour.setHideWhenIdle(on, now()));
    },

    isHidden(): boolean {
      return behaviour.hidden;
    },

    onUpdateAvailable(version: string): void {
      apply(behaviour.onUpdateAvailable(version, now()));
    },

    onUpToDate(): void {
      apply(behaviour.onUpToDate(now()));
    },

    onNotice(text: string): void {
      apply(behaviour.onNotice(text, now()));
    },

    resync(): void {
      apply(behaviour.resync());
    },

    // No `apply`: the coordinator emits nothing for this. The card is redrawn by
    // the poller's own republish, and the only thing that changes here is what
    // the *next* snapshot is allowed to bark about.
    setHiddenBuckets(ids: readonly string[]): void {
      behaviour.setHiddenBuckets(ids);
    },

    // Also no `apply`: same reason as `setHiddenBuckets` — nothing about the
    // dog or the card changes here, only which thresholds the *next* snapshot
    // may bark about.
    setBarkPreset(preset: BarkPreset): void {
      behaviour.setBarkPreset(preset);
    },

    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}

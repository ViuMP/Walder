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
 * on screen, so an idle Walder wakes the CPU for this exactly never. The
 * `waiting` bubble has no deadline at all — it is dismissed by a pet or by the
 * next prompt — and correspondingly arms nothing.
 */
import { Behaviour, type HookKind, type SceneEvent } from '../core/behaviour';
import { bubbleColumnsNeeded } from '../core/bubble';
import type { UsageSnapshot } from '../core/usage';
import { CH } from './ipc';
import type { Overlay } from './overlay-window';
import { vlog } from './log';

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
}

export interface BehaviourHandle {
  onUsage(snapshot: UsageSnapshot): void;
  onPet(): void;
  onHook(kind: HookKind): void;
  setFullscreen(fullscreen: boolean): void;
  /** For the tray's developer toggle. */
  isFullscreen(): boolean;
  stop(): void;
}

export function createBehaviour(deps: BehaviourDeps): BehaviourHandle {
  const now = deps.now ?? ((): number => Date.now());
  const behaviour = new Behaviour(
    deps.hasAnimation === undefined ? {} : { hasAnimation: deps.hasAnimation }
  );
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  /** Apply one batch in order, then re-arm for whatever it left on the clock. */
  function apply(events: readonly SceneEvent[]): void {
    if (events.length > 0) vlog('scene:', events.map((event) => event.type).join(', '));

    for (const event of events) {
      const overlay = deps.getOverlay();
      if (overlay === null) continue;

      if (event.type === 'mode') {
        // A box change is a window resize; `applyBox` does that and tells the
        // renderer through `mode:set`, which is also what carries the scale.
        overlay.applyBox(event.box);
        continue;
      }

      if (event.type === 'bubble') {
        // A bubble is also a window resize: the window cannot grow once the
        // renderer is drawing, so at the small size a long bark would be
        // ellipsised down to `7-day (all mod…`. Widen first, *then* send the
        // text, so the renderer's first paint of it already has the room.
        overlay.applyBubble(
          event.kind === 'none' ? 0 : bubbleColumnsNeeded(event.text)
        );
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

  return {
    onUsage(snapshot: UsageSnapshot): void {
      apply(behaviour.onUsage(snapshot, now()));
    },

    onPet(): void {
      apply(behaviour.onPet(now()));
    },

    onHook(kind: HookKind): void {
      apply(behaviour.onHook(kind, now()));
    },

    setFullscreen(fullscreen: boolean): void {
      apply(behaviour.setFullscreen(fullscreen, now()));
    },

    isFullscreen(): boolean {
      return behaviour.fullscreenActive;
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

/**
 * The one decision behind the notification fallback: should a bubble the owner
 * cannot see be repeated as a native notification?
 *
 * It lives here, and not in `main/behaviour.ts`, because it is a rule rather
 * than a wiring — which kinds are worth interrupting for, and what "he has
 * already been told this" means — and because the wiring side has no way to
 * test the second half without a real notification centre.
 *
 * Nothing here knows what a notification *is*. It answers a question about
 * bubbles; `main/behaviour.ts` owns the sink and `index.ts` owns the Electron
 * `Notification`.
 */
import type { BubbleKind } from './bubble';

/**
 * The kinds worth waking the notification centre for.
 *
 * Both are about the owner and about *now*: a threshold bark is his allowance
 * running out, and a head-tilt is a tool blocked until he answers. The others
 * are deliberately absent. `perk` ("Claude is done") and `update` ("0.2.7 is
 * out") are news that keeps until he next looks at the dog, and a mascot that
 * posts a system notification about its own release notes is the one thing this
 * feature would be remembered for. `sleepy` is the dog mumbling at a pet — he
 * was being clicked on, so he was visibly there.
 */
const SPOKEN: readonly BubbleKind[] = ['nudge', 'waiting'];

/** Where the dog was when the bubble arrived, and whether the owner asked for this. */
export interface UnseenState {
  /** Hidden by hide-when-idle: the window is not on screen at all. */
  readonly hidden: boolean;
  /** Curled in the tiny sleeping box behind a fullscreen window. */
  readonly curled: boolean;
  /** The `notifyWhenHidden` setting. Off by default, so this is normally false. */
  readonly enabled: boolean;
}

/**
 * A gate that must be told about **every** bubble event, in order, and answers
 * whether that one is worth a notification.
 *
 * The "every" is the once-per-bark guard, and it is why this is a closure and
 * not a plain function: the gate remembers which bubble it believes is on
 * screen, so the only event that can fire is the one that *put* it there. A
 * renderer reload re-sends the identical bubble (`Behaviour.resync`), and a
 * second notification about a bark the owner has already been told about is the
 * fastest way to have the whole setting turned off again.
 *
 * A clear (`kind: 'none'`) empties the memory rather than keeping the text, so
 * the same label crossing the same threshold in a *later* window does speak
 * again — that is a new fact, not a repeat.
 */
export function createNoticeGate(): (
  bubble: { readonly kind: BubbleKind; readonly text: string },
  state: UnseenState
) => boolean {
  /** The bubble believed to be on screen, or `null` for a clear screen. */
  let onScreen: string | null = null;

  return (bubble, state) => {
    // Kind and text both, because the same words under a different kind are a
    // different message — and the newline cannot appear in either half.
    const key = bubble.kind === 'none' ? null : `${bubble.kind}\n${bubble.text}`;
    const fresh = key !== null && key !== onScreen;
    onScreen = key;
    return (
      fresh && state.enabled && (state.hidden || state.curled) && SPOKEN.includes(bubble.kind)
    );
  };
}

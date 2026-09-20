/**
 * Audio is deliberately narrower than bubbles: an opted-in threshold bark is a
 * useful accent, while sounding every status message would make Walder another
 * notification channel. The renderer owns playback; this pure gate keeps that
 * policy testable without a browser or an Audio element.
 */
import type { BubbleKind } from './bubble';

export function shouldPlayBark(kind: BubbleKind, enabled: boolean): boolean {
  return enabled && kind === 'nudge';
}

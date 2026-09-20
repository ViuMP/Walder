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

/** Main owns the preference; the overlay only needs its present on/off state. */
export interface BarkSoundPayload {
  readonly barkSound: boolean;
}

/**
 * Here rather than in `main/ipc.ts`, like `parseSessionsPayload`: the overlay
 * validates what main sends it with the same function main types it with, and
 * the renderer imports nothing at runtime from `src/main`.
 */
export function parseBarkSoundPayload(raw: unknown): BarkSoundPayload | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { barkSound } = raw as Record<string, unknown>;
  return typeof barkSound === 'boolean' ? { barkSound } : null;
}

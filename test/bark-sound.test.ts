import { describe, expect, it } from 'vitest';
import { shouldPlayBark } from '../src/core/bark-sound';
import type { BubbleKind } from '../src/core/bubble';

const KINDS: readonly BubbleKind[] = ['nudge', 'perk', 'waiting', 'sleepy', 'update', 'none'];

describe('shouldPlayBark', () => {
  it('plays only opted-in threshold nudges', () => {
    for (const kind of KINDS) {
      expect(shouldPlayBark(kind, false)).toBe(false);
      expect(shouldPlayBark(kind, true)).toBe(kind === 'nudge');
    }
  });
});

import { describe, expect, it } from 'vitest';
import { parseBarkSoundPayload, shouldPlayBark } from '../src/core/bark-sound';
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

describe('parseBarkSoundPayload', () => {
  it('accepts only a boolean barkSound', () => {
    expect(parseBarkSoundPayload({ barkSound: true })).toEqual({ barkSound: true });
    expect(parseBarkSoundPayload({ barkSound: false })).toEqual({ barkSound: false });
    for (const bad of [{ barkSound: 'yes' }, { barkSound: 1 }, {}, null, [], 'true']) {
      expect(parseBarkSoundPayload(bad)).toBeNull();
    }
  });
});

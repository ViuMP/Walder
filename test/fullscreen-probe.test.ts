import { describe, expect, it } from 'vitest';
import { toTopLeft } from '../scripts/fullscreen-probe';

describe('scripts/fullscreen-probe toTopLeft', () => {
  it('puts the primary screen at (0, 0) and flips the others against its height', () => {
    // Primary 1728x1117; a 2560x1440 monitor to its right, bottom-aligned (AppKit y = 0).
    const frames = [
      { x: 0, y: 0, width: 1728, height: 1117 },
      { x: 1728, y: 0, width: 2560, height: 1440 }
    ];
    expect(toTopLeft(frames)).toEqual([
      { x: 0, y: 0, width: 1728, height: 1117 },
      { x: 1728, y: -323, width: 2560, height: 1440 }
    ]);
  });

  it('places a monitor above the primary at a negative top-left y', () => {
    expect(toTopLeft([{ x: 0, y: 0, width: 1728, height: 1117 }, { x: 0, y: 1117, width: 1920, height: 1080 }])[1])
      .toEqual({ x: 0, y: -1080, width: 1920, height: 1080 });
  });
});

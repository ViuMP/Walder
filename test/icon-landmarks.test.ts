import { describe, expect, it } from 'vitest';
import { isLowerLegShade } from '../scripts/icon-landmarks';

describe('icon facial landmarks', () => {
  const ink = { y: 26, height: 46 };
  const crop = { y: 22, height: 37 };

  it('excludes the isolated iris-coloured paw shade that lies below a valid head crop', () => {
    const paw = { count: 1, y: 66 };
    expect(paw.y).toBeGreaterThanOrEqual(crop.y + crop.height);
    expect(isLowerLegShade(paw, ink, '#2D1A0D')).toBe(true);
  });

  it('retains an upper facial singleton even when the crop clips it', () => {
    const clippedFace = { count: 1, y: 59 };
    expect(clippedFace.y).toBeGreaterThanOrEqual(crop.y + crop.height);
    expect(isLowerLegShade(clippedFace, ink, '#2D1A0D')).toBe(false);
  });

  it('retains an outside multi-pixel cluster even in the lower-leg region', () => {
    const clippedCluster = { count: 2, y: 66 };
    expect(clippedCluster.y).toBeGreaterThanOrEqual(crop.y + crop.height);
    expect(isLowerLegShade(clippedCluster, ink, '#2D1A0D')).toBe(false);
  });

  it('retains white highlights and nose ink anywhere in the silhouette', () => {
    for (const color of ['#FFFFFF', '#1F1208']) {
      expect(isLowerLegShade({ count: 1, y: 66 }, ink, color)).toBe(false);
    }
  });
});

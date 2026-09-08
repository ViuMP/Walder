/**
 * The sheet contract and palette resolution.
 *
 * `validateSheet` (tested in `sprites.test.ts`) proves a sheet is internally
 * consistent. It cannot know the names *this app* hard-codes: the renderer picks
 * its animation by name, and the window is sized from the stand box, so art that
 * renamed `idle` or resized `stand` would produce a blank or mis-framed dog with
 * no error anywhere. `requireSheetContract` is the assertion that turns that into
 * a startup failure with a message, and this is what pins it down.
 */
import { describe, expect, it } from 'vitest';
import { SpriteSheetError, type SpriteSheet } from '../src/sprites/types';
import { FALLBACK_PALETTE, loadSheet, requireSheetContract, resolvePalette } from '../src/main/sheet';

/**
 * A sheet that satisfies the contract. Only `boxes` and `animations` are looked
 * at, so the frames need not be real — individual tests break one thing.
 */
function contractSheet(patch: Partial<SpriteSheet> = {}): SpriteSheet {
  const base = {
    boxes: { stand: [48, 40], sleep: [32, 24] },
    palettes: { golden: { a: '#fff' } },
    frames: { f: { box: 'stand', rows: [] } },
    animations: {
      idle: { frames: ['f'], durationsMs: [500], loop: true },
      sleep: { frames: ['f'], durationsMs: [900], loop: true }
    }
  } as unknown as SpriteSheet;
  return { ...base, ...patch };
}

describe('requireSheetContract', () => {
  it('accepts a sheet with the required animations and box sizes', () => {
    expect(() => requireSheetContract(contractSheet())).not.toThrow();
  });

  it('ignores extra animations and extra boxes', () => {
    const extra = contractSheet({
      boxes: { stand: [48, 40], sleep: [32, 24], banner: [64, 16] },
      animations: {
        idle: { frames: ['f'], durationsMs: [500], loop: true },
        sleep: { frames: ['f'], durationsMs: [900], loop: true },
        bark: { frames: ['f'], durationsMs: [80], loop: false }
      }
    } as unknown as Partial<SpriteSheet>);
    expect(() => requireSheetContract(extra)).not.toThrow();
  });

  describe('animations', () => {
    it('names a missing "idle"', () => {
      const s = contractSheet({
        animations: { sleep: { frames: ['f'], durationsMs: [900], loop: true } }
      } as unknown as Partial<SpriteSheet>);
      expect(() => requireSheetContract(s)).toThrow(SpriteSheetError);
      expect(() => requireSheetContract(s)).toThrow(/missing required animation\(s\) "idle"/);
    });

    it('names a missing "sleep"', () => {
      const s = contractSheet({
        animations: { idle: { frames: ['f'], durationsMs: [500], loop: true } }
      } as unknown as Partial<SpriteSheet>);
      expect(() => requireSheetContract(s)).toThrow(/missing required animation\(s\) "sleep"/);
    });

    it('names both when both are gone, and lists what it did find', () => {
      const s = contractSheet({
        animations: { wag: { frames: ['f'], durationsMs: [500], loop: true } }
      } as unknown as Partial<SpriteSheet>);
      expect(() => requireSheetContract(s)).toThrow(/"idle", "sleep"/);
      expect(() => requireSheetContract(s)).toThrow(/has wag/);
    });
  });

  describe('boxes', () => {
    it('rejects a stand box that is not 48x40', () => {
      const s = contractSheet({
        boxes: { stand: [48, 41], sleep: [32, 24] }
      } as unknown as Partial<SpriteSheet>);
      expect(() => requireSheetContract(s)).toThrow(SpriteSheetError);
      expect(() => requireSheetContract(s)).toThrow(
        /box "stand" must be \[48, 40\], got \[48, 41\]/
      );
    });

    it('rejects a sleep box that is not 32x24', () => {
      const s = contractSheet({
        boxes: { stand: [48, 40], sleep: [24, 32] }
      } as unknown as Partial<SpriteSheet>);
      expect(() => requireSheetContract(s)).toThrow(/box "sleep" must be \[32, 24\]/);
    });

    it('names a missing box rather than reporting a size mismatch', () => {
      const s = contractSheet({ boxes: { stand: [48, 40] } } as unknown as Partial<SpriteSheet>);
      expect(() => requireSheetContract(s)).toThrow(
        /missing required box "sleep" \(expected \[32, 24\]\)/
      );
    });

    it('explains why the sizes are not free to change', () => {
      const s = contractSheet({
        boxes: { stand: [64, 64], sleep: [32, 24] }
      } as unknown as Partial<SpriteSheet>);
      expect(() => requireSheetContract(s)).toThrow(/the window is sized from these/);
    });
  });
});

describe('loadSheet', () => {
  it('returns the bundled sheet, and it meets the contract', () => {
    const sheet = loadSheet();
    expect(sheet.boxes['stand']).toEqual([48, 40]);
    expect(sheet.boxes['sleep']).toEqual([32, 24]);
    expect(sheet.animations['idle']).toBeDefined();
    expect(sheet.animations['sleep']).toBeDefined();
    // Idempotent and self-consistent: re-checking what it returned must pass.
    expect(() => requireSheetContract(sheet)).not.toThrow();
  });

  it('carries the fallback palette every renderer path assumes', () => {
    expect(loadSheet().palettes[FALLBACK_PALETTE]).toBeDefined();
  });
});

describe('resolvePalette', () => {
  const sheet = loadSheet();

  it('returns the sheet colours for a palette it has', () => {
    const resolved = resolvePalette(sheet, FALLBACK_PALETTE);
    expect(resolved.name).toBe(FALLBACK_PALETTE);
    expect(resolved.colors).toBe(sheet.palettes[FALLBACK_PALETTE]);
  });

  it('returns null colours for a coat the sheet lacks, keeping the name', () => {
    // Expected, not a bug: the menu offers all five coats while the placeholder
    // art has one, so the choice is remembered and starts working with the art.
    const resolved = resolvePalette(sheet, 'chocolate');
    expect(resolved.name).toBe('chocolate');
    expect(resolved.colors).toBeNull();
  });

  it('does not treat a prototype key as a palette', () => {
    // `sheet.palettes` comes from JSON, so a lookup by an inherited name must
    // not hand the renderer `Object.prototype.constructor` as a colour map.
    expect(resolvePalette(sheet, 'constructor').colors).toBeNull();
    expect(resolvePalette(sheet, '__proto__').colors).toBeNull();
  });

  it('rejects an empty name rather than resolving it', () => {
    expect(resolvePalette(sheet, '').colors).toBeNull();
  });
});

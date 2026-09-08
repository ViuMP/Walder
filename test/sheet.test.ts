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
import {
  FALLBACK_PALETTE,
  boxSize,
  chooseSheetSource,
  isSyncedSheet,
  loadSheet,
  menuPalette,
  requireSheetContract,
  resolvePalette
} from '../src/main/sheet';

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
    /*
     * Box *dimensions* are deliberately not asserted any more (2026-09-08 design
     * gate): the winning mascot design chooses its own, and `overlayMetrics`
     * reads them from the sheet. Only their presence is a contract — which is
     * what these tests pin, along with the fact that a differently-sized sheet is
     * now accepted rather than rejected.
     */
    it('accepts a stand box of any size', () => {
      const s = contractSheet({
        boxes: { stand: [64, 56], sleep: [40, 28] }
      } as unknown as Partial<SpriteSheet>);
      expect(() => requireSheetContract(s)).not.toThrow();
    });

    it('names a missing "sleep" box', () => {
      const s = contractSheet({ boxes: { stand: [48, 40] } } as unknown as Partial<SpriteSheet>);
      expect(() => requireSheetContract(s)).toThrow(SpriteSheetError);
      expect(() => requireSheetContract(s)).toThrow(/missing required box\(es\) "sleep"/);
    });

    it('names a missing "stand" box, and lists what it did find', () => {
      const s = contractSheet({ boxes: { sleep: [32, 24] } } as unknown as Partial<SpriteSheet>);
      expect(() => requireSheetContract(s)).toThrow(/missing required box\(es\) "stand"/);
      expect(() => requireSheetContract(s)).toThrow(/has sleep/);
    });

    it('names both when both are gone', () => {
      const s = contractSheet({ boxes: { banner: [64, 16] } } as unknown as Partial<SpriteSheet>);
      expect(() => requireSheetContract(s)).toThrow(/"stand", "sleep"/);
    });
  });
});

describe('boxSize', () => {
  it('returns the sheet\'s own dimensions as width/height', () => {
    const sheet = contractSheet({
      boxes: { stand: [64, 56], sleep: [40, 28] }
    } as unknown as Partial<SpriteSheet>);
    expect(boxSize(sheet, 'stand')).toEqual({ width: 64, height: 56 });
    expect(boxSize(sheet, 'sleep')).toEqual({ width: 40, height: 28 });
  });

  it('throws for a box the sheet does not have', () => {
    expect(() => boxSize(contractSheet(), 'bark')).toThrow(SpriteSheetError);
  });
});

describe('loadSheet', () => {
  it('returns the bundled sheet, and it meets the contract', () => {
    const sheet = loadSheet();
    // Presence, not size: the size is the art's to choose.
    expect(sheet.boxes['stand']).toBeDefined();
    expect(sheet.boxes['sleep']).toBeDefined();
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
    // Expected, not a bug: a name the owner never typed can still be in the
    // settings file (a coat a later sheet renamed, a hand-edited file). The
    // choice is remembered, and the renderer draws golden meanwhile.
    const resolved = resolvePalette(sheet, 'merle');
    expect(resolved.name).toBe('merle');
    expect(resolved.colors).toBeNull();
  });

  it('resolves every coat the tray menu offers', () => {
    // The five coats in `tray.ts` are the sheet's five palettes; if the art
    // dropped one, the menu would offer a colour that silently did nothing.
    for (const coat of ['golden', 'red', 'cream', 'black-and-tan', 'chocolate']) {
      expect(resolvePalette(sheet, coat).colors, coat).not.toBeNull();
    }
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

describe('the golden palette is part of the contract', () => {
  it('is rejected when missing, because every fallback path assumes it', () => {
    const s = contractSheet({ palettes: { red: { a: '#fff' } } } as unknown as Partial<SpriteSheet>);
    expect(() => requireSheetContract(s)).toThrow(SpriteSheetError);
    expect(() => requireSheetContract(s)).toThrow(/missing the "golden" palette/);
  });
});

describe('isSyncedSheet', () => {
  /*
   * The one thing this has to tell apart is the `{}` stub `scripts/sync-sheet.ts`
   * leaves behind when there is no artwork to copy — an *absent* sheet, which
   * falls back to the placeholder — from a real one, broken or not. Anything
   * structurally wrong must reach `validateSheet` and be reported, not silently
   * swapped for a placeholder dog.
   */
  it('rejects the empty stub', () => {
    expect(isSyncedSheet({})).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isSyncedSheet(null)).toBe(false);
    expect(isSyncedSheet([])).toBe(false);
    expect(isSyncedSheet('{}')).toBe(false);
    expect(isSyncedSheet(undefined)).toBe(false);
  });

  it('accepts anything with content, leaving the verdict to validateSheet', () => {
    expect(isSyncedSheet({ boxes: {} })).toBe(true);
    expect(isSyncedSheet({ nonsense: 1 })).toBe(true);
  });
});

describe('chooseSheetSource', () => {
  it('prefers the synced artwork', () => {
    const chosen = chooseSheetSource({ frames: {} }, { placeholder: true });
    expect(chosen.isReal).toBe(true);
    expect(chosen.name).toBe('walder.json');
    expect(chosen.json).toEqual({ frames: {} });
  });

  it('falls back to the placeholder when no art has been synced', () => {
    const chosen = chooseSheetSource({}, { placeholder: true });
    expect(chosen.isReal).toBe(false);
    expect(chosen.name).toBe('placeholder.json');
    expect(chosen.json).toEqual({ placeholder: true });
  });
});

describe('menuPalette', () => {
  const sheet = loadSheet();

  it('keeps a coat the sheet has', () => {
    expect(menuPalette(sheet, 'red')).toBe('red');
  });

  it('falls back to golden for a coat the sheet lacks', () => {
    // A radio group with no dot on any item reads as broken, so unlike
    // `resolvePalette` the menu cannot keep an unknown name.
    expect(menuPalette(sheet, 'merle')).toBe(FALLBACK_PALETTE);
  });

  it('falls back to golden for a non-string, and for a prototype key', () => {
    expect(menuPalette(sheet, 42)).toBe(FALLBACK_PALETTE);
    expect(menuPalette(sheet, null)).toBe(FALLBACK_PALETTE);
    expect(menuPalette(sheet, 'constructor')).toBe(FALLBACK_PALETTE);
  });
});

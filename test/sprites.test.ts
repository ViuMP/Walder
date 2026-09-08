/**
 * Sheet validation and alpha masks.
 *
 * `validateSheet` is the only gate between hand-drawn JSON and the runtime, and
 * `frameAlphaMask` is what decides whether a click hits the dog or passes through
 * to the window behind. Both are pure, so both are tested here rather than by
 * eye in a running app.
 */
import { describe, expect, it } from 'vitest';
import { SpriteSheetError, validateSheet } from '../src/sprites/types';
import { frameAlphaMask, frameSize, maskBounds } from '../src/sprites/mask';
import placeholder from '../src/sprites/placeholder.json';

/** Minimal well-formed sheet; individual tests break one thing at a time. */
function goodSheet(): Record<string, unknown> {
  return {
    boxes: { tiny: [3, 2] },
    palettes: { golden: { a: '#fff', b: '#000' }, red: { a: '#f00', b: '#900' } },
    frames: { one: { box: 'tiny', rows: ['a.b', '.a.'] } },
    animations: { idle: { frames: ['one'], durationsMs: [500], loop: true } }
  };
}

/** Deep-ish clone so a mutation in one test cannot leak into another. */
function sheetWith(mutate: (sheet: Record<string, any>) => void): Record<string, unknown> {
  const sheet = JSON.parse(JSON.stringify(goodSheet())) as Record<string, any>;
  mutate(sheet);
  return sheet;
}

describe('validateSheet', () => {
  it('accepts a well-formed sheet and returns it typed', () => {
    const sheet = validateSheet(goodSheet());
    expect(sheet.boxes['tiny']).toEqual([3, 2]);
    expect(Object.keys(sheet.palettes)).toEqual(['golden', 'red']);
    expect(sheet.frames['one']?.rows).toEqual(['a.b', '.a.']);
    expect(sheet.animations['idle']?.loop).toBe(true);
  });

  it('accepts the bundled placeholder sheet', () => {
    const sheet = validateSheet(placeholder);
    expect(sheet.boxes['stand']).toEqual([48, 40]);
    expect(sheet.boxes['sleep']).toEqual([32, 24]);
    expect(Object.keys(sheet.frames).sort()).toEqual([
      'idle_neutral_0',
      'idle_neutral_1',
      'sleep_0',
      'sleep_1'
    ]);
    expect(sheet.animations['idle']?.frames).toEqual(['idle_neutral_0', 'idle_neutral_1']);
    expect(sheet.animations['sleep']?.frames).toEqual(['sleep_0', 'sleep_1']);
  });

  it('throws SpriteSheetError, not a bare Error', () => {
    expect(() => validateSheet(null)).toThrow(SpriteSheetError);
    expect(() => validateSheet('nope')).toThrow(/must be an object/);
    expect(() => validateSheet([])).toThrow(/must be an object/);
  });

  describe('boxes', () => {
    it('rejects a box that is not a pair', () => {
      expect(() => validateSheet(sheetWith((s) => (s.boxes.tiny = [3])))).toThrow(
        /\[width, height\] pair/
      );
    });

    it('rejects non-positive and fractional dimensions', () => {
      expect(() => validateSheet(sheetWith((s) => (s.boxes.tiny = [0, 2])))).toThrow(
        /positive integers/
      );
      expect(() => validateSheet(sheetWith((s) => (s.boxes.tiny = [3, 2.5])))).toThrow(
        /positive integers/
      );
      expect(() => validateSheet(sheetWith((s) => (s.boxes.tiny = [3, -2])))).toThrow(
        /positive integers/
      );
    });

    it('rejects an empty boxes map', () => {
      expect(() => validateSheet(sheetWith((s) => (s.boxes = {})))).toThrow(/"boxes" is empty/);
    });
  });

  describe('dimensions', () => {
    it('names the frame and the mismatch when the row count is wrong', () => {
      expect(() =>
        validateSheet(sheetWith((s) => (s.frames.one.rows = ['a.b'])))
      ).toThrow(/frame "one" has 1 rows but box "tiny" is 3x2/);
    });

    it('names the row when its length is wrong', () => {
      expect(() =>
        validateSheet(sheetWith((s) => (s.frames.one.rows = ['a.b', '.a'])))
      ).toThrow(/frame "one" row 1 is 2 characters but box "tiny" is 3x2/);
    });

    it('rejects a frame pointing at a box that does not exist', () => {
      expect(() => validateSheet(sheetWith((s) => (s.frames.one.box = 'huge')))).toThrow(
        /unknown box "huge"/
      );
    });

    it('rejects a non-string row', () => {
      expect(() =>
        validateSheet(sheetWith((s) => (s.frames.one.rows = ['a.b', 42])))
      ).toThrow(/row 1 is not a string/);
    });
  });

  describe('palette keys', () => {
    it('rejects a letter no palette defines, naming row and column', () => {
      expect(() =>
        validateSheet(sheetWith((s) => (s.frames.one.rows = ['a.b', '.q.'])))
      ).toThrow(/frame "one" row 1 column 1 uses key "q"/);
    });

    it('rejects a letter only *some* palettes define', () => {
      // Every palette must cover every used key, or that coat would render holes.
      expect(() =>
        validateSheet(
          sheetWith((s) => {
            s.palettes.golden.c = '#123';
            s.frames.one.rows = ['a.b', '.c.'];
          })
        )
      ).toThrow(/uses key "c", which palette "red" does not define/);
    });

    it('rejects a multi-character palette key', () => {
      expect(() => validateSheet(sheetWith((s) => (s.palettes.golden.ab = '#fff')))).toThrow(
        /must be a single character/
      );
    });

    it('refuses to let a palette claim the transparent marker', () => {
      expect(() => validateSheet(sheetWith((s) => (s.palettes.golden['.'] = '#fff')))).toThrow(
        /reserved for transparent/
      );
    });

    it('rejects a non-string colour', () => {
      expect(() => validateSheet(sheetWith((s) => (s.palettes.golden.a = 12)))).toThrow(
        /must map to a colour string/
      );
    });

    it('rejects an empty palette', () => {
      expect(() => validateSheet(sheetWith((s) => (s.palettes.red = {})))).toThrow(
        /palette "red" is empty/
      );
    });
  });

  describe('animations', () => {
    it('rejects a reference to an unknown frame', () => {
      expect(() =>
        validateSheet(sheetWith((s) => (s.animations.idle.frames = ['ghost'])))
      ).toThrow(/unknown frame "ghost"/);
    });

    it('rejects a duration list of the wrong length', () => {
      expect(() =>
        validateSheet(sheetWith((s) => (s.animations.idle.durationsMs = [100, 200])))
      ).toThrow(/has 2 durations for 1 frames/);
    });

    it('rejects a non-positive or non-finite duration', () => {
      expect(() =>
        validateSheet(sheetWith((s) => (s.animations.idle.durationsMs = [0])))
      ).toThrow(/must be a positive number of ms/);
      expect(() =>
        validateSheet(sheetWith((s) => (s.animations.idle.durationsMs = [-5])))
      ).toThrow(/must be a positive number of ms/);
    });

    it('rejects an empty frame list and a missing loop flag', () => {
      expect(() =>
        validateSheet(sheetWith((s) => (s.animations.idle.frames = [])))
      ).toThrow(/non-empty "frames" array/);
      expect(() => validateSheet(sheetWith((s) => delete s.animations.idle.loop))).toThrow(
        /boolean "loop"/
      );
    });
  });
});

describe('frameSize', () => {
  it('reads dimensions off the rows', () => {
    expect(frameSize({ box: 'tiny', rows: ['a.b', '.a.'] })).toEqual({ width: 3, height: 2 });
  });

  it('reports an empty frame as 0x0 rather than throwing', () => {
    expect(frameSize({ box: 'tiny', rows: [] })).toEqual({ width: 0, height: 0 });
  });
});

describe('frameAlphaMask', () => {
  it('marks every non-transparent cell, row-major', () => {
    const mask = frameAlphaMask({ box: 'tiny', rows: ['a.b', '.a.'] });
    expect(Array.from(mask)).toEqual([1, 0, 1, 0, 1, 0]);
  });

  it('is all zeroes for a fully transparent frame', () => {
    const mask = frameAlphaMask({ box: 'tiny', rows: ['...', '...'] });
    expect(Array.from(mask)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('is all ones for a fully inked frame', () => {
    const mask = frameAlphaMask({ box: 'tiny', rows: ['aaa', 'bbb'] });
    expect(Array.from(mask)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('has one entry per logical pixel', () => {
    const mask = frameAlphaMask({ box: 'tiny', rows: ['a.b', '.a.'] });
    expect(mask.length).toBe(6);
    expect(mask).toBeInstanceOf(Uint8ClampedArray);
  });

  it('treats only "." as transparent, not whitespace or case variants', () => {
    // A space is a palette key like any other as far as the mask is concerned;
    // only the documented marker means "no ink".
    const mask = frameAlphaMask({ box: 'tiny', rows: ['A.A', ' . '] });
    expect(Array.from(mask)).toEqual([1, 0, 1, 1, 0, 1]);
  });

  it('agrees with the placeholder sheet: the dog has ink and a transparent corner', () => {
    const sheet = validateSheet(placeholder);
    const frame = sheet.frames['idle_neutral_0'];
    if (frame === undefined) throw new Error('placeholder is missing idle_neutral_0');
    const { width, height } = frameSize(frame);
    const mask = frameAlphaMask(frame);

    expect(width).toBe(48);
    expect(height).toBe(40);
    // Top-left corner is empty; the sprite is bottom-heavy.
    expect(mask[0]).toBe(0);
    const inked = mask.reduce<number>((sum, value) => sum + value, 0);
    expect(inked).toBeGreaterThan(200);
    expect(inked).toBeLessThan(width * height);
  });
});

describe('maskBounds', () => {
  it('returns the tight box around the ink', () => {
    const mask = frameAlphaMask({ box: 'tiny', rows: ['...', '.a.'] });
    expect(maskBounds(mask, 3, 2)).toEqual({ minX: 1, minY: 1, maxX: 1, maxY: 1 });
  });

  it('returns null for an empty mask, so callers draw nothing', () => {
    const mask = frameAlphaMask({ box: 'tiny', rows: ['...', '...'] });
    expect(maskBounds(mask, 3, 2)).toBeNull();
  });

  it('spans the whole frame when every pixel is inked', () => {
    const mask = frameAlphaMask({ box: 'tiny', rows: ['aaa', 'aaa'] });
    expect(maskBounds(mask, 3, 2)).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 1 });
  });
});

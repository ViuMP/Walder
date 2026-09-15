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
import { framesFor } from '../src/sprites/contract';
import placeholder from '../src/sprites/placeholder.json';
import { decorAnchorSheet } from './fixtures/decor-anchor-sheet';
import { frameSetSheet } from './fixtures/frame-set-sheet';

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
    expect(sheet.animations['idle']?.frames).toEqual(['idle_neutral_0', 'idle_neutral_1']);
    expect(sheet.animations['sleep']?.frames).toEqual(['sleep_0', 'sleep_1']);
  });

  /**
   * The behaviour coordinator emits `play` events by *name* and the renderer
   * falls back to `idle` for a name the sheet lacks — which is correct, and also
   * means a missing animation is invisible rather than a failure. The placeholder
   * therefore carries a crude version of every name the coordinator can emit, so
   * those code paths are actually exercised until the real art lands.
   */
  it('carries every animation the behaviour coordinator can ask for', () => {
    const sheet = validateSheet(placeholder);
    for (const name of [
      'bark',
      'pet',
      'perk',
      'tilt',
      'wake',
      'sleep',
      'idle',
      'idle_happy',
      'idle_worried',
      'idle_exhausted',
      'out',
      'confused'
    ]) {
      expect(sheet.animations[name], name).toBeDefined();
    }
  });

  /**
   * The one-shots must actually end: the renderer waits for a non-looping
   * animation to finish before starting a queued one ("wake, then bark"), and a
   * `bark` authored as a loop would stall that queue forever.
   */
  it('authors the reaction animations as one-shots and the moods as loops', () => {
    const sheet = validateSheet(placeholder);
    for (const name of ['bark', 'pet', 'perk', 'tilt', 'wake']) {
      expect(sheet.animations[name]?.loop, name).toBe(false);
    }
    for (const name of ['idle', 'sleep', 'idle_happy', 'out', 'confused']) {
      expect(sheet.animations[name]?.loop, name).toBe(true);
    }
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

  /*
   * `frameSets` is the sheet carrying a whole second *drawing* of the cast, for
   * the one coat a palette swap cannot express: silver dapple's blotches have to
   * be drawn, not remapped.
   *
   * Both extra rules below are about the sets being INTERCHANGEABLE rather than
   * merely valid, because the renderer swaps them under a running clock — the
   * tray's Colour menu, mid-animation — and keeps the frame index it already
   * had. Anything the two sets disagree about is therefore a fault that only
   * appears when someone changes the dog's colour while he happens to be doing
   * something.
   */
  describe('frameSets', () => {
    /** Clone of the two-set fixture; break one thing per test. */
    function setsWith(mutate: (sheet: Record<string, any>) => void): Record<string, unknown> {
      const sheet = frameSetSheet();
      mutate(sheet);
      return sheet;
    }

    it('defaults to empty, so every one-coat sheet still validates', () => {
      expect(validateSheet(goodSheet()).frameSets).toEqual({});
      expect(validateSheet(goodSheet()).paletteFrameSets).toEqual({});
      expect(validateSheet(placeholder).frameSets).toEqual({});
      expect(validateSheet(placeholder).paletteFrameSets).toEqual({});
    });

    it('reads a second set and the palette that draws it', () => {
      const sheet = validateSheet(frameSetSheet());
      expect(Object.keys(sheet.frameSets)).toEqual(['dapple']);
      expect(sheet.frameSets['dapple']?.['idle_0']?.rows).toEqual(['bb..', 'bb..', 'bb..']);
      expect(sheet.paletteFrameSets).toEqual({ 'silver-dapple': 'dapple' });
    });

    it('holds a set to the same standards as the base frames', () => {
      // Straight through `parseFrames`, so a ragged row or an undefined letter
      // is caught in a dapple frame exactly as in a golden one — with the set
      // named, because "frame idle_0 row 1" is ambiguous once there are two.
      expect(() =>
        validateSheet(setsWith((x) => (x.frameSets.dapple.idle_0.rows = ['bb..', 'bb..'])))
      ).toThrow(/frame set "dapple": frame "idle_0" has 2 rows/);
      expect(() =>
        validateSheet(setsWith((x) => (x.frameSets.dapple.idle_0.rows[0] = 'zz..')))
      ).toThrow(/frame set "dapple": frame "idle_0" row 0 column 0 uses key "z"/);
    });

    it('rejects a set that is missing one of the base set\'s frames', () => {
      // The coat switcher keeps the frame index, so a set without `sleep_0`
      // would draw nothing at all for the sleeping loop.
      expect(() => validateSheet(setsWith((x) => delete x.frameSets.dapple.sleep_0))).toThrow(
        /frame set "dapple" is missing 1 frame\(s\).*starting with "sleep_0"/s
      );
    });

    it('rejects a set with a frame the base set does not have', () => {
      // Artwork no animation names is artwork the gallery never shows.
      expect(() =>
        validateSheet(setsWith((x) => (x.frameSets.dapple.hop_9 = x.frameSets.dapple.idle_0)))
      ).toThrow(/has 1 frame\(s\) the base set does not.*"hop_9"/s);
    });

    it('rejects a set that draws a frame in a different box', () => {
      // The window is sized from the base set's boxes: a `sleep_0` drawn in the
      // standing box would put a big sprite in the small window.
      expect(() =>
        validateSheet(
          setsWith((x) => {
            x.frameSets.dapple.sleep_0 = { box: 'glyph', rows: ['b.', 'b.'] };
          })
        )
      ).toThrow(/draws "sleep_0" in box "glyph", but the base set draws it in "dog"/);
    });

    it('rejects a non-object where a set or the map belongs', () => {
      expect(() => validateSheet(setsWith((x) => (x.frameSets = [])))).toThrow(
        /"frameSets" must be an object/
      );
      expect(() => validateSheet(setsWith((x) => (x.frameSets.dapple = 3)))).toThrow(
        /frame set "dapple": "frames" must be an object/
      );
    });

    describe('paletteFrameSets', () => {
      it('rejects a palette the sheet does not define', () => {
        expect(() =>
          validateSheet(setsWith((x) => (x.paletteFrameSets.merle = 'dapple')))
        ).toThrow(/names palette "merle", which the sheet does not define/);
      });

      it('rejects a set the sheet does not carry', () => {
        // The dangerous one: the renderer would fall back to `frames` and draw
        // the wrong coat's pixels, which reads as a rendering bug rather than a
        // missing entry.
        expect(() =>
          validateSheet(setsWith((x) => (x.paletteFrameSets['silver-dapple'] = 'merle')))
        ).toThrow(/names frame set "merle", which the sheet does not carry/);
        expect(() =>
          validateSheet(setsWith((x) => (x.paletteFrameSets['silver-dapple'] = 7)))
        ).toThrow(/names frame set "7"/);
      });
    });

    describe('framesFor', () => {
      const sheet = validateSheet(frameSetSheet());

      it('gives a coat its own drawing when it has one', () => {
        expect(framesFor(sheet, 'silver-dapple')).toBe(sheet.frameSets['dapple']);
      });

      it('gives the base set to every coat that is a palette swap', () => {
        expect(framesFor(sheet, 'golden')).toBe(sheet.frames);
        expect(framesFor(sheet, 'red')).toBe(sheet.frames);
      });

      it('gives the base set for an unknown coat rather than nothing', () => {
        // A coat name the owner never typed can still be in the settings file,
        // and the renderer draws golden meanwhile — the same graceful fallback
        // `activePalette` does for the colours themselves.
        expect(framesFor(sheet, 'merle')).toBe(sheet.frames);
        expect(framesFor(sheet, '')).toBe(sheet.frames);
      });

      it('does not treat a prototype key as a coat or as a set', () => {
        // Both maps come from JSON, so a coat called `constructor` must not hand
        // the renderer something off `Object.prototype`.
        for (const name of ['constructor', '__proto__', 'toString']) {
          expect(framesFor(sheet, name), name).toBe(sheet.frames);
        }
      });

      it('gives the base set on a sheet with no sets at all', () => {
        const plain = validateSheet(goodSheet());
        expect(framesFor(plain, 'golden')).toBe(plain.frames);
        expect(framesFor(plain, 'silver-dapple')).toBe(plain.frames);
      });

      it('keeps every frame name reachable in both sets', () => {
        // The property the renderer actually depends on: it looks the CURRENT
        // frame name up in whatever set the coat names, so a name resolvable in
        // one set and not the other is a dog who vanishes on a colour change.
        for (const name of Object.keys(sheet.frames)) {
          for (const coat of Object.keys(sheet.palettes)) {
            expect(framesFor(sheet, coat)[name], `${coat}/${name}`).toBeDefined();
          }
        }
      });
    });
  });

  /*
   * `decorAnchors` is where the art tells the app it may draw the `?` and the
   * `z z` itself — the whole point of the 2026-09-09 mirroring work, because a
   * glyph painted into a frame comes out backwards when the dog turns.
   *
   * Every rule below exists so the renderer can look an anchor up and blit with
   * no arithmetic and no fallback. There is deliberately no default anchor: an
   * absent one means "not the app's job", which is what makes the migration
   * sheet-by-sheet rather than all at once.
   */
  describe('decorAnchors', () => {
    /** Clone of the anchored fixture; break one thing per test. */
    function anchoredWith(mutate: (sheet: Record<string, any>) => void): Record<string, unknown> {
      const sheet = decorAnchorSheet();
      mutate(sheet);
      return sheet;
    }

    it('defaults to an empty map, so every sheet drawn before it still validates', () => {
      // The shipped 0.1.2 sheet and the bundled placeholder both declare none.
      expect(validateSheet(goodSheet()).decorAnchors).toEqual({});
      expect(validateSheet(placeholder).decorAnchors).toEqual({});
    });

    it('reads whole-pixel anchors per animation and per decoration', () => {
      const sheet = validateSheet(decorAnchorSheet());
      expect(sheet.decorAnchors['tilt']).toEqual({ qmark: { x: 10, y: 1 } });
      // `tilt` and `confused` hold the same frame but frame the dog differently,
      // so each carries its own anchor — this is why the renderer looks the
      // anchor up by *animation* and not by frame.
      expect(sheet.decorAnchors['confused']).toEqual({ qmark: { x: 9, y: 2 } });
      expect(sheet.decorAnchors['sleep']).toEqual({ zz: { x: 8, y: 0 } });
      expect(sheet.decorAnchors['pet']).toEqual({ heart: { x: 6, y: 1 } });
    });

    it('rejects an anchor on an animation the sheet does not have', () => {
      expect(() =>
        validateSheet(anchoredWith((s) => (s.decorAnchors.yawn = { qmark: { x: 0, y: 0 } })))
      ).toThrow(/names unknown animation "yawn"/);
    });

    it('rejects a decoration that is not a box of its own', () => {
      expect(() =>
        validateSheet(anchoredWith((s) => (s.decorAnchors.tilt = { sweat: { x: 0, y: 0 } })))
      ).toThrow(/names no box/);
    });

    it('rejects a decoration box with no animation to draw', () => {
      // The renderer draws the *first frame of* `animations[decor]`. A box with
      // no animation of the same name has no frame to draw, and the failure
      // would be an invisible decoration rather than an error.
      expect(() =>
        validateSheet(
          anchoredWith((s) => {
            delete s.animations.qmark;
            s.animations.tilt.frames = ['tilt_0', 'tilt_1', 'tilt_2'];
          })
        )
      ).toThrow(/no\s+animation of the same name/);
    });

    it('rejects a decoration whose animation draws a different box', () => {
      expect(() =>
        validateSheet(anchoredWith((s) => (s.animations.qmark.frames = ['idle_0'])))
      ).toThrow(/animation "qmark" draws box "dog", not "qmark"/);
    });

    it('rejects fractional and non-numeric coordinates', () => {
      // A half-pixel anchor would put the glyph off the dog's pixel grid at
      // every scale, which on pixel art reads as a rendering fault.
      expect(() =>
        validateSheet(anchoredWith((s) => (s.decorAnchors.tilt.qmark = { x: 10.5, y: 1 })))
      ).toThrow(/must be whole-pixel/);
      expect(() =>
        validateSheet(anchoredWith((s) => (s.decorAnchors.tilt.qmark = { x: '10', y: 1 })))
      ).toThrow(/must be whole-pixel/);
      expect(() =>
        validateSheet(anchoredWith((s) => (s.decorAnchors.tilt.qmark = { x: 10 })))
      ).toThrow(/must be whole-pixel/);
    });

    it('rejects an anchor that puts any part of the decoration outside the box', () => {
      // The in-box rule is the one the app depends on: the standing box's top
      // rows are the speech-bubble reserve, and a `?` above the box would either
      // be clipped by the window or collide with a bark bubble's tail.
      const cases: Array<[string, { x: number; y: number }]> = [
        ['negative x', { x: -1, y: 1 }],
        ['negative y', { x: 10, y: -1 }],
        ['off the right edge', { x: 13, y: 1 }],
        ['off the bottom edge', { x: 10, y: 11 }]
      ];
      for (const [what, anchor] of cases) {
        expect(
          () => validateSheet(anchoredWith((s) => (s.decorAnchors.tilt.qmark = anchor))),
          what
        ).toThrow(/outside the 16x16 "dog" box/);
      }
    });

    it('accepts an anchor flush against each edge', () => {
      // 16-px box, 4x6 `?`: (0,0) and (12,10) are the extreme legal corners.
      for (const anchor of [{ x: 0, y: 0 }, { x: 12, y: 10 }]) {
        const sheet = validateSheet(anchoredWith((s) => (s.decorAnchors.tilt.qmark = anchor)));
        expect(sheet.decorAnchors['tilt']?.['qmark']).toEqual(anchor);
      }
    });

    it('rejects an anchor on an animation whose frames span two boxes', () => {
      // An anchor is in one box's coordinates, so the same x would mean two
      // different places. The art has never done this; the message says so if it
      // ever does, instead of the `?` quietly landing off the head.
      expect(() =>
        validateSheet(
          anchoredWith((s) => {
            s.animations.tilt.frames = ['tilt_0', 'tilt_1', 'qmark'];
            s.animations.tilt.durationsMs = [90, 90, 90];
          })
        )
      ).toThrow(/frames span boxes/);
    });

    it('rejects a non-object where a map or an anchor belongs', () => {
      expect(() => validateSheet(anchoredWith((s) => (s.decorAnchors = [])))).toThrow(
        /"decorAnchors" must be an object/
      );
      expect(() => validateSheet(anchoredWith((s) => (s.decorAnchors.tilt = 3)))).toThrow(
        /entry "tilt" must be an object/
      );
      expect(() =>
        validateSheet(anchoredWith((s) => (s.decorAnchors.tilt.qmark = [10, 1])))
      ).toThrow(/"tilt"\."qmark" must be an object/);
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

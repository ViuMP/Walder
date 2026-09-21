/**
 * A tiny sheet with two *characters* — Walder and a cat — rather than two coats.
 *
 * `frameSets` (see `frame-set-sheet.ts`) carries a second drawing of the same
 * cast, and its whole premise is that the frame index carries across. Yuna
 * breaks that premise on purpose: her `perk` is six frames where Walder's is
 * three, and her `tail_wag` three where his is four, because she is batting a
 * yarn ball and he is not. So her sets are exempt from parity with the base and
 * she brings an animation table of her own.
 *
 * **Temporary, and deliberately so**, exactly as the two fixtures beside it:
 * `art/walder.json` has no `characters` key until the five approved Yuna sets
 * are installed, so every assertion made against the shipped sheet proves the
 * *single-character* path. This is the only sheet in the repo where
 * `characterOf`, `sheetFor` and `palettesFor` have a second cast to find.
 *
 * Shaped like the real thing rather than minimally:
 *
 *  - every frame `APP_DECOR_BY_FRAME` names, in both tables, so `mirrorReady`
 *    has something to say yes *and* no to;
 *  - two coats for the character, so intra-character parity is a rule with
 *    something to catch, and two that are not hers, so `palettesFor(null)` has
 *    something to keep;
 *  - the glyph frames copied verbatim into every set, as `strips.py` emits them
 *    — the `?` and the `z z` are ink, not coat;
 *  - a `paletteNames` override on one coat only, which is the easter egg.
 *
 * Delete it once the real sheet carries a character and the tests can read it
 * from `art/walder.json`.
 */

/** One square dog box, and the three decoration boxes, as the real sheet has. */
const DOG = 16;
const HEART: readonly [number, number] = [4, 4];
const QMARK: readonly [number, number] = [4, 6];
const ZZ: readonly [number, number] = [6, 4];

/** `ink` repeated at the left of every row, padded out with transparent. */
function frame(box: string, width: number, height: number, ink: string): unknown {
  const row = ink.padEnd(width, '.').slice(0, width);
  return { box, rows: Array.from({ length: height }, () => row) };
}

/** `perk_0 … perk_{count-1}`, the naming every strip uses. */
function names(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}_${i}`);
}

/** Frames for a numbered strip, all in the dog box. */
function strip(prefix: string, count: number, ink: string): Record<string, unknown> {
  return Object.fromEntries(
    names(prefix, count).map((name) => [name, frame('dog', DOG, DOG, ink)])
  );
}

/**
 * Every pose both casts share, drawn in `ink` — plus the glyphs, which are not
 * drawn in `ink` at all: they are the same pixels in every set.
 */
function poses(ink: string): Record<string, unknown> {
  return {
    idle_0: frame('dog', DOG, DOG, ink),
    ...strip('tilt', 3, ink),
    ...strip('sleep', 3, ink),
    // `pet_1` is deliberately absent, as in `decor-anchor-sheet.ts`: the app
    // decorates `pet_2`..`pet_5` and the fixture only carries what it names.
    pet_0: frame('dog', DOG, DOG, ink),
    ...Object.fromEntries(
      [2, 3, 4, 5].map((i) => [`pet_${i}`, frame('dog', DOG, DOG, ink)])
    ),
    heart_0: frame('heart', HEART[0], HEART[1], 'aa'),
    qmark: frame('qmark', QMARK[0], QMARK[1], 'a'),
    zz_0: frame('zz', ZZ[0], ZZ[1], 'aa')
  };
}

/**
 * One cast's animation table.
 *
 * The same names for both, which is the point: the app hard-codes `idle`,
 * `sleep`, `perk`, `tilt`, `pet`, and nothing downstream is told that one of
 * them is twice as long for the cat.
 */
function tables(perk: number, tailWag: number, holdLoop: number): Record<string, unknown> {
  return {
    idle: { frames: ['idle_0'], durationsMs: [500], loop: true },
    tilt: {
      frames: names('tilt', 3),
      durationsMs: [90, 90, 90],
      loop: false,
      hold: true
    },
    confused: { frames: ['tilt_2'], durationsMs: [700], loop: true },
    sleep: { frames: names('sleep', 3), durationsMs: [1_000, 1_000, 1_000], loop: true },
    pet: {
      frames: ['pet_0', 'pet_2', 'pet_3', 'pet_4', 'pet_5'],
      durationsMs: [125, 125, 125, 125, 125],
      loop: false
    },
    perk: {
      frames: names('perk', perk),
      durationsMs: names('perk', perk).map(() => 100),
      loop: false,
      hold: true,
      ...(holdLoop > 1 ? { holdLoop } : {})
    },
    tail_wag: {
      frames: names('tail_wag', tailWag),
      durationsMs: names('tail_wag', tailWag).map(() => 120),
      loop: false
    },
    heart: { frames: ['heart_0'], durationsMs: [300], loop: true },
    qmark: { frames: ['qmark'], durationsMs: [900], loop: false },
    zz: { frames: ['zz_0'], durationsMs: [700], loop: true }
  };
}

/** Both casts anchor the same four poses; the numbers would differ in real art. */
function anchors(): Record<string, unknown> {
  return {
    tilt: { qmark: { x: 10, y: 1 } },
    confused: { qmark: { x: 9, y: 2 } },
    sleep: { zz: { x: 8, y: 0 } },
    pet: { heart: { x: 6, y: 1 } }
  };
}

/** A fresh copy every call, so a test that breaks one field cannot leak. */
export function characterSheet(): Record<string, any> {
  const cat = (ink: string): Record<string, unknown> => ({
    ...poses(ink),
    ...strip('perk', 6, ink),
    ...strip('tail_wag', 3, ink)
  });

  return {
    boxes: { dog: [DOG, DOG], heart: [...HEART], qmark: [...QMARK], zz: [...ZZ] },
    // The two the base mascot wears first, then the character's — insertion
    // order is menu order, and a character's coats sit after the dog's.
    palettes: {
      golden: { a: '#f0c060', b: '#402000' },
      red: { a: '#c04020', b: '#301000' },
      'grey-tabby': { a: '#8d8f94', b: '#2b2c30' },
      tuxedo: { a: '#f4f4f2', b: '#141416' }
    },
    frames: { ...poses('a'), ...strip('perk', 3, 'a'), ...strip('tail_wag', 4, 'a') },
    animations: tables(3, 4, 1),
    decorAnchors: anchors(),
    frameSets: { 'grey-tabby': cat('b'), tuxedo: cat('ab') },
    paletteFrameSets: { 'grey-tabby': 'grey-tabby', tuxedo: 'tuxedo' },
    characters: {
      yuna: {
        name: 'Yuna',
        palettes: ['grey-tabby', 'tuxedo'],
        // The easter egg: one coat is somebody in particular.
        paletteNames: { tuxedo: 'Buda' },
        animations: tables(6, 3, 2),
        decorAnchors: anchors()
      }
    }
  };
}

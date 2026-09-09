/**
 * A tiny sheet with two coats' worth of *drawings*, not two palettes.
 *
 * `frameSets` exists for the one coat a palette cannot express: silver dapple is
 * irregular black blotches over silver with tan points, and no remapping of eight
 * letters produces a spot — the blotch has to be drawn. So the sheet can carry
 * the whole cast a second time and the palette says which drawing to use.
 *
 * **Temporary, and deliberately so**, for the same reason as
 * `decor-anchor-sheet.ts`: the shipped sheet (`art/walder.json`) has one coat's
 * art until the owner has generated the fourteen dapple strips, so every
 * assertion made against it proves the *single-set* path. This fixture is the
 * only sheet in the repo where `framesFor` has a second set to find.
 *
 * Shaped like the real thing rather than minimally:
 *
 *  - two frames in two different boxes, so "same box per frame" is a rule with
 *    something to catch;
 *  - a shared decoration frame whose pixels are *identical* between the sets —
 *    the `?` and the `z z` are ink rather than coat, and `strips.py` copies them
 *    into every set verbatim, so a test that assumed every frame differed would
 *    be testing the wrong invariant;
 *  - a palette (`red`) that draws the base set, because most coats do.
 *
 * Delete it once the real sheet carries a second set and the tests can read it
 * from `art/walder.json`.
 */

/** Two boxes, different sizes, so a frame drawn in the wrong one is detectable. */
const DOG: readonly [number, number] = [4, 3];
const GLYPH: readonly [number, number] = [2, 2];

function rows(width: number, height: number, ink: string): string[] {
  const row = ink.padEnd(width, '.').slice(0, width);
  return Array.from({ length: height }, () => row);
}

function frame(box: string, size: readonly [number, number], ink: string): unknown {
  return { box, rows: rows(size[0], size[1], ink) };
}

/** A fresh copy every call, so a test that breaks one field cannot leak. */
export function frameSetSheet(): Record<string, any> {
  return {
    boxes: { dog: [...DOG], glyph: [...GLYPH] },
    // `silver-dapple` last, because the tray's Colour menu is
    // `Object.keys(sheet.palettes)` and insertion order is menu order.
    palettes: {
      golden: { a: '#f0c060', b: '#402000' },
      red: { a: '#c04020', b: '#301000' },
      'silver-dapple': { a: '#b9bec7', b: '#17171c' }
    },
    frames: {
      idle_0: frame('dog', DOG, 'aa'),
      sleep_0: frame('dog', DOG, 'a'),
      qmark: frame('glyph', GLYPH, 'b')
    },
    animations: {
      idle: { frames: ['idle_0'], durationsMs: [500], loop: true },
      sleep: { frames: ['sleep_0'], durationsMs: [1000], loop: true },
      qmark: { frames: ['qmark'], durationsMs: [900], loop: false }
    },
    frameSets: {
      dapple: {
        // Its own pixels for the dog...
        idle_0: frame('dog', DOG, 'bb'),
        sleep_0: frame('dog', DOG, 'b'),
        // ... and the glyph shared verbatim, as `strips.py` emits it.
        qmark: frame('glyph', GLYPH, 'b')
      }
    },
    paletteFrameSets: { 'silver-dapple': 'dapple' }
  };
}

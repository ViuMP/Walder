/**
 * A tiny sheet that declares `decorAnchors`, so the anchor-driven decoration
 * path is unit-tested on a sheet small enough to read whole.
 *
 * **A synthetic edge case, kept on purpose** (header rewritten 2026-11-17,
 * audit B8). It used to call itself temporary, until `art/walder.json`
 * declared anchors; it now does, for `tilt`, `confused`, `sleep` and `pet`. The
 * fixture stays for what the real sheet cannot show: its `pet` has no anchor,
 * while the shipped one draws a heart.
 *
 * Shaped like the real thing rather than minimally: one dog box, `tilt` holding
 * on `tilt_2`, `confused` as that same frame looping, a three-frame `sleep` whose
 * last frame carries the `z z`, and a `pet` that is deliberately left *without*
 * an anchor so "the sheet says nothing, so the app draws nothing" is covered too.
 *
 * Assertions about the shipped anchors themselves belong against `art/walder.json`.
 */

/** Dog box side, in sprite px. Square, small, and big enough to hold an anchor. */
const DOG = 16;

/** `qmark` and `zz` box dimensions — different from each other on purpose, so a
 * mirrored anchor that used the wrong width would move the wrong glyph. */
const QMARK: readonly [number, number] = [4, 6];
const ZZ: readonly [number, number] = [6, 4];
const HEART: readonly [number, number] = [4, 4];

/** `ink` at the left of every row, padded to the box width with transparent. */
function frame(boxName: string, width: number, height: number, ink: string): unknown {
  const row = ink.padEnd(width, '.').slice(0, width);
  return { box: boxName, rows: Array.from({ length: height }, () => row) };
}

/**
 * A fresh copy every call, so a test that breaks one field cannot leak into the
 * next one (the same reason `sprites.test.ts` clones its own good sheet).
 */
export function decorAnchorSheet(): Record<string, any> {
  return {
    boxes: { dog: [DOG, DOG], heart: [...HEART], qmark: [...QMARK], zz: [...ZZ] },
    palettes: { golden: { a: '#f0c060' }, red: { a: '#c04020' } },
    frames: {
      idle_0: frame('dog', DOG, DOG, 'aaaa'),
      tilt_0: frame('dog', DOG, DOG, 'aaa'),
      tilt_1: frame('dog', DOG, DOG, 'aa'),
      tilt_2: frame('dog', DOG, DOG, 'a'),
      sleep_0: frame('dog', DOG, DOG, 'aa'),
      sleep_1: frame('dog', DOG, DOG, 'aaa'),
      sleep_2: frame('dog', DOG, DOG, 'aaaa'),
      pet_0: frame('dog', DOG, DOG, 'aa'),
      pet_2: frame('dog', DOG, DOG, 'aaa'),
      pet_3: frame('dog', DOG, DOG, 'aaa'),
      pet_4: frame('dog', DOG, DOG, 'aaa'),
      pet_5: frame('dog', DOG, DOG, 'aaa'),
      heart_0: frame('heart', HEART[0], HEART[1], 'aa'),
      qmark: frame('qmark', QMARK[0], QMARK[1], 'a'),
      zz_0: frame('zz', ZZ[0], ZZ[1], 'aa')
    },
    animations: {
      idle: { frames: ['idle_0'], durationsMs: [500], loop: true },
      tilt: { frames: ['tilt_0', 'tilt_1', 'tilt_2'], durationsMs: [90, 90, 90], loop: false, hold: true },
      confused: { frames: ['tilt_2'], durationsMs: [700], loop: true },
      sleep: { frames: ['sleep_0', 'sleep_1', 'sleep_2'], durationsMs: [1000, 1000, 1000], loop: true },
      pet: { frames: ['pet_0', 'pet_2', 'pet_3', 'pet_4', 'pet_5'], durationsMs: [125, 125, 125, 125, 125], loop: false },
      heart: { frames: ['heart_0'], durationsMs: [300], loop: true },
      qmark: { frames: ['qmark'], durationsMs: [900], loop: false },
      zz: { frames: ['zz_0'], durationsMs: [700], loop: true }
    },
    // `tilt` and `confused` both hold `tilt_2` but frame the dog differently, so
    // each names its own anchor — exactly what strips.py has to emit.
    decorAnchors: {
      tilt: { qmark: { x: 10, y: 1 } },
      confused: { qmark: { x: 9, y: 2 } },
      sleep: { zz: { x: 8, y: 0 } },
      pet: { heart: { x: 6, y: 1 } }
    }
  };
}

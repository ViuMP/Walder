/**
 * The art -> app sheet pipeline.
 *
 * `scripts/sync-sheet.ts` copies `art/walder.json` into `src/sprites/walder.json`
 * and refuses to do so unless the sheet passes `validateSheet` *and*
 * `requireSheetContract`. That is the only gate between hand-drawn JSON and a
 * mascot that has to draw itself on someone's desktop, so the gate is applied
 * here too, to both ends of the copy — the script runs from an npm hook where
 * nobody reads the output, while a failure here is a failure of `npm test`.
 *
 * The artist owns `art/walder.json` and regenerates it from `art/frames.mjs`.
 * These tests are therefore written to survive an ordinary redraw (different
 * pixels, a different palette ramp, extra animations) and to fail only on the
 * things the *code* depends on.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateSheet, type SpriteSheet } from '../src/sprites/types';
import {
  FALLBACK_PALETTE,
  REQUIRED_ANIMATIONS,
  REQUIRED_BOXES,
  requireSheetContract
} from '../src/sprites/contract';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ART = join(root, 'art', 'walder.json');
const SYNCED = join(root, 'src', 'sprites', 'walder.json');

function read(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** Everything the app relies on, in one place, applied to both files. */
function expectUsableSheet(sheet: SpriteSheet): void {
  expect(() => requireSheetContract(sheet)).not.toThrow();
  for (const name of REQUIRED_ANIMATIONS) expect(sheet.animations[name], name).toBeDefined();
  for (const name of REQUIRED_BOXES) expect(sheet.boxes[name], name).toBeDefined();
  expect(sheet.palettes[FALLBACK_PALETTE]).toBeDefined();
}

describe("art/walder.json — the artist's file", () => {
  /*
   * Skipped rather than failed when absent: the art pipeline is a separate
   * workflow (`node art/frames.mjs`), and a checkout without it should still be
   * able to run the suite. The app falls back to the placeholder sprite in that
   * state, which `test/sheet.test.ts` covers.
   */
  const present = existsSync(ART);

  it.runIf(present)('passes the same gate scripts/sync-sheet.ts applies', () => {
    const sheet = validateSheet(read(ART));
    expectUsableSheet(sheet);
  });

  it.runIf(present)('offers the five coats the tray menu lists', () => {
    const sheet = validateSheet(read(ART));
    for (const coat of ['golden', 'red', 'cream', 'black-and-tan', 'chocolate']) {
      expect(sheet.palettes[coat], coat).toBeDefined();
    }
  });
});

describe('src/sprites/walder.json — the copy the app imports', () => {
  it('exists, so the static import in src/main/sheet.ts resolves', () => {
    // `sync-sheet` writes an empty `{}` rather than leaving the file absent even
    // when it fails, because a missing static import is a bundler error while an
    // empty one is a case `loadSheet` reports and recovers from.
    expect(existsSync(SYNCED)).toBe(true);
  });

  it('passes the gate', () => {
    const sheet = validateSheet(read(SYNCED));
    expectUsableSheet(sheet);
  });

  it('has one duration per frame in every animation', () => {
    // `validateSheet` enforces this; asserted again against the real art because
    // a mismatch there is the failure mode that produces a dog frozen mid-step
    // with nothing in any log.
    const sheet = validateSheet(read(SYNCED));
    for (const [name, animation] of Object.entries(sheet.animations)) {
      expect(animation.durationsMs.length, name).toBe(animation.frames.length);
    }
  });

  it('holds only animations that can end', () => {
    // A held loop never reaches a last frame to park on. `validateSheet` rejects
    // the combination; this is the assertion that the real art does not rely on
    // it being tolerated.
    const sheet = validateSheet(read(SYNCED));
    for (const [name, animation] of Object.entries(sheet.animations)) {
      if (animation.hold) expect(animation.loop, name).toBe(false);
    }
  });
});

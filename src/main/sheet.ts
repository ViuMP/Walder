/**
 * The sprite sheet the main process hands to the renderer.
 *
 * M3 ships `src/sprites/placeholder.json` — a crude dog-shaped blob in one
 * palette. The real art is authored as `art/walder.json` in exactly the same
 * format, so swapping it in is a one-line import change and nothing downstream
 * moves. The JSON is bundled by the build, so this works identically from a
 * packaged asar.
 *
 * The main process is also the only place the sheet is validated: the renderer
 * receives an already-checked `SpriteSheet` over IPC.
 */
import placeholder from '../sprites/placeholder.json';
import { SpriteSheetError, validateSheet, type Box, type SpriteSheet } from '../sprites/types';
import type { PalettePayload } from './ipc';
import { warn } from './log';

/** The palette every sheet must define, and the fallback when one is missing. */
export const FALLBACK_PALETTE = 'golden';

/**
 * What the *runtime* needs on top of a structurally valid sheet.
 *
 * `validateSheet` proves the JSON is self-consistent; it cannot know which names
 * the app hard-codes. These are those names: the renderer picks its animation by
 * box (`sleep` -> the sleep loop, anything else -> idle) and the window is sized
 * from the stand box via `overlayMetrics`, so art that renamed an animation or
 * resized a box would produce a blank or mis-framed dog rather than an error.
 * Checked here, at load, where it can still be reported.
 */
const REQUIRED_ANIMATIONS: readonly string[] = ['idle', 'sleep'];
const REQUIRED_BOXES: readonly (readonly [string, Box])[] = [
  ['stand', [48, 40]],
  ['sleep', [32, 24]]
];

function sameBox(a: Box | undefined, b: Box): boolean {
  return a !== undefined && a[0] === b[0] && a[1] === b[1];
}

/**
 * Assert the sheet carries the names and box sizes the app is built around.
 *
 * Throws `SpriteSheetError` naming exactly what is missing or wrong. Separate
 * from `loadSheet` so the real art can be checked by the same rule in a test
 * without going through the bundled import.
 */
export function requireSheetContract(sheet: SpriteSheet): void {
  const missing = REQUIRED_ANIMATIONS.filter((name) => sheet.animations[name] === undefined);
  if (missing.length > 0) {
    throw new SpriteSheetError(
      `missing required animation(s) ${missing.map((n) => `"${n}"`).join(', ')} ` +
        `(has ${Object.keys(sheet.animations).join(', ') || 'none'})`
    );
  }

  for (const [name, expected] of REQUIRED_BOXES) {
    const actual = sheet.boxes[name];
    if (actual === undefined) {
      throw new SpriteSheetError(
        `missing required box "${name}" (expected [${expected.join(', ')}])`
      );
    }
    if (!sameBox(actual, expected)) {
      throw new SpriteSheetError(
        `box "${name}" must be [${expected.join(', ')}], got [${actual.join(', ')}] — ` +
          `the window is sized from these, so they are not free to change`
      );
    }
  }
}

/**
 * Validate and return the bundled sheet. Throws `SpriteSheetError` if the art is
 * malformed *or* does not meet `requireSheetContract` — a caller should treat
 * either as fatal, because a mascot with no frames has nothing to draw. `start()`
 * in `index.ts` catches it, logs it and exits 1.
 */
export function loadSheet(): SpriteSheet {
  const sheet = validateSheet(placeholder);
  requireSheetContract(sheet);
  return sheet;
}

/**
 * Resolve a stored palette name against the sheet.
 *
 * The colour menu offers all five coat variants even though the placeholder
 * sheet only carries `golden`, so that the owner's choice is remembered now and
 * simply starts working when the real art lands. An unknown name yields
 * `colors: null`, and the renderer falls back to golden.
 */
export function resolvePalette(sheet: SpriteSheet, name: string): PalettePayload {
  // `hasOwn`, not a bare lookup: the name comes from the settings file, which is
  // user-writable, and `palettes` is a plain object — so `"constructor"` would
  // otherwise resolve to `Object` and be sent to the renderer as a colour map.
  const colors = Object.hasOwn(sheet.palettes, name) ? sheet.palettes[name] : undefined;
  if (colors !== undefined) return { name, colors };
  warn(`palette "${name}" is not in the sheet; renderer will fall back to "${FALLBACK_PALETTE}"`);
  return { name, colors: null };
}

/**
 * The sprite sheet the main process hands to the renderer.
 *
 * Two candidates are compiled in:
 *
 *  - `../sprites/walder.json` — **the real artwork.** A validated copy of
 *    `art/walder.json`, made by `scripts/sync-sheet.ts`, which npm's `pre*` hooks
 *    run before `dev`, `build` and `build:dist`. So the app always draws the
 *    latest approved art without anyone having to remember a step.
 *  - `../sprites/placeholder.json` — the crude dog-shaped blob from M3, kept as
 *    the fallback for the one case that would otherwise leave a blank window: no
 *    art synced yet (a fresh clone where the pipeline has not run, or a build run
 *    straight through `electron-vite` past the hooks). `sync-sheet` writes an
 *    empty `{}` in that case rather than leaving the file absent, because a
 *    missing static import is a bundler error while an empty one is a case this
 *    module can report and recover from.
 *
 * Both are *static* imports, so electron-vite embeds them and this works
 * identically from a packaged asar with no file reading at runtime.
 *
 * The main process is also the only place the sheet is validated: the renderer
 * receives an already-checked `SpriteSheet` over IPC.
 */
import placeholder from '../sprites/placeholder.json';
import walder from '../sprites/walder.json';
import { validateSheet, type SpriteSheet } from '../sprites/types';
import { FALLBACK_PALETTE, chooseSheetSource, requireSheetContract } from '../sprites/contract';
import type { PalettePayload } from './ipc';
import { warn } from './log';

/*
 * The app-level sheet contract lives in `src/sprites/contract.ts` so that
 * `scripts/sync-sheet.ts` can apply the same rule to the artist's file without
 * importing this module (and with it the embedded JSON). Re-exported here because
 * everything in `src/main` reaches for the sheet through this file.
 */
export {
  FALLBACK_PALETTE,
  REQUIRED_ANIMATIONS,
  REQUIRED_BOXES,
  boxSize,
  chooseSheetSource,
  isSyncedSheet,
  requireSheetContract
} from '../sprites/contract';
export type { SheetSource } from '../sprites/contract';

/**
 * Validate and return the sheet the app should draw. Throws `SpriteSheetError`
 * if the chosen art is malformed *or* does not meet `requireSheetContract` — a
 * caller should treat either as fatal, because a mascot with no frames has
 * nothing to draw. `start()` in `index.ts` catches it, logs it and exits 1.
 *
 * A *missing* sheet is not fatal: it warns and draws the placeholder.
 */
export function loadSheet(): SpriteSheet {
  const source = chooseSheetSource(walder, placeholder);
  if (!source.isReal) {
    warn(
      'src/sprites/walder.json holds no artwork — drawing the placeholder sprite. ' +
        'Run "npm run sync:sheet", which copies art/walder.json into the app.'
    );
  }
  const sheet = validateSheet(source.json);
  requireSheetContract(sheet);
  return sheet;
}

/**
 * Resolve a stored palette name against the sheet.
 *
 * An unknown name yields `colors: null` and the renderer falls back to golden — a
 * name the owner never typed can still be in the settings file (a coat a later
 * sheet renamed, a hand-edited file), and a dog in the wrong colour beats no dog.
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

/**
 * The coat to show as *chosen* in the tray, given what the settings file says.
 *
 * Distinct from `resolvePalette`, which keeps an unknown name so a stored choice
 * survives a sheet that temporarily lacks it. The menu cannot do that: a radio
 * group with no dot on any item reads as broken. So the menu falls back to
 * golden — which is also what the renderer is drawing in that state.
 */
export function menuPalette(sheet: SpriteSheet, stored: unknown): string {
  if (typeof stored === 'string' && Object.hasOwn(sheet.palettes, stored)) return stored;
  return FALLBACK_PALETTE;
}

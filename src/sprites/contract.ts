/**
 * What the *app* requires of a sprite sheet, on top of it being well-formed.
 *
 * `validateSheet` (in `types.ts`) proves a sheet is internally consistent — rows
 * match their box, every letter resolves in every palette, every animation names
 * frames that exist. It cannot know which names this app hard-codes, and it must
 * not: the sheet format is general, the app's expectations are not.
 *
 * Those expectations live here. Kept in `src/sprites/` rather than in
 * `src/main/sheet.ts` on purpose: `sheet.ts` statically imports the sheet JSON so
 * that the bundler embeds it, which makes it awkward to import from a plain
 * `tsx` script — and `scripts/sync-sheet.ts` has to apply exactly this contract
 * to `art/walder.json` *before* the file becomes the app's art. One rule, one
 * place, checked both at sync time (where the artist can still fix it) and at
 * load time (where it is the last line of defence).
 */
import { SpriteSheetError, type SpriteSheet } from './types';
// Type-only, and `core/bubble.ts` is itself pure and DOM-free. `BubbleKind` is the
// vocabulary for what the app is saying; the baked-decoration table below is
// precisely a statement about which of those the *art* is already saying.
import type { BubbleKind } from '../core/bubble';

/** The palette every sheet must define, and the fallback when one is missing. */
export const FALLBACK_PALETTE = 'golden';

/**
 * Animations the code names directly.
 *
 * The renderer picks its animation by box and expression through `pickAnimation`
 * (`src/core/expression.ts`), a cascade that ends at plain `idle`; the sleeping
 * box ends at `sleep`. Everything else in the sheet is optional and degrades
 * gracefully, so these two are the whole animation contract.
 */
export const REQUIRED_ANIMATIONS: readonly string[] = ['idle', 'sleep'];

/**
 * Boxes the code names directly. The overlay window is sized from `stand` (plus
 * a bubble reserve) and from `sleep` when he curls up, so art that dropped one
 * would produce a mis-framed dog rather than an error.
 *
 * Box *dimensions* are deliberately not asserted (2026-09-08 design gate): the
 * mascot design chooses its own grid, and everything downstream reads the numbers
 * from the sheet via `boxSize`. Only their presence is a contract.
 */
export const REQUIRED_BOXES: readonly string[] = ['stand', 'sleep'];

/** Logical pixel size of one box. Structurally `core/geometry`'s `BoxSize`. */
export interface SheetBoxSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Assert the sheet carries the names the app is built around.
 *
 * Throws `SpriteSheetError` naming exactly what is missing, because the reader of
 * that message is whoever is editing the art.
 */
export function requireSheetContract(sheet: SpriteSheet): void {
  const missingAnimations = REQUIRED_ANIMATIONS.filter(
    (name) => sheet.animations[name] === undefined
  );
  if (missingAnimations.length > 0) {
    throw new SpriteSheetError(
      `missing required animation(s) ${missingAnimations.map((n) => `"${n}"`).join(', ')} ` +
        `(has ${Object.keys(sheet.animations).join(', ') || 'none'})`
    );
  }

  const missingBoxes = REQUIRED_BOXES.filter((name) => sheet.boxes[name] === undefined);
  if (missingBoxes.length > 0) {
    throw new SpriteSheetError(
      `missing required box(es) ${missingBoxes.map((n) => `"${n}"`).join(', ')} ` +
        `(has ${Object.keys(sheet.boxes).join(', ') || 'none'}) — ` +
        `the window is sized from the sheet's own box dimensions`
    );
  }

  if (sheet.palettes[FALLBACK_PALETTE] === undefined) {
    throw new SpriteSheetError(
      `missing the "${FALLBACK_PALETTE}" palette (has ` +
        `${Object.keys(sheet.palettes).join(', ') || 'none'}) — it is the fallback ` +
        `every renderer path uses when the chosen coat is not in the sheet`
    );
  }
}

/* --------------------------------------------------- decorations in the art */

/**
 * A decoration that exists twice: as a standalone sprite the app could draw for
 * itself, and as pixels the illustrator drew *inside* a frame.
 *
 * The v3 sheet's frames come straight from the owner's strip illustrations, and
 * he drew the hearts, the `?` and the `z z` into them (`art/README.md`, "The
 * strips" and rule 2). The sheet *also* carries `heart`/`qmark`/`zz` as separate
 * one-frame boxes, which is what makes them available to the app.
 */
export type DecorName = 'heart' | 'qmark' | 'zz';

/**
 * Decorations already drawn inside the frames of an animation.
 *
 * Keyed by animation, not by frame, wherever the animation *ends up* on the
 * decorated frame: `tilt` holds on `tilt_2`, which carries the `?`, and the app's
 * own `?` would otherwise flash on for two frames and vanish as the `?` in the
 * art arrives — worse than either alone. `confused` is that same held frame as a
 * one-frame loop. `pet` shows hearts from its third frame and is over in 750 ms,
 * far too short to blink a second set on and off.
 */
export const BAKED_DECOR_BY_ANIMATION: Readonly<Record<string, readonly DecorName[]>> = {
  tilt: ['qmark'],
  confused: ['qmark'],
  pet: ['heart']
};

/**
 * Decorations drawn inside one particular frame.
 *
 * `sleep` is the case the per-animation table cannot express: it is a slow
 * three-second loop and only its last frame carries the `z z`, so the app is free
 * to say `…zzz` over the first two — and must not over the third, where it would
 * sit beside the drawn one.
 */
export const BAKED_DECOR_BY_FRAME: Readonly<Record<string, readonly DecorName[]>> = {
  sleep_2: ['zz']
};

/**
 * What the app is saying with each kind of bubble, when it is saying something a
 * decoration can also say.
 *
 * `nudge` (`5-hour: 80% used`) and `perk` (`woof`) are words with no drawn
 * counterpart anywhere in the sheet, so they are never suppressed.
 */
export const BUBBLE_DECOR: Readonly<Partial<Record<BubbleKind, DecorName>>> = {
  waiting: 'qmark',
  sleepy: 'zz'
};

/** Decorations the art is already drawing, given what is on screen right now. */
export function bakedDecor(
  animation: string | null,
  frame: string | null
): readonly DecorName[] {
  const byAnimation = (animation === null ? undefined : BAKED_DECOR_BY_ANIMATION[animation]) ?? [];
  const byFrame = (frame === null ? undefined : BAKED_DECOR_BY_FRAME[frame]) ?? [];
  if (byFrame.length === 0) return byAnimation;
  if (byAnimation.length === 0) return byFrame;
  return [...new Set([...byAnimation, ...byFrame])];
}

/**
 * Is this bubble saying something the frame on screen already says in pixels?
 *
 * The app then stays quiet: two question marks, or a `…zzz` next to a drawn
 * `z z`, read as a rendering bug rather than as emphasis. Only the *drawing* is
 * suppressed — the bubble is still the coordinator's live state, so its ttl, the
 * head-tilt it holds, and the click that dismisses it all behave unchanged.
 */
export function bubbleIsBakedIn(
  kind: BubbleKind,
  animation: string | null,
  frame: string | null
): boolean {
  const decor = BUBBLE_DECOR[kind];
  if (decor === undefined) return false;
  return bakedDecor(animation, frame).includes(decor);
}

/* ----------------------------------------------- choosing which sheet to draw */

/** Which of the two compiled-in sheets was chosen, and the JSON to validate. */
export interface SheetSource {
  /** File name, for the log line. */
  readonly name: string;
  readonly json: unknown;
  /** False when the placeholder was substituted. */
  readonly isReal: boolean;
}

/**
 * Does this parsed JSON look like a synced sheet at all?
 *
 * Only the shallowest possible check — `validateSheet` does the real work, and
 * anything it would reject *should* be reported as a validation failure rather
 * than silently swapped for the placeholder dog. This distinguishes exactly one
 * thing: the `{}` stub `sync-sheet` leaves behind when there is no artwork to
 * copy, which is not a broken sheet but an absent one.
 */
export function isSyncedSheet(json: unknown): boolean {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return false;
  return Object.keys(json).length > 0;
}

/**
 * Pick between the synced artwork and the placeholder.
 *
 * Pure, and here rather than in `src/main/sheet.ts`, because three callers need
 * the same answer: the main process, which draws the mascot; the animation
 * gallery renderer (`npm run sprites`), which must show the owner exactly the
 * sheet the app would draw rather than a second opinion about it; and the tests.
 * It is also a branch that has to work on a machine where the art pipeline has
 * never run, which is precisely the machine nobody tests on.
 */
export function chooseSheetSource(real: unknown, fallback: unknown): SheetSource {
  if (isSyncedSheet(real)) return { name: 'walder.json', json: real, isReal: true };
  return { name: 'placeholder.json', json: fallback, isReal: false };
}

/* --------------------------------------------------------------------- boxes */

/**
 * The sheet's dimensions for one box, as the `{ width, height }` that
 * `overlayMetrics` and `spriteOrigin` take.
 *
 * Throws if the box is absent, which `requireSheetContract` has already ruled out
 * for `stand` and `sleep` — so a caller working from a loaded sheet cannot hit
 * it, and a caller inventing a box name finds out immediately.
 */
export function boxSize(sheet: SpriteSheet, name: string): SheetBoxSize {
  const box = sheet.boxes[name];
  if (box === undefined) throw new SpriteSheetError(`no box "${name}" in the sheet`);
  return { width: box[0], height: box[1] };
}

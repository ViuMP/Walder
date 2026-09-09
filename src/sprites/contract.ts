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
import { SpriteSheetError, type DecorAnchor, type SpriteSheet } from './types';
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

/* ------------------------------------------------ decorations the app draws */

/*
 * THE MIGRATION THIS SECTION EXISTS FOR (2026-09-09).
 *
 * The three tables above describe the art as it is *today*: the owner drew the
 * `?` into `tilt_2` and the `z z` into `sleep_2`, so the app's only job is to
 * keep quiet where the pixels already speak.
 *
 * That stops working the moment the dog is mirrored. A baked `?` mirrors with
 * him and comes out backwards, and `confused` has no speech bubble to fall back
 * on — its only frame *is* `tilt_2`, so removing the drawn `?` would leave a
 * confused dog with nothing above his head at all. The fix is for the app to
 * draw the glyphs itself, un-mirrored, over glyph-less frames.
 *
 * Those glyph-less frames do not exist yet: they arrive with the regenerated
 * `tilt` and `sleep` strips (stage A). So both mechanisms live here at once, and
 * which one runs is decided **by the sheet**, not by a flag:
 *
 *  - The app draws a decoration only where the sheet declares an anchor for it
 *    (`decorAnchors`, validated in `types.ts`). Today's sheet declares none, so
 *    `visibleDecors` returns nothing, `drawDecorations` draws nothing, and the
 *    behaviour is exactly what shipped in 0.1.2 — the baked glyphs, suppressed
 *    bubbles, no change on screen.
 *  - When the new strips land, `art/strips.py` emits anchors for `tilt`,
 *    `confused` and `sleep`. The same code then draws the `?` and the `z z`
 *    itself, the right way round on a mirrored dog, and `bubbleIsDrawnAsDecor`
 *    takes over from `bubbleIsBakedIn` for the `?`.
 *
 * There is deliberately NO default anchor. An above-the-box default would place
 * a `?` in the speech-bubble reserve, where it collides with a bark bubble's
 * tail, and it would apply to *today's* sheet — drawing a second `?` beside the
 * baked one, which is the exact bug the baked tables exist to prevent. "No
 * anchor" therefore means "not the app's job", which is a statement the art can
 * make one animation at a time.
 */

/**
 * Decorations the **app** draws, keyed by the frame they appear on.
 *
 * Frame-keyed rather than animation-keyed, unlike `BAKED_DECOR_BY_ANIMATION`,
 * because the frame is what carries the timing:
 *
 *  - `tilt_2` is both the frame `tilt` holds on while the `?` is up *and*
 *    `confused`'s only frame, so one entry covers "waiting for you" and "logged
 *    out" without either animation needing to know about the other;
 *  - `sleep_2` is the last frame of a three-second loop, so the `z z` appears for
 *    one second in three — a slow pulse, which is what the owner drew.
 *
 * The anchor is looked up under the **current animation** (`confused` and `tilt`
 * both hold `tilt_2` but frame it differently), which is why `strips.py` emits an
 * anchor for each of them.
 */
export const APP_DECOR_BY_FRAME: Readonly<Record<string, readonly DecorName[]>> = {
  tilt_2: ['qmark'],
  sleep_2: ['zz']
};

/**
 * Bubbles whose whole content is a decoration the app can draw instead.
 *
 * `waiting` is the `?` bubble: with an anchor in the sheet the sprite *replaces*
 * the bubble rather than being suppressed by it, which is the point — a drawn `?`
 * beside the dog's ear reads as the dog wondering, where a `?` in a speech
 * balloon reads as the dog asking a question.
 *
 * `sleepy` is not here: it says `…zzz` over `sleep_0`/`sleep_1` and only the
 * *third* frame carries the glyph, so the bubble is still the right thing to
 * show two-thirds of the time. It goes on being suppressed per frame instead.
 */
export const BUBBLE_AS_DECOR: Readonly<Partial<Record<BubbleKind, DecorName>>> = {
  waiting: 'qmark'
};

/** The anchor for one decoration in one animation, or `null` if the art declares none. */
export function decorAnchorFor(
  sheet: SpriteSheet,
  animation: string | null,
  decor: DecorName
): DecorAnchor | null {
  if (animation === null) return null;
  return sheet.decorAnchors[animation]?.[decor] ?? null;
}

/**
 * Which decoration sprites the app should draw right now.
 *
 * The union of what the frame calls for and what the bubble would have said,
 * **filtered to those the sheet has an anchor for** — so this returns `[]` on
 * every sheet drawn before the anchors existed, and the app draws nothing it does
 * not know where to put.
 *
 * `bubbleKind` is `null` when nothing is being said (and in the gallery, which
 * has no bubbles at all). Order is stable — frame decorations first, then the
 * bubble's — and duplicates are dropped, which matters for exactly one case: a
 * `waiting` bubble while `tilt` holds on `tilt_2` asks for `qmark` twice.
 */
export function visibleDecors(
  sheet: SpriteSheet,
  animation: string | null,
  frame: string | null,
  bubbleKind: BubbleKind | null
): readonly DecorName[] {
  const fromFrame = (frame === null ? undefined : APP_DECOR_BY_FRAME[frame]) ?? [];
  const fromBubble = bubbleKind === null ? undefined : BUBBLE_AS_DECOR[bubbleKind];
  const wanted = fromBubble === undefined ? fromFrame : [...fromFrame, fromBubble];
  if (wanted.length === 0) return [];

  const anchored = wanted.filter((decor) => decorAnchorFor(sheet, animation, decor) !== null);
  if (anchored.length < 2) return anchored;
  return [...new Set(anchored)];
}

/**
 * Is this bubble's entire message already on screen as a decoration sprite the
 * app is drawing?
 *
 * The sibling of `bubbleIsBakedIn`, and suppressing for the same reason — two
 * question marks read as a rendering bug — but about the app's own drawing rather
 * than the illustrator's. Both are consulted: `bubbleIsBakedIn` while the old art
 * is in place, this one once the anchors arrive, and neither is true in between.
 *
 * Takes the already-computed `visible` list rather than recomputing it, so the
 * renderer cannot end up drawing a decoration it decided not to suppress the
 * bubble for.
 */
export function bubbleIsDrawnAsDecor(
  kind: BubbleKind,
  visible: readonly DecorName[]
): boolean {
  const decor = BUBBLE_AS_DECOR[kind];
  if (decor === undefined) return false;
  return visible.includes(decor);
}

/**
 * May the dog be mirrored on *this* sheet?
 *
 * The mirror and the decoration layer are one feature wearing two hats, and this
 * function is the seam. Flipping the dog flips every pixel in his frame,
 * including the ones the illustrator drew *on top of* him: today's `tilt_2`
 * carries a `?` and today's `sleep_2` carries a `z z`, so a mirrored dog on
 * today's art shows a backwards question mark and a backwards `z z` — on the
 * left half of the screen, which is precisely where the mirror is wanted. That
 * is not a subtler bug than facing the wrong way; it is a worse one, because a
 * dog looking off the edge merely looks absent-minded while a reversed glyph
 * looks like a broken renderer.
 *
 * The fix is the anchor-driven layer above: glyph-less strips, and the app
 * drawing the `?` and the `z z` itself, un-mirrored, at an anchor that flips.
 * Until those strips exist the mirror must stay off — and it must switch on when
 * they land **without anyone editing this file**, because the two halves ship in
 * different stages and a flag left off is exactly how a finished feature stays
 * invisible for a release.
 *
 * So the sheet decides, by the same rule the drawing already uses:
 *
 *  - For every `[frame, decors]` entry in `APP_DECOR_BY_FRAME` — the app's own
 *    statement of which glyphs it is responsible for — **at least one animation
 *    in the sheet must play that frame**, and **every** animation that plays it
 *    must declare an anchor for **every** one of that frame's decorations.
 *
 * Both halves of that are load-bearing:
 *
 *  - *Every* animation, not just one: `tilt_2` is played by `tilt` ("waiting for
 *    you") and by `confused` ("logged out"), which frame the dog's head
 *    differently and therefore carry separate anchors. If only `tilt` were
 *    anchored, a mirrored `confused` dog would fall through to the baked `?` and
 *    show it backwards — the exact failure this gate exists to prevent, and one
 *    that only appears when the user happens to be logged out.
 *  - *At least one*, so an empty set is not vacuously ready: `placeholder.json`
 *    has no `tilt_2` and no `sleep_2` frame at all, no `qmark`/`zz` boxes, and
 *    draws its own marks into `confused_0`/`confused_1` — none of it audited for
 *    mirroring, because the placeholder is the sheet on a machine where the art
 *    pipeline has never run. "The frames I would decorate are missing" is not
 *    evidence that mirroring is safe; it is evidence that this is not the v3 art.
 *
 * **Migration story.** On both sheets in the repo today `decorAnchors` is `{}`,
 * so this returns `false`, `isMirrored(facing) && mirrorReady(sheet)` is always
 * `false`, and the dog is drawn exactly as he was in 0.1.2 — art-oriented, with
 * the illustrator's glyphs, `facingFor` still computing a facing that nothing
 * acts on. When stage A's regenerated `tilt`/`sleep` strips and `strips.py`'s
 * anchors land, this returns `true` on the new sheet and the mirror, the
 * anchor-flipped `?` and the anchor-flipped `z z` all switch on together, with
 * no code change and no flag to remember. A sheet that lands half-migrated —
 * `tilt` anchored, `sleep` forgotten — stays un-mirrored rather than shipping one
 * correct glyph and one backwards one.
 *
 * Pure, and per *sheet*: the renderer must memoise it once per sheet load rather
 * than call it per paint (it walks every animation's frame list), and must use
 * the one answer for the blit, the hit test, the hover rect and the debug
 * outline alike — a picture and a hit test that disagree about the mirror is a
 * dog who swallows clicks a body-width away from himself.
 */
export function mirrorReady(sheet: SpriteSheet): boolean {
  for (const [frameName, decors] of Object.entries(APP_DECOR_BY_FRAME)) {
    const playing = Object.keys(sheet.animations).filter((name) =>
      sheet.animations[name]?.frames.includes(frameName)
    );
    if (playing.length === 0) return false;
    for (const decor of decors) {
      for (const animation of playing) {
        if (decorAnchorFor(sheet, animation, decor) === null) return false;
      }
    }
  }
  return true;
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

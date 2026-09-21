/**
 * Which way the dog is looking, and the arithmetic for turning him round.
 *
 * The owner's complaint was concrete: parked in the bottom-*left* corner, Walder
 * stares off the edge of the screen instead of at the work. Every strip is drawn
 * with him facing left (`art/README.md`, rule 3), so "look the other way" can
 * only mean a horizontal mirror — there is no second set of drawings and there
 * never will be, because a hand-drawn mirror of twenty strips is twenty more
 * chances for the two halves to drift apart.
 *
 * Three decisions are baked into this module, and all three are the reason it is
 * a pure module in `core/` rather than three lines in the renderer:
 *
 *  - **Main decides, the renderer obeys.** Only the main process knows where
 *    the window is against the display layout (`screen`), and a renderer that
 *    guessed from `window.screenX` would be wrong on every secondary display
 *    and on every scaling factor. So `facingFor` is called in main and
 *    the answer is pushed over IPC — one boolean-ish fact, changed a handful of
 *    times a day.
 *  - **Hysteresis, not a threshold.** A dog dragged along the middle of the
 *    screen, or standing a pixel from the centre while the window is nudged by a
 *    re-clamp, would otherwise flip on every move. `facingFor` keeps the previous
 *    answer inside a dead band and only commits outside it, which is why it takes
 *    `previous` at all.
 *  - **Mirroring is a coordinate transform, not a second sprite.** The bitmap is
 *    still rasterised art-oriented and cached under one key; the flip happens at
 *    blit time (`FrameRender.mirrored`) and every *query* against the art —
 *    is-this-pixel-ink, where-is-the-silhouette, where-does-the-`?`-go — is
 *    mirrored back into art coordinates by the helpers below. That keeps exactly
 *    one representation of the artwork and confines the flip to four call sites.
 */

/**
 * Which way Walder is **looking** — not which way he is drawn.
 *
 * `'left'` is the art's own orientation, so it is the no-op; `'right'` means the
 * frame is blitted mirrored. Named after the gaze rather than after the transform
 * ("mirrored"/"normal") because every human-facing sentence about this feature is
 * about where he is looking, and a flag whose name is the implementation reads
 * backwards at half the call sites.
 */
export type Facing = 'left' | 'right';

/**
 * The direction the strips are drawn in. Every frame in the sheet faces this way,
 * which is what makes the mirror a pure transform rather than a lookup.
 */
export const ART_FACING: Facing = 'left';

/**
 * Half-width of the dead band around the display's horizontal centre, as a
 * fraction of the display width — so ±4 % of the screen, about ±69 px on a
 * 1728-px-wide laptop panel.
 *
 * Chosen from the two ways this can look wrong. Too narrow and a drag that ends
 * near the middle leaves him flipping as the window is nudged by a re-clamp or a
 * bubble widening (the widening moves the window's left edge, so the *centre*
 * moves too). Too wide and a dog parked a third of the way across the screen
 * still faces the wrong way, which is the bug being fixed. A band of four
 * percent is wider than any nudge the app itself produces and narrow enough that
 * only a deliberately centred dog lands in it.
 */
export const FACING_DEADBAND_FRACTION = 0.04;

/** Is this a `Facing`? The IPC boundary's validator — the renderer is untrusted. */
export function isFacing(value: unknown): value is Facing {
  return value === 'left' || value === 'right';
}

/** Is the frame blitted mirrored for this facing? */
export function isMirrored(facing: Facing): boolean {
  return facing !== ART_FACING;
}

/** Just the horizontal half of a display's bounds — all this module needs. */
export interface FacingDisplayBounds {
  readonly x: number;
  readonly width: number;
}

/**
 * Which way the dog should look, given where he is standing.
 *
 * He looks *towards* the middle of the `display` he is given: left of its
 * centre he faces right, right of it he faces left (the art's own direction).
 * Which display that is belongs to the caller, and since 0.2.7 it is always the
 * primary one — see `syncFacing` in `main/overlay-window.ts`. Inside the dead
 * band around the centre the previous answer is kept, so a dog dragged across
 * the middle turns exactly once and a window nudged by a pixel never turns at
 * all.
 *
 * `previous` is also the answer for any input that cannot be reasoned about — a
 * non-finite centre, a zero-width display, a display rect that has not arrived
 * yet. Keeping the current facing is the only safe failure: the alternative is a
 * dog who spins because `screen` briefly reported nonsense during a display
 * change, which is exactly when this is called.
 */
export function facingFor(
  dogCentreX: number,
  displayBounds: FacingDisplayBounds,
  previous: Facing
): Facing {
  if (!Number.isFinite(dogCentreX)) return previous;
  const { x, width } = displayBounds;
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return previous;

  const centre = x + width / 2;
  const band = width * FACING_DEADBAND_FRACTION;
  if (dogCentreX < centre - band) return 'right';
  if (dogCentreX > centre + band) return 'left';
  return previous;
}

/**
 * Mirror a logical sprite x within a frame `width` pixels wide.
 *
 * `width - 1 - lx`, i.e. a reflection about the *box* centre, in whole pixels
 * and with no rounding anywhere: column 0 becomes the last column, and applying
 * it twice is the identity. That last property is what makes it safe to use for
 * both directions — the hit test mirrors a cursor *into* art coordinates, the
 * decoration layer mirrors an anchor *out of* them.
 *
 * Deliberately does not clamp. A cursor one pixel off the sprite's left edge is
 * `-1`, and it must come back as one pixel off the *right* edge rather than as
 * an edge pixel, or `isOpaqueAt`'s outward dilation would turn a near-miss on
 * one side into a hit on the other.
 */
export function mirrorLogicalX(lx: number, width: number): number {
  return width - 1 - lx;
}

/** A tight box around some ink, in logical sprite pixels. Structurally `MaskBounds`. */
export interface HorizontalBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Mirror a silhouette's bounds within a frame `width` pixels wide.
 *
 * The two x edges swap as well as move, which is the whole reason this is not
 * `mirrorLogicalX` applied twice by the caller: `minX` comes from the old `maxX`.
 * Vertical bounds are untouched — nothing here ever flips vertically.
 */
export function mirrorBounds(bounds: HorizontalBounds, width: number): HorizontalBounds {
  return {
    minX: mirrorLogicalX(bounds.maxX, width),
    minY: bounds.minY,
    maxX: mirrorLogicalX(bounds.minX, width),
    maxY: bounds.maxY
  };
}

/**
 * Mirror a decoration's anchor: `x` is the *left edge* of a `decorWidth`-wide box
 * inside a `boxWidth`-wide one, so the mirrored left edge is
 * `boxWidth - decorWidth - x`.
 *
 * Not `mirrorLogicalX`: that reflects a *point*, and reflecting a box's left edge
 * as a point would put the box's left edge where its right edge belongs — the `?`
 * would land a glyph-width off the dog's ear. An involution like the others
 * (applying it twice returns `x`), and exact for any width, because both terms
 * are whole sprite pixels.
 */
export function mirrorAnchorX(x: number, boxWidth: number, decorWidth: number): number {
  return boxWidth - decorWidth - x;
}

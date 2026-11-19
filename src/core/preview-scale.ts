/**
 * How far the Walder window's two card previews shrink to fit a narrow window.
 *
 * **QA row 10.7 (Windows, 2026-11-18): at the window's narrowest the two
 * previews failed in opposite ways.** The Hover card's Live preview kept the
 * card at its own pinned width and ran it out of its frame (the percentages and
 * "tokens" cut off, and a sideways scrollbar on the whole page); the Overview
 * narrowed the card to whatever room was left beside the dog, so its labels
 * truncated, its bars thinned to hairlines and its percentages wrapped.
 *
 * Both previews are a picture of the real hover card, and the card's layout is
 * fixed per card size (`cardBoxWidthFor` in `card-layout.ts`, pinned by the
 * painter). A narrower window may make the picture smaller; it may not make it
 * a picture of a different card. So the renderer lays each preview out at its
 * natural size and scales the whole of it — the card, and in the Overview the
 * dog beside it — by the factor below.
 *
 * Pure numbers, so the bounds are provable without a window
 * (`test/preview-scale.test.ts`).
 */
import { PANEL_GAP } from './panel-place';

/**
 * The scale that fits a preview `naturalPx` wide into `availablePx`: exactly 1
 * whenever it already fits — so a wide window is drawn exactly as before — and
 * otherwise the fraction that makes it exactly as wide as the room. Never above
 * 1 (a preview is never blown up past the real card's size) and never 0.
 *
 * Anything that cannot be measured returns 1, the "leave it alone" answer: a
 * hidden page measures 0 wide, and a preview not laid out yet has no width.
 * The caller measures again when either appears (its ResizeObserver).
 */
export function previewScale(availablePx: number, naturalPx: number): number {
  if (!Number.isFinite(availablePx) || availablePx <= 0) return 1;
  if (!Number.isFinite(naturalPx) || naturalPx <= 0) return 1;
  return Math.min(1, availablePx / naturalPx);
}

/**
 * The width the Overview's stage needs to show `cardWidth` whole on the dog's
 * left, as the desktop places it (`placePanel`): the stage's `inset`, the card,
 * the desktop's own `gap` to the dog's ink, and `dogExtent` — from the left of
 * the dog's ink to the stage's right inner edge. This is the scene's natural
 * width, the `naturalPx` of `previewScale` there.
 */
export function besideWidth(cardWidth: number, dogExtent: number, inset: number, gap: number = PANEL_GAP): number {
  return inset + cardWidth + gap + dogExtent;
}

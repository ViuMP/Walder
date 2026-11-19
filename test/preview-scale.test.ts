/**
 * The Walder window's two card previews shrink to fit a narrow window instead
 * of overflowing it or reflowing the card (QA row 10.7, Windows 2026-11-18):
 * `previewScale` and `besideWidth` in `core/preview-scale.ts`.
 */
import { describe, expect, it } from 'vitest';
import { CARD_SHADOW_OFFSET, cardBoxWidthFor, cardWidthFor } from '../src/core/card-layout';
import { PANEL_GAP } from '../src/core/panel-place';
import { besideWidth, previewScale } from '../src/core/preview-scale';

/*
 * The window's narrowest page, from settings.html at the 440 px `minWidth`
 * (settings-window.ts). 440 is the window's outer width, so the page itself is
 * narrower still (the frame, a vertical scrollbar): the cases below run over a
 * span of page widths up to 440, the most generous one.
 */
const NARROW_PAGES = [380, 400, 407, 424, 440];
const MAIN_PADDING = 16; // `main` under 640 px
const FIELDSET_EDGE = 2 + 14; // border + padding
const STAGE_EDGE = 2; // `.stage` / `.card-stage` border
const CARD_STAGE_PADDING = 16;

/** The Live preview's room for the card at page width `page`. */
function hoverCardRoom(page: number): number {
  return page - 2 * (MAIN_PADDING + FIELDSET_EDGE + STAGE_EDGE + CARD_STAGE_PADDING);
}

/** The Overview stage's inner width (`clientWidth`) at page width `page`. */
function overviewRoom(page: number): number {
  return page - 2 * (MAIN_PADDING + STAGE_EDGE);
}

/*
 * The dog's reach from his ink's left edge to the stage's right inner edge:
 * `right: 28px` on `#preview-sprite`, plus the 72-px frame's columns right of
 * Walder's idle ink (x = 6) at the drawn scale.
 */
const SPRITE_RIGHT = 28;
const FRAME = 72;
const WALDER_INK_X = 6;
function dogExtent(scale: number): number {
  return SPRITE_RIGHT + (FRAME - WALDER_INK_X) * scale;
}
const INSET = 16;

describe('previewScale', () => {
  it('is exactly 1 whenever the preview fits', () => {
    expect(previewScale(380, 380)).toBe(1);
    expect(previewScale(381, 380)).toBe(1);
    expect(previewScale(10_000, 380)).toBe(1);
  });

  it('is the fraction that makes the preview exactly as wide as the room', () => {
    expect(previewScale(190, 380)).toBe(0.5);
    expect(previewScale(307, 380) * 380).toBeCloseTo(307, 9);
  });

  it('never goes above 1 and never reaches 0', () => {
    for (const available of [1, 50, 199.5, 307, 379.99, 380, 900]) {
      for (const natural of [1, 246, 380, 630, 5000]) {
        const scale = previewScale(available, natural);
        expect(scale).toBeGreaterThan(0);
        expect(scale).toBeLessThanOrEqual(1);
        expect(scale * natural).toBeLessThanOrEqual(available + 1e-9);
      }
    }
  });

  it('leaves the preview alone when there is nothing to measure', () => {
    // A hidden page measures 0 wide; a preview with no width yet has nothing to shrink.
    for (const [available, natural] of [
      [0, 380],
      [-20, 380],
      [Number.NaN, 380],
      [300, 0],
      [300, -1],
      [300, Number.NaN],
      [Number.POSITIVE_INFINITY, 380],
      [300, Number.POSITIVE_INFINITY]
    ] as const) {
      expect(previewScale(available, natural), `${available} / ${natural}`).toBe(1);
    }
  });
});

describe('besideWidth', () => {
  it('is the inset, the card, the desktop gap and the dog', () => {
    expect(besideWidth(376, 160, INSET)).toBe(INSET + 376 + PANEL_GAP + 160);
    expect(besideWidth(376, 160, INSET, 0)).toBe(INSET + 376 + 160);
  });
});

describe('at the narrowest window (QA row 10.7)', () => {
  it('fits the Large card whole in the Hover card live preview', () => {
    const natural = cardWidthFor('large'); // the box and its offset shadow
    expect(natural).toBe(cardBoxWidthFor('large') + CARD_SHADOW_OFFSET);
    for (const page of NARROW_PAGES) {
      const room = hoverCardRoom(page);
      expect(room).toBeLessThan(natural); // the fault: 340 px of room at best
      const scale = previewScale(room, natural);
      expect(scale).toBeLessThan(1);
      expect(scale * natural).toBeLessThanOrEqual(room + 1e-9);
    }
    // The screenshot's page (407 px with the scrollbar): 307 px of room.
    expect(previewScale(hoverCardRoom(407), natural)).toBeCloseTo(307 / 380, 9);
  });

  it('fits the dog and the Large card side by side in the Overview, at every dog size', () => {
    const card = cardBoxWidthFor('large');
    for (const dog of [1, 2, 3]) {
      const natural = besideWidth(card, dogExtent(dog), INSET);
      for (const page of NARROW_PAGES) {
        const room = overviewRoom(page);
        const scale = previewScale(room, natural);
        expect(scale).toBeLessThan(1);
        // Scaled whole: the card keeps its own width inside the scene, and
        // the scene is no wider than the stage.
        expect(natural * scale).toBeLessThanOrEqual(room + 1e-9);
        // In the scene's own units the card still fits on the dog's left.
        const dogX = natural - dogExtent(dog);
        expect(dogX - PANEL_GAP - card).toBeGreaterThanOrEqual(INSET);
      }
    }
    // The default Medium dog with the Large card at a 440 px page.
    expect(previewScale(overviewRoom(440), besideWidth(card, dogExtent(2), INSET))).toBeCloseTo(404 / 564, 9);
  });

  it('changes nothing at the default 1140 px window with the default Medium dog', () => {
    // 1140 less the rail (196), the page padding (2 x 24), the companion column
    // (264) and its gap (24), and the stage's borders: 604 px of stage, before
    // the frame and any scrollbar take their share (about 571 then).
    for (const room of [571, 588, 604]) {
      for (const size of ['large', 'medium', 'small'] as const) {
        expect(previewScale(room, besideWidth(cardBoxWidthFor(size), dogExtent(2), INSET))).toBe(1);
      }
    }
    // The Hover card editor's own column: 444 less 22 + 2 and the stage's 2 x 18.
    expect(previewScale(444 - 24 - 36, cardWidthFor('large'))).toBe(1);
  });
});

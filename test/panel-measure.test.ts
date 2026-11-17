/**
 * D2 (Windows QA, 2026-11-14): the first hover after tray ▸ Card size ▸ Small
 * placed the card at 250 × 140 with a vertical scrollbar and its bottom border
 * cut off; a second later it was re-placed at 250 × 153.
 *
 * The mechanism: a size change made while the card is hidden has no dog to
 * place against, so main leaves the hidden window at the old width, and the
 * renderer — whose `#card` was `width: 100%` of that window — measured the
 * Small layout in Medium's 370 px viewport. One note that wraps at 250 px did
 * not wrap at 370, so the reported height was one line short; the body could
 * scroll, so the shortfall was a scrollbar.
 *
 * The renderer cannot run here (vitest under node, no jsdom — see the header of
 * `panel.ts`), so a real measurement is out of reach. What is pinned instead is
 * every link of the fix that is text or arithmetic:
 *  - the width the painter lays the card out at is a function of the card size
 *    alone, and it is the window width less the shadow strip `panel.html`
 *    reserves — so a height measured at it is the height at the shown width;
 *  - the painter actually uses that width, and the reported height goes through
 *    the same shadow arithmetic;
 *  - the page itself can never scroll, in either axis.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CARD_SHADOW_OFFSET,
  CARD_SIZES,
  cardBoxWidthFor,
  cardWidthFor,
  panelHeightFor
} from '../src/core/card-layout';

// The card's rules and painter are shared with the Walder window since 2026-11-17:
// card.css and card-dom.ts, with panel.html and panel.ts keeping the page around them.
const html =
  readFileSync(new URL('../src/renderer/panel.html', import.meta.url), 'utf8') +
  readFileSync(new URL('../src/renderer/card.css', import.meta.url), 'utf8');
const painter =
  readFileSync(new URL('../src/renderer/panel.ts', import.meta.url), 'utf8') +
  readFileSync(new URL('../src/renderer/card-dom.ts', import.meta.url), 'utf8');

/** The body of the first CSS rule whose selector list matches `selector`. */
function ruleBody(selector: RegExp): string {
  const match = new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`).exec(html);
  expect(match, `no rule for ${selector.source} in panel.html`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('the hover card is measured at the width it is shown at (D2)', () => {
  it('lays each size out at its window width less the shadow strip, independent of the window', () => {
    for (const size of CARD_SIZES) {
      expect(cardBoxWidthFor(size)).toBe(cardWidthFor(size) - CARD_SHADOW_OFFSET);
    }
    // Spelled out, so the loop above is not the function restating itself:
    // the 380 / 370 / 250 windows less the 4 px strip.
    expect(CARD_SIZES.map((size) => cardBoxWidthFor(size))).toEqual([376, 366, 246]);
    // The case that was seen: Small laid out at Small's width, not at the 370
    // px Medium window the page was still in.
    expect(cardBoxWidthFor('small')).toBeLessThan(cardWidthFor('medium') - CARD_SHADOW_OFFSET);
  });

  it('keeps CARD_SHADOW_OFFSET equal to the shadow and the room panel.html leaves for it', () => {
    // `body` on its own, after the `html, body` rule closes.
    const body = ruleBody(/\}\s*body/);
    expect(body).toMatch(new RegExp(`padding:\\s*0 ${CARD_SHADOW_OFFSET}px ${CARD_SHADOW_OFFSET}px 0;`));
    const card = ruleBody(/#card/);
    expect(card).toMatch(
      new RegExp(`box-shadow:\\s*${CARD_SHADOW_OFFSET}px ${CARD_SHADOW_OFFSET}px 0 var\\(--ink\\);`)
    );
  });

  it('pins the painter to that width and the height report to the same arithmetic', () => {
    // Without this line `#card` is `width: 100%` of whatever window it is in,
    // which is the bug.
    expect(painter).toMatch(/card\.style\.width = `\$\{cardBoxWidthFor\(model\.size\)\}px`;/);
    expect(painter).toMatch(/panelHeightFor\(card\.getBoundingClientRect\(\)\.height\)/);
    // No second, hand-written copy of the shadow arithmetic left behind.
    expect(painter).not.toMatch(/getBoundingClientRect\(\)\.height\)\s*\+\s*\d/);
  });

  it('turns a measured card height into a window height that never clips the bottom border', () => {
    expect(panelHeightFor(149)).toBe(149 + CARD_SHADOW_OFFSET);
    // A fractional layout height rounds up: a window half a pixel short clips.
    expect(panelHeightFor(148.2)).toBe(149 + CARD_SHADOW_OFFSET);
    // Not laid out yet: nothing to report, rather than a window of shadow.
    expect(panelHeightFor(0)).toBeNull();
    expect(panelHeightFor(Number.NaN)).toBeNull();
  });

  it('never lets the panel page scroll, so a stale height clips for a moment instead of showing a scrollbar', () => {
    const root = ruleBody(/html,\s*body/);
    expect(root).toMatch(/(^|\s)overflow:\s*hidden;/);
    // Nothing else in the sheet re-opens scrolling on the page or the card.
    expect(html).not.toMatch(/overflow(-[xy])?:\s*(auto|scroll)/);
  });
});

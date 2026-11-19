/**
 * The Walder window's two card previews at a narrow window (QA row 10.7,
 * Windows 2026-11-18), read as text (no jsdom here).
 *
 * Both previews are a picture of the real hover card, so a narrow window may
 * shrink them but never reflow the card: the Overview used to narrow `#card`
 * with a `maxWidth` to squeeze it beside the dog, and the Live preview let the
 * card's pinned width run out of its frame. Now each is scaled whole inside a
 * wrapper (`previewScale`), refitted when its frame resizes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ts = readFileSync(new URL('../src/renderer/settings.ts', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/renderer/settings.html', import.meta.url), 'utf8');

/** The markup of the `<div>` with `id`, through its matching close tag. */
function divMarkup(id: string): string {
  const open = html.lastIndexOf('<div', html.indexOf(`id="${id}"`));
  const tags = /<\/?div\b/g;
  tags.lastIndex = open;
  let depth = 0;
  for (let tag = tags.exec(html); tag !== null; tag = tags.exec(html)) {
    depth += tag[0] === '<div' ? 1 : -1;
    if (depth === 0) return html.slice(open, tag.index);
  }
  return '';
}

/** The declarations of the first CSS rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(html)?.[1] ?? '';
}

describe('the Overview preview at a narrow window', () => {
  it('draws the dog and the card inside one scaled scene', () => {
    expect(html).toContain('id="stage-scene"');
    const scene = divMarkup('stage-scene');
    expect(scene).toContain('id="preview-sprite"');
    expect(scene).toContain('id="card"');
  });

  it('never narrows the card to squeeze it beside the dog', () => {
    expect(ts).not.toMatch(/card\.style\.maxWidth\s*=/);
  });

  it('scales from the stage width, through previewScale', () => {
    expect(ts).toMatch(/import \{[^}]*\bpreviewScale\b[^}]*\} from '\.\.\/core\/preview-scale'/);
    expect(ts).toMatch(/new ResizeObserver\(placeCard\)\.observe\(/);
  });
});

describe('the Hover card live preview at a narrow window', () => {
  it('wraps the card in a box that takes its scaled size', () => {
    expect(html).toContain('id="card-preview-fit"');
    expect(divMarkup('card-preview-fit')).toContain('id="card-preview"');
  });

  it('centres the wrapper, not the card, and scales the card from its top-left corner', () => {
    expect(rule('.card-fit')).toMatch(/margin:\s*auto/);
    expect(rule('.card-stage .card-preview')).not.toMatch(/margin:\s*auto/);
    expect(rule('.card-stage .card-preview')).toMatch(/transform-origin:\s*0 0/);
  });

  it('refits on a window resize and on every repaint of the card', () => {
    expect(html).toContain('class="card-stage" id="card-stage"');
    expect(ts).toMatch(/new ResizeObserver\(\(\) => \{[\s\S]{0,240}?fitCardPreview\(\);[\s\S]{0,40}?\}\)\.observe\(cardStage\)/);
    expect(ts).toMatch(/paint\(\s*cardPreview,[\s\S]*?\);\s*fitCardPreview\(\);/);
  });
});

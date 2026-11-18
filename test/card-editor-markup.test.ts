/**
 * The Hover card editor's markup (no jsdom here, so read as text): with Advanced
 * off, `settings.ts` makes one element inert and faded. The notes that explain
 * why must sit outside it, or a screen reader skips them and they show at
 * ~2.5:1 contrast.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ts = readFileSync(new URL('../src/renderer/settings.ts', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/renderer/settings.html', import.meta.url), 'utf8');

/** The id of the element `settings.ts` sets `.inert` on. */
function inertId(): string {
  const variable = /(\w+)\.inert = /.exec(ts)?.[1] ?? '';
  return new RegExp(`const ${variable} = document\\.getElementById\\('([\\w-]+)'\\)`).exec(ts)?.[1] ?? '';
}

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

describe('the Hover card editor with Advanced off', () => {
  it('makes only the list and Restore inert, never the notes', () => {
    const id = inertId();
    expect(id).not.toBe('');
    const inert = divMarkup(id);
    expect(inert).toContain('id="card-lines"');
    expect(inert).toContain('id="card-restore"');
    for (const note of ['card-standard-note', 'card-size-note', 'card-lines-help', 'card-lines-status']) {
      expect(html, note).toContain(`id="${note}"`);
      expect(inert, note).not.toContain(`id="${note}"`);
    }
  });
});

/**
 * The Hover card editor's markup (no jsdom here, so read as text): with Advanced
 * off, `settings.ts` makes one element inert and faded. The notes that explain
 * why must sit outside it, or a screen reader skips them and they show at
 * ~2.5:1 contrast.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { en } from '../src/core/i18n';

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
    for (const note of ['card-standard-note', 'card-lines-help', 'card-lines-status']) {
      expect(html, note).toContain(`id="${note}"`);
      expect(inert, note).not.toContain(`id="${note}"`);
    }
  });
});

describe('the Walder window markup names its words by key (data-i18n)', () => {
  const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

  it('names only keys that exist, and its English is the English table', () => {
    const text = [...html.matchAll(/<(\w+)[^>]*\bdata-i18n="([\w.]+)"[^>]*>([^<]*)<\/\1>/g)];
    const aria = [...html.matchAll(/aria-label="([^"]*)" data-i18n-aria-label="([\w.]+)"/g)];
    expect(text.length).toBeGreaterThan(25);
    expect(aria.length).toBe(3);
    for (const [, , key, english] of text) {
      expect(Object.hasOwn(en, key as string), key).toBe(true);
      expect(collapse(english as string), key).toBe(en[key as keyof typeof en]);
    }
    for (const [, english, key] of aria) {
      expect(Object.hasOwn(en, key as string), key).toBe(true);
      expect(english, key).toBe(en[key as keyof typeof en]);
    }
    // Every data-i18n in the file was matched above: none sits on an element with children.
    expect(html.match(/data-i18n="/g)?.length).toBe(text.length);
  });
});

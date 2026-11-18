/**
 * Main's language is set before any module that freezes a `t()` at import is
 * evaluated (`src/main/language-boot.ts`). That holds only while the boot is
 * the first import of `index.ts` and imports nothing that calls `t()` itself;
 * a later import re-sort would otherwise freeze main in English silently.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SPECIFIER = /^import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/gm;

function importsOf(path: string): string[] {
  const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
  return [...source.matchAll(SPECIFIER)].map((match) => match[1] as string);
}

describe('main language boot', () => {
  it('is the first import of src/main/index.ts', () => {
    expect(importsOf('main/index.ts')[0]).toBe('./language-boot');
  });

  it('imports only electron, node built-ins, store-path, core/strings and core/i18n', () => {
    expect(importsOf('main/language-boot.ts')).toEqual([
      'electron',
      'node:fs',
      './store-path',
      '../core/strings',
      '../core/i18n'
    ]);
    expect(importsOf('main/store-path.ts').every((s) => s.startsWith('node:'))).toBe(true);
    expect(importsOf('core/strings.ts')).toEqual(['./i18n']);
  });

  it('core/i18n/index.ts imports the tables and nothing else', () => {
    const imports = importsOf('core/i18n/index.ts');
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(specifier, specifier).toMatch(/^\.\/(en|da|zh-CN|hi|es|fr|de)$/);
  });

  it('every page window passes the boot-time language to its page as ?lang=', () => {
    for (const file of ['main/hover-panel.ts', 'main/overlay-window.ts', 'main/settings-window.ts']) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      expect(source, file).toMatch(/pageUrl\(\s*'\w+\.html',\s*`\?lang=\$\{language\(\)\}/);
    }
  });
});

/**
 * Every relative link and image in the tracked Markdown points at a file that exists.
 *
 * Files get moved and deleted in clean-ups, and a link that silently 404s on GitHub
 * is how a doc starts to mislead. `design/` is skipped (its concept notes are
 * history with their own loose paths). `#anchors` are not checked, only the file.
 * Paths written in backticks are code, not links, and are not checked either.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');

const files = execFileSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !f.startsWith('design/') && !f.includes('node_modules/'));

/** `[text](target)`, `![alt](target)`, `[ref]: target` (not `[^footnote]:`), and `src=` / `href=` in inline HTML. */
const LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)|^\s*\[(?!\^)[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)|<(?:img|a|source)\s[^>]*?(?:src|href|srcset)=["']([^"'\s]+)/gm;

function targets(markdown: string): string[] {
  // Code and comments are not links: drop fenced blocks (up to three spaces of
  // indent, as CommonMark allows), HTML comments and inline code spans first.
  const text = markdown
    .replace(/^ {0,3}(`{3,}|~{3,})[\s\S]*?^ {0,3}\1/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/`[^`\n]*`/g, '');
  return [...text.matchAll(LINK)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

function isLocal(target: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#') && !target.startsWith('//');
}

describe('relative links in tracked Markdown', () => {
  it('finds Markdown files to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('every relative link and image resolves to an existing file', () => {
    const broken: string[] = [];
    for (const file of files) {
      for (const target of targets(readFileSync(join(ROOT, file), 'utf8'))) {
        if (!isLocal(target)) continue;
        const path = decodeURIComponent(target.replace(/[#?].*$/, ''));
        if (!path) continue;
        const absolute = path.startsWith('/') ? join(ROOT, path) : join(ROOT, dirname(file), path);
        if (!existsSync(absolute)) broken.push(`${file} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

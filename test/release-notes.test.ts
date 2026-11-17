/**
 * A version bump with no release notes is a release nobody can read about —
 * and the release script itself only *prefers* a notes file (`publish-release
 * .ts` falls back to one plain line when `docs/release-notes/v<version>.md` is
 * missing), so nothing there stops it. This is that stop, run where a bump
 * actually gets noticed: the test suite.
 *
 * Every file in `docs/release-notes/` follows one format — `v<version>.md`,
 * with `## v<version>: <headline>` as its first line — so the checks below
 * are that format, read back:
 *
 *  - every existing file names itself correctly (catches a typo or a
 *    copy-pasted heading before it ships), and
 *  - the version in `package.json` right now has to be one of them, so
 *    `npm version` past the newest notes file fails the suite instead of
 *    `npm run release` quietly writing "Walder <version>" as the only note.
 *
 * A third check: `CHANGELOG.md` is a copy of these files, newest first, so a
 * notes file can exist and never reach it, or the two can drift. Each file's
 * text has to appear in it verbatim.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readText } from './support/host';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const notesDir = join(root, 'docs', 'release-notes');
const changelogPath = join(root, 'CHANGELOG.md');

/** Line endings normalised: a Windows checkout ends every line with CRLF. */
function firstLine(path: string): string {
  return readText(path).split('\n')[0] ?? '';
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('package.json has no version');
  }
  return pkg.version;
}

describe('release notes', () => {
  it('every notes file titles itself after its own version', () => {
    const names = readdirSync(notesDir).filter((name) => name.endsWith('.md'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).toMatch(/^v\d+\.\d+\.\d+\.md$/);
      const tag = name.replace(/\.md$/, '');
      expect(firstLine(join(notesDir, name)).startsWith(`## ${tag}: `)).toBe(true);
    }
  });

  it('the current package.json version has notes, titled to match', () => {
    const version = packageVersion();
    const path = join(notesDir, `v${version}.md`);
    expect(existsSync(path)).toBe(true);
    expect(firstLine(path).startsWith(`## v${version}: `)).toBe(true);
  });

  it('every notes file appears verbatim in CHANGELOG.md', () => {
    const names = readdirSync(notesDir).filter((name) => name.endsWith('.md'));
    const changelog = readText(changelogPath);
    for (const name of names) {
      expect(changelog).toContain(readText(join(notesDir, name)).trim());
    }
  });
});

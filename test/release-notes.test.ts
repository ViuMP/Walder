/**
 * A version bump with no release notes is a release nobody can read about —
 * and the release script itself only *prefers* a notes file (`publish-release
 * .ts` falls back to one plain line when `docs/release-notes/<version>.md` is
 * missing), so nothing there stops it. This is that stop, run where a bump
 * actually gets noticed: the test suite.
 *
 * Every file in `docs/release-notes/` already follows one convention —
 * `# Walder <version>` as its first line, the version taken from the file
 * name — so both checks below are just that convention, read back:
 *
 *  - every existing file names itself correctly (catches a typo or a
 *    copy-pasted heading before it ships), and
 *  - the version in `package.json` right now has to be one of them.
 *
 * The second check *is* the gate P1-10 asks for: today `package.json` is 0.2.5
 * and `docs/release-notes/0.2.5.md` exists, so this passes; the day someone
 * runs `npm version` past the newest notes file without adding one, the file
 * this looks for will not exist and the suite fails instead of `npm run
 * release` quietly writing "Walder 0.2.6" as the only note.
 *
 * A third check: `CHANGELOG.md` is an index of this directory, by hand, so a
 * notes file can exist and never get an index line. That is a release nobody
 * finds from the changelog, and it fails quietly until this test looks for
 * the link.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const notesDir = join(root, 'docs', 'release-notes');
const changelogPath = join(root, 'CHANGELOG.md');

function firstLine(path: string): string {
  return readFileSync(path, 'utf8').split('\n')[0] ?? '';
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
      const version = name.replace(/\.md$/, '');
      expect(firstLine(join(notesDir, name))).toBe(`# Walder ${version}`);
    }
  });

  it('the current package.json version has notes, titled to match', () => {
    const version = packageVersion();
    const path = join(notesDir, `${version}.md`);
    expect(existsSync(path)).toBe(true);
    expect(firstLine(path)).toBe(`# Walder ${version}`);
  });

  it('every notes file is linked from CHANGELOG.md', () => {
    const names = readdirSync(notesDir).filter((name) => name.endsWith('.md'));
    const changelog = readFileSync(changelogPath, 'utf8');
    for (const name of names) {
      expect(changelog).toMatch(new RegExp(`\\]\\(docs/release-notes/${name}\\)`));
    }
  });
});

/**
 * The release script's two decisions: which files go up, and what `gh` is told.
 *
 * Both are pure functions in `scripts/publish-release.ts`, and both are here
 * because a mistake in either is nearly invisible at the moment it is made:
 *
 *  - **The asset filter.** `release/` accumulates. A run that picked up last
 *    version's `.dmg` would attach it to this version's release — a download
 *    that installs the wrong build, with nothing on the page to say so. And
 *    `latest-mac.yml` is `electron-updater`'s feed file: publishing one would
 *    advertise an auto-update channel Walder does not have (an unsigned macOS
 *    app cannot usefully replace itself), so the app would be telling
 *    `electron-updater` clients something untrue.
 *  - **The argv.** `gh` is tolerant, so a misplaced flag lands as a release
 *    title rather than as an error, and nobody would notice until the page was
 *    read. In particular `--generate-notes` must never appear: it would build a
 *    changelog from the *release* repository's commits, which contains no code.
 *
 * Nothing here runs `gh` or touches GitHub. The script itself only calls `main`
 * when it is the process entry point.
 */
import { describe, expect, it } from 'vitest';
import { NEVER_UPLOAD, releaseArgs, releaseAssets } from '../scripts/publish-release';
import { UPDATE_REPO } from '../src/core/update-check';

/** A `release/` directory as electron-builder leaves it after both builds. */
const DIRECTORY: readonly string[] = [
  '.icon-icns',
  'Walder-0.1.3-mac-arm64.dmg',
  'Walder-0.1.3-mac-arm64.dmg.blockmap',
  'Walder-0.1.3-win-x64.exe',
  'Walder-0.1.3-win-x64.exe.blockmap',
  'builder-debug.yml',
  'builder-effective-config.yaml',
  'latest-mac.yml',
  'mac-arm64'
];

describe('releaseAssets', () => {
  it('takes the two installers and nothing else', () => {
    expect(releaseAssets(DIRECTORY, '0.1.3')).toEqual([
      'Walder-0.1.3-mac-arm64.dmg',
      'Walder-0.1.3-win-x64.exe'
    ]);
  });

  it('never uploads the electron-updater feed or the build diagnostics', () => {
    const chosen = releaseAssets(DIRECTORY, '0.1.3');
    for (const name of NEVER_UPLOAD) expect(chosen).not.toContain(name);
    expect(NEVER_UPLOAD).toContain('latest-mac.yml');
    expect(NEVER_UPLOAD).toContain('builder-debug.yml');
  });

  it('leaves a previous version’s installer behind', () => {
    // The quiet disaster this prevents: `release/` accumulates, and an old .dmg
    // attached to a new release is a download that installs the wrong build.
    const mixed = [...DIRECTORY, 'Walder-0.1.2-mac-arm64.dmg', 'Walder-0.2.0-mac-arm64.dmg'];
    expect(releaseAssets(mixed, '0.1.3')).toEqual([
      'Walder-0.1.3-mac-arm64.dmg',
      'Walder-0.1.3-win-x64.exe'
    ]);
  });

  it('ignores blockmaps, directories and anything that is not an installer', () => {
    expect(releaseAssets(DIRECTORY, '0.1.3').every((name) => /\.(dmg|exe)$/.test(name))).toBe(
      true
    );
  });

  it('is empty when nothing has been built for this version', () => {
    // Which is what makes the script say "run npm run dist:mac first" instead
    // of creating an empty release.
    expect(releaseAssets(DIRECTORY, '0.9.9')).toEqual([]);
    expect(releaseAssets([], '0.1.3')).toEqual([]);
  });

  it('takes just one installer when only one platform was built', () => {
    expect(releaseAssets(['Walder-0.1.3-mac-arm64.dmg', 'latest-mac.yml'], '0.1.3')).toEqual([
      'Walder-0.1.3-mac-arm64.dmg'
    ]);
  });
});

describe('releaseArgs', () => {
  const assets = ['release/Walder-0.1.3-mac-arm64.dmg', 'release/Walder-0.1.3-win-x64.exe'];

  it('builds the exact argv, with the tag prefixed and the title spelled out', () => {
    expect(releaseArgs({ version: '0.1.3', repo: UPDATE_REPO, assets })).toEqual([
      'release',
      'create',
      'v0.1.3',
      '--repo',
      'ViuMP/walder-releases',
      '--title',
      'Walder 0.1.3',
      '--notes',
      'Walder 0.1.3',
      ...assets
    ]);
  });

  it('prefers a notes file when there is one', () => {
    const args = releaseArgs({
      version: '0.1.3',
      repo: UPDATE_REPO,
      assets,
      notesFile: 'docs/release-notes/0.1.3.md'
    });
    expect(args).toContain('--notes-file');
    expect(args[args.indexOf('--notes-file') + 1]).toBe('docs/release-notes/0.1.3.md');
    expect(args).not.toContain('--notes');
  });

  it('never asks GitHub to generate the notes', () => {
    // The release repository holds installers and no code, so generated notes
    // would be an empty or nonsensical changelog on a page people are sent to.
    for (const options of [
      { version: '0.1.3', repo: UPDATE_REPO, assets },
      { version: '0.1.3', repo: UPDATE_REPO, assets, notesFile: 'notes.md' },
      { version: '0.1.3', repo: UPDATE_REPO, assets, clobber: true }
    ]) {
      expect(releaseArgs(options)).not.toContain('--generate-notes');
    }
  });

  it('passes --clobber only when asked', () => {
    expect(releaseArgs({ version: '0.1.3', repo: UPDATE_REPO, assets })).not.toContain(
      '--clobber'
    );
    expect(
      releaseArgs({ version: '0.1.3', repo: UPDATE_REPO, assets, clobber: true })
    ).toContain('--clobber');
  });

  it('puts the files last, after every flag', () => {
    const args = releaseArgs({ version: '0.1.3', repo: UPDATE_REPO, assets, clobber: true });
    expect(args.slice(-assets.length)).toEqual(assets);
  });

  it('names the same repository the app checks', () => {
    // Imported from core rather than written out here, so the app and the script
    // cannot drift apart.
    const args = releaseArgs({ version: '0.1.3', repo: UPDATE_REPO, assets });
    expect(args[args.indexOf('--repo') + 1]).toBe(UPDATE_REPO);
  });

  it('keeps every argument as its own array element', () => {
    // The whole reason `execFileSync` is used with an argv array: a shell string
    // would put a version or a notes path through word-splitting.
    const args = releaseArgs({
      version: '0.1.3',
      repo: UPDATE_REPO,
      assets: ['release/Walder 0.1.3.dmg']
    });
    expect(args).toContain('release/Walder 0.1.3.dmg');
    expect(args.every((arg) => !arg.includes('&&') && !arg.includes(';'))).toBe(true);
  });
});

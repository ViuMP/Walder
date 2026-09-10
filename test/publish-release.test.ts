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
 *  - **The handbook.** The releases repository's README already promises the
 *    full guide ships inside each release, so leaving it off makes a live
 *    public page untrue — and it is untrue quietly, because a release with two
 *    installers on it looks complete. So the tests below pin three things: it
 *    is in the asset list, it reaches the argv, and a missing
 *    `docs/HANDBOOK.html` produces an instruction the owner can act on rather
 *    than a release published without it.
 *  - **What `--dry-run` runs.** A dry run that reached the network at all was a
 *    dry run that could fail on a missing login before printing the command it
 *    was asked about — and the flag exists precisely for the moment you are not
 *    sure. `ghPlan` is the decision, so the promise is checkable here.
 *
 * Nothing here runs `gh` or touches GitHub. The script itself only calls `main`
 * when it is the process entry point.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HANDBOOK_BUILD_COMMAND,
  HANDBOOK_SOURCE,
  NEVER_UPLOAD,
  ghPlan,
  handbookAsset,
  handbookDisplayName,
  missingHandbookMessage,
  releaseArgs,
  releaseAssets,
  uploadAssets
} from '../scripts/publish-release';
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

describe('the handbook asset', () => {
  it('names itself after the version, not just HANDBOOK.html', () => {
    // Every release would otherwise offer a file called `HANDBOOK.html`, with
    // nothing on the page saying which build it documents.
    expect(handbookDisplayName('0.1.3')).toBe('Walder-0.1.3-HANDBOOK.html');
    expect(handbookDisplayName('0.2.0')).toBe('Walder-0.2.0-HANDBOOK.html');
  });

  it('is the repository file plus a gh display label', () => {
    // `gh release create` reads `path#label`, so nothing is copied anywhere and
    // a dry run stays a read-only operation.
    expect(handbookAsset('0.1.3')).toBe('docs/HANDBOOK.html#Walder-0.1.3-HANDBOOK.html');
    expect(handbookAsset('0.1.3')).toBe(`${HANDBOOK_SOURCE}#${handbookDisplayName('0.1.3')}`);
  });

  it('carries whatever absolute path the script resolved', () => {
    // `main` passes the path it actually checked with existsSync, so the label
    // and the file cannot come from two different places.
    expect(handbookAsset('0.1.3', '/repo/docs/HANDBOOK.html')).toBe(
      '/repo/docs/HANDBOOK.html#Walder-0.1.3-HANDBOOK.html'
    );
  });

  it('splits into exactly one argv element, label and all', () => {
    // The `#` is data inside one argument, not a separator a shell would see —
    // which is only true because execFileSync is given an array.
    const asset = handbookAsset('0.1.3');
    expect(asset.split(' ')).toHaveLength(1);
    expect(asset).not.toContain('&&');
    expect(asset).not.toContain(';');
    expect(asset).not.toContain('|');
  });

  it('actually exists in the repository', () => {
    // The promise this whole change exists to keep: the releases repo's README
    // says the guide ships in every release, so the file has to be there to
    // ship. If this fails, run the build command the failure message names.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    expect(existsSync(join(root, ...HANDBOOK_SOURCE.split('/')))).toBe(true);
  });
});

describe('uploadAssets', () => {
  const installers = ['release/Walder-0.1.3-mac-arm64.dmg', 'release/Walder-0.1.3-win-x64.exe'];

  it('is the installers plus the handbook, in that order', () => {
    expect(uploadAssets({ installers, version: '0.1.3' })).toEqual([
      ...installers,
      'docs/HANDBOOK.html#Walder-0.1.3-HANDBOOK.html'
    ]);
  });

  it('adds the handbook even when only one platform was built', () => {
    expect(uploadAssets({ installers: installers.slice(0, 1), version: '0.1.3' })).toHaveLength(
      2
    );
  });

  it('never drops or reorders the installers', () => {
    const list = uploadAssets({ installers, version: '0.1.3' });
    expect(list.slice(0, installers.length)).toEqual(installers);
  });

  it('composes with releaseAssets the way the script does', () => {
    // The real pairing: the directory listing decides the installers, and the
    // handbook is appended to whatever that produced.
    const list = uploadAssets({
      installers: releaseAssets(DIRECTORY, '0.1.3'),
      version: '0.1.3'
    });
    expect(list).toEqual([
      'Walder-0.1.3-mac-arm64.dmg',
      'Walder-0.1.3-win-x64.exe',
      'docs/HANDBOOK.html#Walder-0.1.3-HANDBOOK.html'
    ]);
  });

  it('still keeps the never-upload files out', () => {
    const list = uploadAssets({
      installers: releaseAssets(DIRECTORY, '0.1.3'),
      version: '0.1.3'
    });
    for (const name of NEVER_UPLOAD) expect(list).not.toContain(name);
  });
});

describe('missingHandbookMessage', () => {
  it('tells the owner the command that regenerates it', () => {
    // He is not a programmer and does not read the script: "the handbook is
    // missing" on its own is a dead end.
    const message = missingHandbookMessage(HANDBOOK_SOURCE);
    expect(message).toContain('docs/HANDBOOK.html');
    expect(message).toContain('python3 docs/handbook/build_walder.py');
    expect(message).toContain(HANDBOOK_BUILD_COMMAND);
  });

  it('reads as plain English, not as a stack trace', () => {
    const message = missingHandbookMessage(HANDBOOK_SOURCE);
    expect(message).toMatch(/missing/i);
    expect(message).not.toMatch(/Error|ENOENT|undefined/);
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

  it('is exactly what the plan carries as its create step', () => {
    // The link between the two exported halves: whatever `releaseArgs` builds is
    // what the real plan carries as its `create` step, and nothing rewrites it
    // on the way.
    const release = releaseArgs({ version: '0.1.3', repo: UPDATE_REPO, assets });
    const real = ghPlan({ dryRun: false, repo: UPDATE_REPO, version: '0.1.3', release });
    expect(real.find((call) => call.step === 'create')?.args).toEqual(release);
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

  it('carries the handbook through to the argv, last and unaltered', () => {
    // The end-to-end shape of the promise: what `uploadAssets` decides is what
    // `gh` is handed, with the `#` label intact and nothing after it.
    const upload = uploadAssets({ installers: assets, version: '0.1.3' });
    const args = releaseArgs({ version: '0.1.3', repo: UPDATE_REPO, assets: upload });
    expect(args).toContain('docs/HANDBOOK.html#Walder-0.1.3-HANDBOOK.html');
    expect(args[args.length - 1]).toBe('docs/HANDBOOK.html#Walder-0.1.3-HANDBOOK.html');
    expect(args.slice(-upload.length)).toEqual(upload);
  });

  it('keeps the handbook when a notes file and --clobber are also in play', () => {
    // The flags go before the files, so no combination of them may push the
    // handbook out of the list.
    const upload = uploadAssets({ installers: assets, version: '0.1.3' });
    const args = releaseArgs({
      version: '0.1.3',
      repo: UPDATE_REPO,
      assets: upload,
      notesFile: 'docs/release-notes/0.1.3.md',
      clobber: true
    });
    expect(args).toContain(handbookAsset('0.1.3'));
    expect(args.indexOf(handbookAsset('0.1.3'))).toBeGreaterThan(args.indexOf('--clobber'));
  });
});

describe('ghPlan', () => {
  const release = releaseArgs({
    version: '0.1.3',
    repo: UPDATE_REPO,
    assets: ['release/Walder-0.1.3-mac-arm64.dmg']
  });
  const plan = (dryRun: boolean): readonly (readonly string[])[] =>
    ghPlan({ dryRun, repo: UPDATE_REPO, version: '0.1.3', release }).map((call) => call.args);

  /** Every argument of every planned call, flattened — the whole argv surface. */
  const words = (dryRun: boolean): string[] => plan(dryRun).flat();

  it('plans one local call for a dry run, and nothing that touches GitHub', () => {
    // `gh --version` asks a local binary for its version number: worth doing, so
    // a missing CLI is reported, and not a network step.
    expect(plan(true)).toEqual([['--version']]);
  });

  it('names no network verb at all in a dry run', () => {
    // Spelled out one by one, because each of these ran before `--dry-run` was
    // consulted and each could end the script with GitHub's own error instead of
    // the command the owner asked to see.
    const argv = words(true);
    expect(argv).not.toContain('api');
    expect(argv).not.toContain('auth');
    expect(argv).not.toContain('status');
    expect(argv).not.toContain('release');
    expect(argv).not.toContain('view');
    expect(argv).not.toContain('create');
    // And nothing carrying the repository, which is the shape of every remote
    // call in this script.
    expect(argv.some((word) => word.includes(UPDATE_REPO))).toBe(false);
    expect(plan(true).some((call) => call.join(' ').includes('release view'))).toBe(false);
    expect(plan(true).some((call) => call.join(' ').includes('release create'))).toBe(false);
    expect(plan(true).some((call) => call.join(' ').includes('auth status'))).toBe(false);
  });

  it('plans the whole dance for a real run, in the order it has to happen', () => {
    // The order is the point: the login before the repository probe, the
    // "already released?" look-up before the publish, the URL after it.
    expect(
      ghPlan({ dryRun: false, repo: UPDATE_REPO, version: '0.1.3', release }).map(
        (call) => call.step
      )
    ).toEqual(['version', 'auth', 'commits', 'existing', 'create', 'url']);
    expect(plan(false)[1]).toEqual(['auth', 'status']);
    expect(plan(false)[2]).toEqual(['api', 'repos/ViuMP/walder-releases/commits?per_page=1']);
    expect(plan(false)[3]).toEqual([
      'release',
      'view',
      'v0.1.3',
      '--repo',
      UPDATE_REPO
    ]);
  });

  it('probes the CLI in both modes, and only that in a dry run', () => {
    // A dry run is a strict subset of a real one: the same first call, then it
    // stops.
    expect(plan(true)[0]).toEqual(plan(false)[0]);
    expect(plan(true)).toHaveLength(1);
    expect(plan(false).length).toBeGreaterThan(1);
  });

  it('never asks a shell to interpret anything', () => {
    // The file's own rule: `execFileSync` with an argv array, so no element may
    // need quoting to be safe.
    for (const call of plan(false)) {
      for (const word of call) {
        expect(word).not.toContain('&&');
        expect(word).not.toContain(';');
        expect(word).not.toContain('|');
      }
    }
  });

  it('prints the handbook in what a dry run shows', () => {
    // A dry run prints `ghPlan({ dryRun: false, … })` verbatim, one line per
    // call, which is the only place the owner can check the handbook is going
    // up before it goes up. Rendered here exactly as the script renders it.
    const withHandbook = releaseArgs({
      version: '0.1.3',
      repo: UPDATE_REPO,
      assets: uploadAssets({ installers: ['release/Walder-0.1.3-mac-arm64.dmg'], version: '0.1.3' })
    });
    const printed = ghPlan({
      dryRun: false,
      repo: UPDATE_REPO,
      version: '0.1.3',
      release: withHandbook
    }).map((call) => `  gh ${call.args.join(' ')}`);
    expect(
      printed.some((line) => line.includes('docs/HANDBOOK.html#Walder-0.1.3-HANDBOOK.html'))
    ).toBe(true);
    expect(printed.find((line) => line.includes('release create'))).toContain(
      handbookAsset('0.1.3')
    );
  });
});

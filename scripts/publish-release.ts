/**
 * `npm run release` — publish the installers in `release/` to the public
 * releases repository, so the app's update check can find them.
 *
 * ## Why this script exists at all
 *
 * Walder's code repository is private; its releases live in a separate public
 * repo (`UPDATE_REPO`, imported from `core/update-check.ts` so the app and this
 * script cannot possibly name different ones). Publishing is therefore a
 * multi-step `gh` dance, and the steps that go wrong are exactly the ones that
 * are easy to get wrong by hand: forgetting to build first, uploading the
 * electron-builder metadata files, tagging a version that already has a
 * release, or running it against an empty repository that has no commit to tag.
 * Each of those has a check below with a message that says what to do next.
 *
 * ## Two rules in the implementation
 *
 * **`execFileSync` with an argv array, never a shell string.** The version, the
 * notes and the file names all reach a command line, and a shell string would
 * put them through word-splitting and metacharacter expansion. There is no
 * `shell: true` anywhere in this file.
 *
 * **`latest-mac.yml` and `builder-debug.yml` are never uploaded.** electron-vite
 * writes them next to the installers; the first is `electron-updater`'s feed and
 * Walder has no auto-updater (an unsigned macOS app cannot usefully replace
 * itself — see `core/update-check.ts`), so publishing one would advertise an
 * update channel that does not work. The second is build diagnostics about the
 * machine it was built on and belongs in no public place at all.
 *
 * Usage:
 *   npm run release
 *   npm run release -- --notes-file docs/release-notes/0.1.3.md
 *   npm run release -- --clobber          # replace an existing release's files
 *   npm run release -- --dry-run          # print the gh commands and stop
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { UPDATE_REPO } from '../src/core/update-check';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Metadata electron-builder writes beside the installers. Never published. */
export const NEVER_UPLOAD: readonly string[] = [
  'latest-mac.yml',
  'latest-linux.yml',
  'latest.yml',
  'builder-debug.yml',
  'builder-effective-config.yaml'
];

/** Installer extensions worth publishing. */
const INSTALLER_EXTENSIONS: readonly string[] = ['.dmg', '.exe'];

/**
 * The installers for `version` among `entries`, sorted.
 *
 * Matched on the `Walder-<version>-` prefix that `artifactName` in
 * `electron-builder.yml` produces, so a `release/` directory still holding last
 * version's `.dmg` cannot have it attached to this version's release — which
 * would be a download that installs the wrong build, and the least visible
 * possible mistake.
 *
 * Pure, so the rule is unit-tested rather than discovered during a release.
 */
export function releaseAssets(entries: readonly string[], version: string): string[] {
  const prefix = `Walder-${version}-`;
  return entries
    .filter((name) => !NEVER_UPLOAD.includes(name))
    .filter((name) => name.startsWith(prefix))
    .filter((name) => INSTALLER_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)))
    .sort();
}

/**
 * The argv for `gh release create`.
 *
 * `--notes-file` or `--notes`, and **never `--generate-notes`**: that asks
 * GitHub to write the notes from the commits of the *release repository*, which
 * contains no code and no history — it would produce an empty or nonsensical
 * changelog on a page the owner points people at.
 *
 * Pure and exported so the exact argv is pinned by a test. Getting this wrong is
 * not something a dry run would necessarily show: `gh` is tolerant, and a
 * misplaced flag can end up as a release title.
 */
export function releaseArgs(options: {
  readonly version: string;
  readonly repo: string;
  readonly assets: readonly string[];
  readonly notesFile?: string;
  readonly notes?: string;
  readonly clobber?: boolean;
}): string[] {
  const args = [
    'release',
    'create',
    `v${options.version}`,
    '--repo',
    options.repo,
    '--title',
    `Walder ${options.version}`
  ];
  if (options.notesFile !== undefined) args.push('--notes-file', options.notesFile);
  else args.push('--notes', options.notes ?? `Walder ${options.version}`);
  if (options.clobber === true) args.push('--clobber');
  args.push(...options.assets);
  return args;
}

/* ------------------------------------------------------------------ script */

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return null;
  return argv[at + 1] ?? null;
}

/** Run `gh` and return its stdout, or `null` when it exited non-zero. */
function gh(args: readonly string[]): string | null {
  try {
    return execFileSync('gh', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

/** Print `message` and stop, without a stack trace the owner cannot use. */
function fail(message: string): never {
  console.error(`\nnpm run release: ${message}\n`);
  process.exit(1);
}

function appVersion(): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    fail('package.json has no version. Run `npm version patch` first.');
  }
  return pkg.version;
}

/**
 * Is the release repository empty?
 *
 * `gh release create` needs a commit to hang a tag on, and a repository created
 * through the web UI with no README has none — the failure it produces
 * ("Reference does not exist") explains nothing. So it is detected up front and
 * the fix is printed as two commands.
 */
function repoIsEmpty(repo: string): boolean {
  const commits = gh(['api', `repos/${repo}/commits?per_page=1`]);
  if (commits === null) return true;
  try {
    return (JSON.parse(commits) as unknown[]).length === 0;
  } catch {
    return true;
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const clobber = argv.includes('--clobber');
  const version = appVersion();
  const releaseDir = join(root, 'release');

  console.log(`Walder ${version} -> ${UPDATE_REPO}`);

  /* 1. The installers. */
  if (!existsSync(releaseDir)) {
    fail('there is no release/ directory yet. Run `npm run dist:mac` (and/or `dist:win`) first.');
  }
  const assets = releaseAssets(readdirSync(releaseDir), version);
  if (assets.length === 0) {
    fail(
      `no installers for ${version} in release/.\n` +
        '  Run `npm run dist:mac` (and/or `npm run dist:win`) first — the files are\n' +
        `  named Walder-${version}-mac-arm64.dmg and Walder-${version}-win-x64.exe.`
    );
  }
  for (const asset of assets) console.log(`  will upload  ${asset}`);

  /* 2. The gh CLI, and a login. */
  if (gh(['--version']) === null) {
    fail(
      'the GitHub CLI (gh) is not installed.\n' +
        '  Install it with `brew install gh`, then run `gh auth login`.'
    );
  }
  if (gh(['auth', 'status']) === null) {
    fail('you are not signed in to GitHub. Run `gh auth login`, then try again.');
  }

  /* 3. The release repository has to exist and have a commit. */
  if (repoIsEmpty(UPDATE_REPO)) {
    fail(
      `the release repository ${UPDATE_REPO} is empty or unreachable.\n` +
        '  A release needs something to attach a tag to, so give it one commit:\n' +
        `    gh repo create ${UPDATE_REPO} --public --description "Walder installers"\n` +
        `    gh api -X PUT repos/${UPDATE_REPO}/contents/README.md \\\n` +
        '      -f message="First commit" -f content="$(printf \'# Walder releases\' | base64)"'
    );
  }

  /* 4. Notes: a file if there is one, otherwise one plain line. */
  const givenNotes = flag(argv, 'notes-file');
  const conventional = join(root, 'docs', 'release-notes', `${version}.md`);
  const notesFile =
    givenNotes !== null ? givenNotes : existsSync(conventional) ? conventional : null;
  if (notesFile !== null && !existsSync(notesFile)) {
    fail(`the notes file ${notesFile} does not exist.`);
  }

  /* 5. Refuse to publish over an existing release unless told to. */
  const existing = gh(['release', 'view', `v${version}`, '--repo', UPDATE_REPO]);
  if (existing !== null && !clobber) {
    fail(
      `v${version} is already released in ${UPDATE_REPO}.\n` +
        '  Bump the version with `npm version patch` and rebuild, or pass\n' +
        '  `-- --clobber` to replace the files on the existing release.'
    );
  }

  const args = releaseArgs({
    version,
    repo: UPDATE_REPO,
    assets: assets.map((name) => join(releaseDir, name)),
    ...(notesFile === null ? {} : { notesFile }),
    ...(clobber ? { clobber: true } : {})
  });

  if (dryRun) {
    console.log('\n--dry-run, so nothing was published. The command would be:\n');
    console.log(`  gh ${args.join(' ')}\n`);
    return;
  }

  console.log('\nPublishing…');
  try {
    execFileSync('gh', args, { stdio: 'inherit' });
  } catch {
    fail('gh could not create the release. Its own message is above.');
  }

  const url = gh([
    'release',
    'view',
    `v${version}`,
    '--repo',
    UPDATE_REPO,
    '--json',
    'url',
    '--jq',
    '.url'
  ]);
  console.log(`\nDone. ${url === null ? `See https://github.com/${UPDATE_REPO}/releases` : url.trim()}`);
  console.log("Walder's update check will find it within six hours.");
}

// Only when run as a script; the test imports the pure helpers above.
if (process.argv[1] !== undefined && process.argv[1].endsWith('publish-release.ts')) main();

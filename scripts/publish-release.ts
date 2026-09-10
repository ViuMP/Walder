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
 * **`--dry-run` is decided before anything reaches the network.** The steps are
 * planned up front by the pure `ghPlan`, and a dry run's plan holds one local
 * call (`gh --version`) — so the flag you type when you are *not* sure cannot
 * fail on a missing login or an absent repository before it has printed the
 * command you asked about.
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
 *   npm run release -- --dry-run          # print the gh commands and stop,
 *                                         # without asking GitHub anything
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

/**
 * The `gh` invocations a run makes, and the step each one is.
 *
 * `version` is `gh --version`, which is a local capability probe and reaches no
 * network. The other five all talk to GitHub: `auth` is `gh auth status`,
 * `commits` the empty-repository probe, `existing` the "is this version already
 * released" look-up, `create` the publish itself, and `url` the tidy link
 * printed at the end.
 */
export type GhStep = 'version' | 'auth' | 'commits' | 'existing' | 'create' | 'url';

export interface GhCall {
  readonly step: GhStep;
  readonly args: readonly string[];
}

/**
 * Which `gh` calls a run will make, in order — the whole of the `--dry-run`
 * promise, as data.
 *
 * **A dry run must decide it is a dry run before it touches the network.** It
 * did not: `gh auth status`, the empty-repo `gh api` probe and `gh release view`
 * all ran first, and only then was `--dry-run` consulted. So `npm run release --
 * --dry-run` — the thing you type when you are *not* sure, on a machine that may
 * not be logged in, against a repository that may not exist — could fail with
 * "you are not signed in to GitHub" and never print the command it was asked
 * about. It also meant the flag's promise ("prints the command without
 * publishing", README) was true only of the last step.
 *
 * So the plan is computed once, from local inputs, and `main` runs exactly what
 * it names. A dry run names one call, `gh --version`: it is worth telling
 * someone the CLI is missing, and asking a local binary for its version number
 * is not a network step.
 *
 * Pure and exported so the promise is a unit test rather than a thing you find
 * out by watching `gh` in a process monitor.
 */
export function ghPlan(options: {
  readonly dryRun: boolean;
  readonly repo: string;
  readonly version: string;
  readonly release: readonly string[];
}): readonly GhCall[] {
  const probe: GhCall = { step: 'version', args: ['--version'] };
  if (options.dryRun) return [probe];

  const tag = `v${options.version}`;
  const view = ['release', 'view', tag, '--repo', options.repo];
  return [
    probe,
    { step: 'auth', args: ['auth', 'status'] },
    { step: 'commits', args: ['api', `repos/${options.repo}/commits?per_page=1`] },
    { step: 'existing', args: view },
    { step: 'create', args: options.release },
    { step: 'url', args: [...view, '--json', 'url', '--jq', '.url'] }
  ];
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
function repoIsEmpty(args: readonly string[]): boolean {
  const commits = gh(args);
  if (commits === null) return true;
  try {
    return (JSON.parse(commits) as unknown[]).length === 0;
  } catch {
    return true;
  }
}

/**
 * Every step is local until the plan is built, and after that the script only
 * ever runs what the plan names. The two halves in order:
 *
 *  1. **local** — the version in `package.json`, the installers in `release/`,
 *     the notes file. All three can fail, and none of them needs GitHub to say
 *     so, which is what makes `--dry-run` an offline operation.
 *  2. **the plan** (`ghPlan`) — one call for a dry run, six for a real one, and
 *     the dry run stops right after printing them.
 */
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

  /* 2. Notes: a file if there is one, otherwise one plain line. */
  const givenNotes = flag(argv, 'notes-file');
  const conventional = join(root, 'docs', 'release-notes', `${version}.md`);
  const notesFile =
    givenNotes !== null ? givenNotes : existsSync(conventional) ? conventional : null;
  if (notesFile !== null && !existsSync(notesFile)) {
    fail(`the notes file ${notesFile} does not exist.`);
  }

  /* 3. The one command that does the publishing, and the plan around it. */
  const release = releaseArgs({
    version,
    repo: UPDATE_REPO,
    assets: assets.map((name) => join(releaseDir, name)),
    ...(notesFile === null ? {} : { notesFile }),
    ...(clobber ? { clobber: true } : {})
  });
  const plan = ghPlan({ dryRun, repo: UPDATE_REPO, version, release });
  const step = (name: GhStep): readonly string[] | null =>
    plan.find((call) => call.step === name)?.args ?? null;

  /* 4. A dry run prints the plan and stops, having asked GitHub nothing. */
  if (dryRun) {
    console.log('\n--dry-run, so nothing was published. A real run would be:\n');
    for (const call of ghPlan({ dryRun: false, repo: UPDATE_REPO, version, release })) {
      console.log(`  gh ${call.args.join(' ')}`);
    }
    console.log('');
    return;
  }

  /* 5. The gh CLI, and a login. */
  const versionProbe = step('version');
  if (versionProbe !== null && gh(versionProbe) === null) {
    fail(
      'the GitHub CLI (gh) is not installed.\n' +
        '  Install it with `brew install gh`, then run `gh auth login`.'
    );
  }
  const auth = step('auth');
  if (auth !== null && gh(auth) === null) {
    fail('you are not signed in to GitHub. Run `gh auth login`, then try again.');
  }

  /* 6. The release repository has to exist and have a commit. */
  const commits = step('commits');
  if (commits !== null && repoIsEmpty(commits)) {
    fail(
      `the release repository ${UPDATE_REPO} is empty or unreachable.\n` +
        '  A release needs something to attach a tag to, so give it one commit:\n' +
        `    gh repo create ${UPDATE_REPO} --public --description "Walder installers"\n` +
        `    gh api -X PUT repos/${UPDATE_REPO}/contents/README.md \\\n` +
        '      -f message="First commit" -f content="$(printf \'# Walder releases\' | base64)"'
    );
  }

  /* 7. Refuse to publish over an existing release unless told to. */
  const existingArgs = step('existing');
  const existing = existingArgs === null ? null : gh(existingArgs);
  if (existing !== null && !clobber) {
    fail(
      `v${version} is already released in ${UPDATE_REPO}.\n` +
        '  Bump the version with `npm version patch` and rebuild, or pass\n' +
        '  `-- --clobber` to replace the files on the existing release.'
    );
  }

  console.log('\nPublishing…');
  const create = step('create');
  if (create === null) fail('nothing to publish: the plan named no release command.');
  try {
    execFileSync('gh', [...create], { stdio: 'inherit' });
  } catch {
    fail('gh could not create the release. Its own message is above.');
  }

  const urlArgs = step('url');
  const url = urlArgs === null ? null : gh(urlArgs);
  console.log(`\nDone. ${url === null ? `See https://github.com/${UPDATE_REPO}/releases` : url.trim()}`);
  console.log("Walder's update check will find it within six hours.");
}

// Only when run as a script; the test imports the pure helpers above.
if (process.argv[1] !== undefined && process.argv[1].endsWith('publish-release.ts')) main();

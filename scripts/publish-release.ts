/**
 * `npm run release` — publish the installers in `release/` and the user
 * handbook (`docs/HANDBOOK.html`) to the public releases repository, so the
 * app's update check can find the builds and a reader can find the guide.
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
 * ## The rules in the implementation
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
 * **The handbook is required, not optional.** The releases repository's README
 * already tells people the full guide ships inside each release, so a release
 * published without `docs/HANDBOOK.html` makes a live public page lie. It is
 * therefore checked and reported exactly like a missing installer — the run
 * stops with the command that regenerates it — rather than being attached only
 * when it happens to be lying around.
 *
 * **Every installer also goes up under a version-less name.** `Walder-0.2.6-
 * mac-arm64.dmg` becomes `Walder-mac-arm64.dmg` too (`stableAssetName`), copied
 * into a scratch directory first because a GitHub asset is named after the file
 * it was given — there is no separate "label" for an upload the way the
 * handbook gets one. That second copy is what lets the README and the tray's
 * download link point at `.../releases/latest/download/Walder-mac-arm64.dmg`
 * once and never edit it again: "latest" always follows the newest tag, and the
 * file name under it never changes even though the version inside it does. It is uploaded with a `#` display label
 * (`gh release create` reads `path#label`) so the release page names it per
 * version, `Walder-<version>-HANDBOOK.html`, instead of showing the same bare
 * `HANDBOOK.html` on every release with nothing to say which build it documents.
 *
 * Usage:
 *   npm run release
 *   npm run release -- --notes-file docs/release-notes/0.1.3.md
 *   npm run release -- --clobber          # replace an existing release's files
 *   npm run release -- --dry-run          # print the gh commands and stop,
 *                                         # without asking GitHub anything
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 * `Walder-0.2.6-mac-arm64.dmg` -> `Walder-mac-arm64.dmg`; `null` for anything
 * that is not an installer — a blockmap, an update-feed yml, the handbook.
 *
 * Pure, so the rule that decides what a stable download link points at is a
 * unit test rather than something you find out by refreshing a release page.
 */
export function stableAssetName(fileName: string): string | null {
  const match = /^Walder-\d+\.\d+\.\d+-(.+)$/.exec(fileName);
  const rest = match?.[1];
  if (rest === undefined) return null;
  if (!INSTALLER_EXTENSIONS.some((ext) => rest.toLowerCase().endsWith(ext))) return null;
  return `Walder-${rest}`;
}

/**
 * The handbook, as a path relative to the repository root.
 *
 * Written out once and exported so the script, the failure message and the test
 * cannot disagree about which file the release is promising.
 */
export const HANDBOOK_SOURCE = 'docs/HANDBOOK.html';

/** The command that rebuilds the handbook, named in the failure message. */
export const HANDBOOK_BUILD_COMMAND = 'python3 docs/handbook/build_walder.py';

/**
 * What the handbook is called *on the release page*.
 *
 * The file on disk is version-less — it is the current handbook, rebuilt in
 * place — but a release page is a permanent record of one build, and three
 * releases each offering a file called `HANDBOOK.html` gives a reader no way to
 * tell which one belongs to the version they are running. So the display name
 * carries the version, matching `artifactName` in `electron-builder.yml` and
 * putting the handbook next to its installers in the listing.
 */
export function handbookDisplayName(version: string): string {
  return `Walder-${version}-HANDBOOK.html`;
}

/**
 * The handbook as one `gh` asset argument: `path#display-name`.
 *
 * `gh release create` documents this form ("To define a display label for an
 * asset, append text starting with `#` after the file name"), which is why
 * nothing is copied into `release/` first: a copy would be a write performed
 * during `--dry-run` — or, if skipped on a dry run, a printed command naming a
 * file that does not exist — and a stale copy left behind from the previous
 * version is precisely the class of mistake `releaseAssets` exists to prevent.
 *
 * The `#` never reaches a shell: like every other argument here it is one
 * element of an `execFileSync` argv array.
 */
export function handbookAsset(version: string, path: string = HANDBOOK_SOURCE): string {
  return `${path}#${handbookDisplayName(version)}`;
}

/**
 * Everything a release uploads: the installers first, the handbook last.
 *
 * Kept separate from `releaseAssets` because the two answer different
 * questions. `releaseAssets` reads a directory listing and decides which of
 * those files belong to this version; the handbook is not in that directory and
 * is not optional, so it is composed on afterwards rather than filtered in.
 *
 * Pure, so "every release carries the handbook" is a unit test and not a thing
 * anyone has to remember at release time.
 */
export function uploadAssets(options: {
  readonly installers: readonly string[];
  readonly version: string;
  readonly handbookPath?: string;
}): string[] {
  return [...options.installers, handbookAsset(options.version, options.handbookPath)];
}

/**
 * What to print when the handbook is not there.
 *
 * Exported so the wording is pinned by a test: it is the only instruction the
 * owner gets, he does not read this file, and "regenerate it" without the
 * command is not an instruction.
 */
export function missingHandbookMessage(path: string): string {
  return (
    `the handbook ${path} is missing, and every release ships it.\n` +
    `  Regenerate it with \`${HANDBOOK_BUILD_COMMAND}\`, then run this again.`
  );
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
 * network. Of the rest, `auth` is `gh auth status`, `commits` the
 * empty-repository probe, `existing` the "is this version already released"
 * look-up, `create` the publish itself, `stableUpload` the second, version-less
 * copy of each installer (absent when there is nothing to re-upload under a
 * stable name), and `url` the tidy link printed at the end.
 */
export type GhStep = 'version' | 'auth' | 'commits' | 'existing' | 'create' | 'stableUpload' | 'url';

export interface GhCall {
  readonly step: GhStep;
  readonly args: readonly string[];
}

/**
 * The argv for `gh release upload`: the stable-named copies, filed onto the
 * release `create` just made.
 *
 * `--clobber` because the whole point of the stable name is that every release
 * reuses it — this call is expected to overwrite whatever the previous release
 * left under the same name, on a *different* tag where it is otherwise a no-op.
 *
 * Pure and exported for the same reason as `releaseArgs`: the argv is pinned by
 * a test rather than discovered by reading what actually got published.
 */
export function stableUploadArgs(options: {
  readonly version: string;
  readonly repo: string;
  readonly paths: readonly string[];
}): string[] {
  return [
    'release',
    'upload',
    `v${options.version}`,
    ...options.paths,
    '--repo',
    options.repo,
    '--clobber'
  ];
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
  /** `stableUploadArgs(...)` output, or `null`/omitted when there is nothing
   *  to re-upload under a stable name (no installer matched one). */
  readonly stableUpload?: readonly string[] | null;
}): readonly GhCall[] {
  const probe: GhCall = { step: 'version', args: ['--version'] };
  if (options.dryRun) return [probe];

  const tag = `v${options.version}`;
  const view = ['release', 'view', tag, '--repo', options.repo];
  const calls: GhCall[] = [
    probe,
    { step: 'auth', args: ['auth', 'status'] },
    { step: 'commits', args: ['api', `repos/${options.repo}/commits?per_page=1`] },
    { step: 'existing', args: view },
    { step: 'create', args: options.release }
  ];
  if (options.stableUpload !== undefined && options.stableUpload !== null) {
    calls.push({ step: 'stableUpload', args: options.stableUpload });
  }
  calls.push({ step: 'url', args: [...view, '--json', 'url', '--jq', '.url'] });
  return calls;
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
 *  2. **the plan** (`ghPlan`) — one call for a dry run, six or seven for a real
 *     one (`stableUpload` only when an installer had a stable name to take),
 *     and the dry run stops right after printing them.
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

  /* 2. The handbook, which every release promises and none may omit. */
  const handbookPath = join(root, ...HANDBOOK_SOURCE.split('/'));
  if (!existsSync(handbookPath)) fail(missingHandbookMessage(HANDBOOK_SOURCE));
  console.log(`  will upload  ${handbookDisplayName(version)}  (from ${HANDBOOK_SOURCE})`);

  /* 3. Notes: a file if there is one, otherwise one plain line. */
  const givenNotes = flag(argv, 'notes-file');
  const conventional = join(root, 'docs', 'release-notes', `${version}.md`);
  const notesFile =
    givenNotes !== null ? givenNotes : existsSync(conventional) ? conventional : null;
  if (notesFile !== null && !existsSync(notesFile)) {
    fail(`the notes file ${notesFile} does not exist.`);
  }

  /* 4. A second, version-less copy of each installer, so
     releases/latest/download/… never changes between releases. Copied into a
     scratch directory — never into release/, which stays exactly what
     electron-builder wrote — because a GitHub asset is named after the file it
     was given. */
  const scratch = mkdtempSync(join(tmpdir(), 'walder-release-'));
  const stablePaths = assets.flatMap((name) => {
    const stable = stableAssetName(name);
    if (stable === null) return [];
    const dest = join(scratch, stable);
    copyFileSync(join(releaseDir, name), dest);
    console.log(`  will upload  ${stable}  (stable name for ${name})`);
    return [dest];
  });

  /* 5. The one command that does the publishing, and the plan around it. */
  const release = releaseArgs({
    version,
    repo: UPDATE_REPO,
    assets: uploadAssets({
      installers: assets.map((name) => join(releaseDir, name)),
      version,
      handbookPath
    }),
    ...(notesFile === null ? {} : { notesFile }),
    ...(clobber ? { clobber: true } : {})
  });
  const stableUpload =
    stablePaths.length === 0
      ? null
      : stableUploadArgs({ version, repo: UPDATE_REPO, paths: stablePaths });
  const plan = ghPlan({ dryRun, repo: UPDATE_REPO, version, release, stableUpload });
  const step = (name: GhStep): readonly string[] | null =>
    plan.find((call) => call.step === name)?.args ?? null;

  /* 6. A dry run prints the plan and stops, having asked GitHub nothing. */
  if (dryRun) {
    console.log('\n--dry-run, so nothing was published. A real run would be:\n');
    for (const call of ghPlan({
      dryRun: false,
      repo: UPDATE_REPO,
      version,
      release,
      stableUpload
    })) {
      console.log(`  gh ${call.args.join(' ')}`);
    }
    console.log('');
    return;
  }

  /* 7. The gh CLI, and a login. */
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

  /* 8. The release repository has to exist and have a commit. */
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

  /* 9. Refuse to publish over an existing release unless told to. */
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

  /* 10. The stable-named copies, uploaded onto the release just created. */
  const stableUploadStep = step('stableUpload');
  if (stableUploadStep !== null) {
    try {
      execFileSync('gh', [...stableUploadStep], { stdio: 'inherit' });
    } catch {
      fail('gh could not publish the stable-named copies. Its own message is above.');
    }
  }

  const urlArgs = step('url');
  const url = urlArgs === null ? null : gh(urlArgs);
  console.log(`\nDone. ${url === null ? `See https://github.com/${UPDATE_REPO}/releases` : url.trim()}`);
  console.log("Walder's update check will find it within six hours.");
}

// Only when run as a script; the test imports the pure helpers above.
if (process.argv[1] !== undefined && process.argv[1].endsWith('publish-release.ts')) main();

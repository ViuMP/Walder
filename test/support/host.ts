/**
 * Writing a test once and having it hold on macOS, Linux and Windows.
 *
 * Not a test file (vitest only collects `*.test.ts`); small helpers the suites
 * share, because the same few POSIX assumptions broke 33 tests and one whole
 * suite the first time the suite was run on a Windows checkout (2026-10-02),
 * while it was green on the Mac and on the Ubuntu CI runner.
 *
 * **Paths.** The functions under test build paths with the *host's*
 * `node:path` — `join`, `delimiter`, `isAbsolute` — on purpose: at runtime the
 * platform they are told about and the platform they run on are the same, and
 * the host's `join` is then exactly the right spelling. A test that hands one
 * `'/Users/v'` and expects `'/Users/v/.codex'` back is pinning the separator of
 * whatever machine it happens to run on, not anything the function decided.
 * So the expectations stay written the way a person reads them, in POSIX, and
 * `native()` respells them the way the host's `join` would. That is stricter
 * than turning the received backslashes into slashes: on Windows a function
 * that concatenated `'/'` by hand would still fail here, which is the one
 * Windows bug a path test can actually catch.
 *
 * **PATH strings.** `PATH` is split on the host's `delimiter`, which is `;` on
 * Windows, so `'/usr/bin:/opt/homebrew/bin'` is *one* entry there. `hostPathVar`
 * joins entries the way the host's shell would.
 *
 * **Text files.** Git checks text out with CRLF on a Windows machine with
 * `core.autocrlf=true` (the default the Git for Windows installer offers). A
 * test that reads a committed YAML or Markdown file and splits it on `'\n'`
 * gets every line with a trailing `'\r'`. The files are still right — YAML and
 * Markdown do not care — so `readText` reads them the way their real consumers
 * do, with line endings normalised, instead of the test asserting about how the
 * checkout happened to be configured.
 *
 * **Running `tsx`.** `node_modules/.bin/tsx` is a shell script on macOS and
 * Linux and a `tsx.cmd` batch file on Windows, and since the April 2024
 * security releases (CVE-2024-27980) Node refuses to `execFile`/`spawn` a
 * `.cmd` or `.bat` without `shell: true` — it throws `EINVAL` before anything
 * runs. A shell is the wrong fix: it reintroduces the quoting this repo's
 * `execFileSync`-with-an-argv rule exists to avoid, and the repository path
 * here has spaces in it. Both shims do one thing — start this Node on tsx's
 * own CLI module — so `tsxCli` names that module, read from tsx's
 * `package.json` `bin` rather than spelled out, and the caller runs
 * `process.execPath` on it. Same argv, same process, on every platform.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, join, sep } from 'node:path';

/** The repository root: this file lives at `test/support/host.ts`. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A POSIX-spelled path in the spelling this host's `path.join` produces. */
export function native(posix: string): string {
  return posix.split('/').join(sep);
}

/** A `PATH` value made of these entries, joined with this host's delimiter. */
export function hostPathVar(...entries: readonly string[]): string {
  return entries.join(delimiter);
}

/** A committed text file, with CRLF (and a lone CR) read as LF. */
export function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
}

/**
 * The JavaScript file both `node_modules/.bin/tsx` shims start, or `null` when
 * tsx is not installed (a checkout whose devDependencies were pruned).
 */
export function tsxCli(): string | null {
  const dir = join(ROOT, 'node_modules', 'tsx');
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return null;
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: unknown };
  // tsx declares a single command, so `bin` is a string; the object form
  // (`{ "tsx": "…" }`) is accepted too, in case a release ever names it.
  const entry =
    typeof bin === 'string'
      ? bin
      : typeof bin === 'object' && bin !== null
        ? (bin as Record<string, unknown>)['tsx']
        : undefined;
  if (typeof entry !== 'string') return null;
  const cli = join(dir, entry);
  return existsSync(cli) ? cli : null;
}

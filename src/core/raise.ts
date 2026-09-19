/**
 * Finding the application a coding session is running inside.
 *
 * **Why a walk at all.** A hook body and the session registry give us a pid,
 * and that pid is the CLI itself — a `node` or a `codex` binary sitting several
 * levels below whatever the owner actually clicked on in the Dock. There is no
 * call that asks "which window belongs to this process": `open -a` wants an
 * application bundle, and the pid has none. What the pid *does* have is a
 * parent, and its parent a parent, and somewhere up that chain is the terminal
 * emulator that started the whole thing. So the walk exists because the process
 * tree is the only link between the number we have and the thing the owner
 * wants raised.
 *
 * **Why it stops at `.app`.** A bundle is where the operating system's notion
 * of an application begins and the shell's notion of a process ends. Below it
 * are helpers, login shells and interpreters, none of which can be raised;
 * at it is the one path `open -a` accepts. Stopping at the *outermost* bundle
 * is deliberate for the same reason: a `.app` nested inside another `.app` is
 * a helper the parent ships with, and raising a helper raises nothing the owner
 * can see. The bundle a human launched is the one nearest the root.
 *
 * Pure: the parsing and the path arithmetic live here so they can be tested as
 * strings, and `main/raise.ts` owns the half that has to run `ps`.
 */

/** The extension that ends an application bundle's directory name. */
const APP_SUFFIX = '.app';

/**
 * The application bundle `executablePath` lives inside, or `null`.
 *
 * The shortest prefix whose last path segment *ends in* `.app` — shortest
 * because of the nesting rule in the header, and "ends in" rather than
 * "contains" because a directory called `happ.apple` is not a bundle and a
 * prefix cut inside one would be a path that does not exist.
 *
 *  - `/Applications/iTerm.app/Contents/MacOS/iTerm2` → `/Applications/iTerm.app`
 *  - `/Users/x/Foo.app` → `/Users/x/Foo.app` (the executable *is* the bundle)
 *  - `/usr/bin/zsh` → `null` (not in a bundle; keep walking)
 */
export function appBundleFrom(executablePath: string): string | null {
  const parts = executablePath.split('/');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    // Longer than the suffix itself: a segment that is exactly `.app` is a
    // hidden directory with an empty name, not a bundle called nothing.
    if (part.length > APP_SUFFIX.length && part.endsWith(APP_SUFFIX)) {
      return parts.slice(0, i + 1).join('/');
    }
  }
  return null;
}

/** One line of `ps -o ppid=,comm=` output, taken apart. */
export interface PsHop {
  readonly ppid: number;
  /** The executable path `ps` reported for the pid that was asked about. */
  readonly comm: string;
}

/**
 * Parse one `ps -o ppid=,comm=` line, or `null` if it is not one.
 *
 * `ps` right-aligns the pid column, so the line begins with spaces; and `comm`
 * is a full path that may itself contain spaces (`/Applications/Visual Studio
 * Code.app/…`), so the split is on the *first* run of whitespace after the
 * number and nothing further. Anything that does not start with a number is not
 * output we understand — an error on stdout, an empty answer for a pid that
 * exited between two hops — and `null` stops the walk rather than guessing.
 */
export function nextHop(psLine: string): PsHop | null {
  // Unanchored at the end on purpose: `ps` ends its output with a newline, and
  // `$` in JavaScript does not forgive one the way it does in other languages.
  const match = /^\s*(\d+)\s+(\S.*)/.exec(psLine);
  if (match === null) return null;
  const ppid = Number(match[1]);
  if (!Number.isSafeInteger(ppid)) return null;
  return { ppid, comm: (match[2] ?? '').trimEnd() };
}

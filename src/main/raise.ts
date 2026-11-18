/**
 * Finding the application a coding session is running in.
 *
 * `core/raise.ts` explains why finding it means walking the process tree; this
 * is the half that actually runs `ps`. The one question it answers: the owner
 * just brought an application to the front — is it the one this session is
 * running in? See `onFrontmostApp` in `index.ts`.
 *
 * **It only looks; it never raises anything.** Until 2026-11-18 petting the
 * dog while a Claude Code `?` was up also ran `open -a` on this bundle to bring
 * the terminal forward. The owner removed that so Claude behaves like Codex,
 * which never raised a terminal (`docs/DECISIONS.md`). The file keeps its name
 * because the walk is the same one.
 *
 * **No shell, ever.** `execFile` with an absolute binary path and an argv
 * array, the same shape `claude-renew.ts` spawns with: there is no quoting to
 * get wrong, `PATH` is not consulted, and a bundle path containing a space or
 * a quote is one argument rather than three. The gap analysis (§7, items 3 and
 * 17) names the alternatives that are not on the table — `ps -Ao` over every
 * process on the machine, reading another process's environment, driving the
 * window server through AppleScript. None of them is needed to answer "who is
 * my parent", and each one is a much larger thing to ask the operating system
 * for.
 *
 * **Nothing here logs a path.** A process path and a working directory are the
 * owner's data — what he is building and where. The two log lines carry a hop
 * count and nothing else, which is enough to tell a walk that found something
 * from one that ran out of tree.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appBundleFrom, nextHop } from '../core/raise';
import { vlog } from './log';

const run = promisify(execFile);

/** Absolute, because `PATH` is the owner's and this is not a place to trust it. */
export const PS_BIN = '/bin/ps';

/**
 * How far up the tree to look.
 *
 * ponytail: a terminal is 2–4 hops above the CLI on this machine (node → login
 * shell → terminal), and a tmux or a `script` wrapper adds one or two more. 12
 * is a bound, not a measurement — it exists so a tree we have misread cannot
 * turn one lookup into an unbounded run of subprocesses. Ceiling: a session
 * buried deeper than twelve parents never matches the frontmost app. Upgrade
 * path: raise the number, once a real setup is found that needs it.
 */
export const MAX_HOPS = 12;

/** Long enough for `ps` on a healthy machine, short enough not to hang a poll. */
const EXEC_TIMEOUT_MS = 2_000;
/** One `ps` line is under 200 bytes; this is the cap on a stdout gone wrong. */
const EXEC_MAX_BUFFER = 64 * 1024;

export interface AppBundleDeps {
  /** Run a binary and hand back its stdout. Injected in tests. */
  readonly exec?: (bin: string, args: readonly string[]) => Promise<string>;
  readonly platform?: string;
  readonly maxHops?: number;
}

/**
 * The walk's answer for a pid, remembered.
 *
 * A pid's ancestors do not change while it lives, so the walk is a pure
 * function of the pid for as long as the answer is worth anything — and since
 * 0.2.7 the frontmost watch asks this question every two seconds per session
 * (see `onFrontmostApp` in `index.ts`), which without a cache is a `ps` per
 * session per poll for the life of the app. A miss is cached as well as a hit:
 * "no bundle above this pid" is just as stable, and re-walking twelve hops to
 * rediscover it every two seconds is the worse half of the same cost.
 *
 * ponytail: never evicted, and pids are recycled by the OS. Ceiling: one entry
 * per pid Walder has ever heard from (a few dozen over a long day, so bytes),
 * and a recycled pid whose new owner is a different application answers with
 * the old one — at worst a `done` cleared a moment early, or one not cleared.
 * Upgrade path: drop the entry when `core/sessions.ts` drops the session that
 * carried the pid.
 */
const bundleForPid = new Map<number, string | null>();

/**
 * Empty that cache.
 *
 * For the test suite and nothing else: a fake `ps` table is a different machine
 * every time, and a pid remembered from the previous `it` is an answer from a
 * process tree that no longer exists. The app has no reason to call it — the
 * whole point of the map is that a pid's ancestry does not change.
 */
export function clearAppBundleCache(): void {
  bundleForPid.clear();
}

/**
 * The application bundle a pid is running inside, or `null`.
 *
 * `index.ts` compares the frontmost application against each session's own
 * application with this (`Behaviour.onSeen`).
 *
 * Nothing here logs a path — see the file header. The result is the owner's
 * data: what he is running and where it lives.
 */
export async function appBundleForPid(pid: number, deps: AppBundleDeps = {}): Promise<string | null> {
  const cached = bundleForPid.get(pid);
  if (cached !== undefined) return cached;

  const exec = deps.exec ?? defaultExec;
  const platform = deps.platform ?? process.platform;
  const maxHops = deps.maxHops ?? MAX_HOPS;

  // `.app` bundles and `comm` holding a full path are macOS's. Nothing is run
  // at all elsewhere — a wrong answer would be worse than no answer, and there
  // is no second implementation to fall to.
  if (platform !== 'darwin') return null;

  /** Every pid already asked about, so a tree that loops cannot spin. */
  const seen = new Set<number>();
  let current = pid;
  let hops = 0;
  let found: string | null = null;

  try {
    while (hops < maxHops) {
      // pid 1 is launchd and pid 0 is the kernel: neither has an ancestor and
      // neither is in a bundle, so there is nothing above here.
      if (current <= 1 || seen.has(current)) break;
      seen.add(current);
      hops++;

      const hop = nextHop(await exec(PS_BIN, ['-o', 'ppid=,comm=', '-p', String(current)]));
      // The process exited between two hops, or `ps` said something we do not
      // understand. Either way the chain is broken here.
      if (hop === null) break;

      const bundle = appBundleFrom(hop.comm);
      if (bundle !== null) {
        found = bundle;
        break;
      }
      current = hop.ppid;
    }
  } catch {
    // `ps` refused, or the pid is not ours to inspect. No answer is not an
    // error worth a dialog; the line below already says the walk came up empty.
    return null;
  }

  vlog(found === null ? 'app walk: no app in' : 'app walk: found app after', hops, 'hops');
  bundleForPid.set(pid, found);
  return found;
}

async function defaultExec(bin: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run(bin, [...args], {
    timeout: EXEC_TIMEOUT_MS,
    maxBuffer: EXEC_MAX_BUFFER
  });
  return stdout;
}

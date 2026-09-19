/**
 * Raising the application a waiting session belongs to.
 *
 * The owner petted the dog while a `?` was on screen: he has answered "yes, I
 * mean that one", and the useful thing to do next is put that terminal in
 * front of him. `core/raise.ts` explains why finding it means walking the
 * process tree; this is the half that actually runs `ps` and `open`.
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
export const OPEN_BIN = '/usr/bin/open';

/**
 * How far up the tree to look.
 *
 * ponytail: a terminal is 2–4 hops above the CLI on this machine (node → login
 * shell → terminal), and a tmux or a `script` wrapper adds one or two more. 12
 * is a bound, not a measurement — it exists so a tree we have misread cannot
 * turn one pet into an unbounded run of subprocesses. Ceiling: a session
 * buried deeper than twelve parents is simply not raised. Upgrade path: raise
 * the number, once a real setup is found that needs it.
 */
export const MAX_HOPS = 12;

/** Long enough for `ps` on a healthy machine, short enough not to hang a pet. */
const EXEC_TIMEOUT_MS = 2_000;
/** One `ps` line is under 200 bytes; this is the cap on a stdout gone wrong. */
const EXEC_MAX_BUFFER = 64 * 1024;

export interface RaiserDeps {
  /** Run a binary and hand back its stdout. Injected in tests. */
  readonly exec?: (bin: string, args: readonly string[]) => Promise<string>;
  readonly platform?: string;
  readonly maxHops?: number;
}

export interface Raiser {
  /** Walk up from `pid` and raise the first application bundle found. */
  raise(pid: number): Promise<boolean>;
}

async function defaultExec(bin: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run(bin, [...args], {
    timeout: EXEC_TIMEOUT_MS,
    maxBuffer: EXEC_MAX_BUFFER
  });
  return stdout;
}

export function createRaiser(deps: RaiserDeps): Raiser {
  const exec = deps.exec ?? defaultExec;
  const platform = deps.platform ?? process.platform;
  const maxHops = deps.maxHops ?? MAX_HOPS;

  return {
    async raise(pid: number): Promise<boolean> {
      // `open -a` and the `.app` bundle are macOS's, and so is `comm` holding a
      // full path. Nothing is run at all elsewhere — a wrong answer would be
      // worse than no answer, and there is no second implementation to fall to.
      if (platform !== 'darwin') return false;

      /** Every pid already asked about, so a tree that loops cannot spin. */
      const seen = new Set<number>();
      let current = pid;
      let hops = 0;

      try {
        while (hops < maxHops) {
          // pid 1 is launchd and pid 0 is the kernel: neither has an ancestor
          // and neither is in a bundle, so there is nothing above here.
          if (current <= 1 || seen.has(current)) break;
          seen.add(current);
          hops++;

          const hop = nextHop(await exec(PS_BIN, ['-o', 'ppid=,comm=', '-p', String(current)]));
          // The process exited between two hops, or `ps` said something we do
          // not understand. Either way the chain is broken here.
          if (hop === null) break;

          const bundle = appBundleFrom(hop.comm);
          if (bundle !== null) {
            await exec(OPEN_BIN, ['-a', bundle]);
            vlog('raise: found app after', hops, 'hops');
            return true;
          }
          current = hop.ppid;
        }
      } catch {
        // `ps` refused, the pid is not ours to inspect, `open` could not raise
        // it. A pet that raises nothing is a pet; it is not an error worth a
        // dialog, and the line below already says the walk came up empty.
      }

      vlog('raise: no app in', hops, 'hops');
      return false;
    }
  };
}

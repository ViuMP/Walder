/**
 * The disk and the clock behind `core/claude-sessions.ts`.
 *
 * One `readdir` of `~/.claude/sessions`, one read per `.json` file, one call to
 * the pure reducer, and one `onEvent` per transition it reports. Everything that
 * *decides* anything is in the core module; this file is the part that cannot be
 * pure.
 *
 * The shape is `fullscreen-watch.ts`'s, deliberately: injectable deps with real
 * defaults, `start`/`stop`, one `setInterval`. Two polling watchers in one main
 * process should not be two different ideas of what a polling watcher is.
 *
 * No `fs.watch`. It was the obvious thing and it is the wrong thing here: the
 * directory holds a handful of files, a status flip is one small write, and
 * `fs.watch` on macOS would hand us a burst of events per write that we would
 * then debounce back into the 2 s cadence we already have. A readdir is cheaper
 * than the watcher it would replace.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  parseSessionRecord,
  reduceSessions,
  type SessionMap,
  type SessionRecord
} from '../core/claude-sessions';
import { claudeSettingsPath } from './claude-hooks';
import type { HookEvent } from './hook-server';

/**
 * How often the registry is swept.
 *
 * Two seconds, the same cadence as the fullscreen watch — and for the same
 * reason: it is the slowest rate at which a mascot still reads as reacting to
 * what the owner just did. The cost is one `readdir` of a directory with a
 * handful of entries plus a read of each half-kilobyte file, which is nothing
 * beside the probe that already runs on this clock.
 */
export const SESSIONS_POLL_MS = 2_000;

export interface ClaudeSessionsDeps {
  /** Fed straight to `behaviour.onHook`. */
  readonly onEvent: (event: HookEvent) => void;
  /** The registry directory. Defaults to `~/.claude/sessions`. */
  readonly dir?: string;
  readonly readDir?: (dir: string) => string[];
  readonly readFile?: (path: string) => string;
  readonly isAlive?: (pid: number) => boolean;
  readonly intervalMs?: number;
}

export interface ClaudeSessions {
  start(): void;
  stop(): void;
  /** Sweep once now, rather than waiting for the next tick. For the tests. */
  sweepNow(): void;
}

/**
 * Is that pid a live process?
 *
 * Signal 0 is the standard "check, do not send": `ESRCH` is no such process,
 * and `EPERM` is a process that exists but belongs to somebody else — which is
 * still alive, and the answer we want. Any other error is treated as dead,
 * because the question is "may Walder announce this session" and the honest
 * answer to "we could not tell" is no.
 *
 * Untested, deliberately: the three lines below are entirely about the real
 * kernel, and a test of them would be a test of a mock of `process.kill`. The
 * same argument `index.ts` makes for `offerHooksOnFirstLaunch`.
 */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function createClaudeSessions(deps: ClaudeSessionsDeps): ClaudeSessions {
  // `~/.claude/sessions`, derived from the settings path so that the one place
  // that knows where `~/.claude` is stays `claude-hooks.ts`.
  const dir = deps.dir ?? join(dirname(claudeSettingsPath()), 'sessions');
  const readDir = deps.readDir ?? ((at: string): string[] => readdirSync(at, 'utf8'));
  const readFile = deps.readFile ?? ((path: string): string => readFileSync(path, 'utf8'));
  const isAlive = deps.isAlive ?? pidIsAlive;
  const intervalMs = deps.intervalMs ?? SESSIONS_POLL_MS;

  let previous: SessionMap = new Map();
  let timer: ReturnType<typeof setInterval> | null = null;

  function sweep(): void {
    let names: string[];
    try {
      names = readDir(dir);
    } catch {
      // Silently, like `local-tokens.ts`: a home with no `~/.claude/sessions`
      // is a machine that does not run Claude Code, which is an ordinary state
      // of affairs and not a problem to report.
      return;
    }

    const records: SessionRecord[] = [];
    for (const name of names) {
      // The directory also holds a `<pid>.<hex>.key` sibling per session, which
      // is not JSON and is none of our business.
      if (!name.endsWith('.json')) continue;
      let text: string;
      try {
        text = readFile(join(dir, name));
      } catch {
        // A file being written as we read it, or one that vanished between the
        // readdir and here. No warn set: it is re-read in two seconds, and a
        // log line per sweep would be a log line per two seconds forever.
        continue;
      }
      const record = parseSessionRecord(text);
      if (record !== null) records.push(record);
    }

    const { next, events } = reduceSessions(previous, records, isAlive);
    previous = next;
    for (const kind of events) deps.onEvent({ kind, source: 'claude' });
  }

  return {
    start(): void {
      if (timer !== null) return;
      // Immediately, so the seed pass happens at launch rather than two seconds
      // into it — the sooner the map knows what is already open, the sooner a
      // real transition can be told apart from a first sighting.
      sweep();
      timer = setInterval(sweep, intervalMs);
    },

    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },

    sweepNow(): void {
      sweep();
    }
  };
}

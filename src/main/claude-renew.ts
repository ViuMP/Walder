/**
 * Nudging Claude Code into renewing its own login.
 *
 * `core/claude-renew.ts` decides *whether*; this is the half that cannot be
 * pure — finding the CLI, starting it, killing it if it hangs, and looking
 * afterwards to see whether the credential moved.
 *
 * **When it fires at all.** `claude-web` is first in the Claude chain
 * (`provider-chains.ts`, reversed 2026-09-10) and `resolveService` returns at
 * the first provider that answers `ok`, so `claude-oauth.fetch()` — and
 * therefore `observe` — runs only when the browser session is absent, expired
 * or failing. An owner with a healthy claude.ai login never spawns anything;
 * this exists for the machine where the CLI token *is* the only source, which
 * is exactly the machine where it lapsing overnight is a real problem.
 *
 * **The arguments.** `-p` with an empty prompt, `--no-session-persistence` so
 * nothing is written to the session registry, `--strict-mcp-config` so no MCP
 * server in the owner's config is started for a run that will do nothing.
 * `--bare` looks like the obvious flag here and is precisely wrong: its own
 * help says OAuth and the keychain are never read, so the CLI would exit
 * without ever touching the credential we are asking it to renew.
 *
 * **Walder never touches the token.** Not the access token, not the refresh
 * token, not the keychain item. The child is a separate process holding its own
 * credential; all Walder does is start it, and afterwards read the same expiry
 * it reads on every poll to see whether the number changed. Nothing here logs a
 * value, an expiry or a token — only shapes and verdicts.
 *
 * ponytail: the CLI is resolved once at startup from a fixed candidate list.
 * On this Mac (2026-09-19) `claude` is not on PATH and none of the four usual
 * install paths exist — the only CLI present is the desktop app's bundle at
 * `~/Library/Application Support/Claude/claude-code/<version>/claude.app/…`,
 * and whether *that* binary shares the `Claude Code-credentials` keychain item
 * is unverified. Ceiling: on a machine where it does not, every attempt is a
 * silent "no change" and the owner is no worse off than before this existed.
 * Upgrade path: the owner runs it once by hand and confirms the keychain item's
 * modification date moves; if it does not, drop the bundle candidates and let
 * `binary === null` turn renewal off where there is no real CLI.
 *
 * ponytail: no setting and no checkbox. Renewal is on whenever a CLI is found,
 * because the alternative to a renewal is a card that reads `auth-needed` all
 * day, and an owner who wanted that would not have installed a usage mascot.
 * Ceiling: someone who objects to Walder starting a process at all has no way
 * to say so. Upgrade path: one `renewClaudeToken` key in `store.ts` and one
 * checkbox beside "Sleep during fullscreen video" in `tray.ts`, read here.
 *
 * To verify live, once: Walder installs Stop/Notification/UserPromptSubmit
 * hooks into `~/.claude/settings.json` (`claude-hooks.ts`), and an empty `-p`
 * should exit before a turn begins, so none of them should fire. If one does —
 * a spurious bubble every few hours is how it would show up — add
 * `--setting-sources project,local` to `RENEW_ARGS`, which keeps the CLI from
 * reading the user settings file the hooks live in.
 */
import { spawn as spawnChild } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { compareSemver, parseSemver, type Semver } from '../core/semver';
import { shouldRenew, type RenewVerdict } from '../core/claude-renew';
import { readClaudeCodeCredentials } from '../providers/credentials';
import { info, vlog } from './log';

/**
 * How long the child may run before it is asked to stop.
 *
 * An empty prompt is a launch, a credential check and an exit — a second or
 * two. Thirty is not a budget, it is the point past which the process is stuck
 * on something (a network stall, a prompt on stdin we did not anticipate) and
 * is never going to finish.
 */
export const RENEW_KILL_MS = 30_000;

/** How long SIGTERM gets before SIGKILL. Enough for an orderly exit, no more. */
export const RENEW_SIGKILL_GRACE_MS = 5_000;

/** See the `--bare` note in the module header for the flag that is *not* here. */
export const RENEW_ARGS: readonly string[] = [
  '-p',
  '--no-session-persistence',
  '--strict-mcp-config'
];

/** The slice of `ChildProcess` this module uses. Injected in tests. */
export interface RenewChild {
  readonly pid: number | undefined;
  on(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): unknown;
}

export interface ClaudeRenewDeps {
  /** The CLI, or `null` when there is none and renewal is simply off. */
  readonly binary: string | null;
  /** The child's working directory. See `index.ts` for why it is what it is. */
  readonly scratchDir: string;
  readonly spawn?: (bin: string, args: readonly string[], cwd: string) => RenewChild;
  /** Re-read the credential's expiry after the child exits. Defaults to the real read. */
  readonly readExpiresAt?: () => Promise<number | null>;
  readonly now?: () => number;
}

export interface ClaudeRenew {
  /** Called with every expiry `claude-oauth` reads. Cheap, and usually a no-op. */
  observe(expiresAt: number | null): void;
  /** Is that pid the renewal child (live, or the one that just exited)? */
  ownsPid(pid: number): boolean;
  stop(): void;
}

/**
 * The renewal child's cwd should be somewhere that tells the CLI nothing.
 *
 * `child_process.spawn` with an argv array, never a shell string: there is no
 * quoting to get wrong and nothing the environment can inject. Every fd is
 * `'ignore'`, and the one on **stdin** is load-bearing rather than tidiness —
 * an ignored stdin is `/dev/null`, which hands the CLI an immediate EOF, which
 * is what makes `-p` an *empty* prompt rather than a process waiting forever
 * for one.
 */
function defaultSpawn(bin: string, args: readonly string[], cwd: string): RenewChild {
  return spawnChild(bin, [...args], {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: process.env,
    windowsHide: true
  }) as unknown as RenewChild;
}

async function defaultReadExpiresAt(): Promise<number | null> {
  const credentials = await readClaudeCodeCredentials();
  return credentials === null ? null : credentials.expiresAt;
}

export function createClaudeRenew(deps: ClaudeRenewDeps): ClaudeRenew {
  const spawn = deps.spawn ?? defaultSpawn;
  const readExpiresAt = deps.readExpiresAt ?? defaultReadExpiresAt;
  const now = deps.now ?? ((): number => Date.now());

  let attemptedFor: number | null = null;
  let lastAttemptAt: number | null = null;
  /** The last verdict logged, so a refusal is one line and not one per poll. */
  let lastVerdict: RenewVerdict | null = null;
  /** Said once, not once per poll, when there is no CLI to start. */
  let saidNoBinary = false;
  /**
   * Set by an `error` event and never cleared: a binary that could not be
   * executed once (ENOENT because it was upgraded out from under us, EACCES
   * because it is not runnable) will not become runnable by being tried again
   * every few hours.
   */
  let disabled = false;
  /** The running child, or `null`. Held so `stop()` can signal it directly. */
  let liveChild: RenewChild | null = null;
  let livePid: number | null = null;
  /**
   * Kept after the child exits, because `claude-sessions.ts` sweeps on its own
   * 2 s clock and can see the session file a fraction of a second after the
   * process it describes has gone.
   */
  let lastPid: number | null = null;
  let termTimer: ReturnType<typeof setTimeout> | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimers(): void {
    if (termTimer !== null) clearTimeout(termTimer);
    if (killTimer !== null) clearTimeout(killTimer);
    termTimer = null;
    killTimer = null;
  }

  /**
   * Did the credential move?
   *
   * The exit code is deliberately never consulted. The CLI exits non-zero for
   * an empty prompt — there was nothing to answer — *and* renews the credential
   * on the way, so the status would say "failed" about the run that worked. The
   * only honest evidence is the expiry itself, read the same way every poll
   * reads it. A read that rejects is "no change", never a throw: this runs off
   * an event listener with nobody to catch it.
   */
  async function verify(before: number | null): Promise<void> {
    let after: number | null = null;
    try {
      after = await readExpiresAt();
    } catch {
      after = null;
    }
    const moved = after !== null && before !== null && after > before;
    info(`claude token renewal: ${moved ? 'renewed' : 'no change'}`);
  }

  return {
    observe(expiresAt: number | null): void {
      const verdict = shouldRenew(expiresAt, { attemptedFor, lastAttemptAt }, now());
      if (verdict !== 'renew') {
        // Only on a change: `observe` runs on every poll, and four of the five
        // verdicts are the ordinary state of a healthy machine.
        if (verdict !== lastVerdict) vlog('claude renewal:', verdict);
        lastVerdict = verdict;
        return;
      }
      lastVerdict = verdict;

      // Before anything that can fail, quit or throw. Whatever happens next,
      // this expiry has had its one attempt — that is what stops a broken
      // renewal from spawning a process on every poll forever.
      attemptedFor = expiresAt;
      lastAttemptAt = now();

      if (deps.binary === null) {
        if (!saidNoBinary) vlog('claude renewal: no claude binary found; renewal off');
        saidNoBinary = true;
        return;
      }
      if (disabled) return;

      const child = spawn(deps.binary, RENEW_ARGS, deps.scratchDir);
      liveChild = child;
      livePid = child.pid ?? null;
      if (livePid !== null) lastPid = livePid;

      termTimer = setTimeout(() => child.kill(), RENEW_KILL_MS);
      killTimer = setTimeout(
        () => child.kill('SIGKILL'),
        RENEW_KILL_MS + RENEW_SIGKILL_GRACE_MS
      );

      child.on('exit', () => {
        clearTimers();
        if (livePid !== null) lastPid = livePid;
        liveChild = null;
        livePid = null;
        void verify(expiresAt);
      });

      child.on('error', (error: unknown) => {
        clearTimers();
        liveChild = null;
        livePid = null;
        disabled = true;
        vlog('claude renewal: the CLI could not be started; renewal off —', error);
      });
    },

    ownsPid(pid: number): boolean {
      return pid === livePid || pid === lastPid;
    },

    stop(): void {
      clearTimers();
      const child = liveChild;
      if (child === null) return;
      liveChild = null;
      if (livePid !== null) lastPid = livePid;
      livePid = null;
      try {
        child.kill();
      } catch {
        // Already gone between the last event and this signal. Nothing to do.
      }
    }
  };
}

/**
 * Every place a `claude` CLI might be, best first.
 *
 * PATH first, because an owner who installed it deliberately put it there.
 * Relative PATH entries are dropped outright: a relative entry resolves against
 * whatever the cwd happens to be, and "run whatever `./claude` is in the
 * current directory" is the shape of a very old class of bug.
 *
 * Then the four paths the installers use, then — on macOS only — the CLI that
 * ships inside the desktop app, newest version first. That last group is the
 * only one that exists on this machine (2026-09-19); see the module header for
 * what is unverified about it.
 */
export function claudeBinaryCandidates(
  platform: string,
  home: string,
  pathVar: string | undefined,
  listDir: (dir: string) => string[] = (dir) => {
    try {
      return readdirSync(dir, 'utf8');
    } catch {
      // No desktop app, or a home we cannot read. An ordinary state, not news.
      return [];
    }
  }
): string[] {
  const names = platform === 'win32' ? ['claude', 'claude.cmd', 'claude.exe'] : ['claude'];
  const out: string[] = [];

  for (const entry of (pathVar ?? '').split(delimiter)) {
    if (entry.length === 0 || !isAbsolute(entry)) continue;
    for (const name of names) out.push(join(entry, name));
  }

  out.push(
    join(home, '.claude', 'local', 'claude'),
    join('/opt', 'homebrew', 'bin', 'claude'),
    join('/usr', 'local', 'bin', 'claude'),
    join(home, '.local', 'bin', 'claude')
  );

  if (platform === 'darwin') {
    const root = join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
    // A name that is not a version is not a version directory — `Cache`, a
    // stray `.DS_Store`, whatever the app puts there next. Skipped, not guessed.
    const versions: Array<{ name: string; semver: Semver }> = [];
    for (const name of listDir(root)) {
      const semver = parseSemver(name);
      if (semver !== null) versions.push({ name, semver });
    }
    versions.sort((a, b) => compareSemver(b.semver, a.semver));
    for (const version of versions) {
      out.push(join(root, version.name, 'claude.app', 'Contents', 'MacOS', 'claude'));
    }
  }

  return out;
}

/**
 * The first candidate that exists, or `null` for "no CLI, renewal off".
 *
 * Resolved once at startup and never per attempt: the answer does not change
 * while the app runs, and a `stat` of a dozen paths every few hours to learn
 * the same thing is the kind of idle work this project measures.
 */
export function findClaudeBinary(
  exists: (path: string) => boolean = existsSync
): string | null {
  const candidates = claudeBinaryCandidates(process.platform, homedir(), process.env['PATH']);
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

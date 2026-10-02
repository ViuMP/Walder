/**
 * Installing (and removing) Walder's hooks in `~/.claude/settings.json`.
 *
 * Claude Code's hook schema, which this file must match exactly:
 *
 * ```json
 * { "hooks": { "Stop": [ { "matcher": "…", "hooks": [
 *     { "type": "command", "command": "…", "timeout": 2 } ] } ] } }
 * ```
 *
 * `hooks.<Event>` is an array of *matcher groups*, each holding its own array of
 * hooks. `matcher` filters by tool name, and every event we subscribe to gets a
 * group with **no** matcher — for the three lifecycle events because a matcher
 * means nothing there, and for `PostToolUse` (0.2.7), which *is* a tool event,
 * because Walder wants it for every tool: the fact it carries is "a command the
 * owner approved has run", and which command that was is none of his business.
 *
 * Two rules govern everything here, because this file belongs to the owner's
 * Claude Code install and not to us:
 *
 *  1. **Never lose a setting.** The file is parsed, modified and re-stringified
 *     with two-space indent; unknown keys, other people's hooks and other
 *     events are carried through untouched. A timestamped backup is written
 *     before the first change.
 *  2. **Idempotent, and keyed by a marker.** Our hook is recognised by the
 *     string `walder-hook` inside its command (a trailing shell comment), so
 *     running the installer twice updates one entry instead of stacking two,
 *     and `--remove` can find exactly what to take out.
 *
 * Electron-free (plain `node:fs`), so it runs identically from the tray and from
 * `npm run install-hooks`.
 */
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The string that identifies our hook inside a command line. */
export const HOOK_MARKER = 'walder-hook';

/**
 * The four Claude Code events Walder listens for.
 *
 * `PostToolUse` joined the three lifecycle events in 0.2.7 and is the only tool
 * event here: approving a command in Claude Code is not a prompt, so without it
 * nothing tells Walder the owner has unblocked a session that was waiting. See
 * `HookKind`'s `resume`.
 *
 * **A file holding only the older three still counts as installed** —
 * `hookPortIn` answers with the first marked command it finds across this list,
 * and `Stop` carries one in both shapes. Reinstalling is what writes the
 * fourth; nothing nags about it.
 */
export const HOOK_EVENTS: readonly string[] = [
  'Stop',
  'Notification',
  'UserPromptSubmit',
  'PostToolUse'
];

/** Seconds Claude Code will wait for the hook command. */
export const HOOK_TIMEOUT_S = 2;

/** `~/.claude/settings.json`. */
export function claudeSettingsPath(home: string = homedir()): string {
  return join(home, '.claude', 'settings.json');
}

/* ------------------------------------------------------- the port to install */

/** The fallback port. Must match `DEFAULTS.hookPort` in `src/main/store.ts`. */
export const DEFAULT_HOOK_PORT = 47_811;

/**
 * Where `electron-store` keeps Walder's settings file, per platform.
 *
 * Reimplemented rather than read through `electron-store` on purpose: this has
 * to work from `npm run install-hooks`, a plain `tsx` process with no Electron
 * app object at all, and `app.getPath('userData')` is the only thing the real
 * store uses that a script cannot have. The three paths are Electron's own
 * `userData` locations for an app named `walder`, plus the store's `name`
 * option (`walder`) as the file name — see `createStore`.
 *
 * If Electron ever changes those locations this silently reads nothing and the
 * installer falls back to the default port, which is also what happens before
 * Walder has ever run. That is the right failure: a port that is probably right
 * beats refusing to install.
 */
export function walderStorePath(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): string {
  const file = 'walder.json';
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'walder', file);
  }
  if (platform === 'win32') {
    const appData = env['APPDATA'];
    const base =
      appData !== undefined && appData !== ''
        ? appData
        : join(home, 'AppData', 'Roaming');
    return join(base, 'walder', file);
  }
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg !== undefined && xdg !== '' ? xdg : join(home, '.config');
  return join(base, 'walder', file);
}

/** A port the hook server could actually have bound. */
function validPort(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 1024 || value > 65_535) return null;
  return value;
}

/**
 * The port to write into the hook command, read from Walder's own settings file.
 *
 * `hookPortActual` first: that is the port the listener really bound, which is
 * `hookPort + 1` or `+ 2` whenever the preferred one was taken — and a hook
 * pointing at the preferred-but-unbound port is a hook that silently does
 * nothing. `hookPort` is the owner's preference, used when the app has not yet
 * bound anything. `DEFAULT_HOOK_PORT` covers a first run with no settings file.
 *
 * Every failure — no file, unreadable file, invalid JSON, out-of-range numbers —
 * lands on the next fallback rather than raising: the installer's job is to
 * write a hook, and it should still manage that on a machine where Walder has
 * never started.
 */
export async function resolveHookPort(storePath?: string): Promise<number> {
  const path = storePath ?? walderStorePath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return DEFAULT_HOOK_PORT;
  }
  if (!isRecord(parsed)) return DEFAULT_HOOK_PORT;
  return (
    validPort(parsed['hookPortActual']) ??
    validPort(parsed['hookPort']) ??
    DEFAULT_HOOK_PORT
  );
}

/**
 * One extra request header for the hook command to set — `X-Walder-Source:
 * codex`, and nothing else so far.
 */
export interface HookHeader {
  readonly name: string;
  readonly value: string;
}

/**
 * The command Claude Code runs, per platform.
 *
 * `--data-binary @-` forwards the hook's own stdin (the event JSON) verbatim;
 * `-m 1` and `TimeoutSec 1` keep the hook from ever delaying Claude Code; and
 * both variants swallow every failure, because Walder not running must never
 * make the owner's session fail a hook. The trailing comment is the marker.
 *
 * **The Windows variant contains no `$`.** It used to read stdin into `$b` and
 * pass `-Body $b`, which breaks the moment anything POSIX-shaped gets between
 * Claude Code and PowerShell — a Git-Bash `sh -c`, an MSYS wrapper, a WSL
 * session, or any layer that expands the string before `powershell` sees it.
 * `$b` is then substituted with nothing and the hook posts an empty body, which
 * the server answers 400 and the `catch {}` silently swallows: a hook that looks
 * installed and does nothing, on the one platform we cannot test from here. So
 * the read is inlined as `-Body ([Console]::In.ReadToEnd())` — one expression, no
 * variable, nothing for a shell to expand. `#` starts a comment in PowerShell as
 * well as in `sh`, so the marker is inert either way.
 *
 * **Swallowing the failure is not the same as exiting 0, so the Windows variant
 * says `exit 0` out loud.** "Never fail a hook" is two promises: print nothing,
 * and exit 0 — Claude Code reads a non-zero exit as a failed hook and says so in
 * its transcript. The POSIX variant keeps both through `|| true`. The Windows one
 * used to end at `catch {}`, and Windows QA row 7.8 measured it with Walder quit:
 * exit code 1, about 1.3 s, no output — the same through cmd.exe, PowerShell and
 * Git Bash. `powershell -Command` exits with 1 whenever the last statement's `$?`
 * is false, and a `try` whose body threw leaves it false even though the empty
 * `catch` handled the error. So every hook failed for as long as Walder was not
 * running. The trailing `; exit 0` (verified on the same machine to exit 0) sits
 * after the `catch`, where it runs whether or not the post went through, and
 * before the marker comment, which stays last so the detector's `includes` and
 * the port regex read the command exactly as before. An install that predates
 * it carries the old string under the same marker, and the merge already
 * rewrites a marked entry whose command differs — so the next Install upgrades
 * it in place.
 *
 * **`header` is how the Codex twin shares this builder.** Codex's hooks post the
 * same body to the same listener, and the only way the server can tell the two
 * tools apart is a header of ours on the request line (`SOURCE_HEADER` in
 * `hook-server.ts`) — the body belongs to the tool and is piped through
 * verbatim. Passed in rather than decided here so there is one command builder
 * and not two that can drift apart on the Windows variant nobody can test.
 */
export function hookCommand(
  port: number,
  platform: NodeJS.Platform = process.platform,
  header?: HookHeader
): string {
  const url = `http://127.0.0.1:${port}/event`;
  if (platform === 'win32') {
    // A single-entry hashtable, and still `$`-free: the value is a literal.
    const extra = header === undefined ? '' : `-Headers @{'${header.name}'='${header.value}'} `;
    // `; exit 0` after the catch: see "Swallowing the failure" above.
    return (
      `powershell -NoProfile -Command "try { Invoke-RestMethod -Uri ${url} -Method Post ` +
      `-ContentType 'application/json' ${extra}-Body ([Console]::In.ReadToEnd()) -TimeoutSec 1 ` +
      `| Out-Null } catch {}; exit 0 # ${HOOK_MARKER}"`
    );
  }
  const extra = header === undefined ? '' : `-H '${header.name}: ${header.value}' `;
  return (
    `curl -s -m 1 -X POST -H 'Content-Type: application/json' ${extra}--data-binary @- ` +
    `${url} >/dev/null 2>&1 || true # ${HOOK_MARKER}`
  );
}

/* ------------------------------------------------------------------- shapes */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is this hook entry ours? The marker test, and the only definition of it.
 *
 * Module-private, and that is enough: the Codex installer reads a different
 * file by the same rule, but it does so by *calling* `applyHooks` and
 * `hookPortIn` here rather than by re-implementing the walk — so this test has
 * exactly one caller-of-callers and never had a second copy to drift from.
 */
function isOurHook(hook: unknown): boolean {
  return isRecord(hook) && typeof hook['command'] === 'string' && hook['command'].includes(HOOK_MARKER);
}

/** The port out of one of our hook commands, or `null` if it is unreadable. */
function portInCommand(command: string): number | null {
  const match = /127\.0\.0\.1:(\d+)\/event/u.exec(command);
  return match === undefined || match === null ? null : validPort(Number(match[1]));
}

/**
 * The port the installed hooks actually post to, given an already-parsed
 * settings object — `null` when none of `events` carries a hook of ours.
 *
 * Split from `installedHookPort` for the Codex twin: the *shape* (matcher
 * groups holding hook entries) is identical in `~/.codex/hooks.json`, only the
 * file and the event names differ.
 *
 * The first marked command wins. Walder writes the same port into every one, so
 * a disagreement between them means the file was hand-edited — and the honest
 * answer to "which port are the hooks on" is then whichever one is found first
 * rather than a refusal the caller has no way to act on.
 */
export function hookPortIn(
  settings: unknown,
  events: readonly string[] = HOOK_EVENTS
): number | null {
  if (!isRecord(settings)) return null;
  const hooksRoot = settings['hooks'];
  if (!isRecord(hooksRoot)) return null;

  for (const event of events) {
    const groups = hooksRoot[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups as unknown[]) {
      if (!isRecord(group) || !Array.isArray(group['hooks'])) continue;
      for (const hook of group['hooks'] as unknown[]) {
        if (!isOurHook(hook)) continue;
        const port = portInCommand((hook as { command: string }).command);
        if (port !== null) return port;
      }
    }
  }
  return null;
}

/**
 * Which port the hooks in `~/.claude/settings.json` are installed for, or
 * `null` when they are not installed at all.
 *
 * The question Walder could not answer before 0.2.5, and the reason the owner's
 * dog sat silent for days: the listener was up, the store said `47811`, and the
 * settings file held no Walder hook at all — a state with no symptom anywhere
 * in the app. Compared against the bound port at launch (`index.ts`) and read
 * again whenever the tray menu is built.
 *
 * **Synchronous, and never throws.** The tray builds its menu in one
 * synchronous pass, and every failure here — no file, no permission, invalid
 * JSON, a `hooks` key of some shape we do not know — means the same thing to
 * every caller: we cannot see a hook of ours. A missing file is the *normal*
 * case on a machine without Claude Code, so it is not even worth a log line.
 */
export function installedHookPort(settingsPath: string = claudeSettingsPath()): number | null {
  try {
    return hookPortIn(JSON.parse(readFileSync(settingsPath, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * `async: true` makes Claude Code fire the hook and move on instead of blocking
 * the prompt for up to `timeout` while a slow Walder answers. Claude-only: the
 * Codex path passes `false`, since `async` is not in the schema it targets.
 */
function ourHookEntry(command: string, async: boolean): Json {
  return async
    ? { type: 'command', command, timeout: HOOK_TIMEOUT_S, async: true }
    : { type: 'command', command, timeout: HOOK_TIMEOUT_S };
}

/** "a list", "null", "a string" — for a refusal message the owner can act on. */
function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return `a ${typeof value}`;
}

export interface MergeResult {
  /** A new settings object. The input is never mutated. */
  readonly settings: Json;
  readonly changed: boolean;
  /** Events whose hook was added or updated. */
  readonly touched: string[];
  /**
   * Set when the merge refused to proceed, with the reason in one sentence.
   * `changed` is then `false` and `settings` is the input, unaltered.
   */
  readonly refused?: string;
}

/**
 * Add (or refresh) Walder's hook for each of `HOOK_EVENTS`.
 *
 * A settings file that is not an object — missing, `null`, an array, a string —
 * is replaced by a fresh object rather than merged into: there is nothing to
 * preserve, and refusing would leave the owner with no way to install.
 *
 * But a file that *is* an object and holds a `hooks` key of the wrong shape is a
 * different case, and this **refuses** it. The earlier version coerced both
 * `hooks` and `hooks.<Event>` to their empty form (`isRecord(...) ? … : {}`,
 * `Array.isArray(...) ? … : []`), which silently discarded whatever was there —
 * a hand-edited `"hooks": "off"`, or a `"Stop": {…}` written against a schema we
 * do not know — and wrote the result back over the owner's file. Refusing costs
 * the owner one dialog telling them what to fix; coercing costs them a setting
 * they cannot get back. Same rule as the unparseable-JSON case in `applyHooks`.
 */
export function mergeHooks(
  settings: unknown,
  port: number,
  platform: NodeJS.Platform = process.platform
): MergeResult {
  return mergeHooksInto(settings, hookCommand(port, platform), HOOK_EVENTS, true);
}

/**
 * The merge itself, given a finished command and the events to put it under.
 *
 * Split from `mergeHooks` for `codex-hooks.ts`: `~/.codex/hooks.json` has the
 * *same* schema (matcher groups holding hook entries) and differs only in the
 * file, the event names and the header on the command — so the one thing that
 * must not be copied is this function, which is where "never lose a setting"
 * actually lives.
 */
export function mergeHooksInto(
  settings: unknown,
  command: string,
  events: readonly string[],
  async: boolean
): MergeResult {
  const root: Json = isRecord(settings) ? { ...settings } : {};

  const rawHooks = root['hooks'];
  if (rawHooks !== undefined && !isRecord(rawHooks)) {
    return {
      settings: root,
      changed: false,
      touched: [],
      refused:
        `"hooks" in that file is ${describeShape(rawHooks)}, not an object, ` +
        `so Walder could not add its hooks without discarding it.`
    };
  }

  const hooksRoot: Json = isRecord(rawHooks) ? { ...rawHooks } : {};

  for (const event of events) {
    const existing = hooksRoot[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      return {
        settings: root,
        changed: false,
        touched: [],
        refused:
          `"hooks.${event}" in that file is ${describeShape(existing)}, not a list of ` +
          `matcher groups, so Walder could not add its hook without discarding it.`
      };
    }
  }

  const touched: string[] = [];
  let changed = false;

  for (const event of events) {
    const existing = hooksRoot[event];
    const groups: unknown[] = Array.isArray(existing) ? [...existing] : [];

    // Find the group that already holds our hook, wherever it sits.
    let placed = false;
    for (let i = 0; i < groups.length && !placed; i++) {
      const group = groups[i];
      if (!isRecord(group) || !Array.isArray(group['hooks'])) continue;
      const hooks = [...(group['hooks'] as unknown[])];
      for (let j = 0; j < hooks.length; j++) {
        if (!isOurHook(hooks[j])) continue;
        const before = JSON.stringify(hooks[j]);
        const after = ourHookEntry(command, async);
        if (before !== JSON.stringify(after)) changed = true;
        hooks[j] = after;
        groups[i] = { ...group, hooks };
        placed = true;
        break;
      }
    }

    if (!placed) {
      // No matcher, for every event: none of the lifecycle events either tool
      // gives us (`Stop`, `Notification`/`PermissionRequest`,
      // `UserPromptSubmit`) is a tool event and so has nothing to filter, and
      // `PostToolUse` is one but wants them all — see the file header.
      groups.push({ hooks: [ourHookEntry(command, async)] });
      changed = true;
    }

    hooksRoot[event] = groups;
    touched.push(event);
  }

  root['hooks'] = hooksRoot;
  return { settings: root, changed, touched };
}

export interface RemoveResult {
  readonly settings: Json;
  readonly changed: boolean;
  /** Events a hook was removed from. */
  readonly touched: string[];
  /**
   * Never set by `removeHooks` — a removal reads every shape safely, leaving
   * what it does not understand alone. Declared so `applyHooks` can handle both
   * results through one field.
   */
  readonly refused?: string;
}

/**
 * Take Walder's hooks out again, leaving everything else exactly as it was —
 * including a group that holds somebody else's hook alongside ours, and an
 * event that carries other people's groups. A group or event left completely
 * empty is dropped, so uninstalling returns the file to its original shape
 * rather than leaving empty scaffolding behind.
 */
export function removeHooks(settings: unknown): RemoveResult {
  const root: Json = isRecord(settings) ? { ...settings } : {};
  if (!isRecord(root['hooks'])) return { settings: root, changed: false, touched: [] };

  const hooksRoot: Json = { ...root['hooks'] };
  const touched: string[] = [];
  let changed = false;

  for (const [event, value] of Object.entries(hooksRoot)) {
    if (!Array.isArray(value)) continue;
    const groups: unknown[] = [];
    let hit = false;

    for (const group of value as unknown[]) {
      if (!isRecord(group) || !Array.isArray(group['hooks'])) {
        groups.push(group);
        continue;
      }
      const kept = (group['hooks'] as unknown[]).filter((hook) => !isOurHook(hook));
      if (kept.length !== (group['hooks'] as unknown[]).length) hit = true;
      if (kept.length > 0) groups.push({ ...group, hooks: kept });
    }

    if (!hit) continue;
    changed = true;
    touched.push(event);
    if (groups.length > 0) hooksRoot[event] = groups;
    else delete hooksRoot[event];
  }

  if (Object.keys(hooksRoot).length > 0) root['hooks'] = hooksRoot;
  else delete root['hooks'];

  return { settings: root, changed, touched };
}

/* ------------------------------------------------------------------ file I/O */

export interface InstallOptions {
  readonly port: number;
  readonly settingsPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly remove?: boolean;
  /**
   * The three fields `codex-hooks.ts` varies, and the reason `applyHooks` is one
   * function rather than two: the file I/O below — temp file, dated backup,
   * atomic rename, and every refusal that stops short of touching the owner's
   * file — is the part that must never exist in two copies.
   *
   * `events` defaults to Claude Code's four (`HOOK_EVENTS`), `header` to none,
   * and `toolName` to the tool those defaults describe.
   */
  readonly events?: readonly string[];
  readonly header?: HookHeader;
  /** How the summary names the tool that will run the hooks. */
  readonly toolName?: string;
  /** Write `async: true` on each entry. Defaults to `true` (Claude Code); Codex passes `false`. */
  readonly async?: boolean;
  /**
   * The rename and the wait between its retries, swapped out by the test suite
   * so the Windows retry in `renameWithRetry` can be driven without a real
   * sharing violation and without sleeping for real. Production never passes
   * it; either half left out falls back to the real one.
   */
  readonly io?: Partial<RenameIo>;
}

export interface InstallOutcome {
  readonly path: string;
  readonly changed: boolean;
  readonly touched: string[];
  readonly backupPath: string | null;
  /** One or two plain sentences, for the tray dialog or the console. */
  readonly summary: string;
}

/** `settings.json.walder-backup-2026-09-08T18-40-00-000Z`. */
function backupNameFor(path: string, at: Date): string {
  return `${path}.walder-backup-${at.toISOString().replace(/[:.]/gu, '-')}`;
}

/** `settings.json.walder-tmp-4711` — same directory, so the rename is atomic. */
function tempNameFor(path: string): string {
  return `${path}.walder-tmp-${process.pid}`;
}

/* ------------------------------------------------- the rename, and its retry */

/**
 * The error codes a rename onto `settings.json` can fail with *for a moment*
 * on Windows, and only those.
 *
 * Windows QA row 7.1 (2026-10-02): one Install out of three failed with
 * `EPERM: operation not permitted, rename '…settings.json.walder-tmp-7164' ->
 * '…settings.json'` while the owner's Claude Code was running, and the same
 * click a few seconds later succeeded. The cause is Windows file sharing, not
 * a permission: replacing a file by rename fails while another process holds
 * it open without delete sharing, and Claude Code watches and re-reads this
 * file (it had re-read it after the Remove 17 s earlier), as do editors, the
 * search indexer and antivirus scanners. Node reports that sharing violation
 * as `EPERM`, `EBUSY` or `EACCES` depending on which call lost the race, and
 * those handles are held for milliseconds. Removal (row 7.9) goes through the
 * same rename and the same race, and so does the Codex installer, which calls
 * `applyHooks` rather than copying it.
 *
 * Everything else — `ENOENT` (the temp file is gone), `EXDEV`, `ENOSPC`,
 * `EINVAL` — is a real failure that waiting cannot fix, and is thrown on the
 * first attempt exactly as before. On macOS and Linux these three codes mean
 * a genuine permission problem and the retry only delays the same honest error
 * by half a second: not worth a platform branch that the tests (which run on
 * every host) would then have to fake.
 */
export const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * How many times the final rename is tried in all, the first attempt included.
 *
 * Five, with `RENAME_RETRY_STEP_MS`, waits 50 + 100 + 150 + 200 = 500 ms before
 * giving up: comfortably longer than a watcher's re-read or an indexer's peek
 * (milliseconds), and still short enough that the owner, who just clicked a
 * tray item and is waiting for the result box, does not notice it. A lock held
 * longer than that is not a race but an editor or a stuck process holding the
 * file, and the honest failure box ("Nothing was changed") is the right answer
 * to it — the owner closes the other program and clicks again.
 */
export const RENAME_ATTEMPTS = 5;

/**
 * The wait before retry *n* is `n × RENAME_RETRY_STEP_MS` — 50, 100, 150, 200 ms.
 *
 * Growing rather than fixed, so a lock released almost at once costs only the
 * first short wait while a slower one (an antivirus scan of the file Claude
 * Code just re-read) still gets the longer later waits. Linear rather than
 * doubling, because four doublings from a useful first step overshoot the
 * half-second budget above.
 */
export const RENAME_RETRY_STEP_MS = 50;

/** The two operations `renameWithRetry` needs — the real ones unless a test says otherwise. */
export interface RenameIo {
  rename(from: string, to: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

const REAL_RENAME_IO: RenameIo = {
  rename,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

function isTransientRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && TRANSIENT_RENAME_CODES.has(code);
}

/**
 * `rename(from, to)`, retried on a Windows sharing violation.
 *
 * **Still only a rename.** Each attempt is the same atomic `rename`, so the
 * write-order guarantee in `applyHooks` holds on every try: the owner's file is
 * either the old one or the new one, never part of each. There is deliberately
 * no copy-over-the-original fallback for when the retries run out — a copy
 * that is interrupted (or loses the same race halfway) is exactly the
 * half-written `settings.json` the temp file exists to prevent, and a Claude
 * Code that cannot parse its own settings is far worse than an Install that
 * says it did nothing.
 *
 * The error thrown after the last attempt is that attempt's own, untouched, so
 * the caller's log line and its failure box read exactly as they did before
 * the retry existed.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  io: Partial<RenameIo> = {}
): Promise<void> {
  const doRename = io.rename ?? REAL_RENAME_IO.rename;
  const sleep = io.sleep ?? REAL_RENAME_IO.sleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await doRename(from, to);
      return;
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !isTransientRenameError(error)) throw error;
      await sleep(RENAME_RETRY_STEP_MS * attempt);
    }
  }
}

/**
 * Read, merge (or strip), back up and write.
 *
 * The backup is written whenever the file exists and we are about to change it —
 * cheap insurance on a file we do not own, and the timestamp means repeated runs
 * never overwrite an earlier one.
 *
 * **Write order.** The new contents go to a temp file in the same directory
 * first, then the backup is written, then the temp file is `rename`d over the
 * original. The rename is the only step that touches the owner's file and it is
 * atomic, so there is no window in which `settings.json` is half-written: either
 * the old file is there or the new one is. And if the rename fails anyway (a
 * permission change, a full disk), the backup is deleted again — a backup left
 * beside a file that was never modified is just a confusing extra file, and the
 * earlier version could leave exactly that.
 *
 * **The rename is retried; nothing else is.** Only the rename replaces a file
 * other programs have open, so only it can lose a Windows sharing race (QA row
 * 7.1) — see `renameWithRetry`. The temp file and the backup are both *new*
 * names (the backup's carries the millisecond), which no other process has open
 * or even knows about yet, so a failure creating either is a real one and stops
 * the run at once, as before.
 */
export async function applyHooks(opts: InstallOptions): Promise<InstallOutcome> {
  const path = opts.settingsPath ?? claudeSettingsPath();
  const platform = opts.platform ?? process.platform;

  let original: string | null = null;
  try {
    original = await readFile(path, 'utf8');
  } catch {
    original = null;
  }

  let parsed: unknown = {};
  if (original !== null) {
    try {
      parsed = JSON.parse(original);
    } catch {
      // A settings file we cannot parse must not be rewritten from scratch: that
      // would silently delete everything in it.
      return {
        path,
        changed: false,
        touched: [],
        backupPath: null,
        summary:
          `Could not read ${path} — it is not valid JSON, so nothing was changed. ` +
          `Fix or move that file and try again.`
      };
    }
  }

  const result =
    opts.remove === true
      ? removeHooks(parsed)
      : mergeHooksInto(
          parsed,
          hookCommand(opts.port, platform, opts.header),
          opts.events ?? HOOK_EVENTS,
          opts.async ?? true
        );

  if (result.refused !== undefined) {
    return {
      path,
      changed: false,
      touched: [],
      backupPath: null,
      summary:
        `${result.refused} Nothing was changed in ${path}. ` +
        `Fix that entry (or move the file aside) and try again.`
    };
  }

  if (!result.changed) {
    return {
      path,
      changed: false,
      touched: result.touched,
      backupPath: null,
      summary:
        opts.remove === true
          ? `Nothing to remove: ${path} has no Walder hooks.`
          : `Already installed: ${path} is up to date.`
    };
  }

  await mkdir(dirname(path), { recursive: true });

  // 1. The new contents, to a temp file beside the target.
  const tempPath = tempNameFor(path);
  await writeFile(tempPath, `${JSON.stringify(result.settings, null, 2)}\n`, 'utf8');

  // 2. The backup, but only when there is something to back up.
  let backupPath: string | null = null;
  if (original !== null) {
    backupPath = backupNameFor(path, new Date());
    try {
      await writeFile(backupPath, original, 'utf8');
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  // 3. The atomic swap. Nothing before this point has touched the owner's file.
  //    Retried only while another process briefly holds it open (QA row 7.1);
  //    when the retries run out, the cleanup below is exactly what it was.
  try {
    await renameWithRetry(tempPath, path, opts.io);
  } catch (error) {
    await rm(tempPath, { force: true });
    if (backupPath !== null) await rm(backupPath, { force: true });
    throw error;
  }

  const summary =
    opts.remove === true
      ? `Removed Walder's hooks from ${path} (${result.touched.join(', ')}).`
      : `Installed Walder's hooks in ${path} for ${result.touched.join(', ')}. ` +
        `${opts.toolName ?? 'Claude Code'} picks them up on its next start.`;

  return { path, changed: true, touched: result.touched, backupPath, summary };
}

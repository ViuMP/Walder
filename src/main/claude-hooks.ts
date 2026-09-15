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
 * hooks. `matcher` filters by tool name and only means anything for the tool
 * events, so the three lifecycle events we subscribe to get a group with no
 * matcher.
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

/** The three Claude Code events Walder listens for. */
export const HOOK_EVENTS: readonly string[] = ['Stop', 'Notification', 'UserPromptSubmit'];

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
 */
export function hookCommand(port: number, platform: NodeJS.Platform = process.platform): string {
  const url = `http://127.0.0.1:${port}/event`;
  if (platform === 'win32') {
    return (
      `powershell -NoProfile -Command "try { Invoke-RestMethod -Uri ${url} -Method Post ` +
      `-ContentType 'application/json' -Body ([Console]::In.ReadToEnd()) -TimeoutSec 1 ` +
      `| Out-Null } catch {} # ${HOOK_MARKER}"`
    );
  }
  return (
    `curl -s -m 1 -X POST -H 'Content-Type: application/json' --data-binary @- ` +
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
 * Exported because the Codex installer reads a different file with the same
 * rule (`~/.codex/hooks.json`), and two copies of "what counts as a Walder
 * hook" is how a remover stops finding what an installer wrote.
 */
export function isOurHook(hook: unknown): boolean {
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
 * The first marked command wins. Walder writes the same port into all three, so
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

function ourHookEntry(command: string): Json {
  return { type: 'command', command, timeout: HOOK_TIMEOUT_S };
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

  for (const event of HOOK_EVENTS) {
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

  const command = hookCommand(port, platform);
  const touched: string[] = [];
  let changed = false;

  for (const event of HOOK_EVENTS) {
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
        const after = ourHookEntry(command);
        if (before !== JSON.stringify(after)) changed = true;
        hooks[j] = after;
        groups[i] = { ...group, hooks };
        placed = true;
        break;
      }
    }

    if (!placed) {
      // No matcher: `Stop`, `Notification` and `UserPromptSubmit` are not tool
      // events, so there is nothing for a matcher to filter.
      groups.push({ hooks: [ourHookEntry(command)] });
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

  const result = opts.remove === true ? removeHooks(parsed) : mergeHooks(parsed, opts.port, platform);

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
  try {
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    if (backupPath !== null) await rm(backupPath, { force: true });
    throw error;
  }

  const summary =
    opts.remove === true
      ? `Removed Walder's hooks from ${path} (${result.touched.join(', ')}).`
      : `Installed Walder's hooks in ${path} for ${result.touched.join(', ')}. ` +
        `Claude Code picks them up on its next start.`;

  return { path, changed: true, touched: result.touched, backupPath, summary };
}

/**
 * Installing (and removing) Walder's hooks in `~/.codex/hooks.json`.
 *
 * Codex's hooks engine takes the *same* schema as Claude Code's — matcher groups
 * holding `{ type: 'command', command, timeout }` entries, the payload on stdin
 * with a `hook_event_name` — so this file is deliberately almost empty: every
 * rule that matters (never lose a setting, idempotent, keyed by the marker,
 * dated backup, atomic rename) lives in `claude-hooks.ts` and is *called* from
 * here, never copied. What actually differs is only:
 *
 *  1. **the file.** `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`), holding
 *     the same `{ "hooks": { … } }` root. Codex merges every layer it reads —
 *     this file, the `[hooks]` table in `config.toml`, and plugin hooks — so
 *     writing here adds to what the owner has rather than replacing it.
 *  2. **the events.** `PermissionRequest` instead of Claude Code's
 *     `Notification`; `Stop`, `UserPromptSubmit` and `PostToolUse` are shared
 *     names.
 *  3. **one header** on the command, `X-Walder-Source: codex`, which is the only
 *     way the listener can tell the two tools apart — the body is Codex's own,
 *     piped through verbatim.
 *
 * **What this file must not touch: `~/.codex/config.toml`.** Its `notify` key is
 * already owned by the Codex desktop app on the owner's machine (and that app
 * rewrites the file itself), and `[hooks.state."…"] trusted_hash` is the owner's
 * one-time review of a hook definition — see the trust gate below. Walder writes
 * `hooks.json` and nothing else.
 *
 * **One file, one tool — and nothing enforces it.** `mergeHooksInto` keys on
 * the `walder-hook` marker *per event*, so pointing both installers at the same
 * file does not add two sets of entries: it replaces the first installer's
 * entry wherever the two event lists overlap. `Stop` and `UserPromptSubmit` are
 * shared names, so `CODEX_HOME=~/.claude` (or `npm run install-hooks -- --codex
 * --settings ~/.claude/settings.json`) leaves Claude Code posting two of its
 * three events with `X-Walder-Source: codex` on them — a dog that says `Codex
 * done` when Claude Code finished. It is unreachable through the tray, which
 * hard-codes `claudeSettingsPath()` and `codexHooksPath()`, and it is reachable
 * only from the script by deliberately aiming it at the other tool's file.
 * Deliberately not defended: a check here would be a guess about which file the
 * owner meant, the two overrides exist precisely so he can point them at an
 * unusual place, and the recovery is one `--remove` run with the same flags.
 *
 * **The trust gate.** Codex runs a non-plugin hook only after the owner has
 * trusted its exact definition once, through `/hooks` in a Codex terminal; until
 * then it is skipped silently. So installing is only half the job here, and the
 * result dialog and the README carry the other half (`index.ts`). Walder never
 * writes the hash itself: that hash *is* the owner's review.
 *
 * Electron-free, like its Claude twin, so `npm run install-hooks -- --codex`
 * behaves identically to the tray item.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  applyHooks,
  hookPortIn,
  type HookHeader,
  type InstallOutcome
} from './claude-hooks';

/**
 * Codex's config directory: `$CODEX_HOME` when it is set, else `~/.codex`.
 *
 * The override is Codex's own documented escape hatch and is not rare — it is
 * how a second profile or a sandboxed run is kept apart — so reading it is the
 * difference between installing into the config Codex will actually load and
 * installing into a directory nobody reads. An empty value counts as unset,
 * which is what a shell that exports `CODEX_HOME=` leaves behind.
 */
export function codexHome(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): string {
  const set = env['CODEX_HOME'];
  return set !== undefined && set !== '' ? set : join(home, '.codex');
}

/** `~/.codex/hooks.json`. */
export function codexHooksPath(
  env?: Record<string, string | undefined>,
  home?: string
): string {
  return join(codexHome(env, home), 'hooks.json');
}

/**
 * The four Codex events Walder listens for.
 *
 * `Stop` when a turn finishes; `PermissionRequest` immediately before Codex asks
 * the owner to approve a command or a patch, which is the waiting state;
 * `UserPromptSubmit` when he types the next thing, which ends the wait; and —
 * since 0.2.7 — `PostToolUse` when an approved command has finished running,
 * which also ends it.
 *
 * **`PostToolUse` is here because of `PermissionRequest`, not beside it.** Codex
 * fires the approval event after an action and after a subagent whether or not
 * it is going to ask anything (Victor, 2026-09-21), so the `?` stood until the
 * turn's `Stop`. `PostToolUse` is the event that says the command ran, and it
 * is what lets the grace in `core/behaviour.ts` throw the false `?` away before
 * it is ever drawn.
 *
 * **There is no Codex event for a plan-mode question** (`request_user_input` has
 * been asked for and does not exist), so a Codex session parked on a question
 * that is not an approval prompt goes unremarked. Documented rather than faked:
 * a `Stop`-based guess would say "done" about a turn that is not.
 */
export const CODEX_HOOK_EVENTS: readonly string[] = [
  'Stop',
  'PermissionRequest',
  'UserPromptSubmit',
  'PostToolUse'
];

/** What makes a request from these hooks say `Codex` and not `Claude`. */
export const CODEX_SOURCE_HEADER: HookHeader = { name: 'X-Walder-Source', value: 'codex' };

export interface CodexInstallOptions {
  readonly port: number;
  readonly remove?: boolean;
  /** Overridden by the test suite and by `--hooks` on the installer script. */
  readonly hooksPath?: string;
  readonly platform?: NodeJS.Platform;
}

/**
 * Read, merge (or strip), back up and write `~/.codex/hooks.json` — the Claude
 * installer's own file I/O, pointed at a different file with different event
 * names and one extra header.
 *
 * A missing `hooks.json` is created as `{ "hooks": { … } }`: `mergeHooksInto`
 * treats anything that is not an object as nothing to preserve, which is
 * exactly right for a file that does not exist yet.
 */
export async function applyCodexHooks(opts: CodexInstallOptions): Promise<InstallOutcome> {
  return applyHooks({
    port: opts.port,
    settingsPath: opts.hooksPath ?? codexHooksPath(),
    platform: opts.platform ?? process.platform,
    remove: opts.remove === true,
    events: CODEX_HOOK_EVENTS,
    header: CODEX_SOURCE_HEADER,
    toolName: 'Codex'
  });
}

/**
 * Which port the hooks in `~/.codex/hooks.json` post to, or `null` when they are
 * not there at all. `installedHookPort`'s twin, and synchronous and silent for
 * the same reason: the tray builds its menu in one pass, and a missing file is
 * the normal case on a machine without Codex.
 *
 * It cannot see the *trust* state — that lives in `config.toml`, which Walder
 * does not read — so "installed" here means "written", not "running". The
 * dialog and the README are what close that gap.
 */
export function installedCodexHookPort(hooksPath: string = codexHooksPath()): number | null {
  try {
    return hookPortIn(JSON.parse(readFileSync(hooksPath, 'utf8')), CODEX_HOOK_EVENTS);
  } catch {
    return null;
  }
}

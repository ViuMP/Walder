/**
 * `npm run install-hooks` — put Walder's Claude Code hooks into
 * `~/.claude/settings.json`, or take them out again with `--remove`.
 *
 * The same thing the tray's "Install Claude Code hooks…" item does; this is the
 * version for someone at a terminal. All the logic is in
 * `src/main/claude-hooks.ts` so the two cannot drift.
 *
 * The port is *read from Walder's own settings file* rather than assumed, which
 * matters whenever the preferred port was taken: the listener then binds
 * `hookPort + 1` (or `+ 2`) and records it as `hookPortActual`, and a hook
 * pointing at the unbound preferred port would look installed while doing
 * nothing at all. `--port` still overrides, for the case where the owner knows
 * better than the file. See `resolveHookPort`.
 *
 * `--codex` points the whole thing at Codex instead: `~/.codex/hooks.json`, the
 * `PermissionRequest` event in place of `Notification`, and the source header on
 * the command. Nothing else about the run changes — same port resolution, same
 * backup, same `--remove`. Codex additionally wants its hooks *trusted* once
 * (`/hooks` in a Codex terminal) before it will run them, which the script says
 * after a successful install because there is no other way to find out.
 *
 * Usage:
 *   npm run install-hooks
 *   npm run install-hooks -- --port 47812
 *   npm run install-hooks -- --remove
 *   npm run install-hooks -- --codex
 *   npm run install-hooks -- --settings /tmp/settings.json
 *   npm run install-hooks -- --store /tmp/walder.json
 */
import {
  applyHooks,
  hookCommand,
  resolveHookPort,
  walderStorePath
} from '../src/main/claude-hooks';
import { CODEX_SOURCE_HEADER, applyCodexHooks, codexHooksPath } from '../src/main/codex-hooks';

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return null;
  return argv[at + 1] ?? null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const remove = argv.includes('--remove');
  const codex = argv.includes('--codex');

  const rawPort = flag(argv, 'port');
  const storePath = flag(argv, 'store') ?? walderStorePath();
  const port =
    rawPort === null ? await resolveHookPort(storePath) : Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    console.error(`--port must be a whole number between 1024 and 65535, got "${String(rawPort)}"`);
    process.exitCode = 2;
    return;
  }
  if (rawPort === null && !remove) {
    console.log(`Using port ${port} (from ${storePath}).`);
  }

  // `--settings` names the file either way: one override for one file, whichever
  // tool this run is about.
  const settingsPath = flag(argv, 'settings');

  const outcome = codex
    ? await applyCodexHooks({
        port,
        remove,
        hooksPath: settingsPath ?? codexHooksPath()
      })
    : await applyHooks({
        port,
        remove,
        ...(settingsPath === null ? {} : { settingsPath })
      });

  console.log(outcome.summary);
  if (outcome.backupPath !== null) {
    console.log(`A copy of the original file was saved as ${outcome.backupPath}.`);
  }
  if (!remove && outcome.changed) {
    const tool = codex ? 'Codex' : 'Claude Code';
    console.log('');
    console.log(`The command ${tool} will run on each event:`);
    console.log(`  ${hookCommand(port, process.platform, codex ? CODEX_SOURCE_HEADER : undefined)}`);
    console.log('');
    console.log(`It posts the event to Walder and ignores every failure, so ${tool}`);
    console.log('keeps working exactly as before when Walder is not running.');
    if (codex) {
      console.log('');
      console.log('One more step, and Codex will not react without it: run `codex`, type');
      console.log('`/hooks`, and trust Walder’s three entries once. Codex skips a hook it');
      console.log('has not been told to trust, and says nothing about it.');
    }
  }
}

void main().catch((error: unknown) => {
  console.error('Could not update the Claude Code settings:', error);
  process.exitCode = 1;
});

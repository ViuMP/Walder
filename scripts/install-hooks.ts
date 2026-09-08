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
 * Usage:
 *   npm run install-hooks
 *   npm run install-hooks -- --port 47812
 *   npm run install-hooks -- --remove
 *   npm run install-hooks -- --settings /tmp/settings.json
 *   npm run install-hooks -- --store /tmp/walder.json
 */
import {
  applyHooks,
  hookCommand,
  resolveHookPort,
  walderStorePath
} from '../src/main/claude-hooks';

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return null;
  return argv[at + 1] ?? null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const remove = argv.includes('--remove');

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

  const settingsPath = flag(argv, 'settings');

  const outcome = await applyHooks({
    port,
    remove,
    ...(settingsPath === null ? {} : { settingsPath })
  });

  console.log(outcome.summary);
  if (outcome.backupPath !== null) {
    console.log(`A copy of the original file was saved as ${outcome.backupPath}.`);
  }
  if (!remove && outcome.changed) {
    console.log('');
    console.log('The command Claude Code will run on each event:');
    console.log(`  ${hookCommand(port)}`);
    console.log('');
    console.log('It posts the event to Walder and ignores every failure, so Claude Code');
    console.log('keeps working exactly as before when Walder is not running.');
  }
}

void main().catch((error: unknown) => {
  console.error('Could not update the Claude Code settings:', error);
  process.exitCode = 1;
});

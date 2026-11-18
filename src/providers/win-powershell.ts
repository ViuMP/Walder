/**
 * Where Windows PowerShell lives, by absolute path.
 *
 * Moved here from `main/fullscreen-watch.ts` (2026-11-18) so that the
 * Antigravity provider can use it too: that file imports `electron`, and a
 * provider has to stay importable from plain Node (`scripts/probe.ts`, the
 * test suite). Both now import this one helper, so there is one rule and one
 * place it is written down.
 *
 * The rule (2026-11 audit, W-7): a bare `powershell.exe` is looked up in the
 * current directory and on PATH, which belong to the user, not to Walder —
 * the same reason `main/raise.ts` and `providers/antigravity.ts` run `/bin/ps`
 * by its full path on macOS.
 */
import { win32 } from 'node:path';

/** Where Windows keeps itself when `SystemRoot` says nothing usable. */
const DEFAULT_SYSTEM_ROOT = 'C:\\Windows';

export function winPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  // `||`, not `??`: an empty SystemRoot is no more usable than a missing one.
  const root = env['SystemRoot'] || DEFAULT_SYSTEM_ROOT;
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

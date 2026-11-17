/**
 * `npm run dist:win` — package the Windows installer into `release/`.
 *
 * Runs `electron-builder --win --config.npmRebuild=false` with
 * `CSC_IDENTITY_AUTO_DISCOVERY=false` set. The `build` step before it and the
 * `predist:win` / `postdist:win` hooks around it stay in package.json.
 *
 * Why a script rather than `"CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder …"`
 * in package.json: that form is a POSIX shell idiom, and npm runs scripts through
 * `cmd` on Windows, which parses it as a command name and fails — so the one
 * installer meant for Windows could not be built on Windows without first
 * pointing npm's script-shell at Git Bash. Same reasoning as `scripts/sprites.ts`:
 * spawning with an explicit `env` behaves identically on every platform and needs
 * no dependency (`cross-env`) to do it. On a Mac, `dist:all` keeps working exactly
 * as before.
 *
 * For why the rebuild is skipped, see `//win-npmRebuild` in package.json.
 */
import { runBin } from './cli';

const child = runBin('electron-builder', ['--win', '--config.npmRebuild=false'], {
  CSC_IDENTITY_AUTO_DISCOVERY: 'false'
});

child.on('exit', (code, signal) => {
  // A failed or interrupted package must fail the npm script, so that
  // postdist:win's check:asar never runs against a half-written release/.
  process.exit(signal !== null ? 1 : (code ?? 1));
});

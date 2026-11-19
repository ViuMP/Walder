/**
 * `npm run dist:win` — package the Windows installer into `release/`.
 *
 * Runs `electron-builder --win --config.npmRebuild=false` with
 * `CSC_IDENTITY_AUTO_DISCOVERY=false` set, then the asar check. The `build` step
 * before it and the `predist:win` hook stay in package.json.
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
 *
 * Arguments after `npm run dist:win --` go on to electron-builder, and the asar
 * check then reads the directory it packaged into: `release/`, or the one a
 * `--config.directories.output=…` override named (2026-11-19). Until then the
 * flag was dropped here and a `postdist:win` hook checked `release/` by name.
 */
import { resolve } from 'node:path';
import { root, runBin, splitOutput } from './cli';
import { runCheck } from './check-asar';

const args = process.argv.slice(2);
const out = resolve(root, splitOutput(args).output ?? 'release');

const child = runBin('electron-builder', ['--win', '--config.npmRebuild=false', ...args], {
  CSC_IDENTITY_AUTO_DISCOVERY: 'false'
});

child.on('exit', (code, signal) => {
  // A failed or interrupted package must fail the npm script, and the asar
  // check must never run against a half-written output directory.
  const status = signal !== null ? 1 : (code ?? 1);
  process.exit(status !== 0 ? status : runCheck(out));
});

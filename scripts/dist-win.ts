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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// `.cmd` on Windows: npm installs a batch shim, not an executable of the bare name.
const isWindows = process.platform === 'win32';
const bin = join(root, 'node_modules', '.bin', isWindows ? 'electron-builder.cmd' : 'electron-builder');

const child = spawn(
  // Quoted, because a batch shim runs through a shell and the working tree may
  // sit under a path with spaces in it (OneDrive's "OneDrive - <Org>" does).
  isWindows ? `"${bin}"` : bin,
  ['--win', '--config.npmRebuild=false'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    shell: isWindows
  }
);

child.on('error', (error) => {
  console.error(`\nCould not start electron-builder: ${error.message}`);
  console.error('Run "npm install" first.\n');
  process.exit(1);
});

child.on('exit', (code, signal) => {
  // A failed or interrupted package must fail the npm script, so that
  // postdist:win's check:asar never runs against a half-written release/.
  process.exit(signal !== null ? 1 : (code ?? 1));
});

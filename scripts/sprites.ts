/**
 * `npm run sprites` — open the animation gallery.
 *
 * A thin launcher around `electron-vite dev` with `WALDER_GALLERY=1` set, which
 * makes the main process open an ordinary 1100x800 window on the gallery page
 * instead of the mascot (see `src/main/gallery-window.ts`). This replaces the
 * M3-era stub, which refused to run at all: there was no window a gallery could
 * sensibly open in once the app became a single-purpose click-through overlay
 * host, and there is one now.
 *
 * Why a script rather than `"sprites": "WALDER_GALLERY=1 electron-vite dev"`:
 * that form is a POSIX shell idiom and does nothing on Windows `cmd`, which
 * parses it as a command name. Walder ships on both, and a review tool that
 * silently opened the mascot instead on one of them would be worse than no tool.
 * Spawning with an explicit `env` behaves identically everywhere and needs no
 * dependency (`cross-env`) to do it.
 *
 * Reusing `electron-vite dev` rather than building first is what gives the
 * gallery the Vite dev server, and with it the dev-mode CSP the `walder-csp`
 * plugin injects and hot reload while someone iterates on the page itself.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// `.cmd` on Windows: npm installs a batch shim, not an executable of the bare name.
const isWindows = process.platform === 'win32';
const bin = join(root, 'node_modules', '.bin', isWindows ? 'electron-vite.cmd' : 'electron-vite');

console.log('Opening the Walder animation gallery. Close the window to stop.\n');

const child = spawn(bin, ['dev'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, WALDER_GALLERY: '1' },
  // A batch shim can only be run through a shell.
  shell: isWindows
});

child.on('error', (error) => {
  console.error(`\nCould not start electron-vite: ${error.message}`);
  console.error('Run "npm install" first.\n');
  process.exit(1);
});

child.on('exit', (code, signal) => {
  // Mirror the child's fate, so a failing dev server fails the npm script while
  // a Ctrl-C reads as a Ctrl-C rather than as a crash.
  process.exit(signal !== null ? 0 : (code ?? 0));
});

/**
 * `npm run sprites` — launches the dev app straight onto the sprite gallery page
 * instead of the overlay. Cross-platform (no inline env-var syntax).
 */
import { spawn } from 'node:child_process';

const child = spawn('electron-vite', ['dev'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, WALDER_PAGE: 'sprites-dev' }
});

child.on('exit', (code) => process.exit(code ?? 0));

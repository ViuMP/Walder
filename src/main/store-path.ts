import { homedir } from 'node:os';
import { join } from 'node:path';

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

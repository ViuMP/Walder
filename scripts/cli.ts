/**
 * Small pieces the npm-run scripts share, kept in one place because the copies
 * drifted once already (audit B7, 2026-11-17: T3 was a quoting fix that
 * `dist-win.ts` had and `sprites.ts` lacked).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The value after `--<name>` in `argv`, or `null` when the flag is absent. */
export function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return null;
  return argv[at + 1] ?? null;
}

/**
 * How to spawn a `node_modules/.bin` shim. On Windows npm installs a `.cmd`
 * batch shim, which only runs through a shell, and cmd.exe splits an unquoted
 * path at its first space (OneDrive's "OneDrive - <Org>"), so it is quoted.
 */
export function binSpawn(
  name: string,
  platform: NodeJS.Platform = process.platform,
  dir: string = root
): { command: string; shell: boolean } {
  const isWindows = platform === 'win32';
  const bin = join(dir, 'node_modules', '.bin', isWindows ? `${name}.cmd` : name);
  return { command: isWindows ? `"${bin}"` : bin, shell: isWindows };
}

/**
 * Spawn a `node_modules/.bin` tool from the repo root with `extraEnv` added,
 * output inherited. A failure to start exits 1 with a hint; the caller decides
 * what the child's own exit means.
 */
export function runBin(
  name: string,
  args: readonly string[],
  extraEnv: Record<string, string>
): ChildProcess {
  const { command, shell } = binSpawn(name);
  const child = spawn(command, [...args], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    shell
  });
  child.on('error', (error) => {
    console.error(`\nCould not start ${name}: ${error.message}`);
    console.error('Run "npm install" first.\n');
    process.exit(1);
  });
  return child;
}

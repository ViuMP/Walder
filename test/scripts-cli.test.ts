/**
 * `scripts/cli.ts`, the helpers `sprites.ts`, `dist-win.ts`, `dist-mac.ts`, `install-hooks.ts`
 * and `publish-release.ts` share (audit B7, 2026-11-17).
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { binSpawn, flag, shellArg, splitOutput } from '../scripts/cli';

describe('binSpawn', () => {
  it('quotes the .cmd shim it hands to a Windows shell', () => {
    // 2026-11-13: with `shell: true`, cmd.exe split an unquoted shim path at
    // its first space ("OneDrive - <Org>").
    const dir = 'C:\\Users\\me\\OneDrive - Org\\Walder';
    const { command, shell } = binSpawn('electron-vite', 'win32', dir);
    expect(command).toBe(`"${join(dir, 'node_modules', '.bin', 'electron-vite.cmd')}"`);
    expect(shell).toBe(true);
  });

  it('runs the bare shim without a shell elsewhere', () => {
    expect(binSpawn('electron-builder', 'darwin', '/repo')).toEqual({
      command: join('/repo', 'node_modules', '.bin', 'electron-builder'),
      shell: false
    });
  });
});

describe('flag', () => {
  it('reads the value after --name, and null when absent or last', () => {
    expect(flag(['--port', '1234'], 'port')).toBe('1234');
    expect(flag(['--remove'], 'port')).toBeNull();
    expect(flag(['--port'], 'port')).toBeNull();
  });
});

describe('splitOutput', () => {
  // 2026-11-19: `npm run dist:win -- --config.directories.output=…` was dropped
  // by dist-win.ts, and dist:mac appended it to `ditto`.
  it('takes the output override out, in both spellings, and keeps the rest in order', () => {
    expect(splitOutput(['--config.directories.output=/qa/dist', '--x64'])).toEqual({
      output: '/qa/dist',
      rest: ['--x64']
    });
    expect(splitOutput(['--dir', '--config.directories.output', 'C:\\QA run\\dist'])).toEqual({
      output: 'C:\\QA run\\dist',
      rest: ['--dir']
    });
  });

  it('is null with no override, and leaves a flag with no value alone', () => {
    expect(splitOutput([])).toEqual({ output: null, rest: [] });
    expect(splitOutput(['--config.directories.output'])).toEqual({
      output: null,
      rest: ['--config.directories.output']
    });
  });
});

describe('shellArg', () => {
  it('quotes an argument with a space for the cmd.exe line, and only that', () => {
    expect(shellArg('--config.directories.output=C:\\QA run')).toBe('"--config.directories.output=C:\\QA run"');
    expect(shellArg('--win')).toBe('--win');
  });
});

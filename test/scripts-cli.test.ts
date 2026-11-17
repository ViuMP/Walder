/**
 * `scripts/cli.ts`, the helpers `sprites.ts`, `dist-win.ts`, `install-hooks.ts`
 * and `publish-release.ts` share (audit B7, 2026-11-17).
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { binSpawn, flag } from '../scripts/cli';

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

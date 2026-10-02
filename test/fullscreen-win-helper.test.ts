/**
 * The Windows fullscreen helper, run for real.
 *
 * `fullscreen-win.ps1` had never been executed by anyone until 2026-10-02, and
 * on its first run it failed to compile: `Add-Type -MemberDefinition` already
 * emits `using System.Runtime.InteropServices;`, so the explicit
 * `-UsingNamespace` for the same namespace was a duplicate, and Windows
 * PowerShell 5.1 treats that warning as an error. The helper exited with code 1
 * on every launch, the watch logged "could not read the active window 30 times
 * in a row", and the dog never slept over a film on Windows.
 *
 * Two assertions, so the fault is caught on every platform:
 *  - the static one reads the script and rejects the duplicate directive; it
 *    runs everywhere, including the macOS build machine;
 *  - the live one spawns the script exactly as `fullscreen-watch.ts` does and
 *    requires its first line to parse into an active window — it runs only on
 *    win32, where PowerShell exists.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron-store', () => ({ default: class {} }));
vi.mock('electron', () => ({
  app: { getName: () => 'Walder', isPackaged: false, getAppPath: () => '/app' },
  screen: { getAllDisplays: () => [] }
}));

const { parseWinLine } = await import('../src/main/fullscreen-watch');

const SCRIPT = join(__dirname, '..', 'src', 'main', 'fullscreen-win.ps1');

/** How long the live run may take to produce its first sample (Add-Type compiles once). */
const FIRST_LINE_TIMEOUT_MS = 20_000;

describe('fullscreen-win.ps1', () => {
  it('does not name System.Runtime.InteropServices twice (Add-Type already does)', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).not.toMatch(/-UsingNamespace\s+System\.Runtime\.InteropServices/);
    // And the thing the directive was for is still declared, so the assertion
    // above is not satisfied by an empty file.
    expect(source).toMatch(/Add-Type -Namespace Walder -Name Native -MemberDefinition/);
  });

  it.runIf(process.platform === 'win32')(
    'compiles and streams a parseable active-window line on Windows',
    async () => {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

      const firstLine = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no line within ${FIRST_LINE_TIMEOUT_MS} ms; stderr: ${stderr}`)), FIRST_LINE_TIMEOUT_MS);
        const check = (): void => {
          const nl = stdout.indexOf('\n');
          if (nl >= 0) {
            clearTimeout(timer);
            resolve(stdout.slice(0, nl));
          }
        };
        child.stdout.on('data', check);
        child.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`helper exited (code ${code}) before its first line; stderr: ${stderr}`));
        });
      }).finally(() => {
        // The parent's stop protocol: closing stdin ends the loop.
        child.stdin.end();
        child.kill();
      });

      expect(stderr).toBe('');
      const info = parseWinLine(firstLine);
      // Some window is always in the foreground while the suite runs (at the very
      // least the terminal), so the line must describe one with real bounds.
      expect(info).not.toBeNull();
      expect(info!.bounds.width).toBeGreaterThan(0);
      expect(info!.monitor?.width ?? 0).toBeGreaterThan(0);
    },
    FIRST_LINE_TIMEOUT_MS + 5_000
  );
});

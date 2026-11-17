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
    // Only the Add-Type line itself counts: the script's own comments explain
    // the directive by name.
    expect(source).not.toMatch(/^Add-Type\b.*-UsingNamespace\s+System\.Runtime\.InteropServices/m);
    // And the thing the directive was for is still declared, so the assertion
    // above is not satisfied by an empty file.
    expect(source).toMatch(/Add-Type -Namespace Walder -Name Native -MemberDefinition/);
  });

  it('reports the window class with a fully qualified StringBuilder (M5)', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    // `-MemberDefinition` has no `using System.Text`, and adding one is the
    // kind of extra directive 5.1 has refused before — so the type is spelled out.
    expect(source).toMatch(/GetClassName\(IntPtr window, System\.Text\.StringBuilder className, int maxCount\)/);
    expect(source).not.toMatch(/^\s*using\s+System\.Text\s*;/m);
    // And it reaches the line the parent reads.
    expect(source).toMatch(/'","cls":"' \+ \$cls/);
  });

  it('asks for per-monitor DPI awareness before reading rects, and says so on the line (audit M3)', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    // powershell.exe 5.1 is DPI-unaware, so without this every rect is in a
    // 96-DPI logical space that only matches Electron's DIPs on one display.
    expect(source).toMatch(/SetThreadDpiAwarenessContext\(IntPtr dpiContext\)/);
    expect(source).toMatch(/"physical":' \+ \$physical/);
    // Asked on every sample, before the foreground window is read.
    const asked = source.indexOf('$physical = if (Set-PhysicalPixels)');
    expect(asked).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(source.indexOf('$window = [Walder.Native]::GetForegroundWindow()'));
    expect(asked).toBeGreaterThan(source.indexOf('while ($true)'));
  });

  it('reads the class after the DPI switch and whether or not the rect could be read (M3 x M5)', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const asked = source.indexOf('$physical = if (Set-PhysicalPixels)');
    const rect = source.indexOf('[Walder.Native]::GetWindowRect($window');
    const cls = source.indexOf('[Walder.Native]::GetClassName($window');
    expect(asked).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(rect);
    expect(asked).toBeLessThan(cls);
    // A failed GetWindowRect zeroes the rect rather than skipping the sample, so
    // the shell-surface hold (decided by class) never hinges on a readable rect.
    expect(source).toMatch(/if \(-not \[Walder\.Native\]::GetWindowRect\(\$window, \[ref\] \$rect\)\)/);
    expect(source).not.toMatch(/if \(\[Walder\.Native\]::GetWindowRect\(/);
    // Both fields on the one line the parent reads.
    const line = source.indexOf(`$line = '{"pid":' + $processId`);
    expect(line).toBeGreaterThan(cls);
    expect(source.indexOf(`'","cls":"' + $cls`, line)).toBeGreaterThan(line);
    expect(source.indexOf(`'},"physical":' + $physical + '}'`, line)).toBeGreaterThan(line);
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
      // Every real window has a class, so a compiled GetClassName reports one.
      expect(info!.windowClass ?? '').not.toBe('');
      // Audit M3: every supported Windows (10 1703+) has per-monitor v2, so the
      // helper must have switched its thread and reported physical pixels. A
      // line without the flag here means the awareness call failed silently and
      // mixed-scale layouts are back to comparing logical rects with DIPs.
      expect(info!.physical).toBe(true);
    },
    FIRST_LINE_TIMEOUT_MS + 5_000
  );
});

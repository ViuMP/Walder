/**
 * The discovery's child-process timeout per platform (Windows on-screen pass,
 * 2026-11-19): the PowerShell discovery took 1.8–1.9 s on the PC, so the old
 * shared 2 s limit made polls read "not running" while Antigravity was open.
 */
import { describe, expect, it } from 'vitest';
import { EXEC_TIMEOUT_WIN_MS, execTimeoutFor } from '../src/providers/antigravity';

/** The slowest discovery measured on the PC, in ms. */
const MEASURED_WIN_MS = 1_908;

describe('execTimeoutFor', () => {
  it('gives Windows several times the slowest discovery measured there', () => {
    expect(execTimeoutFor('win32')).toBe(EXEC_TIMEOUT_WIN_MS);
    expect(execTimeoutFor('win32')).toBeGreaterThanOrEqual(3 * MEASURED_WIN_MS);
  });

  it('still bounds a hung PowerShell child to a poll-sized wait', () => {
    expect(execTimeoutFor('win32')).toBeLessThanOrEqual(10_000);
  });

  it('leaves the macOS and Linux tools at 2 s', () => {
    expect(execTimeoutFor('darwin')).toBe(2_000);
    expect(execTimeoutFor('linux')).toBe(2_000);
  });
});

/**
 * The Electron-free boundary, enforced by a test rather than by reading.
 *
 * `src/core` and `src/sprites` are the modules the unit tests, the probe script
 * and the renderer all share, and AGENTS.md's rule that they stay free of
 * `electron` and `node:` has been kept by review alone until now. A single
 * stray import would still typecheck and still pass every test that mocks
 * `electron` — and break the renderer bundle, or the probe, at the worst time.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['src/core', 'src/sprites'];

/** `from '…'`, side-effect `import '…'`, dynamic `import('…')` and `require('…')`. */
const SPECIFIER = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

function forbidden(specifier: string): boolean {
  return (
    specifier === 'electron' ||
    specifier.startsWith('electron/') ||
    specifier === 'electron-store' ||
    specifier.startsWith('node:')
  );
}

function sources(): string[] {
  return ROOTS.flatMap((root) =>
    readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(root, name))
  );
}

describe('src/core and src/sprites', () => {
  const files = sources();

  it('are still where this test expects them', () => {
    // A moved directory must fail here, not silently scan nothing.
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it('import neither electron nor node built-ins', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const match of line.matchAll(SPECIFIER)) {
          const specifier = match[1] ?? '';
          if (forbidden(specifier)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

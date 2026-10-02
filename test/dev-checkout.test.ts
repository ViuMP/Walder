/**
 * The preconditions two other suites quietly rely on.
 *
 * `test/gen-icons.test.ts` sets `runnable = TSX !== null` (tsx's CLI module,
 * from `tsxCli()` in `test/support/host.ts`) and `describe.runIf(runnable)` its
 * ~330 lines of icon verification on it;
 * `test/sync-sheet.test.ts:68` does the same with `present = existsSync(ART)`
 * for its five `it.runIf(present)` cases. Both exist so the suite still runs
 * green on a checkout that is missing tsx or
 * `art/walder.json` — but "still runs green" and "silently skipped ~460 lines
 * of icon verification" look identical in a `Test Files`/`Tests` summary. This
 * test holds unconditionally so a pruned tree fails loudly here instead.
 *
 * No skip condition of its own: `npm ci` (including the CI workflow's
 * `--ignore-scripts` form) always installs `tsx` as a devDependency, and
 * `art/walder.json` is committed to the repo, so both are preconditions this
 * test can hold everywhere the suite itself runs.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tsxCli } from './support/host';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('dev checkout preconditions', () => {
  it('has node_modules/.bin/tsx, which every tsx-based npm script runs', () => {
    const tsx = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
    expect(existsSync(tsx), tsx).toBe(true);
  });

  it("has tsx's CLI module, which gen-icons.test.ts runs the script with", () => {
    expect(tsxCli()).not.toBeNull();
  });

  it('has art/walder.json, which sync-sheet.test.ts needs to gate against', () => {
    expect(existsSync(join(root, 'art', 'walder.json'))).toBe(true);
  });
});

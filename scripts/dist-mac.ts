/**
 * `npm run dist:mac` — package the macOS dmg into `release/`, or into the
 * directory a `--config.directories.output=…` argument names (2026-11-19).
 *
 * electron-builder packages into `$TMPDIR/walder-dist` and the artifacts are
 * copied into the output directory afterwards; why is `//dist-mac-tmpdir` in
 * package.json (iCloud re-stamps FinderInfo and `codesign` refuses the bundle).
 * Every other argument after `npm run dist:mac --` goes on to electron-builder.
 * Then the asar check runs on what landed in the output directory.
 *
 * This used to be one shell line in package.json, which appended any extra
 * argument to its last command, `ditto`, and a `postdist:mac` hook that only
 * ever checked `release/`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { root, runBin, splitOutput } from './cli';
import { runCheck } from './check-asar';

const { output, rest } = splitOutput(process.argv.slice(2));
const out = resolve(root, output ?? 'release');
const staging = join(tmpdir(), 'walder-dist');
rmSync(staging, { recursive: true, force: true });

const child = runBin('electron-builder', ['--mac', ...rest, `--config.directories.output=${staging}`], {
  CSC_IDENTITY_AUTO_DISCOVERY: 'false'
});

child.on('exit', (code, signal) => {
  const status = signal !== null ? 1 : (code ?? 1);
  if (status !== 0) process.exit(status);
  // The unpacked apps are replaced, not merged into: `mac-arm64`, and `mac`,
  // where electron-builder puts an x64 build (PR #27).
  for (const app of ['mac-arm64', 'mac']) rmSync(join(out, app), { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const copy = spawnSync('ditto', [staging, out], { stdio: 'inherit' });
  if (copy.status !== 0) process.exit(1);
  process.exit(runCheck(out));
});

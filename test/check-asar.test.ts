/**
 * The packaged archive, checked from the test suite.
 *
 * `scripts/check-asar.ts` is the real gate — it is wired to `postdist:mac` and
 * `postdist:win`, so a packaging run cannot finish with the wrong contents. This
 * file exists for the other half of the problem: the *rules* are code, and code
 * that only ever runs at the end of a fifteen-minute packaging run is code nobody
 * exercises. So the rule engine is unit-tested against synthetic entry lists here
 * (fast, always run), and then applied to whatever real archive happens to be
 * lying in `release/` (skipped when there is none, because a clean checkout has
 * no build).
 *
 * The synthetic half is the part that catches the regression this was written
 * for: `win.files` in `electron-builder.yml` replaces the top-level list rather
 * than extending it, and the Windows installer shipped `/src`, `/test`, `/art`,
 * `/design`, `/docs`, `/scripts`, the tsconfigs and the README inside `app.asar`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { asarEntries, checkAsar, findAsars, platformOf, runtimeClosure } from '../scripts/check-asar';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_MODULES = join(root, 'node_modules');

/**
 * Write a real (if tiny) asar containing exactly `paths`, so the checks are
 * exercised through the same header parser the script uses rather than through a
 * stubbed entry list. Every file is empty: nothing here reads contents.
 *
 * The format is four little-endian `uint32`s — 4, the pickle size, the header
 * string's pickle size, the header string's length — then the JSON, then the
 * concatenated file bodies.
 */
function writeAsar(paths: readonly string[], unpacked: readonly string[] = []): string {
  interface Node {
    files: Record<string, Node | { size: number; offset: string; unpacked?: boolean }>;
  }
  const tree: Node = { files: {} };
  for (const path of paths) {
    const parts = path.split('/');
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      const existing = node.files[part];
      if (existing === undefined || !('files' in existing)) {
        const made: Node = { files: {} };
        node.files[part] = made;
        node = made;
      } else {
        node = existing;
      }
    }
    const leaf = parts[parts.length - 1] as string;
    node.files[leaf] = {
      size: 0,
      offset: '0',
      ...(unpacked.includes(path) ? { unpacked: true } : {})
    };
  }

  const json = Buffer.from(JSON.stringify(tree), 'utf8');
  // The header string is padded to a multiple of four inside its pickle.
  const padding = (4 - (json.length % 4)) % 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(json.length + padding + 8, 4);
  prefix.writeUInt32LE(json.length + padding + 4, 8);
  prefix.writeUInt32LE(json.length, 12);

  const file = join(mkdtempSync(join(tmpdir(), 'walder-asar-')), 'app.asar');
  writeFileSync(file, Buffer.concat([prefix, json, Buffer.alloc(padding)]));
  return file;
}

/** The minimum a passing archive contains, so a test can add one bad entry to it. */
function goodEntries(): string[] {
  return [
    'package.json',
    'out/main/index.js',
    'out/renderer/assets/bark-test.wav',
    'out/preload/index.js',
    'build/trayTemplate.png',
    'node_modules/get-windows/lib/macos.js',
    ...runtimeClosure(NODE_MODULES, ['electron-store']).map(
      (pkg) => `node_modules/${pkg}/package.json`
    )
  ];
}

describe('the asar header reader', () => {
  it('lists every file and no directories', () => {
    const file = writeAsar(['package.json', 'out/main/index.js', 'node_modules/x/index.js']);
    expect(asarEntries(file).sort()).toEqual([
      'node_modules/x/index.js',
      'out/main/index.js',
      'package.json'
    ]);
  });

  it('refuses a file that is not an asar', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'walder-asar-')), 'app.asar');
    writeFileSync(file, Buffer.from('this is not an archive at all', 'utf8'));
    expect(() => asarEntries(file)).toThrow(/does not look like an asar/u);
  });
});

describe('runtimeClosure', () => {
  it("finds electron-store's real dependencies, not just the top level", () => {
    const closure = runtimeClosure(NODE_MODULES, ['electron-store']);
    // `conf` is a direct dependency; `ajv` is two levels down. Both must be in
    // the archive, and the second is the one a hand-maintained list forgets.
    expect(closure).toContain('electron-store');
    expect(closure).toContain('conf');
    expect(closure).toContain('ajv');
  });

  it('ignores a package that is not installed rather than throwing', () => {
    expect(runtimeClosure(NODE_MODULES, ['nothing-is-called-this'])).toEqual([]);
  });
});

describe('platformOf', () => {
  it('reads the platform off the path electron-builder produced', () => {
    expect(platformOf(join('release', 'mac-arm64', 'Walder.app', 'Contents', 'Resources', 'app.asar'))).toBe('mac');
    expect(platformOf(join('release', 'win-unpacked', 'resources', 'app.asar'))).toBe('win');
  });
});

describe('checkAsar', () => {
  it('passes an archive with only the packaged product in it', () => {
    const file = writeAsar(goodEntries());
    // Named `mac` by default (no `.app/Contents/Resources` in a temp path is
    // read as Windows), so drop get-windows for this one.
    const report = checkAsar(file, NODE_MODULES);
    expect(report.platform).toBe('win');
    expect(report.problems).toEqual([
      'ships node_modules/get-windows, whose addon has no Windows build here'
    ]);
  });

  /*
   * The C1 regression itself, entry by entry: each of these was in every Windows
   * installer built before 2026-09-08.
   */
  it.each([
    ['src/main/index.ts', 'src/'],
    ['test/behaviour.test.ts', 'test/'],
    ['art/walder.json', 'art/'],
    ['design/references/pose.png', 'design/'],
    ['docs/QA-CHECKLIST.md', 'docs/'],
    ['scripts/sync-sheet.ts', 'scripts/'],
    ['README.md', 'README.md'],
    ['tsconfig.node.json', 'tsconfig*.json'],
    ['vitest.config.ts', '*.config.ts'],
    ['electron-builder.yml', 'electron-builder.yml'],
    ['out/main/index.js.map', 'a source map']
  ])('rejects %s', (entry, label) => {
    const report = checkAsar(writeAsar([...goodEntries(), entry]), NODE_MODULES);
    expect(report.problems.some((p) => p.includes(label))).toBe(true);
  });

  it('rejects the native build tooling, hoisted or nested', () => {
    for (const entry of [
      'node_modules/@mapbox/node-pre-gyp/lib/main.js',
      'node_modules/node-gyp/bin/node-gyp.js',
      'node_modules/get-windows/node_modules/node-gyp/bin/node-gyp.js',
      'node_modules/node-addon-api/napi.h'
    ]) {
      const report = checkAsar(writeAsar([...goodEntries(), entry]), NODE_MODULES);
      expect(report.problems.some((p) => p.includes('native build tooling')), entry).toBe(true);
    }
  });

  it('rejects an archive missing a runtime dependency', () => {
    const without = goodEntries().filter((entry) => !entry.startsWith('node_modules/conf/'));
    const report = checkAsar(writeAsar(without), NODE_MODULES);
    expect(report.problems.some((p) => p.includes('node_modules/conf'))).toBe(true);
  });

  it('rejects an archive with no main entry point', () => {
    const without = goodEntries().filter((entry) => entry !== 'out/main/index.js');
    expect(checkAsar(writeAsar(without), NODE_MODULES).problems).toContain('missing out/main/index.js');
  });

  it('rejects an archive missing the opt-in bark asset', () => {
    const without = goodEntries().filter((entry) => entry !== 'out/renderer/assets/bark-test.wav');
    expect(checkAsar(writeAsar(without), NODE_MODULES).problems).toContain('missing bundled bark sound');
  });
});

/*
 * The real thing, when there is one. `--dir` builds leave `app.asar` behind;
 * `release/` is gitignored, so this is skipped in a clean checkout and on any
 * machine that has not packaged.
 */
describe('the archives actually in release/', () => {
  const found = existsSync(join(root, 'release')) ? findAsars(join(root, 'release')) : [];

  it.runIf(found.length > 0)('every one of them satisfies the packaging contract', () => {
    for (const path of found) {
      const report = checkAsar(path, NODE_MODULES);
      expect(report.problems, `${path}\n${report.problems.join('\n')}`).toEqual([]);
    }
  });
});

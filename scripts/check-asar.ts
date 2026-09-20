/**
 * `npm run check:asar` — prove that what was packaged is what was meant to be.
 *
 * A packaged Electron app is opaque: `electron-builder` prints a size and a path
 * and nothing about what went in. That opacity hid a real defect for the whole of
 * M6 — `win.files` in `electron-builder.yml` *replaces* the top-level list rather
 * than extending it, and the Windows section held a single negation, so every
 * Windows installer shipped the entire repository (`src/`, `test/`, `art/`,
 * `design/`, `docs/`, `scripts/`, the tsconfigs, the README) inside `app.asar`.
 * The build succeeded, the app ran, and the only symptom was an installer nobody
 * measured against an expectation.
 *
 * So the expectation is written down here and asserted against the real archive.
 * Three families of check, in order of what they protect:
 *
 *  1. **Nothing from the working tree.** Source, tests, artwork, design notes,
 *     docs, build scripts and config are not part of the product. A hit here is
 *     the C1 regression coming back.
 *  2. **Everything the app actually loads.** `out/main/index.js`, and
 *     `electron-store`'s *real* dependency closure, read from `node_modules` at
 *     check time rather than from a list someone maintains by hand. This is what
 *     makes the aggressive `!node_modules/<name>/**\/*` exclusions in
 *     `electron-builder.yml` safe: add a dependency that needs one of those
 *     hoisted packages and this fails at build time, loudly, instead of the app
 *     dying at `new Store(...)` on someone's desktop with no window to say so.
 *  3. **Per-platform native tooling.** `@mapbox/node-pre-gyp`, `node-gyp` and
 *     `node-addon-api` are `get-windows`'s *compiler*, never loaded at run time,
 *     and must be absent everywhere. `get-windows` itself must be present on
 *     macOS (the fullscreen probe) and absent on Windows (a Mac build ships no
 *     Windows addon).
 *
 * The asar header is parsed here rather than shelled out to `npx asar`, and the
 * format is simple enough that doing so is shorter than depending on a package
 * that only exists in this tree as a transitive dependency of electron-builder.
 *
 * Usage:
 *   npm run check:asar                 # every app.asar under release/
 *   npm run check:asar -- path/to/app.asar [more…]
 *
 * Exit 0 with a per-archive summary, or exit 1 naming every violation. Finding no
 * archive at all is *not* a pass: it exits 1 saying so, because a check that
 * silently succeeds when there is nothing to check is worse than no check.
 */
import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------ reading an asar */

/** One entry of an asar's directory tree, as the header stores it. */
interface AsarNode {
  files?: Record<string, AsarNode>;
  size?: number;
  /** Byte offset of the file's data from the start of the data section, as a decimal string. */
  offset?: string;
  unpacked?: boolean;
}

/**
 * Read an asar's JSON header.
 *
 * The layout is four little-endian `uint32`s and then the JSON: `4` (the width
 * of the next field), the pickle size, the header-string pickle size, and the
 * header-string length. Only the last one is needed to slice out the JSON, but
 * the first is checked as a cheap "is this really an asar" guard — a truncated
 * or mistyped file otherwise produces a `JSON.parse` error from a random offset.
 */
function readAsarHeader(path: string): AsarNode {
  return readAsar(path).header;
}

/**
 * The header plus where the file data starts: the pickle (second `uint32`)
 * covers everything after the first eight bytes up to and including the
 * header's padding, so the data section begins right after it.
 */
function readAsar(path: string): { header: AsarNode; dataStart: number } {
  const fd = openSync(path, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (readSync(fd, prefix, 0, 16, 0) < 16) {
      throw new Error(`${path} is too short to be an asar archive`);
    }
    if (prefix.readUInt32LE(0) !== 4) {
      throw new Error(`${path} does not look like an asar archive`);
    }
    const jsonLength = prefix.readUInt32LE(12);
    const json = Buffer.alloc(jsonLength);
    readSync(fd, json, 0, jsonLength, 16);
    return { header: JSON.parse(json.toString('utf8')) as AsarNode, dataStart: 8 + prefix.readUInt32LE(4) };
  } finally {
    closeSync(fd);
  }
}

/**
 * One small text file out of the archive, or `null` when it is not there (or
 * was left unpacked beside the asar). Used for the packaged `package.json`, so
 * a stale archive from an older version can be told apart from a fresh one
 * rather than failing a contract that did not exist when it was built.
 */
export function asarFileText(path: string, entry: string): string | null {
  const { header, dataStart } = readAsar(path);
  let node: AsarNode | undefined = header;
  for (const part of entry.split('/')) node = node?.files?.[part];
  if (node === undefined || node.files !== undefined || node.offset === undefined || node.size === undefined) {
    return null;
  }
  if (node.unpacked === true) return null;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(node.size);
    readSync(fd, buf, 0, node.size, dataStart + Number(node.offset));
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The `version` of the app packaged in the archive, or `null` when unreadable. */
export function asarPackageVersion(path: string): string | null {
  const text = asarFileText(path, 'package.json');
  if (text === null) return null;
  try {
    const version: unknown = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** Every file path inside the archive, `/`-separated and relative to its root. */
export function asarEntries(path: string): string[] {
  const out: string[] = [];
  const walk = (node: AsarNode, prefix: string): void => {
    const children = node.files;
    if (children === undefined) return;
    for (const [name, child] of Object.entries(children)) {
      const full = prefix === '' ? name : `${prefix}/${name}`;
      if (child.files === undefined) out.push(full);
      else walk(child, full);
    }
  };
  walk(readAsarHeader(path), '');
  return out;
}

/* ------------------------------------------------- what the app really needs */

/**
 * Every package `electron-store` pulls in, by its path under `node_modules`.
 *
 * Resolved by walking `dependencies` through the on-disk tree the way Node
 * itself would (nearest `node_modules` first, then upwards), so hoisted and
 * nested copies are both found and reported by the path the archive would use.
 * `optionalDependencies` are deliberately not followed: they may legitimately be
 * absent.
 */
export function runtimeClosure(nodeModules: string, from: string[]): string[] {
  const found = new Set<string>();

  const resolve = (fromDir: string, name: string): string | null => {
    let dir = fromDir;
    for (;;) {
      const candidate = join(dir, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return candidate;
      const up = dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  };

  const stack: [string, string[]][] = [[dirname(nodeModules), from]];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    const [dir, names] = next;
    for (const name of names) {
      const packageDir = resolve(dir, name);
      if (packageDir === null) continue;
      const key = relative(nodeModules, packageDir).split(sep).join('/');
      if (found.has(key)) continue;
      found.add(key);
      let manifest: { dependencies?: Record<string, string> } = {};
      try {
        manifest = JSON.parse(
          readFileSync(join(packageDir, 'package.json'), 'utf8')
        ) as typeof manifest;
      } catch {
        continue;
      }
      stack.push([packageDir, Object.keys(manifest.dependencies ?? {})]);
    }
  }

  return [...found].sort();
}

/* ------------------------------------------------------------------ the rules */

/**
 * Paths that must never appear. Matched against the whole entry path, so a
 * directory prefix catches everything beneath it.
 *
 * `scripts/` is listed by name rather than caught by a blanket rule because it is
 * the one that reads as plausibly-shipped: it is not, nothing in `out/` imports
 * it, and it drags `tsx` expectations along with it.
 */
const FORBIDDEN: readonly { readonly label: string; readonly test: (path: string) => boolean }[] = [
  ...['src', 'test', 'art', 'design', 'docs', 'scripts', 'release'].map((dir) => ({
    label: `${dir}/`,
    test: (p: string): boolean => p === dir || p.startsWith(`${dir}/`)
  })),
  { label: 'README.md', test: (p) => p === 'README.md' },
  { label: 'tsconfig*.json', test: (p) => /^tsconfig[^/]*\.json$/u.test(p) },
  { label: '*.config.ts', test: (p) => /^[^/]*\.config\.ts$/u.test(p) },
  { label: 'electron-builder.yml', test: (p) => p === 'electron-builder.yml' },
  { label: 'package-lock.json', test: (p) => p === 'package-lock.json' },
  { label: 'a source map', test: (p) => p.endsWith('.map') },
  {
    label: 'native build tooling (@mapbox / node-gyp / node-addon-api)',
    test: (p) =>
      p.startsWith('node_modules/@mapbox/') ||
      p.includes('/node-gyp/') ||
      p.startsWith('node_modules/node-gyp/') ||
      p.startsWith('node_modules/node-addon-api/')
  }
];

/** Files that must be there, whatever else changes. */
const REQUIRED: readonly string[] = ['package.json', 'out/main/index.js'];
const BARK_ASSET = /^out\/renderer\/assets\/bark-[\w-]+\.wav$/u;

export type AsarPlatform = 'mac' | 'win';

/** Which platform's archive this is, from where electron-builder put it. */
export function platformOf(path: string): AsarPlatform {
  return path.includes(`.app${sep}Contents${sep}Resources`) ? 'mac' : 'win';
}

export interface AsarReport {
  readonly path: string;
  readonly platform: AsarPlatform;
  readonly entryCount: number;
  readonly problems: string[];
}

/**
 * Apply every rule to one archive.
 *
 * Violations are collected rather than thrown on the first one: a build that got
 * three things wrong should say so once, not three runs in a row.
 */
export function checkAsar(path: string, nodeModules = join(root, 'node_modules')): AsarReport {
  const entries = asarEntries(path);
  const platform = platformOf(path);
  const problems: string[] = [];
  const has = (p: string): boolean => entries.some((e) => e === p || e.startsWith(`${p}/`));

  for (const rule of FORBIDDEN) {
    const hits = entries.filter((entry) => rule.test(entry));
    if (hits.length > 0) {
      problems.push(
        `must not ship ${rule.label} — ${hits.length} entr${hits.length === 1 ? 'y' : 'ies'}, ` +
          `e.g. ${hits.slice(0, 3).join(', ')}`
      );
    }
  }

  for (const required of REQUIRED) {
    if (!entries.includes(required)) problems.push(`missing ${required}`);
  }
  if (!entries.some((entry) => BARK_ASSET.test(entry))) problems.push('missing bundled bark sound');

  // The runtime closure. Skipped rather than guessed at when node_modules is not
  // beside the archive (an archive copied elsewhere for inspection).
  if (existsSync(nodeModules)) {
    for (const pkg of runtimeClosure(nodeModules, ['electron-store'])) {
      if (!has(`node_modules/${pkg}`)) {
        problems.push(`missing runtime dependency node_modules/${pkg} (electron-store needs it)`);
      }
    }
  }

  // `get-windows`: the macOS fullscreen probe, and a module the Windows build
  // could not load even if it wanted to.
  const getWindows = has('node_modules/get-windows');
  if (platform === 'mac' && !getWindows) {
    problems.push('missing node_modules/get-windows — the macOS fullscreen watch cannot arm');
  }
  if (platform === 'win' && getWindows) {
    problems.push('ships node_modules/get-windows, whose addon has no Windows build here');
  }

  return { path, platform, entryCount: entries.length, problems };
}

/* -------------------------------------------------------------------- the CLI */

/** Every `app.asar` under `release/`, however deep electron-builder buried it. */
export function findAsars(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'app.asar') out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

function main(): void {
  const given = process.argv.slice(2);
  const targets = given.length > 0 ? given : findAsars(join(root, 'release'));

  if (targets.length === 0) {
    console.error(
      '\ncheck-asar: no app.asar found under release/.\n' +
        '  Build one first, e.g.  npx electron-builder --dir --mac\n'
    );
    process.exit(1);
  }

  let failed = false;
  for (const target of targets) {
    const report = checkAsar(target);
    const where = relative(root, report.path);
    if (report.problems.length === 0) {
      console.log(`  ok  ${where}  (${report.platform}, ${report.entryCount} entries)`);
    } else {
      failed = true;
      console.error(`  FAIL  ${where}  (${report.platform}, ${report.entryCount} entries)`);
      for (const problem of report.problems) console.error(`        - ${problem}`);
    }
  }

  if (failed) {
    console.error('\ncheck-asar: see electron-builder.yml — the `files` list is the contract.\n');
    process.exit(1);
  }
}

// Only when run as a script; the test imports the checks above.
if (process.argv[1] !== undefined && process.argv[1].endsWith('check-asar.ts')) main();

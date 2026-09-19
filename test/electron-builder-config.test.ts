/**
 * The two copies of the packaging file list, kept honest.
 *
 * `electron-builder.yml` carries the `files` list twice: once at the top level
 * and once under `win`, because a platform section's `files` REPLACES the
 * top-level list rather than extending it, and YAML can alias a sequence but not
 * append to one. (The object form that would allow an alias plus an extra entry —
 * `- from: .` / `filter: *anchor` — is rejected by electron-builder's own schema
 * for a platform section, verified 2026-09-08.)
 *
 * Duplication that nobody checks is duplication that drifts, and the drift here
 * is expensive: the Windows list held only `'!node_modules/get-windows/**\/*'`,
 * which electron-builder read as "the whole project directory except that", so
 * every Windows installer shipped `/src`, `/test`, `/art`, `/design`, `/docs`,
 * `/scripts`, the tsconfigs and the README inside `app.asar`. This test is the
 * cheap half of the guard (`npm run check:asar`, wired to `postdist:*`, is the
 * half that reads the archive that was really built).
 *
 * The YAML is read with a five-line indentation-aware reader rather than a
 * library: the only structure needed is "the list items under this key", and
 * `js-yaml` exists in this tree solely as a transitive dependency of
 * electron-builder, which is not something a test should rely on.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(root, 'electron-builder.yml');

/** The Windows-only line, and the only difference the two lists may have. */
const WINDOWS_ONLY = "'!node_modules/get-windows/**/*'";

/**
 * The `- …` items directly under `key:` at `indent` spaces, comments and blank
 * lines dropped. Stops at the first line that is not an item, a comment or a
 * blank at that indentation — which is the next key at the same or lower level.
 */
function listUnder(yaml: string, key: string, indent: number): string[] {
  const lines = yaml.split('\n');
  const head = `${' '.repeat(indent)}${key}:`;
  const at = lines.findIndex((line) => line === head);
  expect(at, `${key}: not found at indent ${indent}`).toBeGreaterThanOrEqual(0);

  const pad = ' '.repeat(indent + 2);
  const items: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '') continue;
    if (line.startsWith(`${pad}#`)) continue;
    if (!line.startsWith(`${pad}- `)) break;
    items.push(line.slice(pad.length + 2).trim());
  }
  return items;
}

describe('electron-builder.yml', () => {
  const yaml = readFileSync(CONFIG, 'utf8');

  it('gives Windows the whole top-level list, not just a negation', () => {
    const shared = listUnder(yaml, 'files', 0);
    const windows = listUnder(yaml, 'files', 2);

    // The failure this exists for: a Windows list that is only exclusions means
    // "ship everything else", i.e. the entire working tree.
    expect(windows.every((entry) => entry.startsWith("'!"))).toBe(false);
    expect(windows).toEqual([...shared, WINDOWS_ONLY]);
  });

  it('actually ships something, so neither list can be emptied by accident', () => {
    const shared = listUnder(yaml, 'files', 0);
    expect(shared).toContain('out/**/*');
    expect(shared).toContain('package.json');
    expect(shared).toContain('node_modules/**/*');
  });

  /*
   * THE SIGNING PAIR, which is one fact spread over two files.
   *
   * `identity: null` makes electron-builder SKIP signing, and what ships then is
   * the Electron binary's own linker signature: `Identifier=Electron`, `Sealed
   * Resources=none`. A quarantined copy of that bundle — i.e. any download —
   * makes macOS report **"Walder is damaged"**, a dialog with no Open Anyway
   * button. Every release through 0.2.2 shipped that way.
   *
   * `"-"` (ad-hoc) confers no trust and is not a certificate; it makes the
   * bundle coherent, so Gatekeeper's refusal is the ordinary one that System
   * Settings ▸ Privacy & Security ▸ Open Anyway clears. It only signs successfully
   * because `dist:mac` packages outside
   * the iCloud-synced working tree — see `//dist-mac-tmpdir` in package.json.
   * Neither half is any use alone, so both are pinned here.
   */
  it('signs the mac bundle ad-hoc rather than skipping signing', () => {
    // Settings only. The prose above `identity` quotes the old value, so a plain
    // substring search over the file would match its own explanation.
    const settings = yaml.split('\n').filter((line) => !line.trim().startsWith('#'));
    expect(settings).toContain('  identity: "-"');
    expect(settings.join('\n')).not.toContain('identity: null');
    // The hardened runtime is a notarisation requirement; with an ad-hoc
    // signature electron-builder warns it can stop the app launching.
    expect(settings).toContain('  hardenedRuntime: false');
  });

  /*
   * THE SIGNED OVERLAY (P1-14), prepared before a certificate existed. It must
   * extend the default rather than copy it — a second file list would drift —
   * and it must turn on exactly the signing half. The entitlements it names are
   * committed (the only thing in build/ that is) and hold the two JIT keys the
   * hardened runtime demands of Electron, and no sandbox.
   */
  it('has a signed overlay that extends the default and turns the signing half on', () => {
    const signed = readFileSync(join(root, 'electron-builder.signed.yml'), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'));
    expect(signed).toContain('extends: ./electron-builder.yml');
    expect(signed).toContain('  identity: Developer ID Application');
    expect(signed).toContain('  hardenedRuntime: true');
    expect(signed).toContain('  notarize: true');
    expect(signed).toContain('  entitlements: build/entitlements.mac.plist');
    expect(signed.join('\n')).not.toContain('files:');

    // Keys only: the plist's own comment names the sandbox key to say why it
    // is absent, which a whole-file search would read as its presence.
    const keys = Array.from(
      readFileSync(join(root, 'build/entitlements.mac.plist'), 'utf8').matchAll(/<key>([^<]+)<\/key>/g),
      (m) => m[1]
    );
    expect(keys).toEqual([
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory'
    ]);

    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const signedScript: string = pkg.scripts['dist:mac:signed'];
    expect(signedScript).toContain('--config electron-builder.signed.yml');
    expect(signedScript).not.toContain('CSC_IDENTITY_AUTO_DISCOVERY=false');
    expect(pkg.scripts['postdist:mac:signed']).toContain('check:signed');
    for (const tool of ['codesign --verify --deep --strict', 'spctl --assess --type execute', 'stapler validate']) {
      expect(pkg.scripts['check:signed']).toContain(tool);
    }
  });

  it('packages macOS outside the working tree, where nothing re-stamps FinderInfo', () => {
    const pkg = readFileSync(join(root, 'package.json'), 'utf8');
    const distMac: string = JSON.parse(pkg).scripts['dist:mac'];
    // The output directory must be an absolute path outside the repository —
    // inside it, iCloud's file provider re-stamps `com.apple.FinderInfo` on every
    // `.app` within a second, and `codesign` refuses to sign through it.
    expect(distMac).toContain('--config.directories.output=');
    expect(distMac).toContain('${TMPDIR:-/tmp}/walder-dist');
    // …and the artifacts must come back, because check:asar and `npm run
    // release` both read `release/`.
    expect(distMac).toContain('ditto');
    expect(distMac).toMatch(/ditto .*walder-dist.* release$/);
  });

  it('keeps the native build tooling out of both platforms', () => {
    // `check:asar` asserts the same thing on the built archive; this says it at
    // the level someone edits, so deleting a line here fails immediately rather
    // than at the end of the next packaging run.
    for (const pattern of [
      "'!node_modules/@mapbox/**/*'",
      "'!node_modules/node-gyp/**/*'",
      "'!node_modules/node-addon-api/**/*'"
    ]) {
      expect(listUnder(yaml, 'files', 0), pattern).toContain(pattern);
    }
  });
});

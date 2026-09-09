/**
 * The version comparison behind the update check.
 *
 * It gets its own suite because its *input is remote*: the version it compares
 * against the running app comes out of a GitHub API response, so the parser has
 * to be total. Every case below that ends in `null` or `false` is a case where
 * the alternative is Walder telling the owner to download something on the
 * strength of a string nobody can read.
 */
import { describe, expect, it } from 'vitest';
import { compareSemver, isNewerVersion, parseSemver } from '../src/core/semver';

describe('parseSemver', () => {
  it('reads a plain version', () => {
    expect(parseSemver('0.1.3')).toEqual({ major: 0, minor: 1, patch: 3, prerelease: null });
    expect(parseSemver('10.20.30')).toEqual({
      major: 10,
      minor: 20,
      patch: 30,
      prerelease: null
    });
  });

  it('reads a git tag, because that is the form the release arrives in', () => {
    // The app's own version is `0.1.2` (package.json) and the release's is
    // `v0.1.2` (the tag). The two have to compare equal.
    expect(parseSemver('v0.1.3')).toEqual(parseSemver('0.1.3'));
    expect(parseSemver('  v0.1.3  ')).toEqual(parseSemver('0.1.3'));
  });

  it('keeps a prerelease suffix', () => {
    expect(parseSemver('0.2.0-beta.1')?.prerelease).toBe('beta.1');
    expect(parseSemver('1.0.0-rc-2')?.prerelease).toBe('rc-2');
  });

  it('returns null for anything it does not understand', () => {
    for (const value of [
      '',
      'nightly',
      'v0.2',
      '0.1',
      '1.2.3.4',
      '1.2.x',
      // Build metadata is rejected rather than ignored: Walder never produces
      // one, so a tag carrying it is not a release this app knows about.
      '1.2.3+abc',
      'v1.2.3-',
      '-1.2.3',
      '1234567.0.0'
    ]) {
      expect(parseSemver(value), value).toBeNull();
    }
    expect(parseSemver(null)).toBeNull();
    expect(parseSemver(123)).toBeNull();
    expect(parseSemver({ tag_name: 'v1.0.0' })).toBeNull();
  });
});

describe('compareSemver', () => {
  const of = (value: string): ReturnType<typeof parseSemver> & object => {
    const parsed = parseSemver(value);
    if (parsed === null) throw new Error(`not a version: ${value}`);
    return parsed;
  };

  it('orders by major, then minor, then patch', () => {
    expect(compareSemver(of('1.0.0'), of('0.9.9'))).toBe(1);
    expect(compareSemver(of('0.2.0'), of('0.1.9'))).toBe(1);
    expect(compareSemver(of('0.1.3'), of('0.1.2'))).toBe(1);
    expect(compareSemver(of('0.1.2'), of('0.1.3'))).toBe(-1);
    expect(compareSemver(of('0.1.2'), of('v0.1.2'))).toBe(0);
  });

  it('numbers a version part rather than comparing it as text', () => {
    // `10` after `9`, not before it, which a string sort would get wrong.
    expect(compareSemver(of('0.10.0'), of('0.9.0'))).toBe(1);
    expect(compareSemver(of('0.1.10'), of('0.1.9'))).toBe(1);
  });

  it('ranks a prerelease below the release of the same numbers', () => {
    // This is what stops `0.2.0-beta.1` being offered to somebody already
    // running `0.2.0`.
    expect(compareSemver(of('0.2.0-beta.1'), of('0.2.0'))).toBe(-1);
    expect(compareSemver(of('0.2.0'), of('0.2.0-beta.1'))).toBe(1);
  });

  it('orders prerelease identifiers the way the spec does', () => {
    expect(compareSemver(of('1.0.0-beta.2'), of('1.0.0-beta.11'))).toBe(-1);
    expect(compareSemver(of('1.0.0-beta'), of('1.0.0-beta.2'))).toBe(-1);
    expect(compareSemver(of('1.0.0-alpha'), of('1.0.0-beta'))).toBe(-1);
    // A numeric identifier ranks below an alphanumeric one.
    expect(compareSemver(of('1.0.0-1'), of('1.0.0-alpha'))).toBe(-1);
    expect(compareSemver(of('1.0.0-rc.1'), of('1.0.0-rc.1'))).toBe(0);
  });
});

describe('isNewerVersion', () => {
  it('answers the one question the update check asks', () => {
    expect(isNewerVersion('v0.1.3', '0.1.2')).toBe(true);
    expect(isNewerVersion('v0.1.2', '0.1.2')).toBe(false);
    expect(isNewerVersion('v0.1.1', '0.1.2')).toBe(false);
  });

  it('is false whenever either side is unreadable', () => {
    // Doing nothing is invisible; sending the owner to a download page on the
    // strength of a garbled tag is not.
    expect(isNewerVersion('nightly', '0.1.2')).toBe(false);
    expect(isNewerVersion('v0.1.3', 'unknown')).toBe(false);
    expect(isNewerVersion(undefined, '0.1.2')).toBe(false);
    expect(isNewerVersion('v0.1.3', null)).toBe(false);
  });
});

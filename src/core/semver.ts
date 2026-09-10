/**
 * Just enough semantic versioning to answer one question: is the release GitHub
 * is telling us about newer than the app that is running?
 *
 * A hand-written parser rather than a dependency, for two reasons. The
 * comparison is fifteen lines and this is the whole of what Walder needs — no
 * ranges, no satisfies, no coercion. And the *input is remote and untrusted*: it
 * is a `tag_name` out of a GitHub API response, so the parser has to be strict
 * and total, returning `null` for anything it does not understand rather than
 * throwing inside a poll or, worse, guessing. A library would do more and be
 * harder to be sure of.
 *
 * Pure, no Electron, no clock.
 */

export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /**
   * The `-beta.2` part, or `null` for a plain release. Kept as written, because
   * the identifiers are compared individually (see `compareSemver`).
   */
  readonly prerelease: string | null;
}

/**
 * `0.1.3`, `v0.1.3`, `0.2.0-beta.1` — and `null` for everything else.
 *
 * The leading `v` is accepted because that is how git tags are written and how
 * `npm version` writes them, and the two forms have to compare equal: the app's
 * own version comes from `package.json` (`0.1.2`) and the release's from a tag
 * (`v0.1.2`).
 *
 * Build metadata (`+sha`) is rejected rather than ignored. Walder never
 * produces one, so a tag carrying one is not a release this app understands, and
 * "do not offer an update" is the safe answer for anything unexpected.
 */
export function parseSemver(value: unknown): Semver | null {
  if (typeof value !== 'string') return null;
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?$/.exec(
    value.trim()
  );
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null
  };
}

/** `-1`, `0` or `1`, for a sort. */
function cmp(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Compare two dot-separated prerelease identifier lists, per the spec: numeric
 * identifiers compare numerically and rank below alphanumeric ones, and a
 * shorter list ranks below an otherwise-equal longer one — so `1.0.0-beta` is
 * older than `1.0.0-beta.2`.
 */
function comparePrerelease(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const one = left[index];
    const two = right[index];
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    const oneNumeric = /^\d+$/.test(one);
    const twoNumeric = /^\d+$/.test(two);
    if (oneNumeric && twoNumeric) {
      const byNumber = cmp(Number(one), Number(two));
      if (byNumber !== 0) return byNumber;
      continue;
    }
    if (oneNumeric !== twoNumeric) return oneNumeric ? -1 : 1;
    if (one !== two) return one < two ? -1 : 1;
  }
  return 0;
}

/**
 * `-1` when `a` is older, `1` when newer, `0` when the same release.
 *
 * A prerelease is *older* than the plain release of the same numbers, which is
 * what stops `0.2.0-beta.1` being offered to someone already running `0.2.0`.
 */
export function compareSemver(a: Semver, b: Semver): number {
  const byNumbers =
    cmp(a.major, b.major) || cmp(a.minor, b.minor) || cmp(a.patch, b.patch);
  if (byNumbers !== 0) return byNumbers;
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Is `candidate` a release worth telling the owner about, given that he is
 * running `current`?
 *
 * `false` for anything unparseable on either side — a garbled tag, a missing
 * `package.json` version, an object where a string was expected. Offering an
 * update on a version nobody can read would send the owner to a download page
 * for no reason, and doing nothing is invisible.
 */
export function isNewerVersion(candidate: unknown, current: unknown): boolean {
  const next = parseSemver(candidate);
  const now = parseSemver(current);
  if (next === null || now === null) return false;
  return compareSemver(next, now) > 0;
}

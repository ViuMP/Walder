/**
 * Usage buckets — pure parsing/formatting. No electron, no network, no I/O.
 *
 * A "bucket" is one rate-limit window reported by a provider (Claude's 5-hour
 * window, Claude's 7-day window, a per-model 7-day window, ChatGPT's windows).
 * Provider payloads are treated as untrusted and shape-unstable: every parser
 * here must survive missing, renamed, extra or wrongly-typed fields by skipping
 * what it cannot read rather than throwing.
 */

export type SourceStatus =
  | 'ok'
  | 'auth-needed'
  | 'endpoint-changed'
  | 'rate-limited'
  | 'error'
  | 'unavailable';

/** e.g. 'claude.five_hour', 'claude.seven_day_opus', 'chatgpt.primary'. */
export type BucketId = string;

export interface Bucket {
  id: BucketId;
  service: 'claude' | 'chatgpt';
  key: string;
  label: string;
  /** 0-100, rounded to 1 decimal. `null` when the provider gave no number. */
  pct: number | null;
  /** ISO 8601 string, or `null` when unknown. */
  resetsAt: string | null;
  priority: number;
  /**
   * True when Walder derived this row instead of reading it from a provider.
   *
   * There is exactly one today: the "7-day Fable" row, which the dashboard shows
   * but the usage endpoint does not report (see `withDerivedFableRow`). A derived
   * row is real information — it is the shared weekly pool, read off the row that
   * *is* reported — but it is not an independent allowance, so anything that must
   * not double-count a window filters these out. The panel marks them, and
   * `core/behaviour.ts` keeps them out of the bark machine.
   */
  derived?: boolean;
  raw?: unknown;
  /**
   * What kind of allowance this row is. Absent is equivalent to `'window'`,
   * which is what every rate-limit row is; the two other kinds each carry
   * their own detail object below.
   */
  kind?: BucketKind;
  /**
   * The money detail of a `kind: 'money'` row — today only claude.ai's "Extra
   * usage" spend against its monthly cap (see `parseExtraUsage`).
   *
   * `pct` still carries `spent / limit × 100`, so the bar, the bark machine and
   * `formatPct` need to know nothing about money at all; this object is what
   * lets the card print the amounts themselves ("123 / 500 kr.") instead of a
   * bare percentage, which on a spend cap is the less useful half of the fact.
   */
  money?: MoneyDetail;
  /**
   * The balance detail of a `kind: 'credits'` row — today only the Codex credit
   * pool (see `parseCodexCredits`).
   *
   * A balance is *not* a percentage of anything we are told about: the payload
   * gives what is left, never what the pool started at, and `spend_control.
   * individual_limit` is a monthly *spend* cap rather than the credit pool. So
   * a credits row carries `pct: null` and no bar, and this object is the whole
   * value. Honest beats decorative.
   */
  credits?: CreditsDetail;
}

/**
 * The three shapes a Walder allowance row can take.
 *
 * `'window'` is a rate-limit period that resets on a clock (Claude's
 * 5-hour/7-day windows, Codex's primary/secondary windows). `'money'` is a
 * spend against a cap (claude.ai "Extra usage"). `'credits'` is a remaining
 * balance with no known denominator (the Codex credit pool). They differ in
 * what a percentage *means* for them, which is why several places — the bark
 * filter, `pctForFace`, the card's value column — branch on this and not on
 * the id.
 */
export type BucketKind = 'window' | 'money' | 'credits';

/** Spend against a cap, in whatever currency the provider reports. */
export interface MoneyDetail {
  /** Spent so far this period. Finite, ≥ 0, in major units. */
  readonly spent: number;
  /** The cap. Finite, > 0, in the same units as `spent`. */
  readonly limit: number;
  /** ISO 4217, upper case — `USD`, `DKK`, `EUR`. */
  readonly currency: string;
}

/** A remaining balance of service-side credits. */
export interface CreditsDetail {
  /** Credits left, or `null` when the provider reports the pool but no number. */
  readonly balance: number | null;
  /** The account has no cap on credits, so `balance` means nothing. */
  readonly unlimited: boolean;
  /** Nothing left to spend — the one thing worth barking about. */
  readonly exhausted: boolean;
  /** Provider's own estimate of the messages the balance buys, when given. */
  readonly approxCloudMessages?: number;
}

/**
 * The Claude bucket keys Walder shows, and how.
 *
 * This is the allow-list a hover card is built from: **only** a key in this
 * table, or matching `KNOWN_PATTERNS` below, ever reaches the card. Everything
 * else the endpoint hands back is reported once through `ClaudeParseOptions.
 * onIgnored` (shape only) and then dropped.
 *
 * That is the opposite of how this file used to work, and the reason is
 * `amber_ladder`. On 2026-09-10 the owner's account started reporting a fourth
 * Claude key beside `five_hour`, `seven_day` and the already-known
 * `nimbus_quill`: `{ utilization: 0, resets_at: <month-end> }`. The *old*
 * `looksLikeWindow` rule — keep anything with a reset time or nonzero usage —
 * was written to protect a real window Anthropic might add from being dropped
 * as noise, and it worked exactly as designed: `amber_ladder` has a reset time,
 * so it was kept, humanised, and shown on the card as "Amber ladder 0%,
 * resets in …" — a permanently-empty row about nothing, right next to Fable
 * and the 5-hour window the owner actually watches. A keep-by-default rule
 * cannot tell a new *allowance* from a new *codename*; only a name can, and
 * Anthropic has now shipped two of the latter (`nimbus_quill`, `amber_ladder`)
 * to one of the former. So the policy inverts: show only what is named here,
 * plus a weekly window for a *named* model family (`CLAUDE_WINDOW_FAMILIES`)
 * or a Fable-named key (`KNOWN_PATTERNS`). Not "anything shaped like a weekly
 * window": the live payload also carries `seven_day_cowork`,
 * `seven_day_omelette` and `seven_day_breakdown`, which is the same lesson a
 * level down — the shape of a key proves nothing, the family name in it does.
 */
export const CLAUDE_WINDOW_MAP: Record<string, { label: string; priority: number; kind: 'window' }> = {
  five_hour: { label: '5-hour', priority: 0, kind: 'window' },
  seven_day_fable: { label: '7-day Fable', priority: 1, kind: 'window' },
  seven_day_opus: { label: '7-day Opus', priority: 2, kind: 'window' },
  seven_day: { label: '7-day (all models)', priority: 3, kind: 'window' },
  seven_day_sonnet: { label: '7-day Sonnet', priority: 5, kind: 'window' }
};

/**
 * The label view of `CLAUDE_WINDOW_MAP`, kept under its old name so nothing
 * that already reads `KNOWN[key]` for a display label has to change.
 */
export const KNOWN: Record<string, string> = Object.fromEntries(
  Object.entries(CLAUDE_WINDOW_MAP).map(([key, spec]) => [key, spec.label])
);

/**
 * The Anthropic model families a `seven_day_<family>` key is allowed to name.
 *
 * This list — not the *shape* `seven_day_<word>` — is what makes a weekly
 * per-model key genuine. The owner's live payload (2026-09-10) settled the
 * question: beside `five_hour`, `seven_day`, `seven_day_opus` and
 * `seven_day_sonnet` it also carries `seven_day_cowork`, `seven_day_omelette`
 * and `seven_day_breakdown` — three `seven_day_…` keys that are **not**
 * allowances (the last one is a container of other things entirely). An open
 * `^seven_day_…$` pattern kept all three, which is the `amber_ladder` mistake
 * again one level down: the shape of a key cannot tell an allowance from a
 * codename or a container, only the name can.
 *
 * `haiku` is listed although the owner's account does not report it — it is a
 * shipped model family, so the row is real the day Anthropic starts reporting
 * it, and one word in a list is a cheaper way to be ready than a release. A
 * family Anthropic ships *later* costs exactly one line here, and until that
 * line lands the key goes through `onIgnored` and shows up in the verbose log
 * saying which word to add — which is the point: a genuinely new family is
 * visible, rather than silently kept or silently lost.
 */
export const CLAUDE_WINDOW_FAMILIES: readonly string[] = ['opus', 'sonnet', 'haiku', 'fable'];

/**
 * Key shapes that are not in `CLAUDE_WINDOW_MAP` today but are still a real
 * allowance rather than a codename.
 *
 * Two patterns, for two different reasons a key can be genuine without being
 * in the table by exact name:
 *  - a per-model 7-day window for a family in `CLAUDE_WINDOW_FAMILIES` that
 *    the table above does not spell out (`seven_day_haiku`). Anchored at both
 *    ends and closed to that list, so neither a codename nor a container can
 *    ride the pattern: `prefix_seven_day_opus`, `seven_dayopus`,
 *    `seven_day_cowork` and `seven_day_breakdown` all fail it, on purpose.
 *  - "fable" as its own underscore-delimited word. `withDerivedFableRow`'s own
 *    contract is "any spelling of a Fable key wins over the derived mirror" —
 *    and the pattern above, closed to bare family names, matches none of the
 *    spellings that carry a version or a different word order: `seven_day_
 *    fable_5`, `fable_weekly` and `weekly_fable` all fail it, and each one
 *    must still be recognised as the real thing rather than dropped as a
 *    codename that happens to be about the model the owner actually runs.
 *    Anchored the same way as `seven_day_…` above and for the same reason:
 *    bare `/fable/i` would let a codename ride the pattern by merely
 *    *containing* the letters — `notfable_ladder` is a codename, not a Fable
 *    window, and must still be rejected. `(^|_)fable(_|$)` requires "fable" to
 *    sit between underscores (or the start/end of the key), so `notfable_ladder`
 *    and `fablex` both fail it; a key that *ends* in `_fable` (`amber_fable`)
 *    still passes, which is correct — a key literally ending in `_fable` is a
 *    Fable window, whatever the rest of the name is.
 *
 * A key that matches either is humanised and prioritised the same way an
 * unknown key always was (`claudeSpecFor`, below) — this is additive to the
 * whitelist, not a second, looser one: `amber_ladder` matches neither.
 */
export const KNOWN_PATTERNS: readonly RegExp[] = [
  new RegExp(`^seven_day_(?:${CLAUDE_WINDOW_FAMILIES.join('|')})$`),
  /(^|_)fable(_|$)/i
];

/** Is this Claude key one the hover card is allowed to show? */
export function isAllowedClaudeWindow(key: string): boolean {
  if (Object.prototype.hasOwnProperty.call(CLAUDE_WINDOW_MAP, key)) return true;
  return KNOWN_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * The label and priority to show an allowed-but-unmapped key under (a
 * `KNOWN_PATTERNS` match that is not in `CLAUDE_WINDOW_MAP`): humanised name,
 * `claudePriority`'s substring heuristic. Never called for a key
 * `isAllowedClaudeWindow` rejects — those are reported through `onIgnored`
 * and dropped before a spec is ever needed for them.
 */
export function claudeSpecFor(key: string): { label: string; priority: number; kind: 'window' } {
  const known = CLAUDE_WINDOW_MAP[key];
  if (known !== undefined) return known;
  return { label: humanize(key), priority: claudePriority(key), kind: 'window' };
}

/**
 * A Claude key `parseClaudeUsage` dropped because it is not on the whitelist.
 *
 * Shape only, by construction: a boolean and a date, never the percentage or
 * the raw payload. That is enough for `usage-diagnostics.ts` to write a line a
 * developer can act on ("is this a new model window or another codename?")
 * without this parser ever having to know it might be logged, or the log ever
 * being able to carry a real usage number.
 */
export interface IgnoredWindow {
  readonly key: string;
  /**
   * Always `true` from `parseClaudeUsage` today: an entry reaches the
   * whitelist check at all only after `asFiniteNumber(value['utilization'])`
   * has already come back non-null (see the malformed-entry drop above that),
   * so by the time `onIgnored` is called `utilization` is guaranteed present.
   * The field stays in the shape anyway — it is part of what `ignoredWindowLine`
   * reports, and a future caller (or a differently-shaped provider) that can
   * legitimately see an unknown key with no usage number should not have to
   * change this interface to say so. Treat "false" here as reserved wording,
   * not a case production code currently produces.
   */
  readonly hasUtilization: boolean;
  /** `'YYYY-MM-DD'`, or `null` when the entry had no reset time at all. */
  readonly resetsOn: string | null;
}

/**
 * Keys the Claude usage endpoint reports that are **not** allowances, and are
 * dropped unconditionally and silently — never even passed to `onIgnored`.
 *
 * `nimbus_quill` was found on the owner's own account (claude.ai, Team plan,
 * 2026-09-09): it comes back as `{ utilization: 0, resets_at: null }` and
 * corresponds to **nothing** on the usage dashboard — not a window, not a model,
 * not a pool. It is an internal flag of some sort, and a permanently empty
 * "Nimbus quill 0 %" row on the hover card is worse than no row: it invites the
 * owner to work out what it means, and the answer is that it means nothing to
 * him. `amber_ladder` (2026-09-10, see `CLAUDE_WINDOW_MAP`'s comment) is the
 * same class of thing, but is deliberately *not* added here: it still goes
 * through `onIgnored` once per run, because a second codename in one month is
 * worth a line in the log, where a `nimbus_quill` seen and understood many
 * poll cycles ago is not.
 *
 * This set is documentation of the ones already identified and silenced, not
 * the mechanism that catches new ones — that is `isAllowedClaudeWindow` plus
 * `onIgnored`. If Anthropic ever gives `nimbus_quill` a meaning, take it out of
 * here — the drop is deliberate, not a fallback.
 */
export const IGNORED_KEYS = new Set<string>(['nimbus_quill']);

/** 'seven_day_haiku' -> 'Seven day haiku'. */
export function humanize(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim().toLowerCase();
  if (words.length === 0) return key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asIsoOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/** Does this reset string actually parse to an instant? */
function isRealTimestamp(iso: string | null): boolean {
  return iso !== null && Number.isFinite(Date.parse(iso));
}

/** Clamp to 0-100 and round to one decimal. */
function normalisePct(v: number): number {
  const clamped = Math.min(100, Math.max(0, v));
  return Math.round(clamped * 10) / 10;
}

function claudePriority(key: string): number {
  if (key.includes('five_hour')) return 0;
  if (key.includes('fable')) return 1;
  if (key.includes('opus')) return 2;
  if (key === 'seven_day') return 3;
  return 5;
}

/**
 * How to read Claude's `utilization` numbers.
 *
 * - `'percent'` (the default): 0-100, which is what Anthropic's endpoint
 *   actually returns. A genuine `{ five_hour: { utilization: 1 } }` therefore
 *   means 1 %, not 100 %.
 * - `'fraction'`: 0-1, scaled by 100 — for a caller that *knows* the payload is
 *   fractional.
 * - `'auto'`: guess, but only on positive evidence (see `looksFractional`).
 */
export interface ClaudeParseOptions {
  scale?: 'percent' | 'fraction' | 'auto';
  /**
   * Told about every key `isAllowedClaudeWindow` rejected (after `IGNORED_KEYS`
   * and malformed entries are already gone) — shape only, see `IgnoredWindow`.
   * Wired up to a `vlog` line in `main/provider-chains.ts`; left `undefined`
   * here for every test that does not care, and for the probe script, which
   * has no logger to hand it.
   */
  onIgnored?: (window: IgnoredWindow) => void;
  /**
   * Add the derived "7-day Fable" mirror row when the payload carries no real
   * Fable window (`withDerivedFableRow`). Default `true`.
   *
   * `false` is for a caller that merges several bucket lists *before* deciding
   * — the mirror must be suppressed by a real Fable row from anywhere in the
   * merged set, and a mirror already invented by one half of that merge cannot
   * be un-invented by the other half.
   */
  derive?: boolean;
  /**
   * The clock, for the one case that needs one: a `limits[]` entry that states
   * its reset as an offset ("resets in 3600 s") rather than a timestamp. The
   * documented top-level windows always give an ISO string, so nothing else
   * here consults it. Injected rather than read from `Date.now()` so a test
   * that asserts a reset time is not a test of when it ran.
   */
  now?: Date;
}

/**
 * True only when the payload gives positive evidence of being fractional:
 * every value is <= 1 *and* at least one is a non-integer strictly between 0
 * and 1. Requiring that non-integer is what stops a real low-usage percent
 * payload (`{ five_hour: 1, seven_day: 0 }` = 1 % and 0 %) from being inflated
 * to 100 % and 0 % — the false positive that would make Walder bark about an
 * almost-empty window.
 */
function looksFractional(values: number[]): boolean {
  if (values.length === 0) return false;
  if (!values.every((v) => v <= 1)) return false;
  return values.some((v) => v > 0 && v < 1 && !Number.isInteger(v));
}

/** The `resets_at` half of an `IgnoredWindow`: a bare date, or `null`. */
function resetsOnDate(resetsAt: string | null): string | null {
  if (!isRealTimestamp(resetsAt)) return null;
  // `resetsAt` is known parseable at this point; the ISO date prefix is all a
  // log line needs, and it is timezone-stable in a way a formatted local date
  // is not.
  return new Date(resetsAt as string).toISOString().slice(0, 10);
}

/**
 * Parse Claude's OAuth usage payload: an object keyed by bucket name, each
 * `{ utilization, resets_at }`.
 *
 * Utilization is read as a percentage by default, because that is what the
 * endpoint returns. Fraction handling is opt-in via `scale` rather than
 * inferred, so a quiet window is never mistaken for a full one.
 *
 * Three things sit on top of the raw read, applied in this order and each for
 * a different reason: an entry with no readable `utilization` at all is
 * malformed and is dropped without a word (there is no shape worth reporting —
 * `{}` is not a window that got rejected, it is not a window); `IGNORED_KEYS`
 * drops the codenames already identified and understood, just as silently;
 * everything else has to be `isAllowedClaudeWindow` or it is reported once
 * through `onIgnored` and dropped. `withDerivedFableRow` then adds the Fable
 * row the dashboard shows and the payload does not.
 */
export function parseClaudeUsage(json: unknown, opts: ClaudeParseOptions = {}): Bucket[] {
  if (!isPlainObject(json)) return [];

  const found = findTopLevelWindows(json, opts);
  // The same payload's per-model array, merged here rather than by the caller:
  // it is one document and one scale decision, and a caller that had to
  // remember to call both would eventually forget (which is exactly how the
  // Fable row went unnoticed for a month — see `parseClaudeLimits`).
  const taken = new Set(found.map((f) => f.key));
  for (const entry of findLimitWindows(json, opts)) {
    // A top-level window wins over a `limits[]` entry naming the same key:
    // that shape is the documented one, and duplicating a row would put two
    // identical entries on the card and two identical barks in the queue.
    if (taken.has(entry.key)) continue;
    taken.add(entry.key);
    found.push(entry);
  }

  if (found.length === 0) return [];

  const buckets = bucketsFromFound(found, opts);
  return opts.derive === false ? buckets : withDerivedFableRow(buckets);
}

/** One window read out of a payload, before the scale decision is applied. */
interface FoundWindow {
  readonly key: string;
  readonly utilization: number;
  readonly resetsAt: string | null;
  readonly raw: unknown;
}

/** The `{ five_hour: {utilization, resets_at}, … }` half of a usage payload. */
function findTopLevelWindows(
  json: Record<string, unknown>,
  opts: ClaudeParseOptions
): FoundWindow[] {
  const found: FoundWindow[] = [];
  for (const [key, value] of Object.entries(json)) {
    if (!isPlainObject(value)) continue;
    const utilization = asFiniteNumber(value['utilization']);
    // Malformed first, and silently: an entry with no number at all is not a
    // window anybody is choosing to hide, it is nothing to hide it from.
    if (utilization === null) continue;
    if (IGNORED_KEYS.has(key)) continue;
    const resetsAt = asIsoOrNull(value['resets_at']);
    if (!isAllowedClaudeWindow(key)) {
      // Always `hasUtilization: true` here — see `IgnoredWindow`'s doc comment:
      // the `utilization === null` check above already dropped anything without
      // a number before this branch is reachable.
      opts.onIgnored?.({ key, hasUtilization: true, resetsOn: resetsOnDate(resetsAt) });
      continue;
    }
    found.push({ key, utilization, resetsAt, raw: value });
  }
  return found;
}

/** Apply the scale decision to a set of found windows and label them. */
function bucketsFromFound(found: readonly FoundWindow[], opts: ClaudeParseOptions): Bucket[] {
  const mode = opts.scale ?? 'percent';
  const asFractions =
    mode === 'fraction' || (mode === 'auto' && looksFractional(found.map((f) => f.utilization)));
  const scale = asFractions ? 100 : 1;

  return found.map((f) => {
    const spec = claudeSpecFor(f.key);
    return {
      id: `claude.${f.key}`,
      service: 'claude' as const,
      key: f.key,
      label: spec.label,
      pct: normalisePct(f.utilization * scale),
      resetsAt: f.resetsAt,
      priority: spec.priority,
      kind: spec.kind,
      raw: f.raw
    };
  });
}

/* ------------------------------------------------- the per-model limits[] */

// PLACEHOLDER SHAPE — confirm against the owner's key dump (usage keys
// [claude-web]: …). Everything below `findLimitWindows` is written against a
// *researched* shape, not an observed one: public trackers (CodexBar #1851 /
// Win-CodexBar #166, 2026-09) report that `/api/organizations/{org}/usage`
// carries a `limits` array of per-model weekly carve-outs, and that this — not
// a `seven_day_fable` key — is where the Fable weekly number the dashboard
// shows actually lives. The array is documented; its field names are not. So
// the reader below matches by field-name *regex*, the way `readPct` and
// `readResetsAt` already do for ChatGPT's unstable shapes, and the fixture
// `test/fixtures/claude-web-usage-limits.json` is a guess at the spelling. If
// the real payload spells things differently, the fixture is the thing to fix;
// the parser most likely needs no change at all.

/** Top-level key that might hold the per-model array: `limits`, `model_limits`. */
const LIMITS_CONTAINER_RE = /limit/i;

/**
 * What an unnameable `limits[]` entry is reported as. A fixed string rather
 * than the entry's index, so `once()` in `usage-diagnostics.ts` dedupes a
 * payload that carries several of them into one log line instead of one per
 * entry per run.
 */
const UNNAMED_LIMIT_KEY = '(unnamed limits entry)';

/**
 * Field names inside a `limits[]` entry that might name the model, best first.
 * `model` before `name` because a payload carrying both almost certainly uses
 * `name` for a display string and `model` for the identifier we want to key on.
 */
const MODEL_NAME_FIELDS: readonly RegExp[] = [/^model(_name|_id)?$/i, /^name$/i, /^key$|^id$/i, /model/i];

/** Field names inside a `limits[]` entry that might carry the utilization. */
const LIMIT_UTILIZATION_RE = /utilization|utilisation|percent|used|usage/i;

/**
 * The utilization of one `limits[]` entry, **unscaled**.
 *
 * Deliberately not `readPct`: that one clamps and rounds on the spot, which
 * would destroy the evidence `looksFractional` needs to tell a `0.44` payload
 * from a 44 % one. The scale decision belongs to `bucketsFromFound`, over
 * every window in the document at once.
 */
function limitUtilization(entry: Record<string, unknown>): number | null {
  for (const [name, value] of Object.entries(entry)) {
    if (!LIMIT_UTILIZATION_RE.test(name)) continue;
    if (WINDOW_LENGTH_RE.test(name)) continue;
    const n = asFiniteNumber(value);
    if (n !== null) return n;
  }
  return null;
}

/** The model name of one `limits[]` entry, or `null`. */
function limitModelName(entry: Record<string, unknown>): string | null {
  for (const pattern of MODEL_NAME_FIELDS) {
    for (const [name, value] of Object.entries(entry)) {
      if (!pattern.test(name)) continue;
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
  }
  return null;
}

/**
 * A model name as a bucket key: `"Fable 5"` and `"claude-fable-5"` both become
 * `seven_day_fable`, so the entry lands on `CLAUDE_WINDOW_MAP`'s "7-day Fable"
 * row at priority 1 rather than inventing a fourth spelling of it.
 *
 * The version digits are dropped on purpose. A weekly carve-out belongs to a
 * model *family* — Anthropic ships `opus-4-5` and then `opus-5` into the same
 * dashboard row — and keying on the full identifier would give the owner a new,
 * empty row and a new bark history every time a point release lands. A leading
 * `claude_` goes for the same reason: it is on every name and distinguishes
 * nothing.
 *
 * A name that survives none of that (all digits, or punctuation only) returns
 * `null`, and so does one whose family is not in `CLAUDE_WINDOW_FAMILIES` —
 * the same list the top-level scan uses. Either way the entry is reported
 * through `onIgnored` rather than keyed on something meaningless.
 */
export function claudeLimitKey(modelName: string): string | null {
  const slug = modelName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (slug.length === 0) return null;

  // Already a window key (a payload that names `seven_day_opus` outright).
  if (Object.prototype.hasOwnProperty.call(CLAUDE_WINDOW_MAP, slug)) return slug;

  const parts = slug.split('_').filter((part) => part.length > 0 && part !== 'claude');
  // Version segments, front and back: `3_5_sonnet_20241022` -> `sonnet`.
  while (parts.length > 0 && /^\d+$/.test(parts[0] as string)) parts.shift();
  while (parts.length > 0 && /^\d+$/.test(parts[parts.length - 1] as string)) parts.pop();
  if (parts.length === 0) return null;

  const family = parts.join('_');
  if (family.startsWith('seven_day') || family.startsWith('five_hour')) return family;

  const key = `seven_day_${family}`;
  if (Object.prototype.hasOwnProperty.call(CLAUDE_WINDOW_MAP, key)) return key;

  /*
   * A codename, not a model.
   *
   * Prefixing turns *any* name into one shaped like a window key, so a
   * `limits[]` entry called `amber_ladder` would arrive on the card as "Seven
   * day amber ladder" — precisely the row Stage I exists to remove. This used
   * to be filtered by the *shape* of the name ("every model family Anthropic
   * ships is a single word; both codenames seen are two"), which read as a
   * clever heuristic and was really a coincidence: a one-word codename defeats
   * it outright, and the owner's live payload has since produced exactly that
   * (`tangelo`, and `seven_day_cowork` / `seven_day_omelette` on the top-level
   * side).
   *
   * So the same list decides here as decides there: `CLAUDE_WINDOW_FAMILIES`.
   * A family named in it is a window; anything else is reported through
   * `onIgnored` and dropped, whether it is one word or five. The cost when
   * Anthropic ships a new family is one missing row and one log line naming
   * the exact word to add; the cost the other way is a permanently meaningless
   * row nobody can explain.
   */
  if (!CLAUDE_WINDOW_FAMILIES.includes(family)) return null;
  return key;
}

/** The `limits[]` half of a usage payload, as found windows. */
function findLimitWindows(json: Record<string, unknown>, opts: ClaudeParseOptions): FoundWindow[] {
  let array: unknown[] | null = null;
  for (const [name, value] of Object.entries(json)) {
    if (!LIMITS_CONTAINER_RE.test(name)) continue;
    if (!Array.isArray(value)) continue;
    array = value;
    break;
  }
  if (array === null) return [];

  const now = opts.now ?? new Date();
  const found: FoundWindow[] = [];
  for (const entry of array) {
    if (!isPlainObject(entry)) continue;
    const utilization = limitUtilization(entry);
    // Same rule as the top-level scan: no number at all is not a window.
    if (utilization === null) continue;

    const modelName = limitModelName(entry);
    const resetsAt = readResetsAt(entry, now);
    const resetsOn = resetsOnDate(resetsAt);

    // An entry that names no model cannot be keyed, and an entry whose name
    // survives no normalisation (`"4.5"`, `"—"`) cannot either. Both are
    // reported under whatever they *did* say, so the log can be read against
    // the real payload.
    if (modelName === null) {
      opts.onIgnored?.({ key: UNNAMED_LIMIT_KEY, hasUtilization: true, resetsOn });
      continue;
    }
    const key = claudeLimitKey(modelName);
    if (key === null) {
      opts.onIgnored?.({ key: modelName, hasUtilization: true, resetsOn });
      continue;
    }
    if (IGNORED_KEYS.has(key)) continue;
    if (!isAllowedClaudeWindow(key)) {
      opts.onIgnored?.({ key, hasUtilization: true, resetsOn });
      continue;
    }
    found.push({ key, utilization, resetsAt, raw: entry });
  }
  return found;
}

/**
 * The per-model weekly windows of a Claude usage payload, on their own.
 *
 * `parseClaudeUsage` already merges these, so this is exported for the two
 * callers that want them separately: a test, and a diagnostic that asks "did
 * this payload carry a real Fable row at all?". No derived mirror is added
 * here — a `limits[]` array is half a document, and the mirror is a decision
 * about the whole one.
 */
export function parseClaudeLimits(json: unknown, opts: ClaudeParseOptions = {}): Bucket[] {
  if (!isPlainObject(json)) return [];
  return bucketsFromFound(findLimitWindows(json, opts), opts);
}

/** The key and id of the row `withDerivedFableRow` invents. */
const FABLE_KEY = 'seven_day_fable';

/**
 * Is this row about Fable's weekly allowance, however it is spelled?
 *
 * Label **or** key, and that is not belt and braces. The key side catches a
 * payload that names the window (`seven_day_fable`, `fable_weekly`); the label
 * side catches a `limits[]` entry that arrived as `{ model: "Fable 5" }` and
 * was keyed by `claudeLimitKey` — and, more importantly, a future row whose
 * key spelling nobody predicted but whose label came out of
 * `CLAUDE_WINDOW_MAP` as "7-day Fable" anyway. Either is a real Fable number,
 * and either must beat the derived mirror: showing the mirror *beside* a real
 * row would put two different percentages on the card under nearly the same
 * name, which is worse than the missing row this whole mechanism exists to fix.
 */
export function isFableRow(bucket: Bucket): boolean {
  return /fable/i.test(bucket.key) || /fable/i.test(bucket.label);
}

/**
 * Add the "7-day Fable" row, because the dashboard has one and the payload does
 * not.
 *
 * Verified on the owner's account (claude.ai, Team plan, 2026-09-09): the usage
 * response carries `five_hour` and `seven_day` and no Fable key at all, while the
 * dashboard lists a **Fable** weekly row showing the same percentage and the same
 * reset as its "All models" row. Fable draws from the shared weekly pool, so
 * there is nothing separate to report — but Fable is the model the owner actually
 * runs, and a hover card with no Fable row on it looked to him like Walder was
 * not tracking the thing he asked it to track.
 *
 * So the row is synthesised from `seven_day`, flagged `derived`, and labelled as
 * shared in the panel. It is *not* an invented number: it is the same number,
 * shown under the name the owner recognises.
 *
 * **This is a fallback, and only a fallback.** If the payload reports a real
 * Fable number anywhere — a top-level key, or (far more likely, per the
 * research) a `limits[]` entry that `parseClaudeUsage` has already merged in —
 * that one is used and nothing is synthesised. `isFableRow` decides, so any
 * spelling wins over the mirror instead of sitting beside it. Exported so a
 * caller that merges several lists can apply it once, at the end, over the
 * whole set (`parseClaudeUsage(json, { derive: false })`).
 */
export function withDerivedFableRow(buckets: Bucket[]): Bucket[] {
  if (buckets.some(isFableRow)) return buckets;
  const weekly = buckets.find((bucket) => bucket.key === 'seven_day');
  if (weekly === undefined) return buckets;

  return [
    ...buckets,
    {
      id: `claude.${FABLE_KEY}`,
      service: 'claude',
      key: FABLE_KEY,
      label: KNOWN[FABLE_KEY] ?? '7-day Fable',
      pct: weekly.pct,
      resetsAt: weekly.resetsAt,
      priority: 1,
      derived: true
      // No `raw`: there was no provider payload for this row. Leaving it absent
      // is also what keeps `trimSnapshot`'s "raw never reaches disk" rule true
      // for it by construction.
    }
  ];
}

/* ------------------------------------------------ claude.ai "Extra usage" */

// PLACEHOLDER SHAPE — confirm against the owner's key dump (usage keys
// [claude-web]: …). Two sources are researched and neither field list is
// public: an `extra_usage` object inside `/api/organizations/{org}/usage`, and
// `GET /api/organizations/{orgId}/overage_spend_limit` returning
// `{ spend, limit, enabled, reset }`. `parseExtraUsage` reads *either* — it
// looks inside a plausible container first and then at the object it was
// handed — and matches every field by name regex, so the likely outcome of the
// real shape arriving is that nothing here changes and only
// `test/fixtures/claude-web-extra-usage*.json` is corrected.

/** The one money row Walder shows, and where it sits on the card. */
export const EXTRA_USAGE_ID = 'claude.extra_usage';
export const EXTRA_USAGE_KEY = 'extra_usage';
export const EXTRA_USAGE_LABEL = 'Extra usage';
/** Last in the Claude section: it is a bill, not a window. */
const EXTRA_USAGE_PRIORITY = 6;

/**
 * Containers the spend-vs-cap block might be nested in.
 *
 * Four names, all of which mean "extra usage" specifically — and deliberately
 * **not** `spend`, `credits` or `billing`, which the first draft accepted as
 * near-synonyms. The owner's live payload settled it: it carries a top-level
 * `spend` object, and that object is the organisation's ordinary spend, not an
 * opt-in overage cap. A generous container list read it as one and would have
 * put an "Extra usage" row on the card for an account that has extra usage
 * switched off — a row that is wrong in the one direction that matters, since
 * it invites the owner to believe he is being billed for something he never
 * opted into. Anything named here is an overage block by its own name; a
 * genuinely new spelling costs one line, and until it lands the row is simply
 * absent, which is this parser's documented answer for "no extra usage".
 */
const MONEY_CONTAINER_RE = /^(extra_usage|extra_spend|overage|overage_spend_limit)$/i;
/** Field names that carry the amount spent so far. */
const SPENT_FIELD_RE = /spent|^spend|_spend$|_spend_|used_amount|current_spend|amount_used/i;
/** Field names that carry the cap. */
const MONEY_LIMIT_FIELD_RE = /limit|cap$|_cap|^cap|budget|max_spend/i;
/** Field names that carry an ISO 4217 code. */
const CURRENCY_FIELD_RE = /currency|iso_code|currency_code/i;
/** Field names that say whether extra usage is switched on at all. */
const ENABLED_FIELD_RE = /enabled|is_active|^active$|^on$|opted_in/i;
/**
 * Field names whose number is in **minor** units (cents, øre).
 *
 * Billing APIs report money as integers far more often than as decimals, and
 * reading 12_300 cents as "12300 kr." on the card would be a ludicrous and
 * completely silent error. Detected by name — the only honest signal available
 * — and never guessed from magnitude: a real 12 300 kr. cap is perfectly
 * plausible on a Team plan, so "the number is big" proves nothing.
 */
const MINOR_UNIT_FIELD_RE = /cents|_minor|minor_units|pence|øre|ore_amount/i;

/** ISO 4217 as the card is willing to print it. */
const CURRENCY_RE = /^[A-Za-z]{3}$/;

/** Default when the payload states amounts but names no currency. */
const DEFAULT_CURRENCY = 'USD';

/** The first numeric field matching `re`, converted out of minor units. */
function findAmount(obj: Record<string, unknown>, re: RegExp): number | null {
  for (const [name, value] of Object.entries(obj)) {
    if (!re.test(name)) continue;
    if (WINDOW_LENGTH_RE.test(name)) continue;
    const n = asFiniteNumber(value);
    if (n === null) continue;
    return MINOR_UNIT_FIELD_RE.test(name) ? n / 100 : n;
  }
  return null;
}

/** Read a spend-vs-cap block out of one object, or `null`. */
function readMoney(obj: Record<string, unknown>): MoneyDetail | null {
  // An explicit "off" is the whole answer: the account is not spending extra,
  // and a `0 / 0` row would claim otherwise.
  for (const [name, value] of Object.entries(obj)) {
    if (ENABLED_FIELD_RE.test(name) && value === false) return null;
  }

  const spent = findAmount(obj, SPENT_FIELD_RE);
  const limit = findAmount(obj, MONEY_LIMIT_FIELD_RE);
  // Both, or nothing. A cap with no spend is not a row anybody can read, and a
  // spend with no cap has no percentage, no bar and no threshold to bark at.
  if (spent === null || limit === null) return null;
  if (!(spent >= 0) || !(limit > 0)) return null;

  let currency = DEFAULT_CURRENCY;
  for (const [name, value] of Object.entries(obj)) {
    if (!CURRENCY_FIELD_RE.test(name)) continue;
    if (typeof value === 'string' && CURRENCY_RE.test(value.trim())) {
      currency = value.trim().toUpperCase();
      break;
    }
  }

  return { spent, limit, currency };
}

/**
 * claude.ai's "Extra usage" spend against its monthly cap, or `null`.
 *
 * `null` covers three cases that all mean the same thing to the card — **no
 * row at all**, never a `0%` one: the account has extra usage switched off,
 * the payload does not mention it, or it mentions it without amounts (which is
 * what makes the `overage_spend_limit` supplement worth a second GET).
 *
 * Accepts either payload: it looks inside a plausible container
 * (`extra_usage`, `overage`, …) first, and failing that reads the object it
 * was handed, which is the supplement's own top-level shape.
 */
export function parseExtraUsage(json: unknown): MoneyDetail | null {
  if (!isPlainObject(json)) return null;

  for (const [name, value] of Object.entries(json)) {
    if (!MONEY_CONTAINER_RE.test(name)) continue;
    if (!isPlainObject(value)) continue;
    const money = readMoney(value);
    if (money !== null) return money;
    // A container that exists but says "off" (or carries no amounts) is a
    // definite answer; do not go looking for a second opinion at top level.
    return null;
  }

  return readMoney(json);
}

/**
 * First instant of the following month, UTC — when a monthly spend cap rolls.
 *
 * UTC rather than local, like every other timestamp Walder handles, and
 * approximate by design: the endpoint does not tell us the billing anchor, and
 * "resets in 21d" is the right answer to within a day either way. The card
 * never claims a time of day for it.
 */
export function monthEndIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/**
 * The Extra usage row.
 *
 * `pct = spent / limit × 100` is the whole trick: everything downstream —
 * `barFill`, `formatPct`, the 80/85/90/95/100 barks, `formatResetsIn` — is
 * about a percentage, and a spend cap genuinely is one. So the money row needs
 * no special case anywhere except the card's value column, which prints the
 * amounts instead of the bare number.
 */
export function extraUsageBucket(money: MoneyDetail, now: Date): Bucket {
  return {
    id: EXTRA_USAGE_ID,
    service: 'claude',
    key: EXTRA_USAGE_KEY,
    label: EXTRA_USAGE_LABEL,
    pct: normalisePct((money.spent / money.limit) * 100),
    resetsAt: monthEndIso(now),
    priority: EXTRA_USAGE_PRIORITY,
    kind: 'money',
    money
  };
}

const CHATGPT_PRIORITY = 4;
/** After the two Codex windows, in the ChatGPT section. */
const CODEX_CREDITS_PRIORITY = 5;

/**
 * Field names whose bare number may be read as a percentage outright.
 *
 * `limit` and `remaining` are deliberately absent: they are *counts*, and
 * `limit_window_seconds` (604800) read as a percentage clamps to a fake 100 %.
 * A bare number is only a percentage when its name says so.
 */
const USAGE_FIELD_RE = /used|usage|utilization|percent/i;
/** Field names that plausibly carry a reset timestamp. */
const RESET_FIELD_RE = /reset/i;
/** Field names that carry a percent value outright (rather than a raw count). */
const PERCENT_FIELD_RE = /percent|utilization/i;
/**
 * Names that look quota-ish but describe a *window length*, not a quantity:
 * `limit_window_seconds`, `used_window`, `reset_after_seconds`. Never a count,
 * never a percentage.
 */
const WINDOW_LENGTH_RE = /_seconds$|_window|window_/i;

/** How trustworthy a reset value is. Higher wins. */
const RESET_TIER = { relative: 0, absolute: 1, iso: 2 } as const;
type ResetTier = (typeof RESET_TIER)[keyof typeof RESET_TIER];

/** Names that state an *offset* from now rather than a point in time. */
const RELATIVE_NAME_RE = /\b(in|after)\b|_in_|_after_|_after$|_in$|in_sec|seconds_until/i;
/** Names that state an absolute point in time. */
const ABSOLUTE_NAME_RE = /_at$|_at_|\bat\b|timestamp|epoch/i;

/**
 * Interpret one `*reset*` number. Returns the ISO string plus how absolute it
 * is, so the caller can prefer a real timestamp over an offset.
 *
 * A relative *name* wins over a large value (`reset_after_seconds` is an
 * offset even if the account has an absurd window), but a value above the
 * epoch threshold is otherwise taken as absolute even when the name is mute.
 */
function resetFromNumber(
  name: string,
  n: number,
  now: Date
): { iso: string; tier: ResetTier } | null {
  if (!Number.isFinite(n)) return null;

  const relativeByName = RELATIVE_NAME_RE.test(name) && !ABSOLUTE_NAME_RE.test(name);
  if (!relativeByName) {
    if (n > 1e12) return { iso: new Date(n).toISOString(), tier: RESET_TIER.absolute };
    if (n > 1e9) return { iso: new Date(n * 1000).toISOString(), tier: RESET_TIER.absolute };
  }
  // Either the name says "in/after", or the number is far too small to be an
  // epoch: read it as an offset in seconds.
  return {
    iso: new Date(now.getTime() + n * 1000).toISOString(),
    tier: RESET_TIER.relative
  };
}

/**
 * Read a reset timestamp from an object's own `*reset*` fields.
 *
 * Providers hand out both forms at once — the real Codex payload carries
 * `reset_after_seconds` *and* `reset_at` in the same window object — and the
 * absolute one is the only stable answer: a relative offset re-anchors to
 * whenever we happened to poll, so it drifts on every refresh and (via
 * `NudgeMachine`'s window detection) would look like an endless stream of new
 * windows. So every candidate is collected and the most absolute one wins:
 * ISO string > absolute epoch > relative offset.
 */
function readResetsAt(obj: Record<string, unknown>, now: Date): string | null {
  let bestIso: string | null = null;
  let bestTier = -1;

  for (const [name, value] of Object.entries(obj)) {
    if (!RESET_FIELD_RE.test(name)) continue;

    let candidate: { iso: string; tier: ResetTier } | null = null;

    const asStr = asIsoOrNull(value);
    if (asStr !== null) {
      candidate = { iso: asStr, tier: RESET_TIER.iso };
    } else {
      const asNum = asFiniteNumber(value);
      if (asNum !== null) candidate = resetFromNumber(name, asNum, now);
    }

    if (candidate !== null && candidate.tier > bestTier) {
      bestIso = candidate.iso;
      bestTier = candidate.tier;
    }
  }

  return bestIso;
}

/**
 * Find a numeric field whose name matches `re` but is not a window length.
 * Returns the first match, or `null`.
 */
function findCount(obj: Record<string, unknown>, re: RegExp): number | null {
  for (const [name, value] of Object.entries(obj)) {
    if (!re.test(name)) continue;
    if (WINDOW_LENGTH_RE.test(name)) continue;
    const n = asFiniteNumber(value);
    if (n !== null) return n;
  }
  return null;
}

/**
 * Derive a percentage from an object's own scalar fields.
 * Returns `undefined` when no usage-ish number is present at all (so the caller
 * can tell "no usage data" apart from "usage data we could not interpret").
 */
function readPct(obj: Record<string, unknown>): number | null | undefined {
  // 1. An explicit percent field wins, even alongside used/limit counts.
  for (const [name, value] of Object.entries(obj)) {
    if (!PERCENT_FIELD_RE.test(name)) continue;
    if (WINDOW_LENGTH_RE.test(name)) continue;
    const n = asFiniteNumber(value);
    if (n !== null) return normalisePct(n);
  }

  // 2/3. A ratio, but only when a real quota denominator is present in the
  // same object — `limit_window_seconds` is a duration, not a denominator.
  const limit = findCount(obj, /^limit|_limit$|_limit_/i);
  if (limit !== null && limit > 0) {
    const remaining = findCount(obj, /^remaining|_remaining$/i);
    if (remaining !== null) return normalisePct(((limit - remaining) / limit) * 100);

    const used = findCount(obj, /^used|_used$/i);
    if (used !== null) return normalisePct((used / limit) * 100);
  }

  // 4. Any other usage-ish number, read as a percent.
  for (const [name, value] of Object.entries(obj)) {
    if (!USAGE_FIELD_RE.test(name)) continue;
    if (WINDOW_LENGTH_RE.test(name)) continue;
    const n = asFiniteNumber(value);
    if (n !== null) return normalisePct(n);
  }

  return undefined;
}

function windowLabel(windowMinutes: number | null, key: string): string {
  if (windowMinutes === null) return `ChatGPT ${humanize(key)}`;
  if (windowMinutes <= 300) return 'ChatGPT 5-hour';
  if (windowMinutes >= 10080) return 'ChatGPT weekly';
  return `ChatGPT ${Math.round(windowMinutes / 60)}h`;
}

/** 5 hours and 7 days in seconds — the two windows Codex actually reports. */
const FIVE_HOURS_S = 21_600;
const ONE_WEEK_S = 604_800;

/** Label a Codex window from its declared length in seconds. */
function codexWindowLabel(limitWindowSeconds: number | null, key: string): string {
  if (limitWindowSeconds === null || limitWindowSeconds <= 0) return `Codex ${humanize(key)}`;
  if (limitWindowSeconds <= FIVE_HOURS_S) return 'Codex 5-hour';
  if (limitWindowSeconds >= ONE_WEEK_S) return 'Codex weekly';
  return `Codex ${Math.round(limitWindowSeconds / 3600)}h`;
}

/**
 * The window objects inside `rate_limit`, in report order.
 * Codex names them `primary_window` (the 5-hour) and `secondary_window` (the
 * weekly); the bucket key drops the `_window` suffix and gains a `codex_`
 * prefix so `chatgpt.codex_primary` can never collide with a bucket the
 * tolerant walker invents.
 */
const CODEX_WINDOWS = [
  { field: 'primary_window', key: 'codex_primary' },
  { field: 'secondary_window', key: 'codex_secondary' }
] as const;

/**
 * The real `GET /backend-api/wham/usage` shape (verified against a live
 * response, 2026-09): a single `rate_limit` object holding
 * `primary_window` / `secondary_window`, each
 * `{ used_percent, limit_window_seconds, reset_after_seconds, reset_at }`
 * where `reset_at` is a unix timestamp in **seconds**.
 *
 * Only those two windows become buckets. `credits`, `rate_limit_reset_credits`,
 * `model_usage`, `spend_control` and friends are account metadata, not usage
 * windows, and are deliberately ignored — which is also why this explicit
 * branch must run before the tolerant walker, whose `/used|usage/`-shaped
 * heuristics would happily mine buckets out of all of them.
 */
function parseCodexRateLimit(json: unknown, now: Date): Bucket[] {
  if (!isPlainObject(json)) return [];
  const rateLimit = json['rate_limit'];
  if (!isPlainObject(rateLimit)) return [];

  const out: Bucket[] = [];
  for (const { field, key } of CODEX_WINDOWS) {
    const win = rateLimit[field];
    if (!isPlainObject(win)) continue;

    const pct = asFiniteNumber(win['used_percent']);
    const windowSeconds = asFiniteNumber(win['limit_window_seconds']);
    // readResetsAt already prefers the absolute `reset_at` over the relative
    // `reset_after_seconds` that sits beside it.
    const resetsAt = readResetsAt(win, now);
    if (pct === null && resetsAt === null) continue;

    out.push({
      id: `chatgpt.${key}`,
      service: 'chatgpt',
      key,
      label: codexWindowLabel(windowSeconds, key),
      pct: pct === null ? null : normalisePct(pct),
      resetsAt,
      priority: CHATGPT_PRIORITY,
      raw: win
    });
  }
  return out;
}

/** The older Codex/ChatGPT `rate_limits` (plural) shape, if present. */
function parseCodexRateLimits(json: unknown, now: Date): Bucket[] {
  if (!isPlainObject(json)) return [];
  const limits = json['rate_limits'];
  if (!isPlainObject(limits)) return [];

  const out: Bucket[] = [];
  for (const [key, value] of Object.entries(limits)) {
    if (!isPlainObject(value)) continue;
    const pct = readPct(value);
    const resetsAt = readResetsAt(value, now);
    if (pct === undefined && resetsAt === null) continue;
    out.push({
      id: `chatgpt.${key}`,
      service: 'chatgpt',
      key,
      label: windowLabel(asFiniteNumber(value['window_minutes']), key),
      pct: pct ?? null,
      resetsAt,
      priority: CHATGPT_PRIORITY,
      raw: value
    });
  }
  return out;
}

const MAX_WALK_DEPTH = 8;

/**
 * Upper bound on how many buckets the walker may return.
 *
 * There is deliberately no key whitelist on the ChatGPT side, unlike Claude's
 * `CLAUDE_WINDOW_MAP` — the real chat-usage endpoint is still unidentified
 * (2026-09-10, see BUILD_LOG), so the walker's whole job is discovery, and
 * naming which keys are "allowed" would just be guessing at names nobody has
 * confirmed. But an unfamiliar payload can carry far more than a handful of
 * usage-shaped numbers once plan metadata, deprecated fields and per-feature
 * counters are all mined for a `used`/`limit`/`percent` name, and a card with
 * a dozen unexplained "ChatGPT …" rows is worse than a short one that missed
 * something. So everything is still found — trimming happens after, applied
 * to the same sort that decides what appears: a bucket with a real percentage
 * says more than one with only a reset time, so it is kept in preference.
 */
const MAX_WALKED_BUCKETS = 4;

/**
 * Last-resort walker for a payload whose shape we have not seen. Descends the
 * tree and emits a bucket for every object that carries a usage number and/or a
 * reset timestamp among its *own* scalar fields — so an ancestor never
 * duplicates its children. Capped at `MAX_WALKED_BUCKETS`, most-informative
 * first.
 */
function walkForBuckets(json: unknown, now: Date): Bucket[] {
  const out: Bucket[] = [];
  const seen = new Set<object>();

  const visit = (node: unknown, path: string[], depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;

    if (Array.isArray(node)) {
      if (seen.has(node)) return;
      seen.add(node);
      node.forEach((item, i) => visit(item, [...path, String(i)], depth + 1));
      return;
    }
    if (!isPlainObject(node)) return;
    if (seen.has(node)) return;
    seen.add(node);

    const pct = readPct(node);
    const resetsAt = readResetsAt(node, now);
    if (pct !== undefined || resetsAt !== null) {
      const key = path.length > 0 ? path.join('.') : 'root';
      const leaf = path.length > 0 ? (path[path.length - 1] as string) : 'root';
      out.push({
        id: `chatgpt.${key}`,
        service: 'chatgpt',
        key,
        label: `ChatGPT ${humanize(leaf)}`,
        pct: pct ?? null,
        resetsAt,
        priority: CHATGPT_PRIORITY,
        raw: node
      });
    }

    for (const [name, value] of Object.entries(node)) {
      if (isPlainObject(value) || Array.isArray(value)) visit(value, [...path, name], depth + 1);
    }
  };

  visit(json, [], 0);
  // A stable sort: buckets with a real percentage first, ties left in the
  // order the walk found them, so a payload with four or fewer candidates is
  // completely unaffected by this cap.
  out.sort((a, b) => (a.pct === null ? 1 : 0) - (b.pct === null ? 1 : 0));
  return out.slice(0, MAX_WALKED_BUCKETS);
}

/**
 * Parse a ChatGPT/Codex usage payload.
 *
 * Tried in order: the real `rate_limit` shape, the older `rate_limits` plural
 * shape, then an exhaustive walker for a payload we have not seen. Returns
 * `[]` when nothing usage-like can be found.
 *
 * `now` is only consulted for relative resets ("reset_after_seconds").
 */
export function parseChatGptUsage(json: unknown, now: Date = new Date()): Bucket[] {
  // Credits are not a window and do not belong to any of the three shapes
  // below: they are read from the payload once and appended to whichever
  // branch produced the windows.
  const credits = parseCodexCredits(json);
  const extra = credits === null ? [] : [credits];

  const real = parseCodexRateLimit(json, now);
  if (real.length > 0) return [...real, ...extra];
  const legacy = parseCodexRateLimits(json, now);
  if (legacy.length > 0) return [...legacy, ...extra];

  // The walker mines any object with a usage-ish number, `credits` included.
  // When the credits block was understood properly, its walked twin is a
  // duplicate of a row we already have and a worse one, so it is dropped.
  const walked = walkForBuckets(json, now).filter(
    (bucket) => credits === null || !bucket.key.startsWith(CODEX_CREDITS_FIELD)
  );
  return [...walked, ...extra];
}

/* ------------------------------------------------------ Codex credits row */

/** The payload field holding the credit pool, and the bucket key it becomes. */
const CODEX_CREDITS_FIELD = 'credits';
export const CODEX_CREDITS_ID = 'chatgpt.codex_credits';
export const CODEX_CREDITS_KEY = 'codex_credits';
export const CODEX_CREDITS_LABEL = 'Codex credits';

/**
 * The Codex credit balance, or `null` when the account has no credit pool.
 *
 * Read from the same `GET /backend-api/wham/usage` the windows come from — the
 * real response (fixture `codex-wham-usage.json`, verified live 2026-09)
 * carries `credits: { has_credits, unlimited, overage_limit_reached, balance,
 * approx_local_messages, approx_cloud_messages }`, which the parser used to
 * skip along with the rest of the account metadata. This is the ChatGPT side's
 * answer to Claude's Extra usage: chatgpt.com itself has no credit concept,
 * and these credits cover both the Codex CLI and the Codex cloud tasks.
 *
 * `has_credits: false` means the account has no such pool at all, and gets
 * **no row** — the same rule as Extra usage being switched off. A row reading
 * "Codex credits 0" would say something false about an account that simply
 * does not work that way.
 *
 * `balance: null` with `has_credits: true` (which is what the owner's own
 * account returns) is a pool whose size the endpoint declines to state: the
 * row appears, and its value prints as unknown rather than as zero.
 */
export function parseCodexCredits(json: unknown): Bucket | null {
  if (!isPlainObject(json)) return null;
  const block = json[CODEX_CREDITS_FIELD];
  if (!isPlainObject(block)) return null;
  if (block['has_credits'] !== true) return null;

  const unlimited = block['unlimited'] === true;
  const balance = asFiniteNumber(block['balance']);
  const approxCloudMessages = asFiniteNumber(block['approx_cloud_messages']);

  // Two ways to be out: the endpoint says so, or the balance itself says so.
  // An `unlimited` pool can never be exhausted whatever the balance field
  // holds, and an unknown balance is not evidence of an empty one.
  const exhausted =
    !unlimited && (block['overage_limit_reached'] === true || (balance !== null && balance <= 0));

  const credits: CreditsDetail = {
    balance,
    unlimited,
    exhausted,
    ...(approxCloudMessages === null ? {} : { approxCloudMessages })
  };

  return {
    id: CODEX_CREDITS_ID,
    service: 'chatgpt',
    key: CODEX_CREDITS_KEY,
    label: CODEX_CREDITS_LABEL,
    // No bar, on purpose: a balance has no denominator here. `spend_control.
    // individual_limit` is a monthly *spend* cap, not the size of the credit
    // pool, and dividing by it would draw a confident bar of a made-up ratio.
    pct: null,
    resetsAt: null,
    priority: CODEX_CREDITS_PRIORITY,
    kind: 'credits',
    credits,
    raw: block
  };
}

/** "resets in 2h 14m" / "resets in 3d 4h" / "reset pending" / "". */
export function formatResetsIn(resetsAt: string | null, now: Date): string {
  if (resetsAt === null) return '';
  const target = new Date(resetsAt).getTime();
  if (!Number.isFinite(target)) return '';

  const diffMs = target - now.getTime();
  if (diffMs <= 0) return 'reset pending';

  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  // Under a minute still reads as "1m" rather than "0m".
  return `resets in ${Math.max(1, minutes)}m`;
}

/** Flatten several bucket lists into display order: priority, then id. */
export function mergeBuckets(...lists: Bucket[][]): Bucket[] {
  return lists.flat().sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

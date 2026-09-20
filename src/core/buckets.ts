/**
 * Usage buckets — pure parsing/formatting. No electron, no network, no I/O.
 *
 * A "bucket" is one rate-limit window reported by a provider (Claude's 5-hour
 * window, Claude's 7-day window, a per-model 7-day window, ChatGPT's windows).
 * Provider payloads are treated as untrusted and shape-unstable: every parser
 * here must survive missing, renamed, extra or wrongly-typed fields by skipping
 * what it cannot read rather than throwing.
 */
import type { ServiceName } from './services';

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
  service: ServiceName;
  key: string;
  label: string;
  /** 0-100, rounded to 1 decimal. `null` when the provider gave no number. */
  pct: number | null;
  /** ISO 8601 string, or `null` when unknown. */
  resetsAt: string | null;
  priority: number;
  /**
   * `resetsAt` is Walder's arithmetic, not the provider's figure.
   *
   * Set on exactly one row today — Extra usage, whose payload carries a
   * `monthly_limit` and no date of any kind (see `extraUsageBucket`). The card
   * appends `(est.)` to the line when it is set, which is the whole reason the
   * flag travels with the bucket rather than being re-derived by the painter:
   * "did a human tell us this or did we work it out" is a property of where the
   * number came from, and nothing downstream can recover it from an ISO string.
   *
   * Only ever `true`. An absent flag means the provider stated the date, which
   * is the case for every other row and must stay the default.
   */
  resetsEstimated?: true;
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
  /** The count behind a `kind: 'tokens'` row; see `TokensDetail`. */
  tokens?: TokensDetail;
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
export type BucketKind = 'window' | 'money' | 'credits' | 'tokens';

/**
 * The detail of a `kind: 'tokens'` row: tokens consumed since local midnight,
 * summed from the CLI's own transcripts on this machine (`core/local-tokens.ts`).
 *
 * Not a percentage of anything — no plan states a token allowance — so the row
 * carries `pct: null`, no bar, and never barks. `total` counts every token the
 * API billed for: input, cache writes, cache reads and output, the same sum the
 * CLIs themselves report as "total".
 */
export interface TokensDetail {
  /** Finite integer, ≥ 0. */
  readonly total: number;
}

/** Spend against a cap, in whatever currency the provider reports. */
export interface MoneyDetail {
  /** Spent so far this period. Finite, ≥ 0, in major units. */
  readonly spent: number;
  /**
   * The cap, or `null` when the account has none.
   *
   * Nullable since the real claude.ai shape was confirmed (2026-09-10). The
   * owner's own account has extra usage **enabled with `monthly_limit: null`**
   * — he is spending against no cap at all, which the guessed shape treated as
   * unreadable and dropped, hiding a real bill. A `null` here is not "we could
   * not find the number": it is the provider stating there is nothing to be a
   * percentage *of*, so the row carries `pct: null`, draws no bar and crosses
   * no threshold. Reading it as `0` would be worse still — an infinite
   * percentage and a permanently-red bar.
   */
  readonly limit: number | null;
  /** ISO 4217, upper case — `USD`, `DKK`, `EUR`. */
  readonly currency: string;
  /**
   * claude.ai's own `spend_limit_reached`: the cap is hit and further extra
   * usage is refused.
   *
   * Present only when true, exactly like `CreditsDetail.approxCloudMessages`
   * below — absent means "not reached, or not stated", which is also what a
   * snapshot persisted by a build older than this field says. It is the money
   * row's equivalent of `CreditsDetail.exhausted`: the one fact on it worth
   * interrupting the owner for, barked once on the false→true edge by
   * `Behaviour` and never repeated. It is deliberately **not** inferred from
   * `spent >= limit` — with no cap there is nothing to compare against, and
   * claude.ai is the only thing that knows whether it has actually stopped
   * serving extra usage.
   */
  readonly limitReached?: boolean;
  /**
   * Set when `spent`/`limit` are counts of Codex credits rather than amounts
   * of `currency` (`parseCodexSpendLimit`). It stays on `MoneyDetail` rather
   * than becoming a fourth `BucketKind` because every other fact about the row
   * is a money row's: a spend, a cap, a percentage of one against the other, a
   * bar and a reset. Only the unit of the two numbers differs. `currency` is
   * then `'XXX'` — ISO 4217's own "no currency" code — which keeps the field's
   * three-letter invariant intact instead of making it nullable for one row.
   */
  readonly inCredits?: true;
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
/**
 * The two pool keys other modules have to name, rather than re-type.
 *
 * Both are ordinary keys of `CLAUDE_WINDOW_MAP` below — they are pulled out
 * because `core/bubble.ts` has to tell "the 5-hour window" and "the weekly
 * pool" apart from every *per-model* weekly row, and a string literal repeated
 * in two files is one rename away from a bubble that silently stops matching.
 */
export const CLAUDE_FIVE_HOUR_KEY = 'five_hour';
export const CLAUDE_SEVEN_DAY_KEY = 'seven_day';

/**
 * The one row Walder's face reads (`pctForFace` in `usage.ts`). Claude's
 * 5-hour window, by bucket id — a product decision, not a coupling to the
 * service list, and pinned by `test/usage.test.ts` so a parser rename fails
 * loudly rather than leaving the dog permanently calm.
 */
export const FACE_BUCKET_ID = `claude.${CLAUDE_FIVE_HOUR_KEY}`;

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
 * The Anthropic model families a **top-level** `seven_day_<family>` key is
 * allowed to name.
 *
 * Top-level only, since the real shape landed (2026-09-10): a per-model row
 * from `limits[]` is not filtered against this list at all, because it arrives
 * with the dashboard's own display name for the row — see
 * `isAllowedClaudeWindow` and `claudeLimitKey`. This list is for the other
 * case, a bare key with nothing to vouch for it.
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

/**
 * Is this Claude key one the hover card is allowed to show?
 *
 * **Top-level keys only.** A row read out of the payload's `limits[]` array
 * does not come through here at all, and that exception is deliberate — see
 * `findLimitWindows`. The allow-list exists because a *top-level* key arrives
 * as a bare identifier that Walder has to judge for itself, and two of the
 * ones Anthropic ships (`nimbus_quill`, `amber_ladder`) are codenames for
 * nothing. A `limits[]` entry is the opposite situation: it arrives with
 * `scope.model.display_name`, the human name the dashboard itself prints
 * beside the number, so the account has already told us both that the row is
 * an allowance and what to call it. Filtering those against a hardcoded list
 * of model families could only ever hide a row the owner can see on the
 * dashboard — which is the bug this whole area exists to fix, not a risk worth
 * taking against it.
 */
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
 * the raw payload. That is enough for `main/usage-diagnostics.ts` to write a line a
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
  // No clock here any more. It existed for a `limits[]` entry that might have
  // stated its reset as an offset ("resets in 3600 s") — a possibility the
  // guessed shape had to allow for. The confirmed payload gives `resets_at` as
  // an ISO string on every entry, top-level and scoped alike, so nothing in
  // the Claude parsers needs to know what time it is.
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
 *
 * **A `null` top-level value is silent, and that is load-bearing rather than
 * incidental.** The confirmed payload (2026-09-10) reports twelve keys as
 * `null` on the owner's own account — `seven_day_opus`, `seven_day_sonnet`,
 * `seven_day_cowork`, `seven_day_omelette`, `seven_day_breakdown`,
 * `seven_day_oauth_apps`, `tangelo`, `iguana_necktie`, and four more — plus a
 * boolean `member_dashboard_available`. None of those is an unknown window: a
 * `null` is Anthropic saying "this allowance does not apply to this account",
 * which is nothing to report and nothing to decide. Routing them through
 * `onIgnored` would put a dozen "ignoring unknown claude window" lines in the
 * verbose log on every single poll and bury the one line that matters
 * (`amber_ladder`, the real unnamed codename) in noise. `isPlainObject` is
 * what keeps them quiet, so a `null` never reaches the whitelist check at all.
 */
export function parseClaudeUsage(json: unknown, opts: ClaudeParseOptions = {}): Bucket[] {
  if (!isPlainObject(json)) return [];

  const found = findTopLevelWindows(json, opts);
  // The same payload's per-model array, merged here rather than by the caller:
  // it is one document and one scale decision, and a caller that had to
  // remember to call both would eventually forget (which is exactly how the
  // Fable row went unnoticed for a month — see `parseClaudeLimits`).
  const taken = new Set(found.map((f) => f.key));
  for (const entry of findLimitWindows(json)) {
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
  /**
   * Label and priority the payload itself supplied, overriding
   * `claudeSpecFor`'s lookup.
   *
   * Only `limits[]` rows set this, and only because they arrive carrying the
   * dashboard's own `display_name` — the name the owner reads beside that
   * number on claude.ai. Deriving a label from the key instead would print
   * "Seven day fable" for a row the dashboard calls "Fable", and would have no
   * answer at all for a model whose name is not in `CLAUDE_WINDOW_MAP`.
   */
  readonly spec?: { readonly label: string; readonly priority: number; readonly kind: 'window' };
}

/** The `{ five_hour: {utilization, resets_at}, … }` half of a usage payload. */
function findTopLevelWindows(
  json: Record<string, unknown>,
  opts: ClaudeParseOptions
): FoundWindow[] {
  const found: FoundWindow[] = [];
  for (const [key, value] of Object.entries(json)) {
    // Silently, and on purpose: `null`, `true` and an array are not windows
    // that got rejected, and the live payload is mostly `null`. See the
    // function doc above — this one line is what keeps `onIgnored` down to the
    // one key that actually needs a human to look at it.
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
    const spec = f.spec ?? claudeSpecFor(f.key);
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

/*
 * CONFIRMED SHAPE (owner's own account, dev-only values dump, 2026-09-10).
 *
 * `/api/organizations/{org}/usage` carries a `limits` array, and it is what the
 * research promised: the home of the per-model weekly carve-out the dashboard
 * shows and no top-level key reports. The real entry is
 *
 *   { kind, group, percent, severity, resets_at, scope, is_active }
 *
 * and `scope` is the whole story:
 *
 *   scope: null                                        // = five_hour / seven_day
 *   scope: { model: { id: null, display_name: "Fable" }, surface: null }
 *
 * Three entries came back on the owner's account: two with `scope: null`, whose
 * `percent` **duplicates** `five_hour` and `seven_day` exactly, and one scoped
 * to a model, carrying the per-model weekly number the dashboard prints as
 * "Fable". So the rule is `scope.model.display_name`, and nothing else: an
 * entry with a scoped model name is a row, an entry without one is a duplicate
 * of a top-level window and is skipped.
 *
 * Two things are deliberately **not** read, although they are right there:
 * `kind`, `group` and `severity` (their string values were withheld from the
 * dump — only their lengths are known, so any code branching on them would be
 * branching on a guess), and `is_active`, which is `false` on the two unscoped
 * entries and `true` on the scoped one, i.e. it means something we have not
 * established and would be a second, unexplained filter over the first.
 *
 * The old reader here matched every field by name *regex*, because the field
 * names were unknown. They are known now, so the guessing is gone: reading
 * `percent` and `resets_at` by name is both shorter and honest about what the
 * payload actually says. `test/fixtures/claude-web-usage-limits.json` is this
 * shape, with the three unknown strings as flagged placeholders.
 */

/** `'seven_day_' + slug(display_name)`. */
const LIMIT_KEY_PREFIX = 'seven_day_';

/**
 * The label prefix, and the reason the rest of the label is the payload's own
 * string: every `limits[]` row Anthropic scopes to a model is a **weekly**
 * carve-out (`group` distinguishes them from `five_hour`, and the one observed
 * scoped entry resets on the same weekly clock as `seven_day`), so "7-day" is
 * Walder's word and the model name is the dashboard's.
 *
 * Exported because it is also the **test** for "is this a per-model weekly
 * row": every such label wears it, whichever route produced it — this one, or
 * `CLAUDE_WINDOW_MAP`'s own `7-day Opus` / `7-day Fable` — and
 * `core/bubble.ts` strips it to get the model's name back for a bubble
 * (`Opus weekly`). The weekly *pool* also starts with it (`7-day (all
 * models)`), which is why that one is matched by key first.
 */
export const LIMIT_LABEL_PREFIX = '7-day ';

/**
 * Where every per-model row sits on the card: right after the 5-hour window
 * and ahead of the 7-day pool.
 *
 * One priority for all of them, rather than `CLAUDE_WINDOW_MAP`'s per-family
 * numbers, because they are one class of row — "your weekly allowance for the
 * model you are actually running" — and the card has no basis for ordering two
 * of them against each other beyond the order the payload listed them in,
 * which `mergeBuckets` preserves within a priority. It also means a model
 * family nobody has heard of yet lands in the right place instead of at the
 * bottom under `claudePriority`'s fallback.
 */
const LIMIT_PRIORITY = 1;

/**
 * The model name a `limits[]` entry is scoped to, or `null`.
 *
 * `null` is the ordinary case, not an error: the two unscoped entries on the
 * owner's account carry `scope: null` and duplicate `five_hour` and
 * `seven_day`, so they are skipped **silently**. Nothing goes through
 * `onIgnored` for them — they are not unknown windows, they are known windows
 * arriving a second time, and a log line per poll saying so would be pure
 * noise. An entry scoped to a model whose `display_name` is empty or missing
 * is skipped by the same test, for a different reason: there is no name to put
 * on the row, and inventing one from `scope.model.id` is not possible — it is
 * `null` on the real payload.
 */
function scopedModelName(entry: Record<string, unknown>): string | null {
  const scope = entry['scope'];
  if (!isPlainObject(scope)) return null;
  const model = scope['model'];
  if (!isPlainObject(model)) return null;
  const name = model['display_name'];
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * A dashboard model name as a bucket key: `"Fable"` -> `seven_day_fable`.
 *
 * **This now only slugs.** It used to strip version digits and then refuse any
 * family not in `CLAUDE_WINDOW_FAMILIES`, and both halves of that are wrong
 * against the real payload:
 *
 *  - The string is a **display name**, not a model identifier. Anthropic sends
 *    `"Fable"` — what the dashboard prints — not `claude-fable-5-20260901`, so
 *    there are no version digits to strip. If a future name does carry one
 *    (`"Opus 4.5"`), keeping it is the right answer anyway: it is what the
 *    owner is looking at on the dashboard, and a row he can match to what he
 *    read there is worth more than one row per family forever.
 *  - The family allow-list has no business here at all. It exists to judge
 *    bare top-level keys, which arrive with nothing to vouch for them; a
 *    scoped `limits[]` entry arrives with the dashboard's own human name for
 *    the row. Gating that on a hardcoded word list could only hide a row the
 *    owner can see on claude.ai — see `isAllowedClaudeWindow`'s comment.
 *
 * So: lowercase, non-alphanumerics to `_`, runs collapsed, edges trimmed. The
 * key is an identity for state that must survive across polls (the bark
 * machine's `lastFired`, the panel's row order), which is exactly why it is
 * slugged rather than used raw — `"Fable"` and `"fable"` must not be two rows.
 * `null` only when nothing survives the slug (`"—"`, `"4.5"` would keep its
 * digits and survive; `"?!"` would not), because a key of `seven_day_` alone
 * is not an identity.
 */
export function claudeLimitKey(displayName: string): string | null {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug.length === 0 ? null : `${LIMIT_KEY_PREFIX}${slug}`;
}

/**
 * The `limits[]` half of a usage payload, as found windows.
 *
 * Read by exact field name (`limits`, `scope`, `percent`, `resets_at`) now
 * that the shape is confirmed, and **not** filtered through
 * `isAllowedClaudeWindow` — the deliberate exception documented on that
 * function. `percent` falls back to `utilization` for one reason only: it
 * costs a single `??` and it is the spelling every other window in this file
 * uses, so a payload that ever unifies the two spellings keeps working. Every
 * other unknown field is left alone.
 */
function findLimitWindows(json: Record<string, unknown>): FoundWindow[] {
  const array = json['limits'];
  if (!Array.isArray(array)) return [];

  const found: FoundWindow[] = [];
  for (const entry of array) {
    if (!isPlainObject(entry)) continue;
    // Unscoped: a duplicate of a top-level window. Skipped without a word.
    const displayName = scopedModelName(entry);
    if (displayName === null) continue;
    const key = claudeLimitKey(displayName);
    if (key === null) continue;
    // Same rule as the top-level scan: no number at all is not a window.
    const percent = asFiniteNumber(entry['percent']) ?? asFiniteNumber(entry['utilization']);
    if (percent === null) continue;

    found.push({
      key,
      utilization: percent,
      resetsAt: asIsoOrNull(entry['resets_at']),
      raw: entry,
      spec: {
        label: `${LIMIT_LABEL_PREFIX}${displayName}`,
        priority: LIMIT_PRIORITY,
        kind: 'window'
      }
    });
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
  return bucketsFromFound(findLimitWindows(json), opts);
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
  const weekly = buckets.find((bucket) => bucket.key === CLAUDE_SEVEN_DAY_KEY);
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

/*
 * CONFIRMED SHAPE (owner's own account, dev-only values dump, 2026-09-10).
 *
 * Both sources are inside `/api/organizations/{org}/usage`, which is why there
 * is no supplementary request any more (`CLAUDE_SUPPLEMENTS` is empty — see
 * `providers/claude-web.ts`). The primary one:
 *
 *   extra_usage: { is_enabled: true, monthly_limit: null, used_credits: 962,
 *                  utilization: null, currency: "…", decimal_places: 2,
 *                  disabled_reason: null, user_disabled: false,
 *                  spend_limit_reached: false, credits_ever_enabled: true,
 *                  daily: null, weekly: null }
 *
 * and the secondary, same payload, same figure in a different shape:
 *
 *   spend: { used: { amount_minor: 962, currency: "…", exponent: 2 },
 *            limit: null, percent: 0, severity: "…", enabled: true, … }
 *
 * Three things this settled, all of which the guessed reader got wrong:
 *
 *  - **`used_credits` is minor units**, with the payload stating the scale in
 *    `decimal_places`. 962 is **9.62**, not 962. The old reader inferred minor
 *    units from the *field name* (`_cents`, `_minor`) and would have printed
 *    "962 USD" — a hundredfold overstatement of the owner's bill, silently.
 *  - **`monthly_limit` is null** on an account with extra usage switched *on*.
 *    The old reader required both a spend and a cap and returned `null` without
 *    one, so the row would simply not have appeared for the very account it was
 *    written for. Hence `MoneyDetail.limit: number | null`.
 *  - **`utilization` is null** while `used_credits` is 962, so there is no
 *    provider-supplied percentage to fall back on. With no cap there is no
 *    percentage at all, and the row says so rather than inventing one.
 *
 * This also reverses half of the previous fix round's item M2 (which read
 * `spend` as the organisation's ordinary spend and refused it outright). The values dump shows `spend.used.amount_minor` is the **same
 * 962** as `extra_usage.used_credits`: it is the same fact in another shape,
 * not a different bill. It is still only consulted when the payload says
 * nothing about `extra_usage` at all — see `parseExtraUsage` — so the case M2
 * was protecting against (an account that never opted in, showing an "Extra
 * usage" row) is still impossible: such an account reports
 * `extra_usage.is_enabled: false`, which is a definite answer and stops there.
 */

/** The one money row Walder shows, and where it sits on the card. */
export const EXTRA_USAGE_ID = 'claude.extra_usage';
export const EXTRA_USAGE_KEY = 'extra_usage';
export const EXTRA_USAGE_LABEL = 'Extra usage';
/** Last in the Claude section: it is a bill, not a window. */
const EXTRA_USAGE_PRIORITY = 6;

/** ISO 4217 as the card is willing to print it. */
const CURRENCY_RE = /^[A-Za-z]{3}$/;

/** Default when the payload states amounts but names no readable currency. */
const DEFAULT_CURRENCY = 'USD';

/**
 * What `decimal_places` / `exponent` is assumed to be when absent or unusable.
 *
 * Two is right for every currency claude.ai bills in, and the payload states
 * it explicitly anyway; this is the answer to a field that has gone missing,
 * not a guess standing in for one that never existed.
 */
const DEFAULT_DECIMAL_PLACES = 2;

/** Beyond this, a `decimal_places` is not a scale, it is a corrupt payload. */
const MAX_DECIMAL_PLACES = 6;

/** `962` at `decimal_places: 2` -> `9.62`. */
function fromMinorUnits(minor: number, decimalPlaces: number): number {
  return minor / 10 ** decimalPlaces;
}

/** The stated scale, or the default — never something a divisor breaks on. */
function readDecimalPlaces(value: unknown): number {
  const n = asFiniteNumber(value);
  if (n === null || !Number.isInteger(n) || n < 0 || n > MAX_DECIMAL_PLACES) {
    return DEFAULT_DECIMAL_PLACES;
  }
  return n;
}

/** A three-letter code, upper-cased, or the default. */
function readCurrency(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_CURRENCY;
  const trimmed = value.trim();
  // Anything else — a name, an empty string, a symbol — makes `Intl` throw or
  // print nonsense, and the amount is the useful half either way.
  return CURRENCY_RE.test(trimmed) ? trimmed.toUpperCase() : DEFAULT_CURRENCY;
}

/**
 * A cap in minor units as a major-unit cap, or `null` for "no cap".
 *
 * `monthly_limit` is assumed to be on the **same scale as the spend** —
 * `decimal_places` is stated once for the whole block, and a payload that
 * reported the spend in cents and the cap in dollars would be indefensible.
 * Unverifiable today (the owner's cap is `null`), so it is written down here
 * rather than left implicit: if a capped account ever shows a cap 100× too
 * large on the card, this line is the bug.
 *
 * A cap of `0` or less is `null` too: it cannot be divided by, and "your limit
 * is nothing" is not something claude.ai means by it.
 */
function readCap(value: unknown, decimalPlaces: number): number | null {
  const minor = asFiniteNumber(value);
  if (minor === null || minor <= 0) return null;
  return fromMinorUnits(minor, decimalPlaces);
}

/** The `extra_usage` block: the primary source, and the authoritative one. */
function readExtraUsage(obj: Record<string, unknown>): MoneyDetail | null {
  // Strictly `true`. An account that has never switched extra usage on reports
  // `is_enabled: false` with `used_credits: 0`, and a `0 spent` row would
  // invite the owner to believe he is being billed for something he never
  // opted into. The field is confirmed present, so requiring it exactly costs
  // nothing.
  if (obj['is_enabled'] !== true) return null;

  const used = asFiniteNumber(obj['used_credits']);
  if (used === null || used < 0) return null;

  const places = readDecimalPlaces(obj['decimal_places']);
  return {
    spent: fromMinorUnits(used, places),
    limit: readCap(obj['monthly_limit'], places),
    currency: readCurrency(obj['currency']),
    // Present only when true — see `MoneyDetail.limitReached`.
    ...(obj['spend_limit_reached'] === true ? { limitReached: true } : {})
  };
}

/**
 * The `spend` block: the same figure in the shape the billing side uses.
 *
 * Reachable only when the payload carries no `extra_usage` object at all,
 * which is the state the owner's account was observed in a day earlier
 * (`extra_usage: null`). `enabled: false` is honoured the same way
 * `is_enabled` is; a *missing* `enabled` is not, because this is the fallback
 * shape and losing the figure over an absent flag would defeat the point of
 * having one.
 */
function readSpendBlock(obj: Record<string, unknown>): MoneyDetail | null {
  if (obj['enabled'] === false) return null;

  const used = obj['used'];
  if (!isPlainObject(used)) return null;
  const minor = asFiniteNumber(used['amount_minor']);
  if (minor === null || minor < 0) return null;

  // `exponent` is this block's own name for `decimal_places`, and it sits
  // inside `used` beside the amount it scales.
  const places = readDecimalPlaces(used['exponent']);
  // `limit` first, `cap` second: both are `null` on the observed payload, and
  // they are the only two fields it offers that could hold a ceiling.
  const limit =
    readCap(obj['limit'], places) ?? readCap(obj['cap'], places);
  return {
    spent: fromMinorUnits(minor, places),
    limit,
    currency: readCurrency(used['currency'])
  };
}

/**
 * claude.ai's "Extra usage" spend, or `null`.
 *
 * `null` means **no row at all**, never a `0%` one: extra usage is switched
 * off, or the payload does not mention it in either shape.
 *
 * `extra_usage` is consulted first and its answer is final — including a
 * `null` answer. That ordering is the whole safety property: an account with
 * extra usage off says so in `extra_usage`, and is never second-guessed
 * against a `spend` block that may be reporting something else entirely.
 */
export function parseExtraUsage(json: unknown): MoneyDetail | null {
  if (!isPlainObject(json)) return null;

  const extra = json[EXTRA_USAGE_KEY];
  if (isPlainObject(extra)) return readExtraUsage(extra);

  const spend = json['spend'];
  if (isPlainObject(spend)) return readSpendBlock(spend);

  return null;
}

/**
 * The Extra usage row.
 *
 * `pct = spent / limit × 100` when there is a cap, and everything downstream —
 * `barFill`, `formatPct`, the 80/85/90/95/100 barks — then treats the bill as
 * the percentage it genuinely is.
 *
 * **With no cap, `pct` is `null`, and so is the bar and the barks.** Every
 * consumer already handles a `null` percentage, because a Codex credits row
 * has one: `NudgeMachine.onUsage` skips the row, `card-layout` draws no bar,
 * and `formatMoneyValue` prints the amount with the word "spent" instead of a
 * fraction. That is the honest reading of `monthly_limit: null` — the owner is
 * spending against nothing, so there is no "how close am I" to answer, only
 * "how much so far". `spend_limit_reached` is the one thing still worth
 * saying, and `Behaviour` says it once.
 *
 * **`resetsAt` is inferred, and says so.** This was `null` for two versions,
 * and the argument for it was sound as far as it went: claude.ai states no
 * billing anchor anywhere in the payload, so an "Extra usage · resets in 21d"
 * line was Walder's invention wearing the provider's voice, and the owner had
 * no way to tell the difference.
 *
 * What that argument missed is that a spend row with no horizon is close to
 * useless — `9,62 € / 50,00 €` means something very different on the 2nd than
 * on the 29th — so "say nothing" was not the cheap, safe option it looked
 * like. The owner asked for the line back (2026-09-11). The honest way to give
 * it to him is not to drop the objection but to answer it: the date is
 * computed (`nextMonthlyResetAt`), the bucket carries `resetsEstimated`, and
 * the card renders `resets in 19d 3h (est.)`. That is the same admission the
 * value column already makes with `Est. $109.30` on the credit-price
 * conversion, and it leaves this row the only one on the card that is marked
 * as Walder's arithmetic — because it is the only one that is.
 */
export function extraUsageBucket(money: MoneyDetail, now: number): Bucket {
  return {
    id: EXTRA_USAGE_ID,
    service: 'claude',
    key: EXTRA_USAGE_KEY,
    label: EXTRA_USAGE_LABEL,
    pct: money.limit === null ? null : normalisePct((money.spent / money.limit) * 100),
    resetsAt: nextMonthlyResetAt(now),
    // Paired with the date, never set on its own: `(est.)` beside no date at
    // all would be a marker for a claim the row is not making.
    ...(nextMonthlyResetAt(now) === null ? {} : { resetsEstimated: true as const }),
    priority: EXTRA_USAGE_PRIORITY,
    kind: 'money',
    money
  };
}

const CHATGPT_PRIORITY = 4;
/** After the two Codex windows, in the ChatGPT section. */
const CODEX_CREDITS_PRIORITY = 5;
/**
 * Between the two Codex windows (4) and the credits row (5).
 *
 * A half-step rather than a renumbering: the integers on both sides are spoken
 * for, `mergeBuckets` sorts by plain subtraction so a fraction orders exactly
 * as well, and bumping credits to 6 would silently reshuffle it past every
 * Claude row that also sits at 5.
 */
const CODEX_SPEND_LIMIT_PRIORITY = 4.5;

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

/**
 * The two labels `codexWindowLabel` produces for the windows Codex really
 * reports, named because `KNOWN_ROWS` (the **Show in overview** menu) has to
 * agree with them before any payload has arrived.
 *
 * Only the 5-hour one is exported, for `core/bubble.ts`, which shortens it to
 * `Codex 5h` for a bubble — and it matches on the *label* rather than the
 * bucket key deliberately: the key is `codex_primary` on the confirmed
 * `rate_limit` shape but whatever the payload happened to be keyed by on the
 * legacy and walked routes, while the label is this file's own word for the
 * window either way. `Codex weekly` needs no rule there and so needs no export.
 */
export const CODEX_FIVE_HOUR_LABEL = 'Codex 5-hour';
const CODEX_WEEKLY_LABEL = 'Codex weekly';

/** Label a Codex window from its declared length in seconds. */
function codexWindowLabel(limitWindowSeconds: number | null, key: string): string {
  if (limitWindowSeconds === null || limitWindowSeconds <= 0) return `Codex ${humanize(key)}`;
  if (limitWindowSeconds <= FIVE_HOURS_S) return CODEX_FIVE_HOUR_LABEL;
  if (limitWindowSeconds >= ONE_WEEK_S) return CODEX_WEEKLY_LABEL;
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
 * Only those two windows become buckets *here*. `rate_limit_reset_credits`,
 * `model_usage` and friends are account metadata, not usage windows, and are
 * deliberately ignored — which is also why this explicit branch must run
 * before the tolerant walker, whose `/used|usage/`-shaped heuristics would
 * happily mine buckets out of all of them. `credits` and `spend_control` do
 * become rows, but by their own named parsers (`parseCodexCredits`,
 * `parseCodexSpendLimit`) which `parseChatGptUsage` appends afterwards.
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
  const spendLimit = parseCodexSpendLimit(json, now);
  const extra = [spendLimit, credits].filter((b): b is Bucket => b !== null);

  const real = parseCodexRateLimit(json, now);
  if (real.length > 0) return [...real, ...extra];
  const legacy = parseCodexRateLimits(json, now);
  if (legacy.length > 0) return [...legacy, ...extra];

  // The walker mines any object with a usage-ish number, `credits` included.
  // When the credits block was understood properly, its walked twin is a
  // duplicate of a row we already have and a worse one, so it is dropped.
  const walked = walkForBuckets(json, now).filter(
    (bucket) =>
      (credits === null || !bucket.key.startsWith(CODEX_CREDITS_FIELD)) &&
      (spendLimit === null || !bucket.key.startsWith(CODEX_SPEND_FIELD))
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
 * account returns) is a pool whose size the endpoint declines to state. That
 * used to be a row reading `?`, on the principle that unknown is not zero —
 * true, but a `?` sitting under **Codex credit limit**, which *does* have the
 * number, was a row that said nothing and looked like a fault (owner's
 * request, 2026-09-19). So: no balance, not unlimited, not exhausted is **no
 * row**. It comes back the moment there is something to say — a balance, an
 * `unlimited`, or `overage_limit_reached`, which is what the exhaustion bark
 * keys on, so that bark is unaffected.
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

  if (!unlimited && balance === null && !exhausted) return null;

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

/* --------------------------------------------- Codex spend-limit row */

/** The payload block holding the monthly spend cap, and the row it becomes. */
const CODEX_SPEND_FIELD = 'spend_control';
const CODEX_SPEND_LIMIT_FIELD = 'individual_limit';
export const CODEX_SPEND_LIMIT_ID = 'chatgpt.codex_spend_limit';
export const CODEX_SPEND_LIMIT_KEY = 'codex_spend_limit';
export const CODEX_SPEND_LIMIT_LABEL = 'Codex credit limit';

/**
 * The Codex monthly spend cap, or `null` when the account has none.
 *
 * This is the row the owner was missing. He can see credit spend on his Codex
 * dashboard but `parseCodexCredits` correctly returned `null` for him: his
 * `credits.has_credits` is `false`, so there is no purchased *pool*, and what
 * the dashboard shows him is his position against a *cap* — which lives in a
 * different block entirely. Confirmed against a live payload (2026-09-11):
 * `spend_control.individual_limit` carries `{ source, unit, limit, used,
 * remaining, used_percent, remaining_percent, reset_after_seconds, reset_at }`,
 * where the money-ish fields are *strings* and only the percentages and the
 * two reset fields are numbers.
 *
 * `limit`/`used` are numeric **strings** in credits. They are read too, as a
 * `MoneyDetail` carrying `inCredits` — a spend against a cap is exactly
 * what a money row is, and "455%" alone tells the owner he is over without
 * telling him by how much, which is the half he can act on. They are *not*
 * turned into money here: this file is offline and OpenAI publishes no EUR
 * price, so the conversion is a configured setting applied at render time
 * (`formatMoneyValue`), where it can carry its `Est.` and the owner's own
 * currency. Unparseable strings drop back to the plain pct-only window row —
 * the percentage is the fact the payload states most directly, and losing the
 * amounts must never lose the row.
 *
 * **`pct` is not clamped.** The live value is 455 — the cap was blown through
 * four and a half times over — and that is the honest number. `formatPct`
 * prints it as-is and `barFill` clamps its own 0-100 input, so the bar reads
 * full while the text reads 455 %. Clamping here would quietly relabel a
 * 4.5x overrun as "at the limit".
 *
 * No block, or no numeric `used_percent`, means **no row**: a `0 %` line would
 * tell an account that simply has no spend cap that it is nicely under one.
 */
export function parseCodexSpendLimit(json: unknown, now: Date = new Date()): Bucket | null {
  if (!isPlainObject(json)) return null;
  const control = json[CODEX_SPEND_FIELD];
  if (!isPlainObject(control)) return null;
  const block = control[CODEX_SPEND_LIMIT_FIELD];
  if (!isPlainObject(block)) return null;

  const pct = asFiniteNumber(block['used_percent']);
  if (pct === null || pct < 0) return null;

  // `Number('')` and `Number(null)` are both 0, which would print a real-looking
  // "0 / 600 credits", so the strings are required to *be* strings first.
  const spent = asNumericString(block['used']);
  const limit = asNumericString(block['limit']);
  const amounts = spent !== null && spent >= 0 && limit !== null && limit > 0;

  return {
    id: CODEX_SPEND_LIMIT_ID,
    service: 'chatgpt',
    key: CODEX_SPEND_LIMIT_KEY,
    label: CODEX_SPEND_LIMIT_LABEL,
    pct,
    // Already prefers the absolute `reset_at` over the `reset_after_seconds`
    // sitting beside it, and falls back to the offset when only that is there.
    resetsAt: readResetsAt(block, now),
    priority: CODEX_SPEND_LIMIT_PRIORITY,
    // No amounts: the row stays exactly the plain window it was before, rather
    // than a money row with nothing to show in its money column.
    ...(amounts
      ? {
          kind: 'money' as const,
          money: {
            spent: spent as number,
            limit: limit as number,
            // ISO 4217's "no currency" — see `MoneyDetail.inCredits`.
            currency: 'XXX',
            inCredits: true as const
          }
        }
      : {}),
    raw: block
  };
}

/** A numeric string as a finite number, or `null`. Non-strings are `null`. */
function asNumericString(v: unknown): number | null {
  if (typeof v !== 'string' || v.trim().length === 0) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* --------------------------------------------------------- Cursor rows */

/**
 * Cursor's billing period, from `api2.cursor.sh`'s `GetCurrentPeriodUsage`.
 *
 * **The shape here is the captured one**, read off the owner's own Mac with
 * `npm run probe -- --keys` on 2026-09-20 (fixture `cursor-usage.json`), and it
 * is not the shape every open-source Cursor tracker documents. There is no
 * `planUsage.limit`, no `totalSpend`, and no top-level `totalPercentUsed`: the
 * percentages live *inside* `planUsage`, and the spend cap lives in a separate
 * `spendLimitUsage` block with its own vocabulary (`overallLimit`,
 * `overallRemaining`). Parsing what the trackers describe would have produced
 * three rows of `undefined` on the one account anybody has actually looked at,
 * which is the whole reason CONTRIBUTING's "record the shape before writing
 * anything" rule exists.
 *
 * Three rows, and each one earns its place separately:
 *
 *  - **Cursor plan** — `planUsage.totalPercentUsed` against the billing cycle.
 *    The one row every Cursor account has.
 *  - **Cursor Auto** — `planUsage.autoPercentUsed`, and **only when it differs
 *    from the total**. The owner is on the Free plan, where the total can sit
 *    at 0 while Auto climbs, so the two are genuinely different facts; on a
 *    paid plan where Auto *is* the whole usage they are the same number twice,
 *    and a second identical row is noise with a reset time on it.
 *  - **Cursor on-demand** — `spendLimitUsage`, and only when `overallLimit` is
 *    above zero, which is the same rule as Extra usage being switched off: an
 *    account with no on-demand spend enabled has no cap to be a percentage of,
 *    and a `0 %` line would tell it it is comfortably under one.
 *
 * Everything is read defensively and a field that is missing, renamed or of
 * the wrong type costs *that row* and nothing else. A payload with no
 * `planUsage` object at all returns `[]`, which the provider turns into
 * `endpoint-changed` — an empty parse is never a confident 0 %.
 */
export const CURSOR_PLAN_ID = 'cursor.plan';
export const CURSOR_PLAN_KEY = 'plan';
export const CURSOR_PLAN_LABEL = 'Cursor plan';
export const CURSOR_AUTO_ID = 'cursor.auto';
export const CURSOR_AUTO_KEY = 'auto';
export const CURSOR_AUTO_LABEL = 'Cursor Auto';
export const CURSOR_ON_DEMAND_ID = 'cursor.on_demand';
export const CURSOR_ON_DEMAND_KEY = 'on_demand';
export const CURSOR_ON_DEMAND_LABEL = 'Cursor on-demand';

/**
 * After the ChatGPT block: `CHATGPT_PRIORITY` is 4, `CODEX_CREDITS_PRIORITY` 5,
 * `EXTRA_USAGE_PRIORITY` 6, so 7 is the next free integer and the three Cursor
 * rows take 7, 8 and 9 in the order they are described above.
 *
 * Which service comes *first* on the card is not decided here at all —
 * `mergeBuckets` adds `NON_PRIMARY_PRIORITY_OFFSET` to every row of a service
 * that is not the owner's primary one, so these numbers only order Cursor's
 * rows against each other and against the other services' rows within the same
 * primary/non-primary half.
 */
const CURSOR_PRIORITY = 7;

/** The billing-cycle end, but only when it is a date something can parse. */
function cursorResetsAt(json: Record<string, unknown>): string | null {
  const iso = asIsoOrNull(json['billingCycleEnd']);
  return isRealTimestamp(iso) ? iso : null;
}

export function parseCursorUsage(json: unknown): Bucket[] {
  if (!isPlainObject(json)) return [];
  const plan = json['planUsage'];
  if (!isPlainObject(plan)) return [];

  const resetsAt = cursorResetsAt(json);
  const total = asFiniteNumber(plan['totalPercentUsed']);
  const auto = asFiniteNumber(plan['autoPercentUsed']);
  const buckets: Bucket[] = [];

  if (total !== null) {
    buckets.push({
      id: CURSOR_PLAN_ID,
      service: 'cursor',
      key: CURSOR_PLAN_KEY,
      label: CURSOR_PLAN_LABEL,
      pct: normalisePct(total),
      resetsAt,
      priority: CURSOR_PRIORITY,
      kind: 'window'
    });
  }

  // `auto !== total` compares the raw numbers rather than the normalised ones,
  // so an Auto figure that only *rounds* to the total still gets its own row.
  if (auto !== null && auto !== total) {
    buckets.push({
      id: CURSOR_AUTO_ID,
      service: 'cursor',
      key: CURSOR_AUTO_KEY,
      label: CURSOR_AUTO_LABEL,
      pct: normalisePct(auto),
      resetsAt,
      priority: CURSOR_PRIORITY + 1,
      kind: 'window'
    });
  }

  const onDemand = cursorOnDemandRow(json);
  if (onDemand !== null) buckets.push(onDemand);

  return buckets;
}

/**
 * The on-demand row, or `null` when the account has no on-demand cap.
 *
 * **The unit of `overallLimit`/`overallRemaining` is unknown** — the capture
 * printed types, never values, and nothing in the payload says whether these
 * are cents, dollars or Cursor's own request credits. So this is a `'credits'`
 * row and not a `'money'` one: `CreditsDetail` carries plain counts and no
 * currency, where `MoneyDetail` would force a three-letter code onto a number
 * whose unit nobody has confirmed. "1,850 left" is honest about a count; "18.50
 * USD" would be an invention. The percentage is safe either way, because a
 * ratio of two numbers in the same unit has no unit at all.
 */
function cursorOnDemandRow(json: Record<string, unknown>): Bucket | null {
  const spend = json['spendLimitUsage'];
  if (!isPlainObject(spend)) return null;
  const limit = asFiniteNumber(spend['overallLimit']);
  if (limit === null || limit <= 0) return null;
  const remaining = asFiniteNumber(spend['overallRemaining']);
  if (remaining === null) return null;

  const used = limit - remaining;
  return {
    id: CURSOR_ON_DEMAND_ID,
    service: 'cursor',
    key: CURSOR_ON_DEMAND_KEY,
    label: CURSOR_ON_DEMAND_LABEL,
    pct: normalisePct((used / limit) * 100),
    // A spend cap is topped up by paying, not by a clock — the same reasoning
    // as the Codex credits row, and the card draws no reset line for a
    // `'credits'` row anyway.
    resetsAt: null,
    priority: CURSOR_PRIORITY + 2,
    kind: 'credits',
    credits: { balance: remaining, unlimited: false, exhausted: remaining <= 0 }
  };
}

/* ------------------------------------------------------ GitHub Copilot rows */

/**
 * GitHub Copilot's quota snapshots, from `api.github.com/copilot_internal/user`.
 *
 * The shape is the captured one, read off the owner's own GitHub account on
 * 2026-09-20 (Copilot Free; fixture `copilot-user.json`). The payload is a user
 * record with a `quota_snapshots` object hanging off it, and each snapshot is
 * already a percentage — `percent_remaining` — so there is no arithmetic to get
 * wrong and no unit to guess at. Three snapshots exist today:
 * `premium_interactions`, `chat` and `completions`, and each becomes one window
 * row, in that order, because premium interactions are the scarce thing on
 * every plan and the other two are unlimited on most of them.
 *
 * `pct` is `100 − percent_remaining`. Everything else in a snapshot —
 * `entitlement`, `remaining`, `quota_remaining`, `credits_used`,
 * `overage_count` — is left alone: the percentage is the one figure whose
 * meaning is unambiguous, and a second row derived from a count nobody can name
 * the unit of would be an invention.
 *
 * A row is skipped, and only that row, when:
 *
 *  - `entitlement` is not a positive number — the roadmap's "skip unlimited and
 *    entitlement 0" rule. An entitlement of 0 is not "0 % used", it is a quota
 *    that does not apply to this account, and a green bar against it would be a
 *    fact about nothing.
 *  - `has_quota` is explicitly `false` — GitHub saying the same thing in words.
 *    Absent means yes, which is how the field behaves on the accounts that carry
 *    it at all.
 *  - `percent_remaining` is not a finite number, which is the shape having moved
 *    under that one snapshot.
 *
 * Each snapshot also carries `unlimited` and `overage_permitted`, and neither
 * is read. The roadmap's "skip unlimited" is what the entitlement rule above
 * already does — a quota with nothing to be a percentage of does not become a
 * row whatever it calls itself — and adding a second flag to the same decision
 * would only give two answers to disagree.
 *
 * No `quota_snapshots` object at all returns `[]`, which the provider turns into
 * `endpoint-changed` — an empty parse is never a confident 0 %.
 */
export const COPILOT_PREMIUM_ID = 'copilot.premium_interactions';
export const COPILOT_PREMIUM_LABEL = 'Copilot premium';
export const COPILOT_CHAT_ID = 'copilot.chat';
export const COPILOT_CHAT_LABEL = 'Copilot chat';
export const COPILOT_COMPLETIONS_ID = 'copilot.completions';
export const COPILOT_COMPLETIONS_LABEL = 'Copilot completions';

/**
 * After the Cursor block, which ended at 9. The three rows take 10, 11 and 12
 * in the order below; as with Cursor these only order Copilot's rows against
 * the other services' rows within the same primary/non-primary half, because
 * `mergeBuckets` adds `NON_PRIMARY_PRIORITY_OFFSET` to a non-primary service.
 */
export const COPILOT_PRIORITY = 10;

/**
 * The snapshot names and the row each one becomes. The array order *is* the
 * card order and the priority order, so the premium row leads.
 */
const COPILOT_ROWS: readonly {
  readonly key: string;
  readonly id: BucketId;
  readonly label: string;
}[] = [
  { key: 'premium_interactions', id: COPILOT_PREMIUM_ID, label: COPILOT_PREMIUM_LABEL },
  { key: 'chat', id: COPILOT_CHAT_ID, label: COPILOT_CHAT_LABEL },
  { key: 'completions', id: COPILOT_COMPLETIONS_ID, label: COPILOT_COMPLETIONS_LABEL }
];

/**
 * When the quotas roll over, as a date Walder can show.
 *
 * `quota_reset_date_utc` first, because it says which zone it is in;
 * `quota_reset_date` is the same day without one and is the fallback. The
 * snapshots also carry a `quota_reset_at`, and it is **deliberately ignored**:
 * it is a bare number with nothing in the payload saying whether it counts
 * seconds, milliseconds or something else, and a reset line out by a factor of
 * a thousand is worse than no reset line at all.
 */
function copilotResetsAt(json: Record<string, unknown>): string | null {
  const utc = asIsoOrNull(json['quota_reset_date_utc']);
  if (isRealTimestamp(utc)) return utc;
  const plain = asIsoOrNull(json['quota_reset_date']);
  return isRealTimestamp(plain) ? plain : null;
}

export function parseCopilotUsage(json: unknown): Bucket[] {
  if (!isPlainObject(json)) return [];
  const snapshots = json['quota_snapshots'];
  if (!isPlainObject(snapshots)) return [];

  const resetsAt = copilotResetsAt(json);
  const buckets: Bucket[] = [];

  COPILOT_ROWS.forEach((row, index) => {
    const snapshot = snapshots[row.key];
    if (!isPlainObject(snapshot)) return;
    if (snapshot['has_quota'] === false) return;
    const entitlement = asFiniteNumber(snapshot['entitlement']);
    if (entitlement === null || entitlement <= 0) return;
    const remainingPct = asFiniteNumber(snapshot['percent_remaining']);
    if (remainingPct === null) return;

    buckets.push({
      id: row.id,
      service: 'copilot',
      key: row.key,
      label: row.label,
      pct: normalisePct(100 - remainingPct),
      resetsAt,
      // The row's own index, not the count pushed so far: a skipped row leaves
      // its number unused rather than shifting the rows below it up.
      priority: COPILOT_PRIORITY + index,
      kind: 'window'
    });
  });

  return buckets;
}

/**
 * The first instant of the next calendar month, UTC, as an ISO string.
 *
 * The billing anchor claude.ai does not state. Its `extra_usage` block carries
 * `monthly_limit`, `used_credits`, a currency and a scale — and no date, which
 * is why the Extra usage row shipped with no "resets in" line at all. The owner
 * asked for one back (2026-09-11), and he is right that a spend row with no
 * horizon is close to useless: "9,62 € of 50,00 €" means something very
 * different on the 2nd than on the 29th.
 *
 * So it is inferred, and the inference is a narrow one. The field is called
 * `monthly_limit` and the counter it caps is `used_credits`; a monthly cap that
 * did not reset monthly would not be a monthly cap. What is genuinely unknown
 * is the *anchor* — a calendar month, or the anniversary of the subscription —
 * and this assumes the calendar, which is what the same payload's one other
 * month-scale timestamp uses (`amber_ladder`, at `2026-10-01T00:00:00Z`). That
 * is corroboration and not proof, which is exactly why the row is flagged
 * `resetsEstimated` and the card prints `(est.)`: the owner can see that this
 * one figure is Walder's and judge it accordingly.
 *
 * **UTC, and always strictly in the future.** Local months would put two
 * machines on the same account a day apart and shift the line at every
 * daylight-saving jump. And "the start of this month" is in the past every day
 * of the month, which `formatResetsIn` renders as a permanent "reset pending" —
 * including at exactly midnight on the 1st, the one instant a naive
 * implementation gets wrong.
 */
export function nextMonthlyResetAt(now: number): string | null {
  // A clock that is not a finite epoch answers "no date", not an exception.
  // `toISOString` throws `RangeError` on an invalid Date, and this runs inside
  // the provider's own try/catch — so a NaN here would not crash anything
  // visibly, it would quietly turn one poll into an error result and take the
  // whole Extra usage row with it. `null` degrades to the row simply having no
  // reset line, which is what it had before this function existed.
  if (!Number.isFinite(now)) return null;
  const at = new Date(now);
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1, 0, 0, 0, 0)
  ).toISOString();
}

/**
 * How a reset horizon is written on the card.
 *
 *  - **`'countdown'`** — the original: `resets in 3d 4h`, always a duration.
 *  - **`'clock'`** — a duration while a duration is still readable, and a date
 *    once it stops being one.
 */
export type ResetStyle = 'countdown' | 'clock';

/** Menu order: the default first, the way `CARD_SIZES` leads with Large. */
export const RESET_STYLES: readonly ResetStyle[] = ['clock', 'countdown'];

export function isResetStyle(value: unknown): value is ResetStyle {
  return value === 'clock' || value === 'countdown';
}

/**
 * Clock time is the default, and the countdown is what the owner can opt back
 * into — the reverse of how this shipped, because `resets in 6d 4h` is the
 * wording the change exists to get rid of.
 */
export const DEFAULT_RESET_STYLE: ResetStyle = 'clock';

/**
 * "when does this allowance come back", in the shortest form that is still
 * actionable.
 *
 * `''` (no date to state) and `'reset pending'` (the date is past) are the same
 * in both styles. `'countdown'` is then a pure duration, and `'clock'` walks a
 * four-rung ladder:
 *
 *  - under an hour — `resets in 47m`
 *  - under a day — `resets in 3h 20m`
 *  - under a week — `resets Thu 14:30`
 *  - beyond — `resets 28 Sept`
 *
 * The ladder exists because a countdown stops being an answer at about the
 * one-day mark. `resets in 2h 14m` is something the owner can act on without
 * thinking — carry on, or stop now. `resets in 6d 4h` is arithmetic he has to do
 * himself, against a clock he has to look up, to reach the thing he actually
 * wanted to know: *which day*. A weekday and a time is that answer already, and
 * it is a plan ("Thursday afternoon, then") rather than a sum. Past a week the
 * weekday stops being unique enough to mean anything, so it becomes a date.
 *
 * `timeZone` exists so the tests can pin the two formatted rungs without
 * depending on where they run; the renderer passes none and gets the host zone,
 * which is the only zone the owner's "Thursday" is measured in.
 */
export function formatResetsIn(
  resetsAt: string | null,
  now: Date,
  opts: { style?: ResetStyle; locale?: string; timeZone?: string } = {}
): string {
  if (resetsAt === null) return '';
  const target = new Date(resetsAt).getTime();
  if (!Number.isFinite(target)) return '';

  const diffMs = target - now.getTime();
  if (diffMs <= 0) return 'reset pending';

  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  // Under a minute still reads as "1m" rather than "0m".
  const countdown =
    days > 0
      ? `resets in ${days}d ${hours}h`
      : hours > 0
        ? `resets in ${hours}h ${minutes}m`
        : `resets in ${Math.max(1, minutes)}m`;

  // The two sub-day rungs of the clock ladder *are* the countdown text, so
  // there is nothing to format and nothing that can throw.
  if (opts.style === 'countdown' || days === 0) return countdown;

  try {
    const at = new Date(target);
    return days < 7
      ? `resets ${new Intl.DateTimeFormat(opts.locale, {
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: opts.timeZone
        }).format(at)}`
      : `resets ${new Intl.DateTimeFormat(opts.locale, {
          day: 'numeric',
          month: 'short',
          timeZone: opts.timeZone
        }).format(at)}`;
  } catch {
    // `Intl.DateTimeFormat` throws `RangeError` on a locale tag it cannot parse,
    // and the locale here is `navigator.language` — whatever the host says it
    // is. A card that renders no reset line at all (or worse, a renderer that
    // dies mid-paint) is a much larger failure than one that falls back to the
    // wording this function used to have everywhere.
    return countdown;
  }
}

/**
 * How far behind every primary-service row a non-primary one is pushed.
 *
 * 100 because the real priorities live in 0–6 (`CLAUDE_WINDOW_MAP`,
 * `EXTRA_USAGE_PRIORITY`, the Codex constants), so a constant an order of
 * magnitude above the top of that range cannot make a non-primary row *tie*
 * with a primary one, let alone overtake it — which a smaller offset such as 10
 * would eventually do the day somebody adds a priority 11. It is added rather
 * than multiplied so the spacing inside each service is untouched: the
 * half-step at 4.5 (`CODEX_SPEND_LIMIT_PRIORITY`) still lands between 4 and 5,
 * at 104.5.
 */
const NON_PRIMARY_PRIORITY_OFFSET = 100;

/**
 * Every row Walder can name before it has seen a payload — what the tray's
 * **Show in overview** submenu is built from.
 *
 * The ids are the parsers' own, verbatim, and `test/buckets.test.ts` pins each
 * one by parsing the real fixtures: a label typed here is cosmetic, but an id
 * that does not match what a parser emits is a checkbox that silently toggles
 * nothing. Two of the ten deserve a note:
 *
 *  - `claude.seven_day_fable` is emitted by two different routes — a `limits[]`
 *    entry whose `display_name` slugs to `seven_day_fable` (the live payload),
 *    and `withDerivedFableRow`'s mirror when no real Fable row exists. Same id
 *    either way, which is what lets one checkbox cover both.
 *  - the two Codex window **ids** are fixed (`CODEX_WINDOWS` names them
 *    `codex_primary` / `codex_secondary` regardless of what the payload says),
 *    while their **labels** are derived from `limit_window_seconds` by
 *    `codexWindowLabel`. The labels below are what the real fixture produces —
 *    18,000 s and 604,800 s — and an account reporting some other window length
 *    would read "Codex 3h" on the card while this menu still says "Codex
 *    5-hour". The menu is a list of *rows*, not of window lengths, so that is
 *    the cheaper half of the trade: the checkbox still hides the right row.
 *
 * A row the payload carries that is *not* here (a new model family, a walked
 * `chatgpt.*` key) is not lost — the tray appends it from the last snapshot,
 * labelled with whatever that snapshot called it.
 */
export const KNOWN_ROWS: readonly {
  readonly id: BucketId;
  readonly label: string;
  readonly service: ServiceName;
}[] = [
  ...Object.entries(CLAUDE_WINDOW_MAP).map(([key, spec]) => ({
    id: `claude.${key}`,
    label: spec.label,
    service: 'claude' as const
  })),
  { id: EXTRA_USAGE_ID, label: EXTRA_USAGE_LABEL, service: 'claude' },
  { id: 'chatgpt.codex_primary', label: CODEX_FIVE_HOUR_LABEL, service: 'chatgpt' },
  { id: 'chatgpt.codex_secondary', label: CODEX_WEEKLY_LABEL, service: 'chatgpt' },
  { id: CODEX_CREDITS_ID, label: CODEX_CREDITS_LABEL, service: 'chatgpt' },
  { id: CODEX_SPEND_LIMIT_ID, label: CODEX_SPEND_LIMIT_LABEL, service: 'chatgpt' },
  { id: CURSOR_PLAN_ID, label: CURSOR_PLAN_LABEL, service: 'cursor' },
  { id: CURSOR_AUTO_ID, label: CURSOR_AUTO_LABEL, service: 'cursor' },
  { id: CURSOR_ON_DEMAND_ID, label: CURSOR_ON_DEMAND_LABEL, service: 'cursor' },
  ...COPILOT_ROWS.map((row) => ({ id: row.id, label: row.label, service: 'copilot' as const }))
];

/**
 * Flatten several bucket lists into display order: priority, then id — with the
 * owner's primary service, when he has named one, ahead of the other.
 *
 * **The bias is written into `priority` itself, and that is the whole trick.**
 * The obvious implementation — a three-key sort (service, priority, id) leaving
 * the numbers alone — orders the hover card correctly and does nothing at all
 * for the barks, because `Behaviour` does not read this order: it reads
 * `bucket.priority` off each bucket and hands the number to `NudgeMachine`,
 * which sorts simultaneous threshold crossings by it. A card that says ChatGPT
 * matters most while the dog barks about Claude first is worse than no setting.
 * Rewriting the number instead means the one call the poller already makes,
 * before the snapshot reaches `Behaviour` at all, fixes both — with no edit to
 * `behaviour.ts` or `nudge.ts`, which are the two files where an ordering rule
 * would have been hardest to keep honest. The alternative considered and
 * rejected was threading the setting down into `Behaviour` and `NudgeMachine`
 * as a second input: three files knowing about a preference that is, in the
 * end, only ever expressed as "this row comes first".
 *
 * New objects, never a mutation: the caller's `ServiceReport.buckets` arrays
 * are the poller's own kept state, re-merged on every publish, so mutating them
 * would add another 100 to the same rows every three minutes.
 *
 * The leading `primary` argument is optional, and an omitted one must leave
 * this function exactly as it was — `mergeBuckets(a, b)` is still the call in
 * `main/poller.ts`, and every existing test of the plain ordering still passes
 * unchanged. Hence the `typeof` discrimination rather than an overload pair:
 * one signature, one implementation, and a string in any position but the first
 * is a type error.
 */
export function mergeBuckets(
  first?: Bucket['service'] | Bucket[],
  ...rest: Bucket[][]
): Bucket[] {
  const primary = typeof first === 'string' ? first : undefined;
  const lists = typeof first === 'string' ? rest : first === undefined ? rest : [first, ...rest];

  const flat =
    primary === undefined
      ? lists.flat()
      : lists.flat().map((bucket) =>
          bucket.service === primary
            ? bucket
            : { ...bucket, priority: bucket.priority + NON_PRIMARY_PRIORITY_OFFSET }
        );

  return flat.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

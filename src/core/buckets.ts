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
   * What kind of allowance this row is. Optional and unused today — every
   * bucket this file produces is a rate-limit `'window'` — but the type is
   * introduced now, ahead of the Extra-usage-credits and Codex-credits rows a
   * later stage adds, so a caller written against `Bucket` today does not need
   * to be revisited to add the field later. Absent is equivalent to `'window'`.
   */
  kind?: BucketKind;
}

/**
 * The three shapes a Walder allowance row can take.
 *
 * `'window'` is everything this file parses today: a rate-limit period that
 * resets on a clock (Claude's 5-hour/7-day windows, Codex's primary/secondary
 * windows). `'money'` and `'credits'` belong to rows a later stage adds — the
 * claude.ai "Extra usage" spend-vs-cap figure and the Codex credit balance —
 * and are declared here, alongside `Bucket.kind`, purely so that work does not
 * need to touch every place `Bucket` is threaded through (persistence, the
 * panel, the bark machine) a second time.
 */
export type BucketKind = 'window' | 'money' | 'credits';

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
 * plus anything that looks like a new per-model weekly window by *pattern*
 * (`KNOWN_PATTERNS`) — because a genuinely new model tier is a real event this
 * whitelist should not have to be updated by hand to show.
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
 * Key shapes that are not in `CLAUDE_WINDOW_MAP` today but are still a real
 * allowance rather than a codename.
 *
 * Two patterns, for two different reasons a key can be genuine without being
 * in the table by exact name:
 *  - a per-model 7-day window for a model this file has never heard of
 *    (`seven_day_haiku`, whatever Anthropic names the next one). Anchored at
 *    both ends so a codename cannot ride the pattern by merely *containing*
 *    `seven_day` — `prefix_seven_day_x` and `seven_dayx` (no separating
 *    underscore) both fail it, on purpose.
 *  - anything spelled with "fable" in it. `withDerivedFableRow`'s own contract
 *    is "any spelling of a Fable key wins over the derived mirror" — a
 *    `seven_day_fable_5` already matches the pattern above, but a
 *    differently-shaped `fable_weekly` would not, and it must still be
 *    recognised as the real thing rather than dropped as a codename that
 *    happens to be about the model the owner actually runs.
 *
 * A key that matches either is humanised and prioritised the same way an
 * unknown key always was (`claudeSpecFor`, below) — this is additive to the
 * whitelist, not a second, looser one: `amber_ladder` matches neither.
 */
export const KNOWN_PATTERNS: readonly RegExp[] = [
  /^seven_day_[a-z0-9]+(?:_[a-z0-9]+)*$/,
  /fable/i
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

  const found: Array<{ key: string; utilization: number; resetsAt: string | null; raw: unknown }> =
    [];

  for (const [key, value] of Object.entries(json)) {
    if (!isPlainObject(value)) continue;
    const utilization = asFiniteNumber(value['utilization']);
    // Malformed first, and silently: an entry with no number at all is not a
    // window anybody is choosing to hide, it is nothing to hide it from.
    if (utilization === null) continue;
    if (IGNORED_KEYS.has(key)) continue;
    const resetsAt = asIsoOrNull(value['resets_at']);
    if (!isAllowedClaudeWindow(key)) {
      opts.onIgnored?.({ key, hasUtilization: true, resetsOn: resetsOnDate(resetsAt) });
      continue;
    }
    found.push({ key, utilization, resetsAt, raw: value });
  }

  if (found.length === 0) return [];

  const mode = opts.scale ?? 'percent';
  const asFractions =
    mode === 'fraction' || (mode === 'auto' && looksFractional(found.map((f) => f.utilization)));
  const scale = asFractions ? 100 : 1;

  return withDerivedFableRow(
    found.map((f) => {
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
    })
  );
}

/** The key and id of the row `withDerivedFableRow` invents. */
const FABLE_KEY = 'seven_day_fable';

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
 * If Anthropic ever reports a real Fable key, that one is used and nothing is
 * synthesised — hence the `/fable/i` test rather than an exact key match, so a
 * `seven_day_fable_5`, `fable_weekly` or any other spelling wins over the
 * derived row instead of sitting beside it.
 */
function withDerivedFableRow(buckets: Bucket[]): Bucket[] {
  if (buckets.some((bucket) => /fable/i.test(bucket.key))) return buckets;
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

const CHATGPT_PRIORITY = 4;

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
  const real = parseCodexRateLimit(json, now);
  if (real.length > 0) return real;
  const legacy = parseCodexRateLimits(json, now);
  if (legacy.length > 0) return legacy;
  return walkForBuckets(json, now);
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

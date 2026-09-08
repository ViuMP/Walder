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
  raw?: unknown;
}

/** Labels for the Claude bucket keys we know about today. */
export const KNOWN: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: '7-day (all models)',
  seven_day_opus: '7-day Opus',
  seven_day_fable: '7-day Fable',
  seven_day_sonnet: '7-day Sonnet'
};

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

/**
 * Parse Claude's OAuth usage payload: an object keyed by bucket name, each
 * `{ utilization, resets_at }`.
 *
 * Utilization is read as a percentage by default, because that is what the
 * endpoint returns. Fraction handling is opt-in via `scale` rather than
 * inferred, so a quiet window is never mistaken for a full one.
 */
export function parseClaudeUsage(json: unknown, opts: ClaudeParseOptions = {}): Bucket[] {
  if (!isPlainObject(json)) return [];

  const found: Array<{ key: string; utilization: number; resetsAt: string | null; raw: unknown }> =
    [];

  for (const [key, value] of Object.entries(json)) {
    if (!isPlainObject(value)) continue;
    const utilization = asFiniteNumber(value['utilization']);
    if (utilization === null) continue;
    found.push({ key, utilization, resetsAt: asIsoOrNull(value['resets_at']), raw: value });
  }

  if (found.length === 0) return [];

  const mode = opts.scale ?? 'percent';
  const asFractions =
    mode === 'fraction' || (mode === 'auto' && looksFractional(found.map((f) => f.utilization)));
  const scale = asFractions ? 100 : 1;

  return found.map((f) => ({
    id: `claude.${f.key}`,
    service: 'claude' as const,
    key: f.key,
    label: KNOWN[f.key] ?? humanize(f.key),
    pct: normalisePct(f.utilization * scale),
    resetsAt: f.resetsAt,
    priority: claudePriority(f.key),
    raw: f.raw
  }));
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
 * Last-resort walker for a payload whose shape we have not seen. Descends the
 * tree and emits a bucket for every object that carries a usage number and/or a
 * reset timestamp among its *own* scalar fields — so an ancestor never
 * duplicates its children.
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
  return out;
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

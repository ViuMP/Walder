/**
 * "Tokens today" — the one Walder row that comes from this machine rather than
 * from a provider.
 *
 * Both CLIs write a JSONL transcript of every turn they take, and both of them
 * record the token usage the API billed for in it. That is a number no usage
 * endpoint reports: claude.ai and Codex both answer in *percentages of a
 * window*, which is the right answer to "how close am I to being cut off" and
 * no answer at all to "how much did this afternoon actually cost". The
 * transcripts are the only place the second question is answered, and they are
 * already on disk.
 *
 * Pure, like the rest of `core/`: the caller hands over lines of text and the
 * clock, and gets numbers back. Finding the files is `main/local-tokens.ts`.
 *
 * Both readers follow the same rule as every other parser in this folder: the
 * input is untrusted and shape-unstable, so a line that cannot be read is
 * skipped rather than thrown over. A transcript is written by a *different*
 * program that updates on its own schedule, so "the shape changed under us" is
 * a matter of when, not if — and a crashed poll would take the whole hover card
 * down over a row that is a nice-to-have.
 */
import type { Bucket } from './buckets';
import type { ServiceName } from './services';

/**
 * Where the tokens row sits: last in its service's section, under everything.
 *
 * One more than the largest priority any existing row can carry — Claude's
 * "Extra usage" money row is 6 and the "Codex credits" row is 5 (both in
 * `buckets.ts`; neither constant is exported, hence the number here rather than
 * an import). The ordering is deliberate and not merely tidy: every other row
 * is an *allowance* — something that runs out, that the owner may need to act
 * on — and this one is a plain count that can never run out and never barks. It
 * belongs below the things that can bite.
 */
export const LOCAL_TOKENS_PRIORITY = 7;

/** The bucket key and label, shared by both services. */
export const LOCAL_TOKENS_KEY = 'tokens_today';
export const LOCAL_TOKENS_LABEL = 'Tokens today';

/**
 * Cheap pre-filter for a Claude transcript line: only assistant messages carry
 * a `usage` object, and they are a small minority of the file (every user turn,
 * every tool result and every sidechain entry is a line too). `String.includes`
 * on a few thousand lines costs nothing next to `JSON.parse` on all of them.
 */
const CLAUDE_USAGE_MARKER = '"usage":{';

/** The same trick for Codex: only `token_count` events carry a count. */
const CODEX_COUNT_MARKER = '"token_count"';

/** The four fields the API bills for, all of which count as tokens spent. */
const CLAUDE_USAGE_FIELDS = [
  'input_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'output_tokens'
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A finite non-negative number, or 0 — a missing field is not a negative one. */
function asCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** The line's own `timestamp`, as epoch ms, or `null` when unreadable. */
function timestampMs(entry: Record<string, unknown>): number | null {
  const raw = entry['timestamp'];
  if (typeof raw !== 'string') return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
}

/** Parse one JSONL line, or `null`. */
function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Tokens billed since `sinceMs`, read from Claude Code's own `.jsonl`
 * transcripts (the `.jsonl` files under `~/.claude/projects`).
 *
 * **The dedupe is the whole difficulty here.** Claude Code writes one line per
 * *content block*, not one per message, so a reply with a thought, some prose
 * and two tool calls appears as four lines carrying the identical
 * `message.usage` — the totals are per-message, repeated, not per-block. Summing
 * the file naively overstates a day's usage by whatever the average block count
 * happens to be, which on a tool-heavy session is a factor of three or four.
 * `(message.id, requestId)` identifies the message the usage belongs to, and
 * `seen` carries that across calls so the caller can scan several files as one
 * run if it ever needs to.
 *
 * A line with neither identifier collapses to a single entry under the empty
 * key, i.e. at most one such line is ever counted. That is the deliberate
 * direction to err in: a transcript shape that stops carrying ids is a shape we
 * no longer understand, and undercounting a row the owner reads as "roughly how
 * much today" is recoverable in a way that silently multiplying it is not.
 */
export function claudeTranscriptTokens(
  lines: Iterable<string>,
  sinceMs: number,
  seen: Set<string>
): number {
  let total = 0;

  for (const line of lines) {
    if (!line.includes(CLAUDE_USAGE_MARKER)) continue;

    const entry = parseLine(line);
    if (entry === null) continue;

    // The top-level timestamp, not the message's: it is the one every line
    // carries, and it is when this turn actually happened.
    const at = timestampMs(entry);
    if (at === null || at < sinceMs) continue;

    const message = entry['message'];
    if (!isPlainObject(message)) continue;
    const usage = message['usage'];
    if (!isPlainObject(usage)) continue;

    const id = `${String(message['id'] ?? '')}|${String(entry['requestId'] ?? '')}`;
    if (seen.has(id)) continue;
    seen.add(id);

    for (const field of CLAUDE_USAGE_FIELDS) total += asCount(usage[field]);
  }

  return total;
}

/**
 * Tokens billed since `sinceMs`, read from the Codex CLI's session transcripts
 * (`~/.codex/sessions/YYYY/MM/DD/*.jsonl`).
 *
 * Codex emits a `token_count` event after every turn, carrying both a running
 * `total_token_usage` for the session and a `last_token_usage` for that turn.
 * The `last` values are what get summed, for two reasons: the running total
 * cannot be filtered by time (a session that started yesterday carries
 * yesterday's tokens inside today's events), and summing running totals across
 * sessions double-counts every earlier turn. Verified on this machine that the
 * final `total_token_usage` equals the sum of the `last_token_usage` values, so
 * this is the same number arrived at the only way that can be filtered.
 *
 * `info` is `null` on some events — the CLI emits the event before it knows the
 * count — and that is an ordinary case, skipped in silence.
 */
export function codexSessionTokens(lines: Iterable<string>, sinceMs: number): number {
  let total = 0;

  for (const line of lines) {
    if (!line.includes(CODEX_COUNT_MARKER)) continue;

    const entry = parseLine(line);
    if (entry === null) continue;

    const at = timestampMs(entry);
    if (at === null || at < sinceMs) continue;

    const payload = entry['payload'];
    if (!isPlainObject(payload)) continue;
    // The marker only proves the string appears somewhere in the line; this is
    // what proves the line is actually a token_count event.
    if (payload['type'] !== 'token_count') continue;

    const info = payload['info'];
    if (!isPlainObject(info)) continue;
    const last = info['last_token_usage'];
    if (!isPlainObject(last)) continue;

    total += asCount(last['total_tokens']);
  }

  return total;
}

/**
 * Local midnight before `now`, as epoch ms — the start of "today".
 *
 * Local, not UTC, and that is the point: the owner's day is his day. `setHours`
 * on a local `Date` is the one line that gets this right across DST, where
 * "now − (now mod 86 400 000)" silently drifts by an hour twice a year.
 */
export function localMidnight(now: number): number {
  return new Date(now).setHours(0, 0, 0, 0);
}

/**
 * The "Tokens today" row for one service.
 *
 * `pct: null` and `resetsAt: null`, both deliberately. There is no percentage
 * because no plan states a token allowance — nothing here is a fraction of
 * anything — and `core/behaviour.ts` already skips a `null` percentage, so this
 * row can never bark, which is right for a number that cannot run out. And no
 * reset line, because the row *does* reset (at midnight) but saying "resets in
 * 9h" beside a count would read as a deadline the owner has to beat, which is
 * the opposite of what it means.
 */
/*
 * `ServiceName`, not the two CLI services: the poller hands whatever name the
 * token reader produced a count for, and a service with no local transcripts
 * (Cursor) simply has no entry, so no row is built. Narrowing the parameter
 * would only move that "no entry" check from the data into the type.
 */
export function tokensBucket(service: ServiceName, total: number): Bucket {
  return {
    id: `${service}.${LOCAL_TOKENS_KEY}`,
    service,
    key: LOCAL_TOKENS_KEY,
    label: LOCAL_TOKENS_LABEL,
    pct: null,
    resetsAt: null,
    priority: LOCAL_TOKENS_PRIORITY,
    kind: 'tokens',
    tokens: { total }
  };
}

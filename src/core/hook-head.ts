/**
 * The three fields Walder needs, read off the *head* of a hook body too large
 * to accept whole.
 *
 * Why this exists: 0.2.8 QA logged a real Claude Code hook refused with `body
 * over the cap (1024 KiB max)` even after the cap went from 8 KiB to 1 MiB.
 * Claude Code's hook stdin carries `tool_input` and `tool_response` in full,
 * so a `PostToolUse` after a large file read can be any size at all — and no
 * cap is large enough for "any size". Raising it again would only move the
 * refusal. But Walder never needed the tool fields: it needs the event name,
 * the session id and the working directory, and Claude Code writes those
 * **before** the tool fields. So the listener keeps its cap, and when a body
 * runs past it, the bytes already received are scanned here.
 *
 * A bounded regex per key, deliberately not a JSON parse: the head is cut off
 * mid-document, so there is nothing a parser could accept, and a tolerant
 * parser would be a second JSON implementation for one fallback. Each string
 * value is capped at `MAX_DETAIL_CHARS` *escaped* characters, so no match can
 * run unbounded across the head; the escapes are then undone by
 * `JSON.parse` on the one string literal — a few hundred characters, never
 * the body.
 *
 * ponytail: the regex does not know nesting, so the *first* occurrence of a
 * key wins. That is the top-level one for every body Claude Code writes (its
 * own fields come first), and a JSON string can never forge a match: every
 * pattern starts at a `{` or `,` followed by a bare quote, and inside a string
 * a quote is always escaped — so a match is always a real key. A tool whose
 * `tool_input` held a nested object with these keys *and* wrote it before its
 * own would be misread; the upgrade path is a streaming tokenizer that tracks
 * depth, if a source ever does that.
 *
 * Pure: no electron, no node, no logging — the values are payload values and
 * the caller must not log them either.
 */

/**
 * Longest `cwd` or `session_id` taken from a body, and the longest event name.
 *
 * Not a memory bound — the body is already capped — but the bound on what
 * reaches a structure the card iterates and the panel paints. A real path is a
 * couple of hundred characters and a session id is a UUID, so anything past
 * this is not the field it claims to be, and is dropped rather than truncated:
 * half a path is a path to somewhere else. Defined here, beside the one other
 * reader, and re-exported by `main/hook-server.ts` for the parsed-body path.
 */
export const MAX_DETAIL_CHARS = 1_024;

/** What the head yields: the shape of a minimal hook body, so it reads like one. */
export interface HookHead {
  readonly event: string;
  readonly session_id?: string;
  readonly cwd?: string;
}

/** A JSON string literal's body, escapes included, up to the detail cap. */
const STRING_BODY = `((?:[^"\\\\]|\\\\.){0,${MAX_DETAIL_CHARS}})`;

/**
 * Where a key can start: just after the `{` that opens an object or the `,`
 * that separates members. Inside a JSON string neither can be followed by a
 * bare quote, so this is what keeps a string's contents from posing as a key.
 */
const KEY_START = '[{,]\\s*';

/** `"key"` then `:` then a string literal, capturing the literal's body. */
function stringField(key: string): RegExp {
  return new RegExp(`${KEY_START}"${key}"\\s*:\\s*"${STRING_BODY}"`);
}

/**
 * The event name is an identifier, and nothing else is accepted: no escapes,
 * no spaces. `event` first, then Claude Code's own key — the same precedence
 * as `hookKindFrom` gives a parsed body.
 */
const EVENT_NAME_RES: readonly RegExp[] = ['event', 'hook_event_name'].map(
  (key) => new RegExp(`${KEY_START}"${key}"\\s*:\\s*"([A-Za-z]{1,${MAX_DETAIL_CHARS}})"`)
);
const SESSION_ID_RE = stringField('session_id');
const CWD_RE = stringField('cwd');

/** The captured literal body, unescaped, or `undefined` if it is not a valid one. */
function decoded(match: RegExpExecArray | null): string | undefined {
  const body = match?.[1];
  if (body === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(`"${body}"`);
    return typeof value === 'string' && value.length <= MAX_DETAIL_CHARS ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `{ event, session_id?, cwd? }` from the head of a body, or `null` when it is
 * not the start of a JSON object or names no event.
 *
 * The event name is returned as found, not mapped: whether it is one of ours
 * is the listener's decision (`hookKindFrom`), made the same way for a head as
 * for a whole body.
 */
export function hookHeadFrom(head: string): HookHead | null {
  if (!head.trimStart().startsWith('{')) return null;
  let event: string | undefined;
  for (const re of EVENT_NAME_RES) {
    event = re.exec(head)?.[1];
    if (event !== undefined) break;
  }
  if (event === undefined) return null;
  const sessionId = decoded(SESSION_ID_RE.exec(head));
  const cwd = decoded(CWD_RE.exec(head));
  return {
    event,
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    ...(cwd === undefined ? {} : { cwd })
  };
}

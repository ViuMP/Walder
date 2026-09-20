/**
 * Which coding sessions are open right now, and what each of them is doing.
 *
 * Walder has always known that *something* finished or *something* is waiting —
 * that is what a hook event is, and it is enough to perk an ear. It is not
 * enough for the hover card, which the owner opens precisely when two or three
 * terminals are going at once and the question is *which one* wants him. So
 * this module folds the same event stream into a list: one entry per session,
 * with the directory it is working in and the state it was last seen in.
 *
 * **The reducer.** One event in, the whole list out, because a list of three
 * entries is cheaper to rebuild than to mutate correctly, and a pure
 * `(previous, event, now) -> next` is a function whose every case is a two-line
 * test rather than a fixture directory and a clock.
 *
 *  - **The key** is `sessionId`, falling back to the pid, falling back to the
 *    tool's own name. That order is what makes repeated events from one session
 *    land on one entry: the hook server knows the session id (Claude Code puts
 *    it on every hook body) and the registry watcher knows the pid, and either
 *    one alone is stable for the life of a session. The last fallback is the
 *    degenerate case — an event with neither — where one entry per *tool* is
 *    the most honest thing on offer.
 *  - **The three kinds map to three states**: a `prompt` means the owner just
 *    typed, so the session is `working`; `waiting` is `waiting`; `done` is
 *    `done`. There is no fourth state and no timer that moves one state to
 *    another — the only thing that changes an entry is another event about it,
 *    or age (`liveSessions`).
 *  - **An event with no `cwd` keeps the one the entry already had**, and the
 *    same for the pid. The hook body carries a `cwd` on some hooks and not on
 *    others, and a row that lost its directory halfway through a session would
 *    read as a different session appearing.
 *  - **Most recent first**, which is the order the owner reads: the session
 *    that just changed is the one he is asking about.
 *
 * Both Claude Code sources key the same session the same way: the hook body
 * carries `session_id` and the registry file carries `sessionId`, and
 * `main/claude-sessions.ts` forwards the latter, so a session reported by both
 * lands on one entry — with the pid the watcher knows and the cwd whichever
 * spoke last. ponytail: a hook body with no `session_id` (older Claude Code,
 * Codex today) keys on the tool name, so two Codex sessions are one row.
 *
 * Pure: no `electron`, no node, no clock of its own. `now` arrives as an
 * argument for the same reason it does in `card-layout.ts`.
 */
import { WAITING_STALE_MS, type HookKind } from './behaviour';
import type { HookSource } from './bubble';

/** What a session is doing, as the card words it. */
export type SessionState = 'working' | 'waiting' | 'done';

export interface SessionEntry {
  readonly source: HookSource;
  /** `sessionId` ?? the pid ?? the tool's name. See the header. */
  readonly key: string;
  /** The working directory, home already shortened to `~` by main, or `null`. */
  readonly cwd: string | null;
  /** The session's process id, or `null` when only a hook has spoken for it. */
  readonly pid: number | null;
  readonly state: SessionState;
  /** When the last event about this session arrived. */
  readonly at: number;
}

/** One hook event, from either source, in the shape both wiring sites have. */
export interface SessionEventInput {
  readonly kind: HookKind;
  readonly source: HookSource;
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly pid?: number;
}

const STATE_FOR: Readonly<Record<HookKind, SessionState>> = {
  prompt: 'working',
  waiting: 'waiting',
  done: 'done'
};

/** Longest key accepted over IPC. A session id is a UUID; a pid is five digits. */
export const MAX_SESSION_KEY_CHARS = 256;

/**
 * Longest `cwd` accepted over IPC — and, before that, out of a hook body.
 *
 * A path on a real disk is a couple of hundred characters at worst. This is not
 * a display limit (that is `SESSION_CWD_MAX_CHARS` in `card-layout.ts`); it is
 * the cap that stops a malformed or hostile body putting a kilobyte of text
 * into a structure the card will iterate.
 */
export const MAX_SESSION_CWD_CHARS = 1024;

/** The key this event belongs to. See the header for why this order. */
function keyFor(event: SessionEventInput): string {
  if (event.sessionId !== undefined) return event.sessionId;
  return event.pid !== undefined ? String(event.pid) : event.source;
}

/** Fold one event into the list, newest first. */
export function reduceSessionEntries(
  previous: readonly SessionEntry[],
  event: SessionEventInput,
  now: number
): SessionEntry[] {
  const key = keyFor(event);
  const before = previous.find((entry) => entry.key === key) ?? null;
  const updated: SessionEntry = {
    source: event.source,
    key,
    cwd: event.cwd ?? before?.cwd ?? null,
    pid: event.pid ?? before?.pid ?? null,
    state: STATE_FOR[event.kind],
    at: now
  };
  const rest = previous.filter((entry) => entry.key !== key);
  // `updated` first, then a stable sort: two events in the same millisecond
  // therefore leave the one that just arrived at the top, which is what the
  // owner just did.
  return [updated, ...rest].sort((a, b) => b.at - a.at);
}

/**
 * The entries still worth showing.
 *
 * ponytail: the ceiling is a clock. An entry is dropped once it is older than
 * `WAITING_STALE_MS` — the same half hour after which the behaviour coordinator
 * takes down a `waiting` head-tilt, so the card and the dog stop believing in a
 * session at the same moment. What it cannot do is notice a session that ended
 * five seconds ago, because nothing tells us it did: a closed terminal sends no
 * hook. The upgrade is pid liveness, which `main/claude-sessions.ts` already
 * has (`processIsAlive`) and which commit B needs anyway for click-to-raise.
 */
export function liveSessions(entries: readonly SessionEntry[], now: number): SessionEntry[] {
  return entries.filter((entry) => now - entry.at <= WAITING_STALE_MS);
}

/**
 * Fit a path into `maxChars`, keeping the end of it.
 *
 * The end is the part that identifies the project; the beginning is
 * `~/Desktop/Tree/…`, which every one of the owner's sessions shares. So whole
 * path segments are taken from the right until the next one would not fit, and
 * what is left becomes a leading `…`. A path with no segment short enough to
 * keep (one enormous directory name) falls back to a plain character cut, which
 * is ugly and still tells him more than the first 28 characters would.
 *
 * The `~` is not this function's doing: main has already replaced the home
 * prefix before the entry was ever reduced, because `os.homedir()` is a node
 * call and `src/core` may not make one.
 */
export function shortenCwd(cwd: string, maxChars: number): string {
  if (cwd.length <= maxChars) return cwd;

  const parts = cwd.split('/');
  let tail = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = tail === '' ? (parts[i] ?? '') : `${parts[i] ?? ''}/${tail}`;
    // `…/` is the two characters the prefix will cost.
    if (next.length + 2 > maxChars) break;
    tail = next;
  }
  return tail === '' ? `…${cwd.slice(cwd.length - (maxChars - 1))}` : `…/${tail}`;
}

/* ---------------------------------------------------------------- the payload */

/** What `walder:sessions:set` carries. Validated on arrival, like every payload. */
export interface SessionsPayload {
  readonly sessions: readonly SessionEntry[];
}

function isEntry(raw: unknown): raw is SessionEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const entry = raw as Record<string, unknown>;
  if (entry['source'] !== 'claude' && entry['source'] !== 'codex') return false;
  if (
    entry['state'] !== 'working' &&
    entry['state'] !== 'waiting' &&
    entry['state'] !== 'done'
  ) {
    return false;
  }
  const key = entry['key'];
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_SESSION_KEY_CHARS) {
    return false;
  }
  const cwd = entry['cwd'];
  if (cwd !== null && (typeof cwd !== 'string' || cwd.length > MAX_SESSION_CWD_CHARS)) {
    return false;
  }
  const pid = entry['pid'];
  if (pid !== null && (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0)) {
    return false;
  }
  const at = entry['at'];
  if (typeof at !== 'number' || !Number.isFinite(at)) return false;
  return true;
}

/**
 * `{sessions: [...]}` with every entry valid, or `null`.
 *
 * Strict the way `parseServicePayload` is, and for a related reason: one bad
 * entry means the sender is not who we think it is, and half a list is a worse
 * answer than the list the card is already showing. So the whole payload is
 * dropped rather than filtered.
 *
 * It lives in `core` rather than beside the channel table because **both**
 * sides need it: main assembles the payload, and the panel renderer — which
 * cannot import from `src/main` at runtime, and does not anywhere today —
 * checks it on arrival the way it checks `cardSize`.
 */
export function parseSessionsPayload(raw: unknown): SessionsPayload | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const sessions = (raw as Record<string, unknown>)['sessions'];
  if (!Array.isArray(sessions)) return null;
  if (!sessions.every(isEntry)) return null;
  return { sessions: sessions as SessionEntry[] };
}

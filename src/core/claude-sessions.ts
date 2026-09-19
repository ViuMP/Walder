/**
 * Claude Code's own session registry, read as a source of hook events.
 *
 * Claude Code writes one small JSON file per running session into
 * `~/.claude/sessions/<pid>.json`, carrying `pid`, `procStart`, `cwd`,
 * `sessionId`, `status` (`busy` | `waiting` | `idle`) and `statusUpdatedAt`. It
 * is not a published interface and nobody asked for it to be one — it is simply
 * there, kept current by the tool itself, on every machine that runs Claude
 * Code.
 *
 * **Why polling that beats the hook server.** Walder's existing source for
 * "a reply finished" / "it wants you" is a loopback listener plus hooks the
 * owner has to install into `~/.claude/settings.json` — and, for Codex, trust by
 * hand through `/hooks`. Three things have to go right before the dog can perk
 * once: a file Walder is not entitled to write gets written, a port gets bound
 * and stays bound, and the owner completes a trust step in another tool. The
 * memory notes say it plainly: on the owner's own Mac the hooks were never
 * installed at all, and the dog sat silent for days while everything inside the
 * app looked healthy. This path has nothing to install, nothing to trust, and
 * no port. The hook server stays, because it is the only source of *Codex*
 * events — this registry is Claude Code's alone.
 *
 * **Why the first pass says nothing.** The map starts empty, so the first sweep
 * after launch sees every session that is already open as a transition out of
 * nothing. Announcing those would mean a perk per terminal window at every
 * launch — and worse after a crash, where relaunching is precisely the moment
 * the owner is least in the mood for six bubbles. So a pid's first sighting only
 * records its status. That is the whole of the seed rule: no flag, no "have we
 * started yet" boolean, no first-run special case anywhere else. An empty
 * `previous` *is* the flag.
 *
 * **`waiting → idle` is deliberately silent**, which matches the hook path: a
 * wait that ends without a prompt is a wait whose terminal was closed or
 * abandoned, and there is nothing to say about it. `Behaviour`'s own
 * `WAITING_STALE_MS` clock is what takes that `?` down.
 *
 * Pure: no `fs`, no timers, no Electron, no node. `main/claude-sessions.ts`
 * does the reading and the clock.
 *
 * ponytail: `procStart` is not compared to the live process start. A pid the
 * kernel has recycled can therefore leave one stale entry in the map — but
 * never an event, because the new owner of that pid is not Claude Code and so
 * the file's `status` never moves again. The upgrade, if a stale entry ever
 * matters, is to key the map on `pid + procStart`.
 */
import type { HookKind } from './behaviour';

/** What Claude Code says a session is doing. */
export type SessionStatus = 'busy' | 'waiting' | 'idle';

/** The two fields of a session file Walder actually decides on. */
export interface SessionRecord {
  readonly pid: number;
  readonly status: SessionStatus;
}

/** `pid` -> the status it was last seen in. */
export type SessionMap = ReadonlyMap<number, SessionStatus>;

const STATUSES: readonly string[] = ['busy', 'waiting', 'idle'];

/**
 * One session file's text, or `null` if it is not one.
 *
 * **Never throws, and rejects rather than guesses.** This reads a file written
 * by another program, at whatever instant the sweep happens to land — including
 * mid-write, where the JSON is half there. It is also handed the contents of
 * anything that ends in `.json` in that directory, today and after whatever
 * Claude Code adds to it next year. So: a plain object (an array is not one), an
 * integer pid above zero, and a status from the list. Anything else is not a
 * fact we have.
 */
export function parseSessionRecord(text: string): SessionRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as { pid?: unknown; status?: unknown };
  const { pid, status } = record;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof status !== 'string' || !STATUSES.includes(status)) return null;
  return { pid, status: status as SessionStatus };
}

/**
 * Fold this sweep's records into the previous map, and say what changed.
 *
 * The whole decision, in one pure function, so the interesting cases are
 * fixture arrays rather than a temporary directory and a clock:
 *
 *  - a **dead pid** is skipped entirely — not announced, and not carried into
 *    `next`. Claude Code does not always remove its file on the way out, and a
 *    `done` for a session that ended hours ago is worse than silence;
 *  - a **first sighting** records the status and says nothing (see the header);
 *  - an **unchanged** status says nothing, which is the overwhelming majority
 *    of every sweep;
 *  - **→ `busy`** is a `prompt`: work has started, so any `?` for this tool is
 *    answered. That is exactly what `UserPromptSubmit` means on the hook path;
 *  - **→ `waiting`** is a `waiting`;
 *  - **`busy` → `idle`** is a `done`: a reply finished;
 *  - **`waiting` → `idle`** is nothing at all — see the header;
 *  - a pid **absent** from this sweep is absent from `next` and is never
 *    announced. A session that vanished told us nothing on its way out.
 */
export function reduceSessions(
  previous: SessionMap,
  records: readonly SessionRecord[],
  isAlive: (pid: number) => boolean
): { next: SessionMap; events: HookKind[] } {
  const next = new Map<number, SessionStatus>();
  const events: HookKind[] = [];

  for (const record of records) {
    if (!isAlive(record.pid)) continue;
    const before = previous.get(record.pid);
    next.set(record.pid, record.status);
    if (before === undefined || before === record.status) continue;

    if (record.status === 'busy') events.push('prompt');
    else if (record.status === 'waiting') events.push('waiting');
    else if (before === 'busy') events.push('done');
  }

  return { next, events };
}

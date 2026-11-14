/**
 * Gemini usage, read from Antigravity's own language server on loopback.
 *
 * **Why not Google.** There is a `retrieveUserQuotaSummary` on Google's side,
 * and it answers **403 to any client that is not Antigravity** — there is no
 * personal credential Walder could hold that would make that call work, and
 * Google closed the Code Assist sign-in the Gemini CLI used (gap analysis §4,
 * P2-2, "Gemini dropped"). But Antigravity's own quota panel does not ask
 * Google either: the IDE ships a language server that runs on this machine,
 * and the panel asks *it*, over `127.0.0.1`. That is the door Walder uses —
 * the same door, the same request, the same answer, and not one packet to
 * Google. The idea is codenotch's; the code here is ours.
 *
 * **What this reads from the process table, and nothing else.** Victor
 * approved the first version of this on 2026-09-21 (one pid, that process's
 * argv and ports). Widened on 2026-11-13 by the audit and awaiting his
 * sign-off: step 2 is new, and step 3 covers every instance of that name.
 *
 *  1. `pgrep -U <own uid> -f language_server_macos_arm` — this user's pids
 *     whose command line names the server: the candidate list, nothing read
 *     from it but pids.
 *  2. `ps -o comm= -p <pid>` — the name each candidate was started under
 *     (argv[0], normally the executable's path), and only the pids whose
 *     basename is exactly `language_server_macos_arm` go on. A `tail -f` of
 *     its log or an editor matches `-f` too; it is dropped here, before any
 *     further argument is read (audit, 2026-11-13).
 *  3. For each process of that name: `ps -o args= -p <pid>` — its argv, for
 *     the one argument the server requires as its CSRF token — and
 *     `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN` — its listening ports. Every
 *     instance is tried until one answers.
 *
 * No `ps -Ao` over every process on the machine, no arguments past argv[0] of
 * any process not named `language_server_macos_arm`, no environment of anything.
 * `execFile` with an absolute binary path and an argv array, never a shell —
 * the same shape `main/raise.ts` runs `/bin/ps` with, for the same reasons:
 * nothing to quote wrong, and `PATH` is the owner's and not a place to trust.
 *
 * **The token is never logged, never returned and never persisted.** It lives
 * in this module's cache for as long as the server does, goes out as one
 * header, and appears in no `ProviderResult` and no diagnostic. Nothing in
 * this file calls a logger at all.
 *
 * **Two ports, one of them HTTPS.** The server listens twice and only one of
 * the two speaks plain HTTP; the other answers a plain request with 400
 * "Client sent an HTTP request to an HTTPS server". Rather than guess from the
 * port number, every listening port is tried in order and the first that
 * answers 200 is kept. The pair `{port, token}` is then cached, because the
 * port changes on every launch of the IDE and re-running four child processes
 * every three minutes to learn a number that has not moved is the kind of idle
 * work this project measures. Any non-200, or a request that throws, drops the
 * cache so the next poll rediscovers — which is what a restarted IDE looks
 * like from here.
 *
 * ponytail: only the IDE's language server is found, not the `agy` CLI — which
 * serves the same RPC on loopback under a different process name and, having
 * no panel to defend, without a CSRF token. Ceiling: a machine with the CLI
 * running and the IDE closed reads `unavailable`. Upgrade path: a second
 * `pgrep` pattern here, and a token that is allowed to be absent.
 */
import { execFile } from "node:child_process";
import { parseAntigravityUsage } from "../core/buckets";
import { keyTreeLines } from "../core/usage-shape";
import {
  failure,
  parseJson,
  topLevelKeys,
  type HttpFetch,
  type ProviderResult,
  type UsageProvider,
} from "./types";

export const ANTIGRAVITY_ID = "antigravity";
export const ANTIGRAVITY_LABEL = "Antigravity";

/** Absolute, because `PATH` is the owner's — as in `main/raise.ts`. */
export const PGREP_BIN = "/usr/bin/pgrep";
export const PS_BIN = "/bin/ps";
export const LSOF_BIN = "/usr/sbin/lsof";

/** The IDE's bundled language server, as `pgrep -f` matches it. */
export const ANTIGRAVITY_PROCESS = "language_server_macos_arm";

/** The Connect-RPC method the IDE's own quota panel calls. */
export const ANTIGRAVITY_RPC_PATH =
  "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";

/** Connect-RPC: the request message is a JSON object, empty for this method. */
export const ANTIGRAVITY_RPC_MESSAGE = "{}";

/** The header the language server checks its `--csrf_token` argument against. */
export const ANTIGRAVITY_CSRF_HEADER = "x-codeium-csrf-token";

export const ANTIGRAVITY_NOT_RUNNING_MESSAGE =
  "Antigravity is not running — open Antigravity to read Gemini's limits";
export const ANTIGRAVITY_NO_ANSWER_MESSAGE =
  "Antigravity is running but its language server did not answer";
export const ANTIGRAVITY_UNREADABLE_MESSAGE =
  "Antigravity answered with a payload Walder could not read (run npm run probe -- --keys)";

/** Long enough for `pgrep`/`ps`/`lsof` on a healthy Mac, short enough not to hang a poll. */
const EXEC_TIMEOUT_MS = 2_000;
/** `lsof` for one process is a few lines; this is the cap on a stdout gone wrong. */
const EXEC_MAX_BUFFER = 64 * 1024;

/**
 * Shorter than the 15 s default, because this is a socket on this machine and
 * because up to one port per attempt is spent before the right one is found: a
 * loopback server that has not answered in three seconds is not going to.
 */
export const ANTIGRAVITY_TIMEOUT_MS = 3_000;

/** `--csrf_token <value>` or `--csrf_token=<value>`; both forms appear. */
const CSRF_ARG = /--csrf_token[=\s]+(\S+)/;

/** `lsof`'s NAME column, e.g. `127.0.0.1:53124 (LISTEN)`. */
const LISTEN_PORT = /:(\d+)\s*\(LISTEN\)/g;

/** Where the quota RPC lives, once a port is known. */
export function antigravityUrl(port: number): string {
  return `http://127.0.0.1:${port}${ANTIGRAVITY_RPC_PATH}`;
}

export interface AntigravityDeps {
  readonly http: HttpFetch;
  /** Run a binary and hand back its stdout. Injected in tests, as in `main/raise.ts`. */
  readonly exec?: (bin: string, args: readonly string[]) => Promise<string>;
  /** Top-level keys of a payload we could not read as usage. Shape, never values. */
  readonly onUnexpectedShape?: (keys: string[]) => void;
  /** Top-level keys of every JSON answer, for `npm run probe -- --keys`. */
  readonly onUsageKeys?: (keys: string[]) => void;
  /** Nested key names and types (`keyTreeLines`), never values. Same audience. */
  readonly onUsageShape?: (lines: string[]) => void;
}

function defaultExec(bin: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      bin,
      [...args],
      {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
        encoding: "utf8",
      },
      // Every non-zero exit is an empty answer, not a throw: `pgrep` exits 1
      // when nothing matches, which is the ordinary "Antigravity is closed"
      // case and not an error worth showing anyone. stderr is discarded — it
      // is the one place a child could quote an argument back at us.
      (error, stdout) => resolve(error === null ? stdout : ""),
    );
  });
}

/** The endpoint one poll may use: a port that answered, and the token it wants. */
interface Endpoint {
  readonly port: number;
  readonly token: string;
}

export function createAntigravityProvider(
  deps: AntigravityDeps,
): UsageProvider {
  const exec = deps.exec ?? defaultExec;
  /**
   * The last endpoint that answered 200, for as long as it keeps answering.
   * Never persisted and never logged — see the header.
   */
  let cached: Endpoint | null = null;

  /**
   * The pids of this user's processes named `language_server_macos_arm`;
   * empty for "Antigravity is not running". `-U` is left out where there is
   * no uid (Windows, where this provider never finds a process anyway).
   */
  async function findPids(): Promise<number[]> {
    const uid = process.getuid?.();
    const user = uid === undefined ? [] : ["-U", String(uid)];
    let out: string;
    try {
      out = await exec(PGREP_BIN, [...user, "-f", ANTIGRAVITY_PROCESS]);
    } catch {
      return [];
    }
    const pids: number[] = [];
    for (const line of out.split("\n")) {
      const pid = Number(line.trim());
      if (!Number.isInteger(pid) || pid <= 0) continue;
      // `-f` matches a `tail -f` of the log or an editor too; the approved
      // scope is the process of that name, so the name is checked before any
      // further argv is read (audit, 2026-11-13). `comm` on macOS is argv[0],
      // normally the executable's path, which may contain spaces
      // ("Antigravity IDE.app"), so the basename is compared, not a split on
      // whitespace.
      let comm: string;
      try {
        comm = await exec(PS_BIN, ["-o", "comm=", "-p", String(pid)]);
      } catch {
        continue;
      }
      if (comm.trim().split("/").pop() === ANTIGRAVITY_PROCESS) pids.push(pid);
    }
    return pids;
  }

  /** Every endpoint worth trying this poll, in the order the ports are listed. */
  async function discover(pid: number): Promise<Endpoint[]> {
    let args: string;
    let listening: string;
    try {
      args = await exec(PS_BIN, ["-o", "args=", "-p", String(pid)]);
      listening = await exec(LSOF_BIN, [
        "-nP",
        "-a",
        "-p",
        String(pid),
        "-iTCP",
        "-sTCP:LISTEN",
      ]);
    } catch {
      return [];
    }

    const token = CSRF_ARG.exec(args)?.[1];
    // No token, no request: the server rejects an unauthenticated call, and
    // guessing one would only turn a clear "did not answer" into a 401.
    if (token === undefined || token.length === 0) return [];

    const ports: number[] = [];
    for (const match of listening.matchAll(LISTEN_PORT)) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && !ports.includes(port))
        ports.push(port);
    }
    return ports.map((port) => ({ port, token }));
  }

  return {
    id: ANTIGRAVITY_ID,
    service: "gemini",
    label: ANTIGRAVITY_LABEL,

    // Cheap and local, as the contract requires: one `pgrep` and a `ps -o
    // comm=` per match against this machine's own process table, no socket
    // and no network.
    async isAvailable(): Promise<boolean> {
      return (await findPids()).length > 0;
    },

    async fetch(): Promise<ProviderResult> {
      // The remembered endpoint first and, when it is dead, a fresh look in the
      // *same* poll: Antigravity quits and restarts between polls, and a stale
      // port has to end as "not running" or as the new port — not as a whole
      // interval of "did not answer" about a process pgrep no longer finds.
      const remembered = cached;
      cached = null;
      if (remembered !== null) {
        const again = await tryEndpoint(remembered);
        if (again !== null) return again;
      }
      const pids = await findPids();
      if (pids.length === 0) {
        return failure(
          ANTIGRAVITY_ID,
          "unavailable",
          ANTIGRAVITY_NOT_RUNNING_MESSAGE,
        );
      }
      // Several servers (two IDE windows) are all tried; the first endpoint
      // that answers wins.
      for (const pid of pids) {
        for (const candidate of await discover(pid)) {
          const result = await tryEndpoint(candidate);
          if (result !== null) return result;
        }
      }
      return failure(ANTIGRAVITY_ID, "error", ANTIGRAVITY_NO_ANSWER_MESSAGE);
    },
  };

  /** One port asked once: a result when it answered JSON, `null` to try the next. */
  async function tryEndpoint(
    candidate: Endpoint,
  ): Promise<ProviderResult | null> {
    let response;
    try {
      response = await deps.http(antigravityUrl(candidate.port), {
        headers: {
          "Content-Type": "application/json",
          [ANTIGRAVITY_CSRF_HEADER]: candidate.token,
        },
        post: ANTIGRAVITY_RPC_MESSAGE,
        timeoutMs: ANTIGRAVITY_TIMEOUT_MS,
      });
    } catch {
      // The HTTPS half of the pair, or a port that closed between `lsof`
      // and now. Either way the next candidate is the one to try.
      return null;
    }
    // Only a 200 counts. `classifyHttp` is deliberately not used: this is
    // a local server whose sibling port answers 400 to a plain request,
    // and "400 means try the other port" is not a status the owner should
    // ever be shown a card about.
    if (response.status !== 200) return null;

    const json = parseJson(response.body);
    if (json === null) return null;

    cached = candidate;
    const keys = topLevelKeys(json);
    deps.onUsageKeys?.(keys);
    deps.onUsageShape?.(keyTreeLines(json));

    const buckets = parseAntigravityUsage(json);
    if (buckets.length === 0) {
      // Not `ok` with no rows: a 200 with no `groups` is the shape having
      // moved, and a healthy empty account is not what that means.
      deps.onUnexpectedShape?.(keys);
      return failure(
        ANTIGRAVITY_ID,
        "endpoint-changed",
        ANTIGRAVITY_UNREADABLE_MESSAGE,
      );
    }
    return { buckets, status: "ok", via: ANTIGRAVITY_ID };
  }
}

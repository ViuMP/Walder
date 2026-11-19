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
 * argv and ports). Widened on 2026-11-13 by the audit, and that wider scope
 * approved by him on 2026-11-14: step 2 is new, and step 3 covers every
 * instance of that name.
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
 * **On Windows (2026-11-18) the same scope, in one PowerShell call.** There is
 * no `pgrep`, `ps` or `lsof`, so one fixed script
 * (`ANTIGRAVITY_WIN_DISCOVERY_SCRIPT`) does all three, run as
 * `powershell.exe -NoProfile -NonInteractive -Command <script>` by its
 * absolute System32 path (`win-powershell.ts`), with nothing spliced into it:
 *
 *  1. `Get-CimInstance Win32_Process` with a WMI filter on the image name
 *     `language_server.exe` — the candidate list.
 *  2. Kept only when its `SessionId` is the session PowerShell itself runs in
 *     (this user's, the `-U` of step 1 above) **and** its executable path ends
 *     in `\antigravity\resources\bin\language_server.exe`. The image name is
 *     generic — another Codeium-family editor could ship a server of the same
 *     name — so the path is what stands in for the macOS name check: like
 *     `ps -o comm=`, it is the process's identity, read before any argument,
 *     and a same-named server anywhere else never has its command line read.
 *     The alternative, matching `--override_ide_name antigravity` in the
 *     command line, was turned down because deciding it means reading the
 *     argv of every `language_server.exe` first, which is the wider scope the
 *     2026-11-14 decision does not cover.
 *  3. For each one kept: its `CommandLine`, for `--csrf_token`, and its
 *     listening ports from `MSFT_NetTCPConnection` filtered to that one pid
 *     (`lsof -p <pid>`'s scope; the CIM class `Get-NetTCPConnection` wraps,
 *     asked directly because loading that cmdlet's module costs PowerShell
 *     about half a second more, measured on the PC).
 *
 * `parseWindowsDiscovery` then checks the path and session again on the
 * Node side, so the rule is written, and tested, in one place that does not
 * depend on PowerShell having done its part.
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
import { winPowerShellPath } from "./win-powershell";

export const ANTIGRAVITY_ID = "antigravity";
export const ANTIGRAVITY_LABEL = "Antigravity";

/** Absolute, because `PATH` is the owner's — as in `main/raise.ts`. */
export const PGREP_BIN = "/usr/bin/pgrep";
export const PS_BIN = "/bin/ps";
export const LSOF_BIN = "/usr/sbin/lsof";

/** The IDE's bundled language server, as `pgrep -f` matches it. */
export const ANTIGRAVITY_PROCESS = "language_server_macos_arm";

/**
 * The same server's image name on Windows, measured on the PC on 2026-11-18
 * (Antigravity 2.33.0): exactly this, not `language_server_windows_x64.exe`.
 */
export const ANTIGRAVITY_PROCESS_WIN = "language_server.exe";

/**
 * Where that image has to live for Walder to count it as Antigravity's: the
 * tail of `%LOCALAPPDATA%\Programs\antigravity\resources\bin\language_server.exe`,
 * compared without regard to letter case, as Windows paths are. The leading
 * backslash makes `antigravity` a whole folder name, so `notantigravity\…`
 * does not pass. Why the path and not the command line: see the header.
 */
export const ANTIGRAVITY_WIN_PATH_SUFFIX =
  "\\antigravity\\resources\\bin\\language_server.exe";

/**
 * The one PowerShell script the Windows path runs; see the header for what it
 * reads and why. Built from the two constants above at load time, so it is a
 * fixed string — nothing from the machine or the owner is ever put into it.
 *
 * Written with single quotes only: `execFile` on Windows re-quotes an argument
 * that contains `"` with backslashes, and PowerShell 5.1's reading of that is
 * not something to depend on (`''` is a literal `'` inside a single-quoted
 * PowerShell string). `-like` is case-insensitive, and the suffix holds no
 * wildcard character. `$p` is the pid PowerShell itself just read, an integer,
 * concatenated into the CIM filter inside PowerShell. `State = 2` is Listen
 * in `MSFT_NetTCPConnection`.
 *
 * Output: nothing when no process matches (`@() | ConvertTo-Json` prints
 * nothing); otherwise `{pid, session, self, path, args, ports}`, as one object
 * or an array of them, with `ports` an array or a bare number — PowerShell
 * 5.1's `ConvertTo-Json` collapses one-element arrays, and the parser takes
 * both shapes.
 */
export const ANTIGRAVITY_WIN_DISCOVERY_SCRIPT = [
  "$s = (Get-Process -Id $PID).SessionId;",
  `@(Get-CimInstance -ClassName Win32_Process -Filter 'Name = ''${ANTIGRAVITY_PROCESS_WIN}''' |`,
  `Where-Object { $_.SessionId -eq $s -and $_.ExecutablePath -like '*${ANTIGRAVITY_WIN_PATH_SUFFIX}' } |`,
  "ForEach-Object { $p = $_.ProcessId; [pscustomobject]@{",
  "pid = $p; session = $_.SessionId; self = $s; path = $_.ExecutablePath; args = $_.CommandLine;",
  "ports = @(Get-CimInstance -Namespace ROOT/StandardCimv2 -ClassName MSFT_NetTCPConnection",
  "-Filter ('OwningProcess = ' + $p + ' AND State = 2') | ForEach-Object { $_.LocalPort }) } })",
  "| ConvertTo-Json -Compress -Depth 3",
].join(" ");

/** The arguments PowerShell is started with; the script is the last one. */
const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-Command"] as const;

/** The highest TCP port number; anything outside 1..this is not a port. */
const MAX_PORT = 65_535;
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

/**
 * Long enough for `pgrep`/`ps`/`lsof` on a healthy Mac, short enough not to
 * hang a poll.
 */
const EXEC_TIMEOUT_MS = 2_000;
/**
 * Windows runs one PowerShell process per discovery, and PowerShell's start is
 * most of its cost: 1.1–1.4 s warm on the PC (2026-11-18), then 1.8–1.9 s on
 * every one of four runs later that night with the machine busier — right at
 * 2 s, so polls read "not running" while Antigravity was open (seen on screen,
 * 2026-11-19). Eight seconds is a poll-sized wait that still bounds a hung
 * child; the poll runs in the background, so the owner never waits on it.
 */
export const EXEC_TIMEOUT_WIN_MS = 8_000;

/** The child-process timeout for the discovery on `platform`. */
export function execTimeoutFor(platform: NodeJS.Platform): number {
  return platform === "win32" ? EXEC_TIMEOUT_WIN_MS : EXEC_TIMEOUT_MS;
}
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
  /**
   * Which discovery to run: `win32` takes the PowerShell path, everything else
   * the `pgrep`/`ps`/`lsof` one. Defaults to `process.platform`; injected so
   * both paths are tested on whatever machine runs the suite.
   */
  readonly platform?: NodeJS.Platform;
  /** Windows PowerShell's absolute path. Defaults to `winPowerShellPath()`. */
  readonly powershellPath?: string;
  /** Top-level keys of a payload we could not read as usage. Shape, never values. */
  readonly onUnexpectedShape?: (keys: string[]) => void;
  /** Top-level keys of every JSON answer, for `npm run probe -- --keys`. */
  readonly onUsageKeys?: (keys: string[]) => void;
  /** Nested key names and types (`keyTreeLines`), never values. Same audience. */
  readonly onUsageShape?: (lines: string[]) => void;
}

function defaultExec(
  bin: string,
  args: readonly string[],
  timeout: number = EXEC_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      bin,
      [...args],
      {
        timeout,
        maxBuffer: EXEC_MAX_BUFFER,
        encoding: "utf8",
        // Windows only (ignored elsewhere): without it, every poll would
        // flash a PowerShell console window on the owner's screen.
        windowsHide: true,
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
export interface Endpoint {
  readonly port: number;
  readonly token: string;
}

/**
 * One Antigravity language server found on Windows, and what to try on it.
 * `endpoints` is empty when it has no token or no port yet: it still counts
 * as running, so the card says "did not answer" rather than "not running".
 */
export interface WindowsServer {
  readonly pid: number;
  readonly endpoints: readonly Endpoint[];
}

/**
 * Is this executable path Antigravity's own language server? The Windows
 * stand-in for the macOS `comm` check; see `ANTIGRAVITY_WIN_PATH_SUFFIX`.
 */
export function isAntigravityServerPath(path: string): boolean {
  return path
    .toLowerCase()
    .endsWith(ANTIGRAVITY_WIN_PATH_SUFFIX.toLowerCase());
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** `ports` as PowerShell 5.1 prints it: an array, a bare number, or nothing. */
function portsOf(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : [value];
  const ports: number[] = [];
  for (const port of raw) {
    if (isPositiveInteger(port) && port <= MAX_PORT && !ports.includes(port))
      ports.push(port);
  }
  return ports;
}

/**
 * The discovery script's stdout, read as servers. Pure, so the shapes
 * PowerShell 5.1 prints (one object or an array; a port or an array of them;
 * a byte-order mark, CRLF, or nothing at all) are tested without a PC.
 *
 * The match is checked again here rather than trusted from the script: a row
 * is kept only with a real pid, its own session equal to PowerShell's, and an
 * executable path that passes `isAntigravityServerPath`. Anything that does
 * not parse is no server, never a throw.
 */
export function parseWindowsDiscovery(stdout: string): WindowsServer[] {
  // `trim()` also drops a byte-order mark (U+FEFF counts as white space to
  // it), should PowerShell print one, and the CRLF it ends its output with.
  const text = stdout.trim();
  if (text === "") return [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const rows: unknown[] = Array.isArray(json) ? json : [json];
  const servers: WindowsServer[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const { pid, session, self, path, args, ports } = row as Record<
      string,
      unknown
    >;
    if (!isPositiveInteger(pid)) continue;
    // Session 0 is real (services), so "a number, and the same one" — not
    // "truthy" — is the test.
    if (typeof session !== "number" || session !== self) continue;
    if (typeof path !== "string" || !isAntigravityServerPath(path)) continue;
    // `--csrf_token`, never `--host_bridge_token=`: the regex names the
    // argument in full, so the other secret on the same line cannot match.
    const token = typeof args === "string" ? CSRF_ARG.exec(args)?.[1] : undefined;
    const endpoints =
      token === undefined || token.length === 0
        ? []
        : portsOf(ports).map((port) => ({ port, token }));
    servers.push({ pid, endpoints });
  }
  return servers;
}

export function createAntigravityProvider(
  deps: AntigravityDeps,
): UsageProvider {
  const platform = deps.platform ?? process.platform;
  const windows = platform === "win32";
  const timeout = execTimeoutFor(platform);
  const exec =
    deps.exec ?? ((bin: string, args: readonly string[]) => defaultExec(bin, args, timeout));
  /**
   * The last endpoint that answered 200, for as long as it keeps answering.
   * Never persisted and never logged — see the header.
   */
  let cached: Endpoint | null = null;

  /**
   * Every Antigravity server on this machine, each with a way to get the
   * endpoints worth trying on it; empty for "Antigravity is not running".
   * On macOS the endpoints are read per pid only when asked for, so the
   * order of child processes is exactly what it was before Windows existed:
   * `pgrep`, a `ps -o comm=` per match, then `ps -o args=` and `lsof` per
   * server in turn. On Windows one PowerShell call has already read them.
   */
  async function findServers(): Promise<
    (() => Promise<readonly Endpoint[]>)[]
  > {
    if (windows) {
      const servers = await discoverWindows();
      return servers.map((server) => async () => server.endpoints);
    }
    return (await findPids()).map((pid) => () => discover(pid));
  }

  /** The Windows discovery: one fixed PowerShell call, read by the pure parser. */
  async function discoverWindows(): Promise<WindowsServer[]> {
    let out: string;
    try {
      out = await exec(deps.powershellPath ?? winPowerShellPath(), [
        ...POWERSHELL_ARGS,
        ANTIGRAVITY_WIN_DISCOVERY_SCRIPT,
      ]);
    } catch {
      return [];
    }
    return parseWindowsDiscovery(out);
  }

  /**
   * The pids of this user's processes named `language_server_macos_arm`;
   * empty for "Antigravity is not running". `-U` is left out where there is
   * no uid (only reachable on Windows with `platform` forced to `darwin`, as
   * the tests do).
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
    // comm=` per match against this machine's own process table (on Windows,
    // the one PowerShell call), no socket and no network.
    async isAvailable(): Promise<boolean> {
      return (await findServers()).length > 0;
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
      const servers = await findServers();
      if (servers.length === 0) {
        return failure(
          ANTIGRAVITY_ID,
          "unavailable",
          ANTIGRAVITY_NOT_RUNNING_MESSAGE,
        );
      }
      // Several servers (two IDE windows) are all tried; the first endpoint
      // that answers wins.
      for (const endpointsOf of servers) {
        for (const candidate of await endpointsOf()) {
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
      // and now. Either way the next candidate is the one to try. On
      // Windows the TLS port answers a plain request with a 400 or closes
      // its connection, depending on the client (both seen 2026-11-18); a
      // closed connection rejects at once rather than waiting out the
      // timeout, so either way that port costs milliseconds.
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

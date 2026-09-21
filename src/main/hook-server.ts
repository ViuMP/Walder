/**
 * The Claude Code hook listener: a loopback HTTP server that turns Claude Code's
 * lifecycle hooks into Walder's head-perk.
 *
 * Claude Code's hooks run a shell command and pipe the event as JSON on stdin,
 * so the smallest thing that can carry them into a running Electron app is a
 * `curl` to a local port. That makes this the app's only inbound network
 * surface, and it is built accordingly:
 *
 *  - **bound to `127.0.0.1` only** — never `0.0.0.0`, so nothing off this
 *    machine can reach it, whatever the firewall says;
 *  - **one path, one method, one media type** (`POST /event`, `application/json`);
 *    everything else is 404/405/415;
 *  - **8 KB body cap** and a 2 s socket timeout, so a wedged or malicious client
 *    cannot hold memory or a socket in the main process;
 *  - **no `Origin` header allowed, and the `Host` must be loopback** — those two
 *    together are what stop a web page the owner happens to have open from
 *    driving the mascot (CSRF) or reaching it through a rebound DNS name;
 *  - **bodies are never logged.** The payload carries a session id and, on some
 *    hooks, transcript paths. Only the method, the path, the status and the
 *    mapped event name reach the log.
 *
 * Nothing here is trusted with anything: the only effect a request can have is
 * one of three fixed enum values handed to the behaviour coordinator.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { HookKind } from '../core/behaviour';
import type { HookSource } from '../core/bubble';
import { topLevelKeys } from '../providers/types';
import { vlog, warn } from './log';

/**
 * Which tool a request came from. Defined in `core/bubble.ts` (where the texts
 * that name the tool live) and re-exported here, so the wiring side can import
 * it from the listener that decides it.
 */
export type { HookSource };

/**
 * One mapped hook event: what happened, and which tool it happened in.
 *
 * The three optional fields are what the SESSIONS block on the hover card is
 * built from (`core/sessions.ts`): *which* session this was, and where it is
 * working. They are optional because neither source guarantees them — a Codex
 * body may omit `cwd`, and a hook never carries a pid at all — and because the
 * bubble, which is what this type was invented for, still reads only `kind`
 * and `source`.
 *
 * `pid` is never read from a body: it comes from the session-registry watcher,
 * which learns it from the file name. Carried here rather than in a second
 * event type so the two sources reach `onHook` as one shape — and because
 * commit B (click a row to raise that terminal) needs it.
 */
export interface HookEvent {
  readonly kind: HookKind;
  readonly source: HookSource;
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly pid?: number;
}

/**
 * The header Walder's own Codex hook command sets (WP9), case-insensitively —
 * Node lowercases every header name it parses.
 *
 * A header rather than a body field because the body is Codex's, verbatim: the
 * hook pipes the tool's stdin through untouched (`--data-binary @-`), so the
 * only place the installer can leave a mark of its own is the request line.
 * Anything without it is Claude Code, which is both the older installer and the
 * safer default — a mislabelled bubble is worse than an unlabelled one only if
 * it names the wrong tool.
 */
export const SOURCE_HEADER = 'x-walder-source';

/** The one route. */
export const HOOK_PATH = '/event';

/** Loopback only. Not configurable — see the note above. */
export const HOOK_HOST = '127.0.0.1';

/** Largest accepted body. A hook payload is a few hundred bytes. */
export const MAX_BODY_BYTES = 8 * 1024;

/** Socket timeout. A local `curl` that has not finished in 2 s is not going to. */
export const SOCKET_TIMEOUT_MS = 2_000;

/** How many consecutive ports to try when the preferred one is taken. */
export const PORT_ATTEMPTS = 3;

/**
 * How often Node sweeps open connections for expired header/request timeouts.
 * Its default is 30 s, which would make the 2 s timeouts above nominal.
 */
export const CONNECTIONS_CHECKING_INTERVAL_MS = 500;

/**
 * The hook event names of both tools, mapped onto what Walder does about them.
 *
 * `Stop` fires when a reply or a turn finishes; `Notification` when Claude Code
 * wants the owner's attention (permission, or an idle prompt); `UserPromptSubmit`
 * when the owner types the next thing, which is the natural end of a wait. All
 * three names are shared — Codex's hooks engine took Claude Code's schema —
 * which is why one table serves both and the *source* is decided by a header.
 *
 * `PermissionRequest` is Codex's approval event, and the only name that is not
 * shared in practice: Claude Code has one too, but Walder installs `Notification`
 * there (it covers the idle prompt as well), so mapping this is harmless in a
 * Claude session and the whole waiting story in a Codex one.
 */
const EVENT_KINDS: Readonly<Record<string, HookKind>> = {
  Stop: 'done',
  Notification: 'waiting',
  PermissionRequest: 'waiting',
  UserPromptSubmit: 'prompt'
};

export interface HookServerDeps {
  /** First port to try; `hookPort` from the store. */
  readonly port: number;
  readonly onEvent: (event: HookEvent) => void;
  /**
   * The port actually bound, so `install-hooks` writes the right URL. Called
   * exactly once per start — with `null` when nothing could be bound at all.
   *
   * **The `null` is the fix for a latent bug.** This used to fire only on
   * success, so a launch that bound nothing left `hookPortActual` holding the
   * port of some *earlier* run; the installer then wrote a hook pointing at a
   * port nothing is listening on, and it looked installed and did nothing —
   * exactly the failure `resolveHookPort` exists to prevent.
   */
  readonly onPort?: (port: number | null) => void;
  readonly attempts?: number;
}

export interface HookServer {
  /** The bound port, or `null` when nothing could be bound. */
  readonly port: number | null;
  close(): Promise<void>;
}

/** Read `event` or Claude Code's own `hook_event_name` from a parsed body. */
export function hookKindFrom(body: unknown): HookKind | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const name = record['event'] ?? record['hook_event_name'];
  if (typeof name !== 'string') return null;
  return EVENT_KINDS[name] ?? null;
}

/**
 * The Codex payload fields whose **values** may be logged, and nothing else.
 *
 * Why there is an allow-list at all: Victor sees `Codex waiting` bubbles while
 * Codex is merely working (2026-09-21). `~/.codex/hooks.json` installs `Stop`,
 * `PermissionRequest` and `UserPromptSubmit`, and this server maps
 * `PermissionRequest` to `waiting` — but nobody has ever seen a Codex hook
 * body, so we cannot tell whether its engine fires that event for commands it
 * then auto-approves. Without a capture there is nothing to reason about, and
 * a capture is exactly what this app is not allowed to take.
 *
 * So: key *names* for every accepted event (that is the standing rule — see
 * the module header and `test/log-hygiene.test.ts`), plus the values of these
 * three and only these three, and only from Codex. Each is an enum the engine
 * chooses from a fixed set — an event name, an approval mode, an
 * allow/deny verdict — so none of them can carry a path, a prompt or a
 * transcript. `cwd`, `session_id`, `transcript_path`, `command`, `tool_input`
 * and everything else stay key-name-only, whatever they are called.
 *
 * The value guard backs the list up rather than trusting it: a string, shorter
 * than `MAX_ENUM_CHARS`, and with no whitespace in it. A prose sentence, a
 * path with a space, a JSON blob and a wrapped transcript all fail at least
 * one of those, so a field that stops being an enum stops being logged instead
 * of quietly leaking.
 */
const CODEX_ENUM_KEYS: readonly string[] = ['hook_event_name', 'permission_mode', 'decision'];

/** An "enum" longer than this is not an enum any more. See `CODEX_ENUM_KEYS`. */
const MAX_ENUM_CHARS = 32;

/**
 * `key: value` for each allow-listed enum the body carries, Codex only.
 *
 * Empty for Claude Code, and empty for a Codex body that carries none of them
 * — which is itself the answer to the question this was added for, read off
 * the key-name list beside it.
 *
 * `key: value` and not `key=value`, which is not cosmetic: `log.ts`'s
 * catch-all redaction masks any unbroken 20-character run of
 * `[A-Za-z0-9+_=-]`, and `hook_event_name=PermissionRequest` is one. The space
 * breaks the run, so the backstop only fires on a value long enough to deserve
 * it — which, at up to `MAX_ENUM_CHARS`, one still can, and that is the right
 * way round.
 */
export function enumFieldsFrom(body: unknown, source: HookSource): string[] {
  if (source !== 'codex') return [];
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return [];
  const record = body as Record<string, unknown>;
  const out: string[] = [];
  for (const key of CODEX_ENUM_KEYS) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    if (value.length === 0 || value.length > MAX_ENUM_CHARS) continue;
    if (/\s/.test(value)) continue;
    out.push(`${key}: ${value}`);
  }
  return out;
}

/**
 * Longest `cwd` or `session_id` taken from a body.
 *
 * The body is already capped at 8 KB, so this is not a memory bound: it is the
 * bound on what reaches a structure the card iterates and the panel paints. A
 * real path is a couple of hundred characters and a session id is a UUID, so
 * anything past this is not the field it claims to be, and is dropped rather
 * than truncated — half a path is a path to somewhere else.
 */
export const MAX_DETAIL_CHARS = 1_024;

/**
 * The two identifying fields of a hook body, when they are strings.
 *
 * Claude Code's hook stdin JSON carries `cwd` and `session_id` beside the
 * event name, and Codex's engine copied that schema. Nothing about them is
 * trusted: they are read only if they are strings, dropped if they are longer
 * than `MAX_DETAIL_CHARS`, and they are **never logged** — `cwd` is a path on
 * the owner's own disk, which is the payload-value rule this app has had since
 * 0.1 (see the header, and `test/log-hygiene.test.ts`).
 */
export function hookDetailsFrom(body: unknown): { cwd?: string; sessionId?: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  const cwd = record['cwd'];
  const sessionId = record['session_id'];
  return {
    ...(typeof cwd === 'string' && cwd.length <= MAX_DETAIL_CHARS ? { cwd } : {}),
    ...(typeof sessionId === 'string' && sessionId.length <= MAX_DETAIL_CHARS
      ? { sessionId }
      : {})
  };
}

/**
 * Is the `Host` header loopback?
 *
 * The socket is already bound to 127.0.0.1, so the only way a request arrives
 * with a foreign `Host` is DNS rebinding: a page on the open internet resolving
 * its own hostname to 127.0.0.1 and then talking to whatever answers. Checking
 * the header costs one comparison and closes that door.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  // Strip the port; IPv6 literals arrive bracketed.
  const name = host.startsWith('[')
    ? (host.slice(1, host.indexOf(']')) || host)
    : (host.split(':')[0] ?? '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

/**
 * Is the request's media type `application/json`?
 *
 * The check is the other half of the `Origin` rule, aimed at the same attacker.
 * A cross-site `fetch` can be made *without* an `Origin` header only by staying
 * inside the "simple request" set, and the three media types that set allows —
 * `text/plain`, `application/x-www-form-urlencoded`, `multipart/form-data` —
 * exclude JSON. Requiring JSON therefore forces any browser caller into a
 * preflight, which this server answers with a 403 (and no CORS headers), so the
 * real request is never sent. `curl`, which is what Claude Code's hook runs,
 * already sends `Content-Type: application/json`.
 *
 * Case-insensitive on the media type, and parameters (`; charset=utf-8`) are
 * ignored — both are what RFC 9110 says a recipient must do.
 */
export function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const media = (value.split(';')[0] ?? '').trim().toLowerCase();
  return media === 'application/json';
}

/**
 * Reply with a status and nothing else. Never echoes anything from the request.
 *
 * No `Access-Control-Allow-*` header is ever set, on any path through this
 * function — that is deliberate and is what makes a rejected browser request
 * unreadable to the page that made it, rather than merely refused.
 */
function reply(res: ServerResponse, status: number): void {
  res.statusCode = status;
  res.setHeader('Content-Length', '0');
  // No cross-origin access, ever: there is no legitimate browser caller.
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

/**
 * Has the "a hook reached us and was refused" warning been printed this run?
 *
 * Module scope, so it is once per *process* and not once per listener: a second
 * `startHookServer` in the same run is a retry, not a new machine, and the owner
 * needs the sentence once either way.
 */
let refusalWarned = false;

/**
 * Refuse a request that *arrived at our route* — wrong media type, wrong
 * origin, unparseable body, oversized body — and say so where the owner can
 * see it, once.
 *
 * These four used to be `vlog` only, and that is how 0.2.4 hid the whole
 * failure on the owner's machine: his hooks were missing, nothing reached the
 * server, and even when something did the refusal was invisible unless Verbose
 * log happened to be on. A request that gets this far is a hook somebody
 * installed — a stale command, a shell mangling the body — so the first one is
 * worth a warning that names the fix. After that it goes back to `vlog`: a
 * broken hook fires on every reply, and a log full of the same line is a log
 * nobody reads.
 *
 * 404 and 405 are deliberately *not* here, and `handle` is ordered so they
 * cannot be: the **path test runs first**, before the `Host` and `Origin`
 * refusals, so a request that never addressed `/event` is a 404 and says
 * nothing. It is as likely to be a port scan as a hook — anything at all can
 * knock on a loopback port, and "reinstall your hooks" is the wrong sentence to
 * print because something probed `/`.
 *
 * The **method** test deliberately stays *below* the two refusals, which is the
 * one place the order is not simply "cheapest test first": a CORS preflight is
 * `OPTIONS /event` *with* an `Origin`, and it must come back 403 with no
 * `Access-Control-Allow-*` header rather than a 405 that tells the page which
 * methods it may try. A wrong-`Host`/`Origin` request to `/event` is a hook
 * somebody installed badly (or a page trying its luck), and both are worth the
 * one warning.
 *
 * The 204 that drops an event we do not subscribe to is not here either — that
 * one is the healthy case.
 */
function refuse(res: ServerResponse, status: number, shape: string): void {
  if (refusalWarned) {
    vlog(`hook request refused: ${shape}`);
  } else {
    refusalWarned = true;
    warn(
      `a hook reached Walder but was refused: ${shape}; the installed hook command ` +
        `is probably stale — reinstall from the tray`
    );
  }
  reply(res, status);
}

/** Read at most `MAX_BODY_BYTES`; resolves `null` when the cap is exceeded. */
async function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      resolve(value);
    };

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(null));
    req.on('aborted', () => finish(null));
  });
}

/** `codex` only when Walder's own Codex hook said so; everything else is Claude. */
export function hookSourceFrom(value: string | string[] | undefined): HookSource {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim().toLowerCase() === 'codex' ? 'codex' : 'claude';
}

function handle(req: IncomingMessage, res: ServerResponse, onEvent: (event: HookEvent) => void): void {
  const method = req.method ?? '';
  // `req.url` is a path here, never absolute — but parse defensively so a
  // query string or a `//` prefix cannot slip past the equality test.
  const path = (req.url ?? '').split('?')[0] ?? '';

  // The path first, and *before* the two refusals below: only a request that
  // actually addressed our route can be a broken hook, and only a broken hook
  // is worth the once-per-run "reinstall from the tray" warning. See `refuse`.
  if (path !== HOOK_PATH) {
    reply(res, 404);
    return;
  }
  if (!isLoopbackHost(req.headers.host)) {
    refuse(res, 403, 'non-loopback Host');
    return;
  }
  if (req.headers.origin !== undefined) {
    // A browser sends `Origin` on every cross-site request; `curl` sends none.
    refuse(res, 403, 'browser origin');
    return;
  }
  // Below the two refusals on purpose: a CORS preflight is `OPTIONS /event`
  // with an `Origin`, and it must be refused rather than answered with an
  // `Allow` list. See `refuse`.
  if (method !== 'POST') {
    res.setHeader('Allow', 'POST');
    reply(res, 405);
    return;
  }
  if (!isJsonContentType(req.headers['content-type'])) {
    refuse(res, 415, 'not application/json');
    return;
  }

  const source = hookSourceFrom(req.headers[SOURCE_HEADER]);

  void readBody(req).then((raw) => {
    if (raw === null) {
      refuse(res, 413, 'body over the cap');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Deliberately not logged with the body: it may carry a transcript path.
      refuse(res, 400, 'body was not JSON');
      return;
    }

    const kind = hookKindFrom(parsed);
    // An unrecognised hook name is accepted and dropped, not rejected: Claude
    // Code has more hooks than we subscribe to, and a non-2xx would make the
    // owner's hook noisy for an event we simply do not care about.
    if (kind === null) {
      vlog('hook event ignored (not one of ours)');
      reply(res, 204);
      return;
    }

    /*
     * The mapped name, the tool, the payload's top-level **key names**, and —
     * for Codex — the handful of allow-listed enum values (`CODEX_ENUM_KEYS`).
     * Never a value beyond those: `cwd` is a path on the owner's own disk and
     * `transcript_path` points at everything he has ever typed at the CLI.
     *
     * The key names are the diagnostic. `Codex waiting` fires while Codex is
     * only working, and the one thing that would settle it is knowing which
     * event Codex actually sends and what it sends with it — a
     * `PermissionRequest` carrying `decision=approved` is an auto-approval we
     * should not be calling a wait, and `permission_mode` says whether the
     * session was ever going to ask. One line per accepted event, at `vlog`,
     * so it costs nothing until the owner turns the diagnostics on.
     */
    const enums = enumFieldsFrom(parsed, source);
    vlog(
      'hook event ->',
      source,
      kind,
      `keys: ${topLevelKeys(parsed).sort().join(',')}`,
      ...enums
    );
    reply(res, 204);
    try {
      onEvent({ kind, source, ...hookDetailsFrom(parsed) });
    } catch (error) {
      warn('hook handler threw:', error);
    }
  });
}

/** Try to bind one port. Resolves `false` on `EADDRINUSE`, rejects otherwise. */
async function listenOn(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolve(false);
        return;
      }
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOOK_HOST);
  });
}

/**
 * Start the listener, walking up to `PORT_ATTEMPTS` consecutive ports.
 *
 * The walk exists because the port is a fixed default (47811) that another copy
 * of something may already hold; the port actually bound is reported through
 * `onPort` so the hook command written into `~/.claude/settings.json` points at
 * the right one. Failing to bind is a *degraded* state, not a fatal one: the dog
 * simply never perks, and everything else works.
 */
export async function startHookServer(deps: HookServerDeps): Promise<HookServer> {
  const attempts = Math.max(1, deps.attempts ?? PORT_ATTEMPTS);
  const first = Math.max(1024, Math.min(65_535, Math.trunc(deps.port)));

  for (let offset = 0; offset < attempts; offset++) {
    const port = first + offset;
    if (port > 65_535) break;

    const server = createServer((req, res) => handle(req, res, deps.onEvent));
    server.setTimeout(SOCKET_TIMEOUT_MS, (socket) => socket.destroy());
    server.headersTimeout = SOCKET_TIMEOUT_MS;
    server.requestTimeout = SOCKET_TIMEOUT_MS;
    // Node enforces `headersTimeout`/`requestTimeout` from a sweep whose default
    // period is 30 s, so a 2 s timeout is really "2 s, checked every 30 s" —
    // long enough for a stalled socket to sit in the main process for half a
    // minute. 500 ms makes the two timeouts mean what they say. Guarded by a
    // property check because it is a relatively recent addition and this is the
    // only place in the app that depends on a Node internal's name.
    if ('connectionsCheckingInterval' in server) {
      (server as unknown as { connectionsCheckingInterval: number }).connectionsCheckingInterval =
        CONNECTIONS_CHECKING_INTERVAL_MS;
    }
    // Errors after a successful bind (a client resetting mid-request) must not
    // reach the process's uncaught handler.
    server.on('error', (error) => warn('hook server error:', error));

    let bound = false;
    try {
      bound = await listenOn(server, port);
    } catch (error) {
      warn(`hook server could not bind ${HOOK_HOST}:${port}:`, error);
      server.close();
      continue;
    }

    if (!bound) {
      server.close();
      vlog(`hook port ${port} is taken; trying the next`);
      continue;
    }

    vlog(`hook server listening on http://${HOOK_HOST}:${port}${HOOK_PATH}`);
    deps.onPort?.(port);

    return {
      port,
      close: async (): Promise<void> =>
        new Promise((resolve) => {
          server.close(() => resolve());
          // A keep-alive socket would otherwise hold the close open past quit.
          server.closeAllConnections?.();
        })
    };
  }

  warn(
    `hook server could not bind any of ports ${first}-${first + attempts - 1}; ` +
      `Claude Code hook events will be ignored this session`
  );
  // Reported, not skipped: a stored port from an earlier run must not survive a
  // launch that bound nothing — see `onPort`.
  deps.onPort?.(null);
  return { port: null, close: async (): Promise<void> => undefined };
}

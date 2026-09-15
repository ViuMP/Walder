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
import { vlog, warn } from './log';

/**
 * Which tool a request came from. Defined in `core/bubble.ts` (where the texts
 * that name the tool live) and re-exported here, so the wiring side can import
 * it from the listener that decides it.
 */
export type { HookSource };

/** One mapped hook event: what happened, and which tool it happened in. */
export interface HookEvent {
  readonly kind: HookKind;
  readonly source: HookSource;
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
 * Claude Code's hook event names, mapped onto what Walder does about them.
 *
 * `Stop` fires when a reply finishes; `Notification` when Claude Code wants the
 * owner's attention (permission, or an idle prompt); `UserPromptSubmit` when the
 * owner types the next thing, which is the natural end of a wait.
 */
const EVENT_KINDS: Readonly<Record<string, HookKind>> = {
  Stop: 'done',
  Notification: 'waiting',
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
 * 404 and 405 are deliberately *not* here (they are not our route at all, so
 * they are as likely to be a port scan as a hook), and neither is the 204 that
 * drops an event we do not subscribe to — that one is the healthy case.
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

  if (!isLoopbackHost(req.headers.host)) {
    refuse(res, 403, 'non-loopback Host');
    return;
  }
  if (req.headers.origin !== undefined) {
    // A browser sends `Origin` on every cross-site request; `curl` sends none.
    refuse(res, 403, 'browser origin');
    return;
  }
  if (path !== HOOK_PATH) {
    reply(res, 404);
    return;
  }
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

    vlog('hook event ->', source, kind);
    reply(res, 204);
    try {
      onEvent({ kind, source });
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

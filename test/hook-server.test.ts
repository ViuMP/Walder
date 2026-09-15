/**
 * The Claude Code hook listener, driven over a real socket.
 *
 * This is the app's only inbound network surface, so the tests are mostly about
 * what it *refuses*: a wrong path, a wrong method, a wrong media type, an
 * oversized body, a browser origin, a rebound hostname. A real `http.Server` on
 * an ephemeral port is used rather than a mocked request object, because half of
 * what is being asserted (the body cap firing mid-stream, the loopback bind)
 * only exists at that level.
 *
 * Every reply is also checked for two things that must hold on *all* of them:
 * no `Access-Control-Allow-Origin` (a refused browser request must be
 * unreadable, not merely refused) and no body at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import type { HookKind } from '../src/core/behaviour';
import {
  MAX_BODY_BYTES,
  SOURCE_HEADER,
  hookKindFrom,
  hookSourceFrom,
  isJsonContentType,
  isLoopbackHost,
  startHookServer,
  type HookEvent,
  type HookServer
} from '../src/main/hook-server';

/** Ports are picked high and randomly, so parallel runs do not collide. */
function ephemeralPort(): number {
  return 41_000 + Math.floor(Math.random() * 20_000);
}

interface Reply {
  readonly status: number;
}

interface RawReply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/**
 * One raw request against the listener, with the full reply.
 *
 * `contentType: null` omits the header entirely, which is what a client that
 * posts without one looks like.
 */
async function raw(
  port: number,
  path: string,
  body: string | Buffer,
  opts: {
    method?: string;
    host?: string;
    origin?: string;
    contentType?: string | null;
    source?: string;
  } = {}
): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'POST',
        // One socket per request: the 413 path destroys the socket mid-upload,
        // and a pooled connection would carry that reset into the next request.
        agent: false,
        headers: {
          ...(opts.contentType === null
            ? {}
            : { 'Content-Type': opts.contentType ?? 'application/json' }),
          ...(opts.host === undefined ? {} : { Host: opts.host }),
          ...(opts.origin === undefined ? {} : { Origin: opts.origin }),
          // Deliberately in the casing Walder's own hook writes it, so the
          // lookup is exercised against Node's lowercasing rather than ours.
          ...(opts.source === undefined ? {} : { 'X-Walder-Source': opts.source })
        }
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text })
        );
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * `raw`, reduced to the status — and asserting on the way past that the reply
 * carries neither a CORS grant nor a body. Every request in this file goes
 * through here, so those two invariants are checked on every status code the
 * server can produce rather than in one token test.
 */
async function post(
  port: number,
  path: string,
  body: string | Buffer,
  opts: {
    method?: string;
    host?: string;
    origin?: string;
    contentType?: string | null;
    source?: string;
  } = {}
): Promise<Reply> {
  const reply = await raw(port, path, body, opts);
  expect(reply.headers['access-control-allow-origin'], 'CORS grant leaked').toBeUndefined();
  expect(reply.body, 'reply carried a body').toBe('');
  return { status: reply.status };
}

let server: HookServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

/**
 * Start a listener and collect every event it maps.
 *
 * `events` holds the *kinds*, because that is what nearly every case here is
 * about; `full` holds the whole event for the handful that care which tool it
 * came from. Two arrays rather than one derived view, because every caller
 * destructures this — and a getter would then be read once, before the request
 * it is about has even been sent.
 */
async function listener(): Promise<{ port: number; events: HookKind[]; full: HookEvent[] }> {
  const events: HookKind[] = [];
  const full: HookEvent[] = [];
  const started = await startHookServer({
    port: ephemeralPort(),
    onEvent: (event) => {
      events.push(event.kind);
      full.push(event);
    }
  });
  server = started;
  if (started.port === null) throw new Error('could not bind a test port');
  return { port: started.port, events, full };
}

describe('hookKindFrom', () => {
  it('reads Claude Code’s own key as well as ours', () => {
    expect(hookKindFrom({ event: 'Stop' })).toBe('done');
    expect(hookKindFrom({ hook_event_name: 'Stop' })).toBe('done');
  });

  it('maps the three events we subscribe to', () => {
    expect(hookKindFrom({ event: 'Stop' })).toBe('done');
    expect(hookKindFrom({ event: 'Notification' })).toBe('waiting');
    expect(hookKindFrom({ event: 'UserPromptSubmit' })).toBe('prompt');
    // Codex's approval event, and the only name the two tools do not share in
    // practice: Walder installs `Notification` on the Claude side because it
    // covers the idle prompt too.
    expect(hookKindFrom({ event: 'PermissionRequest' })).toBe('waiting');
    expect(hookKindFrom({ hook_event_name: 'PermissionRequest' })).toBe('waiting');
  });

  it('returns null for anything else', () => {
    expect(hookKindFrom({ event: 'PreToolUse' })).toBeNull();
    expect(hookKindFrom({ event: 42 })).toBeNull();
    expect(hookKindFrom({})).toBeNull();
    expect(hookKindFrom(null)).toBeNull();
    expect(hookKindFrom([{ event: 'Stop' }])).toBeNull();
    expect(hookKindFrom('Stop')).toBeNull();
  });
});

describe('isLoopbackHost', () => {
  it('accepts the loopback names with and without a port', () => {
    for (const host of ['127.0.0.1', '127.0.0.1:47811', 'localhost', 'localhost:47811', '[::1]:1']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('rejects a rebound hostname and a missing header', () => {
    expect(isLoopbackHost('evil.example.com')).toBe(false);
    expect(isLoopbackHost('evil.example.com:47811')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe('isJsonContentType', () => {
  it('accepts the media type with any parameters and any casing', () => {
    for (const value of [
      'application/json',
      'application/json; charset=utf-8',
      'APPLICATION/JSON',
      ' application/json ',
      'Application/Json;charset=UTF-8'
    ]) {
      expect(isJsonContentType(value), value).toBe(true);
    }
  });

  it('rejects everything else, including a missing header', () => {
    for (const value of [
      'text/plain',
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/json-patch+json',
      'application/jsonx',
      ''
    ]) {
      expect(isJsonContentType(value), value).toBe(false);
    }
    expect(isJsonContentType(undefined)).toBe(false);
  });
});

describe('startHookServer', () => {
  it('accepts a Stop hook and maps it to a perk', async () => {
    const { port, events } = await listener();
    expect(await post(port, '/event', JSON.stringify({ event: 'Stop' }))).toEqual({ status: 204 });
    expect(events).toEqual(['done']);
  });

  it('accepts Claude Code’s raw hook payload on the same route', async () => {
    const { port, events } = await listener();
    const raw = JSON.stringify({
      hook_event_name: 'Notification',
      session_id: 'abc123',
      message: 'Claude needs your permission'
    });
    expect(await post(port, '/event', raw)).toEqual({ status: 204 });
    expect(events).toEqual(['waiting']);
  });

  it('accepts a hook name it does not care about, and does nothing', async () => {
    const { port, events } = await listener();
    // A non-2xx here would make the owner's hook noisy for an event we ignore.
    expect(await post(port, '/event', JSON.stringify({ event: 'PreToolUse' }))).toEqual({
      status: 204
    });
    expect(events).toEqual([]);
  });

  it('404s any other path', async () => {
    const { port, events } = await listener();
    expect(await post(port, '/', '{}')).toEqual({ status: 404 });
    expect(await post(port, '/events', '{}')).toEqual({ status: 404 });
    expect(await post(port, '/event/../admin', '{}')).toEqual({ status: 404 });
    expect(events).toEqual([]);
  });

  it('ignores a query string on the one route it has', async () => {
    const { port, events } = await listener();
    expect(await post(port, '/event?x=1', JSON.stringify({ event: 'Stop' }))).toEqual({
      status: 204
    });
    expect(events).toEqual(['done']);
  });

  it('405s a method other than POST', async () => {
    const { port, events } = await listener();
    expect(await post(port, '/event', '', { method: 'GET' })).toEqual({ status: 405 });
    expect(await post(port, '/event', '{}', { method: 'PUT' })).toEqual({ status: 405 });
    expect(events).toEqual([]);
  });

  /**
   * The media-type gate. A cross-site `fetch` can omit `Origin` only by staying
   * inside the "simple request" set, whose three allowed media types exclude
   * JSON — so requiring JSON forces a preflight, and the preflight is refused.
   */
  it('415s a media type other than application/json', async () => {
    const { port, events } = await listener();
    const body = JSON.stringify({ event: 'Stop' });
    for (const contentType of [
      'text/plain',
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x'
    ]) {
      expect(await post(port, '/event', body, { contentType }), contentType).toEqual({
        status: 415
      });
    }
    // And a request with no Content-Type at all.
    expect(await post(port, '/event', body, { contentType: null })).toEqual({ status: 415 });
    expect(events).toEqual([]);
  });

  it('accepts application/json with a charset parameter', async () => {
    const { port, events } = await listener();
    const reply = await post(port, '/event', JSON.stringify({ event: 'Stop' }), {
      contentType: 'application/json; charset=utf-8'
    });
    expect(reply).toEqual({ status: 204 });
    expect(events).toEqual(['done']);
  });

  it('403s a CORS preflight instead of granting it', async () => {
    const { port, events } = await listener();
    // What a browser sends before a cross-site JSON POST. The `Origin` rule
    // catches it first, and no `Access-Control-Allow-*` header comes back — so
    // the page never gets permission to send the real request.
    const reply = await raw(port, '/event', '', {
      method: 'OPTIONS',
      origin: 'https://example.com',
      contentType: null
    });
    expect(reply.status).toBe(403);
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    expect(reply.headers['access-control-allow-methods']).toBeUndefined();
    expect(reply.headers['access-control-allow-headers']).toBeUndefined();
    expect(reply.body).toBe('');
    expect(events).toEqual([]);
  });

  it('never carries a CORS grant or a body, whatever the status', async () => {
    const { port } = await listener();
    // One request per status code the server can produce. `post` asserts the
    // absence of both on each; this test is what pins the *coverage*.
    const seen = [
      (await post(port, '/event', JSON.stringify({ event: 'Stop' }))).status,
      (await post(port, '/nope', '{}')).status,
      (await post(port, '/event', '{}', { method: 'GET' })).status,
      (await post(port, '/event', '{}', { contentType: 'text/plain' })).status,
      (await post(port, '/event', 'not json')).status,
      (await post(port, '/event', Buffer.alloc(MAX_BODY_BYTES + 1, 0x61))).status,
      (await post(port, '/event', '{}', { origin: 'https://example.com' })).status
    ];
    expect(seen).toEqual([204, 404, 405, 415, 400, 413, 403]);
  });

  it('413s a body over the cap', async () => {
    const { port, events } = await listener();
    const huge = Buffer.alloc(MAX_BODY_BYTES + 1, 0x61);
    expect(await post(port, '/event', huge)).toEqual({ status: 413 });
    expect(events).toEqual([]);
  });

  it('accepts a body right at the cap', async () => {
    const { port, events } = await listener();
    // Valid JSON padded out to exactly the limit.
    const padding = 'x'.repeat(MAX_BODY_BYTES - JSON.stringify({ event: 'Stop', pad: '' }).length);
    const body = JSON.stringify({ event: 'Stop', pad: padding });
    expect(body.length).toBe(MAX_BODY_BYTES);
    expect(await post(port, '/event', body)).toEqual({ status: 204 });
    expect(events).toEqual(['done']);
  });

  it('400s a body that is not JSON', async () => {
    const { port, events } = await listener();
    expect(await post(port, '/event', 'not json at all')).toEqual({ status: 400 });
    expect(await post(port, '/event', '')).toEqual({ status: 400 });
    expect(events).toEqual([]);
  });

  it('403s a request carrying a browser Origin', async () => {
    const { port, events } = await listener();
    const reply = await post(port, '/event', JSON.stringify({ event: 'Stop' }), {
      origin: 'https://example.com'
    });
    expect(reply).toEqual({ status: 403 });
    expect(events).toEqual([]);
  });

  it('403s a request whose Host is not loopback (DNS rebinding)', async () => {
    const { port, events } = await listener();
    const reply = await post(port, '/event', JSON.stringify({ event: 'Stop' }), {
      host: 'evil.example.com'
    });
    expect(reply).toEqual({ status: 403 });
    expect(events).toEqual([]);
  });

  it('walks to the next port when the preferred one is taken', async () => {
    const port = ephemeralPort();
    const first = await startHookServer({ port, onEvent: () => undefined });
    const second = await startHookServer({ port, onEvent: () => undefined });
    try {
      expect(first.port).toBe(port);
      expect(second.port).toBe(port + 1);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('reports the bound port through onPort', async () => {
    const ports: (number | null)[] = [];
    const started = await startHookServer({
      port: ephemeralPort(),
      onEvent: () => undefined,
      onPort: (bound) => ports.push(bound)
    });
    server = started;
    expect(ports).toEqual([started.port]);
  });

  /**
   * The latent bug this closes: `onPort` used to fire only on success, so a
   * launch that bound nothing left `hookPortActual` holding an *earlier* run's
   * port — and the installer then wrote a hook pointing at a closed door, which
   * looks installed and does nothing.
   */
  it('reports null through onPort when nothing could be bound', async () => {
    const port = ephemeralPort();
    const ports: (number | null)[] = [];
    const held = await Promise.all([
      startHookServer({ port, onEvent: () => undefined, attempts: 1 }),
      startHookServer({ port: port + 1, onEvent: () => undefined, attempts: 1 }),
      startHookServer({ port: port + 2, onEvent: () => undefined, attempts: 1 })
    ]);
    try {
      const blocked = await startHookServer({
        port,
        onEvent: () => undefined,
        onPort: (bound) => ports.push(bound)
      });
      expect(blocked.port).toBeNull();
      expect(ports).toEqual([null]);
      await blocked.close();
    } finally {
      await Promise.all(held.map((one) => one.close()));
    }
  });

  it('degrades to no listener rather than throwing when every port is taken', async () => {
    const port = ephemeralPort();
    const held = await Promise.all([
      startHookServer({ port, onEvent: () => undefined, attempts: 1 }),
      startHookServer({ port: port + 1, onEvent: () => undefined, attempts: 1 }),
      startHookServer({ port: port + 2, onEvent: () => undefined, attempts: 1 })
    ]);
    try {
      const blocked = await startHookServer({ port, onEvent: () => undefined });
      expect(blocked.port).toBeNull();
      // Closing a listener that never bound is still safe.
      await blocked.close();
    } finally {
      await Promise.all(held.map((one) => one.close()));
    }
  });

  /**
   * Which tool sent it. Claude Code's own hook command carries no header of
   * ours (it pipes the tool's stdin through verbatim), so "no header" must mean
   * Claude — and only Walder's own Codex installer writes the header that says
   * otherwise.
   */
  describe('the source header', () => {
    it('reads codex from the header, whatever its casing', () => {
      expect(hookSourceFrom('codex')).toBe('codex');
      expect(hookSourceFrom('Codex')).toBe('codex');
      expect(hookSourceFrom(' CODEX ')).toBe('codex');
      // A repeated header arrives as a list; the first value decides.
      expect(hookSourceFrom(['codex', 'claude'])).toBe('codex');
    });

    it('falls back to claude for anything else', () => {
      expect(hookSourceFrom(undefined)).toBe('claude');
      expect(hookSourceFrom('')).toBe('claude');
      expect(hookSourceFrom('claude')).toBe('claude');
      expect(hookSourceFrom('gemini')).toBe('claude');
    });

    it('tags a request carrying the header as codex', async () => {
      const { port, full } = await listener();
      expect(
        await post(port, '/event', JSON.stringify({ event: 'Stop' }), { source: 'codex' })
      ).toEqual({ status: 204 });
      expect(full).toEqual([{ kind: 'done', source: 'codex' }]);
      expect(SOURCE_HEADER).toBe('x-walder-source');
    });

    it('tags a request without it as claude', async () => {
      const { port, full } = await listener();
      await post(port, '/event', JSON.stringify({ event: 'Notification' }));
      expect(full).toEqual([{ kind: 'waiting', source: 'claude' }]);
    });

    /** The whole Codex waiting path end to end: its event plus its header. */
    it('turns a Codex approval prompt into a codex wait', async () => {
      const { port, full } = await listener();
      expect(
        await post(port, '/event', JSON.stringify({ hook_event_name: 'PermissionRequest' }), {
          source: 'codex'
        })
      ).toEqual({ status: 204 });
      expect(full).toEqual([{ kind: 'waiting', source: 'codex' }]);
    });
  });

  /**
   * A refused request means somebody's hook is broken, and 0.2.4 said so only
   * to a Verbose log nobody had on — which is how a whole dead pipeline stayed
   * invisible for days. It is now one `warn`, and *one*: a broken hook fires on
   * every reply, and a log full of the same line is a log nobody reads.
   *
   * The module is re-imported so the once-per-process flag starts fresh; every
   * other test in this file shares one copy of it.
   */
  it('warns once per run about a refused hook, then goes quiet', async () => {
    vi.resetModules();
    // Both from the fresh registry: a `setLogSink` on the *outer* copy of
    // `log.ts` would be invisible to the fresh server's own copy of it.
    const fresh = await import('../src/main/hook-server');
    const freshLog = await import('../src/main/log');
    const lines: string[] = [];
    freshLog.setLogSink((line) => lines.push(line));
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const started = await fresh.startHookServer({
      port: ephemeralPort(),
      onEvent: () => undefined
    });
    try {
      if (started.port === null) throw new Error('could not bind a test port');
      // Four different refusal shapes, so this is not merely "the same one
      // twice": 415, 400, 413 and the browser-origin 403.
      await post(started.port, '/event', '{}', { contentType: 'text/plain' });
      await post(started.port, '/event', 'not json');
      await post(started.port, '/event', Buffer.alloc(MAX_BODY_BYTES + 1, 0x61));
      await post(started.port, '/event', '{}', { origin: 'https://example.com' });

      const warned = lines.filter((line) => line.includes('was refused'));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain('reinstall from the tray');
      // A healthy hook is still silent, and still works.
      expect(await post(started.port, '/event', JSON.stringify({ event: 'Stop' }))).toEqual({
        status: 204
      });
    } finally {
      await started.close();
      freshLog.setLogSink(null);
      quiet.mockRestore();
    }
  });

  /**
   * The other half of that warning: it must only ever be about *our* route.
   *
   * A loopback port gets knocked on by all sorts — a port scanner, a browser
   * tab the owner left on some `localhost:` dev page, another app probing for
   * its own service. None of that is a hook, so "reinstall from the tray" is
   * the wrong sentence, and printing it once per run means the *first* such
   * knock would burn the one warning a genuinely broken hook needs. So the path
   * test runs above the `Host` and `Origin` refusals, and this pins it with the
   * worst case: a real browser request, complete with `Origin`, to `/`.
   */
  it('404s a browser request to another path without warning about hooks', async () => {
    vi.resetModules();
    const fresh = await import('../src/main/hook-server');
    const freshLog = await import('../src/main/log');
    const lines: string[] = [];
    freshLog.setLogSink((line) => lines.push(line));
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const started = await fresh.startHookServer({
      port: ephemeralPort(),
      onEvent: () => undefined
    });
    try {
      if (started.port === null) throw new Error('could not bind a test port');
      expect(
        await post(started.port, '/', '{}', { origin: 'https://example.com' })
      ).toEqual({ status: 404 });
      expect(lines.filter((line) => line.includes('was refused'))).toEqual([]);

      // And the warning is still available for the request that deserves it —
      // a bad `Origin` on `/event` is a 403 with no CORS header, as before.
      expect(
        await post(started.port, '/event', '{}', { origin: 'https://example.com' })
      ).toEqual({ status: 403 });
      expect(lines.filter((line) => line.includes('was refused'))).toHaveLength(1);
    } finally {
      await started.close();
      freshLog.setLogSink(null);
      quiet.mockRestore();
    }
  });

  it('survives a handler that throws', async () => {
    const started = await startHookServer({
      port: ephemeralPort(),
      onEvent: () => {
        throw new Error('boom');
      }
    });
    server = started;
    if (started.port === null) throw new Error('could not bind a test port');
    expect(await post(started.port, '/event', JSON.stringify({ event: 'Stop' }))).toEqual({
      status: 204
    });
  });
});

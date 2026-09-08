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
import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import type { HookKind } from '../src/core/behaviour';
import {
  MAX_BODY_BYTES,
  hookKindFrom,
  isJsonContentType,
  isLoopbackHost,
  startHookServer,
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
  opts: { method?: string; host?: string; origin?: string; contentType?: string | null } = {}
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
          ...(opts.origin === undefined ? {} : { Origin: opts.origin })
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
  opts: { method?: string; host?: string; origin?: string; contentType?: string | null } = {}
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

/** Start a listener and collect every event it maps. */
async function listener(): Promise<{ port: number; events: HookKind[] }> {
  const events: HookKind[] = [];
  const started = await startHookServer({
    port: ephemeralPort(),
    onEvent: (kind) => events.push(kind)
  });
  server = started;
  if (started.port === null) throw new Error('could not bind a test port');
  return { port: started.port, events };
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
    const ports: number[] = [];
    const started = await startHookServer({
      port: ephemeralPort(),
      onEvent: () => undefined,
      onPort: (bound) => ports.push(bound)
    });
    server = started;
    expect(ports).toEqual([started.port]);
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

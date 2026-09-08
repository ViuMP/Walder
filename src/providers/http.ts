/**
 * Adapter from a WHATWG `fetch`-shaped function to the providers' `HttpFetch`.
 *
 * Three different implementations are wrapped by this one function:
 *  - `net.fetch` in the main process (Chromium's stack, no cookie jar),
 *  - `session.fromPartition('persist:…').fetch` (same, *with* that partition's
 *    cookies — which is the whole mechanism behind the two web providers),
 *  - Node's global `fetch` in `scripts/probe.ts`, which runs outside Electron.
 *
 * The adapter owns the bounds the providers must not each re-implement, and each
 * one is a safety rule rather than a nicety:
 *
 *  - **The timeout** (via `AbortController`), so a hung endpoint cannot stall a
 *    poll forever.
 *  - **`redirect: 'manual'`.** Every provider request either carries the owner's
 *    cookies or an `Authorization: Bearer` header, and `redirect: 'follow'`
 *    would let an endpoint that has been repointed decide where those go. A
 *    cross-origin redirect is therefore never followed: it comes back as
 *    `{ok: false, redirected: true}`, which `classifyHttp` maps to
 *    `endpoint-changed` — the honest answer, since the endpoint has indeed
 *    moved. A *same-origin* `Location` may be followed exactly once (login flows
 *    legitimately bounce `/api/x` to `/api/x/`), and a second redirect ends the
 *    call.
 *  - **A 1 MB body cap.** These endpoints return small JSON documents; anything
 *    larger is either not the endpoint we think it is or a way to make the main
 *    process eat memory. The body is read through the response stream where the
 *    implementation exposes one, so an oversized body is abandoned rather than
 *    buffered, and the result is marked `truncated` (again `endpoint-changed`).
 *  - **Reading the body to text exactly once**, and **never throwing for an HTTP
 *    status** — a 401 is a *result*, and each provider maps it to a
 *    `SourceStatus` itself.
 *  - **An explicit `credentials` mode**, chosen once per adapter — and this is
 *    the bug fix of 2026-09-08. `session.fetch` and `net.fetch` follow the
 *    WHATWG default of `credentials: 'same-origin'`, and a request issued by the
 *    *main process* has no origin for that to be the same as: Chromium attached
 *    **no cookies at all**. So `chatgpt-web.isAuthenticated()` saw the
 *    logged-out `{}` while the owner sat in front of a logged-in login window,
 *    the window never closed, and the tray went on saying "login needed". The
 *    two cookie-session adapters are built with `'include'`; the two bearer
 *    adapters with `'omit'`, so the owner's browsing cookies can never ride
 *    along on a request that authenticates with a header. It belongs here, once
 *    per adapter, rather than at each call site, so no provider can forget it.
 */
import { DEFAULT_TIMEOUT_MS, type HttpFetch, type HttpResponse } from './types';

/** Largest response body read, in bytes. Bigger than any real usage payload. */
export const MAX_BODY_BYTES = 1_048_576;

/** How many same-origin redirects a single request may follow. */
export const MAX_REDIRECT_HOPS = 1;

/** The slice of a `ReadableStream` this needs, present on both `fetch` stacks. */
interface BodyStreamLike {
  getReader?: () => {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    cancel?: (reason?: unknown) => unknown;
  };
  cancel?: (reason?: unknown) => unknown;
}

/** The subset of a `fetch` response this adapter uses. */
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /** Absent in a stub; present on real `fetch` responses. */
  body?: BodyStreamLike | null;
}

/**
 * Whether the fetch stack may attach (and store) this partition's cookies.
 *
 * `'include'` for the two web providers — it is the entire mechanism behind
 * them. `'omit'` for the bearer providers, and for anything outside Electron.
 * There is deliberately no `'same-origin'`: it is the WHATWG default, and for a
 * main-process request it silently means "no cookies", which is the bug.
 */
export type CredentialsMode = 'include' | 'omit';

/** The subset of `fetch` this adapter uses. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal: AbortSignal;
    redirect: 'manual';
    credentials: CredentialsMode;
  }
) => Promise<FetchLikeResponse>;

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/**
 * Where a `Location` header may send this request, or `null` for "nowhere".
 *
 * Same origin only. The request that produced the redirect carried either the
 * partition's cookies or a bearer token, and re-issuing it against another
 * origin would hand that credential to whoever the redirect names — which is
 * exactly the move an endpoint takeover would make. Relative locations are
 * resolved against the original URL, so `Location: /api/v2/usage` works.
 */
export function sameOriginRedirect(from: string, location: string | null): string | null {
  if (location === null || location.trim().length === 0) return null;
  let base: URL;
  let next: URL;
  try {
    base = new URL(from);
    next = new URL(location, base);
  } catch {
    return null;
  }
  // Origin equality also pins the scheme, so an https -> http downgrade cannot
  // slip through here.
  if (next.origin !== base.origin) return null;
  return next.toString();
}

/** Abandon a body we are not going to read, so the socket is not left open. */
function dropBody(response: FetchLikeResponse): void {
  try {
    void response.body?.cancel?.('unused');
  } catch {
    // A stub with no stream, or a body already consumed. Nothing to do.
  }
}

/**
 * Read a body, refusing to hold more than `cap` bytes.
 *
 * Three paths, in order of preference: a declared `content-length` over the cap
 * is rejected without reading anything at all; a stream is read chunk by chunk
 * and cancelled the moment the cap is passed; and an implementation with neither
 * (a test stub) falls back to `text()` and is measured afterwards.
 */
async function readCappedBody(
  response: FetchLikeResponse,
  cap: number
): Promise<{ body: string; truncated: boolean }> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    dropBody(response);
    return { body: '', truncated: true };
  }

  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') <= cap) return { body: text, truncated: false };
    return { body: text.slice(0, cap), truncated: true };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    if (total + value.byteLength > cap) {
      try {
        void reader.cancel?.('body cap');
      } catch {
        // Already closed; the truncation stands either way.
      }
      return { body: Buffer.concat(chunks).toString('utf8').slice(0, cap), truncated: true };
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { body: Buffer.concat(chunks).toString('utf8'), truncated: false };
}

/** The shape returned for a redirect nobody may follow. */
function redirectResult(response: FetchLikeResponse): HttpResponse {
  dropBody(response);
  return {
    ok: false,
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: '',
    redirected: true
  };
}

/**
 * Wrap a `fetch`-like function.
 *
 * Every request is a plain `GET` with explicit headers: no provider here writes
 * anything, and keeping the method fixed means a mis-built provider cannot turn
 * a usage poll into a mutation against the owner's account.
 *
 * `credentials` defaults to `'omit'` — the safe half. A caller that wants the
 * partition's cookies has to say so, and exactly two do (`partitionSession` in
 * `provider-chains.ts`).
 */
export function fromFetch(
  fetchImpl: FetchLike,
  credentials: CredentialsMode = 'omit'
): HttpFetch {
  return async (url, init) => {
    const controller = new AbortController();
    const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = { ...(init?.headers ?? {}) };

    const once = (target: string): Promise<FetchLikeResponse> =>
      fetchImpl(target, {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'manual',
        credentials
      });

    try {
      let requestUrl = url;
      let response = await once(requestUrl);

      for (let hop = 0; isRedirect(response.status) && hop < MAX_REDIRECT_HOPS; hop++) {
        const next = sameOriginRedirect(requestUrl, response.headers.get('location'));
        if (next === null) return redirectResult(response);
        dropBody(response);
        requestUrl = next;
        response = await once(requestUrl);
      }
      // Either the hop budget is gone or the second answer redirected again.
      if (isRedirect(response.status)) return redirectResult(response);

      const { body, truncated } = await readCappedBody(response, MAX_BODY_BYTES);
      const result: HttpResponse = {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get('content-type'),
        body,
        ...(truncated ? { truncated: true } : {})
      };
      return result;
    } finally {
      clearTimeout(timer);
    }
  };
}

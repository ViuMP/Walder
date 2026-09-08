/**
 * Verbose main-process logging, off by default — with a mandatory redaction
 * filter in front of it.
 *
 * The owner never sees a terminal, so a chatty mascot would only fill a log file
 * nobody reads — and the hit/drag channels fire on every mouse move. Run
 * `WALDER_LOG=1 npm run dev` to turn diagnostics on.
 *
 * **Redaction.** From M4 on, this process handles OAuth access tokens and
 * `sessionKey` cookies. They are read at poll time and never written anywhere,
 * but a stray `vlog(response)` or an error whose message quotes a request URL
 * would put one on stdout, and from there into a crash report or a screenshot.
 * So *every* argument that reaches `console` goes through `redact` first:
 * defence in depth, not a substitute for not logging secrets in the first place.
 * Because of that, every argument is turned into a string here — objects are
 * JSON, Errors are message + stack — since a live object handed to `console`
 * would be formatted by the console itself, after the filter could see it.
 */

/**
 * Known secret shapes, masked with their giveaway prefix included:
 *  - `eyJ…` — the base64url of `{"` that starts every JWT (Claude's OAuth
 *    access token, Codex's `id_token`/`access_token`).
 *  - `sk-…` — API-key style credentials.
 *  - `sessionKey=…` — the claude.ai session cookie, as it appears in a Cookie
 *    header or a URL query.
 */
const SECRET_RE = /(?:eyJ|sk-|sessionKey=)[A-Za-z0-9._-]{8,}/g;

/**
 * Any long base64-ish run, as a catch-all for a token shape we have not seen.
 *
 * `.` and `/` are deliberately *not* in the character class: with them, an
 * ordinary file path (`/Users/victorprehn/Desktop`) is one 20+ character run and
 * every path in the log would be masked, which would make the diagnostics
 * useless and push whoever is debugging to turn the filter off. Real tokens are
 * long unbroken alphanumeric runs, and each dot-separated JWT segment is itself
 * well over 20 characters, so they are still caught.
 */
const BASE64ISH_RE = /[A-Za-z0-9+_=-]{20,}/g;

export const REDACTED = '[redacted]';

/** Mask anything that looks like a credential. Applied to every logged value. */
export function redact(text: string): string {
  return text.replace(SECRET_RE, REDACTED).replace(BASE64ISH_RE, REDACTED);
}

/**
 * Render one logged value as a string so `redact` can see all of it.
 *
 * Errors keep their stack (that is the whole value of logging one); everything
 * non-primitive becomes JSON, with a plain `String()` fallback for a cyclic or
 * otherwise unserialisable object.
 */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (value === null || typeof value !== 'object') return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Redact every argument and join them the way `console` would. */
export function redactArgs(args: readonly unknown[]): string[] {
  return args.map((arg) => redact(stringify(arg)));
}

const VERBOSE = process.env['WALDER_LOG'] === '1';

export const verbose = VERBOSE;

/** Log a diagnostic line. No-op unless `WALDER_LOG=1`. */
export function vlog(...args: unknown[]): void {
  if (VERBOSE) console.log('[walder]', ...redactArgs(args));
}

/** Log a real problem. Always printed — these mean something is broken. */
export function warn(...args: unknown[]): void {
  console.warn('[walder]', ...redactArgs(args));
}

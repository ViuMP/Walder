/**
 * Main-process logging: a console line, an optional rotating file, and a
 * mandatory redaction filter in front of both.
 *
 * The owner never sees a terminal, so a chatty mascot would only fill a log file
 * nobody reads — and the hit/drag channels fire on every mouse move. Run
 * `WALDER_LOG=1 npm run dev` to turn diagnostics on, or tick tray ▸ Developer ▸
 * Verbose log in a packaged build (`setVerbose`).
 *
 * Two levels, and the difference is who they are for. `warn` means something is
 * broken: always printed, and always written to the file, because the owner
 * reports these a day later and the record has to still exist. `vlog` is
 * diagnostics: off unless asked for, and the file is where they go, since a
 * packaged app's stdout goes nowhere anyone can read.
 *
 * The file itself is written by `log-file.ts` through the `setLogSink` seam —
 * this module stays free of `electron` and `fs` so it can be imported by
 * anything, including modules unit-tested under plain node.
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

/* ------------------------------------------------------------ verbosity */

/**
 * `WALDER_LOG=1` turns diagnostics on for a terminal run and cannot be turned
 * back off — a developer who asked for them on the command line means it.
 * Anything else defers to `setVerbose`, which the tray checkbox drives.
 */
const ENV_VERBOSE = process.env['WALDER_LOG'] === '1';

let verboseFlag = ENV_VERBOSE;

/**
 * Turn diagnostics on or off at runtime (tray ▸ Developer ▸ Verbose log).
 *
 * Needed because the owner has no terminal: when something goes wrong the only
 * way for him to produce a diagnosable record is a checkbox that starts writing
 * one to a file he can find. Ignored while `WALDER_LOG=1` is set, so a dev run
 * cannot be quietened by whatever happens to be in the settings file.
 */
export function setVerbose(on: boolean): void {
  verboseFlag = ENV_VERBOSE || on;
}

/** Are diagnostics currently being recorded? */
export function verbose(): boolean {
  return verboseFlag;
}

/* ----------------------------------------------------------------- the sink */

/**
 * Where redacted log lines go in addition to the console.
 *
 * A seam rather than a direct `fs` write, for two reasons. This module is
 * imported by nearly every file in `src/main`, including ones unit-tested under
 * plain node, so it must not pull in `electron` (for `app.getPath('logs')`) or
 * open a file handle at import time. And the rotation policy is real logic worth
 * testing on its own, which is easier when it is not entangled with the
 * formatting. `index.ts` installs the sink from `log-file.ts` at startup; until
 * then — and in every test — logging is console-only.
 */
export type LogSink = (line: string) => void;

let sink: LogSink | null = null;

/** Install (or, with `null`, remove) the file sink. */
export function setLogSink(next: LogSink | null): void {
  sink = next;
}

const PREFIX = '[walder]';

/**
 * Hand one already-redacted line to the sink, timestamped.
 *
 * A sink that throws — a full disk, a directory that vanished — must never take
 * the app down over a log line, and must not recurse into `warn` either.
 */
function toSink(level: 'info' | 'warn', parts: readonly string[]): void {
  if (sink === null) return;
  try {
    sink(`${new Date().toISOString()} ${level === 'warn' ? 'WARN' : 'INFO'} ${parts.join(' ')}\n`);
  } catch {
    // Deliberately silent: see above.
  }
}

/**
 * Log a diagnostic line. No-op unless `WALDER_LOG=1` or the verbose-log
 * checkbox is on.
 */
export function vlog(...args: unknown[]): void {
  if (!verboseFlag) return;
  const parts = redactArgs(args);
  console.log(PREFIX, ...parts);
  toSink('info', parts);
}

/**
 * Log an event worth *recording* but not worth printing: always written to the
 * file, echoed to the console only when diagnostics are on.
 *
 * The middle level between `vlog` and `warn`, and it exists for one class of
 * line: a state change nobody needs to be told about while it happens, but which
 * is the first thing anyone wants to see afterwards. The fullscreen sleep is the
 * case that created it — "did he curl up over that film?" is unanswerable from a
 * packaged build unless the transition is in the file, and asking the owner to
 * have ticked the verbose checkbox *before* the thing he is reporting happened
 * is asking for the impossible. It is not a `warn`, because nothing is wrong.
 */
export function info(...args: unknown[]): void {
  const parts = redactArgs(args);
  if (verboseFlag) console.log(PREFIX, ...parts);
  toSink('info', parts);
}

/**
 * Log a real problem. Always printed *and* always written to the file, whatever
 * the verbose setting: these mean something is broken, and the whole point of
 * the file is to still be there tomorrow when the owner reports it.
 */
export function warn(...args: unknown[]): void {
  const parts = redactArgs(args);
  console.warn(PREFIX, ...parts);
  toSink('warn', parts);
}

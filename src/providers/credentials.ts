/**
 * Reading the CLI tools' own credentials — the most sensitive code in Walder.
 *
 * Four rules hold here, and none of them is negotiable:
 *
 *  1. **Read at poll time, keep in memory, never persist.** Nothing in this file
 *     writes a token anywhere: not to the settings store, not to a cache, not to
 *     a log line. The returned object lives as long as the one HTTP call that
 *     uses it.
 *  2. **Never refresh.** Claude Code's keychain item holds a `refreshToken`, and
 *     spending it *rotates* the pair — the CLI would find its own stored
 *     credentials stale and the owner would be logged out of the tool this
 *     mascot is supposed to watch. Verified on 2026-09-08 (BUILD_LOG). This
 *     file never spends the refresh token, and since 2026-09-19 an expired
 *     token is no longer left for the owner alone: `src/main/claude-renew.ts`
 *     asks the CLI to renew its own credential by spawning it with an empty
 *     prompt, so the pair is only ever rotated by its owner. An expired token
 *     is still reported as `auth-needed` until that happens.
 *  3. **Never log a value.** Only shapes: "keychain item found", "no accessToken
 *     field". `src/main/log.ts` redacts as a backstop; this layer simply does
 *     not hand it anything to redact.
 *  4. **Missing is normal.** No Claude Code install, no Codex install, a
 *     hand-mangled JSON file, a keychain the user denied access to — every one
 *     of those is `null`, never a throw. A mascot must not fail to start because
 *     a tool it can read is not installed.
 *
 * Every external effect (the platform name, the home directory, reading a file,
 * running `security`, the clock) is injected, so the tests exercise all of this
 * without touching the real keychain.
 *
 * Rule 3 is also why a Claude read that comes back empty-handed reports a
 * `ClaudeCredentialShape` — reason class and top-level key names — rather
 * than nothing at all: "no login found" with no *why* left Windows QA row
 * 4.19 undiagnosable, and a shape is exactly what rule 3 allows.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/** How long `security find-generic-password` may take before we give up. */
export const KEYCHAIN_TIMEOUT_MS = 5_000;

/**
 * How long `gh auth token` may take before we give up. The same five seconds
 * as the keychain, for the same reason: both are a local child process that
 * either answers at once or is not going to, and a poll must not hang on one.
 */
export const GH_TOKEN_TIMEOUT_MS = 5_000;

/** The macOS keychain item Claude Code stores its OAuth pair in. */
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * A token this close to expiry is treated as already expired: the poll that
 * would use it takes non-zero time, and a token that dies mid-flight produces a
 * confusing `error` instead of an honest `auth-needed`.
 */
export const EXPIRY_GRACE_MS = 60_000;

export interface ClaudeOauthCredentials {
  readonly expired: false;
  readonly accessToken: string;
  /** Epoch milliseconds, as Claude Code stores it. */
  readonly expiresAt: number;
  /** `"team"`, `"pro"`, … — informational only. */
  readonly subscriptionType: string | null;
}

/** A login exists but its access token is (or is about to be) stale. */
export interface ExpiredCredentials {
  readonly expired: true;
  /**
   * The expiry we read, kept even though it is stale: `main/claude-renew.ts`
   * keys its "one attempt per expiry" rule on this number, and without it a
   * failed renewal would be retried on every poll for as long as the token
   * stayed dead. `null` when the field was absent from the credential entirely
   * — there is nothing to key on, and renewal is skipped.
   */
  readonly expiresAt: number | null;
  /**
   * The keychain item exists but Claude Code emptied it — `claudeAiOauth` is
   * still there, `accessToken` is not. Verified live on 2026-09-19: a logout
   * clears the access token and drops the refresh token with it, so there is
   * nothing for `main/claude-renew.ts` to renew — only the owner running
   * `claude` and logging in again fixes this.
   */
  readonly loggedOut?: true;
}

/** `null` means "no Claude Code login on this machine that we can read". */
export type ClaudeCredentialsResult = ClaudeOauthCredentials | ExpiredCredentials | null;

export interface CodexCredentials {
  readonly accessToken: string;
  /** Sent as `ChatGPT-Account-Id`; `null` when the file does not carry one. */
  readonly accountId: string | null;
}

export interface CursorCredentials {
  readonly accessToken: string;
}

export interface CopilotCredentials {
  readonly accessToken: string;
}

/** Injected effects, so none of this needs a real machine to test. */
export interface CredentialIo {
  readonly platform?: NodeJS.Platform | string;
  readonly homedir?: () => string;
  /** `APPDATA` on Windows, where Cursor keeps its state. */
  readonly appData?: () => string | undefined;
  /** Resolves to the file's text, or rejects (missing file, no permission). */
  readonly readTextFile?: (path: string) => Promise<string>;
  /** Resolves to the secret's text, or `null` when there is no such item. */
  readonly keychain?: (service: string) => Promise<string | null>;
  /**
   * One `value` out of a key/value SQLite table, or `null` when the file, the
   * table or the row is not there. Cursor's `state.vscdb`.
   */
  readonly readSqliteValue?: (path: string, table: string, key: string) => Promise<string | null>;
  /**
   * The GitHub CLI's own token (`gh auth token`), or `null` when `gh` is not
   * installed, not logged in, or answered with nothing.
   */
  readonly ghToken?: () => Promise<string | null>;
  readonly now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Read a generic password out of the macOS keychain.
 *
 * `execFile`, never a shell: the service name goes straight into `argv`, so
 * there is no quoting to get wrong and nothing to inject. A non-zero exit (no
 * such item, or the user denied the prompt) is `null`, not an error, and the
 * child's stderr is discarded rather than logged — it is the only place the
 * item's own contents could appear in a diagnostic.
 */
function keychainViaSecurity(service: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error !== null) {
          resolve(null);
          return;
        }
        const text = stdout.trim();
        resolve(text.length > 0 ? text : null);
      }
    );
  });
}

/**
 * Every place a `gh` CLI might be, best first — the same shape, and the same
 * reasoning, as `claudeBinaryCandidates` in `main/claude-renew.ts`.
 *
 * **Why this exists at all.** Copilot read `unavailable` in the packaged 0.2.6
 * on the owner's Mac (2026-09-21) while `gh auth token` worked perfectly in
 * his terminal. An app launched from Finder inherits `launchd`'s minimal
 * `PATH` — roughly `/usr/bin:/bin:/usr/sbin:/sbin` — and never reads a login
 * shell's profile, so the Homebrew `gh` that every shell finds is invisible to
 * the one process that needs it. Resolving the binary the way the Claude CLI
 * is already resolved costs four `existsSync` calls once per run.
 *
 * PATH first, because an owner who installed it deliberately put it there, and
 * relative PATH entries are dropped outright: "run whatever `./gh` is in the
 * current directory" is the shape of a very old class of bug.
 *
 * Then the industry-standard install roots and nothing else — no conda, no
 * pyenv, no personal prefix (Victor's decision, 2026-09-21). A private root is
 * a private choice; the owner who made it can put it on the PATH, which is the
 * first thing this looks at.
 */
export function ghBinaryCandidates(
  platform: string,
  home: string,
  pathVar: string | undefined
): string[] {
  const names = platform === 'win32' ? ['gh', 'gh.cmd', 'gh.exe'] : ['gh'];
  const out: string[] = [];

  for (const entry of (pathVar ?? '').split(delimiter)) {
    if (entry.length === 0 || !isAbsolute(entry)) continue;
    for (const name of names) out.push(join(entry, name));
  }

  out.push(
    join('/opt', 'homebrew', 'bin', 'gh'),
    join('/usr', 'local', 'bin', 'gh'),
    join(home, '.local', 'bin', 'gh'),
    join('/usr', 'bin', 'gh')
  );

  return out;
}

/** The first candidate that exists, or `null` for "no GitHub CLI here". */
export function findGhBinary(exists: (path: string) => boolean = existsSync): string | null {
  return ghBinaryCandidates(process.platform, homedir(), process.env['PATH']).find(exists) ?? null;
}

/**
 * The resolved CLI, remembered for the life of the process.
 *
 * Exactly as `claude-renew.ts` resolves its own CLI once at startup: the
 * answer does not change while the app runs, and stat-ing a dozen paths every
 * three minutes to learn the same thing is the kind of idle work this project
 * measures. `null` is cached too — "not installed" is an answer, and
 * re-checking it per poll is the same waste. Held out here rather than inside
 * `findGhBinary` so that function stays pure and the tests can drive it with a
 * fake `exists` without one case's answer leaking into the next.
 */
let ghBinary: string | null | undefined;

/**
 * Ask the GitHub CLI for the token it already holds.
 *
 * Exactly the shape of `keychainViaSecurity` above, and for the same reasons:
 * `execFile` with an argument vector and never a shell, a timeout so a poll
 * cannot hang on a child process, the child's stderr discarded rather than
 * logged (it is the one place `gh` could quote the token back at us), a
 * non-zero exit — `gh` logged out — resolved as `null` rather than thrown, and
 * an empty answer treated as no token at all. No `gh` on the machine at all is
 * `null` without spawning anything.
 */
function ghTokenViaCli(): Promise<string | null> {
  if (ghBinary === undefined) ghBinary = findGhBinary();
  const binary = ghBinary;
  if (binary === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      binary,
      ['auth', 'token'],
      { timeout: GH_TOKEN_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error !== null) {
          resolve(null);
          return;
        }
        const text = stdout.trim();
        resolve(text.length > 0 ? text : null);
      }
    );
  });
}

/**
 * Read one value out of a key/value table in an SQLite file, read-only.
 *
 * `node:sqlite` (Node 22.13+, and the Node inside Electron 44 is 24), so no
 * dependency and no `sqlite3` binary to find. Opened read-only, and every
 * failure — no file, a locked database, a table that is not there, a row that
 * is not there — is `null`: this is another program's state file, read at
 * whatever moment the poll lands, and "no credential" is the only honest
 * answer to anything short of a value. The table and key names are ours, never
 * the owner's input, so the identifier goes into the SQL by string and the key
 * goes in as a bound parameter.
 */
async function sqliteValueViaNode(path: string, table: string, key: string): Promise<string | null> {
  let db: { prepare(sql: string): { get(...params: unknown[]): unknown }; close(): void } | null =
    null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key);
    if (typeof row !== 'object' || row === null) return null;
    const value = (row as { value?: unknown }).value;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed, or never opened.
    }
  }
}

function io(overrides: CredentialIo): Required<CredentialIo> {
  return {
    platform: overrides.platform ?? process.platform,
    homedir: overrides.homedir ?? homedir,
    appData: overrides.appData ?? (() => process.env['APPDATA']),
    readTextFile: overrides.readTextFile ?? ((path) => readFile(path, 'utf8')),
    keychain: overrides.keychain ?? keychainViaSecurity,
    readSqliteValue: overrides.readSqliteValue ?? sqliteValueViaNode,
    ghToken: overrides.ghToken ?? ghTokenViaCli,
    now: overrides.now ?? (() => Date.now())
  };
}

/** Read and parse a JSON file, or `null` for anything at all going wrong. */
async function readJsonFile(
  path: string,
  readTextFile: (p: string) => Promise<string>
): Promise<unknown> {
  let text: string;
  try {
    text = await readTextFile(path);
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/* ------------------------------------------------- claude credential shape */

/**
 * Why a Claude Code credential read produced no usable token — the *class* of
 * the failure, never anything out of the credential itself.
 *
 * This exists because of Windows QA row 4.19 (2026-10-02): a 7.8 KB
 * `~/.claude/.credentials.json` sat in the owner's home directory and the tray
 * still said "no Claude Code login found", with nothing anywhere to say which
 * of half a dozen very different causes it was. Each one points somewhere
 * else, which is why they are told apart:
 *
 *  - `missing` — no file (or, on macOS, no keychain item): Claude Code was
 *    never logged in here, or keeps its login somewhere this does not look.
 *  - `unreadable` — the file is there but the read failed (a permission, a
 *    lock held by another process, a cloud-sync placeholder). The error's
 *    `code` travels with it; its message does not, because Node puts the full
 *    path in it and nothing about a path helps more than the code does.
 *  - `not-json` — read fine, does not parse. A byte-order mark written by a
 *    Windows editor and a zero-length file are both called out by `hint`,
 *    because both look valid to the eye and are not to `JSON.parse`.
 *  - `not-an-object` — parses, but to an array or a scalar.
 *  - `no-oauth-block` — a JSON object without `claudeAiOauth` at all. What a
 *    file holding only MCP/plugin OAuth state looks like, and what a Claude
 *    Code bundled inside the desktop app (which keeps its own login elsewhere)
 *    leaves behind — the leading suspect for row 4.19, which is exactly why
 *    the top-level key names are reported alongside it.
 *  - `empty-oauth-block` — `claudeAiOauth` is there but holds no access token
 *    (not an object at all, or emptied by a logout — the latter surfaces to the
 *    owner as `LOGGED_OUT_MESSAGE` and is reported here too, for the same
 *    probe line to cover it).
 */
export type ClaudeCredentialReason =
  | 'missing'
  | 'unreadable'
  | 'not-json'
  | 'not-an-object'
  | 'no-oauth-block'
  | 'empty-oauth-block';

/**
 * The shape of a Claude Code credential that held no usable token: where it
 * was looked for, why it did not count, and the top-level **key names** of
 * whatever JSON object was there.
 *
 * Key names only, by the rule at the top of this file. A name says what kind
 * of file this is (`mcpOAuth` alone, say, against `claudeAiOauth`); a value
 * would be a credential. The names are sanitised by `shownKeyName` on top of
 * that, so even a file whose *keys* were secrets could not put one in a log.
 */
export interface ClaudeCredentialShape {
  readonly source: 'file' | 'keychain';
  readonly reason: ClaudeCredentialReason;
  /** Sorted, sanitised, at most `CLAUDE_CREDENTIAL_KEYS_SHOWN` of them. */
  readonly keys: readonly string[];
  /** How many top-level keys there were in all, so a capped list says so. */
  readonly keyCount: number;
  /** For `unreadable`: the read error's `code` (`EACCES`, `EBUSY`), if it had one. */
  readonly errorCode?: string;
  /** For `not-json`: the two causes that look like valid JSON to a person. */
  readonly hint?: 'empty' | 'byte-order-mark';
}

/**
 * At most this many key names go into one diagnostic. A real
 * `.credentials.json` has two or three top-level keys; a dozen is room for
 * every plausible future one, and a hard stop for a file that is not what we
 * think it is (a misplaced dump with thousands of keys) turning one log line
 * into a page.
 */
export const CLAUDE_CREDENTIAL_KEYS_SHOWN = 12;

/**
 * A key name longer than this is not shown, only measured. Every key Claude
 * Code writes is a short camelCase identifier; a forty-character "name" is
 * more likely to be data that ended up in key position (an id, a token used as
 * a map key) than a field, and its length is all the diagnostic needs.
 */
export const CREDENTIAL_KEY_NAME_MAX_CHARS = 40;

/** What a plain identifier looks like: the only kind of key name shown verbatim. */
const PLAIN_KEY_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Node's `fs` error codes are short upper-case words (`ENOENT`, `EACCES`,
 * `EBUSY`). Anything else in `code` is not one, and is dropped rather than
 * trusted into a log line.
 */
const FS_ERROR_CODE = /^E[A-Z]{2,15}$/;

/** U+FEFF, which `readFile(…, 'utf8')` keeps and `JSON.parse` refuses. */
const BYTE_ORDER_MARK = '﻿';

/** A key name as a diagnostic may show it: verbatim if plain, else only its length. */
function shownKeyName(key: string): string {
  return key.length <= CREDENTIAL_KEY_NAME_MAX_CHARS && PLAIN_KEY_NAME.test(key)
    ? key
    : `<${key.length}-char key>`;
}

function shapeOf(
  source: ClaudeCredentialShape['source'],
  reason: ClaudeCredentialReason,
  json: unknown,
  extra: Pick<ClaudeCredentialShape, 'errorCode' | 'hint'> = {}
): ClaudeCredentialShape {
  const all = isRecord(json) ? Object.keys(json) : [];
  const keys = all.map(shownKeyName).sort().slice(0, CLAUDE_CREDENTIAL_KEYS_SHOWN);
  return { source, reason, keys, keyCount: all.length, ...extra };
}

/** The `code` of a failed read, if it is one of Node's own. */
function fsErrorCode(error: unknown): string | undefined {
  const code = isRecord(error) ? error['code'] : undefined;
  return typeof code === 'string' && FS_ERROR_CODE.test(code) ? code : undefined;
}

/** Why `text` failed to parse, where the reason is one a person would miss. */
function unparseableHint(text: string): ClaudeCredentialShape['hint'] {
  if (text.trim().length === 0) return 'empty';
  if (text.startsWith(BYTE_ORDER_MARK)) return 'byte-order-mark';
  return undefined;
}

/**
 * One line describing a shape, for the verbose log and `npm run probe` — e.g.
 * `.credentials.json present, keys: mcpOAuth,organizationUuid — no
 * claudeAiOauth block`.
 *
 * Kept here, next to the type, so the app's log and the probe say the same
 * words; the tray keeps its own short sentence ("no Claude Code login found"),
 * because the owner needs to know *that* it failed and a developer needs to
 * know *how*.
 */
export function describeClaudeCredentialShape(shape: ClaudeCredentialShape): string {
  const where = shape.source === 'file' ? '.credentials.json' : 'keychain item';
  const keyList = (): string => {
    const hidden = shape.keyCount - shape.keys.length;
    const names = shape.keys.length === 0 ? '(none)' : shape.keys.join(',');
    return hidden > 0 ? `${names} (+${hidden} more)` : names;
  };
  switch (shape.reason) {
    case 'missing':
      return `${where} not found`;
    case 'unreadable':
      return `${where} present but unreadable${shape.errorCode === undefined ? '' : ` (${shape.errorCode})`}`;
    case 'not-json': {
      const why =
        shape.hint === 'empty'
          ? ' (empty)'
          : shape.hint === 'byte-order-mark'
            ? ' (starts with a byte-order mark)'
            : '';
      return `${where} present, not JSON${why}`;
    }
    case 'not-an-object':
      return `${where} present, JSON but not an object`;
    case 'no-oauth-block':
      return `${where} present, keys: ${keyList()} — no claudeAiOauth block`;
    case 'empty-oauth-block':
      return `${where} present, keys: ${keyList()} — claudeAiOauth block present but empty`;
  }
}

/** Where this platform keeps the Claude Code credential (see `readClaudeCodeCredentials`). */
function claudeSource(platform: string): ClaudeCredentialShape['source'] {
  return platform === 'darwin' ? 'keychain' : 'file';
}

/** Either the parsed credential JSON, or the shape of why there is none. */
type ClaudeJsonRead =
  | { readonly ok: true; readonly json: unknown }
  | { readonly ok: false; readonly shape: ClaudeCredentialShape };

/**
 * Read the Claude Code credential JSON from wherever this platform keeps it,
 * keeping the *reason* when it is not there — which `readJsonFile` throws
 * away, and which is the whole point of row 4.19's fix.
 *
 * On macOS a keychain read that throws (a denied prompt) is `unreadable` and
 * a `null` item is `missing`; `keychainViaSecurity` already folds both of
 * those into `null`, so only an injected reader can tell them apart, and
 * that is enough for the tests to pin both.
 */
async function readClaudeJson(
  platform: string,
  home: () => string,
  readTextFile: (p: string) => Promise<string>,
  keychain: (service: string) => Promise<string | null>
): Promise<ClaudeJsonRead> {
  const source = claudeSource(platform);
  let text: string;
  if (source === 'keychain') {
    let raw: string | null;
    try {
      raw = await keychain(CLAUDE_KEYCHAIN_SERVICE);
    } catch {
      return { ok: false, shape: shapeOf(source, 'unreadable', null) };
    }
    if (raw === null) return { ok: false, shape: shapeOf(source, 'missing', null) };
    text = raw;
  } else {
    try {
      text = await readTextFile(join(home(), '.claude', '.credentials.json'));
    } catch (error) {
      const errorCode = fsErrorCode(error);
      const reason = errorCode === 'ENOENT' ? 'missing' : 'unreadable';
      return { ok: false, shape: shapeOf(source, reason, null, { errorCode }) };
    }
  }
  try {
    return { ok: true, json: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, shape: shapeOf(source, 'not-json', null, { hint: unparseableHint(text) }) };
  }
}

/**
 * The Claude Code OAuth access token, if there is one we can use.
 *
 * macOS keeps it in the keychain; Windows and Linux in
 * `~/.claude/.credentials.json`. Both hold the same JSON, under
 * `claudeAiOauth`.
 *
 * Returns `{ expired: true }` — deliberately *not* `null` — when the token is
 * past (or within `EXPIRY_GRACE_MS` of) `expiresAt`, or when the item is there
 * but empty (`loggedOut: true`, see `ExpiredCredentials`). The distinction
 * matters to `registry.ts`: a login that exists but is stale or emptied is
 * worth reporting as `auth-needed`, whereas no login at all should quietly let
 * the next provider in the chain answer.
 *
 * `onShape` is told *why* whenever there was no access token to be had — see
 * `ClaudeCredentialShape`. It hears a shape, never the credential, and a
 * reporter that throws is ignored: rule 4 above says this function does not
 * throw, and a diagnostic is the last thing that should change that.
 */
export async function readClaudeCodeCredentials(
  overrides: CredentialIo = {},
  onShape?: (shape: ClaudeCredentialShape) => void
): Promise<ClaudeCredentialsResult> {
  const { platform, homedir: home, readTextFile, keychain, now } = io(overrides);
  const report = (shape: ClaudeCredentialShape): void => {
    try {
      onShape?.(shape);
    } catch {
      // A diagnostic must not turn a missing login into a thrown error.
    }
  };

  const read = await readClaudeJson(platform, home, readTextFile, keychain);
  if (!read.ok) {
    report(read.shape);
    return null;
  }
  const { json } = read;
  const source = claudeSource(platform);

  if (!isRecord(json)) {
    report(shapeOf(source, 'not-an-object', json));
    return null;
  }
  // Own key, not `in`: a parsed file has a plain prototype, but "is the field
  // in the file" is the question, and `hasOwn` is that question exactly.
  if (!Object.hasOwn(json, 'claudeAiOauth')) {
    report(shapeOf(source, 'no-oauth-block', json));
    return null;
  }
  const oauth = json['claudeAiOauth'];
  if (!isRecord(oauth)) {
    report(shapeOf(source, 'empty-oauth-block', json));
    return null;
  }

  const accessToken = nonEmptyString(oauth['accessToken']);
  // The item is there but Claude Code emptied it on logout (live on
  // 2026-09-19: `accessToken` "", `expiresAt` 0, refresh token gone). That is
  // not "never logged in" — it is a distinct dead end with nothing to renew.
  if (accessToken === null) {
    report(shapeOf(source, 'empty-oauth-block', json));
    return { expired: true, expiresAt: null, loggedOut: true };
  }

  const rawExpiry = oauth['expiresAt'];
  const expiresAt =
    typeof rawExpiry === 'number' && Number.isFinite(rawExpiry) ? rawExpiry : null;

  // No expiry at all: assume stale rather than sending a token we cannot vouch
  // for. A 401 would say the same thing, one round trip later.
  if (expiresAt === null) return { expired: true, expiresAt: null };
  if (expiresAt <= now() + EXPIRY_GRACE_MS) return { expired: true, expiresAt };

  return {
    expired: false,
    accessToken,
    expiresAt,
    subscriptionType: nonEmptyString(oauth['subscriptionType'])
  };
}

/**
 * The Codex CLI's ChatGPT access token from `~/.codex/auth.json`.
 *
 * No expiry check: the file carries no `expiresAt`, only a `last_refresh`, and
 * the token itself is a JWT we deliberately do not decode. An expired one comes
 * back as a 401 from the endpoint, which the provider maps to `auth-needed` —
 * the same outcome, without this layer having to interpret a credential.
 */
export async function readCodexCredentials(
  overrides: CredentialIo = {}
): Promise<CodexCredentials | null> {
  const { homedir: home, readTextFile } = io(overrides);
  const json = await readJsonFile(join(home(), '.codex', 'auth.json'), readTextFile);

  if (!isRecord(json)) return null;
  const tokens = json['tokens'];
  if (!isRecord(tokens)) return null;

  const accessToken = nonEmptyString(tokens['access_token']);
  if (accessToken === null) return null;

  return { accessToken, accountId: nonEmptyString(tokens['account_id']) };
}

/* ------------------------------------------------------------------ cursor */

/** The key Cursor files its bearer token under, in `state.vscdb`. */
export const CURSOR_TOKEN_KEY = 'cursorAuth/accessToken';

/**
 * The two key/value tables in `state.vscdb`. Every open-source Cursor usage
 * tracker reads the token out of `ItemTable` (VS Code's own state table); one
 * documents `cursorDiskKV`. Both are tried, first hit wins, and the probe run
 * on a machine with Cursor says which one was real.
 */
export const CURSOR_STATE_TABLES: readonly string[] = ['ItemTable', 'cursorDiskKV'];

/**
 * Where Cursor keeps its state database, per platform, or `null` when the
 * platform's base directory is unknown (no `APPDATA` on Windows).
 */
export function cursorStatePath(overrides: CredentialIo = {}): string | null {
  const { platform, homedir: home, appData } = io(overrides);
  const tail = ['Cursor', 'User', 'globalStorage', 'state.vscdb'];
  if (platform === 'darwin') return join(home(), 'Library', 'Application Support', ...tail);
  if (platform === 'win32') {
    const base = appData();
    return base === undefined || base.length === 0 ? null : join(base, ...tail);
  }
  return join(home(), '.config', ...tail);
}

/**
 * The Cursor editor's bearer token, if the editor is installed and logged in.
 *
 * Cursor is a *token* provider, like Codex: the credential is read at poll
 * time out of the editor's own state file and used as a header, and nothing is
 * ever written back. Deliberately no browser login for this service — a Cursor
 * sign-in page creates a second, empty account rather than attaching to the
 * one the editor holds (gap analysis §4, P2-2).
 *
 * The stored value is sometimes a JSON string literal (`"eyJ…"`) rather than
 * the bare token; one `JSON.parse` attempt covers both without guessing.
 */
export async function readCursorCredentials(
  overrides: CredentialIo = {}
): Promise<CursorCredentials | null> {
  const path = cursorStatePath(overrides);
  if (path === null) return null;
  const { readSqliteValue } = io(overrides);
  for (const table of CURSOR_STATE_TABLES) {
    const raw = await readSqliteValue(path, table, CURSOR_TOKEN_KEY);
    if (raw === null) continue;
    let token: string = raw;
    if (raw.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'string') token = parsed;
      } catch {
        // Not JSON after all; the raw text is the token.
      }
    }
    const accessToken = nonEmptyString(token.trim());
    if (accessToken !== null) return { accessToken };
  }
  return null;
}

/* ----------------------------------------------------------------- copilot */

/**
 * The GitHub token the `gh` CLI already holds, if it holds one.
 *
 * Copilot is a *token* provider like Codex and Cursor, and the credential is
 * the GitHub CLI's — never one of ours. Walder does not run an OAuth flow of
 * its own for github.com, does not write `gh`'s config, and never refreshes
 * anything: `gh auth token` prints whatever the owner's own `gh auth login`
 * put there, we send it as one header, and it is dropped when the call
 * returns. The same rule Codex is read under (rule 2 at the top of this file).
 *
 * Every failure is `null`: no `gh` on the PATH, a `gh` that is logged out, a
 * spawn that throws before the callback can run. "No Copilot credential" is
 * the only honest answer to any of those, and none of them is an error worth
 * showing the owner.
 */
export async function readCopilotCredentials(
  overrides: CredentialIo = {}
): Promise<CopilotCredentials | null> {
  const { ghToken } = io(overrides);
  let raw: string | null;
  try {
    raw = await ghToken();
  } catch {
    return null;
  }
  const accessToken = raw === null ? null : nonEmptyString(raw.trim());
  return accessToken === null ? null : { accessToken };
}

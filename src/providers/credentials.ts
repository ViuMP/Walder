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
 *     mascot is supposed to watch. Verified on 2026-09-08 (BUILD_LOG) and
 *     decided there: an expired token is reported as `auth-needed` and Claude
 *     Code refreshes it the next time the owner uses it, all by itself.
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
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** How long `security find-generic-password` may take before we give up. */
export const KEYCHAIN_TIMEOUT_MS = 5_000;

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
}

/** `null` means "no Claude Code login on this machine that we can read". */
export type ClaudeCredentialsResult = ClaudeOauthCredentials | ExpiredCredentials | null;

export interface CodexCredentials {
  readonly accessToken: string;
  /** Sent as `ChatGPT-Account-Id`; `null` when the file does not carry one. */
  readonly accountId: string | null;
}

/** Injected effects, so none of this needs a real machine to test. */
export interface CredentialIo {
  readonly platform?: NodeJS.Platform | string;
  readonly homedir?: () => string;
  /** Resolves to the file's text, or rejects (missing file, no permission). */
  readonly readTextFile?: (path: string) => Promise<string>;
  /** Resolves to the secret's text, or `null` when there is no such item. */
  readonly keychain?: (service: string) => Promise<string | null>;
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

function io(overrides: CredentialIo): Required<CredentialIo> {
  return {
    platform: overrides.platform ?? process.platform,
    homedir: overrides.homedir ?? homedir,
    readTextFile: overrides.readTextFile ?? ((path) => readFile(path, 'utf8')),
    keychain: overrides.keychain ?? keychainViaSecurity,
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

/**
 * The Claude Code OAuth access token, if there is one we can use.
 *
 * macOS keeps it in the keychain; Windows and Linux in
 * `~/.claude/.credentials.json`. Both hold the same JSON, under
 * `claudeAiOauth`.
 *
 * Returns `{ expired: true }` — deliberately *not* `null` — when the token is
 * past (or within `EXPIRY_GRACE_MS` of) `expiresAt`. The distinction matters to
 * `registry.ts`: a login that exists but is stale is worth reporting as
 * `auth-needed`, whereas no login at all should quietly let the next provider in
 * the chain answer.
 */
export async function readClaudeCodeCredentials(
  overrides: CredentialIo = {}
): Promise<ClaudeCredentialsResult> {
  const { platform, homedir: home, readTextFile, keychain, now } = io(overrides);

  let json: unknown = null;
  if (platform === 'darwin') {
    let raw: string | null = null;
    try {
      raw = await keychain(CLAUDE_KEYCHAIN_SERVICE);
    } catch {
      raw = null;
    }
    if (raw !== null) {
      try {
        json = JSON.parse(raw) as unknown;
      } catch {
        json = null;
      }
    }
  } else {
    json = await readJsonFile(join(home(), '.claude', '.credentials.json'), readTextFile);
  }

  if (!isRecord(json)) return null;
  const oauth = json['claudeAiOauth'];
  if (!isRecord(oauth)) return null;

  const accessToken = nonEmptyString(oauth['accessToken']);
  if (accessToken === null) return null;

  const rawExpiry = oauth['expiresAt'];
  const expiresAt =
    typeof rawExpiry === 'number' && Number.isFinite(rawExpiry) ? rawExpiry : null;

  // No expiry at all: assume stale rather than sending a token we cannot vouch
  // for. A 401 would say the same thing, one round trip later.
  if (expiresAt === null) return { expired: true };
  if (expiresAt <= now() + EXPIRY_GRACE_MS) return { expired: true };

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

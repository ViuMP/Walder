/**
 * Reading the CLI tools' credentials.
 *
 * The rules being pinned here are the ones that would be expensive to get wrong:
 *
 *  - an **expired** token is `{ expired: true }`, not `null` and never a
 *    refresh — refreshing rotates Claude Code's own pair and would log the owner
 *    out of the tool this mascot exists to watch (BUILD_LOG, 2026-09-08);
 *  - `null` for every kind of "not there": no keychain item, no file, bad JSON,
 *    the wrong shape, a denied keychain prompt;
 *  - the **platform split** — keychain on macOS, `~/.claude/.credentials.json`
 *    elsewhere — because the wrong branch silently means "no Claude login" on a
 *    machine that has one.
 *
 * Every effect is injected, so nothing here touches the real keychain.
 */
import { describe, expect, it } from 'vitest';
import {
  EXPIRY_GRACE_MS,
  CLAUDE_KEYCHAIN_SERVICE,
  CLAUDE_CREDENTIAL_KEYS_SHOWN,
  CREDENTIAL_KEY_NAME_MAX_CHARS,
  describeClaudeCredentialShape,
  readClaudeCodeCredentials,
  type ClaudeCredentialShape,
  readCodexCredentials,
  type CredentialIo,
  cursorStatePath,
  readCursorCredentials,
  readCopilotCredentials,
  ghBinaryCandidates,
  findGhBinary,
  CURSOR_TOKEN_KEY
} from '../src/providers/credentials';
import { hostPathVar, native } from './support/host';

const NOW = Date.parse('2026-09-08T15:00:00Z');

/** A realistic keychain payload; the token value is fake and never asserted on. */
function keychainJson(
  overrides: Record<string, unknown> = {},
  expiresAt = NOW + 3_600_000
): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fake-access-token-value',
      refreshToken: 'fake-refresh-token-value',
      expiresAt,
      subscriptionType: 'team',
      ...overrides
    },
    mcpOAuth: {}
  });
}

function macIo(raw: string | null, overrides: CredentialIo = {}): CredentialIo {
  return {
    platform: 'darwin',
    now: () => NOW,
    keychain: async () => raw,
    ...overrides
  };
}

describe('readClaudeCodeCredentials on macOS', () => {
  it('reads the OAuth pair out of the keychain item', async () => {
    const result = await readClaudeCodeCredentials(macIo(keychainJson()));
    expect(result).toEqual({
      expired: false,
      accessToken: 'fake-access-token-value',
      expiresAt: NOW + 3_600_000,
      subscriptionType: 'team'
    });
  });

  it('asks for the item Claude Code actually stores', async () => {
    const asked: string[] = [];
    await readClaudeCodeCredentials(
      macIo(keychainJson(), {
        keychain: async (service) => {
          asked.push(service);
          return keychainJson();
        }
      })
    );
    expect(asked).toEqual([CLAUDE_KEYCHAIN_SERVICE]);
  });

  it('reports an expired token as expired, not as missing', async () => {
    // The distinction the registry depends on: a login that exists but is stale
    // is worth telling the owner about; no login at all should quietly let the
    // next provider answer.
    const result = await readClaudeCodeCredentials(macIo(keychainJson({}, NOW - 1000)));
    // The expiry rides along even though it is stale: `main/claude-renew.ts`
    // keys its one-attempt-per-expiry rule on exactly this number.
    expect(result).toEqual({ expired: true, expiresAt: NOW - 1000 });
  });

  it('treats a token inside the grace window as already expired', async () => {
    // A token that dies mid-request produces a confusing `error` instead of an
    // honest `auth-needed`.
    const justInside = await readClaudeCodeCredentials(
      macIo(keychainJson({}, NOW + EXPIRY_GRACE_MS - 1))
    );
    expect(justInside).toEqual({ expired: true, expiresAt: NOW + EXPIRY_GRACE_MS - 1 });

    const justOutside = await readClaudeCodeCredentials(
      macIo(keychainJson({}, NOW + EXPIRY_GRACE_MS + 60_000))
    );
    expect(justOutside).toMatchObject({ expired: false });
  });

  it('treats a missing or unreadable expiry as expired', async () => {
    // `expiresAt: null`, not a number: there was no expiry to key on, so
    // renewal has nothing to be "once per" and skips the credential entirely.
    expect(await readClaudeCodeCredentials(macIo(keychainJson({ expiresAt: undefined })))).toEqual({
      expired: true,
      expiresAt: null
    });
    expect(
      await readClaudeCodeCredentials(macIo(keychainJson({ expiresAt: 'soon' })))
    ).toEqual({ expired: true, expiresAt: null });
  });

  it('never returns the refresh token', async () => {
    // Structural, not cosmetic: nothing downstream can spend a token it was
    // never handed, so the no-refresh rule cannot be broken by accident.
    const result = await readClaudeCodeCredentials(macIo(keychainJson()));
    expect(JSON.stringify(result)).not.toContain('refresh');
  });

  it('is null when there is no keychain item', async () => {
    expect(await readClaudeCodeCredentials(macIo(null))).toBeNull();
  });

  it('is null when the keychain read throws (a denied prompt)', async () => {
    const io = macIo(null, {
      keychain: async () => {
        throw new Error('User canceled the operation.');
      }
    });
    expect(await readClaudeCodeCredentials(io)).toBeNull();
  });

  it('is null for malformed JSON or the wrong shape', async () => {
    expect(await readClaudeCodeCredentials(macIo('not json at all'))).toBeNull();
    expect(await readClaudeCodeCredentials(macIo('[]'))).toBeNull();
    expect(await readClaudeCodeCredentials(macIo('{"mcpOAuth":{}}'))).toBeNull();
  });

  it('reports an emptied item as logged out, not as no login', async () => {
    // Live on 2026-09-19: Claude Code's own logout leaves `claudeAiOauth` in
    // place but empties `accessToken` (and drops the refresh token with it) —
    // a distinct dead end from "never logged in", with nothing to renew.
    expect(
      await readClaudeCodeCredentials(macIo(keychainJson({ accessToken: '' })))
    ).toEqual({ expired: true, expiresAt: null, loggedOut: true });
    expect(
      await readClaudeCodeCredentials(macIo(keychainJson({ accessToken: 42 })))
    ).toEqual({ expired: true, expiresAt: null, loggedOut: true });
  });
});

describe('readClaudeCodeCredentials off macOS', () => {
  // The fake file system is keyed in POSIX for readability and looked up in
  // the host's spelling, which is what the reader's `path.join` produces.
  const io = (files: Record<string, string>): CredentialIo => ({
    platform: 'win32',
    now: () => NOW,
    homedir: () => '/home/v',
    readTextFile: async (path) => {
      const text = Object.entries(files).find(([posix]) => native(posix) === path)?.[1];
      // Shaped like Node's own error, `code` and all: the shape diagnostic
      // tells "not there" from "there but unreadable" by that code alone.
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    },
    keychain: async () => {
      throw new Error('the keychain must not be consulted off macOS');
    }
  });

  it('reads ~/.claude/.credentials.json instead of the keychain', async () => {
    const result = await readClaudeCodeCredentials(
      io({ '/home/v/.claude/.credentials.json': keychainJson() })
    );
    expect(result).toMatchObject({ expired: false, subscriptionType: 'team' });
  });

  it('is null when the file is not there', async () => {
    expect(await readClaudeCodeCredentials(io({}))).toBeNull();
  });

  it('is null for a truncated file rather than throwing', async () => {
    expect(
      await readClaudeCodeCredentials(io({ '/home/v/.claude/.credentials.json': '{"clau' }))
    ).toBeNull();
  });

  it('reports an emptied item as logged out, not as no login', async () => {
    expect(
      await readClaudeCodeCredentials(
        io({ '/home/v/.claude/.credentials.json': keychainJson({ accessToken: '' }) })
      )
    ).toEqual({ expired: true, expiresAt: null, loggedOut: true });
  });
});

describe('the shape of a Claude credential read that found no token', () => {
  // Windows QA row 4.19 (2026-10-02): a 7.8 KB `.credentials.json` was there
  // and the only word anywhere was "no Claude Code login found". These pin the
  // *why* that now goes to the verbose log and `npm run probe` — and that it
  // is a why made of reason classes and key names, never of values.
  const FILE = '/home/v/.claude/.credentials.json';
  const SECRET = 'fake-secret-value-never-printed';

  function fileIo(text: string | Error): CredentialIo {
    return {
      platform: 'win32',
      now: () => NOW,
      homedir: () => '/home/v',
      readTextFile: async (path) => {
        if (path !== native(FILE)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        if (text instanceof Error) throw text;
        return text;
      },
      keychain: async () => {
        throw new Error('the keychain must not be consulted off macOS');
      }
    };
  }

  /** Run one read and return what it said, plus every shape it reported. */
  async function readWithShapes(
    credentialIo: CredentialIo
  ): Promise<{ result: unknown; shapes: ClaudeCredentialShape[] }> {
    const shapes: ClaudeCredentialShape[] = [];
    const result = await readClaudeCodeCredentials(credentialIo, (shape) => shapes.push(shape));
    return { result, shapes };
  }

  /** The one line the verbose log and the probe would print for a read. */
  async function lineFor(credentialIo: CredentialIo): Promise<string> {
    const { shapes } = await readWithShapes(credentialIo);
    expect(shapes).toHaveLength(1);
    return describeClaudeCredentialShape(shapes[0]!);
  }

  it('names the top-level keys, sorted, when there is no claudeAiOauth block', async () => {
    const io = fileIo(JSON.stringify({ organizationUuid: SECRET, mcpOAuth: { server: SECRET } }));
    const { result, shapes } = await readWithShapes(io);
    expect(result).toBeNull();
    expect(shapes).toEqual([
      expect.objectContaining({
        source: 'file',
        reason: 'no-oauth-block',
        keys: ['mcpOAuth', 'organizationUuid'],
        keyCount: 2
      })
    ]);
    const line = await lineFor(io);
    expect(line).toBe(
      '.credentials.json present, keys: mcpOAuth,organizationUuid — no claudeAiOauth block'
    );
    // The values are in the file; they must be in neither the shape nor the line.
    expect(JSON.stringify(shapes)).not.toContain(SECRET);
    expect(line).not.toContain(SECRET);
  });

  it('calls a file that does not parse not-json, and says why when a person would miss it', async () => {
    const truncated = await readWithShapes(fileIo(`{"claudeAiOauth":{"accessToken":"${SECRET}`));
    expect(truncated.result).toBeNull();
    expect(truncated.shapes[0]).toMatchObject({ reason: 'not-json', keys: [], keyCount: 0 });
    expect(describeClaudeCredentialShape(truncated.shapes[0]!)).toBe(
      '.credentials.json present, not JSON'
    );
    expect(JSON.stringify(truncated.shapes)).not.toContain(SECRET);

    // A Windows editor's UTF-8 BOM: valid JSON to the eye, not to `JSON.parse`.
    expect(await lineFor(fileIo('﻿' + keychainJson()))).toBe(
      '.credentials.json present, not JSON (starts with a byte-order mark)'
    );
    expect(await lineFor(fileIo('   '))).toBe('.credentials.json present, not JSON (empty)');
  });

  it('tells a missing file from one that is there but unreadable', async () => {
    expect(await lineFor({ ...fileIo(''), homedir: () => '/elsewhere' })).toBe(
      '.credentials.json not found'
    );

    const busy = Object.assign(new Error(`EBUSY: resource busy, open '${SECRET}'`), {
      code: 'EBUSY'
    });
    const locked = await readWithShapes(fileIo(busy));
    expect(locked.result).toBeNull();
    expect(locked.shapes[0]).toMatchObject({ reason: 'unreadable', errorCode: 'EBUSY' });
    expect(describeClaudeCredentialShape(locked.shapes[0]!)).toBe(
      '.credentials.json present but unreadable (EBUSY)'
    );
    // The error's message (Node puts the path in it) is not part of the shape.
    expect(JSON.stringify(locked.shapes)).not.toContain(SECRET);

    // A `code` that is not one of Node's own is dropped rather than trusted.
    expect(await lineFor(fileIo(Object.assign(new Error('x'), { code: SECRET })))).toBe(
      '.credentials.json present but unreadable'
    );
  });

  it('calls JSON that is not an object not-an-object', async () => {
    expect(await lineFor(fileIo('[1,2,3]'))).toBe(
      '.credentials.json present, JSON but not an object'
    );
  });

  it('reports a claudeAiOauth block with no token, both null and logged out', async () => {
    const nullBlock = fileIo('{"claudeAiOauth":null,"mcpOAuth":{}}');
    expect(await readClaudeCodeCredentials(nullBlock)).toBeNull();
    expect(await lineFor(nullBlock)).toBe(
      '.credentials.json present, keys: claudeAiOauth,mcpOAuth — claudeAiOauth block present but empty'
    );

    const loggedOut = await readWithShapes(fileIo(keychainJson({ accessToken: '' })));
    expect(loggedOut.result).toEqual({ expired: true, expiresAt: null, loggedOut: true });
    expect(loggedOut.shapes).toEqual([
      expect.objectContaining({ reason: 'empty-oauth-block', keys: ['claudeAiOauth', 'mcpOAuth'] })
    ]);
    expect(JSON.stringify(loggedOut.shapes)).not.toContain('fake-refresh-token-value');
  });

  it('caps the key list, and shows an odd key name only by its length', async () => {
    const extra = 3;
    const total = CLAUDE_CREDENTIAL_KEYS_SHOWN + extra;
    const many = Object.fromEntries(
      Array.from({ length: total }, (_, i) => [`key${String(i).padStart(2, '0')}`, i])
    );
    const capped = (await readWithShapes(fileIo(JSON.stringify(many)))).shapes[0]!;
    expect(capped.keys).toHaveLength(CLAUDE_CREDENTIAL_KEYS_SHOWN);
    expect(capped.keyCount).toBe(total);
    const line = describeClaudeCredentialShape(capped);
    expect(line).toContain('keys: key00,key01,');
    expect(line).toContain(`(+${extra} more) — no claudeAiOauth block`);

    const longKey = 'k'.repeat(CREDENTIAL_KEY_NAME_MAX_CHARS + 1);
    const odd = (
      await readWithShapes(fileIo(JSON.stringify({ [longKey]: 1, 'has space': 2, plain: 3 })))
    ).shapes[0]!;
    expect(odd.keys).toEqual([`<${longKey.length}-char key>`, '<9-char key>', 'plain']);
    expect(describeClaudeCredentialShape(odd)).not.toContain(longKey);
  });

  it('reports nothing for a usable or merely expired token', async () => {
    expect((await readWithShapes(fileIo(keychainJson()))).shapes).toEqual([]);
    expect((await readWithShapes(fileIo(keychainJson({}, NOW - 1000)))).shapes).toEqual([]);
  });

  it('says keychain item on macOS, and missing for no item', async () => {
    expect(await readClaudeCodeCredentials(macIo(null))).toBeNull();
    expect(await lineFor(macIo(null))).toBe('keychain item not found');
    expect(await lineFor(macIo('{"mcpOAuth":{}}'))).toBe(
      'keychain item present, keys: mcpOAuth — no claudeAiOauth block'
    );
  });

  it('still returns null when the reporter itself throws', async () => {
    const result = await readClaudeCodeCredentials(fileIo('{}'), () => {
      throw new Error('a broken diagnostic');
    });
    expect(result).toBeNull();
  });
});

describe('readCodexCredentials', () => {
  const io = (text: string | null): CredentialIo => ({
    homedir: () => '/home/v',
    readTextFile: async (path) => {
      if (path !== native('/home/v/.codex/auth.json') || text === null) throw new Error('ENOENT');
      return text;
    }
  });

  it('reads the access token and account id', async () => {
    const result = await readCodexCredentials(
      io(
        JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: {
            access_token: 'fake-codex-token',
            account_id: '00000000-0000-0000-0000-000000000000',
            refresh_token: 'fake-refresh'
          },
          last_refresh: '2026-09-01T18:31:00Z'
        })
      )
    );
    expect(result).toEqual({
      accessToken: 'fake-codex-token',
      accountId: '00000000-0000-0000-0000-000000000000'
    });
  });

  it('tolerates a missing account id', async () => {
    // Sent only when present: an empty `ChatGPT-Account-Id` header is rejected
    // outright by the endpoint.
    const result = await readCodexCredentials(
      io(JSON.stringify({ tokens: { access_token: 'fake' } }))
    );
    expect(result).toEqual({ accessToken: 'fake', accountId: null });
  });

  it('never returns the refresh token', async () => {
    const result = await readCodexCredentials(
      io(JSON.stringify({ tokens: { access_token: 'fake', refresh_token: 'secret' } }))
    );
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('is null for a missing file, bad JSON or the wrong shape', async () => {
    expect(await readCodexCredentials(io(null))).toBeNull();
    expect(await readCodexCredentials(io('{'))).toBeNull();
    expect(await readCodexCredentials(io('{"tokens":null}'))).toBeNull();
    expect(await readCodexCredentials(io('{"tokens":{"access_token":""}}'))).toBeNull();
  });
});

describe('readCursorCredentials', () => {
  const MAC = native('/Users/v/Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  const io = (
    rows: Record<string, Record<string, string>>,
    platform = 'darwin'
  ): CredentialIo & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      platform,
      homedir: () => '/Users/v',
      appData: () => 'C:\\Users\\v\\AppData\\Roaming',
      readSqliteValue: async (path, table, key) => {
        asked.push(`${table}:${key}`);
        return rows[path]?.[`${table}:${key}`] ?? null;
      },
      keychain: async () => {
        throw new Error('the keychain has nothing to do with Cursor');
      }
    };
  };

  it('knows where Cursor keeps its state on each platform', () => {
    expect(cursorStatePath(io({}))).toBe(MAC);
    expect(cursorStatePath(io({}, 'linux'))).toBe(
      native('/Users/v/.config/Cursor/User/globalStorage/state.vscdb')
    );
    expect(cursorStatePath(io({}, 'win32'))).toContain('Cursor');
    expect(cursorStatePath({ platform: 'win32', appData: () => undefined })).toBeNull();
  });

  it('reads the token out of ItemTable', async () => {
    const result = await readCursorCredentials(io({ [MAC]: { [`ItemTable:${CURSOR_TOKEN_KEY}`]: 'eyJ.jwt' } }));
    expect(result).toEqual({ accessToken: 'eyJ.jwt' });
  });

  it('falls back to cursorDiskKV, and asks for nothing else', async () => {
    const overrides = io({ [MAC]: { [`cursorDiskKV:${CURSOR_TOKEN_KEY}`]: 'eyJ.jwt' } });
    expect(await readCursorCredentials(overrides)).toEqual({ accessToken: 'eyJ.jwt' });
    expect(overrides.asked).toEqual([`ItemTable:${CURSOR_TOKEN_KEY}`, `cursorDiskKV:${CURSOR_TOKEN_KEY}`]);
  });

  it('unwraps a JSON string literal, and trims', async () => {
    expect(await readCursorCredentials(io({ [MAC]: { [`ItemTable:${CURSOR_TOKEN_KEY}`]: '"eyJ.jwt"' } })))
      .toEqual({ accessToken: 'eyJ.jwt' });
    expect(await readCursorCredentials(io({ [MAC]: { [`ItemTable:${CURSOR_TOKEN_KEY}`]: ' eyJ.jwt\n' } })))
      .toEqual({ accessToken: 'eyJ.jwt' });
  });

  it('is null with no editor, no row, or an empty value', async () => {
    expect(await readCursorCredentials(io({}))).toBeNull();
    expect(await readCursorCredentials(io({ [MAC]: { [`ItemTable:${CURSOR_TOKEN_KEY}`]: '""' } }))).toBeNull();
    expect(await readCursorCredentials(io({ [MAC]: { 'ItemTable:other': 'x' } }))).toBeNull();
    // Windows with no APPDATA: nothing is even asked for.
    const win = io({}, 'win32');
    expect(await readCursorCredentials({ ...win, appData: () => undefined })).toBeNull();
  });

  it('reads the real state file read-only and answers null when it is absent', async () => {
    // The default reader against a path that does not exist: no throw, no file created.
    const result = await readCursorCredentials({ platform: 'darwin', homedir: () => '/nonexistent/walder-test' });
    expect(result).toBeNull();
  });
});

describe('readCopilotCredentials', () => {
  it('returns the GitHub CLI token, trimmed', async () => {
    // `gh auth token` prints the token with a trailing newline, and the header
    // it goes into must not carry one.
    expect(await readCopilotCredentials({ ghToken: async () => ' gho_fake\n' })).toEqual({
      accessToken: 'gho_fake'
    });
  });

  it('is null when gh has no token to give', async () => {
    // No `gh` on the PATH, or a `gh` that is logged out: both are "no Copilot
    // credential", and neither is worth showing the owner as an error.
    expect(await readCopilotCredentials({ ghToken: async () => null })).toBeNull();
    expect(await readCopilotCredentials({ ghToken: async () => '' })).toBeNull();
    expect(await readCopilotCredentials({ ghToken: async () => '   ' })).toBeNull();
  });

  it('is null when the reader itself throws', async () => {
    // A spawn that fails before the callback runs must not take the poll with
    // it — "missing is normal" applies to the child process too.
    expect(
      await readCopilotCredentials({
        ghToken: async () => {
          throw new Error('spawn gh ENOENT');
        }
      })
    ).toBeNull();
  });
});

/**
 * Finding `gh` when there is barely a PATH.
 *
 * Copilot read `unavailable` in the packaged 0.2.6 while `gh auth token`
 * worked in the owner's terminal (2026-09-21): a Finder-launched app inherits
 * `launchd`'s minimal PATH and never reads a login shell's profile, so the
 * Homebrew `gh` every shell finds was invisible to the one process that
 * needed it. Same fix, and same candidate shape, as `claudeBinaryCandidates`.
 */
describe('ghBinaryCandidates', () => {
  it('puts PATH entries first, then the standard install roots', () => {
    // Host delimiter and host separator, as in `claude-renew-main.test.ts`:
    // the function uses the host's `node:path`, which is right at runtime.
    expect(
      ghBinaryCandidates('darwin', '/Users/v', hostPathVar('/usr/bin', '/opt/homebrew/bin'))
    ).toEqual(
      [
        '/usr/bin/gh',
        '/opt/homebrew/bin/gh',
        '/opt/homebrew/bin/gh',
        '/usr/local/bin/gh',
        '/Users/v/.local/bin/gh',
        '/usr/bin/gh'
      ].map(native)
    );
  });

  it('drops relative PATH entries', () => {
    // "Run whatever `./gh` is in the current directory" is a very old class of
    // bug, and the cwd of a Finder-launched app is not the owner's choice.
    const out = ghBinaryCandidates('darwin', '/Users/v', hostPathVar('./tools', '../bin', ''));
    expect(out).toEqual(
      ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/Users/v/.local/bin/gh', '/usr/bin/gh'].map(
        native
      )
    );
  });

  it('names no conda or other personal prefix', () => {
    // Victor's decision, 2026-09-21: a private root is a private choice, and
    // the owner who made it can put it on the PATH — which is the first thing
    // this looks at.
    const out = ghBinaryCandidates('darwin', '/Users/v', undefined).join('\n');
    expect(out).not.toMatch(/conda|miniforge|mamba|pyenv|nvm/);
  });

  it('looks for the Windows spellings on Windows', () => {
    // A POSIX-shaped PATH entry, because `path.isAbsolute` and the PATH
    // delimiter are the *host's* — the same compromise `claude-renew`'s own
    // candidate test makes. What is being pinned here is the name list.
    expect(ghBinaryCandidates('win32', '/home/v', '/tools').slice(0, 3)).toEqual(
      ['/tools/gh', '/tools/gh.cmd', '/tools/gh.exe'].map(native)
    );
  });
});

describe('findGhBinary', () => {
  it('prefers a gh that is on the PATH', () => {
    const path = process.env['PATH'];
    try {
      process.env['PATH'] = '/opt/mine/bin';
      const mine = native('/opt/mine/bin/gh');
      expect(findGhBinary((p) => p === mine || p === native('/usr/local/bin/gh'))).toBe(mine);
    } finally {
      process.env['PATH'] = path;
    }
  });

  it('falls back to the first install root that exists', () => {
    const path = process.env['PATH'];
    try {
      process.env['PATH'] = '';
      const root = native('/usr/local/bin/gh');
      expect(findGhBinary((p) => p === root)).toBe(root);
    } finally {
      process.env['PATH'] = path;
    }
  });

  it('is null when there is no gh anywhere — which reads as unavailable', async () => {
    expect(findGhBinary(() => false)).toBeNull();
    // And that is what the provider layer sees: no token, no Copilot.
    expect(await readCopilotCredentials({ ghToken: async () => null })).toBeNull();
  });
});

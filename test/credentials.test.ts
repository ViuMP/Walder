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
  readClaudeCodeCredentials,
  readCodexCredentials,
  type CredentialIo,
  cursorStatePath,
  readCursorCredentials,
  readCopilotCredentials,
  CURSOR_TOKEN_KEY
} from '../src/providers/credentials';

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
  const io = (files: Record<string, string>): CredentialIo => ({
    platform: 'win32',
    now: () => NOW,
    homedir: () => '/home/v',
    readTextFile: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error('ENOENT');
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

describe('readCodexCredentials', () => {
  const io = (text: string | null): CredentialIo => ({
    homedir: () => '/home/v',
    readTextFile: async (path) => {
      if (path !== '/home/v/.codex/auth.json' || text === null) throw new Error('ENOENT');
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
  const MAC = '/Users/v/Library/Application Support/Cursor/User/globalStorage/state.vscdb';
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
      '/Users/v/.config/Cursor/User/globalStorage/state.vscdb'
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

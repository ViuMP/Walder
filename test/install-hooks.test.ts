/**
 * The `~/.claude/settings.json` merge.
 *
 * This file belongs to the owner's Claude Code install, not to us, so the tests
 * are almost entirely about *not breaking it*: unknown top-level keys, other
 * people's hooks in the same event, other people's hooks in the same matcher
 * group, and events we do not subscribe to all have to come back byte-for-byte
 * equivalent. And because the tray item can be clicked twice, the merge has to
 * be idempotent — the bug it prevents is a settings file that grows a duplicate
 * `curl` on every click.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_HOOK_PORT,
  HOOK_EVENTS,
  HOOK_MARKER,
  HOOK_TIMEOUT_S,
  applyHooks,
  claudeSettingsPath,
  hookCommand,
  installedHookPort,
  mergeHooks,
  removeHooks,
  resolveHookPort,
  walderStorePath
} from '../src/main/claude-hooks';

const PORT = 47_811;

/** Our hook entry inside `settings.hooks[event]`, or `undefined`. */
function ourHook(settings: Record<string, unknown>, event: string): Record<string, unknown> | undefined {
  const hooks = settings['hooks'] as Record<string, unknown> | undefined;
  const groups = hooks?.[event] as unknown[] | undefined;
  for (const group of groups ?? []) {
    const inner = (group as { hooks?: unknown[] }).hooks ?? [];
    for (const hook of inner) {
      const command = (hook as { command?: unknown }).command;
      if (typeof command === 'string' && command.includes(HOOK_MARKER)) {
        return hook as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

describe('claudeSettingsPath', () => {
  it('is ~/.claude/settings.json', () => {
    expect(claudeSettingsPath('/Users/someone')).toBe('/Users/someone/.claude/settings.json');
  });
});

describe('hookCommand', () => {
  it('posts the hook’s own stdin to the loopback port, on macOS/Linux', () => {
    const command = hookCommand(PORT, 'darwin');
    expect(command).toContain('curl');
    // `@-` is what forwards the event JSON Claude Code pipes in.
    expect(command).toContain('--data-binary @-');
    expect(command).toContain(`http://127.0.0.1:${PORT}/event`);
    // Never allowed to fail: Walder being closed must not fail the owner's hook.
    expect(command).toContain('|| true');
    expect(command).toContain(HOOK_MARKER);
  });

  it('uses PowerShell on Windows, and still forwards stdin', () => {
    const command = hookCommand(PORT, 'win32');
    expect(command).toContain('powershell -NoProfile');
    expect(command).toContain('[Console]::In.ReadToEnd()');
    expect(command).toContain('Invoke-RestMethod');
    expect(command).toContain('catch {}');
    expect(command).toContain(HOOK_MARKER);
  });

  /**
   * The Windows command must contain no `$`. Anything POSIX-shaped between
   * Claude Code and PowerShell — Git Bash, an MSYS wrapper, WSL — expands the
   * string first, and a `$b` holding the piped event JSON would be substituted
   * with nothing: the hook then posts an empty body, the server answers 400 and
   * `catch {}` swallows it. Installed, and silently inert. Pinned as an exact
   * string because this is the one platform the build cannot exercise.
   */
  it('never uses a shell variable on Windows', () => {
    const command = hookCommand(PORT, 'win32');
    expect(command).not.toContain('$');
    expect(command).toContain('-Body ([Console]::In.ReadToEnd())');
    expect(command).toBe(
      `powershell -NoProfile -Command "try { Invoke-RestMethod -Uri http://127.0.0.1:47811/event ` +
        `-Method Post -ContentType 'application/json' -Body ([Console]::In.ReadToEnd()) ` +
        `-TimeoutSec 1 | Out-Null } catch {} # walder-hook"`
    );
  });

  it('carries the port it is given', () => {
    expect(hookCommand(47_813, 'darwin')).toContain('127.0.0.1:47813');
    expect(hookCommand(47_813, 'win32')).toContain('127.0.0.1:47813');
  });
});

/**
 * Reading the port out of Walder's own settings file.
 *
 * The bug this closes: the listener walks to `hookPort + 1` when the preferred
 * port is taken and records that as `hookPortActual`, so an installer that
 * assumed the default wrote a hook pointing at a port nothing was listening on —
 * a hook that looks installed and does nothing.
 */
describe('resolveHookPort', () => {
  async function tempStore(contents?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'walder-store-'));
    const path = join(dir, 'walder.json');
    if (contents !== undefined) await writeFile(path, contents, 'utf8');
    return path;
  }

  it('prefers the port actually bound', async () => {
    const path = await tempStore(JSON.stringify({ hookPort: 47_811, hookPortActual: 47_813 }));
    expect(await resolveHookPort(path)).toBe(47_813);
  });

  it('falls back to the preferred port when nothing has bound yet', async () => {
    const path = await tempStore(JSON.stringify({ hookPort: 47_900, hookPortActual: null }));
    expect(await resolveHookPort(path)).toBe(47_900);
  });

  it('falls back to the default on a missing, empty or corrupt file', async () => {
    expect(await resolveHookPort(await tempStore())).toBe(DEFAULT_HOOK_PORT);
    expect(await resolveHookPort(await tempStore('{ not json'))).toBe(DEFAULT_HOOK_PORT);
    expect(await resolveHookPort(await tempStore('[]'))).toBe(DEFAULT_HOOK_PORT);
    expect(await resolveHookPort(await tempStore('{}'))).toBe(DEFAULT_HOOK_PORT);
  });

  it('ignores values outside the range a listener could have bound', async () => {
    const path = await tempStore(
      JSON.stringify({ hookPort: 47_811, hookPortActual: 80, extra: 1 })
    );
    // 80 is privileged; the listener starts at 1024, so it cannot be ours.
    expect(await resolveHookPort(path)).toBe(47_811);

    const junk = await tempStore(
      JSON.stringify({ hookPort: 'nope', hookPortActual: 70_000 })
    );
    expect(await resolveHookPort(junk)).toBe(DEFAULT_HOOK_PORT);
  });
});

describe('walderStorePath', () => {
  it('is electron-store’s own userData location, per platform', () => {
    expect(walderStorePath('darwin', {}, '/Users/someone')).toBe(
      '/Users/someone/Library/Application Support/walder/walder.json'
    );
    expect(walderStorePath('win32', { APPDATA: 'C:\\Users\\someone\\AppData\\Roaming' }, 'C:\\Users\\someone')).toBe(
      join('C:\\Users\\someone\\AppData\\Roaming', 'walder', 'walder.json')
    );
    expect(walderStorePath('linux', {}, '/home/someone')).toBe(
      '/home/someone/.config/walder/walder.json'
    );
  });

  it('honours XDG_CONFIG_HOME, and APPDATA’s absence', () => {
    expect(walderStorePath('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/someone')).toBe(
      '/xdg/walder/walder.json'
    );
    expect(walderStorePath('win32', {}, '/home/someone')).toBe(
      join('/home/someone', 'AppData', 'Roaming', 'walder', 'walder.json')
    );
  });
});

/**
 * Reading back what is installed — the question the app could not ask before
 * 0.2.5, and the reason the owner's dog sat silent for days with a healthy
 * listener, a stored port and no hooks in the file at all.
 *
 * Every failure has to be `null` rather than a throw: this is read at launch
 * *and* on every tray menu build, and a settings file somebody hand-edited into
 * nonsense must cost a status line, not the menu.
 */
describe('installedHookPort', () => {
  async function tempSettings(contents?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'walder-claude-'));
    const path = join(dir, 'settings.json');
    if (contents !== undefined) await writeFile(path, contents, 'utf8');
    return path;
  }

  it('reads the port out of an installed hook', async () => {
    const { settings } = mergeHooks({}, PORT, 'darwin');
    const path = await tempSettings(JSON.stringify(settings));
    expect(installedHookPort(path)).toBe(PORT);
  });

  it('reports the stale port when the listener has moved on', async () => {
    const { settings } = mergeHooks({}, PORT + 2, 'darwin');
    const path = await tempSettings(JSON.stringify(settings));
    // The mismatch with the bound port is what `index.ts` turns into
    // "Reinstall Claude Code hooks".
    expect(installedHookPort(path)).toBe(PORT + 2);
  });

  it('finds a hook installed under only one of the four events', async () => {
    // What a half-removed (or hand-edited) file looks like: Claude Code still
    // reports a wait, and nothing else.
    const { settings } = mergeHooks({}, PORT, 'darwin');
    const hooks = settings['hooks'] as Record<string, unknown>;
    const path = await tempSettings(
      JSON.stringify({ hooks: { Notification: hooks['Notification'] } })
    );
    expect(installedHookPort(path)).toBe(PORT);
  });

  it('still reads a file written before PostToolUse joined the list', async () => {
    /*
     * 0.2.7 added a fourth entry, and every install out there has three.
     * "Installed" has to keep meaning what it meant, or the tray would tell
     * everyone who upgraded that their working hooks are missing — and the
     * hooks *are* working, they are just one event short. `Stop` carries the
     * marker in both shapes, so the first-match walk answers either way.
     */
    const { settings } = mergeHooks({}, PORT, 'darwin');
    const hooks = settings['hooks'] as Record<string, unknown>;
    const old = {
      hooks: {
        Stop: hooks['Stop'],
        Notification: hooks['Notification'],
        UserPromptSubmit: hooks['UserPromptSubmit']
      }
    };
    expect(Object.keys(old.hooks)).toHaveLength(3);
    expect(installedHookPort(await tempSettings(JSON.stringify(old)))).toBe(PORT);
  });

  it('is null when the file is missing, empty, or not ours', async () => {
    expect(installedHookPort(await tempSettings())).toBeNull();
    expect(installedHookPort(await tempSettings('{}'))).toBeNull();
    // The owner's real file on 2026-09-15: three hooks, none of them Walder's.
    expect(
      installedHookPort(
        await tempSettings(
          JSON.stringify({
            hooks: {
              Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
              UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hi' }] }]
            }
          })
        )
      )
    ).toBeNull();
  });

  it('is null rather than a throw for every shape it cannot read', async () => {
    for (const contents of [
      '{ not json',
      '[]',
      'null',
      JSON.stringify({ hooks: 'off' }),
      JSON.stringify({ hooks: { Stop: 'off' } }),
      JSON.stringify({ hooks: { Stop: [{ hooks: 'off' }] } }),
      // Ours by the marker, but with no URL a port can be read out of.
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: `true # ${HOOK_MARKER}` }] }] }
      }),
      // A port outside the range a listener could have bound.
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: `curl http://127.0.0.1:80/event # ${HOOK_MARKER}` }] }
          ]
        }
      })
    ]) {
      expect(installedHookPort(await tempSettings(contents)), contents).toBeNull();
    }
  });

  it('defaults to the real settings path', () => {
    // No assertion on the value — the machine running the tests may or may not
    // have hooks installed. What is pinned is that the default argument is a
    // path and the call cannot throw.
    expect(() => installedHookPort()).not.toThrow();
  });
});

describe('mergeHooks', () => {
  it('installs one command hook per event, in Claude Code’s schema', () => {
    const { settings, changed, touched } = mergeHooks({}, PORT, 'darwin');
    expect(changed).toBe(true);
    expect(touched).toEqual([...HOOK_EVENTS]);
    // Four since 0.2.7. `PostToolUse` is the one that says an approved command
    // has run, which is the only thing either tool sends when the owner
    // unblocks a session without typing anything.
    expect([...HOOK_EVENTS]).toEqual(['Stop', 'Notification', 'UserPromptSubmit', 'PostToolUse']);

    for (const event of HOOK_EVENTS) {
      const groups = (settings['hooks'] as Record<string, unknown>)[event] as unknown[];
      expect(groups, event).toHaveLength(1);
      const group = groups[0] as Record<string, unknown>;
      // No matcher — on `PostToolUse` too, which *is* a tool event: Walder
      // wants it for every tool, and which command ran is none of his business.
      expect(group['matcher']).toBeUndefined();
      expect(ourHook(settings, event)).toEqual({
        type: 'command',
        command: hookCommand(PORT, 'darwin'),
        timeout: HOOK_TIMEOUT_S
      });
    }
  });

  it('is idempotent: a second merge adds nothing', () => {
    const first = mergeHooks({}, PORT, 'darwin');
    const second = mergeHooks(first.settings, PORT, 'darwin');
    expect(second.changed).toBe(false);
    expect(second.settings).toEqual(first.settings);

    const groups = (second.settings['hooks'] as Record<string, unknown>)['Stop'] as unknown[];
    expect(groups).toHaveLength(1);
  });

  it('updates in place when the port has moved', () => {
    const first = mergeHooks({}, PORT, 'darwin');
    const moved = mergeHooks(first.settings, PORT + 2, 'darwin');
    expect(moved.changed).toBe(true);
    const groups = (moved.settings['hooks'] as Record<string, unknown>)['Stop'] as unknown[];
    expect(groups).toHaveLength(1);
    expect(ourHook(moved.settings, 'Stop')?.['command']).toContain('47813');
  });

  it('preserves unknown top-level keys and other events', () => {
    const before = {
      model: 'opus',
      env: { FOO: 'bar' },
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }]
      }
    };
    const { settings } = mergeHooks(before, PORT, 'darwin');
    expect(settings['model']).toBe('opus');
    expect(settings['env']).toEqual({ FOO: 'bar' });
    expect(settings['permissions']).toEqual({ allow: ['Bash(ls:*)'] });
    expect((settings['hooks'] as Record<string, unknown>)['PreToolUse']).toEqual(
      before.hooks.PreToolUse
    );
  });

  it('appends beside somebody else’s hook on the same event', () => {
    const before = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }
    };
    const { settings } = mergeHooks(before, PORT, 'darwin');
    const groups = (settings['hooks'] as Record<string, unknown>)['Stop'] as unknown[];
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual(before.hooks.Stop[0]);
    expect(ourHook(settings, 'Stop')).toBeDefined();
  });

  it('finds and updates our hook inside a shared matcher group', () => {
    const shared = mergeHooks(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'say done' },
                { type: 'command', command: `old --thing # ${HOOK_MARKER}` }
              ]
            }
          ]
        }
      },
      PORT,
      'darwin'
    );
    const groups = (shared.settings['hooks'] as Record<string, unknown>)['Stop'] as unknown[];
    expect(groups).toHaveLength(1);
    const inner = (groups[0] as { hooks: unknown[] }).hooks;
    expect(inner).toHaveLength(2);
    // The neighbour is untouched; ours is refreshed.
    expect(inner[0]).toEqual({ type: 'command', command: 'say done' });
    expect((inner[1] as { command: string }).command).toBe(hookCommand(PORT, 'darwin'));
  });

  it('never mutates its input', () => {
    const before = { hooks: { Stop: [] } };
    const snapshot = JSON.stringify(before);
    mergeHooks(before, PORT, 'darwin');
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('starts from scratch on a file that is not an object', () => {
    for (const junk of [null, undefined, [], 'nope', 7]) {
      const { settings, changed } = mergeHooks(junk, PORT, 'darwin');
      expect(changed).toBe(true);
      expect(ourHook(settings, 'Stop')).toBeDefined();
    }
  });

  /**
   * The difference between "there is nothing to preserve" and "there is
   * something here we do not understand".
   *
   * A whole file that is not an object carries no settings, so replacing it
   * loses nothing. A `hooks` key of the wrong shape is the opposite: it is
   * something the owner (or a future Claude Code) put there, and the earlier
   * code coerced it to `{}`/`[]` and wrote the result back — silently deleting
   * it. Refusing costs one dialog; coercing costs a setting.
   */
  it('refuses a "hooks" key that is not an object, instead of discarding it', () => {
    for (const junk of ['off', 42, [], null, true]) {
      const before = { model: 'opus', hooks: junk };
      const result = mergeHooks(before, PORT, 'darwin');
      expect(result.changed, JSON.stringify(junk)).toBe(false);
      expect(result.touched).toEqual([]);
      expect(result.refused).toBeDefined();
      expect(result.refused).toContain('"hooks"');
      // The input comes back untouched — in particular `hooks` still holds it.
      expect(result.settings['hooks']).toEqual(junk);
      expect(result.settings['model']).toBe('opus');
    }
  });

  it('refuses a hooks.<Event> that is not an array, instead of discarding it', () => {
    for (const junk of [{ matcher: 'x' }, 'curl', 7, null]) {
      const before = {
        hooks: {
          Stop: junk,
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }]
        }
      };
      const result = mergeHooks(before, PORT, 'darwin');
      expect(result.changed, JSON.stringify(junk)).toBe(false);
      expect(result.refused).toContain('"hooks.Stop"');
      // Nothing was written for the *other* two events either: a partial
      // install is worse than none, because the owner cannot tell which
      // happened.
      expect(result.settings).toEqual(before);
    }
  });

  it('still installs when a hooks.<Event> we do not touch is malformed', () => {
    // Only the three events we write to are checked; a broken `PreToolUse`
    // belongs to somebody else and is carried through as-is.
    const before = { hooks: { PreToolUse: 'not a list' } };
    const result = mergeHooks(before, PORT, 'darwin');
    expect(result.changed).toBe(true);
    expect(result.refused).toBeUndefined();
    expect((result.settings['hooks'] as Record<string, unknown>)['PreToolUse']).toBe('not a list');
    expect(ourHook(result.settings, 'Stop')).toBeDefined();
  });
});

describe('removeHooks', () => {
  it('takes ours out and leaves nothing behind', () => {
    const installed = mergeHooks({ model: 'opus' }, PORT, 'darwin');
    const { settings, changed, touched } = removeHooks(installed.settings);
    expect(changed).toBe(true);
    expect(touched.sort()).toEqual([...HOOK_EVENTS].sort());
    // The whole `hooks` key goes, because it held only ours.
    expect(settings).toEqual({ model: 'opus' });
  });

  it('leaves other people’s hooks in place', () => {
    const before = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }]
      }
    };
    const installed = mergeHooks(before, PORT, 'darwin');
    const { settings } = removeHooks(installed.settings);
    expect(settings).toEqual(before);
  });

  it('leaves a neighbour inside a shared group', () => {
    const before = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'say done' },
              { type: 'command', command: `x # ${HOOK_MARKER}` }
            ]
          }
        ]
      }
    };
    const { settings, changed } = removeHooks(before);
    expect(changed).toBe(true);
    expect(settings).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }
    });
  });

  it('is a no-op on a file with no Walder hooks', () => {
    const before = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
    const { changed, settings } = removeHooks(before);
    expect(changed).toBe(false);
    expect(settings).toEqual(before);
    expect(removeHooks({}).changed).toBe(false);
    expect(removeHooks(null).changed).toBe(false);
  });

  it('round-trips: install then remove returns the original', () => {
    const before = { model: 'opus', hooks: { PreToolUse: [{ hooks: [] }] } };
    const installed = mergeHooks(before, PORT, 'darwin');
    expect(removeHooks(installed.settings).settings).toEqual(before);
  });
});

describe('applyHooks (on disk)', () => {
  async function tempSettings(contents?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'walder-hooks-'));
    const path = join(dir, 'settings.json');
    if (contents !== undefined) await writeFile(path, contents, 'utf8');
    return path;
  }

  it('creates the file when there is none, with no backup to make', async () => {
    const path = await tempSettings();
    const outcome = await applyHooks({ port: PORT, settingsPath: path, platform: 'darwin' });
    expect(outcome.changed).toBe(true);
    expect(outcome.backupPath).toBeNull();

    const written = await readFile(path, 'utf8');
    // Two-space indent, as Claude Code writes it.
    expect(written).toContain('\n  "hooks": {');
    expect(ourHook(JSON.parse(written) as Record<string, unknown>, 'Stop')).toBeDefined();
  });

  it('backs the original up before the first change', async () => {
    const path = await tempSettings('{\n  "model": "opus"\n}\n');
    const outcome = await applyHooks({ port: PORT, settingsPath: path, platform: 'darwin' });
    expect(outcome.backupPath).not.toBeNull();

    const backup = await readFile(outcome.backupPath as string, 'utf8');
    expect(backup).toBe('{\n  "model": "opus"\n}\n');
    expect((await readdir(join(path, '..'))).some((f) => f.includes('walder-backup'))).toBe(true);
  });

  it('writes nothing on a second run', async () => {
    const path = await tempSettings();
    await applyHooks({ port: PORT, settingsPath: path, platform: 'darwin' });
    const after = await readFile(path, 'utf8');

    const second = await applyHooks({ port: PORT, settingsPath: path, platform: 'darwin' });
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeNull();
    expect(second.summary).toContain('Already installed');
    expect(await readFile(path, 'utf8')).toBe(after);
  });

  it('removes cleanly', async () => {
    const path = await tempSettings('{"model":"opus"}');
    await applyHooks({ port: PORT, settingsPath: path, platform: 'darwin' });
    const outcome = await applyHooks({
      port: PORT,
      settingsPath: path,
      platform: 'darwin',
      remove: true
    });
    expect(outcome.changed).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ model: 'opus' });
  });

  /**
   * The one case where refusing is the only safe answer: rewriting a file we
   * cannot parse would silently delete everything the owner had in it.
   */
  it('refuses to touch a settings file it cannot parse', async () => {
    const path = await tempSettings('{ this is not json');
    const outcome = await applyHooks({ port: PORT, settingsPath: path, platform: 'darwin' });
    expect(outcome.changed).toBe(false);
    expect(outcome.summary).toContain('not valid JSON');
    expect(await readFile(path, 'utf8')).toBe('{ this is not json');
  });

  /** The same refusal, one level in: a `hooks` key of the wrong shape. */
  it('refuses a malformed hooks key, and leaves the file and directory alone', async () => {
    const path = await tempSettings('{"model":"opus","hooks":"off"}');
    const outcome = await applyHooks({ port: PORT, settingsPath: path, platform: 'darwin' });
    expect(outcome.changed).toBe(false);
    expect(outcome.backupPath).toBeNull();
    expect(outcome.summary).toContain('"hooks"');
    expect(outcome.summary).toContain('Nothing was changed');
    expect(await readFile(path, 'utf8')).toBe('{"model":"opus","hooks":"off"}');
    // No backup and no temp file left behind by a refusal.
    expect((await readdir(join(path, '..')))).toEqual(['settings.json']);
  });

  /**
   * Write order: the temp file is renamed over the original *last*, so a failure
   * anywhere earlier leaves `settings.json` exactly as it was — and no temp file
   * survives a successful run.
   */
  it('leaves no temp file behind, and the backup names the untouched original', async () => {
    const path = await tempSettings('{\n  "model": "opus"\n}\n');
    const outcome = await applyHooks({ port: PORT, settingsPath: path, platform: 'darwin' });
    expect(outcome.changed).toBe(true);

    const files = (await readdir(join(path, '..'))).sort();
    expect(files.filter((f) => f.includes('walder-tmp'))).toEqual([]);
    expect(files.filter((f) => f.includes('walder-backup'))).toHaveLength(1);
    expect(await readFile(outcome.backupPath as string, 'utf8')).toBe('{\n  "model": "opus"\n}\n');
    expect(ourHook(JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>, 'Stop')).toBeDefined();
  });
});

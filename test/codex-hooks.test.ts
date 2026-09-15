/**
 * The `~/.codex/hooks.json` merge.
 *
 * Almost everything here is `claude-hooks.ts`'s code reached through a different
 * door, and that is the point of the file: the tests pin the four things that
 * *are* Codex's — the path (including `$CODEX_HOME`), the event names, the
 * source header on the command, and the fact that none of the never-lose-a-
 * setting behaviour was lost on the way through. If a future edit copies the
 * merge instead of calling it, the "other people's hooks survive" cases below
 * are what notice.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_MARKER, HOOK_TIMEOUT_S, hookCommand } from '../src/main/claude-hooks';
import {
  CODEX_HOOK_EVENTS,
  CODEX_SOURCE_HEADER,
  applyCodexHooks,
  codexHome,
  codexHooksPath,
  installedCodexHookPort
} from '../src/main/codex-hooks';

const PORT = 47_811;

type Json = Record<string, unknown>;

/** Our hook entry inside `hooks[event]`, or `undefined`. */
function ourHook(settings: Json, event: string): Json | undefined {
  const groups = (settings['hooks'] as Json | undefined)?.[event] as unknown[] | undefined;
  for (const group of groups ?? []) {
    for (const hook of (group as { hooks?: unknown[] }).hooks ?? []) {
      const command = (hook as { command?: unknown }).command;
      if (typeof command === 'string' && command.includes(HOOK_MARKER)) return hook as Json;
    }
  }
  return undefined;
}

async function tempHooks(contents?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'walder-codex-'));
  const path = join(dir, 'hooks.json');
  if (contents !== undefined) await writeFile(path, contents, 'utf8');
  return path;
}

async function read(path: string): Promise<Json> {
  return JSON.parse(await readFile(path, 'utf8')) as Json;
}

describe('codexHome', () => {
  it('is ~/.codex by default', () => {
    expect(codexHome({}, '/Users/someone')).toBe('/Users/someone/.codex');
    expect(codexHooksPath({}, '/Users/someone')).toBe('/Users/someone/.codex/hooks.json');
  });

  it('obeys $CODEX_HOME, which is how a second profile is kept apart', () => {
    expect(codexHome({ CODEX_HOME: '/tmp/cx' }, '/Users/someone')).toBe('/tmp/cx');
    expect(codexHooksPath({ CODEX_HOME: '/tmp/cx' }, '/Users/someone')).toBe('/tmp/cx/hooks.json');
  });

  it('treats an exported-but-empty value as unset', () => {
    // `export CODEX_HOME=` leaves an empty string, and joining onto it would
    // install into `/hooks.json`.
    expect(codexHome({ CODEX_HOME: '' }, '/Users/someone')).toBe('/Users/someone/.codex');
  });
});

describe('the Codex events', () => {
  it('replaces Notification with Codex’s approval event', () => {
    // `PermissionRequest` fires before Codex asks to run a command or apply a
    // patch. There is no Codex event for a plan-mode question at all — see the
    // note on `CODEX_HOOK_EVENTS`.
    expect(CODEX_HOOK_EVENTS).toEqual(['Stop', 'PermissionRequest', 'UserPromptSubmit']);
  });
});

describe('the command', () => {
  it('carries the source header, so the listener can name the tool', () => {
    const command = hookCommand(PORT, 'darwin', CODEX_SOURCE_HEADER);
    expect(command).toContain("-H 'X-Walder-Source: codex'");
    // And everything the Claude command does: stdin forwarded, never fatal,
    // marked as ours.
    expect(command).toContain('--data-binary @-');
    expect(command).toContain(`http://127.0.0.1:${PORT}/event`);
    expect(command).toContain('|| true');
    expect(command).toContain(HOOK_MARKER);
  });

  it('adds the header to the PowerShell hashtable, and stays $-free', () => {
    const command = hookCommand(PORT, 'win32', CODEX_SOURCE_HEADER);
    expect(command).toContain("-Headers @{'X-Walder-Source'='codex'}");
    expect(command).toContain('-Body ([Console]::In.ReadToEnd())');
    expect(command).not.toContain('$');
    expect(command).toContain(HOOK_MARKER);
  });
});

describe('applyCodexHooks (on disk)', () => {
  it('creates the file as { "hooks": … } when there is none', async () => {
    const path = await tempHooks();
    const outcome = await applyCodexHooks({ port: PORT, hooksPath: path, platform: 'darwin' });
    expect(outcome.changed).toBe(true);
    expect(outcome.backupPath).toBeNull();
    expect(outcome.touched).toEqual([...CODEX_HOOK_EVENTS]);
    expect(outcome.summary).toContain('Codex picks them up');

    const written = await read(path);
    expect(Object.keys(written)).toEqual(['hooks']);
    for (const event of CODEX_HOOK_EVENTS) {
      expect(ourHook(written, event), event).toEqual({
        type: 'command',
        command: hookCommand(PORT, 'darwin', CODEX_SOURCE_HEADER),
        timeout: HOOK_TIMEOUT_S
      });
    }
    // Claude Code's event is *not* written here: Codex would never fire it.
    expect(ourHook(written, 'Notification')).toBeUndefined();
  });

  it('merges into a hooks.json that already has other hooks', async () => {
    const before = {
      hooks: {
        // Somebody else's hook on an event we also want, and a whole event we
        // do not touch.
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }]
      },
      // An unknown top-level key, which is the owner's and none of our business.
      notes: 'mine'
    };
    const path = await tempHooks(JSON.stringify(before, null, 2));
    await applyCodexHooks({ port: PORT, hooksPath: path, platform: 'darwin' });

    const after = await read(path);
    expect(after['notes']).toBe('mine');
    const hooks = after['hooks'] as Json;
    expect(hooks['PreToolUse']).toEqual(before.hooks.PreToolUse);
    const stop = hooks['Stop'] as unknown[];
    expect(stop).toHaveLength(2);
    expect(stop[0]).toEqual(before.hooks.Stop[0]);
    expect(ourHook(after, 'Stop')).toBeDefined();
  });

  it('is idempotent, and backs the original up before a real change', async () => {
    const path = await tempHooks(JSON.stringify({ notes: 'mine' }, null, 2));
    const first = await applyCodexHooks({ port: PORT, hooksPath: path, platform: 'darwin' });
    expect(first.backupPath).not.toBeNull();
    expect(await readFile(first.backupPath as string, 'utf8')).toBe(
      JSON.stringify({ notes: 'mine' }, null, 2)
    );
    const written = await readFile(path, 'utf8');

    const second = await applyCodexHooks({ port: PORT, hooksPath: path, platform: 'darwin' });
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeNull();
    expect(second.summary).toContain('Already installed');
    expect(await readFile(path, 'utf8')).toBe(written);
    // One backup from the first run, and no temp file from either.
    const files = await readdir(join(path, '..'));
    expect(files.filter((name) => name.includes('walder-backup'))).toHaveLength(1);
    expect(files.filter((name) => name.includes('walder-tmp'))).toEqual([]);
  });

  it('removes only ours, and leaves the rest of the file as it was', async () => {
    const before = {
      notes: 'mine',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }
    };
    const path = await tempHooks(JSON.stringify(before));
    await applyCodexHooks({ port: PORT, hooksPath: path, platform: 'darwin' });

    const outcome = await applyCodexHooks({
      port: PORT,
      hooksPath: path,
      platform: 'darwin',
      remove: true
    });
    expect(outcome.changed).toBe(true);
    expect(await read(path)).toEqual(before);
    expect(installedCodexHookPort(path)).toBeNull();
  });
});

describe('installedCodexHookPort', () => {
  it('reads the port out of the installed command', async () => {
    const path = await tempHooks();
    await applyCodexHooks({ port: 47_813, hooksPath: path, platform: 'darwin' });
    expect(installedCodexHookPort(path)).toBe(47_813);
  });

  it('is null for an absent, empty or unparseable file, and for a stranger’s hooks', async () => {
    expect(installedCodexHookPort(join(tmpdir(), 'walder-nope', 'hooks.json'))).toBeNull();
    expect(installedCodexHookPort(await tempHooks(''))).toBeNull();
    expect(installedCodexHookPort(await tempHooks('{ not json'))).toBeNull();
    expect(installedCodexHookPort(await tempHooks('{"hooks":"off"}'))).toBeNull();
    expect(
      installedCodexHookPort(
        await tempHooks(
          JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } })
        )
      )
    ).toBeNull();
  });

  /**
   * It reads the *Codex* events only. A `~/.claude/settings.json` handed to it
   * by mistake has our hook under `Notification`, and reporting that as a Codex
   * install would show a green status line for hooks Codex will never run.
   */
  it('ignores a Walder hook sitting under Claude Code’s event', async () => {
    const path = await tempHooks(
      JSON.stringify({
        hooks: {
          Notification: [
            { hooks: [{ type: 'command', command: hookCommand(PORT, 'darwin') }] }
          ]
        }
      })
    );
    expect(installedCodexHookPort(path)).toBeNull();
  });

  it('defaults to the real path without throwing', () => {
    // No assertion on the value: the machine running the tests may or may not
    // have Codex hooks installed.
    expect(() => installedCodexHookPort()).not.toThrow();
  });
});

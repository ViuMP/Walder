/**
 * Click-to-raise: the path arithmetic, the `ps` line parsing, and the walk.
 *
 * The walk is the part with a real failure mode — a tree that loops, a pid
 * that exits mid-walk, a machine where `ps` is not what we think it is — so
 * `exec` is a table here rather than a real subprocess, and what is asserted
 * is the exact argv the walker would have run.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { appBundleFrom, nextHop } from '../src/core/raise';
import {
  appBundleForPid,
  clearAppBundleCache,
  createRaiser,
  MAX_HOPS,
  OPEN_BIN,
  PS_BIN
} from '../src/main/raise';

/*
 * The walk remembers its answer per pid (0.2.7 — the frontmost watch asks the
 * same question every two seconds), and every `it` below is a different fake
 * machine that happens to reuse pid 100. Without this each test would be
 * answered by the previous one's process tree.
 */
beforeEach(() => {
  clearAppBundleCache();
});

describe('appBundleFrom', () => {
  it('cuts a deep executable path back to its bundle', () => {
    expect(appBundleFrom('/Applications/iTerm.app/Contents/MacOS/iTerm2')).toBe(
      '/Applications/iTerm.app'
    );
  });

  it('keeps a bundle path that is already the bundle', () => {
    expect(appBundleFrom('/Users/x/Foo.app')).toBe('/Users/x/Foo.app');
  });

  it('answers null for an ordinary binary', () => {
    expect(appBundleFrom('/usr/bin/zsh')).toBeNull();
  });

  it('answers null for a segment that merely contains .app', () => {
    expect(appBundleFrom('/opt/happ.apple/x')).toBeNull();
  });

  it('takes the outermost bundle when one is nested inside another', () => {
    // A helper inside an app is not the thing a human launched, and `open -a`
    // on it would raise a process with no window the owner recognises.
    expect(
      appBundleFrom('/Applications/Outer.app/Contents/Helpers/Inner.app/Contents/MacOS/inner')
    ).toBe('/Applications/Outer.app');
  });

  it('answers null for a segment that is only the extension', () => {
    expect(appBundleFrom('/Users/x/.app/bin/thing')).toBeNull();
  });

  it('handles a bundle name with a space in it', () => {
    expect(appBundleFrom('/Applications/Visual Studio Code.app/Contents/MacOS/Electron')).toBe(
      '/Applications/Visual Studio Code.app'
    );
  });
});

describe('nextHop', () => {
  it('takes apart an ordinary line', () => {
    expect(nextHop('501 /usr/bin/node')).toEqual({ ppid: 501, comm: '/usr/bin/node' });
  });

  it('ignores the leading spaces ps right-aligns the column with', () => {
    expect(nextHop('    1 /sbin/launchd\n')).toEqual({ ppid: 1, comm: '/sbin/launchd' });
  });

  it('keeps the spaces inside a comm', () => {
    expect(nextHop('  902 /Applications/Visual Studio Code.app/Contents/MacOS/Electron')).toEqual({
      ppid: 902,
      comm: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'
    });
  });

  it('answers null for anything that is not a ps line', () => {
    expect(nextHop('')).toBeNull();
    expect(nextHop('   ')).toBeNull();
    expect(nextHop('ps: no such process')).toBeNull();
    // A pid with no comm is half a line, and half an answer is not one.
    expect(nextHop('  501')).toBeNull();
  });
});

/** A raiser whose `ps` answers from `table`, keyed by the pid asked about. */
function raiserWith(
  table: Readonly<Record<string, string>>,
  extra: { platform?: string; maxHops?: number } = {}
): { raise: (pid: number) => Promise<boolean>; calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = [];
  const raiser = createRaiser({
    platform: 'darwin',
    ...extra,
    exec: async (bin, args) => {
      calls.push([bin, [...args]]);
      if (bin === OPEN_BIN) return '';
      const asked = args[args.length - 1] ?? '';
      const line = table[asked];
      if (line === undefined) throw new Error('no such process');
      return line;
    }
  });
  return { raise: (pid) => raiser.raise(pid), calls };
}

/** The argv `ps` is run with for one pid — pinned, because no shell is allowed. */
function psCall(pid: number): [string, string[]] {
  return [PS_BIN, ['-o', 'ppid=,comm=', '-p', String(pid)]];
}

describe('createRaiser', () => {
  it('walks up to the terminal and opens its bundle', async () => {
    const { raise, calls } = raiserWith({
      '100': '  101 /usr/local/bin/node',
      '101': '  102 /bin/zsh',
      '102': '    1 /Applications/iTerm.app/Contents/MacOS/iTerm2'
    });
    await expect(raise(100)).resolves.toBe(true);
    expect(calls).toEqual([
      psCall(100),
      psCall(101),
      psCall(102),
      [OPEN_BIN, ['-a', '/Applications/iTerm.app']]
    ]);
  });

  it('gives up at launchd, and opens nothing', async () => {
    const { raise, calls } = raiserWith({ '100': '  1 /usr/bin/node' });
    await expect(raise(100)).resolves.toBe(false);
    expect(calls).toEqual([psCall(100)]);
  });

  it('does not spin on a tree that points at itself', async () => {
    const { raise, calls } = raiserWith({ '100': ' 100 /usr/bin/node' });
    await expect(raise(100)).resolves.toBe(false);
    expect(calls).toEqual([psCall(100)]);
  });

  it('stops where ps says something it cannot parse', async () => {
    const { raise, calls } = raiserWith({ '100': 'ps: nope' });
    await expect(raise(100)).resolves.toBe(false);
    expect(calls).toEqual([psCall(100)]);
  });

  it('answers false when exec throws', async () => {
    // The table is empty, so the very first `ps` rejects.
    const { raise } = raiserWith({});
    await expect(raise(100)).resolves.toBe(false);
  });

  it('runs nothing at all off macOS', async () => {
    const { raise, calls } = raiserWith(
      { '100': '  101 /Applications/iTerm.app/Contents/MacOS/iTerm2' },
      { platform: 'win32' }
    );
    await expect(raise(100)).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it('stops at the hop cap rather than walking a tree forever', async () => {
    // A chain longer than the cap, with the bundle out of reach at the end.
    const table: Record<string, string> = {};
    for (let pid = 100; pid < 100 + MAX_HOPS * 2; pid++) {
      table[String(pid)] = `  ${pid + 1} /usr/bin/node`;
    }
    const { raise, calls } = raiserWith(table);
    await expect(raise(100)).resolves.toBe(false);
    expect(calls).toHaveLength(MAX_HOPS);
  });

  it('honours a smaller cap when one is injected', async () => {
    const { raise, calls } = raiserWith(
      { '100': '  101 /usr/bin/node', '101': '  102 /bin/zsh', '102': '  103 /bin/sh' },
      { maxHops: 2 }
    );
    await expect(raise(100)).resolves.toBe(false);
    expect(calls).toEqual([psCall(100), psCall(101)]);
  });
});

/**
 * The walk without the `open`, which is what the frontmost watch spends: is
 * the app the owner just brought forward the one this session is running in?
 *
 * The cache is the point of the separate function as much as the reuse is —
 * `onFrontmostApp` asks once per session per two-second poll, and a `ps` walk
 * each time is a subprocess per session per poll for the life of the app.
 */
describe('appBundleForPid', () => {
  /** A `ps` table as a fake exec, counting the calls it was asked for. */
  function psTable(table: Readonly<Record<string, string>>): {
    exec: (bin: string, args: readonly string[]) => Promise<string>;
    calls: { n: number };
  } {
    const calls = { n: 0 };
    return {
      calls,
      exec: async (_bin, args) => {
        calls.n++;
        const line = table[args[args.length - 1] ?? ''];
        if (line === undefined) throw new Error('no such process');
        return line;
      }
    };
  }

  it('answers the bundle the walk reaches', async () => {
    const { exec } = psTable({
      '100': '  101 /usr/local/bin/node',
      '101': '    1 /Applications/iTerm.app/Contents/MacOS/iTerm2'
    });
    await expect(appBundleForPid(100, { exec, platform: 'darwin' })).resolves.toBe(
      '/Applications/iTerm.app'
    );
  });

  it('walks once per pid and answers from memory after that', async () => {
    const { exec, calls } = psTable({
      '100': '  101 /usr/local/bin/node',
      '101': '    1 /Applications/iTerm.app/Contents/MacOS/iTerm2'
    });
    await appBundleForPid(100, { exec, platform: 'darwin' });
    expect(calls.n).toBe(2);
    await expect(appBundleForPid(100, { exec, platform: 'darwin' })).resolves.toBe(
      '/Applications/iTerm.app'
    );
    // Not one more `ps`: a pid's ancestors do not change while it lives.
    expect(calls.n).toBe(2);
  });

  it('remembers a walk that found nothing, too', async () => {
    // "No bundle above this pid" is as stable as a hit, and re-walking twelve
    // hops every two seconds to rediscover it is the expensive half.
    const { exec, calls } = psTable({ '100': '    1 /usr/bin/node' });
    await expect(appBundleForPid(100, { exec, platform: 'darwin' })).resolves.toBeNull();
    expect(calls.n).toBe(1);
    await expect(appBundleForPid(100, { exec, platform: 'darwin' })).resolves.toBeNull();
    expect(calls.n).toBe(1);
  });

  it('runs nothing at all off macOS', async () => {
    const { exec, calls } = psTable({
      '100': '    1 /Applications/iTerm.app/Contents/MacOS/iTerm2'
    });
    await expect(appBundleForPid(100, { exec, platform: 'win32' })).resolves.toBeNull();
    expect(calls.n).toBe(0);
  });

  it('is the same walk `raise` spends, so the two cannot disagree', async () => {
    const table = {
      '100': '  101 /usr/local/bin/node',
      '101': '    1 /Applications/iTerm.app/Contents/MacOS/iTerm2'
    };
    const { raise, calls } = raiserWith(table);
    await expect(raise(100)).resolves.toBe(true);
    expect(calls.at(-1)).toEqual([OPEN_BIN, ['-a', '/Applications/iTerm.app']]);
    // And the frontmost path now gets that answer for free, off the cache the
    // pet just filled: no further `ps`.
    const before = calls.length;
    await expect(appBundleForPid(100)).resolves.toBe('/Applications/iTerm.app');
    expect(calls).toHaveLength(before);
  });
});

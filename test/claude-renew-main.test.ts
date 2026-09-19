/**
 * The spawning half of the Claude Code login renewal.
 *
 * What is worth pinning here is everything that could go wrong on a machine
 * nobody is watching: a second process for the same expiry, a child that never
 * exits, a binary that cannot be started being retried forever, and — the one
 * with teeth — the renewal child being announced as a Claude Code session,
 * which would have Walder reacting to his own housekeeping every few hours.
 *
 * The child double is `test/fullscreen-watch.test.ts`'s, narrowed to the three
 * members this module uses. No real process is started and no real credential
 * is read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RENEW_ARGS,
  RENEW_KILL_MS,
  RENEW_SIGKILL_GRACE_MS,
  claudeBinaryCandidates,
  createClaudeRenew,
  findClaudeBinary,
  type RenewChild
} from '../src/main/claude-renew';
import { setVerbose } from '../src/main/log';

const NOW = Date.parse('2026-09-19T09:00:00Z');
/** Comfortably inside the 4-minute margin, so `shouldRenew` says `renew`. */
const STALE = NOW - 1_000;
const BIN = '/opt/homebrew/bin/claude';
const SCRATCH = '/tmp/walder-test/claude-scratch';

/** A stand-in for the `claude` child process. */
function fakeChild(pid = 4242): {
  child: RenewChild;
  exit: () => void;
  fail: (message: string) => void;
  signals: () => Array<string | undefined>;
} {
  const lifecycle = new Map<string, Array<(...args: unknown[]) => void>>();
  const signals: Array<string | undefined> = [];
  return {
    child: {
      pid,
      on: (event, listener): unknown => {
        const list = lifecycle.get(event) ?? [];
        list.push(listener);
        lifecycle.set(event, list);
        return undefined;
      },
      kill: (signal): unknown => {
        signals.push(signal);
        return true;
      }
    },
    exit: () => (lifecycle.get('exit') ?? []).forEach((fn) => fn(0)),
    fail: (message) => (lifecycle.get('error') ?? []).forEach((fn) => fn(new Error(message))),
    signals: () => signals
  };
}

/** Every line `vlog`/`info` printed, joined the way `console` would. */
let logged: string[] = [];

/** Let `verify`'s await chain finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  logged = [];
  // `vlog` and `info` only reach the console with diagnostics on; the file sink
  // is never installed in a test, so the console is the whole output.
  setVerbose(true);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  setVerbose(false);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('createClaudeRenew', () => {
  it('spawns the CLI once, with the renewal arguments and the scratch cwd', () => {
    const fake = fakeChild();
    const spawns: Array<{ bin: string; args: readonly string[]; cwd: string }> = [];
    const renew = createClaudeRenew({
      binary: BIN,
      scratchDir: SCRATCH,
      now: () => NOW,
      spawn: (bin, args, cwd) => {
        spawns.push({ bin, args, cwd });
        return fake.child;
      }
    });

    renew.observe(STALE);
    expect(spawns).toEqual([{ bin: BIN, args: RENEW_ARGS, cwd: SCRATCH }]);
    // `--bare` would be the obvious flag and is the wrong one: its help says
    // OAuth and the keychain are never read, so the CLI would exit without
    // touching the credential this exists to renew.
    expect(RENEW_ARGS).not.toContain('--bare');
  });

  it('owns the child pid as soon as observe returns', () => {
    // The session sweep runs on its own 2 s clock and must never see this
    // process as the owner starting work in Claude Code.
    const fake = fakeChild(9001);
    const renew = createClaudeRenew({
      binary: BIN,
      scratchDir: SCRATCH,
      now: () => NOW,
      spawn: () => fake.child
    });

    expect(renew.ownsPid(9001)).toBe(false);
    renew.observe(STALE);
    expect(renew.ownsPid(9001)).toBe(true);
    expect(renew.ownsPid(9002)).toBe(false);
    // And still afterwards: the session file can outlive the process it names.
    fake.exit();
    expect(renew.ownsPid(9001)).toBe(true);
  });

  it('never spawns twice for the same expiry', () => {
    let spawns = 0;
    const renew = createClaudeRenew({
      binary: BIN,
      scratchDir: SCRATCH,
      now: () => NOW,
      spawn: () => {
        spawns++;
        return fakeChild().child;
      }
    });

    renew.observe(STALE);
    renew.observe(STALE);
    renew.observe(STALE);
    expect(spawns).toBe(1);
  });

  it('kills a child that never exits, then makes sure of it', () => {
    const fake = fakeChild();
    const renew = createClaudeRenew({
      binary: BIN,
      scratchDir: SCRATCH,
      now: () => NOW,
      spawn: () => fake.child
    });

    renew.observe(STALE);
    expect(fake.signals()).toEqual([]);
    vi.advanceTimersByTime(RENEW_KILL_MS);
    expect(fake.signals()).toEqual([undefined]);
    vi.advanceTimersByTime(RENEW_SIGKILL_GRACE_MS);
    expect(fake.signals()).toEqual([undefined, 'SIGKILL']);
  });

  it('disarms both kills when the child exits on its own', () => {
    const fake = fakeChild();
    const renew = createClaudeRenew({
      binary: BIN,
      scratchDir: SCRATCH,
      now: () => NOW,
      spawn: () => fake.child,
      readExpiresAt: async () => null
    });

    renew.observe(STALE);
    fake.exit();
    vi.advanceTimersByTime(RENEW_KILL_MS + RENEW_SIGKILL_GRACE_MS + 1_000);
    expect(fake.signals()).toEqual([]);
  });

  it('says so once when there is no CLI, and spawns nothing', () => {
    let spawns = 0;
    let clock = NOW;
    const renew = createClaudeRenew({
      binary: null,
      scratchDir: SCRATCH,
      now: () => clock,
      spawn: () => {
        spawns++;
        return fakeChild().child;
      }
    });

    renew.observe(STALE);
    clock += 60 * 60_000;
    renew.observe(STALE - 1);
    expect(spawns).toBe(0);
    expect(logged.filter((line) => line.includes('no claude binary found'))).toHaveLength(1);
  });

  it('gives up for good when the CLI cannot be started', () => {
    // ENOENT (upgraded out from under us) or EACCES (not runnable). Neither
    // becomes true again by being tried every few hours.
    const fake = fakeChild();
    let spawns = 0;
    let clock = NOW;
    const renew = createClaudeRenew({
      binary: BIN,
      scratchDir: SCRATCH,
      now: () => clock,
      spawn: () => {
        spawns++;
        return fake.child;
      }
    });

    renew.observe(STALE);
    fake.fail('spawn ENOENT');
    clock += 60 * 60_000;
    renew.observe(STALE - 1);
    expect(spawns).toBe(1);
    // And the kill timers died with it.
    vi.advanceTimersByTime(RENEW_KILL_MS + RENEW_SIGKILL_GRACE_MS + 1_000);
    expect(fake.signals()).toEqual([]);
  });

  it('judges the attempt by the expiry, never by the exit code', async () => {
    // The CLI exits non-zero for an empty prompt *and* renews on the way, so
    // the status would say "failed" about the run that worked.
    for (const [after, expected] of [
      [STALE + 8 * 60 * 60_000, 'renewed'],
      [STALE, 'no change'],
      [null, 'no change']
    ] as Array<[number | null, string]>) {
      logged = [];
      const fake = fakeChild();
      createClaudeRenew({
        binary: BIN,
        scratchDir: SCRATCH,
        now: () => NOW,
        spawn: () => fake.child,
        readExpiresAt: async () => after
      }).observe(STALE);
      fake.exit();
      await settle();
      expect(logged.some((line) => line.includes(`claude token renewal: ${expected}`))).toBe(true);
    }
  });

  it('treats a credential read that rejects as no change, and does not throw', async () => {
    const fake = fakeChild();
    createClaudeRenew({
      binary: BIN,
      scratchDir: SCRATCH,
      now: () => NOW,
      spawn: () => fake.child,
      readExpiresAt: async () => {
        throw new Error('the keychain said no');
      }
    }).observe(STALE);

    expect(() => fake.exit()).not.toThrow();
    await settle();
    expect(logged.some((line) => line.includes('claude token renewal: no change'))).toBe(true);
  });

  it('stops after a failed attempt, and re-arms on the next expiry', async () => {
    // The pair that makes this safe: a renewal that changed nothing is never
    // retried for that expiry, and a credential that *did* move is a different
    // number and gets its own attempt.
    let spawns = 0;
    let clock = NOW;
    let child = fakeChild();
    const renew = createClaudeRenew({
      binary: BIN,
      scratchDir: SCRATCH,
      now: () => clock,
      spawn: () => {
        spawns++;
        return child.child;
      },
      readExpiresAt: async () => STALE
    });

    renew.observe(STALE);
    child.exit();
    await settle();
    expect(spawns).toBe(1);

    // Same expiry, cooldown long gone: still refused.
    clock += 60 * 60_000;
    renew.observe(STALE);
    expect(spawns).toBe(1);

    // A different expiry, equally stale: attempted.
    child = fakeChild(4243);
    renew.observe(clock - 1_000);
    expect(spawns).toBe(2);
  });

  it('renews on demand, gate ignored, and spends that expiry\'s one attempt', async () => {
    // The Developer item: a token with hours left would be 'fresh' to the gate.
    const fresh = NOW + 6 * 60 * 60_000;
    const fake = fakeChild();
    let spawns = 0;
    const renew = createClaudeRenew({
      binary: BIN,
      scratchDir: SCRATCH,
      now: () => NOW,
      readExpiresAt: async () => fresh,
      spawn: () => {
        spawns++;
        return fake.child;
      }
    });

    renew.observe(fresh);
    expect(spawns).toBe(0);
    await renew.renewNow();
    expect(spawns).toBe(1);
    // The forced run counted: the natural gate will not try this expiry again.
    fake.exit();
    await settle();
    renew.observe(fresh - 5 * 60_000 + 1);
    renew.observe(fresh);
    expect(spawns).toBe(1);
  });

  it('does not force a run when there is no login to renew', async () => {
    let spawns = 0;
    const renew = createClaudeRenew({
      binary: BIN,
      scratchDir: SCRATCH,
      now: () => NOW,
      readExpiresAt: async () => null,
      spawn: () => {
        spawns++;
        return fakeChild().child;
      }
    });

    await renew.renewNow();
    expect(spawns).toBe(0);
  });

  it('refuses a second forced run while one is still running', async () => {
    const fake = fakeChild();
    let spawns = 0;
    const renew = createClaudeRenew({
      binary: BIN,
      scratchDir: SCRATCH,
      now: () => NOW,
      readExpiresAt: async () => STALE,
      spawn: () => {
        spawns++;
        return fake.child;
      }
    });

    await renew.renewNow();
    await renew.renewNow();
    expect(spawns).toBe(1);
  });

  it('kills a live child on stop, once, and is a no-op with none', () => {
    const fake = fakeChild();
    const renew = createClaudeRenew({
      binary: BIN,
      scratchDir: SCRATCH,
      now: () => NOW,
      spawn: () => fake.child
    });

    // Nothing running yet.
    expect(() => renew.stop()).not.toThrow();
    expect(fake.signals()).toEqual([]);

    renew.observe(STALE);
    renew.stop();
    renew.stop();
    expect(fake.signals()).toEqual([undefined]);
    // The kill timers went with it, so nothing signals a dead pid later.
    vi.advanceTimersByTime(RENEW_KILL_MS + RENEW_SIGKILL_GRACE_MS + 1_000);
    expect(fake.signals()).toEqual([undefined]);
  });
});

describe('claudeBinaryCandidates', () => {
  const HOME = '/Users/v';

  it('drops relative PATH entries', () => {
    // A relative entry resolves against whatever the cwd happens to be, and
    // "run whatever ./claude is in this directory" is an old class of bug.
    const found = claudeBinaryCandidates('linux', HOME, '/usr/bin:bin:.:/opt/tools', () => []);
    expect(found).toContain('/usr/bin/claude');
    expect(found).toContain('/opt/tools/claude');
    expect(found.some((path) => !path.startsWith('/'))).toBe(false);
  });

  it('looks for the .cmd and .exe wrappers on Windows', () => {
    const found = claudeBinaryCandidates('win32', HOME, '/tools', () => []);
    expect(found.slice(0, 3)).toEqual(['/tools/claude', '/tools/claude.cmd', '/tools/claude.exe']);
  });

  it('puts PATH ahead of the four install paths', () => {
    const found = claudeBinaryCandidates('linux', HOME, '/usr/bin', () => []);
    expect(found).toEqual([
      '/usr/bin/claude',
      '/Users/v/.claude/local/claude',
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      '/Users/v/.local/bin/claude'
    ]);
  });

  it('appends the macOS desktop bundle, newest version first', () => {
    // The only CLI on this Mac (2026-09-19): none of the four install paths
    // exist and `claude` is not on PATH.
    const root = '/Users/v/Library/Application Support/Claude/claude-code';
    const listed: string[] = [];
    const found = claudeBinaryCandidates('darwin', HOME, '', (dir) => {
      listed.push(dir);
      return ['2.1.9', 'Cache', '2.1.275', '.DS_Store', '2.0.1'];
    });

    expect(listed).toEqual([root]);
    expect(found.slice(-3)).toEqual([
      `${root}/2.1.275/claude.app/Contents/MacOS/claude`,
      `${root}/2.1.9/claude.app/Contents/MacOS/claude`,
      `${root}/2.0.1/claude.app/Contents/MacOS/claude`
    ]);
    // Names that are not versions are skipped, not guessed at.
    expect(found.some((path) => path.includes('Cache') || path.includes('DS_Store'))).toBe(false);
  });

  it('has no bundle candidates off macOS', () => {
    const found = claudeBinaryCandidates('win32', HOME, '', () => ['2.1.275']);
    expect(found.some((path) => path.includes('claude.app'))).toBe(false);
  });
});

describe('findClaudeBinary', () => {
  it('returns the first candidate that exists', () => {
    const asked: string[] = [];
    const third = (): string => {
      const seen: string[] = [];
      findClaudeBinary((path) => {
        seen.push(path);
        return false;
      });
      return seen[2] ?? '';
    };
    const target = third();

    expect(
      findClaudeBinary((path) => {
        asked.push(path);
        return path === target;
      })
    ).toBe(target);
    // And it stopped there rather than stat-ing the rest.
    expect(asked.at(-1)).toBe(target);
  });

  it('is null when there is no CLI anywhere, which turns renewal off', () => {
    expect(findClaudeBinary(() => false)).toBeNull();
  });
});

/**
 * The rotating log file, and the seam that feeds it.
 *
 * This is the only record that survives to be read later: the owner has no
 * terminal, and a packaged app's stdout goes nowhere. So the properties that
 * matter are not about formatting, they are about the file still being there and
 * still being small — and about a broken disk costing the logging and nothing
 * else. Each of those is pinned below.
 *
 * `electron` is never imported: `createFileLog` takes a directory, and the app
 * passes `app.getPath('logs')`. That is what makes this testable at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LOG_NAME, MAX_BYTES, MAX_FILES, createFileLog, rotate } from '../src/main/log-file';
import { REDACTED, setLogSink, setVerbose, verbose, vlog, warn } from '../src/main/log';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'walder-log-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  setLogSink(null);
  setVerbose(false);
  vi.restoreAllMocks();
});

const live = (): string => join(dir, LOG_NAME);
const gen = (n: number): string => join(dir, `walder.${n}.log`);

describe('createFileLog', () => {
  it('appends lines to walder.log, creating the directory', () => {
    const nested = join(dir, 'Logs', 'Walder');
    const log = createFileLog({ dir: nested });
    log.write('one\n');
    log.write('two\n');

    expect(log.path).toBe(join(nested, LOG_NAME));
    expect(readFileSync(log.path, 'utf8')).toBe('one\ntwo\n');
  });

  it('appends to an existing file rather than truncating it', () => {
    // The previous run's warnings are the interesting ones when an app has been
    // restarted to "fix" something. Truncating on open would lose exactly those.
    writeFileSync(live(), 'from the last run\n');
    createFileLog({ dir }).write('from this run\n');

    expect(readFileSync(live(), 'utf8')).toBe('from the last run\nfrom this run\n');
  });

  it('rotates once the live file passes the cap, keeping three generations', () => {
    const log = createFileLog({ dir, maxBytes: 40, maxFiles: 3 });
    // Twelve bytes a line, so a rotation every fourth line.
    for (let i = 0; i < 16; i++) log.write(`line ${String(i).padStart(4, '0')}\n`);

    expect(existsSync(live())).toBe(true);
    expect(existsSync(gen(1))).toBe(true);
    expect(existsSync(gen(2))).toBe(true);
    // The fourth generation is deleted, not kept: that is the whole cap.
    expect(existsSync(gen(3))).toBe(false);
  });

  it('never lets a single file exceed the cap by more than one line', () => {
    const maxBytes = 100;
    const log = createFileLog({ dir, maxBytes, maxFiles: 3 });
    const line = `${'x'.repeat(29)}\n`;
    for (let i = 0; i < 20; i++) log.write(line);

    for (const path of [live(), gen(1), gen(2)]) {
      if (!existsSync(path)) continue;
      expect(readFileSync(path).byteLength, path).toBeLessThanOrEqual(maxBytes + line.length);
    }
  });

  it('keeps the newest lines in the live file after a rotation', () => {
    // The direction of the shuffle is easy to get backwards, and getting it
    // backwards means the file the owner sends is the oldest one.
    const log = createFileLog({ dir, maxBytes: 20, maxFiles: 3 });
    log.write('oldest\n');
    log.write('middle\n');
    log.write('newest\n');

    expect(readFileSync(live(), 'utf8')).toContain('newest');
    expect(readFileSync(gen(1), 'utf8')).not.toContain('newest');
  });

  it('measures the cap in bytes, not characters', () => {
    // A UTF-8 log ("…zzz", a path with an umlaut) would otherwise overshoot.
    const log = createFileLog({ dir, maxBytes: 24, maxFiles: 2 });
    log.write('ååååååååååå\n'); // 23 bytes, 12 characters
    log.write('b\n');
    expect(existsSync(gen(1))).toBe(true);
  });

  it('goes quiet instead of throwing when the file cannot be written', () => {
    const log = createFileLog({ dir });
    // Replace the live file with a directory: appending to it fails on every OS.
    rmSync(live(), { force: true });
    mkdirSync(live());

    expect(() => log.write('this cannot be written\n')).not.toThrow();
    // And it stays quiet rather than retrying (and failing) on every later line.
    expect(() => log.write('nor this\n')).not.toThrow();
  });

  it('does not throw when the directory cannot be created', () => {
    // A path under a *file* can never be a directory.
    const file = join(dir, 'not-a-directory');
    writeFileSync(file, 'x');
    const log = createFileLog({ dir: join(file, 'logs') });
    expect(() => log.write('anything\n')).not.toThrow();
  });

  it('ships a 1 MB × 3 default, which is what the README promises', () => {
    expect(MAX_BYTES).toBe(1_024 * 1_024);
    expect(MAX_FILES).toBe(3);
  });
});

describe('rotate', () => {
  it('is a no-op when there is nothing to rotate', () => {
    expect(() => rotate(dir, 3)).not.toThrow();
    expect(existsSync(gen(1))).toBe(false);
  });

  it('does not resurrect a generation that is missing in the middle', () => {
    writeFileSync(live(), 'a');
    writeFileSync(gen(2), 'c');
    rotate(dir, 3);

    // `walder.log` became `.1`; the absent `.1` did not become a `.2`, and the
    // old `.2` was the one deleted.
    expect(existsSync(live())).toBe(false);
    expect(readFileSync(gen(1), 'utf8')).toBe('a');
    expect(existsSync(gen(2))).toBe(false);
  });
});

/*
 * The sink seam in `log.ts`.
 *
 * Two rules, and both are load-bearing. `warn` must reach the file whatever the
 * verbose setting, because a warning is the thing someone reports a day later.
 * And redaction must happen *before* the sink, not before the console only — the
 * file is the copy that gets attached to a message.
 */
describe('the log sink', () => {
  function collect(): string[] {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    return lines;
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('writes warnings to the file even with verbose off', () => {
    const lines = collect();
    setVerbose(false);
    warn('something broke');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('WARN');
    expect(lines[0]).toContain('something broke');
  });

  it('writes vlog only when verbose is on', () => {
    const lines = collect();
    setVerbose(false);
    vlog('quiet');
    expect(lines).toHaveLength(0);

    setVerbose(true);
    vlog('loud');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('INFO');
    expect(lines[0]).toContain('loud');
  });

  it('reports the current verbosity, so the tray checkbox can reflect it', () => {
    setVerbose(true);
    expect(verbose()).toBe(true);
    setVerbose(false);
    expect(verbose()).toBe(false);
  });

  it('redacts before the sink, not just before the console', () => {
    const lines = collect();
    setVerbose(true);
    vlog('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.sig');

    expect(lines[0]).toContain(REDACTED);
    expect(lines[0]).not.toContain('eyJhbGci');
  });

  it('timestamps every line, so a log read next week can be placed in time', () => {
    const lines = collect();
    warn('dated');
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
  });

  it('ends every line with exactly one newline', () => {
    const lines = collect();
    warn('a');
    warn('b');
    expect(lines.every((line) => line.endsWith('\n') && !line.endsWith('\n\n'))).toBe(true);
  });

  it('survives a sink that throws, without recursing into warn', () => {
    setLogSink(() => {
      throw new Error('disk full');
    });
    // If `warn` handled a throwing sink by warning about it, this would recurse
    // until the stack ran out.
    expect(() => warn('anything')).not.toThrow();
  });

  it('stops writing once the sink is removed', () => {
    const lines = collect();
    warn('before');
    setLogSink(null);
    warn('after');
    expect(lines).toHaveLength(1);
  });
});

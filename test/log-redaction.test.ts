/**
 * The log redaction filter.
 *
 * From M4 the main process handles OAuth access tokens and `sessionKey`
 * cookies. They are read at poll time and never written anywhere — but a stray
 * `vlog(response)`, or a `fetch` error whose message quotes the request, would
 * put one on stdout and from there into a crash report or a screenshot. This
 * filter is the backstop, so every case it must catch is pinned here.
 *
 * It is also tested for what it must *not* destroy: a filter that mangles every
 * file path makes the diagnostics useless, and whoever is debugging turns it
 * off.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  REDACTED,
  info,
  redact,
  redactArgs,
  setLogSink,
  setVerbose,
  vlog,
  warn
} from '../src/main/log';

describe('redact', () => {
  it('masks a JWT-shaped access token', () => {
    // `eyJ` is the base64url of `{"` and starts every JWT — Claude's OAuth token
    // and Codex's id_token both look like this.
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const out = redact(`Authorization: Bearer ${jwt}`);
    expect(out).not.toContain('eyJhbGci');
    expect(out).toContain(REDACTED);
  });

  it('masks an sk- style key', () => {
    const out = redact('key=sk-proj-abcdefghijklmnopqrstuvwxyz0123');
    expect(out).not.toContain('abcdefghij');
    expect(out).toContain(REDACTED);
  });

  it('masks a sessionKey cookie, prefix and all', () => {
    const out = redact('Cookie: sessionKey=sk-ant-sid01-AbCdEfGhIjKlMnOpQrStUv; other=1');
    expect(out).not.toContain('AbCdEfGh');
    expect(out).toContain(REDACTED);
  });

  it('masks a long base64-ish run with no recognisable prefix', () => {
    // The catch-all, for a token shape we have not seen.
    const out = redact('token: QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo');
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('QUJDREVG');
  });

  it('masks every occurrence, not just the first', () => {
    const out = redact('a=eyJhbGciOiJIUzI1NiJ9 b=eyJzdWIiOiIxMjM0NTYifQ');
    expect(out).toBe(`a=${REDACTED} b=${REDACTED}`);
  });

  it('leaves ordinary diagnostics alone', () => {
    // Everything the logger actually prints on a normal run must survive, or the
    // filter would be turned off the first time someone had to debug something.
    for (const line of [
      'ignoreMouseEvents -> true',
      'window created 128x128 at (1232, 691), scale 2',
      'poll claude: auth-needed via claude-oauth (0 buckets)',
      'panel placed left of the dog at (920, 640) 300x246',
      'palette "chocolate" is not in the sheet'
    ]) {
      expect(redact(line)).toBe(line);
    }
  });

  it('leaves a file path readable', () => {
    // The reason `/` and `.` are not in the base64-ish character class: with
    // them, every path in the log is one long "token" and gets masked.
    const path = '/Users/victorprehn/Library/Application Support/walder/walder.json';
    expect(redact(path)).toBe(path);
  });

  it('is idempotent', () => {
    const once = redact('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(redact(once)).toBe(once);
  });
});

describe('redactArgs', () => {
  it('renders every argument as a string so the filter can see all of it', () => {
    // A live object handed to `console` is formatted by the console — after the
    // filter could have looked at it. So everything becomes a string here.
    expect(redactArgs(['x', 1, true, null, undefined])).toEqual([
      'x',
      '1',
      'true',
      'null',
      'undefined'
    ]);
  });

  it('redacts inside a nested object', () => {
    const out = redactArgs([{ headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9' } }]);
    expect(out[0]).toContain(REDACTED);
    expect(out[0]).not.toContain('eyJhbGci');
  });

  it('keeps an Error stack but redacts it', () => {
    const error = new Error('failed for sessionKey=AbCdEfGhIjKlMnOpQrStUv');
    const out = redactArgs([error]);
    expect(out[0]).toContain('Error');
    expect(out[0]).toContain(REDACTED);
    expect(out[0]).not.toContain('AbCdEfGh');
  });

  it('survives a cyclic object rather than throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'walder' };
    cyclic['self'] = cyclic;
    expect(() => redactArgs([cyclic])).not.toThrow();
  });
});

/**
 * The three levels, and which of them survive to the file.
 *
 * `info` was added for the fullscreen transitions: the owner has no terminal,
 * and asking him to have ticked **Verbose log** *before* the thing he is
 * reporting happened is asking for the impossible. So a state change is recorded
 * whatever the setting, without printing anything at him — and it is still
 * redacted, like every other level.
 */
describe('the log levels', () => {
  /** Capture what reaches the file sink and the console for one call. */
  function capture(call: () => void, verbose: boolean): { file: string[]; console: number } {
    const file: string[] = [];
    let printed = 0;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {
      printed++;
    });
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      printed++;
    });
    setLogSink((line) => file.push(line));
    setVerbose(verbose);
    try {
      call();
    } finally {
      setVerbose(false);
      setLogSink(null);
      log.mockRestore();
      warned.mockRestore();
    }
    return { file, console: printed };
  }

  it('writes info to the file even when diagnostics are off', () => {
    const quiet = capture(() => info('fullscreen entered'), false);
    expect(quiet.file).toHaveLength(1);
    expect(quiet.file[0]).toContain('INFO fullscreen entered');
    expect(quiet.console, 'printed at the owner with nothing wrong').toBe(0);
  });

  it('echoes info to the console once diagnostics are on', () => {
    expect(capture(() => info('fullscreen left'), true).console).toBe(1);
  });

  it('keeps vlog out of the file when diagnostics are off', () => {
    // The difference between the two levels: vlog is a diagnostic and costs
    // nothing when nobody asked for it.
    expect(capture(() => vlog('mouse moved'), false).file).toHaveLength(0);
    expect(capture(() => vlog('mouse moved'), true).file).toHaveLength(1);
  });

  it('always writes warn, and redacts every level', () => {
    expect(capture(() => warn('broken'), false).file).toHaveLength(1);
    for (const line of [
      capture(() => info('token', 'eyJhbGciOiJIUzI1NiJ9'), false).file[0],
      capture(() => warn('token', 'eyJhbGciOiJIUzI1NiJ9'), false).file[0],
      capture(() => vlog('token', 'eyJhbGciOiJIUzI1NiJ9'), true).file[0]
    ]) {
      expect(line).toContain(REDACTED);
      expect(line).not.toContain('eyJhbGci');
    }
  });
});

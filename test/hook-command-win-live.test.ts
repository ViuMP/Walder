/**
 * The Windows hook command, run for real (Windows audit W3, 2026-11-14).
 *
 * Claude Code and Codex write the event JSON to the hook's stdin as UTF-8. The
 * PowerShell command up to 0.2.9 read it with `[Console]::In.ReadToEnd()`,
 * which decodes through the console code page, and posted the string with a
 * bare `application/json`, which Windows PowerShell 5.1 encodes as ISO-8859-1.
 * Measured on Windows 11 through cmd.exe, PowerShell and Git Bash under code
 * pages 437, 850, 1252 and 65001: no run delivered a non-ASCII byte intact, and
 * a session in `…\Skrivebord\Blåbær` showed on the SESSIONS row as `Bl?�b?�r`.
 * The JSON still parsed — the damage stays inside strings — so nothing failed
 * loudly; only the folder on the card was wrong.
 *
 * The exact string is pinned in `install-hooks.test.ts` and `codex-hooks.test.ts`
 * on every platform. This file runs that string through PowerShell itself,
 * which only exists on win32, so the live cases are skipped elsewhere (like
 * `fullscreen-win-helper.test.ts`). Each case starts the command the way a host
 * does — through `cmd.exe /c`, and through Git Bash when it is installed — on a
 * console forced to an OEM code page (850), the default that broke it, and to
 * 65001, and requires the listener to receive the bytes that were sent. The
 * listener is our own, on an ephemeral port: never Walder's.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CODEX_SOURCE_HEADER } from '../src/main/codex-hooks';
import { hookCommand } from '../src/main/claude-hooks';

const LIVE = process.platform === 'win32';

/** PowerShell starts in 1–3 s on a loaded machine; the post itself is capped at 1 s. */
const RUN_TIMEOUT_MS = 20_000;

/** Western Europe's OEM console code page — what a default Danish install runs under. */
const OEM_CODE_PAGE = 850;

/** The UTF-8 console code page, where the old command still mis-encoded on the way out. */
const UTF8_CODE_PAGE = 65_001;

/** Where Git for Windows puts the bash that Claude Code can be configured to use. */
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

const EXPECTED_CWD = 'C:\\Users\\x\\Skrivebord\\Blåbær Æble';
const EXPECTED_PROMPT = 'ø Ø æ å 日本語';
const PAYLOAD = Buffer.from(
  JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'w3-live-test',
    cwd: EXPECTED_CWD,
    prompt: EXPECTED_PROMPT
  }),
  'utf8'
);

interface Received {
  readonly body: Buffer;
  readonly contentType: string | undefined;
  readonly source: string | undefined;
}

let server: Server;
let port = 0;
let waiting: ((r: Received) => void) | null = null;

/** The next request the listener sees, or `null` if none arrives in time. */
function nextRequest(): Promise<Received | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting = null;
      resolve(null);
    }, RUN_TIMEOUT_MS);
    waiting = (r) => {
      clearTimeout(timer);
      waiting = null;
      resolve(r);
    };
  });
}

/**
 * Run `command` with the payload on stdin the way `host` would, after setting
 * the child console's code page. `chcp` acts on the console the child owns, and
 * a hidden child of the test worker gets a console of its own, so this never
 * touches the terminal running the suite.
 */
function run(host: 'cmd' | 'gitbash', command: string, codePage: number): Promise<number | null> {
  const child =
    host === 'cmd'
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"chcp ${codePage} >nul & ${command}"`], {
          windowsVerbatimArguments: true,
          windowsHide: true
        })
      : spawn(GIT_BASH, ['-c', `chcp.com ${codePage} >/dev/null; ${command}`], { windowsHide: true });
  child.stdin.end(PAYLOAD);
  child.stdout.resume();
  child.stderr.resume();
  return new Promise((resolve) => child.on('close', resolve));
}

describe.runIf(LIVE)('the Windows hook command, live (W3)', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.statusCode = 204;
        res.end();
        const source = req.headers['x-walder-source'];
        waiting?.({
          body: Buffer.concat(chunks),
          contentType: req.headers['content-type'],
          source: Array.isArray(source) ? source[0] : source
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const cases: ReadonlyArray<{ host: 'cmd' | 'gitbash'; codePage: number; codex: boolean }> = [
    { host: 'cmd', codePage: OEM_CODE_PAGE, codex: false },
    { host: 'cmd', codePage: UTF8_CODE_PAGE, codex: false },
    { host: 'cmd', codePage: OEM_CODE_PAGE, codex: true },
    { host: 'gitbash', codePage: OEM_CODE_PAGE, codex: false }
  ];

  for (const { host, codePage, codex } of cases) {
    it.runIf(host === 'cmd' || existsSync(GIT_BASH))(
      `delivers the UTF-8 body byte for byte via ${host} on code page ${codePage}${codex ? ' (Codex)' : ''}`,
      // The command gives its post one second (`-TimeoutSec 1`) and swallows a
      // miss by design, so on a runner busy with the rest of the suite a post
      // can time out and nothing arrives. That is the hook working as meant,
      // not the encoding failing: try again before calling it a failure.
      { timeout: RUN_TIMEOUT_MS * 2, retry: 2 },
      async () => {
        const command = hookCommand(port, 'win32', codex ? CODEX_SOURCE_HEADER : undefined);
        const received = nextRequest();
        const exit = await run(host, command, codePage);
        const got = await received;

        expect(exit).toBe(0);
        expect(got).not.toBeNull();
        // The bytes, not just the parse: the old command parsed fine and was wrong.
        expect(got!.body.equals(PAYLOAD)).toBe(true);
        // Decoded the way hook-server.ts decodes it.
        const parsed = JSON.parse(got!.body.toString('utf8')) as { cwd: string; prompt: string };
        expect(parsed.cwd).toBe(EXPECTED_CWD);
        expect(parsed.prompt).toBe(EXPECTED_PROMPT);
        expect(got!.contentType).toBe('application/json; charset=utf-8');
        expect(got!.source).toBe(codex ? CODEX_SOURCE_HEADER.value : undefined);
      }
    );
  }
});

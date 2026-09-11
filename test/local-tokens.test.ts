/**
 * The "Tokens today" row: the line readers, and the scanner over a fake home.
 *
 * Two halves, tested the way they are built. The pure readers get fixture lines
 * as strings — the shapes here were copied off this machine's real transcripts,
 * trimmed to the fields the parsers read — and the scanner gets a temporary
 * home under `os.tmpdir()` rather than the developer's own `~/.claude`, since a
 * test that asserted against the real thing would pass today and fail tomorrow.
 *
 * The behaviour worth pinning hardest is the dedupe: Claude Code writes one
 * line per content block with the *same* per-message usage repeated on each, so
 * a naive sum overstates a tool-heavy day several times over.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LOCAL_TOKENS_PRIORITY,
  claudeTranscriptTokens,
  codexSessionTokens,
  localMidnight,
  tokensBucket
} from '../src/core/local-tokens';
import { createLocalTokenScanner } from '../src/main/local-tokens';

const TODAY = '2026-09-11T12:54:46.533Z';
const YESTERDAY = '2026-09-10T12:54:46.533Z';
const SINCE = Date.parse('2026-09-11T00:00:00.000Z');

/** One Claude assistant line, as the transcript actually shapes it. */
function claudeLine(
  messageId: string,
  requestId: string,
  usage: Record<string, number>,
  timestamp = TODAY
): string {
  return JSON.stringify({
    timestamp,
    requestId,
    type: 'assistant',
    message: { id: messageId, role: 'assistant', usage }
  });
}

/** One Codex `token_count` event. */
function codexLine(lastTotal: number | null, timestamp = TODAY): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info:
        lastTotal === null
          ? null
          : {
              total_token_usage: { total_tokens: 999_999 },
              last_token_usage: { total_tokens: lastTotal }
            }
    }
  });
}

const FULL_USAGE = {
  input_tokens: 2,
  cache_creation_input_tokens: 76_241,
  cache_read_input_tokens: 100,
  output_tokens: 316
};
/** 2 + 76241 + 100 + 316. */
const FULL_TOTAL = 76_659;

describe('claudeTranscriptTokens', () => {
  it('sums the four billed fields of one message', () => {
    expect(claudeTranscriptTokens([claudeLine('msg_1', 'req_1', FULL_USAGE)], SINCE, new Set())).toBe(
      FULL_TOTAL
    );
  });

  it('counts a message repeated once per content block only once', () => {
    const lines = [
      claudeLine('msg_1', 'req_1', FULL_USAGE),
      claudeLine('msg_1', 'req_1', FULL_USAGE),
      claudeLine('msg_1', 'req_1', FULL_USAGE),
      claudeLine('msg_2', 'req_2', FULL_USAGE)
    ];
    expect(claudeTranscriptTokens(lines, SINCE, new Set())).toBe(FULL_TOTAL * 2);
  });

  it('carries the dedupe across calls through the shared seen set', () => {
    const seen = new Set<string>();
    const line = claudeLine('msg_1', 'req_1', FULL_USAGE);
    expect(claudeTranscriptTokens([line], SINCE, seen)).toBe(FULL_TOTAL);
    expect(claudeTranscriptTokens([line], SINCE, seen)).toBe(0);
  });

  it('drops lines from before the cutoff', () => {
    const lines = [
      claudeLine('msg_old', 'req_old', FULL_USAGE, YESTERDAY),
      claudeLine('msg_new', 'req_new', FULL_USAGE)
    ];
    expect(claudeTranscriptTokens(lines, SINCE, new Set())).toBe(FULL_TOTAL);
  });

  it('treats a missing usage field as zero rather than as a break', () => {
    expect(
      claudeTranscriptTokens([claudeLine('msg_1', 'req_1', { output_tokens: 7 })], SINCE, new Set())
    ).toBe(7);
  });

  it('survives garbage, truncated lines and lines with no usage at all', () => {
    const lines = [
      '',
      'not json at all',
      '{"timestamp":"2026-09-11T12:00:00Z","message":{"usage":{"output_tokens":5',
      JSON.stringify({ timestamp: TODAY, type: 'user', message: { content: 'hello' } }),
      // Has the marker but no timestamp: unreadable, not today.
      JSON.stringify({ message: { id: 'm', usage: { output_tokens: 99 } } }),
      claudeLine('msg_1', 'req_1', FULL_USAGE)
    ];
    expect(claudeTranscriptTokens(lines, SINCE, new Set())).toBe(FULL_TOTAL);
  });
});

describe('codexSessionTokens', () => {
  it('sums the per-turn last_token_usage, not the running total', () => {
    expect(codexSessionTokens([codexLine(1_000), codexLine(2_500)], SINCE)).toBe(3_500);
  });

  it('skips an event whose info is null', () => {
    expect(codexSessionTokens([codexLine(null), codexLine(400)], SINCE)).toBe(400);
  });

  it('drops events from before the cutoff, and garbage', () => {
    const lines = [
      codexLine(9_000, YESTERDAY),
      'token_count but not json',
      JSON.stringify({ timestamp: TODAY, type: 'event_msg', payload: { type: 'agent_message' } }),
      codexLine(400)
    ];
    expect(codexSessionTokens(lines, SINCE)).toBe(400);
  });
});

describe('tokensBucket', () => {
  it('is a barless, resetless row that sorts last in its section', () => {
    const bucket = tokensBucket('claude', 76_659);
    expect(bucket).toEqual({
      id: 'claude.tokens_today',
      service: 'claude',
      key: 'tokens_today',
      label: 'Tokens today',
      pct: null,
      resetsAt: null,
      priority: LOCAL_TOKENS_PRIORITY,
      kind: 'tokens',
      tokens: { total: 76_659 }
    });
    // Below Extra usage (6) and Codex credits (5): it is a count, not an
    // allowance, and nothing above it should be pushed down by it.
    expect(LOCAL_TOKENS_PRIORITY).toBeGreaterThan(6);
    expect(tokensBucket('chatgpt', 0).id).toBe('chatgpt.tokens_today');
  });
});

describe('localMidnight', () => {
  it('is the local start of the day containing now', () => {
    const now = new Date(2026, 8, 11, 17, 43, 12, 500).getTime();
    const midnight = localMidnight(now);
    const asDate = new Date(midnight);
    expect(asDate.getHours()).toBe(0);
    expect(asDate.getMinutes()).toBe(0);
    expect(asDate.getDate()).toBe(11);
    expect(midnight).toBeLessThanOrEqual(now);
  });
});

/* ------------------------------------------------------------- the scanner */

const homes: string[] = [];

/** A throwaway home directory, cleaned up after the test. */
function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'walder-tokens-'));
  homes.push(home);
  return home;
}

/** Write a transcript and stamp it as touched `at`. */
function transcript(home: string, relative: string, lines: string[], at: number): string {
  const path = join(home, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  const seconds = at / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('createLocalTokenScanner', () => {
  /** Noon today, local, so the fixtures are unambiguously "today". */
  const noon = new Date(2026, 8, 11, 12, 0, 0).getTime();
  const nowFn = (): number => noon;

  it('adds up both CLIs from their real directory layouts', () => {
    const home = fakeHome();
    const stamp = new Date(noon).toISOString();
    transcript(
      home,
      '.claude/projects/x/a.jsonl',
      [
        claudeLine('msg_1', 'req_1', FULL_USAGE, stamp),
        // The same message again, one line per content block.
        claudeLine('msg_1', 'req_1', FULL_USAGE, stamp),
        claudeLine('msg_2', 'req_2', { output_tokens: 41 }, stamp)
      ],
      noon
    );
    transcript(home, '.codex/sessions/2026/09/11/b.jsonl', [codexLine(1_200, stamp)], noon);
    // Not a transcript, and not to be parsed.
    transcript(home, '.codex/sessions/2026/09/11/notes.txt', ['garbage'], noon);

    expect(createLocalTokenScanner({ home, now: nowFn }).totals()).toEqual({
      claude: FULL_TOTAL + 41,
      chatgpt: 1_200
    });
  });

  it('reports null for a CLI that is not installed, never zero', () => {
    const home = fakeHome();
    transcript(
      home,
      '.claude/projects/x/a.jsonl',
      [claudeLine('msg_1', 'req_1', { output_tokens: 10 }, new Date(noon).toISOString())],
      noon
    );

    expect(createLocalTokenScanner({ home, now: nowFn }).totals()).toEqual({
      claude: 10,
      chatgpt: null
    });
  });

  it('skips files untouched since midnight', () => {
    const home = fakeHome();
    const yesterdayNoon = noon - 86_400_000;
    transcript(
      home,
      '.claude/projects/x/old.jsonl',
      [claudeLine('msg_old', 'req_old', FULL_USAGE, new Date(yesterdayNoon).toISOString())],
      yesterdayNoon
    );

    expect(createLocalTokenScanner({ home, now: nowFn }).totals().claude).toBe(0);
  });

  /**
   * The cache proven the honest way: rewrite the file with different content
   * but the *same* mtime and size. A scanner that re-parsed would report the
   * new number; one that memoised reports the old one. Then touch the mtime and
   * watch it pick the change up, so the test also proves the cache is not
   * simply stuck.
   */
  it('does not re-parse a file whose mtime and size are unchanged', () => {
    const home = fakeHome();
    const stamp = new Date(noon).toISOString();
    const scanner = createLocalTokenScanner({ home, now: nowFn });
    const path = transcript(
      home,
      '.claude/projects/x/a.jsonl',
      [claudeLine('msg_1', 'req_1', { output_tokens: 111 }, stamp)],
      noon
    );
    expect(scanner.totals().claude).toBe(111);

    // Same length, same mtime, different number.
    writeFileSync(
      path,
      `${claudeLine('msg_1', 'req_1', { output_tokens: 999 }, stamp)}\n`,
      'utf8'
    );
    utimesSync(path, noon / 1000, noon / 1000);
    expect(scanner.totals().claude).toBe(111);

    // A newer mtime is a real change, and is read.
    const later = (noon + 60_000) / 1000;
    utimesSync(path, later, later);
    expect(scanner.totals().claude).toBe(999);
  });
});

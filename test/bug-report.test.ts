/**
 * The prefilled bug report.
 *
 * Three things here are worth a test each, and they are all things that would
 * fail silently in front of the owner:
 *
 *  - **the URL is inside the release repository.** `index.ts` refuses to open
 *    anything that is not, so a prefix that drifted would turn "Report a bug…"
 *    into a menu item that logs a warning and does nothing.
 *  - **the boxes the tracker's issue form declares are the boxes this fills
 *    in.** The form is `bug_report.yml`, drafted in `docs/release-repo/` and
 *    pushed to the other repository by hand, and it is prefilled per field. A
 *    field id that drifts on either side opens that box empty, with no error on
 *    either side — so the ids are asserted against the drafted file itself.
 *  - **nothing in the report is a percentage.** The type is the real guard (see
 *    `core/bug-report.ts`'s header) and this is the assertion that says so out
 *    loud: no usage number, no account, ever, in a public issue.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BUG_REPORT_FIELDS,
  BUG_REPORT_NEW_ISSUE_URL,
  BUG_REPORT_TEMPLATE,
  BUG_REPORT_TITLE,
  BUG_REPORT_URL_MAX,
  BUG_REPORT_URL_PREFIX,
  bugReportUrl,
  diagnosticsBlock,
  type BugReportFacts
} from '../src/core/bug-report';
import { UPDATE_REPO, UPDATE_URL_PREFIX } from '../src/core/update-check';

const FACTS: BugReportFacts = {
  version: '0.2.4',
  platform: 'darwin',
  osVersion: '26.0',
  arch: 'arm64',
  electron: '44.2.0',
  displays: [
    { width: 1728, height: 1117, scale: 2 },
    { width: 2560, height: 1440, scale: 1 }
  ],
  settings: {
    size: 'Medium',
    cardSize: 'Large',
    hideWhenIdle: false,
    sleepInFullscreen: true,
    primaryService: 'Claude'
  },
  updateState: 'up to date',
  fullscreen: false,
  logPath: '/Users/x/Library/Logs/Walder/walder.log'
};

/** The same facts with `count` displays, for the length cap. */
function withDisplays(count: number): BugReportFacts {
  return {
    ...FACTS,
    displays: Array.from({ length: count }, (_, i) => ({
      width: 3840 + i,
      height: 2160 + i,
      scale: 2
    }))
  };
}

/** The diagnostics box's prefilled value, which is where the facts now are. */
function body(url: string): string {
  const value = new URL(url).searchParams.get(BUG_REPORT_FIELDS.diagnostics);
  expect(value).not.toBeNull();
  return value as string;
}

/** The drafted issue form, read as text — the ids are all this test needs. */
const FORM = readFileSync('docs/release-repo/ISSUE_TEMPLATE/bug_report.yml', 'utf8');

describe('the URL', () => {
  it('is pinned to the release repository, the same one the updater uses', () => {
    // One repository, named once. `index.ts` guards both openers on a
    // `startsWith` of the matching prefix, so these two drifting apart is how
    // "Report a bug…" would become a no-op.
    expect(BUG_REPORT_URL_PREFIX).toBe(`https://github.com/${UPDATE_REPO}/`);
    expect(BUG_REPORT_URL_PREFIX).toBe(UPDATE_URL_PREFIX);
    expect(BUG_REPORT_NEW_ISSUE_URL).toBe(`${BUG_REPORT_URL_PREFIX}issues/new`);
    expect(bugReportUrl(FACTS).startsWith(BUG_REPORT_URL_PREFIX)).toBe(true);
  });

  it('fills the form box by box, because a form ignores `body=`', () => {
    // An issue form is prefilled per field — `?template=bug_report.yml&version=…`
    // — and drops a `body=` on the floor. So this is not a formatting choice:
    // a report that still wrote Markdown would open an EMPTY form.
    const url = new URL(bugReportUrl(FACTS));
    expect(`${url.origin}${url.pathname}`).toBe(BUG_REPORT_NEW_ISSUE_URL);
    expect(url.searchParams.get('template')).toBe(BUG_REPORT_TEMPLATE);
    expect(url.searchParams.get('title')).toBe(BUG_REPORT_TITLE);
    expect(url.searchParams.get('body')).toBeNull();

    expect(url.searchParams.get(BUG_REPORT_FIELDS.version)).toBe('0.2.4');
    expect(url.searchParams.get(BUG_REPORT_FIELDS.os)).toBe('macOS 26.0');
    expect(url.searchParams.get(BUG_REPORT_FIELDS.chip)).toBe('Apple Silicon');

    const text = body(url.href);
    expect(text).toContain('Walder 0.2.4 (arm64)');
    expect(text).toContain('```');
  });

  it('names the processor in the exact words the dropdown offers', () => {
    // The dropdown is prefilled by an option's own text: a fourth spelling
    // selects nothing, and the required box opens empty with no warning.
    const chip = (facts: BugReportFacts): string | null =>
      new URL(bugReportUrl(facts)).searchParams.get(BUG_REPORT_FIELDS.chip);
    expect(chip(FACTS)).toBe('Apple Silicon');
    expect(chip({ ...FACTS, arch: 'x64' })).toBe('Intel');
    expect(chip({ ...FACTS, platform: 'win32', arch: 'x64' })).toBe('Windows x64');
    // A platform with no option prefills nothing rather than something untrue.
    expect(chip({ ...FACTS, platform: 'linux' })).toBeNull();
  });

  it('sends only field ids the drafted form actually declares', () => {
    // The two halves live in different repositories and are pushed by hand, so
    // a rename on either side is silent: the box opens empty and nobody knows.
    expect(FORM).toContain('name: Bug report');
    for (const id of Object.values(BUG_REPORT_FIELDS)) {
      expect(FORM).toContain(`    id: ${id}\n`);
    }
    for (const option of ['Apple Silicon', 'Intel', 'Windows x64']) {
      expect(FORM).toContain(`- ${option}`);
    }
    // The three that a report cannot be diagnosed without are required.
    expect(FORM.match(/required: true/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('the diagnostics block', () => {
  it('reads as a fenced list of facts, one per line', () => {
    expect(diagnosticsBlock(FACTS).split('\n')).toEqual([
      '```',
      'Walder 0.2.4 (arm64)',
      'macOS 26.0',
      'Electron 44.2.0',
      'Displays: 1728x1117 @2x, 2560x1440 @1x',
      'Settings: size Medium, card Large, hide when idle off, sleep in fullscreen on, primary Claude',
      'Update check: up to date',
      'Fullscreen now: no',
      'Log: /Users/x/Library/Logs/Walder/walder.log',
      '```'
    ]);
  });

  it('tells "we were not looking" apart from "nothing was fullscreen"', () => {
    expect(diagnosticsBlock({ ...FACTS, fullscreen: null })).toContain('Fullscreen now: unknown');
    expect(diagnosticsBlock({ ...FACTS, fullscreen: true })).toContain('Fullscreen now: yes');
  });

  it('says so rather than printing nothing when there is no log file', () => {
    expect(diagnosticsBlock({ ...FACTS, logPath: null })).toContain('Log: none');
    expect(diagnosticsBlock({ ...FACTS, displays: [] })).toContain('Displays: none reported');
  });

  /*
   * The privacy assertion, and the reason the facts are a closed type.
   *
   * A public GitHub issue is the least private place this app can write to, and
   * the one number it must never carry is a usage percentage — the same rule
   * `main/log.ts` enforces for the log file. There is no field that could hold
   * one; this pins that no *formatting* introduces one either (a scale factor
   * rendered as a percentage, a future "83 % of the cap" line).
   */
  it('carries no percentage, and no account, whatever the facts are', () => {
    for (const facts of [FACTS, { ...FACTS, fullscreen: null }, withDisplays(6)]) {
      const block = diagnosticsBlock(facts);
      expect(block).not.toContain('%');
      expect(block).not.toMatch(/@[a-z]/i); // `@2x` yes, an email address no
    }
  });
});

describe('the length cap', () => {
  it('leaves an ordinary report exactly as written', () => {
    const url = bugReportUrl(FACTS);
    expect(url.length).toBeLessThanOrEqual(BUG_REPORT_URL_MAX);
    expect(body(url)).toContain('Displays: 1728x1117');
    expect(body(url)).toContain('Log: /Users/x/');
  });

  it('drops the displays line first when the URL would be refused', () => {
    // GitHub answers an over-long new-issue URL with 414, and an owner who
    // clicked "Report a bug…" and got a browser error has been failed twice.
    const many = withDisplays(300);
    expect(bugReportUrl({ ...many, logPath: null }).length).toBeGreaterThan(0);
    const url = bugReportUrl(many);

    expect(url.length).toBeLessThanOrEqual(BUG_REPORT_URL_MAX);
    expect(body(url)).not.toContain('Displays:');
    // The cheaper fact goes first: the log path is still there.
    expect(body(url)).toContain('Log: /Users/x/');
    // And what a report is actually diagnosed from is never dropped.
    expect(body(url)).toContain('Walder 0.2.4 (arm64)');
    expect(body(url)).toContain('Update check: up to date');
  });

  it('drops the log path second, and only then', () => {
    const huge = { ...withDisplays(300), logPath: `/Users/x/${'l'.repeat(BUG_REPORT_URL_MAX)}.log` };
    const text = body(bugReportUrl(huge));
    expect(text).not.toContain('Displays:');
    expect(text).not.toContain('Log:');
    // Still a readable block rather than a truncated one: the fence closes, and
    // the required boxes are filled whatever had to be dropped from this one.
    expect(text.split('```')).toHaveLength(3);
    const url = new URL(bugReportUrl(huge));
    expect(url.searchParams.get(BUG_REPORT_FIELDS.version)).toBe('0.2.4');
    expect(url.searchParams.get(BUG_REPORT_FIELDS.chip)).toBe('Apple Silicon');
  });
});

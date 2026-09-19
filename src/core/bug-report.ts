/**
 * "Report a bug…" — the prefilled GitHub issue, and the facts that go in it.
 *
 * ## Why a browser tab and not a form
 *
 * Walder has no backend, and the one promise the README makes about the network
 * is that nothing leaves the machine of Walder's own accord. A crash SDK
 * (Sentry, Bugsnag) breaks that on the first line of its own README; an in-app
 * report form needs a server to send to. So the report is a **URL**: this file
 * writes the issue, the browser opens it, and the owner reads every word of it
 * before pressing Submit on GitHub. Until he does, nothing has been sent
 * anywhere — which is exactly what VS Code's *Help ▸ Report Issue* does, for the
 * same reason.
 *
 * ## What cannot be in the report
 *
 * `BugReportFacts` is the whole of what this file can say, and the type is the
 * enforcement: there is **no field for an account, a login, a token, a usage
 * percentage or a bucket name**, so no edit to the caller can put one in a
 * report without first adding a field here — where it would be read in review.
 * That is the same rule `main/log.ts` applies to the log file (`redact`), stated
 * as a type rather than as a filter, because a filter can only mask a shape it
 * recognises.
 *
 * Pure and Electron-free: `main/index.ts` gathers the facts and opens the URL.
 */
import { UPDATE_REPO } from './update-check';

/**
 * Every URL the bug report may open must start with this.
 *
 * Deliberately the same pattern as `UPDATE_URL_PREFIX` — a `startsWith` on a
 * constant naming the host, the owner and the repository, checked again at the
 * point `shell.openExternal` is called. Nothing here is built from a remote
 * response, so the guard is belt and braces; it costs one line and it means the
 * rule ("Walder opens URLs inside one repository, and nowhere else") has no
 * exception to remember.
 */
export const BUG_REPORT_URL_PREFIX = `https://github.com/${UPDATE_REPO}/`;

/** The public tracker's new-issue form, which the report prefills. */
export const BUG_REPORT_NEW_ISSUE_URL = `${BUG_REPORT_URL_PREFIX}issues/new`;

/**
 * The issue form this report fills in, by file name.
 *
 * The tracker's template is a GitHub **issue form** (`bug_report.yml`, drafted
 * in `docs/release-repo/ISSUE_TEMPLATE/`) rather than the Markdown template it
 * used to be, because a form can mark the version, the OS and the chip
 * required and a Markdown template cannot — those three arrive missing often
 * enough to cost two round trips per report.
 *
 * The consequence for this file is the whole of the change: **a form ignores
 * `body=`**. Prefilling is per box, `?template=bug_report.yml&<field id>=…`, so
 * the headings that used to be written here ("## What happened", "## Steps")
 * are now the form's own labels and the code fills the boxes instead. The ids
 * below are that form's ids; renaming one on either side drops that box's
 * contents with no error anywhere.
 */
export const BUG_REPORT_TEMPLATE = 'bug_report.yml';

/** The form's field ids, which are also the query parameter names. */
export const BUG_REPORT_FIELDS = {
  version: 'version',
  os: 'os',
  chip: 'chip',
  diagnostics: 'diagnostics'
} as const;

/**
 * The title Walder proposes, with the trailing space the owner types into.
 *
 * `Bug: ` rather than a guessed summary: Walder does not know what went wrong —
 * that is the whole reason the owner is filing this — and a title that read
 * "Bug: something happened" would be worse than an empty one.
 */
export const BUG_REPORT_TITLE = 'Bug: ';

/**
 * The longest URL this file will produce.
 *
 * GitHub answers a new-issue URL that is too long with **414 URI Too Long**, and
 * an owner who clicked "Report a bug…" and got a browser error page has been
 * failed twice. The real limit is not documented and has moved; 6 000 is well
 * inside every figure ever observed for it and still leaves room for a body ten
 * times the size of the template. When the cap does bind, `bugReportUrl` drops
 * facts rather than truncating the body — a report that ends mid-sentence looks
 * like corruption.
 */
export const BUG_REPORT_URL_MAX = 6_000;

/** One display, as the report describes it. No name, no id — see the header. */
export interface DisplayFact {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

/**
 * Everything a bug report may contain. See the file header: this type *is* the
 * privacy rule, so nothing may be added to it without that being the decision.
 *
 * The three settings strings are display text the caller has already resolved
 * (`Medium`, `Large`, `ChatGPT`) rather than stored ids: the label tables live
 * in `core/card-layout.ts` and `main/tray.ts`, and a third copy here would be a
 * third thing to drift when a name changes.
 */
export interface BugReportFacts {
  readonly version: string;
  readonly platform: string;
  readonly osVersion: string;
  readonly arch: string;
  readonly electron: string;
  readonly displays: readonly DisplayFact[];
  readonly settings: {
    readonly size: string;
    readonly cardSize: string;
    readonly hideWhenIdle: boolean;
    readonly sleepInFullscreen: boolean;
    readonly primaryService: string;
  };
  /** What the last update check found, in a few words. Never a URL. */
  readonly updateState: string;
  /** `null` when the fullscreen watch is off or has not answered yet. */
  readonly fullscreen: boolean | null;
  /** `null` when no log file could be opened — every test, and a full disk. */
  readonly logPath: string | null;
}

/** Which facts a shortened report leaves out, in the order they are dropped. */
type Omission = 'displays' | 'log';

function onOff(value: boolean): string {
  return value ? 'on' : 'off';
}

/**
 * The human name of the platform, because `darwin` and `win32` are for us.
 *
 * `process.platform` is still carried: an owner reporting from a platform we
 * have no word for should not end up with a report that names no platform at
 * all.
 */
function platformName(platform: string): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform;
}

/**
 * Which processor, in the exact words the form's dropdown offers.
 *
 * A GitHub dropdown is prefilled by an option's own text, so these three
 * strings have to be the three in `bug_report.yml` and nothing else selects
 * anything. A platform/arch we have no option for prefills *nothing* rather
 * than a fourth value: the reporter then picks one, which is better than a form
 * opening with a required box holding something that is not on its own list.
 */
function chipOption(platform: string, arch: string): string | null {
  if (platform === 'darwin') return arch === 'arm64' ? 'Apple Silicon' : 'Intel';
  if (platform === 'win32') return 'Windows x64';
  return null;
}

/** `1728x1117 @2x`, which is what anyone reading a layout bug wants to know. */
function displayLine(display: DisplayFact): string {
  return `${display.width}x${display.height} @${display.scale}x`;
}

function factLines(facts: BugReportFacts, omit: readonly Omission[]): string[] {
  const lines = [
    `Walder ${facts.version} (${facts.arch})`,
    `${platformName(facts.platform)} ${facts.osVersion}`,
    `Electron ${facts.electron}`
  ];
  if (!omit.includes('displays')) {
    lines.push(
      `Displays: ${
        facts.displays.length === 0
          ? 'none reported'
          : facts.displays.map(displayLine).join(', ')
      }`
    );
  }
  lines.push(
    `Settings: size ${facts.settings.size}, card ${facts.settings.cardSize}, ` +
      `hide when idle ${onOff(facts.settings.hideWhenIdle)}, ` +
      `sleep in fullscreen ${onOff(facts.settings.sleepInFullscreen)}, ` +
      `primary ${facts.settings.primaryService}`,
    `Update check: ${facts.updateState}`,
    // `unknown` and `no` are different answers: the watch being off is not the
    // same as nothing being fullscreen, and a report that conflated them would
    // send someone hunting a fullscreen bug that never happened.
    `Fullscreen now: ${
      facts.fullscreen === null ? 'unknown' : facts.fullscreen ? 'yes' : 'no'
    }`
  );
  if (!omit.includes('log')) {
    lines.push(`Log: ${facts.logPath ?? 'none'}`);
  }
  return lines;
}

/**
 * The diagnostics, as a fenced block: one fact per line, all of it readable.
 *
 * Fenced because GitHub would otherwise reflow the lines into one paragraph, and
 * because a fence is the visual promise that this is a machine-written block the
 * owner may delete wholesale if he disagrees with any of it. Written to be read
 * *before* it is sent — which is the only reason it is one fact per line rather
 * than a JSON blob.
 *
 * It is also what `index.ts` puts on the clipboard, so a browser that dropped the
 * query string (or an owner who files the issue from another machine) still has
 * the facts to paste.
 */
export function diagnosticsBlock(facts: BugReportFacts): string {
  return fenced(facts, []);
}

function fenced(facts: BugReportFacts, omit: readonly Omission[]): string {
  return ['```', ...factLines(facts, omit), '```'].join('\n');
}

/**
 * One prefilled form: the three required boxes, and the diagnostics.
 *
 * The fences travel in the value rather than coming from a `render:` on the
 * form, so that what the form opens with and what the clipboard holds are the
 * same string — an owner whose browser dropped the query string pastes and gets
 * the identical block, not one with a second fence around it.
 *
 * `URLSearchParams` because it is the encoding GitHub reads a form prefill
 * with, newlines and all; `encodeURIComponent` by hand is the same rules
 * written out twice.
 */
function urlFor(facts: BugReportFacts, omit: readonly Omission[]): string {
  const query = new URLSearchParams({
    template: BUG_REPORT_TEMPLATE,
    title: BUG_REPORT_TITLE,
    [BUG_REPORT_FIELDS.version]: facts.version,
    [BUG_REPORT_FIELDS.os]: `${platformName(facts.platform)} ${facts.osVersion}`,
    [BUG_REPORT_FIELDS.diagnostics]: fenced(facts, omit)
  });
  const chip = chipOption(facts.platform, facts.arch);
  if (chip !== null) query.set(BUG_REPORT_FIELDS.chip, chip);
  return `${BUG_REPORT_NEW_ISSUE_URL}?${query}`;
}

/**
 * The prefilled issue URL, shortened if it has to be.
 *
 * The order the facts are dropped in is the order of how little they are
 * missed: the **displays** line first (long, and only a layout bug wants it),
 * then the **log path**, which the owner can read off `Developer ▸ Reveal log
 * file` anyway. Everything else — version, OS, Electron, settings, update state,
 * fullscreen — is what a report is diagnosed from and is never dropped. In
 * practice no real report comes close to the cap; this exists so that an
 * improbable one (a wall of displays, a very long log path) still opens a page
 * instead of a 414.
 */
export function bugReportUrl(facts: BugReportFacts): string {
  const attempts: readonly (readonly Omission[])[] = [[], ['displays'], ['displays', 'log']];
  let url = '';
  for (const omit of attempts) {
    url = urlFor(facts, omit);
    if (url.length <= BUG_REPORT_URL_MAX) break;
  }
  return url;
}

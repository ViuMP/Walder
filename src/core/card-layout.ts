/**
 * What the hover card says, at each of its three sizes.
 *
 * The card used to be one layout with the formatting rules spread across
 * `panel.ts`: which lines exist, when a status note appears, whether a bar is
 * drawn. That was fine while there was one layout. Three layouts turn every one
 * of those decisions into a branch, and the renderer is the one file in this
 * project that **cannot be unit-tested** — vitest runs under node here, with no
 * jsdom, so nothing that touches `document` is reachable from a test.
 *
 * So the decisions live here, as a pure function from a snapshot to a model, and
 * `panel.ts` becomes a painter with no conditionals of its own beyond "is this
 * field null". If you find yourself adding an `if` to the renderer, it belongs
 * in `cardRowsFor` instead: that is the whole point of this module.
 *
 * Renderer-safe on purpose — no `electron`, no node built-ins, nothing from
 * `src/main`. It is imported by the panel window (typechecked by the *web*
 * tsconfig, which cannot see node types) and by main (for the tray labels and
 * the window width), and both must see exactly the same rules.
 *
 * The three sizes, and what each is for:
 *
 *  - **Large** — the card as it has always been: a header with the age of the
 *    numbers, a source line per service saying which provider answered, status
 *    notes, and a full row per window (label, percentage, 20-segment bar, "resets
 *    in …").
 *  - **Medium** — the same numbers with the scaffolding removed. No header, no
 *    source lines; bars and resets stay, because they are the information. A
 *    status note only when something is actually wrong, and then in the
 *    service-naming form (`Claude: login needed`) — dropping the source line
 *    would otherwise leave a bare "login needed" with nothing to say *whose*.
 *  - **Small** — one line per window, `7-day (all models)   63%`, and nothing
 *    else. No bars, no resets, no "(shared pool)" marker. It is the size for
 *    somebody who already knows what the rows mean and wants the numbers.
 *
 * One rule survives every size: **never present unknown-age data as current.**
 * Large says the age in its header; Medium and Small have no header, so they
 * grow a muted footer *only* when there is something wrong with the age — the
 * snapshot is stale, or there has not been one yet. A card that is silent about
 * its age when the age is fine, and honest about it when it is not.
 */
import { formatResetsIn, type Bucket } from './buckets';
import {
  barFill,
  formatPct,
  formatRefreshedAgo,
  isStale,
  type BarTone,
  type ServiceReport,
  type UsageSnapshot
} from './usage';

/** The two services the card has sections for, in display order. */
export type CardService = 'claude' | 'chatgpt';

const SERVICES: readonly CardService[] = ['claude', 'chatgpt'];

export type CardSize = 'large' | 'medium' | 'small';

/** Menu order: biggest first, the way the owner reads the choice. */
export const CARD_SIZES: readonly CardSize[] = ['large', 'medium', 'small'];

/**
 * The card starts Large.
 *
 * It is the layout every screenshot and every line of the README describes, and
 * the only one that explains itself — a first-run owner should not have to work
 * out what `7-day Opus  63%` with no bar and no reset time is telling him.
 */
export const DEFAULT_CARD_SIZE: CardSize = 'large';

export function isCardSize(value: unknown): value is CardSize {
  return value === 'large' || value === 'medium' || value === 'small';
}

/**
 * Window width per size, in logical pixels.
 *
 * **Fixed, not measured.** The renderer could report a natural width the way it
 * reports its height, but the card would then breathe as the labels changed
 * (`7-day Opus` to `7-day (all models)` on the next poll), and a tooltip that
 * changes width under the cursor reads as a glitch. So these are chosen against
 * the longest label the parser can produce — `7-day (all models)` plus `100%` at
 * the 12 px system mono font, which is what Small is cut to fit — and the label
 * gets an ellipsis rather than the card getting wider.
 *
 * 300 is the design's own width and stays Large's. 250 is Large minus the room
 * the source lines needed; 200 is the narrowest that still fits that longest
 * label beside its percentage without truncating either.
 */
export const CARD_WIDTH: Readonly<Record<CardSize, number>> = {
  large: 300,
  medium: 250,
  small: 200
};

export function cardWidthFor(size: CardSize): number {
  return CARD_WIDTH[size];
}

/** Menu-bar names for the two services. */
export const SERVICE_LABELS: Readonly<Record<CardService, string>> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT'
};

/** The card's own section headings, which are the same names shouted. */
const SERVICE_TITLES: Readonly<Record<CardService, string>> = {
  claude: 'CLAUDE',
  chatgpt: 'CHATGPT'
};

/**
 * The one-line account status the Accounts submenu shows — and, at the two small
 * card sizes, the card's own status note.
 *
 * Each status is phrased as what the owner can *do* about it, which is the only
 * useful thing a status line can say: a login they can fix, a rate limit they
 * should ignore, an endpoint change they cannot fix but should know explains the
 * missing numbers.
 *
 * It lives in this module rather than in `main/tray.ts` (which re-exports it, so
 * the menu's import is unchanged) because the card now needs the same sentence:
 * with the source line gone, "login needed" has to name the service. Two copies
 * of that wording would be two chances for the menu and the card to disagree
 * about what is wrong, in front of an owner looking at both at once.
 */
export function accountStatusLine(service: CardService, report: ServiceReport | null): string {
  const name = SERVICE_LABELS[service];
  if (report === null) return `${name}: checking…`;
  switch (report.status) {
    case 'ok':
      return `${name}: ok via ${report.viaLabel}`;
    case 'auth-needed':
      return `${name}: login needed`;
    case 'endpoint-changed':
      return `${name}: endpoint changed`;
    case 'rate-limited':
      return `${name}: rate limited, retrying`;
    case 'error':
      return `${name}: could not be reached`;
    case 'unavailable':
    default:
      return `${name}: not logged in`;
  }
}

/**
 * What kind of thing a row is measuring.
 *
 * Every row is a `'window'` today. The other two are the shapes already decided
 * for the credit rows (`'money'` = Claude's extra-usage spend against a monthly
 * cap, `'credits'` = Codex's remaining balance), which arrive with
 * `Bucket.kind`. Carried on the model now, as a pass-through, so the painter is
 * written against the field from the start: the alternative is a second pass
 * over `panel.ts` — the untestable file — at the moment the value first becomes
 * interesting.
 */
export type CardRowKind = 'window' | 'money' | 'credits';

export interface CardRow {
  readonly kind: CardRowKind;
  /** The bucket id, so a painter could key DOM nodes by it. */
  readonly id: string;
  readonly label: string;
  /** Draw the "(shared pool)" marker? Never at Small, which has no room for it. */
  readonly shared: boolean;
  /** Already formatted: `63%`, or `?` when the provider gave no number. */
  readonly pctText: string;
  /** The 20-segment bar, or `null` at a size that draws no bars. */
  readonly bar: { readonly filled: number; readonly tone: BarTone } | null;
  /** `resets in 2h 14m`, or `null` — no line at all rather than an empty one. */
  readonly resetsText: string | null;
}

export interface CardSection {
  readonly service: CardService;
  /** `CLAUDE  ·  via Claude Code login`, or `null` at a size without source lines. */
  readonly sourceLine: string | null;
  /** A muted note about what is wrong, or what an empty section means. */
  readonly statusLine: string | null;
  readonly rows: readonly CardRow[];
}

export interface CardHeader {
  readonly title: string;
  /** `refreshed 2 min ago`, or `not checked yet` before the first poll. */
  readonly ago: string;
  /** Mark the age: the numbers are older than two poll intervals. */
  readonly stale: boolean;
}

/** The age line the small sizes grow when — and only when — the age is a problem. */
export interface CardFooter {
  readonly text: string;
  readonly stale: boolean;
}

export interface CardModel {
  readonly size: CardSize;
  readonly width: number;
  readonly header: CardHeader | null;
  readonly sections: readonly CardSection[];
  readonly footer: CardFooter | null;
}

/** `CLAUDE · via Claude Code login`, or `CLAUDE · no source` when nothing answered. */
function sourceLineFor(service: CardService, report: ServiceReport): string {
  const via = report.status === 'unavailable' ? report.viaLabel : `via ${report.viaLabel}`;
  return `${SERVICE_TITLES[service]}  ·  ${via}`;
}

/**
 * The status note at Large: the provider's own message when it has one.
 *
 * `ok` says nothing — the numbers below are the message — except in the one
 * state that would otherwise render as a heading followed by nothing: an `ok`
 * source that reported no windows at all. That looks exactly like a card that
 * failed to draw, and is the one thing a source line saying "via Claude Code
 * login" cannot explain, so it gets a line of its own.
 */
function largeStatusLine(report: ServiceReport): string | null {
  if (report.status !== 'ok') return report.message ?? report.status;
  return report.buckets.length === 0 ? 'no limits reported' : null;
}

/**
 * The status note at Medium and Small, which have no source line above it.
 *
 * Service-naming, and in the menu's own words (see `accountStatusLine`): the
 * source line was what said *whose* login is needed, so its sentence has to.
 * The provider's richer `message` is dropped rather than wrapped — these sizes
 * exist because the owner asked for less, and a two-line explanation of an
 * expired token is the opposite of that. Large still carries it.
 */
function compactStatusLine(service: CardService, report: ServiceReport): string | null {
  if (report.status !== 'ok') return accountStatusLine(service, report);
  if (report.buckets.length === 0) return `${SERVICE_LABELS[service]}: no limits reported`;
  return null;
}

function rowFor(bucket: Bucket, size: CardSize, now: number): CardRow {
  const resets = size === 'small' ? '' : formatResetsIn(bucket.resetsAt, new Date(now));
  return {
    // Pass-through today: every bucket is a usage window. See `CardRowKind`.
    kind: 'window',
    id: bucket.id,
    label: bucket.label,
    // Small drops the marker: there is no room for a footnote on a one-line row.
    // The cost is real and is called out in the README — two weekly rows can
    // then show the same percentage with nothing to say they are one pool.
    shared: size !== 'small' && bucket.derived === true,
    pctText: formatPct(bucket.pct),
    bar: size === 'small' ? null : barFill(bucket.pct),
    resetsText: resets.length > 0 ? resets : null
  };
}

function sectionFor(
  service: CardService,
  report: ServiceReport,
  size: CardSize,
  now: number
): CardSection {
  const large = size === 'large';
  return {
    service,
    sourceLine: large ? sourceLineFor(service, report) : null,
    statusLine: large ? largeStatusLine(report) : compactStatusLine(service, report),
    rows: report.buckets.map((bucket) => rowFor(bucket, size, now))
  };
}

/** A section with nothing in it must not draw its dashed rule and its padding. */
function isEmptySection(section: CardSection): boolean {
  return section.sourceLine === null && section.statusLine === null && section.rows.length === 0;
}

/**
 * The age footer for Medium and Small, or `null` when the age is unremarkable.
 *
 * Silent while the numbers are fresh, because a compact card that spends a line
 * saying "refreshed just now" is not compact. Present the moment that stops
 * being true — which is the "never present unknown-age data as current" rule,
 * kept at the sizes that have no header to keep it in.
 */
function compactFooter(snapshot: UsageSnapshot | null, now: number): CardFooter | null {
  if (snapshot === null) return { text: 'not checked yet', stale: false };
  if (!isStale(snapshot.fetchedAt, now, snapshot.intervalMs)) return null;
  return { text: formatRefreshedAgo(snapshot.fetchedAt, now), stale: true };
}

/**
 * The whole card, for this snapshot at this size.
 *
 * `now` is passed in rather than read from the clock so every "resets in" and
 * every staleness verdict in one render agrees, and so the tests can pin the
 * wording of both.
 *
 * `snapshot === null` is the pre-first-poll state, and it is deliberately not an
 * empty card: Large says "not checked yet" in its header, the small sizes say it
 * in their footer, and neither draws a section — there is nothing yet to put in
 * one, and a source line for a poll that has not happened would be an invention.
 */
export function cardRowsFor(
  snapshot: UsageSnapshot | null,
  size: CardSize,
  now: number
): CardModel {
  const width = cardWidthFor(size);
  const large = size === 'large';

  if (snapshot === null) {
    return {
      size,
      width,
      header: large ? { title: 'WALDER', ago: 'not checked yet', stale: false } : null,
      sections: [],
      footer: large ? null : compactFooter(null, now)
    };
  }

  const sections = SERVICES.map((service) =>
    sectionFor(service, snapshot.services[service], size, now)
  ).filter((section) => !isEmptySection(section));

  return {
    size,
    width,
    header: large
      ? {
          title: 'WALDER',
          ago: formatRefreshedAgo(snapshot.fetchedAt, now),
          // Marked, not hidden: stale numbers are still the best information
          // there is, and the owner needs to know how old they are — not to be
          // shown nothing.
          stale: isStale(snapshot.fetchedAt, now, snapshot.intervalMs)
        }
      : null,
    sections,
    footer: large ? null : compactFooter(snapshot, now)
  };
}

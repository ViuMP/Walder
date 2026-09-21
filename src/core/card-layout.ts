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
import {
  DEFAULT_RESET_STYLE,
  RESET_STYLES,
  formatResetsIn,
  isResetStyle,
  type Bucket,
  type ResetStyle
} from './buckets';
import {
  barFill,
  formatCreditsValue,
  formatMoneyValue,
  formatPct,
  formatTokensValue,
  formatRefreshedAgo,
  isStale,
  type BarTone,
  type CreditPrice,
  type ServiceReport,
  type UsageSnapshot
} from './usage';
import { SERVICES, SERVICE_INFO, type ServiceName } from './services';
import { SOURCE_LABEL } from './bubble';
import { shortenCwd, type SessionEntry, type SessionState } from './sessions';
import { t } from './strings';

/** The services the card has sections for, in `SERVICES` order. */
export type CardService = ServiceName;

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

/*
 * The reset-wording choice lives in `buckets.ts` (it is a property of the
 * formatter), but every consumer of it — the store, the tray, the panel — already
 * imports its card vocabulary from here. Re-exported so "the things the card menu
 * offers" stays one import, the way `SERVICE_LABELS` is re-exported by `tray.ts`.
 */
export { DEFAULT_RESET_STYLE, RESET_STYLES, isResetStyle };
export type { ResetStyle };

/**
 * Window width per size, in logical pixels.
 *
 * **Fixed, not measured.** The renderer could report a natural width the way it
 * reports its height, but the card would then breathe as the labels changed
 * (`7-day Opus` to `7-day (all models)` on the next poll), and a tooltip that
 * changes width under the cursor reads as a glitch. So these are chosen against
 * the longest label+value pair the parsers can produce, and a row that still
 * does not fit gets an ellipsis on its label rather than the card getting wider.
 *
 * **Widened 2026-09-11 (owner's decision), 300 / 250 / 200 → 380 / 370 / 250.**
 *
 * The old numbers were argued against `7-day (all models)` plus `100%`, and that
 * argument was correct right up until the value column stopped being a
 * percentage. The binding case is now the **Codex credit-limit row** —
 * `CODEX_SPEND_LIMIT_LABEL` in `buckets.ts`, label `Codex credit limit`, value
 * `Est. $109.30 / $24.00  (455%)` when a list price is configured and the owner
 * is four times over his cap. That value is 29 characters where `100%` was
 * four, and because `.value` is `flex: none` and `.label` carries the
 * `text-overflow: ellipsis`, the label absorbed every pixel of the shortfall:
 * at 300 px Large had 67 px of budget for a label needing 130, so the owner read
 * `Codex credit li…` on the one row that exists to tell him he is over a limit.
 *
 * Two cheaper fixes were tried on paper first and both were worse. *Shortening
 * the label* — `Codex cap`, `Credit limit` — buys the pixels by making the row
 * ambiguous next to `Codex credits` and `Codex 5-hour`, which is three rows
 * competing for one name. *Letting the value ellipsise instead* is strictly
 * worse than losing the label: a truncated number is a wrong number, and
 * `Est. $109.30 / $24…` reads as a real figure while being one.
 *
 * So: widen. 380 is Large, with ~17 px of slack over the estimate for a face
 * that measures wider than the 0.6 em rule of thumb assumes.
 *
 * Medium is 370, and it is deliberately *not* the proportional 310 the widening
 * was first sketched at. Medium shows the same rows as Large with only the
 * scaffolding removed, so it has to fit the same widest row; the only pixels it
 * can genuinely save are its own smaller `--pad` (10 px against 12 px) plus a
 * little air. 310 would have put it 49 px short and simply moved the ellipsis
 * from Large to Medium — a narrower card that lies is not a compact card.
 * Medium is smaller than Large because it says *less*, not because it is thinner.
 *
 * Small stays the odd one out at 250, and still truncates this row. That is the
 * size for somebody who already knows what the rows mean and wants the numbers;
 * widening it to fit would make it Medium and delete the reason it exists.
 *
 * `test/card-layout.test.ts` reconstructs this budget arithmetic from
 * `panel.html` and asserts it, since the renderer itself cannot be tested.
 */
export const CARD_WIDTH: Readonly<Record<CardSize, number>> = {
  large: 380,
  medium: 370,
  small: 250
};

export function cardWidthFor(size: CardSize): number {
  return CARD_WIDTH[size];
}

/** Menu-bar names for the two services. */
export const SERVICE_LABELS: Readonly<Record<CardService, string>> = Object.fromEntries(
  SERVICES.map((service) => [service, SERVICE_INFO[service].label])
) as Record<CardService, string>;

/** The card's own section headings, which are the same names shouted. */
const SERVICE_TITLES: Readonly<Record<CardService, string>> = Object.fromEntries(
  SERVICES.map((service) => [service, SERVICE_INFO[service].title])
) as Record<CardService, string>;

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
  if (report === null) return t('card.status.checking', { name });
  switch (report.status) {
    case 'ok':
      return t('card.status.ok', { name, via: report.viaLabel });
    case 'auth-needed':
      return t('card.status.authNeeded', { name });
    case 'endpoint-changed':
      return t('card.status.endpointChanged', { name });
    case 'rate-limited':
      return t('card.status.rateLimited', { name });
    case 'error':
      return t('card.status.error', { name });
    case 'unavailable':
    default:
      return t('card.status.unavailable', { name });
  }
}

/**
 * What kind of thing a row is measuring.
 *
 * Read straight off `Bucket.kind` (`?? 'window'`, which is what the parsers
 * leave for an ordinary usage window). `'money'` is Claude's extra-usage spend
 * against a monthly cap; `'credits'` is Codex's remaining balance. It reaches
 * the painter because the three differ in *what the value column says* —
 * `rowFor` below resolves that here, so `panel.ts` still paints `pctText`
 * without knowing which kind it holds.
 */
export type CardRowKind = 'window' | 'money' | 'credits' | 'tokens';

export interface CardRow {
  readonly kind: CardRowKind;
  /** The bucket id, so a painter could key DOM nodes by it. */
  readonly id: string;
  readonly label: string;
  /** Draw the "(shared pool)" marker? Never at Small, which has no room for it. */
  readonly shared: boolean;
  /**
   * The value column, already formatted, whatever the kind: `63%` for a
   * window (`?` when the provider gave no number), `123 / 500 kr.  (25%)` for
   * money, `1,240 left` / `unlimited` / `?` for credits. Named `pctText` for
   * the same reason `Bucket.pct` drives all three — every kind is a
   * percentage to the bar and the barks, and only this one string differs.
   */
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
  /**
   * How old *this service's* numbers are, or `null` when that is not worth
   * saying.
   *
   * The header (Large) and the footer (Medium/Small) already say how old the
   * *tick* is; this says how old this section's own numbers are, and only
   * when that is a problem — a service polled as part of the tick that
   * produced the snapshot is exactly as fresh as the header claims, so a
   * healthy section grows no line. It is what tells the owner that a ChatGPT
   * backed off to fifteen minutes is not as current as a Claude polled thirty
   * seconds ago, which the snapshot-level stamp alone cannot say. And when the
   * whole card is stale (the Mac slept), the header or footer already says so
   * once; repeating it under every section would be the same fact three times.
   */
  readonly ago: string | null;
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

/**
 * The SESSIONS block: one row per live Claude Code / Codex session.
 *
 * `null` at Medium and Small, and `null` when there are no sessions, which is
 * the same rule the rest of this module keeps — a heading with nothing under it
 * is a card that looks broken. Rows are pre-worded (`Claude · ~/…/Walder ·
 * waiting`) for the same reason every other string here is: the renderer is the
 * one file no test can read.
 */
export interface CardSessions {
  readonly title: string;
  readonly rows: readonly { readonly key: string; readonly text: string }[];
}

export interface CardModel {
  readonly size: CardSize;
  readonly width: number;
  readonly header: CardHeader | null;
  readonly sections: readonly CardSection[];
  /** The live sessions, at Large only. `null` when there is nothing to list. */
  readonly sessions: CardSessions | null;
  readonly footer: CardFooter | null;
}

/** `CLAUDE · via Claude Code login`, or `CLAUDE · no source` when nothing answered. */
function sourceLineFor(service: CardService, report: ServiceReport): string {
  const via =
    report.status === 'unavailable' ? report.viaLabel : t('card.via', { label: report.viaLabel });
  return t('card.sourceLine', { title: SERVICE_TITLES[service], via });
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
  return report.buckets.length === 0 ? t('card.noLimitsReported') : null;
}

/**
 * The status note at Medium and Small, which have no source line above it.
 *
 * Service-naming, and in the menu's own words (see `accountStatusLine`): the
 * source line was what said *whose* login is needed, so its sentence has to.
 * The provider's richer `message` is still dropped for most statuses — these
 * sizes exist because the owner asked for less, and a two-line explanation of
 * a rate limit is the opposite of that — but `auth-needed` and `unavailable`
 * are the one case where the message itself *is* the fix ("run `claude` and
 * log in"), not an elaboration of one, so it is worth the single line the
 * `.note` style already wraps onto. Large still carries the message for every
 * status.
 */
function compactStatusLine(service: CardService, report: ServiceReport): string | null {
  if (report.status === 'auth-needed' || report.status === 'unavailable') {
    return report.message ? report.message : accountStatusLine(service, report);
  }
  if (report.status !== 'ok') return accountStatusLine(service, report);
  if (report.buckets.length === 0) {
    return t('card.status.noLimitsReported', { name: SERVICE_LABELS[service] });
  }
  return null;
}

/**
 * One row, with the value column the bucket's own kind calls for.
 *
 * The three kinds differ in exactly what a reader needs, and nowhere else:
 *
 *  - **`'window'`** — a percentage, a bar, a reset. The original row.
 *  - **`'money'`** — the amounts, and the percentage when there is a cap
 *    (`9.62 / 50.00 USD  (19%)`); the bar is kept, because a spend against a
 *    cap genuinely is a percentage and draws and barks like one. Dropping it
 *    would make the one row with a hard limit on it the only row that does not
 *    show how close it is. **With no cap** (`money.limit === null`, which is
 *    the owner's own account) there is no percentage, the value reads
 *    `9.62 USD spent`, and the bar goes too — see the branch below.
 *  - **`'credits'`** — the balance, `bar: null` **and** `resetsText: null`.
 *    Both nulls are the same honesty: the provider says what is left and never
 *    what the pool held, so a bar would have to invent the missing half, and a
 *    credit pool has no reset — it is topped up when somebody pays, not on a
 *    clock. See `formatCreditsValue`.
 *
 * A `kind` the switch does not recognise falls through to the window shape,
 * which is also what `bucket.kind ?? 'window'` means for the ordinary rows the
 * parsers produce without a kind at all.
 */
function rowFor(
  bucket: Bucket,
  size: CardSize,
  now: number,
  locale: string,
  price: CreditPrice | null,
  resetStyle: ResetStyle
): CardRow {
  const kind: CardRowKind = bucket.kind ?? 'window';
  /*
   * `(est.)` marks a reset Walder worked out rather than read.
   *
   * One row wears it today — Extra usage, whose payload states a monthly cap
   * and no date at all, so the horizon is computed (`nextMonthlyResetAt`). The
   * marker is the condition on which that line is allowed to exist: without it
   * the row would be the only thing on the card that looks sourced and is not,
   * and the owner would have no way to tell. It is appended rather than woven
   * into `formatResetsIn` because that function answers "how long until this
   * timestamp", which is the same question whoever produced the timestamp —
   * where the timestamp came from is the *bucket's* property, and this is the
   * one place that knows both.
   */
  const stated =
    size === 'small'
      ? ''
      : formatResetsIn(bucket.resetsAt, new Date(now), { style: resetStyle, locale });
  const resets =
    stated.length > 0 && bucket.resetsEstimated === true
      ? t('card.estimatedSuffix', { text: stated })
      : stated;
  const base = {
    kind,
    id: bucket.id,
    label: bucket.label,
    // Small drops the marker: there is no room for a footnote on a one-line row.
    // The cost is real and is called out in the README — two weekly rows can
    // then show the same percentage with nothing to say they are one pool.
    shared: size !== 'small' && bucket.derived === true
  };

  if (kind === 'credits' && bucket.credits !== undefined) {
    return {
      ...base,
      pctText: formatCreditsValue(bucket.credits, locale),
      bar: null,
      resetsText: null
    };
  }

  if (kind === 'tokens' && bucket.tokens !== undefined) {
    // A running count with no allowance behind it: no bar, no reset line, on
    // the same principle as credits. The label says "today"; that is the
    // whole reset story.
    return {
      ...base,
      pctText: formatTokensValue(bucket.tokens, locale),
      bar: null,
      resetsText: null
    };
  }

  if (kind === 'money' && bucket.money !== undefined) {
    return {
      ...base,
      pctText: formatMoneyValue(bucket.money, bucket.pct, locale, price, size === 'large'),
      // A capless money row gets **no bar**, on the same principle as a
      // credits row: `barFill(null)` draws an empty 20-segment bar in the
      // "unknown" tone, and an empty bar beside "$9.62 spent" reads as "you
      // have used none of your allowance" when the truth is that there is no
      // allowance to have used. The bar comes back the moment the owner sets a
      // monthly limit on claude.ai, because then there is something to draw
      // against.
      bar: size === 'small' || bucket.pct === null ? null : barFill(bucket.pct),
      resetsText: resets.length > 0 ? resets : null
    };
  }

  return {
    ...base,
    pctText: formatPct(bucket.pct),
    bar: size === 'small' ? null : barFill(bucket.pct),
    resetsText: resets.length > 0 ? resets : null
  };
}

function sectionFor(
  service: CardService,
  report: ServiceReport,
  size: CardSize,
  now: number,
  locale: string,
  price: CreditPrice | null,
  intervalMs: number,
  tickStale: boolean,
  resetStyle: ResetStyle
): CardSection {
  const large = size === 'large';
  return {
    service,
    sourceLine: large ? sourceLineFor(service, report) : null,
    statusLine: large ? largeStatusLine(report) : compactStatusLine(service, report),
    rows: report.buckets.map((bucket) => rowFor(bucket, size, now, locale, price, resetStyle)),
    ago:
      !tickStale && report.fetchedAt !== undefined && isStale(report.fetchedAt, now, intervalMs)
        ? formatRefreshedAgo(report.fetchedAt, now)
        : null
  };
}

/**
 * How many characters of a session's directory the card shows.
 *
 * Same budget arithmetic as the `CARD_WIDTH` table above, applied to the one
 * row this block draws. Large is 380 px; take off the 12 px `--pad` on each
 * side and the 3 px border on each side and 350 px of text is left. The
 * sessions rows are set at the `.resets`/`.note` size of 10 px, and the 0.6 em
 * rule of thumb that table argues from makes that 6 px a glyph — so a row holds
 * about 58 characters. The fixed parts take the widest of them: `Claude` (6),
 * two ` · ` separators (6) and `waiting` (7) is 19, and 58 − 19 is 39. Rounded
 * down to 36 for the slack that table also leaves, because a system-mono face
 * can measure wider than the rule of thumb assumes and this row, unlike a
 * bucket label, has no ellipsis of its own to fall back on.
 */
export const SESSION_CWD_MAX_CHARS = 36;

/** `working` / `waiting` / `done`, in the card's own words. */
const SESSION_STATE_TEXT: Readonly<Record<SessionState, string>> = {
  working: t('card.session.working'),
  waiting: t('card.session.waiting'),
  done: t('card.session.done')
};

/** One row: `Claude · ~/…/Walder · waiting`, or without the middle when unknown. */
function sessionRow(entry: SessionEntry): { key: string; text: string } {
  const tool = SOURCE_LABEL[entry.source];
  const state = SESSION_STATE_TEXT[entry.state];
  return {
    key: entry.key,
    text:
      entry.cwd === null
        ? t('card.sessionRowNoCwd', { tool, state })
        : t('card.sessionRow', {
            tool,
            cwd: shortenCwd(entry.cwd, SESSION_CWD_MAX_CHARS),
            state
          })
  };
}

/**
 * The whole block, or `null`.
 *
 * Large only, and only with something to list — see `CardSessions`. The caller
 * has already dropped the stale entries (`liveSessions`); a layout module has
 * no business deciding what counts as live, which is a question about a clock.
 */
function sessionsFor(sessions: readonly SessionEntry[], size: CardSize): CardSessions | null {
  if (size !== 'large' || sessions.length === 0) return null;
  return { title: t('card.sessionsTitle'), rows: sessions.map(sessionRow) };
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
  if (snapshot === null) return { text: t('card.notCheckedYet'), stale: false };
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
 *
 * `locale` is a **parameter with a default, not a read of the host**, for the
 * same reason `now` is: this module must stay pure, and a function that asks
 * the environment for the locale produces a different card on a Danish machine
 * than on the CI runner, which makes every string assertion in
 * `card-layout.test.ts` a test of where it ran. `'en-GB'` is the default (the
 * repo's own spelling throughout), and `panel.ts` — which *is* the renderer and
 * *does* know the owner — passes `navigator.language`. Only money and credits
 * rows consult it; a percentage has no locale.
 *
 * `price` travels the same way and for the same reason: it is a *setting*, and
 * a pure layout module must not reach into a store to find one. It is only ever
 * read by a `MoneyDetail.inCredits` row (the Codex credit cap), and defaulting to
 * `null` means a caller that has not got one yet — every test, and the panel's
 * first provisional paint — shows the credit counts rather than a wrong price.
 *
 * `resetStyle` is a setting too, and travels the same way. It reaches the rows
 * through `sectionFor` rather than being applied to the finished model because
 * `resetsText` is already the *decorated* string (`… (est.)`), and re-parsing a
 * sentence to reword half of it is not a thing a layout module should do.
 *
 * `sessions` is the live list (`liveSessions` in `core/sessions.ts`), and
 * defaults to empty so every caller that predates the block — the tray's width
 * lookup, the snapshot suites — is unchanged and gets `sessions: null`.
 */
export function cardRowsFor(
  snapshot: UsageSnapshot | null,
  size: CardSize,
  now: number,
  locale = 'en-GB',
  price: CreditPrice | null = null,
  resetStyle: ResetStyle = DEFAULT_RESET_STYLE,
  sessions: readonly SessionEntry[] = []
): CardModel {
  const width = cardWidthFor(size);
  const large = size === 'large';
  // Outside the `snapshot === null` branch on purpose: the sessions are not
  // usage, and a machine that has not polled yet can perfectly well have three
  // terminals going. The block is the one part of the card that has something
  // to say before the first poll returns.
  const sessionsBlock = sessionsFor(sessions, size);

  if (snapshot === null) {
    return {
      size,
      width,
      header: large ? { title: t('card.title'), ago: t('card.notCheckedYet'), stale: false } : null,
      sections: [],
      sessions: sessionsBlock,
      footer: large ? null : compactFooter(null, now)
    };
  }

  /*
   * A service the owner has unticked is gone from the card, heading and all.
   *
   * Hide Claude and the section used to stay behind as `CLAUDE · via Claude
   * Code login` over `no limits reported` — a heading, a source line and a
   * note, all to say nothing, and the note actively misleading: the login is
   * fine and the limits were reported, the owner simply asked not to see them.
   * A service that genuinely reported no rows is a different fact and keeps
   * that line; `hiddenServices` is the only thing that can tell the two apart
   * by the time the payload gets here (see `forIpc`).
   */
  const emptied = new Set(snapshot.hiddenServices ?? []);
  const tickStale = isStale(snapshot.fetchedAt, now, snapshot.intervalMs);
  /*
   * A service with no login is not on the card at all (Victor, 2026-09-20,
   * looking at four sections of which two said "not logged in"). The card is
   * where the numbers are; the Accounts submenu is where a login is offered,
   * and a heading over nothing would only say what the menu already says.
   * `unavailable` is exactly "no provider could even be asked" — a login that
   * exists and fails (`auth-needed`, `error`) still shows, with its remedy.
   */
  const sections = SERVICES.filter(
    (service) => !emptied.has(service) && snapshot.services[service].status !== 'unavailable'
  ).map((service) =>
    sectionFor(
      service,
      snapshot.services[service],
      size,
      now,
      locale,
      price,
      snapshot.intervalMs,
      tickStale,
      resetStyle
    )
  );

  return {
    size,
    width,
    header: large
      ? {
          title: t('card.title'),
          ago: formatRefreshedAgo(snapshot.fetchedAt, now),
          // Marked, not hidden: stale numbers are still the best information
          // there is, and the owner needs to know how old they are — not to be
          // shown nothing.
          stale: tickStale
        }
      : null,
    sections,
    sessions: sessionsBlock,
    footer: large ? null : compactFooter(snapshot, now)
  };
}

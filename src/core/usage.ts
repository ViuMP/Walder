/**
 * The usage snapshot: what one poll produced, as the overlay and the hover panel
 * see it.
 *
 * Pure and dependency-free, because it is the single shape shared by the main
 * process (which builds it), the settings store (which persists a trimmed copy)
 * and both renderers (which draw it). Keeping it here rather than in
 * `main/poller.ts` is what lets the panel renderer — typechecked by the *web*
 * tsconfig, which cannot see node types — import the type it renders.
 */
import type { Bucket, BucketKind, CreditsDetail, MoneyDetail, SourceStatus, TokensDetail } from './buckets';
import { expressionFor, type Expression } from './expression';

/**
 * One service's answer. A `ProviderResult` plus the human label of the provider
 * that produced it, so the panel can print "CLAUDE · via Claude Code login"
 * without knowing anything about the provider registry.
 */
export interface ServiceReport {
  readonly buckets: Bucket[];
  readonly status: SourceStatus;
  readonly message?: string;
  /** Provider id, e.g. `claude-oauth`. */
  readonly via: string;
  /** Provider label, e.g. `Claude Code login`. */
  readonly viaLabel: string;
}

export interface UsageSnapshot {
  /** ISO 8601, when the poll completed. */
  readonly fetchedAt: string;
  readonly services: Readonly<Record<'claude' | 'chatgpt', ServiceReport>>;
  /** Both services' buckets, merged into display order. */
  readonly buckets: Bucket[];
  /** Walder's face for this snapshot, decided in main (see `pctForFace`). */
  readonly expression: Expression;
  /** The poll interval in force, so the panel can tell how stale this is. */
  readonly intervalMs: number;
}

/**
 * The percentage Walder's face should reflect: **Claude's 5-hour window, and
 * nothing else.**
 *
 * That window is the allowance that actually runs out mid-afternoon, and it is
 * the one the expression thresholds in `expressionFor` were chosen against. No
 * other window means the same thing at the same number: a 7-day allowance at
 * 85 % on a Tuesday is fine, and Codex's own windows are a different service on
 * a different clock and a different scale.
 *
 * So there is deliberately **no fallback to the highest percentage we know**.
 * That fallback existed to keep a ChatGPT-only setup from a permanently
 * confused dog, and the cost was much worse than the benefit: the dog's face —
 * the whole product, and the only thing visible without hovering — silently
 * started describing a *different* allowance than the one it appears to
 * describe. An exhausted-looking dog because Codex's weekly quota is at 91 %,
 * while Claude's 5-hour window sits at 12 %, is not a degraded reading; it is a
 * wrong one, and nothing on screen says which allowance is meant.
 *
 * Absent, or present with no number, therefore gives `null`, which
 * `expressionFor` turns into the confused face — an honest "I don't know",
 * with the real numbers one hover away in the panel (which shows every bucket
 * from every service, and is where a ChatGPT-only owner reads their usage).
 */
export function pctForFace(buckets: readonly Bucket[]): number | null {
  const fiveHour = buckets.find(
    (b) =>
      b.service === 'claude' &&
      // Windows only. A money or credits row is a percentage of a *bill*, not
      // of an allowance that runs out this afternoon, and the face's whole
      // contract is that it describes the 5-hour window. Belt and braces
      // today — no non-window row is keyed `five_hour` — but the row that
      // would break this is exactly the kind nobody would think to check.
      isWindowKind(b.kind) &&
      b.key.includes('five_hour') &&
      b.pct !== null
  );
  if (fiveHour?.pct == null || !Number.isFinite(fiveHour.pct)) return null;
  return fiveHour.pct;
}

/** Absent means `'window'`, everywhere. */
export function isWindowKind(kind: BucketKind | undefined): boolean {
  return kind === undefined || kind === 'window';
}

/** The face for a set of buckets. */
export function expressionForBuckets(buckets: readonly Bucket[]): Expression {
  return expressionFor(pctForFace(buckets));
}

/**
 * Is this snapshot old enough that the panel should say so?
 *
 * Two intervals: one missed poll is normal (a laptop that slept, a backoff after
 * a 429), two means the numbers on screen are no longer describing now. An
 * unparseable `fetchedAt` counts as stale — the only other option is to present
 * unknown-age data as current.
 */
export function isStale(fetchedAt: string, now: number, intervalMs: number): boolean {
  const at = Date.parse(fetchedAt);
  if (!Number.isFinite(at)) return true;
  return now - at > 2 * intervalMs;
}

/* ------------------------------------------------------------ panel display */

/** Segments in the panel's pixel bar, from the design. */
export const BAR_SEGMENTS = 20;

export type BarTone = 'low' | 'mid' | 'high' | 'unknown';

/**
 * How many of the 20 segments to fill, and in which colour band.
 *
 * `Math.round` rather than `floor`: the design's own numbers imply it (24 % is
 * drawn as 5 of 20, not 4), and rounding keeps a nearly-full window from
 * showing a gap. Deliberately *not* clamped to "at least one segment" — 0 %
 * should look empty.
 *
 * Bands follow the design's caption exactly: green under 50, amber from 50 up
 * to and including 80, red above 80.
 */
export function barFill(pct: number | null): { filled: number; tone: BarTone } {
  if (pct === null || !Number.isFinite(pct)) return { filled: 0, tone: 'unknown' };
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.min(BAR_SEGMENTS, Math.max(0, Math.round((clamped / 100) * BAR_SEGMENTS)));
  const tone: BarTone = clamped < 50 ? 'low' : clamped <= 80 ? 'mid' : 'high';
  return { filled, tone };
}

/**
 * The percentage as the panel prints it. `?` for unknown — never `0%`, which
 * would read as "plenty left" when the truth is "we could not find out".
 */
export function formatPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '?';
  return `${Math.round(pct)}%`;
}

/**
 * What one unit of a `MoneyDetail.unit` row costs, in a real currency.
 *
 * A setting rather than a constant because there is no single right answer:
 * OpenAI lists Codex credits at USD 40 per 1,000 (0.04 USD each) and publishes
 * no EUR price at all, while the owner is billed in EUR. So the number *and*
 * the currency are the owner's to state, Walder only multiplies — and prints
 * the result with a `≈`, because a list price is an estimate of a bill and not
 * the bill. `null` means "do not guess": the row then shows the counts the
 * provider actually stated.
 */
export interface CreditPrice {
  /** Price of one unit, in major units of `currency`. Finite, > 0. */
  readonly amount: number;
  /** ISO 4217, upper case. */
  readonly currency: string;
}

/**
 * Is this a usable credit price?
 *
 * Lives here, next to the type, because both sides of the IPC need exactly this
 * check and neither should be the one that owns it: main validates what it read
 * off a hand-editable settings file, and the renderer validates what arrived
 * over IPC (main is not an attacker, but a wrong number here is printed on the
 * card as if it were a bill).
 *
 * `amount > 0`: a `0` would print `≈ $0.00 / $0.00` beside a 455% bar. Three
 * letters: anything else makes `Intl.NumberFormat` throw.
 */
export function isCreditPrice(value: unknown): value is CreditPrice {
  if (typeof value !== 'object' || value === null) return false;
  const { amount, currency } = value as Partial<CreditPrice>;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return false;
  return typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency);
}

/**
 * The value column of a money row: `9.62 / 50.00 USD  (19%)`, or
 * `9.62 USD spent` when the account has no cap.
 *
 * Four decisions worth stating, because a card row is two seconds of reading
 * and every one of them costs or saves a misunderstanding:
 *
 *  - **Amounts first, percentage second.** A spend cap is money; "19 %" alone
 *    does not tell the owner whether he has spent 9 kr. or 90. The percentage
 *    is kept because it is what the bar beside it draws and what the barks
 *    quote, so the two must visibly agree.
 *  - **`Intl.NumberFormat` in the currency style**, which is what puts `kr.`
 *    after a Danish amount and `$` before an American one, in the owner's own
 *    locale. `undefined` as the locale means the host's — a test that asserts
 *    a string must pass one explicitly, because otherwise it asserts the
 *    machine it ran on.
 *  - **The two halves agree on precision, and the currency decides what it
 *    is.** This used to print whole units for a round number, on the grounds
 *    that a cap is always round — which produced `9.62 / 50` once the real
 *    amounts arrived, two different precisions in one row, reading like a bug.
 *    The confirmed payload states the scale itself (`decimal_places: 2`), so
 *    both halves now use the currency's own fraction digits: two for USD and
 *    DKK, **none** for JPY, taken from `resolvedOptions()` rather than
 *    hardcoded so `¥962.00` cannot happen either.
 *  - **The cap carries the symbol and the spend does not.** `9.62 kr. /
 *    50.00 kr.` says the same thing twice; that is how a price range reads.
 *    With no cap there is nothing to pair, so the single amount carries the
 *    symbol and the word **"spent"** does the work the missing denominator
 *    used to: a bare `$9.62` beside rows that are all percentages reads as an
 *    allowance, which is the opposite of what it is.
 *
 * A **unit row** (`MoneyDetail.unit`, today only the Codex credit cap) is the
 * same row with the two numbers counted in something that is not money, and it
 * takes the last two decisions differently on purpose:
 *  - With a `price`, it prints `≈ $109.30 / $24.00  (455%)`. The `≈` is load
 *    bearing — this is a published list price applied to a credit count, not
 *    the invoice — and **both** halves carry the symbol, because the left one
 *    is a converted number and a bare `109.30` beside `$24.00` would read as
 *    the credits themselves.
 *  - With no price, it prints the counts the provider stated, whole, with the
 *    unit word after them: `2,733 / 600 credits  (455%)`. Fractions of a
 *    credit are noise on a hover card, and the word does the same job "spent"
 *    does above — a bare pair of numbers beside rows of percentages says
 *    nothing about what it counts.
 *
 * Callers comparing this against a literal must be NBSP-tolerant: ICU puts a
 * non-breaking or narrow no-break space between number and symbol in most
 * locales, and normalising it away here would break the very rendering the
 * formatter exists to get right.
 */
export function formatMoneyValue(
  money: MoneyDetail,
  pct: number | null,
  locale?: string,
  price?: CreditPrice | null
): string {
  // A unit row is only converted when a price says how; a real money row is
  // already in its own currency and is never scaled.
  const priced = money.unit !== undefined && price != null;
  // An unknown currency code makes `Intl` throw rather than degrade, so the
  // formatter is built once and its absence is the fallback signal: the number
  // is still the useful half, and it is printed without a symbol.
  let currency: Intl.NumberFormat | null = null;
  try {
    currency = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: priced ? (price as CreditPrice).currency : money.currency
    });
  } catch {
    currency = null;
  }
  // Counts of a unit are whole; amounts of money take their currency's scale.
  const digits =
    money.unit !== undefined && !priced ? 0 : (currency?.resolvedOptions().maximumFractionDigits ?? 2);
  const plain = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
  const scale = priced ? (price as CreditPrice).amount : 1;
  const amount = (value: number, withCurrency: boolean): string =>
    withCurrency && currency !== null
      ? currency.format(value * scale)
      : plain.format(value * scale);
  const withPct = (shown: string): string =>
    pct === null || !Number.isFinite(pct) ? shown : `${shown}  (${formatPct(pct)})`;

  if (money.unit !== undefined) {
    const prefix = priced ? '≈ ' : '';
    const suffix = priced ? '' : ` ${money.unit}`;
    const spent = amount(money.spent, priced);
    // No cap: same reasoning as the money row below — the word carries it.
    if (money.limit === null) return `${prefix}${spent}${suffix} spent`;
    return withPct(`${prefix}${spent} / ${amount(money.limit, priced)}${suffix}`);
  }

  // No cap: no fraction, no percentage, nothing to be close to.
  if (money.limit === null) return `${amount(money.spent, true)} spent`;

  return withPct(`${amount(money.spent, false)} / ${amount(money.limit, true)}`);
}

/**
 * The value column of a credits row: `1,240 left`, `unlimited`, or `?`.
 *
 * No bar accompanies it and none should: the endpoint reports what is left and
 * never what the pool held, so there is no percentage to be honest about. The
 * word "left" is doing real work — a bare `1,240` beside rows that are all
 * percentages reads as an amount *used*, which is the opposite of the truth.
 *
 * `?` for a pool the account has but whose size is not stated (the owner's own
 * account answers exactly that today), on the same principle as `formatPct`:
 * never `0`, which would read as "spent" when the truth is "not told".
 */
export function formatCreditsValue(credits: CreditsDetail, locale?: string): string {
  if (credits.unlimited) return 'unlimited';
  if (credits.balance === null || !Number.isFinite(credits.balance)) return '?';
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(credits.balance)} left`;
}

/**
 * `1.2M tokens` / `845k tokens` / `312 tokens`. One decimal above a thousand
 * so 1,240,000 and 1,290,000 do not both read as "1M"; the exact count is a
 * transcript grep away and has no business on a hover card.
 */
export function formatTokensValue(tokens: TokensDetail, locale?: string): string {
  const n = tokens.total;
  if (!Number.isFinite(n) || n < 0) return '?';
  const fmt = (v: number): string =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(v);
  if (n >= 1_000_000) return `${fmt(n / 1_000_000)}M tokens`;
  if (n >= 1_000) return `${fmt(n / 1_000)}k tokens`;
  return `${fmt(n)} tokens`;
}

/* ------------------------------------------------------------- persistence */

/**
 * The snapshot as it is written to the settings file, so the dog has a face the
 * instant he appears instead of a confused one for the first three minutes.
 *
 * Trimmed on purpose. `Bucket.raw` holds the provider's original payload — which
 * on the ChatGPT session route can include account metadata — and the settings
 * file is plain, unencrypted JSON in the user's library folder. Only what the
 * panel actually draws is persisted: label, percentage, reset time, and each
 * service's status line. Per-service bucket lists are not stored either; they
 * are rebuilt by filtering the merged list, which cannot drift from it.
 */
export interface PersistedBucket {
  readonly id: string;
  readonly service: 'claude' | 'chatgpt';
  readonly key: string;
  readonly label: string;
  readonly pct: number | null;
  readonly resetsAt: string | null;
  readonly priority: number;
  /**
   * Carried through, because both sides of the wire need it: the panel marks a
   * derived row "(shared pool)", and the bark filter in `core/behaviour.ts`
   * keeps derived rows out of the `NudgeMachine`. Dropping it here would make a
   * *restored* snapshot bark about a row a live one deliberately stays quiet
   * about — the kind of difference nobody would think to look for.
   */
  readonly derived?: boolean;
  /**
   * The three kind-carried fields, persisted for the same reason `derived` is:
   * a restored snapshot must draw and bark exactly as the live one it replaced.
   *
   * Without `kind` and its detail object, a restored Extra usage row would come
   * back as an ordinary window — same percentage, same bar, but its value
   * column silently reverting from "123 / 500 kr." to "25%" until the first
   * poll landed; and a restored Codex credits row, which has `pct: null`,
   * would come back as a window with no number at all. Both are the kind of
   * three-minutes-after-launch difference nobody would think to look for.
   */
  readonly kind?: BucketKind;
  readonly money?: MoneyDetail;
  readonly credits?: CreditsDetail;
  readonly tokens?: TokensDetail;
}

export interface PersistedServiceReport {
  readonly status: SourceStatus;
  readonly message?: string;
  readonly via: string;
  readonly viaLabel: string;
}

export interface PersistedSnapshot {
  readonly fetchedAt: string;
  readonly intervalMs: number;
  readonly buckets: PersistedBucket[];
  readonly services: Readonly<Record<'claude' | 'chatgpt', PersistedServiceReport>>;
}

const SERVICES: readonly ('claude' | 'chatgpt')[] = ['claude', 'chatgpt'];

const STATUSES: readonly SourceStatus[] = [
  'ok',
  'auth-needed',
  'endpoint-changed',
  'rate-limited',
  'error',
  'unavailable'
];

const KINDS: readonly BucketKind[] = ['window', 'money', 'credits', 'tokens'];

function trimBucket(bucket: Bucket): PersistedBucket {
  return {
    id: bucket.id,
    service: bucket.service,
    key: bucket.key,
    label: bucket.label,
    pct: bucket.pct,
    resetsAt: bucket.resetsAt,
    priority: bucket.priority,
    // Only when true, so an ordinary bucket's persisted shape is unchanged.
    ...(bucket.derived === true ? { derived: true } : {}),
    // Likewise: a plain window persists exactly as it always did, with no
    // `kind` key at all. Each detail object is re-built field by field rather
    // than spread, so a provider that one day hangs something extra off it
    // cannot smuggle that onto disk the way `raw` would.
    ...(bucket.kind === undefined || bucket.kind === 'window' ? {} : { kind: bucket.kind }),
    ...(bucket.money === undefined
      ? {}
      : {
          money: {
            spent: bucket.money.spent,
            limit: bucket.money.limit,
            currency: bucket.money.currency,
            // Only when true, like `derived` above — and it has to be here at
            // all because a restored row that forgot the flag would re-arm the
            // "limit reached" bark and say it again on the first poll after
            // every launch, about something the owner was told days ago.
            ...(bucket.money.limitReached === true ? { limitReached: true } : {}),
            // Likewise absent on an ordinary money row. Without it a restored
            // Codex credit row would come back claiming its 2,733 credits are
            // 2,733 XXX — the one field that says what the numbers count.
            ...(bucket.money.unit === undefined ? {} : { unit: bucket.money.unit })
          }
        }),
    ...(bucket.credits === undefined
      ? {}
      : {
          credits: {
            balance: bucket.credits.balance,
            unlimited: bucket.credits.unlimited,
            exhausted: bucket.credits.exhausted,
            ...(bucket.credits.approxCloudMessages === undefined
              ? {}
              : { approxCloudMessages: bucket.credits.approxCloudMessages })
          }
        }),
    ...(bucket.tokens === undefined ? {} : { tokens: { total: bucket.tokens.total } })
  };
}

function trimReport(report: ServiceReport): PersistedServiceReport {
  const base = { status: report.status, via: report.via, viaLabel: report.viaLabel };
  return report.message === undefined ? base : { ...base, message: report.message };
}

/** Strip a snapshot down to what may be written to disk. */
export function trimSnapshot(snapshot: UsageSnapshot): PersistedSnapshot {
  return {
    fetchedAt: snapshot.fetchedAt,
    intervalMs: snapshot.intervalMs,
    buckets: snapshot.buckets.map(trimBucket),
    services: {
      claude: trimReport(snapshot.services.claude),
      chatgpt: trimReport(snapshot.services.chatgpt)
    }
  };
}

/**
 * The snapshot as it may cross IPC: the same trim the settings file gets.
 *
 * `Bucket.raw` is the provider's original payload — on the ChatGPT session
 * route that can include account metadata, and on any route it is unvalidated
 * remote JSON. Neither renderer reads it (the panel draws label, percentage and
 * reset time; the overlay reads only `expression`), so it has no business being
 * structured-cloned into a window. Built on `trimSnapshot` rather than beside
 * it, so "what may leave the main process" is defined exactly once and the disk
 * copy and the IPC copy cannot drift apart.
 *
 * Everything the renderers *do* need survives, including `expression` — carried
 * over rather than recomputed, so main's face and the panel's numbers always
 * describe the same poll.
 */
export function forIpc(snapshot: UsageSnapshot): UsageSnapshot {
  const trimmed = trimSnapshot(snapshot);
  const buckets: Bucket[] = trimmed.buckets.map((bucket) => ({ ...bucket }));
  const forService = (service: 'claude' | 'chatgpt'): ServiceReport => ({
    ...trimmed.services[service],
    buckets: buckets.filter((bucket) => bucket.service === service)
  });
  return {
    fetchedAt: snapshot.fetchedAt,
    intervalMs: snapshot.intervalMs,
    expression: snapshot.expression,
    buckets,
    services: { claude: forService('claude'), chatgpt: forService('chatgpt') }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A persisted money block, or `undefined` if it is not one.
 *
 * The settings file is plain JSON in the owner's library folder and is
 * hand-editable, so every field is checked rather than trusted: a `limit` of
 * 0 or a negative `spent` would make `pct` infinite or negative and the bar
 * nonsense, and a currency that is not three letters makes `Intl` throw. An
 * **absent** `limit` is the exception and not a failure — see below. A
 * block that fails any of it is dropped and the row degrades to an ordinary
 * one — the row still appears, with its stored percentage; only the amounts
 * are lost, until the next poll. Never a crash on launch over a stale file.
 */
function readMoney(raw: unknown): MoneyDetail | undefined {
  if (!isRecord(raw)) return undefined;
  const { spent, limit, currency } = raw;
  if (typeof spent !== 'number' || !Number.isFinite(spent) || spent < 0) return undefined;
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) return undefined;
  // A missing or `null` cap is the *normal* state — the owner's own account has
  // extra usage on with `monthly_limit: null` — so it restores as `null` and
  // the row comes back capless, exactly as it was persisted. A cap that is
  // *present* still has to be a usable divisor: a hand-edited `0` would make
  // `pct` infinite and the bar nonsense, and dropping the whole block is
  // better than restoring a row that draws wrongly.
  if (limit !== null && limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return undefined;
  }
  return {
    spent,
    limit: typeof limit === 'number' ? limit : null,
    currency: currency.toUpperCase(),
    // Literal `true` only, like `CreditsDetail.exhausted`: a truthy string in a
    // hand-edited file must not fire the "limit reached" bark.
    ...(raw['limitReached'] === true ? { limitReached: true } : {}),
    // A non-empty string only — this one is printed straight onto the card, and
    // the file is hand-editable. Anything else restores as an ordinary money
    // row in `currency`, which is the conservative half of the mistake.
    ...(typeof raw['unit'] === 'string' && raw['unit'].trim().length > 0
      ? { unit: raw['unit'].trim() }
      : {})
  };
}

/** A persisted credits block, or `undefined`. Same rules, same reason. */
function readCredits(raw: unknown): CreditsDetail | undefined {
  if (!isRecord(raw)) return undefined;
  const { balance, unlimited, exhausted, approxCloudMessages } = raw;
  // `balance` is legitimately `null` (a pool whose size is not stated), so
  // "absent or unreadable" and "stated as unknown" both land on `null`.
  const known = typeof balance === 'number' && Number.isFinite(balance) ? balance : null;
  const approx =
    typeof approxCloudMessages === 'number' && Number.isFinite(approxCloudMessages)
      ? approxCloudMessages
      : undefined;
  return {
    balance: known,
    // Literal booleans only: a truthy string must not silence the
    // credits-exhausted bark, nor claim an unlimited pool.
    unlimited: unlimited === true,
    exhausted: exhausted === true,
    ...(approx === undefined ? {} : { approxCloudMessages: approx })
  };
}

/** A persisted tokens block, or `undefined`: a finite non-negative `total` only. */
function readTokens(raw: unknown): TokensDetail | undefined {
  if (!isRecord(raw)) return undefined;
  const total = raw['total'];
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return undefined;
  return { total };
}

function readBucket(raw: unknown): PersistedBucket | null {
  if (!isRecord(raw)) return null;
  const { id, service, key, label, pct, resetsAt, priority, derived } = raw;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (service !== 'claude' && service !== 'chatgpt') return null;
  if (typeof key !== 'string' || typeof label !== 'string') return null;
  const numericPct = typeof pct === 'number' && Number.isFinite(pct) ? pct : null;
  const iso = typeof resetsAt === 'string' && resetsAt.length > 0 ? resetsAt : null;
  const order = typeof priority === 'number' && Number.isFinite(priority) ? priority : 9;
  const kind = KINDS.includes(raw['kind'] as BucketKind)
    ? (raw['kind'] as BucketKind)
    : undefined;
  const money = readMoney(raw['money']);
  const credits = readCredits(raw['credits']);
  const tokens = readTokens(raw['tokens']);
  return {
    id,
    service,
    key,
    label,
    pct: numericPct,
    resetsAt: iso,
    priority: order,
    // Anything but a literal `true` is "not derived": the file is user-writable,
    // and a truthy string must not turn an ordinary window into a silent one.
    ...(derived === true ? { derived: true } : {}),
    // A `kind` whose detail block did not survive validation is downgraded to
    // an ordinary window rather than kept: a `'money'` row with no amounts
    // would send the card looking for a `money` object that is not there.
    ...(kind === 'money' && money !== undefined ? { kind, money } : {}),
    ...(kind === 'credits' && credits !== undefined ? { kind, credits } : {}),
    ...(kind === 'tokens' && tokens !== undefined ? { kind, tokens } : {})
  };
}

function readReport(raw: unknown): PersistedServiceReport {
  const unknownReport: PersistedServiceReport = {
    status: 'unavailable',
    via: 'none',
    viaLabel: 'no source'
  };
  if (!isRecord(raw)) return unknownReport;
  const status = STATUSES.includes(raw['status'] as SourceStatus)
    ? (raw['status'] as SourceStatus)
    : 'unavailable';
  const via = typeof raw['via'] === 'string' ? raw['via'] : 'none';
  const viaLabel = typeof raw['viaLabel'] === 'string' ? raw['viaLabel'] : via;
  const message = typeof raw['message'] === 'string' ? raw['message'] : undefined;
  const base = { status, via, viaLabel };
  return message === undefined ? base : { ...base, message };
}

/**
 * Rebuild a snapshot from the settings file.
 *
 * Tolerant by design: the file is user-writable, and a hand-mangled entry must
 * cost the owner a stale face for one poll, never a crash on launch. Anything
 * unreadable — no `fetchedAt`, an unparseable date — yields `null`, and the
 * caller simply starts with no snapshot. Individual malformed buckets are
 * dropped rather than failing the whole restore.
 */
export function restoreSnapshot(raw: unknown, fallbackIntervalMs: number): UsageSnapshot | null {
  if (!isRecord(raw)) return null;
  const fetchedAt = raw['fetchedAt'];
  if (typeof fetchedAt !== 'string' || !Number.isFinite(Date.parse(fetchedAt))) return null;

  const rawBuckets = Array.isArray(raw['buckets']) ? raw['buckets'] : [];
  const buckets = rawBuckets
    .map(readBucket)
    .filter((b): b is PersistedBucket => b !== null)
    .map((b) => ({ ...b }) as Bucket);

  const rawServices = isRecord(raw['services']) ? raw['services'] : {};
  const services = {} as Record<'claude' | 'chatgpt', ServiceReport>;
  for (const service of SERVICES) {
    const report = readReport(rawServices[service]);
    services[service] = { ...report, buckets: buckets.filter((b) => b.service === service) };
  }

  const rawInterval = raw['intervalMs'];
  const intervalMs =
    typeof rawInterval === 'number' && Number.isFinite(rawInterval) && rawInterval > 0
      ? rawInterval
      : fallbackIntervalMs;

  return {
    fetchedAt,
    services,
    buckets,
    expression: expressionForBuckets(buckets),
    intervalMs
  };
}

/* --------------------------------------------------------------- developer */

/**
 * A synthetic snapshot for `Developer ▸ Inject usage`.
 *
 * Deliberately shaped as a real Claude 5-hour bucket rather than as a shortcut
 * that sets `expression` directly: the injected snapshot then travels the *same*
 * path as a real poll — face, hover panel, tray status line and the bark
 * thresholds all derive from it exactly as they would from Anthropic's answer.
 * A test path that bypasses the machinery it is meant to exercise proves
 * nothing.
 *
 * `pct === null` is the "no data" case: an `ok` source that reported no windows,
 * which is what makes the dog confused rather than cheerful.
 */
export function injectedSnapshot(pct: number | null, now: number, intervalMs: number): UsageSnapshot {
  const buckets: Bucket[] =
    pct === null
      ? []
      : [
          {
            id: 'claude.five_hour',
            service: 'claude',
            key: 'five_hour',
            label: '5-hour',
            pct,
            resetsAt: new Date(now + 5 * 60 * 60 * 1000).toISOString(),
            priority: 0
          }
        ];

  const report: ServiceReport = {
    buckets,
    status: 'ok',
    message: 'injected (developer menu)',
    via: 'injected',
    viaLabel: 'injected'
  };
  const empty: ServiceReport = {
    buckets: [],
    status: 'unavailable',
    message: 'not checked yet',
    via: 'none',
    viaLabel: 'no source'
  };

  return {
    fetchedAt: new Date(now).toISOString(),
    services: { claude: report, chatgpt: empty },
    buckets,
    expression: expressionForBuckets(buckets),
    intervalMs
  };
}

/** "refreshed 2 min ago" / "refreshed just now" for the panel footer. */
export function formatRefreshedAgo(fetchedAt: string, now: number): string {
  const at = Date.parse(fetchedAt);
  if (!Number.isFinite(at)) return 'never refreshed';
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'refreshed just now';
  if (minutes === 1) return 'refreshed 1 min ago';
  if (minutes < 60) return `refreshed ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? 'refreshed 1 hour ago' : `refreshed ${hours} hours ago`;
}

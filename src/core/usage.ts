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
import type { Bucket, SourceStatus } from './buckets';
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
    (b) => b.service === 'claude' && b.key.includes('five_hour') && b.pct !== null
  );
  if (fiveHour?.pct == null || !Number.isFinite(fiveHour.pct)) return null;
  return fiveHour.pct;
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

function trimBucket(bucket: Bucket): PersistedBucket {
  return {
    id: bucket.id,
    service: bucket.service,
    key: bucket.key,
    label: bucket.label,
    pct: bucket.pct,
    resetsAt: bucket.resetsAt,
    priority: bucket.priority
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

function readBucket(raw: unknown): PersistedBucket | null {
  if (!isRecord(raw)) return null;
  const { id, service, key, label, pct, resetsAt, priority } = raw;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (service !== 'claude' && service !== 'chatgpt') return null;
  if (typeof key !== 'string' || typeof label !== 'string') return null;
  const numericPct = typeof pct === 'number' && Number.isFinite(pct) ? pct : null;
  const iso = typeof resetsAt === 'string' && resetsAt.length > 0 ? resetsAt : null;
  const order = typeof priority === 'number' && Number.isFinite(priority) ? priority : 9;
  return { id, service, key, label, pct: numericPct, resetsAt: iso, priority: order };
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

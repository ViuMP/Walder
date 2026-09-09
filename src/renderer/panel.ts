/**
 * Walder — hover-panel renderer.
 *
 * Draws the usage card and reports its height back so main can size the window
 * around it. Everything else about the panel — when to show it, where to put it,
 * how big to make the window — is main's job; this file only turns a
 * `UsageSnapshot` into the card in `design/HoverPanel.dc.html`.
 *
 * Three rules it follows:
 *
 *  - **`textContent`, never `innerHTML`.** Every string on this card comes from
 *    a provider's JSON: bucket labels, and the `message` on a failed source. The
 *    CSP would stop an injected `<script>` from running, but building DOM by
 *    hand means there is nothing to stop in the first place.
 *  - **Never invent a number.** An unknown percentage prints `?` with a grey bar
 *    rather than `0%`; a snapshot older than two poll intervals says so in the
 *    footer. A mascot that confidently shows a wrong allowance is worse than one
 *    that admits it does not know.
 *  - **Say which source answered**, per service, and say what is wrong when one
 *    is not `ok`. That line is what sends the owner to Accounts ▸ Log in.
 *
 * The formatting rules themselves (bar fill, colour band, "resets in", "refreshed
 * N min ago", staleness) are pure functions in `core/usage.ts` and
 * `core/buckets.ts`, so they are unit-tested rather than eyeballed.
 */
import { formatResetsIn, type Bucket } from '../core/buckets';
import {
  BAR_SEGMENTS,
  barFill,
  formatPct,
  formatRefreshedAgo,
  isStale,
  type ServiceReport,
  type UsageSnapshot
} from '../core/usage';

/*
 * Renderer logging: silent unless the page was opened with `?debug=1`.
 *
 * A `console.*` call in this window is not a diagnostic anybody reads — the
 * page is loaded from `file://` in a packaged app, by a window that draws a dog
 * and has no devtools anyone is going to open. The real log is the main
 * process's (`main/log.ts`, with its redaction filter); this is the renderer
 * half, off by default for the same reason `vlog` is. `?debug=1` is the flag
 * that already turns on the hit-area outline, so one switch covers both.
 *
 * Deliberately duplicated in `overlay.ts` rather than shared: a common module
 * would be hoisted into a second ESM chunk, and a `file://` document cannot
 * fetch a sibling module (opaque origin, blocked by CORS). Six lines beats a
 * blank window.
 */
const debug = new URLSearchParams(window.location.search).get('debug') === '1';

function rerror(...args: unknown[]): void {
  if (debug) console.error('[walder]', ...args);
}

const SERVICES: readonly ('claude' | 'chatgpt')[] = ['claude', 'chatgpt'];

const SERVICE_TITLES: Readonly<Record<'claude' | 'chatgpt', string>> = {
  claude: 'CLAUDE',
  chatgpt: 'CHATGPT'
};

const card = document.getElementById('card');

let snapshot: UsageSnapshot | null = null;

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The 20-segment pixel bar. */
function bar(pct: number | null): HTMLElement {
  const { filled, tone } = barFill(pct);
  const wrap = el('div', 'seg');
  for (let i = 0; i < BAR_SEGMENTS; i++) {
    const cell = document.createElement('div');
    if (i < filled) cell.classList.add(`on-${tone}`);
    wrap.append(cell);
  }
  return wrap;
}

function bucketRow(bucket: Bucket, now: number): HTMLElement {
  const row = el('div', 'row');

  const head = el('div', 'rowhead');
  const label = el('span', 'label', bucket.label);
  /*
   * A derived row says so, quietly.
   *
   * The "7-day Fable" row is not a separate allowance — it is the weekly pool
   * shown again under the name the owner recognises (see `withDerivedFableRow`
   * in `core/buckets.ts`). Without the note the card carries two rows at the
   * same percentage with the same reset and nothing to say that spending one
   * spends the other, which reads as a bug in Walder rather than as how the plan
   * works. Nested inside the label so the ellipsis still applies to the pair,
   * and muted so it does not compete with the number.
   */
  if (bucket.derived === true) label.append(el('span', 'shared', '  (shared pool)'));
  head.append(label);
  head.append(el('span', 'value', formatPct(bucket.pct)));
  row.append(head);

  row.append(bar(bucket.pct));

  const resets = formatResetsIn(bucket.resetsAt, new Date(now));
  // No line at all when the provider gave no reset time — an empty grey line
  // would read as a value we failed to render.
  if (resets.length > 0) row.append(el('div', 'resets', resets));

  return row;
}

/** "CLAUDE · via Claude Code login", or "· no source" when nothing answered. */
function sourceLine(service: 'claude' | 'chatgpt', report: ServiceReport): HTMLElement {
  const via = report.status === 'unavailable' ? report.viaLabel : `via ${report.viaLabel}`;
  return el('div', 'source', `${SERVICE_TITLES[service]}  ·  ${via}`);
}

function serviceSection(service: 'claude' | 'chatgpt', report: ServiceReport, now: number): Node[] {
  const nodes: Node[] = [sourceLine(service, report)];

  // The status line, whenever there is something to say. `ok` says nothing: the
  // numbers below it are the message.
  if (report.status !== 'ok' && report.message !== undefined) {
    nodes.push(el('div', 'note', report.message));
  } else if (report.status !== 'ok') {
    nodes.push(el('div', 'note', report.status));
  }

  /*
   * An `ok` source that reported no windows at all needs a line of its own.
   *
   * Without one the section is a heading and then nothing — which looks exactly
   * like a card that failed to render, and is the one thing a source line saying
   * "via Claude Code login" cannot explain. It is a real state: a provider can
   * answer 200 with a payload whose every entry was an internal we dropped, or
   * an account with no metered windows. So say what happened, in the same muted
   * `note` line a failure would use.
   */
  if (report.status === 'ok' && report.buckets.length === 0) {
    nodes.push(el('div', 'note', 'no limits reported'));
  }

  for (const bucket of report.buckets) nodes.push(bucketRow(bucket, now));
  return nodes;
}

function render(): void {
  if (card === null) return;
  const now = Date.now();
  card.replaceChildren();

  const head = el('div', 'head');
  head.append(el('span', 'title', 'WALDER'));

  if (snapshot === null) {
    head.append(el('span', 'ago', 'not checked yet'));
    card.append(head);
    reportHeight();
    return;
  }

  const stale = isStale(snapshot.fetchedAt, now, snapshot.intervalMs);
  const ago = el('span', 'ago', formatRefreshedAgo(snapshot.fetchedAt, now));
  // Marked, not hidden: stale numbers are still the best information there is,
  // and the owner needs to know how old they are — not to be shown nothing.
  if (stale) ago.classList.add('stale');
  head.append(ago);
  card.append(head);

  for (const service of SERVICES) {
    card.append(...serviceSection(service, snapshot.services[service], now));
  }

  reportHeight();
}

/**
 * Tell main how tall the card came out.
 *
 * A frameless window cannot size itself to its content, and only the renderer
 * knows the height after layout — which depends on how many buckets each service
 * reported and whether there are status lines. The 4 px is the offset shadow,
 * which is part of the design and must not be clipped.
 */
function reportHeight(): void {
  if (card === null) return;
  const height = Math.ceil(card.getBoundingClientRect().height) + 4;
  if (height <= 4) return;
  void window.walder.reportPanelSize(height);
}

async function boot(): Promise<void> {
  if (card === null) {
    rerror('panel card element missing; nothing will be drawn');
    return;
  }

  window.walder.onUsage((next) => {
    snapshot = next;
    render();
  });

  // A card that has been up for a while should keep its footer honest ("2 min
  // ago" -> "3 min ago") without waiting for the next poll. Cheap: the panel is
  // hidden most of the time, and this only re-renders text.
  setInterval(() => {
    if (snapshot !== null) render();
  }, 30_000);

  render();

  // Ask rather than wait: the panel usually loads *after* the restored snapshot
  // was pushed, so without this it would be empty until the first live poll.
  const settings = await window.walder.getSettings();
  if (settings === null) return;
  if (settings.usage !== null) {
    snapshot = settings.usage;
    render();
  }
}

void boot();

export {};

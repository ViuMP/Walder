/**
 * Walder — hover-panel renderer.
 *
 * Draws the usage card and reports its height back so main can size the window
 * around it. Everything else about the panel — when to show it, where to put it,
 * how wide to make the window — is main's job; this file only turns a
 * `CardModel` into the card in `design/HoverPanel.dc.html`.
 *
 * **It is a painter, and nothing else.** Every decision about *what the card
 * says* — which lines exist at which size, when a status note appears, whether a
 * row gets a bar — lives in `cardRowsFor` (`core/card-layout.ts`), because this
 * file is the one place in the project that cannot be unit-tested: vitest runs
 * under node here, with no jsdom, so nothing that touches `document` is
 * reachable from a test. The conditionals below are therefore only ever "is this
 * field null" — if you need to ask a question about the *data*, ask it in
 * `card-layout.ts` where a test can watch you.
 *
 * Two rules it keeps of its own:
 *
 *  - **`textContent`, never `innerHTML`.** Every string on this card comes from
 *    a provider's JSON: bucket labels, and the `message` on a failed source. The
 *    CSP would stop an injected `<script>` from running, but building DOM by
 *    hand means there is nothing to stop in the first place.
 *  - **Measure after every paint.** A frameless window cannot size itself to its
 *    content, and the content changes with the snapshot *and* with the card size.
 *  - **ARIA labels come from `core/a11y-text.ts`, never composed here.** They are
 *    words, and words in this file are words no test can read.
 */
import {
  cardRowsFor,
  isCardSize,
  type CardModel,
  type CardRow,
  type CardSection,
  type CardSize
} from '../core/card-layout';
import { rowLabel, sectionLabel } from '../core/a11y-text';
import { BAR_SEGMENTS } from '../core/usage';
import type { BarTone, CreditPrice, UsageSnapshot } from '../core/usage';

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

const card = document.getElementById('card');

let snapshot: UsageSnapshot | null = null;
/**
 * Large until the `settings:get` response arrives. The first provisional paint
 * can therefore be Large; the settings round trip immediately repaints it at
 * the stored size before the panel is shown.
 */
let cardSize: CardSize = 'large';
/**
 * `null` until the same `settings:get` round trip that corrects `cardSize`.
 * Null is the safe provisional value, not a guess at the list price: the Codex
 * credit row then shows the counts the provider stated, which are true whatever
 * the owner paid, instead of an amount that might be in the wrong currency for
 * one frame.
 */
let creditPrice: CreditPrice | null = null;

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The 20-segment pixel bar, from an already-computed fill. */
function bar(fill: { filled: number; tone: BarTone }): HTMLElement {
  const wrap = el('div', 'seg');
  // Twenty empty divs are the percentage drawn again. The row's own label
  // already says it in words, and a reader counting cells says it a third time.
  wrap.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < BAR_SEGMENTS; i++) {
    const cell = document.createElement('div');
    if (i < fill.filled) cell.classList.add(`on-${fill.tone}`);
    wrap.append(cell);
  }
  return wrap;
}

function rowNode(row: CardRow): HTMLElement {
  const node = el('div', 'row');
  // One group with one sentence, rather than three spans a reader has to
  // assemble: the label, the number and the reset are one fact about one
  // allowance, and they are read in the order the eye takes them.
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', rowLabel(row));

  const head = el('div', 'rowhead');
  const label = el('span', 'label', row.label);
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
  if (row.shared) label.append(el('span', 'shared', '  (shared pool)'));
  head.append(label);
  head.append(el('span', 'value', row.pctText));
  node.append(head);

  if (row.bar !== null) node.append(bar(row.bar));
  if (row.resetsText !== null) node.append(el('div', 'resets', row.resetsText));

  return node;
}

function sectionNode(section: CardSection): HTMLElement {
  const node = el('div', 'section');
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', sectionLabel(section));
  if (section.sourceLine !== null) node.append(el('div', 'source', section.sourceLine));
  if (section.statusLine !== null) node.append(el('div', 'note', section.statusLine));
  for (const row of section.rows) node.append(rowNode(row));
  return node;
}

/** Paint a model. The only function here that touches `#card`'s children. */
function paint(model: CardModel): void {
  if (card === null) return;
  card.replaceChildren();
  // The per-size padding, gaps and font sizes are CSS, keyed off this attribute
  // (see `panel.html`) — the model decides *what* is drawn, the stylesheet how
  // tightly.
  card.dataset['size'] = model.size;

  if (model.header !== null) {
    const head = el('div', 'head');
    head.append(el('span', 'title', model.header.title));
    const ago = el('span', 'ago', model.header.ago);
    if (model.header.stale) ago.classList.add('stale');
    head.append(ago);
    card.append(head);
  }

  for (const section of model.sections) card.append(sectionNode(section));

  if (model.footer !== null) {
    const foot = el('div', 'foot', model.footer.text);
    if (model.footer.stale) foot.classList.add('stale');
    card.append(foot);
  }
}

function render(): void {
  if (card === null) return;
  // `navigator.language` here, not inside `cardRowsFor`: this is the one file
  // that legitimately knows the owner's locale, and the layout module must stay
  // pure so its tests are not tests of the machine they ran on.
  paint(cardRowsFor(snapshot, cardSize, Date.now(), navigator.language, creditPrice));
  reportHeight();
}

/**
 * Tell main how tall the card came out.
 *
 * A frameless window cannot size itself to its content, and only the renderer
 * knows the height after layout — which depends on how many buckets each service
 * reported, whether there are status lines, and which of the three card sizes is
 * showing. The 4 px is the offset shadow, which is part of the design and must
 * not be clipped.
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

  // The tray's "Card size" radio group. Validated rather than trusted, for the
  // same reason `facing` is on the overlay: main is not an attacker, but a
  // nonsense value here would put the card in a layout `cardRowsFor` has no
  // rules for, and keeping the current one is always safe.
  window.walder.onCardSize((payload) => {
    if (!isCardSize(payload.cardSize)) return;
    cardSize = payload.cardSize;
    render();
  });

  // A card that has been up for a while should keep its age line honest ("2 min
  // ago" -> "3 min ago") without waiting for the next poll. Cheap: the panel is
  // hidden most of the time, and this only re-renders text.
  setInterval(() => {
    if (snapshot !== null) render();
  }, 30_000);

  render();

  // Ask rather than wait: the panel usually loads *after* the restored snapshot
  // was pushed, so without this it would be empty until the first live poll.
  // The card size arrives in the same round trip and corrects the provisional
  // Large paint before the panel becomes visible.
  const settings = await window.walder.getSettings();
  if (settings === null) return;
  if (isCardSize(settings.cardSize)) cardSize = settings.cardSize;
  // Not re-checked, unlike `cardSize`: `readCodexCreditPrice` in main is the
  // one validator and it answers a usable price or `null`, nothing else.
  creditPrice = settings.codexCreditPrice;
  if (settings.usage !== null) snapshot = settings.usage;
  render();
}

void boot();

export {};

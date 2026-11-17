/**
 * The hover card's DOM, shared by the card itself (`panel.ts`) and the
 * Overview screen of the Walder window (`settings.ts`), so the two always draw
 * the same numbers the same way. Pure DOM from a `CardModel`; the model comes
 * from `cardRowsFor` in `core/card-layout.ts`. The matching styles are
 * `card.css`.
 */
import { cardBoxWidthFor, type CardModel, type CardRow, type CardSection } from '../core/card-layout';
import { rowLabel, sectionLabel } from '../core/a11y-text';
import { BAR_SEGMENTS } from '../core/usage';
import type { BarTone } from '../core/usage';

export function el(tag: string, className?: string, text?: string): HTMLElement {
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
  if (section.ago !== null) node.append(el('div', 'note stale', section.ago));
  for (const row of section.rows) node.append(rowNode(row));
  return node;
}

/** Paint a model into `card`. The only function that touches its children. */
export function paint(card: HTMLElement, model: CardModel): void {
  card.replaceChildren();
  // The per-size padding, gaps and font sizes are CSS, keyed off this attribute
  // (see `panel.html`) — the model decides *what* is drawn, the stylesheet how
  // tightly.
  card.dataset['size'] = model.size;
  /*
   * The width the card will be *shown* at, not the window's current one (D2,
   * `cardBoxWidthFor` in `core/card-layout.ts`). A Card size change made while
   * the card is hidden leaves the window at the old width until the next hover
   * places it, and a height measured in that viewport is the old width's
   * height — one wrapped line short going to Small, which is the scrollbar the
   * owner saw. Set through the CSSOM, which the CSP does not govern.
   */
  card.style.width = `${cardBoxWidthFor(model.size)}px`;

  if (model.header !== null) {
    const head = el('div', 'head');
    head.append(el('span', 'title', model.header.title));
    const ago = el('span', 'ago', model.header.ago);
    if (model.header.stale) ago.classList.add('stale');
    head.append(ago);
    card.append(head);
  }

  for (const section of model.sections) card.append(sectionNode(section));

  /*
   * The SESSIONS block, after the two service sections and before the footer.
   *
   * Painted with the elements that already exist: `.section` for the group and
   * its dashed rule, `.source` for the heading (it is the same kind of thing
   * as `CLAUDE  ·  via …` — a small, letter-spaced, muted label) and `.note`
   * for the rows. No new CSS: the block is a heading over a list of short
   * muted lines, which is exactly what those two classes already are.
   */
  if (model.sessions !== null) {
    const node = el('div', 'section');
    node.setAttribute('role', 'group');
    node.setAttribute('aria-label', model.sessions.title);
    node.append(el('div', 'source', model.sessions.title));
    for (const row of model.sessions.rows) node.append(el('div', 'note', row.text));
    card.append(node);
  }

  if (model.footer !== null) {
    const foot = el('div', 'foot', model.footer.text);
    if (model.footer.stale) foot.classList.add('stale');
    card.append(foot);
  }
}


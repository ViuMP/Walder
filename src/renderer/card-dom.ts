/**
 * The hover card's DOM, shared by the card itself (`panel.ts`) and the
 * Overview screen of the Walder window (`settings.ts`), so the two always draw
 * the same numbers the same way. Pure DOM from a `CardModel`; the model comes
 * from `cardRowsFor` in `core/card-layout.ts`. The matching styles are
 * `card.css`.
 */
import {
  cardBoxWidthFor,
  type CardFooter,
  type CardHeader,
  type CardLineModel,
  type CardModel,
  type CardRow,
  type CardSection,
  type CardSessions
} from '../core/card-layout';
import { rowLabel, sectionLabel } from '../core/a11y-text';
import { BAR_SEGMENTS } from '../core/usage';
import { t } from '../core/strings';
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
  if (row.shared) label.append(el('span', 'shared', `  ${t('card.sharedPool')}`));
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

function headNode(header: CardHeader): HTMLElement {
  const head = el('div', 'head');
  head.append(el('span', 'title', header.title));
  const ago = el('span', 'ago', header.ago);
  if (header.stale) ago.classList.add('stale');
  head.append(ago);
  return head;
}

/*
 * The SESSIONS block. Painted with the elements that already exist: `.section`
 * for the group and its dashed rule, `.source` for the heading (it is the same
 * kind of thing as `CLAUDE  ·  via …` — a small, letter-spaced, muted label)
 * and `.note` for the rows. No new CSS.
 */
function sessionsNode(sessions: CardSessions): HTMLElement {
  const node = el('div', 'section');
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', sessions.title);
  node.append(el('div', 'source', sessions.title));
  for (const row of sessions.rows) node.append(el('div', 'note', row.text));
  return node;
}

function footNode(footer: CardFooter): HTMLElement {
  const foot = el('div', 'foot', footer.text);
  if (footer.stale) foot.classList.add('stale');
  return foot;
}

/** One line of the owner's flat card (`CardModel.lines`). */
function lineNode(line: CardLineModel): HTMLElement {
  switch (line.kind) {
    case 'title':
      return headNode(line.header);
    case 'service':
      return sectionNode(line.section);
    case 'row':
      return rowNode(line.row);
    case 'reset':
      return el('div', 'resets', line.text);
    case 'sessions':
      return sessionsNode(line.sessions);
    case 'updated':
      return footNode(line.footer);
  }
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

  // The owner's own order: one flat list, drawn instead of the classic parts.
  if (model.lines !== undefined) {
    card.dataset['layout'] = 'flat';
    for (const line of model.lines) card.append(lineNode(line));
    return;
  }
  delete card.dataset['layout'];

  if (model.header !== null) card.append(headNode(model.header));

  for (const section of model.sections) card.append(sectionNode(section));

  // After the service sections and before the footer.
  if (model.sessions !== null) card.append(sessionsNode(model.sessions));

  if (model.footer !== null) card.append(footNode(model.footer));
}

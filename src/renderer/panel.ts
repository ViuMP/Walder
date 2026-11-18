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
  DEFAULT_CARD_LAYOUT,
  DEFAULT_RESET_STYLE,
  cardBoxWidthFor,
  cardRowsFor,
  panelHeightFor,
  isCardSize,
  isResetStyle,
  parseCardLayout,
  type CardLayout,
  type CardModel,
  type CardRow,
  type CardSection,
  type CardSize,
  type ResetStyle
} from '../core/card-layout';
import { language, t } from '../core/strings';
import { intlLocale } from '../core/i18n';
import { paint } from './card-dom';
import { parseSessionsPayload, type SessionEntry } from '../core/sessions';
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
// The language main chose (`?lang=`, read by core/strings.ts): for the
// screen reader and the font fallback (`:lang()` in card.css).
document.documentElement.lang = language();
card?.setAttribute('aria-label', t('panel.aria'));

let snapshot: UsageSnapshot | null = null;
/**
 * Large until the `settings:get` response arrives. The first provisional paint
 * can therefore be Large; the settings round trip immediately repaints it at
 * the stored size before the panel is shown.
 */
let cardSize: CardSize = 'large';
/**
 * The default until the same `settings:get` round trip corrects it. Unlike
 * `cardSize` a wrong value here costs nothing but the wording of one line for
 * one frame — it cannot mis-size the window.
 */
let resetStyle: ResetStyle = DEFAULT_RESET_STYLE;
/**
 * `null` until the same `settings:get` round trip that corrects `cardSize`.
 * Null is the safe provisional value, not a guess at the list price: the Codex
 * credit row then shows the counts the provider stated, which are true whatever
 * the owner paid, instead of an amount that might be in the wrong currency for
 * one frame.
 */
let creditPrice: CreditPrice | null = null;
/**
 * The live coding sessions. Empty until main says otherwise, which is also
 * what an owner with no hooks and no Claude Code sees forever — and an empty
 * list is a card with no SESSIONS block at all, not a block saying "none".
 */
let sessions: readonly SessionEntry[] = [];
/** The owner's line layout (`cardLayout`): classic until `settings:get` says otherwise. */
let cardLayout: CardLayout = DEFAULT_CARD_LAYOUT;

function render(): void {
  if (card === null) return;
  // `navigator.language` here, not inside `cardRowsFor`: this is the one file
  // that legitimately knows the owner's locale, and the layout module must stay
  // pure so its tests are not tests of the machine they ran on.
  if (card === null) return;
  paint(
    card,
    cardRowsFor(
      snapshot,
      cardSize,
      Date.now(),
      intlLocale(language(), navigator.language),
      creditPrice,
      resetStyle,
      sessions,
      cardLayout
    )
  );
  reportHeight();
}

/**
 * Tell main how tall the card came out.
 *
 * A frameless window cannot size itself to its content, and only the renderer
 * knows the height after layout — which depends on how many buckets each service
 * reported, whether there are status lines, and which of the three card sizes is
 * showing. `panelHeightFor` adds the offset shadow, which is part of the design
 * and must not be clipped. Correct for the size being painted whatever width
 * the window has right now, because `paint` lays the card out at that size's
 * own width (D2).
 */
function reportHeight(): void {
  if (card === null) return;
  const height = panelHeightFor(card.getBoundingClientRect().height);
  if (height === null) return;
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

  // The tray's "Reset times" radio group, validated for the same reason.
  window.walder.onResetStyle((payload) => {
    if (!isResetStyle(payload.resetStyle)) return;
    resetStyle = payload.resetStyle;
    render();
  });

  // The owner's line layout, through the setting's own validator; a payload
  // that fails it keeps the current layout.
  window.walder.onCardLayout((payload) => {
    const parsed = parseCardLayout(payload.cardLayout);
    if (parsed === null) return;
    cardLayout = parsed;
    render();
  });

  // Validated with the same function main used to build it — it is in `core`
  // precisely so both sides share one answer to "is this a session list". A
  // payload that fails leaves the current rows up, which is the same choice
  // the two guards above make: the last thing we know beats nothing.
  window.walder.onSessions((payload) => {
    const parsed = parseSessionsPayload(payload);
    if (parsed === null) return;
    sessions = parsed.sessions;
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
  // The same guard doing double duty: `resetStyle` is still optional on the
  // payload until main's assembly site is wired, and an absent field must leave
  // the default in place rather than blank the wording.
  if (isResetStyle(settings.resetStyle)) resetStyle = settings.resetStyle;
  // Not re-checked, unlike `cardSize`: `readCodexCreditPrice` in main is the
  // one validator and it answers a usable price or `null`, nothing else.
  creditPrice = settings.codexCreditPrice;
  // Through the same validator, and through the same "absent leaves the
  // default" rule as `resetStyle`: the field is optional on the payload.
  const firstSessions = parseSessionsPayload({ sessions: settings.sessions ?? [] });
  if (firstSessions !== null) sessions = firstSessions.sessions;
  cardLayout = parseCardLayout(settings.cardLayout) ?? DEFAULT_CARD_LAYOUT;
  if (settings.usage !== null) snapshot = settings.usage;
  render();
}

void boot();

export {};

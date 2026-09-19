/**
 * What the hover card says, at each of its three sizes.
 *
 * This file carries the weight that would otherwise sit on the renderer, which
 * cannot be tested at all: vitest runs under node here with no jsdom, so nothing
 * that touches `document` is reachable. `panel.ts` is now a painter with no
 * decisions in it, and every decision it used to make is asserted below —
 * against six snapshots that between them cover the states the owner will
 * actually see:
 *
 *  1. `healthy`   — both services answering, including the derived Fable row.
 *  2. `loginNeeded` — a service that needs a login and has no numbers.
 *  3. `okButEmpty` — an `ok` source that reported no windows at all.
 *  4. `unknowns`  — a window with no percentage and no reset time.
 *  5. `stale`     — real numbers, two poll intervals old.
 *  6. `never`     — no snapshot yet.
 *
 * The recurring bug class these guard against is a size that *silently* drops
 * something load-bearing: a stale card with no age on it, a `login needed` with
 * nothing to say whose login, a section that renders as a heading and nothing
 * else.
 */
import { describe, expect, it } from 'vitest';
import {
  CARD_SIZES,
  CARD_WIDTH,
  DEFAULT_CARD_SIZE,
  SERVICE_LABELS,
  accountStatusLine,
  cardRowsFor,
  cardWidthFor,
  isCardSize,
  type CardSize
} from '../src/core/card-layout';
import type { Bucket } from '../src/core/buckets';
import { forIpc, type ServiceReport, type UsageSnapshot } from '../src/core/usage';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');
const INTERVAL = 180_000;

function bucket(over: Partial<Bucket> & Pick<Bucket, 'id' | 'key' | 'label'>): Bucket {
  return {
    service: 'claude',
    pct: 50,
    resetsAt: new Date(NOW + 2 * 60 * 60 * 1000).toISOString(),
    priority: 0,
    ...over
  } as Bucket;
}

function report(over: Partial<ServiceReport> = {}): ServiceReport {
  return {
    buckets: [],
    status: 'ok',
    via: 'claude-oauth',
    viaLabel: 'Claude Code login',
    ...over
  };
}

function snapshot(
  claude: ServiceReport,
  chatgpt: ServiceReport,
  fetchedAt = new Date(NOW - 60_000).toISOString()
): UsageSnapshot {
  const buckets = [...claude.buckets, ...chatgpt.buckets];
  return {
    fetchedAt,
    services: { claude, chatgpt },
    buckets,
    expression: 'neutral',
    intervalMs: INTERVAL
  };
}

const FIVE_HOUR = bucket({ id: 'claude.five_hour', key: 'five_hour', label: '5-hour', pct: 63 });
const SEVEN_DAY = bucket({
  id: 'claude.seven_day',
  key: 'seven_day',
  label: '7-day (all models)',
  pct: 22,
  priority: 3
});
const FABLE = bucket({
  id: 'claude.seven_day_fable',
  key: 'seven_day_fable',
  label: '7-day Fable',
  pct: 22,
  priority: 1,
  derived: true
});
const CODEX = bucket({
  id: 'chatgpt.primary',
  key: 'primary',
  label: 'Codex 5-hour',
  service: 'chatgpt',
  pct: 91
});

const healthy = snapshot(
  report({ buckets: [FIVE_HOUR, FABLE, SEVEN_DAY] }),
  report({ buckets: [CODEX], via: 'codex-cli', viaLabel: 'Codex CLI' })
);

const loginNeeded = snapshot(
  report({ status: 'auth-needed', message: 'the Claude Code token has expired' }),
  report({ buckets: [CODEX], via: 'codex-cli', viaLabel: 'Codex CLI' })
);

const okButEmpty = snapshot(report({ buckets: [] }), report({ buckets: [CODEX] }));

const unknowns = snapshot(
  report({
    buckets: [
      bucket({ id: 'claude.five_hour', key: 'five_hour', label: '5-hour', pct: null, resetsAt: null })
    ]
  }),
  report({ status: 'unavailable', via: 'none', viaLabel: 'no source' })
);

const stale = snapshot(
  report({ buckets: [FIVE_HOUR] }),
  report({ buckets: [] }),
  new Date(NOW - 3 * INTERVAL).toISOString()
);

/** Every row on the card, whichever section it is in. */
function allRows(model: ReturnType<typeof cardRowsFor>) {
  return model.sections.flatMap((section) => section.rows);
}

function sectionFor(model: ReturnType<typeof cardRowsFor>, service: 'claude' | 'chatgpt') {
  return model.sections.find((section) => section.service === service);
}

describe('the size vocabulary', () => {
  it('offers exactly three sizes, biggest first, and defaults to Large', () => {
    expect(CARD_SIZES).toEqual(['large', 'medium', 'small']);
    expect(DEFAULT_CARD_SIZE).toBe('large');
  });

  it('accepts only those three', () => {
    for (const size of CARD_SIZES) expect(isCardSize(size)).toBe(true);
    for (const junk of ['tiny', 'LARGE', '', 'huge', 0, 1, null, undefined, {}, ['small']]) {
      expect(isCardSize(junk), String(junk)).toBe(false);
    }
  });

  it('pins one fixed width per size, widest first', () => {
    // Fixed rather than measured: a tooltip that changes width under the cursor
    // as the labels change reads as a glitch.
    expect(CARD_WIDTH).toEqual({ large: 380, medium: 370, small: 250 });
    for (const size of CARD_SIZES) expect(cardWidthFor(size)).toBe(CARD_WIDTH[size]);
    expect(cardWidthFor('large')).toBeGreaterThan(cardWidthFor('medium'));
    expect(cardWidthFor('medium')).toBeGreaterThan(cardWidthFor('small'));
  });

  /*
   * Why those numbers and not the old 300 / 250 / 200.
   *
   * The renderer cannot be tested — vitest runs under node with no jsdom — so
   * "does the label fit?" can never be *measured* here. What can be pinned is
   * the arithmetic the width was chosen by, which is the thing that silently
   * rotted: `CARD_WIDTH` was picked against `7-day (all models)` plus `100%`,
   * and then the Codex credit-limit row arrived with a value column three times
   * that long. Nothing failed, because `.value` is `flex: none` and `.label` is
   * `overflow:hidden; text-overflow:ellipsis` — the label just silently ate the
   * whole shortfall and the owner read `Codex credit li…`.
   *
   * So the budget is reconstructed from `panel.html` and asserted. Every number
   * below is an ESTIMATE, NOT A MEASUREMENT: the character advances in
   * particular are the usual 0.6 em rule of thumb for a monospace face, not
   * anything the system font actually reported. Treat a failure here as "go and
   * look at the real card", not as a pixel-exact verdict.
   */

  /** Chrome around the row, straight out of `panel.html`, in logical px. */
  const BODY_PADDING = 4; // body { padding: 0 4px 4px 0 }
  const CARD_BORDER = 6; // #card { border: 3px solid } — both sides
  const ROWHEAD_GAP = 8; // .rowhead { gap: 8px } — between label and value
  /** `#card` `--pad`, per size. Medium and Small are tighter on purpose. */
  const CARD_PAD: Readonly<Record<CardSize, number>> = { large: 12, medium: 10, small: 8 };

  /** Monospace advance ≈ 0.6 em. `.value` is 11 px; `.label` is 12 px. */
  const valuePx = (value: string): number => value.length * 6.6;
  const labelPx = (label: string): number => label.length * 7.2;

  /** What is left for `.label` once the chrome and the value have taken theirs. */
  const labelBudget = (size: CardSize, value: string): number =>
    CARD_WIDTH[size] - BODY_PADDING - CARD_BORDER - 2 * CARD_PAD[size] - ROWHEAD_GAP - valuePx(value);

  it('is wide enough at Large and Medium for the longest label+value the app can produce', () => {
    // The binding case, and the reason for the 2026-09-11 widening: the Codex
    // credit-limit row (`CODEX_SPEND_LIMIT_LABEL` in `core/buckets.ts`) with a
    // list price configured and the owner four times over his cap. Nothing the
    // parsers can emit is longer — 455 % is already the widest percentage, and
    // both money figures are at their full `$nnn.nn` width.
    const label = 'Codex credit limit';
    const value = 'Est. $109.30 / $24.00  (455%)';
    expect(label).toHaveLength(18);

    expect(labelBudget('large', value)).toBeGreaterThanOrEqual(labelPx(label));
    expect(labelBudget('medium', value)).toBeGreaterThanOrEqual(labelPx(label));

    // Small is deliberately NOT in that list. It is the size for somebody who
    // already knows what the rows mean, and it ellipsises this row on purpose;
    // widening it to fit would make it the same card as Medium and delete the
    // reason it exists. Asserted so the omission reads as a decision rather
    // than as a line somebody forgot.
    expect(labelBudget('small', value)).toBeLessThan(labelPx(label));
  });

  it('reports its own size and width on the model', () => {
    for (const size of CARD_SIZES) {
      const model = cardRowsFor(healthy, size, NOW);
      expect(model.size).toBe(size);
      expect(model.width).toBe(cardWidthFor(size));
    }
  });
});

describe('Large: the card as it has always been', () => {
  it('carries the header, the source lines, the bars and the resets', () => {
    const model = cardRowsFor(healthy, 'large', NOW);

    expect(model.header).toEqual({ title: 'WALDER', ago: 'refreshed 1 min ago', stale: false });
    expect(model.footer).toBeNull();

    const claude = sectionFor(model, 'claude');
    expect(claude?.sourceLine).toBe('CLAUDE  ·  via Claude Code login');
    // `ok` with numbers says nothing: the numbers are the message.
    expect(claude?.statusLine).toBeNull();
    expect(claude?.rows.map((r) => r.label)).toEqual(['5-hour', '7-day Fable', '7-day (all models)']);

    const first = claude?.rows[0];
    expect(first?.pctText).toBe('63%');
    expect(first?.bar).toEqual({ filled: 13, tone: 'mid' });
    expect(first?.resetsText).toBe('resets in 2h 0m');
    expect(first?.kind).toBe('window');

    expect(sectionFor(model, 'chatgpt')?.sourceLine).toBe('CHATGPT  ·  via Codex CLI');
  });

  it('marks the derived weekly row, and only that one', () => {
    const rows = allRows(cardRowsFor(healthy, 'large', NOW));
    expect(rows.filter((r) => r.shared).map((r) => r.label)).toEqual(['7-day Fable']);
  });

  it('prints the provider’s own message when a source is not ok', () => {
    const claude = sectionFor(cardRowsFor(loginNeeded, 'large', NOW), 'claude');
    expect(claude?.statusLine).toBe('the Claude Code token has expired');
    expect(claude?.rows).toEqual([]);
  });

  it('says so when an ok source reported no windows at all', () => {
    // Otherwise the section is a heading followed by nothing, which looks
    // exactly like a card that failed to draw.
    expect(sectionFor(cardRowsFor(okButEmpty, 'large', NOW), 'claude')?.statusLine).toBe(
      'no limits reported'
    );
  });

  it('says "no source" rather than "via no source" when nothing answered', () => {
    expect(sectionFor(cardRowsFor(unknowns, 'large', NOW), 'chatgpt')?.sourceLine).toBe(
      'CHATGPT  ·  no source'
    );
  });

  it('never invents a number: unknown percentage is ?, with no reset line', () => {
    const row = allRows(cardRowsFor(unknowns, 'large', NOW))[0];
    expect(row?.pctText).toBe('?');
    expect(row?.bar).toEqual({ filled: 0, tone: 'unknown' });
    expect(row?.resetsText).toBeNull();
  });

  it('marks a stale header rather than hiding the numbers', () => {
    const model = cardRowsFor(stale, 'large', NOW);
    expect(model.header?.stale).toBe(true);
    expect(model.header?.ago).toBe('refreshed 9 min ago');
    expect(allRows(model)).toHaveLength(1);
  });

  it('shows "not checked yet" in the header before the first poll, with no sections', () => {
    const model = cardRowsFor(null, 'large', NOW);
    expect(model.header).toEqual({ title: 'WALDER', ago: 'not checked yet', stale: false });
    expect(model.sections).toEqual([]);
    expect(model.footer).toBeNull();
  });
});

describe('CardSection.ago: a service backed off further than the tick', () => {
  // Claude is exactly as fresh as the tick; ChatGPT was actually polled three
  // intervals ago (a long rate-limit backoff), which the header's own "1 min
  // ago" says nothing about.
  const perServiceStale = snapshot(
    report({ buckets: [FIVE_HOUR], fetchedAt: new Date(NOW).toISOString() }),
    report({ buckets: [CODEX], fetchedAt: new Date(NOW - 3 * INTERVAL).toISOString() })
  );

  it('grows the line only for the service whose own numbers are old, at every size', () => {
    for (const size of CARD_SIZES) {
      const model = cardRowsFor(perServiceStale, size, NOW);
      expect(sectionFor(model, 'claude')?.ago).toBeNull();
      expect(sectionFor(model, 'chatgpt')?.ago).toBe('refreshed 9 min ago');
    }
  });

  it('is null when the report has no fetchedAt of its own', () => {
    // Every other fixture in this file predates the field, so this is also the
    // ordinary case: nothing to measure staleness against, nothing shown.
    const model = cardRowsFor(healthy, 'large', NOW);
    expect(sectionFor(model, 'claude')?.ago).toBeNull();
    expect(sectionFor(model, 'chatgpt')?.ago).toBeNull();
  });

  it('says nothing per section when the whole card is stale — the header already does', () => {
    // The Mac slept: both stamps are old, and so is the tick's. One "refreshed
    // 9 min ago" in the header (or the footer) is the fact; three would be noise.
    const old = new Date(NOW - 3 * INTERVAL).toISOString();
    const allStale = snapshot(
      report({ buckets: [FIVE_HOUR], fetchedAt: old }),
      report({ buckets: [CODEX], fetchedAt: old }),
      old
    );
    for (const size of CARD_SIZES) {
      const model = cardRowsFor(allStale, size, NOW);
      expect(sectionFor(model, 'claude')?.ago).toBeNull();
      expect(sectionFor(model, 'chatgpt')?.ago).toBeNull();
      expect(size === 'large' ? model.header?.stale : model.footer?.stale).toBe(true);
    }
  });
});

describe('Medium: the numbers without the scaffolding', () => {
  it('drops the header and the source lines, keeps the bars and the resets', () => {
    const model = cardRowsFor(healthy, 'medium', NOW);

    expect(model.header).toBeNull();
    for (const section of model.sections) expect(section.sourceLine).toBeNull();

    const first = sectionFor(model, 'claude')?.rows[0];
    expect(first?.bar).toEqual({ filled: 13, tone: 'mid' });
    expect(first?.resetsText).toBe('resets in 2h 0m');
    // The shared-pool marker survives here — Medium still has room for it.
    expect(allRows(model).filter((r) => r.shared).map((r) => r.label)).toEqual(['7-day Fable']);
  });

  it('is silent about status while everything is ok', () => {
    for (const section of cardRowsFor(healthy, 'medium', NOW).sections) {
      expect(section.statusLine).toBeNull();
    }
  });

  it('names the fix in a status note, because there is no source line to', () => {
    // The provider's own message, which names what to do about it — richer
    // than the menu's generic "login needed", and the whole point of keeping
    // it at this size.
    const claude = sectionFor(cardRowsFor(loginNeeded, 'medium', NOW), 'claude');
    expect(claude?.statusLine).toBe('the Claude Code token has expired');
  });

  it('names the service on an empty ok section too', () => {
    expect(sectionFor(cardRowsFor(okButEmpty, 'medium', NOW), 'claude')?.statusLine).toBe(
      'Claude: no limits reported'
    );
  });

  it('grows an age footer only when the age is a problem', () => {
    // Fresh: nothing. A compact card that spends a line saying "refreshed just
    // now" is not compact.
    expect(cardRowsFor(healthy, 'medium', NOW).footer).toBeNull();
    expect(cardRowsFor(stale, 'medium', NOW).footer).toEqual({
      text: 'refreshed 9 min ago',
      stale: true
    });
    expect(cardRowsFor(null, 'medium', NOW).footer).toEqual({
      text: 'not checked yet',
      stale: false
    });
  });
});

describe('Small: one line per window', () => {
  it('drops the bars, the resets and the shared marker', () => {
    const model = cardRowsFor(healthy, 'small', NOW);
    expect(model.header).toBeNull();

    for (const row of allRows(model)) {
      expect(row.bar).toBeNull();
      expect(row.resetsText).toBeNull();
      expect(row.shared).toBe(false);
    }
    // What is left is exactly the label and the percentage.
    expect(sectionFor(model, 'claude')?.rows.map((r) => `${r.label} ${r.pctText}`)).toEqual([
      '5-hour 63%',
      '7-day Fable 22%',
      '7-day (all models) 22%'
    ]);
    for (const section of model.sections) expect(section.sourceLine).toBeNull();
  });

  it('collapses a broken source to one remedy-naming line', () => {
    const model = cardRowsFor(loginNeeded, 'small', NOW);
    expect(sectionFor(model, 'claude')?.statusLine).toBe('the Claude Code token has expired');
    expect(sectionFor(model, 'claude')?.rows).toEqual([]);
  });

  it('still refuses to present unknown-age data as current', () => {
    // No header at this size, so the footer is the only place the age can live —
    // and it is the one thing Small may not drop.
    expect(cardRowsFor(stale, 'small', NOW).footer?.stale).toBe(true);
    expect(cardRowsFor(null, 'small', NOW).footer?.text).toBe('not checked yet');
    expect(cardRowsFor(healthy, 'small', NOW).footer).toBeNull();
  });

  it('still prints ? for an unknown percentage', () => {
    expect(allRows(cardRowsFor(unknowns, 'small', NOW))[0]?.pctText).toBe('?');
  });
});

describe('every size, every fixture', () => {
  const fixtures: readonly { name: string; snapshot: UsageSnapshot | null }[] = [
    { name: 'healthy', snapshot: healthy },
    { name: 'loginNeeded', snapshot: loginNeeded },
    { name: 'okButEmpty', snapshot: okButEmpty },
    { name: 'unknowns', snapshot: unknowns },
    { name: 'stale', snapshot: stale },
    { name: 'never', snapshot: null }
  ];

  it('never loses a window: the row count is the bucket count at every size', () => {
    for (const { name, snapshot: fixture } of fixtures) {
      const expected = fixture === null ? 0 : fixture.buckets.length;
      for (const size of CARD_SIZES) {
        expect(allRows(cardRowsFor(fixture, size, NOW)), `${name} @ ${size}`).toHaveLength(expected);
      }
    }
  });

  it('always says how old the numbers are when that is a problem', () => {
    // Large in the header, Medium and Small in the footer — but never nowhere.
    for (const { name, snapshot: fixture } of [fixtures[4], fixtures[5]] as typeof fixtures) {
      for (const size of CARD_SIZES) {
        const model = cardRowsFor(fixture, size, NOW);
        const said = model.header !== null ? model.header.ago : model.footer?.text;
        expect(said, `${name} @ ${size}`).toBeTruthy();
      }
    }
  });

  it('formats every percentage, so the painter never sees a raw number', () => {
    for (const { snapshot: fixture } of fixtures) {
      for (const size of CARD_SIZES) {
        for (const row of allRows(cardRowsFor(fixture, size, NOW))) {
          expect(row.pctText).toMatch(/^(\?|\d{1,3}%)$/);
        }
      }
    }
  });
});

describe('accountStatusLine (moved here from tray.ts)', () => {
  it('names the service and what the owner can do about it', () => {
    expect(accountStatusLine('claude', null)).toBe('Claude: checking…');
    expect(accountStatusLine('chatgpt', report({ viaLabel: 'Codex CLI' }))).toBe(
      'ChatGPT: ok via Codex CLI'
    );
    expect(accountStatusLine('claude', report({ status: 'auth-needed' }))).toBe(
      'Claude: login needed'
    );
    expect(accountStatusLine('claude', report({ status: 'endpoint-changed' }))).toBe(
      'Claude: endpoint changed — update Walder'
    );
    expect(accountStatusLine('claude', report({ status: 'rate-limited' }))).toBe(
      'Claude: rate limited, retrying'
    );
    expect(accountStatusLine('claude', report({ status: 'error' }))).toBe(
      'Claude: could not be reached — check the connection'
    );
    expect(accountStatusLine('claude', report({ status: 'unavailable' }))).toBe(
      'Claude: not logged in'
    );
  });

  it('keeps one set of service names for the menu and the card', () => {
    expect(SERVICE_LABELS).toEqual({ claude: 'Claude', chatgpt: 'ChatGPT' });
  });
});

describe('statusLine: message vs. accountStatusLine, per status and size', () => {
  // `auth-needed`/`unavailable` name the fix in the message itself, so it
  // survives down to Small. The other broken statuses only elaborate on a
  // sentence `accountStatusLine` already says just as well, so Large keeps
  // the message and Medium/Small fall back to it.
  const withMessageEverywhere: readonly ServiceReport['status'][] = ['auth-needed', 'unavailable'];
  const withMessageAtLargeOnly: readonly ServiceReport['status'][] = [
    'endpoint-changed',
    'error',
    'rate-limited'
  ];
  const messageFor = (status: ServiceReport['status']) => `${status}: here is the fix`;

  it.each(
    ['large', 'medium', 'small'].flatMap((size) =>
      withMessageEverywhere.map((status) => [status, size, messageFor(status)] as const)
    )
  )('%s @ %s carries the message at every size', (status, size, expected) => {
    const model = cardRowsFor(
      snapshot(report({ status, message: expected }), report()),
      size as CardSize,
      NOW
    );
    expect(sectionFor(model, 'claude')?.statusLine).toBe(expected);
  });

  it.each(
    withMessageAtLargeOnly.map((status) => [status, messageFor(status)] as const)
  )('%s carries the message at Large', (status, message) => {
    const model = cardRowsFor(snapshot(report({ status, message }), report()), 'large', NOW);
    expect(sectionFor(model, 'claude')?.statusLine).toBe(message);
  });

  it.each(
    withMessageAtLargeOnly.flatMap((status) =>
      ['medium', 'small'].map((size) => [status, size] as const)
    )
  )('%s falls back to accountStatusLine at %s', (status, size) => {
    const message = messageFor(status);
    const model = cardRowsFor(
      snapshot(report({ status, message }), report()),
      size as CardSize,
      NOW
    );
    expect(sectionFor(model, 'claude')?.statusLine).toBe(
      accountStatusLine('claude', report({ status, message }))
    );
  });

  it('falls back to accountStatusLine at the compact sizes when there is no message at all', () => {
    for (const size of ['medium', 'small'] as const) {
      const model = cardRowsFor(snapshot(report({ status: 'auth-needed' }), report()), size, NOW);
      expect(sectionFor(model, 'claude')?.statusLine).toBe('Claude: login needed');
    }
  });
});

/** A size the model was built for is a size the painter can key CSS off. */
it('is a plain data model: no functions, no DOM, nothing to call', () => {
  const model = cardRowsFor(healthy, 'large', NOW);
  const seen: unknown[] = [];
  JSON.stringify(model, (_key, value) => {
    seen.push(value);
    return value;
  });
  expect(seen.every((value) => typeof value !== 'function')).toBe(true);
  const sizes: CardSize[] = [...CARD_SIZES];
  expect(sizes).toContain(model.size);
});

/**
 * The money and credits rows (item 5): the value column each kind needs, at
 * every size.
 *
 * `kind` used to be a hard-coded `'window'` pass-through here, with a comment
 * saying the value branch was the merge-time job — this is that job. Three
 * things are load-bearing and each is asserted per size, because "it works at
 * Large" is exactly how the Small layout ends up with a bar the parser cannot
 * fill:
 *
 *  - money keeps its bar (a spend against a cap really is a percentage) and
 *    prints the amounts beside it — **unless the account has no cap**, when
 *    there is no percentage, no bar and no reset, only the amount spent;
 *  - credits has **no bar and no reset line** at any size — the provider says
 *    what is left and never what the pool held, and a credit pool is topped up
 *    by a payment rather than by a clock;
 *  - Small still renders exactly one line for both, which is what Small means.
 */
describe('money and credits rows', () => {
  const MONEY = bucket({
    id: 'claude.extra_usage',
    key: 'extra_usage',
    label: 'Extra usage',
    pct: 19.2,
    priority: 6,
    kind: 'money',
    money: { spent: 9.62, limit: 50, currency: 'DKK' }
  });
  /** The owner's own account: extra usage on, `monthly_limit: null`. */
  const CAPLESS = bucket({
    id: 'claude.extra_usage',
    key: 'extra_usage',
    label: 'Extra usage',
    pct: null,
    resetsAt: null,
    priority: 6,
    kind: 'money',
    money: { spent: 9.62, limit: null, currency: 'DKK' }
  });
  const CREDITS = bucket({
    id: 'chatgpt.codex_credits',
    key: 'codex_credits',
    label: 'Codex credits',
    service: 'chatgpt',
    pct: null,
    resetsAt: null,
    priority: 5,
    kind: 'credits',
    credits: { balance: 1240, unlimited: false, exhausted: false }
  });

  const withBoth = snapshot(
    report({ buckets: [FIVE_HOUR, MONEY] }),
    report({ buckets: [CODEX, CREDITS], via: 'codex-cli', viaLabel: 'Codex CLI' })
  );

  /** ICU puts a non-breaking space between number and symbol; tolerate it. */
  const norm = (s: string): string => s.replace(/ | /g, ' ');

  function row(size: CardSize, id: string, patch: Partial<Bucket> = {}) {
    const snap =
      Object.keys(patch).length === 0
        ? withBoth
        : snapshot(
            report({ buckets: [FIVE_HOUR, { ...MONEY, ...patch }] }),
            report({ buckets: [CODEX, CREDITS], via: 'codex-cli', viaLabel: 'Codex CLI' })
          );
    const found = allRows(cardRowsFor(snap, size, NOW, 'da-DK')).find((r) => r.id === id);
    expect(found, `${id} missing at ${size}`).toBeDefined();
    return found as NonNullable<typeof found>;
  }

  for (const size of CARD_SIZES) {
    it(`money at ${size}: amounts, the percentage, and the bar kept`, () => {
      const money = row(size, 'claude.extra_usage');
      expect(money.kind).toBe('money');
      expect(norm(money.pctText)).toBe('9,62 kr. / 50,00 kr.  (19%)');
      // Small draws no bars at all, so the money row loses its there too —
      // that is the size's rule, not an exception for this kind.
      if (size === 'small') expect(money.bar).toBeNull();
      else expect(money.bar).toEqual({ filled: expect.any(Number), tone: expect.any(String) });
      // The reset is the month roll, and follows the size's ordinary rule.
      if (size === 'small') expect(money.resetsText).toBeNull();
      else expect(money.resetsText).toContain('resets in');
    });

    it(`money at ${size}: an inferred reset says so, a provider's does not`, () => {
      /*
       * The Extra usage row's reset is Walder's arithmetic, not claude.ai's
       * figure — the payload carries no date of any kind — so the card must say
       * which it is. `(est.)` is the same admission the value column already
       * makes with `Est. $109.30` on the credit-price conversion, and without it
       * this row would be the one line on the card that looks sourced and is
       * not.
       */
      const estimated = row(size, 'claude.extra_usage', { resetsEstimated: true });
      const stated = row(size, 'claude.extra_usage');
      if (size === 'small') {
        expect(estimated.resetsText).toBeNull();
        return;
      }
      expect(estimated.resetsText?.endsWith(' (est.)')).toBe(true);
      // …and the marker is the ONLY difference: the figure itself is untouched.
      expect(estimated.resetsText).toBe(`${stated.resetsText as string} (est.)`);
      expect(stated.resetsText).not.toContain('est.');
    });

    it(`credits at ${size}: the balance, and never a bar or a reset`, () => {
      const credits = row(size, 'chatgpt.codex_credits');
      expect(credits.kind).toBe('credits');
      expect(credits.pctText).toBe('1.240 left');
      expect(credits.bar).toBeNull();
      expect(credits.resetsText).toBeNull();
    });

    it(`ordinary windows at ${size} are untouched by either branch`, () => {
      const window = row(size, 'claude.five_hour');
      expect(window.kind).toBe('window');
      expect(window.pctText).toBe('63%');
      expect(window.bar === null).toBe(size === 'small');
    });
  }

  it('draws no bar on a capless money row, at any size', () => {
    /*
     * `barFill(null)` returns an empty 20-segment bar in the "unknown" tone,
     * and an empty bar beside "9,62 kr. spent" reads as "you have used none of
     * your allowance" when the truth is that there is no allowance to have
     * used. Same honesty as the credits row's missing bar — and the same
     * reason there is no reset line either: the payload states no billing
     * anchor, so `resetsAt` is `null` and nothing is invented from it.
     */
    const capless = snapshot(report({ buckets: [FIVE_HOUR, CAPLESS] }), report());
    for (const size of CARD_SIZES) {
      const extra = allRows(cardRowsFor(capless, size, NOW, 'da-DK')).find(
        (r) => r.id === 'claude.extra_usage'
      );
      expect(extra?.kind, size).toBe('money');
      expect(norm(extra?.pctText ?? ''), size).toBe('9,62 kr. spent');
      expect(extra?.bar, size).toBeNull();
      expect(extra?.resetsText, size).toBeNull();
      // …while the window beside it still draws one at the larger sizes, so
      // this is the row's own behaviour and not a card that failed to render.
      const window = allRows(cardRowsFor(capless, size, NOW, 'da-DK')).find(
        (r) => r.id === 'claude.five_hour'
      );
      expect(window?.bar === null, size).toBe(size === 'small');
    }
  });

  it('Small keeps one line for a money row and one for a credits row', () => {
    // "One line" is the model's own promise at this size: a value, no bar, and
    // for credits no reset either. Money keeps its reset at the larger sizes
    // and loses it here like every other row.
    const money = row('small', 'claude.extra_usage');
    const credits = row('small', 'chatgpt.codex_credits');
    for (const r of [money, credits]) {
      expect(r.bar).toBeNull();
      expect(r.resetsText).toBeNull();
      expect(r.pctText.length).toBeGreaterThan(0);
    }
  });

  it('is locale-free by default, and takes the renderer’s locale as an argument', () => {
    // The default must be a fixed locale, not the host's: `cardRowsFor` is a
    // pure function and a test of it must not be a test of the machine.
    const british = allRows(cardRowsFor(withBoth, 'large', NOW)).find(
      (r) => r.id === 'chatgpt.codex_credits'
    );
    expect(british?.pctText).toBe('1,240 left');
    const danish = row('large', 'chatgpt.codex_credits');
    expect(danish.pctText).toBe('1.240 left');
    // …and the comma-vs-full-stop difference proves the argument is used at
    // all, which a same-locale assertion could not.
    expect(british?.pctText).not.toBe(danish.pctText);
  });

  it('falls back to the window shape for a bucket whose kind lacks its detail', () => {
    // Defensive, and it matters: a persisted snapshot written by an older
    // build can carry `kind: 'money'` with the `money` object trimmed out
    // (`trimSnapshot` stores only what the panel draws). A row that then tried
    // to format `undefined` would throw inside the renderer, which is the one
    // file with no test to catch it.
    const halfMoney = bucket({
      id: 'claude.extra_usage',
      key: 'extra_usage',
      label: 'Extra usage',
      pct: 40,
      kind: 'money'
    });
    const model = cardRowsFor(snapshot(report({ buckets: [halfMoney] }), report()), 'large', NOW);
    const only = allRows(model)[0];
    expect(only?.kind).toBe('money');
    expect(only?.pctText).toBe('40%');
    expect(only?.bar).not.toBeNull();
  });
});

/**
 * The Codex credit cap: a money row whose two numbers are counted in credits,
 * optionally converted at a configured list price. It draws exactly like the
 * Extra usage row above — bar, reset line, Small rules — because it *is* one;
 * only the value column's wording differs.
 */
describe('the Codex credit-limit row', () => {
  /** The owner's live numbers (dev dump, 2026-09-11). 455 %, four times over. */
  const CREDIT_CAP = bucket({
    id: 'chatgpt.codex_spend_limit',
    key: 'codex_spend_limit',
    label: 'Codex credit limit',
    service: 'chatgpt',
    pct: 455,
    priority: 4.5,
    kind: 'money',
    money: { spent: 2732.6146183013916, limit: 600, currency: 'XXX', inCredits: true }
  });
  const PRICE = { amount: 0.04, currency: 'USD' };
  const withCap = snapshot(
    report({ buckets: [FIVE_HOUR] }),
    report({ buckets: [CREDIT_CAP], via: 'chatgpt-web', viaLabel: 'chatgpt.com login' })
  );
  const norm = (s: string): string => s.replace(/[  ]/g, ' ');
  const find = (size: CardSize, price?: { amount: number; currency: string } | null) => {
    const found = allRows(cardRowsFor(withCap, size, NOW, 'en-US', price ?? null)).find(
      (r) => r.id === 'chatgpt.codex_spend_limit'
    );
    expect(found, `missing at ${size}`).toBeDefined();
    return found as NonNullable<typeof found>;
  };

  for (const size of CARD_SIZES) {
    it(`${size}: the priced estimate, the percentage, and the money row's own rules`, () => {
      const row = find(size, PRICE);
      expect(row.kind).toBe('money');
      // Large alone gets the counts ahead of the percentage (P1-16): it is the
      // only size with room to show what the list price was multiplied by.
      expect(norm(row.pctText)).toBe(
        size === 'large'
          ? 'Est. $109.30 / $24.00  (2,733 / 600 credits · 455%)'
          : 'Est. $109.30 / $24.00  (455%)'
      );
      // The bar clamps to full even though 455 does not, exactly as before the
      // amounts existed; Small drops it, like every other row.
      if (size === 'small') {
        expect(row.bar).toBeNull();
        expect(row.resetsText).toBeNull();
      } else {
        expect(row.bar).toEqual({ filled: 20, tone: 'high' });
        expect(row.resetsText).toContain('resets in');
      }
    });

    it(`${size}: falls back to credit counts with no price configured`, () => {
      expect(norm(find(size).pctText)).toBe('2,733 / 600 credits  (455%)');
      expect(norm(find(size, null).pctText)).toBe('2,733 / 600 credits  (455%)');
    });
  }

  it('leaves every other row alone when a price is configured', () => {
    // The price is for credit rows only; a percentage row has nothing to convert.
    const priced = allRows(cardRowsFor(withCap, 'large', NOW, 'en-US', PRICE));
    const plain = allRows(cardRowsFor(withCap, 'large', NOW, 'en-US'));
    expect(priced[0]?.pctText).toBe(plain[0]?.pctText);
  });

  it('shows the raw credit counts only at Large, not Medium', () => {
    expect(norm(find('large', PRICE).pctText)).toContain('credits ·');
    expect(norm(find('medium', PRICE).pctText)).not.toContain('credits ·');
  });
});

/**
 * The tokens row (local CLI transcripts, item 6): a running count with no
 * allowance behind it, so it draws like credits — no bar, no reset — but for a
 * different reason: not "no known denominator", but "no allowance exists".
 */
describe('tokens rows', () => {
  const TOKENS = bucket({
    id: 'claude.tokens_today',
    key: 'tokens_today',
    label: 'Tokens today',
    pct: null,
    resetsAt: null,
    priority: 9,
    kind: 'tokens',
    tokens: { total: 1_240_000 }
  });

  const withTokens = snapshot(report({ buckets: [FIVE_HOUR, TOKENS] }), report());

  for (const size of CARD_SIZES) {
    it(`tokens at ${size}: the running count, and never a bar or a reset`, () => {
      const row = allRows(cardRowsFor(withTokens, size, NOW, 'en-US')).find(
        (r) => r.id === 'claude.tokens_today'
      );
      expect(row?.kind).toBe('tokens');
      expect(row?.pctText).toBe('1.2M tokens');
      expect(row?.bar).toBeNull();
      expect(row?.resetsText).toBeNull();
      expect(row?.shared).toBe(false);
    });
  }

  it('falls back to the window shape for a tokens bucket with no tokens detail', () => {
    const halfTokens = bucket({
      id: 'claude.tokens_today',
      key: 'tokens_today',
      label: 'Tokens today',
      pct: 40,
      kind: 'tokens'
    });
    const model = cardRowsFor(snapshot(report({ buckets: [halfTokens] }), report()), 'large', NOW);
    const only = allRows(model)[0];
    expect(only?.kind).toBe('tokens');
    expect(only?.pctText).toBe('40%');
    expect(only?.bar).not.toBeNull();
  });
});

describe('a service whose rows the owner has all hidden', () => {
  /*
   * **The section goes, heading and all** (owner's decision, 2026-09-15).
   *
   * It used to stay: `CLAUDE · via Claude Code login` over `no limits
   * reported`, three lines to say nothing — and the note was actively wrong,
   * because the login is fine and the limits *were* reported. The owner
   * unticked those rows; being told they are missing is not news. A service
   * that genuinely reported nothing keeps that note (the case below), and
   * `hiddenServices` is the only thing that can tell the two apart once the
   * rows are gone — see `forIpc`.
   */
  const allHidden = forIpc(healthy, [
    'claude.five_hour',
    'claude.seven_day',
    'claude.seven_day_fable'
  ]);

  it('is not on the card at all, at any size', () => {
    expect(allHidden.hiddenServices).toEqual(['claude']);
    for (const size of CARD_SIZES) {
      const model = cardRowsFor(allHidden, size, NOW);
      expect(sectionFor(model, 'claude'), size).toBeUndefined();
      expect(model.sections.map((section) => section.service), size).toEqual(['chatgpt']);
    }
  });

  it('leaves the other service\'s section untouched', () => {
    const chatgpt = sectionFor(cardRowsFor(allHidden, 'large', NOW), 'chatgpt');
    expect(chatgpt?.rows.map((row) => row.label)).toEqual(['Codex 5-hour']);
    expect(chatgpt?.sourceLine).not.toBeNull();
  });

  it('still says "no limits reported" for a source that really reported none', () => {
    // The distinction the whole mechanism exists for: same empty row list, and
    // the opposite treatment, because `okButEmpty` hid nothing.
    const model = cardRowsFor(forIpc(okButEmpty), 'large', NOW);
    const claude = sectionFor(model, 'claude');
    expect(claude?.rows).toEqual([]);
    expect(claude?.sourceLine).not.toBeNull();
    expect(claude?.statusLine).toBe('no limits reported');
    for (const size of ['medium', 'small'] as const) {
      expect(sectionFor(cardRowsFor(forIpc(okButEmpty), size, NOW), 'claude')?.statusLine).toBe(
        'Claude: no limits reported'
      );
    }
  });

  it('hides both sections when the owner hides every row he has', () => {
    const nothingLeft = forIpc(healthy, healthy.buckets.map((b) => b.id));
    expect(nothingLeft.hiddenServices).toEqual(['claude', 'chatgpt']);
    // An empty card, not a card of empty headings. The header and the age line
    // still carry the one thing that is always true — see `cardRowsFor`.
    const model = cardRowsFor(nothingLeft, 'large', NOW);
    expect(model.sections).toEqual([]);
    expect(model.header).not.toBeNull();
  });

  it('keeps a service whose rows are only partly hidden', () => {
    const some = forIpc(healthy, ['claude.seven_day_fable']);
    expect(some.hiddenServices).toBeUndefined();
    const claude = sectionFor(cardRowsFor(some, 'large', NOW), 'claude');
    expect(claude?.rows.map((row) => row.label)).toEqual(['5-hour', '7-day (all models)']);
  });
});

/*
 * The reset wording is a setting, and it arrives the way `locale` and `price`
 * do: as a parameter with a default, so this module stays pure and these
 * assertions are not assertions about the machine they ran on.
 */
describe('the reset wording', () => {
  // Six days out — far enough that the two styles genuinely disagree, near
  // enough that the clock style is still a weekday rather than a date.
  const farOff = snapshot(
    report({
      buckets: [
        bucket({
          id: 'claude.seven_day',
          key: 'seven_day',
          label: '7-day (all models)',
          resetsAt: new Date(NOW + 6 * 24 * 60 * 60 * 1000).toISOString()
        })
      ]
    }),
    report()
  );

  function firstReset(resetStyle?: 'clock' | 'countdown'): string | null {
    const model = cardRowsFor(farOff, 'large', NOW, 'en-GB', null, resetStyle);
    return allRows(model)[0]?.resetsText ?? null;
  }

  it('says the countdown when the owner asked for one', () => {
    expect(firstReset('countdown')).toBe('resets in 6d 0h');
  });

  it('defaults to the clock, which is the answer the countdown made him work out', () => {
    // No style passed — `resets in 6d 0h` is arithmetic; a weekday is a plan.
    const stated = firstReset();
    expect(stated).not.toBe('resets in 6d 0h');
    expect(stated).toMatch(/^resets \w+ \d\d:\d\d$/u);
    expect(firstReset('clock')).toBe(stated);
  });
});

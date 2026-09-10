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
import type { ServiceReport, UsageSnapshot } from '../src/core/usage';

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
    expect(CARD_WIDTH).toEqual({ large: 300, medium: 250, small: 200 });
    for (const size of CARD_SIZES) expect(cardWidthFor(size)).toBe(CARD_WIDTH[size]);
    expect(cardWidthFor('large')).toBeGreaterThan(cardWidthFor('medium'));
    expect(cardWidthFor('medium')).toBeGreaterThan(cardWidthFor('small'));
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

  it('names the service in a status note, because there is no source line to', () => {
    // The menu's own sentence, from `accountStatusLine`, so the two cannot
    // disagree in front of an owner looking at both.
    const claude = sectionFor(cardRowsFor(loginNeeded, 'medium', NOW), 'claude');
    expect(claude?.statusLine).toBe('Claude: login needed');
    expect(claude?.statusLine).toBe(
      accountStatusLine('claude', loginNeeded.services.claude)
    );
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

  it('collapses a broken source to one service-naming line', () => {
    const model = cardRowsFor(loginNeeded, 'small', NOW);
    expect(sectionFor(model, 'claude')?.statusLine).toBe('Claude: login needed');
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

  it('never emits a section with nothing in it', () => {
    // An empty section would paint its dashed rule and its padding around
    // nothing — a card that looks like it failed halfway through.
    for (const { name, snapshot: fixture } of fixtures) {
      for (const size of CARD_SIZES) {
        for (const section of cardRowsFor(fixture, size, NOW).sections) {
          const empty =
            section.sourceLine === null && section.statusLine === null && section.rows.length === 0;
          expect(empty, `${name} @ ${size}`).toBe(false);
        }
      }
    }
  });

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
      'Claude: endpoint changed'
    );
    expect(accountStatusLine('claude', report({ status: 'rate-limited' }))).toBe(
      'Claude: rate limited, retrying'
    );
    expect(accountStatusLine('claude', report({ status: 'error' }))).toBe(
      'Claude: could not be reached'
    );
    expect(accountStatusLine('claude', report({ status: 'unavailable' }))).toBe(
      'Claude: not logged in'
    );
  });

  it('keeps one set of service names for the menu and the card', () => {
    expect(SERVICE_LABELS).toEqual({ claude: 'Claude', chatgpt: 'ChatGPT' });
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

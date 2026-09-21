/**
 * Byte-for-byte pin of every owner-facing sentence Walder produces, taken just
 * before P2-6 moves those literals into a strings table.
 *
 * This is step A of that move: a snapshot of *today's* wording, built from the
 * pure text builders in `src/core` — the bubble, the hover-card model, the
 * accessibility labels, the update-check menu line, the service names and the
 * shortcut labels — plus, in the sibling file `test/tray.snapshot.test.ts`,
 * every label the tray menu builds.
 *
 * **Step B must never touch the `.snap` file this generates.** These tests
 * assert wording, not structure — the strings move to a table in step B, but
 * what they render as must not change one character. If step B's diff includes
 * a change under `test/__snapshots__/strings.snapshot.test.ts.snap`, the move
 * changed output and is not the refactor it claims to be; revert and find the
 * literal that drifted (a trimmed space, a re-ordered template, a rounding
 * difference) rather than accepting the new snapshot.
 *
 * Hermetic on purpose: one fixed `now`, the fixed locale the repo already
 * defaults to (`en-GB`), and no bucket in the `cardRowsFor` fixtures ever
 * resets more than two hours out — short enough that the `clock` and
 * `countdown` reset stylings coincide (see `formatResetsIn`), so nothing here
 * depends on `Intl` or the host's time zone. `updateMenuLine`'s `failed` state
 * is the one text builder that does format a wall clock (`clockTime`, which
 * reads `Date#getHours`); that one `it` pins `process.env.TZ` for its
 * duration, the way `test/timezone.test.ts` does.
 */
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_FIVE_HOUR_KEY,
  CLAUDE_SEVEN_DAY_KEY,
  CODEX_FIVE_HOUR_LABEL,
  EXTRA_USAGE_KEY,
  LIMIT_LABEL_PREFIX,
  type Bucket,
  type SourceStatus
} from '../src/core/buckets';
import {
  CLAUDE_LOGGED_OUT_TEXT,
  CODEX_HOOKS_MISSING_TEXT,
  CODEX_HOOKS_STALE_TEXT,
  ELLIPSIS,
  HOOKS_MISSING_TEXT,
  HOOKS_STALE_TEXT,
  INTRO_HELLO_TEXT,
  INTRO_LOGIN_TEXT,
  SLEEP_TEXT,
  barkLabel,
  hookDoneText,
  hookWaitingText,
  nudgeText,
  updateText,
  type HookSource
} from '../src/core/bubble';
import {
  CARD_SIZES,
  RESET_STYLES,
  accountStatusLine,
  cardRowsFor,
  type CardRow,
  type CardSection,
  type CardSize
} from '../src/core/card-layout';
import { dogLabel, rowLabel, sectionLabel } from '../src/core/a11y-text';
import type { Expression } from '../src/core/expression';
import { updateMenuLine, type UpdateState } from '../src/core/update-check';
import { SERVICES, SERVICE_INFO } from '../src/core/services';
import {
  SHORTCUT_PRESETS,
  defaultHideShortcut,
  presetAccelerator,
  shortcutLabel,
  shortcutStatusLine,
  type ShortcutStatus
} from '../src/core/shortcuts';
import type { ServiceReport, UsageSnapshot } from '../src/core/usage';

describe('bubble.ts', () => {
  const SOURCES: readonly HookSource[] = ['claude', 'codex'];

  it('hookDoneText / hookWaitingText, for both hook sources', () => {
    const collected = Object.fromEntries(
      SOURCES.map((source) => [
        source,
        { done: hookDoneText(source), waiting: hookWaitingText(source) }
      ])
    );
    expect(collected).toMatchSnapshot();
  });

  it('the hooks-missing / hooks-stale / logged-out notices', () => {
    expect({
      HOOKS_MISSING_TEXT,
      HOOKS_STALE_TEXT,
      CODEX_HOOKS_MISSING_TEXT,
      CODEX_HOOKS_STALE_TEXT,
      CLAUDE_LOGGED_OUT_TEXT
    }).toMatchSnapshot();
  });

  it('first-launch greeting and the sleeping-dog text', () => {
    expect({ INTRO_HELLO_TEXT, INTRO_LOGIN_TEXT, SLEEP_TEXT, ELLIPSIS }).toMatchSnapshot();
  });

  it('updateText, for a few versions', () => {
    expect(['0.2.5', '1.0.0', '0.10.2-beta.1'].map((v) => updateText(v))).toMatchSnapshot();
  });

  it('barkLabel, for every rule in its docblock', () => {
    const collected = {
      claudeFiveHour: barkLabel({ service: 'claude', key: CLAUDE_FIVE_HOUR_KEY, label: '5-hour' }),
      claudeSevenDay: barkLabel({
        service: 'claude',
        key: CLAUDE_SEVEN_DAY_KEY,
        label: '7-day (all models)'
      }),
      claudeExtraUsage: barkLabel({ service: 'claude', key: EXTRA_USAGE_KEY, label: 'Extra usage' }),
      perModelWeeklyOpus: barkLabel({
        service: 'claude',
        key: 'seven_day_opus',
        label: `${LIMIT_LABEL_PREFIX}Opus`
      }),
      perModelWeeklyFable: barkLabel({
        service: 'claude',
        key: 'seven_day_fable',
        label: `${LIMIT_LABEL_PREFIX}Fable`
      }),
      perModelWeeklySonnet: barkLabel({
        service: 'claude',
        key: 'seven_day_sonnet',
        label: `${LIMIT_LABEL_PREFIX}Sonnet`
      }),
      // Not `LIMIT_LABEL_PREFIX`-prefixed, and not one of the three named keys:
      // falls through to the bucket's own label, unchanged.
      unknownClaudeLabel: barkLabel({
        service: 'claude',
        key: 'seven_day_haiku',
        label: 'Seven day haiku'
      }),
      codexFiveHour: barkLabel({ service: 'chatgpt', key: 'primary', label: CODEX_FIVE_HOUR_LABEL }),
      codexWeekly: barkLabel({ service: 'chatgpt', key: 'weekly', label: 'Codex weekly' }),
      codexCredits: barkLabel({ service: 'chatgpt', key: 'credits', label: 'Codex credits' })
    };
    expect(collected).toMatchSnapshot();
  });

  it('nudgeText, across the bark thresholds and the exhaustion edge', () => {
    const collected = {
      // The five `normal`-preset thresholds (see core/nudge.ts BARK_LEVELS).
      byThreshold: [80, 85, 90, 95, 100].map((pct) => nudgeText('Claude 5h', pct)),
      // The observed percentage is rounded, not the threshold that fired.
      roundedObservation: nudgeText('Claude 5h', 87.6),
      // The edge: fully exhausted, and a caller passing a non-finite reading.
      fullyExhausted: nudgeText('Codex 5h', 100),
      nonFinite: nudgeText('Codex 5h', Number.NaN),
      zero: nudgeText('Claude 7-day', 0)
    };
    expect(collected).toMatchSnapshot();
  });
});

describe('card-layout.ts — cardRowsFor', () => {
  // Fixed, and every fixture's `resetsAt` below is anchored to it — see the
  // file header for why that keeps `clock` and `countdown` identical here.
  const NOW = Date.parse('2026-09-19T12:00:00.000Z');
  const INTERVAL = 180_000;

  // Copied from test/card-layout.test.ts's own fixture builders, so this file
  // states a snapshot in the same shape that suite already asserts against.
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

  function snapshotFrom(
    claude: ServiceReport,
    chatgpt: ServiceReport,
    fetchedAt = new Date(NOW - 60_000).toISOString()
  ): UsageSnapshot {
    const buckets = [...claude.buckets, ...chatgpt.buckets];
    return {
      fetchedAt,
      services: {
        claude,
        chatgpt,
        // Unavailable, so the card draws no Cursor, Copilot or Gemini section
        // and every existing hunk of this snapshot stays exactly as it was.
        cursor: { buckets: [], status: 'unavailable', via: 'none', viaLabel: 'no source' },
        copilot: { buckets: [], status: 'unavailable', via: 'none', viaLabel: 'no source' },
        gemini: { buckets: [], status: 'unavailable', via: 'none', viaLabel: 'no source' }
      },
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

  // The same five real-shape fixtures test/card-layout.test.ts pins, plus the
  // pre-first-poll `null` state cardRowsFor also branches on.
  const FIXTURES: Readonly<Record<string, UsageSnapshot | null>> = {
    healthy: snapshotFrom(
      report({ buckets: [FIVE_HOUR, FABLE, SEVEN_DAY] }),
      report({ buckets: [CODEX], via: 'codex-cli', viaLabel: 'Codex CLI' })
    ),
    loginNeeded: snapshotFrom(
      report({ status: 'auth-needed', message: 'the Claude Code token has expired' }),
      report({ buckets: [CODEX], via: 'codex-cli', viaLabel: 'Codex CLI' })
    ),
    okButEmpty: snapshotFrom(report({ buckets: [] }), report({ buckets: [CODEX] })),
    unknowns: snapshotFrom(
      report({
        buckets: [
          bucket({
            id: 'claude.five_hour',
            key: 'five_hour',
            label: '5-hour',
            pct: null,
            resetsAt: null
          })
        ]
      }),
      report({ status: 'unavailable', via: 'none', viaLabel: 'no source' })
    ),
    stale: snapshotFrom(
      report({ buckets: [FIVE_HOUR] }),
      report({ buckets: [] }),
      new Date(NOW - 3 * INTERVAL).toISOString()
    ),
    never: null
  };

  /** Only the fields a reader ever sees — no widths, no bar-fill counts. */
  function pickRow(row: CardRow) {
    return { label: row.label, pctText: row.pctText, shared: row.shared, resetsText: row.resetsText };
  }

  function pickSection(section: CardSection) {
    return {
      service: section.service,
      sourceLine: section.sourceLine,
      statusLine: section.statusLine,
      ago: section.ago,
      rows: section.rows.map(pickRow)
    };
  }

  function pickCard(model: ReturnType<typeof cardRowsFor>) {
    return {
      header: model.header === null ? null : { title: model.header.title, ago: model.header.ago, stale: model.header.stale },
      sections: model.sections.map(pickSection),
      footer: model.footer === null ? null : { text: model.footer.text, stale: model.footer.stale }
    };
  }

  function grid(snapshot: UsageSnapshot | null) {
    const bySize: Record<CardSize, Record<string, unknown>> = { large: {}, medium: {}, small: {} };
    for (const size of CARD_SIZES) {
      for (const style of RESET_STYLES) {
        bySize[size][style] = pickCard(cardRowsFor(snapshot, size, NOW, 'en-GB', null, style));
      }
    }
    return bySize;
  }

  for (const [name, snapshot] of Object.entries(FIXTURES)) {
    it(`${name}: every size × every reset style`, () => {
      expect(grid(snapshot)).toMatchSnapshot();
    });
  }
});

describe('card-layout.ts — accountStatusLine', () => {
  it('every SourceStatus, for both services, with and without a message', () => {
    const statuses: readonly SourceStatus[] = [
      'ok',
      'auth-needed',
      'endpoint-changed',
      'rate-limited',
      'error',
      'unavailable'
    ];
    const forService = (service: (typeof SERVICES)[number]) =>
      Object.fromEntries(
        statuses.map((status) => [
          status,
          {
            withMessage: accountStatusLine(service, {
              buckets: [],
              status,
              via: 'x',
              viaLabel: 'x label',
              message: 'a provider message'
            }),
            withoutMessage: accountStatusLine(service, {
              buckets: [],
              status,
              via: 'x',
              viaLabel: 'x label'
            })
          }
        ])
      );
    const collected = {
      checking: accountStatusLine('claude', null),
      claude: forService('claude'),
      chatgpt: forService('chatgpt')
    };
    expect(collected).toMatchSnapshot();
  });
});

describe('a11y-text.ts', () => {
  const EXPRESSIONS: readonly Expression[] = [
    'happy',
    'neutral',
    'worried',
    'exhausted',
    'out',
    'confused'
  ];

  it('dogLabel, every mood × pct/bubble present or absent', () => {
    const collected = EXPRESSIONS.map((expression) => ({
      expression,
      bare: dogLabel(expression, null, null),
      withPct: dogLabel(expression, 87, null),
      withBubble: dogLabel(expression, null, 'Five-hour window is at 90%.'),
      withBoth: dogLabel(expression, 42.5, 'Codex done')
    }));
    expect(collected).toMatchSnapshot();
  });

  it('rowLabel, across kinds, the shared marker and a reset line', () => {
    const row = (over: Partial<CardRow> = {}): CardRow => ({
      kind: 'window',
      id: 'claude:five_hour',
      label: '5-hour',
      shared: false,
      pctText: '63%',
      bar: null,
      resetsText: null,
      ...over
    });
    const collected = {
      plain: rowLabel(row()),
      shared: rowLabel(row({ label: '7-day Fable', shared: true })),
      withReset: rowLabel(row({ resetsText: 'resets in 2h 14m' })),
      credits: rowLabel(row({ kind: 'credits', pctText: '1,240 left' })),
      money: rowLabel(row({ kind: 'money', pctText: '123 / 500 kr.  (25%)' })),
      tokens: rowLabel(row({ kind: 'tokens', pctText: '4,096 today' }))
    };
    expect(collected).toMatchSnapshot();
  });

  it('sectionLabel, with and without a status line, for both services', () => {
    const section = (over: Partial<CardSection> = {}): CardSection => ({
      service: 'claude',
      sourceLine: null,
      statusLine: null,
      rows: [],
      ago: null,
      ...over
    });
    const collected = {
      claudeNoStatus: sectionLabel(section()),
      claudeWithStatus: sectionLabel(section({ statusLine: 'login needed' })),
      chatgptNoStatus: sectionLabel(section({ service: 'chatgpt' })),
      chatgptWithStatus: sectionLabel(section({ service: 'chatgpt', statusLine: 'not logged in' }))
    };
    expect(collected).toMatchSnapshot();
  });
});

describe('update-check.ts — updateMenuLine', () => {
  it('every UpdateState kind the switch handles, with and without a cooldown', () => {
    // `failed` is the one state that formats a wall clock (`clockTime`), so
    // this one `it` pins the process time zone for its duration — the same
    // pattern test/timezone.test.ts uses — rather than leaving the snapshot to
    // depend on whatever zone it happens to run in.
    const originalTz = process.env['TZ'];
    process.env['TZ'] = 'UTC';
    try {
      const AT = Date.parse('2026-09-19T09:03:00.000Z');
      const states: Readonly<Record<string, UpdateState>> = {
        never: { kind: 'never' },
        upToDate: { kind: 'up-to-date', at: AT },
        available: {
          kind: 'available',
          version: '0.3.0',
          url: 'https://github.com/ViuMP/walder-releases/releases/tag/v0.3.0',
          at: AT
        },
        failed: { kind: 'failed', detail: 'HTTP 403', at: AT }
      };
      const collected = Object.fromEntries(
        Object.entries(states).map(([name, state]) => [
          name,
          { noCooldown: updateMenuLine(state, 0), cooldown: updateMenuLine(state, 42_000) }
        ])
      );
      expect(collected).toMatchSnapshot();
    } finally {
      if (originalTz === undefined) delete process.env['TZ'];
      else process.env['TZ'] = originalTz;
    }
  });
});

describe('services.ts', () => {
  it('SERVICE_INFO, verbatim', () => {
    expect(SERVICE_INFO).toMatchSnapshot();
  });
});

describe('shortcuts.ts', () => {
  it('every preset\'s accelerator, label and caveat, on darwin and elsewhere', () => {
    const platforms = ['darwin', 'win32'] as const;
    const collected: Record<string, unknown> = {};
    for (const platform of platforms) {
      collected[platform] = SHORTCUT_PRESETS.map((preset) => {
        const accelerator = presetAccelerator(preset, platform);
        return {
          id: preset.id,
          accelerator,
          label: shortcutLabel(accelerator, platform),
          caveat: preset.caveat
        };
      });
    }
    collected['defaultDarwin'] = defaultHideShortcut('darwin');
    collected['defaultOther'] = defaultHideShortcut('win32');
    expect(collected).toMatchSnapshot();
  });

  it('shortcutStatusLine, for every status', () => {
    const statuses: readonly ShortcutStatus[] = ['registered', 'in-use', 'invalid', 'unregistered'];
    const collected = Object.fromEntries(
      statuses.map((status) => [status, shortcutStatusLine(status, 'Control+Command+W', 'darwin')])
    );
    expect(collected).toMatchSnapshot();
  });
});

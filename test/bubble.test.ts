/**
 * Bubble wording and wrapping.
 *
 * The bubble lives inside a window whose size is fixed at creation — a
 * click-through window cannot grow on demand — so the text has to be made to
 * fit rather than being allowed to overflow, and beyond that the *window* is
 * widened for it up front (`bubbleColumnsNeeded` here feeds
 * `bubbleExtraPx` in `core/geometry.ts`). Ellipsising is the last resort, not
 * the first: at the smallest size "7-day (all models): 85% used" used to arrive
 * as "7-day (all mod…", which contains neither the window nor the number.
 */
import { describe, expect, it } from 'vitest';
import {
  BUG_REPORT_COPIED_TEXT,
  CLAUDE_LOGGED_OUT_TEXT,
  CODEX_HOOKS_MISSING_TEXT,
  CODEX_HOOKS_OUTDATED_TEXT,
  CODEX_HOOKS_STALE_TEXT,
  ELLIPSIS,
  HOOKS_MISSING_TEXT,
  HOOKS_OUTDATED_TEXT,
  HOOKS_STALE_TEXT,
  INTRO_HELLO_TEXT,
  INTRO_LOGIN_TEXT,
  barkLabel,
  bubbleShape,
  bubbleColumnsNeeded,
  bubbleReserveColumns,
  displayColumns,
  hookNoticesAnsweredBy,
  hooksOutdatedNotice,
  introHelloText,
  nudgeText,
  wrapBubbleText
} from '../src/core/bubble';
import {
  CODEX_CREDITS_KEY,
  CODEX_CREDITS_LABEL,
  EXTRA_USAGE_KEY,
  EXTRA_USAGE_LABEL,
  KNOWN,
  claudeLimitKey,
  parseClaudeLimits,
  withDerivedFableRow,
  type Bucket
} from '../src/core/buckets';
import { UP_TO_DATE_TEXT } from '../src/core/update-check';

describe('bubbleShape', () => {
  it('uses the thought bubble only for the sleeping acknowledgement', () => {
    expect(bubbleShape('sleepy')).toBe('thought');
    for (const kind of ['nudge', 'perk', 'waiting', 'update', 'none'] as const) {
      expect(bubbleShape(kind)).toBe('speech');
    }
  });
});

/**
 * The bubble's name for a row, which is **not** the card's (owner's decision,
 * 2026-09-15 — see `barkLabel`). The card is a table under a service heading;
 * a bubble is one line with no heading and no neighbours, so it names the
 * service and drops the words the layout was carrying.
 *
 * Each row below is stated as the bucket a parser really produces, so that a
 * renamed key or label shows up here as a bubble that stopped matching rather
 * than as a rule quietly falling through to the card's wording.
 */
describe('barkLabel', () => {
  const row = (over: Partial<Bucket> & Pick<Bucket, 'key' | 'label'>): Bucket => ({
    id: `claude.${over.key}`,
    service: 'claude',
    pct: 90,
    resetsAt: null,
    priority: 0,
    ...over
  });

  it('names the service on the two Claude pools, and shortens both', () => {
    // `5h` rather than `5-hour` so it reads as a pair with `Codex 5h`; the
    // pool's `(all models)` was the card disambiguating it from the rows below
    // it, and a bubble has no rows below it.
    expect(barkLabel(row({ key: 'five_hour', label: KNOWN['five_hour'] as string }))).toBe(
      'Claude 5h'
    );
    expect(barkLabel(row({ key: 'seven_day', label: KNOWN['seven_day'] as string }))).toBe(
      'Claude 7-day'
    );
  });

  it('leads with the model on every per-model weekly row', () => {
    expect(barkLabel(row({ key: 'seven_day_fable', label: '7-day Fable' }))).toBe('Fable weekly');
    expect(barkLabel(row({ key: 'seven_day_opus', label: '7-day Opus' }))).toBe('Opus weekly');
    expect(barkLabel(row({ key: 'seven_day_sonnet', label: '7-day Sonnet' }))).toBe(
      'Sonnet weekly'
    );
  });

  /**
   * The derived mirror is the weekly pool shown under the name the owner
   * recognises (`withDerivedFableRow`). It never barks — `barkableBuckets`
   * filters it out — but it is in the **Show in overview** menu and in a
   * restored snapshot, so its wording has to be right rather than accidental.
   */
  it('names the derived Fable mirror the same as a real Fable row', () => {
    const derived = withDerivedFableRow([
      row({ key: 'seven_day', label: KNOWN['seven_day'] as string })
    ]).find((bucket) => bucket.key === 'seven_day_fable');
    expect(derived?.derived).toBe(true);
    expect(barkLabel(derived as Bucket)).toBe('Fable weekly');
  });

  /**
   * And the route that actually reports Fable on the owner's account: a
   * `limits[]` entry carrying the dashboard's own display name, keyed by
   * `claudeLimitKey`. Its label is built from the payload's string, so this is
   * the one rule that has to survive a name Anthropic invents tomorrow.
   */
  it('names a limits[]-sourced Fable row the same way', () => {
    const [fable] = parseClaudeLimits({
      limits: [
        { percent: 81, resets_at: null, scope: { model: { id: null, display_name: 'Fable' } } }
      ]
    });
    expect(fable?.key).toBe(claudeLimitKey('Fable'));
    expect(fable?.label).toBe('7-day Fable');
    expect(barkLabel(fable as Bucket)).toBe('Fable weekly');
  });

  it('pairs the two services\' pools under one word', () => {
    // `Extra usage` is claude.ai's name for the *setting*; the bubble is about
    // the spend, and `Codex credits` already read that way.
    expect(
      barkLabel(row({ key: EXTRA_USAGE_KEY, label: EXTRA_USAGE_LABEL, kind: 'money' }))
    ).toBe('Claude credits');
    expect(
      barkLabel({
        service: 'chatgpt',
        key: CODEX_CREDITS_KEY,
        label: CODEX_CREDITS_LABEL,
        kind: 'credits'
      })
    ).toBe('Codex credits');
  });

  it('shortens the Codex 5-hour window and leaves the weekly one alone', () => {
    const codex = (label: string, key = 'codex_primary'): string =>
      barkLabel({ service: 'chatgpt', key, label });
    expect(codex('Codex 5-hour')).toBe('Codex 5h');
    // The legacy and walked routes key the same window differently; the label
    // is this file's own word for it either way.
    expect(codex('Codex 5-hour', 'primary')).toBe('Codex 5h');
    expect(codex('Codex weekly', 'codex_secondary')).toBe('Codex weekly');
  });

  it('falls through to the bucket\'s own label for anything it has no rule for', () => {
    // A window either provider adds tomorrow still barks, under whatever the
    // parser called it — including a Claude key that is not a pool and whose
    // label does not wear the weekly prefix.
    expect(barkLabel(row({ key: 'codex_spend_limit', label: 'Codex credit limit' }))).toBe(
      'Codex credit limit'
    );
    expect(barkLabel(row({ key: 'amber_ladder', label: 'Amber ladder' }))).toBe('Amber ladder');
    expect(barkLabel({ service: 'chatgpt', key: 'codex_3h', label: 'Codex 3h' })).toBe('Codex 3h');
    // Not a label any parser produces, and the guard matters: the prefix rule
    // must not turn a bare `7-day ` into a bubble that names no model at all.
    expect(barkLabel(row({ key: 'seven_day_odd', label: '7-day ' }))).toBe('7-day ');
  });
});

describe('nudgeText', () => {
  it('matches the wording in the design, for each bubble label', () => {
    expect(nudgeText('Claude 5h', 80)).toBe('Claude 5h: 80% used');
    expect(nudgeText('Claude 7-day', 85)).toBe('Claude 7-day: 85% used');
    expect(nudgeText('Codex 5h', 90)).toBe('Codex 5h: 90% used');
    expect(nudgeText('Fable weekly', 95)).toBe('Fable weekly: 95% used');
  });

  /**
   * The *observed* percentage, rounded — not the threshold that fired. Saying
   * "80% used" when the reading is 87 % would understate the warning.
   */
  it('rounds the observed percentage', () => {
    expect(nudgeText('Claude 5h', 82.4)).toBe('Claude 5h: 82% used');
    expect(nudgeText('Claude 5h', 99.6)).toBe('Claude 5h: 100% used');
  });

  it('survives a non-finite percentage', () => {
    expect(nudgeText('Claude 5h', Number.NaN)).toBe('Claude 5h: 0% used');
  });
});

describe('wrapBubbleText', () => {
  it('leaves text that fits on one line alone', () => {
    expect(wrapBubbleText('woof', 20, 2)).toEqual(['woof']);
    expect(wrapBubbleText('?', 20, 2)).toEqual(['?']);
  });

  it('wraps on whitespace, greedily', () => {
    expect(wrapBubbleText('5-hour: 80% used', 10, 2)).toEqual(['5-hour:', '80% used']);
  });

  it('collapses runs of whitespace and trims', () => {
    expect(wrapBubbleText('  woof   woof  ', 20, 2)).toEqual(['woof woof']);
  });

  it('returns nothing at all for empty input', () => {
    expect(wrapBubbleText('', 20, 2)).toEqual([]);
    expect(wrapBubbleText('   ', 20, 2)).toEqual([]);
  });

  it('ellipsises the last line when the text does not fit', () => {
    const lines = wrapBubbleText('7-day (all models): 85% used', 10, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith(ELLIPSIS)).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(10);
  });

  it('hard-splits a word longer than the line', () => {
    expect(wrapBubbleText('abcdefghij', 4, 3)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('hard-splits after flushing what was already on the line', () => {
    expect(wrapBubbleText('ab cdefghij', 4, 4)).toEqual(['ab', 'cdef', 'ghij']);
  });

  it('never exceeds the column budget, whatever it is given', () => {
    const text = '7-day (all models): 85% used';
    for (let cols = 1; cols <= 40; cols++) {
      for (let rows = 1; rows <= 3; rows++) {
        const lines = wrapBubbleText(text, cols, rows);
        expect(lines.length, `${cols}x${rows}`).toBeLessThanOrEqual(rows);
        for (const line of lines) expect(line.length, `${cols}x${rows}`).toBeLessThanOrEqual(cols);
      }
    }
  });

  it('degrades to a bare ellipsis in a single column', () => {
    expect(wrapBubbleText('5-hour: 80% used', 1, 1)).toEqual([ELLIPSIS]);
  });

  it('treats nonsense budgets as one column and one line', () => {
    expect(wrapBubbleText('woof', 0, 0)).toEqual([ELLIPSIS]);
    expect(wrapBubbleText('woof', -5, -5)).toEqual([ELLIPSIS]);
  });
});

describe('bubbleColumnsNeeded', () => {
  it('is the narrowest width that shows the whole text', () => {
    // The defining property, checked directly against the wrap: at the answer
    // the text is intact, and one column narrower it is not.
    for (const text of [
      'woof',
      '5-hour: 80% used',
      '7-day (all models): 85% used',
      'Codex 5-hour: 90% used',
      UP_TO_DATE_TEXT,
      // The two first-launch beats. They are the longest sentences Walder ever
      // says, so they are the ones that prove the width arithmetic still holds
      // when the answer is two lines rather than one.
      INTRO_HELLO_TEXT,
      INTRO_LOGIN_TEXT,
      introHelloText('win32'),
      BUG_REPORT_COPIED_TEXT,
      '…zzz'
    ]) {
      const cols = bubbleColumnsNeeded(text);
      const lines = wrapBubbleText(text, cols, 2);
      expect(lines.join(' '), text).toBe(text.split(/\s+/u).join(' '));
      expect(lines.length, text).toBeLessThanOrEqual(2);

      if (cols > 1) {
        const tighter = wrapBubbleText(text, cols - 1, 2);
        expect(tighter.join(' '), `${text} is not minimal`).not.toBe(text);
      }
    }
  });

  it('is zero for nothing to say', () => {
    expect(bubbleColumnsNeeded('')).toBe(0);
    expect(bubbleColumnsNeeded('   ')).toBe(0);
  });

  it('never returns a width that would split a word', () => {
    // A hard-split word is as unreadable as an ellipsised one, so the answer is
    // at least as wide as the longest word.
    const text = '7-day (all models): 85% used';
    const longest = text.split(' ').reduce((most, word) => Math.max(most, word.length), 0);
    expect(bubbleColumnsNeeded(text)).toBeGreaterThanOrEqual(longest);
  });

  it('needs fewer columns when it may use more lines', () => {
    const text = '7-day (all models): 85% used';
    expect(bubbleColumnsNeeded(text, 2)).toBeLessThan(bubbleColumnsNeeded(text, 1));
    expect(bubbleColumnsNeeded(text, 1)).toBe(text.length);
  });

  it('handles a single unbreakable word longer than any line', () => {
    expect(bubbleColumnsNeeded('abcdefghij', 2)).toBe(10);
  });

  it('asks for the whole sentence when only one line is allowed', () => {
    // What `main/behaviour.ts` asks for since 0.2.5: the window is widened for a
    // one-line fit, so the renderer may still wrap to two lines when its own
    // measurement is wider than the estimate — but it can never run out of
    // columns and ellipsise. `test/geometry.test.ts` holds the table of every
    // text this has to be true for.
    const cols = bubbleColumnsNeeded(UP_TO_DATE_TEXT, 1);
    expect(cols).toBe(UP_TO_DATE_TEXT.length);
    expect(wrapBubbleText(UP_TO_DATE_TEXT, cols, 1)).toEqual([UP_TO_DATE_TEXT]);
  });

  it('fits the logged-out notice in no more room than the widest one already shown', () => {
    // `INTRO_HELLO_TEXT` is the longest sentence Walder ever says (see the
    // table above); a notice that stayed within that bound could never be the
    // one that finally needs the window widened.
    const cols = bubbleColumnsNeeded(CLAUDE_LOGGED_OUT_TEXT, 1);
    expect(cols).toBe(CLAUDE_LOGGED_OUT_TEXT.length);
    expect(cols).toBeLessThanOrEqual(bubbleColumnsNeeded(INTRO_HELLO_TEXT, 1));
  });

  it('fits the bug-report clipboard notice in no more room than the hello', () => {
    expect(bubbleColumnsNeeded(BUG_REPORT_COPIED_TEXT, 1)).toBeLessThanOrEqual(
      bubbleColumnsNeeded(INTRO_HELLO_TEXT, 1)
    );
  });
});

describe('introHelloText', () => {
  it('points at the menu bar on macOS and the tray everywhere else', () => {
    // Windows has no menu bar; the first-run hello said so on every OS until
    // 2026-11-13.
    expect(introHelloText('darwin')).toBe(INTRO_HELLO_TEXT);
    for (const platform of ['win32', 'linux']) {
      expect(introHelloText(platform)).toBe('Hello. Click the bone in your tray.');
      expect(introHelloText(platform).length).toBeLessThanOrEqual(INTRO_HELLO_TEXT.length);
    }
  });
});

describe('display columns: what the wrap counts in, for every script', () => {
  it('counts Latin one per character, Han two, a Devanagari cluster one, isolates none', () => {
    expect(displayColumns('Claude 5h: 87% used')).toBe(19);
    expect(displayColumns('已用')).toBe(4);
    // न + ् + ह + ी: one conjunct syllable with its vowel sign, read as one.
    expect(displayColumns('न्ही')).toBeLessThanOrEqual(2);
    // Fewer columns than code units: marks and viramas have no column of their own.
    expect(displayColumns('हिन्दी')).toBeLessThan('हिन्दी'.length);
    expect(displayColumns('\u2068Alt+Shift+W\u2069')).toBe(11);
    expect(displayColumns('')).toBe(0);
  });

  it('widens for Devanagari only: every other script reserves exactly the columns it needs', () => {
    for (const text of ['Claude 5h: 87% used', 'Claude 5小时：已用 87%', 'Walder 0.3.2 est disponible', '']) {
      for (const lines of [1, 2]) expect(bubbleReserveColumns(text, lines), text).toBe(bubbleColumnsNeeded(text, lines));
    }
    const hindi = 'आपके पास नवीनतम संस्करण है';
    expect(bubbleReserveColumns(hindi, 1)).toBeGreaterThan(bubbleColumnsNeeded(hindi, 1));
  });

  it('never cuts inside a grapheme cluster', () => {
    const hindi = 'आपका उपयोग सीमा के पास है';
    for (let cols = 1; cols <= 12; cols++) {
      const lines = wrapBubbleText(hindi, cols, 20);
      expect(lines.join(' ').replace(/\s+/g, '')).toBe(hindi.replace(/\s+/g, ''));
      for (const line of lines) {
        // A line never starts with a combining mark or virama, which would mean a cluster was split.
        expect(line, `${cols}: ${line}`).not.toMatch(/^[\u093E-\u094D\u0900-\u0903]/u);
      }
    }
  });

  it('wraps an unspaced Chinese sentence by character, within the column budget', () => {
    const text = 'Claude 5小时：已用 87%';
    const lines = wrapBubbleText('已用完本周的全部额度请稍后再试', 8, 4);
    expect(lines.length).toBe(4);
    for (const line of lines) expect(displayColumns(line)).toBeLessThanOrEqual(8);
    expect(lines.join('')).toBe('已用完本周的全部额度请稍后再试');
    // One line fits it exactly; two lines need about half.
    expect(bubbleColumnsNeeded(text, 1)).toBe(displayColumns(text));
    expect(bubbleColumnsNeeded(text, 2)).toBeLessThan(displayColumns(text));
  });

  it('never splits a Latin run inside a word that holds Han', () => {
    const word = '小狗Walder已经完成';
    for (let cols = 6; cols <= 12; cols++) {
      const lines = wrapBubbleText(word, cols, 10);
      expect(lines.join(''), `${cols}`).toBe(word);
      expect(lines.some((line) => line.includes('Walder')), `${cols}: ${lines.join(' | ')}`).toBe(true);
      for (const line of lines) expect(displayColumns(line)).toBeLessThanOrEqual(cols);
    }
    // After a word already on the line, too.
    expect(wrapBubbleText('ok 小狗Walder完成', 8, 10)).toEqual(['ok 小狗', 'Walder完', '成']);
    // The narrowest bubble still holds the name on one line.
    expect(bubbleColumnsNeeded('Claude已完成', 3)).toBeGreaterThanOrEqual(6);
    // A run longer than a whole line is still cut, rather than overflow.
    expect(wrapBubbleText('已Abcdefghij', 4, 10).every((line) => displayColumns(line) <= 4)).toBe(true);
  });
});

/**
 * The "Update … hooks" bubble (owner decision 2026-11-20): once per Walder
 * version per tool, and never ahead of a missing, mismatch or no-listener
 * notice.
 */
/**
 * Which launch notices a hook write makes false (Mac QA 2026-11-20): after
 * Install or Update, "Install … hooks" stayed up until a pet cleared it.
 */
describe('hookNoticesAnsweredBy', () => {
  it('is the three hook notices of that tool after an install or update', () => {
    expect(hookNoticesAnsweredBy('claude', false)).toEqual([
      HOOKS_MISSING_TEXT,
      HOOKS_STALE_TEXT,
      HOOKS_OUTDATED_TEXT
    ]);
    expect(hookNoticesAnsweredBy('codex', false)).toEqual([
      CODEX_HOOKS_MISSING_TEXT,
      CODEX_HOOKS_STALE_TEXT,
      CODEX_HOOKS_OUTDATED_TEXT
    ]);
  });

  it('is nothing after a removal, which makes "Install … hooks" true again', () => {
    expect(hookNoticesAnsweredBy('claude', true)).toEqual([]);
    expect(hookNoticesAnsweredBy('codex', true)).toEqual([]);
  });
});

describe('hooksOutdatedNotice', () => {
  const outdated = { installedPort: 47823, boundPort: 47823, outdated: true, saidFor: null };
  const current = { installedPort: 47823, boundPort: 47823, outdated: false, saidFor: null };
  type State = Parameters<typeof hooksOutdatedNotice>[0]['claude'];
  const ask = (claude: State, codex: State, appVersion = '0.3.1', otherNoticeSaid = false) =>
    hooksOutdatedNotice({ claude, codex, appVersion, otherNoticeSaid });

  it('is said once for the version, not again on the next launch of it', () => {
    expect(ask(outdated, current)).toBe('claude');
    expect(ask({ ...outdated, saidFor: '0.3.1' }, current)).toBeNull();
  });

  it('is said again under a later Walder if the hooks are still outdated', () => {
    expect(ask({ ...outdated, saidFor: '0.3.1' }, current, '0.3.2')).toBe('claude');
    // A garbled record costs one bubble rather than silencing it for good.
    expect(ask({ ...outdated, saidFor: 'garbage' }, current)).toBe('claude');
  });

  it('is never said when the hooks are up to date', () => {
    expect(ask(current, current)).toBeNull();
    expect(ask({ ...current, outdated: undefined }, current)).toBeNull();
  });

  it('stands back for a no-listener, mismatch or missing notice', () => {
    expect(ask({ ...outdated, boundPort: null }, current)).toBeNull();
    expect(ask({ ...outdated, boundPort: 47824 }, current)).toBeNull();
    expect(ask({ ...outdated, installedPort: null }, current)).toBeNull();
    // A missing or mismatch notice said this launch, for either tool.
    expect(ask(outdated, outdated, '0.3.1', true)).toBeNull();
  });

  it('keeps Claude and Codex apart, one bubble per launch', () => {
    expect(ask(current, outdated)).toBe('codex');
    // Both outdated: Claude this launch, Codex the next (only Claude is recorded).
    expect(ask(outdated, outdated)).toBe('claude');
    expect(ask({ ...outdated, saidFor: '0.3.1' }, outdated)).toBe('codex');
    expect(ask({ ...outdated, saidFor: '0.3.1' }, { ...outdated, saidFor: '0.3.1' })).toBeNull();
    // Codex already told for this version does not stop Claude.
    expect(ask(outdated, { ...outdated, saidFor: '0.3.1' })).toBe('claude');
  });

  it('is worded as the tray item it points at', () => {
    expect(HOOKS_OUTDATED_TEXT).toBe('Update Claude Code hooks');
    expect(CODEX_HOOKS_OUTDATED_TEXT).toBe('Update Codex hooks');
  });
});

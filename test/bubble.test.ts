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
  ELLIPSIS,
  bubbleShape,
  bubbleColumnsNeeded,
  nudgeText,
  wrapBubbleText
} from '../src/core/bubble';
import { UP_TO_DATE_TEXT } from '../src/core/update-check';

describe('bubbleShape', () => {
  it('uses the thought bubble only for the sleeping acknowledgement', () => {
    expect(bubbleShape('sleepy')).toBe('thought');
    for (const kind of ['nudge', 'perk', 'waiting', 'update', 'none'] as const) {
      expect(bubbleShape(kind)).toBe('speech');
    }
  });
});

describe('nudgeText', () => {
  it('matches the wording in the design, for each provider label', () => {
    expect(nudgeText('5-hour', 80)).toBe('5-hour: 80% used');
    expect(nudgeText('7-day (all models)', 85)).toBe('7-day (all models): 85% used');
    expect(nudgeText('Codex 5-hour', 90)).toBe('Codex 5-hour: 90% used');
  });

  /**
   * The *observed* percentage, rounded — not the threshold that fired. Saying
   * "80% used" when the reading is 87 % would understate the warning.
   */
  it('rounds the observed percentage', () => {
    expect(nudgeText('5-hour', 82.4)).toBe('5-hour: 82% used');
    expect(nudgeText('5-hour', 99.6)).toBe('5-hour: 100% used');
  });

  it('survives a non-finite percentage', () => {
    expect(nudgeText('5-hour', Number.NaN)).toBe('5-hour: 0% used');
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
});

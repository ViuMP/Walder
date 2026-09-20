/**
 * The words a screen reader is given (`src/core/a11y-text.ts`).
 *
 * These are the only description of Walder that exists for somebody who cannot
 * see him, and they are invisible to everybody who can: nothing on screen
 * changes when a label goes wrong, no screenshot catches it, and the renderers
 * that use it cannot be tested at all (no jsdom under vitest here). So every
 * sentence the module can produce is written out below rather than derived —
 * a test that rebuilt the string from the same pieces would agree with any bug
 * in the building.
 */
import { describe, expect, it } from 'vitest';
import { dogLabel, rowLabel, sectionLabel } from '../src/core/a11y-text';
import type { Expression } from '../src/core/expression';
import type { CardRow, CardRowKind, CardSection } from '../src/core/card-layout';

/** Every mood, and the word it is read as. */
const MOODS: readonly (readonly [Expression, string])[] = [
  ['happy', 'happy'],
  ['neutral', 'fine'],
  ['worried', 'worried'],
  ['exhausted', 'exhausted'],
  ['out', 'out of Claude time'],
  ['confused', 'confused, no number to show']
];

function row(over: Partial<CardRow> = {}): CardRow {
  return {
    kind: 'window',
    id: 'claude:five_hour',
    label: '5-hour',
    shared: false,
    pctText: '63%',
    bar: null,
    resetsText: null,
    ...over
  };
}

function section(over: Partial<CardSection> = {}): CardSection {
  return { service: 'claude', sourceLine: null, statusLine: null, rows: [], ago: null, ...over };
}

describe('dogLabel', () => {
  it.each(MOODS)('names the mood for %s', (expression, word) => {
    expect(dogLabel(expression, null, null)).toBe(`Walder, ${word}.`);
  });

  it.each(MOODS)('adds the 5-hour number for %s when there is one', (expression, word) => {
    expect(dogLabel(expression, 87, null)).toBe(
      `Walder, ${word}. Claude 5-hour 87% used.`
    );
  });

  it.each(MOODS)('adds the bubble for %s, verbatim', (expression, word) => {
    // Verbatim because a bark is already a sentence written for a person; a
    // second phrasing here would be a second copy of every string in
    // `core/bubble.ts` to keep in step.
    expect(dogLabel(expression, null, 'Five-hour window is at 90%.')).toBe(
      `Walder, ${word}. Five-hour window is at 90%.`
    );
  });

  it.each(MOODS)('says all three for %s when all three are known', (expression, word) => {
    expect(dogLabel(expression, 87, 'Woof.')).toBe(
      `Walder, ${word}. Claude 5-hour 87% used. Woof.`
    );
  });

  it('says nothing about a percentage it does not have', () => {
    // The whole reason `confused` has words of its own: no number is a fact
    // about Walder, and "0%" would be a claim about the owner's account.
    expect(dogLabel('confused', null, null)).toBe('Walder, confused, no number to show.');
    expect(dogLabel('confused', null, null)).not.toContain('%');
  });

  it('ignores a non-finite percentage the way the face does', () => {
    expect(dogLabel('happy', Number.NaN, null)).toBe('Walder, happy.');
    expect(dogLabel('happy', Number.POSITIVE_INFINITY, null)).toBe('Walder, happy.');
  });

  it('rounds like the card does', () => {
    // Same arithmetic as `formatPct`, so the spoken number and the drawn number
    // are never one apart on the same snapshot.
    expect(dogLabel('worried', 86.4, null)).toContain('86% used');
    expect(dogLabel('worried', 86.5, null)).toContain('87% used');
    expect(dogLabel('happy', 0, null)).toContain('0% used');
  });

  it('treats an empty bubble as no bubble', () => {
    // A cleared bubble arrives as an empty string; a trailing space read aloud
    // is a pause with nothing after it.
    expect(dogLabel('happy', null, '')).toBe('Walder, happy.');
  });

  it('names the weekly posture without changing the face or 5-hour number', () => {
    expect(dogLabel('worried', 87, null, 'lie')).toBe(
      'Walder, worried. Claude 5-hour 87% used. Lying down.'
    );
    expect(dogLabel('worried', 87, null, 'lie_down')).toBe(
      'Walder, worried. Claude 5-hour 87% used. Lying down, head on paws.'
    );
  });
});

describe('rowLabel', () => {
  const KINDS: readonly CardRowKind[] = ['window', 'money', 'credits', 'tokens'];

  it.each(KINDS)('reads the label and the value for a %s row', (kind) => {
    // `pctText` is used exactly as the card shows it, whatever the kind — the
    // column already holds `63%`, `1,240 left` or `123 / 500 kr.  (25%)`.
    expect(rowLabel(row({ kind, pctText: '1,240 left' }))).toBe('5-hour, 1,240 left');
  });

  it('says a derived row is the same pool', () => {
    expect(rowLabel(row({ label: '7-day Fable', shared: true }))).toBe(
      '7-day Fable, 63%, shared pool'
    );
  });

  it('adds the reset when there is one', () => {
    expect(rowLabel(row({ resetsText: 'resets in 2h 14m' }))).toBe(
      '5-hour, 63%, resets in 2h 14m'
    );
  });

  it('says nothing at all about a reset there is none of', () => {
    expect(rowLabel(row())).toBe('5-hour, 63%');
  });

  it('puts the shared note before the reset, as the eye takes them', () => {
    expect(rowLabel(row({ shared: true, resetsText: 'resets Thursday' }))).toBe(
      '5-hour, 63%, shared pool, resets Thursday'
    );
  });
});

describe('sectionLabel', () => {
  it('uses the menu-bar name, not the card heading', () => {
    // `CLAUDE` is shouted for the design's sake; a reader would spell it out or
    // say it louder, and neither is what the heading means.
    expect(sectionLabel(section())).toBe('Claude');
    expect(sectionLabel(section({ service: 'chatgpt' }))).toBe('ChatGPT');
  });

  it('carries the status line, which is why an empty section exists at all', () => {
    expect(sectionLabel(section({ statusLine: 'Claude: login needed' }))).toBe(
      'Claude, Claude: login needed'
    );
  });
});

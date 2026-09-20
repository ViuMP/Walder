import { describe, expect, it } from 'vitest';

import { expressionFor, pickAnimation, type Expression } from '../src/core/expression.js';

describe('expressionFor', () => {
  it.each([
    [null, 'confused'],
    [0, 'happy'],
    [49.9, 'happy'],
    [50, 'neutral'],
    [79.9, 'neutral'],
    [80, 'worried'],
    [94.9, 'worried'],
    [95, 'exhausted'],
    [99.9, 'exhausted'],
    [100, 'out'],
    [120, 'out']
  ] as const)('maps %s to %s', (pct, expected) => {
    expect(expressionFor(pct)).toBe(expected);
  });

  it('treats a non-finite number as unknown', () => {
    expect(expressionFor(Number.NaN)).toBe('confused');
    expect(expressionFor(Number.POSITIVE_INFINITY)).toBe('confused');
  });
});

/**
 * `pickAnimation` is a CASCADE, not a table, and that is the thing worth pinning.
 *
 * The art and the code advance separately: the sheet may ship five
 * per-expression idle loops, or one, or none, and Walder has to look right in
 * every case rather than going blank when a name is missing. Every test below is
 * one rung of that cascade — and the reason they exist at all is that the rungs
 * are invisible in a running app: a sheet missing `idle_worried` produces a dog
 * who breathes neutrally instead of an error anybody would notice.
 */
describe('pickAnimation', () => {
  /** A sheet that has every name — the full v2 art. */
  const everything = () => true;
  /** A sheet with nothing but the two the contract guarantees. */
  const bare = (name: string): boolean => name === 'idle' || name === 'sleep';

  const MOODS: readonly Expression[] = ['neutral', 'happy', 'worried', 'exhausted'];

  it('sleeps in the sleeping box, whatever the face says', () => {
    // The box wins over the expression: a dog curled up in the tiny fullscreen
    // window has no face on show, and there is no `sleep_worried` in the art.
    for (const expression of ['neutral', 'worried', 'out', 'confused'] as const) {
      expect(pickAnimation('sleep', expression, everything), expression).toBe('sleep');
    }
  });

  it('falls out of the sleeping box when the art has no sleep animation', () => {
    // The placeholder-sheet case, and a sheet mid-redraw. Better a standing dog
    // than a frozen one.
    expect(pickAnimation('sleep', 'neutral', (name) => name === 'idle')).toBe('idle');
  });

  it('uses the matching held lie stage when the optional posture art exists', () => {
    expect(pickAnimation('lie', 'worried', (name) => name === 'idle' || name === 'lie')).toBe('lie');
    expect(
      pickAnimation('lie_down', 'worried', (name) => name === 'idle' || name === 'lie' || name === 'lie_down')
    ).toBe('lie_down');
    expect(pickAnimation('lie_down', 'worried', (name) => name === 'idle' || name === 'lie')).toBe('lie');
    expect(pickAnimation('lie', 'worried', bare)).toBe('idle');
  });

  it('prefers the per-expression idle loop when the art has one', () => {
    for (const expression of MOODS) {
      expect(pickAnimation('stand', expression, everything), expression).toBe(
        `idle_${expression}`
      );
    }
  });

  it('gives out and confused their own whole-body animations', () => {
    // They are states, not faces: "no allowance left" is a dog flat on the floor
    // and "no idea" is a head-tilt, neither of which is a breathing loop. So they
    // are reached even by a sheet with no `idle_out`/`idle_confused`.
    const noMoodIdles = (name: string): boolean =>
      !name.startsWith('idle_') && name !== 'idle_neutral';
    expect(pickAnimation('stand', 'out', noMoodIdles)).toBe('out');
    expect(pickAnimation('stand', 'confused', noMoodIdles)).toBe('confused');
  });

  it('prefers idle_out over out when the art draws one', () => {
    // The rung order matters: an `idle_out` would be a *loop* the artist drew
    // deliberately, and it should win over the generic state animation.
    expect(pickAnimation('stand', 'out', everything)).toBe('idle_out');
  });

  it('ends at plain idle, which the sheet contract guarantees', () => {
    for (const expression of [...MOODS, 'out', 'confused'] as const) {
      expect(pickAnimation('stand', expression, bare), expression).toBe('idle');
    }
  });

  it('ends at idle even for a box the art knows nothing about', () => {
    // `pickAnimation` takes the box as a string rather than a union on purpose —
    // the sheet names its own boxes — so an unrecognised one must degrade rather
    // than fall through to `undefined`.
    expect(pickAnimation('perched', 'neutral', bare)).toBe('idle');
  });

  it('never returns a name the sheet does not have', () => {
    // The invariant the renderer depends on: it looks the result up in
    // `sheet.animations` and draws nothing if it is missing. Asserted across
    // every box, every expression and three shapes of sheet.
    const sheets: Array<[string, (name: string) => boolean]> = [
      ['full', everything],
      ['bare', bare],
      ['no mood idles', (name) => !name.startsWith('idle_')]
    ];
    for (const [label, has] of sheets) {
      for (const box of ['stand', 'sleep', 'lie', 'lie_down']) {
        for (const expression of [...MOODS, 'out', 'confused'] as const) {
          const chosen = pickAnimation(box, expression, has);
          expect(has(chosen), `${label}/${box}/${expression} -> ${chosen}`).toBe(true);
        }
      }
    }
  });
});

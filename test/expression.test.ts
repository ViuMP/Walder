import { describe, expect, it } from 'vitest';

import { expressionFor } from '../src/core/expression.js';

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

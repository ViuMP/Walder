/**
 * `keyTreeLines`: the types-only key tree `npm run probe -- --keys` prints for
 * a provider whose parser does not exist yet.
 *
 * What it protects: the `--keys` promise. Every line is a key name and a type,
 * so a run pasted into a chat carries no number, no boolean and no string from
 * the owner's account — and a long camelCase key is spaced so the log
 * redactor's 20-character rule does not hide it.
 */
import { describe, expect, it } from 'vitest';
import { keyTreeLines } from '../src/core/usage-shape';

describe('keyTreeLines', () => {
  it('prints nested key names and types, indented, and nothing else', () => {
    const lines = keyTreeLines({
      billingCycleEnd: '2026-10-01T00:00:00Z',
      planUsage: { autoPercentUsed: 61.7, remainingBonus: true },
      autoBucketModels: ['a', 'b'],
      events: [{ totalCents: 5 }],
      empty: [],
      nothing: null
    });
    expect(lines).toEqual([
      'billing Cycle End: string',
      'plan Usage: object',
      '  auto Percent Used: number',
      '  remaining Bonus: boolean',
      'auto Bucket Models: array of string',
      'events: array of object',
      '  total Cents: number',
      'empty: array of nothing',
      'nothing: null'
    ]);
    const text = lines.join('\n');
    expect(text).not.toContain('61.7');
    expect(text).not.toContain('true');
    expect(text).not.toContain('2026');
  });

  it('spaces a long camelCase key past the redactor\'s 20-character rule', () => {
    const [line] = keyTreeLines({ autoModelSelectedDisplayMessage: 'x' });
    expect(line).toBe('auto Model Selected Display Message: string');
    expect(/[A-Za-z0-9+_=-]{20,}/.test(line ?? '')).toBe(false);
  });

  it('stops at the depth cap and rejects a non-object payload', () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    const lines = keyTreeLines(deep);
    expect(lines.at(-1)).toBe('        e: object');
    expect(keyTreeLines([1, 2])).toEqual(['(payload is array(2), not an object)']);
  });
});

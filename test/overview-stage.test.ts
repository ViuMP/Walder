/**
 * The Walder window's Overview stages Model, Colour and Card size until Apply
 * (`core/overview-stage.ts`): what Apply writes, which coats a model offers,
 * and which coat a model change picks.
 */
import { describe, expect, it } from 'vitest';
import {
  characterOfCoat,
  coatForCharacter,
  coatsOf,
  effective,
  pendingChanges,
  type CoatInfo
} from '../src/core/overview-stage';

const coats: CoatInfo[] = [
  { id: 'golden', character: 'walder' },
  { id: 'silver-dapple', character: 'walder' },
  { id: 'yuna-grey-tabby', character: 'yuna' },
  { id: 'yuna-calico', character: 'yuna' }
];
const saved = { palette: 'golden', cardSize: 'large' as const };

describe('the Overview stage', () => {
  it('writes only staged keys that differ from what is saved', () => {
    expect(pendingChanges({}, saved)).toEqual({});
    expect(pendingChanges({ palette: 'golden', cardSize: 'large' }, saved)).toEqual({});
    expect(pendingChanges({ palette: 'yuna-calico' }, saved)).toEqual({ palette: 'yuna-calico' });
    expect(pendingChanges({ palette: 'golden', cardSize: 'small' }, saved)).toEqual({ cardSize: 'small' });
  });

  it('shows the staged value over the saved one', () => {
    expect(effective({ cardSize: 'medium' }, saved)).toEqual({ palette: 'golden', cardSize: 'medium' });
  });

  it("offers only the chosen model's coats", () => {
    expect(coatsOf('yuna', coats).map((c) => c.id)).toEqual(['yuna-grey-tabby', 'yuna-calico']);
    expect(characterOfCoat('silver-dapple', coats)).toBe('walder');
    expect(characterOfCoat('no-such-coat', coats)).toBe('walder');
  });

  it("keeps the coat on a model change if it is that model's, else picks the model's first", () => {
    expect(coatForCharacter('yuna', 'golden', coats)).toBe('yuna-grey-tabby');
    expect(coatForCharacter('yuna', 'yuna-calico', coats)).toBe('yuna-calico');
    expect(coatForCharacter('walder', 'yuna-calico', coats)).toBe('golden');
    expect(coatForCharacter('yuna', 'golden', coats.slice(0, 2))).toBeNull();
  });
});

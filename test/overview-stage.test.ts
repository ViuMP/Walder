/**
 * The Walder window's Overview stages Model, Colour and Card size until Apply
 * (`core/overview-stage.ts`): what Apply writes, which coats a model offers,
 * and which coat a model change picks.
 */
import { describe, expect, it } from 'vitest';
import {
  characterOfCoat,
  coatForCharacter,
  anyConnected,
  coatShortLabel,
  coatsOf,
  effective,
  serviceStatusWord,
  swatchColor,
  pendingChanges,
  type CoatInfo
} from '../src/core/overview-stage';

const coats: CoatInfo[] = [
  { id: 'golden', character: 'walder' },
  { id: 'silver-dapple', character: 'walder' },
  { id: 'yuna-grey-tabby', character: 'yuna' },
  { id: 'yuna-calico', character: 'yuna' }
];
const saved = { palette: 'golden', size: 'medium' as const, cardSize: 'large' as const };

describe('the Overview stage', () => {
  it('writes only staged keys that differ from what is saved', () => {
    expect(pendingChanges({}, saved)).toEqual({});
    expect(pendingChanges({ palette: 'golden', cardSize: 'large' }, saved)).toEqual({});
    expect(pendingChanges({ palette: 'yuna-calico' }, saved)).toEqual({ palette: 'yuna-calico' });
    expect(pendingChanges({ palette: 'golden', cardSize: 'small' }, saved)).toEqual({ cardSize: 'small' });
    expect(pendingChanges({ size: 'medium' }, saved)).toEqual({});
    expect(pendingChanges({ size: 'large' }, saved)).toEqual({ size: 'large' });
  });

  it('shows the staged value over the saved one', () => {
    expect(effective({ cardSize: 'medium' }, saved)).toEqual({
      palette: 'golden',
      size: 'medium',
      cardSize: 'medium'
    });
    expect(effective({ size: 'small' }, saved).size).toBe('small');
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

describe('the Overview swatches and services bar', () => {
  it('colours a swatch with the coat tone painted most in the idle frame', () => {
    const colors = { a: '#FFF3D6', m: '#E3A454', o: '#7A451A', q: '#5F3415' };
    expect(swatchColor(['.mmm.', 'qmaq.'], colors)).toBe('#E3A454');
    expect(swatchColor(['ooo', 'omm'], colors)).toBe('#7A451A');
    // The outline is not coat, however much of it there is.
    expect(swatchColor(['qqqq', 'qqa.'], colors)).toBe('#FFF3D6');
    expect(swatchColor(['....'], colors)).toBe('#E3A454');
    expect(swatchColor(['aa'], {})).toBe('#8d8880');
  });

  it('names a coat without its character', () => {
    expect(coatShortLabel('Yuna calico', 'yuna')).toBe('Calico');
    expect(coatShortLabel('Yuna grey tabby', 'yuna')).toBe('Grey tabby');
    expect(coatShortLabel('Golden', 'walder')).toBe('Golden');
  });

  it('says Connected only for a service that answered', () => {
    expect(serviceStatusWord('ok')).toBe('Connected');
    expect(serviceStatusWord('auth-needed')).toBe('Log in');
    expect(serviceStatusWord('unavailable')).toBe('Not set up');
    expect(anyConnected(['unavailable', 'ok'])).toBe(true);
    expect(anyConnected(['unavailable', 'error'])).toBe(false);
    expect(anyConnected([])).toBe(false);
  });
});

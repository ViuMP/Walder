/**
 * IPC payload validation. The renderer is untrusted: these validators are the
 * only thing between a malformed message and `win.setPosition` /
 * `win.setIgnoreMouseEvents`, so each rejection path is pinned down here.
 */
import { describe, expect, it } from 'vitest';
import {
  CH,
  CLICK_SLOP_PX,
  SCALE_BY_SIZE,
  SIZE_NAMES,
  isSizeName,
  parseDragMovePayload,
  parseHitPayload
} from '../src/main/ipc';

describe('channel table', () => {
  it('prefixes every channel with walder:', () => {
    for (const channel of Object.values(CH)) expect(channel.startsWith('walder:')).toBe(true);
  });

  it('has no duplicate channel names', () => {
    const names = Object.values(CH);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('parseHitPayload', () => {
  it('accepts either boolean', () => {
    expect(parseHitPayload({ inside: true })).toEqual({ inside: true });
    expect(parseHitPayload({ inside: false })).toEqual({ inside: false });
  });

  it('rejects truthy non-booleans rather than coercing them', () => {
    // Coercion here would turn a bug into a permanently click-swallowing window.
    expect(parseHitPayload({ inside: 1 })).toBeNull();
    expect(parseHitPayload({ inside: 'true' })).toBeNull();
    expect(parseHitPayload({ inside: null })).toBeNull();
  });

  it('rejects a missing field, a non-object and an array', () => {
    expect(parseHitPayload({})).toBeNull();
    expect(parseHitPayload(null)).toBeNull();
    expect(parseHitPayload(undefined)).toBeNull();
    expect(parseHitPayload('inside')).toBeNull();
    expect(parseHitPayload([true])).toBeNull();
  });
});

describe('parseDragMovePayload', () => {
  it('accepts finite deltas, including negatives and zero', () => {
    expect(parseDragMovePayload({ dxScreen: 10, dyScreen: -20 })).toEqual({
      dxScreen: 10,
      dyScreen: -20
    });
    expect(parseDragMovePayload({ dxScreen: 0, dyScreen: 0 })).toEqual({
      dxScreen: 0,
      dyScreen: 0
    });
  });

  it('rounds sub-pixel deltas to whole screen pixels', () => {
    expect(parseDragMovePayload({ dxScreen: 10.6, dyScreen: -3.2 })).toEqual({
      dxScreen: 11,
      dyScreen: -3
    });
  });

  it('rejects NaN and infinities', () => {
    // NaN would reach setPosition and leave the window unmovable.
    expect(parseDragMovePayload({ dxScreen: Number.NaN, dyScreen: 0 })).toBeNull();
    expect(parseDragMovePayload({ dxScreen: 0, dyScreen: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseDragMovePayload({ dxScreen: Number.NEGATIVE_INFINITY, dyScreen: 0 })).toBeNull();
  });

  it('rejects absurd magnitudes', () => {
    expect(parseDragMovePayload({ dxScreen: 1e9, dyScreen: 0 })).toBeNull();
    expect(parseDragMovePayload({ dxScreen: 0, dyScreen: -1e9 })).toBeNull();
  });

  it('rejects non-numbers and malformed shapes', () => {
    expect(parseDragMovePayload({ dxScreen: '10', dyScreen: 0 })).toBeNull();
    expect(parseDragMovePayload({ dxScreen: 10 })).toBeNull();
    expect(parseDragMovePayload(null)).toBeNull();
    expect(parseDragMovePayload([1, 2])).toBeNull();
  });
});

describe('size names', () => {
  it('recognises exactly the three sizes', () => {
    for (const size of SIZE_NAMES) expect(isSizeName(size)).toBe(true);
    expect(isSizeName('huge')).toBe(false);
    expect(isSizeName(undefined)).toBe(false);
    expect(isSizeName(2)).toBe(false);
  });

  it('maps each size to its documented scale', () => {
    expect(SCALE_BY_SIZE).toEqual({ small: 2, medium: 3, large: 4 });
  });
});

describe('click slop', () => {
  it('is a small positive pixel count', () => {
    expect(CLICK_SLOP_PX).toBe(4);
  });
});

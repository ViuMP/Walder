/**
 * IPC payload validation. The renderer is untrusted: these validators are the
 * only thing between a malformed message and `win.setPosition` /
 * `win.setIgnoreMouseEvents`, so each rejection path is pinned down here.
 */
import { describe, expect, it } from 'vitest';
import {
  CH,
  CLICK_SLOP_PX,
  PANEL_MAX_HEIGHT,
  PANEL_MIN_HEIGHT,
  SCALE_BY_SIZE,
  SERVICE_NAMES,
  SIZE_NAMES,
  isServiceName,
  isSizeName,
  parseDragMovePayload,
  parseHitPayload,
  parseHoverEnterPayload,
  parsePanelSizePayload,
  parseServicePayload,
  type FacingPayload,
  type ModePayload
} from '../src/main/ipc';
import * as ipc from '../src/main/ipc';
import { ART_FACING, isFacing } from '../src/core/facing';
import { CARD_SIZES, cardWidthFor, isCardSize } from '../src/core/card-layout';

describe('channel table', () => {
  it('prefixes every channel with walder:', () => {
    for (const channel of Object.values(CH)) expect(channel.startsWith('walder:')).toBe(true);
  });

  it('has no duplicate channel names', () => {
    const names = Object.values(CH);
    expect(new Set(names).size).toBe(names.length);
  });
});

/*
 * `facing` is the one main -> renderer payload with a validator, because it is
 * the one whose wrong value is *invisible*: a dog silently drawn the wrong way
 * round looks like art, not like a bug. So the renderer checks it with `isFacing`
 * and keeps its current facing on anything else — asserted in `facing.test.ts`;
 * what belongs here is that the channel and the two payload shapes exist and
 * agree with each other.
 */
describe('facing over IPC', () => {
  it('has its own channel', () => {
    expect(CH.facingSet).toBe('walder:facing:set');
  });

  it('rides along with mode, so the first paint is already the right way round', () => {
    // Structural, not behavioural: `mode` is what `settings:get` returns, and a
    // renderer that had to wait for a second message would draw one frame facing
    // the wrong way on launch.
    const mode: ModePayload = { scale: 2, box: 'stand', facing: ART_FACING, hidden: false };
    expect(isFacing(mode.facing)).toBe(true);
  });

  it('carries nothing but the direction on a turn', () => {
    const payload: FacingPayload = { facing: 'right' };
    expect(isFacing(payload.facing)).toBe(true);
    expect(Object.keys(payload)).toEqual(['facing']);
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
    // Capped at 3x by the owner's decision at the 2026-09-08 design gate: the
    // 4x dog was too big for a desktop. `medium` (2x) is the default.
    expect(SCALE_BY_SIZE).toEqual({ small: 1, medium: 2, large: 3 });
  });

  it('never offers a scale above 3', () => {
    for (const scale of Object.values(SCALE_BY_SIZE)) expect(scale).toBeLessThanOrEqual(3);
  });
});

describe('click slop', () => {
  it('is a small positive pixel count', () => {
    expect(CLICK_SLOP_PX).toBe(4);
  });
});

describe('parseHoverEnterPayload', () => {
  const rect = { x: 1200, y: 700, width: 96, height: 80 };

  it('accepts a sane sprite rect, rounding to whole screen pixels', () => {
    expect(parseHoverEnterPayload({ spriteRectScreen: rect })).toEqual({
      spriteRectScreen: rect
    });
    expect(
      parseHoverEnterPayload({
        spriteRectScreen: { x: 1200.4, y: 699.6, width: 96.2, height: 80.5 }
      })
    ).toEqual({ spriteRectScreen: { x: 1200, y: 700, width: 96, height: 81 } });
  });

  it('accepts negative coordinates', () => {
    // A display to the left of the primary one has negative x, and the dog is
    // allowed to live there.
    expect(parseHoverEnterPayload({ spriteRectScreen: { ...rect, x: -900 } })).toEqual({
      spriteRectScreen: { ...rect, x: -900 }
    });
  });

  it('rejects a degenerate rect rather than clamping it', () => {
    // A zero-size rect describes nothing; placing a panel against it would put
    // the card somewhere arbitrary, which is harder to notice than no card.
    expect(parseHoverEnterPayload({ spriteRectScreen: { ...rect, width: 0 } })).toBeNull();
    expect(parseHoverEnterPayload({ spriteRectScreen: { ...rect, height: -10 } })).toBeNull();
  });

  it('rejects NaN, infinities and absurd magnitudes', () => {
    expect(parseHoverEnterPayload({ spriteRectScreen: { ...rect, x: Number.NaN } })).toBeNull();
    expect(
      parseHoverEnterPayload({ spriteRectScreen: { ...rect, y: Number.POSITIVE_INFINITY } })
    ).toBeNull();
    expect(parseHoverEnterPayload({ spriteRectScreen: { ...rect, width: 1e9 } })).toBeNull();
  });

  it('rejects malformed shapes', () => {
    expect(parseHoverEnterPayload({})).toBeNull();
    expect(parseHoverEnterPayload({ spriteRectScreen: null })).toBeNull();
    expect(parseHoverEnterPayload({ spriteRectScreen: [1, 2, 3, 4] })).toBeNull();
    expect(parseHoverEnterPayload({ spriteRectScreen: { x: '1', y: 1, width: 1, height: 1 } })).toBeNull();
    expect(parseHoverEnterPayload(null)).toBeNull();
  });
});

describe('parseServicePayload', () => {
  it('accepts exactly the two services', () => {
    expect(parseServicePayload({ service: 'claude' })).toEqual({ service: 'claude' });
    expect(parseServicePayload({ service: 'chatgpt' })).toEqual({ service: 'chatgpt' });
  });

  it('rejects anything else without defaulting', () => {
    // This channel opens a browser window on a real login page; an unrecognised
    // service must never fall through to "the first one".
    expect(parseServicePayload({ service: 'gemini' })).toBeNull();
    expect(parseServicePayload({ service: 'Claude' })).toBeNull();
    expect(parseServicePayload({ service: 0 })).toBeNull();
    expect(parseServicePayload({})).toBeNull();
    expect(parseServicePayload(null)).toBeNull();
    expect(parseServicePayload('claude')).toBeNull();
  });

  it('recognises exactly the two service names', () => {
    for (const service of SERVICE_NAMES) expect(isServiceName(service)).toBe(true);
    expect(isServiceName('copilot')).toBe(false);
    expect(isServiceName(undefined)).toBe(false);
  });
});

describe('parsePanelSizePayload', () => {
  it('accepts a sane height, rounded up to a whole pixel', () => {
    expect(parsePanelSizePayload({ height: 260 })).toEqual({ height: 260 });
    expect(parsePanelSizePayload({ height: 260.2 })).toEqual({ height: 261 });
  });

  it('rejects heights outside the sane range', () => {
    expect(parsePanelSizePayload({ height: PANEL_MIN_HEIGHT - 1 })).toBeNull();
    expect(parsePanelSizePayload({ height: PANEL_MAX_HEIGHT + 1 })).toBeNull();
    expect(parsePanelSizePayload({ height: 0 })).toBeNull();
    expect(parsePanelSizePayload({ height: -100 })).toBeNull();
  });

  it('rejects NaN and non-numbers', () => {
    expect(parsePanelSizePayload({ height: Number.NaN })).toBeNull();
    expect(parsePanelSizePayload({ height: '260' })).toBeNull();
    expect(parsePanelSizePayload({})).toBeNull();
    expect(parsePanelSizePayload(null)).toBeNull();
  });

  it('accepts the smallest card this renderer can produce', () => {
    /*
     * The floor is 24, not the 40 it was, and the difference is a real bug: a
     * Small card with one window row measures about 41 px, and this validator
     * *drops* an out-of-range payload rather than clamping it — so a floor
     * above the smallest real card does not shrink the window a little too
     * much, it leaves it at `PANEL_INITIAL_HEIGHT` (220 px) with a 41 px card
     * floating in the top of it and no error anywhere.
     */
    expect(PANEL_MIN_HEIGHT).toBe(24);
    expect(parsePanelSizePayload({ height: 41 })).toEqual({ height: 41 });
    expect(parsePanelSizePayload({ height: PANEL_MIN_HEIGHT })).toEqual({
      height: PANEL_MIN_HEIGHT
    });
    expect(parsePanelSizePayload({ height: PANEL_MAX_HEIGHT })).toEqual({
      height: PANEL_MAX_HEIGHT
    });
  });
});

describe('the panel width comes from the card size', () => {
  it('has no `PANEL_WIDTH` of its own any more', () => {
    // It would have been a fourth opinion about how wide the card is, beside
    // the three that are real. `hover-panel.ts` asks `cardWidthFor`.
    expect('PANEL_WIDTH' in ipc).toBe(false);
  });

  it('gives every card size a width, and Large the old design width', () => {
    expect(cardWidthFor('large')).toBe(300);
    for (const size of CARD_SIZES) {
      expect(isCardSize(size)).toBe(true);
      expect(cardWidthFor(size)).toBeGreaterThan(0);
    }
  });
});

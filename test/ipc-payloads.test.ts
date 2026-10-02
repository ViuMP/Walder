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
  parseBarkSoundPayload,
  parseHitPayload,
  parseHoverEnterPayload,
  parsePanelSizePayload,
  parseServicePayload,
  type FacingPayload,
  type ModePayload,
  type ResetStylePayload
} from '../src/main/ipc';
import * as ipc from '../src/main/ipc';
import { ART_FACING, isFacing } from '../src/core/facing';
import {
  parseSessionsPayload,
  type SessionEntry,
  type SessionsPayload
} from '../src/core/sessions';
import { CARD_SIZES, RESET_STYLES, cardWidthFor, isCardSize } from '../src/core/card-layout';

describe('channel table', () => {
  it('prefixes every channel with walder:', () => {
    for (const channel of Object.values(CH)) expect(channel.startsWith('walder:')).toBe(true);
  });

  it('has no duplicate channel names', () => {
    const names = Object.values(CH);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('parseBarkSoundPayload', () => {
  it('accepts only an explicit boolean', () => {
    expect(parseBarkSoundPayload({ barkSound: true })).toEqual({ barkSound: true });
    expect(parseBarkSoundPayload({ barkSound: false })).toEqual({ barkSound: false });
    for (const bad of [{}, { barkSound: 1 }, { barkSound: 'true' }, null, []]) {
      expect(parseBarkSoundPayload(bad)).toBeNull();
    }
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
    const mode: ModePayload = {
      scale: 2,
      box: 'stand',
      facing: ART_FACING,
      hidden: false,
      still: false
    };
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
  /** The ink rect in window coordinates, inside a Small 88 x 100 window. */
  const rect = { x: 8, y: 20, width: 72, height: 60 };
  const viewport = { width: 88, height: 100 };
  const enter = (r: unknown, v: unknown = viewport): unknown => ({
    spriteRectWindow: r,
    viewport: v
  });

  it('accepts a sane window rect and viewport, rounding to whole pixels', () => {
    expect(parseHoverEnterPayload(enter(rect))).toEqual({ spriteRectWindow: rect, viewport });
    expect(
      parseHoverEnterPayload(
        enter({ x: 8.4, y: 19.6, width: 72.2, height: 60.5 }, { width: 87.6, height: 100.2 })
      )
    ).toEqual({
      spriteRectWindow: { x: 8, y: 20, width: 72, height: 61 },
      viewport: { width: 88, height: 100 }
    });
  });

  it('accepts negative coordinates', () => {
    // The bound is a sanity limit, not a layout rule: placement only adds the
    // window's position, and a sign changes nothing about that.
    expect(parseHoverEnterPayload(enter({ ...rect, x: -4 }))).toEqual({
      spriteRectWindow: { ...rect, x: -4 },
      viewport
    });
  });

  it('rejects a degenerate rect or viewport rather than clamping it', () => {
    // A zero-size rect describes nothing; placing a panel against it would put
    // the card somewhere arbitrary, which is harder to notice than no card.
    expect(parseHoverEnterPayload(enter({ ...rect, width: 0 }))).toBeNull();
    expect(parseHoverEnterPayload(enter({ ...rect, height: -10 }))).toBeNull();
    // And the viewport decides whether the rect is converted at all.
    expect(parseHoverEnterPayload(enter(rect, { width: 0, height: 100 }))).toBeNull();
    expect(parseHoverEnterPayload(enter(rect, { width: 88, height: -1 }))).toBeNull();
  });

  it('rejects NaN, infinities and absurd magnitudes', () => {
    expect(parseHoverEnterPayload(enter({ ...rect, x: Number.NaN }))).toBeNull();
    expect(parseHoverEnterPayload(enter({ ...rect, y: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(parseHoverEnterPayload(enter({ ...rect, width: 1e9 }))).toBeNull();
    expect(parseHoverEnterPayload(enter(rect, { width: Number.NaN, height: 100 }))).toBeNull();
    expect(parseHoverEnterPayload(enter(rect, { width: 88, height: 1e9 }))).toBeNull();
  });

  it('rejects malformed shapes', () => {
    expect(parseHoverEnterPayload({})).toBeNull();
    expect(parseHoverEnterPayload(enter(null))).toBeNull();
    expect(parseHoverEnterPayload(enter([1, 2, 3, 4]))).toBeNull();
    expect(parseHoverEnterPayload(enter({ x: '1', y: 1, width: 1, height: 1 }))).toBeNull();
    expect(parseHoverEnterPayload(enter(rect, null))).toBeNull();
    expect(parseHoverEnterPayload({ spriteRectWindow: rect })).toBeNull();
    expect(parseHoverEnterPayload(null)).toBeNull();
  });

  it('no longer accepts the old screen-coordinate payload', () => {
    // 0.2.8 QA, row 5.9h: a screen rect from the renderer is the bug itself.
    expect(parseHoverEnterPayload({ spriteRectScreen: rect })).toBeNull();
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
    expect(parseServicePayload({ service: 'ollama' })).toBeNull();
    expect(parseServicePayload({ service: 'Claude' })).toBeNull();
    expect(parseServicePayload({ service: 0 })).toBeNull();
    expect(parseServicePayload({})).toBeNull();
    expect(parseServicePayload(null)).toBeNull();
    expect(parseServicePayload('claude')).toBeNull();
  });

  it('recognises exactly the service names there are', () => {
    for (const service of SERVICE_NAMES) expect(isServiceName(service)).toBe(true);
    // A name that is on the roadmap and is not a service yet — the point is
    // that the guard reads `SERVICES` and not a plausible-looking string.
    // (It was `'gemini'` until Gemini became one, 2026-09-21.)
    expect(isServiceName('ollama')).toBe(false);
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

/*
 * The reset wording rides its own channel for the same reason the card size
 * does: it changes nothing but text, and must not travel down `usage:update`,
 * which also feeds the bark machine and the dog's face.
 */
describe('reset style over IPC', () => {
  it('has its own channel, distinct from the card size\u2019s', () => {
    expect(CH.resetStyleSet).toBe('walder:resetStyle:set');
    expect(CH.resetStyleSet).not.toBe(CH.cardSizeSet);
  });

  it('offers exactly the two wordings, and its validator accepts both', () => {
    expect([...RESET_STYLES]).toEqual(['clock', 'countdown']);
    for (const style of RESET_STYLES) expect(ipc.isResetStyle(style)).toBe(true);
    for (const junk of ['relative', '', null, undefined, 1]) {
      expect(ipc.isResetStyle(junk), String(junk)).toBe(false);
    }
  });

  it('is shaped as the payload the panel validates', () => {
    const payload: ResetStylePayload = { resetStyle: 'countdown' };
    expect(ipc.isResetStyle(payload.resetStyle)).toBe(true);
  });
});

describe('the panel width comes from the card size', () => {
  it('has no `PANEL_WIDTH` of its own any more', () => {
    // It would have been a fourth opinion about how wide the card is, beside
    // the three that are real. `hover-panel.ts` asks `cardWidthFor`.
    expect('PANEL_WIDTH' in ipc).toBe(false);
  });

  it('gives every card size a width, and Large the one `card-layout` pins', () => {
    expect(cardWidthFor('large')).toBe(380);
    for (const size of CARD_SIZES) {
      expect(isCardSize(size)).toBe(true);
      expect(cardWidthFor(size)).toBeGreaterThan(0);
    }
  });
});

/*
 * The sessions payload travels main -> renderer, and is nonetheless validated
 * on arrival — by the same function main built it with, which is why that
 * function lives in `core/sessions.ts` and is re-exported here. The cases that
 * matter are in `test/sessions.test.ts`; what belongs in this file is that the
 * channel exists, that the re-export is the same function, and that the shape
 * the panel sees is the shape main sends.
 */
describe('sessions over IPC', () => {
  it('has its own channel, off the usage path', () => {
    expect(CH.sessionsSet).toBe('walder:sessions:set');
    expect(CH.sessionsSet).not.toBe(CH.usageUpdate);
  });

  it('re-exports the one validator rather than keeping a second opinion', () => {
    expect(ipc.parseSessionsPayload).toBe(parseSessionsPayload);
  });

  it('accepts the payload main sends, and drops a list with one bad entry', () => {
    const sessions: SessionEntry[] = [
      { source: 'codex', key: '4321', cwd: '~/code', pid: 4321, state: 'working', at: 1 }
    ];
    const payload: SessionsPayload = { sessions };
    expect(ipc.parseSessionsPayload(payload)).toEqual(payload);
    expect(ipc.parseSessionsPayload({ sessions: [...sessions, { ...sessions[0], state: 'idle' }] })).toBeNull();
    expect(ipc.parseSessionsPayload({ sessions: [{ ...sessions[0], cwd: 'x'.repeat(1025) }] })).toBeNull();
    expect(ipc.parseSessionsPayload({ sessions: 'none' })).toBeNull();
  });
});

/**
 * The size-change handshake's rules (`core/size-change`).
 *
 * Windows QA row 3.3: a tray Size change resizes the window before the renderer
 * can have painted at the new size, and for a frame or two Windows shows the
 * old-size dog at the new window's top-left. The fix of 2026-11-15 covered the
 * gap with window opacity and was measured on 2026-11-16 not to hold. The
 * design tested here blanks the renderer's picture *before* the resize and
 * draws him again only on a paint at the new scale in the new viewport.
 *
 * Every decision in that design is a pure function, because neither side that
 * acts on them can be driven here: the renderer has no DOM under vitest, and
 * what Windows composites cannot be asserted at all. So this file pins
 *  - the match rule, at whole and at fractional scale factors, against each
 *    half-updated paint that must not end the blank, and after a bubble or a
 *    box change has resized the window again;
 *  - the renderer's state machine: when it acknowledges, when it draws again,
 *    and that it does each at most once per change;
 *  - main's decision whether to defer a pick, and which report it acts on;
 *  - and, as text, that `renderer/overlay.ts` calls the rules where the design
 *    says it does.
 * None of it says the picture on screen is right. That has to be looked at.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SIZE_BLANK_GRACE_MS,
  SIZE_BLANK_MAX_MS,
  SIZE_BLANK_PAINTS,
  SIZE_VIEW_SLACK,
  acceptsBlankReport,
  endsSettling,
  nearer,
  onSizeMessage,
  onSizePaint,
  onSizeTimeout,
  paintedAtSize,
  parseSizeChangeMessage,
  parseSizeReport,
  resizedMessage,
  sizeRequest,
  type SettlingSize,
  type SizeBlank,
  type SizeTarget
} from '../src/core/size-change';

/** Medium and Large at 100 %, as the window is sized there. */
const MEDIUM = { scale: 2, width: 176, height: 183 } as const;
const LARGE = { scale: 3, width: 264, height: 274 } as const;

/** Medium -> Large: what main reports after the resize. */
const GROW: SizeTarget = {
  scale: LARGE.scale,
  from: { width: MEDIUM.width, height: MEDIUM.height },
  to: { width: LARGE.width, height: LARGE.height }
};
/** Large -> Medium. */
const SHRINK: SizeTarget = {
  scale: MEDIUM.scale,
  from: { width: LARGE.width, height: LARGE.height },
  to: { width: MEDIUM.width, height: MEDIUM.height }
};

const BLANK = { phase: 'blank', id: 1 } as const;
const RESIZED = { phase: 'resized', id: 1, ...GROW } as const;

describe('the constants', () => {
  it('lets the renderer outlast main by at least a quarter of a second', () => {
    // Main may take the whole grace to resize; the renderer then needs frames
    // to follow. A ceiling shorter than that would draw him before the resize.
    expect(SIZE_BLANK_MAX_MS).toBeGreaterThanOrEqual(SIZE_BLANK_GRACE_MS + 250);
  });

  it('asks for more than one blank paint', () => {
    expect(SIZE_BLANK_PAINTS).toBeGreaterThanOrEqual(2);
    expect(Number.isInteger(SIZE_BLANK_PAINTS)).toBe(true);
  });

  it('gives a viewport two points of slack, far under any size step', () => {
    expect(SIZE_VIEW_SLACK).toBe(2);
    // The smallest step there is, Small <-> Medium on the 72 px box, is 78
    // points of height: the old viewport is rejected only while the slack is
    // well under half of it.
    expect(SIZE_VIEW_SLACK * 4).toBeLessThan(78 / 2);
  });
});

describe('parseSizeChangeMessage', () => {
  it('accepts a blank and drops anything extra', () => {
    expect(parseSizeChangeMessage({ ...BLANK, extra: 1 })).toEqual(BLANK);
  });

  it('accepts a resized and drops anything extra', () => {
    expect(
      parseSizeChangeMessage({
        ...RESIZED,
        from: { ...GROW.from, x: 5 },
        extra: 1
      })
    ).toEqual(RESIZED);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'blank'],
    ['a number', 1],
    ['an array', [BLANK]],
    ['no phase', { id: 1 }],
    ['an unknown phase', { phase: 'shown', id: 1 }],
    ['no id', { phase: 'blank' }],
    ['a zero id', { phase: 'blank', id: 0 }],
    ['a negative id', { phase: 'blank', id: -1 }],
    ['a fractional id', { phase: 'blank', id: 1.5 }],
    ['a NaN id', { phase: 'blank', id: Number.NaN }],
    ['an infinite id', { phase: 'blank', id: Number.POSITIVE_INFINITY }],
    ['a numeric-string id', { phase: 'blank', id: '1' }],
    ['a resized with no scale', { ...RESIZED, scale: undefined }],
    ['a resized with a zero scale', { ...RESIZED, scale: 0 }],
    ['a resized with a negative scale', { ...RESIZED, scale: -3 }],
    ['a resized with a NaN scale', { ...RESIZED, scale: Number.NaN }],
    ['a resized with an infinite scale', { ...RESIZED, scale: Number.POSITIVE_INFINITY }],
    ['a resized with no from', { phase: 'resized', id: 1, scale: 3, to: GROW.to }],
    ['a resized with no to', { phase: 'resized', id: 1, scale: 3, from: GROW.from }],
    ['a resized whose from is an array', { ...RESIZED, from: [176, 183] }],
    ['a resized with a zero width', { ...RESIZED, to: { width: 0, height: 274 } }],
    ['a resized with a negative height', { ...RESIZED, to: { width: 264, height: -274 } }],
    ['a resized with a NaN width', { ...RESIZED, from: { width: Number.NaN, height: 183 } }],
    [
      'a resized with an infinite height',
      { ...RESIZED, from: { width: 176, height: Number.POSITIVE_INFINITY } }
    ],
    ['a resized with a missing height', { ...RESIZED, to: { width: 264 } }]
  ])('rejects %s', (_label, raw) => {
    expect(parseSizeChangeMessage(raw)).toBeNull();
  });
});

describe('parseSizeReport', () => {
  const SHOWN = { phase: 'shown', id: 4, matched: true, width: 264, height: 275 } as const;

  it('accepts a blank and drops anything extra', () => {
    expect(parseSizeReport({ phase: 'blank', id: 4, scale: 9 })).toEqual({ phase: 'blank', id: 4 });
  });

  it('accepts a shown, matched or not, and drops anything extra', () => {
    expect(parseSizeReport({ ...SHOWN, extra: 1 })).toEqual(SHOWN);
    expect(parseSizeReport({ ...SHOWN, matched: false })).toEqual({ ...SHOWN, matched: false });
  });

  it.each([
    ['null', null],
    ['a string', 'blank'],
    ['an array', [SHOWN]],
    ['an unknown phase', { phase: 'resized', id: 4 }],
    ['no id', { phase: 'blank' }],
    ['a zero id', { phase: 'blank', id: 0 }],
    ['a negative id', { phase: 'shown', id: -4, matched: true, width: 264, height: 275 }],
    ['a fractional id', { phase: 'blank', id: 0.5 }],
    ['a shown with no matched', { phase: 'shown', id: 4, width: 264, height: 275 }],
    ['a shown with a truthy matched', { ...SHOWN, matched: 1 }],
    ['a shown with a string matched', { ...SHOWN, matched: 'true' }],
    ['a shown with a zero width', { ...SHOWN, width: 0 }],
    ['a shown with a negative height', { ...SHOWN, height: -275 }],
    ['a shown with a NaN width', { ...SHOWN, width: Number.NaN }],
    ['a shown with an infinite height', { ...SHOWN, height: Number.POSITIVE_INFINITY }],
    ['a shown with no height', { phase: 'shown', id: 4, matched: true, width: 264 }]
  ])('rejects %s', (_label, raw) => {
    expect(parseSizeReport(raw)).toBeNull();
  });
});

describe('nearer', () => {
  it('counts an equal distance as near, so from === to matches', () => {
    expect(nearer(220, 264, 176)).toBe(true);
    expect(nearer(176, 176, 176)).toBe(true);
    expect(nearer(300, 176, 176)).toBe(true);
  });

  it('is false for a value at from when to is elsewhere', () => {
    expect(nearer(176, 264, 176)).toBe(false);
    expect(nearer(264, 176, 264)).toBe(false);
  });

  it('is true a point or two off to', () => {
    for (const d of [-2, -1, 1, 2]) {
      expect(nearer(264 + d, 264, 176), `grow ${d}`).toBe(true);
      expect(nearer(176 + d, 176, 264), `shrink ${d}`).toBe(true);
    }
  });

  it('is false a point or two off from', () => {
    for (const d of [-2, -1, 1, 2]) {
      expect(nearer(176 + d, 264, 176), `grow ${d}`).toBe(false);
    }
  });

  it('is true within the slack of to, wherever from is', () => {
    // After a follow-up `resized` an axis can be back within a point or two
    // of where it started (262 before, 264 now). Such an axis says nothing,
    // and a viewport rounded a point towards `from` must not read as old.
    for (const from of [264, 263, 262, 261, 260, 265, 266, 267, 268, 88, 504]) {
      for (const d of [-SIZE_VIEW_SLACK, -1.6, -1, -0.4, 0, 0.4, 1, 1.6, SIZE_VIEW_SLACK]) {
        expect(nearer(264 + d, 264, from), `from ${from}, ${d} off`).toBe(true);
      }
    }
  });

  it('is false at from, and a point or two off it, across the smallest size steps', () => {
    // Small <-> Medium and Medium <-> Large: the height (120, 198, 274) and
    // the width of the window with no bubble (88, 176, 264).
    const steps = [
      [120, 198],
      [198, 274],
      [88, 176],
      [176, 264]
    ] as const;
    for (const [a, b] of steps) {
      for (const d of [-2, -1, 0, 1, 2]) {
        expect(nearer(a + d, b, a), `${a} -> ${b}, ${d} off`).toBe(false);
        expect(nearer(b + d, a, b), `${b} -> ${a}, ${d} off`).toBe(false);
      }
    }
  });
});

describe('paintedAtSize at 100 %', () => {
  it('accepts the new scale in the new viewport', () => {
    expect(paintedAtSize(GROW, LARGE.scale, LARGE.width, LARGE.height)).toBe(true);
  });

  it('rejects the new scale in the old viewport (mode:set won)', () => {
    expect(paintedAtSize(GROW, LARGE.scale, MEDIUM.width, MEDIUM.height)).toBe(false);
  });

  it('rejects the old scale in the new viewport (the resize event won)', () => {
    expect(paintedAtSize(GROW, MEDIUM.scale, LARGE.width, LARGE.height)).toBe(false);
  });

  it('rejects the old picture: old scale, old viewport', () => {
    expect(paintedAtSize(GROW, MEDIUM.scale, MEDIUM.width, MEDIUM.height)).toBe(false);
  });

  it('rejects everything while there is no target', () => {
    expect(paintedAtSize(null, LARGE.scale, LARGE.width, LARGE.height)).toBe(false);
    expect(paintedAtSize(null, MEDIUM.scale, MEDIUM.width, MEDIUM.height)).toBe(false);
  });

  it('rejects a viewport that has only one axis at the new size', () => {
    expect(paintedAtSize(GROW, LARGE.scale, LARGE.width, MEDIUM.height)).toBe(false);
    expect(paintedAtSize(GROW, LARGE.scale, MEDIUM.width, LARGE.height)).toBe(false);
  });

  it('rejects a third scale in the new viewport', () => {
    expect(paintedAtSize(GROW, 1, LARGE.width, LARGE.height)).toBe(false);
  });
});

/**
 * At 125 % and 150 % the window Windows grants and the viewport Chromium
 * reports are rounded from one physical rect and need not agree with what was
 * asked for, or with each other (asked 264 × 274, granted 264 × 275.2, for
 * one). The rule never compares for equality, so none of that matters — which
 * is what these pin, whatever the cause of the 2026-11-16 timeouts was.
 */
describe('paintedAtSize at a fractional scale factor', () => {
  const grow: SizeTarget = { ...GROW, to: { width: 264, height: 275 } };

  it.each([
    [264, 276],
    [263, 274],
    [265, 275],
    [264, 275],
    [264, 275.2]
  ])('accepts a %d x %d viewport for a 264 x 275 window', (width, height) => {
    expect(paintedAtSize(grow, grow.scale, width, height)).toBe(true);
  });

  it('still rejects the old viewport, a point or two off', () => {
    for (const [width, height] of [
      [176, 183],
      [177, 184],
      [175, 182],
      [176, 183.2]
    ] as const) {
      expect(paintedAtSize(grow, grow.scale, width, height), `${width}x${height}`).toBe(false);
    }
  });

  it('is symmetric: the shrink accepts and rejects the mirror images', () => {
    const shrink: SizeTarget = { ...SHRINK, from: { width: 264, height: 275 } };
    for (const [width, height] of [
      [176, 183],
      [177, 184],
      [175, 182]
    ] as const) {
      expect(paintedAtSize(shrink, shrink.scale, width, height), `${width}x${height}`).toBe(true);
    }
    for (const [width, height] of [
      [264, 275],
      [264, 276],
      [263, 274]
    ] as const) {
      expect(paintedAtSize(shrink, shrink.scale, width, height), `${width}x${height}`).toBe(false);
    }
  });

  it('accepts from === to at the same scale, wherever the viewport is', () => {
    // Small -> Large -> Small inside one wait: the window is resized to the
    // size it has, and the next paint has to end the blank.
    const same: SizeTarget = { scale: 1, from: { width: 88, height: 92 }, to: { width: 88, height: 92 } };
    expect(paintedAtSize(same, 1, 88, 92)).toBe(true);
    expect(paintedAtSize(same, 1, 89, 93)).toBe(true);
    expect(paintedAtSize(same, 3, 88, 92)).toBe(false);
  });

  it('rejects one axis equal before and after with the other still at from', () => {
    // Why the rule is "both axes" and not "either": the width did not change,
    // so it is "near to" in the old viewport too.
    const tall: SizeTarget = {
      scale: 3,
      from: { width: 264, height: 183 },
      to: { width: 264, height: 275 }
    };
    expect(paintedAtSize(tall, 3, 264, 183)).toBe(false);
    expect(paintedAtSize(tall, 3, 264, 275)).toBe(true);
  });
});

/**
 * The window is resized for a bubble and for a box change too, and one can
 * land in the frames between main's resize and the renderer's matching paint
 * (review of 2026-11-16). Main then sends `resized` again: the same `from`,
 * the size the window has now as `to`. These pin the rule against the targets
 * that produces — and, first, why the first target alone is not enough.
 *
 * The sizes are the real ones on the 72 px box: Small 88 x 120, Large
 * 264 x 274, and with a 30-column bubble 240 and 314 wide.
 */
describe('paintedAtSize after another resize', () => {
  const SMALL_VIEW = { width: 88, height: 120 } as const;
  const LARGE_VIEW = { width: 264, height: 274 } as const;
  const SMALL_BARKING = { width: 240, height: 120 } as const;
  const LARGE_BARKING = { width: 314, height: 274 } as const;

  it('a bark after Large -> Small: the first target never matches, the follow-up does', () => {
    const first: SizeTarget = { scale: 1, from: LARGE_VIEW, to: SMALL_VIEW };
    // 240 is nearer the 264 he came from than the 88 he was resized to.
    expect(paintedAtSize(first, 1, SMALL_BARKING.width, SMALL_BARKING.height)).toBe(false);

    const followed: SizeTarget = { ...first, to: SMALL_BARKING };
    expect(paintedAtSize(followed, 1, SMALL_BARKING.width, SMALL_BARKING.height)).toBe(true);
    // The picture from before the size change is still what it rejects...
    expect(paintedAtSize(followed, 1, LARGE_VIEW.width, LARGE_VIEW.height)).toBe(false);
    // ...and the old scale in the right viewport.
    expect(paintedAtSize(followed, 3, SMALL_BARKING.width, SMALL_BARKING.height)).toBe(false);
  });

  it('a bubble that clears after Small -> Large: the same', () => {
    const first: SizeTarget = { scale: 3, from: SMALL_BARKING, to: LARGE_BARKING };
    expect(paintedAtSize(first, 3, LARGE_VIEW.width, LARGE_VIEW.height)).toBe(false);

    const followed: SizeTarget = { ...first, to: LARGE_VIEW };
    expect(paintedAtSize(followed, 3, LARGE_VIEW.width, LARGE_VIEW.height)).toBe(true);
    expect(paintedAtSize(followed, 3, SMALL_BARKING.width, SMALL_BARKING.height)).toBe(false);
    expect(paintedAtSize(followed, 1, LARGE_VIEW.width, LARGE_VIEW.height)).toBe(false);
  });

  it('a width back within two points of where it started matches at a fractional factor', () => {
    // Small with a 33-column bubble is 262 wide; Large with none is 264. The
    // width says nothing, so a viewport rounded towards 262 must still match
    // — on the height, which is a size step away.
    const target: SizeTarget = {
      scale: 3,
      from: { width: 262, height: 120 },
      to: { width: 264, height: 274 }
    };
    for (const [width, height] of [
      [264, 274],
      [263, 274],
      [262.4, 274.4],
      [262, 275.2],
      [265, 273],
      [266, 276]
    ] as const) {
      expect(paintedAtSize(target, 3, width, height), `${width}x${height}`).toBe(true);
    }
    // The old viewport, exactly and a point or two off, is still rejected.
    for (const [width, height] of [
      [262, 120],
      [263, 121],
      [264, 122],
      [261, 118]
    ] as const) {
      expect(paintedAtSize(target, 3, width, height), `${width}x${height}`).toBe(false);
    }
  });

  it('the size between the two resizes matches only when it is nearer the last', () => {
    // Small with a bubble -> Large with it (314) -> the bubble clears (264):
    // 314 is nearer 264 than the 240 he started at, and at the new scale it
    // is the picture a bubble clearing always passes through.
    const cleared: SizeTarget = { scale: 3, from: SMALL_BARKING, to: LARGE_VIEW };
    expect(paintedAtSize(cleared, 3, LARGE_BARKING.width, LARGE_BARKING.height)).toBe(true);
    // Large -> Small (88) -> a 45-column bark (328): 88 is nearer the 264 he
    // started at, so he stays blank for the one more resize.
    const barked: SizeTarget = { scale: 1, from: LARGE_VIEW, to: { width: 328, height: 120 } };
    expect(paintedAtSize(barked, 1, SMALL_VIEW.width, SMALL_VIEW.height)).toBe(false);
    expect(paintedAtSize(barked, 1, 328, 120)).toBe(true);
  });
});

describe('onSizeMessage', () => {
  const blanking = (id: number, paints = 0, target: SizeTarget | null = null): SizeBlank => ({
    id,
    paints,
    target
  });

  it('a blank from nothing starts one, arms its ceiling and asks for a paint', () => {
    expect(onSizeMessage(null, BLANK)).toEqual({
      state: blanking(1),
      armTimeoutForId: 1,
      repaint: true
    });
  });

  it('a blank with a higher id replaces the state outright and re-arms', () => {
    expect(onSizeMessage(blanking(1, SIZE_BLANK_PAINTS, GROW), { phase: 'blank', id: 2 })).toEqual({
      state: blanking(2),
      armTimeoutForId: 2,
      repaint: true
    });
  });

  it('a blank with the same or a lower id is ignored', () => {
    const state = blanking(2, 1, GROW);
    for (const id of [2, 1]) {
      expect(onSizeMessage(state, { phase: 'blank', id }), `id ${id}`).toEqual({
        state,
        armTimeoutForId: null,
        repaint: false
      });
    }
  });

  it('a resized with the same id sets the target, keeps the count, arms nothing', () => {
    expect(onSizeMessage(blanking(1, 2), RESIZED)).toEqual({
      state: blanking(1, 2, GROW),
      armTimeoutForId: null,
      repaint: true
    });
  });

  it('a second resized with the same id replaces the target and asks for a paint', () => {
    // Main resized the window again, for a bubble, before he was drawn.
    const again = { ...RESIZED, to: { width: 314, height: 274 } };
    expect(onSizeMessage(blanking(1, SIZE_BLANK_PAINTS, GROW), again)).toEqual({
      state: blanking(1, SIZE_BLANK_PAINTS, { ...GROW, to: { width: 314, height: 274 } }),
      armTimeoutForId: null,
      repaint: true
    });
  });

  it('a resized with another id is ignored', () => {
    const state = blanking(2, 1);
    for (const id of [1, 3]) {
      expect(onSizeMessage(state, { ...RESIZED, id }), `id ${id}`).toEqual({
        state,
        armTimeoutForId: null,
        repaint: false
      });
    }
  });

  it('a resized with nothing being blanked is ignored', () => {
    // The ceiling ran out first: he is drawn, at the old consistent state.
    expect(onSizeMessage(null, RESIZED)).toEqual({
      state: null,
      armTimeoutForId: null,
      repaint: false
    });
  });

  it('junk changes nothing, with or without a blank under way', () => {
    const state = blanking(1, 1, GROW);
    for (const raw of [null, 'blank', 7, [], {}, { phase: 'blank' }, { phase: 'resized', id: 1 }]) {
      expect(onSizeMessage(state, raw)).toEqual({ state, armTimeoutForId: null, repaint: false });
      expect(onSizeMessage(null, raw)).toEqual({
        state: null,
        armTimeoutForId: null,
        repaint: false
      });
    }
  });
});

describe('onSizePaint', () => {
  const IDLE = { state: null, blank: false, ackId: null, repaint: false, shownId: null };

  it('does nothing when no size change is under way', () => {
    expect(onSizePaint(null, LARGE.scale, LARGE.width, LARGE.height)).toEqual(IDLE);
  });

  it('paints blank, one frame after another, and acknowledges on exactly the last', () => {
    let state = onSizeMessage(null, BLANK).state;
    const steps = [];
    for (let i = 0; i < SIZE_BLANK_PAINTS + 3; i += 1) {
      const step = onSizePaint(state, MEDIUM.scale, MEDIUM.width, MEDIUM.height);
      state = step.state;
      steps.push(step);
    }
    expect(steps.every((step) => step.blank)).toBe(true);
    expect(steps.every((step) => step.shownId === null)).toBe(true);
    // Each blank paint asks for the next until the count is reached...
    expect(steps.map((step) => step.repaint)).toEqual(
      steps.map((_step, index) => index < SIZE_BLANK_PAINTS - 1)
    );
    // ...and the acknowledgement rides the paint that reaches it, never again.
    expect(steps.map((step) => step.ackId)).toEqual(
      steps.map((_step, index) => (index === SIZE_BLANK_PAINTS - 1 ? 1 : null))
    );
    expect(state).toEqual({ id: 1, paints: SIZE_BLANK_PAINTS, target: null });
  });

  it('with three blank paints: blank on 1 to 3, repaint on 1 and 2, the ack on 3', () => {
    // The numbers the design reckons with, spelled out. If the knob is turned
    // this is the test to turn with it.
    expect(SIZE_BLANK_PAINTS).toBe(3);
    let state = onSizeMessage(null, BLANK).state;
    const seen = [];
    for (let i = 0; i < 4; i += 1) {
      const step = onSizePaint(state, MEDIUM.scale, MEDIUM.width, MEDIUM.height);
      state = step.state;
      seen.push([step.blank, step.repaint, step.ackId]);
    }
    expect(seen).toEqual([
      [true, true, null],
      [true, true, null],
      [true, false, 1],
      [true, false, null]
    ]);
  });

  it('stays blank on every half-updated paint once the target is set', () => {
    const state: SizeBlank = { id: 1, paints: SIZE_BLANK_PAINTS, target: GROW };
    for (const [scale, width, height] of [
      [MEDIUM.scale, MEDIUM.width, MEDIUM.height],
      [MEDIUM.scale, LARGE.width, LARGE.height],
      [LARGE.scale, MEDIUM.width, MEDIUM.height],
      [LARGE.scale, LARGE.width, MEDIUM.height]
    ] as const) {
      expect(onSizePaint(state, scale, width, height), `${scale} ${width}x${height}`).toEqual({
        state,
        blank: true,
        ackId: null,
        repaint: false,
        shownId: null
      });
    }
  });

  it('stays blank at the new scale and viewport until resized has arrived', () => {
    // The `resize` event and a stray `mode:set` both beat `resized`: no
    // target, no match, however right the paint looks.
    const state: SizeBlank = { id: 1, paints: SIZE_BLANK_PAINTS, target: null };
    expect(onSizePaint(state, LARGE.scale, LARGE.width, LARGE.height).blank).toBe(true);
  });

  it('draws him on the matching paint, reports it once, and is idle after', () => {
    const state: SizeBlank = { id: 1, paints: SIZE_BLANK_PAINTS, target: GROW };
    const step = onSizePaint(state, LARGE.scale, LARGE.width, LARGE.height);
    expect(step).toEqual({ state: null, blank: false, ackId: null, repaint: false, shownId: 1 });
    expect(onSizePaint(step.state, LARGE.scale, LARGE.width, LARGE.height)).toEqual(IDLE);
  });

  it('a match before the acknowledgement was due shows him and sends no acknowledgement', () => {
    // Main's timer resized before the third blank paint: the change is made,
    // and an acknowledgement now would only be a late one.
    const state: SizeBlank = { id: 1, paints: 1, target: GROW };
    const step = onSizePaint(state, LARGE.scale, LARGE.width, LARGE.height);
    expect(step.shownId).toBe(1);
    expect(step.ackId).toBeNull();
    expect(step.blank).toBe(false);
  });

  it('still counts and acknowledges when the target arrived before the count was reached', () => {
    // Main's timer resized early, but the viewport has not followed yet: the
    // blank frames go on, and the acknowledgement main no longer needs is
    // still sent exactly once (main ignores it).
    let state: SizeBlank = { id: 1, paints: SIZE_BLANK_PAINTS - 1, target: GROW };
    const step = onSizePaint(state, LARGE.scale, MEDIUM.width, MEDIUM.height);
    expect(step.ackId).toBe(1);
    state = step.state;
    expect(onSizePaint(state, LARGE.scale, MEDIUM.width, MEDIUM.height).ackId).toBeNull();
  });

  it('a new blank during the wait for a match starts the count again and acknowledges again', () => {
    // A second pick after main resized, while he is still blank: main is
    // waiting for *this* id's blank frames.
    let state: SizeBlank = { id: 1, paints: SIZE_BLANK_PAINTS, target: GROW };
    state = onSizeMessage(state, { phase: 'blank', id: 2 }).state;
    const acks = [];
    for (let i = 0; i < SIZE_BLANK_PAINTS; i += 1) {
      // Even a paint that would have matched the first change stays blank.
      const step = onSizePaint(state, LARGE.scale, LARGE.width, LARGE.height);
      expect(step.blank).toBe(true);
      state = step.state;
      acks.push(step.ackId);
    }
    expect(acks.filter((id) => id !== null)).toEqual([2]);
  });
});

describe('onSizeTimeout', () => {
  it('ends the blank it was armed for and says so', () => {
    const state: SizeBlank = { id: 3, paints: SIZE_BLANK_PAINTS, target: GROW };
    expect(onSizeTimeout(state, 3)).toEqual({ state: null, shownId: 3 });
  });

  it('does nothing for a change that was replaced by a newer one', () => {
    const state: SizeBlank = { id: 4, paints: 1, target: null };
    expect(onSizeTimeout(state, 3)).toEqual({ state, shownId: null });
  });

  it('does nothing when he is already drawn', () => {
    expect(onSizeTimeout(null, 3)).toEqual({ state: null, shownId: null });
  });
});

/**
 * The renderer as `overlay.ts` wires it, without the DOM: the state it keeps
 * between calls and everything it would send main.
 */
function renderer() {
  let state: SizeBlank = null;
  const acks: number[] = [];
  const shown: { id: number; matched: boolean }[] = [];
  const armed: number[] = [];
  return {
    message(raw: unknown): void {
      const step = onSizeMessage(state, raw);
      state = step.state;
      if (step.armTimeoutForId !== null) armed.push(step.armTimeoutForId);
    },
    /** One paint; answers whether it was blank. */
    paint(scale: number, width: number, height: number): boolean {
      const step = onSizePaint(state, scale, width, height);
      state = step.state;
      if (step.ackId !== null) acks.push(step.ackId);
      if (step.shownId !== null) shown.push({ id: step.shownId, matched: true });
      return step.blank;
    },
    timeout(id: number): void {
      const step = onSizeTimeout(state, id);
      state = step.state;
      if (step.shownId !== null) shown.push({ id: step.shownId, matched: false });
    },
    acks,
    shown,
    armed,
    get state(): SizeBlank {
      return state;
    }
  };
}

describe('a whole size change, as the renderer lives it', () => {
  it('the healthy order: blank, three frames, ack, resized, a half paint, the match', () => {
    const r = renderer();
    r.message(BLANK);
    expect(r.armed).toEqual([1]);
    for (let i = 0; i < SIZE_BLANK_PAINTS; i += 1) {
      expect(r.paint(MEDIUM.scale, MEDIUM.width, MEDIUM.height)).toBe(true);
    }
    expect(r.acks).toEqual([1]);

    // Main resizes. The `resize` event wins the race to the renderer...
    expect(r.paint(MEDIUM.scale, LARGE.width, LARGE.height)).toBe(true);
    r.message(RESIZED);
    // ...then `resized`, still at the old scale...
    expect(r.paint(MEDIUM.scale, LARGE.width, LARGE.height)).toBe(true);
    // ...then `mode:set`.
    expect(r.paint(LARGE.scale, LARGE.width, LARGE.height)).toBe(false);
    expect(r.shown).toEqual([{ id: 1, matched: true }]);
    expect(r.state).toBeNull();
    // The ceiling fires later and finds nothing to do.
    r.timeout(1);
    expect(r.shown).toEqual([{ id: 1, matched: true }]);
  });

  it('the other order: resized and mode:set before the resize event', () => {
    const r = renderer();
    r.message(BLANK);
    for (let i = 0; i < SIZE_BLANK_PAINTS; i += 1) r.paint(MEDIUM.scale, MEDIUM.width, MEDIUM.height);
    r.message(RESIZED);
    // New scale, old viewport: the displaced frame, kept blank.
    expect(r.paint(LARGE.scale, MEDIUM.width, MEDIUM.height)).toBe(true);
    expect(r.paint(LARGE.scale, LARGE.width, LARGE.height)).toBe(false);
    expect(r.shown).toEqual([{ id: 1, matched: true }]);
  });

  it("tray's early mode:set, at the old scale, opens nothing", () => {
    // The tray sends `mode:set` straight after the pick, before any resize:
    // it carries the old scale, and there is no target yet either way.
    const r = renderer();
    r.message(BLANK);
    expect(r.paint(MEDIUM.scale, MEDIUM.width, MEDIUM.height)).toBe(true);
    expect(r.shown).toEqual([]);
  });

  it('never matched: the ceiling draws him and reports it as unmatched', () => {
    const r = renderer();
    r.message(BLANK);
    for (let i = 0; i < 10; i += 1) expect(r.paint(MEDIUM.scale, MEDIUM.width, MEDIUM.height)).toBe(true);
    r.timeout(1);
    expect(r.shown).toEqual([{ id: 1, matched: false }]);
    expect(r.paint(MEDIUM.scale, MEDIUM.width, MEDIUM.height)).toBe(false);
    // The resize that main makes afterwards is not waited for: he stays drawn.
    r.message(RESIZED);
    expect(r.paint(LARGE.scale, LARGE.width, LARGE.height)).toBe(false);
    expect(r.shown).toEqual([{ id: 1, matched: false }]);
  });

  it('a second pick after the resize: stays blank throughout, acks the new id, matches its target', () => {
    const r = renderer();
    r.message(BLANK);
    for (let i = 0; i < SIZE_BLANK_PAINTS; i += 1) r.paint(MEDIUM.scale, MEDIUM.width, MEDIUM.height);
    r.message(RESIZED);
    // Before the first change matched, the owner picks Small.
    r.message({ phase: 'blank', id: 2 });
    expect(r.armed).toEqual([1, 2]);
    // The first change's viewport and scale arrive: no longer what is waited for.
    for (let i = 0; i < SIZE_BLANK_PAINTS; i += 1) {
      expect(r.paint(LARGE.scale, LARGE.width, LARGE.height)).toBe(true);
    }
    expect(r.acks).toEqual([1, 2]);
    // The first change's ceiling fires: it is not this change's.
    r.timeout(1);
    expect(r.shown).toEqual([]);
    r.message({
      phase: 'resized',
      id: 2,
      scale: 1,
      from: GROW.to,
      to: { width: 88, height: 92 }
    });
    expect(r.paint(LARGE.scale, 88, 92)).toBe(true);
    expect(r.paint(1, 88, 92)).toBe(false);
    expect(r.shown).toEqual([{ id: 2, matched: true }]);
  });

  it('a bark after the resize: blank in the first target, drawn once the follow-up names the size', () => {
    // Large -> Small, then a 30-column bark widens the window to 240 before
    // any paint matched. Without the follow-up he stayed blank to the ceiling.
    const first = {
      phase: 'resized',
      id: 1,
      scale: 1,
      from: { width: 264, height: 274 },
      to: { width: 88, height: 120 }
    } as const;
    const r = renderer();
    r.message(BLANK);
    for (let i = 0; i < SIZE_BLANK_PAINTS; i += 1) r.paint(3, 264, 274);
    r.message(first);
    // The viewport skips the 88 it was resized to and arrives at 240.
    expect(r.paint(1, 240, 120)).toBe(true);
    expect(r.paint(1, 240, 120)).toBe(true);
    r.message({ ...first, to: { width: 240, height: 120 } });
    expect(r.paint(1, 240, 120)).toBe(false);
    expect(r.shown).toEqual([{ id: 1, matched: true }]);
    // One ceiling for the whole change, and one acknowledgement.
    expect(r.armed).toEqual([1]);
    expect(r.acks).toEqual([1]);
  });

  it('a follow-up that arrives after he is drawn is ignored', () => {
    const r = renderer();
    r.message(BLANK);
    for (let i = 0; i < SIZE_BLANK_PAINTS; i += 1) r.paint(MEDIUM.scale, MEDIUM.width, MEDIUM.height);
    r.message(RESIZED);
    expect(r.paint(LARGE.scale, LARGE.width, LARGE.height)).toBe(false);
    // It crossed with the `shown` report: nothing is blanked again.
    r.message({ ...RESIZED, to: { width: 314, height: 274 } });
    expect(r.state).toBeNull();
    expect(r.paint(LARGE.scale, LARGE.width, LARGE.height)).toBe(false);
    expect(r.shown).toEqual([{ id: 1, matched: true }]);
  });

  it('a resize to the size he has (from === to) matches on the next paint', () => {
    const r = renderer();
    r.message(BLANK);
    for (let i = 0; i < SIZE_BLANK_PAINTS; i += 1) r.paint(MEDIUM.scale, MEDIUM.width, MEDIUM.height);
    r.message({ phase: 'resized', id: 1, scale: MEDIUM.scale, from: GROW.from, to: GROW.from });
    expect(r.paint(MEDIUM.scale, MEDIUM.width, MEDIUM.height)).toBe(false);
    expect(r.shown).toEqual([{ id: 1, matched: true }]);
  });

  it('acknowledges at most once and shows at most once, over any paint sequence', () => {
    // A small deterministic generator: every run tries the same sequences.
    let seed = 20261116;
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % bound;
    };
    const scales = [MEDIUM.scale, LARGE.scale];
    const widths = [MEDIUM.width, LARGE.width, 177, 263];
    const heights = [MEDIUM.height, LARGE.height, 184, 275];
    for (let run = 0; run < 300; run += 1) {
      const r = renderer();
      r.message(BLANK);
      for (let step = 0; step < 40; step += 1) {
        const dice = next(12);
        if (dice === 0) r.message(RESIZED);
        // A repeat of the same `blank` while it is under way. (Main sends each
        // id once; one arriving after he is drawn again would be a new blank,
        // which is `onSizeMessage`'s rule and not this property's subject.)
        else if (dice === 1 && r.state !== null) r.message(BLANK);
        else if (dice === 2) r.message({ ...RESIZED, id: 2 });
        else if (dice === 3 && step > 20) r.timeout(1);
        else r.paint(scales[next(2)] as number, widths[next(4)] as number, heights[next(4)] as number);
      }
      expect(r.acks.length, `run ${run}`).toBeLessThanOrEqual(1);
      expect(r.shown.length, `run ${run}`).toBeLessThanOrEqual(1);
      expect(r.armed, `run ${run}`).toEqual([1]);
      // And he is never drawn while the state says blank: `shown` and the
      // state going null are the same event.
      if (r.shown.length === 1) expect(r.state, `run ${run}`).toBeNull();
      else expect(r.state, `run ${run}`).not.toBeNull();
    }
  });
});

describe('sizeRequest', () => {
  it('retargets a wait that is running: the same id, the new scale', () => {
    expect(sizeRequest({ id: 4, scale: 2 }, true, 1, 3, 5)).toEqual({
      kind: 'retarget',
      pending: { id: 4, scale: 3 }
    });
  });

  it('retargets even back to the scale he has, and even when it can no longer defer', () => {
    expect(sizeRequest({ id: 4, scale: 3 }, true, 1, 1, 5)).toEqual({
      kind: 'retarget',
      pending: { id: 4, scale: 1 }
    });
    expect(sizeRequest({ id: 4, scale: 3 }, false, 1, 2, 5)).toEqual({
      kind: 'retarget',
      pending: { id: 4, scale: 2 }
    });
  });

  it('resizes now when there is nothing to wait for', () => {
    // macOS and Linux, before ready-to-show, hidden, destroyed.
    expect(sizeRequest(null, false, 1, 3, 1)).toEqual({ kind: 'now' });
  });

  it('resizes now for the size he already has', () => {
    expect(sizeRequest(null, true, 2, 2, 1)).toEqual({ kind: 'now' });
  });

  it('starts a wait otherwise, with the id it was handed', () => {
    expect(sizeRequest(null, true, 1, 3, 7)).toEqual({
      kind: 'start',
      pending: { id: 7, scale: 3 }
    });
  });
});

describe('acceptsBlankReport', () => {
  const pending = { id: 4, scale: 3 } as const;

  it('accepts a blank report for the id that is pending', () => {
    expect(acceptsBlankReport(pending, { phase: 'blank', id: 4 })).toBe(true);
  });

  it('rejects an earlier or a later id', () => {
    expect(acceptsBlankReport(pending, { phase: 'blank', id: 3 })).toBe(false);
    expect(acceptsBlankReport(pending, { phase: 'blank', id: 5 })).toBe(false);
  });

  it('rejects a shown report, even for the pending id', () => {
    expect(
      acceptsBlankReport(pending, { phase: 'shown', id: 4, matched: true, width: 264, height: 274 })
    ).toBe(false);
  });

  it('rejects everything when nothing is pending', () => {
    expect(acceptsBlankReport(null, { phase: 'blank', id: 4 })).toBe(false);
  });
});

describe('resizedMessage', () => {
  const settling: SettlingSize = { id: 4, from: { width: 264, height: 274 } };

  it('carries the id and from of the change, and the scale and size it is handed', () => {
    expect(resizedMessage(settling, 1, { width: 88, height: 120 })).toEqual({
      phase: 'resized',
      id: 4,
      scale: 1,
      from: { width: 264, height: 274 },
      to: { width: 88, height: 120 }
    });
  });

  it('a follow-up differs from the first in nothing but to', () => {
    const first = resizedMessage(settling, 1, { width: 88, height: 120 });
    const again = resizedMessage(settling, 1, { width: 240, height: 120 });
    expect(again).toEqual({ ...first, to: { width: 240, height: 120 } });
  });

  it('takes only the size from a whole window rect, and is what the renderer parses', () => {
    // What `getBounds` hands main, on both sides of the resize.
    const before = { x: 212, y: 246, width: 264, height: 274 };
    const rect = { x: 300, y: 400, width: 240, height: 120 };
    const message = resizedMessage({ id: 4, from: before }, 1, rect);
    expect(message.to).toEqual({ width: 240, height: 120 });
    expect(message.from).toEqual({ width: 264, height: 274 });
    expect(parseSizeChangeMessage(message)).toEqual(message);
  });
});

describe('endsSettling', () => {
  const settling: SettlingSize = { id: 4, from: { width: 264, height: 274 } };
  const shown = (id: number, matched: boolean) =>
    ({ phase: 'shown', id, matched, width: 88, height: 120 }) as const;

  it('a shown report for the settling change ends it, matched or at the time limit', () => {
    expect(endsSettling(settling, shown(4, true))).toBe(true);
    expect(endsSettling(settling, shown(4, false))).toBe(true);
  });

  it('a shown report for another change does not', () => {
    expect(endsSettling(settling, shown(3, true))).toBe(false);
    expect(endsSettling(settling, shown(5, false))).toBe(false);
  });

  it('a blank report does not, even for the same id', () => {
    expect(endsSettling(settling, { phase: 'blank', id: 4 })).toBe(false);
  });

  it('nothing settling is nothing to end', () => {
    expect(endsSettling(null, shown(4, true))).toBe(false);
  });
});

describe('the overlay wires the size-change rules', () => {
  // `overlay.ts` cannot run here (no DOM), so the calls themselves are pinned,
  // as `test/a11y-text.test.ts` pins the label rebuild: with any of these
  // removed the rules above are still green, and on Windows he is either
  // displaced again or left blank until a time limit.
  // Line endings follow the checkout (CRLF on Windows), so they are folded first.
  const src = readFileSync(new URL('../src/renderer/overlay.ts', import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n'
  );
  const body = (name: string): string => {
    const start = src.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('\n}\n', start));
  };

  it('subscribes onSizeChange to size:change', () => {
    expect(src).toContain('window.walder.onSizeChange(onSizeChange);');
  });

  it('onSizeChange applies the message, arms the ceiling as a timeout and asks for a paint', () => {
    const fn = body('onSizeChange');
    expect(fn).toContain('const step = onSizeMessage(sizeBlank, raw);');
    expect(fn).toContain('sizeBlank = step.state;');
    expect(fn).toContain('if (sizeBlankCap !== null) clearTimeout(sizeBlankCap);');
    expect(fn).toContain(
      'sizeBlankCap = setTimeout(() => onSizeBlankExpired(id), SIZE_BLANK_MAX_MS);'
    );
    expect(fn).toMatch(/if \(!step\.repaint\) return;\n  needsHitTest = true;\n  requestPaint\(\);/);
    // The ceiling is a timeout, not a count of frames: nothing here waits on rAF.
    expect(fn).not.toContain('requestAnimationFrame');
  });

  it('the ceiling ends the blank, re-tests, repaints and reports an unmatched shown', () => {
    const fn = body('onSizeBlankExpired');
    expect(fn).toContain('const step = onSizeTimeout(sizeBlank, id);');
    expect(fn).toContain('sizeBlank = step.state;');
    expect(fn).toContain('if (step.shownId === null) return;');
    expect(fn).toMatch(/needsHitTest = true;\n  requestPaint\(\);/);
    expect(fn).toMatch(/phase: 'shown',\n    id: step\.shownId,\n    matched: false,/);
  });

  it('paint asks onSizePaint before it reads retest, with what draw is about to use', () => {
    const fn = body('paint');
    const ask = fn.indexOf(
      'const size = onSizePaint(sizeBlank, scale, window.innerWidth, window.innerHeight);'
    );
    const retest = fn.indexOf('const retest = changed || needsHitTest;');
    const drawn = fn.indexOf('draw(lastBob, size.blank);');
    expect(ask).toBeGreaterThan(-1);
    expect(retest).toBeGreaterThan(ask);
    expect(drawn).toBeGreaterThan(retest);
    expect(fn).toContain('sizeBlank = size.state;');
  });

  it('paint re-tests the ink on the paint that draws him again, and drops the ceiling', () => {
    const fn = body('paint');
    expect(fn).toMatch(
      /if \(size\.shownId !== null\) \{\n(?:\s*\/\/.*\n)*\s*if \(sizeBlankCap !== null\) clearTimeout\(sizeBlankCap\);\n\s*sizeBlankCap = null;\n\s*needsHitTest = true;\n\s*\}\n\n\s*const retest/
    );
  });

  it('paint asks for the next blank frame, acknowledges and reports, after the draw', () => {
    const fn = body('paint');
    const drawn = fn.indexOf('draw(lastBob, size.blank);');
    const repaint = fn.indexOf('if (size.repaint) requestPaint();');
    const ack = fn.indexOf(
      "if (size.ackId !== null) void window.walder.sizeReport({ phase: 'blank', id: size.ackId });"
    );
    expect(repaint).toBeGreaterThan(drawn);
    expect(ack).toBeGreaterThan(drawn);
    expect(fn).toMatch(/phase: 'shown',\n      id: size\.shownId,\n      matched: true,/);
  });

  it('draw clears the canvas and returns before drawing anything when blank', () => {
    const fn = body('draw');
    expect(fn).toMatch(
      /resizeCanvas\(\);\n(?:\s*\/\/.*\n)*\s*ctx\.setTransform\(1, 0, 0, 1, 0, 0\);\n\s*ctx\.clearRect\(0, 0, canvas\.width, canvas\.height\);\n\s*if \(blank\) return;\n/
    );
    // Nothing is drawn above the early return.
    const early = fn.indexOf('if (blank) return;');
    for (const drawer of ['renderFrame(', 'drawDecorations(', 'drawBubble(', 'drawHitOutline(']) {
      expect(fn.indexOf(drawer), drawer).toBeGreaterThan(early);
    }
    // And `draw` is called from nowhere that could forget the flag.
    expect(src.match(/\bdraw\(/g)).toHaveLength(2);
  });

  it('nothing is ink while the picture is blank', () => {
    expect(body('onInk')).toMatch(
      /^function onInk\(x: number, y: number\): boolean \{\n(?:\s*\/\/.*\n)*\s*if \(sizeBlank !== null\) return false;\n/
    );
  });

  it('reports to main from three places and no others, and never on overlay:painted', () => {
    expect(src.match(/window\.walder\.sizeReport\(/g)).toHaveLength(3);
    expect(src).not.toContain('sizePainted');
  });
});

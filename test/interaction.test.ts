/**
 * The overlay's two interaction state machines.
 *
 * These decide whether a click reaches the dog or the window behind it, and
 * whether a mouse-up is a pet or the end of a drag. Both used to live inline in
 * the renderer's DOM handlers, where the only way to check them was to click a
 * dog on a screen the builder cannot see; extracted into `src/core/interaction.ts`
 * they are ordinary functions with ordinary edge cases — and the edge cases are
 * where the bugs were: a notification sent on every move (which flips window
 * state 60 times a second), a hover update landing mid-drag (which drops the
 * drag), and a threshold off by one pixel (which swallows every pet).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  HOVER_INITIAL,
  dragBegin,
  dragTargetRect,
  dragTo,
  hoverLeave,
  hoverMove,
  hoverResync,
  hoverRetest,
  isClick,
  type HoverState,
  type InkProbe
} from '../src/core/interaction';
import { CLICK_SLOP_PX } from '../src/main/ipc';
import { clampRectToWorkAreas, type Rect } from '../src/core/geometry';

/** An ink probe that is true inside the box x:[10,20), y:[10,20). */
const boxProbe: InkProbe = (x, y) => x >= 10 && x < 20 && y >= 10 && y < 20;
const always: InkProbe = () => true;
const never: InkProbe = () => false;

/** A hover state as if the cursor were resting on ink at (15, 15). */
function onInkAt15(): HoverState {
  return { inside: true, at: { x: 15, y: 15 } };
}

describe('hoverMove', () => {
  it('notifies on the crossing onto ink, and not again while it stays there', () => {
    const first = hoverMove(HOVER_INITIAL, 15, 15, false, boxProbe);
    expect(first.state.inside).toBe(true);
    expect(first.notify).toBe(true);

    // This is the case that matters for CPU: main flips the window's
    // click-through flag, so a move that changes nothing must send nothing.
    const second = hoverMove(first.state, 16, 16, false, boxProbe);
    expect(second.state.inside).toBe(true);
    expect(second.notify).toBe(false);

    const third = hoverMove(second.state, 17, 12, false, boxProbe);
    expect(third.notify).toBe(false);
  });

  it('notifies on the crossing back off ink', () => {
    const off = hoverMove(onInkAt15(), 5, 5, false, boxProbe);
    expect(off.state.inside).toBe(false);
    expect(off.notify).toBe(true);
  });

  it('records the position even while it reports nothing', () => {
    const moved = hoverMove(HOVER_INITIAL, 3, 4, false, never);
    expect(moved.state.at).toEqual({ x: 3, y: 4 });
    expect(moved.notify).toBe(false);
  });

  it('suppresses the verdict entirely mid-drag', () => {
    // During a drag the window slides under a stationary cursor, so the cursor
    // legitimately sits over transparent pixels. Reporting that would make main
    // go click-through and drop the drag on the floor.
    const probe = vi.fn(never);
    const during = hoverMove(onInkAt15(), 999, 999, true, probe);
    expect(during.state.inside).toBe(true);
    expect(during.notify).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    // ...but the position is still tracked, because the drag's end needs it.
    expect(during.state.at).toEqual({ x: 999, y: 999 });
  });

  it('does not report a crossing onto ink mid-drag either', () => {
    const during = hoverMove({ inside: false, at: null }, 15, 15, true, always);
    expect(during.state.inside).toBe(false);
    expect(during.notify).toBe(false);
  });
});

describe('hoverLeave', () => {
  it('goes click-through and forgets the cursor', () => {
    const left = hoverLeave(onInkAt15(), false);
    expect(left.state).toEqual({ inside: false, at: null });
    expect(left.notify).toBe(true);
  });

  it('says nothing when it was already off ink', () => {
    const left = hoverLeave({ inside: false, at: { x: 1, y: 1 } }, false);
    expect(left.state.inside).toBe(false);
    expect(left.notify).toBe(false);
  });

  it('keeps the interactive state mid-drag', () => {
    // A drag holds pointer capture and continues outside the window; going
    // click-through here would end it.
    const left = hoverLeave(onInkAt15(), true);
    expect(left.state.inside).toBe(true);
    expect(left.notify).toBe(false);
    expect(left.state.at).toBeNull();
  });
});

describe('hoverRetest', () => {
  it('reports a silhouette change under a stationary cursor', () => {
    // A new animation frame can have ink where the last one did not.
    const gained = hoverRetest({ inside: false, at: { x: 15, y: 15 } }, false, always);
    expect(gained.state.inside).toBe(true);
    expect(gained.notify).toBe(true);

    const lost = hoverRetest(onInkAt15(), false, never);
    expect(lost.state.inside).toBe(false);
    expect(lost.notify).toBe(true);
  });

  it('stays quiet when the answer is unchanged', () => {
    expect(hoverRetest(onInkAt15(), false, always).notify).toBe(false);
  });

  it('does nothing without a known cursor position', () => {
    const probe = vi.fn(always);
    const result = hoverRetest({ inside: false, at: null }, false, probe);
    expect(result.notify).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('does nothing mid-drag', () => {
    const probe = vi.fn(never);
    expect(hoverRetest(onInkAt15(), true, probe).notify).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('hoverResync', () => {
  it('re-sends even when the answer has not changed', () => {
    // The whole reason `hit:resync` exists: main flipped the window flag itself
    // (the force-interactive hatch), so "unchanged" still has to be transmitted
    // or the window stays wrong until the cursor next crosses the outline.
    const same = hoverResync(onInkAt15(), always);
    expect(same.state.inside).toBe(true);
    expect(same.notify).toBe(true);
  });

  it('re-derives the answer rather than repeating the cached one', () => {
    const changed = hoverResync(onInkAt15(), never);
    expect(changed.state.inside).toBe(false);
    expect(changed.notify).toBe(true);
  });

  it('reports false, and still reports, with the cursor outside the window', () => {
    const outside = hoverResync({ inside: true, at: null }, always);
    expect(outside.state.inside).toBe(false);
    expect(outside.notify).toBe(true);
  });

  it('keeps the cursor position', () => {
    expect(hoverResync(onInkAt15(), never).state.at).toEqual({ x: 15, y: 15 });
  });
});

describe('drag deltas', () => {
  it('reports the delta cumulatively from the press, not from the last move', () => {
    // Idempotence is the point: a dropped or reordered drag:move must not leave
    // the window permanently offset from the cursor.
    let state = dragBegin(500, 400, 7);
    const a = dragTo(state, 510, 400);
    expect([a.dxScreen, a.dyScreen]).toEqual([10, 0]);
    state = a.state;

    const b = dragTo(state, 530, 430);
    expect([b.dxScreen, b.dyScreen]).toEqual([30, 30]);
    state = b.state;

    // Replaying the same position yields the same delta, twice.
    expect(dragTo(state, 530, 430).dxScreen).toBe(30);
  });

  it('keeps the pointer id it was given', () => {
    expect(dragTo(dragBegin(0, 0, 42), 5, 5).state.pointerId).toBe(42);
  });

  it('keeps the greatest distance reached, not the latest', () => {
    // Drag out 50 px and come back to the start: that was a drag, not a pet.
    let state = dragBegin(100, 100, 1);
    state = dragTo(state, 150, 100).state;
    expect(state.moved).toBeCloseTo(50);
    state = dragTo(state, 100, 100).state;
    expect(state.moved).toBeCloseTo(50);
    expect(isClick(state)).toBe(false);
  });

  it('measures straight-line distance, not Manhattan', () => {
    // A 2x2 px hand tremor is 2.83 px away, not 4: it must stay a pet.
    const state = dragTo(dragBegin(0, 0, 1), 2, 2).state;
    expect(state.moved).toBeCloseTo(Math.SQRT2 * 2);
    expect(isClick(state)).toBe(true);
  });
});

describe('isClick threshold', () => {
  it('is a pet at 3.99 px and a drag at 4.0 px', () => {
    expect(CLICK_SLOP_PX).toBe(4);
    const pet = dragTo(dragBegin(0, 0, 1), 3.99, 0).state;
    const notPet = dragTo(dragBegin(0, 0, 1), 4, 0).state;
    expect(pet.moved).toBeCloseTo(3.99);
    expect(isClick(pet)).toBe(true);
    expect(notPet.moved).toBe(4);
    expect(isClick(notPet)).toBe(false);
  });

  it('counts a press with no movement at all as a click', () => {
    expect(isClick(dragBegin(10, 10, 1))).toBe(true);
    expect(isClick(dragTo(dragBegin(10, 10, 1), 10, 10).state)).toBe(true);
  });

  it('applies the threshold to the diagonal, not to either axis', () => {
    // 3 px each way is 4.24 px: over the line, even though neither axis is.
    const diagonal = dragTo(dragBegin(0, 0, 1), 3, 3).state;
    expect(isClick(diagonal)).toBe(false);
  });
});

describe('dragTargetRect and the clamp it feeds', () => {
  const ORIGIN: Rect = { x: 300, y: 300, width: 192, height: 192 };
  const LAPTOP: Rect = { x: 0, y: 25, width: 1440, height: 875 };

  it('offsets the press-time rect and keeps its size', () => {
    expect(dragTargetRect(ORIGIN, -40, 60)).toEqual({
      x: 260,
      y: 360,
      width: 192,
      height: 192
    });
  });

  it('is absolute, so a repeated delta does not accumulate', () => {
    expect(dragTargetRect(ORIGIN, 10, 10)).toEqual(dragTargetRect(ORIGIN, 10, 10));
  });

  it('composes with the work-area clamp to keep the dog reachable', () => {
    // A drag far off the left edge: the target is nonsense, the clamp recovers it.
    const target = dragTargetRect(ORIGIN, -9000, 0);
    expect(target.x).toBe(-8700);
    expect(clampRectToWorkAreas(target, [LAPTOP])).toEqual({ x: LAPTOP.x, y: 300 });
  });

  it('leaves a drag that stays on screen exactly where the cursor put it', () => {
    const target = dragTargetRect(ORIGIN, 120, 90);
    expect(clampRectToWorkAreas(target, [LAPTOP])).toEqual({ x: 420, y: 390 });
  });
});

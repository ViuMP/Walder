/**
 * Where the hover panel goes.
 *
 * Pure, so the two failure modes that would actually be noticed — a card half
 * off the screen edge, and a card hanging off the bottom next to a dog in his
 * home corner — are provable without a second window on screen.
 */
import { describe, expect, it } from 'vitest';
import { PANEL_GAP, placePanel, workAreaFor } from '../src/core/panel-place';
import type { Rect } from '../src/core/geometry';

const LAPTOP: Rect = { x: 0, y: 25, width: 1440, height: 875 };
const LEFT_SCREEN: Rect = { x: -1920, y: 0, width: 1920, height: 1080 };
const PANEL = { width: 300, height: 260 };

/** The dog in his default corner: bottom-right of the laptop's work area. */
const HOME: Rect = { x: 1330, y: 810, width: 96, height: 80 };

describe('placePanel', () => {
  it('sits to the left of the dog by default, top-aligned with him', () => {
    // The dog's home corner is bottom-right, so the space to his left is the
    // space that exists.
    const at = placePanel(HOME, PANEL, LAPTOP);
    expect(at.side).toBe('left');
    expect(at.x).toBe(HOME.x - PANEL_GAP - PANEL.width);
    // Vertically: top-aligned, but clamped up so the card fits above the edge.
    expect(at.y).toBeLessThanOrEqual(HOME.y);
    expect(at.y + PANEL.height).toBeLessThanOrEqual(LAPTOP.y + LAPTOP.height);
  });

  it('is top-aligned with the dog when there is room below', () => {
    const dog: Rect = { x: 800, y: 300, width: 96, height: 80 };
    expect(placePanel(dog, PANEL, LAPTOP).y).toBe(dog.y);
  });

  it('flips to the right when a left-hand card would cross the left edge', () => {
    // Half off-screen is worse than on the "wrong" side.
    const dog: Rect = { x: 40, y: 300, width: 96, height: 80 };
    const at = placePanel(dog, PANEL, LAPTOP);
    expect(at.side).toBe('right');
    expect(at.x).toBe(dog.x + dog.width + PANEL_GAP);
  });

  it('flips at exactly the point where the card would no longer fit', () => {
    const justFits: Rect = { x: PANEL.width + PANEL_GAP, y: 300, width: 96, height: 80 };
    expect(placePanel(justFits, PANEL, LAPTOP).side).toBe('left');

    const justDoesNot: Rect = { ...justFits, x: justFits.x - 1 };
    expect(placePanel(justDoesNot, PANEL, LAPTOP).side).toBe('right');
  });

  it('clamps a right-flipped card back inside the right edge', () => {
    // The pathological case: a work area too narrow for dog + card on either
    // side. The card must still be fully on screen.
    const narrow: Rect = { x: 0, y: 0, width: 360, height: 800 };
    const dog: Rect = { x: 40, y: 100, width: 96, height: 80 };
    const at = placePanel(dog, PANEL, narrow);
    expect(at.x + PANEL.width).toBeLessThanOrEqual(narrow.x + narrow.width);
    expect(at.x).toBeGreaterThanOrEqual(narrow.x);
  });

  it('clamps vertically at both edges', () => {
    const high: Rect = { x: 800, y: -200, width: 96, height: 80 };
    expect(placePanel(high, PANEL, LAPTOP).y).toBe(LAPTOP.y);

    const low: Rect = { x: 800, y: 890, width: 96, height: 80 };
    const at = placePanel(low, PANEL, LAPTOP);
    expect(at.y + PANEL.height).toBe(LAPTOP.y + LAPTOP.height);
  });

  it('pins a card taller than the work area to its top edge', () => {
    // A min/max pair that inverts would push it off the bottom instead.
    const at = placePanel(HOME, { width: 300, height: 5000 }, LAPTOP);
    expect(at.y).toBe(LAPTOP.y);
  });

  it('works on a display with negative coordinates', () => {
    const dog: Rect = { x: -400, y: 500, width: 96, height: 80 };
    const at = placePanel(dog, PANEL, LEFT_SCREEN);
    expect(at.side).toBe('left');
    expect(at.x).toBe(dog.x - PANEL_GAP - PANEL.width);
    expect(at.x).toBeGreaterThanOrEqual(LEFT_SCREEN.x);
  });

  it('returns whole pixels', () => {
    const at = placePanel({ x: 800.5, y: 300.5, width: 96, height: 80 }, PANEL, LAPTOP);
    expect(Number.isInteger(at.x)).toBe(true);
    expect(Number.isInteger(at.y)).toBe(true);
  });

  it('honours a custom gap', () => {
    const dog: Rect = { x: 800, y: 300, width: 96, height: 80 };
    expect(placePanel(dog, PANEL, LAPTOP, 40).x).toBe(dog.x - 40 - PANEL.width);
  });
});

describe('workAreaFor', () => {
  it('picks the area containing the dog', () => {
    expect(workAreaFor(HOME, [LEFT_SCREEN, LAPTOP])).toBe(LAPTOP);
    expect(workAreaFor({ x: -1000, y: 400, width: 96, height: 80 }, [LEFT_SCREEN, LAPTOP])).toBe(
      LEFT_SCREEN
    );
  });

  it('chooses by the dog\'s centre, not the first display listed', () => {
    // A dog parked at the seam belongs to the display he is mostly on — the
    // panel must not appear on the monitor the owner is not looking at.
    const straddling: Rect = { x: -40, y: 400, width: 96, height: 80 };
    expect(workAreaFor(straddling, [LEFT_SCREEN, LAPTOP])).toBe(LAPTOP);
  });

  it('falls back to the nearest area when the dog is on none of them', () => {
    const nowhere: Rect = { x: 5000, y: 400, width: 96, height: 80 };
    expect(workAreaFor(nowhere, [LEFT_SCREEN, LAPTOP])).toBe(LAPTOP);
  });

  it('returns the dog\'s own rect when there are no displays', () => {
    // Transient, while displays are being reconfigured; guessing is worse.
    expect(workAreaFor(HOME, [])).toBe(HOME);
  });
});

/**
 * Where the hover panel goes relative to the dog. Pure, so the flip and the
 * clamp are provable without a second window on screen.
 *
 * The rules, in order:
 *  1. **Left of the dog by default.** The dog's home corner is the bottom-right
 *    of the screen, so the space to his left is the space that exists.
 *  2. **Flip to his right** if a left-hand panel would cross the work area's
 *    left edge. A panel that is half off-screen is worse than one on the
 *    "wrong" side.
 *  3. **Top-aligned with the dog**, then clamped vertically so the whole card
 *    fits — the panel is taller than the dog, and near the bottom of the screen
 *    a top-aligned card would hang off it.
 *  4. **Clamp horizontally as a last resort**, for the pathological case where
 *    neither side fits (a work area narrower than dog + panel).
 *
 * All coordinates are screen coordinates in logical pixels, which is what
 * Electron's `setBounds` and `Display.workArea` both use.
 */
import type { Rect } from './geometry';

/** Gap between the dog's ink and the panel's border, in logical pixels. */
export const PANEL_GAP = 12;

export interface PanelSize {
  readonly width: number;
  readonly height: number;
}

export interface PanelPlacement {
  readonly x: number;
  readonly y: number;
  /** Which side of the dog the panel ended up on. Useful in logs and tests. */
  readonly side: 'left' | 'right';
}

/**
 * Place `panel` beside `dog` inside `workArea`.
 *
 * `dog` is the sprite's *ink* rect in screen coordinates (what the overlay
 * renderer sends as `spriteRectScreen`), not the overlay window rect: the window
 * is mostly transparent padding, and measuring from it would leave a visible gap
 * that grows with the dog's size.
 */
export function placePanel(
  dog: Rect,
  panel: PanelSize,
  workArea: Rect,
  gap: number = PANEL_GAP
): PanelPlacement {
  const leftX = dog.x - gap - panel.width;
  const rightX = dog.x + dog.width + gap;

  const fitsLeft = leftX >= workArea.x;
  const side: 'left' | 'right' = fitsLeft ? 'left' : 'right';
  const preferredX = fitsLeft ? leftX : rightX;

  // The last-resort clamp. `Math.max(workArea.x, …)` on the inside so a panel
  // wider than the work area is pinned to its left edge rather than pushed off
  // the right one by an inverted min/max pair.
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - panel.width);
  const x = Math.min(Math.max(preferredX, workArea.x), maxX);

  const maxY = Math.max(workArea.y, workArea.y + workArea.height - panel.height);
  const y = Math.min(Math.max(dog.y, workArea.y), maxY);

  return { x: Math.round(x), y: Math.round(y), side };
}

/**
 * The work area the dog is on, given every display's work area.
 *
 * Chosen by the dog's centre, not the cursor: the panel belongs to the dog, and
 * on a two-monitor setup a dog parked at the seam must not put its panel on the
 * monitor the owner is not looking at. Falls back to the first area, and to a
 * degenerate area only when there are no displays at all (a transient state
 * while displays are being reconfigured).
 */
export function workAreaFor(dog: Rect, workAreas: readonly Rect[]): Rect {
  if (workAreas.length === 0) return dog;
  const centre = { x: dog.x + dog.width / 2, y: dog.y + dog.height / 2 };

  const containing = workAreas.find(
    (area) =>
      centre.x >= area.x &&
      centre.x < area.x + area.width &&
      centre.y >= area.y &&
      centre.y < area.y + area.height
  );
  if (containing !== undefined) return containing;

  let nearest = workAreas[0] as Rect;
  let best = Number.POSITIVE_INFINITY;
  for (const area of workAreas) {
    const dx = centre.x - (area.x + area.width / 2);
    const dy = centre.y - (area.y + area.height / 2);
    const distance = dx * dx + dy * dy;
    if (distance < best) {
      best = distance;
      nearest = area;
    }
  }
  return nearest;
}

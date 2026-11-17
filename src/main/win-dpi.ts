/**
 * Putting the Windows fullscreen helper's rects into Electron's units.
 *
 * Electron-free on purpose, so the arithmetic is a unit test on every platform
 * (the caller in `fullscreen-watch.ts` supplies the live display list). It lives
 * in `main/` rather than `core/` because it is the Windows half of the probe's
 * I/O contract, not part of the platform-neutral decision: `core/fullscreen.ts`
 * only ever sees rects that are already in DIPs.
 *
 * WHY THIS EXISTS (audit 2026-11, finding M3). The decision compares the
 * foreground window's rect with the dog's display, and the dog's display comes
 * from Electron in **DIPs** (device-independent pixels). Until this change the
 * helper ran as an ordinary `powershell.exe` 5.1, which declares no DPI
 * awareness in its manifest, so Windows' DPI virtualisation handed it every
 * rect in a **96-DPI logical space** — measured on the audit PC:
 * `GetProcessDpiAwareness` = UNAWARE, `GetDpiForSystem` = 96. On one display
 * that logical space *is* Electron's DIP space, at any scale (a fullscreen
 * film at 125 % reads 1536 × 960 on both sides), which is why the single-display
 * case always worked. With several displays at different scales it is not: an
 * unaware process sees each monitor keep its *physical* top-left and shrink by
 * 96/dpi, while Chromium lays its DIP displays out edge to edge. A 100 %
 * monitor to the right of a 150 % primary is at x = 1920 for the helper and at
 * x = 1280 for Electron, so a film there never covered the dog's display and a
 * dog sitting on it never slept. (Predicted from the documented behaviour of
 * both sides; the audit PC has a single display, so it was not seen on screen.)
 *
 * THE FIX. The helper now makes its sampling thread per-monitor DPI aware and
 * reports **physical pixels** for both the window and its monitor, and says so
 * (`"physical":1` on the line). Physical virtual-screen coordinates are the one
 * space every process agrees on. This file then maps the window through the
 * display Windows itself put it on — the monitor rect the helper reported,
 * matched against each Electron display's physical rect — using that display's
 * own origin and scale. That is exactly how Chromium converts a point on a
 * display, so the window lands in the same DIP space as the dog's display.
 *
 * A line *without* the flag (a helper on a Windows too old for per-monitor
 * awareness, which falls back to today's behaviour) is left alone: its numbers
 * are already logical, and scaling them again would turn the single-display
 * 125 % case — which works — into a miss (1536 would become ~1229).
 */
import type { Rect } from '../core/geometry';

/** One display in both of the spaces the mapping needs. */
export interface DisplayUnits {
  /** Electron's `Display.bounds`: DIPs, the space the decision runs in. */
  readonly dip: Rect;
  /** The same display in physical virtual-screen pixels (`dipToScreenRect`). */
  readonly physical: Rect;
}

/** The part of a helper sample this mapping touches. */
export interface PhysicalSample {
  readonly bounds: Rect;
  readonly monitor?: Rect;
}

/** Overlap area of two rects; 0 when they do not meet. */
function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The display a physical rect belongs to: the one whose physical rect it
 * overlaps most, or `null` when it overlaps none.
 *
 * Given the helper's *monitor* rect this is an exact match (the two describe the
 * same monitor in the same units), so it is Windows' own `MonitorFromWindow`
 * choice that decides which scale a window is mapped with — not a guess from the
 * window's extent, which for a maximised window overhangs by the resize border.
 */
export function physicalDisplayFor(rect: Rect, displays: readonly DisplayUnits[]): DisplayUnits | null {
  let best: DisplayUnits | null = null;
  let bestArea = 0;
  for (const display of displays) {
    const area = overlap(rect, display.physical);
    if (area > bestArea) {
      bestArea = area;
      best = display;
    }
  }
  return best;
}

/**
 * A physical rect mapped into DIPs through one display's origin and scale.
 *
 * Edges, not origin plus size, are mapped and then rounded, so a rect that
 * reaches a display edge in physical pixels reaches the same edge in DIPs
 * exactly; rounding is at most half a DIP, well inside the decision's 2 px
 * tolerance. A rect that extends past the display (a maximised window's 8 px
 * resize border, or a window spanning two monitors) is extrapolated linearly
 * with the same scale — exact on this display, approximate beyond it.
 */
export function physicalToDip(rect: Rect, display: DisplayUnits): Rect {
  const sx = display.dip.width / display.physical.width;
  const sy = display.dip.height / display.physical.height;
  const left = Math.round(display.dip.x + (rect.x - display.physical.x) * sx);
  const top = Math.round(display.dip.y + (rect.y - display.physical.y) * sy);
  const right = Math.round(display.dip.x + (rect.x + rect.width - display.physical.x) * sx);
  const bottom = Math.round(display.dip.y + (rect.y + rect.height - display.physical.y) * sy);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * A physical-pixel helper sample in DIPs, or `null` when it cannot be placed.
 *
 *  - The display is chosen by the helper's monitor rect when there is one, and
 *    by the window's own rect otherwise.
 *  - `monitor` becomes that display's DIP bounds, so it stays in the same units
 *    as `bounds` — the decision falls back to it when Electron's display list is
 *    momentarily empty.
 *  - **No displays at all** (Electron mid-reconfiguration): returned unchanged.
 *    Both rects are then physical, so the decision's last-resort comparison of
 *    the window with its own monitor is still self-consistent.
 *  - **Displays, but none that matches**: `null`, which the decision reads as
 *    "no window" and so *not* fullscreen. Comparing physical pixels with a DIP
 *    display could read a merely large window as covering a smaller-in-DIPs
 *    display — a false sleep — and a dog that stays awake for one sample while
 *    displays settle is the harmless direction.
 *  - A display with no physical extent cannot be scaled through and is skipped.
 */
export function sampleToDip<T extends PhysicalSample>(
  sample: T,
  displays: readonly DisplayUnits[]
): T | null {
  const usable = displays.filter((d) => d.physical.width > 0 && d.physical.height > 0);
  if (usable.length === 0) return sample;
  const display = physicalDisplayFor(sample.monitor ?? sample.bounds, usable);
  if (display === null) return null;
  return {
    ...sample,
    bounds: physicalToDip(sample.bounds, display),
    ...(sample.monitor === undefined ? {} : { monitor: display.dip })
  };
}

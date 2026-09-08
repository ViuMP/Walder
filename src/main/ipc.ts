/**
 * The one and only IPC channel table, plus payload types and validators.
 *
 * Deliberately free of any `electron` import: the preload (sandboxed, CJS) and
 * the renderer's ambient types both need these names, and pulling `ipcMain` into
 * a preload bundle would be wrong. The `ipcMain`/`webContents` wiring lives next
 * door in `ipc-bridge.ts`.
 *
 * **The renderer is untrusted.** It runs sandboxed under a strict CSP, but a
 * compromised renderer must not be able to move the window to nonsense
 * coordinates, blow up the main process, or flip the click-through state into a
 * shape the window API rejects. Every renderer -> main payload therefore goes
 * through a validator here, and a payload that fails is dropped, not coerced.
 */
import type { Palette, SpriteSheet } from '../sprites/types';

/** All channels carry the `walder:` prefix so nothing collides with Electron's own. */
export const CH = {
  // main -> renderer (send)
  modeSet: 'walder:mode:set',
  paletteSet: 'walder:palette:set',
  sheetSet: 'walder:sheet:set',
  hitResync: 'walder:hit:resync',
  // renderer -> main (invoke/handle)
  hitSet: 'walder:hit:set',
  dragStart: 'walder:drag:start',
  dragMove: 'walder:drag:move',
  dragEnd: 'walder:drag:end',
  pet: 'walder:pet',
  menuOpen: 'walder:menu:open',
  settingsGet: 'walder:settings:get'
} as const;

/* ------------------------------------------------------------------ payloads */

export type SizeName = 'small' | 'medium' | 'large';
export type BoxName = 'stand' | 'sleep';

/** Logical pixels per sprite pixel, per size. The only scales the window knows. */
export const SCALE_BY_SIZE: Readonly<Record<SizeName, 2 | 3 | 4>> = {
  small: 2,
  medium: 3,
  large: 4
};

export const SIZE_NAMES: readonly SizeName[] = ['small', 'medium', 'large'];

/**
 * Total cursor movement under this many screen pixels makes a mouse-up a click
 * (a pet) rather than the end of a drag. The renderer decides, because only it
 * knows how far the cursor travelled; main just receives `pet` or nothing.
 */
export const CLICK_SLOP_PX = 4;

/** Which sprite box to draw, and how big. */
export interface ModePayload {
  readonly scale: number;
  readonly box: BoxName;
}

/** A colour variant. `colors` is `null` when the sheet has no such palette. */
export interface PalettePayload {
  readonly name: string;
  readonly colors: Palette | null;
}

export interface SheetPayload {
  readonly sheet: SpriteSheet;
}

/** Inside = the cursor is over opaque sprite pixels, so the window should take clicks. */
export interface HitPayload {
  readonly inside: boolean;
}

/*
 * `hit:resync` carries no payload. It exists because the click-through state is
 * held in two places: main owns the window flag, the renderer owns the cached
 * answer to "is the cursor on ink" and only speaks up when that answer *changes*.
 * When main changes the flag for a reason the renderer did not cause — turning
 * the force-interactive escape hatch off, say — those two copies disagree, and
 * the renderer would stay silent until the cursor next crossed the outline. A
 * resync makes it re-derive and re-send unconditionally.
 */

/** Cursor movement since `drag:start`, in screen pixels. Cumulative, not incremental. */
export interface DragMovePayload {
  readonly dxScreen: number;
  readonly dyScreen: number;
}

/** Everything the renderer needs to draw its first frame, in one round trip. */
export interface SettingsPayload {
  readonly sheet: SpriteSheet;
  readonly mode: ModePayload;
  readonly palette: PalettePayload;
  readonly forceInteractive: boolean;
}

/* ---------------------------------------------------------------- validators */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Largest cursor delta accepted in one drag, in screen pixels. */
const MAX_DRAG_PX = 100_000;

/** `{inside: boolean}` or `null` if the payload is not that. */
export function parseHitPayload(raw: unknown): HitPayload | null {
  if (!isRecord(raw)) return null;
  const inside = raw['inside'];
  if (typeof inside !== 'boolean') return null;
  return { inside };
}

/**
 * `{dxScreen, dyScreen}` as finite numbers within a sane range, or `null`.
 * NaN would silently become an unmovable window; a huge value would fling it
 * past every display and force a clamp on every move.
 */
export function parseDragMovePayload(raw: unknown): DragMovePayload | null {
  if (!isRecord(raw)) return null;
  const dx = raw['dxScreen'];
  const dy = raw['dyScreen'];
  if (typeof dx !== 'number' || typeof dy !== 'number') return null;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (Math.abs(dx) > MAX_DRAG_PX || Math.abs(dy) > MAX_DRAG_PX) return null;
  return { dxScreen: Math.round(dx), dyScreen: Math.round(dy) };
}

export function isSizeName(value: unknown): value is SizeName {
  return value === 'small' || value === 'medium' || value === 'large';
}

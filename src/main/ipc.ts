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
import type { Rect } from '../core/geometry';
import type { UsageSnapshot } from '../core/usage';
import type { Palette, SpriteSheet } from '../sprites/types';

/** All channels carry the `walder:` prefix so nothing collides with Electron's own. */
export const CH = {
  // main -> renderer (send)
  modeSet: 'walder:mode:set',
  paletteSet: 'walder:palette:set',
  sheetSet: 'walder:sheet:set',
  hitResync: 'walder:hit:resync',
  usageUpdate: 'walder:usage:update',
  // renderer -> main (invoke/handle)
  hitSet: 'walder:hit:set',
  dragStart: 'walder:drag:start',
  dragMove: 'walder:drag:move',
  dragEnd: 'walder:drag:end',
  pet: 'walder:pet',
  menuOpen: 'walder:menu:open',
  settingsGet: 'walder:settings:get',
  hoverEnter: 'walder:hover:enter',
  hoverLeave: 'walder:hover:leave',
  refreshNow: 'walder:refresh:now',
  authLogin: 'walder:auth:login',
  authLogout: 'walder:auth:logout',
  panelSize: 'walder:panel:size'
} as const;

/* ------------------------------------------------------------------ payloads */

export type SizeName = 'small' | 'medium' | 'large';
export type BoxName = 'stand' | 'sleep';

/**
 * Logical pixels per sprite pixel, per size. The only scales the window knows.
 *
 * Capped at 3x by the owner's decision at the 2026-09-08 design gate: the 4x dog
 * was too big to live on a desktop. `medium` (2x) stays the default.
 */
export const SCALE_BY_SIZE: Readonly<Record<SizeName, 1 | 2 | 3>> = {
  small: 1,
  medium: 2,
  large: 3
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
  /** The last snapshot, so the dog has a face before the first poll returns. */
  readonly usage: UsageSnapshot | null;
}

/** A fresh (or restored) usage snapshot, sent to both windows. */
export type UsagePayload = UsageSnapshot;

/**
 * The cursor came to rest on the dog's ink.
 *
 * `spriteRectScreen` is the sprite's opaque bounds in *screen* coordinates —
 * only the renderer knows them, because only it knows which frame is showing and
 * where the silhouette is inside the mostly-transparent window. The panel is
 * placed against this rect, not the window rect, so the gap beside the dog does
 * not grow with his size.
 */
export interface HoverEnterPayload {
  readonly spriteRectScreen: Rect;
}

/** Which service a login/logout request is about. */
export interface ServicePayload {
  readonly service: ServiceName;
}

export type ServiceName = 'claude' | 'chatgpt';
export const SERVICE_NAMES: readonly ServiceName[] = ['claude', 'chatgpt'];

/**
 * The panel renderer reporting how tall its card came out.
 *
 * The panel's width is fixed at 300 px and its height depends on how many
 * buckets and status lines there are, which only the renderer knows after
 * layout. A frameless window cannot size itself, so it measures and asks.
 */
export interface PanelSizePayload {
  readonly height: number;
}

/** Fixed panel width, in logical pixels. Matches the design. */
export const PANEL_WIDTH = 300;
/** Sanity bounds on a renderer-reported panel height. */
export const PANEL_MIN_HEIGHT = 40;
export const PANEL_MAX_HEIGHT = 2_000;

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

export function isServiceName(value: unknown): value is ServiceName {
  return value === 'claude' || value === 'chatgpt';
}

/** Largest sprite rect accepted, in screen pixels — well past any real display. */
const MAX_RECT_PX = 100_000;

function isSaneCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_RECT_PX;
}

function isSaneExtent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_RECT_PX;
}

/**
 * `{spriteRectScreen: {x, y, width, height}}`, or `null`.
 *
 * A zero or negative extent is rejected rather than clamped: it would place a
 * panel against a rect that describes nothing, and silently showing the panel in
 * the wrong corner is harder to notice than not showing it at all.
 */
export function parseHoverEnterPayload(raw: unknown): HoverEnterPayload | null {
  if (!isRecord(raw)) return null;
  const rect = raw['spriteRectScreen'];
  if (!isRecord(rect)) return null;
  if (!isSaneCoordinate(rect['x']) || !isSaneCoordinate(rect['y'])) return null;
  if (!isSaneExtent(rect['width']) || !isSaneExtent(rect['height'])) return null;
  return {
    spriteRectScreen: {
      x: Math.round(rect['x']),
      y: Math.round(rect['y']),
      width: Math.round(rect['width']),
      height: Math.round(rect['height'])
    }
  };
}

/**
 * `{service: 'claude' | 'chatgpt'}`, or `null`.
 *
 * The strictest validator here, because this one opens a real browser window on
 * a real login page: an unrecognised service must never fall through to a
 * default, so the enum is closed and anything else is dropped.
 */
export function parseServicePayload(raw: unknown): ServicePayload | null {
  if (!isRecord(raw)) return null;
  const service = raw['service'];
  if (!isServiceName(service)) return null;
  return { service };
}

/** `{height}` within sane bounds, rounded up to a whole pixel, or `null`. */
export function parsePanelSizePayload(raw: unknown): PanelSizePayload | null {
  if (!isRecord(raw)) return null;
  const height = raw['height'];
  if (typeof height !== 'number' || !Number.isFinite(height)) return null;
  if (height < PANEL_MIN_HEIGHT || height > PANEL_MAX_HEIGHT) return null;
  return { height: Math.ceil(height) };
}

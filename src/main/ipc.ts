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
import type { SceneEvent } from '../core/behaviour';
// Type-only: `facing:set` runs main -> renderer, so the *renderer* is the side
// that validates it (with `isFacing`, straight from `core/facing`). Nothing
// arrives here to be parsed.
import type { Facing } from '../core/facing';
import { isCardSize, isResetStyle, type CardSize, type ResetStyle } from '../core/card-layout';
import {
  parseSessionsPayload,
  type SessionEntry,
  type SessionsPayload
} from '../core/sessions';
import type { Rect } from '../core/geometry';
import { SERVICES, isServiceName, type ServiceName } from '../core/services';
import type { CreditPrice, UsageSnapshot } from '../core/usage';
import type { Palette, SpriteSheet } from '../sprites/types';

/** All channels carry the `walder:` prefix so nothing collides with Electron's own. */
export const CH = {
  // main -> renderer (send)
  modeSet: 'walder:mode:set',
  paletteSet: 'walder:palette:set',
  sheetSet: 'walder:sheet:set',
  hitResync: 'walder:hit:resync',
  facingSet: 'walder:facing:set',
  /*
   * The card's own size (Large / Medium / Small), pushed to the panel window.
   *
   * A channel of its own rather than a field on `usage:update`, deliberately:
   * that payload is also what feeds the bark machine and the dog's face, and a
   * menu click that changes nothing but a layout must not travel down a path
   * that can make him yelp. It also means the size can change while no poll has
   * ever returned, which is exactly when the owner is trying the three sizes out.
   */
  cardSizeSet: 'walder:cardSize:set',
  /** How the card words a reset horizon, pushed to the panel — as `cardSize` is. */
  resetStyleSet: 'walder:resetStyle:set',
  /** The optional threshold-bark sound, pushed to the overlay only. */
  barkSoundSet: 'walder:barkSound:set',
  /**
   * The live coding sessions, pushed to the panel whenever one of them moves.
   *
   * Its own channel for the same reason `cardSize` has one: this fires on
   * every hook event, several times a minute while the owner is working, and
   * it must not travel down `usage:update` — that payload feeds the bark
   * machine and the dog's face, and a session changing state must not be able
   * to make him yelp about a usage threshold.
   */
  sessionsSet: 'walder:sessions:set',
  usageUpdate: 'walder:usage:update',
  scene: 'walder:scene',
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
 *
 * On the v3 sheet's 72 x 72 `stand` box that is 72 / 144 / 216 screen pixels.
 * 144 is the size the art is drawn for and the owner's stated maximum, so
 * `large` is knowingly past it — kept because the three-entry menu is what he
 * asked for and a high-DPI screen makes 3x reasonable, and called out as such in
 * the README rather than quietly offered as if it were designed for.
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

/**
 * Which sprite box to draw, how big, and which way round.
 *
 * `facing` rides along rather than arriving as a separate first message because
 * `mode` is what the renderer's *first* paint is built from (`settings:get`):
 * without it a dog whose window is on the left half of the screen would draw one
 * frame facing the wrong way and then turn, which reads as a glitch on launch.
 * Every later change comes over `facing:set` alone — the box and scale are
 * untouched by a turn, and resizing the window for one would be wrong.
 */
export interface ModePayload {
  readonly scale: number;
  readonly box: BoxName;
  readonly facing: Facing;
  /**
   * Is the dog off screen right now (the hide-when-idle mode)?
   *
   * Presence is otherwise a `visible` *scene event*, and an edge — which is
   * exactly why it also has to be carried here. The coordinator emits its first
   * `visible:false` inside `createBehaviour`, synchronously, long before the
   * overlay page has loaded: that message is sent to a renderer that does not
   * exist yet and is simply lost, and the renderer then animated a hidden dog at
   * full cadence (`backgroundThrottling: false` keeps a hidden window ticking)
   * with no `visible` event ever coming to tell it otherwise. The same hole
   * reopens whenever `ensureOverlay` rebuilds the window after a renderer crash.
   *
   * So presence is *state* on the payload the renderer pulls for its first frame
   * (`settings:get`) and on every `mode:set`, and the renderer feeds it through
   * the same code path as the scene event. Sourced from `Overlay.isShown()`,
   * which is written by nothing but those events (`Behaviour.hidden` at one
   * remove), so the two cannot disagree.
   */
  readonly hidden: boolean;
  /**
   * Is still mode on (tray ▸ **Still mode**)? State, not an event, for exactly
   * the same reason `hidden` is: it is set from the store during startup, long
   * before the overlay page can hear about it.
   *
   * It is only *half* the answer. The renderer ORs it with the OS's own
   * `prefers-reduced-motion`, which main cannot see from here and has no
   * business reading — the query belongs to the window doing the drawing.
   */
  readonly still: boolean;
}

/** Which way the dog is looking. Main decides; see `core/facing.ts`. */
export interface FacingPayload {
  readonly facing: Facing;
}

/**
 * Which of the three card layouts to draw. Main owns the preference (it is in
 * the store and in the tray menu); the panel renderer redraws from it.
 *
 * Re-exported below alongside `isCardSize`, the way `Facing` is imported here:
 * this runs main -> renderer, so the *renderer* is the side that validates it.
 */
export interface CardSizePayload {
  readonly cardSize: CardSize;
}

/** The same arrangement for the reset wording: main owns it, the panel redraws. */
export interface ResetStylePayload {
  readonly resetStyle: ResetStyle;
}

/** Main owns the preference; the overlay only needs its present on/off state. */
export interface BarkSoundPayload {
  readonly barkSound: boolean;
}

export function parseBarkSoundPayload(raw: unknown): BarkSoundPayload | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { barkSound } = raw as Record<string, unknown>;
  return typeof barkSound === 'boolean' ? { barkSound } : null;
}

export type { CardSize, ResetStyle };
export { isCardSize, isResetStyle };

/*
 * The sessions payload and its validator live in `core/sessions.ts`, beside
 * the reducer that produces the entries, and are re-exported here the way
 * `isCardSize` is: the panel renderer validates this one on arrival and cannot
 * import from `src/main` at runtime, while everything main-side already looks
 * for payload names in this file.
 */
export type { SessionEntry, SessionsPayload };
export { parseSessionsPayload };

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
  /**
   * The stored card size, so the panel's first paint is already the right
   * layout. Without it a Small card would draw itself Large for one frame and
   * then shrink — and, worse, report the Large height to main, which would size
   * the window around a card that no longer exists.
   */
  readonly cardSize: CardSize;
  /**
   * The stored reset wording, pulled with the first frame for the same reason
   * `cardSize` is: otherwise every reset line on the card would say one thing
   * for a frame and another once the tray's push arrived.
   */
  readonly resetStyle: ResetStyle;
  /** Whether threshold nudges may play the optional bark asset. */
  readonly barkSound: boolean;
  /**
   * What one Codex credit costs, so the credit-limit row can show an amount
   * rather than a bare count. `null` means the owner turned the estimate off.
   *
   * Pulled with the first frame like `cardSize` and — unlike `cardSize` — never
   * pushed afterwards: there is no UI that changes it, so it cannot change
   * while the app runs.
   */
  readonly codexCreditPrice: CreditPrice | null;
  /**
   * The live sessions, pulled with the first frame for the same reason `usage`
   * is: the panel is usually loaded long after the events that built the list,
   * so without this the SESSIONS block would be empty until the next hook.
   *
   * Optional so a caller that has no session source wired — every test that
   * builds a `SettingsPayload` by hand — is unchanged.
   */
  readonly sessions?: readonly SessionEntry[];
}

/** A fresh (or restored) usage snapshot, sent to both windows. */
export type UsagePayload = UsageSnapshot;

/**
 * One scene event from the behaviour coordinator — a face, a bubble or an
 * animation to play.
 *
 * Sent one event per message rather than as a batch, deliberately: a `mode`
 * event is *not* forwarded at all (it is a window resize, which main performs,
 * and the renderer learns about the new box on `mode:set` instead), and the
 * remaining events must reach the renderer in the same order they were emitted
 * relative to that resize. One message each keeps that ordering obvious.
 *
 * `visible` **is** forwarded, unlike `mode`, and is the one event both sides act
 * on: main hides or shows the window, and the renderer stops or restarts its own
 * animation timer (`backgroundThrottling: false` means a hidden window keeps
 * ticking otherwise).
 */
export type ScenePayload = SceneEvent;

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

/** Re-exported from `core/services`, the one place the list is written. */
export type { ServiceName };
export const SERVICE_NAMES: readonly ServiceName[] = SERVICES;
export { isServiceName };

/**
 * The panel renderer reporting how tall its card came out.
 *
 * The panel's width is fixed per card size (`cardWidthFor` in
 * `core/card-layout.ts`) and its height depends on how many buckets and status
 * lines there are, which only the renderer knows after layout. A frameless
 * window cannot size itself, so it measures and asks.
 */
export interface PanelSizePayload {
  readonly height: number;
}

/*
 * `PANEL_WIDTH` is gone: the width is now a function of the card size, and
 * lives with the rest of the layout in `core/card-layout.ts` (`CARD_WIDTH`,
 * `cardWidthFor`). A constant here would have been a fourth opinion about how
 * wide the card is, next to the three that are real.
 */

/**
 * Sanity bounds on a renderer-reported panel height.
 *
 * **24, not 40.** A Small card with a single window row measures about 41 px,
 * and `parsePanelSizePayload` *drops* an out-of-range payload rather than
 * clamping it — so a floor above the smallest real card does not shrink the
 * window a little too much, it leaves the window at `PANEL_INITIAL_HEIGHT`
 * (220 px) with a 41 px card floating in the top of it and no error anywhere.
 * 24 is below the smallest layout this card can produce (border 6 + padding 16
 * is already 22 with no content at all) while still rejecting the 0-and-negative
 * values the bound exists for.
 */
export const PANEL_MIN_HEIGHT = 24;
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

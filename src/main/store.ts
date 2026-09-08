/**
 * Persisted settings, on disk under `app.getPath('userData')/walder.json`.
 *
 * Two things make this more than a thin wrapper. First, the JSON schema: the file
 * is user-writable, and a hand-mangled value must not reach the window API, so
 * anything that fails validation is discarded (`clearInvalidConfig`) rather than
 * crashing the app on launch. Second, per-display positions: the dog is
 * remembered per display, so undocking a laptop does not drop it in the middle of
 * nowhere — and re-docking puts it back where it was.
 */
import { app, screen } from 'electron';
import type { Display } from 'electron';
import Store from 'electron-store';
import type { Schema } from 'electron-store';
import {
  bottomRightOf,
  clampRectToWorkAreas,
  type Rect,
  type RectInset
} from '../core/geometry';
import { isSizeName, type SizeName } from './ipc';
import { vlog } from './log';

export interface Point {
  x: number;
  y: number;
}

export interface WalderSettings {
  /** `displayKey` -> top-left window position on that display. */
  positions: Record<string, Point>;
  size: SizeName;
  /** Palette name; may name a palette the current sheet lacks (renderer falls back). */
  palette: string;
  launchAtLogin: boolean;
  pollIntervalSec: number;
  hookPort: number;
  /** Debug escape hatch: when true the window never becomes click-through. */
  forceInteractive: boolean;
}

export type WalderStore = Store<WalderSettings>;

export const DEFAULTS: WalderSettings = {
  positions: {},
  size: 'medium',
  palette: 'golden',
  launchAtLogin: false,
  pollIntervalSec: 180,
  hookPort: 47811,
  forceInteractive: false
};

/**
 * Inset from the work-area edge for the default resting position, and for the
 * "Reset position" escape hatch in the tray menu.
 */
export const EDGE_MARGIN = 16;

const schema: Schema<WalderSettings> = {
  positions: {
    type: 'object',
    // Keys are display ids, so they cannot be enumerated up front.
    additionalProperties: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y']
    },
    default: {}
  },
  size: { type: 'string', enum: ['small', 'medium', 'large'], default: 'medium' },
  palette: { type: 'string', minLength: 1, default: 'golden' },
  launchAtLogin: { type: 'boolean', default: false },
  pollIntervalSec: { type: 'number', minimum: 30, maximum: 86_400, default: 180 },
  hookPort: { type: 'number', minimum: 1024, maximum: 65_535, default: 47_811 },
  forceInteractive: { type: 'boolean', default: false }
};

/**
 * Open the settings file. Must be called after `app.whenReady()` — before that,
 * `app.getPath('userData')` is not settled.
 */
export function createStore(): WalderStore {
  const store = new Store<WalderSettings>({
    name: 'walder',
    schema,
    defaults: DEFAULTS,
    // A corrupt or hand-edited file resets to defaults instead of throwing on
    // launch. Losing a remembered position beats a mascot that cannot start.
    clearInvalidConfig: true
  });
  vlog('store path:', store.path);
  return store;
}

/**
 * Identity of a display for position memory. The size is part of the key on
 * purpose: the same monitor at a different resolution is a different canvas, and
 * a remembered corner would land in the wrong place (or off-screen).
 */
export function displayKey(display: Display): string {
  return `${display.id}:${display.bounds.width}x${display.bounds.height}`;
}

function workAreas(): Rect[] {
  return screen.getAllDisplays().map((d) => d.workArea);
}

/** Read `size`, tolerating a value the schema somehow let through. */
export function readSize(store: WalderStore): SizeName {
  const raw = store.get('size');
  return isSizeName(raw) ? raw : DEFAULTS.size;
}

/**
 * Where to put the window on launch.
 *
 * Prefers a saved position on a display that still exists and still has the same
 * resolution, checking the primary display first so a docked laptop does not put
 * the dog on the external monitor just because it enumerates first. Anything else
 * (first run, unplugged monitor, changed resolution) falls back to the
 * bottom-right of the primary display's work area. The chosen point is clamped
 * either way, because a saved position can predate a work-area change (a dock
 * appearing, a menu bar resizing).
 */
export function resolveStartPosition(
  store: WalderStore,
  width: number,
  height: number,
  inset?: RectInset
): { x: number; y: number } {
  const positions = store.get('positions');
  const areas = workAreas();

  const primary = screen.getPrimaryDisplay();
  const ordered = [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)];

  for (const display of ordered) {
    const key = displayKey(display);
    const saved = positions[key];
    if (saved === undefined) continue;
    if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) continue;
    const clamped = clampRectToWorkAreas({ x: saved.x, y: saved.y, width, height }, areas, inset);
    vlog('start position from saved display key', key, clamped);
    return clamped;
  }

  const spot = defaultPosition(width, height);
  vlog('start position default (bottom-right of primary)', spot);
  return spot;
}

/**
 * The dog's home corner: bottom-right of the *primary* display's work area,
 * inset by `EDGE_MARGIN`. Both the first-run position and the tray's "Reset
 * position" use this, so the escape hatch lands exactly where a fresh install
 * would — the one place the owner can always find it.
 */
export function defaultPosition(width: number, height: number): { x: number; y: number } {
  return bottomRightOf(screen.getPrimaryDisplay().workArea, width, height, EDGE_MARGIN);
}

/**
 * Remember where the window is now, under the display it currently sits on.
 * Called on drag end and after a size change.
 */
export function savePosition(store: WalderStore, bounds: Rect): void {
  const centre = {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2)
  };
  const display = screen.getDisplayNearestPoint(centre);
  const positions = { ...store.get('positions') };
  positions[displayKey(display)] = { x: Math.round(bounds.x), y: Math.round(bounds.y) };
  store.set('positions', positions);
  vlog('saved position', displayKey(display), positions[displayKey(display)]);
}

/*
 * Note: positions for displays that are not currently attached are deliberately
 * *kept*. Pruning them would mean a laptop that is undocked once forgets where
 * the dog sat on the desk monitor. Each entry is a few bytes, and there are only
 * ever as many as the machine has seen display configurations.
 */

/**
 * Clamp a rect against the live work areas. Thin wrapper so callers skip
 * `screen`. Pass `inset` (see `inkInset`) so the guard measures the sprite and
 * not the transparent padding around it.
 */
export function clampToDisplays(rect: Rect, inset?: RectInset): { x: number; y: number } {
  return clampRectToWorkAreas(rect, workAreas(), inset);
}

/**
 * Apply the persisted launch-at-login preference to the OS — but only from a
 * packaged app, and only when it differs from what the OS already thinks.
 *
 * `app.isPackaged` gates the write because the login-item API cannot work from
 * an unsigned, unpackaged build (which is exactly `npm run dev`): macOS refuses
 * it and Electron logs the refusal as a native ERROR line, so a dev run would
 * print an alarming error for a setting that was never going to take effect.
 * Comparing before writing keeps the useful direction working in a real build:
 * if the user removed the item in System Settings, a stored `true` is re-applied.
 */
export function applyLaunchAtLogin(openAtLogin: boolean): void {
  if (!app.isPackaged) {
    vlog('login item skipped (not a packaged app):', openAtLogin);
    return;
  }
  if (app.getLoginItemSettings().openAtLogin === openAtLogin) return;
  app.setLoginItemSettings({ openAtLogin });
  vlog('login item ->', openAtLogin);
}

/**
 * What the OS actually reports, for the tray checkbox.
 *
 * Packaged, the OS is the truth: the user can remove the login item in System
 * Settings, and a checkbox reading the store would then lie. Unpackaged there is
 * no login item to read, so the stored preference is all there is — and the menu
 * shows that item disabled, because ticking it could not do anything.
 */
export function launchAtLoginState(store: WalderStore): { on: boolean; editable: boolean } {
  if (!app.isPackaged) return { on: store.get('launchAtLogin') === true, editable: false };
  return { on: app.getLoginItemSettings().openAtLogin, editable: true };
}

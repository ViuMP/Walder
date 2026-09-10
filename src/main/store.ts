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
import type { PersistedSnapshot } from '../core/usage';
import { defaultHideShortcut, looksLikeAccelerator } from '../core/shortcuts';
import { MAX_DISCOVERED } from '../providers/endpoint-discovery';
import { DEFAULT_CARD_SIZE, isCardSize, type CardSize } from '../core/card-layout';
import { isSizeName, type SizeName } from './ipc';
import { vlog } from './log';

/**
 * The platform's default hide shortcut, computed once at module load.
 *
 * `process.platform` cannot change under a running process, and the value is
 * needed in two places that must agree — the JSON schema's `default` and
 * `DEFAULTS` — so computing it twice would be two chances to disagree.
 */
const DEFAULT_HIDE_SHORTCUT = defaultHideShortcut(process.platform);

export interface Point {
  x: number;
  y: number;
}

export interface WalderSettings {
  /** `displayKey` -> top-left window position on that display. */
  positions: Record<string, Point>;
  size: SizeName;
  /**
   * Which of the three hover-card layouts to draw — **independent of `size`**,
   * which is the dog. A 3x dog with a Small card is a perfectly reasonable
   * choice (the mascot big, the numbers terse), and tying the two would take
   * that away for the sake of one fewer setting.
   */
  cardSize: CardSize;
  /** Palette name; may name a palette the current sheet lacks (renderer falls back). */
  palette: string;
  launchAtLogin: boolean;
  pollIntervalSec: number;
  /** Preferred port for the Claude Code hook listener (`main/hook-server.ts`). */
  hookPort: number;
  /**
   * The port the listener actually bound, which may be `hookPort + 1` or `+ 2`
   * when the preferred one was taken. Written by the server at startup and read
   * by the hook installer, so the command in `~/.claude/settings.json` points at
   * a port that is really listening. `null` before the first successful bind.
   */
  hookPortActual: number | null;
  /**
   * Curl up in the tiny sleeping box while a fullscreen window is up — a film, a
   * presentation, a game. On by default: above full-screen video is the one
   * place a mascot is unambiguously in the way.
   */
  sleepInFullscreen: boolean;
  /**
   * Stay off screen entirely unless there is something to say — a bark, a `?`, a
   * `woof`, an empty allowance, a login that has expired, or a new version.
   *
   * Off by default: the whole point of a mascot is that he is there, and an
   * owner who has just installed one should see it. The mode is for the second
   * week.
   */
  hideWhenIdle: boolean;
  /**
   * The global shortcut that toggles `hideWhenIdle`, as an Electron
   * accelerator. Platform-dependent default — see `defaultHideShortcut`.
   */
  hideShortcut: string;
  /**
   * Ask GitHub every six hours whether a newer Walder exists. On by default;
   * README's Privacy section documents it, and unticking it means no request is
   * ever made.
   */
  checkForUpdates: boolean;
  /**
   * The newest version Walder has already told the owner about, so the "0.1.3
   * is out" bubble appears once and not on every check for the rest of the
   * version's life. `null` before the first notice.
   */
  updateNotifiedVersion: string | null;
  /** Debug escape hatch: when true the window never becomes click-through. */
  forceInteractive: boolean;
  /**
   * Write the detailed diagnostics to the log file, not just the warnings
   * (tray ▸ Developer ▸ Verbose log; `setVerbose` in `log.ts`).
   *
   * Persisted rather than session-only on purpose: the faults worth capturing —
   * a login that stops taking, a poll that quietly fails — are intermittent, so
   * the owner has to be able to tick this and leave it ticked until the next
   * occurrence, across restarts.
   */
  verboseLog: boolean;
  /**
   * Quota-ish request paths observed while a chatgpt.com login window was open
   * (`providers/endpoint-discovery.ts`). Path + query only, tried first by the
   * `chatgpt-web` provider. Never shown to the owner and never sent anywhere but
   * back to `chatgpt.com`.
   */
  chatgptDiscoveredEndpoints: string[];
  /** The same for claude.ai. Informational: the claude.ai route is already known. */
  claudeDiscoveredEndpoints: string[];
  /**
   * The last usage snapshot, trimmed by `trimSnapshot` — percentages, labels and
   * reset times only, never a provider's raw payload and never a credential. It
   * exists so the dog has a real face the moment he appears rather than a
   * confused one until the first poll returns.
   */
  lastSnapshot: PersistedSnapshot | null;
}

export type WalderStore = Store<WalderSettings>;

export const DEFAULTS: WalderSettings = {
  positions: {},
  size: 'medium',
  cardSize: DEFAULT_CARD_SIZE,
  palette: 'golden',
  launchAtLogin: false,
  pollIntervalSec: 180,
  hookPort: 47811,
  hookPortActual: null,
  sleepInFullscreen: true,
  hideWhenIdle: false,
  hideShortcut: DEFAULT_HIDE_SHORTCUT,
  checkForUpdates: true,
  updateNotifiedVersion: null,
  forceInteractive: false,
  verboseLog: false,
  chatgptDiscoveredEndpoints: [],
  claudeDiscoveredEndpoints: [],
  lastSnapshot: null
};

/**
 * Inset from the work-area edge for the default resting position, and for the
 * "Reset position" escape hatch in the tray menu.
 */
export const EDGE_MARGIN = 16;

/**
 * The JSON schema `electron-store` validates the file against. Exported so a
 * test can assert the two deliberate choices in it — the `maxItems` cap on the
 * discovered-endpoint lists, and the permissive `lastSnapshot` type — without
 * opening a real store.
 */
export const SETTINGS_SCHEMA: Schema<WalderSettings> = {
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
  /*
   * Deliberately just "a string" — no `enum`, unlike `size` right above it.
   *
   * The same trade `hideShortcut` makes below: `clearInvalidConfig` wipes the
   * *whole* settings file when any single value fails the schema, so an `enum`
   * here would mean a hand-typed `cardSize: "tiny"` costs the owner his
   * position memory, his coat and his logins-adjacent preferences as well. The
   * real validation is `readCardSize`, which falls back to Large and keeps
   * everything else.
   *
   * `size` keeps its enum because it predates this reasoning and changing it
   * would be a schema migration for no benefit — not because the enum is right.
   */
  cardSize: { type: 'string', default: DEFAULT_CARD_SIZE },
  palette: { type: 'string', minLength: 1, default: 'golden' },
  launchAtLogin: { type: 'boolean', default: false },
  pollIntervalSec: { type: 'number', minimum: 30, maximum: 86_400, default: 180 },
  hookPort: { type: 'number', minimum: 1024, maximum: 65_535, default: 47_811 },
  hookPortActual: { type: ['number', 'null'], minimum: 1024, maximum: 65_535, default: null },
  sleepInFullscreen: { type: 'boolean', default: true },
  hideWhenIdle: { type: 'boolean', default: false },
  /*
   * Deliberately just "a string" — no `pattern`, no `minLength`, no `enum`.
   *
   * `clearInvalidConfig` wipes the *whole* settings file when any value fails
   * the schema, so a pattern here would mean a hand-edited (or hand-mistyped)
   * shortcut also costs the owner his position memory, his coat, his size and
   * his logins-adjacent preferences. The real validation is `readHideShortcut`,
   * which falls back to the platform default and keeps everything else — the
   * same trade `lastSnapshot` makes below, for the same reason.
   */
  hideShortcut: { type: 'string', default: DEFAULT_HIDE_SHORTCUT },
  checkForUpdates: { type: 'boolean', default: true },
  /*
   * No `pattern` here either, and for the same reason: this is a version string
   * written by the app, but the file is user-writable and a mangled one must
   * cost at most one duplicate update notice. `shouldNotify` treats anything it
   * cannot parse as "not notified yet".
   */
  updateNotifiedVersion: { type: ['string', 'null'], default: null },
  forceInteractive: { type: 'boolean', default: false },
  verboseLog: { type: 'boolean', default: false },
  chatgptDiscoveredEndpoints: {
    type: 'array',
    items: { type: 'string', maxLength: 2_048 },
    maxItems: MAX_DISCOVERED,
    default: []
  },
  claudeDiscoveredEndpoints: {
    type: 'array',
    items: { type: 'string', maxLength: 2_048 },
    maxItems: MAX_DISCOVERED,
    default: []
  },
  /*
   * Deliberately permissive: `clearInvalidConfig` wipes the *whole* settings
   * file when any value fails the schema, so a snapshot shape that drifts by one
   * field would also cost the owner their position memory and colour choice. The
   * real validation is `restoreSnapshot`, which drops what it cannot read and
   * keeps everything else.
   */
  lastSnapshot: { type: ['object', 'null'], default: null }
};

/**
 * Open the settings file. Must be called after `app.whenReady()` — before that,
 * `app.getPath('userData')` is not settled.
 */
export function createStore(): WalderStore {
  const store = new Store<WalderSettings>({
    name: 'walder',
    schema: SETTINGS_SCHEMA,
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
 * Read `cardSize`. This is where the validation actually happens — the schema
 * entry lets any string through on purpose (see the comment on it).
 */
export function readCardSize(store: WalderStore): CardSize {
  const raw = store.get('cardSize');
  return isCardSize(raw) ? raw : DEFAULTS.cardSize;
}

/**
 * Read `hideShortcut`, falling back to the platform default for anything that
 * could not be registered.
 *
 * The validation is *here* rather than in the JSON schema on purpose — see the
 * comment on the schema entry. The cost of a bad value is one shortcut reverting
 * to its default; the cost of putting the same rule in the schema would be the
 * whole settings file being wiped.
 */
export function readHideShortcut(store: WalderStore): string {
  const raw = store.get('hideShortcut');
  if (looksLikeAccelerator(raw)) return (raw as string).trim();
  vlog('hideShortcut is not usable; falling back to', DEFAULT_HIDE_SHORTCUT);
  return DEFAULT_HIDE_SHORTCUT;
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

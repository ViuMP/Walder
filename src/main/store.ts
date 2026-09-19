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
import { isCreditPrice, type CreditPrice, type PersistedSnapshot } from '../core/usage';
import type { ServiceSchedule } from '../core/poll-schedule';
import { defaultHideShortcut, looksLikeAccelerator } from '../core/shortcuts';
import { MAX_DISCOVERED } from '../providers/endpoint-discovery';
import {
  DEFAULT_CARD_SIZE,
  DEFAULT_RESET_STYLE,
  isCardSize,
  isResetStyle,
  type CardSize,
  type ResetStyle
} from '../core/card-layout';
import { isServiceName, isSizeName, type ServiceName, type SizeName } from './ipc';
import { vlog } from './log';

/**
 * The platform's default hide shortcut, computed once at module load.
 *
 * `process.platform` cannot change under a running process, and the value is
 * needed in two places that must agree — the JSON schema's `default` and
 * `DEFAULTS` — so computing it twice would be two chances to disagree.
 */
const DEFAULT_HIDE_SHORTCUT = defaultHideShortcut(process.platform);

/**
 * OpenAI's published Codex list price: USD 40 per 1,000 credits. Named once for
 * the same reason `DEFAULT_HIDE_SHORTCUT` is — the JSON schema's `default` and
 * `DEFAULTS` must not be two chances to disagree.
 */
export const DEFAULT_CODEX_CREDIT_PRICE: CreditPrice = { amount: 0.04, currency: 'USD' };

export interface Point {
  x: number;
  y: number;
}

/**
 * The shape version of the settings file — `1` today, and the only value any
 * released Walder has written.
 *
 * It exists so that a future migration has something to read. `conf`'s own
 * `migrations` option is keyed on the *app* version, which is the wrong key:
 * the file's shape does not change with every release, and keying on 0.2.6 vs
 * 0.3.0 would mean deciding, at each bump, whether a migration that never
 * needed to run should run anyway.
 */
export const SCHEMA_VERSION = 1;

export interface WalderSettings {
  /** The shape of this file. See `SCHEMA_VERSION`. */
  schemaVersion: number;
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
  /**
   * How the card writes a reset horizon: as a clock time once a countdown stops
   * being readable (the default), or always as a countdown.
   *
   * Separate from `cardSize` even though both are "how the card looks", because
   * they answer different questions — how *much* the card says, and whether one
   * of the things it says is any use. An owner on Small still wants a weekday.
   */
  resetStyle: ResetStyle;
  /**
   * Which service the owner actually lives in, so Walder reacts to that one
   * first: its rows sit at the top of the hover card, and when several
   * thresholds cross in the same poll its bark is the one that wins.
   *
   * Service only — not a per-bucket ranking. A "put the 5-hour window above
   * 7-day Opus" setting was the alternative, and it loses on both sides of the
   * trade: the rows are already ordered by how urgent they are within a
   * service, and a full ordering UI would be the first menu in Walder that
   * needs a dialog rather than a radio group.
   *
   * It deliberately does **not** touch the dog's face. `pctForFace` stays
   * hard-wired to Claude's 5-hour window: the face is the one thing on screen
   * at all times, and a setting that silently re-points it would mean an owner
   * cannot tell, from a worried dog alone, what he is worried about.
   */
  primaryService: ServiceName;
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
   * Draw the dog, but never move him: every animation pinned to its resting
   * frame and every one-shot an instant change of picture.
   *
   * Off by default, because the OS already answers this question for the owners
   * who have answered it — the renderer treats `prefers-reduced-motion: reduce`
   * as equivalent to this being on, so a Mac with Reduce Motion ticked gets a
   * still dog with nothing to find in a menu. The switch exists for the owner
   * who wants the rest of their animations and not this one: a mascot in the
   * corner of the eye is a different thing from a UI transition, and "I like
   * motion, just not next to what I am reading" is not a preference macOS has a
   * checkbox for.
   *
   * The renderer, not main, is what honours it: motion is drawn there, and the
   * only thing crossing the boundary is this flag on `ModePayload`.
   */
  stillMode: boolean;
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
   * What one Codex credit costs, so the "Codex credit limit" row can print an
   * amount instead of a bare credit count.
   *
   * A setting and not a constant because OpenAI publishes one list price (USD
   * 40 per 1,000 credits — the default below) and the owner is billed in EUR at
   * a rate nobody publishes. `null` turns the estimate off entirely and the row
   * falls back to the counts the provider actually stated, which is the right
   * answer for anyone who would rather see no number than a wrong one.
   */
  codexCreditPrice: CreditPrice | null;
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
  /**
   * Where each service's backoff stood when the app last quit — two small
   * numbers per service (`failures`, `nextDueAt`) and no payload of any kind.
   *
   * Held only in memory, a penalty was cleared by quitting, so an owner who
   * restarted Walder because it looked stuck was re-arming the rate limit he was
   * waiting out. `restoreSchedules` validates it and ignores anything already
   * elapsed.
   */
  pollSchedules: Record<'claude' | 'chatgpt', ServiceSchedule> | null;
  /**
   * What the behaviour coordinator must remember across a quit so it does not
   * repeat itself — the bark machine's per-window level bookkeeping and the
   * exhaustion edges (`core/behaviour.ts`'s `BehaviourMemory`). Percentages and
   * reset timestamps only, the same class of fact as `lastSnapshot`, and for
   * the same reason: `lastSnapshot` is re-fed at launch, so without this the
   * dog re-announces a threshold the owner acknowledged an hour ago.
   *
   * Typed `object | null` rather than the real shape, because the real shape
   * lives in `src/core` and the store must not import behaviour types to
   * describe a blob it never reads. `Behaviour`'s own validator is the check.
   */
  behaviourMemory: object | null;
  /**
   * Bucket ids the owner has unticked in tray ▸ **Show in overview**. Off the
   * hover card and silent — see `visibleBuckets` and `Behaviour.
   * setHiddenBuckets`. Ids rather than labels: a label is the payload's word
   * and changes under us, and the id is what both filters match on.
   */
  hiddenBuckets: string[];
  /**
   * Which tools have already been *offered* their hook install at launch, so
   * the offer is made once per machine and a "Cancel" is respected forever.
   *
   * One flag per tool rather than a single boolean: Claude Code and Codex are
   * installed independently, and an owner who adds the second one a month later
   * should be offered its hooks then. Written *before* the dialog opens (see
   * `offerHooksOnFirstLaunch`), so a crash while it is up cannot re-ask.
   *
   * Never a statement about whether the hooks are installed — that question is
   * answered by reading the tool's own settings file (`installedHookPort`), and
   * a flag here would go stale the moment the owner edited it.
   */
  hooksOffered: { claude: boolean; codex: boolean };
  /**
   * Has the three-beat first-run introduction been started on this machine?
   *
   * Written *before* the first intro bubble, the same crash-safety as
   * `hooksOffered` and for the same reason: a crash (or a quit) between the
   * bubble and the flag would re-introduce the app at every launch for the rest
   * of the install's life, and there is nothing in the introduction the owner
   * can dismiss permanently. Recording first costs at most one introduction
   * nobody saw.
   *
   * A plain boolean, not a per-beat record: the chain is one thing that either
   * happened or did not, and a half-finished introduction is not worth
   * resuming three launches later.
   */
  introduced: boolean;
}

export type WalderStore = Store<WalderSettings>;

export const DEFAULTS: WalderSettings = {
  schemaVersion: SCHEMA_VERSION,
  positions: {},
  size: 'medium',
  cardSize: DEFAULT_CARD_SIZE,
  resetStyle: DEFAULT_RESET_STYLE,
  primaryService: 'claude',
  palette: 'golden',
  launchAtLogin: false,
  pollIntervalSec: 180,
  hookPort: 47811,
  hookPortActual: null,
  sleepInFullscreen: true,
  hideWhenIdle: false,
  stillMode: false,
  hideShortcut: DEFAULT_HIDE_SHORTCUT,
  checkForUpdates: true,
  updateNotifiedVersion: null,
  forceInteractive: false,
  verboseLog: false,
  codexCreditPrice: DEFAULT_CODEX_CREDIT_PRICE,
  chatgptDiscoveredEndpoints: [],
  claudeDiscoveredEndpoints: [],
  lastSnapshot: null,
  pollSchedules: null,
  behaviourMemory: null,
  hiddenBuckets: [],
  hooksOffered: { claude: false, codex: false },
  introduced: false
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
  schemaVersion: { type: 'number', default: SCHEMA_VERSION },
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
  size: { type: 'string', default: 'medium' },
  /*
   * Deliberately just "a string" — no `enum`.
   *
   * The same trade `hideShortcut` makes below: `clearInvalidConfig` wipes the
   * *whole* settings file when any single value fails the schema, so an `enum`
   * here would mean a hand-typed `cardSize: "tiny"` costs the owner his
   * position memory, his coat and his logins-adjacent preferences as well. The
   * real validation is `readCardSize`, which falls back to Large and keeps
   * everything else.
   *
   * `size` uses the same arrangement: its runtime reader falls back to Medium
   * without sacrificing the rest of a hand-edited settings file.
   */
  cardSize: { type: 'string', default: DEFAULT_CARD_SIZE },
  // Bare string, no enum, same trade — `readResetStyle` is the real validation.
  resetStyle: { type: 'string', default: DEFAULT_RESET_STYLE },
  // Bare string, no enum — the same trade `cardSize` makes directly above, and
  // for the same reason: a hand-typed `primaryService: "gemini"` must cost the
  // owner that one preference, not his whole settings file. `readPrimaryService`
  // is the real check.
  primaryService: { type: 'string', default: 'claude' },
  palette: { type: 'string', minLength: 1, default: 'golden' },
  launchAtLogin: { type: 'boolean', default: false },
  pollIntervalSec: { type: 'number', minimum: 30, maximum: 86_400, default: 180 },
  hookPort: { type: 'number', minimum: 1024, maximum: 65_535, default: 47_811 },
  hookPortActual: { type: ['number', 'null'], minimum: 1024, maximum: 65_535, default: null },
  sleepInFullscreen: { type: 'boolean', default: true },
  hideWhenIdle: { type: 'boolean', default: false },
  stillMode: { type: 'boolean', default: false },
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
  // Bare object-or-null, the same trade `cardSize` and `lastSnapshot` make
  // above: a mistyped price must not make `clearInvalidConfig` wipe the whole
  // file. `readCodexCreditPrice` is the real check.
  codexCreditPrice: { type: ['object', 'null'], default: DEFAULT_CODEX_CREDIT_PRICE },
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
  lastSnapshot: { type: ['object', 'null'], default: null },
  // Permissive for the reason spelled out directly above: `restoreSchedules` is
  // the real check, and a mangled backoff must not cost the whole file.
  pollSchedules: { type: ['object', 'null'], default: null },
  /*
   * Permissive for exactly the reason `lastSnapshot` is, one line above: this
   * is a blob written by the app whose shape will drift as the coordinator
   * grows, and `clearInvalidConfig` wipes the *whole* file when any value fails
   * the schema. `Behaviour`'s own field-by-field validator drops what it cannot
   * read and keeps the rest, so a drifted memory costs one duplicate bark.
   */
  behaviourMemory: { type: ['object', 'null'], default: null },
  // Bucket ids, so `string` is the whole shape there is to state. No `maxItems`:
  // the list can only ever be as long as the rows the payloads report, and
  // `clearInvalidConfig` wipes the *whole* file when a value fails the schema —
  // `readHiddenBuckets` drops the junk entries instead.
  hiddenBuckets: { type: 'array', items: { type: 'string' }, default: [] },
  /*
   * Two optional booleans, and deliberately no `required`: a file written by
   * 0.2.4 (or by WP9 before the Codex half exists) carries neither key, and
   * `clearInvalidConfig` would wipe the *whole* settings file over a missing
   * flag whose worst failure is one dialog too many. The reader treats anything
   * that is not `true` as "not offered yet".
   */
  hooksOffered: {
    type: 'object',
    properties: { claude: { type: 'boolean' }, codex: { type: 'boolean' } },
    default: { claude: false, codex: false }
  },
  // A file written before 0.2.6 carries no key at all, which `default` answers
  // as "not yet introduced" — the right answer for an owner who has never seen
  // the chain, and one harmless run of it for everyone else.
  introduced: { type: 'boolean', default: false }
};

/**
 * Open the settings file. Must be called after `app.whenReady()` — before that,
 * `app.getPath('userData')` is not settled.
 *
 * `cwd` is for the tests and nothing else: the app never passes one, so the file
 * lands in `userData` as it always has, while a test can point the *real* schema
 * and `clearInvalidConfig` at a temp directory rather than at the owner's
 * settings. Without it the only way to exercise either is to mock `Store` away,
 * which is to say not to exercise them at all.
 */
export function createStore(cwd?: string): WalderStore {
  const store = new Store<WalderSettings>({
    name: 'walder',
    schema: SETTINGS_SCHEMA,
    defaults: DEFAULTS,
    ...(cwd ? { cwd } : {}),
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

/** Read `resetStyle`. As with `cardSize`, this is the real validation. */
export function readResetStyle(store: WalderStore): ResetStyle {
  const raw = store.get('resetStyle');
  return isResetStyle(raw) ? raw : DEFAULTS.resetStyle;
}

/**
 * Read `primaryService`. As with `cardSize`, the schema lets any string through
 * on purpose (see the comment on it) and this is where the value is actually
 * judged; anything unusable falls back to Claude, which is both the default and
 * the service the dog's face already tracks.
 */
export function readPrimaryService(store: WalderStore): ServiceName {
  const raw = store.get('primaryService');
  return isServiceName(raw) ? raw : DEFAULTS.primaryService;
}

/**
 * Read `codexCreditPrice`. As with `cardSize`, the schema lets the shape
 * through and `isCreditPrice` is where it is actually checked.
 *
 * An explicit `null` is a *choice* — "do not estimate" — and is returned as is.
 * Anything else unusable falls back to the list price, because a file that has
 * been mangled is not the owner saying he wants the estimate off.
 */
export function readCodexCreditPrice(store: WalderStore): CreditPrice | null {
  const raw = store.get('codexCreditPrice');
  if (raw === null) return null;
  if (!isCreditPrice(raw)) return DEFAULTS.codexCreditPrice;
  return { amount: raw.amount, currency: raw.currency.toUpperCase() };
}

/**
 * Read `hiddenBuckets`, tolerating junk the same way the other readers do: a
 * non-array is no hidden rows at all, and a non-string entry is dropped rather
 * than failing the read. An id Walder no longer reports is kept — the owner
 * unticked it, and a provider that stops answering for one poll must not
 * silently re-tick it.
 */
export function readHiddenBuckets(store: WalderStore): string[] {
  const raw = store.get('hiddenBuckets');
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === 'string' && id.length > 0);
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

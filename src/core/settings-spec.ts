/**
 * Every user setting Walder has, in one table: its key in `walder.json`, its
 * default, how it is shown, and the rule a new value must pass.
 *
 * One table so that the three places that need the list cannot drift apart:
 * the store (`main/store.ts` takes its defaults from here), the settings
 * controller (`main/settings.ts`, the one writer, which refuses any key that is
 * not in this table and any value `validate` rejects), and the settings window
 * (`renderer/settings.ts`, which draws one control per entry). `SETTINGS.md`
 * is the human copy; `test/settings-spec.test.ts` fails when the two disagree.
 *
 * Electron-free, so the renderer can import it and the tests need no mocks.
 *
 * App state that also lives in `walder.json` (window positions, the last
 * snapshot, poll schedules and the rest) is deliberately NOT here: it is not a
 * setting, and the controller must never let a window write it. The list of
 * those keys is `APP_STATE_KEYS` below, and a test fails when a store key is in
 * neither list.
 */
import { BARK_PRESETS, DEFAULT_BARK_PRESET, type BarkPreset } from './nudge';
import {
  CARD_SIZES,
  DEFAULT_CARD_LAYOUT,
  DEFAULT_CARD_SIZE,
  DEFAULT_RESET_STYLE,
  RESET_STYLES,
  SERVICE_LABELS,
  parseCardLayout,
  type CardLayout,
  type CardSize,
  type ResetStyle
} from './card-layout';
import { SERVICES, isServiceName, type ServiceName } from './services';
import { defaultHideShortcut, looksLikeAccelerator } from './shortcuts';
import { isCreditPrice, type CreditPrice } from './usage';
import { MIN_POLL_SEC } from './poll-schedule';
import { t } from './strings';

/** The dog's three sizes. Here rather than in `main/ipc` so core can name them. */
export type SizeName = 'small' | 'medium' | 'large';
export const SIZE_NAMES: readonly SizeName[] = ['small', 'medium', 'large'];
export function isSizeName(value: unknown): value is SizeName {
  return typeof value === 'string' && (SIZE_NAMES as readonly string[]).includes(value);
}

/** The Walder window's colours: follow the system (`auto`), or force one. */
export type ThemeName = 'auto' | 'light' | 'dark';
export const THEME_NAMES: readonly ThemeName[] = ['auto', 'light', 'dark'];
export const THEME_LABELS: Readonly<Record<ThemeName, string>> = {
  auto: 'Automatic',
  light: 'Light',
  dark: 'Dark'
};

/** OpenAI's published Codex list price: USD 40 per 1,000 credits. */
export const DEFAULT_CODEX_CREDIT_PRICE: CreditPrice = { amount: 0.04, currency: 'USD' };
export const DEFAULT_HOOK_PORT = 47_811;
export const DEFAULT_POLL_INTERVAL_SEC = 180;
/** The poller never asks more often than `MIN_POLL_SEC`, so a lower value would be a lie. */
export const POLL_INTERVAL_RANGE = { min: MIN_POLL_SEC, max: 86_400 } as const;
export const HOOK_PORT_RANGE = { min: 1024, max: 65_535 } as const;

export const SIZE_LABELS: Readonly<Record<SizeName, string>> = {
  small: t('tray.small'),
  medium: t('tray.medium'),
  large: t('tray.large')
};
export const CARD_SIZE_LABELS: Readonly<Record<CardSize, string>> = {
  large: t('tray.large'),
  medium: t('tray.medium'),
  small: t('tray.small')
};
export const RESET_STYLE_LABELS: Readonly<Record<ResetStyle, string>> = {
  clock: t('tray.resetStyle.clock'),
  countdown: t('tray.resetStyle.countdown')
};
export const BARK_PRESET_LABELS: Readonly<Record<BarkPreset, string>> = {
  quiet: t('tray.barkPreset.quiet'),
  normal: t('tray.barkPreset.normal'),
  chatty: t('tray.barkPreset.chatty')
};

/** "black-and-tan" -> "Black and tan". The coats are the art's decision, not a list here. */
export function paletteLabel(id: string): string {
  const words = id.replace(/[-_]/g, ' ').trim();
  if (words.length === 0) return id;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The values of every user setting, by key. */
export interface UserSettings {
  size: SizeName;
  palette: string;
  cardSize: CardSize;
  resetStyle: ResetStyle;
  stillMode: boolean;
  theme: ThemeName;
  barkPreset: BarkPreset;
  barkSound: boolean;
  primaryService: ServiceName;
  notifyWhenHidden: boolean;
  hiddenServices: ServiceName[];
  cardLayout: CardLayout;
  hideWhenIdle: boolean;
  hideShortcut: string;
  sleepInFullscreen: boolean;
  pollIntervalSec: number;
  codexCreditPrice: CreditPrice | null;
  launchAtLogin: boolean;
  checkForUpdates: boolean;
  hookPort: number;
  verboseLog: boolean;
  forceInteractive: boolean;
}
export type SettingKey = keyof UserSettings;

export type SettingGroup = 'appearance' | 'alerts' | 'visibility' | 'usage' | 'app' | 'advanced';
export const SETTING_GROUPS: readonly { id: SettingGroup; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'visibility', label: 'Visibility' },
  { id: 'usage', label: 'Usage' },
  { id: 'app', label: 'App' },
  { id: 'advanced', label: 'Advanced' }
];

/**
 * How a control looks. `choice` options are fixed here except for `palette`,
 * whose options come from the sprite sheet at run time (`dynamicOptions`).
 */
export type SettingControl =
  | { kind: 'toggle' }
  | { kind: 'choice'; options: readonly { value: string; label: string }[]; dynamicOptions?: 'palette' }
  | { kind: 'number'; min: number; max: number; step: number; unit: string }
  | { kind: 'services' }
  | { kind: 'shortcut' }
  | { kind: 'creditPrice' }
  | { kind: 'cardLayout' };

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SettingSpec<K extends SettingKey = SettingKey> {
  key: K;
  group: SettingGroup;
  label: string;
  help: string;
  control: SettingControl;
  /** Set when a change only takes effect after a restart; the window says so. */
  appliesOn?: 'restart';
  validate(value: unknown, ctx: ValidationContext): Validation<UserSettings[K]>;
}

/** What validation needs to know that is not in this file. */
export interface ValidationContext {
  /** The palette ids the sprite sheet has. Empty means "accept any non-empty id". */
  palettes: readonly string[];
}

const ok = <T>(value: T): Validation<T> => ({ ok: true, value });
const fail = <T>(error: string): Validation<T> => ({ ok: false, error });

function bool(value: unknown): Validation<boolean> {
  return typeof value === 'boolean' ? ok(value) : fail('Must be on or off.');
}

function oneOf<T extends string>(values: readonly T[]) {
  return (value: unknown): Validation<T> =>
    typeof value === 'string' && (values as readonly string[]).includes(value)
      ? ok(value as T)
      : fail(`Must be one of: ${values.join(', ')}.`);
}

function intIn(min: number, max: number) {
  return (value: unknown): Validation<number> =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
      ? ok(value)
      : fail(`Must be a whole number from ${min} to ${max}.`);
}

function options<T extends string>(values: readonly T[], labels: Readonly<Record<T, string>>) {
  return values.map((value) => ({ value, label: labels[value] }));
}

export const SETTINGS: readonly SettingSpec[] = [
  {
    key: 'size',
    group: 'appearance',
    label: t('tray.size'),
    help: 'How big the dog is drawn on screen.',
    control: { kind: 'choice', options: options(SIZE_NAMES, SIZE_LABELS) },
    validate: oneOf(SIZE_NAMES)
  },
  {
    key: 'palette',
    group: 'appearance',
    label: t('tray.colour'),
    help: 'The coat. The choices come from the sprite sheet.',
    control: { kind: 'choice', options: [], dynamicOptions: 'palette' },
    validate: (value, ctx) => {
      if (typeof value !== 'string' || value.length === 0) return fail('Pick a coat.');
      if (ctx.palettes.length > 0 && !ctx.palettes.includes(value)) {
        return fail('That coat is not in the sprite sheet.');
      }
      return ok(value);
    }
  },
  {
    key: 'cardSize',
    group: 'appearance',
    label: t('tray.cardSize'),
    help: 'How much the hover card shows. Large has a header and every detail; Small has one line per usage window.',
    control: { kind: 'choice', options: options(CARD_SIZES, CARD_SIZE_LABELS) },
    validate: oneOf(CARD_SIZES)
  },
  {
    key: 'resetStyle',
    group: 'appearance',
    label: t('tray.resetTimes'),
    help: 'Show reset times as a clock time or as a countdown.',
    control: { kind: 'choice', options: options(RESET_STYLES, RESET_STYLE_LABELS) },
    validate: oneOf(RESET_STYLES)
  },
  {
    key: 'stillMode',
    group: 'appearance',
    label: t('tray.stillMode'),
    help: 'Hold one frame per pose instead of animating.',
    control: { kind: 'toggle' },
    validate: bool
  },
  {
    key: 'theme',
    group: 'appearance',
    label: 'Theme',
    help: 'Light, dark, or follow your system (Automatic). Changes this window only.',
    control: { kind: 'choice', options: options(THEME_NAMES, THEME_LABELS) },
    validate: oneOf(THEME_NAMES)
  },
  {
    key: 'barkPreset',
    group: 'alerts',
    label: t('tray.barks'),
    help: 'Which usage levels raise a speech bubble: Quiet at 95 and 100 %, Chatty every 10 %.',
    control: { kind: 'choice', options: options(BARK_PRESETS, BARK_PRESET_LABELS) },
    validate: oneOf(BARK_PRESETS)
  },
  {
    key: 'barkSound',
    group: 'alerts',
    label: t('tray.barkSound'),
    help: 'Play a short bark with each usage bubble.',
    control: { kind: 'toggle' },
    validate: bool
  },
  {
    key: 'primaryService',
    group: 'alerts',
    label: t('tray.primaryService'),
    help: 'The service listed first and reacted to first when two need attention at once.',
    control: { kind: 'choice', options: options(SERVICES, SERVICE_LABELS) },
    validate: oneOf(SERVICES)
  },
  {
    key: 'notifyWhenHidden',
    group: 'alerts',
    label: t('tray.notifyWhenHidden'),
    help: 'Send a system notification when the dog has something to say but is hidden.',
    control: { kind: 'toggle' },
    validate: bool
  },
  {
    key: 'hiddenServices',
    group: 'visibility',
    label: t('tray.showInOverview'),
    help: 'Services shown on the card, allowed to bark and checked. Untick one to hide it; a hidden service makes no requests.',
    control: { kind: 'services' },
    validate: (value) => {
      if (!Array.isArray(value) || !value.every(isServiceName)) return fail('Unknown service.');
      return ok([...new Set(value)]);
    }
  },
  {
    key: 'cardLayout',
    group: 'visibility',
    label: 'Hover card',
    help: 'Show, hide and reorder every line of the hover card.',
    control: { kind: 'cardLayout' },
    validate: (value) => {
      const layout = parseCardLayout(value);
      return layout === null ? fail('Not a card layout.') : ok(layout);
    }
  },
  {
    key: 'hideWhenIdle',
    group: 'visibility',
    label: t('tray.hideWhenIdle'),
    help: 'Stay off screen until there is something to say, then leave again.',
    control: { kind: 'toggle' },
    validate: bool
  },
  {
    key: 'hideShortcut',
    group: 'visibility',
    label: t('tray.shortcut'),
    help: 'The global shortcut that turns Hide when idle on and off. Needs at least one modifier.',
    control: { kind: 'shortcut' },
    validate: (value) =>
      looksLikeAccelerator(value)
        ? ok((value as string).trim())
        : fail('Use modifiers and one key, for example Alt+Shift+W.')
  },
  {
    key: 'sleepInFullscreen',
    group: 'visibility',
    label: t('tray.sleepDuringFullscreen'),
    help: 'Curl up small while a fullscreen video or game is in front.',
    control: { kind: 'toggle' },
    validate: bool
  },
  {
    key: 'pollIntervalSec',
    group: 'usage',
    label: 'Refresh interval',
    help: 'Seconds between usage checks. Walder never checks more often than every 180 seconds.',
    control: { kind: 'number', ...POLL_INTERVAL_RANGE, step: 30, unit: 's' },
    validate: intIn(POLL_INTERVAL_RANGE.min, POLL_INTERVAL_RANGE.max)
  },
  {
    key: 'codexCreditPrice',
    group: 'usage',
    label: 'Codex credit price',
    help: 'Price of one Codex credit, used for the estimated cost on the card. Off hides the estimate.',
    control: { kind: 'creditPrice' },
    appliesOn: 'restart',
    validate: (value) => {
      if (value === null) return ok(null);
      if (!isCreditPrice(value)) return fail('Enter an amount above 0 and a three-letter currency code.');
      return ok({ amount: value.amount, currency: value.currency.toUpperCase() });
    }
  },
  {
    key: 'launchAtLogin',
    group: 'app',
    label: t('tray.launchAtLogin'),
    help: 'Start Walder when you log in. Only available in the installed app.',
    control: { kind: 'toggle' },
    validate: bool
  },
  {
    key: 'checkForUpdates',
    group: 'app',
    label: t('tray.checkForUpdatesAutomatically'),
    help: 'Ask GitHub every six hours whether a newer release exists. Nothing is downloaded.',
    control: { kind: 'toggle' },
    validate: bool
  },
  {
    key: 'hookPort',
    group: 'app',
    label: 'Hook port',
    help: 'Local port the Claude Code and Codex hooks report to. After a change, restart Walder and install the hooks again.',
    control: { kind: 'number', ...HOOK_PORT_RANGE, step: 1, unit: '' },
    appliesOn: 'restart',
    validate: intIn(HOOK_PORT_RANGE.min, HOOK_PORT_RANGE.max)
  },
  {
    key: 'verboseLog',
    group: 'advanced',
    label: t('tray.verboseLog'),
    help: 'Write detailed lines to the log file. Usage values are never logged.',
    control: { kind: 'toggle' },
    validate: bool
  },
  {
    key: 'forceInteractive',
    group: 'advanced',
    label: t('tray.forceInteractive'),
    help: 'Make the whole dog window take clicks. For debugging click-through.',
    control: { kind: 'toggle' },
    validate: bool
  }
];

export const SETTING_KEYS: readonly SettingKey[] = SETTINGS.map((spec) => spec.key);

export function settingSpec(key: string): SettingSpec | undefined {
  return SETTINGS.find((spec) => spec.key === key);
}

/** The defaults. `hideShortcut` depends on the platform; nothing else does. */
export function settingDefaults(platform: string): UserSettings {
  return {
    size: 'medium',
    palette: 'golden',
    cardSize: DEFAULT_CARD_SIZE,
    resetStyle: DEFAULT_RESET_STYLE,
    stillMode: false,
    theme: 'auto',
    barkPreset: DEFAULT_BARK_PRESET,
    barkSound: false,
    primaryService: 'claude',
    notifyWhenHidden: false,
    hiddenServices: [],
    cardLayout: DEFAULT_CARD_LAYOUT,
    hideWhenIdle: false,
    hideShortcut: defaultHideShortcut(platform),
    sleepInFullscreen: true,
    pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC,
    codexCreditPrice: DEFAULT_CODEX_CREDIT_PRICE,
    launchAtLogin: false,
    checkForUpdates: true,
    hookPort: DEFAULT_HOOK_PORT,
    verboseLog: false,
    forceInteractive: false
  };
}

/**
 * Keys in `walder.json` that are app state, not settings. No settings UI may
 * write them; the controller refuses every key that is not in `SETTINGS`.
 */
export const APP_STATE_KEYS = [
  'schemaVersion',
  'positions',
  'hookPortActual',
  'updateNotifiedVersion',
  'chatgptDiscoveredEndpoints',
  'claudeDiscoveredEndpoints',
  'lastSnapshot',
  'pollSchedules',
  'behaviourMemory',
  'hiddenBuckets',
  'hooksOffered',
  'introduced'
] as const;

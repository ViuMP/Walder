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
import { STRINGS, t, type StringKey } from './strings';
import { ENDONYMS, LANGUAGES, type Language } from './i18n';

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
  auto: t('theme.auto'),
  light: t('theme.light'),
  dark: t('theme.dark')
};

/**
 * Walder's language: follow the system's preferred languages, or one of ours.
 * Applies after a restart (see `core/strings.ts` for why).
 */
export type LanguageSetting = 'system' | Language;
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ['system', ...LANGUAGES];
/** `System` in the active language; every language under its own name (`ENDONYMS`). */
export const LANGUAGE_LABELS: Readonly<Record<LanguageSetting, string>> = {
  system: t('settings.language.system'),
  ...ENDONYMS
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
// Its own words: a card and a dog can take different genders (es Mediana, Mediano).
export const CARD_SIZE_LABELS: Readonly<Record<CardSize, string>> = {
  large: t('cardSize.large'),
  medium: t('cardSize.medium'),
  small: t('cardSize.small')
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

/**
 * A coat's name in the active language: `coat.<id>` from the string tables, so
 * `black-and-tan` reads "Sort og tan" in Danish. The id itself stays the data
 * (settings, sheet, bug report). A coat the art adds without a table entry
 * falls back to its sentence-cased id ("black-and-tan" -> "Black and tan"),
 * so it still shows rather than vanishing (`test/tray.test.ts`).
 */
export function paletteLabel(id: string): string {
  const key = `coat.${id}`;
  if (Object.hasOwn(STRINGS, key)) return t(key as StringKey);
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
  language: LanguageSetting;
  hookPort: number;
  verboseLog: boolean;
  forceInteractive: boolean;
}
export type SettingKey = keyof UserSettings;

export type SettingGroup = 'appearance' | 'alerts' | 'visibility' | 'usage' | 'app' | 'advanced';
export const SETTING_GROUPS: readonly { id: SettingGroup; label: string }[] = [
  { id: 'appearance', label: t('group.appearance') },
  { id: 'alerts', label: t('group.alerts') },
  { id: 'visibility', label: t('group.visibility') },
  { id: 'usage', label: t('group.usage') },
  { id: 'app', label: t('group.app') },
  { id: 'advanced', label: t('group.advanced') }
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
  return typeof value === 'boolean' ? ok(value) : fail(t('valid.bool'));
}

function oneOf<T extends string>(values: readonly T[]) {
  return (value: unknown): Validation<T> =>
    typeof value === 'string' && (values as readonly string[]).includes(value)
      ? ok(value as T)
      : fail(t('valid.oneOf', { values: values.join(', ') }));
}

function intIn(min: number, max: number) {
  return (value: unknown): Validation<number> =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
      ? ok(value)
      : fail(t('valid.intIn', { min, max }));
}

function options<T extends string>(values: readonly T[], labels: Readonly<Record<T, string>>) {
  return values.map((value) => ({ value, label: labels[value] }));
}

export const SETTINGS: readonly SettingSpec[] = [
  {
    key: 'size',
    group: 'appearance',
    label: t('tray.size'),
    help: t('help.size'),
    control: { kind: 'choice', options: options(SIZE_NAMES, SIZE_LABELS) },
    validate: oneOf(SIZE_NAMES)
  },
  {
    key: 'palette',
    group: 'appearance',
    label: t('tray.colour'),
    help: t('help.palette'),
    control: { kind: 'choice', options: [], dynamicOptions: 'palette' },
    validate: (value, ctx) => {
      if (typeof value !== 'string' || value.length === 0) return fail(t('valid.pickCoat'));
      if (ctx.palettes.length > 0 && !ctx.palettes.includes(value)) {
        return fail(t('valid.coatMissing'));
      }
      return ok(value);
    }
  },
  {
    key: 'cardSize',
    group: 'appearance',
    label: t('tray.cardSize'),
    help: t('help.cardSize'),
    control: { kind: 'choice', options: options(CARD_SIZES, CARD_SIZE_LABELS) },
    validate: oneOf(CARD_SIZES)
  },
  {
    key: 'resetStyle',
    group: 'appearance',
    label: t('tray.resetTimes'),
    help: t('help.resetStyle'),
    control: { kind: 'choice', options: options(RESET_STYLES, RESET_STYLE_LABELS) },
    validate: oneOf(RESET_STYLES)
  },
  {
    key: 'stillMode',
    group: 'appearance',
    label: t('tray.stillMode'),
    help: t('help.stillMode'),
    control: { kind: 'toggle' },
    validate: bool
  },
  {
    key: 'theme',
    group: 'appearance',
    label: t('settings.theme'),
    help: t('help.theme'),
    control: { kind: 'choice', options: options(THEME_NAMES, THEME_LABELS) },
    validate: oneOf(THEME_NAMES)
  },
  {
    key: 'barkPreset',
    group: 'alerts',
    label: t('tray.barks'),
    help: t('help.barkPreset'),
    control: { kind: 'choice', options: options(BARK_PRESETS, BARK_PRESET_LABELS) },
    validate: oneOf(BARK_PRESETS)
  },
  {
    key: 'barkSound',
    group: 'alerts',
    label: t('tray.barkSound'),
    help: t('help.barkSound'),
    control: { kind: 'toggle' },
    validate: bool
  },
  {
    key: 'primaryService',
    group: 'alerts',
    label: t('tray.primaryService'),
    help: t('help.primaryService'),
    control: { kind: 'choice', options: options(SERVICES, SERVICE_LABELS) },
    validate: oneOf(SERVICES)
  },
  {
    key: 'notifyWhenHidden',
    group: 'alerts',
    label: t('tray.notifyWhenHidden'),
    help: t('help.notifyWhenHidden'),
    control: { kind: 'toggle' },
    validate: bool
  },
  {
    key: 'hiddenServices',
    group: 'visibility',
    label: t('tray.showInOverview'),
    help: t('help.hiddenServices'),
    control: { kind: 'services' },
    validate: (value) => {
      if (!Array.isArray(value) || !value.every(isServiceName)) return fail(t('valid.unknownService'));
      return ok([...new Set(value)]);
    }
  },
  {
    key: 'cardLayout',
    group: 'visibility',
    label: t('settings.hoverCard'),
    help: t('help.cardLayout'),
    control: { kind: 'cardLayout' },
    validate: (value) => {
      const layout = parseCardLayout(value);
      return layout === null ? fail(t('valid.notLayout')) : ok(layout);
    }
  },
  {
    key: 'hideWhenIdle',
    group: 'visibility',
    label: t('tray.hideWhenIdle'),
    help: t('help.hideWhenIdle'),
    control: { kind: 'toggle' },
    validate: bool
  },
  {
    key: 'hideShortcut',
    group: 'visibility',
    label: t('tray.shortcut'),
    help: t('help.hideShortcut'),
    control: { kind: 'shortcut' },
    validate: (value) =>
      looksLikeAccelerator(value)
        ? ok((value as string).trim())
        : fail(t('valid.shortcut'))
  },
  {
    key: 'sleepInFullscreen',
    group: 'visibility',
    label: t('tray.sleepDuringFullscreen'),
    help: t('help.sleepInFullscreen'),
    control: { kind: 'toggle' },
    validate: bool
  },
  {
    key: 'pollIntervalSec',
    group: 'usage',
    label: t('settings.pollInterval'),
    help: t('help.pollIntervalSec'),
    control: { kind: 'number', ...POLL_INTERVAL_RANGE, step: 30, unit: 's' },
    validate: intIn(POLL_INTERVAL_RANGE.min, POLL_INTERVAL_RANGE.max)
  },
  {
    key: 'codexCreditPrice',
    group: 'usage',
    label: t('settings.codexCreditPrice'),
    help: t('help.codexCreditPrice'),
    control: { kind: 'creditPrice' },
    appliesOn: 'restart',
    validate: (value) => {
      if (value === null) return ok(null);
      if (!isCreditPrice(value)) return fail(t('valid.creditPrice'));
      return ok({ amount: value.amount, currency: value.currency.toUpperCase() });
    }
  },
  {
    key: 'language',
    group: 'app',
    label: t('settings.language'),
    help: t('help.language'),
    control: { kind: 'choice', options: options(LANGUAGE_SETTINGS, LANGUAGE_LABELS) },
    appliesOn: 'restart',
    validate: oneOf(LANGUAGE_SETTINGS)
  },
  {
    key: 'launchAtLogin',
    group: 'app',
    label: t('tray.launchAtLogin'),
    help: t('help.launchAtLogin'),
    control: { kind: 'toggle' },
    validate: bool
  },
  {
    key: 'checkForUpdates',
    group: 'app',
    label: t('tray.checkForUpdatesAutomatically'),
    help: t('help.checkForUpdates'),
    control: { kind: 'toggle' },
    validate: bool
  },
  {
    key: 'hookPort',
    group: 'app',
    label: t('settings.hookPort'),
    help: t('help.hookPort'),
    control: { kind: 'number', ...HOOK_PORT_RANGE, step: 1, unit: '' },
    appliesOn: 'restart',
    validate: intIn(HOOK_PORT_RANGE.min, HOOK_PORT_RANGE.max)
  },
  {
    key: 'verboseLog',
    group: 'advanced',
    label: t('tray.verboseLog'),
    help: t('help.verboseLog'),
    control: { kind: 'toggle' },
    validate: bool
  },
  {
    key: 'forceInteractive',
    group: 'advanced',
    label: t('tray.forceInteractive'),
    help: t('help.forceInteractive'),
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
    language: 'system',
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
  'introduced',
  'hooksOutdatedNotified'
] as const;

/**
 * The one writer of user settings.
 *
 * Before this module each setting was written in its own place — fourteen
 * closures inside `createTray`, three more in `index.ts` — each with its own
 * side effect, so a second UI could only have copied them. Now the tray menu,
 * the global shortcut and the settings window all call `set(key, value)`, and
 * this module:
 *
 *  1. refuses any key that is not a user setting (`core/settings-spec`), so no
 *     UI can reach app state such as window positions or the last snapshot;
 *  2. validates the value against that key's rule;
 *  3. writes it to `walder.json` — and if the write fails (disk full, a locked
 *     file), still applies it for this run and says so, instead of throwing out
 *     of a click handler (audit S2);
 *  4. runs the key's side effect (resize the dog, re-sort the card, bind the
 *     shortcut, ...), which `index.ts` supplies, because those touch windows
 *     and services this module must not know about;
 *  5. tells every listener, so the tray re-checks its items and an open
 *     settings window shows the new value whichever UI made the change.
 *
 * `get` and `snapshot` return the *effective* value — what the app is actually
 * using — through the same `read*` helpers the rest of main uses, so a
 * hand-mangled file shows its fallback rather than the junk.
 */
import {
  POLL_INTERVAL_RANGE,
  settingDefaults,
  settingSpec,
  type SettingKey,
  type UserSettings
} from '../core/settings-spec';
import {
  launchAtLoginState,
  readBarkPreset,
  readBarkSound,
  readCardSize,
  readCardLayout,
  readCodexCreditPrice,
  readHiddenServices,
  readHideShortcut,
  readPrimaryService,
  readResetStyle,
  readSize,
  readTheme,
  type WalderStore
} from './store';
import { applyLaunchAtLogin } from './store';
import { setVerbose, verbose, vlog, warn } from './log';
import type { Overlay } from './overlay-window';
import { CH, SCALE_BY_SIZE } from './ipc';
import { resolvePalette } from './sheet';
import type { SpriteSheet } from '../sprites/types';
import type { BarkPreset } from '../core/nudge';
import type { CardLayout, CardSize, ResetStyle } from '../core/card-layout';
import type { ServiceName } from '../core/services';

export type SettingEffects = { [K in SettingKey]?: (value: UserSettings[K]) => void };

export interface SettingsDeps {
  readonly store: WalderStore;
  /** The coats the sprite sheet has, in sheet order. */
  readonly palettes: () => readonly string[];
  /** The side effect of each key. A key with none is read from the store where it is used. */
  readonly effects: SettingEffects;
  /** True while `WALDER_LOG=1` forces the verbose log on; the setting cannot turn it off. */
  readonly verboseForced?: () => boolean;
}

export type SetResult =
  | { ok: true; value: unknown; saved: boolean }
  | { ok: false; error: string };

export type SettingsListener = (key: SettingKey, settings: UserSettings) => void;

export interface Settings {
  get<K extends SettingKey>(key: K): UserSettings[K];
  snapshot(): UserSettings;
  set(key: string, value: unknown): SetResult;
  /** Keys a UI must show as read-only right now, with the reason. */
  locked(): Partial<Record<SettingKey, string>>;
  onChange(listener: SettingsListener): () => void;
}

export function createSettings(deps: SettingsDeps): Settings {
  const { store } = deps;
  const defaults = settingDefaults(process.platform);
  const listeners = new Set<SettingsListener>();

  function readNumber(key: 'pollIntervalSec' | 'hookPort', min: number, max: number): number {
    const raw = store.get(key);
    return typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max
      ? raw
      : defaults[key];
  }

  function snapshot(): UserSettings {
    const palettes = deps.palettes();
    const palette = store.get('palette');
    return {
      size: readSize(store),
      palette:
        typeof palette === 'string' && (palettes.length === 0 || palettes.includes(palette))
          ? palette
          : defaults.palette,
      cardSize: readCardSize(store),
      resetStyle: readResetStyle(store),
      stillMode: store.get('stillMode') === true,
      theme: readTheme(store),
      barkPreset: readBarkPreset(store),
      barkSound: readBarkSound(store),
      primaryService: readPrimaryService(store),
      notifyWhenHidden: store.get('notifyWhenHidden') === true,
      hiddenServices: readHiddenServices(store),
      cardLayout: readCardLayout(store),
      hideWhenIdle: store.get('hideWhenIdle') === true,
      hideShortcut: readHideShortcut(store),
      sleepInFullscreen: store.get('sleepInFullscreen') !== false,
      pollIntervalSec: readNumber('pollIntervalSec', POLL_INTERVAL_RANGE.min, POLL_INTERVAL_RANGE.max),
      codexCreditPrice: readCodexCreditPrice(store),
      launchAtLogin: launchAtLoginState(store).on,
      checkForUpdates: store.get('checkForUpdates') !== false,
      hookPort: readNumber('hookPort', 1024, 65_535),
      verboseLog: verbose(),
      forceInteractive: store.get('forceInteractive') === true
    };
  }

  function locked(): Partial<Record<SettingKey, string>> {
    const out: Partial<Record<SettingKey, string>> = {};
    if (!launchAtLoginState(store).editable) {
      out.launchAtLogin = 'Only the installed app can start at login.';
    }
    if (deps.verboseForced?.() === true) {
      out.verboseLog = 'Forced on by WALDER_LOG=1 for this run.';
    }
    return out;
  }

  function set(key: string, value: unknown): SetResult {
    const spec = settingSpec(key);
    if (spec === undefined) return { ok: false, error: `"${key}" is not a setting.` };
    const reason = locked()[spec.key];
    if (reason !== undefined) return { ok: false, error: reason };
    const checked = spec.validate(value, { palettes: deps.palettes() });
    if (!checked.ok) return checked;

    let saved = true;
    try {
      store.set(spec.key, checked.value as never);
    } catch (error) {
      // Applied for this run all the same: only the memory of it is lost.
      saved = false;
      warn(`could not save the ${spec.key} setting:`, error);
    }
    try {
      (deps.effects[spec.key] as ((v: unknown) => void) | undefined)?.(checked.value);
    } catch (error) {
      warn(`applying the ${spec.key} setting failed:`, error);
    }
    vlog('setting', spec.key, '->', checked.value);
    const now = snapshot();
    for (const listener of listeners) {
      try {
        listener(spec.key, now);
      } catch (error) {
        warn('settings listener failed:', error);
      }
    }
    return { ok: true, value: checked.value, saved };
  }

  return {
    get: (key) => snapshot()[key],
    snapshot,
    set,
    locked,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

/**
 * What each setting does once stored — the side effects that used to live in
 * the tray's `apply*` closures, moved here unchanged so the tray, the shortcut
 * and the settings window share them. The callbacks are the tray's own deps
 * (`TrayDeps` passes straight in), so `index.ts` wires each one once.
 */
export interface EffectDeps {
  readonly getOverlay: () => Overlay | null;
  readonly sheet: SpriteSheet;
  readonly onGeometryChanged?: () => void;
  readonly onCardSize?: (size: CardSize) => void;
  readonly onResetStyle?: (style: ResetStyle) => void;
  readonly onBarkPreset?: (preset: BarkPreset) => void;
  readonly onBarkSound?: (on: boolean) => void;
  readonly onPrimaryService?: (service: ServiceName) => void;
  readonly onHiddenServices?: (services: readonly ServiceName[]) => void;
  readonly onCardLayout?: (layout: CardLayout) => void;
  readonly onSleepInFullscreen?: (on: boolean) => void;
  readonly onStillMode?: (on: boolean) => void;
  readonly onHideWhenIdle?: (on: boolean) => void;
  readonly onHideShortcut?: (accelerator: string) => void;
}

export function standardEffects(deps: EffectDeps): SettingEffects {
  /** The live overlay, or `null` with a log line, so a missing window is never a silent no-op. */
  function overlayOrWarn(action: string): Overlay | null {
    const overlay = deps.getOverlay();
    if (overlay === null || overlay.win.isDestroyed()) {
      warn(`setting "${action}" not shown: no overlay window`);
      return null;
    }
    return overlay;
  }
  return {
    size: (size) => {
      const overlay = overlayOrWarn('size');
      if (overlay === null) return;
      overlay.applySize(SCALE_BY_SIZE[size]);
      overlay.send(CH.modeSet, overlay.currentMode());
      // The dog just changed size under a possibly-open hover card.
      deps.onGeometryChanged?.();
    },
    palette: (name) => overlayOrWarn('palette')?.send(CH.paletteSet, resolvePalette(deps.sheet, name)),
    cardSize: (size) => deps.onCardSize?.(size),
    resetStyle: (style) => deps.onResetStyle?.(style),
    stillMode: (on) => deps.onStillMode?.(on),
    barkPreset: (preset) => deps.onBarkPreset?.(preset),
    barkSound: (on) => deps.onBarkSound?.(on),
    primaryService: (service) => deps.onPrimaryService?.(service),
    hiddenServices: (services) => deps.onHiddenServices?.(services),
    cardLayout: (layout) => deps.onCardLayout?.(layout),
    hideWhenIdle: (on) => deps.onHideWhenIdle?.(on),
    hideShortcut: (accelerator) => deps.onHideShortcut?.(accelerator),
    sleepInFullscreen: (on) => deps.onSleepInFullscreen?.(on),
    launchAtLogin: (on) => applyLaunchAtLogin(on),
    // No effect: the checker reads the setting on every due check (audit S8).
    verboseLog: (on) => setVerbose(on),
    forceInteractive: (on) => overlayOrWarn('force interactive')?.setForceInteractive(on)
  };
}

/**
 * The settings window's channels and payloads. Electron-free, like `ipc.ts`,
 * because the window's preload imports it.
 *
 * Kept apart from `ipc.ts` on purpose: the overlay and the hover card get the
 * preload in `preload/index.ts` and must never be able to write a setting, so
 * these channels exist only in `preload/settings.ts`, and main answers them
 * only for the settings window's own `webContents`.
 */
import type { SettingKey, UserSettings } from '../core/settings-spec';
import type { CreditPrice, UsageSnapshot } from '../core/usage';
import type { SessionEntry } from '../core/sessions';
import type { ShortcutStatus } from '../core/shortcuts';
import type { Character } from '../core/overview-stage';

export const SETTINGS_CH = {
  /** renderer -> main (invoke): everything the window draws. */
  get: 'walder:settingsWindow:get',
  /** renderer -> main (invoke): `{ key, value }`; answers a `SettingsSetReply`. */
  set: 'walder:settingsWindow:set',
  /** renderer -> main (invoke): ask for fresh numbers, as the tray's Refresh does. */
  refresh: 'walder:settingsWindow:refresh',
  /** renderer -> main (invoke): every coat's idle frame, for the Overview's preview. */
  previews: 'walder:settingsWindow:previews',
  /** main -> renderer: the whole state again, after any change from any UI. */
  changed: 'walder:settingsWindow:changed'
} as const;

export interface SettingsWindowState {
  settings: UserSettings;
  /** Keys shown read-only right now, with the reason. */
  locked: Partial<Record<SettingKey, string>>;
  /** The coats the sprite sheet offers, in sheet order. */
  palettes: { value: string; label: string }[];
  /** Whether the hide shortcut is held, for the line under it. */
  shortcutStatus: ShortcutStatus;
  platform: string;
  version: string;
  /** For the Overview screen: the same inputs the hover card draws from. */
  usage: UsageSnapshot | null;
  sessions: SessionEntry[];
  creditPrice: CreditPrice | null;
}

/**
 * One coat as the Overview previews it: the first idle frame the overlay would
 * draw for it, with that coat's colours. Asked for once, not pushed: it only
 * changes with the sheet, which needs a restart.
 */
export interface CoatPreview {
  id: string;
  label: string;
  character: Character;
  rows: string[];
  colors: Record<string, string>;
}

export type SettingsSetReply =
  | { ok: true; saved: boolean; state: SettingsWindowState }
  | { ok: false; error: string; state: SettingsWindowState };

/** Shape check for the renderer's `set` request. The value is checked by the spec. */
export function parseSetRequest(raw: unknown): { key: string; value: unknown } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { key, value } = raw as { key?: unknown; value?: unknown };
  if (typeof key !== 'string' || key.length === 0 || key.length > 64) return null;
  return { key, value };
}

/**
 * Shape of the settings window's bridge (`src/preload/settings.ts`), for the
 * renderer's separate tsconfig. Kept in step with the preload by hand.
 */
import type { SettingsSetReply, SettingsWindowState } from '../main/settings-ipc';

export interface WalderSettingsApi {
  get(): Promise<SettingsWindowState | null>;
  set(key: string, value: unknown): Promise<SettingsSetReply | null>;
  refresh(): Promise<boolean>;
  onChanged(callback: (state: SettingsWindowState) => void): () => void;
}

declare global {
  interface Window {
    walderSettings: WalderSettingsApi;
  }
}

export {};

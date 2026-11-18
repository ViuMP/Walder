/**
 * Shape of the settings window's bridge (`src/preload/settings.ts`), for the
 * renderer's separate tsconfig. Kept in step with the preload by hand.
 */
import type { CoatPreview, SettingsSetReply, SettingsWindowState } from '../main/settings-ipc';

export interface WalderSettingsApi {
  get(): Promise<SettingsWindowState | null>;
  set(key: string, value: unknown): Promise<SettingsSetReply | null>;
  /** Poll now; the services still waiting out a rate limit, or null if refused. */
  refresh(): Promise<readonly string[] | null>;
  /** Every coat's idle frame and colours, once at boot; null if refused. */
  previews(): Promise<CoatPreview[] | null>;
  onChanged(callback: (state: SettingsWindowState) => void): () => void;
}

declare global {
  interface Window {
    walderSettings: WalderSettingsApi;
  }
}

export {};

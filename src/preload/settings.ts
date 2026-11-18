/**
 * Walder — the settings window's preload. Sandboxed, bundled as CJS like the
 * other one, and just as narrow: four calls on the fixed channels in
 * `../main/settings-ipc`, nothing generic. Main answers them only for the
 * settings window and validates every value it is sent.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { SETTINGS_CH } from '../main/settings-ipc';
import type { SettingsSetReply, SettingsWindowState } from '../main/settings-ipc';
import type { WalderSettingsApi } from './settings.d';

const api = {
  get: (): Promise<SettingsWindowState | null> => ipcRenderer.invoke(SETTINGS_CH.get),
  set: (key: string, value: unknown): Promise<SettingsSetReply | null> =>
    ipcRenderer.invoke(SETTINGS_CH.set, { key, value }),
  refresh: (): Promise<readonly string[] | null> => ipcRenderer.invoke(SETTINGS_CH.refresh),
  onChanged: (callback: (state: SettingsWindowState) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, state: SettingsWindowState): void =>
      callback(state);
    ipcRenderer.on(SETTINGS_CH.changed, listener);
    return () => {
      ipcRenderer.removeListener(SETTINGS_CH.changed, listener);
    };
  }
};

// Typed against the declaration the renderer sees, so the two cannot drift.
const bridge: WalderSettingsApi = api;
contextBridge.exposeInMainWorld('walderSettings', bridge);

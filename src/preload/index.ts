/**
 * Walder — preload. M2a placeholder: exposes an empty, frozen `window.walder`
 * namespace so the renderer has a stable seam. Real IPC (usage snapshots, pet
 * clicks, hit-test regions, fullscreen state) is added in later stages.
 */
import { contextBridge } from 'electron';

const api = Object.freeze({});

contextBridge.exposeInMainWorld('walder', api);

/**
 * Shape of the bridge the preload exposes to renderer code. Empty in M2a.
 */
export interface WalderApi {
  // Populated in later stages (usage snapshots, pet events, fullscreen state).
}

declare global {
  interface Window {
    walder: WalderApi;
  }
}

export {};

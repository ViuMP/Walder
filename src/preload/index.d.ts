/**
 * Shape of the bridge the preload exposes to renderer code.
 *
 * Kept in step with `src/preload/index.ts` by hand — the renderer is typechecked
 * by a separate tsconfig that never sees the preload's implementation, so this
 * declaration is what it believes.
 */
import type {
  ModePayload,
  PalettePayload,
  SettingsPayload,
  SheetPayload
} from '../main/ipc';

export interface WalderApi {
  /** Everything needed for the first frame. `null` if main rejected the caller. */
  getSettings(): Promise<SettingsPayload | null>;
  /** `true` when the cursor is over opaque sprite pixels, so clicks should land. */
  setHit(inside: boolean): Promise<void>;
  dragStart(): Promise<void>;
  /** Cumulative cursor movement since `dragStart`, in screen pixels. */
  dragMove(dxScreen: number, dyScreen: number): Promise<void>;
  dragEnd(): Promise<void>;
  pet(): Promise<void>;
  /** Right-click on the dog: open the tray menu. */
  openMenu(): Promise<void>;
  /** Each subscription returns its own unsubscribe function. */
  onSheet(callback: (payload: SheetPayload) => void): () => void;
  onMode(callback: (payload: ModePayload) => void): () => void;
  onPalette(callback: (payload: PalettePayload) => void): () => void;
  /** Main changed the click-through flag itself: re-derive and re-send the hover state. */
  onHitResync(callback: () => void): () => void;
}

declare global {
  interface Window {
    walder: WalderApi;
  }
}

export {};

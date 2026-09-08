/**
 * Shape of the bridge the preload exposes to renderer code.
 *
 * Kept in step with `src/preload/index.ts` by hand — the renderer is typechecked
 * by a separate tsconfig that never sees the preload's implementation, so this
 * declaration is what it believes.
 *
 * One bridge serves both windows: the overlay uses the hit/drag/hover half, the
 * hover panel uses `onUsage` and `reportPanelSize`. Main checks the sender on
 * every channel, so a call from the wrong window is dropped there rather than
 * being prevented here.
 */
import type {
  ModePayload,
  PalettePayload,
  ServiceName,
  SettingsPayload,
  SheetPayload,
  UsagePayload
} from '../main/ipc';
import type { Rect } from '../core/geometry';

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
  /** The cursor came to rest on the dog's ink, at these screen bounds. */
  hoverEnter(spriteRectScreen: Rect): Promise<void>;
  /** The cursor left the dog, or a drag began. */
  hoverLeave(): Promise<void>;
  /** Poll every provider now; resolves `false` when the cooldown blocked it. */
  refreshNow(): Promise<boolean>;
  login(service: ServiceName): Promise<void>;
  logout(service: ServiceName): Promise<void>;
  /** Panel only: report the measured card height. */
  reportPanelSize(height: number): Promise<void>;
  /** Each subscription returns its own unsubscribe function. */
  onSheet(callback: (payload: SheetPayload) => void): () => void;
  onMode(callback: (payload: ModePayload) => void): () => void;
  onPalette(callback: (payload: PalettePayload) => void): () => void;
  /** Main changed the click-through flag itself: re-derive and re-send the hover state. */
  onHitResync(callback: () => void): () => void;
  /** A fresh (or restored) usage snapshot. */
  onUsage(callback: (payload: UsagePayload) => void): () => void;
}

declare global {
  interface Window {
    walder: WalderApi;
  }
}

export {};

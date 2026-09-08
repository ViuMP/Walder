/**
 * Canvas rendering for sprite frames. Renderer-only (needs DOM canvas types).
 *
 * A frame is a grid of palette letters, so drawing it naively means one
 * `fillRect` per pixel — 1920 of them for the 48x40 stand box, every frame, for
 * a mascot that must stay under 1 % idle CPU. So each distinct combination is
 * rasterised once into an `OffscreenCanvas` and thereafter blitted with a single
 * `drawImage`.
 *
 * The cache is keyed by `paletteName|frameName|scale|dpr` and *bounded*. Names,
 * not object identity: palettes arrive over IPC as fresh clones, so the same
 * coat is a different object after every push and an identity key would miss
 * every time while retaining a bitmap per push. The bound matters because the
 * key space is not fixed either — coats, sizes and a device ratio that changes
 * when the window is dragged to another monitor all multiply out — so entries
 * are evicted least-recently-used past `MAX_CACHE_ENTRIES`. In steady state only
 * a handful of keys are live and nothing is ever evicted.
 *
 * Bitmaps are rasterised in *device* pixels (`scale * dpr`, rounded — see
 * `devicePixelScale`) and drawn at that exact size, so the caller must work in
 * device pixels too: the canvas backing store is device pixels and there is no
 * `ctx.scale(dpr, dpr)` anywhere, because on a fractional ratio that is what
 * makes sprite pixel widths uneven.
 */
import type { Frame, Palette } from './types';
import { frameSize } from './mask';
import { devicePixelScale, rasteriseFrame } from './raster';

export { frameAlphaMask, frameSize, maskBounds } from './mask';
export type { FrameSize, MaskBounds } from './mask';
export { devicePixelScale, rasteriseFrame } from './raster';
export type { FillTarget } from './raster';

/** Either flavour of 2D context; `renderFrame` only ever blits into it. */
export type AnyCanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * How many rasterised bitmaps to keep. A live set is one coat x one size x one
 * ratio x the frames of the running animation — a handful. 64 leaves room to
 * flip through every coat and size, or to cross onto a second monitor, without
 * re-rasterising, while bounding the worst case at a few megabytes.
 */
export const MAX_CACHE_ENTRIES = 64;

/**
 * `paletteName|frameName|scale|dpr` -> bitmap, in least-recently-used order.
 * A `Map` iterates in insertion order, so re-inserting on every read makes the
 * first key the oldest and eviction a single `delete`.
 */
const rasterCache = new Map<string, OffscreenCanvas>();

/** Everything that identifies one rasterised bitmap. */
export interface FrameRender {
  readonly frame: Frame;
  /** Sheet key of `frame`. Part of the cache key, so it must match the frame. */
  readonly frameName: string;
  readonly palette: Palette;
  /** Sheet key of `palette`, including the fallback if one was substituted. */
  readonly paletteName: string;
  /** Logical (CSS) pixels per sprite pixel. */
  readonly scale: number;
  /** Device pixel ratio of the surface being drawn to. */
  readonly dpr: number;
}

function rasterise(frame: Frame, palette: Palette, pixelScale: number): OffscreenCanvas {
  const { width, height } = frameSize(frame);
  const canvas = new OffscreenCanvas(
    Math.max(1, width * pixelScale),
    Math.max(1, height * pixelScale)
  );
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('sprite render: no 2d context on the offscreen canvas');
  ctx.imageSmoothingEnabled = false;
  rasteriseFrame(frame, palette, pixelScale, ctx);
  return canvas;
}

function cached(key: string, make: () => OffscreenCanvas): OffscreenCanvas {
  const hit = rasterCache.get(key);
  if (hit !== undefined) {
    // Re-insert to move it to the young end of the iteration order.
    rasterCache.delete(key);
    rasterCache.set(key, hit);
    return hit;
  }

  const bitmap = make();
  rasterCache.set(key, bitmap);
  while (rasterCache.size > MAX_CACHE_ENTRIES) {
    const oldest = rasterCache.keys().next();
    if (oldest.done === true) break;
    rasterCache.delete(oldest.value);
  }
  return bitmap;
}

/** Current number of cached bitmaps. Exposed for tests and diagnostics. */
export function rasterCacheSize(): number {
  return rasterCache.size;
}

/** Drop every cached bitmap. Nothing in the app needs this; tests do. */
export function clearRasterCache(): void {
  rasterCache.clear();
}

/**
 * Blit `render.frame` with its top-left at the context's current origin.
 *
 * The context transform must already be in **device** pixels (translate by
 * `Math.round(cssX * dpr)`), because the bitmap is device-sized and is drawn 1:1.
 */
export function renderFrame(render: FrameRender, ctx: AnyCanvasContext): void {
  const { frame, frameName, palette, paletteName, scale, dpr } = render;
  if (!Number.isFinite(scale) || scale <= 0) return;

  const pixelScale = devicePixelScale(scale, dpr);
  const key = `${paletteName}|${frameName}|${scale}|${dpr}`;
  const bitmap = cached(key, () => rasterise(frame, palette, pixelScale));

  ctx.imageSmoothingEnabled = false;
  // Explicit destination size rather than the two-argument form: it is the same
  // number today, and it stays correct if a cached bitmap outlives its key.
  ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);
}

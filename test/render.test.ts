/// <reference lib="dom" />
/**
 * The rasterised-bitmap cache in `src/sprites/render.ts`.
 *
 * `renderFrame` rasterises each distinct `paletteName|frameName|scale|dpr`
 * once and caches the bitmap, bounded at `MAX_CACHE_ENTRIES` and evicted
 * least-recently-used — otherwise a mascot cycling through coats, sizes and
 * monitors would grow the cache without bound. This is the only place that
 * property is exercised: that eviction actually happens at exactly the
 * documented bound, that it drops the *oldest* key and not some other one,
 * and that touching a cached key (a re-render, which is the only way this
 * cache is ever read) moves it back to the young end instead of ageing out on
 * schedule regardless.
 *
 * `OffscreenCanvas` does not exist in Node, so it is stubbed for this file
 * only with a `getContext` that returns a recording context implementing
 * exactly the surface `rasteriseFrame` (src/sprites/raster.ts) and
 * `renderFrame` itself call: `fillStyle`/`fillRect` for the rasteriser, and
 * `imageSmoothingEnabled`/`save`/`translate`/`scale`/`drawImage`/`restore` for
 * the blit. `renderFrame` — the function that actually goes through
 * `cached()` — is exercised directly through its public export; nothing here
 * needed `cached()` itself exported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRasterCache,
  rasterCacheSize,
  renderFrame,
  MAX_CACHE_ENTRIES,
  type FrameRender
} from '../src/sprites/render';
import type { Frame, Palette } from '../src/sprites/types';

/** A recording 2D context: does nothing but count and remember calls. */
function recordingCtx(): CanvasRenderingContext2D {
  const ctx = {
    fillStyle: '#000',
    imageSmoothingEnabled: false,
    fillRectCalls: 0,
    fillRect(): void {
      ctx.fillRectCalls++;
    },
    save(): void {},
    restore(): void {},
    translate(): void {},
    scale(): void {},
    drawImage(): void {}
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

/** One made-up bitmap per construction, so cache misses are countable. */
let offscreenConstructions = 0;

class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    offscreenConstructions++;
  }
  getContext(): CanvasRenderingContext2D {
    return recordingCtx();
  }
}

beforeEach(() => {
  offscreenConstructions = 0;
  clearRasterCache();
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearRasterCache();
});

const FRAME: Frame = { box: 'dog', rows: ['aa', 'aa'] };
const PALETTE: Palette = { a: '#ff8800' };

/** A render at a given `scale`, which is what makes each key distinct here. */
function renderAt(scale: number): void {
  const render: FrameRender = {
    frame: FRAME,
    frameName: 'idle_0',
    palette: PALETTE,
    paletteName: 'golden',
    scale,
    dpr: 1
  };
  renderFrame(render, recordingCtx());
}

describe('renderFrame cache eviction', () => {
  it('caps the cache at exactly MAX_CACHE_ENTRIES', () => {
    for (let scale = 1; scale <= MAX_CACHE_ENTRIES; scale++) renderAt(scale);
    expect(rasterCacheSize()).toBe(MAX_CACHE_ENTRIES);

    renderAt(MAX_CACHE_ENTRIES + 1);
    expect(rasterCacheSize()).toBe(MAX_CACHE_ENTRIES);
  });

  it('evicts the oldest key once the bound is exceeded', () => {
    for (let scale = 1; scale <= MAX_CACHE_ENTRIES; scale++) renderAt(scale);

    // One more distinct key pushes the cache over the bound...
    renderAt(MAX_CACHE_ENTRIES + 1);
    expect(rasterCacheSize()).toBe(MAX_CACHE_ENTRIES);

    // ...so the very first key (scale 1) must have been dropped: rendering it
    // again is a cache miss, observable as a fresh OffscreenCanvas built.
    const before = offscreenConstructions;
    renderAt(1);
    expect(offscreenConstructions).toBe(before + 1);
  });

  it('moves a touched key to the young end instead of letting it age out on schedule', () => {
    // Fill the cache with scales 1..MAX, in order.
    for (let scale = 1; scale <= MAX_CACHE_ENTRIES; scale++) renderAt(scale);

    // Touch the oldest key (scale 1) again — a cache hit, which must move it
    // to the young end rather than leaving it the next eviction candidate.
    renderAt(1);

    // One more distinct key: without the touch, scale 1 would be oldest and
    // would be evicted; with the touch, scale 2 is oldest instead.
    renderAt(MAX_CACHE_ENTRIES + 1);
    expect(rasterCacheSize()).toBe(MAX_CACHE_ENTRIES);

    const beforeOne = offscreenConstructions;
    renderAt(1);
    expect(offscreenConstructions, 'scale 1 should still be cached — a hit, not a rebuild').toBe(
      beforeOne
    );

    const beforeTwo = offscreenConstructions;
    renderAt(2);
    expect(offscreenConstructions, 'scale 2 should have been evicted instead').toBe(beforeTwo + 1);
  });
});

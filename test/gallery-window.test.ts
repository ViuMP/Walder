/**
 * The gate that turns a run into an animation-gallery run.
 *
 * Small, but worth pinning: `galleryRequested` decides whether the process
 * becomes an ordinary titled window or the mascot, and it is read *before* the
 * single-instance lock in `index.ts`. Getting it wrong in either direction is
 * bad in a way nobody would attribute to this function — a stray truthy value
 * would replace the owner's mascot with a review tool, and a missed one would
 * make `npm run sprites` open a click-through overlay with no way to close it.
 *
 * `electron` is mocked because the module imports `BrowserWindow` at the top
 * level; nothing here builds a window.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {} }));

const { GALLERY_ENV, GALLERY_HEIGHT, GALLERY_WIDTH, galleryRequested } = await import(
  '../src/main/gallery-window'
);

describe('galleryRequested', () => {
  it('is true only for exactly "1"', () => {
    expect(galleryRequested({ [GALLERY_ENV]: '1' })).toBe(true);
    expect(galleryRequested({})).toBe(false);
    expect(galleryRequested({ [GALLERY_ENV]: '0' })).toBe(false);
    // `scripts/sprites.ts` sets the string "1" and nothing else. Treating any
    // non-empty value as true would make a stray `WALDER_GALLERY=false` in a
    // shell profile replace the mascot with the gallery.
    expect(galleryRequested({ [GALLERY_ENV]: 'true' })).toBe(false);
    expect(galleryRequested({ [GALLERY_ENV]: '' })).toBe(false);
  });

  it('opens at the size the owner was promised', () => {
    // A review window that arrived small enough to need resizing before the
    // first card was visible would be a worse tool than the PNG contact sheets.
    expect(GALLERY_WIDTH).toBe(1_100);
    expect(GALLERY_HEIGHT).toBe(800);
  });
});

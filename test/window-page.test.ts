/**
 * The page plumbing the overlay, the hover panel and the gallery share
 * (2026-11 audit, W-5): one page resolver and one navigation lock, with the
 * behaviour each window had when it carried its own copy.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRELOAD, lockNavigation, pageUrl } from '../src/main/window-page';

const DEV = 'ELECTRON_RENDERER_URL';

describe('pageUrl', () => {
  afterEach(() => {
    delete process.env[DEV];
  });

  it('points at the dev server under `npm run dev`, query included', () => {
    process.env[DEV] = 'http://localhost:5173';
    expect(pageUrl('panel.html')).toBe('http://localhost:5173/panel.html');
    expect(pageUrl('overlay.html', '?debug=1')).toBe('http://localhost:5173/overlay.html?debug=1');
  });

  it('points at the bundled renderer file otherwise, an empty dev URL included', () => {
    process.env[DEV] = '';
    const url = pageUrl('overlay.html', '?debug=1');
    expect(url.startsWith('file://')).toBe(true);
    expect(url.endsWith('/renderer/overlay.html?debug=1')).toBe(true);
  });

  it('resolves the preload next to the renderer, as `../preload/index.cjs`', () => {
    expect(PRELOAD.replaceAll('\\', '/').endsWith('/preload/index.cjs')).toBe(true);
  });
});

describe('lockNavigation', () => {
  function fakeWin(): {
    win: Parameters<typeof lockNavigation>[0];
    navigate: (url: string) => boolean;
    openHandler: () => unknown;
  } {
    let onNavigate: ((event: { preventDefault: () => void }, url: string) => void) | null = null;
    let openHandler: (() => unknown) | null = null;
    const win = {
      webContents: {
        setWindowOpenHandler: (handler: () => unknown) => {
          openHandler = handler;
        },
        on: (_name: string, handler: typeof onNavigate) => {
          onNavigate = handler;
        }
      }
    } as unknown as Parameters<typeof lockNavigation>[0];
    return {
      win,
      navigate: (url) => {
        let prevented = false;
        onNavigate?.({ preventDefault: () => (prevented = true) }, url);
        return prevented;
      },
      openHandler: () => openHandler?.()
    };
  }

  it('denies new windows, allows only its own page, and names the window it blocked in', () => {
    const fake = fakeWin();
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      lockNavigation(fake.win, 'file:///app/panel.html', ' in the hover panel');
      expect(fake.openHandler()).toEqual({ action: 'deny' });
      expect(fake.navigate('file:///app/panel.html')).toBe(false);
      expect(fake.navigate('https://example.com/')).toBe(true);
      expect(warned).toHaveBeenCalledTimes(1);
      expect(String(warned.mock.calls[0]?.join(' '))).toContain(
        'blocked in-window navigation in the hover panel to https://example.com/'
      );
    } finally {
      warned.mockRestore();
    }
  });
});

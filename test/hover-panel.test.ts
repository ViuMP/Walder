/**
 * The hover panel's window behaviour, against a mocked `BrowserWindow`.
 *
 * The placement arithmetic is already pinned in `panel-place.test.ts`; what is
 * only testable here is the part that is *timing and window flags*, and both
 * have a specific way of going wrong:
 *
 *  - **The show delay is a race.** The card must not appear because the cursor
 *    crossed the dog on its way somewhere else, which means an enter that is
 *    cancelled and re-armed inside the 250 ms window must not fire early — and
 *    a leave inside it must cancel outright, not merely hide a card that then
 *    pops up a moment later.
 *  - **The window must never take focus.** `show()` on a `focusable: false`
 *    window still raises it and, on macOS, activates a dockless app — which
 *    would steal the caret out of whatever the owner is typing into. So it is
 *    `showInactive()`, and it is fully click-through
 *    (`setIgnoreMouseEvents(true)`, no `forward`) because nothing on the card is
 *    interactive and it appears right next to where the cursor already is.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import type { Rect } from '../src/core/geometry';

const host = vi.hoisted(() => ({
  /** Constructor options of every window built. */
  built: [] as Record<string, unknown>[],
  calls: [] as string[],
  bounds: [] as Rect[],
  ignoreMouse: [] as { ignore: boolean; options: unknown }[],
  alwaysOnTop: [] as unknown[][],
  loaded: [] as string[],
  navHandlers: [] as ((event: { preventDefault: () => void }, url: string) => void)[],
  openHandlerDenies: 0
}));

vi.mock('electron', () => {
  class FakeWebContents {
    setWindowOpenHandler(handler: () => { action: string }): void {
      if (handler().action === 'deny') host.openHandlerDenies++;
    }
    on(event: string, listener: (e: { preventDefault: () => void }, url: string) => void): void {
      if (event === 'will-navigate') host.navHandlers.push(listener);
    }
    send(): void {}
    isDestroyed(): boolean {
      return false;
    }
  }

  class FakeBrowserWindow {
    readonly webContents = new FakeWebContents();
    private visible = false;
    private destroyed = false;
    private resizable: boolean;

    constructor(options: Record<string, unknown>) {
      host.built.push(options);
      this.resizable = options['resizable'] !== false;
    }

    setAlwaysOnTop(...args: unknown[]): void {
      host.alwaysOnTop.push(args);
    }
    setVisibleOnAllWorkspaces(): void {}
    setSkipTaskbar(): void {}
    setMenuBarVisibility(): void {}
    setIgnoreMouseEvents(ignore: boolean, options?: unknown): void {
      host.ignoreMouse.push({ ignore, options });
    }
    loadURL(url: string): Promise<void> {
      host.loaded.push(url);
      return Promise.resolve();
    }
    isResizable(): boolean {
      return this.resizable;
    }
    setResizable(next: boolean): void {
      this.resizable = next;
    }
    setBounds(rect: Rect): void {
      host.calls.push('setBounds');
      host.bounds.push(rect);
    }
    showInactive(): void {
      host.calls.push('showInactive');
      this.visible = true;
    }
    show(): void {
      // Recorded, never expected: see the file header.
      host.calls.push('show');
      this.visible = true;
    }
    hide(): void {
      host.calls.push('hide');
      this.visible = false;
    }
    isVisible(): boolean {
      return this.visible;
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      host.calls.push('destroy');
      this.destroyed = true;
    }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    screen: {
      getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }]
    }
  };
});

const { HOVER_SHOW_DELAY_MS, PANEL_INITIAL_HEIGHT, createHoverPanel } = await import(
  '../src/main/hover-panel'
);
const { PANEL_WIDTH } = await import('../src/main/ipc');

/** The dog's ink rect, mid-screen so placement is never clamped. */
const DOG: Rect = { x: 700, y: 400, width: 64, height: 64 };

beforeEach(() => {
  vi.useFakeTimers();
  host.built.length = 0;
  host.calls.length = 0;
  host.bounds.length = 0;
  host.ignoreMouse.length = 0;
  host.alwaysOnTop.length = 0;
  host.loaded.length = 0;
  host.navHandlers.length = 0;
  host.openHandlerDenies = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createHoverPanel: the window it builds', () => {
  it('is a click-through, unfocusable, always-on-top tooltip', () => {
    const panel = createHoverPanel();

    const options = host.built[0] as Record<string, unknown>;
    expect(options['focusable']).toBe(false);
    expect(options['show']).toBe(false);
    expect(options['transparent']).toBe(true);
    expect(options['skipTaskbar']).toBe(true);
    expect(options['width']).toBe(PANEL_WIDTH);

    // Fully click-through, with no `{forward: true}`: unlike the overlay, this
    // window never needs to hear about mouse moves.
    expect(host.ignoreMouse).toEqual([{ ignore: true, options: undefined }]);
    // The same level as the dog, so the two never separate.
    expect(host.alwaysOnTop[0]).toEqual([true, 'screen-saver']);
    panel.destroy();
  });

  it('locks its own navigation: it holds the preload bridge', () => {
    const panel = createHoverPanel();
    expect(host.openHandlerDenies).toBe(1);

    const handler = host.navHandlers[0];
    expect(handler).toBeDefined();
    let prevented = false;
    handler?.({ preventDefault: () => (prevented = true) }, 'https://evil.example/');
    expect(prevented).toBe(true);

    prevented = false;
    handler?.({ preventDefault: () => (prevented = true) }, host.loaded[0] as string);
    expect(prevented).toBe(false);
    panel.destroy();
  });
});

describe('the show delay', () => {
  it('shows the card once the cursor has rested for the delay', () => {
    const panel = createHoverPanel();
    panel.hoverEnter(DOG);

    // Nothing yet: this is what stops the card flickering as the cursor crosses.
    expect(host.calls).not.toContain('showInactive');
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS);

    expect(host.calls.filter((c) => c === 'showInactive')).toHaveLength(1);
    // `showInactive`, never `show`.
    expect(host.calls).not.toContain('show');
    // Placed before it was shown, so it never appears in the wrong spot first.
    expect(host.calls.indexOf('setBounds')).toBeLessThan(host.calls.indexOf('showInactive'));
    expect(panel.isShowing()).toBe(true);
    panel.destroy();
  });

  it('does not show when the cursor leaves inside the delay', () => {
    const panel = createHoverPanel();
    panel.hoverEnter(DOG);
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS - 50);
    panel.hoverLeave();

    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS * 4);
    expect(host.calls).not.toContain('showInactive');
    expect(panel.isShowing()).toBe(false);
    panel.destroy();
  });

  it('enter, leave, enter inside the delay re-arms rather than firing early', () => {
    // The race: two crossings of the dog in quick succession must not add up to
    // a card appearing before the cursor has actually rested for 250 ms.
    const panel = createHoverPanel();
    panel.hoverEnter(DOG);
    vi.advanceTimersByTime(100);
    panel.hoverLeave();
    vi.advanceTimersByTime(50);
    panel.hoverEnter(DOG);

    // 250 ms after the *first* enter: still nothing.
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS - 150);
    expect(host.calls).not.toContain('showInactive');

    // 250 ms after the *second* enter: exactly one card, not two.
    vi.advanceTimersByTime(150);
    expect(host.calls.filter((c) => c === 'showInactive')).toHaveLength(1);
    panel.destroy();
  });

  it('hides immediately when the cursor leaves a card that is up', () => {
    const panel = createHoverPanel();
    panel.hoverEnter(DOG);
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS);
    expect(panel.isShowing()).toBe(true);

    panel.hoverLeave();
    // No delay on the way out: a card that lingers reads as a bug.
    expect(host.calls.at(-1)).toBe('hide');
    expect(panel.isShowing()).toBe(false);
    panel.destroy();
  });

  it('follows the dog rather than waiting out the delay again', () => {
    const panel = createHoverPanel();
    panel.hoverEnter(DOG);
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS);
    const shown = host.bounds.length;

    panel.hoverEnter({ ...DOG, x: DOG.x + 40 });
    expect(host.bounds.length).toBe(shown + 1);
    // Re-placed, and not shown a second time.
    expect(host.calls.filter((c) => c === 'showInactive')).toHaveLength(1);
    panel.destroy();
  });

  it('does not leave a timer running after destroy', () => {
    const panel = createHoverPanel();
    panel.hoverEnter(DOG);
    panel.destroy();
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS * 4);
    expect(host.calls).not.toContain('showInactive');
  });
});

describe('setContentHeight', () => {
  it('re-places the card, because a taller card can need a new y', () => {
    const panel = createHoverPanel();
    panel.hoverEnter(DOG);
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS);
    const before = host.bounds.length;

    panel.setContentHeight(PANEL_INITIAL_HEIGHT + 120);
    expect(host.bounds.length).toBe(before + 1);
    expect(host.bounds.at(-1)?.height).toBe(PANEL_INITIAL_HEIGHT + 120);
    expect(host.bounds.at(-1)?.width).toBe(PANEL_WIDTH);
    panel.destroy();
  });

  it('ignores a height it already has', () => {
    const panel = createHoverPanel();
    panel.hoverEnter(DOG);
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS);
    const before = host.bounds.length;

    panel.setContentHeight(PANEL_INITIAL_HEIGHT);
    expect(host.bounds.length).toBe(before);
    panel.destroy();
  });
});

/**
 * The hover panel's window behaviour, against a mocked `BrowserWindow`.
 *
 * The placement arithmetic is already pinned in `panel-place.test.ts`; what is
 * only testable here is the part that is *timing and window flags*, and each has
 * a specific way of going wrong:
 *
 *  - **The show delay is a race.** The card must not appear because the cursor
 *    crossed the dog on its way somewhere else, which means an enter that is
 *    cancelled and re-armed inside the 250 ms window must not fire early — and
 *    a leave inside it must cancel outright, not merely hide a card that then
 *    pops up a moment later. Nor may a *rect change* inside that window restart
 *    the clock: the renderer sends one on every animation frame that moves the
 *    ink, and `blink` (83 ms) and `tail_wag` (100 ms) both used to starve the
 *    250 ms timer indefinitely, so the card never appeared at all while the dog
 *    was blinking.
 *  - **The window must never take focus.** `show()` on a `focusable: false`
 *    window still raises it and, on macOS, activates a dockless app — which
 *    would steal the caret out of whatever the owner is typing into. So it is
 *    `showInactive()`, and it is fully click-through
 *    (`setIgnoreMouseEvents(true)`, no `forward`) because nothing on the card is
 *    interactive and it appears right next to where the cursor already is.
 *  - **The card size is a window width plus a renderer push.** A size change
 *    must re-place the window at the new width *without hiding the card* — the
 *    owner is comparing the three, and the renderer only re-sends `hover:enter`
 *    when the dog's rect changes, so a hidden card would stay hidden.
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
  /** `(channel, payload)` of every `webContents.send`. */
  sent: [] as { channel: string; payload: unknown }[],
  loaded: [] as string[],
  navHandlers: [] as ((event: { preventDefault: () => void }, url: string) => void)[],
  openHandlerDenies: 0,
  /** What `isVisible()` should claim, regardless of the real state. */
  lieVisible: null as boolean | null
}));

vi.mock('electron', () => {
  class FakeWebContents {
    setWindowOpenHandler(handler: () => { action: string }): void {
      if (handler().action === 'deny') host.openHandlerDenies++;
    }
    on(event: string, listener: (e: { preventDefault: () => void }, url: string) => void): void {
      if (event === 'will-navigate') host.navHandlers.push(listener);
    }
    send(channel: string, payload: unknown): void {
      host.sent.push({ channel, payload });
    }
    isDestroyed(): boolean {
      return false;
    }
  }

  class FakeBrowserWindow {
    readonly webContents = new FakeWebContents();
    private visible = false;
    private destroyed = false;
    private resizable: boolean;
    private rect: Rect = { x: 0, y: 0, width: 0, height: 0 };

    constructor(options: Record<string, unknown>) {
      host.built.push(options);
      this.resizable = options['resizable'] !== false;
      this.rect = {
        x: 0,
        y: 0,
        width: Number(options['width'] ?? 0),
        height: Number(options['height'] ?? 0)
      };
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
      this.rect = rect;
    }
    getBounds(): Rect {
      return this.rect;
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
      // `host.lieVisible` reproduces the macOS reading of this flag, which is
      // false for a merely *occluded* window and true for one ordered in on
      // another Space — neither of which is "the owner can see this".
      return host.lieVisible ?? this.visible;
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
const { CH } = await import('../src/main/ipc');
const { cardWidthFor } = await import('../src/core/card-layout');

/** The dog's ink rect, mid-screen so placement is never clamped. */
const DOG: Rect = { x: 700, y: 400, width: 64, height: 64 };

beforeEach(() => {
  vi.useFakeTimers();
  host.built.length = 0;
  host.calls.length = 0;
  host.bounds.length = 0;
  host.ignoreMouse.length = 0;
  host.alwaysOnTop.length = 0;
  host.sent.length = 0;
  host.loaded.length = 0;
  host.navHandlers.length = 0;
  host.openHandlerDenies = 0;
  host.lieVisible = null;
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
    expect(options['width']).toBe(cardWidthFor('large'));

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
    expect(host.bounds.at(-1)?.width).toBe(cardWidthFor('large'));
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

describe('hoverEnter does not restart the timer on a rect change', () => {
  it('shows 250 ms after the first enter, not 250 ms after the last frame', () => {
    /*
     * The regression this exists for: the renderer sends `hover:enter` whenever
     * the dog's ink rect changes, which is every animation frame that moves him.
     * `blink` runs at 83 ms and `tail_wag` at 100 ms — both shorter than the
     * delay — so clearing and re-arming the timer on each one pushed the card
     * out for as long as the dog kept moving, which is forever.
     */
    const panel = createHoverPanel();
    panel.hoverEnter(DOG);

    for (const step of [83, 83, 83]) {
      vi.advanceTimersByTime(step);
      panel.hoverEnter({ ...DOG, y: DOG.y + 1 });
    }
    expect(host.calls).not.toContain('showInactive');

    // 250 ms after the *first* enter: the card is up.
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS - 249);
    expect(host.calls.filter((c) => c === 'showInactive')).toHaveLength(1);

    // And it landed at the latest anchor, not the first one.
    expect(host.bounds.at(-1)?.y).toBe(DOG.y + 1);
    panel.destroy();
  });
});

describe('hoverLeave hides unconditionally', () => {
  it('hides even when isVisible() says the window is not visible', () => {
    /*
     * On macOS `isVisible()` is false for a merely *occluded* window and true
     * for one ordered in on another Space, so it cannot answer "can the owner
     * see this". Guarding the hide on it left cards on screen with the cursor
     * nowhere near the dog. `hide()` on a hidden window is a no-op, so there is
     * nothing to save by asking first.
     */
    const panel = createHoverPanel();
    panel.hoverEnter(DOG);
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS);

    host.lieVisible = false;
    panel.hoverLeave();
    expect(host.calls.filter((c) => c === 'hide')).toHaveLength(1);
    panel.destroy();
  });
});

describe('setCardSize', () => {
  it('re-widens the open card in place and tells the renderer to redraw', () => {
    const panel = createHoverPanel();
    panel.hoverEnter(DOG);
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS);
    expect(host.bounds.at(-1)?.width).toBe(cardWidthFor('large'));

    panel.setCardSize('small');

    expect(host.bounds.at(-1)?.width).toBe(cardWidthFor('small'));
    expect(host.bounds.at(-1)?.width).toBe(200);
    expect(host.sent).toEqual([{ channel: CH.cardSizeSet, payload: { cardSize: 'small' } }]);
    // Never hidden: the owner is comparing the three sizes, and the renderer
    // only re-sends `hover:enter` when the dog's rect changes.
    expect(host.calls).not.toContain('hide');
    expect(panel.isShowing()).toBe(true);
    panel.destroy();
  });

  it('does nothing at all when the size has not changed', () => {
    const panel = createHoverPanel({ cardSize: 'medium' });
    panel.hoverEnter(DOG);
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS);
    const before = host.bounds.length;

    panel.setCardSize('medium');
    expect(host.bounds.length).toBe(before);
    expect(host.sent).toEqual([]);
    panel.destroy();
  });

  it('takes effect on a card that is not up, without showing it', () => {
    const panel = createHoverPanel();
    panel.setCardSize('medium');
    expect(host.calls).not.toContain('showInactive');
    expect(host.sent.at(-1)?.channel).toBe(CH.cardSizeSet);

    panel.hoverEnter(DOG);
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS);
    expect(host.bounds.at(-1)?.width).toBe(cardWidthFor('medium'));
    panel.destroy();
  });

  it('builds the window at the size it was given', () => {
    const panel = createHoverPanel({ cardSize: 'small' });
    expect((host.built[0] as Record<string, unknown>)['width']).toBe(cardWidthFor('small'));
    panel.destroy();
  });
});

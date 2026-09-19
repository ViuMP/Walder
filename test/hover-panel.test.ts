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
 *  - **The macOS full-screen setup is pinned.** The fake records the workspace
 *    arguments and the order of the invisible pre-show sequence, so a future
 *    refactor cannot silently lose the behavior the owner verified in Safari.
 *  - **The reload of a dead renderer is bounded, and only a test can say so.**
 *    It is the one self-retrying path in the app, and the failure it guards
 *    against — a renderer that dies on every load, behind a window that is
 *    hidden at the time — is invisible by construction: nobody would see it
 *    except as a machine filling up with renderer processes.
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
  /** Arguments of every `setVisibleOnAllWorkspaces` call, in order. */
  workspaces: [] as unknown[][],
  opacity: [] as number[],
  /** `(channel, payload)` of every `webContents.send`. */
  sent: [] as { channel: string; payload: unknown }[],
  /** `once('ready-to-show')` listeners, so a test can decide when the page is ready. */
  readyHandlers: [] as (() => void)[],
  loaded: [] as string[],
  navHandlers: [] as ((event: { preventDefault: () => void }, url: string) => void)[],
  /** `on('render-process-gone')` listeners, so a test can kill the renderer. */
  goneHandlers: [] as ((event: unknown, details: { reason: string }) => void)[],
  /** How many times the page was reloaded. */
  reloads: 0,
  openHandlerDenies: 0,
  /** What `isVisible()` should claim, regardless of the real state. */
  lieVisible: null as boolean | null
}));

vi.mock('electron', () => {
  class FakeWebContents {
    setWindowOpenHandler(handler: () => { action: string }): void {
      if (handler().action === 'deny') host.openHandlerDenies++;
    }
    on(event: string, listener: (e: never, arg: never) => void): void {
      if (event === 'will-navigate')
        host.navHandlers.push(listener as unknown as (typeof host.navHandlers)[number]);
      if (event === 'render-process-gone')
        host.goneHandlers.push(listener as unknown as (typeof host.goneHandlers)[number]);
    }
    reload(): void {
      host.reloads++;
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
      host.calls.push('setAlwaysOnTop');
      host.alwaysOnTop.push(args);
    }
    /**
     * Records its arguments, unlike the stub this replaced. The flag that
     * matters — `{visibleOnFullScreen: true}` — is the whole reason the card is
     * meant to appear over a full-screen app, and nothing asserted it before.
     */
    setVisibleOnAllWorkspaces(...args: unknown[]): void {
      host.calls.push('setVisibleOnAllWorkspaces');
      host.workspaces.push(args);
    }
    moveTop(): void {
      host.calls.push('moveTop');
    }
    setOpacity(value: number): void {
      host.calls.push(`setOpacity:${value}`);
      host.opacity.push(value);
    }
    once(event: string, listener: () => void): void {
      if (event === 'ready-to-show') host.readyHandlers.push(listener);
    }
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

  const display = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 0, width: 1440, height: 900 }
  };

  return {
    BrowserWindow: FakeBrowserWindow,
    screen: {
      getAllDisplays: () => [display],
      getDisplayNearestPoint: () => display,
      getCursorScreenPoint: () => ({ x: 710, y: 410 })
    }
  };
});

const {
  HOVER_SHOW_DELAY_MS,
  MAX_RENDERER_RELOADS,
  PANEL_INITIAL_HEIGHT,
  createHoverPanel
} = await import('../src/main/hover-panel');
const { CH } = await import('../src/main/ipc');
const { cardWidthFor } = await import('../src/core/card-layout');

/** The dog's ink rect, mid-screen so placement is never clamped. */
const DOG: Rect = { x: 700, y: 400, width: 64, height: 64 };

/** Fire the `ready-to-show` the real window would fire after its first paint. */
function ready(): void {
  for (const handler of host.readyHandlers.splice(0)) handler();
}

beforeEach(() => {
  vi.useFakeTimers();
  host.built.length = 0;
  host.calls.length = 0;
  host.bounds.length = 0;
  host.ignoreMouse.length = 0;
  host.alwaysOnTop.length = 0;
  host.workspaces.length = 0;
  host.opacity.length = 0;
  host.sent.length = 0;
  host.readyHandlers.length = 0;
  host.loaded.length = 0;
  host.navHandlers.length = 0;
  host.goneHandlers.length = 0;
  host.reloads = 0;
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
    // Re-placed *and* re-shown. The show is not a mistake: see the stranded-card
    // test below — on a card that really is up it is an invisible no-op, and it
    // is the only thing that recovers one ordered in on another Space.
    expect(host.calls.filter((c) => c === 'showInactive')).toHaveLength(2);
    expect(host.calls.indexOf('setBounds')).toBeLessThan(host.calls.indexOf('showInactive'));
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

describe('the stranded card: an enter on an “already visible” window shows it again', () => {
  it('shows again when isVisible() is true but the card is on another Space', () => {
    /*
     * The fault this exists for. After long uptime the card can be ordered in on
     * a Space the owner has left; `isVisible()` reports true for it, so the old
     * code re-placed it on every hover and never ordered it in again — a log
     * full of "panel re-placed (already visible)" and no card on screen.
     * `showInactive()` on a window macOS already calls visible is what moves it
     * to the current Space, and nothing app-side can tell the stranded reading
     * from the healthy one, so it is run for both.
     */
    const panel = createHoverPanel();
    host.lieVisible = true;

    panel.hoverEnter(DOG);
    // No waiting out the delay: the window is (or claims to be) up already.
    expect(host.calls.filter((c) => c === 'showInactive')).toHaveLength(1);
    expect(host.bounds).toHaveLength(1);

    // And again on the next hover, because the next one may be the one that
    // lands on the Space the owner is actually looking at.
    panel.hoverEnter({ ...DOG, x: DOG.x + 40 });
    expect(host.calls.filter((c) => c === 'showInactive')).toHaveLength(2);
    // Never `show()`: this window must not take focus, on any path.
    expect(host.calls).not.toContain('show');
    panel.destroy();
  });
});

describe('the collection behaviour is re-asserted on every show', () => {
  /*
   * Set once at construction, lost by a window that has been through Space and
   * display changes — which is why it is said again per show rather than only in
   * the `once('ready-to-show')` pre-show. macOS-only: `setVisibleOnAllWorkspaces`
   * does nothing on Windows, and the card already works there.
   */
  const isMac = process.platform === 'darwin';

  it('re-asserts the level and the full-screen flag with each showInactive', () => {
    const panel = createHoverPanel();
    const atBuild = host.workspaces.length;

    panel.hoverEnter(DOG);
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS);
    // One pair per show on macOS, none at all elsewhere.
    expect(host.workspaces.length - atBuild).toBe(isMac ? 1 : 0);

    if (isMac) {
      expect(host.workspaces.at(-1)).toEqual([
        true,
        // `skipTransformProcessType` is not optional here: without it Electron
        // transforms the process type on every call, which "will hide the window
        // and dock for a short time" — i.e. hide the very card being shown.
        { visibleOnFullScreen: true, skipTransformProcessType: true }
      ]);
      expect(host.alwaysOnTop.at(-1)).toEqual([true, 'screen-saver']);
      // The level goes first, so the full-screen flag is the last word: a level
      // change is the call with a history of dropping it.
      expect(host.calls.lastIndexOf('setAlwaysOnTop')).toBeLessThan(
        host.calls.lastIndexOf('setVisibleOnAllWorkspaces')
      );
      expect(host.calls.lastIndexOf('setVisibleOnAllWorkspaces')).toBeLessThan(
        host.calls.lastIndexOf('showInactive')
      );
    }

    // Again on the re-show path, which is the one the stranded card takes.
    panel.hoverEnter({ ...DOG, x: DOG.x + 40 });
    expect(host.workspaces.length - atBuild).toBe(isMac ? 2 : 0);
    expect(host.alwaysOnTop.length).toBe(isMac ? 3 : 1);
    panel.destroy();
  });

  it('says nothing per show while the cursor merely moves across the dog', () => {
    // The renderer sends `hover:enter` on every animation frame that moves the
    // ink. Neither call is documented as a no-op, so they ride on real shows.
    const panel = createHoverPanel();
    const atBuild = host.workspaces.length;

    for (const step of [83, 83]) {
      vi.advanceTimersByTime(step);
      panel.hoverEnter({ ...DOG, y: DOG.y + 1 });
    }
    expect(host.workspaces.length).toBe(atBuild);
    panel.destroy();
  });
});

describe('a dead panel renderer', () => {
  it('reloads the page rather than leaving a blank card', () => {
    /*
     * The window survives a renderer crash and nothing rebuilds it, so without
     * this the card is blank until the app is restarted — and it is only on
     * screen while the cursor rests on the dog, so it reads as "the card is
     * broken today". Nothing has to be re-pushed after the reload: `panel.ts`'s
     * boot asks for `settings:get`, whose payload carries the last snapshot.
     */
    const panel = createHoverPanel();
    expect(host.goneHandlers).toHaveLength(1);

    host.goneHandlers[0]?.(null as never, { reason: 'crashed' });
    expect(host.reloads).toBe(1);
    panel.destroy();
  });

  it('stops reloading after three tries rather than looping forever', () => {
    /*
     * The bound, and why this is the one place in the app that needs one: the
     * overlay's own `render-process-gone` handler only warns, so this is the
     * only self-retrying path there is. A renderer that dies *on load* — a
     * broken asset, a GPU fault the page trips every boot — would otherwise
     * crash-reload forever behind a window that is hidden at the time, and the
     * only symptom would be a machine quietly filling up with renderer
     * processes.
     */
    const panel = createHoverPanel();
    const gone = host.goneHandlers[0];
    expect(gone).toBeDefined();

    for (let i = 0; i < 4; i++) gone?.(null as never, { reason: 'crashed' });

    expect(host.reloads).toBe(MAX_RENDERER_RELOADS);
    expect(host.reloads).toBe(3);
    panel.destroy();
  });

  it('counts per window, so a second panel gets its own three', () => {
    // The counter is a closure inside `createHoverPanel`, not module state: a
    // panel rebuilt in a later session is a new window and a new chance.
    const first = createHoverPanel();
    for (let i = 0; i < 4; i++) host.goneHandlers[0]?.(null as never, { reason: 'crashed' });
    first.destroy();

    const second = createHoverPanel();
    host.goneHandlers[1]?.(null as never, { reason: 'crashed' });
    expect(host.reloads).toBe(MAX_RENDERER_RELOADS + 1);
    second.destroy();
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
    expect(host.bounds.at(-1)?.width).toBe(250);
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

describe('setResetStyle', () => {
  it('tells the renderer, and touches nothing main owns', () => {
    const panel = createHoverPanel();
    panel.hoverEnter(DOG);
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS);
    const before = host.bounds.length;

    panel.setResetStyle('countdown');

    // The wording is one line either way, so the card cannot change height and
    // the window is neither re-placed nor hidden.
    expect(host.bounds.length).toBe(before);
    expect(host.calls).not.toContain('hide');
    expect(host.sent).toEqual([
      { channel: CH.resetStyleSet, payload: { resetStyle: 'countdown' } }
    ]);
    expect(panel.isShowing()).toBe(true);
    panel.destroy();
  });

  it('does nothing at all when the style has not changed', () => {
    const panel = createHoverPanel();
    panel.hoverEnter(DOG);
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS);

    // `clock` is what the panel starts on, so this is the repeat click.
    panel.setResetStyle('clock');
    expect(host.sent).toEqual([]);
    panel.destroy();
  });

  it('takes effect on a card that is not up, without showing it', () => {
    const panel = createHoverPanel();
    panel.setResetStyle('countdown');
    expect(host.calls).not.toContain('showInactive');
    expect(host.sent.at(-1)?.channel).toBe(CH.resetStyleSet);
    panel.destroy();
  });
});

describe('setSessions', () => {
  const entry = (state: 'working' | 'waiting' | 'done') => ({
    source: 'claude' as const,
    key: 'abc',
    cwd: '~/code',
    pid: 4321,
    state,
    at: 1
  });

  it('pushes the list and touches nothing main owns', () => {
    const panel = createHoverPanel();
    panel.hoverEnter(DOG);
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS);
    const before = host.bounds.length;

    panel.setSessions([entry('waiting')]);

    // The block can change the card's height, but the renderer reports the
    // new one a frame later — guessing it here would put a visibly wrong
    // window on screen in the meantime. So: a push, and nothing else.
    expect(host.bounds.length).toBe(before);
    expect(host.calls).not.toContain('hide');
    expect(host.sent).toEqual([
      { channel: CH.sessionsSet, payload: { sessions: [entry('waiting')] } }
    ]);
    expect(panel.isShowing()).toBe(true);
    panel.destroy();
  });

  it('sends once per distinct list, however often it is told', () => {
    const panel = createHoverPanel();
    panel.setSessions([entry('waiting')]);
    panel.setSessions([entry('waiting')]);
    // A `waiting` heartbeat that changes nothing must not repaint the card.
    expect(host.sent).toHaveLength(1);

    panel.setSessions([entry('done')]);
    expect(host.sent).toHaveLength(2);
    panel.destroy();
  });

  it('pushes an empty list, because the block has to come off the card', () => {
    const panel = createHoverPanel();
    panel.setSessions([]);
    expect(host.sent).toEqual([{ channel: CH.sessionsSet, payload: { sessions: [] } }]);
    panel.destroy();
  });
});

describe.runIf(process.platform === 'darwin')('the macOS full-screen preparation', () => {
  it('uses a panel at the dog’s level and joins full-screen workspaces', () => {
    const panel = createHoverPanel();
    const options = host.built[0] as Record<string, unknown>;

    expect(options['type']).toBe('panel');
    expect(options['roundedCorners']).toBe(false);
    expect(host.alwaysOnTop).toEqual([[true, 'screen-saver']]);
    expect(host.workspaces).toEqual([[true, { visibleOnFullScreen: true }]]);
    panel.destroy();
  });

  it('pre-shows once, invisibly, before a full-screen Space can become frontmost', () => {
    const panel = createHoverPanel();
    ready();
    ready();

    expect(host.calls.slice(host.calls.indexOf('setOpacity:0'))).toEqual([
      'setOpacity:0',
      'showInactive',
      'hide',
      'setOpacity:1'
    ]);
    expect(panel.isShowing()).toBe(false);
    panel.destroy();
  });

  it('leaves a card that was hovered up before first paint alone', () => {
    const panel = createHoverPanel();
    panel.hoverEnter(DOG);
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS);
    ready();

    expect(host.calls).not.toContain('setOpacity:0');
    expect(panel.isShowing()).toBe(true);
    panel.destroy();
  });

  it('still shows normally after the invisible pre-show', () => {
    const panel = createHoverPanel();
    ready();
    panel.hoverEnter(DOG);
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS);

    expect(host.calls.filter((call) => call === 'showInactive')).toHaveLength(2);
    expect(panel.isShowing()).toBe(true);
    panel.destroy();
  });
});

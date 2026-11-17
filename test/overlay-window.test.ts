/**
 * The overlay window's presence gate, against a mocked `BrowserWindow`.
 *
 * The rest of `overlay-window.ts` is arithmetic that is already pinned
 * elsewhere (`geometry.test.ts` for the metrics, `store.test.ts` for the
 * clamping). What is only testable here is the pair of flags behind
 * `setVisible`, and both halves of it have a failure mode the owner would see
 * and could not explain:
 *
 *  - **A hidden dog must not flash at launch.** The coordinator's first batch
 *    carries `visible:false` when the hide-when-idle mode is on, and that
 *    arrives *before* `ready-to-show`. If the event handler showed the window
 *    unconditionally and something hid it a moment later, the owner would see
 *    the dog appear and vanish on every login — which reads as a crash, not as
 *    a setting.
 *  - **The window must never take focus.** `show()` on a `focusable: false`
 *    window still raises it and, on macOS, activates a dockless app: the caret
 *    would jump out of whatever the owner is typing into, every time the dog
 *    came back for a bark. So it is `showInactive()`, here and in
 *    `ready-to-show`, and `show` is recorded by the fake purely so a test can
 *    assert it is never reached.
 *
 * `electron` is mocked the way `hover-panel.test.ts` mocks it, so this runs
 * under vitest's node environment with no app and no real window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rect } from '../src/core/geometry';
import type { SizeBlank } from '../src/core/size-change';
import type { WalderSettings, WalderStore } from '../src/main/store';

const host = vi.hoisted(() => ({
  /** Constructor options of every window built. */
  built: [] as Record<string, unknown>[],
  /** Every window operation, in order. */
  calls: [] as string[],
  bounds: [] as Rect[],
  /** `ready-to-show` listeners, so a test can decide when the page is ready. */
  readyHandlers: [] as (() => void)[],
  /**
   * `setBoundsBefore` is how many `setBounds` calls had happened when the
   * message went out, so a test can tell "sent before the resize" from "after".
   */
  sent: [] as { channel: string; payload: unknown; setBoundsBefore: number }[],
  /** What `screen.getCursorScreenPoint()` answers. */
  cursor: { x: 0, y: 0 },
  /**
   * `screen.on` listeners, so a test can raise `display-metrics-changed` the
   * way a scale change in Settings ▸ Display does.
   */
  screenListeners: [] as { event: string; listener: () => void }[],
  /** `render-process-gone` listeners, so a test can kill the renderer. */
  goneHandlers: [] as ((event: unknown, details: { reason: string }) => void)[],
  /** How many times the page was reloaded. */
  reloads: 0,
  /** Every `setIgnoreMouseEvents` argument, in order. */
  ignores: [] as boolean[],
  /** `did-finish-load` listeners, so a test can finish a (re)load. */
  loadHandlers: [] as (() => void)[],
  /** The window's `closed` listeners, so a test can close it. */
  closedHandlers: [] as (() => void)[],
  /** The window's `close` listeners: what `app.quit` raises before `closed`. */
  closeHandlers: [] as (() => void)[],
  /**
   * Handlers registered on the window's own `webContents.ipc`, so a test can
   * deliver a renderer's `size:report` the way Electron would.
   */
  ipcHandlers: [] as { channel: string; listener: (event: unknown, raw: unknown) => unknown }[],
  /** How many `setBounds` calls had happened at each `reload()`. */
  reloadedAfter: [] as number[],
  /**
   * What the window is actually given for a `setBounds`, when it is not what
   * was asked: Windows rounds a DIP rect to whole physical pixels at a
   * fractional scale factor. `null` grants exactly what was asked.
   */
  grant: null as ((asked: Rect) => Rect) | null,
  /** What `isDestroyed()` answers: set by a test that destroys the window. */
  destroyed: false
}));

vi.mock('electron-store', () => ({ default: class {} }));

vi.mock('electron', () => {
  class FakeWebContents {
    /** `webContents.ipc`: the per-window handler table (`CH.sizeReport` lives there). */
    readonly ipc = {
      handle: (channel: string, listener: (event: unknown, raw: unknown) => unknown): void => {
        host.ipcHandlers.push({ channel, listener });
      }
    };
    setWindowOpenHandler(): void {}
    on(event: string, listener: (event: unknown, details: { reason: string }) => void): void {
      if (event === 'render-process-gone') host.goneHandlers.push(listener);
      if (event === 'did-finish-load') host.loadHandlers.push(listener as unknown as () => void);
    }
    reload(): void {
      host.reloads++;
      host.reloadedAfter.push(host.bounds.length);
    }
    send(channel: string, payload: unknown): void {
      host.sent.push({ channel, payload, setBoundsBefore: host.bounds.length });
    }
    isDestroyed(): boolean {
      return host.destroyed;
    }
  }

  class FakeBrowserWindow {
    readonly webContents = new FakeWebContents();
    private visible = false;
    private resizable: boolean;
    private bounds: Rect;

    constructor(options: Record<string, unknown>) {
      host.built.push(options);
      this.resizable = options['resizable'] !== false;
      this.bounds = {
        x: Number(options['x'] ?? 0),
        y: Number(options['y'] ?? 0),
        width: Number(options['width'] ?? 100),
        height: Number(options['height'] ?? 100)
      };
    }

    once(event: string, listener: () => void): void {
      if (event === 'ready-to-show') host.readyHandlers.push(listener);
      if (event === 'closed') host.closedHandlers.push(listener);
    }
    on(event: string, listener: () => void): void {
      if (event === 'closed') host.closedHandlers.push(listener);
      if (event === 'close') host.closeHandlers.push(listener);
    }
    /**
     * Recorded, never expected — like `show` below. The first fix for the
     * Windows size-change frame hid the window with it and was measured not
     * to work (`core/size-change`); it is here only so the tests can assert
     * that nothing reaches it.
     */
    setOpacity(value: number): void {
      host.calls.push(`setOpacity:${value}`);
    }
    setAlwaysOnTop(): void {}
    moveTop(): void {
      host.calls.push('moveTop');
    }
    setVisibleOnAllWorkspaces(): void {}
    setSkipTaskbar(): void {}
    setMenuBarVisibility(): void {}
    setIgnoreMouseEvents(next: boolean): void {
      host.ignores.push(next);
    }
    loadURL(): Promise<void> {
      return Promise.resolve();
    }
    isResizable(): boolean {
      return this.resizable;
    }
    setResizable(next: boolean): void {
      this.resizable = next;
    }
    // Both throw on a destroyed window, as Electron's do: a timer or a late
    // report that forgot to check would fail loudly rather than pass quietly.
    getBounds(): Rect {
      if (host.destroyed) throw new Error('Object has been destroyed');
      return this.bounds;
    }
    setBounds(rect: Rect): void {
      if (host.destroyed) throw new Error('Object has been destroyed');
      host.calls.push('setBounds');
      host.bounds.push(rect);
      this.bounds = host.grant === null ? rect : host.grant(rect);
    }
    setPosition(x: number, y: number): void {
      host.calls.push('setPosition');
      this.bounds = { ...this.bounds, x, y };
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
    focus(): void {
      host.calls.push('focus');
    }
    hide(): void {
      host.calls.push('hide');
      this.visible = false;
    }
    isVisible(): boolean {
      return this.visible;
    }
    isDestroyed(): boolean {
      return host.destroyed;
    }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    screen: {
      on: (event: string, listener: () => void) => {
        host.screenListeners.push({ event, listener });
      },
      removeListener: () => {},
      getAllDisplays: () => [DISPLAY],
      getPrimaryDisplay: () => DISPLAY,
      getDisplayNearestPoint: () => DISPLAY,
      getDisplayMatching: () => DISPLAY,
      getCursorScreenPoint: () => host.cursor
    }
  };
});

const DISPLAY = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 875 },
  /**
   * Settable per test (reset to 1 in `beforeEach`): the renderer draws the dog
   * at a whole number of device px per sprite px, so at a fractional factor his
   * drawn ink is not his nominal one (`drawnInkInset`).
   */
  scaleFactor: 1
};

const { createOverlay, PAINT_SIGNAL_GRACE_MS } = await import('../src/main/overlay-window');
const { SIZE_BLANK_GRACE_MS, onSizeMessage, onSizePaint } = await import(
  '../src/core/size-change'
);
const { DEFAULTS } = await import('../src/main/store');
const { CH, SCALE_BY_SIZE } = await import('../src/main/ipc');
const { boxMetrics, bubbleExtraPx, drawnInkInset, inkInset, MIN_VISIBLE_PX } = await import(
  '../src/core/geometry'
);
const { MAX_RENDERER_RELOADS } = await import('../src/main/hover-panel');
const { setLogSink, setVerbose } = await import('../src/main/log');

/** A store-shaped object; only `get`/`set`/`path` are ever touched. */
function fakeStore(overrides: Partial<WalderSettings> = {}): WalderStore {
  const data: Record<string, unknown> = { ...DEFAULTS, ...overrides };
  return {
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => {
      data[key] = value;
    },
    path: '/tmp/walder-test/walder.json'
  } as unknown as WalderStore;
}

/**
 * The sheet's boxes, at the v3 dimensions, plus a `lie` box. `lie` is the same
 * width as `stand` but has no bubble reserve, so it is shorter by exactly that —
 * the case that moved him down on relaunch after a quit at a high weekly figure.
 */
const BOXES = {
  stand: { width: 72, height: 72 },
  sleep: { width: 61, height: 58 },
  lie: { width: 72, height: 72 }
} as const;

function build(): ReturnType<typeof createOverlay> {
  return createOverlay(fakeStore(), 2, BOXES, NO_GAP);
}

/**
 * The platform the tests that are not about the Windows Size-change wait run
 * on. Pinned, so they do the same on every host: on win32 a scale change of a
 * window that is ready and shown is deferred behind the renderer's answer or a
 * real 200 ms timer, and `applySize` would return with nothing resized.
 */
const NO_GAP = { platform: 'darwin' } as const;

/** Fire the `ready-to-show` the real window would fire after its first paint. */
function ready(): void {
  for (const handler of host.readyHandlers) handler();
  host.readyHandlers.length = 0;
}

beforeEach(() => {
  host.built.length = 0;
  host.calls.length = 0;
  host.bounds.length = 0;
  host.readyHandlers.length = 0;
  host.sent.length = 0;
  host.screenListeners.length = 0;
  host.goneHandlers.length = 0;
  host.reloads = 0;
  host.ignores.length = 0;
  host.loadHandlers.length = 0;
  host.closedHandlers.length = 0;
  host.closeHandlers.length = 0;
  host.ipcHandlers.length = 0;
  host.reloadedAfter.length = 0;
  host.grant = null;
  host.destroyed = false;
  DISPLAY.scaleFactor = 1;
});

describe('the window it builds', () => {
  it('starts invisible and shows itself, inactive, once the page is ready', () => {
    const overlay = build();
    expect((host.built[0] as Record<string, unknown>)['show']).toBe(false);
    expect((host.built[0] as Record<string, unknown>)['focusable']).toBe(false);
    // Nothing yet: `show: false` plus `ready-to-show` is what stops an empty
    // transparent rectangle appearing before the first frame is drawn.
    expect(host.calls).not.toContain('showInactive');
    expect(overlay.isShown()).toBe(true);

    ready();
    expect(host.calls.filter((call) => call === 'showInactive')).toHaveLength(1);
    expect(host.calls).not.toContain('show');
    expect(host.calls).not.toContain('focus');
  });
});

/**
 * What the launch's hook offer waits for. `ready-to-show` is the page's first
 * paint — an empty canvas, hundreds of milliseconds before the sheet arrives —
 * so for a dog on screen it must not settle there (0.2.8 QA: the alert was up
 * 0.14 s before the dog).
 */
describe('painted', () => {
  /** Has `painted` settled, once every queued microtask has run? */
  async function settled(overlay: ReturnType<typeof createOverlay>): Promise<boolean> {
    let done = false;
    void overlay.painted.then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return done;
  }

  it('waits past ready-to-show for the renderer to report its first frame', async () => {
    const overlay = build();
    ready();
    expect(await settled(overlay)).toBe(false);

    overlay.notePainted();
    expect(await settled(overlay)).toBe(true);
  });

  it('settles anyway once the grace period runs out with no signal', async () => {
    vi.useFakeTimers();
    try {
      const overlay = build();
      ready();
      let done = false;
      void overlay.painted.then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(PAINT_SIGNAL_GRACE_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles at ready-to-show for a dog who is hidden by then', async () => {
    const overlay = build();
    overlay.setVisible(false);
    ready();
    expect(await settled(overlay)).toBe(true);
  });
});

describe('setVisible', () => {
  it('suppresses the initial show when it is called before ready-to-show', () => {
    // The real sequence: `createBehaviour` applies the stored hide-when-idle
    // preference during `start()`, which is well before the page has painted.
    const overlay = build();
    overlay.setVisible(false);
    expect(overlay.isShown()).toBe(false);

    ready();
    // Never shown at all — not shown and then hidden, which would be a visible
    // flash on every launch.
    expect(host.calls).not.toContain('showInactive');
    expect(host.calls).not.toContain('hide');
  });

  it('shows him again after that, with showInactive and never show', () => {
    const overlay = build();
    overlay.setVisible(false);
    ready();

    overlay.setVisible(true);
    expect(overlay.isShown()).toBe(true);
    expect(host.calls.filter((call) => call === 'showInactive')).toHaveLength(1);
    expect(host.calls).not.toContain('show');
    expect(host.calls).not.toContain('focus');
  });

  it('is idempotent: the same value twice is one window operation', () => {
    const overlay = build();
    ready();
    host.calls.length = 0;

    overlay.setVisible(false);
    overlay.setVisible(false);
    expect(host.calls).toEqual(['hide']);

    overlay.setVisible(true);
    overlay.setVisible(true);
    expect(host.calls).toEqual(['hide', 'showInactive']);
  });

  it('does not re-show a window that is already meant to be shown', () => {
    // The guard that matters for `second-instance`: `isShown()` is the *intent*,
    // and calling `setVisible(true)` on a visible window must not raise it (and
    // so must not disturb the window the owner is typing into).
    const overlay = build();
    ready();
    host.calls.length = 0;
    overlay.setVisible(true);
    expect(host.calls).toEqual([]);
  });

  it('remembers a show requested before ready-to-show', () => {
    const overlay = build();
    overlay.setVisible(false);
    overlay.setVisible(true);
    expect(host.calls).toEqual([]);
    ready();
    expect(host.calls).toEqual(['showInactive']);
  });

  /**
   * 2026-11-14, audit X2: the hover card's show orders it above the dog, and
   * `orderAboveCard` puts him back. Never on a hidden dog: on macOS an
   * order-above brings an ordered-out window back on screen.
   */
  it('orders him above the card only while he is on screen', () => {
    const overlay = build();
    overlay.orderAboveCard();
    // Not shown yet (before ready-to-show): nothing.
    expect(host.calls).not.toContain('moveTop');

    ready();
    overlay.orderAboveCard();
    expect(host.calls.filter((call) => call === 'moveTop')).toHaveLength(1);

    overlay.setVisible(false);
    overlay.orderAboveCard();
    expect(host.calls.filter((call) => call === 'moveTop')).toHaveLength(1);
    expect(host.calls).not.toContain('show');
    expect(host.calls).not.toContain('focus');
  });

  it('leaves the geometry alone: hiding is not a resize', () => {
    const overlay = build();
    ready();
    const before = host.bounds.length;
    overlay.setVisible(false);
    overlay.setVisible(true);
    // No `setBounds`, no `setPosition`: the dog must come back exactly where he
    // was, and a hidden window is still a positioned one.
    expect(host.bounds).toHaveLength(before);
    expect(host.calls).not.toContain('setPosition');
  });
});

/**
 * Presence has to be readable as *state*, not only as the `visible` event that
 * changed it.
 *
 * That event is an edge, and the first one of a run is emitted inside
 * `createBehaviour` — before the overlay page has loaded, so it is sent to a
 * renderer that does not exist yet and is simply lost. The renderer then
 * animates a hidden dog at full cadence (`backgroundThrottling: false`) with
 * nothing ever coming to tell it otherwise. `settings:get` and `mode:set` both
 * carry `currentMode()`, so this is where that gap is closed.
 */
describe('currentMode', () => {
  it('reports hidden after the initial hide, and through ready-to-show', () => {
    const overlay = build();
    expect(overlay.currentMode().hidden).toBe(false);

    // The real launch sequence: the stored hide-when-idle preference is applied
    // during `start()`, well before the page has painted.
    overlay.setVisible(false);
    expect(overlay.currentMode().hidden).toBe(true);
    ready();
    // Still hidden once the page is ready — which is exactly the moment a
    // booting renderer asks for this.
    expect(overlay.currentMode().hidden).toBe(true);

    overlay.setVisible(true);
    expect(overlay.currentMode().hidden).toBe(false);
  });

  it('puts presence on the mode:set that a box change sends', () => {
    const overlay = build();
    ready();
    overlay.setVisible(false);
    host.sent.length = 0;

    overlay.applyBox('sleep');
    const payload = host.sent.at(-1)?.payload as { box?: string; hidden?: boolean };
    expect(payload.box).toBe('sleep');
    expect(payload.hidden).toBe(true);
  });
});

/**
 * Still mode crosses as state on the same payload, for the same reason
 * presence does — it is applied from the store during startup, before the
 * overlay page exists, so an *event* would be sent to nobody.
 *
 * The renderer is what actually stops drawing motion (it also ORs in the OS's
 * `prefers-reduced-motion`, which main cannot see); all that is testable here
 * is that the flag is sent, and keeps being sent.
 */
describe('setStill', () => {
  it('sends a mode:set carrying the flag', () => {
    const overlay = build();
    ready();
    host.sent.length = 0;

    overlay.setStill(true);
    const last = host.sent.at(-1);
    expect(last?.channel).toBe('walder:mode:set');
    expect((last?.payload as { still?: boolean }).still).toBe(true);
  });

  it('keeps the flag on every later mode payload', () => {
    // The failure this pins: a box change resends `currentMode()`, and a still
    // flag that lived only in the message that set it would be silently
    // cancelled by the next unrelated resize.
    const overlay = build();
    ready();
    overlay.setStill(true);
    host.sent.length = 0;

    overlay.applyBox('sleep');
    const payload = host.sent.at(-1)?.payload as { box?: string; still?: boolean };
    expect(payload.box).toBe('sleep');
    expect(payload.still).toBe(true);
    expect(overlay.currentMode().still).toBe(true);
  });

  it('says nothing when the flag has not moved', () => {
    // The menu rebuilds itself on every click; a repeated `false` must not be a
    // repeated message to the renderer.
    const overlay = build();
    ready();
    host.sent.length = 0;

    overlay.setStill(false);
    expect(host.sent).toEqual([]);
  });
});

/**
 * A saved position means one thing: where the *standing* window sat. Startup
 * reads it back that way, so a window saved from any other box has to be
 * normalised first — otherwise a quit while asleep (any fullscreen app) or
 * lying (weekly at 90 % or more) relaunched him lower by the difference in
 * window height, and the 24 px visibility clamp let it through. The fake
 * store is shared between the two builds, exactly like a quit and a relaunch.
 */
describe('a position saved from another box', () => {
  for (const other of ['sleep', 'lie'] as const) {
    it(`relaunches at the same height after a quit in the ${other} box`, () => {
      const store = fakeStore();
      const first = createOverlay(store, 2, BOXES, NO_GAP);
      const standY = first.win.getBounds().y;

      first.applyBox(other);
      createOverlay(store, 2, BOXES, NO_GAP);
      const relaunched = host.built.at(-1) as Record<string, unknown>;
      expect(relaunched['y']).toBe(standY);
    });
  }
});

/**
 * A size change while a bubble is up must not move the dog.
 *
 * The bubble widens the window symmetrically by `bubbleExtra` a side, and that
 * widening is a different width at every scale. `resize` used to keep the
 * window's left edge, which with a bubble up is the dog's resting left edge
 * minus the *old* widening; the save then added back the *new* one, so the
 * stored x and the dog drifted by the difference on every Size click mid-bark
 * (0.2.8 QA: 1324 → 1319 → 1335 → 1365). The resting left edge is the anchor.
 */
describe('a size change with a bubble up', () => {
  it('keeps the resting x, in the store and on screen, at every scale', () => {
    // Mid-screen, so no clamp at a work-area edge can stand in for the fix.
    const restX = 600;
    const restY = 400;
    const key = `${DISPLAY.id}:${DISPLAY.bounds.width}x${DISPLAY.bounds.height}`;
    const store = fakeStore({ positions: { [key]: { x: restX, y: restY } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    // Wide enough to widen the window at all three scales, by a different
    // amount at each (76 / 51 / 25 px a side on the 72 px stand box).
    const columns = 30;
    overlay.applyBubble(columns);

    const savedX = (): number | undefined =>
      (store.get('positions') as Record<string, { x: number }>)[key]?.x;
    for (const size of ['medium', 'large', 'small'] as const) {
      const scale = SCALE_BY_SIZE[size];
      overlay.applySize(scale);
      const extra = bubbleExtraPx(columns, scale, BOXES.stand);
      expect(extra, size).toBeGreaterThan(0);
      expect(savedX(), size).toBe(restX);
      expect(overlay.win.getBounds().x, size).toBe(restX - extra);
    }
  });
});

/**
 * 0.2.8 QA, row 5.9a2, through the real `resize`: the dog at the Small default
 * spot, the intro bubble up, then Size ▸ Large. Since the Windows QA (row 3.3)
 * a size change keeps him wholly on screen, and since 2026-11-14 (audit X1) a
 * dog on the right half grows leftwards from his resting window's right edge,
 * so the Large dog lands on the Large home spot. The widening must be measured
 * from where he *landed*: the window is still widened symmetrically about him,
 * so its right half hangs off, and the bubble has to be laid out in what is on
 * screen (`bubbleExtraPx` in `core/geometry.ts` has the numbers).
 */
describe('a size change with a bubble up at the right edge', () => {
  it('lands him at home and widens until the on-screen part holds the bubble', () => {
    const area = DISPLAY.workArea;
    const largeMetrics = boxMetrics(SCALE_BY_SIZE.large, BOXES.stand, true, 0);
    const large = largeMetrics.width;
    // `defaultPosition`: the Small window, 16 px in from the right.
    const restX = area.x + area.width - boxMetrics(1, BOXES.stand, true, 0).width - 16;
    const key = `${DISPLAY.id}:${DISPLAY.bounds.width}x${DISPLAY.bounds.height}`;
    const store = fakeStore({ positions: { [key]: { x: restX, y: 600 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    // `Hello. Click the bone in your menu bar.` on one line.
    const columns = 39;
    overlay.applyBubble(columns);
    overlay.applySize(SCALE_BY_SIZE.large);

    const bounds = overlay.win.getBounds();
    const onScreen = Math.min(bounds.x + bounds.width, area.x + area.width) - bounds.x;
    // As wide as the window the bubble would have had fully on screen, to
    // within the pixel the symmetric widening rounds up by…
    const whole = large + 2 * bubbleExtraPx(columns, SCALE_BY_SIZE.large, BOXES.stand);
    expect(onScreen).toBeGreaterThanOrEqual(whole - 1);
    // …the resting window is 16 px in from the right edge, as Reset puts it…
    const settled = area.x + area.width - large - 16;
    expect(inkInset(largeMetrics).right).toBeGreaterThan(0);
    const saved = (store.get('positions') as Record<string, { x: number }>)[key]?.x;
    expect(saved).toBe(settled);
    // …and the window is widened symmetrically about that resting spot.
    expect(bounds.x + (bounds.width - large) / 2).toBe(settled);
  });

  it('still widens on screen for a Large dog the owner parked off the edge', () => {
    // The drag rule lets him hang off (80 px of dog on screen here); a bubble
    // must not move him, and must still get the room a visible window gives.
    const area = DISPLAY.workArea;
    const large = boxMetrics(SCALE_BY_SIZE.large, BOXES.stand, true, 0).width;
    const restX = area.x + area.width - boxMetrics(1, BOXES.stand, true, 0).width - 16;
    const key = `${DISPLAY.id}:${DISPLAY.bounds.width}x${DISPLAY.bounds.height}`;
    const store = fakeStore({ positions: { [key]: { x: restX, y: 400 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.large, BOXES, NO_GAP);
    expect(overlay.win.getBounds().x).toBe(restX);
    const columns = 39;
    overlay.applyBubble(columns);

    const bounds = overlay.win.getBounds();
    const onScreen = Math.min(bounds.x + bounds.width, area.x + area.width) - bounds.x;
    const whole = large + 2 * bubbleExtraPx(columns, SCALE_BY_SIZE.large, BOXES.stand);
    expect(onScreen).toBeGreaterThanOrEqual(whole - 1);
    expect(bounds.x + (bounds.width - large) / 2).toBe(restX);
  });
});

/**
 * Windows QA, row 3.3: Size ▸ Large at the default bottom-right spot. The
 * bottom-left anchor ran the window to x 2102 on a 1920 px screen and left only
 * his head on it; macOS hid this because NSWindow constrains frames itself. A
 * size or box change must end with all of him on the work area.
 */
describe('a size or box change at the screen corner', () => {
  const area = DISPLAY.workArea;
  const key = `${DISPLAY.id}:${DISPLAY.bounds.width}x${DISPLAY.bounds.height}`;
  const savedAt = (store: WalderStore): { x: number; y: number } | undefined =>
    (store.get('positions') as Record<string, { x: number; y: number }>)[key];
  /** The window's ink rect under `metrics`, from its live bounds. */
  const inkOf = (bounds: Rect, metrics: ReturnType<typeof boxMetrics>): Rect => {
    const inset = inkInset(metrics);
    return {
      x: bounds.x + inset.left,
      y: bounds.y + inset.top,
      width: bounds.width - inset.left - inset.right,
      height: bounds.height - inset.top - inset.bottom
    };
  };
  const whollyInside = (ink: Rect): boolean =>
    ink.x >= area.x &&
    ink.y >= area.y &&
    ink.x + ink.width <= area.x + area.width &&
    ink.y + ink.height <= area.y + area.height;

  it('lands a Small dog grown to Large with all of his ink on screen, and saves that', () => {
    // No saved position: the first-run default spot, 16 px in from the corner.
    const store = fakeStore();
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    const small = overlay.win.getBounds();
    expect(small.x + small.width).toBe(area.x + area.width - 16);

    overlay.applySize(SCALE_BY_SIZE.large);
    const large = boxMetrics(SCALE_BY_SIZE.large, BOXES.stand, true, 0);
    const bounds = overlay.win.getBounds();
    const ink = inkOf(bounds, large);
    expect(whollyInside(ink)).toBe(true);
    // Grown leftwards from the window's right edge (2026-11-14, audit X1):
    // the Large home spot, the one Reset gives at Large.
    expect(bounds.x + bounds.width).toBe(area.x + area.width - 16);
    // He still stands on the same bottom edge — there was room for that.
    expect(bounds.y + bounds.height).toBe(small.y + small.height);
    expect(savedAt(store)).toEqual({ x: bounds.x, y: bounds.y });
  });

  /**
   * 2026-11-14, audit X1 (the owner): growth kept the left edge and the clamp
   * pulled a Large dog back on screen, so the shrink came back 136 px left of
   * home. Every round trip between sizes from the home corner now comes home,
   * with every size wholly on screen on the way, and a relaunch in between
   * changes nothing.
   */
  it('comes back to the home spot after every round trip between sizes, across a relaunch', () => {
    const sizes = ['small', 'medium', 'large'] as const;
    const homeFor = (scale: number): { x: number; y: number } => {
      const m = boxMetrics(scale, BOXES.stand, true, 0);
      return {
        x: area.x + area.width - m.width - 16,
        y: area.y + area.height - m.height - 16
      };
    };
    for (const from of sizes) {
      for (const via of sizes) {
        if (via === from) continue;
        const label = `${from} -> ${via} -> ${from}`;
        const store = fakeStore();
        const overlay = createOverlay(store, SCALE_BY_SIZE[from], BOXES, NO_GAP);
        const start = overlay.win.getBounds();
        expect({ x: start.x, y: start.y }, label).toEqual(homeFor(SCALE_BY_SIZE[from]));

        overlay.applySize(SCALE_BY_SIZE[via]);
        const mid = overlay.win.getBounds();
        const viaMetrics = boxMetrics(SCALE_BY_SIZE[via], BOXES.stand, true, 0);
        expect(whollyInside(inkOf(mid, viaMetrics)), label).toBe(true);
        expect({ x: mid.x, y: mid.y }, label).toEqual(homeFor(SCALE_BY_SIZE[via]));

        overlay.applySize(SCALE_BY_SIZE[from]);
        expect(overlay.win.getBounds(), label).toEqual(start);
        expect(savedAt(store), label).toEqual({ x: start.x, y: start.y });

        // Quit at `via`, relaunch there, and shrink or grow back.
        const relaunchStore = fakeStore();
        createOverlay(relaunchStore, SCALE_BY_SIZE[from], BOXES, NO_GAP).applySize(SCALE_BY_SIZE[via]);
        const again = createOverlay(relaunchStore, SCALE_BY_SIZE[via], BOXES, NO_GAP);
        expect({ x: again.win.getBounds().x, y: again.win.getBounds().y }, label).toEqual(
          homeFor(SCALE_BY_SIZE[via])
        );
        again.applySize(SCALE_BY_SIZE[from]);
        expect(again.win.getBounds(), label).toEqual(start);
      }
    }
  });

  it('keeps the right edge for a dog dropped on the right half, and a Reset stays home', () => {
    // Mid-screen on the right half: the resting window's right edge is the
    // fixed point, so a round trip comes back to the drop.
    const store = fakeStore({ positions: { [key]: { x: 1000, y: 500 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    const small = overlay.win.getBounds();
    overlay.applySize(SCALE_BY_SIZE.large);
    const large = overlay.win.getBounds();
    expect(large.x + large.width).toBe(small.x + small.width);
    overlay.applySize(SCALE_BY_SIZE.small);
    expect(overlay.win.getBounds()).toEqual(small);

    // A drop decides the side afresh: dragged to the left half, he keeps his
    // left edge from then on.
    overlay.dragStart();
    overlay.dragMove(-800, 0);
    overlay.dragEnd();
    const dropped = overlay.win.getBounds();
    overlay.applySize(SCALE_BY_SIZE.large);
    expect(overlay.win.getBounds().x).toBe(dropped.x);

    // Reset at Large, then Small: the Small home spot.
    overlay.resetPosition();
    overlay.applySize(SCALE_BY_SIZE.small);
    const home = overlay.win.getBounds();
    expect(home.x + home.width).toBe(area.x + area.width - 16);
    expect(savedAt(store)).toEqual({ x: home.x, y: home.y });
  });

  it('keeps his side through a display event that does not move him', () => {
    // Small on the right half, grown to Large across the middle: a
    // `display-metrics-changed` that leaves him where he is (the Dock resizing
    // the work area) must not re-decide the side, or Small lands 176 px left.
    const store = fakeStore({ positions: { [key]: { x: 690, y: 500 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    const small = overlay.win.getBounds();
    overlay.applySize(SCALE_BY_SIZE.large);
    for (const { event, listener } of host.screenListeners) {
      if (event === 'display-metrics-changed') listener();
    }
    overlay.applySize(SCALE_BY_SIZE.small);
    expect(overlay.win.getBounds()).toEqual(small);
  });

  it('keeps the bottom-left corner put for a resize mid-screen', () => {
    const store = fakeStore({ positions: { [key]: { x: 300, y: 500 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    const small = overlay.win.getBounds();
    for (const size of ['medium', 'large', 'small'] as const) {
      overlay.applySize(SCALE_BY_SIZE[size]);
      const bounds = overlay.win.getBounds();
      expect(bounds.x, size).toBe(small.x);
      expect(bounds.y + bounds.height, size).toBe(small.y + small.height);
    }
  });

  it('keeps the sleep box inside at the corner, and the wake-up too', () => {
    const store = fakeStore();
    const overlay = createOverlay(store, SCALE_BY_SIZE.large, BOXES, NO_GAP);
    overlay.applyBox('sleep');
    const sleep = boxMetrics(SCALE_BY_SIZE.large, BOXES.sleep, false, 0);
    expect(whollyInside(inkOf(overlay.win.getBounds(), sleep))).toBe(true);

    overlay.applyBox('stand');
    const stand = boxMetrics(SCALE_BY_SIZE.large, BOXES.stand, true, 0);
    expect(whollyInside(inkOf(overlay.win.getBounds(), stand))).toBe(true);
  });

  it('leaves a dog the owner parked half off an edge where he was on a box change', () => {
    // 40 px of the Small dog on screen at the left edge: reachable, so the
    // drag rule keeps it, and a curl-up must not hop him onto the screen.
    const small = boxMetrics(SCALE_BY_SIZE.small, BOXES.stand, true, 0);
    const parkedX = area.x - inkInset(small).left - (BOXES.stand.width - 40);
    const store = fakeStore({ positions: { [key]: { x: parkedX, y: 500 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    expect(overlay.win.getBounds().x).toBe(parkedX);

    overlay.applyBox('sleep');
    overlay.applyBox('stand');
    expect(overlay.win.getBounds().x).toBe(parkedX);
    expect(savedAt(store)).toEqual({ x: parkedX, y: 500 });
  });
});

/**
 * QA row 1.8, the follow-up (the owner at 125 %): Size ▸ Medium at the default
 * corner left about 20 physical px of his rear off the right edge. The renderer
 * draws him at 3 device px per sprite px there — 2.4 CSS, 172.8 of the 176 px
 * window — but every clamp in main measured his nominal ink (8 * scale of
 * transparent padding a side), so the nominal box was settled flush with the
 * edge and the 14.4 px he is drawn wider a side hung off it. The clamps now
 * measure the drawn ink (`drawnInkInset`), on the display's scale factor.
 */
describe('a size change at the corner at a fractional scale factor', () => {
  const area = DISPLAY.workArea;
  const right = area.x + area.width;
  const key = `${DISPLAY.id}:${DISPLAY.bounds.width}x${DISPLAY.bounds.height}`;
  const savedAt = (store: WalderStore): { x: number; y: number } | undefined =>
    (store.get('positions') as Record<string, { x: number; y: number }>)[key];
  const medium = boxMetrics(SCALE_BY_SIZE.medium, BOXES.stand, true, 0);
  const drawnMedium = (dpr: number): ReturnType<typeof drawnInkInset> =>
    drawnInkInset({
      metrics: medium,
      scale: SCALE_BY_SIZE.medium,
      box: BOXES.stand,
      standBox: BOXES.stand,
      dpr
    });
  /** The window's drawn ink rect at Medium on a display at `dpr`. */
  const drawnInkOf = (bounds: Rect, dpr: number): Rect => {
    const inset = drawnMedium(dpr);
    return {
      x: bounds.x + inset.left,
      y: bounds.y + inset.top,
      width: bounds.width - inset.left - inset.right,
      height: bounds.height - inset.top - inset.bottom
    };
  };
  const whollyInside = (ink: Rect): boolean =>
    ink.x >= area.x &&
    ink.y >= area.y &&
    ink.x + ink.width <= area.x + area.width &&
    ink.y + ink.height <= area.y + area.height;
  /** Raise `display-metrics-changed`, as a scale change in Settings does. */
  const metricsChanged = (): void => {
    for (const { event, listener } of host.screenListeners) {
      if (event === 'display-metrics-changed') listener();
    }
  };

  it('ends Small -> Medium at 125 % with the drawn ink wholly on screen, and restores there', () => {
    DISPLAY.scaleFactor = 1.25;
    // A Small dog parked with his drawn ink flush with the right edge: growing
    // from his window's right edge (2026-11-14, audit X1) would put the
    // Medium dog's wider drawn ink past it, so the clamp has to measure it.
    const smallMetrics = boxMetrics(SCALE_BY_SIZE.small, BOXES.stand, true, 0);
    const smallDrawn = drawnInkInset({
      metrics: smallMetrics,
      scale: SCALE_BY_SIZE.small,
      box: BOXES.stand,
      standBox: BOXES.stand,
      dpr: 1.25
    });
    const store = fakeStore({
      positions: { [key]: { x: right + smallDrawn.right - smallMetrics.width, y: 600 } }
    });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    const small = overlay.win.getBounds();
    expect(small.x + small.width - smallDrawn.right).toBe(right);

    overlay.applySize(SCALE_BY_SIZE.medium);
    const bounds = overlay.win.getBounds();
    const ink = drawnInkOf(bounds, 1.25);
    expect(whollyInside(ink)).toBe(true);
    // Moved only as far as it had to: the drawn ink meets the right edge…
    expect(ink.x + ink.width).toBe(right);
    // …which is (nominal padding - drawn padding) further left than the
    // nominal clamp put the window, whose drawn ink hung 15 px off the edge.
    const nominal = inkInset(medium);
    const drawn = drawnMedium(1.25);
    expect(bounds.x + bounds.width).toBe(right + nominal.right - (nominal.right - drawn.right));
    expect(bounds.x + bounds.width).toBeLessThan(right + nominal.right);
    // Same floor as before the change.
    expect(bounds.y + bounds.height).toBe(small.y + small.height);
    // Saved, and a relaunch at Medium puts him back on exactly that spot.
    expect(savedAt(store)).toEqual({ x: bounds.x, y: bounds.y });
    createOverlay(store, SCALE_BY_SIZE.medium, BOXES, NO_GAP);
    const relaunched = host.built.at(-1) as Record<string, unknown>;
    expect({ x: relaunched['x'], y: relaunched['y'] }).toEqual({ x: bounds.x, y: bounds.y });
  });

  it('is the home corner at 100 % and at 125 %', () => {
    // From the Small home spot to the Medium one: the window's right edge is
    // the fixed point, so the drawn ink, whatever the factor, is inside.
    for (const dpr of [1, 1.25]) {
      DISPLAY.scaleFactor = dpr;
      const store = fakeStore();
      const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
      overlay.applySize(SCALE_BY_SIZE.medium);
      const bounds = overlay.win.getBounds();
      expect(bounds.x + bounds.width, `dpr ${dpr}`).toBe(right - 16);
      expect(whollyInside(drawnInkOf(bounds, dpr)), `dpr ${dpr}`).toBe(true);
      expect(savedAt(store), `dpr ${dpr}`).toEqual({ x: bounds.x, y: bounds.y });
    }
    expect(drawnMedium(1)).toEqual(inkInset(medium));
  });

  it('pulls him back on screen when the display goes from 100 % to 125 %', () => {
    // A Medium dog with his ink flush with the right edge at 100 %.
    const store = fakeStore({
      positions: { [key]: { x: right + inkInset(medium).right - medium.width, y: 600 } }
    });
    const overlay = createOverlay(store, SCALE_BY_SIZE.medium, BOXES, NO_GAP);
    // At 100 % his ink is flush with the right edge; at 125 % it is drawn
    // wider, so the same window would leave some of him off the screen.
    expect(whollyInside(drawnInkOf(overlay.win.getBounds(), 1.25))).toBe(false);

    DISPLAY.scaleFactor = 1.25;
    metricsChanged();
    const bounds = overlay.win.getBounds();
    const ink = drawnInkOf(bounds, 1.25);
    expect(whollyInside(ink)).toBe(true);
    expect(ink.x + ink.width).toBe(right);
    expect(savedAt(store)).toEqual({ x: bounds.x, y: bounds.y });
  });

  it('leaves a dog parked half off an edge where he was on a scale change', () => {
    // The drag rule he was parked under still holds: 40 px of a Small dog on
    // screen at the left edge stays reachable at 125 %, so he is not moved.
    const small = boxMetrics(SCALE_BY_SIZE.small, BOXES.stand, true, 0);
    const parkedX = area.x - inkInset(small).left - (BOXES.stand.width - 40);
    const store = fakeStore({ positions: { [key]: { x: parkedX, y: 500 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    expect(overlay.win.getBounds().x).toBe(parkedX);

    DISPLAY.scaleFactor = 1.25;
    metricsChanged();
    expect(overlay.win.getBounds().x).toBe(parkedX);
    expect(savedAt(store)).toEqual({ x: parkedX, y: 500 });
  });
});

/**
 * 0.2.8 QA, row 5.9h: the hover card up, the cursor resting on the dog, and a
 * bark that widens the window symmetrically and a pet that shrinks it back.
 * The window's corner moves under a cursor that does not, so the renderer's
 * cached point goes stale by the shift — main has to say where the cursor is
 * in the *new* window, and say it before the resize reaches the renderer.
 */
describe('a resize under a still cursor', () => {
  /** Every `hover:cursor` sent so far. */
  const cursorSends = (): typeof host.sent =>
    host.sent.filter((entry) => entry.channel === CH.hoverCursor);

  it('sends the cursor in the new window coordinates, before setBounds, both ways', () => {
    const key = `${DISPLAY.id}:${DISPLAY.bounds.width}x${DISPLAY.bounds.height}`;
    const store = fakeStore({ positions: { [key]: { x: 600, y: 400 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    const standing = overlay.win.getBounds();
    // On the dog: the middle of the sprite, which is centred in the window.
    host.cursor = {
      x: standing.x + Math.round(standing.width / 2),
      y: standing.y + standing.height - 10
    };

    for (const columns of [30, 0]) {
      host.sent.length = 0;
      const resizesBefore = host.bounds.length;
      overlay.applyBubble(columns);
      const after = overlay.win.getBounds();
      expect(cursorSends(), `columns ${columns}`).toEqual([
        {
          channel: CH.hoverCursor,
          payload: {
            x: host.cursor.x - after.x,
            y: host.cursor.y - after.y,
            width: after.width,
            height: after.height
          },
          setBoundsBefore: resizesBefore
        }
      ]);
    }
    // And back where it started, so the point is the one it was before the bark.
    expect(overlay.win.getBounds()).toEqual(standing);
  });

  it('sends nothing mid-drag, where the drag owns the pointer', () => {
    const overlay = build();
    overlay.dragStart();
    host.sent.length = 0;
    overlay.applyBubble(30);
    expect(cursorSends()).toEqual([]);
    overlay.dragEnd();
  });
});

/**
 * 2026-11-13 audit, M2: a bubble arriving or clearing mid-drag. `dragMove`
 * positions absolutely from the window the drag started with, so unless the
 * resize rebases that origin the dog jumps by the widening on the next move —
 * and a bubble clearing near the left edge let the clamp measure the wide rect
 * against the narrow ink, parking him wholly off screen and saving it.
 */
describe('a resize mid-drag', () => {
  const key = `${DISPLAY.id}:${DISPLAY.bounds.width}x${DISPLAY.bounds.height}`;

  it('keeps the dog under the cursor when a bubble arrives', () => {
    const store = fakeStore({ positions: { [key]: { x: 600, y: 400 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.medium, BOXES, NO_GAP);
    overlay.dragStart();
    overlay.dragMove(-50, 0);
    const rest = overlay.win.getBounds().x;

    overlay.applyBubble(40);
    const extra = bubbleExtraPx(40, SCALE_BY_SIZE.medium, BOXES.stand);
    expect(extra).toBeGreaterThan(0);
    // The cursor has not moved: the same delta must leave him where he is.
    overlay.dragMove(-50, 0);
    expect(overlay.win.getBounds().x + extra).toBe(rest);
    overlay.dragEnd();
  });

  it('cannot park him off the left edge when a bubble clears', () => {
    const store = fakeStore({ positions: { [key]: { x: 300, y: 400 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.medium, BOXES, NO_GAP);
    const metrics = boxMetrics(SCALE_BY_SIZE.medium, BOXES.stand, true, 0);
    overlay.applyBubble(40);
    const wide = overlay.win.getBounds();
    expect(wide.width).toBeGreaterThan(metrics.width);
    overlay.dragStart();
    overlay.applyBubble(0);
    // The delta that leaves the *wide* window's right ink edge (measured with
    // the narrow inset, as the stale clamp did) exactly MIN_VISIBLE_PX on
    // screen — so the old code accepted it and the narrow dog's ink ended up
    // twice the widening further left. Any further and the clamp's recovery
    // would mask the bug by pulling him fully back on.
    const dx =
      DISPLAY.workArea.x + MIN_VISIBLE_PX - wide.width + inkInset(metrics).right - wide.x;
    overlay.dragMove(dx, 0);
    overlay.dragEnd();

    const b = overlay.win.getBounds();
    const inkRight = b.x + b.width - inkInset(metrics).right;
    expect(b.width).toBe(metrics.width);
    expect(inkRight - DISPLAY.workArea.x).toBeGreaterThanOrEqual(MIN_VISIBLE_PX);
    const saved = (store.get('positions') as Record<string, { x: number }>)[key]?.x;
    expect(saved).toBe(b.x);
  });
});

/**
 * 2026-11-13 audit, M1: the window survives a renderer crash and nothing
 * rebuilds it, so the handler itself has to bring the dog back — and put the
 * window back in the click-through, drag-free state it was built in, since the
 * dead renderer can no longer say the cursor left.
 */
describe('a dead overlay renderer', () => {
  it('goes click-through, drops the drag and reloads the page', () => {
    const overlay = build();
    overlay.setInteractive(true);
    overlay.dragStart();
    expect(host.ignores.at(-1)).toBe(false);
    expect(host.goneHandlers).toHaveLength(1);

    host.goneHandlers[0]?.(null, { reason: 'crashed' });
    expect(host.ignores.at(-1)).toBe(true);
    expect(overlay.isDragging()).toBe(false);
    expect(host.reloads).toBe(1);
  });

  // 2026-11-13, R12: the crash ends the drag the way a release does, so the
  // spot he was dragged to is the one the next launch puts him at.
  it('saves the position a drag cut short by the crash reached', () => {
    const key = `${DISPLAY.id}:${DISPLAY.bounds.width}x${DISPLAY.bounds.height}`;
    const store = fakeStore({ positions: { [key]: { x: 600, y: 400 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.medium, BOXES, NO_GAP);
    overlay.dragStart();
    overlay.dragMove(-50, -30);
    const b = overlay.win.getBounds();
    expect(b.x).not.toBe(600);

    host.goneHandlers[0]?.(null, { reason: 'crashed' });
    expect((store.get('positions') as Record<string, unknown>)[key]).toEqual({ x: b.x, y: b.y });
  });

  // 2026-11-14 re-review: the save throws when the settings file cannot be
  // written, and that must not stop the click-through and the reload.
  it('still goes click-through and reloads when the dragged position cannot be saved', () => {
    const store = fakeStore();
    const overlay = createOverlay(store, SCALE_BY_SIZE.medium, BOXES, NO_GAP);
    overlay.setInteractive(true);
    overlay.dragStart();
    overlay.dragMove(-50, -30);
    (store as { set: unknown }).set = () => {
      throw new Error('EACCES');
    };

    host.goneHandlers[0]?.(null, { reason: 'crashed' });
    expect(overlay.isDragging()).toBe(false);
    expect(host.ignores.at(-1)).toBe(true);
    expect(host.reloads).toBe(1);
  });

  it('stays interactive under the force-interactive hatch', () => {
    const overlay = build();
    overlay.setForceInteractive(true);
    host.goneHandlers[0]?.(null, { reason: 'crashed' });
    expect(host.ignores.at(-1)).toBe(false);
  });

  it('stops reloading after three tries rather than looping forever', () => {
    build();
    for (let i = 0; i < 4; i++) host.goneHandlers[0]?.(null, { reason: 'crashed' });
    expect(host.reloads).toBe(MAX_RENDERER_RELOADS);
  });
});

/**
 * Windows QA, row 2.4: Reset position with a bubble up. The spot was computed
 * for the bubble-widened window, so when the bubble cleared and the window
 * narrowed about its centre he stood 21 px from the right edge instead of 16.
 * The home corner belongs to the resting window.
 */
describe('resetPosition', () => {
  const area = DISPLAY.workArea;
  const key = `${DISPLAY.id}:${DISPLAY.bounds.width}x${DISPLAY.bounds.height}`;
  const rest = boxMetrics(SCALE_BY_SIZE.small, BOXES.stand, true, 0);
  /** `defaultPosition` for the resting Small window: 16 px in from the corner. */
  const home = {
    x: area.x + area.width - rest.width - 16,
    y: area.y + area.height - rest.height - 16
  };

  it('stores, and lands once the bubble clears, the 16 px spot with a bubble up', () => {
    const store = fakeStore({ positions: { [key]: { x: 300, y: 300 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    overlay.applyBubble(30);
    const extra = bubbleExtraPx(30, SCALE_BY_SIZE.small, BOXES.stand);
    expect(extra).toBeGreaterThan(0);

    overlay.resetPosition();
    expect((store.get('positions') as Record<string, unknown>)[key]).toEqual(home);
    // Mid-bubble the window is widened symmetrically about the resting spot…
    expect(overlay.win.getBounds().x).toBe(home.x - extra);

    // …so when it clears he is exactly 16 px from the right and bottom edges.
    overlay.applyBubble(0);
    const bounds = overlay.win.getBounds();
    expect({ x: bounds.x, y: bounds.y }).toEqual(home);
    expect(area.x + area.width - (bounds.x + bounds.width)).toBe(16);
  });

  it('puts an asleep dog where he wakes up at the 16 px spot', () => {
    const store = fakeStore({ positions: { [key]: { x: 300, y: 300 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    overlay.applyBox('sleep');
    overlay.resetPosition();
    expect((store.get('positions') as Record<string, unknown>)[key]).toEqual(home);

    overlay.applyBox('stand');
    const bounds = overlay.win.getBounds();
    expect({ x: bounds.x, y: bounds.y }).toEqual(home);
  });
});

/**
 * The overlay's half of the hover card's leave watchdog (Windows QA, the stuck
 * card): asked by the panel every interval while the card is wanted, it tells
 * the renderer where a cursor that left without a `mouseleave` now is, on the
 * channel the renderer already re-derives hover from. The panel's half — when
 * it asks, when it stops — is in `hover-panel.test.ts`.
 */
describe('reportCursorIfOutside', () => {
  const cursorSends = (): typeof host.sent =>
    host.sent.filter((entry) => entry.channel === CH.hoverCursor);

  it('sends nothing, and keeps watching, while the cursor is inside the window', () => {
    const overlay = build();
    const b = overlay.win.getBounds();
    host.cursor = { x: b.x + Math.round(b.width / 2), y: b.y + b.height - 10 };
    host.sent.length = 0;
    expect(overlay.reportCursorIfOutside()).toBe(false);
    expect(cursorSends()).toEqual([]);
  });

  it('sends the off-window reading once the cursor is outside, and says it is done', () => {
    const overlay = build();
    const b = overlay.win.getBounds();
    // The QA move: from the dog to (700, 300), far up and to the left.
    host.cursor = { x: b.x - 200, y: b.y - 300 };
    host.sent.length = 0;
    expect(overlay.reportCursorIfOutside()).toBe(true);
    expect(cursorSends().map((entry) => entry.payload)).toEqual([
      { x: -200, y: -300, width: b.width, height: b.height }
    ]);
  });

  it('counts the first pixel past the right edge as outside', () => {
    const overlay = build();
    const b = overlay.win.getBounds();
    host.cursor = { x: b.x + b.width, y: b.y + b.height - 1 };
    expect(overlay.reportCursorIfOutside()).toBe(true);
  });

  it('stays out of a drag, which owns the pointer', () => {
    const overlay = build();
    const b = overlay.win.getBounds();
    overlay.dragStart();
    host.cursor = { x: b.x - 200, y: b.y - 300 };
    host.sent.length = 0;
    expect(overlay.reportCursorIfOutside()).toBe(false);
    expect(cursorSends()).toEqual([]);
    overlay.dragEnd();
  });
});

/**
 * Windows QA row 3.3: on a tray Size change, one or two screen frames showed
 * the previous picture, unscaled, at the top-left of the window that had
 * already been resized — the old-size dog 76–78 px too high. The first fix
 * (2026-11-15) made the window transparent across the gap and was measured on
 * 2026-11-16 not to hold: the displaced dog still showed after the window was
 * opaque again. So on Windows `applySize` no longer resizes. It asks the
 * renderer for a blank picture and resizes when that is reported, or 200 ms
 * later; the renderer draws him again by itself (`core/size-change`).
 *
 * What is pinned here is main's half: that nothing moves until the wait ends,
 * that the wait always ends, that whatever happens to the window meanwhile is
 * honoured, that the end result is exactly the window a direct resize gives —
 * the same code, run later — and that a bubble or a box change that resizes
 * the window again before he is drawn is told to the renderer too. Whether
 * the picture on screen is right is not something a fake window can say.
 *
 * The platform is passed in, so the Windows path runs on any host and the
 * "nothing at all on macOS or Linux" half is pinned on a Windows one.
 */
describe('a size change on Windows waits for a blank picture', () => {
  const SMALL = SCALE_BY_SIZE.small;
  const MEDIUM = SCALE_BY_SIZE.medium;
  const LARGE = SCALE_BY_SIZE.large;
  const key = `${DISPLAY.id}:${DISPLAY.bounds.width}x${DISPLAY.bounds.height}`;
  type Point = { x: number; y: number };
  const savedAt = (store: WalderStore): Point | undefined =>
    (store.get('positions') as Record<string, Point>)[key];
  /**
   * Mid-screen on the left half: far enough from every edge that no clamp
   * moves him at any size, and from the middle that growing does not turn him.
   */
  const MID: Point = { x: 300, y: 400 };
  const storeAt = (point: Point = MID): WalderStore =>
    fakeStore({ positions: { [key]: point } });
  const sizeOf = (rect: { width: number; height: number }): { width: number; height: number } => ({
    width: rect.width,
    height: rect.height
  });
  /** The standing window at `scale`, as `WxH`: how the log names a size. */
  const dims = (scale: number): string => {
    const m = boxMetrics(scale, BOXES.stand, true, 0);
    return `${m.width}x${m.height}`;
  };

  /** `ready-to-show` arms the paint-signal timer; this is the count with nothing waiting. */
  let idleTimers = 0;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    // Main never makes the window invisible any more, on any path.
    expect(host.calls.filter((call) => call.startsWith('setOpacity'))).toEqual([]);
    setVerbose(false);
    setLogSink(null);
    vi.useRealTimers();
  });

  /** A dog on `platform`, with the page ready and the record of calls cleared. */
  function shown(
    platform: NodeJS.Platform = 'win32',
    store: WalderStore = storeAt(),
    scale: number = SMALL
  ): ReturnType<typeof createOverlay> {
    const overlay = createOverlay(store, scale, BOXES, { platform });
    ready();
    host.calls.length = 0;
    host.sent.length = 0;
    host.bounds.length = 0;
    idleTimers = vi.getTimerCount();
    return overlay;
  }

  /** Deliver a `size:report` the way the renderer's `invoke` would arrive. */
  function report(raw: unknown): void {
    const handler = host.ipcHandlers.filter((entry) => entry.channel === CH.sizeReport).at(-1);
    if (handler === undefined) throw new Error('no size:report handler is registered');
    handler.listener({}, raw);
  }
  /** The renderer says the blank picture for change `id` is up. */
  const ack = (id: number): void => report({ phase: 'blank', id });

  const resizes = (): number => host.calls.filter((call) => call === 'setBounds').length;
  const opacityCalls = (): string[] => host.calls.filter((call) => call.startsWith('setOpacity'));
  const sizeSends = (): unknown[] =>
    host.sent.filter((entry) => entry.channel === CH.sizeChange).map((entry) => entry.payload);
  const modeSends = (): unknown[] =>
    host.sent.filter((entry) => entry.channel === CH.modeSet).map((entry) => entry.payload);
  const metricsChanged = (): void => {
    for (const { event, listener } of host.screenListeners) {
      if (event === 'display-metrics-changed') listener();
    }
  };
  /**
   * The renderer's half, run for real on what main sent: `messages` through
   * `onSizeMessage` in order, then one paint at the scale main has now, in a
   * viewport the size the window has now. Is that paint still blank? It is the
   * paint the renderer makes once everything main did has reached it, so
   * `true` means he is not drawn until the renderer's own time limit.
   */
  function blankAtTheWindowsSize(
    overlay: ReturnType<typeof createOverlay>,
    messages: unknown[] = sizeSends()
  ): boolean {
    let state: SizeBlank = null;
    for (const message of messages) state = onSizeMessage(state, message).state;
    const { width, height } = overlay.win.getBounds();
    return onSizePaint(state, overlay.currentMode().scale, width, height).blank;
  }
  /** The renderer says he is drawn again for change `id`, in the window as it is. */
  const reportShown = (
    overlay: ReturnType<typeof createOverlay>,
    id: number,
    matched = true
  ): void => report({ phase: 'shown', id, matched, ...sizeOf(overlay.win.getBounds()) });

  /** What two runs are compared by: where he is, what was saved, his scale and facing. */
  interface Snapshot {
    bounds: Rect;
    saved: Point | undefined;
    scale: number;
    facing: string;
  }
  interface Rig {
    overlay: ReturnType<typeof createOverlay>;
    store: WalderStore;
    /** Pick a size and, on Windows, answer the blank it asks for. */
    pick(scale: number): void;
    snap(): Snapshot;
  }
  /**
   * A fresh overlay on `platform` with nothing of an earlier one left in the
   * host, so a test can run the same steps on two platforms and compare: two
   * overlays must not hear each other's display events or answers.
   */
  function rig(platform: NodeJS.Platform, at: Point | null = MID, scale: number = SMALL): Rig {
    host.screenListeners.length = 0;
    host.ipcHandlers.length = 0;
    host.goneHandlers.length = 0;
    DISPLAY.scaleFactor = 1;
    const store = at === null ? fakeStore() : storeAt(at);
    const overlay = shown(platform, store, scale);
    return {
      overlay,
      store,
      pick(next: number): void {
        const asked = sizeSends().length;
        overlay.applySize(next);
        const blank = sizeSends().slice(asked).at(-1) as { phase?: string; id?: number } | undefined;
        if (blank?.phase === 'blank' && blank.id !== undefined) ack(blank.id);
      },
      snap: (): Snapshot => ({
        bounds: { ...overlay.win.getBounds() },
        saved: savedAt(store),
        scale: overlay.currentMode().scale,
        facing: overlay.currentMode().facing
      })
    };
  }

  /* ------------------------------------------------------------ the sequence */

  it('a pick resizes nothing: one blank request, and everything still the old size', () => {
    const store = storeAt();
    const overlay = shown('win32', store);
    const before = { ...overlay.win.getBounds() };

    overlay.applySize(LARGE);
    expect(resizes()).toBe(0);
    expect(host.calls).toEqual([]);
    expect(host.sent).toEqual([
      { channel: CH.sizeChange, payload: { phase: 'blank', id: 1 }, setBoundsBefore: 0 }
    ]);
    // Until the resize, main is one consistent old state: the scale a
    // `mode:set` or `settings:get` would carry, the bounds, the saved spot.
    expect(overlay.currentMode().scale).toBe(SMALL);
    expect(overlay.win.getBounds()).toEqual(before);
    expect(savedAt(store)).toEqual(MID);
    expect(vi.getTimerCount()).toBe(idleTimers + 1);
  });

  it('the answer resizes: cursor, setBounds, resized, then mode:set, in that order', () => {
    const overlay = shown();
    const before = { ...overlay.win.getBounds() };
    overlay.applySize(LARGE);
    host.sent.length = 0;

    ack(1);
    expect(resizes()).toBe(1);
    const after = overlay.win.getBounds();
    expect(sizeOf(after)).toEqual(sizeOf(boxMetrics(LARGE, BOXES.stand, true, 0)));
    expect(host.sent.map((entry) => [entry.channel, entry.setBoundsBefore])).toEqual([
      // The cursor before the window moves, as on every resize...
      [CH.hoverCursor, 0],
      // ...and both of these after it: `from` and `to` are read, not predicted,
      // and the new scale never crosses ahead of the sizes to check it against.
      [CH.sizeChange, 1],
      [CH.modeSet, 1]
    ]);
    expect(sizeSends()).toEqual([
      { phase: 'resized', id: 1, scale: LARGE, from: sizeOf(before), to: sizeOf(after) }
    ]);
    expect(modeSends()).toEqual([expect.objectContaining({ scale: LARGE, box: 'stand' })]);
    expect(overlay.currentMode().scale).toBe(LARGE);
    // The answer won: no timer is left to resize again.
    expect(vi.getTimerCount()).toBe(idleTimers);
    vi.advanceTimersByTime(1_000);
    expect(resizes()).toBe(1);
    expect(opacityCalls()).toEqual([]);
  });

  it('reports the size the window was granted, not the one that was asked for', () => {
    // At 125 % Windows rounds the rect to whole physical pixels; the renderer
    // is told what `getBounds` says afterwards.
    const overlay = shown();
    const before = sizeOf(overlay.win.getBounds());
    overlay.applySize(LARGE);
    host.grant = (asked) => ({ ...asked, height: asked.height + 1.2 });
    ack(1);
    const asked = host.bounds.at(-1) as Rect;
    expect(sizeSends().at(-1)).toEqual({
      phase: 'resized',
      id: 1,
      scale: LARGE,
      from: before,
      to: { width: asked.width, height: asked.height + 1.2 }
    });
  });

  it('with no answer: nothing at 199 ms, the same resize at 200 ms, and a late answer does nothing', () => {
    const overlay = shown();
    const before = { ...overlay.win.getBounds() };
    overlay.applySize(MEDIUM);
    host.sent.length = 0;

    vi.advanceTimersByTime(SIZE_BLANK_GRACE_MS - 1);
    expect(resizes()).toBe(0);
    expect(host.sent).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(resizes()).toBe(1);
    const after = overlay.win.getBounds();
    expect(sizeSends()).toEqual([
      { phase: 'resized', id: 1, scale: MEDIUM, from: sizeOf(before), to: sizeOf(after) }
    ]);
    expect(modeSends()).toEqual([expect.objectContaining({ scale: MEDIUM })]);

    host.sent.length = 0;
    ack(1);
    vi.advanceTimersByTime(1_000);
    expect(resizes()).toBe(1);
    expect(host.sent).toEqual([]);
    expect(opacityCalls()).toEqual([]);
  });

  it('SIZE_BLANK_GRACE_MS is the 200 ms the design reckons with', () => {
    expect(SIZE_BLANK_GRACE_MS).toBe(200);
  });

  it('only a blank report for the pending change resizes', () => {
    const overlay = shown();
    // Nothing pending at all.
    expect(() => ack(1)).not.toThrow();
    expect(resizes()).toBe(0);

    overlay.applySize(LARGE);
    host.sent.length = 0;
    const wrong: unknown[] = [
      { phase: 'blank', id: 2 },
      { phase: 'blank', id: 99 },
      { phase: 'shown', id: 1, matched: true, width: 264, height: 274 },
      { phase: 'shown', id: 1, matched: false, width: 88, height: 92 },
      // Junk: dropped by the parser.
      { phase: 'blank', id: 0 },
      { phase: 'blank', id: '1' },
      { phase: 'blank' },
      { id: 1 },
      { phase: 'shown', id: 1 },
      'blank',
      1,
      null,
      undefined,
      []
    ];
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (const raw of wrong) expect(() => report(raw), JSON.stringify(raw)).not.toThrow();
      // Each malformed one is named in the log, without its contents: the
      // log's own prefix and that one sentence, and nothing after it. The
      // payload is the renderer's, and nothing of it may be written.
      expect(warned.mock.calls).toHaveLength(10);
      for (const call of warned.mock.calls) {
        expect(call).toEqual(['[walder]', 'dropped malformed size:report payload']);
        expect(call.join(' ')).toMatch(/dropped malformed size:report payload$/);
      }
    } finally {
      warned.mockRestore();
    }
    expect(resizes()).toBe(0);
    expect(host.sent).toEqual([]);
    expect(overlay.currentMode().scale).toBe(SMALL);

    ack(1);
    expect(resizes()).toBe(1);
    // A duplicate of the answer that was acted on.
    ack(1);
    expect(resizes()).toBe(1);
  });

  /* ----------------------------------------------------------- repeated picks */

  it('a second pick in the wait: one request, the timer not restarted, one resize at the second scale', () => {
    const overlay = shown();
    overlay.applySize(MEDIUM);
    vi.advanceTimersByTime(150);
    overlay.applySize(LARGE);
    expect(sizeSends()).toEqual([{ phase: 'blank', id: 1 }]);
    expect(vi.getTimerCount()).toBe(idleTimers + 1);
    expect(overlay.currentMode().scale).toBe(SMALL);

    // 200 ms from the *first* pick: clicks cannot postpone the resize.
    vi.advanceTimersByTime(49);
    expect(resizes()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(resizes()).toBe(1);
    expect(overlay.currentMode().scale).toBe(LARGE);
    expect(sizeOf(overlay.win.getBounds())).toEqual(
      sizeOf(boxMetrics(LARGE, BOXES.stand, true, 0))
    );
    expect(sizeSends().at(-1)).toMatchObject({ phase: 'resized', id: 1, scale: LARGE });
  });

  it('Small -> Large -> Small in the wait: a resize to the size he has, from === to', () => {
    const overlay = shown();
    const before = { ...overlay.win.getBounds() };
    overlay.applySize(LARGE);
    overlay.applySize(SMALL);
    host.sent.length = 0;

    ack(1);
    // Still told, so the renderer has something to match and draws him again
    // on its next paint rather than at its time limit.
    expect(sizeSends()).toEqual([
      { phase: 'resized', id: 1, scale: SMALL, from: sizeOf(before), to: sizeOf(before) }
    ]);
    expect(modeSends()).toEqual([expect.objectContaining({ scale: SMALL })]);
    expect(overlay.win.getBounds()).toEqual(before);
    expect(vi.getTimerCount()).toBe(idleTimers);
  });

  it('a pick after the resize is a new change: id 2, and only its own answer resizes it', () => {
    const overlay = shown();
    overlay.applySize(LARGE);
    ack(1);
    host.sent.length = 0;

    overlay.applySize(MEDIUM);
    expect(sizeSends()).toEqual([{ phase: 'blank', id: 2 }]);
    expect(resizes()).toBe(1);
    // The first change's answer again, in flight when the second was made.
    ack(1);
    expect(resizes()).toBe(1);
    expect(overlay.currentMode().scale).toBe(LARGE);

    ack(2);
    expect(resizes()).toBe(2);
    expect(overlay.currentMode().scale).toBe(MEDIUM);
    expect(sizeSends().at(-1)).toMatchObject({ phase: 'resized', id: 2, scale: MEDIUM });
  });

  it('a pick after a timed-out wait is not resized by the late answer to the first', () => {
    const overlay = shown();
    overlay.applySize(LARGE);
    vi.advanceTimersByTime(SIZE_BLANK_GRACE_MS);
    expect(resizes()).toBe(1);

    overlay.applySize(MEDIUM);
    ack(1);
    expect(resizes()).toBe(1);
    ack(2);
    expect(resizes()).toBe(2);
  });

  /* -------------------------------------------- box changes and bubbles, meanwhile */

  it('a box change and a bubble in the wait resize at once at the old scale, and the flush starts from them', () => {
    const overlay = shown();
    const standing = { ...overlay.win.getBounds() };
    overlay.applySize(LARGE);
    host.sent.length = 0;

    overlay.applyBubble(30);
    overlay.applyBox('sleep');
    // Immediately, and never through the blank: they are not menu picks.
    expect(resizes()).toBe(2);
    expect(sizeSends()).toEqual([]);
    expect(modeSends()).toEqual([expect.objectContaining({ scale: SMALL, box: 'sleep' })]);
    expect(overlay.currentMode()).toMatchObject({ scale: SMALL, box: 'sleep' });
    const during = { ...overlay.win.getBounds() };
    expect(during.width).toBeGreaterThan(standing.width);
    // Still waiting: neither of them ended the wait.
    expect(vi.getTimerCount()).toBe(idleTimers + 1);

    host.sent.length = 0;
    ack(1);
    const after = { ...overlay.win.getBounds() };
    expect(resizes()).toBe(3);
    // `from` is the window as they left it, not as it was at the pick.
    expect(sizeSends()).toEqual([
      { phase: 'resized', id: 1, scale: LARGE, from: sizeOf(during), to: sizeOf(after) }
    ]);
    expect(modeSends()).toEqual([expect.objectContaining({ scale: LARGE, box: 'sleep' })]);

    // And it is the window the same three calls give with no wait at all.
    const direct = rig('darwin');
    direct.overlay.applyBubble(30);
    direct.overlay.applyBox('sleep');
    direct.overlay.applySize(LARGE);
    expect(after).toEqual(direct.overlay.win.getBounds());
  });

  it('a box change and a bubble outside a wait are synchronous and ask for no blank', () => {
    const overlay = shown();
    overlay.applyBox('sleep');
    overlay.applyBox('stand');
    overlay.applyBubble(30);
    overlay.applyBubble(0);
    expect(resizes()).toBe(4);
    expect(sizeSends()).toEqual([]);
    expect(vi.getTimerCount()).toBe(idleTimers);
  });

  /* ------------------------------------------------------------- the fast paths */

  it('before ready-to-show: resizes at once, with no request and no timer', () => {
    const overlay = createOverlay(storeAt(), SMALL, BOXES, { platform: 'win32' });
    host.sent.length = 0;
    overlay.applySize(LARGE);
    expect(resizes()).toBe(1);
    expect(sizeSends()).toEqual([]);
    expect(overlay.currentMode().scale).toBe(LARGE);
    expect(vi.getTimerCount()).toBe(0);

    // Once the page is ready, the next pick waits, and it is change number 1.
    ready();
    host.sent.length = 0;
    overlay.applySize(MEDIUM);
    expect(sizeSends()).toEqual([{ phase: 'blank', id: 1 }]);
    expect(resizes()).toBe(1);
  });

  it('while hidden: resizes at once, with no request and no timer', () => {
    const overlay = shown();
    overlay.setVisible(false);
    host.sent.length = 0;
    overlay.applySize(LARGE);
    expect(resizes()).toBe(1);
    expect(sizeSends()).toEqual([]);
    expect(overlay.currentMode().scale).toBe(LARGE);
    expect(vi.getTimerCount()).toBe(idleTimers);
  });

  it('the size he already has: resizes at once, as it always did, with no request', () => {
    const overlay = shown();
    const before = { ...overlay.win.getBounds() };
    overlay.applySize(SMALL);
    expect(resizes()).toBe(1);
    expect(overlay.win.getBounds()).toEqual(before);
    expect(sizeSends()).toEqual([]);
    expect(vi.getTimerCount()).toBe(idleTimers);
  });

  /* ------------------------------------------------------ presence, meanwhile */

  it('hidden during the wait, then another pick: resizes at once to the new scale', () => {
    const overlay = shown();
    overlay.applySize(MEDIUM);
    overlay.setVisible(false);
    expect(resizes()).toBe(0);

    overlay.applySize(LARGE);
    expect(resizes()).toBe(1);
    expect(overlay.currentMode().scale).toBe(LARGE);
    // One request (the first pick's) and the one resize; no second request.
    expect(sizeSends()).toEqual([
      { phase: 'blank', id: 1 },
      expect.objectContaining({ phase: 'resized', id: 1, scale: LARGE })
    ]);
    expect(vi.getTimerCount()).toBe(idleTimers);
    ack(1);
    expect(resizes()).toBe(1);
  });

  it.each(['the answer', 'the timer'] as const)(
    'hidden during the wait and no further pick: %s still resizes',
    (how) => {
      const overlay = shown();
      overlay.applySize(LARGE);
      overlay.setVisible(false);
      expect(resizes()).toBe(0);
      if (how === 'the answer') ack(1);
      else vi.advanceTimersByTime(SIZE_BLANK_GRACE_MS);
      expect(resizes()).toBe(1);
      expect(overlay.currentMode()).toMatchObject({ scale: LARGE, hidden: true });
      // Hiding is still only hiding: the flush shows nothing.
      expect(host.calls).not.toContain('showInactive');
      expect(host.calls).not.toContain('show');
    }
  );

  it('shown again during the wait: the wait goes on and ends as usual', () => {
    const overlay = shown();
    overlay.applySize(LARGE);
    overlay.setVisible(false);
    overlay.setVisible(true);
    expect(resizes()).toBe(0);
    expect(host.calls).toEqual(['hide', 'showInactive']);
    ack(1);
    expect(resizes()).toBe(1);
    expect(overlay.currentMode()).toMatchObject({ scale: LARGE, hidden: false });
  });

  /* ------------------------------------- the same window a direct resize gives */

  it.each([
    ['at the home corner', null],
    ['on the left half', MID],
    ['on the right half', { x: 1000, y: 500 }]
  ] as const)(
    'ends exactly where a direct resize ends, %s (X1)',
    (_label, at) => {
      const trail = (platform: NodeJS.Platform): Snapshot[] => {
        const r = rig(platform, at);
        const seen = [r.snap()];
        for (const scale of [LARGE, SMALL, MEDIUM, LARGE, SMALL]) {
          r.pick(scale);
          seen.push(r.snap());
        }
        return seen;
      };
      const win = trail('win32');
      expect(win).toEqual(trail('darwin'));
      // A real trail, not six copies of one window: he grew, and the round
      // trips came home (2026-11-14, audit X1).
      expect(win[1]?.bounds.width).toBeGreaterThan(win[0]?.bounds.width ?? Infinity);
      expect(win[1]?.scale).toBe(LARGE);
      expect(win[2]?.bounds).toEqual(win[0]?.bounds);
      expect(win[5]?.bounds).toEqual(win[0]?.bounds);
    }
  );

  it('Small -> Large -> Small picked inside one wait ends where it started, as on macOS', () => {
    const quick = (platform: NodeJS.Platform): Snapshot => {
      const r = rig(platform, null);
      if (platform === 'win32') {
        r.overlay.applySize(LARGE);
        r.overlay.applySize(SMALL);
        ack(1);
      } else {
        r.overlay.applySize(LARGE);
        r.overlay.applySize(SMALL);
      }
      return r.snap();
    };
    expect(quick('win32')).toEqual(quick('darwin'));
  });

  it('saves the position at the resize, not at the pick', () => {
    const store = storeAt();
    const overlay = shown('win32', store);
    overlay.applySize(LARGE);
    expect(savedAt(store)).toEqual(MID);

    ack(1);
    const bounds = overlay.win.getBounds();
    expect(savedAt(store)).toEqual({ x: bounds.x, y: bounds.y });
    expect(savedAt(store)).not.toEqual(MID);
  });

  it('honours a Reset and a display change made during the wait', () => {
    const moved = (platform: NodeJS.Platform): Snapshot => {
      const r = rig(platform);
      const meanwhile = (): void => {
        r.overlay.resetPosition();
        DISPLAY.scaleFactor = 1.25;
        metricsChanged();
      };
      if (platform === 'win32') {
        r.overlay.applySize(LARGE);
        meanwhile();
        // Both acted on the old size, which is still the size he is.
        expect(r.overlay.currentMode().scale).toBe(SMALL);
        expect(sizeOf(r.overlay.win.getBounds())).toEqual(
          sizeOf(boxMetrics(SMALL, BOXES.stand, true, 0))
        );
        ack(1);
      } else {
        meanwhile();
        r.overlay.applySize(LARGE);
      }
      return r.snap();
    };
    const win = moved('win32');
    expect(win).toEqual(moved('darwin'));
    expect(win.scale).toBe(LARGE);
    // Reset took him to the right half, so he is no longer at the left spot.
    expect(win.bounds.x).toBeGreaterThan(MID.x + 200);
  });

  it('a pick mid-drag: the resize rebases the drag, as a direct one does (M2)', () => {
    const dragged = (platform: NodeJS.Platform) => {
      const r = rig(platform);
      r.overlay.dragStart();
      r.overlay.dragMove(-50, -30);
      host.sent.length = 0;
      r.pick(MEDIUM);
      const resized = { ...r.overlay.win.getBounds() };
      // The drag owns the pointer: no cursor reading is sent for this resize.
      const cursorSends = host.sent.filter((entry) => entry.channel === CH.hoverCursor).length;
      // The cursor has not moved: the same cumulative delta must leave him put.
      r.overlay.dragMove(-50, -30);
      const held = { ...r.overlay.win.getBounds() };
      r.overlay.dragEnd();
      return { resized, held, cursorSends, end: r.snap() };
    };
    const win = dragged('win32');
    expect(win).toEqual(dragged('darwin'));
    expect(win.held).toEqual(win.resized);
    expect(win.cursorSends).toBe(0);
    expect(win.end.scale).toBe(MEDIUM);
    expect(sizeOf(win.resized)).toEqual(
      sizeOf(boxMetrics(MEDIUM, BOXES.stand, true, 0))
    );
  });

  /* --------------------------------------------------- the page and the window */

  it('a renderer that dies in the wait: resized before the reload, and nothing is left waiting', () => {
    const overlay = shown();
    overlay.applySize(LARGE);
    host.goneHandlers.at(-1)?.(null, { reason: 'crashed' });
    expect(resizes()).toBe(1);
    expect(host.reloads).toBe(1);
    // The resize came first, so the fresh page boots into the new size.
    expect(host.reloadedAfter).toEqual([1]);
    expect(overlay.currentMode().scale).toBe(LARGE);
    expect(vi.getTimerCount()).toBe(idleTimers);

    // The dead page's answer, had it been in flight, and the time limit.
    ack(1);
    vi.advanceTimersByTime(1_000);
    expect(resizes()).toBe(1);
  });

  it('a renderer past its last reload is still resized', () => {
    const overlay = shown();
    for (let i = 0; i < MAX_RENDERER_RELOADS; i++) {
      host.goneHandlers.at(-1)?.(null, { reason: 'crashed' });
    }
    expect(resizes()).toBe(0);
    overlay.applySize(LARGE);
    host.goneHandlers.at(-1)?.(null, { reason: 'crashed' });
    expect(host.reloads).toBe(MAX_RENDERER_RELOADS);
    expect(resizes()).toBe(1);
    expect(overlay.currentMode().scale).toBe(LARGE);
    expect(vi.getTimerCount()).toBe(idleTimers);
  });

  it('a renderer that dies with nothing waiting resizes nothing', () => {
    shown();
    host.goneHandlers.at(-1)?.(null, { reason: 'crashed' });
    expect(resizes()).toBe(0);
    expect(sizeSends()).toEqual([]);
    expect(host.reloads).toBe(1);
  });

  it('a page load in the wait resizes at once', () => {
    const overlay = shown();
    overlay.applySize(LARGE);
    expect(host.loadHandlers).toHaveLength(1);
    host.sent.length = 0;
    for (const handler of host.loadHandlers) handler();
    expect(resizes()).toBe(1);
    expect(overlay.currentMode().scale).toBe(LARGE);
    // Its `mode:set` is out before the bridge's own push, which is registered later.
    expect(modeSends()).toEqual([expect.objectContaining({ scale: LARGE })]);
    expect(vi.getTimerCount()).toBe(idleTimers);
    // A load with nothing waiting does nothing.
    for (const handler of host.loadHandlers) handler();
    expect(resizes()).toBe(1);
  });

  it('closing the window in the wait resizes first, so the saved position is the saved size\'s', () => {
    const store = storeAt();
    const overlay = shown('win32', store);
    overlay.applySize(LARGE);
    expect(host.closeHandlers).toHaveLength(1);

    for (const handler of host.closeHandlers) handler();
    expect(resizes()).toBe(1);
    const bounds = overlay.win.getBounds();
    expect(sizeOf(bounds)).toEqual(sizeOf(boxMetrics(LARGE, BOXES.stand, true, 0)));
    expect(savedAt(store)).toEqual({ x: bounds.x, y: bounds.y });
    expect(vi.getTimerCount()).toBe(idleTimers);

    for (const handler of host.closedHandlers) handler();
    host.destroyed = true;
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    expect(resizes()).toBe(1);
  });

  it('a window closed in the wait: the timer is dropped and a late answer touches nothing', () => {
    const overlay = shown();
    overlay.applySize(LARGE);
    expect(vi.getTimerCount()).toBe(idleTimers + 1);
    for (const handler of host.closedHandlers) handler();
    expect(vi.getTimerCount()).toBe(idleTimers);

    // The change went with the window: an answer finds nothing pending, even
    // before the fake is told it is destroyed.
    host.calls.length = 0;
    host.sent.length = 0;
    ack(1);
    expect(host.calls).toEqual([]);
    expect(host.sent).toEqual([]);

    host.destroyed = true;
    expect(() => {
      vi.advanceTimersByTime(1_000);
      ack(1);
      overlay.applySize(MEDIUM);
    }).not.toThrow();
    expect(host.calls).toEqual([]);
    expect(host.sent).toEqual([]);
  });

  it('a window destroyed in the wait is left alone by the timer, a late answer and the next pick', () => {
    // The fake throws on `getBounds`/`setBounds` once destroyed, as Electron does.
    const overlay = shown();
    overlay.applySize(LARGE);
    host.destroyed = true;
    host.calls.length = 0;
    host.sent.length = 0;
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    expect(() => ack(1)).not.toThrow();
    expect(() => overlay.applySize(MEDIUM)).not.toThrow();
    expect(host.calls).toEqual([]);
    expect(host.sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(idleTimers);
  });

  it('a window destroyed in the wait, then a pick: the wait is dropped, nothing thrown', () => {
    const overlay = shown();
    overlay.applySize(LARGE);
    host.destroyed = true;
    host.calls.length = 0;
    expect(() => overlay.applySize(MEDIUM)).not.toThrow();
    expect(host.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(idleTimers);
  });

  it('a position that cannot be saved does not stop a timed-out resize or its messages', () => {
    // The flush runs from a timer, where nothing above would catch the throw
    // the settings file makes when it cannot be written.
    const store = storeAt();
    const overlay = shown('win32', store);
    overlay.applySize(LARGE);
    host.sent.length = 0;
    (store as { set: unknown }).set = () => {
      throw new Error('EACCES');
    };
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => vi.advanceTimersByTime(SIZE_BLANK_GRACE_MS)).not.toThrow();
      expect(warned).toHaveBeenCalledTimes(1);
    } finally {
      warned.mockRestore();
    }
    expect(resizes()).toBe(1);
    const after = overlay.win.getBounds();
    expect(sizeSends()).toEqual([
      expect.objectContaining({ phase: 'resized', id: 1, scale: LARGE, to: sizeOf(after) })
    ]);
    expect(modeSends()).toEqual([expect.objectContaining({ scale: LARGE })]);
    expect(overlay.currentMode().scale).toBe(LARGE);
  });

  it('the same failure on an answer is caught too', () => {
    const store = storeAt();
    const overlay = shown('win32', store);
    overlay.applySize(LARGE);
    (store as { set: unknown }).set = () => {
      throw new Error('EACCES');
    };
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => ack(1)).not.toThrow();
    } finally {
      warned.mockRestore();
    }
    expect(resizes()).toBe(1);
    expect(sizeSends().at(-1)).toMatchObject({ phase: 'resized', id: 1, scale: LARGE });
  });

  it.each([
    ['fails', true],
    ['works', false]
  ] as const)(
    'a resize that takes him across the middle turns him before mode:set, when the save %s',
    (_label, failing) => {
      // `resize` settles the facing last, after the save — which throws when
      // the settings file cannot be written. The flush catches that and has to
      // settle the facing itself, or the `mode:set` it sends straight after
      // says he still looks the way he did.
      //
      // Large at x 560 on the 1440 px screen: centre 692, inside the dead band
      // (662–778) and on the left half, so he keeps the art's `left` and his
      // left edge. Small there has its centre at 604, left of the band.
      const store = storeAt({ x: 560, y: 400 });
      const overlay = shown('win32', store, LARGE);
      expect(overlay.win.getBounds().x).toBe(560);
      expect(overlay.currentMode().facing).toBe('left');
      overlay.applySize(SMALL);
      host.sent.length = 0;
      if (failing) {
        (store as { set: unknown }).set = () => {
          throw new Error('EACCES');
        };
      }
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        expect(() => ack(1)).not.toThrow();
        expect(warned).toHaveBeenCalledTimes(failing ? 1 : 0);
      } finally {
        warned.mockRestore();
      }
      expect(overlay.win.getBounds().x).toBe(560);
      expect(overlay.currentMode()).toMatchObject({ scale: SMALL, facing: 'right' });
      // The turn is sent, and before the `mode:set` that also carries it.
      expect(host.sent.map((entry) => entry.channel)).toEqual([
        CH.hoverCursor,
        CH.facingSet,
        CH.sizeChange,
        CH.modeSet
      ]);
      expect(host.sent.find((entry) => entry.channel === CH.facingSet)?.payload).toEqual({
        facing: 'right'
      });
      expect(modeSends()).toEqual([expect.objectContaining({ scale: SMALL, facing: 'right' })]);
    }
  );

  /* ---------------------------------- resized again before he is drawn again */

  /*
   * Review of 2026-11-16. Main sends `resized` once, from the flush. In the
   * few frames before the renderer's matching paint a bark, a bubble running
   * out or a curl-up resizes the window again, through calls that send no
   * `size:change`; the renderer was left waiting for a viewport the window no
   * longer had and drew nothing — him and the bubble — until its 500 ms limit.
   * Until the renderer reports him shown, every other resize is now followed
   * by `resized` again: the same id and `from`, the size the window has now.
   */

  it('a bark in the frames after the resize: resized again, same id and from, the size it has now', () => {
    const overlay = shown('win32', storeAt(), LARGE);
    const large = sizeOf(overlay.win.getBounds());
    overlay.applySize(SMALL);
    ack(1);
    const small = sizeOf(overlay.win.getBounds());
    const first = { phase: 'resized', id: 1, scale: SMALL, from: large, to: small };
    expect(sizeSends().at(-1)).toEqual(first);
    const sentBefore = host.sent.length;

    // No paint has matched yet — no `shown` report — and he barks.
    overlay.applyBubble(30);
    const barking = sizeOf(overlay.win.getBounds());
    expect(barking).toEqual({ width: 240, height: small.height });
    // One more message, after the window was resized; a bubble still sends
    // no `mode:set`.
    expect(
      host.sent.slice(sentBefore).map((entry) => [entry.channel, entry.setBoundsBefore])
    ).toEqual([
      [CH.hoverCursor, 1],
      [CH.sizeChange, 2]
    ]);
    expect(sizeSends().at(-1)).toEqual({ ...first, to: barking });

    // What it is for. With everything main sent, the paint at the window's
    // size draws him; with the first `resized` alone it is blank, because 240
    // is nearer the 264 he came from than the 88 that message named.
    expect(blankAtTheWindowsSize(overlay)).toBe(false);
    expect(blankAtTheWindowsSize(overlay, sizeSends().slice(0, -1))).toBe(true);
    expect(vi.getTimerCount()).toBe(idleTimers);
  });

  it('a bubble that clears in the frames after the resize: the same', () => {
    const overlay = shown();
    overlay.applyBubble(30);
    const barking = sizeOf(overlay.win.getBounds());
    overlay.applySize(LARGE);
    ack(1);
    expect(sizeOf(overlay.win.getBounds()).width).toBe(314);

    overlay.applyBubble(0);
    const large = sizeOf(overlay.win.getBounds());
    expect(large).toEqual(sizeOf(boxMetrics(LARGE, BOXES.stand, true, 0)));
    expect(sizeSends().at(-1)).toEqual({
      phase: 'resized',
      id: 1,
      scale: LARGE,
      from: barking,
      to: large
    });
    expect(blankAtTheWindowsSize(overlay)).toBe(false);
    expect(blankAtTheWindowsSize(overlay, sizeSends().slice(0, -1))).toBe(true);
  });

  it('a box change in those frames: resized again first, then its mode:set', () => {
    const overlay = shown();
    const small = sizeOf(overlay.win.getBounds());
    overlay.applySize(LARGE);
    ack(1);
    const sentBefore = host.sent.length;

    overlay.applyBox('sleep');
    const asleep = sizeOf(overlay.win.getBounds());
    // The order of the flush: the sizes, then the message that carries the
    // scale and the box.
    expect(host.sent.slice(sentBefore).map((entry) => entry.channel)).toEqual([
      CH.hoverCursor,
      CH.sizeChange,
      CH.modeSet
    ]);
    expect(sizeSends().at(-1)).toEqual({
      phase: 'resized',
      id: 1,
      scale: LARGE,
      from: small,
      to: asleep
    });
    expect(modeSends().at(-1)).toMatchObject({ scale: LARGE, box: 'sleep' });
    expect(blankAtTheWindowsSize(overlay)).toBe(false);
  });

  it('every resize before he is drawn is followed, each with the size it left', () => {
    const overlay = shown();
    const small = sizeOf(overlay.win.getBounds());
    overlay.applySize(LARGE);
    ack(1);
    const seen: unknown[] = [];
    for (const step of [
      (): void => overlay.applyBubble(30),
      (): void => overlay.applyBox('sleep'),
      (): void => overlay.applyBubble(0),
      (): void => overlay.applyBox('stand')
    ]) {
      step();
      seen.push(sizeSends().at(-1));
      expect(seen.at(-1)).toEqual({
        phase: 'resized',
        id: 1,
        scale: LARGE,
        // Always the size from before the size change: the one viewport that
        // must never match.
        from: small,
        to: sizeOf(overlay.win.getBounds())
      });
      expect(blankAtTheWindowsSize(overlay)).toBe(false);
    }
    // One blank, the flush's `resized`, and one follow-up per resize.
    expect(sizeSends()).toHaveLength(2 + 4);
    expect(new Set(seen.map((message) => JSON.stringify(message))).size).toBe(4);
  });

  it.each([
    ['matched', true],
    ['at its time limit', false]
  ] as const)(
    'once he is reported shown (%s), a bubble or a box change sends nothing more',
    (_label, matched) => {
      const overlay = shown();
      overlay.applySize(LARGE);
      ack(1);
      reportShown(overlay, 1, matched);
      const sends = sizeSends().length;
      overlay.applyBubble(30);
      overlay.applyBox('sleep');
      overlay.applyBubble(0);
      expect(resizes()).toBe(4);
      expect(sizeSends()).toHaveLength(sends);
    }
  );

  it('a shown report for another change does not end it', () => {
    const overlay = shown();
    overlay.applySize(LARGE);
    ack(1);
    overlay.applySize(MEDIUM);
    ack(2);
    // The first change's report, in flight when the second pick was made, and
    // one for a change that does not exist.
    reportShown(overlay, 1);
    reportShown(overlay, 3);
    overlay.applyBubble(30);
    expect(sizeSends().at(-1)).toMatchObject({
      phase: 'resized',
      id: 2,
      scale: MEDIUM,
      to: sizeOf(overlay.win.getBounds())
    });

    reportShown(overlay, 2);
    const sends = sizeSends().length;
    overlay.applyBubble(0);
    expect(sizeSends()).toHaveLength(sends);
  });

  it('a new pick ends it: resizes in its wait send nothing, and its own resize starts afresh', () => {
    const overlay = shown();
    overlay.applySize(LARGE);
    ack(1);
    overlay.applySize(MEDIUM);
    expect(sizeSends().at(-1)).toEqual({ phase: 'blank', id: 2 });
    const sends = sizeSends().length;

    // In the wait he is resized at the old scale, and the renderer has no
    // target to keep current: it dropped change 1 for the new `blank`.
    overlay.applyBubble(30);
    overlay.applyBox('sleep');
    expect(sizeSends()).toHaveLength(sends);
    const during = sizeOf(overlay.win.getBounds());

    ack(2);
    expect(sizeSends().slice(sends)).toEqual([
      { phase: 'resized', id: 2, scale: MEDIUM, from: during, to: sizeOf(overlay.win.getBounds()) }
    ]);
    // And change 2 is followed in its turn.
    overlay.applyBubble(0);
    expect(sizeSends().at(-1)).toEqual({
      phase: 'resized',
      id: 2,
      scale: MEDIUM,
      from: during,
      to: sizeOf(overlay.win.getBounds())
    });
  });

  it.each(['a page load', 'a dead renderer'] as const)(
    '%s ends it, for a change that was settling and for one it resizes itself',
    (what) => {
      const happen = (): void => {
        if (what === 'a page load') for (const handler of host.loadHandlers) handler();
        else host.goneHandlers.at(-1)?.(null, { reason: 'crashed' });
      };
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const overlay = shown();
        overlay.applySize(LARGE);
        ack(1);
        happen();
        let sends = sizeSends().length;
        // The page that loads next boots drawn, at the size the window has.
        overlay.applyBubble(30);
        expect(sizeSends()).toHaveLength(sends);

        overlay.applySize(MEDIUM);
        happen();
        expect(sizeSends().at(-1)).toMatchObject({ phase: 'resized', id: 2, scale: MEDIUM });
        sends = sizeSends().length;
        overlay.applyBubble(0);
        overlay.applyBox('sleep');
        expect(sizeSends()).toHaveLength(sends);
      } finally {
        warned.mockRestore();
      }
    }
  );

  it('a window closed while a change settles is not followed up', () => {
    const overlay = shown();
    overlay.applySize(LARGE);
    ack(1);
    for (const handler of host.closedHandlers) handler();
    const sends = sizeSends().length;
    // The fake window still answers; the real one is gone by now.
    overlay.applyBubble(30);
    expect(sizeSends()).toHaveLength(sends);
  });

  it('a pick with nothing to wait for, while one settles, is followed up at its own scale', () => {
    const overlay = shown();
    const small = sizeOf(overlay.win.getBounds());
    overlay.applySize(LARGE);
    ack(1);
    overlay.setVisible(false);

    // Hidden: resized at once, with no blank asked for. If the renderer is
    // still blank for change 1, this is the scale and the size it now needs.
    overlay.applySize(MEDIUM);
    expect(resizes()).toBe(2);
    expect(overlay.currentMode().scale).toBe(MEDIUM);
    expect(sizeSends()).toEqual([
      { phase: 'blank', id: 1 },
      expect.objectContaining({ phase: 'resized', id: 1, scale: LARGE }),
      {
        phase: 'resized',
        id: 1,
        scale: MEDIUM,
        from: small,
        to: sizeOf(boxMetrics(MEDIUM, BOXES.stand, true, 0))
      }
    ]);
    expect(blankAtTheWindowsSize(overlay)).toBe(false);
  });

  it('a box change whose save fails is still followed up', () => {
    // The follow-up goes out before the save, which is what throws.
    const store = storeAt();
    const overlay = shown('win32', store);
    overlay.applySize(LARGE);
    ack(1);
    (store as { set: unknown }).set = () => {
      throw new Error('EACCES');
    };
    expect(() => overlay.applyBox('sleep')).toThrow('EACCES');
    expect(sizeSends().at(-1)).toMatchObject({
      phase: 'resized',
      id: 1,
      scale: LARGE,
      to: sizeOf(overlay.win.getBounds())
    });
  });

  it('reads the size it follows up with from the window, not from what was asked', () => {
    const overlay = shown();
    overlay.applySize(LARGE);
    ack(1);
    host.grant = (asked) => ({ ...asked, width: asked.width + 0.8 });
    overlay.applyBubble(30);
    const asked = host.bounds.at(-1) as Rect;
    expect(sizeSends().at(-1)).toMatchObject({
      phase: 'resized',
      id: 1,
      to: { width: asked.width + 0.8, height: asked.height }
    });
  });

  it('logs a follow-up with the id and the size, and nothing when none is sent', () => {
    const lines: string[] = [];
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const overlay = shown();
      setVerbose(true);
      setLogSink((line) => {
        if (line.includes('size change')) lines.push(line.trim().replace(/^\S+ \S+ /, ''));
      });
      overlay.applyBubble(30);
      expect(lines).toEqual([]);
      overlay.applyBubble(0);
      overlay.applySize(LARGE);
      ack(1);
      lines.length = 0;
      overlay.applyBubble(30);
      reportShown(overlay, 1);
      overlay.applyBubble(0);
    } finally {
      logged.mockRestore();
    }
    expect(lines).toEqual([
      'size change 1: resized again meanwhile (-> 314x274)',
      'size change 1: shown, matched at 314x274'
    ]);
  });

  /* ------------------------------------------------------- macOS and Linux */

  it.each(['darwin', 'linux'] as const)(
    '%s: a bubble or a box change after a size change sends no size:change either',
    (platform) => {
      const overlay = shown(platform);
      overlay.applySize(LARGE);
      overlay.applyBubble(30);
      overlay.applyBox('sleep');
      overlay.applyBubble(0);
      expect(resizes()).toBe(4);
      expect(sizeSends()).toEqual([]);
      expect(vi.getTimerCount()).toBe(idleTimers);
    }
  );

  it.each(['darwin', 'linux'] as const)(
    '%s: resizes at once, sends no size:change, registers no handler and arms no timer',
    (platform) => {
      const overlay = shown(platform);
      expect(host.ipcHandlers).toEqual([]);
      expect(host.loadHandlers).toEqual([]);
      expect(host.closeHandlers).toEqual([]);

      overlay.applySize(LARGE);
      expect(resizes()).toBe(1);
      expect(overlay.currentMode().scale).toBe(LARGE);
      overlay.applySize(SMALL);
      overlay.applySize(SMALL);
      expect(resizes()).toBe(3);
      expect(sizeSends()).toEqual([]);
      // Only what a resize always sent: the cursor, once per `setBounds`.
      expect(host.sent.map((entry) => entry.channel)).toEqual([
        CH.hoverCursor,
        CH.hoverCursor,
        CH.hoverCursor
      ]);
      expect(vi.getTimerCount()).toBe(idleTimers);
      vi.advanceTimersByTime(1_000);
      expect(resizes()).toBe(3);
      expect(opacityCalls()).toEqual([]);
    }
  );

  it.each(['darwin', 'linux'] as const)(
    '%s: a save that fails still throws out of applySize, as it did',
    (platform) => {
      const store = storeAt();
      const overlay = shown(platform, store);
      (store as { set: unknown }).set = () => {
        throw new Error('EACCES');
      };
      expect(() => overlay.applySize(LARGE)).toThrow('EACCES');
    }
  );

  /* ----------------------------------------------------------- what is left alone */

  it('notePainted settles painted and nothing else, with or without a change waiting', async () => {
    for (const waiting of [false, true]) {
      const overlay = shown();
      let settled = false;
      void overlay.painted.then(() => {
        settled = true;
      });
      if (waiting) overlay.applySize(LARGE);
      host.sent.length = 0;
      const timers = vi.getTimerCount();

      // The launch's first-frame report, and a repeat of it after a reload.
      overlay.notePainted();
      overlay.notePainted();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled, `waiting ${waiting}`).toBe(true);
      expect(host.sent, `waiting ${waiting}`).toEqual([]);
      expect(resizes(), `waiting ${waiting}`).toBe(0);
      expect(vi.getTimerCount(), `waiting ${waiting}`).toBe(timers);
      // It is no longer an answer to anything: the change is still waiting.
      if (waiting) {
        expect(overlay.currentMode().scale).toBe(SMALL);
        ack(1);
        expect(resizes()).toBe(1);
      }
    }
  });

  it('still mode and the card order are untouched by the wait', () => {
    const overlay = shown();
    overlay.setStill(true);
    overlay.applySize(LARGE);
    overlay.orderAboveCard();
    expect(host.calls).toEqual(['moveTop']);
    expect(overlay.currentMode()).toMatchObject({ scale: SMALL, still: true });
    ack(1);
    expect(overlay.currentMode()).toMatchObject({ scale: LARGE, still: true });
  });

  /* ------------------------------------------------------------------ the log */

  it('writes one verbose line per step, with nothing in them but ids, scales and sizes', () => {
    const lines: string[] = [];
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const overlay = shown();
      setVerbose(true);
      setLogSink((line) => {
        if (line.includes('size change')) lines.push(line.trim().replace(/^\S+ \S+ /, ''));
      });

      // A healthy change: asked, answered, resized, shown.
      overlay.applySize(LARGE);
      ack(1);
      report({ phase: 'shown', id: 1, matched: true, ...sizeOf(overlay.win.getBounds()) });
      // One that nobody answers, and that the renderer gives up on.
      overlay.applySize(SMALL);
      overlay.applySize(MEDIUM);
      vi.advanceTimersByTime(SIZE_BLANK_GRACE_MS);
      ack(2);
      report({ phase: 'shown', id: 2, matched: false, ...sizeOf(overlay.win.getBounds()) });
    } finally {
      logged.mockRestore();
    }
    expect(lines).toEqual([
      'size change 1: asked the renderer for a blank picture (scale 1 -> 3)',
      `size change 1: resized after the blank picture is up (${dims(SMALL)} -> ${dims(LARGE)})`,
      `size change 1: shown, matched at ${dims(LARGE)}`,
      'size change 2: asked the renderer for a blank picture (scale 3 -> 1)',
      'size change 2: now for scale 2, same wait',
      `size change 2: resized after no answer from the renderer in 200 ms (${dims(LARGE)} -> ${dims(MEDIUM)})`,
      'size change 2: a blank report with nothing waiting for it; ignored',
      `size change 2: shown at the renderer's time limit, at ${dims(MEDIUM)}`
    ]);
    // The two lines an on-screen run is checked for the absence of.
    expect(lines.filter((line) => line.includes('no answer from the renderer'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('time limit'))).toHaveLength(1);
  });
});

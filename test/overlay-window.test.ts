/**
 * The overlay window's presence gate, against a mocked `BrowserWindow`.
 *
 * The arithmetic of `overlay-window.ts` is pinned elsewhere (`geometry.test.ts`
 * for the metrics and the one clamp, `store.test.ts` for the wrapper that
 * reads the displays). What is pinned here is the wiring: that every path
 * which sets the dog's position goes through that clamp (the owner's rule of
 * 2026-11-16, he is never outside the screen — its own suite below), the
 * Windows and macOS size-change wait, and the pair of flags behind
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
  /**
   * Every window operation, in order. A `setBounds` is recorded under one of
   * three names, told apart by the fake and not by the caller. `'setBounds'`
   * is a resize: made with the non-resizable flag lifted, as `resize` makes
   * it. `'move'` is a call made without lifting it whose rect restates the
   * size the window was last *asked* to be (the constructor's, or the last
   * resize's) — `moveTo`. `'move:not-the-asked-size'` is such a call with any
   * other size, which nothing expects. So `'move'` in an expectation pins
   * both halves of the rule: the window was moved with `setBounds`, and with
   * the size main asked for — a move that passed a size read back from a
   * window granted larger would fail it. `'setPosition'` is recorded so that
   * every test can assert it never happens (`afterEach`).
   */
  calls: [] as string[],
  /** The rect of every `'setBounds'` (a resize), in order. */
  bounds: [] as Rect[],
  /** The rect of every `'move'`, in order. */
  moves: [] as Rect[],
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
  /**
   * DIPs added to the window's width and height by every `setPosition`: the
   * hypothesis for the fault measured at 125 % on Windows (the window grew on
   * every step of a drag), in which `setPosition` re-applies a size read back
   * a little too large and `setBounds` gives exactly what is asked. The
   * overlay no longer calls `setPosition`, so this bites only a test that
   * calls it on the window itself, to stand for the code as it was. A
   * `setPosition` also goes through `grant`, with the size the window has:
   * the round trip of the hypothesis, for the rounding model below.
   */
  growOnSetPosition: 0,
  /**
   * Did anything call `setPosition` during the test? Apart from `calls`,
   * which the tests clear as they go. A test that calls it itself, to stand
   * for the code as it was, puts this back to `false`.
   */
  calledSetPosition: false,
  /**
   * DIPs by which every `'move'` leaves the window taller than it *was*,
   * whatever height the move asked for: the other reading of the same fault,
   * in which restating the size does not help. Not what is expected at 125 %
   * with `moveTo`; it is here so the protections that never relied on a cure
   * (`insideHeld`, the read-back in `resize`, the drop) stay tested. `0` is a
   * window that takes the size it is asked to have, which is every other
   * test.
   */
  growOnMove: 0,
  /**
   * DIPs `getBounds` adds to the window's width and height over what it has:
   * the read-back half of the hypothesis for the 125 % growth (Chromium turns
   * the physical rect into the DIP rect that encloses it, which at an origin
   * that is not a multiple of the scale is a DIP wider and taller). The fake's
   * `setPosition` re-applies the size it reads, as Electron's is understood to
   * (`SetBounds(Rect(position, GetSize()))`), so under this a `setPosition`
   * grows the window by it every time. `0` reads back what the window has.
   */
  readSurplus: 0,
  /**
   * DIPs added to `readSurplus` by every `getBounds`, cumulatively for the
   * whole test: a read-back that grows on every read, whatever is asked of the
   * window in between. The harshest form of the same fault, for the tests
   * that pin that a move never passes on a size it read.
   */
  readGrowth: 0,
  /** How many `getBounds` calls `readGrowth` has counted. */
  reads: 0,
  /**
   * What `screen.getAllDisplays()` answers, the primary first. `[DISPLAY]`
   * unless a test attaches, removes or rearranges displays (set after
   * `DISPLAY` exists, and again in `beforeEach`). Empty is the transient state
   * of a display reconfiguration.
   */
  displays: [] as {
    id: number;
    bounds: Rect;
    workArea: Rect;
    scaleFactor: number;
  }[],
  /**
   * Every question put to the fake `screen` that needs a display to answer
   * (`getPrimaryDisplay`, `getDisplayMatching`, `getDisplayNearestPoint`), in
   * order. What Electron answers those with no display attached has not been
   * observed, so the overlay must not ask them then; a test checks it did not.
   */
  screenAsks: [] as string[],
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
    /** The size last asked of the window, as opposed to the one it has. */
    private asked: { width: number; height: number };

    constructor(options: Record<string, unknown>) {
      host.built.push(options);
      this.resizable = options['resizable'] !== false;
      this.bounds = {
        x: Number(options['x'] ?? 0),
        y: Number(options['y'] ?? 0),
        width: Number(options['width'] ?? 100),
        height: Number(options['height'] ?? 100)
      };
      this.asked = { width: this.bounds.width, height: this.bounds.height };
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
      if (host.readSurplus === 0 && host.readGrowth === 0) return this.bounds;
      if (host.readGrowth !== 0) host.reads++;
      const surplus = host.readSurplus + host.reads * host.readGrowth;
      return {
        ...this.bounds,
        width: this.bounds.width + surplus,
        height: this.bounds.height + surplus
      };
    }
    setBounds(rect: Rect): void {
      if (host.destroyed) throw new Error('Object has been destroyed');
      const granted = host.grant === null ? rect : host.grant(rect);
      if (!this.resizable) {
        const restated = rect.width === this.asked.width && rect.height === this.asked.height;
        host.calls.push(restated ? 'move' : 'move:not-the-asked-size');
        host.moves.push(rect);
        this.bounds =
          host.growOnMove === 0
            ? granted
            : { ...granted, height: this.bounds.height + host.growOnMove };
        return;
      }
      host.calls.push('setBounds');
      host.bounds.push(rect);
      this.asked = { width: rect.width, height: rect.height };
      this.bounds = granted;
    }
    /**
     * Never called by the overlay (`afterEach` asserts it). Modelled as the
     * hypothesis has it — the position, with the size the window has now and
     * a little more — for the tests that call it directly.
     */
    setPosition(x: number, y: number): void {
      host.calls.push('setPosition');
      host.calledSetPosition = true;
      // The size the window reports, as Electron's `setPosition` re-applies it.
      const read = this.getBounds();
      const roundTrip = {
        x,
        y,
        width: read.width + host.growOnSetPosition,
        height: read.height + host.growOnSetPosition
      };
      this.bounds = host.grant === null ? roundTrip : host.grant(roundTrip);
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

  type FakeDisplay = (typeof host.displays)[number];
  /**
   * What the fake answers when no display is attached. What Electron answers
   * then has not been observed; the overlay is written not to ask.
   */
  const NO_DISPLAY: FakeDisplay = {
    id: 0,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    workArea: { x: 0, y: 0, width: 0, height: 0 },
    scaleFactor: 1
  };
  const overlapOf = (a: Rect, b: Rect): number => {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  };
  /** Squared distance from a point to a display's bounds; 0 inside them. */
  const distanceTo = (point: { x: number; y: number }, b: Rect): number => {
    const dx = Math.max(b.x - point.x, 0, point.x - (b.x + b.width));
    const dy = Math.max(b.y - point.y, 0, point.y - (b.y + b.height));
    return dx * dx + dy * dy;
  };
  const nearestTo = (point: { x: number; y: number }): FakeDisplay => {
    host.screenAsks.push('nearest');
    let best: FakeDisplay | null = null;
    for (const display of host.displays) {
      if (best === null || distanceTo(point, display.bounds) < distanceTo(point, best.bounds)) {
        best = display;
      }
    }
    return best ?? NO_DISPLAY;
  };
  /** As Electron: the display a rect overlaps most, else the nearest one. */
  const matching = (rect: Rect): FakeDisplay => {
    host.screenAsks.push('matching');
    let best: FakeDisplay | null = null;
    for (const display of host.displays) {
      const area = overlapOf(rect, display.bounds);
      if (area > 0 && (best === null || area > overlapOf(rect, best.bounds))) best = display;
    }
    return best ?? nearestTo({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  };

  return {
    // `window-page.ts` reads `app.isPackaged` (audit S7); a test run is a dev run.
    app: { isPackaged: false },
    BrowserWindow: FakeBrowserWindow,
    screen: {
      on: (event: string, listener: () => void) => {
        host.screenListeners.push({ event, listener });
      },
      removeListener: () => {},
      getAllDisplays: () => host.displays,
      getPrimaryDisplay: () => {
        host.screenAsks.push('primary');
        return host.displays[0] ?? NO_DISPLAY;
      },
      getDisplayNearestPoint: nearestTo,
      getDisplayMatching: matching,
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
/** `DISPLAY`'s own work area, which a test may replace and `beforeEach` puts back. */
const HOME_WORK_AREA = DISPLAY.workArea;
host.displays = [DISPLAY];

const { createOverlay, PAINT_SIGNAL_GRACE_MS } = await import('../src/main/overlay-window');
const { SIZE_BLANK_GRACE_MS, onSizeMessage, onSizePaint } = await import(
  '../src/core/size-change'
);
const { DEFAULTS } = await import('../src/main/store');
const { CH, CLICK_SLOP_PX, SCALE_BY_SIZE } = await import('../src/main/ipc');
const {
  boxMetrics,
  bubbleExtraPx,
  coveredByWorkAreas,
  drawnInkInset,
  inkInset,
  spriteFit,
  spriteLayout
} = await import('../src/core/geometry');
const { devicePixelScale } = await import('../src/sprites/raster');
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
 * The platform the tests that are not about the Size-change wait run on.
 * Pinned, so they do the same on every host: on win32 and darwin a scale change of a
 * window that is ready and shown is deferred behind the renderer's answer or a
 * real 200 ms timer, and `applySize` would return with nothing resized.
 */
const NO_GAP = { platform: 'linux' } as const;

/** Fire the `ready-to-show` the real window would fire after its first paint. */
function ready(): void {
  for (const handler of host.readyHandlers) handler();
  host.readyHandlers.length = 0;
}

beforeEach(() => {
  host.built.length = 0;
  host.calls.length = 0;
  host.bounds.length = 0;
  host.moves.length = 0;
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
  host.growOnMove = 0;
  host.growOnSetPosition = 0;
  host.calledSetPosition = false;
  host.readSurplus = 0;
  host.readGrowth = 0;
  host.reads = 0;
  host.screenAsks.length = 0;
  host.destroyed = false;
  DISPLAY.scaleFactor = 1;
  DISPLAY.workArea = HOME_WORK_AREA;
  host.displays = [DISPLAY];
});

/*
 * No path of the overlay moves the window with `setPosition`, in any test of
 * this file: every move restates the size main asked for (`moveTo` in
 * `overlay-window.ts`, which has why). And none passes a move any other size.
 */
afterEach(() => {
  expect(host.calledSetPosition, 'setPosition was called on the overlay window').toBe(false);
  for (const moved of host.calls) expect(moved).not.toBe('move:not-the-asked-size');
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
    // No resize and no move: the dog must come back exactly where he was, and
    // a hidden window is still a positioned one.
    expect(host.bounds).toHaveLength(before);
    expect(host.calls).not.toContain('move');
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
    expect((last!.payload as { still?: boolean }).still).toBe(true);
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
 * window height, and the 24 px visibility clamp of the time let it through
 * (the clamp is strict since 2026-11-16, which is no reason to store the wrong
 * point). The fake
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

  // Rewritten 2026-11-16 (the owner: he is never outside the screen). This
  // was 'still widens on screen for a Large dog the owner parked off the
  // edge': the drag rule let him hang off with 80 px of dog on screen, the
  // launch restored him there, and the bubble was not to move him. He cannot
  // be off the edge now, so the launch pulls him in — and the half that still
  // matters is kept: the bubble does not move him and still gets its room,
  // with the widened window hanging off the edge his ink is flush with.
  it('pulls a Large dog saved off the edge in at launch; the bubble then gets its room without moving him', () => {
    const area = DISPLAY.workArea;
    const largeMetrics = boxMetrics(SCALE_BY_SIZE.large, BOXES.stand, true, 0);
    const large = largeMetrics.width;
    const restX = area.x + area.width - boxMetrics(1, BOXES.stand, true, 0).width - 16;
    const key = `${DISPLAY.id}:${DISPLAY.bounds.width}x${DISPLAY.bounds.height}`;
    const store = fakeStore({ positions: { [key]: { x: restX, y: 400 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.large, BOXES, NO_GAP);
    // His ink flush with the right edge; only the padding is past it.
    const flush = area.x + area.width - large + inkInset(largeMetrics).right;
    expect(flush).toBe(1200);
    expect(overlay.win.getBounds().x).toBe(flush);
    const columns = 39;
    overlay.applyBubble(columns);

    const bounds = overlay.win.getBounds();
    const onScreen = Math.min(bounds.x + bounds.width, area.x + area.width) - bounds.x;
    const whole = large + 2 * bubbleExtraPx(columns, SCALE_BY_SIZE.large, BOXES.stand);
    expect(onScreen).toBeGreaterThanOrEqual(whole - 1);
    expect(bounds.x + (bounds.width - large) / 2).toBe(flush);
    expect(bounds.y).toBe(400);
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

  // Rewritten 2026-11-16 (the owner: he is never outside the screen). This
  // was 'leaves a dog the owner parked half off an edge where he was on a box
  // change': 40 px of a Small dog on screen at the left edge was kept by the
  // launch and by a curl-up, under the drag rule. There is no such placement
  // any more: the launch puts his ink flush with the edge, and what is left
  // of the old promise is that a box change does not move him from there.
  it('launches a dog saved half off an edge flush with it, and a box change leaves him there', () => {
    const small = boxMetrics(SCALE_BY_SIZE.small, BOXES.stand, true, 0);
    const parkedX = area.x - inkInset(small).left - (BOXES.stand.width - 40);
    const flush = area.x - inkInset(small).left;
    expect(flush).toBe(-8);
    const store = fakeStore({ positions: { [key]: { x: parkedX, y: 500 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    expect(overlay.win.getBounds().x).toBe(flush);
    expect(whollyInside(inkOf(overlay.win.getBounds(), small))).toBe(true);

    overlay.applyBox('sleep');
    expect(overlay.win.getBounds().x).toBe(flush);
    overlay.applyBox('stand');
    expect(overlay.win.getBounds().x).toBe(flush);
    expect(savedAt(store)).toEqual({ x: flush, y: 500 });
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

  // Rewritten 2026-11-16 (the owner: he is never outside the screen). This
  // was 'leaves a dog parked half off an edge where he was on a scale
  // change': a dog 40 px on screen kept the drag rule he was parked under.
  // He now starts with his ink flush with the edge, and the scale change is
  // judged by the one rule: at 125 % a Small dog is drawn *smaller* (0.8), so
  // he is still inside and does not move. The reverse, where he is drawn
  // larger and has to be pulled in, is in the suite of the rule below.
  it('does not move a dog flush with an edge when the scale goes to 125 %, where he is drawn smaller', () => {
    const small = boxMetrics(SCALE_BY_SIZE.small, BOXES.stand, true, 0);
    const parkedX = area.x - inkInset(small).left - (BOXES.stand.width - 40);
    const flush = area.x - inkInset(small).left;
    const store = fakeStore({ positions: { [key]: { x: parkedX, y: 500 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    expect(overlay.win.getBounds().x).toBe(flush);

    DISPLAY.scaleFactor = 1.25;
    host.calls.length = 0;
    metricsChanged();
    expect(host.calls).toEqual([]);
    expect(overlay.win.getBounds().x).toBe(flush);
    // Nothing moved, so nothing was saved: the file still holds the old point.
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

  // Rewritten 2026-11-16 (the owner: he is never outside the screen). The
  // old version dragged him to the one delta at which the stale wide rect
  // still passed the lenient rule (exactly MIN_VISIBLE_PX of ink on screen)
  // and asserted he kept at least that much. There is no such threshold now:
  // dragged as far left as it goes after the bubble has cleared, he must be
  // measured as the narrow window he is — his ink flush with the edge, not
  // the widening's width inside it or outside it.
  it('cannot park him off the left edge when a bubble clears', () => {
    const store = fakeStore({ positions: { [key]: { x: 300, y: 400 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.medium, BOXES, NO_GAP);
    const metrics = boxMetrics(SCALE_BY_SIZE.medium, BOXES.stand, true, 0);
    overlay.applyBubble(40);
    const wide = overlay.win.getBounds();
    expect(wide.width).toBeGreaterThan(metrics.width);
    overlay.dragStart();
    overlay.applyBubble(0);
    overlay.dragMove(-10000, 0);
    overlay.dragEnd();

    const b = overlay.win.getBounds();
    expect(b.width).toBe(metrics.width);
    expect(b.x + inkInset(metrics).left).toBe(DISPLAY.workArea.x);
    const saved = (store.get('positions') as Record<string, { x: number }>)[key]?.x;
    expect(saved).toBe(b.x);
  });

  // 2026-11-17 (review): the test above reads only the left inset, which a
  // drag origin left at the old, wide size answers the same way — with the
  // rebase's size taken out it still passed. The far edge is where a stale
  // size shows: measured as the wide window he no longer has, he stops twice
  // the widening short of the right edge. And since `dragMove` only ever lets
  // the held size grow, a stale wide origin would last the rest of the drag.
  it('measures the narrow window he has at the right edge too, once the bubble has cleared', () => {
    const store = fakeStore({ positions: { [key]: { x: 300, y: 400 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.medium, BOXES, NO_GAP);
    const metrics = boxMetrics(SCALE_BY_SIZE.medium, BOXES.stand, true, 0);
    overlay.applyBubble(40);
    expect(overlay.win.getBounds().width).toBeGreaterThan(metrics.width);
    overlay.dragStart();
    overlay.applyBubble(0);
    overlay.dragMove(10000, 0);

    const right = DISPLAY.workArea.x + DISPLAY.workArea.width;
    const held = overlay.win.getBounds();
    expect(held.width).toBe(metrics.width);
    expect(held.x + held.width - inkInset(metrics).right).toBe(right);
    overlay.dragEnd();
    const b = overlay.win.getBounds();
    expect(b.x + b.width - inkInset(metrics).right).toBe(right);
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

  it('still moves him home, without throwing, when the spot cannot be saved', () => {
    // 2026-11 audit, W-1: the tray's reset must not throw out on a failed write.
    const store = fakeStore({ positions: { [key]: { x: 300, y: 300 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    (store as { set: unknown }).set = () => {
      throw new Error('EACCES');
    };
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => overlay.resetPosition()).not.toThrow();
      expect(warned).toHaveBeenCalledTimes(1);
    } finally {
      warned.mockRestore();
    }
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
 * QA row 3.17 (Windows, 2026-11-19): about 30 ms after the dog's menu opened
 * under the pointer the renderer reported a leave the cursor never made (a
 * `mouseleave`, by inference), and no enter until the mouse moved. Main sends
 * the cursor when the menu closes (`ipc-bridge.test.ts` pins the call), on
 * the channel the renderer already re-derives hover from.
 */
describe('resyncCursor', () => {
  const cursorSends = (): typeof host.sent =>
    host.sent.filter((entry) => entry.channel === CH.hoverCursor);

  it('sends the cursor in window coordinates, against the bounds as they are', () => {
    const overlay = build();
    const b = overlay.win.getBounds();
    host.cursor = { x: b.x + 40, y: b.y + b.height - 10 };
    host.sent.length = 0;
    overlay.resyncCursor();
    expect(cursorSends().map((entry) => entry.payload)).toEqual([
      { x: 40, y: b.height - 10, width: b.width, height: b.height }
    ]);
  });

  it('sends a cursor that has left too, so a missed leave is caught at the close', () => {
    const overlay = build();
    const b = overlay.win.getBounds();
    host.cursor = { x: b.x - 200, y: b.y - 300 };
    host.sent.length = 0;
    overlay.resyncCursor();
    expect(cursorSends().map((entry) => entry.payload)).toEqual([
      { x: -200, y: -300, width: b.width, height: b.height }
    ]);
  });

  it('stays out of a drag, which owns the pointer', () => {
    const overlay = build();
    overlay.dragStart();
    host.sent.length = 0;
    overlay.resyncCursor();
    expect(cursorSends()).toEqual([]);
    overlay.dragEnd();
  });

  it('sends nothing while he is hidden', () => {
    const overlay = build();
    overlay.setVisible(false);
    host.sent.length = 0;
    overlay.resyncCursor();
    expect(cursorSends()).toEqual([]);
  });
});

/**
 * The owner's rule of 2026-11-16, in his words: "walder can't move outside
 * your screen, so it always stay inside your screen borders, no exceptions,
 * should also take multiple displays into account". Inside means all of his
 * drawn ink on the work area of some display (clear of the taskbar, the Dock
 * and the menu bar); across the seam between two displays is allowed where
 * both cover him. The geometry is pinned in `geometry.test.ts`; what is pinned
 * here is that **every path that sets his position, or on which it can go
 * stale, goes through it** — one test or more per path, each against the fake
 * window and the fake `screen` above.
 *
 * None of this has been seen on a screen yet, and the two-display cases can
 * only be run like this on the machines available: the fake's displays are
 * rectangles a test attaches, and its `getDisplayMatching` is "most overlap,
 * else nearest", as Electron documents its own.
 */
describe('inside the screen, on every path (owner, 2026-11-16)', () => {
  type Point = { x: number; y: number };
  type FakeDisplay = (typeof host.displays)[number];
  const SMALL = SCALE_BY_SIZE.small;
  const MEDIUM = SCALE_BY_SIZE.medium;
  const LARGE = SCALE_BY_SIZE.large;
  const keyOf = (display: { id: number; bounds: { width: number; height: number } }): string =>
    `${display.id}:${display.bounds.width}x${display.bounds.height}`;
  const key = keyOf(DISPLAY);
  const savedAt = (store: WalderStore, k: string = key): Point | undefined =>
    (store.get('positions') as Record<string, Point>)[k];
  const storeAt = (point: Point, k: string = key): WalderStore =>
    fakeStore({ positions: { [k]: point } });
  const fire = (name: string): void => {
    for (const { event, listener } of host.screenListeners) if (event === name) listener();
  };
  const metricsChanged = (): void => fire('display-metrics-changed');
  const count = (call: string): number => host.calls.filter((c) => c === call).length;
  const display = (id: number, bounds: Rect, scaleFactor = 1, workArea: Rect = bounds): FakeDisplay => ({
    id,
    bounds,
    workArea,
    scaleFactor
  });
  const overlapOf = (a: Rect, b: Rect): number => {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  };
  /** The display a window is on, as the fake `screen` (and Windows) decide it. */
  const displayOf = (b: Rect): FakeDisplay =>
    host.displays.reduce((best, d) => (overlapOf(b, d.bounds) > overlapOf(b, best.bounds) ? d : best));

  /**
   * His ink in a window, worked out the way the renderer places him and not the
   * way main measures him: the box drawn for `scale` at the display's factor,
   * centred in the window's width, feet on the window's floor — whatever size
   * the window really has. Whole pixels, as main's measure is, which is what
   * the exact expectations below want. It assumes a box that is not clipped
   * by its window; for one that is (asleep at a fractional scale factor) in a
   * window larger than its metrics, `rendered` below is the truth.
   */
  function drawnInk(
    b: Rect,
    scale: number,
    boxName: keyof typeof BOXES = 'stand',
    bubble = false,
    dpr = 1
  ): Rect {
    const boxSize = BOXES[boxName];
    const reserve = boxName === 'stand' || bubble;
    const plain = boxMetrics(scale, boxSize, reserve, 0);
    const extra = Math.max(0, Math.round((b.width - plain.width) / 2));
    const m = boxMetrics(scale, boxSize, reserve, extra);
    const inset = drawnInkInset({ metrics: m, scale, box: boxSize, standBox: BOXES.stand, dpr });
    const width = m.width - inset.left - inset.right;
    const height = m.height - inset.top - inset.bottom;
    return { x: b.x + (b.width - m.width) / 2 + inset.left, y: b.y + b.height - height, width, height };
  }
  /** Is all of him inside the screen, measured on the display his window is on? */
  function inside(
    b: Rect,
    scale: number,
    boxName: keyof typeof BOXES = 'stand',
    bubble = false
  ): boolean {
    return coveredByWorkAreas(
      drawnInk(b, scale, boxName, bubble, displayOf(b).scaleFactor),
      host.displays.map((d) => d.workArea)
    );
  }

  /**
   * Where the renderer really draws him in a window: `spriteLayout` run in the
   * size the window has (it reads `window.innerWidth`/`innerHeight` and knows
   * nothing of main's metrics), the part above the window's top clipped away.
   * Not floored, and no metrics in it — so unlike `drawnInk` it does not share
   * main's assumptions about a window that is not the size it was laid out
   * for: a box drawn taller than its window fills a taller window's extra rows.
   */
  function rendered(b: Rect, scale: number, boxName: keyof typeof BOXES = 'stand'): Rect {
    const dpr = displayOf(b).scaleFactor;
    const box = BOXES[boxName];
    const layout = spriteLayout({
      viewWidth: b.width,
      viewHeight: b.height,
      box,
      scale,
      pixelScale: devicePixelScale(scale, dpr, spriteFit(scale, BOXES.stand)),
      dpr
    });
    const top = Math.max(0, layout.css.y);
    return {
      x: b.x + layout.css.x,
      y: b.y + top,
      width: box.width * layout.cssScale,
      height: b.height - top
    };
  }

  const area = DISPLAY.workArea;
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  const small = boxMetrics(SMALL, BOXES.stand, true, 0);
  const medium = boxMetrics(MEDIUM, BOXES.stand, true, 0);
  const large = boxMetrics(LARGE, BOXES.stand, true, 0);

  /* ------------------------------------------------------------- the launch */

  describe('at launch', () => {
    it('restores a position saved half off an edge with all of him on screen', () => {
      // A file written before the rule: 40 px of a Small dog on screen at the
      // left edge, which a drag could leave and the launch then kept.
      const parkedX = area.x - inkInset(small).left - (BOXES.stand.width - 40);
      const store = storeAt({ x: parkedX, y: 500 });
      const overlay = createOverlay(store, SMALL, BOXES, NO_GAP);
      const b = overlay.win.getBounds();
      expect(b.x + inkInset(small).left).toBe(area.x);
      expect(b.y).toBe(500);
      expect(inside(b, SMALL)).toBe(true);
      // Not written back at launch, as before: the first move or resize saves.
      expect(savedAt(store)).toEqual({ x: parkedX, y: 500 });
    });

    it('restores a position from another display layout onto the screen there is', () => {
      // Saved under this display's key at a point far outside it — the display
      // kept its id and size and everything around it changed.
      for (const point of [
        { x: 5000, y: 300 },
        { x: -3000, y: -3000 },
        { x: 600, y: 4000 }
      ]) {
        const overlay = createOverlay(storeAt(point), MEDIUM, BOXES, NO_GAP);
        expect(inside(overlay.win.getBounds(), MEDIUM), JSON.stringify(point)).toBe(true);
      }
    });

    it('corrects at ready-to-show what the window system did with the position it was given', () => {
      // The constructor's position was inside; between then and the first
      // paint the taskbar appeared under him, with no event (or one that came
      // before the listeners were there).
      const store = storeAt({ x: 600, y: bottom - small.height });
      const overlay = createOverlay(store, SMALL, BOXES, NO_GAP);
      DISPLAY.workArea = { ...area, height: area.height - 40 };
      host.calls.length = 0;
      ready();
      // Moved first, shown after: never a frame of him over the taskbar.
      expect(host.calls).toEqual(['move', 'showInactive']);
      const b = overlay.win.getBounds();
      expect(b.y + b.height).toBe(bottom - 40);
      expect(inside(b, SMALL)).toBe(true);
      expect(savedAt(store)).toEqual({ x: 600, y: b.y });
    });

    it('corrects a hidden dog at ready-to-show too, and still does not show him', () => {
      const overlay = createOverlay(storeAt({ x: 600, y: bottom - small.height }), SMALL, BOXES, NO_GAP);
      overlay.setVisible(false);
      DISPLAY.workArea = { ...area, height: area.height - 40 };
      host.calls.length = 0;
      ready();
      expect(host.calls).toEqual(['move']);
      expect(inside(overlay.win.getBounds(), SMALL)).toBe(true);
    });

    // 2026-11-17 (review): the home spot goes through the rule too, and the
    // only test on a display too small for him went through Reset.
    it('with nothing saved, on a display the window does not fit: his ink is what is fitted', () => {
      // Too small for the Large window (264 x 282), large enough for his ink
      // (216 x 216): the window's top-left pinned to the area's, which is what
      // the unclamped home spot is there, would leave him over two edges.
      host.displays = [display(8, { x: 0, y: 0, width: 230, height: 230 })];
      const fits = createOverlay(fakeStore(), LARGE, BOXES, NO_GAP).win.getBounds();
      expect(inside(fits, LARGE)).toBe(true);
      const ink = drawnInk(fits, LARGE);
      expect({ right: ink.x + ink.width, bottom: ink.y + ink.height }).toEqual({ right: 230, bottom: 230 });

      // Too small for his ink as well: head and front kept, as for Reset.
      host.displays = [display(9, { x: 0, y: 0, width: 200, height: 200 })];
      const pinned = drawnInk(createOverlay(fakeStore(), LARGE, BOXES, NO_GAP).win.getBounds(), LARGE);
      expect({ x: pinned.x, y: pinned.y }).toEqual({ x: 0, y: 0 });
    });

    it('does nothing at ready-to-show but show him when he is inside', () => {
      build();
      host.calls.length = 0;
      ready();
      expect(host.calls).toEqual(['showInactive']);
    });
  });

  /* --------------------------------------------------------------- the drag */

  describe('a drag', () => {
    /** A Medium dog mid-screen, held. */
    function held(): { overlay: ReturnType<typeof createOverlay>; store: WalderStore } {
      const store = storeAt({ x: 600, y: 400 });
      const overlay = createOverlay(store, MEDIUM, BOXES, NO_GAP);
      overlay.dragStart();
      return { overlay, store };
    }
    const inset = inkInset(medium);
    // Where the Medium window is when his ink is flush with each edge.
    const flushLeft = area.x - inset.left;
    const flushRight = right - medium.width + inset.right;
    const flushTop = area.y - inset.top;
    const flushBottom = bottom - medium.height;
    const at = (overlay: ReturnType<typeof createOverlay>): Point => {
      const b = overlay.win.getBounds();
      return { x: b.x, y: b.y };
    };

    it('slides along each of the four edges: the axis across it pinned, the other following', () => {
      const { overlay } = held();
      const steps: [number, number, Point][] = [
        // Past the left edge, the pointer moving down…
        [-5000, 30, { x: flushLeft, y: 430 }],
        [-5000, 80, { x: flushLeft, y: 480 }],
        [-9000, 80, { x: flushLeft, y: 480 }],
        // …the right edge, moving up…
        [5000, 10, { x: flushRight, y: 410 }],
        [5000, -60, { x: flushRight, y: 340 }],
        // …the top, moving right (the bubble reserve hangs above: it is not him)…
        [0, -5000, { x: 600, y: flushTop }],
        [140, -5000, { x: 740, y: flushTop }],
        // …and the bottom, moving left.
        [0, 5000, { x: 600, y: flushBottom }],
        [-200, 5000, { x: 400, y: flushBottom }]
      ];
      for (const [dx, dy, expected] of steps) {
        overlay.dragMove(dx, dy);
        expect(at(overlay), `delta (${dx}, ${dy})`).toEqual(expected);
        expect(inside(overlay.win.getBounds(), MEDIUM), `delta (${dx}, ${dy})`).toBe(true);
      }
      overlay.dragEnd();
    });

    it('is held on both axes at a corner, each of the four', () => {
      const { overlay } = held();
      const corners: [number, number, Point][] = [
        [-5000, -5000, { x: flushLeft, y: flushTop }],
        [5000, -5000, { x: flushRight, y: flushTop }],
        [-5000, 5000, { x: flushLeft, y: flushBottom }],
        [5000, 5000, { x: flushRight, y: flushBottom }]
      ];
      for (const [dx, dy, expected] of corners) {
        overlay.dragMove(dx, dy);
        expect(at(overlay), `delta (${dx}, ${dy})`).toEqual(expected);
      }
      overlay.dragEnd();
    });

    // 2026-11-17 (review): every delta above is thousands of pixels, where
    // the rule this replaced (24 px of him reachable, checked strictly only
    // at the drop) pulled him wholly inside too — with that rule put back in
    // `dragMove` they all still passed. A little way over an edge is where
    // the two differ, and it is the owner's case: he slides, he is not let
    // over and snapped back on release.
    it('is held from the first pixel past an edge: 30 px over each of the four is the edge itself', () => {
      const over: [string, number, number, Point][] = [
        ['left', flushLeft - 600 - 30, 0, { x: flushLeft, y: 400 }],
        ['right', flushRight - 600 + 30, 0, { x: flushRight, y: 400 }],
        ['top', 0, flushTop - 400 - 30, { x: 600, y: flushTop }],
        ['bottom', 0, flushBottom - 400 + 30, { x: 600, y: flushBottom }],
        ['a corner, by one pixel', flushLeft - 600 - 1, flushBottom - 400 + 1, { x: flushLeft, y: flushBottom }]
      ];
      for (const [side, dx, dy, expected] of over) {
        const { overlay, store } = held();
        overlay.dragMove(dx, dy);
        expect(at(overlay), side).toEqual(expected);
        expect(inside(overlay.win.getBounds(), MEDIUM), side).toBe(true);
        // It was the move that held him: the release has nothing to put right.
        host.calls.length = 0;
        overlay.dragEnd();
        expect(host.calls, side).toEqual([]);
        expect(savedAt(store), side).toEqual(expected);
      }
      // And the last pixel before each edge is still his to take.
      const { overlay } = held();
      overlay.dragMove(flushLeft - 600 + 1, flushTop - 400 + 1);
      expect(at(overlay)).toEqual({ x: flushLeft + 1, y: flushTop + 1 });
      overlay.dragMove(flushRight - 600 - 1, flushBottom - 400 - 1);
      expect(at(overlay)).toEqual({ x: flushRight - 1, y: flushBottom - 1 });
      overlay.dragEnd();
    });

    it('picks the pointer up again at the same grab point when it comes back', () => {
      const { overlay } = held();
      overlay.dragMove(-5000, 80);
      overlay.dragMove(-5000, 5000);
      // Back inside: exactly origin plus delta, nothing owed for the time he
      // was held at the edge.
      overlay.dragMove(-20, 80);
      expect(at(overlay)).toEqual({ x: 580, y: 480 });
      overlay.dragMove(0, 0);
      expect(at(overlay)).toEqual({ x: 600, y: 400 });
      overlay.dragEnd();
    });

    it('makes no window call for a move that leaves him where he is held', () => {
      const { overlay } = held();
      overlay.dragMove(-5000, 0);
      host.calls.length = 0;
      host.sent.length = 0;
      // The pointer wanders further outside the screen; he is already at the
      // nearest place he may be.
      overlay.dragMove(-6000, 0);
      overlay.dragMove(-9000, 0);
      overlay.dragMove(-6000, 0);
      expect(host.calls).toEqual([]);
      expect(host.sent).toEqual([]);
      // One call per move that does move him.
      overlay.dragMove(-6000, 5);
      expect(host.calls).toEqual(['move']);
      overlay.dragEnd();
    });

    it('saves the spot he was held at, not the one the pointer asked for', () => {
      const { overlay, store } = held();
      overlay.dragMove(5000, 5000);
      host.calls.length = 0;
      overlay.dragEnd();
      // He was inside already: the drop moves nothing.
      expect(host.calls).toEqual([]);
      expect(savedAt(store)).toEqual({ x: flushRight, y: flushBottom });
      // And a relaunch puts him exactly there.
      createOverlay(store, MEDIUM, BOXES, NO_GAP);
      const relaunched = host.built.at(-1) as Record<string, unknown>;
      expect({ x: relaunched['x'], y: relaunched['y'] }).toEqual({ x: flushRight, y: flushBottom });
    });

    it('a press and release with no move in between (a pet) moves nothing', () => {
      const store = storeAt({ x: 600, y: 400 });
      const overlay = createOverlay(store, MEDIUM, BOXES, NO_GAP);
      host.calls.length = 0;
      overlay.dragStart();
      overlay.dragEnd();
      expect(host.calls).toEqual([]);
      expect(at(overlay)).toEqual({ x: 600, y: 400 });
      expect(savedAt(store)).toEqual({ x: 600, y: 400 });
    });

    /*
     * The correcting move restates the size that was asked, and which size
     * the window has after it is not known: still the DIP too many (it keeps
     * what it was granted, whatever is asked) or the asked one (restating it
     * works). He is put where he is inside under both, so under the first his
     * feet are on the edge and under the second a DIP above it.
     */
    it('the drop corrects a window the last move left over the edge, once, whichever size the correction leaves it', () => {
      for (const keeps of [true, false]) {
        const label = keeps ? 'the window keeps its surplus' : 'the window takes the asked size';
        // Held at the bottom edge; the window system then leaves the window a
        // DIP taller than it was (the 125 % fault), so his feet are a DIP over.
        const { overlay, store } = held();
        overlay.dragMove(0, 5000);
        host.growOnMove = 1;
        overlay.dragMove(10, 5000);
        host.growOnMove = 0;
        const over = overlay.win.getBounds();
        expect(over.y + over.height, label).toBe(bottom + 1);

        if (keeps) host.grant = (asked) => ({ ...asked, height: asked.height + 1 });
        host.calls.length = 0;
        overlay.dragEnd();
        host.grant = null;
        expect(host.calls, label).toEqual(['move']);
        const b = overlay.win.getBounds();
        expect(b.height, label).toBe(medium.height + (keeps ? 1 : 0));
        expect(b.y + b.height, label).toBe(keeps ? bottom : bottom - 1);
        expect(inside(b, MEDIUM), label).toBe(true);
        // The saved spot is reckoned in the window that was *read* at the
        // drop (a DIP taller), moved to where it was asked to go: the resting
        // window with its feet on the edge. That is where the window is if it
        // keeps its surplus. If it takes the asked size it stands a DIP
        // higher than the spot saved for it (asserted above: `bottom - 1`),
        // and a relaunch puts him that DIP lower, on the edge. Known, inside
        // either way, and not reconciled: nothing reads the bounds again.
        expect(savedAt(store), label).toEqual({ x: 610, y: flushBottom });
      }
    });

    /*
     * The fault measured at 125 % on Windows, modelled as if restating the
     * asked size on every move did not help: every move still leaves the
     * window a DIP taller than it was (`host.growOnMove`). Not what `moveTo`
     * is expected to leave — that is the suite after this one — but the cause
     * is a hypothesis until it is seen on screen, so the rule must hold
     * against this too, without fighting it: one call per pointer event, his
     * feet never more than the one step the window system added after the
     * call, and never sinking.
     */
    it('holds the bottom edge against a window that grows on every move, one call per move', () => {
      const { overlay, store } = held();
      host.growOnMove = 1;
      let lastY = Infinity;
      for (let dx = 0; dx <= 300; dx += 10) {
        host.calls.length = 0;
        overlay.dragMove(dx, 5000);
        expect(count('move'), `dx ${dx}`).toBeLessThanOrEqual(1);
        const b = overlay.win.getBounds();
        expect(b.y, `dx ${dx}`).toBeLessThanOrEqual(lastY);
        lastY = b.y;
        const overhang = b.y + b.height - bottom;
        expect(overhang, `dx ${dx}`).toBeLessThanOrEqual(1);
        expect(overhang, `dx ${dx}`).toBeGreaterThanOrEqual(0);
        expect(b.x).toBe(600 + dx);
      }
      host.calls.length = 0;
      overlay.dragEnd();
      // One correction at the drop, and nothing reads the result to try again.
      expect(count('move')).toBe(1);
      const b = overlay.win.getBounds();
      expect(b.y + b.height - bottom).toBeLessThanOrEqual(1);
      // Saved as the resting window with its feet on the edge.
      expect(savedAt(store)).toEqual({ x: 900, y: flushBottom });
    });

    it('measures a window granted larger than asked from its floor and its middle, not its top-left', () => {
      // A window a DIP taller and two wider than its metrics: he stands on its
      // floor, centred. Held against the top-left corner, it is his ink that
      // must be flush with it — the surplus is not dog, so it may hang off.
      // The grant stays for the drag: a move restates the size asked, and this
      // is the window that is given a little more than that every time.
      const { overlay } = held();
      host.grant = (asked) => ({ ...asked, width: asked.width + 2, height: asked.height + 1 });
      overlay.applyBox('sleep');
      overlay.applyBox('stand');
      const grown = overlay.win.getBounds();
      expect({ width: grown.width, height: grown.height }).toEqual({
        width: medium.width + 2,
        height: medium.height + 1
      });
      // During the drag the size the next move will be granted is not known,
      // so he is held where he is inside at any size up to this one: his head
      // as in the window he has metrics for, flush with the corner.
      overlay.dragMove(-5000, -5000);
      const dragged = { ...overlay.win.getBounds() };
      expect({ x: dragged.x + inset.left, y: dragged.y + inset.top }).toEqual({
        x: area.x,
        y: area.y
      });
      expect(inside(dragged, MEDIUM)).toBe(true);
      // …and his feet as in the tallest it has been: against the bottom-right.
      overlay.dragMove(5000, 5000);
      const low = overlay.win.getBounds();
      expect({ right: low.x + low.width - inset.right, bottom: low.y + low.height }).toEqual({
        right,
        bottom
      });
      expect(inside(low, MEDIUM)).toBe(true);
      // The drop measures the window he has, finds him inside, and moves nothing.
      host.calls.length = 0;
      overlay.dragEnd();
      expect(host.calls).toEqual([]);

      // A display event: the work area closes in from the top and the left.
      // Whether he is inside is asked of the window as it stands; the move
      // that puts him back restates the asked size, so he is placed for
      // either size it may then have. This window keeps its surplus, and he
      // ends short of the corner by it — the row above his head, and half of
      // the two columns — never over it.
      overlay.dragStart();
      overlay.dragMove(-5000, -5000);
      overlay.dragEnd();
      DISPLAY.workArea = { x: 40, y: 65, width: area.width - 40, height: area.height - 40 };
      host.calls.length = 0;
      metricsChanged();
      expect(host.calls).toEqual(['move']);
      const kept = overlay.win.getBounds();
      expect({ width: kept.width, height: kept.height }).toEqual({
        width: medium.width + 2,
        height: medium.height + 1
      });
      const ink = drawnInk(kept, MEDIUM);
      expect({ x: ink.x, y: ink.y }).toEqual({ x: 40 + 1, y: 65 + 1 });
      // A fixed point: asked again, nothing.
      host.calls.length = 0;
      metricsChanged();
      expect(host.calls).toEqual([]);
    });

    it('a window larger than asked that takes the asked size at the correction ends flush with the corner', () => {
      // The other outcome of the same correction: the move that restates the
      // size is given exactly it.
      const { overlay } = held();
      host.grant = (asked) => ({ ...asked, width: asked.width + 2, height: asked.height + 1 });
      overlay.applyBox('sleep');
      overlay.applyBox('stand');
      overlay.dragMove(-5000, -5000);
      overlay.dragEnd();
      DISPLAY.workArea = { x: 40, y: 65, width: area.width - 40, height: area.height - 40 };
      host.grant = null;
      host.calls.length = 0;
      metricsChanged();
      expect(host.calls).toEqual(['move']);
      const b = overlay.win.getBounds();
      expect({ width: b.width, height: b.height }).toEqual({
        width: medium.width,
        height: medium.height
      });
      const ink = drawnInk(b, MEDIUM);
      expect({ x: ink.x, y: ink.y }).toEqual({ x: 40, y: 65 });
      host.calls.length = 0;
      metricsChanged();
      expect(host.calls).toEqual([]);
    });

    /*
     * 2026-11-17 (review): `settleFor` at the drop was pinned only at the
     * bottom edge, where measuring him in the window as read and in either
     * size give the same answer. At a top and a side edge they do not: placed
     * flush in the larger window that was read, he is over both edges by the
     * surplus as soon as the move gives it up.
     */
    it('the drop corrects a larger window at a top and a side edge so that he is inside whichever size it is left', () => {
      for (const keeps of [true, false]) {
        const label = keeps ? 'the window keeps its surplus' : 'the window takes the asked size';
        DISPLAY.workArea = area;
        const { overlay, store } = held();
        host.grant = (asked) => ({ ...asked, width: asked.width + 2, height: asked.height + 1 });
        overlay.applyBox('sleep');
        overlay.applyBox('stand');
        overlay.dragMove(-5000, -5000);
        // The work area closes in from the top and the left under the held dog.
        DISPLAY.workArea = { x: 40, y: 65, width: area.width - 40, height: area.height - 65 };
        if (!keeps) host.grant = null;
        host.calls.length = 0;
        overlay.dragEnd();
        host.grant = null;
        expect(host.calls, label).toEqual(['move']);
        expect(host.moves.at(-1), label).toEqual({
          x: 40 - inset.left,
          y: 65 - inset.top,
          width: medium.width,
          height: medium.height
        });
        const b = overlay.win.getBounds();
        const ink = drawnInk(b, MEDIUM);
        // Flush if the surplus is given up; short by it (the row, and half
        // of the two columns) if it is kept. Never over the edge.
        expect({ x: ink.x, y: ink.y }, label).toEqual(keeps ? { x: 41, y: 66 } : { x: 40, y: 65 });
        expect(inside(b, MEDIUM), label).toBe(true);
        expect(savedAt(store), label).toBeDefined();
      }
      DISPLAY.workArea = area;
    });

    it('mid-screen, the same growing window is not hidden: he sinks with it, as before', () => {
      // The rule says where the drift has to stop, not that it is cured.
      const { overlay } = held();
      host.growOnMove = 1;
      for (let dx = 10; dx <= 50; dx += 10) overlay.dragMove(dx, 0);
      const b = overlay.win.getBounds();
      expect(b.y).toBe(400);
      expect(b.height).toBe(medium.height + 5);
      overlay.dragEnd();
    });

    /*
     * The cost of holding him inside under any size the window may be given
     * (2026-11-17, review): the drag measures his head as in a window of its
     * metrics' size, so while the window is larger he stops short of the top
     * edge by all of the surplus. A DIP or two if that is the constant grant
     * measured after a resize; everything it has grown if the window still
     * grows on every move although each restates the asked size
     * (`host.growOnMove` — the model in which `moveTo` cures nothing; with
     * the growth coming from `setPosition` he reaches the edge, in the suite
     * after this one). Pinned as it is — inside, never above the edge — so
     * that changing it is a decision.
     */
    it('under a window that grows on every move he stops short of the top edge by all it has grown, until a resize', () => {
      const { overlay } = held();
      host.growOnMove = 1;
      // 45 moves, all past the click slop (under it he does not move).
      for (let dx = 1; dx <= 45; dx++) overlay.dragMove(dx + CLICK_SLOP_PX, 0);
      expect(overlay.win.getBounds().height).toBe(medium.height + 45);
      overlay.dragMove(45 + CLICK_SLOP_PX, -5000);
      host.growOnMove = 0;
      const top = { ...overlay.win.getBounds() };
      expect({ y: top.y, height: top.height }).toEqual({ y: flushTop, height: medium.height + 46 });
      // Inside, and 46 below the edge he was dragged to: not "a DIP or two".
      expect(rendered(top, MEDIUM).y - area.y).toBe(46);
      expect(coveredByWorkAreas(rendered(top, MEDIUM), [area])).toBe(true);
      // The drop leaves him there (he is inside), and so does the next drag:
      // the window is still as tall.
      host.calls.length = 0;
      overlay.dragEnd();
      overlay.dragStart();
      overlay.dragMove(0, -5000);
      overlay.dragEnd();
      expect(host.calls).toEqual([]);
      // A resize gives the window its metrics' size back, and then he reaches it.
      overlay.applyBubble(30);
      overlay.applyBubble(0);
      expect(overlay.win.getBounds().height).toBe(medium.height);
      overlay.dragStart();
      overlay.dragMove(0, -5000);
      overlay.dragEnd();
      expect(rendered(overlay.win.getBounds(), MEDIUM).y).toBe(area.y);
    });

    it('a bubble arriving while he is held at an edge does not move him', () => {
      const { overlay } = held();
      overlay.dragMove(-5000, 0);
      const inkLeft = overlay.win.getBounds().x + inset.left;
      overlay.applyBubble(40);
      const extra = (overlay.win.getBounds().width - medium.width) / 2;
      expect(extra).toBeGreaterThan(0);
      expect(overlay.win.getBounds().x + extra + inset.left).toBe(inkLeft);
      // The pointer has not moved: the same delta leaves him there.
      host.calls.length = 0;
      overlay.dragMove(-5000, 0);
      expect(host.calls).toEqual([]);
      overlay.dragEnd();
      expect(inside(overlay.win.getBounds(), MEDIUM, 'stand', true)).toBe(true);
    });
  });

  /* ------------------------------------------- moves restate the asked size */

  /*
   * 2026-11-17. On Windows at 125 % the window grew on every step of a drag
   * (Small: 110 x 150 physical px to 847 x 708 in one drag, measured), with
   * every move a `setPosition`. The hypothesis, not yet confirmed on screen:
   * `setPosition` re-applies the size the window reports, which at a
   * fractional scale factor comes back a little too large. So no move is a
   * `setPosition` any more: each restates the size main last *asked* for, in
   * one `setBounds` (`moveTo`).
   *
   * The fake models the hypothesis here: `setPosition` grows the window a DIP
   * each way, `setBounds` gives exactly what is asked. Every test below fails
   * on the code as it was, whose moves were `setPosition` calls.
   */
  describe('every move restates the size that was asked (the growth at 125 %)', () => {
    const sleeping = boxMetrics(MEDIUM, BOXES.sleep, false, 0);
    const sizeOf = (r: Rect): { width: number; height: number } => ({
      width: r.width,
      height: r.height
    });
    const mediumSize = { width: medium.width, height: medium.height };
    const smallSize = { width: small.width, height: small.height };

    beforeEach(() => {
      DISPLAY.scaleFactor = 1.25;
      host.growOnSetPosition = 1;
    });

    it('no path calls setPosition: a drag, the drop, a re-clamp, the correction after a resize, a Reset', () => {
      const overlay = createOverlay(storeAt({ x: 600, y: 400 }), MEDIUM, BOXES, NO_GAP);
      const spy = vi.spyOn(overlay.win, 'setPosition');
      const setBounds = vi.spyOn(overlay.win, 'setBounds');
      /** Run one path; it made exactly `expected`, and every move had the asked size. */
      const path = (name: string, expected: string[], act: () => void): void => {
        host.calls.length = 0;
        host.moves.length = 0;
        act();
        expect(host.calls, name).toEqual(expected);
        expect(spy, name).not.toHaveBeenCalled();
      };

      // A drag: one call per move, each the position and the asked size.
      overlay.dragStart();
      path('a drag', ['move', 'move', 'move'], () => {
        overlay.dragMove(40, 0);
        overlay.dragMove(40, 30);
        overlay.dragMove(40, 5000);
      });
      expect(host.moves.map(sizeOf)).toEqual([mediumSize, mediumSize, mediumSize]);
      expect(setBounds).toHaveBeenLastCalledWith({
        x: 640,
        y: bottom - medium.height,
        ...mediumSize
      });

      // The drop's correction: the last move leaves the window a DIP taller,
      // his feet a DIP over the edge.
      host.growOnMove = 1;
      overlay.dragMove(50, 5000);
      host.growOnMove = 0;
      path('the drop', ['move'], () => overlay.dragEnd());
      expect(host.moves.map(sizeOf)).toEqual([mediumSize]);

      // A re-clamp: a taskbar appears under him.
      DISPLAY.workArea = { ...area, height: area.height - 48 };
      path('a re-clamp', ['move'], () => metricsChanged());
      expect(host.moves.map(sizeOf)).toEqual([mediumSize]);
      DISPLAY.workArea = area;

      // The correction after a resize: at the bottom edge, granted 2 taller.
      overlay.dragStart();
      overlay.dragMove(0, 5000);
      overlay.dragEnd();
      host.grant = (asked) => ({ ...asked, height: asked.height + 2 });
      path('the correction after a resize', ['setBounds', 'move'], () => overlay.applyBox('sleep'));
      host.grant = null;
      expect(host.moves.map(sizeOf)).toEqual([{ width: sleeping.width, height: sleeping.height }]);

      // A wake that finds him outside (the work area shrank with no event).
      DISPLAY.workArea = { ...area, height: area.height - 48 };
      path('a wake', ['move'], () => overlay.revalidatePosition());
      DISPLAY.workArea = area;

      // Reset.
      path('a Reset', ['move'], () => overlay.resetPosition());
      expect(host.moves.map(sizeOf)).toEqual([{ width: sleeping.width, height: sleeping.height }]);
      expect(sizeOf(overlay.win.getBounds())).toEqual({
        width: sleeping.width,
        height: sleeping.height
      });
    });

    it('a long drag leaves the window the size that was asked, and he reaches the top edge flush', () => {
      const store = storeAt({ x: 600, y: 400 });
      const overlay = createOverlay(store, MEDIUM, BOXES, NO_GAP);
      overlay.dragStart();
      for (let dx = CLICK_SLOP_PX; dx <= 300; dx++) {
        host.calls.length = 0;
        overlay.dragMove(dx, 0);
        expect(host.calls, `dx ${dx}`).toEqual(['move']);
        expect(overlay.win.getBounds(), `dx ${dx}`).toEqual({ x: 600 + dx, y: 400, ...mediumSize });
      }
      // To the top edge: his drawn head on it, not short of it by what the
      // window grew during the drag — it did not grow.
      overlay.dragMove(300, -5000);
      const top = { ...overlay.win.getBounds() };
      expect(sizeOf(top)).toEqual(mediumSize);
      const head = rendered(top, MEDIUM).y;
      expect(head).toBeGreaterThanOrEqual(area.y);
      expect(head).toBeLessThan(area.y + 1);
      // The pointer further out moves nothing, and nor does the drop.
      host.calls.length = 0;
      overlay.dragMove(300, -9000);
      overlay.dragEnd();
      expect(host.calls).toEqual([]);
      expect(overlay.win.getBounds()).toEqual(top);
      expect(savedAt(store)).toEqual({ x: top.x, y: top.y });
    });

    it('a drag after a bubble or a box change moves the window at the size that change asked for', () => {
      const overlay = createOverlay(storeAt({ x: 600, y: 400 }), MEDIUM, BOXES, NO_GAP);
      // A bubble up before the press: the window is wider, and so is the move.
      overlay.applyBubble(30);
      const widened = sizeOf(overlay.win.getBounds());
      expect(widened.width).toBeGreaterThan(medium.width);
      overlay.dragStart();
      overlay.dragMove(10, 10);
      expect(sizeOf(host.moves.at(-1) as Rect)).toEqual(widened);
      expect(sizeOf(overlay.win.getBounds())).toEqual(widened);

      // The bubble clears under the held dog: the next move is the plain size.
      overlay.applyBubble(0);
      overlay.dragMove(20, 20);
      expect(sizeOf(host.moves.at(-1) as Rect)).toEqual(mediumSize);
      expect(sizeOf(overlay.win.getBounds())).toEqual(mediumSize);

      // He curls up mid-drag: the sleeping box's.
      overlay.applyBox('sleep');
      overlay.dragMove(30, 30);
      expect(sizeOf(host.moves.at(-1) as Rect)).toEqual({
        width: sleeping.width,
        height: sleeping.height
      });
      overlay.dragEnd();
      expect(sizeOf(overlay.win.getBounds())).toEqual({
        width: sleeping.width,
        height: sleeping.height
      });

      // And a size change after the drop: the next drag moves the Large window.
      overlay.applyBox('stand');
      overlay.applySize(LARGE);
      overlay.dragStart();
      overlay.dragMove(-5, -5);
      overlay.dragEnd();
      expect(sizeOf(host.moves.at(-1) as Rect)).toEqual({ width: large.width, height: large.height });
      expect(sizeOf(overlay.win.getBounds())).toEqual({ width: large.width, height: large.height });
    });

    it('after a drag, size round trips, a sleep and a wake, a bark and an unlock do not move him', () => {
      const store = storeAt({ x: 600, y: 400 });
      const overlay = createOverlay(store, SMALL, BOXES, NO_GAP);
      // Dragged a little way first: on the code as it was those moves left
      // the window taller, and each resize after carried its floor down.
      overlay.dragStart();
      for (let step = 1; step <= 12; step++) overlay.dragMove(step * 3, step * 2);
      overlay.dragEnd();
      const home = { x: 636, y: 424, ...smallSize };
      expect(overlay.win.getBounds()).toEqual(home);

      for (let round = 0; round < 3; round++) {
        overlay.applySize(LARGE);
        overlay.applySize(MEDIUM);
        overlay.applySize(SMALL);
        expect(overlay.win.getBounds(), `sizes, round ${round}`).toEqual(home);
        overlay.applyBox('sleep');
        overlay.applyBox('stand');
        expect(overlay.win.getBounds(), `sleep and wake, round ${round}`).toEqual(home);
        overlay.applyBubble(30);
        overlay.applyBubble(0);
        expect(overlay.win.getBounds(), `a bark, round ${round}`).toEqual(home);
        // The machine wakes or is unlocked: he is inside, so nothing at all.
        host.calls.length = 0;
        overlay.revalidatePosition();
        metricsChanged();
        expect(host.calls, `a wake, round ${round}`).toEqual([]);
      }
      expect(savedAt(store)).toEqual({ x: home.x, y: home.y });
    });

    /*
     * The no-op test of `dragMove`. A window that is where the pointer wants
     * it but not the size that was asked gets the size restated — once: the
     * same rect is not asked for twice running, so a window system that
     * answers it with another size again is not chased.
     */
    it('restates the size of a window found larger where the pointer already holds it, once and no more', () => {
      const overlay = createOverlay(storeAt({ x: 600, y: 400 }), MEDIUM, BOXES, NO_GAP);
      overlay.dragStart();
      overlay.dragMove(10, 0);
      // Something other than this file leaves the window elsewhere and
      // larger: `setPosition` called on the window here, as the code that was
      // would have, three times.
      for (const x of [611, 612, 613]) overlay.win.setPosition(x, 400);
      host.calledSetPosition = false;
      expect(overlay.win.getBounds()).toEqual({
        x: 613,
        y: 400,
        width: medium.width + 3,
        height: medium.height + 3
      });

      // The pointer asks for exactly where it is: the size is put right.
      host.calls.length = 0;
      overlay.dragMove(13, 0);
      expect(host.calls).toEqual(['move']);
      expect(overlay.win.getBounds()).toEqual({ x: 613, y: 400, ...mediumSize });
      // Nothing more for the same pointer position.
      overlay.dragMove(13, 0);
      overlay.dragMove(13, 0);
      expect(host.calls).toEqual(['move']);

      // A window system that gives it the larger size again whatever is
      // asked: one call for the new place, and then none.
      host.grant = (asked) => ({ ...asked, height: asked.height + 2 });
      host.calls.length = 0;
      overlay.dragMove(14, 0);
      expect(host.calls).toEqual(['move']);
      expect(overlay.win.getBounds().height).toBe(medium.height + 2);
      for (let i = 0; i < 5; i++) overlay.dragMove(14, 0);
      expect(host.calls).toEqual(['move']);
      overlay.dragEnd();
    });
  });

  /* --------------------------------------- the rest of what moveTo relies on */

  /*
   * 2026-11-17 (review): three parts of the no-`setPosition` change that no
   * test held, and a model of the hypothesis itself.
   */
  describe('moves that restate the asked size: the no-op rule and the sizes a drag allows for', () => {
    const mediumSize = { width: medium.width, height: medium.height };

    it('a window read back smaller than asked is held at the bottom-right corner as large as the move will ask it to be', () => {
      const overlay = createOverlay(storeAt({ x: 600, y: 400 }), MEDIUM, BOXES, NO_GAP);
      host.grant = (asked) => ({ ...asked, width: asked.width - 2, height: asked.height - 1 });
      overlay.applyBox('sleep');
      overlay.applyBox('stand');
      host.grant = null;
      expect(overlay.win.getBounds()).toMatchObject({ width: medium.width - 2, height: medium.height - 1 });
      overlay.dragStart();
      overlay.dragMove(5000, 5000);
      // The move restated the asked size and was given it: his feet and his
      // side are on the edges, not past them as they would be had the drag
      // been laid out in the smaller window that was read.
      const b = { ...overlay.win.getBounds() };
      expect(b).toEqual({
        x: right - medium.width + inkInset(medium).right,
        y: bottom - medium.height,
        ...mediumSize
      });
      overlay.dragEnd();
    });

    it('a resize under a held dog counts as the last thing asked: the same pointer position asks nothing more', () => {
      const overlay = createOverlay(storeAt({ x: 600, y: 400 }), MEDIUM, BOXES, NO_GAP);
      overlay.dragStart();
      overlay.dragMove(10, 10);
      // A bubble arrives mid-drag and the window is given 2 DIP more height
      // than the resize asked: where the pointer holds it, not the asked size.
      host.grant = (asked) => ({ ...asked, height: asked.height + 2 });
      overlay.applyBubble(30);
      const b = { ...overlay.win.getBounds() };
      host.calls.length = 0;
      for (let i = 0; i < 3; i++) overlay.dragMove(10, 10);
      // The system has answered that very rect already; it is not chased.
      expect(host.calls).toEqual([]);
      expect(overlay.win.getBounds()).toEqual(b);
      overlay.dragEnd();
    });

    it('a window that is the asked size where the pointer wants it is left alone, wherever it was last asked to be', () => {
      const overlay = createOverlay(storeAt({ x: 600, y: 400 }), MEDIUM, BOXES, NO_GAP);
      overlay.dragStart();
      // The system places the window a DIP left of where it is asked to be.
      host.grant = (asked) => ({ ...asked, x: asked.x - 1 });
      overlay.dragMove(10, 0);
      expect(overlay.win.getBounds()).toEqual({ x: 609, y: 400, ...mediumSize });
      // The pointer comes back that DIP: he is there already, at the size
      // asked. Asking would only move him another DIP left.
      host.calls.length = 0;
      overlay.dragMove(9, 0);
      expect(host.calls).toEqual([]);
      expect(overlay.win.getBounds().x).toBe(609);
      overlay.dragEnd();
    });

    /*
     * The hypothesis, modelled. **An assumption about Chromium, not checked
     * against its source and not seen on screen**: at 125 % a DIP rect is
     * turned into the whole physical pixels that enclose it, and read back as
     * the whole DIPs that enclose those. It reproduces what was measured
     * after a resize (88 x 120 asked, 121–122 read back). Under it a
     * `setPosition` — the position, with the size read back — grows the
     * window step after step, and a move that restates the asked size cannot:
     * what the window is given depends on where it is and on nothing before.
     */
    describe('under enclosing-pixel rounding at 125 % (a model)', () => {
      const enclose = (r: Rect): Rect => {
        const f = 1.25;
        const left = Math.floor(r.x * f);
        const top = Math.floor(r.y * f);
        const x = Math.floor(left / f);
        const y = Math.floor(top / f);
        return {
          x,
          y,
          width: Math.ceil(Math.ceil((r.x + r.width) * f) / f) - x,
          height: Math.ceil(Math.ceil((r.y + r.height) * f) / f) - y
        };
      };
      beforeEach(() => {
        DISPLAY.scaleFactor = 1.25;
        host.grant = enclose;
      });

      it('the model: 300 moves by setPosition grow the window, as measured', () => {
        const overlay = createOverlay(storeAt({ x: 600, y: 400 }), MEDIUM, BOXES, NO_GAP);
        for (let step = 1; step <= 300; step++) overlay.win.setPosition(600 + step, 400 + (step % 50));
        host.calledSetPosition = false;
        const b = overlay.win.getBounds();
        expect(b.width).toBeGreaterThan(medium.width + 100);
        expect(b.height).toBeGreaterThan(medium.height + 100);
      });

      it('300 steps of a drag: the window is never more than the rounding of where it is', () => {
        const overlay = createOverlay(storeAt({ x: 600, y: 400 }), MEDIUM, BOXES, NO_GAP);
        overlay.dragStart();
        for (let step = CLICK_SLOP_PX; step <= 300; step++) {
          overlay.dragMove(step, step % 50);
          const b = overlay.win.getBounds();
          expect(b, `step ${step}`).toEqual(enclose(host.moves.at(-1) as Rect));
          expect(b.width - medium.width, `step ${step}`).toBeLessThanOrEqual(2);
          expect(b.height - medium.height, `step ${step}`).toBeLessThanOrEqual(2);
        }
        overlay.dragEnd();
      });

      it('after that drag, rounds of size, sleep and bark do not carry him further each time', () => {
        const overlay = createOverlay(storeAt({ x: 601, y: 401 }), MEDIUM, BOXES, NO_GAP);
        overlay.dragStart();
        for (let step = 1; step <= 40; step++) overlay.dragMove(step * 7, step);
        overlay.dragEnd();
        const round = (): Rect => {
          overlay.applySize(LARGE);
          overlay.applySize(MEDIUM);
          overlay.applyBox('sleep');
          overlay.applyBox('stand');
          overlay.applyBubble(30);
          overlay.applyBubble(0);
          return { ...overlay.win.getBounds() };
        };
        // The first round may move him by the rounding of where the drag
        // left him (the resize anchors on bounds read back, which this
        // change does not touch); after it, nothing.
        const first = round();
        expect(round()).toEqual(first);
        expect(round()).toEqual(first);
        // And a Reset asks for the same rect each time.
        overlay.resetPosition();
        const asked = { ...(host.moves.at(-1) as Rect) };
        overlay.resetPosition();
        overlay.resetPosition();
        expect(host.moves.at(-1)).toEqual(asked);
      });
    });
  });

  /* ------------------------------- a read-back larger than the window (125 %) */

  /*
   * 2026-11-18. The hypothesis for the growth at 125 %, in its two halves:
   * `getBounds` reads the window back a DIP or two larger than it is (the
   * enclosing DIP rect of a physical rect whose origin is not a multiple of
   * the scale), and Electron's `setPosition` re-applies the size it reads, so
   * every `setPosition` makes the surplus permanent and the next read adds
   * to it. The fake models both (`readSurplus`, `readGrowth`, and its
   * `setPosition`). A move made with `setBounds` and the size main *asked*
   * for has nothing to accumulate in. Every test here fails on the code as it
   * was, whose moves were `setPosition` calls.
   */
  describe('a read-back larger than the window: moves pass the asked size, never a size read', () => {
    const mediumSize = { width: medium.width, height: medium.height };
    const sizeOf = (r: Rect): { width: number; height: number } => ({
      width: r.width,
      height: r.height
    });
    /** The window as it really is, past the fake's inflated read-back. */
    const trueBounds = (overlay: ReturnType<typeof createOverlay>): Rect => {
      const surplus = host.readSurplus;
      const growth = host.readGrowth;
      host.readSurplus = 0;
      host.readGrowth = 0;
      const b = { ...overlay.win.getBounds() };
      host.readSurplus = surplus;
      host.readGrowth = growth;
      return b;
    };

    beforeEach(() => {
      DISPLAY.scaleFactor = 1.25;
    });

    it('the model: under a read-back 1 DIP too large, 40 setPosition calls grow the window by 40', () => {
      // What the code did before this change, one `setPosition` per pointer
      // event, called on the window directly to show what the fake stands for.
      const overlay = createOverlay(storeAt({ x: 81, y: 81 }), MEDIUM, BOXES, NO_GAP);
      host.readSurplus = 1;
      for (let i = 0; i < 40; i++) overlay.win.setPosition(81 + i * 3, 81 + i * 2);
      host.calledSetPosition = false;
      expect(sizeOf(trueBounds(overlay))).toEqual({
        width: medium.width + 40,
        height: medium.height + 40
      });
    });

    it('a drag never calls setPosition, and every move is one setBounds with the asked size although getBounds reads 1–2 DIP more', () => {
      for (const surplus of [1, 2]) {
        const overlay = createOverlay(storeAt({ x: 600, y: 400 }), MEDIUM, BOXES, NO_GAP);
        const setPosition = vi.spyOn(overlay.win, 'setPosition');
        const setBounds = vi.spyOn(overlay.win, 'setBounds');
        host.readSurplus = surplus;
        expect(sizeOf(overlay.win.getBounds()), `+${surplus}`).toEqual({
          width: medium.width + surplus,
          height: medium.height + surplus
        });
        overlay.dragStart();
        // From step 2: step 1 is 3.6 px from the press, under the click slop.
        for (let step = 2; step <= 40; step++) {
          host.calls.length = 0;
          overlay.dragMove(step * 3, step * 2);
          expect(host.calls, `+${surplus}, step ${step}`).toEqual(['move']);
          expect(setBounds, `+${surplus}, step ${step}`).toHaveBeenLastCalledWith({
            x: 600 + step * 3,
            y: 400 + step * 2,
            ...mediumSize
          });
        }
        overlay.dragEnd();
        expect(setPosition, `+${surplus}`).not.toHaveBeenCalled();
        expect(setBounds, `+${surplus}`).toHaveBeenCalledTimes(39);
        // The window is the size that was asked; only the reading is larger.
        expect(trueBounds(overlay), `+${surplus}`).toEqual({ x: 720, y: 480, ...mediumSize });
        host.readSurplus = 0;
      }
    });

    it('over a long drag under a read-back that grows on every read, the size passed to setBounds never grows', () => {
      const overlay = createOverlay(storeAt({ x: 100, y: 100 }), MEDIUM, BOXES, NO_GAP);
      const setPosition = vi.spyOn(overlay.win, 'setPosition');
      const setBounds = vi.spyOn(overlay.win, 'setBounds');
      host.readGrowth = 1;
      overlay.dragStart();
      const steps = 200;
      // From step 2: step 1 is 3.2 px from the press, under the click slop.
      for (let step = 2; step <= steps; step++) {
        host.calls.length = 0;
        const dx = step;
        const dy = (step * 3) % 40;
        overlay.dragMove(dx, dy);
        expect(host.calls, `step ${step}`).toEqual(['move']);
        expect(host.moves.at(-1), `step ${step}`).toEqual({ x: 100 + dx, y: 100 + dy, ...mediumSize });
      }
      overlay.dragEnd();
      // The reading really did grow, by hundreds of DIP...
      expect(overlay.win.getBounds().width).toBeGreaterThan(medium.width + steps);
      // ...and not one call passed it on.
      expect(setPosition).not.toHaveBeenCalled();
      expect(setBounds).toHaveBeenCalledTimes(steps - 1);
      for (const [rect] of setBounds.mock.calls) {
        expect({ width: rect.width, height: rect.height }).toEqual(mediumSize);
      }
      expect(sizeOf(trueBounds(overlay))).toEqual(mediumSize);
    });

    it('he is still held inside the screen at every edge and corner, and the drop keeps him there', () => {
      const surplus = 2;
      for (const [dx, dy] of [
        [-5000, 0],
        [5000, 0],
        [0, -5000],
        [0, 5000],
        [-5000, -5000],
        [5000, -5000],
        [-5000, 5000],
        [5000, 5000]
      ] as const) {
        const label = `${dx}, ${dy}`;
        const store = storeAt({ x: 600, y: 400 });
        const overlay = createOverlay(store, MEDIUM, BOXES, NO_GAP);
        host.readSurplus = surplus;
        overlay.dragStart();
        host.calls.length = 0;
        overlay.dragMove(dx, dy);
        expect(host.calls, label).toEqual(['move']);
        expect(sizeOf(host.moves.at(-1) as Rect), label).toEqual(mediumSize);
        const held = trueBounds(overlay);
        expect(inside(held, MEDIUM), label).toBe(true);
        // Short of the edge pushed against by no more than the surplus read
        // (and the one whole DIP the measure is rounded by).
        const ink = drawnInk(held, MEDIUM, 'stand', false, DISPLAY.scaleFactor);
        if (dx < 0) expect(ink.x - area.x, label).toBeLessThanOrEqual(surplus + 1);
        if (dx > 0) expect(right - (ink.x + ink.width), label).toBeLessThanOrEqual(surplus + 1);
        if (dy < 0) expect(ink.y - area.y, label).toBeLessThanOrEqual(surplus + 1);
        if (dy > 0) expect(bottom - (ink.y + ink.height), label).toBeLessThanOrEqual(surplus + 1);
        // The pointer further out asks nothing more.
        host.calls.length = 0;
        overlay.dragMove(dx * 2, dy * 2);
        expect(host.calls, label).toEqual([]);
        overlay.dragEnd();
        expect(count('move'), label).toBeLessThanOrEqual(1);
        expect(inside(trueBounds(overlay), MEDIUM), label).toBe(true);
        expect(savedAt(store), label).toBeDefined();
        host.readSurplus = 0;
      }
    });
  });

  /* ---------------------------------------------------------- Reset position */

  describe('Reset position', () => {
    it('is the home corner, untouched by the clamp, at every size, box and bubble', () => {
      for (const scale of [SMALL, MEDIUM, LARGE]) {
        for (const boxName of ['stand', 'sleep', 'lie'] as const) {
          for (const columns of [0, 30]) {
            const label = `scale ${scale} ${boxName} columns ${columns}`;
            const store = storeAt({ x: 300, y: 300 });
            const overlay = createOverlay(store, scale, BOXES, NO_GAP);
            overlay.applyBox(boxName);
            overlay.applyBubble(columns);
            overlay.resetPosition();
            const rest = boxMetrics(scale, BOXES.stand, true, 0);
            expect(savedAt(store), label).toEqual({
              x: right - rest.width - 16,
              y: bottom - rest.height - 16
            });
            expect(inside(overlay.win.getBounds(), scale, boxName, columns > 0), label).toBe(true);
          }
        }
      }
    });

    /*
     * 2026-11-17 (review). Reset reckoned the window's top from the height
     * read back and then moved with the height asked: a window read 2 DIP
     * taller whose move gave them up ended 2 DIP above home, and repeated
     * Resets wandered. It asks for the same rect every time now: the resting
     * window at home, in the size that was asked.
     */
    it('asks for home in the size that was asked, however tall the window was read, and again the same', () => {
      const home = { x: right - medium.width - 16, y: bottom - medium.height - 16 };
      for (const keeps of [true, false]) {
        const label = keeps ? 'the window keeps its surplus' : 'the window takes the asked size';
        const store = storeAt({ x: 600, y: 400 });
        const overlay = createOverlay(store, MEDIUM, BOXES, NO_GAP);
        host.grant = (asked) => ({ ...asked, height: asked.height + 2 });
        overlay.applyBox('sleep');
        overlay.applyBox('stand');
        expect(overlay.win.getBounds().height, label).toBe(medium.height + 2);
        if (!keeps) host.grant = null;
        for (const round of [1, 2, 3]) {
          host.calls.length = 0;
          overlay.resetPosition();
          expect(host.calls, `${label}, Reset ${round}`).toEqual(['move']);
          expect(host.moves.at(-1), `${label}, Reset ${round}`).toEqual({
            ...home,
            width: medium.width,
            height: medium.height
          });
          const b = overlay.win.getBounds();
          // His feet on home's floor, or below it by the surplus that stays.
          expect(b.y + b.height, `${label}, Reset ${round}`).toBe(bottom - 16 + (keeps ? 2 : 0));
          expect(inside(b, MEDIUM), label).toBe(true);
          expect(savedAt(store), label).toEqual(home);
        }
        host.grant = null;
      }
    });

    it('on a display he does not fit, a window read taller is placed for either size the Reset leaves it', () => {
      for (const keeps of [true, false]) {
        const label = keeps ? 'the window keeps its surplus' : 'the window takes the asked size';
        host.displays = [display(7, { x: 0, y: 0, width: 200, height: 200 })];
        const overlay = createOverlay(fakeStore(), LARGE, BOXES, NO_GAP);
        host.grant = (asked) => ({ ...asked, height: asked.height + 2 });
        overlay.applyBox('sleep');
        overlay.applyBox('stand');
        expect(overlay.win.getBounds().height, label).toBe(large.height + 2);
        if (!keeps) host.grant = null;
        overlay.resetPosition();
        host.grant = null;
        // His head on the top edge, or below it by the surplus: never above.
        const ink = drawnInk(overlay.win.getBounds(), LARGE);
        expect({ x: ink.x, y: ink.y }, label).toEqual({ x: 0, y: keeps ? 2 : 0 });
      }
    });

    it('lands inside on a display the window does not fit, his head and front kept', () => {
      // A work area smaller than a Large dog both ways: nothing fits, so the
      // fallback of the rule applies — the top-left of his ink on the area's.
      const tiny = display(7, { x: 0, y: 0, width: 200, height: 200 });
      host.displays = [tiny];
      const overlay = createOverlay(fakeStore(), LARGE, BOXES, NO_GAP);
      overlay.resetPosition();
      const b = overlay.win.getBounds();
      const ink = drawnInk(b, LARGE);
      expect({ x: ink.x, y: ink.y }).toEqual({ x: 0, y: 0 });
      // Stable: nothing that re-validates it moves him again.
      host.calls.length = 0;
      overlay.revalidatePosition();
      metricsChanged();
      expect(host.calls).toEqual([]);
    });
  });

  /* ------------------------------------------------- size, box and bubble */

  describe('a resize', () => {
    it('keeps a dog standing in each corner inside through every size, box and bubble', () => {
      const corners = [
        { x: -5000, y: -5000 },
        { x: 5000, y: -5000 },
        { x: -5000, y: 5000 },
        { x: 5000, y: 5000 }
      ];
      for (const corner of corners) {
        const store = storeAt(corner);
        const overlay = createOverlay(store, SMALL, BOXES, NO_GAP);
        const label = JSON.stringify(corner);
        expect(inside(overlay.win.getBounds(), SMALL), label).toBe(true);
        let scale = SMALL;
        const check = (boxName: keyof typeof BOXES, bubble: boolean, what: string): void => {
          expect(inside(overlay.win.getBounds(), scale, boxName, bubble), `${label} ${what}`).toBe(
            true
          );
        };
        for (const next of [LARGE, MEDIUM, SMALL, LARGE]) {
          overlay.applySize(next);
          scale = next;
          check('stand', false, `size ${next}`);
          overlay.applyBubble(39);
          check('stand', true, `size ${next} barking`);
          overlay.applyBubble(0);
          check('stand', false, `size ${next} quiet again`);
          overlay.applyBox('sleep');
          check('sleep', false, `size ${next} asleep`);
          overlay.applyBubble(3);
          check('sleep', true, `size ${next} zzz`);
          overlay.applyBubble(0);
          overlay.applyBox('lie');
          check('lie', false, `size ${next} lying`);
          overlay.applyBox('stand');
          check('stand', false, `size ${next} standing again`);
        }
      }
    });

    it('a bark does not move a dog whose ink is flush with an edge', () => {
      // The bubble path is strict now too, and for a dog who is inside that
      // must be a no-op: he must not hop when he barks.
      const flush = right - large.width + inkInset(large).right;
      const overlay = createOverlay(storeAt({ x: flush, y: 400 }), LARGE, BOXES, NO_GAP);
      host.calls.length = 0;
      overlay.applyBubble(39);
      const b = overlay.win.getBounds();
      expect(b.x + (b.width - large.width) / 2).toBe(flush);
      expect(b.y).toBe(400);
      expect(host.calls).toEqual(['setBounds']);
      overlay.applyBubble(0);
      expect(overlay.win.getBounds()).toEqual({ x: flush, y: 400, width: large.width, height: large.height });
    });

    it('a zzz over a dog asleep against the top edge at 125 % brings the rows it uncovers on screen', () => {
      // The one bubble that moves him. At 125 % a Medium dog is drawn 2.4 px
      // per sprite pixel, taller asleep than his reserve-less window, which
      // clips the top of him. The zzz adds the reserve, the clipped rows are
      // drawn — and they would be above the work area.
      DISPLAY.scaleFactor = 1.25;
      const overlay = createOverlay(storeAt({ x: 600, y: 300 }), MEDIUM, BOXES, NO_GAP);
      overlay.applyBox('sleep');
      overlay.dragStart();
      overlay.dragMove(0, -5000);
      overlay.dragEnd();
      const asleep = { ...overlay.win.getBounds() };
      expect(asleep.y).toBe(area.y);
      expect(inside(asleep, MEDIUM, 'sleep')).toBe(true);

      overlay.applyBubble(3);
      const dreaming = overlay.win.getBounds();
      expect(inside(dreaming, MEDIUM, 'sleep', true)).toBe(true);
      expect(drawnInk(dreaming, MEDIUM, 'sleep', true, 1.25).y).toBe(area.y);
      // Lower than he was, by the rows that were clipped.
      expect(dreaming.y + dreaming.height).toBeGreaterThan(asleep.y + asleep.height);
      overlay.applyBubble(0);
      expect(inside(overlay.win.getBounds(), MEDIUM, 'sleep')).toBe(true);
    });

    /*
     * The grant: at 125 % Windows gives the window a DIP or two more height
     * than was asked. At the bottom edge his feet would be that much past it,
     * so the bounds are read back once and he is moved once — and nothing is
     * read again, so it cannot loop.
     */
    it('at the bottom edge, a window granted taller ends with his feet on the edge: one resize, one move', () => {
      const overlay = createOverlay(storeAt({ x: 600, y: bottom - small.height }), SMALL, BOXES, NO_GAP);
      host.grant = (asked) => ({ ...asked, height: asked.height + 2 });
      for (const columns of [30, 0, 30, 0]) {
        host.calls.length = 0;
        overlay.applyBubble(columns);
        expect(host.calls, `columns ${columns}`).toEqual(['setBounds', 'move']);
        const b = overlay.win.getBounds();
        expect(b.y + b.height, `columns ${columns}`).toBe(bottom);
        expect(inside(b, SMALL, 'stand', columns > 0), `columns ${columns}`).toBe(true);
      }
      // A box change and a size change the same.
      for (const act of [
        (): void => overlay.applyBox('sleep'),
        (): void => overlay.applyBox('stand'),
        (): void => overlay.applySize(MEDIUM)
      ]) {
        host.calls.length = 0;
        act();
        expect(host.calls).toEqual(['setBounds', 'move']);
        const b = overlay.win.getBounds();
        expect(b.y + b.height).toBe(bottom);
      }
    });

    /*
     * 2026-11-17 (review): what that correction leaves behind was asserted
     * nowhere — the saved spot, which decides where he relaunches, and the
     * origin of a drag held through it. Both are laid out in the size that was
     * *asked* (what the metrics and every later resize reckon in) at the
     * top-left he really *has* after the move. So at the bottom edge under a
     * +2 grant the saved resting spot is 2 DIP above the flush one: inside,
     * and the one persistent trace this change adds to the 125 % fault.
     */
    it('saves, after that correction, the top-left he has at the size that was asked', () => {
      const store = storeAt({ x: 600, y: bottom - small.height });
      const overlay = createOverlay(store, SMALL, BOXES, NO_GAP);
      host.grant = (asked) => ({ ...asked, height: asked.height + 2 });

      overlay.applySize(MEDIUM);
      expect(overlay.win.getBounds()).toEqual({
        x: 600,
        y: bottom - medium.height - 2,
        width: medium.width,
        height: medium.height + 2
      });
      expect(savedAt(store)).toEqual({ x: 600, y: bottom - medium.height - 2 });

      // A box change saves the standing window he would wake into from that
      // same top-left: the sleeping window as asked, 2 DIP up.
      overlay.applyBox('sleep');
      const asleep = overlay.win.getBounds();
      expect(asleep.y + asleep.height).toBe(bottom);
      expect(savedAt(store)).toEqual({ x: 600, y: bottom - medium.height - 2 });

      // Where a relaunch puts him: inside, his feet 2 DIP above the edge if
      // the window is then given exactly what is asked.
      host.grant = null;
      const relaunched = createOverlay(store, MEDIUM, BOXES, NO_GAP).win.getBounds();
      expect(relaunched.y + relaunched.height).toBe(bottom - 2);
      expect(inside(relaunched, MEDIUM)).toBe(true);
    });

    it('rebases a drag held through that correction by the move he really made', () => {
      const overlay = createOverlay(storeAt({ x: 600, y: 400 }), MEDIUM, BOXES, NO_GAP);
      const sleeping = boxMetrics(MEDIUM, BOXES.sleep, false, 0);
      overlay.dragStart();
      // Exactly onto the bottom edge, so the pointer is asking for where he is.
      const down = bottom - medium.height - 400;
      overlay.dragMove(0, down);
      expect(overlay.win.getBounds().y + medium.height).toBe(bottom);

      host.grant = (asked) => ({ ...asked, height: asked.height + 2 });
      overlay.applyBox('sleep');
      host.grant = null;
      const asleep = { ...overlay.win.getBounds() };
      expect(asleep).toEqual({
        x: 600,
        y: bottom - sleeping.height - 2,
        width: sleeping.width,
        height: sleeping.height + 2
      });

      // The pointer has not moved: the same delta is where he is.
      host.calls.length = 0;
      overlay.dragMove(0, down);
      expect(host.calls).toEqual([]);
      // One DIP up is one DIP up — not swallowed by an origin left where the
      // window was asked to be, 2 DIP lower than where it is.
      overlay.dragMove(0, down - 1);
      expect(overlay.win.getBounds()).toMatchObject({ x: 600, y: asleep.y - 1 });
      overlay.dragMove(7, down - 10);
      expect(overlay.win.getBounds()).toMatchObject({ x: 607, y: asleep.y - 10 });
      overlay.dragEnd();
    });

    it('mid-screen the same grant moves nothing more, and the drift is not hidden', () => {
      const overlay = createOverlay(storeAt({ x: 600, y: 400 }), SMALL, BOXES, NO_GAP);
      const floor = 400 + small.height;
      host.grant = (asked) => ({ ...asked, height: asked.height + 2 });
      host.calls.length = 0;
      for (const columns of [30, 0, 30]) overlay.applyBubble(columns);
      expect(count('move')).toBe(0);
      expect(count('setBounds')).toBe(3);
      // The known fault, as on unpatched code: 2 DIP down per resize.
      const b = overlay.win.getBounds();
      expect(b.y + b.height).toBe(floor + 6);
    });

    /*
     * 2026-11-17 (review). A window read back taller than its metrics was
     * measured as the metrics' ink with the surplus added above his head.
     * That is right while the box is drawn shorter than the window. Asleep at
     * 125 % Medium he is drawn 139.2 tall in a 116 px window and clipped by
     * it: in a taller window the extra rows are dog, his head is still at the
     * window's top, and a correction at a top edge left it above the edge by
     * the surplus (2 DIP under the measured grant, up to the 23 that were
     * clipped under a window that grows per move).
     */
    describe('a box drawn taller than its window, in a window granted taller (125 %)', () => {
      const sleeping = boxMetrics(MEDIUM, BOXES.sleep, false, 0);
      const lowered = { ...area, y: area.y + 40, height: area.height - 40 };
      /**
       * Asleep at 125 % Medium, in a window `surplus` DIP taller than asked,
       * against the top edge. The grant is left on: the drag's moves restate
       * the asked size, and this is the window that is given `surplus` more
       * whatever is asked. The caller takes it off, or not.
       */
      function asleepAtTheTop(surplus: number): ReturnType<typeof createOverlay> {
        DISPLAY.scaleFactor = 1.25;
        const overlay = createOverlay(storeAt({ x: 600, y: 300 }), MEDIUM, BOXES, NO_GAP);
        host.grant = (asked) => ({ ...asked, height: asked.height + surplus });
        overlay.applyBox('sleep');
        overlay.dragStart();
        overlay.dragMove(0, -5000);
        overlay.dragEnd();
        const b = overlay.win.getBounds();
        expect(b.height, `+${surplus}`).toBe(sleeping.height + surplus);
        expect(rendered(b, MEDIUM, 'sleep').y, `+${surplus}`).toBeGreaterThanOrEqual(area.y);
        return overlay;
      }

      it('a taskbar arriving at the top puts his drawn head on the new edge, whatever the window was granted', () => {
        // 0 is the window as asked; 2 the measured grant; 23 the last surplus
        // at which he is still clipped; from 24 the window is taller than he
        // is drawn and the rest of it really is air above him.
        // Both outcomes of the correcting move, which restates the asked
        // size: the window keeps its surplus, or takes the size asked.
        for (const keeps of [true, false]) {
          for (const surplus of [0, 1, 2, 10, 23, 24, 30, 45]) {
            const label = `+${surplus}, ${keeps ? 'kept' : 'given up'}`;
            host.screenListeners.length = 0;
            DISPLAY.workArea = area;
            const overlay = asleepAtTheTop(surplus);
            if (!keeps) host.grant = null;
            DISPLAY.workArea = lowered;
            host.calls.length = 0;
            metricsChanged();
            expect(host.calls, label).toEqual(['move']);
            const b = overlay.win.getBounds();
            expect(b.height, label).toBe(sleeping.height + (keeps ? surplus : 0));
            const head = rendered(b, MEDIUM, 'sleep').y;
            // On the edge: not above it, and less than the one whole DIP the
            // measure is rounded by below it — while the window is no taller
            // than he is drawn. In one that stays taller than that (from 24)
            // the rows above him are air, and he is placed as if they could
            // be dog (the window may be the asked size after the move): below
            // the edge by that air, never above it.
            const air = keeps ? Math.max(0, surplus - 23) : 0;
            expect(head, label).toBeGreaterThanOrEqual(lowered.y);
            expect(head, label).toBeLessThan(lowered.y + 1 + air);
            // Pinned, not only bounded (2026-11-17, review: the band above is
            // up to 22 DIP wide for a large surplus kept). The window's top
            // is on the edge under every surplus and both outcomes, and the
            // head is where the renderer draws it in a window of that height
            // standing there.
            expect(b.y, label).toBe(lowered.y);
            expect(head, label).toBe(
              rendered({ ...b, y: lowered.y, height: sleeping.height + (keeps ? surplus : 0) }, MEDIUM, 'sleep').y
            );
            if (air > 0) expect(head - lowered.y, label).toBeGreaterThan(air - 1);
            expect(coveredByWorkAreas(rendered(b, MEDIUM, 'sleep'), [lowered]), label).toBe(true);
            // A fixed point: asked again by anything, he is where he should be.
            host.calls.length = 0;
            metricsChanged();
            overlay.revalidatePosition();
            expect(host.calls, label).toEqual([]);
            host.grant = null;
          }
        }
      });

      it('the same under a window that grows on every move, and a Reset and a wake measure him the same way', () => {
        for (const moves of [3, 10, 22, 30, 45]) {
          host.screenListeners.length = 0;
          DISPLAY.workArea = area;
          DISPLAY.scaleFactor = 1.25;
          const overlay = createOverlay(storeAt({ x: 600, y: 300 }), MEDIUM, BOXES, NO_GAP);
          overlay.applyBox('sleep');
          host.growOnMove = 1;
          overlay.dragStart();
          for (let dx = 1; dx <= moves; dx++) overlay.dragMove(dx + CLICK_SLOP_PX, 0);
          overlay.dragMove(moves + CLICK_SLOP_PX, -5000);
          overlay.dragEnd();
          expect(overlay.win.getBounds().height, `${moves} moves`).toBeGreaterThan(sleeping.height + moves);

          DISPLAY.workArea = lowered;
          metricsChanged();
          host.growOnMove = 0;
          const b = overlay.win.getBounds();
          expect(rendered(b, MEDIUM, 'sleep').y, `${moves} moves`).toBeGreaterThanOrEqual(lowered.y);
          expect(coveredByWorkAreas(rendered(b, MEDIUM, 'sleep'), [lowered]), `${moves} moves`).toBe(true);
          host.calls.length = 0;
          overlay.revalidatePosition();
          expect(host.calls, `${moves} moves`).toEqual([]);
        }
      });

      it('a zzz over him there brings the rows it uncovers on screen, in the window it is given', () => {
        // The zzz adds the reserve, so the box is no longer clipped and the
        // rows that were are drawn: they have to come down onto the screen
        // (the one bubble that moves him). Asked for with his head on the
        // edge; the window is then granted 2 DIP taller and he stands on its
        // floor, so head and feet are both 2 DIP lower — the known sink, which
        // the rule does not hide. What it must not be is above the edge.
        const overlay = asleepAtTheTop(2);
        host.grant = (asked) => ({ ...asked, height: asked.height + 2 });
        host.calls.length = 0;
        overlay.applyBubble(3);
        host.grant = null;
        expect(host.calls).toEqual(['setBounds']);
        const dreaming = overlay.win.getBounds();
        const head = rendered(dreaming, MEDIUM, 'sleep').y;
        expect(head).toBeGreaterThanOrEqual(area.y);
        expect(head).toBeLessThan(area.y + 1 + 2);
        expect(coveredByWorkAreas(rendered(dreaming, MEDIUM, 'sleep'), [area])).toBe(true);
      });
    });

    /*
     * 2026-11-17 (review): the correction after a resize was pinned only at
     * the bottom edge. Here the window is given back wider and further left
     * than asked (a model, not a measurement: what was measured is height),
     * so his ink, centred in it, is a DIP over the left edge. He is put back
     * where he is inside whether the correcting move keeps the two columns
     * or gives them up.
     */
    it('a window granted wider and further left at a side edge is corrected for either size the move leaves it', () => {
      const leftOf = (m: typeof medium): number => area.x - inkInset(m).left;
      for (const keeps of [true, false]) {
        const label = keeps ? 'the window keeps its surplus' : 'the window takes the asked size';
        const overlay = createOverlay(storeAt({ x: leftOf(medium), y: 400 }), MEDIUM, BOXES, NO_GAP);
        overlay.applyBox('sleep');
        let call = 0;
        host.grant = (asked) => {
          call++;
          if (call === 1) return { ...asked, x: asked.x - 2, width: asked.width + 2 };
          return keeps ? { ...asked, width: asked.width + 2 } : asked;
        };
        host.calls.length = 0;
        overlay.applyBox('stand');
        host.grant = null;
        expect(host.calls, label).toEqual(['setBounds', 'move']);
        expect(host.moves.at(-1), label).toMatchObject({ x: leftOf(medium), width: medium.width });
        const b = overlay.win.getBounds();
        expect(drawnInk(b, MEDIUM).x, label).toBe(area.x + (keeps ? 1 : 0));
        expect(inside(b, MEDIUM), label).toBe(true);
      }
    });

    it('keeps the cursor reading true through the correction', () => {
      const overlay = createOverlay(storeAt({ x: 600, y: bottom - small.height }), SMALL, BOXES, NO_GAP);
      host.cursor = { x: 640, y: bottom - 20 };
      host.grant = (asked) => ({ ...asked, height: asked.height + 2 });
      host.sent.length = 0;
      overlay.applyBubble(30);
      const b = overlay.win.getBounds();
      const last = host.sent.filter((entry) => entry.channel === CH.hoverCursor).at(-1);
      // The last reading is for the window where it ended up, at its real size.
      expect(last?.payload).toEqual({
        x: host.cursor.x - b.x,
        y: host.cursor.y - b.y,
        width: b.width,
        height: b.height
      });
    });
  });

  /* ------------------------------------------------------- display changes */

  describe('a display change', () => {
    it('moves him up when a taskbar appears under him, and saves it', () => {
      const store = storeAt({ x: 600, y: bottom - small.height });
      const overlay = createOverlay(store, SMALL, BOXES, NO_GAP);
      DISPLAY.workArea = { ...area, height: area.height - 48 };
      host.calls.length = 0;
      metricsChanged();
      expect(host.calls).toEqual(['move']);
      const b = overlay.win.getBounds();
      expect({ x: b.x, bottom: b.y + b.height }).toEqual({ x: 600, bottom: bottom - 48 });
      expect(savedAt(store)).toEqual({ x: 600, y: b.y });
      // Asked again, nothing: the correction is a fixed point.
      host.calls.length = 0;
      metricsChanged();
      expect(host.calls).toEqual([]);
    });

    it('moves him in from each side a work area can shrink from', () => {
      // A taskbar or the Dock on the left, the right, the top (a menu bar).
      const shrunk: [string, Rect, Point][] = [
        ['left', { ...area, x: area.x + 60, width: area.width - 60 }, { x: -5000, y: 400 }],
        ['right', { ...area, width: area.width - 60 }, { x: 5000, y: 400 }],
        ['top', { ...area, y: area.y + 60, height: area.height - 60 }, { x: 600, y: -5000 }]
      ];
      for (const [side, workArea, corner] of shrunk) {
        DISPLAY.workArea = area;
        host.screenListeners.length = 0;
        const overlay = createOverlay(storeAt(corner), MEDIUM, BOXES, NO_GAP);
        const before = { ...overlay.win.getBounds() };
        DISPLAY.workArea = workArea;
        expect(inside(before, MEDIUM), side).toBe(false);
        metricsChanged();
        const b = overlay.win.getBounds();
        expect(inside(b, MEDIUM), side).toBe(true);
        // By exactly the strip's thickness, on the one axis.
        expect(Math.abs(b.x - before.x) + Math.abs(b.y - before.y), side).toBe(60);
      }
    });

    it('does nothing when the work area grows back: he is not dragged to an edge', () => {
      const overlay = createOverlay(storeAt({ x: 600, y: bottom - small.height }), SMALL, BOXES, NO_GAP);
      DISPLAY.workArea = { ...area, height: area.height - 48 };
      metricsChanged();
      const b = { ...overlay.win.getBounds() };
      DISPLAY.workArea = area;
      host.calls.length = 0;
      metricsChanged();
      expect(host.calls).toEqual([]);
      expect(overlay.win.getBounds()).toEqual(b);
    });

    // The other direction — 100 % to 125 % at Small, where he is drawn smaller
    // and does not move — is in 'a size change at the corner at a fractional
    // scale factor' above, with the Medium case that has to be pulled in.
    it('pulls him in when the scale goes back to 100 %, where a Small dog is drawn larger', () => {
      DISPLAY.scaleFactor = 1.25;
      const drawn = drawnInkInset({
        metrics: small,
        scale: SMALL,
        box: BOXES.stand,
        standBox: BOXES.stand,
        dpr: 1.25
      });
      expect(drawn.left).toBeGreaterThan(inkInset(small).left);
      const store = storeAt({ x: -5000, y: 500 });
      const overlay = createOverlay(store, SMALL, BOXES, NO_GAP);
      // Flush at 125 %: more of the window hangs off than could at 100 %.
      expect(overlay.win.getBounds().x).toBe(area.x - drawn.left);

      DISPLAY.scaleFactor = 1;
      metricsChanged();
      const b = overlay.win.getBounds();
      expect(b.x).toBe(area.x - inkInset(small).left);
      expect(inside(b, SMALL)).toBe(true);
      expect(savedAt(store)).toEqual({ x: b.x, y: 500 });
    });

    /*
     * 2026-11-14, audit X1: his side of the screen is decided where he is
     * *put*. A nudge straight up — the taskbar appearing under him — is not
     * that, and must not flip the side of a dog grown across the middle.
     */
    it('a correction straight up keeps his side: Small comes back to the same x', () => {
      const store = storeAt({ x: 690, y: bottom - small.height });
      const overlay = createOverlay(store, SMALL, BOXES, NO_GAP);
      const start = { ...overlay.win.getBounds() };
      overlay.applySize(LARGE);
      // Grown leftwards from his right edge, so his centre is on the left half.
      const grown = overlay.win.getBounds();
      expect(grown.x + grown.width).toBe(start.x + start.width);
      expect(grown.x + grown.width / 2).toBeLessThan(area.x + area.width / 2);

      DISPLAY.workArea = { ...area, height: area.height - 48 };
      metricsChanged();
      const lifted = overlay.win.getBounds();
      expect({ x: lifted.x, bottom: lifted.y + lifted.height }).toEqual({
        x: grown.x,
        bottom: bottom - 48
      });

      overlay.applySize(SMALL);
      const back = overlay.win.getBounds();
      expect(back.x).toBe(start.x);
      expect(back.y + back.height).toBe(bottom - 48);
    });

    it('a correction sideways decides his side afresh', () => {
      // The work area loses its right half (a rearrangement), so he is moved
      // left to its new edge: that is being put somewhere, and his side is
      // decided again from where he landed.
      const store = storeAt({ x: 1300, y: 400 });
      const overlay = createOverlay(store, SMALL, BOXES, NO_GAP);
      DISPLAY.workArea = { ...area, width: 700 };
      metricsChanged();
      const moved = overlay.win.getBounds();
      expect(moved.x + moved.width - inkInset(small).right).toBe(700);
      // Right half of the 700 px area: a size change keeps his right edge, and
      // the clamp then holds his ink at the edge.
      overlay.applySize(LARGE);
      const b = overlay.win.getBounds();
      expect(inside(b, LARGE)).toBe(true);
      expect(b.x + b.width - inkInset(large).right).toBeLessThanOrEqual(700);
    });

    /*
     * 2026-11-17 (review): the test above starts on the right half and lands
     * on the right half, so it passes whether or not his side is decided
     * again. These three are the ones that tell: a sideways correction that
     * changes his half, a straight-up one onto *another* display, and a
     * straight-up one on a display he was dragged to (not the one he launched
     * on), which must keep his side.
     */
    it('a correction sideways onto the other half changes the edge a size change keeps', () => {
      // On the left half, 20 px over where the work area is about to end.
      const overlay = createOverlay(storeAt({ x: 640, y: 400 }), SMALL, BOXES, NO_GAP);
      const start = overlay.win.getBounds();
      expect(start.x + start.width / 2).toBeLessThan(area.x + area.width / 2);

      DISPLAY.workArea = { ...area, width: 700 };
      metricsChanged();
      const moved = { ...overlay.win.getBounds() };
      expect(moved.x).toBe(620);
      // The right half of what is left: put there, his side is the right one.
      expect(moved.x + moved.width / 2).toBeGreaterThan(350);

      overlay.applySize(LARGE);
      const b = overlay.win.getBounds();
      // The correction left him flush with the new right edge, so since
      // 2026-11-20 the size change keeps his ink's right edge there (not the
      // window's, X1), and he grows leftwards.
      expect(b.x + b.width - inkInset(large).right).toBe(700);
      expect(inside(b, LARGE)).toBe(true);
      overlay.applySize(SMALL);
      expect(overlay.win.getBounds()).toEqual(moved);

      // The work area comes back: he is inside, so nothing moves him and his
      // side stays the one the correction decided, though he is now on the
      // left half and no longer flush. A size change keeps the window's right
      // edge — the left one had the correction not decided his side again.
      DISPLAY.workArea = area;
      metricsChanged();
      expect(overlay.win.getBounds()).toEqual(moved);
      overlay.applySize(LARGE);
      const after = overlay.win.getBounds();
      expect(after.x + after.width).toBe(moved.x + moved.width);
    });

    it('a correction straight up onto another display decides his side there', () => {
      // A wide display with a narrow one under it. On the narrow one he is on
      // the right half; lifted straight up when it is unplugged, the same x is
      // on the left half of the wide one.
      const wide = display(41, { x: 0, y: 0, width: 2000, height: 800 });
      const under = display(42, { x: 0, y: 800, width: 1000, height: 800 });
      host.displays = [wide, under];
      const store = storeAt({ x: 600, y: 1200 }, keyOf(under));
      const overlay = createOverlay(store, SMALL, BOXES, NO_GAP);
      expect(overlay.win.getBounds()).toMatchObject({ x: 600, y: 1200 });

      host.displays = [wide];
      fire('display-removed');
      const lifted = { ...overlay.win.getBounds() };
      // Not sideways at all: only the display under him is another one.
      expect({ x: lifted.x, bottom: lifted.y + lifted.height }).toEqual({ x: 600, bottom: 800 });
      expect(savedAt(store, keyOf(wide))).toEqual({ x: 600, y: lifted.y });

      overlay.applySize(LARGE);
      const b = overlay.win.getBounds();
      // The left half of the wide display: his left edge is the one kept.
      expect({ x: b.x, bottom: b.y + b.height }).toEqual({ x: 600, bottom: 800 });
    });

    it('a correction straight up on a display he was dragged to keeps the side decided there', () => {
      const first = display(51, { x: 0, y: 0, width: 1000, height: 800 });
      const second = display(52, { x: 1000, y: 0, width: 1000, height: 800 });
      host.displays = [first, second];
      const overlay = createOverlay(storeAt({ x: 300, y: 400 }, keyOf(first)), SMALL, BOXES, NO_GAP);
      // Dropped on the second display's floor, just right of its middle.
      overlay.dragStart();
      overlay.dragMove(1470 - 300, 800 - small.height - 400);
      overlay.dragEnd();
      const dropped = { ...overlay.win.getBounds() };
      expect({ x: dropped.x, bottom: dropped.y + dropped.height }).toEqual({ x: 1470, bottom: 800 });

      overlay.applySize(LARGE);
      const grown = overlay.win.getBounds();
      // Grown leftwards from his right edge: his centre is now on the left half.
      expect(grown.x + grown.width).toBe(dropped.x + dropped.width);
      expect(grown.x + grown.width / 2).toBeLessThan(1500);

      // The taskbar appears under him there: straight up, on the same display.
      host.displays = [first, { ...second, workArea: { ...second.bounds, height: 752 } }];
      metricsChanged();
      const lifted = overlay.win.getBounds();
      expect({ x: lifted.x, bottom: lifted.y + lifted.height }).toEqual({ x: grown.x, bottom: 752 });

      // Still the right-hand side, as decided at the drop: Small comes home.
      overlay.applySize(SMALL);
      const back = overlay.win.getBounds();
      expect({ x: back.x, bottom: back.y + back.height }).toEqual({ x: dropped.x, bottom: 752 });
    });

    it('a display removed: he lands on the one that is left, and its key is the one written', () => {
      const second = display(2, { x: 1440, y: 0, width: 1920, height: 1080 }, 1, {
        x: 1440,
        y: 0,
        width: 1920,
        height: 1040
      });
      host.displays = [DISPLAY, second];
      const store = storeAt({ x: 2500, y: 600 }, keyOf(second));
      const overlay = createOverlay(store, SMALL, BOXES, NO_GAP);
      expect(overlay.win.getBounds()).toMatchObject({ x: 2500, y: 600 });

      host.displays = [DISPLAY];
      host.calls.length = 0;
      fire('display-removed');
      expect(host.calls).toEqual(['move']);
      const b = overlay.win.getBounds();
      expect(inside(b, SMALL)).toBe(true);
      // The nearest spot on what is left: ink flush with its right edge.
      expect({ x: b.x, y: b.y }).toEqual({ x: right - small.width + inkInset(small).right, y: 600 });
      expect(savedAt(store)).toEqual({ x: b.x, y: b.y });
      // The unplugged display's entry is kept for a replug.
      expect(savedAt(store, keyOf(second))).toEqual({ x: 2500, y: 600 });
    });

    it('a display added, with him inside already: no window call and nothing saved', () => {
      const store = fakeStore();
      const overlay = createOverlay(store, SMALL, BOXES, NO_GAP);
      const b = { ...overlay.win.getBounds() };
      host.displays = [DISPLAY, display(2, { x: 1440, y: 0, width: 1920, height: 1080 })];
      host.calls.length = 0;
      fire('display-added');
      expect(host.calls).toEqual([]);
      expect(overlay.win.getBounds()).toEqual(b);
      expect(store.get('positions')).toEqual({});
    });

    it('with no display reported: nothing, and no throw; the event that follows corrects', () => {
      const store = storeAt({ x: 600, y: bottom - small.height });
      const overlay = createOverlay(store, SMALL, BOXES, NO_GAP);
      const b = { ...overlay.win.getBounds() };
      DISPLAY.workArea = { ...area, height: area.height - 48 };
      host.displays = [];
      host.calls.length = 0;
      host.sent.length = 0;
      host.screenAsks.length = 0;
      expect(() => {
        fire('display-removed');
        metricsChanged();
        overlay.revalidatePosition();
      }).not.toThrow();
      expect(host.calls).toEqual([]);
      expect(host.sent).toEqual([]);
      // Not even a question that needs a display to answer: what Electron
      // says to those with none attached is not known.
      expect(host.screenAsks).toEqual([]);
      expect(overlay.win.getBounds()).toEqual(b);
      // A drag in that state is left alone too, rather than guessed at.
      overlay.dragStart();
      expect(() => overlay.dragMove(10, 10)).not.toThrow();
      overlay.dragMove(0, 0);
      expect(() => overlay.dragEnd()).not.toThrow();
      expect(overlay.win.getBounds()).toEqual(b);

      host.displays = [DISPLAY];
      fire('display-added');
      const after = overlay.win.getBounds();
      expect(after.y + after.height).toBe(bottom - 48);
    });

    it('still moves him when the corrected spot cannot be saved, and does not throw', () => {
      // A screen event has nothing above it to catch a failed write.
      const store = storeAt({ x: 600, y: bottom - small.height });
      const overlay = createOverlay(store, SMALL, BOXES, NO_GAP);
      (store as { set: unknown }).set = () => {
        throw new Error('EACCES');
      };
      DISPLAY.workArea = { ...area, height: area.height - 48 };
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        expect(() => metricsChanged()).not.toThrow();
        expect(warned).toHaveBeenCalledTimes(1);
      } finally {
        warned.mockRestore();
      }
      const b = overlay.win.getBounds();
      expect(b.y + b.height).toBe(bottom - 48);
    });
  });

  /* ---------------------------------------------------- shown again, a wake */

  describe('coming back', () => {
    it('setVisible(true) after a work-area change nobody announced: moved, then shown', () => {
      const overlay = createOverlay(storeAt({ x: 600, y: bottom - small.height }), SMALL, BOXES, NO_GAP);
      ready();
      overlay.setVisible(false);
      DISPLAY.workArea = { ...area, height: area.height - 48 };
      host.calls.length = 0;
      overlay.setVisible(true);
      expect(host.calls).toEqual(['move', 'showInactive']);
      const b = overlay.win.getBounds();
      expect(b.y + b.height).toBe(bottom - 48);
    });

    it('setVisible(true) with him inside is the one call it always was', () => {
      const overlay = build();
      ready();
      overlay.setVisible(false);
      host.calls.length = 0;
      overlay.setVisible(true);
      expect(host.calls).toEqual(['showInactive']);
    });

    it('a hidden dog is corrected by the display event itself, so the show has nothing to do', () => {
      const overlay = createOverlay(storeAt({ x: 600, y: bottom - small.height }), SMALL, BOXES, NO_GAP);
      ready();
      overlay.setVisible(false);
      DISPLAY.workArea = { ...area, height: area.height - 48 };
      host.calls.length = 0;
      metricsChanged();
      expect(host.calls).toEqual(['move']);
      overlay.setVisible(true);
      expect(host.calls).toEqual(['move', 'showInactive']);
    });

    it('revalidatePosition (a wake, an unlock) corrects a stale position and is nothing otherwise', () => {
      const store = storeAt({ x: 600, y: bottom - small.height });
      const overlay = createOverlay(store, SMALL, BOXES, NO_GAP);
      ready();
      host.calls.length = 0;
      host.sent.length = 0;
      overlay.revalidatePosition();
      expect(host.calls).toEqual([]);
      expect(host.sent).toEqual([]);
      expect(savedAt(store)).toEqual({ x: 600, y: bottom - small.height });

      // The lid was closed on a docked laptop and the taskbar is back.
      DISPLAY.workArea = { ...area, height: area.height - 48 };
      overlay.revalidatePosition();
      expect(host.calls).toEqual(['move']);
      const b = overlay.win.getBounds();
      expect(b.y + b.height).toBe(bottom - 48);
      expect(savedAt(store)).toEqual({ x: 600, y: b.y });

      overlay.revalidatePosition();
      expect(host.calls).toEqual(['move']);
    });

    it('revalidatePosition on a destroyed window does nothing', () => {
      const overlay = build();
      host.destroyed = true;
      expect(() => overlay.revalidatePosition()).not.toThrow();
    });
  });

  /* ------------------------------------------------------ several displays */

  describe('two displays of the same height', () => {
    const left = display(11, { x: 0, y: 0, width: 1000, height: 800 });
    const rightHand = display(12, { x: 1000, y: 0, width: 1000, height: 800 });
    /** A Small dog across the seam: 50 px of his window on the left display. */
    function straddling(): { overlay: ReturnType<typeof createOverlay>; store: WalderStore } {
      host.displays = [left, rightHand];
      const store = storeAt({ x: 950, y: 400 }, keyOf(left));
      return { overlay: createOverlay(store, SMALL, BOXES, NO_GAP), store };
    }

    it('launches him across the seam where he was left', () => {
      const { overlay } = straddling();
      const b = overlay.win.getBounds();
      expect({ x: b.x, y: b.y }).toEqual({ x: 950, y: 400 });
      const ink = drawnInk(b, SMALL);
      expect(ink.x).toBeLessThan(1000);
      expect(ink.x + ink.width).toBeGreaterThan(1000);
      expect(inside(b, SMALL)).toBe(true);
    });

    it('leaves him there through a sleep, a wake-up, a bark and a display event', () => {
      const { overlay } = straddling();
      const start = { ...overlay.win.getBounds() };
      overlay.applyBox('sleep');
      expect(overlay.win.getBounds().x).toBe(start.x);
      expect(overlay.win.getBounds().y + overlay.win.getBounds().height).toBe(start.y + start.height);
      overlay.applyBox('stand');
      expect(overlay.win.getBounds()).toEqual(start);

      overlay.applyBubble(30);
      const barking = overlay.win.getBounds();
      expect(barking.x + (barking.width - small.width) / 2).toBe(start.x);
      overlay.applyBubble(0);
      expect(overlay.win.getBounds()).toEqual(start);

      host.calls.length = 0;
      metricsChanged();
      fire('display-added');
      overlay.revalidatePosition();
      expect(host.calls).toEqual([]);
      expect(overlay.win.getBounds()).toEqual(start);
    });

    it('keeps the anchors of a size change across the seam, and comes home', () => {
      const { overlay, store } = straddling();
      const start = { ...overlay.win.getBounds() };
      overlay.applySize(MEDIUM);
      const b = overlay.win.getBounds();
      // On the right half of the display he is mostly on: his right edge and
      // the floor he stands on are kept (audit X1), still across the seam.
      expect(b.x + b.width).toBe(start.x + start.width);
      expect(b.y + b.height).toBe(start.y + start.height);
      expect(inside(b, MEDIUM)).toBe(true);
      overlay.applySize(SMALL);
      expect(overlay.win.getBounds()).toEqual(start);
      expect(savedAt(store, keyOf(left))).toEqual({ x: start.x, y: start.y });
    });

    it('drags smoothly from one display to the other, covered at every step', () => {
      host.displays = [left, rightHand];
      const overlay = createOverlay(storeAt({ x: 700, y: 400 }, keyOf(left)), SMALL, BOXES, NO_GAP);
      overlay.dragStart();
      for (let dx = 0; dx <= 600; dx += 7) {
        overlay.dragMove(dx, 0);
        const b = overlay.win.getBounds();
        // Exactly under the pointer all the way: the seam is not an edge.
        expect({ x: b.x, y: b.y }, `dx ${dx}`).toEqual({ x: 700 + dx, y: 400 });
        expect(inside(b, SMALL), `dx ${dx}`).toBe(true);
      }
      // And along the bottom edge through the seam, with no bump.
      for (let dx = 600; dx >= 0; dx -= 7) {
        overlay.dragMove(dx, 5000);
        const b = overlay.win.getBounds();
        expect({ x: b.x, bottom: b.y + b.height }, `dx ${dx}`).toEqual({ x: 700 + dx, bottom: 800 });
      }
      overlay.dragEnd();
    });
  });

  describe('two displays of different heights', () => {
    const short = display(21, { x: 0, y: 0, width: 1000, height: 600 });
    const tall = display(22, { x: 1000, y: 0, width: 1000, height: 1000 });
    const wall = 1000 - inkInset(small).left;

    it('a drag below the shorter display stops at the wall, then goes over when up is nearer', () => {
      host.displays = [short, tall];
      // On the tall display, lower than the short one reaches.
      const overlay = createOverlay(storeAt({ x: 1300, y: 800 }, keyOf(tall)), SMALL, BOXES, NO_GAP);
      expect(overlay.win.getBounds()).toMatchObject({ x: 1300, y: 800 });
      overlay.dragStart();
      const seen: Point[] = [];
      for (let dx = 0; dx >= -900; dx -= 10) {
        overlay.dragMove(dx, 0);
        const b = overlay.win.getBounds();
        expect(inside(b, SMALL), `dx ${dx}`).toBe(true);
        seen.push({ x: b.x, y: b.y });
      }
      // With the pointer, then pinned at the wall at the same height…
      expect(seen[10]).toEqual({ x: 1200, y: 800 });
      expect(seen[31]).toEqual({ x: wall, y: 800 });
      expect(seen[50]).toEqual({ x: wall, y: 800 });
      // …and once going up (320) is nearer than staying at the wall, onto the
      // shorter display's floor, under the pointer's x.
      expect(seen[70]).toEqual({ x: 600, y: 600 - small.height });
      // Never anywhere else: every x between the wall and the jump is the wall.
      for (const p of seen) {
        expect(p.y === 800 || p.y === 600 - small.height).toBe(true);
        if (p.y === 800) expect(p.x).toBeGreaterThanOrEqual(wall);
      }
      overlay.dragEnd();
    });

    it('across the seam above the shorter floor he passes freely', () => {
      host.displays = [short, tall];
      const overlay = createOverlay(storeAt({ x: 1300, y: 300 }, keyOf(tall)), SMALL, BOXES, NO_GAP);
      overlay.dragStart();
      for (let dx = 0; dx >= -600; dx -= 10) {
        overlay.dragMove(dx, 0);
        const b = overlay.win.getBounds();
        expect({ x: b.x, y: b.y }, `dx ${dx}`).toEqual({ x: 1300 + dx, y: 300 });
      }
      overlay.dragEnd();
    });

    it('unplugging the tall display brings him up onto the short one', () => {
      host.displays = [short, tall];
      const store = storeAt({ x: 1300, y: 800 }, keyOf(tall));
      const overlay = createOverlay(store, SMALL, BOXES, NO_GAP);
      host.displays = [short];
      fire('display-removed');
      const b = overlay.win.getBounds();
      expect(inside(b, SMALL)).toBe(true);
      expect({ right: b.x + b.width - inkInset(small).right, bottom: b.y + b.height }).toEqual({
        right: 1000,
        bottom: 600
      });
      expect(savedAt(store, keyOf(short))).toEqual({ x: b.x, y: b.y });
      expect(savedAt(store, keyOf(tall))).toEqual({ x: 1300, y: 800 });
    });
  });

  describe('two displays at different scale factors', () => {
    const plain = display(31, { x: 0, y: 0, width: 1000, height: 800 }, 1);
    const scaled = display(32, { x: 1000, y: 0, width: 1000, height: 800 }, 1.25);

    it('measures him as he is drawn on the display he ends on, at every step, and is stable', () => {
      // At 125 % a Medium dog is drawn 20 % larger than at 100 %: nearly the
      // whole window wide, and well into the bubble reserve.
      const at125 = drawnInkInset({
        metrics: medium,
        scale: MEDIUM,
        box: BOXES.stand,
        standBox: BOXES.stand,
        dpr: 1.25
      });
      expect(at125.left).toBeLessThan(inkInset(medium).left);
      expect(at125.top).toBeLessThan(inkInset(medium).top);

      host.displays = [plain, scaled];
      const overlay = createOverlay(storeAt({ x: 400, y: 300 }, keyOf(plain)), MEDIUM, BOXES, NO_GAP);
      overlay.dragStart();
      // Mid-height, then held against the top edge (where the two differ),
      // then against the bottom, each across the seam and back.
      for (const dy of [0, -5000, 5000]) {
        for (let dx = -600; dx <= 1700; dx += 20) {
          overlay.dragMove(dx, dy);
          const b = { ...overlay.win.getBounds() };
          expect(inside(b, MEDIUM), `delta (${dx}, ${dy})`).toBe(true);
          // The same pointer position again: nothing to do.
          host.calls.length = 0;
          overlay.dragMove(dx, dy);
          expect(host.calls, `delta (${dx}, ${dy})`).toEqual([]);
          expect(overlay.win.getBounds(), `delta (${dx}, ${dy})`).toEqual(b);
        }
      }
      // Held in the far top-right corner of the 125 % display: his larger ink
      // flush with both edges.
      overlay.dragMove(5000, -5000);
      const corner = overlay.win.getBounds();
      expect({ x: corner.x, y: corner.y }).toEqual({
        x: 2000 - medium.width + at125.right,
        y: 0 - at125.top
      });
      overlay.dragEnd();
      expect(inside(overlay.win.getBounds(), MEDIUM)).toBe(true);
    });

    /*
     * 2026-11-17 (review): side by side at the same height, the display
     * nearest the place he is asked to be is always the one he lands on, so
     * the test above passes with his ink measured once, where he was asked.
     * These two are a layout where the clamp changes display: asked for a
     * place that is (just) on the 100 % display and not on the 125 % one, the
     * nearest place he may be is on the 125 % one — where he is drawn 14 px a
     * side wider, and measured the 100 % way would hang that far over the
     * wall under the shorter display.
     */
    describe('where the nearest place inside is on the other display', () => {
      const short = display(33, { x: 0, y: 0, width: 1000, height: 600 }, 1);
      const tall = display(34, { x: 1000, y: 0, width: 1000, height: 1000 }, 1.25);
      const at125 = drawnInkInset({
        metrics: medium,
        scale: MEDIUM,
        box: BOXES.stand,
        standBox: BOXES.stand,
        dpr: 1.25
      });
      /** The window with his 125 % ink flush against the wall under the short display. */
      const atTheWall = 1000 - at125.left;

      it('a drag is held at the wall by his ink as it is drawn on the display he is held on', () => {
        expect(inkInset(medium).left - at125.left).toBeGreaterThanOrEqual(14);
        host.displays = [short, tall];
        // On the 125 % display, five rows of his window above the short one's floor.
        const overlay = createOverlay(storeAt({ x: 1300, y: 595 }, keyOf(tall)), MEDIUM, BOXES, NO_GAP);
        expect(overlay.win.getBounds()).toMatchObject({ x: 1300, y: 595 });
        overlay.dragStart();
        // Asked to be wholly left of the seam: those five rows are on the
        // 100 % display and nothing of the window is on the 125 % one.
        overlay.dragMove(824 - 1300, 0);
        const b = { ...overlay.win.getBounds() };
        expect({ x: b.x, y: b.y }).toEqual({ x: atTheWall, y: 595 });
        expect(displayOf(b)).toBe(tall);
        expect(inside(b, MEDIUM)).toBe(true);
        // Stable under the same pointer position, and at the drop.
        host.calls.length = 0;
        overlay.dragMove(824 - 1300, 0);
        overlay.dragEnd();
        expect(host.calls).toEqual([]);
        expect(overlay.win.getBounds()).toEqual(b);
      });

      it('a display change moves him to the wall by the same measure', () => {
        host.displays = [short, tall];
        // On the 100 % display's floor, his window's right edge on the seam.
        const store = storeAt({ x: 824, y: 600 - medium.height }, keyOf(short));
        const overlay = createOverlay(store, MEDIUM, BOXES, NO_GAP);
        const before = { ...overlay.win.getBounds() };
        expect(before).toMatchObject({ x: 824, y: 600 - medium.height });
        expect(inside(before, MEDIUM)).toBe(true);

        // That display now ends five rows below the top of his window.
        const shorter = display(33, { x: 0, y: 0, width: 1000, height: before.y + 5 }, 1);
        host.displays = [shorter, tall];
        expect(displayOf(before)).toBe(shorter);
        host.calls.length = 0;
        metricsChanged();
        expect(host.calls).toEqual(['move']);
        const b = overlay.win.getBounds();
        expect({ x: b.x, y: b.y }).toEqual({ x: atTheWall, y: before.y });
        expect(inside(b, MEDIUM)).toBe(true);
        host.calls.length = 0;
        metricsChanged();
        expect(host.calls).toEqual([]);
      });
    });
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
 * The platform is passed in, so the waiting path runs on any host and the
 * "nothing at all on Linux" half is pinned on a Windows or a Mac one. The
 * whole suite runs once as Windows and once as macOS (2026-11-17: the Mac
 * showed its own bad frame on the same row and now takes the same wait), and
 * every "as a direct resize does" comparison is against Linux.
 */
describe.each(['win32', 'darwin'] as const)('a size change on %s waits for a blank picture', (WAITS) => {
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
    platform: NodeJS.Platform = WAITS,
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
    /** Pick a size and, where it waits, answer the blank it asks for. */
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
    const overlay = shown(WAITS, store);
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
    const direct = rig('linux');
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
    const overlay = createOverlay(storeAt(), SMALL, BOXES, { platform: WAITS });
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
    ['on the right half', { x: 1000, y: 500 }],
    // Flush with a side, his ink's side edge is kept (2026-11-20).
    ['flush with the left side', { x: -5000, y: 500 }],
    ['flush with the right side', { x: 5000, y: 500 }]
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
      const win = trail(WAITS);
      expect(win).toEqual(trail('linux'));
      // A real trail, not six copies of one window: he grew, and the round
      // trips came home (2026-11-14, audit X1).
      expect(win[1]?.bounds.width).toBeGreaterThan(win[0]?.bounds.width ?? Infinity);
      expect(win[1]?.scale).toBe(LARGE);
      expect(win[2]?.bounds).toEqual(win[0]?.bounds);
      expect(win[5]?.bounds).toEqual(win[0]?.bounds);
    }
  );

  it('Small -> Large -> Small picked inside one wait ends where it started, as a direct resize does', () => {
    const quick = (platform: NodeJS.Platform): Snapshot => {
      const r = rig(platform, null);
      if (platform === WAITS) {
        r.overlay.applySize(LARGE);
        r.overlay.applySize(SMALL);
        ack(1);
      } else {
        r.overlay.applySize(LARGE);
        r.overlay.applySize(SMALL);
      }
      return r.snap();
    };
    expect(quick(WAITS)).toEqual(quick('linux'));
  });

  it('saves the position at the resize, not at the pick', () => {
    const store = storeAt();
    const overlay = shown(WAITS, store);
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
      if (platform === WAITS) {
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
    const win = moved(WAITS);
    expect(win).toEqual(moved('linux'));
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
    const win = dragged(WAITS);
    expect(win).toEqual(dragged('linux'));
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
    const overlay = shown(WAITS, store);
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
    const overlay = shown(WAITS, store);
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
    const overlay = shown(WAITS, store);
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
      const overlay = shown(WAITS, store, LARGE);
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
    const overlay = shown(WAITS, storeAt(), LARGE);
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

  it('a box change whose save fails is still followed up, and does not throw', () => {
    // 2026-11 audit, W-1: the save is caught inside `resize`, so the box
    // change finishes and its `mode:set` still goes out.
    const store = storeAt();
    const overlay = shown(WAITS, store);
    overlay.applySize(LARGE);
    ack(1);
    host.sent.length = 0;
    (store as { set: unknown }).set = () => {
      throw new Error('EACCES');
    };
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => overlay.applyBox('sleep')).not.toThrow();
      expect(warned).toHaveBeenCalledTimes(1);
    } finally {
      warned.mockRestore();
    }
    expect(modeSends()).toEqual([expect.objectContaining({ box: 'sleep', scale: LARGE })]);
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

  /* ----------------------------------------------------------------- Linux */

  it.each(['linux'] as const)(
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

  it.each(['linux'] as const)(
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

  it.each(['linux'] as const)(
    '%s: a save that fails is warned about, and applySize still resizes',
    (platform) => {
      // 2026-11 audit, W-1: it used to throw out of applySize.
      const store = storeAt();
      const overlay = shown(platform, store);
      (store as { set: unknown }).set = () => {
        throw new Error('EACCES');
      };
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        expect(() => overlay.applySize(LARGE)).not.toThrow();
        expect(warned).toHaveBeenCalledTimes(1);
      } finally {
        warned.mockRestore();
      }
      expect(overlay.currentMode().scale).toBe(LARGE);
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

  /* ------------------------------ inside the screen (owner, 2026-11-16) */

  /*
   * The deferred resize is `resize` run later on the live state, so the rule
   * that he is never outside the screen holds through the wait by the same
   * code as everywhere else. These pin that it does: what happens to him in
   * the wait is clamped at the old size, and the flush at the new one.
   */

  it('a drag to a screen edge in the wait ends where the same drag before a direct resize does', () => {
    const dragged = (platform: NodeJS.Platform): Snapshot => {
      const r = rig(platform);
      const toTheCorner = (): void => {
        r.overlay.dragStart();
        r.overlay.dragMove(-5000, 5000);
        r.overlay.dragEnd();
      };
      if (platform === WAITS) {
        r.overlay.applySize(LARGE);
        toTheCorner();
        // Held at the edge as the Small dog he still is.
        const small = boxMetrics(SMALL, BOXES.stand, true, 0);
        expect(r.overlay.win.getBounds()).toEqual({
          x: DISPLAY.workArea.x - inkInset(small).left,
          y: DISPLAY.workArea.y + DISPLAY.workArea.height - small.height,
          width: small.width,
          height: small.height
        });
        ack(1);
      } else {
        toTheCorner();
        r.overlay.applySize(LARGE);
      }
      return r.snap();
    };
    const win = dragged(WAITS);
    expect(win).toEqual(dragged('linux'));
    const large = boxMetrics(LARGE, BOXES.stand, true, 0);
    expect(sizeOf(win.bounds)).toEqual(sizeOf(large));
    expect(coveredByWorkAreas(win.bounds, [DISPLAY.workArea], inkInset(large))).toBe(true);
    // Grown from the left edge he was dropped at and the floor he stood on.
    expect(win.bounds.y + win.bounds.height).toBe(DISPLAY.workArea.y + DISPLAY.workArea.height);
    expect(win.saved).toEqual({ x: win.bounds.x, y: win.bounds.y });
  });

  it('a work area that shrinks in the wait is honoured at the old size, and the flush lands inside it', () => {
    const shrunk = { ...DISPLAY.workArea, height: DISPLAY.workArea.height - 48 };
    const moved = (platform: NodeJS.Platform): Snapshot => {
      DISPLAY.workArea = HOME_WORK_AREA;
      const small = boxMetrics(SMALL, BOXES.stand, true, 0);
      const r = rig(platform, {
        x: 300,
        y: HOME_WORK_AREA.y + HOME_WORK_AREA.height - small.height
      });
      const taskbar = (): void => {
        DISPLAY.workArea = shrunk;
        metricsChanged();
      };
      if (platform === WAITS) {
        r.overlay.applySize(LARGE);
        taskbar();
        expect(r.overlay.currentMode().scale).toBe(SMALL);
        const b = r.overlay.win.getBounds();
        expect(b.y + b.height).toBe(shrunk.y + shrunk.height);
        ack(1);
      } else {
        taskbar();
        r.overlay.applySize(LARGE);
      }
      return r.snap();
    };
    const win = moved(WAITS);
    expect(win).toEqual(moved('linux'));
    expect(win.bounds.y + win.bounds.height).toBe(shrunk.y + shrunk.height);
    expect(
      coveredByWorkAreas(win.bounds, [shrunk], inkInset(boxMetrics(LARGE, BOXES.stand, true, 0)))
    ).toBe(true);
  });

  it('closing in the wait at the corner saves a position that is inside at the new size', () => {
    const area = DISPLAY.workArea;
    const small = boxMetrics(SMALL, BOXES.stand, true, 0);
    const large = boxMetrics(LARGE, BOXES.stand, true, 0);
    // His ink flush with the right and bottom edges.
    const store = storeAt({
      x: area.x + area.width - small.width + inkInset(small).right,
      y: area.y + area.height - small.height
    });
    const overlay = shown(WAITS, store);
    overlay.applySize(LARGE);
    for (const handler of host.closeHandlers) handler();
    const bounds = overlay.win.getBounds();
    const saved = savedAt(store) as Point;
    expect(saved).toEqual({ x: bounds.x, y: bounds.y });
    expect(
      coveredByWorkAreas({ ...saved, width: large.width, height: large.height }, [area], inkInset(large))
    ).toBe(true);
    // And the relaunch at that size starts exactly there, with nothing to correct.
    createOverlay(store, LARGE, BOXES, { platform: WAITS });
    const relaunched = host.built.at(-1) as Record<string, unknown>;
    expect({ x: relaunched['x'], y: relaunched['y'] }).toEqual(saved);
  });
});

/**
 * RECHECK 2026-11-18, d (Mac and Windows): a size round trip at the top edge
 * ended 144 pt lower. `resize` kept his feet everywhere, so growing at a top
 * edge pushed his head past it, the clamp pushed him down, and the shrink kept
 * the pushed feet. On the top half he now keeps the top of his ink, as the
 * clamp measures it — with the sheet's transparent margin (`ink`) and without.
 */
describe('a size round trip at the top edge (RECHECK d)', () => {
  const key = `${DISPLAY.id}:${DISPLAY.bounds.width}x${DISPLAY.bounds.height}`;
  const sizes = ['small', 'medium', 'large'] as const;
  /** As `sheetBoxes` hands them over: one shared margin on every box. */
  const SHARED = { top: 4, side: 0 };
  const INKED = {
    stand: { ...BOXES.stand, ink: SHARED },
    sleep: { ...BOXES.sleep, ink: SHARED },
    lie: { ...BOXES.lie, ink: SHARED }
  };
  /** The top of his drawn ink for a standing window `bounds` at `scale`. */
  const inkTop = (bounds: Rect, scale: number, boxes: typeof BOXES): number =>
    bounds.y +
    (drawnInkInset({
      metrics: boxMetrics(scale, boxes.stand, true, 0),
      scale,
      box: boxes.stand,
      standBox: boxes.stand,
      dpr: DISPLAY.scaleFactor
    }).top ?? 0);
  // Mid-width, the top-left corner and the top-right corner; saved far above
  // the area, so the launch clamps him flush with its top.
  const spots = { 'top edge': 600, 'top-left': -500, 'top-right': 2000 } as const;

  for (const [label, boxes] of [
    ['box edge', BOXES],
    ['ink margin', INKED]
  ] as const) {
    for (const [where, x] of Object.entries(spots)) {
      for (const dpr of [1, 1.25, 1.5, 2]) {
        it(`${where}, ${label}, dpr ${dpr}: every round trip comes back to the same rect`, () => {
          DISPLAY.scaleFactor = dpr;
          for (const from of sizes) {
            for (const via of sizes) {
              if (via === from) continue;
              const trip = `${from} -> ${via} -> large -> ${from}`;
              const store = fakeStore({ positions: { [key]: { x, y: -1000 } } });
              const overlay = createOverlay(store, SCALE_BY_SIZE[from], boxes, NO_GAP);
              const start = overlay.win.getBounds();
              const area = DISPLAY.workArea;
              expect(inkTop(start, SCALE_BY_SIZE[from], boxes), trip).toBe(area.y);
              for (const step of [via, 'large', from] as const) {
                overlay.applySize(SCALE_BY_SIZE[step]);
                // Flush with the top at every step: never above it, never pushed down.
                expect(inkTop(overlay.win.getBounds(), SCALE_BY_SIZE[step], boxes), trip).toBe(
                  area.y
                );
              }
              // In the corners too, since 2026-11-20: flush with a side, a
              // size change keeps his ink's side edge.
              expect(overlay.win.getBounds(), trip).toEqual(start);
            }
          }
        });
      }
    }
  }

  /**
   * Owner, 2026-11-19: Yuna has no top margin (`coatInkMargin`), so a coat
   * change to her with the dog flush at a top edge would leave her four rows
   * over it, her bubble a line short until something else clamped her.
   * `setBoxes` checks at once; back to the dog is inside already, and nothing.
   */
  it('a coat change at the top edge settles Yuna below it and leaves the dog where he is', () => {
    const area = DISPLAY.workArea;
    for (const dpr of [1, 1.25, 1.5, 2, 2.5]) {
      DISPLAY.scaleFactor = dpr;
      for (const size of sizes) {
        const label = `${size} dpr ${dpr}`;
        const scale = SCALE_BY_SIZE[size];
        const store = fakeStore({ positions: { [key]: { x: 600, y: -1000 } } });
        const overlay = createOverlay(store, scale, INKED, NO_GAP);
        expect(inkTop(overlay.win.getBounds(), scale, INKED), label).toBe(area.y);
        overlay.setBoxes(BOXES);
        const yuna = overlay.win.getBounds();
        expect(inkTop(yuna, scale, BOXES), label).toBe(area.y);
        overlay.setBoxes(INKED);
        expect(overlay.win.getBounds(), label).toEqual(yuna);
      }
    }
  });

  it('still keeps his feet on the bottom half, at the bottom edge and at home', () => {
    const area = DISPLAY.workArea;
    for (const x of [600, 2000]) {
      const store = fakeStore({ positions: { [key]: { x, y: 5000 } } });
      const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
      const start = overlay.win.getBounds();
      expect(start.y + start.height).toBe(area.y + area.height);
      for (const step of ['medium', 'large', 'small'] as const) {
        overlay.applySize(SCALE_BY_SIZE[step]);
        const b = overlay.win.getBounds();
        expect(b.y + b.height).toBe(area.y + area.height);
      }
      expect(overlay.win.getBounds()).toEqual(start);
    }
  });

  it('grows downwards from the top of his ink anywhere on the top half, and a drop re-decides', () => {
    const store = fakeStore({ positions: { [key]: { x: 600, y: 200 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    const small = overlay.win.getBounds();
    overlay.applySize(SCALE_BY_SIZE.large);
    const large = overlay.win.getBounds();
    expect(inkTop(large, SCALE_BY_SIZE.large, BOXES)).toBe(inkTop(small, SCALE_BY_SIZE.small, BOXES));
    overlay.applySize(SCALE_BY_SIZE.small);
    expect(overlay.win.getBounds()).toEqual(small);

    // Dragged to the bottom half: his feet are the fixed point again.
    overlay.dragStart();
    overlay.dragMove(0, 500);
    overlay.dragEnd();
    const dropped = overlay.win.getBounds();
    overlay.applySize(SCALE_BY_SIZE.large);
    const grown = overlay.win.getBounds();
    expect(grown.y + grown.height).toBe(dropped.y + dropped.height);
  });

  /*
   * Windows QA 2026-11-19, row 3.3c: Small at x 912 on a 1920 display (left
   * half), Medium grows from the left edge and carries his centre past the
   * middle, a pet there re-decided his side, and Large kept the right edge:
   * x 824, and the round trip ended 88 px left of where it began.
   */
  it('a pet does not re-decide his side: a round trip with pets in between comes home', () => {
    const area = DISPLAY.workArea;
    const smallWidth = boxMetrics(SCALE_BY_SIZE.small, BOXES.stand, true, 0).width;
    const mediumWidth = boxMetrics(SCALE_BY_SIZE.medium, BOXES.stand, true, 0).width;
    // Left of the middle at Small, right of it once grown to Medium.
    const x = Math.round(area.x + area.width / 2 - (smallWidth + mediumWidth) / 4);
    const store = fakeStore({ positions: { [key]: { x, y: -1000 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    const start = overlay.win.getBounds();
    expect(start.x + start.width / 2).toBeLessThan(area.x + area.width / 2);
    const pet = (): void => {
      overlay.dragStart();
      overlay.dragEnd();
    };
    overlay.applySize(SCALE_BY_SIZE.medium);
    const medium = overlay.win.getBounds();
    expect(medium.x).toBe(start.x);
    expect(medium.x + medium.width / 2).toBeGreaterThan(area.x + area.width / 2);
    pet();
    overlay.applySize(SCALE_BY_SIZE.large);
    expect(overlay.win.getBounds().x).toBe(start.x);
    pet();
    overlay.applySize(SCALE_BY_SIZE.small);
    expect(overlay.win.getBounds()).toEqual(start);
  });

  /*
   * A hand is not an AHK click (Windows QA 2026-11-19): every pointer move of
   * a press is a `drag:move`, and a pet that wobbled 2-3 px moved him that
   * much and saved it. A press under `CLICK_SLOP_PX` (`isClick`) is a dead
   * zone: he does not move, the release saves nothing and decides nothing.
   */
  it('a pet with a few pixels of hand movement does not move him, save, or re-decide his side', () => {
    const area = DISPLAY.workArea;
    const smallWidth = boxMetrics(SCALE_BY_SIZE.small, BOXES.stand, true, 0).width;
    const mediumWidth = boxMetrics(SCALE_BY_SIZE.medium, BOXES.stand, true, 0).width;
    const x = Math.round(area.x + area.width / 2 - (smallWidth + mediumWidth) / 4);
    const store = fakeStore({ positions: { [key]: { x, y: -1000 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    const start = overlay.win.getBounds();
    overlay.applySize(SCALE_BY_SIZE.medium);
    const medium = { ...overlay.win.getBounds() };
    expect(medium.x + medium.width / 2).toBeGreaterThan(area.x + area.width / 2);

    // Two pixels out, two along and three down (3.6 px), released there.
    const set = vi.spyOn(store, 'set');
    host.calls.length = 0;
    overlay.dragStart();
    overlay.dragMove(2, 0);
    overlay.dragMove(2, 3);
    expect(overlay.win.getBounds()).toEqual(medium);
    overlay.dragEnd();
    expect(host.calls).toEqual([]);
    expect(set).not.toHaveBeenCalled();
    // And the left edge is still the one kept: the round trip comes home.
    overlay.applySize(SCALE_BY_SIZE.large);
    expect(overlay.win.getBounds().x).toBe(start.x);
    overlay.applySize(SCALE_BY_SIZE.small);
    expect(overlay.win.getBounds()).toEqual(start);
  });

  it('a press that leaves the click slop drags from the press point, with no offset', () => {
    const store = fakeStore({ positions: { [key]: { x: 300, y: 400 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.medium, BOXES, NO_GAP);
    const origin = { ...overlay.win.getBounds() };
    overlay.dragStart();
    overlay.dragMove(3, 0);
    expect(overlay.win.getBounds()).toEqual(origin);
    // Past the slop the grab point is under the cursor again: origin + delta.
    overlay.dragMove(5, 1);
    expect(overlay.win.getBounds()).toEqual({ ...origin, x: origin.x + 5, y: origin.y + 1 });
    // Back inside the slop it still follows: the dead zone is for a pet only.
    overlay.dragMove(1, 0);
    expect(overlay.win.getBounds()).toEqual({ ...origin, x: origin.x + 1 });
    overlay.dragEnd();
    const saved = (store.get('positions') as Record<string, { x: number; y: number }>)[key];
    expect(saved?.x).toBe(301);
  });

  it('a press that travels the click slop is a drag, and re-decides', () => {
    const area = DISPLAY.workArea;
    const smallWidth = boxMetrics(SCALE_BY_SIZE.small, BOXES.stand, true, 0).width;
    const mediumWidth = boxMetrics(SCALE_BY_SIZE.medium, BOXES.stand, true, 0).width;
    const x = Math.round(area.x + area.width / 2 - (smallWidth + mediumWidth) / 4);
    const store = fakeStore({ positions: { [key]: { x, y: -1000 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    overlay.applySize(SCALE_BY_SIZE.medium);
    // 4.0 px is a drag (`isClick` is strictly below the slop): his centre is
    // on the right half where he is dropped, so the right edge is kept now.
    overlay.dragStart();
    overlay.dragMove(CLICK_SLOP_PX, 0);
    overlay.dragEnd();
    const dropped = overlay.win.getBounds();
    expect(dropped.x + dropped.width / 2).toBeGreaterThan(area.x + area.width / 2);
    overlay.applySize(SCALE_BY_SIZE.large);
    const large = overlay.win.getBounds();
    expect(large.x + large.width).toBe(dropped.x + dropped.width);
  });

  it('a pet does not re-decide top or bottom either: grown across the mid-height, he still shrinks home', () => {
    const area = DISPLAY.workArea;
    const smallHeight = boxMetrics(SCALE_BY_SIZE.small, BOXES.stand, true, 0).height;
    // Just above the mid-height at Small: the top of his ink is kept, and
    // growing downwards from it carries his centre onto the bottom half.
    const y = Math.round(area.y + area.height / 2 - smallHeight / 2 - 10);
    // Well on the left half at every size, so only top-or-bottom is in play.
    const store = fakeStore({ positions: { [key]: { x: 100, y } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
    const start = overlay.win.getBounds();
    expect(start.y + start.height / 2).toBeLessThan(area.y + area.height / 2);
    overlay.applySize(SCALE_BY_SIZE.large);
    const large = overlay.win.getBounds();
    expect(large.x).toBe(start.x);
    expect(large.x + large.width / 2).toBeLessThan(area.x + area.width / 2);
    expect(inkTop(large, SCALE_BY_SIZE.large, BOXES)).toBe(inkTop(start, SCALE_BY_SIZE.small, BOXES));
    expect(large.y + large.height / 2).toBeGreaterThan(area.y + area.height / 2);
    overlay.dragStart();
    overlay.dragEnd();
    overlay.applySize(SCALE_BY_SIZE.small);
    expect(overlay.win.getBounds()).toEqual(start);
  });

  it('leaves a spot saved flush under the old frame clamp where it was (RECHECK e: no migration)', () => {
    // Saved before the margin: the frame's top on the area's top. His ink is
    // four rows lower than that, so it is inside and the launch keeps it.
    const area = DISPLAY.workArea;
    const old = { x: 600, y: area.y - boxMetrics(SCALE_BY_SIZE.small, BOXES.stand, true, 0).bubbleReserve };
    const store = fakeStore({ positions: { [key]: old } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, INKED, NO_GAP);
    expect({ x: overlay.win.getBounds().x, y: overlay.win.getBounds().y }).toEqual(old);
    // Dragged hard into the top, he now goes the margin higher than that.
    overlay.dragStart();
    overlay.dragMove(0, -500);
    overlay.dragEnd();
    expect(overlay.win.getBounds().y).toBe(old.y - 4 * SCALE_BY_SIZE.small);
  });

  it('keeps the top of his ink through a box change: no shift for sleep and back', () => {
    const store = fakeStore({ positions: { [key]: { x: 600, y: 200 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.medium, BOXES, NO_GAP);
    const before = overlay.win.getBounds();
    overlay.applyBox('sleep');
    const asleep = overlay.win.getBounds();
    expect(asleep.y + asleep.height).toBe(before.y + before.height);
    overlay.applyBox('stand');
    expect(overlay.win.getBounds()).toEqual(before);
  });

  it('keeps a dog asleep or lying flush with the top edge flush through a size change', () => {
    for (const dpr of [1, 1.25]) {
      DISPLAY.scaleFactor = dpr;
      for (const box of ['sleep', 'lie'] as const) {
        const top = (b: Rect, scale: number): number =>
          b.y +
          (drawnInkInset({
            metrics: boxMetrics(scale, INKED[box], false, 0),
            scale,
            box: INKED[box],
            standBox: INKED.stand,
            dpr
          }).top ?? 0);
        const store = fakeStore({ positions: { [key]: { x: 600, y: 300 } } });
        const overlay = createOverlay(store, SCALE_BY_SIZE.small, INKED, NO_GAP);
        overlay.applyBox(box);
        overlay.dragStart();
        overlay.dragMove(0, -5000);
        overlay.dragEnd();
        const start = overlay.win.getBounds();
        expect(top(start, SCALE_BY_SIZE.small), `${box} dpr ${dpr}`).toBe(DISPLAY.workArea.y);
        for (const step of ['medium', 'large', 'small'] as const) {
          overlay.applySize(SCALE_BY_SIZE[step]);
          expect(top(overlay.win.getBounds(), SCALE_BY_SIZE[step]), `${box} ${step} dpr ${dpr}`).toBe(
            DISPLAY.workArea.y
          );
        }
        expect(overlay.win.getBounds(), `${box} dpr ${dpr}`).toEqual(start);
      }
    }
  });

  it('does not hop him when he stands up from lying flush with the top edge (one shared margin)', () => {
    for (const scale of [SCALE_BY_SIZE.small, SCALE_BY_SIZE.large]) {
      const store = fakeStore({ positions: { [key]: { x: 600, y: -1000 } } });
      const overlay = createOverlay(store, scale, INKED, NO_GAP);
      const standing = overlay.win.getBounds();
      expect(inkTop(standing, scale, INKED)).toBe(DISPLAY.workArea.y);
      overlay.applyBox('lie');
      const lying = overlay.win.getBounds();
      expect(lying.y + lying.height, `scale ${scale}`).toBe(standing.y + standing.height);
      overlay.applyBox('stand');
      expect(overlay.win.getBounds(), `scale ${scale}`).toEqual(standing);
    }
  });
});

/**
 * Owner, 2026-11-20 ("fix it"): a dog parked flush against the left or right
 * side of a work area at Medium or Large did not come home sideways after a
 * size round trip. X1 keeps the resting window's side edge; his ink's side
 * inset grows with the size, so the shrink put his ink past the side, the
 * clamp pulled him in, and the grow kept the pulled-in edge. Flush with a side
 * of the screen (an edge of the work areas' union, within a pixel), a scale
 * change now keeps his ink's side edge; everywhere else X1 is unchanged.
 */
describe('a size round trip at a side (owner, 2026-11-20)', () => {
  const key = `${DISPLAY.id}:${DISPLAY.bounds.width}x${DISPLAY.bounds.height}`;
  const sizes = ['small', 'medium', 'large'] as const;
  type Box = keyof typeof BOXES;
  /** His drawn ink's left and right edge in window `b`, showing `box` with no bubble. */
  const sides = (
    b: Rect,
    scale: number,
    box: Box,
    dpr: number = DISPLAY.scaleFactor
  ): { left: number; right: number } => {
    const m = boxMetrics(scale, BOXES[box], box === 'stand', 0);
    const inset = drawnInkInset({ metrics: m, scale, box: BOXES[box], standBox: BOXES.stand, dpr });
    return { left: b.x + inset.left, right: b.x + b.width - inset.right };
  };
  const SPOTS = { left: -5000, right: 5000 } as const;

  for (const side of ['left', 'right'] as const) {
    for (const box of ['stand', 'sleep', 'lie'] as const) {
      for (const dpr of [1, 1.25, 1.5, 2]) {
        it(`flush ${side}, ${box}, dpr ${dpr}: every round trip comes back to the same rect`, () => {
          DISPLAY.scaleFactor = dpr;
          const area = DISPLAY.workArea;
          const edge = side === 'left' ? area.x : area.x + area.width;
          for (const from of sizes) {
            for (const via of sizes) {
              if (via === from) continue;
              const trip = `${from} -> ${via} -> ${from}`;
              const store = fakeStore({ positions: { [key]: { x: 600, y: 400 } } });
              const overlay = createOverlay(store, SCALE_BY_SIZE[from], BOXES, NO_GAP);
              overlay.applyBox(box);
              // Put there by a drag in the box he is showing: flush with the side.
              overlay.dragStart();
              overlay.dragMove(SPOTS[side], 0);
              overlay.dragEnd();
              const start = { ...overlay.win.getBounds() };
              expect(sides(start, SCALE_BY_SIZE[from], box)[side], trip).toBe(edge);
              for (const step of [via, from] as const) {
                overlay.applySize(SCALE_BY_SIZE[step]);
                expect(
                  sides(overlay.win.getBounds(), SCALE_BY_SIZE[step], box)[side],
                  `${trip} at ${step}`
                ).toBe(edge);
              }
              expect(overlay.win.getBounds(), trip).toEqual(start);
            }
          }
        });
      }
    }
  }

  it('flush at launch: Large -> Small -> Large and Medium -> Large -> Medium come home, and the spot saved is the start', () => {
    for (const side of ['left', 'right'] as const) {
      for (const [from, via] of [
        ['large', 'small'],
        ['medium', 'large']
      ] as const) {
        const label = `${side} ${from} -> ${via}`;
        const store = fakeStore({ positions: { [key]: { x: SPOTS[side], y: 400 } } });
        const overlay = createOverlay(store, SCALE_BY_SIZE[from], BOXES, NO_GAP);
        const start = { ...overlay.win.getBounds() };
        overlay.applySize(SCALE_BY_SIZE[via]);
        overlay.applySize(SCALE_BY_SIZE[from]);
        expect(overlay.win.getBounds(), label).toEqual(start);
        expect((store.get('positions') as Record<string, unknown>)[key], label).toEqual({
          x: start.x,
          y: start.y
        });
      }
    }
  });

  it('still maps home onto home at every size, and keeps the window edges mid-screen (X1)', () => {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      DISPLAY.scaleFactor = dpr;
      // Home: Reset at each size, then every size change lands on that size's home.
      const overlay = createOverlay(fakeStore(), SCALE_BY_SIZE.small, BOXES, NO_GAP);
      const homes = new Map<string, Rect>();
      for (const size of sizes) {
        overlay.applySize(SCALE_BY_SIZE[size]);
        overlay.resetPosition();
        homes.set(size, { ...overlay.win.getBounds() });
      }
      for (const from of sizes) {
        for (const to of sizes) {
          overlay.applySize(SCALE_BY_SIZE[from]);
          overlay.resetPosition();
          overlay.applySize(SCALE_BY_SIZE[to]);
          expect(overlay.win.getBounds(), `home ${from} -> ${to} dpr ${dpr}`).toEqual(homes.get(to));
        }
      }
      // Mid-screen: the left half keeps the window's left edge, the right half its right edge.
      for (const [x, keep] of [
        [300, 'left'],
        [1000, 'right']
      ] as const) {
        const store = fakeStore({ positions: { [key]: { x, y: 400 } } });
        const mid = createOverlay(store, SCALE_BY_SIZE.small, BOXES, NO_GAP);
        const start = { ...mid.win.getBounds() };
        for (const step of ['large', 'medium', 'small'] as const) {
          mid.applySize(SCALE_BY_SIZE[step]);
          const b = mid.win.getBounds();
          if (keep === 'left') expect(b.x, `mid ${x} ${step} dpr ${dpr}`).toBe(start.x);
          else expect(b.x + b.width, `mid ${x} ${step} dpr ${dpr}`).toBe(start.x + start.width);
        }
        expect(mid.win.getBounds(), `mid ${x} dpr ${dpr}`).toEqual(start);
      }
    }
  });

  // The known limit, pinned: a Large dog nearer a side than the growth of his
  // side inset (16 px at 1x from Small) is clamped flush by the shrink, and the
  // grow then keeps that flush edge. He ends flush, not where he was (before
  // 2026-11-20 he ended 16 px in, not where he was either).
  it('a Large dog a few pixels off a side ends flush after Large -> Small -> Large', () => {
    const store = fakeStore({ positions: { [key]: { x: -5000, y: 400 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.large, BOXES, NO_GAP);
    overlay.dragStart();
    overlay.dragMove(5, 0);
    overlay.dragEnd();
    expect(sides(overlay.win.getBounds(), SCALE_BY_SIZE.large, 'stand').left).toBe(DISPLAY.workArea.x + 5);
    overlay.applySize(SCALE_BY_SIZE.small);
    expect(sides(overlay.win.getBounds(), SCALE_BY_SIZE.small, 'stand').left).toBe(DISPLAY.workArea.x);
    overlay.applySize(SCALE_BY_SIZE.large);
    expect(sides(overlay.win.getBounds(), SCALE_BY_SIZE.large, 'stand').left).toBe(DISPLAY.workArea.x);
  });

  it('flush is within a pixel: 1 px off a side keeps the ink edge, 2 px off keeps the window edge (X1)', () => {
    const area = DISPLAY.workArea;
    const small = SCALE_BY_SIZE.small;
    const large = SCALE_BY_SIZE.large;
    const m = boxMetrics(small, BOXES.stand, true, 0);
    const flushX = area.x - drawnInkInset({ metrics: m, scale: small, box: BOXES.stand, standBox: BOXES.stand, dpr: 1 }).left;
    for (const off of [1, 2]) {
      const store = fakeStore({ positions: { [key]: { x: flushX + off, y: 400 } } });
      const overlay = createOverlay(store, small, BOXES, NO_GAP);
      const start = { ...overlay.win.getBounds() };
      overlay.applySize(large);
      const b = overlay.win.getBounds();
      if (off === 1) expect(sides(b, large, 'stand').left, `${off} px`).toBe(area.x + 1);
      else expect(b.x, `${off} px`).toBe(start.x);
      overlay.applySize(small);
      expect(overlay.win.getBounds(), `${off} px`).toEqual(start);
    }
  });

  // The usual way to be flush asleep: he fell asleep where he stood flush. The
  // sleep box is narrower and a box change keeps the left edge, so asleep at a
  // right side he is 11 sprite px short of it; the ink kept is the one he will
  // stand in, which is flush (before, Large -> Small -> Large there ended 5 px
  // short of the side, awake).
  it.each([1, 1.25, 1.5, 2])('standing flush, then asleep, dpr %s: the round trip asleep comes back, and so does he when he wakes', (dpr) => {
    DISPLAY.scaleFactor = dpr;
    for (const side of ['left', 'right'] as const) {
      for (const [from, via] of [
        ['medium', 'large'],
        ['medium', 'small'],
        ['large', 'small'],
        ['large', 'medium']
      ] as const) {
        const label = `${side} ${from} -> ${via}`;
        const store = fakeStore({ positions: { [key]: { x: SPOTS[side], y: 400 } } });
        const overlay = createOverlay(store, SCALE_BY_SIZE[from], BOXES, NO_GAP);
        const standing = { ...overlay.win.getBounds() };
        overlay.applyBox('sleep');
        const asleep = { ...overlay.win.getBounds() };
        overlay.applySize(SCALE_BY_SIZE[via]);
        overlay.applySize(SCALE_BY_SIZE[from]);
        // At a fractional ratio the sleep box is drawn a pixel or three out of
        // step with the standing one, the clamp nudges him asleep, and the
        // nudge is not undone: the known limit. He still wakes where he stood.
        const back = overlay.win.getBounds();
        if (Number.isInteger(dpr)) expect(back, label).toEqual(asleep);
        else expect(Math.abs(back.x - asleep.x), label).toBeLessThanOrEqual(3);
        overlay.applyBox('stand');
        expect(overlay.win.getBounds(), label).toEqual(standing);
      }
    }
  });

  // Dragged asleep a few pixels in from a side, the ink he will stand in is
  // wider and hangs past it: both nudges are pulled back the same way, so the
  // side is the way the clamp moves him. Before this was checked, a right side
  // read as left and Large -> Small -> Large ended 160 px in (review, 2026-11-20).
  it.each([1, 1.25, 1.5, 2])('asleep a few pixels in from a side, dpr %s: a round trip ends no further from the side than he was', (dpr) => {
    DISPLAY.scaleFactor = dpr;
    const area = DISPLAY.workArea;
    for (const side of ['left', 'right'] as const) {
      for (const off of [3, 5, 8, 12, 30]) {
        for (const [from, via] of [
          ['large', 'small'],
          ['medium', 'small'],
          ['large', 'medium'],
          ['small', 'large']
        ] as const) {
          const label = `${side} ${off} px ${from} -> ${via}`;
          const store = fakeStore({ positions: { [key]: { x: 600, y: 400 } } });
          const overlay = createOverlay(store, SCALE_BY_SIZE[from], BOXES, NO_GAP);
          overlay.applyBox('sleep');
          overlay.dragStart();
          overlay.dragMove(SPOTS[side], 0);
          overlay.dragEnd();
          overlay.dragStart();
          overlay.dragMove(side === 'left' ? off : -off, 0);
          overlay.dragEnd();
          const gap = (b: Rect): number => {
            const ink = sides(b, SCALE_BY_SIZE[from], 'sleep');
            return side === 'left' ? ink.left - area.x : area.x + area.width - ink.right;
          };
          const start = gap(overlay.win.getBounds());
          overlay.applySize(SCALE_BY_SIZE[via]);
          overlay.applySize(SCALE_BY_SIZE[from]);
          const end = gap(overlay.win.getBounds());
          expect(end, label).toBeGreaterThanOrEqual(0);
          expect(end, label).toBeLessThanOrEqual(start + 1);
        }
      }
    }
  });

  it('a box change at a flush side still keeps the left edge, and a bark does not move him', () => {
    for (const side of ['left', 'right'] as const) {
      const store = fakeStore({ positions: { [key]: { x: SPOTS[side], y: 400 } } });
      const overlay = createOverlay(store, SCALE_BY_SIZE.large, BOXES, NO_GAP);
      const start = { ...overlay.win.getBounds() };
      overlay.applyBox('sleep');
      expect(overlay.win.getBounds().x, side).toBe(start.x);
      overlay.applyBox('stand');
      expect(overlay.win.getBounds(), side).toEqual(start);
      overlay.applyBubble(30);
      const barking = overlay.win.getBounds();
      expect(barking.x + (barking.width - start.width) / 2, side).toBe(start.x);
      overlay.applyBubble(0);
      expect(overlay.win.getBounds(), side).toEqual(start);
    }
  });

  describe('two displays side by side', () => {
    const display = (id: number, x: number): (typeof host.displays)[number] => ({
      id,
      bounds: { x, y: 0, width: 1000, height: 800 },
      workArea: { x, y: 0, width: 1000, height: 800 },
      scaleFactor: 1
    });
    const left = display(21, 0);
    const rightHand = display(22, 1000);
    const keyOf = (d: typeof left): string => `${d.id}:${d.bounds.width}x${d.bounds.height}`;
    const LARGE = SCALE_BY_SIZE.large;
    const SMALL = SCALE_BY_SIZE.small;

    it('the seam is not a side: X1 keeps the window edge there, he may stand across it, and comes home', () => {
      host.displays = [left, rightHand];
      // A Large dog whose ink ends exactly at the seam, on the right half of the left display.
      const m = boxMetrics(LARGE, BOXES.stand, true, 0);
      const inset = drawnInkInset({ metrics: m, scale: LARGE, box: BOXES.stand, standBox: BOXES.stand, dpr: 1 });
      const x = 1000 - m.width + inset.right;
      const store = fakeStore({ positions: { [keyOf(left)]: { x, y: 400 } } });
      const overlay = createOverlay(store, LARGE, BOXES, NO_GAP);
      const start = { ...overlay.win.getBounds() };
      expect(sides(start, LARGE, 'stand', 1).right).toBe(1000);
      overlay.applySize(SMALL);
      const small = overlay.win.getBounds();
      // The window's right edge is kept (X1), so his smaller ink crosses the seam.
      expect(small.x + small.width).toBe(start.x + start.width);
      expect(sides(small, SMALL, 'stand', 1).right).toBeGreaterThan(1000);
      overlay.applySize(LARGE);
      expect(overlay.win.getBounds()).toEqual(start);
    });

    it('where the neighbour does not reach down to him, the seam is a side', () => {
      // The left display is half as tall: below its bottom, the tall display's
      // left edge is a side, and a dog flush with it comes home.
      const short = { ...left, bounds: { ...left.bounds, height: 400 }, workArea: { ...left.workArea, height: 400 } };
      host.displays = [short, rightHand];
      const m = boxMetrics(LARGE, BOXES.stand, true, 0);
      const inset = drawnInkInset({
        metrics: m,
        scale: LARGE,
        box: BOXES.stand,
        standBox: BOXES.stand,
        dpr: 1
      });
      const store = fakeStore({ positions: { [keyOf(rightHand)]: { x: 1000 - inset.left, y: 600 } } });
      const overlay = createOverlay(store, LARGE, BOXES, NO_GAP);
      const start = { ...overlay.win.getBounds() };
      expect(sides(start, LARGE, 'stand', 1).left).toBe(1000);
      overlay.applySize(SMALL);
      expect(sides(overlay.win.getBounds(), SMALL, 'stand', 1).left).toBe(1000);
      overlay.applySize(LARGE);
      expect(overlay.win.getBounds()).toEqual(start);
    });

    it('the outer sides of the pair are sides: flush there, a round trip comes home', () => {
      host.displays = [left, rightHand];
      for (const [x, k, side, edge] of [
        [-5000, keyOf(left), 'left', 0],
        [5000, keyOf(rightHand), 'right', 2000]
      ] as const) {
        const store = fakeStore({ positions: { [k]: { x, y: 400 } } });
        const overlay = createOverlay(store, LARGE, BOXES, NO_GAP);
        const start = { ...overlay.win.getBounds() };
        expect(sides(start, LARGE, 'stand', 1)[side], side).toBe(edge);
        overlay.applySize(SMALL);
        expect(sides(overlay.win.getBounds(), SMALL, 'stand', 1)[side], side).toBe(edge);
        overlay.applySize(LARGE);
        expect(overlay.win.getBounds(), side).toEqual(start);
      }
    });
  });
});

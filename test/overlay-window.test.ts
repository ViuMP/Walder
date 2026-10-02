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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rect } from '../src/core/geometry';
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
  cursor: { x: 0, y: 0 }
}));

vi.mock('electron-store', () => ({ default: class {} }));

vi.mock('electron', () => {
  class FakeWebContents {
    setWindowOpenHandler(): void {}
    on(): void {}
    send(channel: string, payload: unknown): void {
      host.sent.push({ channel, payload, setBoundsBefore: host.bounds.length });
    }
    isDestroyed(): boolean {
      return false;
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
    }
    on(): void {}
    setAlwaysOnTop(): void {}
    setVisibleOnAllWorkspaces(): void {}
    setSkipTaskbar(): void {}
    setMenuBarVisibility(): void {}
    setIgnoreMouseEvents(): void {}
    loadURL(): Promise<void> {
      return Promise.resolve();
    }
    isResizable(): boolean {
      return this.resizable;
    }
    setResizable(next: boolean): void {
      this.resizable = next;
    }
    getBounds(): Rect {
      return this.bounds;
    }
    setBounds(rect: Rect): void {
      host.calls.push('setBounds');
      host.bounds.push(rect);
      this.bounds = rect;
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
      return false;
    }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    screen: {
      on: () => {},
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
  workArea: { x: 0, y: 25, width: 1440, height: 875 }
};

const { createOverlay, PAINT_SIGNAL_GRACE_MS } = await import('../src/main/overlay-window');
const { DEFAULTS } = await import('../src/main/store');
const { CH, SCALE_BY_SIZE } = await import('../src/main/ipc');
const { boxMetrics, bubbleExtraPx, inkInset } = await import('../src/core/geometry');

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
  return createOverlay(fakeStore(), 2, BOXES);
}

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
      const first = createOverlay(store, 2, BOXES);
      const standY = first.win.getBounds().y;

      first.applyBox(other);
      createOverlay(store, 2, BOXES);
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
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES);
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
 * a size change keeps him wholly on screen, so the Large dog no longer hangs
 * off the right edge — he is pulled left until his ink meets it. The widening
 * must be measured from where he *landed*: the window is still widened
 * symmetrically about him, so its right half hangs off, and the bubble has to
 * be laid out in what is on screen (`bubbleExtraPx` in `core/geometry.ts` has
 * the numbers).
 */
describe('a size change with a bubble up at the right edge', () => {
  it('pulls him on screen and widens until the on-screen part holds the bubble', () => {
    const area = DISPLAY.workArea;
    const largeMetrics = boxMetrics(SCALE_BY_SIZE.large, BOXES.stand, true, 0);
    const large = largeMetrics.width;
    // `defaultPosition`: the Small window, 16 px in from the right.
    const restX = area.x + area.width - boxMetrics(1, BOXES.stand, true, 0).width - 16;
    const key = `${DISPLAY.id}:${DISPLAY.bounds.width}x${DISPLAY.bounds.height}`;
    const store = fakeStore({ positions: { [key]: { x: restX, y: 600 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES);
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
    // …the dog's right ink edge is on the work area's right edge…
    const settled = area.x + area.width - large + inkInset(largeMetrics).right;
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
    const overlay = createOverlay(store, SCALE_BY_SIZE.large, BOXES);
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
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES);
    const small = overlay.win.getBounds();
    expect(small.x + small.width).toBe(area.x + area.width - 16);

    overlay.applySize(SCALE_BY_SIZE.large);
    const large = boxMetrics(SCALE_BY_SIZE.large, BOXES.stand, true, 0);
    const bounds = overlay.win.getBounds();
    const ink = inkOf(bounds, large);
    expect(whollyInside(ink)).toBe(true);
    // Moved only as far as it had to: his right ink edge meets the work area's.
    expect(ink.x + ink.width).toBe(area.x + area.width);
    // He still stands on the same bottom edge — there was room for that.
    expect(bounds.y + bounds.height).toBe(small.y + small.height);
    // The resting position saved is the clamped one, not the off-screen anchor.
    expect(savedAt(store)).toEqual({ x: bounds.x, y: bounds.y });
  });

  it('keeps the bottom-left corner put for a resize mid-screen', () => {
    const store = fakeStore({ positions: { [key]: { x: 300, y: 500 } } });
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES);
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
    const overlay = createOverlay(store, SCALE_BY_SIZE.large, BOXES);
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
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES);
    expect(overlay.win.getBounds().x).toBe(parkedX);

    overlay.applyBox('sleep');
    overlay.applyBox('stand');
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
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES);
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
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES);
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
    const overlay = createOverlay(store, SCALE_BY_SIZE.small, BOXES);
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

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
  sent: [] as { channel: string; payload: unknown }[]
}));

vi.mock('electron-store', () => ({ default: class {} }));

vi.mock('electron', () => {
  class FakeWebContents {
    setWindowOpenHandler(): void {}
    on(): void {}
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
      getDisplayMatching: () => DISPLAY
    }
  };
});

const DISPLAY = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 875 }
};

const { createOverlay } = await import('../src/main/overlay-window');
const { DEFAULTS } = await import('../src/main/store');

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

/** The sheet's two boxes, at the v3 dimensions. */
const BOXES = {
  stand: { width: 72, height: 72 },
  sleep: { width: 61, height: 58 }
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

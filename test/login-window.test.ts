/**
 * The login windows: the one place Walder shows real web content, and the one
 * place it holds a live session whose cookies the poller later uses.
 *
 * Three findings from the 2026-09-08 security gate are pinned here.
 *
 *  1. **The allowlist had a hole at every popup.** An allowed `window.open`
 *     returned `{action: 'allow'}` and the resulting child got *no handlers* —
 *     no open handler, no `will-navigate`, no `will-redirect` — so one
 *     allowlisted host that could be made to open a window was enough to browse
 *     anywhere with the owner's session attached. `lockLoginWindow` is now
 *     re-applied to every child, recursively, and there is a `did-navigate`
 *     backstop that reverts a URL which commits anyway.
 *  2. **No preload, ever.** This window must not be able to reach Walder's IPC
 *     bridge; it is a browser, not part of the app.
 *  3. **A logout clears one partition.** The two services are deliberately in
 *     separate `persist:` partitions so neither site can see the other's
 *     cookies, and logging out of one must not touch the other.
 *
 * Plus the close condition, which is the HIGH bug the window had: it closed
 * about two seconds after opening for anyone with Claude Code installed,
 * because it asked "is any provider available" instead of "is this web login
 * authenticated".
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import type { BrowserWindow } from 'electron';

const host = vi.hoisted(() => ({
  built: [] as Record<string, unknown>[],
  /** Partitions `clearStorageData` was called on, in order. */
  cleared: [] as string[],
  /** Partitions a permission handler was installed on. */
  permissioned: [] as string[],
  /** Every `session.fromPartition` argument, in order. */
  partitions: [] as string[],
  windows: [] as FakeWindowLike[],
  closed: 0
}));

interface FakeWindowLike {
  readonly options: Record<string, unknown>;
  readonly loaded: string[];
  readonly openHandlers: ((details: { url: string }) => { action: string; overrideBrowserWindowOptions?: Record<string, unknown> })[];
  emit(event: string, ...args: unknown[]): void;
  handlerCount(event: string): number;
}

vi.mock('electron', () => {
  class FakeWebContents {
    readonly listeners = new Map<string, ((...args: never[]) => void)[]>();
    readonly loaded: string[] = [];
    readonly openHandlers: ((details: { url: string }) => {
      action: string;
      overrideBrowserWindowOptions?: Record<string, unknown>;
    })[] = [];

    setWindowOpenHandler(
      handler: (details: { url: string }) => {
        action: string;
        overrideBrowserWindowOptions?: Record<string, unknown>;
      }
    ): void {
      this.openHandlers.push(handler);
    }

    on(event: string, listener: (...args: never[]) => void): this {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return this;
    }

    loadURL(url: string): Promise<void> {
      this.loaded.push(url);
      return Promise.resolve();
    }
  }

  class FakeBrowserWindow {
    readonly webContents = new FakeWebContents();
    readonly windowListeners = new Map<string, ((...args: never[]) => void)[]>();
    readonly options: Record<string, unknown>;
    private destroyed = false;

    constructor(options: Record<string, unknown> = {}) {
      this.options = options;
      host.built.push(options);
      host.windows.push(this as unknown as FakeWindowLike);
    }

    get loaded(): string[] {
      return this.webContents.loaded;
    }
    get openHandlers(): FakeWebContents['openHandlers'] {
      return this.webContents.openHandlers;
    }

    on(event: string, listener: (...args: never[]) => void): this {
      const list = this.windowListeners.get(event) ?? [];
      list.push(listener);
      this.windowListeners.set(event, list);
      return this;
    }
    once(event: string, listener: (...args: never[]) => void): this {
      return this.on(event, listener);
    }
    /** `BrowserWindow.loadURL` delegates to its webContents, as Electron's does. */
    loadURL(url: string): Promise<void> {
      return this.webContents.loadURL(url);
    }
    show(): void {}
    focus(): void {}
    close(): void {
      host.closed++;
      this.destroyed = true;
      for (const listener of this.windowListeners.get('closed') ?? []) {
        (listener as () => void)();
      }
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }

    /** Fire a `webContents` event, as Electron would. */
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.webContents.listeners.get(event) ?? []) {
        (listener as (...a: unknown[]) => void)(...args);
      }
    }
    handlerCount(event: string): number {
      return (this.webContents.listeners.get(event) ?? []).length;
    }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    net: { fetch: () => Promise.reject(new Error('not used in this test')) },
    session: {
      fromPartition: (partition: string) => {
        host.partitions.push(partition);
        return {
          setPermissionRequestHandler: () => host.permissioned.push(partition),
          setPermissionCheckHandler: () => undefined,
          clearStorageData: async () => {
            host.cleared.push(partition);
          },
          webRequest: { onCompleted: () => undefined },
          cookies: { get: async () => [] },
          fetch: () => Promise.reject(new Error('not used in this test'))
        };
      }
    }
  };
});

const {
  LOGIN_POLL_MS,
  LOGIN_URLS,
  createLoginWindows,
  lockLoginWindow
} = await import('../src/main/login-window');
const { PARTITIONS } = await import('../src/main/provider-chains');

/** The store slice `attachDiscovery` reaches for. */
function fakeStore() {
  const data: Record<string, unknown> = {};
  return {
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => {
      data[key] = value;
    },
    path: '/tmp/walder-test/walder.json'
  } as never;
}

beforeEach(() => {
  host.built.length = 0;
  host.cleared.length = 0;
  host.permissioned.length = 0;
  host.partitions.length = 0;
  host.windows.length = 0;
  host.closed = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Build a window through the mocked constructor, as Electron would hand us one. */
async function newWindow(): Promise<FakeWindowLike & BrowserWindow> {
  const { BrowserWindow: Fake } = await import('electron');
  return new Fake({}) as unknown as FakeWindowLike & BrowserWindow;
}

const NAV_EVENTS = ['will-navigate', 'will-redirect', 'will-frame-navigate', 'did-navigate'];

describe('lockLoginWindow', () => {
  it('attaches every navigation handler, plus the child hook', async () => {
    const win = await newWindow();
    lockLoginWindow(win, 'claude');

    expect(win.openHandlers).toHaveLength(1);
    for (const event of [...NAV_EVENTS, 'did-create-window']) {
      expect(win.handlerCount(event)).toBe(1);
    }
  });

  it('allows an allowlisted popup, in the same partition and with no preload', async () => {
    const win = await newWindow();
    lockLoginWindow(win, 'chatgpt');

    const result = win.openHandlers[0]?.({ url: 'https://auth.openai.com/authorize' });
    expect(result?.action).toBe('allow');
    const prefs = result?.overrideBrowserWindowOptions?.['webPreferences'] as Record<
      string,
      unknown
    >;
    expect(prefs['partition']).toBe(PARTITIONS.chatgpt);
    // A popup is as remote as its opener: no bridge into the app.
    expect(prefs).not.toHaveProperty('preload');
    expect(prefs['sandbox']).toBe(true);
    expect(prefs['contextIsolation']).toBe(true);
    expect(prefs['nodeIntegration']).toBe(false);
    expect(prefs['webviewTag']).toBe(false);
  });

  it('denies a popup outside the allowlist, and does not hand it to the OS browser', async () => {
    const win = await newWindow();
    lockLoginWindow(win, 'claude');
    for (const url of ['https://evil.example/', 'http://claude.ai/', 'javascript:alert(1)']) {
      expect(win.openHandlers[0]?.({ url })?.action).toBe('deny');
    }
  });

  it('blocks navigation and redirects outside the allowlist, and allows the flow itself', async () => {
    const win = await newWindow();
    lockLoginWindow(win, 'claude');

    for (const event of ['will-navigate', 'will-redirect']) {
      let prevented = false;
      win.emit(event, { preventDefault: () => (prevented = true) }, 'https://evil.example/login');
      expect(prevented).toBe(true);

      prevented = false;
      win.emit(
        event,
        { preventDefault: () => (prevented = true) },
        'https://accounts.google.com/o/oauth2/v2/auth'
      );
      expect(prevented).toBe(false);
    }
  });

  it('blocks a subframe navigation, where will-navigate never fires', async () => {
    const win = await newWindow();
    lockLoginWindow(win, 'claude');

    let prevented = false;
    win.emit('will-frame-navigate', {
      url: 'https://evil.example/frame',
      preventDefault: () => (prevented = true)
    });
    expect(prevented).toBe(true);

    prevented = false;
    win.emit('will-frame-navigate', {
      url: 'https://claude.ai/login',
      preventDefault: () => (prevented = true)
    });
    expect(prevented).toBe(false);
  });

  it('reverts to the login page when a URL outside the allowlist commits anyway', async () => {
    const win = await newWindow();
    lockLoginWindow(win, 'claude');

    win.emit('did-navigate', {}, 'https://evil.example/pwned');
    expect(win.loaded).toEqual([LOGIN_URLS.claude]);
  });

  it('leaves an allowlisted or blank committed URL alone', async () => {
    const win = await newWindow();
    lockLoginWindow(win, 'chatgpt');

    win.emit('did-navigate', {}, 'https://chatgpt.com/auth/login');
    // `about:blank` is exempt: a popup starts there, and reverting it would
    // break every login flow that uses one.
    win.emit('did-navigate', {}, 'about:blank');
    win.emit('did-navigate', {}, '');
    expect(win.loaded).toEqual([]);
  });

  it('locks every child window the same way, recursively', async () => {
    // The HIGH finding: an allowed popup used to get no handlers at all.
    const win = await newWindow();
    lockLoginWindow(win, 'claude');

    const child = await newWindow();
    win.emit('did-create-window', child);

    expect(child.openHandlers).toHaveLength(1);
    for (const event of [...NAV_EVENTS, 'did-create-window']) {
      expect(child.handlerCount(event)).toBe(1);
    }
    // The child enforces the same allowlist...
    expect(child.openHandlers[0]?.({ url: 'https://evil.example/' })?.action).toBe('deny');
    let prevented = false;
    child.emit('will-navigate', { preventDefault: () => (prevented = true) }, 'https://evil.example/');
    expect(prevented).toBe(true);
    // ...and so does *its* child.
    const grandchild = await newWindow();
    child.emit('did-create-window', grandchild);
    expect(grandchild.handlerCount('will-navigate')).toBe(1);
    expect(grandchild.openHandlers[0]?.({ url: 'https://evil.example/' })?.action).toBe('deny');
  });
});

describe('createLoginWindows', () => {
  function windows(isLoggedIn: () => Promise<boolean>) {
    const loggedIn: string[] = [];
    const handle = createLoginWindows({
      store: fakeStore(),
      isLoggedIn,
      onLoggedIn: (service) => loggedIn.push(service)
    });
    return { handle, loggedIn };
  }

  it('builds a window with no preload and a locked-down webPreferences', () => {
    const { handle } = windows(async () => false);
    handle.openLogin('claude');

    const prefs = host.built[0]?.['webPreferences'] as Record<string, unknown>;
    // Load-bearing: this window must not be able to reach the IPC bridge.
    expect(prefs).not.toHaveProperty('preload');
    expect(prefs['partition']).toBe(PARTITIONS.claude);
    expect(prefs['sandbox']).toBe(true);
    expect(prefs['contextIsolation']).toBe(true);
    expect(prefs['nodeIntegration']).toBe(false);
    expect(prefs['webviewTag']).toBe(false);
    expect(prefs['webSecurity']).toBe(true);
    expect(host.windows[0]?.loaded).toEqual([LOGIN_URLS.claude]);
    // And the partition denies every permission, as the overlay's session does.
    expect(host.permissioned).toEqual([PARTITIONS.claude]);
    handle.closeAll();
  });

  it('locks the window it builds', () => {
    const { handle } = windows(async () => false);
    handle.openLogin('chatgpt');
    const win = host.windows[0] as FakeWindowLike;
    expect(win.openHandlers).toHaveLength(1);
    for (const event of NAV_EVENTS) expect(win.handlerCount(event)).toBe(1);
    handle.closeAll();
  });

  it('focuses the existing window rather than opening a second one', () => {
    const { handle } = windows(async () => false);
    handle.openLogin('claude');
    handle.openLogin('claude');
    expect(host.built).toHaveLength(1);
    expect(handle.isOpen('claude')).toBe(true);
    expect(handle.isOpen('chatgpt')).toBe(false);
    handle.closeAll();
  });

  it('clears only its own partition on logout', async () => {
    const { handle } = windows(async () => false);
    await handle.logout('claude');
    expect(host.cleared).toEqual([PARTITIONS.claude]);
    expect(host.cleared).not.toContain(PARTITIONS.chatgpt);

    await handle.logout('chatgpt');
    expect(host.cleared).toEqual([PARTITIONS.claude, PARTITIONS.chatgpt]);
  });

  it('stays open while the web login is not authenticated', async () => {
    // The HIGH bug: with Claude Code installed the old check said "logged in"
    // immediately and the window shut before anything could be typed.
    vi.useFakeTimers();
    const { handle, loggedIn } = windows(async () => false);
    handle.openLogin('claude');

    await vi.advanceTimersByTimeAsync(LOGIN_POLL_MS * 10);
    expect(host.closed).toBe(0);
    expect(loggedIn).toEqual([]);
    expect(handle.isOpen('claude')).toBe(true);
    handle.closeAll();
  });

  it('closes once, and refreshes, when the login is authenticated', async () => {
    vi.useFakeTimers();
    let authenticated = false;
    const { handle, loggedIn } = windows(async () => authenticated);
    handle.openLogin('claude');

    await vi.advanceTimersByTimeAsync(LOGIN_POLL_MS * 2);
    expect(host.closed).toBe(0);

    authenticated = true;
    await vi.advanceTimersByTimeAsync(LOGIN_POLL_MS);
    expect(host.closed).toBe(1);
    expect(loggedIn).toEqual(['claude']);

    // And the watch is gone: no second close, no further checks.
    await vi.advanceTimersByTimeAsync(LOGIN_POLL_MS * 10);
    expect(host.closed).toBe(1);
    expect(loggedIn).toEqual(['claude']);
  });

  it('never runs two checks at once, however slow the answer is', async () => {
    // Each check is a real network request, so a slow one must not queue up
    // behind itself every 2 s for as long as the window is open.
    vi.useFakeTimers();
    let checks = 0;
    const { handle } = windows(
      () =>
        new Promise<boolean>(() => {
          checks++;
        })
    );
    handle.openLogin('chatgpt');

    await vi.advanceTimersByTimeAsync(LOGIN_POLL_MS * 8);
    expect(checks).toBe(1);
    handle.closeAll();
  });
});

/**
 * The login windows: the one place Walder shows real web content, and the one
 * place it holds a live session whose cookies the poller later uses.
 *
 * Four things are pinned here.
 *
 *  1. **The navigation rule is `https:` and never loopback**, not a host
 *     allowlist. That changed on 2026-09-08 because the allowlist made an
 *     enterprise SSO login impossible — see `login-hosts.ts` and its test for
 *     the reasoning. What this file adds is that the rule is enforced on all
 *     five events *and on every popup, recursively*: an allowed `window.open`
 *     used to return `{action: 'allow'}` and the resulting child got no handlers
 *     at all, so a page that could be made to open a window was unguarded.
 *  2. **Every top-level host is logged**, once, host only. An SSO flow that
 *     dead-ends is otherwise undiagnosable from a bug report.
 *  3. **No preload, ever.** This window must not be able to reach Walder's IPC
 *     bridge; it is a browser, not part of the app. And it presents a Chrome
 *     user agent, because Google refuses OAuth from one naming Electron.
 *  4. **A logout clears one partition.** The two services are deliberately in
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
  /** `[partition, userAgent]` for every `setUserAgent` call, in order. */
  userAgents: [] as [string, string][],
  windows: [] as FakeWindowLike[],
  closed: 0,
  /** Every `vlog` line, joined — for the host trail. */
  vlogs: [] as string[],
  /** Every `warn` line, joined — for the blocked-navigation lines. */
  warns: [] as string[]
}));

/**
 * The logger, captured. The host trail is a *feature* of this file (an SSO flow
 * that dead-ends can only be diagnosed from it), so it is asserted rather than
 * silenced — and asserted for what it must NOT contain as much as what it must.
 */
vi.mock('../src/main/log', () => ({
  vlog: (...args: unknown[]) => host.vlogs.push(args.map(String).join(' ')),
  warn: (...args: unknown[]) => host.warns.push(args.map(String).join(' ')),
  setVerbose: () => undefined,
  setLogSink: () => undefined,
  redact: (text: string) => text
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
    // The process-wide fallback, which workers inherit — cleaned alongside the
    // partitions' own UA. See `applyChromeUserAgentFallback`.
    app: {
      userAgentFallback:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) walder/0.1.1 Chrome/142.0.0.0 Electron/44.2.0 Safari/537.36'
    },
    net: { fetch: () => Promise.reject(new Error('not used in this test')) },
    session: {
      fromPartition: (partition: string) => {
        host.partitions.push(partition);
        return {
          setPermissionRequestHandler: () => host.permissioned.push(partition),
          setPermissionCheckHandler: () => undefined,
          // Electron's real default UA, with the two app tokens Walder strips.
          getUserAgent: () =>
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) walder/0.1.1 Chrome/142.0.0.0 Electron/44.2.0 Safari/537.36',
          setUserAgent: (ua: string) => host.userAgents.push([partition, ua]),
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
  host.vlogs.length = 0;
  host.warns.length = 0;
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

describe('LOGIN_URLS', () => {
  it('starts on the two hosts `LOGIN_START_HOSTS` names, over https', async () => {
    // The one navigation Walder chooses rather than follows — everything after
    // it is the site's decision. Nothing else would catch a typo here now that
    // there is no allowlist for a wrong host to fail.
    const { LOGIN_START_HOSTS, loginUrlHost } = await import('../src/core/login-hosts');
    expect(Object.values(LOGIN_URLS).map(loginUrlHost).sort()).toEqual(
      [...LOGIN_START_HOSTS].sort()
    );
    for (const url of Object.values(LOGIN_URLS)) {
      expect(url.startsWith('https://')).toBe(true);
    }
  });
});

describe('lockLoginWindow', () => {
  it('attaches every navigation handler, plus the child hook', async () => {
    const win = await newWindow();
    lockLoginWindow(win, 'claude');

    expect(win.openHandlers).toHaveLength(1);
    for (const event of [...NAV_EVENTS, 'did-create-window']) {
      expect(win.handlerCount(event)).toBe(1);
    }
  });

  it('allows an https popup, in the same partition and with no preload', async () => {
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

  it('allows an identity provider popup, and locks the window it opens', async () => {
    // "Continue with Google/Microsoft/SSO" opens its consent screen in a popup.
    // Denying it leaves an owner who has no password unable to log in at all —
    // and allowing it without re-locking is the hole the 09-08 gate found.
    const win = await newWindow();
    lockLoginWindow(win, 'claude');

    for (const url of [
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
      'https://appleid.apple.com/auth/authorize',
      'https://login.microsoftonline.com/common/oauth2/authorize',
      'https://acme.okta.com/app/anthropic/exk123/sso/saml',
      'https://challenges.cloudflare.com/turnstile/v0/manage'
    ]) {
      expect(win.openHandlers[0]?.({ url })?.action).toBe('allow');
    }

    const popup = await newWindow();
    win.emit('did-create-window', popup);
    expect(popup.openHandlers).toHaveLength(1);
    for (const event of [...NAV_EVENTS, 'did-create-window']) {
      expect(popup.handlerCount(event)).toBe(1);
    }
    let prevented = false;
    popup.emit(
      'will-navigate',
      { preventDefault: () => (prevented = true) },
      'http://claude.ai/login'
    );
    expect(prevented).toBe(true);
  });

  it('denies a refused popup, and does not hand it to the OS browser', async () => {
    // The URL was chosen by remote content; opening it in Safari instead would
    // just move the problem somewhere Walder cannot see.
    const win = await newWindow();
    lockLoginWindow(win, 'claude');
    for (const url of [
      'http://claude.ai/',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://127.0.0.1:8787/event',
      'https://localhost/'
    ]) {
      expect(win.openHandlers[0]?.({ url })?.action).toBe('deny');
    }
  });

  it('blocks refused navigations and redirects, and allows the SSO chain itself', async () => {
    const win = await newWindow();
    lockLoginWindow(win, 'claude');

    for (const event of ['will-navigate', 'will-redirect']) {
      for (const url of ['http://claude.ai/login', 'https://127.0.0.1:8787/event']) {
        let prevented = false;
        win.emit(event, { preventDefault: () => (prevented = true) }, url);
        expect(prevented, `${event} ${url}`).toBe(true);
      }

      // The hops a Team-plan SSO login actually makes. Every one of these was
      // blocked by the old allowlist, which is why the page loaded forever.
      for (const url of [
        'https://accounts.google.com/o/oauth2/v2/auth',
        'https://acme.okta.com/app/anthropic/exk123/sso/saml',
        'https://api-abcdef.duosecurity.com/frame/v4/auth/prompt',
        'https://claude.ai/api/auth/sso/callback'
      ]) {
        let prevented = false;
        win.emit(event, { preventDefault: () => (prevented = true) }, url);
        expect(prevented, `${event} ${url}`).toBe(false);
      }
    }
  });

  it('logs every top-level host once, and never a path or a query', async () => {
    // The owner can only report "it kept loading". This trail is what turns
    // that into a list of hosts somebody can look at — and the path and query
    // of an SSO URL carry one-time codes, SAML assertions and sometimes an
    // email address, so they must never reach the log.
    const win = await newWindow();
    lockLoginWindow(win, 'claude');

    const noop = { preventDefault: () => undefined };
    win.emit('will-navigate', noop, 'https://claude.ai/login');
    win.emit('will-navigate', noop, 'https://claude.ai/login/sso');
    win.emit('will-redirect', noop, 'https://acme.okta.com/sso/saml?SAMLRequest=SECRET');
    win.emit('did-navigate', {}, 'https://claude.ai/?code=SECRET2&email=a@b.c');

    const trail = host.vlogs.filter((line) => line.includes('top-level host'));
    // Once per host, not once per URL: claude.ai, okta, claude.ai again.
    expect(trail).toHaveLength(3);
    expect(trail[0]).toContain('claude.ai');
    expect(trail[1]).toContain('acme.okta.com');
    for (const line of host.vlogs) {
      expect(line).not.toContain('SECRET');
      expect(line).not.toContain('a@b.c');
      expect(line).not.toContain('/login/sso');
    }
  });

  it('names the host and the reason when it blocks something', async () => {
    const win = await newWindow();
    lockLoginWindow(win, 'chatgpt');
    win.emit(
      'will-redirect',
      { preventDefault: () => undefined },
      'https://127.0.0.1:8787/event?token=SECRET'
    );

    expect(host.warns).toHaveLength(1);
    expect(host.warns[0]).toContain('127.0.0.1');
    expect(host.warns[0]).toContain('loopback');
    expect(host.warns[0]).not.toContain('SECRET');
  });

  /** Fire `will-frame-navigate` and report whether it was prevented. */
  function frameNav(win: FakeWindowLike, url: string, isMainFrame: boolean): boolean {
    let prevented = false;
    win.emit('will-frame-navigate', {
      url,
      isMainFrame,
      preventDefault: () => (prevented = true)
    });
    return prevented;
  }

  it('holds a MAIN-frame navigation to the same rule', async () => {
    // `will-navigate` misses some main-frame navigations, so this event is the
    // one that catches them.
    const win = await newWindow();
    lockLoginWindow(win, 'claude');

    expect(frameNav(win, 'http://claude.ai/login', true)).toBe(true);
    expect(frameNav(win, 'https://localhost/frame', true)).toBe(true);
    expect(frameNav(win, 'https://claude.ai/login', true)).toBe(false);
    expect(frameNav(win, 'https://acme.okta.com/sso/saml', true)).toBe(false);
  });

  it('lets a SUBFRAME load any https host, which is what a login page needs', async () => {
    // The 2026-09-08 bug, in one test: the allowlist was enforced on iframes
    // too, so the Turnstile human check and the "continue with…" buttons never
    // loaded and neither login page could be used. An iframe here has no
    // preload, cannot reach the IPC bridge and is cross-origin to the page.
    const win = await newWindow();
    lockLoginWindow(win, 'chatgpt');

    for (const url of [
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile',
      'https://accounts.google.com/gsi/iframe/select',
      'https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js',
      'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.frame.html',
      'https://api-abcdef.duosecurity.com/frame/v4/auth/prompt',
      'https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html',
      'https://cdn.oaistatic.com/assets/x.js',
      'about:blank'
    ]) {
      expect(frameNav(win, url, false)).toBe(false);
    }
  });

  it('still refuses a subframe that is not https, or is this machine', async () => {
    // Not decorative: an `http:` frame is interceptable, `javascript:`/`data:`
    // are script injection into a window holding a live session, and a loopback
    // frame is a page in our own window talking to our own hook listener.
    const win = await newWindow();
    lockLoginWindow(win, 'claude');

    for (const url of [
      'http://challenges.cloudflare.com/turnstile',
      'http://claude.ai/login',
      'file:///etc/passwd',
      'data:text/html,<script>1</script>',
      'javascript:alert(document.cookie)',
      'ftp://claude.ai/',
      'https://127.0.0.1:8787/event'
    ]) {
      expect(frameNav(win, url, false)).toBe(true);
    }
  });

  it('reverts to the login page when a refused URL commits anyway', async () => {
    const win = await newWindow();
    lockLoginWindow(win, 'claude');

    win.emit('did-navigate', {}, 'http://evil.example/pwned');
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
    // The child enforces the same rule...
    expect(child.openHandlers[0]?.({ url: 'https://127.0.0.1:8787/' })?.action).toBe('deny');
    let prevented = false;
    child.emit('will-navigate', { preventDefault: () => (prevented = true) }, 'http://claude.ai/');
    expect(prevented).toBe(true);
    // ...and so does *its* child.
    const grandchild = await newWindow();
    child.emit('did-create-window', grandchild);
    expect(grandchild.handlerCount('will-navigate')).toBe(1);
    expect(grandchild.openHandlers[0]?.({ url: 'https://localhost/' })?.action).toBe('deny');
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

  it('presents a Chrome user agent on the partition, not an Electron one', async () => {
    // Google refuses OAuth from a UA carrying `Electron/…`, so the login page
    // would render and the "continue with Google" button would dead-end. The
    // partition is set once (see `sessionFor`), which is why this reads the
    // whole run's calls rather than only the ones this test caused.
    const { handle } = windows(async () => false);
    handle.openLogin('claude');
    handle.openLogin('chatgpt');

    const { PARTITIONS: partitions } = await import('../src/main/provider-chains');
    for (const partition of [partitions.claude, partitions.chatgpt]) {
      const set = host.userAgents.find(([p]) => p === partition);
      expect(set, `no user agent set on ${partition}`).toBeDefined();
      expect(set?.[1]).not.toMatch(/electron\//i);
      expect(set?.[1]).not.toMatch(/walder\//i);
      expect(set?.[1]).toMatch(/Chrome\/\d/);
    }
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

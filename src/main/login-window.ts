/**
 * The login windows — the only place Walder shows real web content.
 *
 * A normal, focusable, 480×720 window on `https://claude.ai/login` or
 * `https://chatgpt.com/auth/login`, running in the same `persist:` partition the
 * matching provider polls from. The owner logs in exactly as they would in a
 * browser, and the cookies land where the provider can use them.
 *
 * Everything about this window is locked down, because it is the one attack
 * surface in the app:
 *
 *  - **No preload, ever.** This window must not be able to reach Walder's IPC
 *    bridge. It is a browser, not part of the app.
 *  - `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`,
 *    `webviewTag: false`.
 *  - **Navigation is allowlisted** (`core/login-hosts.ts`), for in-window
 *    navigation, redirects, subframes and `window.open` — and, recursively, for
 *    every popup an allowed page opens (`lockLoginWindow`). A login flow
 *    legitimately walks through several hosts — the product, its auth service,
 *    Google/Microsoft/Apple — and nothing outside that list is followed. A
 *    denied `window.open` is *not* handed to the OS browser: the URL was chosen
 *    by remote content, and opening it elsewhere just moves the problem.
 *  - **No permissions.** The partition denies camera, microphone, geolocation
 *    and the rest, exactly as the overlay's session does. A login page has no
 *    business asking, and a permission dialog from a mascot would be
 *    inexplicable.
 *
 * The window closes itself once the service's **web** provider reports that it
 * is *authenticated* — not that a cookie exists, and not that some other
 * provider for the same service is available — checked every 2 s while the
 * window is open, and it triggers an immediate refresh so the owner sees the
 * dog's face change instead of having to work out whether it worked.
 */
import { BrowserWindow } from 'electron';
import type { Session } from 'electron';
import { isAllowedLoginUrl } from '../core/login-hosts';
import {
  attachDiscovery,
  DISCOVERY_RE,
  type DiscoveryStore,
  type WebRequestSession
} from '../providers/endpoint-discovery';
import { CLAUDE_AI_ORIGIN } from '../providers/claude-web';
import { CHATGPT_ORIGIN } from '../providers/chatgpt-web';
import { sessionFor, PARTITIONS } from './provider-chains';
import type { ServiceName } from './ipc';
import type { WalderStore } from './store';
import { vlog, warn } from './log';

export const LOGIN_WINDOW_WIDTH = 480;
export const LOGIN_WINDOW_HEIGHT = 720;

/** How often to check whether the login has taken. */
export const LOGIN_POLL_MS = 2_000;

/** Give up watching after this long; the window stays open for the owner. */
export const LOGIN_WATCH_TIMEOUT_MS = 10 * 60_000;

export const LOGIN_URLS: Readonly<Record<ServiceName, string>> = {
  claude: 'https://claude.ai/login',
  chatgpt: 'https://chatgpt.com/auth/login'
};

const ORIGINS: Readonly<Record<ServiceName, string>> = {
  claude: CLAUDE_AI_ORIGIN,
  chatgpt: CHATGPT_ORIGIN
};

/** Store key each service's discovered endpoints go to. */
const DISCOVERY_KEYS: Readonly<Record<ServiceName, string>> = {
  claude: 'claudeDiscoveredEndpoints',
  chatgpt: 'chatgptDiscoveredEndpoints'
};

const TITLES: Readonly<Record<ServiceName, string>> = {
  claude: 'Log in to Claude',
  chatgpt: 'Log in to ChatGPT'
};

/** Refuse every permission in a login partition, as the overlay's session does. */
function denyPermissions(target: Session): void {
  target.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  target.setPermissionCheckHandler(() => false);
}

/**
 * Apply the whole navigation lock to one login window — and to every window it
 * goes on to open.
 *
 * This is one function rather than a block inside `build` because of the hole
 * that used to be here: an *allowed* popup was returned from
 * `setWindowOpenHandler` and then got no handlers of its own. Everything the
 * allowlist protects — in-window navigation, redirects, subframes, further
 * popups — was unguarded in that child, so a single allowlisted host that could
 * be made to open a window was enough to browse anywhere with the owner's live
 * session attached. `did-create-window` now re-applies this function to each
 * child, which makes the lock recursive by construction: a grandchild is locked
 * by its parent's copy of the same handler.
 *
 * Five layers, because each covers a case the others miss:
 *  - `setWindowOpenHandler` — `window.open`, deciding whether a child exists.
 *  - `will-navigate` — a navigation the page starts in itself.
 *  - `will-redirect` — a server redirect the page did not choose.
 *  - `will-frame-navigate` — the same, in an iframe (`will-navigate` is
 *    main-frame only, and an iframe shares the partition's cookies).
 *  - `did-navigate` — the backstop. If a URL outside the allowlist ever commits
 *    anyway (an Electron edge case, a redirect form nothing above matched), the
 *    window is put back on the login page rather than left sitting on it.
 */
export function lockLoginWindow(win: BrowserWindow, service: ServiceName): void {
  const partition = PARTITIONS[service];
  const wc = win.webContents;

  wc.setWindowOpenHandler(({ url }) => {
    if (isAllowedLoginUrl(url)) {
      // Some identity providers open their consent screen in a popup. Keep it
      // inside the same partition, with the same rules, and never in the OS
      // browser (where the login would land in a session we cannot read).
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: LOGIN_WINDOW_WIDTH,
          height: LOGIN_WINDOW_HEIGHT,
          webPreferences: {
            partition,
            // No `preload` here either: a popup is as remote as its opener.
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: false,
            webSecurity: true
          }
        }
      };
    }
    warn('login window: blocked a popup to a host outside the allowlist');
    return { action: 'deny' };
  });

  wc.on('will-navigate', (event, url) => {
    if (isAllowedLoginUrl(url)) return;
    event.preventDefault();
    warn('login window: blocked navigation to a host outside the allowlist');
  });

  // Same rule for a redirect the page did not initiate.
  wc.on('will-redirect', (event, url) => {
    if (isAllowedLoginUrl(url)) return;
    event.preventDefault();
    warn('login window: blocked a redirect to a host outside the allowlist');
  });

  // And in an iframe: `will-navigate` never fires for a subframe, but a subframe
  // is loaded with the same partition's cookies.
  wc.on('will-frame-navigate', (details) => {
    if (isAllowedLoginUrl(details.url)) return;
    details.preventDefault();
    warn('login window: blocked a subframe navigation outside the allowlist');
  });

  wc.on('did-navigate', (_event, url) => {
    // `about:blank` is exempt, and must be: a popup starts there before its real
    // navigation, and reverting it would break every login that uses one. It
    // carries no remote content and no session of its own.
    if (url === '' || url === 'about:blank') return;
    if (isAllowedLoginUrl(url)) return;
    warn('login window: a URL outside the allowlist committed; reverting to the login page');
    void wc.loadURL(LOGIN_URLS[service]);
  });

  // Whatever this window opens is locked the same way, recursively.
  wc.on('did-create-window', (child) => {
    lockLoginWindow(child, service);
  });
}

export interface LoginDeps {
  readonly store: WalderStore;
  /**
   * True once the service's *web* provider reports an authenticated session —
   * `isWebLoginAuthenticated`, never the whole chain. Called at most once every
   * 2 s, and only while a login window is open.
   */
  readonly isLoggedIn: (service: ServiceName) => Promise<boolean>;
  /** Called once, after a login is detected. */
  readonly onLoggedIn: (service: ServiceName) => void;
}

export interface LoginWindows {
  /** Open (or focus) the login window for a service. */
  openLogin(service: ServiceName): void;
  /** Clear the service's whole partition: cookies, storage, caches. */
  logout(service: ServiceName): Promise<void>;
  /** Is a login window currently open for this service? */
  isOpen(service: ServiceName): boolean;
  /** Close every login window. Used on quit. */
  closeAll(): void;
}

export function createLoginWindows(deps: LoginDeps): LoginWindows {
  const open = new Map<ServiceName, BrowserWindow>();

  function build(service: ServiceName): BrowserWindow {
    const partition = PARTITIONS[service];
    const target = sessionFor(service);
    denyPermissions(target);

    const win = new BrowserWindow({
      width: LOGIN_WINDOW_WIDTH,
      height: LOGIN_WINDOW_HEIGHT,
      title: TITLES[service],
      // A login window is the one window Walder shows that the owner drives, so
      // unlike the overlay it takes focus and can be moved and closed normally.
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        // No `preload`. Deliberate, and load-bearing: see the file header.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        // The page is remote content; nothing in it may reach the file system.
        webSecurity: true
      }
    });

    // Every navigation rule, on this window and on anything it opens.
    lockLoginWindow(win, service);

    // Learn which endpoints the real site asks for while it is loaded (the path
    // only — see `endpoint-discovery.ts`).
    const stopDiscovery = attachDiscovery({
      session: target as unknown as WebRequestSession,
      store: deps.store as unknown as DiscoveryStore,
      storeKey: DISCOVERY_KEYS[service],
      origin: ORIGINS[service],
      re: DISCOVERY_RE,
      onFound: (path) => vlog(`discovery (${service}):`, path)
    });

    /*
     * Watch for the login taking effect.
     *
     * `deps.isLoggedIn` asks the service's *web* provider whether it is
     * authenticated — one request, answered by an organisation list or an access
     * token. Not "is a provider available": with Claude Code or Codex installed
     * a token provider is available for the same service and would report a
     * login the browser session does not have, which closed this window about
     * two seconds after it opened.
     *
     * Because it is a real network call, it is rate-limited on two axes: once
     * every 2 s, and never twice at once (`checking`), so a slow answer cannot
     * queue up behind itself. The interval exists only while the window does —
     * `closed` clears it — and gives up after ten minutes.
     */
    const startedAt = Date.now();
    let settled = false;
    let checking = false;
    const watch = setInterval(() => {
      if (settled || checking || win.isDestroyed()) return;
      if (Date.now() - startedAt > LOGIN_WATCH_TIMEOUT_MS) {
        clearInterval(watch);
        vlog(`login watch for ${service} timed out; leaving the window open`);
        return;
      }
      checking = true;
      void deps
        .isLoggedIn(service)
        .then((loggedIn) => {
          if (!loggedIn || settled || win.isDestroyed()) return;
          settled = true;
          clearInterval(watch);
          vlog(`login detected for ${service}; closing the window and refreshing`);
          deps.onLoggedIn(service);
          win.close();
        })
        .catch(() => {
          // A failed check is not a failed login; try again on the next tick.
        })
        .finally(() => {
          checking = false;
        });
    }, LOGIN_POLL_MS);

    win.on('closed', () => {
      clearInterval(watch);
      stopDiscovery();
      open.delete(service);
    });

    win.once('ready-to-show', () => win.show());
    void win.loadURL(LOGIN_URLS[service]);
    return win;
  }

  return {
    openLogin(service: ServiceName): void {
      const existing = open.get(service);
      if (existing !== undefined && !existing.isDestroyed()) {
        existing.focus();
        return;
      }
      open.set(service, build(service));
      vlog('opened the login window for', service);
    },

    async logout(service: ServiceName): Promise<void> {
      open.get(service)?.close();
      // The whole partition, not just cookies: a site can keep a login in
      // localStorage or IndexedDB too, and a half-cleared session would look
      // logged out to Walder and logged in to the site.
      await sessionFor(service).clearStorageData();
      vlog('cleared the session for', service);
    },

    isOpen(service: ServiceName): boolean {
      const win = open.get(service);
      return win !== undefined && !win.isDestroyed();
    },

    closeAll(): void {
      for (const win of open.values()) {
        if (!win.isDestroyed()) win.close();
      }
    }
  };
}

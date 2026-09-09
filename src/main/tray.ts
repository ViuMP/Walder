/**
 * The tray / menu-bar icon — the app's only user interface.
 *
 * Walder has no dock icon, no window chrome and no settings dialog, so this menu
 * is the whole of it: size, colour, launch at login, the two escape hatches
 * (reset position, force interactive), and Quit. It is also what the dog's own
 * right-click opens (via `menu:open`), which is why the `Tray` handle is kept and
 * the menu is rebuilt on every change — `Menu` items cache their checked state at
 * build time, so radio and checkbox marks would go stale otherwise.
 *
 * The overlay is reached through `deps.getOverlay()` on every click, never
 * captured: `ensureOverlay` in `index.ts` can replace the window (macOS
 * `activate`, a renderer crash) without rebuilding the tray, and a captured
 * handle would then point at a destroyed window — every menu action silently
 * doing nothing, with no error anywhere.
 */
import { Menu, Tray, app, nativeImage } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import type { HookKind } from '../core/behaviour';
import { lastCheckLine, type AuthCheck } from '../core/last-check';
import {
  presetAccelerator,
  shortcutLabel,
  shortcutPresetsFor,
  shortcutStatusLine,
  type ShortcutStatus
} from '../core/shortcuts';
import type { Overlay } from './overlay-window';
import { SCALE_BY_SIZE, SIZE_NAMES, SERVICE_NAMES, type ServiceName, type SizeName } from './ipc';
import { CH } from './ipc';
import { menuPalette, resolvePalette } from './sheet';
import type { SpriteSheet } from '../sprites/types';
import { formatPct, pctForFace, type ServiceReport, type UsageSnapshot } from '../core/usage';
import {
  applyLaunchAtLogin,
  launchAtLoginState,
  readHideShortcut,
  readSize,
  type WalderStore
} from './store';
import { setVerbose, vlog, warn } from './log';

/**
 * A coat's menu label, derived from its sheet key: `black-and-tan` -> `Black and
 * tan`.
 *
 * Derived rather than looked up in a table of the five coats we happen to ship,
 * because the coats are the *art's* decision and a hard-coded list drifts in both
 * directions. The M3 menu offered five while the placeholder sheet had one, so
 * four of the items silently did nothing; and a coat the artist adds later would
 * never appear at all. The sheet keys are already lowercase hyphenated words, so
 * sentence-casing them is the whole transformation.
 */
export function paletteLabel(id: string): string {
  const words = id.replace(/[-_]/g, ' ').trim();
  if (words.length === 0) return id;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The coats to offer, in the sheet's own order.
 *
 * Insertion order, deliberately not sorted: the art file lists them light to dark
 * (golden, red, cream, black-and-tan, chocolate), which is the order the owner
 * has been reviewing them in.
 */
export function paletteChoices(sheet: SpriteSheet): readonly { id: string; label: string }[] {
  return Object.keys(sheet.palettes).map((id) => ({ id, label: paletteLabel(id) }));
}

const SIZE_LABELS: Readonly<Record<SizeName, string>> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large'
};

/** Menu-bar names for the two services. */
const SERVICE_LABELS: Readonly<Record<ServiceName, string>> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT'
};

/**
 * The one-line account status the Accounts submenu shows.
 *
 * Each status is phrased as what the owner can *do* about it, which is the only
 * useful thing a status line can say: a login they can fix, a rate limit they
 * should ignore, an endpoint change they cannot fix but should know explains the
 * missing numbers. Exported so the wording is pinned by a test rather than by
 * whoever edits the menu next.
 */
export function accountStatusLine(service: ServiceName, report: ServiceReport | null): string {
  const name = SERVICE_LABELS[service];
  if (report === null) return `${name}: checking…`;
  switch (report.status) {
    case 'ok':
      return `${name}: ok via ${report.viaLabel}`;
    case 'auth-needed':
      return `${name}: login needed`;
    case 'endpoint-changed':
      return `${name}: endpoint changed`;
    case 'rate-limited':
      return `${name}: rate limited, retrying`;
    case 'error':
      return `${name}: could not be reached`;
    case 'unavailable':
    default:
      return `${name}: not logged in`;
  }
}

/**
 * Are the *fake-data* Developer items shown?
 *
 * Unpackaged (`npm run dev`) always, and `WALDER_DEV=1` for a packaged build the
 * owner is helping debug. Never on for a normal install: these items inject fake
 * usage numbers and fake hook events, and a mascot that can be *told* to say
 * "100 % used" is a mascot nobody can trust.
 *
 * The Developer submenu itself is always present, because "Verbose log" lives
 * there and is the one Developer item a normal install needs — see
 * `developerSubmenu`.
 */
export function developerMenuVisible(
  env: Record<string, string | undefined> = process.env,
  packaged: boolean = app.isPackaged
): boolean {
  return env['WALDER_DEV'] === '1' || !packaged;
}

/** The percentages the Developer > Inject usage submenu offers. */
export const INJECT_PERCENTS: readonly number[] = [45, 82, 91, 100];

/** "Refresh now" when it is allowed, and why not when it is not. */
export function refreshLabel(cooldownMs: number): string {
  if (cooldownMs <= 0) return 'Refresh now';
  return `Refresh now (wait ${Math.ceil(cooldownMs / 1000)}s)`;
}

/**
 * The percentage line under the header, shown only in the hide-when-idle mode:
 * `Claude 5-hour: 63% used`.
 *
 * It exists because that mode takes away the thing the app is *for*. Normally
 * the number is on the owner's screen as a dog's face and one hover away in
 * full; with the dog hidden there is nothing to hover, and the menu is all
 * there is. So the one number the face would have carried — Claude's 5-hour
 * window, the same one `pctForFace` picks — is printed here.
 *
 * `Claude 5-hour: ?` when there is no number, never `0% used`: "we could not
 * find out" and "you have used none of it" must not look the same. A disabled
 * item rather than a clickable one — there is nothing to do with it.
 */
export function usageLine(snapshot: UsageSnapshot | null): string {
  const pct = snapshot === null ? null : pctForFace(snapshot.buckets);
  if (pct === null) return 'Claude 5-hour: ?';
  return `Claude 5-hour: ${formatPct(pct)} used`;
}

export interface TrayDeps {
  /**
   * Resolved on every click, not captured: the overlay window can be rebuilt
   * under a tray that is not. `null` means there is momentarily no window.
   */
  readonly getOverlay: () => Overlay | null;
  readonly store: WalderStore;
  readonly sheet: SpriteSheet;
  readonly onQuit: () => void;
  /**
   * Absolute path of the log file, shown as a caption under Developer ▸ Verbose
   * log so the owner can find the file he was asked for. `undefined` when no file
   * sink was installed, which is every test and any run where the logs directory
   * could not be created.
   */
  readonly logPath?: string;
  /*
   * The usage half is optional so the tray still builds — as the M3 menu, minus
   * Refresh and Accounts — when no poller is wired to it. That keeps this file
   * testable on its own and keeps a poller failure from taking the app's only
   * user interface with it.
   */
  /** The last snapshot, for the Accounts status lines. */
  readonly getUsage?: () => UsageSnapshot | null;
  /** Manual refresh; `false` when the cooldown blocked it. */
  readonly onRefreshNow?: () => boolean;
  /** Milliseconds left on the manual cooldown. */
  readonly refreshCooldownMs?: () => number;
  readonly onLogin?: (service: ServiceName) => void;
  readonly onLogout?: (service: ServiceName) => void;
  /**
   * What the last *authentication* check for this service found — the second
   * Accounts line. Synchronous and in-memory: it reads what the web provider
   * already remembered, and never makes a request of its own (this runs while
   * the menu is being built). `null` before the first check of the run.
   */
  readonly getLastCheck?: (service: ServiceName) => AuthCheck | null;
  /**
   * A menu action moved or resized the dog, so the hover card's anchor — the
   * sprite's ink rect, measured in the renderer — no longer describes anything.
   * Wired to hiding the card: the renderer re-sends `hover:enter` with the new
   * rect on its next paint if the cursor is still on the dog, so the card
   * returns in the right place instead of hanging where the dog used to be.
   */
  readonly onGeometryChanged?: () => void;
  /*
   * Behaviour half, also optional so the tray still builds without it.
   */
  /** The "Sleep during fullscreen video" checkbox was toggled. */
  readonly onSleepInFullscreen?: (on: boolean) => void;
  /**
   * The "Hide when idle" checkbox was toggled.
   *
   * Reports only: the store write, the coordinator call and the menu rebuild all
   * happen in `index.ts`'s `setHideWhenIdle`, because the global shortcut needs
   * exactly the same three and two copies of them would drift.
   */
  readonly onHideWhenIdle?: (on: boolean) => void;
  /** A shortcut preset was chosen. `index.ts` stores it and rebinds the keys. */
  readonly onHideShortcut?: (accelerator: string) => void;
  /**
   * Did the current shortcut actually register? Read while the menu is being
   * built, so it must be a synchronous look at what the binder already knows.
   */
  readonly shortcutStatus?: () => ShortcutStatus;
  /** "Install Claude Code hooks…" was chosen. */
  readonly onInstallHooks?: () => void;
  /**
   * "Remove Claude Code hooks…" was chosen.
   *
   * Separate from `onInstallHooks` rather than a boolean argument on it, so a
   * host that wires only one of the two (a test, a future stripped-down build)
   * cannot accidentally offer a removal that does an install.
   */
  readonly onRemoveHooks?: () => void;
  /** Developer: pretend a poll returned this Claude 5-hour percentage. */
  readonly onInjectUsage?: (pct: number | null) => void;
  /** Developer: pretend a Claude Code hook fired. */
  readonly onSimulateHook?: (kind: HookKind) => void;
  /** Developer: flip the believed fullscreen state without a real video. */
  readonly onToggleFullscreen?: () => void;
  /** Developer: what that state currently is, for the item's checkmark. */
  readonly isFullscreen?: () => boolean;
}

export interface TrayHandle {
  readonly tray: Tray;
  /**
   * Rebuild the menu. Needed from outside because menu items cache their label
   * and enabled state at build time: a new snapshot changes the Accounts lines,
   * and the manual cooldown expiring re-enables Refresh.
   */
  refresh(): void;
}

/**
 * Load the generated tray icon for this platform.
 *
 * macOS wants a *template* image: shape in the alpha channel, drawn black, and
 * tinted by the system so it works on a light or dark menu bar. Windows and Linux
 * do no such tinting — a black-on-alpha icon there is invisible on the usual dark
 * taskbar — so they get the light variant, a white bone with a dark outline that
 * reads on either background.
 *
 * `app.getAppPath()` is the project root in dev and the asar root when packaged,
 * and `nativeImage` reads straight out of an asar, so one path covers both.
 * Electron picks up the `@2x` companion automatically.
 */
function loadIcon(): Electron.NativeImage {
  const isMac = process.platform === 'darwin';
  const name = isMac ? 'trayTemplate.png' : 'tray-win.png';
  const file = join(app.getAppPath(), 'build', name);
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) {
    warn(`tray icon missing or unreadable at ${file} — run "npm run gen:tray"`);
    return image;
  }
  if (isMac) image.setTemplateImage(true);
  return image;
}

export function createTray(deps: TrayDeps): TrayHandle {
  const { getOverlay, store, sheet, onQuit } = deps;
  const usageWired = deps.onRefreshNow !== undefined || deps.getUsage !== undefined;

  /**
   * The live overlay, or `null` with a log line. Every menu action goes through
   * this, so a rebuilt (or momentarily missing) window cannot turn the menu into
   * a set of buttons that quietly do nothing.
   */
  function overlayOrWarn(action: string): Overlay | null {
    const overlay = getOverlay();
    if (overlay === null || overlay.win.isDestroyed()) {
      warn(`tray "${action}" ignored: no overlay window`);
      return null;
    }
    return overlay;
  }

  const icon = loadIcon();
  const tray = new Tray(icon);
  tray.setToolTip('Walder');
  if (icon.isEmpty() && process.platform === 'darwin') {
    // Without this the menu bar would show nothing clickable at all.
    tray.setTitle('W');
  }

  function applySize(size: SizeName): void {
    // The preference is stored even if the window has gone: the next one to be
    // built reads it, so the click is never simply lost.
    store.set('size', size);
    const scale = SCALE_BY_SIZE[size];
    const overlay = overlayOrWarn('Size');
    if (overlay !== null) {
      overlay.applySize(scale);
      overlay.send(CH.modeSet, overlay.currentMode());
      // The dog just changed size under a possibly-open hover card.
      deps.onGeometryChanged?.();
    }
    vlog('size ->', size, 'scale', scale);
    refresh();
  }

  function applyPalette(name: string): void {
    store.set('palette', name);
    overlayOrWarn('Colour')?.send(CH.paletteSet, resolvePalette(sheet, name));
    vlog('palette ->', name);
    refresh();
  }

  function applyLaunch(on: boolean): void {
    store.set('launchAtLogin', on);
    applyLaunchAtLogin(on);
    refresh();
  }

  function applySleepInFullscreen(on: boolean): void {
    store.set('sleepInFullscreen', on);
    deps.onSleepInFullscreen?.(on);
    vlog('sleepInFullscreen ->', on);
    refresh();
  }

  /**
   * Tick or untick "Hide when idle", and choose the shortcut for it.
   *
   * Neither writes the store: `index.ts` owns both writes, because the same two
   * changes can arrive from the global shortcut, and the menu is not involved in
   * that path at all. The `refresh()` is still here so the checkmark is right in
   * a build with no handler wired.
   */
  function applyHideWhenIdle(on: boolean): void {
    deps.onHideWhenIdle?.(on);
    refresh();
  }

  function applyHideShortcut(accelerator: string): void {
    deps.onHideShortcut?.(accelerator);
    refresh();
  }

  /**
   * Tick or untick the verbose log.
   *
   * The store write and `setVerbose` are both needed and neither is redundant:
   * the store is what survives a restart, and `setVerbose` is what the *current*
   * process consults on every `vlog`. Logging the change itself is deliberate —
   * it puts a marker in the file saying when recording started, which is the
   * first thing anyone reading it wants to know.
   */
  function applyVerboseLog(on: boolean): void {
    store.set('verboseLog', on);
    setVerbose(on);
    vlog('verbose log ->', on);
    refresh();
  }

  function applyForceInteractive(on: boolean): void {
    store.set('forceInteractive', on);
    overlayOrWarn('Force interactive')?.setForceInteractive(on);
    refresh();
  }

  function applyResetPosition(): void {
    const overlay = overlayOrWarn('Reset position');
    if (overlay === null) return;
    overlay.resetPosition();
    // The dog teleported; the card must not stay behind at the old corner.
    deps.onGeometryChanged?.();
  }

  /** Timer that re-enables the Refresh item when its cooldown expires. */
  let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

  function applyRefreshNow(): void {
    const started = deps.onRefreshNow?.() ?? false;
    if (!started) {
      // The item should have been disabled; a click that gets through anyway
      // (a stale menu) must not poll.
      vlog('refresh now: refused by the cooldown');
    }
    // Rebuild immediately so the item shows as disabled, and again when the
    // cooldown is over so it comes back without the owner reopening the menu.
    refresh();
    const wait = deps.refreshCooldownMs?.() ?? 0;
    if (cooldownTimer !== null) clearTimeout(cooldownTimer);
    cooldownTimer =
      wait > 0
        ? setTimeout(() => {
            cooldownTimer = null;
            refresh();
          }, wait + 100)
        : null;
  }

  /**
   * `Accounts ▸`: two status lines per service, then its login/logout actions.
   *
   * The lines are disabled items rather than a tooltip or a dialog, because the
   * tray menu is the whole of Walder's interface — if the panel says a source is
   * broken, this is where the owner comes to fix it.
   *
   * **Two lines, because they answer different questions** (added 2026-09-08,
   * after the owner logged in to ChatGPT and was still told "login needed" with
   * no way to see why). The first is about the *usage poll*: ok, rate limited,
   * the endpoint moved. The second is about the *login itself*, with a
   * timestamp: "Logged in (checked 12:03)", "Not logged in — last check: HTTP
   * 401 (12:03)", "Check failed: timeout (12:03)". Between them, "it says login
   * needed" stops being a mystery and becomes a report someone can act on.
   *
   * Deliberately no identity in either line. Walder knows which account is
   * logged in and will not say — a menu bar is read over the owner's shoulder in
   * a café, and "logged in" is the whole of what he needs to know.
   */
  function accountsSubmenu(): MenuItemConstructorOptions[] {
    const snapshot = deps.getUsage?.() ?? null;
    const items: MenuItemConstructorOptions[] = [];

    SERVICE_NAMES.forEach((service, index) => {
      if (index > 0) items.push({ type: 'separator' });
      const report = snapshot?.services[service] ?? null;
      items.push({ label: accountStatusLine(service, report), enabled: false });
      items.push({
        label: `  ${lastCheckLine(deps.getLastCheck?.(service) ?? null)}`,
        enabled: false
      });
      items.push({ label: 'Log in…', click: () => deps.onLogin?.(service) });
      items.push({
        label: 'Log out',
        click: () => {
          deps.onLogout?.(service);
          refresh();
        }
      });
    });

    return items;
  }

  /**
   * `Shortcut ▸`: the vetted presets, as a radio group.
   *
   * A short list rather than a "press the keys you want" recorder, which is the
   * owner's decision and the right one — see the header of
   * `core/shortcuts.ts`. Three details worth knowing:
   *
   *  - **`Custom: …`** appears only when the stored accelerator is not one of
   *    the presets, which happens if the owner edits the settings file by hand.
   *    Without it the radio group would show no dot at all and read as broken,
   *    and clicking any preset would silently discard a working choice.
   *  - **A caveat is part of the label**, not a tooltip: a tray menu has no
   *    tooltips, and `Alt+Shift+W` really does misbehave while typing accents.
   *  - **The status line is last and disabled.** Absent when the shortcut
   *    registered — a menu that reports its own success is noise — and present
   *    when it did not, because that is the only place the owner can find out
   *    why pressing the keys does nothing.
   */
  function shortcutSubmenu(): MenuItemConstructorOptions[] {
    const platform = process.platform;
    const current = readHideShortcut(store);
    const presets = shortcutPresetsFor(platform);

    const items: MenuItemConstructorOptions[] = presets.map((preset) => {
      const accelerator = presetAccelerator(preset, platform);
      const label = shortcutLabel(accelerator, platform);
      return {
        label: preset.caveat === undefined ? label : `${label} — ${preset.caveat}`,
        type: 'radio',
        checked: accelerator === current,
        click: () => applyHideShortcut(accelerator)
      };
    });

    const known = presets.some((preset) => presetAccelerator(preset, platform) === current);
    if (!known) {
      items.push({
        label: `Custom: ${shortcutLabel(current, platform)}`,
        type: 'radio',
        checked: true,
        // No click handler: choosing it again would change nothing, and an item
        // that does nothing when clicked is better than one that pretends to.
        enabled: false
      });
    }

    const line = shortcutStatusLine(deps.shortcutStatus?.() ?? 'registered', current, platform);
    if (line !== null) {
      items.push({ type: 'separator' });
      items.push({ label: line, enabled: false });
    }

    return items;
  }

  /**
   * `Developer ▸`: the verbose log, plus the three things that are impossible to
   * exercise by hand.
   *
   * **Verbose log is always here**, packaged or not — the exception to the
   * fake-data gate on `developerMenuVisible`. It is the only Developer item a
   * *normal* install needs: the owner has no terminal, so when he reports "it
   * stopped showing numbers on Tuesday" the only way to have evidence is a
   * checkbox he could tick beforehand. Everything it writes has already been
   * through `redact`, so it cannot leak a credential, and unlike the items below
   * it cannot make the mascot say something untrue.
   *
   * The rest are dev-only. Usage percentages arrive from a provider every three
   * minutes, hook events arrive only while Claude Code is running, and a
   * fullscreen video takes a film to test — so each gets a menu item.
   */
  function developerSubmenu(): MenuItemConstructorOptions[] {
    const logItems: MenuItemConstructorOptions[] = [
      {
        label: 'Verbose log',
        type: 'checkbox',
        checked: store.get('verboseLog') === true,
        click: (item) => applyVerboseLog(item.checked)
      },
      {
        // A disabled caption, not a button that opens it: there is no
        // `shell.openPath` anywhere in Walder and revealing a log file is not
        // worth introducing one. The owner can copy the path out of a
        // screenshot.
        label: deps.logPath === undefined ? 'Log file: none' : `Log: ${deps.logPath}`,
        enabled: false
      }
    ];

    if (!developerMenuVisible()) return logItems;

    return [
      ...logItems,
      { type: 'separator' },
      {
        label: 'Inject usage',
        submenu: [
          ...INJECT_PERCENTS.map((pct) => ({
            label: `${pct}%`,
            click: () => deps.onInjectUsage?.(pct)
          })),
          { type: 'separator' as const },
          { label: 'no data', click: () => deps.onInjectUsage?.(null) }
        ]
      },
      {
        label: 'Simulate hook',
        submenu: (['done', 'waiting', 'prompt'] as const).map((kind) => ({
          label: kind,
          click: () => deps.onSimulateHook?.(kind)
        }))
      },
      {
        label: 'Toggle fullscreen mode',
        type: 'checkbox',
        checked: deps.isFullscreen?.() ?? false,
        click: () => {
          deps.onToggleFullscreen?.();
          refresh();
        }
      }
    ];
  }

  function buildMenu(): Menu {
    const currentSize = readSize(store);
    // `menuPalette`, not the raw stored value: a stored coat the current sheet
    // lacks must still put the radio dot *somewhere*, and golden is both the
    // contract's fallback and what the renderer is actually drawing in that
    // state. A radio group with no dot on any item reads as broken.
    const currentPalette = menuPalette(sheet, store.get('palette'));
    const launch = launchAtLoginState(store);

    const sizeItems: MenuItemConstructorOptions[] = SIZE_NAMES.map((size) => ({
      label: SIZE_LABELS[size],
      type: 'radio',
      checked: size === currentSize,
      click: () => applySize(size)
    }));

    const paletteItems: MenuItemConstructorOptions[] = paletteChoices(sheet).map(
      ({ id, label }) => ({
        label,
        type: 'radio',
        checked: id === currentPalette,
        click: () => applyPalette(id)
      })
    );

    const cooldownMs = deps.refreshCooldownMs?.() ?? 0;
    const usageItems: MenuItemConstructorOptions[] = usageWired
      ? [
          {
            label: refreshLabel(cooldownMs),
            enabled: cooldownMs <= 0,
            click: applyRefreshNow
          },
          { label: 'Accounts', submenu: accountsSubmenu() },
          { type: 'separator' }
        ]
      : [];

    /*
     * The percentage under the header, in the hide-when-idle mode only.
     *
     * Not always present, deliberately: with the dog on screen his face and the
     * hover card already say this, and a menu that repeats what is on screen
     * three inches away is clutter. With him hidden it is the only place the
     * number exists.
     */
    const hideWhenIdleOn = store.get('hideWhenIdle') === true;
    const presenceItems: MenuItemConstructorOptions[] = hideWhenIdleOn
      ? [{ label: usageLine(deps.getUsage?.() ?? null), enabled: false }]
      : [];

    const shortcut = readHideShortcut(store);

    return Menu.buildFromTemplate([
      { label: 'Walder', enabled: false },
      ...presenceItems,
      { type: 'separator' },
      ...usageItems,
      { label: 'Size', submenu: sizeItems },
      { label: 'Colour', submenu: paletteItems },
      {
        // Reflects the OS when there is an OS setting to reflect (the user can
        // remove the login item in System Settings); disabled in an unpackaged
        // dev run, where the login-item API cannot work at all.
        label: launch.editable ? 'Launch at login' : 'Launch at login (packaged app only)',
        type: 'checkbox',
        enabled: launch.editable,
        checked: launch.on,
        click: (item) => applyLaunch(item.checked)
      },
      {
        label: 'Sleep during fullscreen video',
        type: 'checkbox',
        checked: store.get('sleepInFullscreen') !== false,
        click: (item) => applySleepInFullscreen(item.checked)
      },
      {
        label: 'Hide when idle',
        type: 'checkbox',
        checked: hideWhenIdleOn,
        /*
         * `accelerator` here is **display only**. The keys are held by
         * `globalShortcut` (see `main/shortcut.ts`), which is what makes them
         * work while no menu is open — the whole point. `registerAccelerator:
         * false` stops the menu registering them a second time on Windows and
         * Linux, where an Electron menu item's accelerator is a real binding;
         * on macOS a tray context menu never registers one anyway.
         *
         * If the platform turns out not to render it, the fallback is a suffix
         * on the label — a QA item, since nobody here can see a tray menu.
         */
        accelerator: shortcut,
        registerAccelerator: false,
        click: (item) => applyHideWhenIdle(item.checked)
      },
      { label: 'Shortcut', submenu: shortcutSubmenu() },
      { type: 'separator' },
      // Writes the three command hooks into ~/.claude/settings.json, so Claude
      // Code finishing a reply makes the dog's ears go up — and takes them out
      // again. Both are here because the removal used to exist only as
      // `npm run install-hooks -- --remove`, which an owner who installed from a
      // .dmg has no project folder to run: the app could edit a file it could not
      // then tidy up after itself. Both ellipses are honest — each opens a
      // confirmation naming the file and the backup (see `index.ts`).
      { label: 'Install Claude Code hooks…', click: () => deps.onInstallHooks?.() },
      { label: 'Remove Claude Code hooks…', click: () => deps.onRemoveHooks?.() },
      { type: 'separator' },
      // The escape hatch for a dog that cannot be reached with the mouse — on a
      // monitor that is gone, or dragged somewhere a drag cannot undo.
      { label: 'Reset position', click: applyResetPosition },
      {
        label: 'Force interactive (debug)',
        type: 'checkbox',
        checked: store.get('forceInteractive') === true,
        click: (item) => applyForceInteractive(item.checked)
      },
      // Always present: `developerSubmenu` decides how much of itself to show,
      // and its verbose-log item is needed in a normal install.
      { label: 'Developer', submenu: developerSubmenu() },
      { type: 'separator' },
      { label: 'Quit', click: onQuit }
    ]);
  }

  /** Rebuild so radio dots and checkmarks reflect the store. */
  function refresh(): void {
    tray.setContextMenu(buildMenu());
  }

  refresh();

  // Left-clicking the icon opens the same menu — there is no other UI to show.
  // Rebuilt first: the Accounts lines and the Refresh item both go stale between
  // openings, and a menu that shows last poll's status is worse than none.
  tray.on('click', () => {
    refresh();
    tray.popUpContextMenu();
  });

  return { tray, refresh };
}

/** Read the persisted size as a scale, for the initial window. */
export function initialScale(store: WalderStore): number {
  return SCALE_BY_SIZE[readSize(store)];
}

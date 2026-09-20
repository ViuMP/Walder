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
import type { HookEvent, HookSource } from './hook-server';
import { lastCheckLine, type AuthCheck } from '../core/last-check';
import { LOGIN } from './services-main';
import {
  presetAccelerator,
  shortcutLabel,
  shortcutPresetsFor,
  shortcutStatusLine,
  type ShortcutStatus
} from '../core/shortcuts';
import { updateMenuLine, type UpdateState } from '../core/update-check';
import { KNOWN_ROWS, type Bucket } from '../core/buckets';
import { BARK_PRESETS, type BarkPreset } from '../core/nudge';
import {
  CARD_SIZES,
  RESET_STYLES,
  SERVICE_LABELS,
  accountStatusLine,
  type CardSize,
  type ResetStyle
} from '../core/card-layout';
import type { Overlay } from './overlay-window';
import { SCALE_BY_SIZE, SIZE_NAMES, SERVICE_NAMES, type ServiceName, type SizeName } from './ipc';
import { CH } from './ipc';
import { menuPalette, resolvePalette } from './sheet';
import type { SpriteSheet } from '../sprites/types';
import { formatPct, pctForFace, type UsageSnapshot } from '../core/usage';
import {
  applyLaunchAtLogin,
  launchAtLoginState,
  readCardSize,
  readHideShortcut,
  readPrimaryService,
  readBarkPreset,
  readResetStyle,
  readSize,
  type WalderStore
} from './store';
import { setVerbose, vlog, warn } from './log';
import { t } from '../core/strings';

/**
 * Slack added to a cooldown before rebuilding the menu that the cooldown had
 * greyed out — so the item is enabled again when the owner next opens the menu,
 * rather than one millisecond short of it.
 */
const COOLDOWN_REBUILD_SLACK_MS = 100;

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

/**
 * Exported so `index.ts` can name a size the way the menu does — the bug report
 * says `size Medium`, and a second table there would be a second thing to drift.
 */
export const SIZE_LABELS: Readonly<Record<SizeName, string>> = {
  small: t('tray.small'),
  medium: t('tray.medium'),
  large: t('tray.large')
};

/**
 * Labels for the hover card's three layouts.
 *
 * The same three words as the dog's own sizes, on purpose: they mean the same
 * thing (bigger / smaller), and the submenu they sit under says which of the two
 * things is being sized. Biggest first, following `CARD_SIZES`, because the card
 * ships Large and a menu whose first item is the default reads more easily than
 * one where the default is in the middle.
 */
export const CARD_SIZE_LABELS: Readonly<Record<CardSize, string>> = {
  large: t('tray.large'),
  medium: t('tray.medium'),
  small: t('tray.small')
};

/**
 * Labels for the two reset wordings.
 *
 * Named after what the owner will *see* rather than after the mechanism — "Clock
 * time" and "Countdown", not "Absolute" and "Relative". The default is first,
 * following `RESET_STYLES`, for the same reason Large leads the sizes.
 */
export const RESET_STYLE_LABELS: Readonly<Record<ResetStyle, string>> = {
  clock: t('tray.resetStyle.clock'),
  countdown: t('tray.resetStyle.countdown')
};

/**
 * Labels for the three bark presets, in `BARK_PRESETS` order — a scale, not a
 * default-first list, so it reads quietest to loudest rather than leading with
 * "Normal" the way `CARD_SIZE_LABELS` leads with Large.
 */
export const BARK_PRESET_LABELS: Readonly<Record<BarkPreset, string>> = {
  quiet: t('tray.barkPreset.quiet'),
  normal: t('tray.barkPreset.normal'),
  chatty: t('tray.barkPreset.chatty')
};

/*
 * `SERVICE_LABELS` and `accountStatusLine` now live in `core/card-layout.ts` and
 * are re-exported here.
 *
 * They moved because the hover card needs the same sentence: at Medium and Small
 * it has no source line, so its status note has to name the service, and two
 * copies of that wording would be two chances for the menu and the card to
 * disagree in front of an owner looking at both at once. Re-exported rather than
 * repointed at every call site so `accountStatusLine` is still importable from
 * the file whose menu it describes.
 */
export { SERVICE_LABELS, accountStatusLine };

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
  if (cooldownMs <= 0) return t('tray.refreshNow');
  return t('tray.refreshNowCooldown', { seconds: Math.ceil(cooldownMs / 1000) });
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
  if (pct === null) return t('tray.usageUnknown');
  return t('tray.usageLine', { pct: formatPct(pct) });
}

/**
 * The rows the **Show in overview** submenu offers: the ones Walder can name up
 * front, then anything the last snapshot carried that is not among them.
 *
 * The second half is what keeps the menu honest. `KNOWN_ROWS` is a list written
 * by hand, and the payloads have twice now grown a row nobody predicted (a
 * per-model weekly window, a walked `chatgpt.*` key); those rows are on the card
 * whether or not anybody has added them here, so they must be tickable too — and
 * the only name there is for them is the one the snapshot printed on the card.
 *
 * Order is `KNOWN_ROWS` first and the snapshot's own order after it, not
 * priority: this is a settings list, and an owner looking for "7-day Sonnet"
 * should find it in the same place every time rather than wherever this
 * afternoon's percentages put it.
 */
export function overviewRows(
  last: readonly Bucket[] = []
): readonly { readonly id: string; readonly label: string; readonly service: ServiceName }[] {
  const named = new Set(KNOWN_ROWS.map((row) => row.id));
  const extra: { id: string; label: string; service: ServiceName }[] = [];
  for (const bucket of last) {
    // `named` doubles as the seen-set, so a snapshot that somehow lists an id
    // twice still yields one checkbox for it.
    if (named.has(bucket.id)) continue;
    named.add(bucket.id);
    extra.push({ id: bucket.id, label: bucket.label, service: bucket.service });
  }
  return [...KNOWN_ROWS, ...extra];
}

/** Which tool the Developer ▸ Simulate hook items pretend to be. */
export const HOOK_SOURCE_LABELS: Readonly<Record<HookSource, string>> = {
  claude: t('tray.toolClaude'),
  codex: t('tray.toolCodex')
};

/** What `installedHookPort()` found, against what the listener really bound. */
export interface HookInstallStatus {
  /** The port the installed hooks post to (`~/.claude/settings.json`, `~/.codex/hooks.json`). */
  readonly installedPort: number | null;
  /** The port Walder is listening on, or `null` when nothing bound. */
  readonly boundPort: number | null;
}

/**
 * The same reading for each tool, because they are installed separately and can
 * disagree: Claude Code's hooks can be current while Codex's are missing, or
 * written for a port from two launches ago.
 */
export interface HookInstallStatuses {
  readonly claude: HookInstallStatus;
  readonly codex: HookInstallStatus;
}

/** How the status line and the two items name each tool. */
const HOOK_TOOL_LABELS: Readonly<Record<HookSource, string>> = {
  claude: t('tray.toolClaudeCode'),
  codex: t('tray.toolCodex')
};

/**
 * The disabled line above the two hook items: is this actually working?
 *
 * The whole 0.2.5 hook fix in one sentence. Until now the menu offered to
 * install hooks and never said whether they *were* installed, so the state the
 * owner spent days in — listener up, hooks absent, dog silent — looked exactly
 * like the healthy one from every angle he could see.
 *
 * Four answers, in the order they are worth knowing:
 *
 *  - **no listener** first, even when the hooks are also missing: installing
 *    them would write a hook pointing at nothing, so "reinstall" is the wrong
 *    advice and this is the fact that has to be fixed (usually by a restart).
 *  - **not installed** — the common case, and the one the item below fixes.
 *  - **a port mismatch** names both numbers, because that is what makes the
 *    sentence actionable: the hooks are real, they simply post to a door that
 *    closed when the preferred port was taken at some later launch.
 *  - **installed** names the port too, so the owner reporting a bug can read
 *    the one number that matters straight off the menu.
 *
 * `tool` only picks the name in front of the colon: Codex gets the identical
 * four answers, since "written but never trusted" is a state neither this nor
 * anything else in Walder can see (`installedCodexHookPort`).
 */
export function hookStatusLine(status: HookInstallStatus, tool: HookSource = 'claude'): string {
  const name = t('tray.hookName', { tool: HOOK_TOOL_LABELS[tool] });
  const { installedPort, boundPort } = status;
  if (boundPort === null) return t('tray.hookNoListener', { name });
  if (installedPort === null) return t('tray.hookNotInstalled', { name });
  if (installedPort === boundPort) return t('tray.hookInstalled', { name, port: boundPort });
  return t('tray.hookPortMismatch', { name, installedPort, boundPort });
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
   * Absolute path of the log file. It is both what Developer ▸ **Reveal log
   * file** opens in the file manager and the caption printed under it, so the
   * owner can read the path off the screen as well as reach the file.
   * `undefined` when no file sink was installed, which is every test and any run
   * where the logs directory could not be created.
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
  /**
   * The hover card's size was changed. `index.ts` wires this to
   * `panel.setCardSize`, which re-widens the window and tells the renderer to
   * redraw.
   *
   * Deliberately *not* wired to `onGeometryChanged`: that one hides the card,
   * which is right when the dog moved (the anchor is stale) and wrong here. The
   * owner clicking through Large / Medium / Small is comparing them, and a card
   * that disappears on each click cannot be compared — it would only come back
   * when the cursor next crossed the dog's outline.
   */
  readonly onCardSize?: (size: CardSize) => void;
  /**
   * The card's reset wording was changed. `index.ts` wires this to
   * `panel.setResetStyle`, which pushes it to the renderer and nothing else —
   * the window's width is the card size's business, not this one's.
   */
  readonly onResetStyle?: (style: ResetStyle) => void;
  /**
   * The bark preset was changed. `index.ts` wires this to
   * `behaviour.setBarkPreset`, which forwards the preset's levels to the
   * `NudgeMachine` — this setting has no renderer side at all, unlike
   * `onResetStyle` and `onCardSize`.
   */
  readonly onBarkPreset?: (preset: BarkPreset) => void;
  /**
   * The primary service was changed.
   *
   * `index.ts` wires this to the poller's own `refreshNow()`, which is the
   * existing path for "something changed that the panel must reflect now"
   * (a logout uses it too). The setting is read on every publish, so doing
   * nothing here would also be correct — the next poll picks it up — and that
   * is exactly what happens when the 60 s manual cooldown refuses the refresh.
   * Re-sorting the card in place would have meant a second publish path
   * through the poller for one menu item, which is a worse trade than a
   * refresh that is sometimes a few minutes late.
   */
  readonly onPrimaryService?: (service: ServiceName) => void;
  /**
   * A row was ticked or unticked in **Show in overview**. The whole new list is
   * handed over, not the one id that moved: `index.ts` has three things to do
   * with it (store it, tell the coordinator, republish), and each of them wants
   * the list rather than the delta.
   *
   * The tray does **not** write the store itself, unlike Size and Card size.
   * The coordinator has to be told in the same breath or a hidden row barks
   * once more before the next poll, and splitting a write from its two
   * consequences across two files is how the third one gets forgotten.
   */
  readonly onHiddenBuckets?: (ids: readonly string[]) => void;
  /**
   * Which rows are hidden right now, for the checkmarks. Read while the menu is
   * being built, so it must be a synchronous look at the settings file.
   */
  readonly hiddenBuckets?: () => readonly string[];
  /**
   * The rows the last snapshot actually carried, so a row Walder has never been
   * able to name up front (`KNOWN_ROWS`) still gets a checkbox — labelled with
   * whatever the payload called it. Empty before the first poll, which simply
   * means the submenu holds the known rows and nothing else.
   */
  readonly lastBuckets?: () => readonly Bucket[];
  /*
   * Behaviour half, also optional so the tray still builds without it.
   */
  /** The "Sleep during fullscreen video" checkbox was toggled. */
  readonly onSleepInFullscreen?: (on: boolean) => void;
  /**
   * The "Still mode" checkbox was toggled.
   *
   * The store write happens here (unlike `onHideWhenIdle`, which has a second
   * caller in the global shortcut): the menu is the only way to reach this, so
   * `index.ts` only has to pass the flag on to the overlay.
   */
  readonly onStillMode?: (on: boolean) => void;
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
  /*
   * The update half, optional like the usage half so the tray still builds
   * without a checker wired to it.
   */
  /** What the last update check found. Read while the menu is being built. */
  readonly updateState?: () => UpdateState;
  /** "Check for updates now"; `false` when the 60 s cooldown blocked it. */
  readonly onCheckUpdateNow?: () => boolean;
  /** Milliseconds left on that cooldown. */
  readonly updateCooldownMs?: () => number;
  /**
   * "Download…" was chosen. The URL is handed straight through, and `index.ts`
   * checks it against the pinned release-repository prefix before opening it —
   * `shell.openExternal` lives there and nowhere else.
   */
  readonly onOpenUpdate?: (url: string) => void;
  /** The "Check for updates automatically" checkbox was toggled. */
  readonly onCheckForUpdates?: (on: boolean) => void;
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
  /** "Install Codex hooks…" / "Remove Codex hooks…" — the Claude pair's twin. */
  readonly onInstallCodexHooks?: () => void;
  readonly onRemoveCodexHooks?: () => void;
  /**
   * Are the hooks installed, and for the port Walder is actually listening on?
   *
   * Read synchronously while the menu is being built (it is two small file
   * reads), so neither line can be a launch behind the item directly below it.
   * Absent in a host with no hook listener, and then no line is shown at all —
   * a status about a feature that is not wired would be a lie either way.
   */
  readonly hookStatus?: () => HookInstallStatuses;
  /**
   * "Report a bug…" was chosen. `index.ts` gathers the diagnostics, puts them on
   * the clipboard and opens a prefilled issue — through the same pinned-prefix
   * guard as the update URL, because `shell.openExternal` lives there.
   */
  readonly onReportBug?: () => void;
  /**
   * "Reveal log file" was chosen. Absent (and the item disabled) in a build with
   * no `logPath`, which is every test and any run whose logs directory could not
   * be created.
   */
  readonly onRevealLog?: () => void;
  /** Developer: pretend a poll returned this Claude 5-hour percentage. */
  readonly onInjectUsage?: (pct: number | null) => void;
  /** Developer: pretend a Claude Code hook fired. */
  readonly onSimulateHook?: (event: HookEvent) => void;
  /** Developer: run the Claude Code login renewal once, whatever the expiry. */
  readonly onRenewClaudeNow?: () => void;
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

  /**
   * The hover card's layout. Nothing to do with the dog, and nothing to do with
   * the overlay window — so no `overlayOrWarn` and no `onGeometryChanged` here:
   * the card is a window of its own, and this is the only menu action that
   * touches it and nothing else.
   */
  function applyCardSize(size: CardSize): void {
    store.set('cardSize', size);
    deps.onCardSize?.(size);
    vlog('card size ->', size);
    refresh();
  }

  /** The card's reset wording. Same shape as `applyCardSize`, and same reasons. */
  function applyResetStyle(style: ResetStyle): void {
    store.set('resetStyle', style);
    deps.onResetStyle?.(style);
    vlog('reset style ->', style);
    refresh();
  }

  /**
   * The bark preset. Same shape as `applyResetStyle`, but nothing here touches
   * the overlay or the card — the whole effect is `deps.onBarkPreset`, which
   * `index.ts` wires straight to the behaviour coordinator.
   */
  function applyBarkPreset(preset: BarkPreset): void {
    store.set('barkPreset', preset);
    deps.onBarkPreset?.(preset);
    vlog('bark preset ->', preset);
    refresh();
  }

  /**
   * The service Walder reacts to first. Nothing here touches the overlay or the
   * card directly: the choice is a *sorting* input, read by `mergeBuckets` on
   * the poller's next publish, so the only local work is to store it, ask for
   * that publish, and move the radio dot.
   */
  function applyPrimaryService(service: ServiceName): void {
    store.set('primaryService', service);
    deps.onPrimaryService?.(service);
    vlog('primary service ->', service);
    refresh();
  }

  /**
   * One row ticked or unticked in **Show in overview**. `shown` is the state the
   * item has *already* been toggled to — Electron hands the menu item over after
   * flipping it — so ticked means "not hidden".
   *
   * The whole new list goes out through one dep rather than being written here:
   * a hidden row must also stop barking, and the store write and the
   * coordinator call have to happen together or the row says one more thing
   * after the owner has told it not to. `index.ts` does both, plus the
   * republish that takes it off the open card without a network round trip.
   */
  function applyHiddenBucket(id: string, shown: boolean): void {
    const hidden = deps.hiddenBuckets?.() ?? [];
    const next = shown ? hidden.filter((other) => other !== id) : [...hidden, id];
    // An id cannot be hidden twice: the menu's own state is what drove this, so
    // the only way to a duplicate is a hand-edited settings file.
    deps.onHiddenBuckets?.(shown ? next : [...new Set(next)]);
    vlog('show in overview ->', id, shown);
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

  function applyStillMode(on: boolean): void {
    store.set('stillMode', on);
    deps.onStillMode?.(on);
    vlog('stillMode ->', on);
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

  /** Timer that re-enables the update item when *its* cooldown expires. */
  let updateCooldownTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The one update item, which is two buttons depending on the state: open the
   * download page, or ask GitHub whether there is one.
   *
   * The cooldown dance mirrors `applyRefreshNow` exactly — rebuild now so the
   * item shows as disabled, and again when the wait is over so it comes back
   * without the owner reopening the menu.
   *
   * A click here asks GitHub *whether or not* `Check for updates automatically`
   * is ticked: the owner has asked in so many words, and the setting is about
   * the checks Walder makes on its own. `false` back therefore means one of two
   * things and neither is a mistake — the 60 s cooldown is running (the item
   * should already have been greyed out and this click came off a stale menu),
   * or a check is still awaiting its answer.
   */
  function applyUpdateItem(state: UpdateState): void {
    if (state.kind === 'available') {
      deps.onOpenUpdate?.(state.url);
      return;
    }

    const started = deps.onCheckUpdateNow?.() ?? false;
    if (!started) vlog('check for updates: nothing started (cooldown, or one already running)');
    refresh();
    const wait = deps.updateCooldownMs?.() ?? 0;
    if (updateCooldownTimer !== null) clearTimeout(updateCooldownTimer);
    updateCooldownTimer =
      wait > 0
        ? setTimeout(() => {
            updateCooldownTimer = null;
            refresh();
          }, wait + COOLDOWN_REBUILD_SLACK_MS)
        : null;
  }

  /**
   * Tick or untick the notification fallback.
   *
   * The store *is* the setting, so there is nothing to tell anybody: the
   * behaviour shell reads the key on every batch (see `notifyWhenHidden` in
   * `main/behaviour.ts`), unlike still mode, which has a live window to inform.
   */
  function applyNotifyWhenHidden(on: boolean): void {
    store.set('notifyWhenHidden', on);
    vlog('notifyWhenHidden ->', on);
    refresh();
  }

  function applyCheckForUpdates(on: boolean): void {
    // The store *is* the setting here: the checker reads `enabled()` on every
    // due check, so there is nothing to restart.
    store.set('checkForUpdates', on);
    deps.onCheckForUpdates?.(on);
    vlog('checkForUpdates ->', on);
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
          }, wait + COOLDOWN_REBUILD_SLACK_MS)
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
      // The usage status line is for every service — a token-only source can
      // be rate limited or have moved its endpoint like any other.
      items.push({ label: accountStatusLine(service, report), enabled: false });
      // The other three are about a *browser login*, and a service with
      // `LOGIN` `null` has none: there is no login check to report (the second
      // line would permanently read "not checked"), nothing for Log in… to
      // open, and nothing for Log out to clear. Cursor is signed in and out
      // inside the Cursor editor, which is what its `noLogin` string says.
      if (LOGIN[service] === null) return;
      items.push({
        label: `  ${lastCheckLine(deps.getLastCheck?.(service) ?? null)}`,
        enabled: false
      });
      items.push({ label: t('tray.logIn'), click: () => deps.onLogin?.(service) });
      items.push({
        label: t('tray.logOut'),
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
        label:
          preset.caveat === undefined
            ? label
            : t('tray.shortcutCaveat', { label, caveat: preset.caveat }),
        type: 'radio',
        checked: accelerator === current,
        click: () => applyHideShortcut(accelerator)
      };
    });

    const known = presets.some((preset) => presetAccelerator(preset, platform) === current);
    if (!known) {
      items.push({
        label: t('tray.shortcutCustom', { label: shortcutLabel(current, platform) }),
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
        label: t('tray.verboseLog'),
        type: 'checkbox',
        checked: store.get('verboseLog') === true,
        click: (item) => applyVerboseLog(item.checked)
      },
      {
        /*
         * A button now, not the disabled caption it used to be.
         *
         * The caption was the right call while nothing asked the owner for the
         * file; "Report a bug…" does, and telling him to find
         * `~/Library/Logs/Walder/walder.log` by hand — from a menu that had
         * just printed it, undraggable — is the step a report dies at.
         * `shell.showItemInFolder` selects it in Finder, which is the gesture
         * before dragging it into a GitHub issue. Disabled, and honest about
         * why, when there is no file to reveal.
         */
        label: deps.logPath === undefined ? t('tray.logFileNone') : t('tray.revealLogFile'),
        enabled: deps.logPath !== undefined,
        click: () => deps.onRevealLog?.()
      },
      // The path stays, one line below, because it is still the thing the owner
      // reads off the screen when he is on a machine whose Finder is not the one
      // in front of him — and because a menu item that reveals a file should say
      // which file.
      ...(deps.logPath === undefined
        ? []
        : [{ label: t('tray.logPathLine', { path: deps.logPath }), enabled: false }])
    ];

    if (!developerMenuVisible()) return logItems;

    return [
      ...logItems,
      { type: 'separator' },
      {
        label: t('tray.injectUsage'),
        submenu: [
          ...INJECT_PERCENTS.map((pct) => ({
            label: `${pct}%`,
            click: () => deps.onInjectUsage?.(pct)
          })),
          { type: 'separator' as const },
          { label: t('tray.noData'), click: () => deps.onInjectUsage?.(null) }
        ]
      },
      {
        // One submenu per tool: the bubbles now name it (`Claude done` /
        // `Codex done`), and the per-source queue is exactly the thing that is
        // impossible to exercise by hand without two tools running at once.
        label: t('tray.simulateHook'),
        submenu: (['claude', 'codex'] as const).map((source) => ({
          label: HOOK_SOURCE_LABELS[source],
          submenu: (['done', 'waiting', 'prompt'] as const).map((kind) => ({
            label: t(`tray.hookKind.${kind}`),
            click: () => deps.onSimulateHook?.({ kind, source })
          }))
        }))
      },
      {
        label: t('tray.toggleFullscreen'),
        type: 'checkbox',
        checked: deps.isFullscreen?.() ?? false,
        click: () => {
          deps.onToggleFullscreen?.();
          refresh();
        }
      },
      {
        // The renewal waits for the last four minutes of an eight-hour token,
        // so without this the first chance to see it work is most of a day
        // away. The outcome is in the log: "claude token renewal: renewed".
        label: t('tray.renewClaudeNow'),
        click: () => deps.onRenewClaudeNow?.()
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

    const currentCardSize = readCardSize(store);
    const cardSizeItems: MenuItemConstructorOptions[] = CARD_SIZES.map((size) => ({
      label: CARD_SIZE_LABELS[size],
      type: 'radio',
      checked: size === currentCardSize,
      click: () => applyCardSize(size)
    }));

    const currentResetStyle = readResetStyle(store);
    const resetStyleItems: MenuItemConstructorOptions[] = RESET_STYLES.map((style) => ({
      label: RESET_STYLE_LABELS[style],
      type: 'radio',
      checked: style === currentResetStyle,
      click: () => applyResetStyle(style)
    }));

    const currentBarkPreset = readBarkPreset(store);
    const barkPresetItems: MenuItemConstructorOptions[] = BARK_PRESETS.map((preset) => ({
      label: BARK_PRESET_LABELS[preset],
      type: 'radio',
      checked: preset === currentBarkPreset,
      click: () => applyBarkPreset(preset)
    }));

    /*
     * Show in overview: one checkbox per row, grouped by service in `SERVICES`
     * order — Claude's above ChatGPT's.
     *
     * Grouped with a separator rather than sorted into one list, because the
     * services' rows are named alike ("5-hour", "Codex 5-hour") and the card
     * itself is read as blocks. A service with no rows at all contributes
     * nothing, which is why a separator only ever sits between two non-empty
     * groups.
     */
    const hiddenIds = new Set(deps.hiddenBuckets?.() ?? []);
    const rows = overviewRows(deps.lastBuckets?.() ?? []);
    const overviewItemsFor = (service: ServiceName): MenuItemConstructorOptions[] =>
      rows
        .filter((row) => row.service === service)
        .map((row) => ({
          label: row.label,
          type: 'checkbox' as const,
          // Ticked means shown: the owner reads the submenu's own title as the
          // question, and "hidden" is the state with no tick.
          checked: !hiddenIds.has(row.id),
          click: (menuItem: { checked: boolean }) =>
            applyHiddenBucket(row.id, menuItem.checked)
        }));
    const overviewItems: MenuItemConstructorOptions[] = SERVICE_NAMES.map(overviewItemsFor)
      .filter((group) => group.length > 0)
      .flatMap((group, index) => (index === 0 ? group : [{ type: 'separator' as const }, ...group]));

    const currentPrimary = readPrimaryService(store);
    const primaryServiceItems: MenuItemConstructorOptions[] = SERVICE_NAMES.map((service) => ({
      label: SERVICE_LABELS[service],
      type: 'radio',
      checked: service === currentPrimary,
      click: () => applyPrimaryService(service)
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
          { label: t('tray.accounts'), submenu: accountsSubmenu() },
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

    // Both tools' readings in one call: two small file reads, and asking twice
    // could show two lines taken a moment apart.
    const hooks = deps.hookStatus?.();

    /*
     * The update block, just above Quit — the bottom of the menu, where a
     * once-a-release concern belongs, and far from anything the owner clicks
     * daily. Absent when no checker is wired (a test, a build with the feature
     * compiled out), like the usage half above.
     */
    const updateWired = deps.updateState !== undefined || deps.onCheckUpdateNow !== undefined;
    const updateState = deps.updateState?.() ?? { kind: 'never' as const };
    const updateCooldownMs = deps.updateCooldownMs?.() ?? 0;
    const updateItems: MenuItemConstructorOptions[] = updateWired
      ? [
          { type: 'separator' },
          {
            label: updateMenuLine(updateState, updateCooldownMs),
            // "Download…" is always available; a check is not, while the
            // cooldown runs.
            enabled: updateState.kind === 'available' || updateCooldownMs <= 0,
            click: () => applyUpdateItem(updateState)
          },
          {
            label: t('tray.checkForUpdatesAutomatically'),
            type: 'checkbox',
            checked: store.get('checkForUpdates') !== false,
            click: (menuItem) => applyCheckForUpdates(menuItem.checked)
          }
        ]
      : [];

    return Menu.buildFromTemplate([
      { label: t('tray.walder'), enabled: false },
      ...presenceItems,
      { type: 'separator' },
      ...usageItems,
      { label: t('tray.size'), submenu: sizeItems },
      // Immediately after "Size", because the two are the same kind of choice
      // and the owner who has just made the dog smaller is the owner about to
      // wonder whether the card follows. It does not — see `applyCardSize`.
      { label: t('tray.cardSize'), submenu: cardSizeItems },
      // Next, because it is the other thing about the card that is purely how it
      // reads — and it is the one line on every row the owner is most likely to
      // find useless, so it belongs where he will look after resizing.
      { label: t('tray.resetTimes'), submenu: resetStyleItems },
      // Last of the card block: "how big is the card", "how does it word a
      // reset" and "what is on it" are three parts of one question, and the
      // owner who has just made the card smaller is the owner about to wonder
      // how to make it shorter.
      { label: t('tray.showInOverview'), submenu: overviewItems },
      // After "Show in overview": the two card settings stay adjacent, and
      // the barks follow the row list they act on.
      { label: t('tray.barks'), submenu: barkPresetItems },
      // Beside the two size choices rather than up in the usage block, because
      // what the owner sees it *do* is reorder the card — and unlike the items
      // in that block it is a preference, not an action, so it stays here with
      // the other preferences even when no usage source is wired at all.
      { label: t('tray.primaryService'), submenu: primaryServiceItems },
      { label: t('tray.colour'), submenu: paletteItems },
      {
        // Reflects the OS when there is an OS setting to reflect (the user can
        // remove the login item in System Settings); disabled in an unpackaged
        // dev run, where the login-item API cannot work at all.
        label: launch.editable ? t('tray.launchAtLogin') : t('tray.launchAtLoginPackagedOnly'),
        type: 'checkbox',
        enabled: launch.editable,
        checked: launch.on,
        click: (item) => applyLaunch(item.checked)
      },
      {
        label: t('tray.sleepDuringFullscreen'),
        type: 'checkbox',
        checked: store.get('sleepInFullscreen') !== false,
        click: (item) => applySleepInFullscreen(item.checked)
      },
      {
        // Directly under the fullscreen courtesy, because both answer the same
        // question — "be less of a distraction" — and an owner who has just
        // found one is looking for the other. The renderer ORs this with the
        // OS's own Reduce Motion, so the box being unticked does not mean the
        // dog is moving.
        label: t('tray.stillMode'),
        type: 'checkbox',
        checked: store.get('stillMode') === true,
        click: (item) => applyStillMode(item.checked)
      },
      {
        label: t('tray.hideWhenIdle'),
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
      { label: t('tray.shortcut'), submenu: shortcutSubmenu() },
      {
        /*
         * After the hide-when-idle pair rather than between them, because the
         * shortcut belongs to the checkbox above it — and this belongs to both:
         * it is the compensation for a dog who cannot be seen, and with him on
         * screen it does nothing at all.
         *
         * Left off by default on purpose. The first notification Walder posts
         * is also the macOS permission prompt (see `notify` in `index.ts`), so
         * ticking this box is the owner asking to be asked.
         */
        label: t('tray.notifyWhenHidden'),
        type: 'checkbox',
        checked: store.get('notifyWhenHidden') === true,
        click: (item) => applyNotifyWhenHidden(item.checked)
      },
      { type: 'separator' },
      // Writes the three command hooks into ~/.claude/settings.json, so Claude
      // Code finishing a reply makes the dog's ears go up — and takes them out
      // again. Both are here because the removal used to exist only as
      // `npm run install-hooks -- --remove`, which an owner who installed from a
      // .dmg has no project folder to run: the app could edit a file it could not
      // then tidy up after itself. Both ellipses are honest — each opens a
      // confirmation naming the file and the backup (see `index.ts`).
      // The status line above the two actions, disabled: it is a reading, and
      // the thing to do about it is the item directly below it.
      ...(hooks === undefined
        ? []
        : [{ label: hookStatusLine(hooks.claude, 'claude'), enabled: false }]),
      { label: t('tray.installClaudeHooks'), click: () => deps.onInstallHooks?.() },
      { label: t('tray.removeClaudeHooks'), click: () => deps.onRemoveHooks?.() },
      // The Codex pair, in the same shape and directly below: a different file
      // (`~/.codex/hooks.json`), a different third event, and one extra header
      // so the listener can tell whose turn just finished. Both tools are in
      // daily use here, so neither is a submenu.
      ...(hooks === undefined
        ? []
        : [{ label: hookStatusLine(hooks.codex, 'codex'), enabled: false }]),
      { label: t('tray.installCodexHooks'), click: () => deps.onInstallCodexHooks?.() },
      { label: t('tray.removeCodexHooks'), click: () => deps.onRemoveCodexHooks?.() },
      { type: 'separator' },
      // The escape hatch for a dog that cannot be reached with the mouse — on a
      // monitor that is gone, or dragged somewhere a drag cannot undo.
      { label: t('tray.resetPosition'), click: applyResetPosition },
      {
        label: t('tray.forceInteractive'),
        type: 'checkbox',
        checked: store.get('forceInteractive') === true,
        click: (item) => applyForceInteractive(item.checked)
      },
      // Always present: `developerSubmenu` decides how much of itself to show,
      // and its verbose-log item is needed in a normal install.
      { label: t('tray.developer'), submenu: developerSubmenu() },
      ...updateItems,
      // Directly under the update block and above Quit: both are once-in-a-while
      // concerns about the app itself rather than about the dog, and this is
      // where a menu bar app is looked for them. Always present — unlike the
      // update items it needs nothing wired to be *offered*, and an owner who
      // cannot find "Report a bug" reports it by not reporting it. The ellipsis
      // is the platform's promise that something opens; what opens is a draft in
      // his browser that he sends, or does not (see `openBugReport`).
      { label: t('tray.reportBug'), click: () => deps.onReportBug?.() },
      { type: 'separator' },
      { label: t('tray.quit'), click: onQuit }
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

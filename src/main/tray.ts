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
 * captured: `ensureOverlay` in `index.ts` can replace a destroyed or missing
 * window (macOS `activate`, a second launch) without rebuilding the tray — a
 * renderer crash is not one of those, the overlay reloads its own page
 * (`overlay-window.ts`, since 2026-11-13) — and a captured
 * handle would then point at a destroyed window — every menu action silently
 * doing nothing, with no error anywhere.
 */
import { Menu, Tray, app, nativeImage } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import type { HookEvent, HookSource } from './hook-server';
import { lastCheckLine, type AuthCheck } from '../core/last-check';
import { LOGIN } from './services-main';
import type { ShortcutStatus } from '../core/shortcuts';
import { updateMenuLine, type UpdateState } from '../core/update-check';
import {
  SERVICE_LABELS,
  accountStatusLine,
  type CardSize,
  type ResetStyle
} from '../core/card-layout';
import type { BarkPreset } from '../core/nudge';
import type { Overlay } from './overlay-window';
import { SCALE_BY_SIZE, SIZE_NAMES, SERVICE_NAMES, type ServiceName, type SizeName } from './ipc';
import type { SpriteSheet } from '../sprites/types';
import { formatPct, pctForFace, type UsageSnapshot } from '../core/usage';
import { readHideShortcut, readSize, type WalderStore } from './store';
import { vlog, warn } from './log';
import { createSettings, standardEffects, type Settings } from './settings';
import type { SettingKey } from '../core/settings-spec';
import { t } from '../core/strings';
import { ACCOUNT_STATES, type AccountState } from '../core/account-sim';

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
export {
  BARK_PRESET_LABELS,
  CARD_SIZE_LABELS,
  RESET_STYLE_LABELS,
  SIZE_LABELS,
  paletteLabel
} from '../core/settings-spec';
import { SIZE_LABELS } from '../core/settings-spec';

/**
 * Exported so `index.ts` can name a size the way the menu does — the bug report
 * says `size Medium`, and a second table there would be a second thing to drift.
 */

/**
 * Labels for the hover card's three layouts.
 *
 * The same three words as the dog's own sizes, on purpose: they mean the same
 * thing (bigger / smaller), and the submenu they sit under says which of the two
 * things is being sized. Biggest first, following `CARD_SIZES`, because the card
 * ships Large and a menu whose first item is the default reads more easily than
 * one where the default is in the middle.
 */

/**
 * Labels for the two reset wordings.
 *
 * Named after what the owner will *see* rather than after the mechanism — "Clock
 * time" and "Countdown", not "Absolute" and "Relative". The default is first,
 * following `RESET_STYLES`, for the same reason Large leads the sizes.
 */

/**
 * Labels for the three bark presets, in `BARK_PRESETS` order — a scale, not a
 * default-first list, so it reads quietest to loudest rather than leading with
 * "Normal" the way `CARD_SIZE_LABELS` leads with Large.
 */

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
 * Is the Developer submenu shown?
 *
 * Unpackaged (`npm run dev`) always, and `WALDER_DEV=1` for a packaged build the
 * owner is helping debug. Never on for a normal install: these items inject fake
 * usage numbers and fake hook events, and a mascot that can be *told* to say
 * "100 % used" is a mascot nobody can trust.
 *
 * This gates the whole Developer submenu (2026-11-17). Verbose log is in the
 * Walder window and Reveal log file is a top-level menu item, so a normal
 * install needs nothing from it.
 */
export function developerMenuVisible(
  env: Record<string, string | undefined> = process.env,
  packaged: boolean = app.isPackaged
): boolean {
  return env['WALDER_DEV'] === '1' || !packaged;
}

/**
 * The weekly injects: one in each held posture's band (`LIE_WORRIED_PCT` 90,
 * `LIE_TIRED_PCT` 95), calm on the 5-hour row so only the posture changes.
 */
export const INJECT_WEEKLY_PCTS: readonly number[] = [92, 96];
export const INJECT_WEEKLY_FIVE_HOUR_PCT = 30;

/**
 * The percentages the Developer > Inject usage submenu offers. 96 is there for
 * the QA checklist (rows 3.4k, 5.6): it is the only one in the `exhausted`
 * face's 95–99 band — 91 is still `worried` and 100 is already `out`, so
 * before it was added no inject reached that face at all.
 */
export const INJECT_PERCENTS: readonly number[] = [45, 82, 91, 96, 100];

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
  /**
   * Install would rewrite the installed entries (`installedHooksOutdated`): an
   * older command, or an event missing. Absent reads as current.
   */
  readonly outdated?: boolean;
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
 * Five answers, in the order they are worth knowing:
 *
 *  - **no listener** first, even when the hooks are also missing: installing
 *    them would write a hook pointing at nothing, so "reinstall" is the wrong
 *    advice and this is the fact that has to be fixed (usually by a restart).
 *  - **not installed** — the common case, and the one the item below fixes.
 *  - **a port mismatch** names both numbers, because that is what makes the
 *    sentence actionable: the hooks are real, they simply post to a door that
 *    closed when the preferred port was taken at some later launch.
 *  - **out of date** (2026-11-19): the port is right but the command is one
 *    an older Walder wrote, which Install rewrites in place. Before this the
 *    line said "installed (port N)" for an old command and a new one alike;
 *    the item below then reads "Update … hooks…" (`installItemLabel`).
 *  - **installed** names the port too, so the owner reporting a bug can read
 *    the one number that matters straight off the menu.
 *
 * `tool` only picks the name in front of the colon: Codex gets the identical
 * five answers, since "written but never trusted" is a state neither this nor
 * anything else in Walder can see (`installedCodexHookPort`).
 */
export function hookStatusLine(status: HookInstallStatus, tool: HookSource = 'claude'): string {
  const name = t('tray.hookName', { tool: HOOK_TOOL_LABELS[tool] });
  const { installedPort, boundPort } = status;
  if (boundPort === null) return t('tray.hookNoListener', { name });
  if (installedPort === null) return t('tray.hookNotInstalled', { name });
  if (installedPort !== boundPort) {
    return t('tray.hookPortMismatch', { name, installedPort, boundPort });
  }
  if (status.outdated === true) return t('tray.hookOutdated', { name, port: boundPort });
  return t('tray.hookInstalled', { name, port: boundPort });
}

/**
 * Is Install, for this tool, an update? The one predicate behind the menu item
 * (`installItemLabel`) and the confirmation's question and button (`index.ts`),
 * so the two cannot disagree (Windows QA 7.2a: "Update … hooks…" opened a box
 * whose button read Install).
 */
export function isHookUpdate(status: HookInstallStatus | undefined): boolean {
  return status !== undefined && status.boundPort !== null && status.outdated === true;
}

export type HookConfirmVerb = 'remove' | 'update' | 'install';

/**
 * The hook confirmation's verb, which picks both its question
 * (`hooks.question.<verb>`) and its button (`hooks.<verb>`): Remove, Update
 * when the menu item read "Update … hooks…", else Install.
 */
export function hookConfirmVerb(remove: boolean, status: HookInstallStatus | undefined): HookConfirmVerb {
  if (remove) return 'remove';
  return isHookUpdate(status) ? 'update' : 'install';
}

/**
 * The install item's label: "Update … hooks…" when the line above says out of
 * date (and a listener is up for the update to point at), "Install …" otherwise.
 * The same click either way; Install rewrites a marked entry in place.
 */
export function installItemLabel(status: HookInstallStatus | undefined, tool: HookSource): string {
  const update = isHookUpdate(status);
  if (tool === 'codex') return t(update ? 'tray.updateCodexHooks' : 'tray.installCodexHooks');
  return t(update ? 'tray.updateClaudeHooks' : 'tray.installClaudeHooks');
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
   * The shared settings writer. `index.ts` passes the one the settings window
   * also uses, so a change in either shows in both; without it the tray makes
   * its own from these deps.
   */
  readonly settings?: Settings;
  /** Opens the settings window. The menu item is left out when this is absent. */
  readonly onOpenSettings?: () => void;
  /**
   * Absolute path of the log file. It is both what the menu's **Reveal log
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
  /** The owner's Refresh: always allowed (a 429's wait is kept by the poller). */
  readonly onRefreshNow?: () => void;
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
  /** The optional threshold-bark sound changed; only the overlay consumes it. */
  readonly onBarkSound?: (on: boolean) => void;
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
   * A service was ticked or unticked in **Show in overview**. The whole new
   * list is handed over, not the one name that moved: `index.ts` has three
   * things to do with it (store it, tell the coordinator, republish), and each
   * of them wants the list rather than the delta.
   *
   * The tray does **not** write the store itself, unlike Size and Card size.
   * The coordinator has to be told in the same breath or a hidden row barks
   * once more before the next poll, and splitting a write from its two
   * consequences across two files is how the third one gets forgotten.
   */
  readonly onHiddenServices?: (services: readonly ServiceName[]) => void;
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
  readonly onInjectUsage?: (pct: number | null, weeklyPct?: number) => void;
  /** Developer: pretend a Claude Code hook fired. */
  readonly onSimulateHook?: (event: HookEvent) => void;
  /** Developer: run the Claude Code login renewal once, whatever the expiry. */
  readonly onRenewClaudeNow?: () => void;
  /** Developer: lay a simulated account state over every snapshot (`core/account-sim.ts`). */
  readonly onSimulateAccountState?: (state: AccountState) => void;
  /** Developer: the state in force, for the radio's check. */
  readonly accountState?: () => AccountState;
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
  /**
   * Rebuild the menu and open it at the cursor. The one way in for everything
   * that opens the menu — the icon's own click handlers and the dog's
   * right-click (`menu:open` in `ipc-bridge.ts`) — so every opening shows a menu
   * built at that moment, and the dog and the bone show the same one (row 3.1).
   *
   * `onClose` runs once when this opening's menu closes (`menu-will-close`),
   * or at once if the popup throws or there is no menu of ours to watch
   * (Linux's set menu). It can arrive after a later opening has begun: the
   * caller tells its own openings apart (`menu:open` in `ipc-bridge.ts`).
   */
  openMenu(onClose?: () => void): void;
}

/**
 * Whether Walder opens the tray menu itself rather than handing it to the icon.
 *
 * On Windows a menu given to `tray.setContextMenu()` is shown by Electron's
 * `NotifyIcon::HandleClickEvent` (`shell/browser/ui/win/notify_icon.cc`, read at
 * v44.2.0) straight from the right-click, *instead of* emitting `'right-click'`
 * — the event only fires when no context menu is set. So there was no moment to
 * rebuild in: the owner got whatever the last `refresh()` built, and "Refresh
 * now (wait 60s)" still read 60 twenty seconds later (Windows QA, rows 4.10 and
 * 9.18). Setting no menu makes Electron emit `'right-click'`, and the handler
 * rebuilds and opens the fresh menu with `popUpContextMenu(menu)`.
 *
 * macOS too, since 2026-11-14. This paragraph used to say that Electron emits
 * `'click'` from the status item's `mouseDown:` *before* it opens the set menu
 * (`tray_icon_cocoa.mm`), so that a rebuild in the `'click'` handler was what
 * the opening showed. Measured on macOS 27.2 with Electron 44.11.3 (log lines on
 * every tray and menu event, presses on the real icon), that is not what
 * happens. With a menu set, the system opens it on the press — left, right or
 * an accessibility press — and Electron emits no `'click'`, `'mouse-down'`,
 * `'mouse-up'` or `'right-click'` at all; only the menu's own
 * `'menu-will-show'`, and a menu set from there is not the one on screen. The
 * one event before it, `'mouse-enter'`, comes when the pointer arrives, not at
 * the press. So nothing rebuilt the menu and row 4.10 read "wait 60s" twenty
 * seconds after a refresh, on the released 0.2.9 as on this branch. With no
 * menu set, the press emits `'click'` (a right-click `'right-click'`, an
 * accessibility press `'click'` as well) on the mouse-down, and the menu
 * `popUpContextMenu(menu)` then opens is the one built 2 ms earlier — under the
 * icon, the icon highlighted while it is up, a second press closing it.
 *
 * Every press arrived there as a `'click'`, a quick second one and one sent
 * with a click count of 2 included, so `setIgnoreDoubleClickEvents(true)`
 * changed nothing on that system. It is called all the same: not measured on
 * an older macOS, where `tray_icon_cocoa.mm` reports a press with a click
 * count of 2 as `'double-click'` instead, and with no set menu that press
 * would open nothing.
 *
 * Linux keeps the set menu: it emits no `'right-click'` at all, and an
 * AppIndicator icon needs a set menu to show anything.
 *
 * Read per tray rather than at module load so the tests can take either branch.
 */
function opensMenuItself(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
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

  /*
   * Every setting goes through the one writer (`main/settings.ts`): it
   * validates, stores, runs the side effect and tells its listeners — this menu
   * among them, which is what moves the radio dot (`settings.onChange` below).
   * A tray built without a shared controller (every test, and any caller that
   * has no settings window) makes its own from these same deps.
   */
  const settings: Settings =
    deps.settings ??
    createSettings({
      store,
      palettes: () => Object.keys(sheet.palettes),
      effects: standardEffects(deps)
    });

  function apply(key: SettingKey, value: unknown): void {
    const result = settings.set(key, value);
    if (!result.ok) warn(`tray: ${key} not changed: ${result.error}`);
  }

  const applySize = (size: SizeName): void => apply('size', size);
  const applyHideWhenIdle = (on: boolean): void => apply('hideWhenIdle', on);

  // The menu follows every change, whichever UI made it.
  settings.onChange(() => refresh());

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

  function applyResetPosition(): void {
    const overlay = overlayOrWarn('Reset position');
    if (overlay === null) return;
    overlay.resetPosition();
    // The dog teleported; the card must not stay behind at the old corner.
    deps.onGeometryChanged?.();
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
      // The login is checked only for a service that is *not* ok (`index.ts`,
      // `refreshLoginChecks`), so under an ok header "not checked yet" would
      // read forever and promise a check that never comes (2026-11-13 audit,
      // X6). Hidden then; any real record, and every not-ok service, keeps it.
      const check = deps.getLastCheck?.(service) ?? null;
      if (check !== null || report?.status !== 'ok') {
        items.push({ label: `  ${lastCheckLine(check)}`, enabled: false });
      }
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
   * `Hooks ▸`: each tool's status line (disabled: it is a reading), then its
   * install and remove items. Claude writes `~/.claude/settings.json`, Codex
   * `~/.codex/hooks.json`.
   */
  function hooksSubmenu(
    hooks: ReturnType<NonNullable<TrayDeps['hookStatus']>> | undefined
  ): MenuItemConstructorOptions[] {
    return [
      ...(hooks === undefined
        ? []
        : [{ label: hookStatusLine(hooks.claude, 'claude'), enabled: false }]),
      { label: installItemLabel(hooks?.claude, 'claude'), click: () => deps.onInstallHooks?.() },
      { label: t('tray.removeClaudeHooks'), click: () => deps.onRemoveHooks?.() },
      { type: 'separator' },
      ...(hooks === undefined
        ? []
        : [{ label: hookStatusLine(hooks.codex, 'codex'), enabled: false }]),
      { label: installItemLabel(hooks?.codex, 'codex'), click: () => deps.onInstallCodexHooks?.() },
      { label: t('tray.removeCodexHooks'), click: () => deps.onRemoveCodexHooks?.() }
    ];
  }

  /**
   * `Developer ▸`, shown in dev builds and with `WALDER_DEV=1` only (see
   * `developerMenuVisible`): the things that are impossible to exercise by
   * hand. Usage percentages arrive from a provider every three minutes, hook
   * events arrive only while Claude Code is running, and a fullscreen video
   * takes a film to test — so each gets a menu item.
   */
  function developerSubmenu(): MenuItemConstructorOptions[] {
    return [
      {
        label: t('tray.injectUsage'),
        submenu: [
          ...INJECT_PERCENTS.map((pct) => ({
            label: formatPct(pct),
            click: () => deps.onInjectUsage?.(pct)
          })),
          { type: 'separator' as const },
          // The weekly posture: a calm 5-hour row beside a spent weekly pool,
          // which no real account of the owner's is likely to show on demand.
          ...INJECT_WEEKLY_PCTS.map((weeklyPct) => ({
            label: t('tray.injectWeekly', { weeklyPct, fiveHourPct: INJECT_WEEKLY_FIVE_HOUR_PCT }),
            click: () => deps.onInjectUsage?.(INJECT_WEEKLY_FIVE_HOUR_PCT, weeklyPct)
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
        // The out-of-credit and spend-limit states the QA rows need and no
        // account of the owner's shows on demand. Memory only, until Normal or quit.
        label: t('tray.simulateAccount'),
        submenu: ACCOUNT_STATES.map((state) => ({
          label: t(`tray.accountState.${state}`),
          type: 'radio' as const,
          checked: (deps.accountState?.() ?? 'normal') === state,
          click: () => {
            deps.onSimulateAccountState?.(state);
            refresh();
          }
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
    const sizeItems: MenuItemConstructorOptions[] = SIZE_NAMES.map((size) => ({
      label: SIZE_LABELS[size],
      type: 'radio',
      checked: size === currentSize,
      click: () => applySize(size)
    }));

    const usageItems: MenuItemConstructorOptions[] = usageWired
      ? [
          { label: t('tray.refreshNow'), click: () => deps.onRefreshNow?.() },
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
     * The update item, just above Report a bug — the bottom of the menu, where a
     * once-a-release concern belongs. "Check for updates automatically" lives in
     * the Walder window. Absent when no checker is wired (a test, a build with
     * the feature compiled out), like the usage half above.
     */
    const updateWired = deps.updateState !== undefined || deps.onCheckUpdateNow !== undefined;
    const updateState = deps.updateState?.() ?? { kind: 'never' as const };
    const updateCooldownMs = deps.updateCooldownMs?.() ?? 0;
    const updateItems: MenuItemConstructorOptions[] = updateWired
      ? [
          {
            label: updateMenuLine(updateState, updateCooldownMs),
            // "Download…" is always available; a check is not, while the
            // cooldown runs.
            enabled: updateState.kind === 'available' || updateCooldownMs <= 0,
            click: () => applyUpdateItem(updateState)
          }
        ]
      : [];

    /*
     * The menu holds what is used day to day and the actions the window cannot
     * do (accounts, hooks, reset position, report a bug). Every other setting is
     * in the Walder window only (2026-11-17): the full list made a menu about 35
     * lines tall, too tall for a Windows tray at 125 % scaling.
     */
    return Menu.buildFromTemplate([
      { label: t('tray.walder'), enabled: false },
      ...presenceItems,
      { type: 'separator' },
      ...usageItems,
      ...(deps.onOpenSettings === undefined
        ? []
        : [{ label: t('tray.openWindow'), click: () => deps.onOpenSettings?.() }]),
      { label: t('tray.size'), submenu: sizeItems },
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
         */
        accelerator: shortcut,
        registerAccelerator: false,
        click: (item) => applyHideWhenIdle(item.checked)
      },
      { type: 'separator' },
      // Install and remove for both tools, each under its status line. Each
      // install/remove opens a confirmation naming the file and the backup
      // (see `index.ts`).
      { label: t('tray.hooks'), submenu: hooksSubmenu(hooks) },
      // The escape hatch for a dog that cannot be reached with the mouse — on a
      // monitor that is gone, or dragged somewhere a drag cannot undo.
      { label: t('tray.resetPosition'), click: applyResetPosition },
      // Fake usage and fake hook events: dev builds and WALDER_DEV=1 only.
      ...(developerMenuVisible()
        ? [{ label: t('tray.developer'), submenu: developerSubmenu() }]
        : []),
      { type: 'separator' },
      ...updateItems,
      // Both about the app itself rather than the dog. "Reveal log file" sits
      // here because "Report a bug…" asks for the log.
      { label: t('tray.reportBug'), click: () => deps.onReportBug?.() },
      {
        label: deps.logPath === undefined ? t('tray.logFileNone') : t('tray.revealLogFile'),
        enabled: deps.logPath !== undefined,
        click: () => deps.onRevealLog?.()
      },
      { type: 'separator' },
      // Relaunch is scheduled first, then the ordinary quit path runs, so every
      // before-quit/will-quit save happens exactly as it does for Quit.
      {
        label: t('tray.restart'),
        click: () => {
          app.relaunch();
          onQuit();
        }
      },
      { label: t('tray.quit'), click: onQuit }
    ]);
  }

  const selfOpened = opensMenuItself(process.platform);
  /** The menu as last built; what `openMenu` shows when `selfOpened`. */
  let menu = buildMenu();
  /**
   * The menu that is (or was last) on screen, held so it outlives the next
   * `refresh()`. `popUpContextMenu(menu)` hands Electron only a weak pointer to
   * the menu's model, and a poll landing while the menu is open reassigns
   * `menu` — without this reference the open menu could be collected from under
   * the menu runner. Replaced only by the next opening, which closes the old
   * menu first (`NotifyIcon::PopUpContextMenu` cancels the current one; on
   * macOS the press that asks for the next opening closes this one before
   * the event arrives).
   */
  let shown: Menu | null = null;

  /** Rebuild so radio dots and checkmarks reflect the store. */
  function refresh(): void {
    menu = buildMenu();
    // When `selfOpened`, a set menu would be shown without asking us — stale
    // (see `opensMenuItself`). An open menu is never redrawn either
    // way: the new one is only what the *next* opening shows.
    if (!selfOpened) tray.setContextMenu(menu);
  }

  function openMenu(onClose?: () => void): void {
    // Rebuilt first: the Accounts lines and the Refresh / Check-for-updates
    // cooldowns all go stale between openings, and a menu that shows last
    // poll's status is worse than none.
    refresh();
    if (!selfOpened) {
      try {
        tray.popUpContextMenu();
      } finally {
        onClose?.();
      }
      return;
    }
    shown = menu;
    // Whether our own menu came up for a press (Windows QA 3.17: a right-click
    // in the overflow showed Teams' menu, and nothing said whether Walder heard it).
    shown.once('menu-will-show', () => vlog('tray menu: shown'));
    if (onClose !== undefined) shown.once('menu-will-close', () => onClose());
    try {
      tray.popUpContextMenu(shown);
    } catch (err) {
      onClose?.();
      throw err;
    }
  }

  if (!selfOpened) tray.setContextMenu(menu);

  // Left-clicking the icon opens the same menu — there is no other UI to show.
  // Wrapped: Electron passes its event first, which is not an `onClose`.
  tray.on('click', () => {
    vlog('tray icon: click');
    openMenu();
  });
  // Every press a `'click'`, never a `'double-click'` that opens nothing (see
  // `opensMenuItself`). macOS-only API.
  if (process.platform === 'darwin') tray.setIgnoreDoubleClickEvents(true);
  // The click Windows users reach for first, and on macOS the other press that
  // has always opened this menu. Emitted only because no context menu is set
  // there (`opensMenuItself`); on Linux the set menu *is* the right-click, so
  // nothing is added.
  if (selfOpened) {
    tray.on('right-click', () => {
      vlog('tray icon: right-click');
      openMenu();
    });
  }

  return { tray, refresh, openMenu };
}

/** Read the persisted size as a scale, for the initial window. */
export function initialScale(store: WalderStore): number {
  return SCALE_BY_SIZE[readSize(store)];
}

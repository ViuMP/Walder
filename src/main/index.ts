/**
 * Walder — main process.
 *
 * Assembles the pieces of the app: the persisted settings, the overlay window,
 * the hover panel, the poll loop that feeds both, the login windows, and the
 * tray menu that is the app's only user interface. Walder has no dock icon and
 * no closable window, so it never quits on its own — the Quit item in the tray
 * menu is the single way out.
 *
 * Wiring order matters and is not arbitrary:
 *   store → sheet → overlay → panel → poller → login windows → tray → IPC.
 * The poller needs the store (interval, stored snapshot) and something to send
 * snapshots to; the login windows need the poller (to refresh after a login) and
 * the chains (to know when a login has taken); the tray needs all of them; and
 * the IPC bridge is registered last because it hands renderer messages to every
 * one of them.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  net,
  Notification,
  powerMonitor,
  screen,
  session,
  shell
} from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createStore,
  applyLaunchAtLogin,
  readBarkPreset,
  readCardSize,
  readHiddenBuckets,
  readHideShortcut,
  readPrimaryService,
  readSize,
  type WalderStore
} from './store';
import { createOverlay, type BoxSizes, type Overlay } from './overlay-window';
import { createHoverPanel, type HoverPanel } from './hover-panel';
import {
  CARD_SIZE_LABELS,
  SERVICE_LABELS,
  SIZE_LABELS,
  createTray,
  initialScale,
  type HookInstallStatuses,
  type TrayHandle
} from './tray';
import { registerIpc, unregisterIpc } from './ipc-bridge';
import { boxSize, loadSheet } from './sheet';
import { createPoller, type Poller } from './poller';
import { createLocalTokenScanner } from './local-tokens';
import { createChains } from './provider-chains';
import { createLoginWindows, type LoginWindows } from './login-window';
import { createBehaviour, type BehaviourHandle } from './behaviour';
import { createShortcutBinder, type ShortcutBinder } from './shortcut';
import { createUpdateChecker, type UpdateChecker } from './update-check';
import { UPDATE_URL_PREFIX, shouldNotify } from '../core/update-check';
import { DEFAULT_BARK_PRESET } from '../core/nudge';
import {
  BUG_REPORT_URL_PREFIX,
  bugReportUrl,
  diagnosticsBlock,
  type BugReportFacts
} from '../core/bug-report';
import { fromFetch } from '../providers/http';
import { createFullscreenWatch, type FullscreenWatch } from './fullscreen-watch';
import { startHookServer, type HookEvent, type HookServer } from './hook-server';
import { liveSessions, reduceSessionEntries, type SessionEntry } from '../core/sessions';
import { createClaudeSessions, processIsAlive, type ClaudeSessions } from './claude-sessions';
import { createClaudeRenew, findClaudeBinary, type ClaudeRenew } from './claude-renew';
import { createRaiser } from './raise';
import {
  DEFAULT_HOOK_PORT,
  applyHooks,
  claudeSettingsPath,
  installedHookPort
} from './claude-hooks';
import {
  applyCodexHooks as writeCodexHookFile,
  codexHome,
  codexHooksPath,
  installedCodexHookPort
} from './codex-hooks';
import {
  CLAUDE_LOGGED_OUT_TEXT,
  CODEX_HOOKS_MISSING_TEXT,
  CODEX_HOOKS_STALE_TEXT,
  HOOKS_MISSING_TEXT,
  HOOKS_STALE_TEXT,
  INTRO_HELLO_TEXT,
  INTRO_LOGIN_TEXT
} from '../core/bubble';
import { LOGGED_OUT_MESSAGE } from '../providers/claude-oauth';
import { CH, type ServiceName } from './ipc';
import {
  chainFor,
  isWebLoginAuthenticated,
  lastLoginCheck,
  type ProviderChains
} from '../providers/registry';
import { injectedSnapshot } from '../core/usage';
import { forIpc, type UsageSnapshot } from '../core/usage';
import { setLogSink, setVerbose, vlog, warn } from './log';
import { createFileLog } from './log-file';
import { galleryRequested, openGallery } from './gallery-window';
import type { SpriteSheet } from '../sprites/types';

/**
 * Only ever one Walder. A mascot is a singleton by nature — two overlays would
 * fight over the same screen corner, double every provider poll and bark twice
 * about the same threshold. The lock must be requested before `whenReady`, so
 * the second copy exits before it can build a window.
 */
const isGallery = galleryRequested();

/**
 * The gallery run is exempt: it is a different app (a titled, focusable window
 * with no tray, no poller and no overlay), and refusing to open it because the
 * real mascot happens to be running would be maddening — reviewing the artwork
 * with the dog still on screen is the normal case, not an accident.
 */
const gotTheLock = isGallery || app.requestSingleInstanceLock();

// Module-scope handles: a `Tray` that is garbage-collected disappears from the
// menu bar, so these must outlive the function that made them.
let trayHandle: TrayHandle | null = null;
let overlay: Overlay | null = null;
let panel: HoverPanel | null = null;
let store: WalderStore | null = null;
let sheet: SpriteSheet | null = null;
let poller: Poller | null = null;
let chains: ProviderChains | null = null;
let logins: LoginWindows | null = null;
let behaviour: BehaviourHandle | null = null;
let shortcut: ShortcutBinder | null = null;
let updates: UpdateChecker | null = null;
let fullscreenWatch: FullscreenWatch | null = null;
let hookServer: HookServer | null = null;
let claudeSessions: ClaudeSessions | null = null;
let claudeRenew: ClaudeRenew | null = null;
/**
 * Every coding session Walder has heard from, newest first.
 *
 * Both event sources feed it through `onHookEvent` below, and the hover card's
 * SESSIONS block is `liveSessions` of it. Module scope beside the two handles
 * that produce it, rather than a watcher of its own: there is nothing to
 * start, nothing to stop and no clock — the clock is `Date.now()` at the two
 * moments anything reads it.
 */
let sessions: SessionEntry[] = [];
/**
 * Click-to-raise, built here because it holds nothing: no window, no timer, no
 * state between calls. `createRaiser({})` takes the real `execFile` and the
 * real platform, and a machine that is not macOS gets a `raise` that returns
 * `false` without running anything.
 */
const raiser = createRaiser({});
/** Where `warn`/`vlog` are being written, for the tray caption. */
let logPath: string | undefined;

/**
 * The first-run introduction, as the beats that have not been played yet.
 *
 * A list rather than a counter because the third beat is not ours — the hook
 * offer pushes itself on (see `startHooks`) — and a counter would mean two
 * places agreeing about how many beats there are.
 */
let intro: Array<() => void> = [];

/**
 * Start writing the log file, before anything else can have something to say.
 *
 * `app.getPath('logs')` is the OS's own place for this — `~/Library/Logs/Walder`
 * on macOS, `%APPDATA%\Walder\logs` on Windows — so an owner asked for "the log
 * file" can be told a location that is the same on every machine. It must be
 * called after `whenReady`, like every other `getPath`.
 *
 * The verbose *level* comes from the store, which is opened a moment later in
 * `start()`; until then only warnings are recorded, which is the right default
 * for the handful of lines that could arrive in between.
 */
function startFileLog(): void {
  try {
    const file = createFileLog({ dir: app.getPath('logs') });
    setLogSink(file.write);
    logPath = file.path;
  } catch (error) {
    // No file, console only. Never fatal: a mascot that refused to start
    // because it could not open its log would be absurd.
    warn('could not open the log file:', error);
  }
}

/**
 * Refuse every permission the renderer could ask for, before any window exists.
 *
 * Walder's renderer draws a dog: it has no use for the camera, the microphone,
 * geolocation, notifications, clipboard reads, media-key capture or anything else
 * on that list. Electron's default is to *grant* several of them, and a
 * permission dialog attributed to an app with no visible window would be both
 * alarming and unexplainable. Both handlers are needed — `RequestHandler` covers
 * the asking APIs, `CheckHandler` the synchronous availability checks — and they
 * must be installed before the window loads, or a fast page could slip a request
 * in first.
 *
 * The login partitions get the same treatment in `login-window.ts`; this covers
 * the default session, which is the overlay's and the panel's.
 */
function denyAllPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  vlog('permission handlers installed (deny all)');
}

/**
 * Push a snapshot to both windows and refresh the menu's account lines.
 *
 * `forIpc` first: the renderers get the trimmed snapshot, without each bucket's
 * original provider payload. Nothing in either window reads it, and it is
 * unvalidated remote JSON that on the ChatGPT route can carry account metadata.
 */
function publishSnapshot(snapshot: UsageSnapshot): void {
  // The rows the owner unticked never reach a window: `forIpc` filters them out
  // and rebuilds each service's own list from what is left, so they leave the
  // card and the per-service sections in a single pass — and it reports back the
  // service whose *every* row is hidden, which the panel then drops entirely. No
  // store means nothing is hidden — that is the tests' path, and the first
  // seconds of a run whose settings file could not be opened.
  const payload = forIpc(snapshot, store === null ? [] : readHiddenBuckets(store));
  overlay?.send(CH.usageUpdate, payload);
  panel?.send(CH.usageUpdate, payload);
  trayHandle?.refresh();
  refreshLoginChecks(snapshot);
  // Last: the coordinator may bark about this snapshot, and the bubble should
  // land after the numbers it is about.
  //
  // The **full** snapshot, deliberately. The dog's face follows Claude's 5-hour
  // window whether or not that row is on the card (`pctForFace`), and the
  // coordinator drops the hidden rows from its own bark filter — so handing it
  // the trimmed list would silence the face as well as the barks.
  behaviour?.onUsage(snapshot);

  // A logged-out keychain item is worth a notice, once per episode: nothing
  // will fix itself here (`claude-oauth.ts`), so a bark on every poll would
  // just repeat itself for as long as the owner stays away from `claude`.
  if (snapshot.services.claude.message === LOGGED_OUT_MESSAGE && !saidLoggedOut) {
    saidLoggedOut = true;
    behaviour?.onNotice(CLAUDE_LOGGED_OUT_TEXT);
  } else if (snapshot.services.claude.status === 'ok') {
    saidLoggedOut = false;
  }
}

/**
 * Whether the logged-out notice has already fired for the current episode —
 * same gate style as `checkClaudeHookInstall`'s one-shot warnings, in memory
 * only. The provider boundary is crossed by message identity alone (matching
 * `LOGGED_OUT_MESSAGE`), which is deliberately the only thing about the
 * credential that reaches this far. Cleared on the next `ok`, so a later
 * logout barks again.
 */
let saidLoggedOut = false;

/** Services whose login check is in flight, so a slow one cannot queue up. */
const checking = new Set<ServiceName>();

/**
 * After a poll, find out whether the *login* for anything that is not working
 * is still good — so the tray's Accounts line has something true to say.
 *
 * Only for a service the poll could not answer for. That is the whole point: a
 * service reporting `ok` needs no explanation, and asking anyway would add two
 * requests against the owner's account every three minutes forever. A broken one
 * is exactly what he opens the menu about, and one extra request per poll while
 * it is broken is a fair price for "Not logged in — last check: HTTP 401
 * (12:03)" instead of a flat "login needed" with no date on it.
 *
 * Fire-and-forget: the answer lands in the provider's own memory (nothing is
 * persisted) and the menu is rebuilt so it shows up. A failure is not reported —
 * `isWebLoginAuthenticated` already turns a throw into `false`, and the record it
 * leaves behind says the check failed, which is the honest thing for the menu to
 * show.
 */
function refreshLoginChecks(snapshot: UsageSnapshot): void {
  const currentChains = chains;
  if (currentChains === null) return;
  for (const service of ['claude', 'chatgpt'] as const) {
    if (snapshot.services[service].status === 'ok') continue;
    if (checking.has(service)) continue;
    checking.add(service);
    void isWebLoginAuthenticated(chainFor(currentChains, service), service)
      .then(() => trayHandle?.refresh())
      .finally(() => checking.delete(service));
  }
}

/**
 * Both of the sheet's box dimensions, for the overlay window.
 *
 * Read from the loaded art rather than hard-coded: the winning mascot design
 * chooses its own grid (the 2026-09-08 gate moved it once already), and the
 * window is sized from whichever box is showing.
 */
function sheetBoxes(loaded: SpriteSheet): BoxSizes {
  const stand = boxSize(loaded, 'stand');
  return {
    stand,
    sleep: boxSize(loaded, 'sleep'),
    ...(loaded.boxes.lie === undefined ? {} : { lie: boxSize(loaded, 'lie') })
  };
}

/**
 * Start the Claude Code hook listener, remember the port it got, and find out
 * whether the hooks that are supposed to reach it actually exist.
 *
 * A failed *bind* is not fatal and not reported to the owner: the only
 * consequence is that the dog never perks when a reply finishes. A missing or
 * stale *install* is a different matter and is the 0.2.5 fix — see
 * `checkHookInstall`.
 */
/** Play the next beat of the introduction, if there is one left. */
function nextIntroBeat(): void {
  intro.shift()?.();
}

/**
 * The first run: three bubbles, one per pet.
 *
 * Until 0.2.6 a first launch was a dog appearing in the corner of the screen
 * with a confused face, no dock icon, no window, and nothing anywhere saying
 * what he was or what he wanted. Everything the owner needs is in the tray menu
 * and the tray menu is a bone he has no reason to have noticed.
 *
 * **Three beats, and one pet between each.** Not one bubble with three
 * sentences, and not three bubbles at once, for two independent reasons. The
 * mechanical one: `Behaviour.onNotice` keeps exactly one queued notice, newest
 * wins, so three queued in a tick would leave one. The real one: the pet *is*
 * the lesson. A new owner has to learn that clicking the dog dismisses what he
 * is saying, and the only way to teach that is to make him do it — three times,
 * with something worth reading each time.
 *
 * **The login beat is decided at pet time, not here.** By the time the owner
 * has read the first bubble and clicked, the first poll has had its chance; if
 * it came back with numbers, there is nothing to log in to and the beat is
 * skipped by recursing straight into the next one. The test is `!== 'ok'` and
 * not `=== 'auth-needed'` on purpose: any answer short of real numbers — no
 * login, an expired one, a provider that failed — leaves a confused dog and no
 * data, and "go and log in" is the right first thing to try for all of them.
 *
 * **The flag is written before the first bubble**, exactly as
 * `offerHooksOnFirstLaunch` writes `hooksOffered` before its dialog: a crash in
 * the middle of an introduction that cannot be recorded is an introduction
 * repeated at every launch forever, and the worst case of recording first is
 * one introduction nobody saw.
 *
 * ponytail: an update notice arriving during beat 1 takes the single notice
 * slot and is replaced by beat 2. Accepted — it is a first launch of a version
 * that was current minutes ago, and the menu carries the update permanently.
 */
function startIntro(): void {
  if (store === null || store.get('introduced') === true) return;
  try {
    store.set('introduced', true);
  } catch (error) {
    warn('could not record the introduction:', error);
  }
  vlog('first launch: introducing the app');

  intro = [
    () => behaviour?.onNotice(INTRO_HELLO_TEXT),
    () => {
      if (poller?.last()?.services.claude.status === 'ok') nextIntroBeat();
      else behaviour?.onNotice(INTRO_LOGIN_TEXT);
    }
  ];
  nextIntroBeat();
}

/**
 * One hook event, from either source: the dog reacts, and the list updates.
 *
 * Both sites used to be `behaviour?.onHook(event)` and nothing else. The
 * SESSIONS block needs the same event a second time, so the pair became one
 * function rather than the same three lines twice — and the home directory is
 * replaced with `~` *here*, before the entry exists, because `os.homedir()` is
 * a node call and `src/core` may not make one. Shortening it any further is
 * the card's business (`shortenCwd`).
 *
 * Never logged: `cwd` is a path on the owner's own disk.
 */
function onHookEvent(event: HookEvent): void {
  behaviour?.onHook(event);
  const home = homedir();
  const cwd =
    event.cwd !== undefined && home.length > 0 && event.cwd.startsWith(home)
      ? `~${event.cwd.slice(home.length)}`
      : event.cwd;
  const now = Date.now();
  // Pruned on the way in, not only on the way out to the card: an entry the
  // clock has already dropped can never come back — its `at` cannot move
  // without another event, and another event rebuilds it anyway — so keeping
  // the aged ones would be a list that grows by one per session for as long as
  // the app runs, and every event walks it three times.
  sessions = liveSessions(
    reduceSessionEntries(sessions, { ...event, ...(cwd === undefined ? {} : { cwd }) }, now),
    now
  );
  panel?.setSessions(sessions);
}

async function startHooks(): Promise<void> {
  if (store === null) return;
  const preferred = store.get('hookPort');
  hookServer = await startHookServer({
    port: typeof preferred === 'number' ? preferred : DEFAULT_HOOK_PORT,
    onEvent: onHookEvent,
    onPort: (port) => {
      try {
        // `null` included: a launch that bound nothing must not leave an
        // earlier run's port behind for the installer to write into a hook.
        store?.set('hookPortActual', port);
      } catch (error) {
        warn('could not persist the hook port:', error);
      }
    }
  });
  // The hook offer is beat 3 of the introduction on a first launch, and an
  // interruption on every other one. `startHookServer` is awaited above, so by
  // the time this line runs `start()` has returned and `startIntro` has already
  // filled the list — an empty list therefore means "not a first launch".
  if (intro.length === 0) checkHookInstall();
  else intro.push(checkHookInstall);
}

/**
 * Do the installed hooks — Claude Code's and Codex's — really point at the
 * listener we just started?
 *
 * The question nothing asked before 0.2.5, and the reason the owner's dog sat
 * silent for days: his hooks were simply not there. Everything looked healthy
 * from inside the app — the listener bound, the port was stored — and every
 * refusal path in the server was a `vlog` behind a Verbose log nobody had on.
 *
 * Two answers per tool are worth interrupting for, and each gets **one bubble
 * per launch** (this runs once, from `startHooks`), because both are a standing
 * condition rather than news: nothing about them changes until the owner acts.
 * The warning goes to the log for a bug report; the bubble is what he actually
 * sees, and the tray's status lines are where he can check them afterwards.
 *
 * Claude first, then Codex. With both missing the second notice replaces the
 * first in the queue (`onNotice` keeps at most one), which is deliberate: two
 * bubbles about two files he has to visit anyway is nagging, the tray says both,
 * and the dialogs below offer both on a first launch regardless.
 *
 * **Chained, not fired side by side.** On a machine that has both tools and
 * neither's hooks, both first-launch offers are due — and two modal dialogs
 * asked in the same tick stack on top of each other, so the owner answers a
 * question about Codex while a question about Claude Code is still waiting
 * underneath it, in whatever order the platform happens to order them. The
 * Claude offer therefore resolves before the Codex one is even asked. The chain
 * is `void`ed rather than awaited: startup may not block on a dialog, and
 * neither half can reject (every dialog path below reports its own failures).
 */
function checkHookInstall(): void {
  void checkClaudeHookInstall().then(() => checkCodexHookInstall());
}

async function checkClaudeHookInstall(): Promise<void> {
  const installed = installedHookPort();
  const bound = hookServer?.port ?? null;

  if (installed === null) {
    // No Claude Code on this machine at all: nothing to install into, and a
    // bubble telling somebody to install hooks for a tool he does not have is
    // the app nagging about itself. The tray's status line still says so.
    if (!existsSync(dirname(claudeSettingsPath()))) {
      vlog('no ~/.claude directory; skipping the Claude Code hooks notice');
      return;
    }
    warn(
      'Claude Code hooks are not installed; the dog will not react to Claude Code until they are'
    );
    behaviour?.onNotice(HOOKS_MISSING_TEXT);
    await offerHooksOnFirstLaunch('claude');
    return;
  }

  // Nothing bound is already warned about by the server, and a reinstall would
  // not help: there is no port to point the hooks at.
  if (bound === null || installed === bound) return;

  warn(
    `the installed Claude Code hooks post to port ${installed}, but Walder is listening ` +
      `on ${bound}; they need reinstalling from the tray`
  );
  behaviour?.onNotice(HOOKS_STALE_TEXT);
}

/**
 * The same three questions for Codex, against `~/.codex/hooks.json`.
 *
 * One thing this cannot see: whether the owner has *trusted* the hooks. Codex
 * runs a non-plugin hook only after its exact definition has been trusted once
 * through `/hooks`, and that record lives in `config.toml`, a file Walder does
 * not read and must not write. So "installed" here means written, and a Codex
 * that stays silent with everything green is the trust step — which is why the
 * install dialog says so in the same breath as the success.
 */
async function checkCodexHookInstall(): Promise<void> {
  const installed = installedCodexHookPort();
  const bound = hookServer?.port ?? null;

  if (installed === null) {
    // No Codex on this machine: nothing to install into. `codexHome()` rather
    // than the file's directory, because `$CODEX_HOME` moves both.
    if (!existsSync(codexHome())) {
      vlog('no ~/.codex directory; skipping the Codex hooks notice');
      return;
    }
    warn('Codex hooks are not installed; the dog will not react to Codex until they are');
    behaviour?.onNotice(CODEX_HOOKS_MISSING_TEXT);
    await offerHooksOnFirstLaunch('codex');
    return;
  }

  if (bound === null || installed === bound) return;

  warn(
    `the installed Codex hooks post to port ${installed}, but Walder is listening ` +
      `on ${bound}; they need reinstalling from the tray`
  );
  behaviour?.onNotice(CODEX_HOOKS_STALE_TEXT);
}

/** What the tray's two status lines report. Read at menu build, never cached. */
function hookStatus(): HookInstallStatuses {
  const boundPort = hookServer?.port ?? null;
  return {
    claude: { installedPort: installedHookPort(), boundPort },
    codex: { installedPort: installedCodexHookPort(), boundPort }
  };
}

/**
 * Offer to install the hooks, once per tool per machine.
 *
 * **Only for a tool that is actually on the machine** — the caller has already
 * established that its hooks are missing, and this checks that its config
 * directory exists, because offering to write `~/.claude/settings.json` to
 * somebody who does not use Claude Code is a dialog about a feature he does not
 * have.
 *
 * **The flag is written before the dialog opens.** A crash (or a quit) while it
 * is up would otherwise leave the offer unrecorded and re-asked at every launch
 * for the rest of the install's life — and an un-dismissable question is worse
 * than a missed one. The cost of recording first is at most one offer that was
 * never seen; the tray item and the status line remain, so nothing is lost.
 *
 * **Returns when the offer is finished**, not when it is opened — the dialog
 * answered and, if the answer was yes, the write and its report dialog done
 * too. That is what lets `checkHookInstall` ask about one tool at a time
 * instead of stacking two modals. Every path resolves: an offer that is not due
 * (already made, no config directory, no store) resolves immediately, and the
 * write reports its own failures rather than rejecting.
 *
 * **Not unit-tested, and deliberately so.** Everything it decides is Electron:
 * `dialog.showMessageBox`, the tray-owned `store` module singleton, and
 * `existsSync` against the real `~/.claude` and `$CODEX_HOME`. Testing it would
 * mean mocking `index.ts`'s whole module graph — the app's entry point, which
 * builds windows at import time — for one `.then`. The ordering it exists for
 * is visible in QA §7 instead (the first-launch rows), and `store.test.ts`
 * pins the `hooksOffered` flag that makes it once-per-machine.
 */
async function offerHooksOnFirstLaunch(tool: 'claude' | 'codex'): Promise<void> {
  if (store === null) return;
  // `~/.claude` for Claude Code, `$CODEX_HOME ?? ~/.codex` for Codex — the
  // directory each tool keeps its own config in, and the only evidence on the
  // machine that it is used at all.
  const home = tool === 'claude' ? dirname(claudeSettingsPath()) : codexHome();
  if (!existsSync(home)) return;

  const offered = store.get('hooksOffered');
  if (offered?.[tool] === true) return;
  try {
    store.set('hooksOffered', { ...offered, [tool]: true });
  } catch (error) {
    // Recorded or not, the offer is made — but say so, because the consequence
    // of a failed write is the same dialog again at the next launch.
    warn('could not record the hook offer:', error);
  }
  vlog(`offering the ${tool} hook install (first launch)`);
  if (tool === 'claude') await applyClaudeHooks(false, true);
  else await applyCodexHooks(false, true);
}

/**
 * Install or remove the hooks in `~/.claude/settings.json`, asking first.
 *
 * **Why it asks.** This is the only thing in the whole app that writes to a file
 * the owner did not give it — a file Claude Code itself depends on — and the tray
 * is a menu with no undo, one slip of the mouse away from Quit. So both
 * directions confirm, and the confirmation names the *path* and says a backup is
 * written, because "Install Claude Code hooks…" on its own does not tell anyone
 * which file is about to change. The trailing ellipsis in both labels is the
 * platform convention promising exactly this dialog.
 *
 * Removal is a menu item rather than a README instruction for the same reason:
 * an owner who installed from a `.dmg` has no project folder to run `npm run
 * install-hooks -- --remove` in, so the documented uninstall step was one only a
 * developer could perform. `applyHooks({remove: true})` was already there and
 * already tested; nothing but a way to reach it was missing.
 *
 * **`offer` is the first-launch variant** (0.2.5): the same question, plus the
 * sentence that makes "Cancel" a safe answer, and asked with the *async*
 * `showMessageBox` because nothing about starting up may block on a dialog. The
 * tray path keeps `showMessageBoxSync` — it is already inside a click, and the
 * synchronous form is what keeps the confirmation and the write in one
 * readable line.
 *
 * The returned promise is only interesting on the `offer` path, where it is how
 * `checkHookInstall` asks about one tool at a time; the tray fires and forgets.
 */
async function applyClaudeHooks(remove: boolean, offer = false): Promise<void> {
  const path = claudeSettingsPath();
  const verb = remove ? 'Remove' : 'Install';

  const question = {
    type: 'question' as const,
    title: 'Walder',
    message: `${verb} Walder's Claude Code hooks?`,
    detail:
      (remove
        ? `This takes Walder's three entries out of\n${path}\n\n` +
          'Nothing else in the file is touched, and a dated copy of it is saved ' +
          'beside it first. Claude Code stops telling Walder when a reply is done, ' +
          'and is otherwise unaffected.'
        : `This adds three entries to\n${path}\n\n` +
          'They send a short message to Walder on this machine when Claude Code ' +
          'finishes a reply or waits for you, and do nothing else. A dated copy of ' +
          'the file is saved beside it first.') +
      (offer
        ? '\n\nYou can do this later from the tray menu (Install Claude Code hooks…).'
        : ''),
    buttons: [verb, 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  };

  if (offer) {
    const { response } = await dialog.showMessageBox(question);
    if (response === 0) await writeClaudeHooks(remove, verb);
    else vlog(`${verb.toLowerCase()}-hooks: declined at the launch offer`);
    return;
  }

  if (dialog.showMessageBoxSync(question) !== 0) {
    vlog(`${verb.toLowerCase()}-hooks: cancelled at the confirmation`);
    return;
  }
  await writeClaudeHooks(remove, verb);
}

/**
 * The half of `applyClaudeHooks` that happens once the owner has said yes: the
 * write, and the dialog reporting what it did. Split out so the confirmation
 * can be asked synchronously (the tray) or asynchronously (the launch offer)
 * without two copies of everything that follows it.
 *
 * Resolves when the report dialog has been dismissed, and **never rejects**:
 * both outcomes end in a `showMessageBox`, which is the only channel there is.
 */
async function writeClaudeHooks(remove: boolean, verb: string): Promise<void> {
  // The port actually bound first: the listener walks to `hookPort + 1` when the
  // preferred one is taken, and a hook pointing at the unbound preferred port
  // would look installed and do nothing. Irrelevant to a removal, which matches
  // on the marker rather than the port, but harmless to pass.
  const port = store?.get('hookPortActual') ?? store?.get('hookPort') ?? DEFAULT_HOOK_PORT;
  try {
    const outcome = await applyHooks({
      port: typeof port === 'number' ? port : DEFAULT_HOOK_PORT,
      remove
    });
    vlog(`${verb.toLowerCase()}-hooks:`, outcome.summary);
    const detail =
      outcome.backupPath === null
        ? outcome.summary
        : `${outcome.summary}\n\nThe original file was copied to ${outcome.backupPath}.`;
    // A dialog is the only channel there is: Walder has no window and the
    // owner never sees a terminal. Awaited, so the caller's promise does not
    // resolve while this box is still on screen — which is what would let a
    // second first-launch offer open underneath it.
    await dialog.showMessageBox({
      type: outcome.changed ? 'info' : 'none',
      title: 'Walder',
      message: 'Claude Code hooks',
      detail,
      buttons: ['OK'],
      noLink: true
    });
  } catch (error: unknown) {
    warn(`${verb.toLowerCase()}-hooks failed:`, error);
    await dialog.showMessageBox({
      type: 'error',
      title: 'Walder',
      message: 'Could not update the Claude Code settings',
      detail: 'Nothing was changed. See the log for details.',
      buttons: ['OK'],
      noLink: true
    });
  }
}

/**
 * The Codex twin of `applyClaudeHooks`: the same confirmation, the same two
 * directions, a different file (`~/.codex/hooks.json`).
 *
 * Kept as its own pair of functions rather than a tool-parameterised one because
 * almost nothing the owner *reads* is shared — a different path, a different
 * third event, and one whole extra step that has no Claude equivalent (the
 * trust gate, in `writeCodexHooks`). A table of four detail strings would hide
 * the wording where nobody proof-reads it.
 */
async function applyCodexHooks(remove: boolean, offer = false): Promise<void> {
  const path = codexHooksPath();
  const verb = remove ? 'Remove' : 'Install';

  const question = {
    type: 'question' as const,
    title: 'Walder',
    message: `${verb} Walder's Codex hooks?`,
    detail:
      (remove
        ? `This takes Walder's three entries out of\n${path}\n\n` +
          'Nothing else in the file is touched, and a dated copy of it is saved ' +
          'beside it first. Codex stops telling Walder when a turn is done, and is ' +
          'otherwise unaffected.'
        : `This adds three entries to\n${path}\n\n` +
          'They send a short message to Walder on this machine when Codex finishes ' +
          'a turn or waits for you, and do nothing else. A dated copy of the file ' +
          'is saved beside it first. Your Codex settings file (config.toml) is not ' +
          'touched.') +
      (offer ? '\n\nYou can do this later from the tray menu (Install Codex hooks…).' : ''),
    buttons: [verb, 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  };

  if (offer) {
    const { response } = await dialog.showMessageBox(question);
    if (response === 0) await writeCodexHooks(remove, verb);
    else vlog(`${verb.toLowerCase()}-codex-hooks: declined at the launch offer`);
    return;
  }

  if (dialog.showMessageBoxSync(question) !== 0) {
    vlog(`${verb.toLowerCase()}-codex-hooks: cancelled at the confirmation`);
    return;
  }
  await writeCodexHooks(remove, verb);
}

/**
 * The write, and the dialog reporting it — `writeClaudeHooks` with one extra
 * paragraph that is the whole reason this cannot be silent.
 *
 * **The trust step.** Codex runs a non-plugin hook only after the owner has
 * trusted its exact definition once, and it skips an untrusted one *silently*.
 * So a successful install here produces a dog that still never reacts, with
 * nothing anywhere to explain it — the 0.2.4 failure all over again, except this
 * time by design of the tool. Walder will not write the hash itself (that hash
 * is the owner's review of a command, not ours to forge), so the only honest
 * thing left is to say what he has to do, in the dialog that just told him the
 * install worked.
 */
async function writeCodexHooks(remove: boolean, verb: string): Promise<void> {
  const port = store?.get('hookPortActual') ?? store?.get('hookPort') ?? DEFAULT_HOOK_PORT;
  try {
    const outcome = await writeCodexHookFile({
      port: typeof port === 'number' ? port : DEFAULT_HOOK_PORT,
      remove
    });
    vlog(`${verb.toLowerCase()}-codex-hooks:`, outcome.summary);
    const parts = [outcome.summary];
    if (outcome.backupPath !== null) {
      parts.push(`The original file was copied to ${outcome.backupPath}.`);
    }
    if (!remove && outcome.changed) {
      parts.push(
        'Codex runs a new hook only after you trust it once: open a terminal, run ' +
          // Straight apostrophe, like every other user-facing "Walder's" in
          // the app: the curly one was the odd entry out.
          "`codex`, type `/hooks`, and trust Walder's three entries. Until then " +
          'Codex stays silent.'
      );
    }
    // Awaited for the same reason as its Claude twin: the caller may be walking
    // two first-launch offers in turn, and must not open the next one over this.
    await dialog.showMessageBox({
      type: outcome.changed ? 'info' : 'none',
      title: 'Walder',
      message: 'Codex hooks',
      detail: parts.join('\n\n'),
      buttons: ['OK'],
      noLink: true
    });
  } catch (error: unknown) {
    warn(`${verb.toLowerCase()}-codex-hooks failed:`, error);
    await dialog.showMessageBox({
      type: 'error',
      title: 'Walder',
      message: 'Could not update the Codex hooks',
      detail: 'Nothing was changed. See the log for details.',
      buttons: ['OK'],
      noLink: true
    });
  }
}

/**
 * Turn the hide-when-idle mode on or off — the one place that does it.
 *
 * There are two ways in (the menu checkbox and the global shortcut) and three
 * things that must happen for either: the preference is stored, the coordinator
 * is told (which is what actually hides or shows him, immediately when there is
 * nothing to say), and the menu is rebuilt so its checkmark is not left lying.
 * Two copies of that would drift, and the copy that drifted would be the
 * shortcut — the one nobody watches a menu while using.
 */
function setHideWhenIdle(on: boolean): void {
  try {
    store?.set('hideWhenIdle', on);
  } catch (error) {
    // The mode still takes effect for this run; only the memory of it is lost.
    warn('could not persist the hide-when-idle setting:', error);
  }
  behaviour?.setHideWhenIdle(on);
  trayHandle?.refresh();
  vlog('hideWhenIdle ->', on);
}

/**
 * Store a new shortcut and bind it, from the `Shortcut ▸` menu.
 *
 * The setting is written *before* the binding is attempted and is kept whatever
 * the attempt produces: a combination another app happens to own today may be
 * free tomorrow, and quietly reverting the owner's choice would leave him
 * choosing it again and again with no explanation. The menu carries the failure
 * instead (`shortcutStatusLine`).
 */
function setHideShortcut(accelerator: string): void {
  try {
    store?.set('hideShortcut', accelerator);
  } catch (error) {
    warn('could not persist the hide shortcut:', error);
  }
  shortcut?.apply(accelerator);
  trayHandle?.refresh();
}

/**
 * Open the release page in the owner's browser — **the only `shell.open*` call
 * in Walder**, and a deliberate, documented exception to the rule stated at
 * `tray.ts`'s navigation note.
 *
 * `shell.openExternal` hands a URL to whatever the OS has registered for its
 * scheme, so the one thing that must never happen is opening a URL that a
 * remote response chose. `parseLatestRelease` already pins `html_url` to the
 * release repository, and this checks the same prefix again at the point of
 * use: one guard is a rule, two is a rule that survives an edit to either side.
 */
function openUpdatePage(url: string): void {
  if (!url.startsWith(UPDATE_URL_PREFIX)) {
    warn('refused to open an update URL outside the release repository:', url);
    return;
  }
  void shell.openExternal(url);
  vlog('opened the release page');
}

/**
 * What the last update check found, in the few words a bug report wants.
 *
 * Not `updateMenuLine`: that string is a *button* ("Check for updates now",
 * "(wait 42s)"), and a diagnostics line reading like an instruction to the
 * reader is a line nobody can interpret a week later. `detail` on a failure is
 * already a shape and never a response body — see `UpdateState`.
 */
function updateStateLine(): string {
  const state = updates?.state() ?? { kind: 'never' as const };
  switch (state.kind) {
    case 'available':
      return `${state.version} available`;
    case 'up-to-date':
      return 'up to date';
    case 'failed':
      return `last check failed (${state.detail})`;
    default:
      return 'not checked yet';
  }
}

/**
 * Open a prefilled issue on the public tracker — the second and last
 * `shell.open*` call in Walder, and held to the same rule as `openUpdatePage`.
 *
 * **Nothing is sent by opening it.** The URL carries a draft the owner reads in
 * his own browser and submits, or does not. That is the whole design: Walder has
 * no backend to post a report to and is not about to acquire one, and a crash
 * reporter that uploaded of its own accord would contradict the promise in
 * README's Privacy section.
 *
 * The facts are gathered here because every one of them is an Electron or
 * process reading; what may be *in* them is `core/bug-report.ts`'s decision, and
 * the `BugReportFacts` type is what stops a future edit adding an account name
 * or a usage percentage to a public issue. Nothing below reads the poller.
 *
 * The clipboard write comes first and is not a nicety: a browser that drops a
 * very long query string, or an owner who files from his phone, would otherwise
 * be left retyping the diagnostics off a screenshot.
 */
function openBugReport(): void {
  const facts: BugReportFacts = {
    version: app.getVersion(),
    platform: process.platform,
    osVersion: process.getSystemVersion(),
    arch: process.arch,
    electron: process.versions.electron,
    displays: screen.getAllDisplays().map((display) => ({
      width: display.size.width,
      height: display.size.height,
      scale: display.scaleFactor
    })),
    settings: {
      // Display text, not stored ids: the labels are the menu's, so the report
      // and the menu cannot describe the same setting with two different words.
      size: store === null ? '?' : SIZE_LABELS[readSize(store)],
      cardSize: store === null ? '?' : CARD_SIZE_LABELS[readCardSize(store)],
      hideWhenIdle: store?.get('hideWhenIdle') === true,
      sleepInFullscreen: store?.get('sleepInFullscreen') !== false,
      primaryService: store === null ? '?' : SERVICE_LABELS[readPrimaryService(store)]
    },
    updateState: updateStateLine(),
    // `null`, not `false`, when there is no watch: "we were not looking" and
    // "nothing was fullscreen" are different answers.
    fullscreen: fullscreenWatch?.isFullscreen() ?? null,
    logPath: logPath ?? null
  };

  clipboard.writeText(diagnosticsBlock(facts));

  const url = bugReportUrl(facts);
  if (!url.startsWith(BUG_REPORT_URL_PREFIX)) {
    warn('refused to open a bug-report URL outside the release repository:', url);
    return;
  }
  void shell.openExternal(url);
  vlog('opened the bug report page');
}

/**
 * Show the log file in the owner's file manager.
 *
 * `showItemInFolder` rather than `openPath`: the owner is being asked to *send*
 * the file, and selecting it in Finder is the step before dragging it into a
 * GitHub issue — whereas opening it would hand a 1 MB text file to whatever
 * happens to own `.log` on his machine. A no-op when no file sink was installed;
 * the menu item is disabled in that case anyway, and this is the second guard.
 */
function revealLogFile(): void {
  if (logPath === undefined) return;
  shell.showItemInFolder(logPath);
  vlog('revealed the log file');
}

/**
 * Start asking GitHub, every six hours, whether a newer Walder exists.
 *
 * Wiring worth reading twice: `updateNotifiedVersion` is written **before**
 * `onUpdateAvailable`. The bubble is a once-per-version thing, and if the write
 * came second, a crash (or a quit) in between would leave the version unrecorded
 * and the notice repeating on every check for the rest of that version's life.
 * Recording first can at worst cost one notice that was never shown — and the
 * menu carries the update permanently either way, so nothing is actually lost.
 */
function startUpdateChecks(): void {
  updates = createUpdateChecker({
    // The same adapter the providers use — timeout, 1 MB cap, `redirect:
    // 'manual'`. `'omit'`: this goes to GitHub and must not carry a cookie for
    // anything.
    http: fromFetch(net.fetch.bind(net), 'omit'),
    currentVersion: app.getVersion(),
    enabled: () => store?.get('checkForUpdates') !== false,
    onState: (state, manual) => {
      if (state.kind === 'available' && shouldNotify(state.version, store?.get('updateNotifiedVersion'))) {
        try {
          store?.set('updateNotifiedVersion', state.version);
        } catch (error) {
          warn('could not record the notified version:', error);
        }
        behaviour?.onUpdateAvailable(state.version);
      }
      // Only after a click. The owner asked and deserves an answer — the menu
      // item greys out for the cooldown and comes back saying exactly what it
      // said before, which is what "nothing happened" also looks like. The
      // six-hourly check saying this four times a day would be nagging, and
      // there is no memory to make it once-only: it is true every time.
      if (manual && state.kind === 'up-to-date') behaviour?.onUpToDate();
      // Always, including a failure: the menu line is the permanent record of
      // what the last check found.
      trayHandle?.refresh();
    }
  });
  updates.start();
}

function start(): void {
  store = createStore();

  // Before the first `vlog` that could matter, and after the store exists,
  // because the store is where the owner's choice lives.
  setVerbose(store.get('verboseLog') === true);
  vlog('walder starting; log file:', logPath ?? '(console only)');

  try {
    sheet = loadSheet();
  } catch (error) {
    // A malformed sheet leaves nothing to draw, and silently showing an empty
    // window would look identical to a crash. Fail loudly instead.
    warn('sprite sheet failed validation:', error);
    app.exit(1);
    return;
  }

  vlog('userData:', app.getPath('userData'));
  vlog('settings file:', store.path);

  // Keep the OS login item in step with the stored preference: the user may have
  // removed it in System Settings since the last run. A no-op unless packaged —
  // see `applyLaunchAtLogin`.
  applyLaunchAtLogin(store.get('launchAtLogin') === true);

  // No `denyAllPermissions()` here any more: it is installed in the `whenReady`
  // handler, above both this and the gallery branch. Calling it twice was
  // harmless (the second `setPermissionRequestHandler` simply replaced the
  // first) but it logged "permission handlers installed" twice on every start,
  // which reads like a restart that did not happen.
  overlay = createOverlay(store, initialScale(store), sheetBoxes(sheet));
  // Before the page loads, not after: the flag rides on `currentMode()`, which
  // is what the renderer pulls through `settings:get` for its first paint.
  overlay.setStill(store.get('stillMode') === true);

  panel = createHoverPanel({
    cardSize: readCardSize(store),
    // Read at each show, for the log line only: whether we believed a
    // full-screen app was in front is the state the whole diagnosis turns on,
    // and reconstructing it afterwards from timestamps proved unreliable.
    isFullscreen: () => behaviour?.isFullscreen() ?? false
  });

  behaviour = createBehaviour({
    getOverlay: () => overlay,
    // Only the sleeping-box pet consults this: it picks between a twitch and a
    // `…zzz` bubble, and the renderer's usual "fall back to idle" would be no
    // visible reaction at all there.
    hasAnimation: (name) => sheet?.animations[name] !== undefined,
    // The stored hide-when-idle preference, read once. `createBehaviour` turns
    // it into a `setHideWhenIdle(true)` so the very first batch hides him,
    // before `ready-to-show` can put him on screen for a frame.
    hideWhenIdle: () => store?.get('hideWhenIdle') === true,
    // The stored bark preset, read once — same reasons as `hideWhenIdle`. The
    // tray pushes every later change straight through `behaviour.setBarkPreset`.
    barkPreset: () => (store === null ? DEFAULT_BARK_PRESET : readBarkPreset(store)),
    // He has left the screen, and a hidden window sends no `mouseleave`.
    onHidden: () => panel?.hoverLeave(),
    // What he had already barked about when he was last quit, and where the
    // same is written after each poll. Without the pair, the snapshot restored
    // at launch (`lastSnapshot`) re-crosses every threshold it is already past
    // and he re-announces all of it.
    memory: () => store?.get('behaviourMemory'),
    saveMemory: (memory) => store?.set('behaviourMemory', memory),
    // Which rows are off the card, and therefore also silent. Read once here;
    // the tray pushes every later change straight through `setHiddenBuckets`.
    hiddenBuckets: () => (store === null ? [] : readHiddenBuckets(store)),
    // Is the notification fallback on? Read per batch, not once: the tray
    // writes this key and the owner ticks it in the moment he needs it.
    notifyWhenHidden: () => store?.get('notifyWhenHidden') === true,
    /*
     * The fallback itself, for a bark nobody can see.
     *
     * The `Notification` is constructed **here, at delivery**, and that is the
     * whole reason this is a closure and not a flag: macOS asks for permission
     * the first time one is shown, so a Walder that built one at launch would
     * put up a system prompt before the owner had ticked anything. Silent,
     * because the bark it repeats is silent — the dog is a thing you glance at,
     * not a thing that pings — and `isSupported` because a Linux desktop
     * without a notification daemon is a `show()` that throws.
     */
    notify: (text) => {
      if (!Notification.isSupported()) return;
      new Notification({ title: 'Walder', body: text, silent: true }).show();
    },
    // A pet is the owner asking "so where am I?", so it also asks for fresh
    // numbers. Read through the closure rather than captured: the poller is
    // built a few lines below this. The 60 s manual cooldown inside `refreshNow`
    // is what makes repeated petting harmless.
    refreshUsage: () => void poller?.refreshNow(),
    /*
     * And the same pet, when it dismissed a `?`, brings that terminal forward.
     *
     * `sessions` is newest-first (`reduceSessionEntries` sorts it that way), so
     * a plain `find` is already the right pick: the session that most recently
     * spoke for this tool is the one whose head-tilt was on screen.
     *
     * The fallback to a session that is no longer `waiting` is deliberate. The
     * bubble said "waiting" — that is what the owner clicked — but the list is
     * fed by the same event stream and may have moved the row to `done` a
     * moment ago, while the `?` was still up and still the truth as far as he
     * could see. Raising the terminal he pointed at is right in both cases.
     *
     * A Codex session carries no pid (its hooks send none), so `pid !== null`
     * is what quietly makes this a Claude Code feature until that changes.
     */
    onWaitingDismissed: (source) => {
      const entry =
        sessions.find((s) => s.source === source && s.state === 'waiting' && s.pid !== null) ??
        sessions.find((s) => s.source === source && s.pid !== null);
      if (entry?.pid != null) void raiser.raise(entry.pid).catch(() => undefined);
    }
  });

  /*
   * The Claude Code login renewal, wired before the chains that feed it.
   *
   * The scratch directory is not a detail. It is the child's cwd, and the CLI
   * discovers its project context by walking *up* from wherever it was started:
   * a `CLAUDE.md`, a `.claude/settings.json`, an `.mcp.json`. An empty
   * directory inside `userData` has no ancestor carrying any of those, so the
   * renewal run finds nothing and does nothing but renew. It is also stable
   * across reboots, which `/var/folders` is not — a temp directory that has
   * been swept out from under a spawn is an ENOENT for no reason at all.
   *
   * A directory we cannot create means no safe cwd, and no safe cwd means no
   * renewal: the fallback would be to start the CLI somewhere with a project in
   * it, which is precisely what this avoids.
   */
  try {
    const scratchDir = join(app.getPath('userData'), 'claude-scratch');
    mkdirSync(scratchDir, { recursive: true });
    claudeRenew = createClaudeRenew({ binary: findClaudeBinary(), scratchDir });
  } catch (error) {
    warn('no scratch directory for the Claude renewal; renewal off:', error);
  }

  chains = createChains({
    store,
    // Every expiry `claude-oauth` reads, which — the web provider being first
    // in that chain — is only the polls where the CLI token is what Walder is
    // actually relying on.
    onClaudeExpiresAt: (expiresAt) => claudeRenew?.observe(expiresAt)
  });
  poller = createPoller({
    store,
    chains,
    onSnapshot: publishSnapshot,
    // The one usage number that comes off this disk rather than off the wire;
    // read on every publish, so it keeps updating even while a login is stale.
    localTokens: createLocalTokenScanner().totals
  });

  logins = createLoginWindows({
    store,
    /*
     * "Logged in" means the *web* provider for this service is authenticated —
     * one request that has to come back with an organisation list or an access
     * token. Not "any provider in the chain is available": that is what closed
     * the login window two seconds after it opened for anyone with Claude Code
     * or Codex installed, because their token providers are available for the
     * same service and know nothing about the browser session being created.
     * And not "a cookie exists" either: both sites set cookies on the login
     * page itself.
     */
    isLoggedIn: async (service: ServiceName) => {
      if (chains === null) return false;
      return isWebLoginAuthenticated(chainFor(chains, service), service);
    },
    onLoggedIn: () => {
      poller?.refreshNow();
      trayHandle?.refresh();
    }
  });

  // `getOverlay`, not `overlay`: `ensureOverlay` replaces the window without
  // rebuilding the tray, and a captured handle would leave every menu item
  // pointing at a destroyed window.
  trayHandle = createTray({
    getOverlay: () => overlay,
    store,
    sheet,
    onQuit: () => app.quit(),
    ...(logPath === undefined ? {} : { logPath }),
    getUsage: () => poller?.last() ?? null,
    onRefreshNow: () => poller?.refreshNow() ?? false,
    refreshCooldownMs: () => poller?.cooldownRemainingMs() ?? 0,
    onLogin: (service) => logins?.openLogin(service),
    onLogout: (service) => {
      void logins?.logout(service).then(() => {
        // A logout changes what the panel should say immediately, not in three
        // minutes — and not "unless he pressed Refresh in the last minute",
        // which is what `refreshNow` alone meant: its cooldown would refuse,
        // and the logged-out account's buckets would sit in the snapshot (and
        // in the store, and so at the next launch). `forget` is the fact;
        // `pokeNow` then goes and gets whatever is left, without spending the
        // owner's one manual refresh on housekeeping.
        poller?.forget(service);
        poller?.pokeNow();
        trayHandle?.refresh();
      });
    },
    // The second Accounts line: what the last authentication check found, and
    // when. Read straight out of the web provider's memory — no request, which
    // matters because this runs while the menu is being built.
    getLastCheck: (service) =>
      chains === null ? null : lastLoginCheck(chainFor(chains, service), service),
    // Size and Reset position both move the dog out from under the hover card.
    onGeometryChanged: () => panel?.hoverLeave(),
    // Card size, by contrast, re-widens the open card in place — see the note on
    // `TrayDeps.onCardSize`.
    onCardSize: (size) => panel?.setCardSize(size),
    onResetStyle: (style) => panel?.setResetStyle(style),
    // Unlike `onResetStyle`, this never touches the panel: the preset's only
    // consumer is the `NudgeMachine` the behaviour coordinator owns.
    onBarkPreset: (preset) => behaviour?.setBarkPreset(preset),
    onBarkSound: (on) => overlay?.setBarkSound(on),
    // The card re-sorts on the spot. `publish` reads the setting, so the numbers
    // in hand are enough — no network, no cooldown to be refused by, and the
    // snapshot keeps its own `fetchedAt` so the age on the card does not lie.
    onPrimaryService: () => poller?.republish(),
    // Three consequences of one tick, in this order: the setting is the truth
    // (so it is written first and a crash cannot lose it), the coordinator must
    // know before the next poll can bark about a row the owner has just hidden,
    // and the republish is what takes the row off an already-open card without
    // a network round trip or a cooldown to be refused by.
    onHiddenBuckets: (ids) => {
      store?.set('hiddenBuckets', [...ids]);
      behaviour?.setHiddenBuckets(ids);
      poller?.republish();
    },
    hiddenBuckets: () => (store === null ? [] : readHiddenBuckets(store)),
    // Only for labelling a row `KNOWN_ROWS` has never heard of — the checkbox
    // has to be called something, and the card's own word for it is the only
    // name that exists.
    lastBuckets: () => poller?.last()?.buckets ?? [],
    onSleepInFullscreen: (on) => {
      // Turning it off must wake a dog that is already curled up, without
      // waiting for the next poll of a watch that is now idle. `setEnabled`
      // also stops the 2 s timer when off (and restarts it, clearing a
      // given-up watch, when on) — see `fullscreen-watch.ts`.
      if (!on) behaviour?.setFullscreen(false);
      fullscreenWatch?.setEnabled(on);
    },
    // The tray already wrote the store; the renderer is the half that draws.
    onStillMode: (on) => overlay?.setStill(on),
    onHideWhenIdle: (on) => setHideWhenIdle(on),
    onHideShortcut: (accelerator) => setHideShortcut(accelerator),
    shortcutStatus: () => shortcut?.status() ?? 'unregistered',
    updateState: () => updates?.state() ?? { kind: 'never' },
    onCheckUpdateNow: () => updates?.checkNow() ?? false,
    updateCooldownMs: () => updates?.cooldownRemainingMs() ?? 0,
    onOpenUpdate: (url) => openUpdatePage(url),
    onReportBug: () => openBugReport(),
    onRevealLog: () => revealLogFile(),
    // `void`: the tray only ever fires and forgets — the returned promise is
    // there for the first-launch offers, which have to be asked one at a time.
    onInstallHooks: () => void applyClaudeHooks(false),
    onRemoveHooks: () => void applyClaudeHooks(true),
    onInstallCodexHooks: () => void applyCodexHooks(false),
    onRemoveCodexHooks: () => void applyCodexHooks(true),
    // Read while the menu is being built, so the line is never a launch behind:
    // the owner may have installed the hooks in the meantime, from the item
    // directly below it.
    hookStatus,
    onInjectUsage: (pct, weeklyPct) => {
      // Through `publishSnapshot`, so the panel, the tray and the dog all see
      // the same fake poll — see `injectedSnapshot`.
      publishSnapshot(
        injectedSnapshot(pct, Date.now(), poller?.last()?.intervalMs ?? 180_000, weeklyPct ?? null)
      );
    },
    onSimulateHook: (event) => behaviour?.onHook(event),
    onRenewClaudeNow: () => void claudeRenew?.renewNow(),
    onToggleFullscreen: () => behaviour?.setFullscreen(behaviour.isFullscreen() !== true),
    isFullscreen: () => behaviour?.isFullscreen() ?? false
  });

  fullscreenWatch = createFullscreenWatch({
    onChange: (fullscreen) => behaviour?.setFullscreen(fullscreen),
    enabled: () => store?.get('sleepInFullscreen') !== false,
    // Fullscreen is per display: a film on the external monitor must not put a
    // dog sitting on the laptop screen to sleep. Read on every poll rather than
    // captured, because the owner can drag him between displays.
    dogDisplay: () => {
      const win = overlay?.win;
      if (win === undefined || win.isDestroyed()) return null;
      return screen.getDisplayMatching(win.getBounds()).bounds;
    }
  });
  fullscreenWatch.start();

  /*
   * The global shortcut, after the tray exists — `setHideWhenIdle` rebuilds the
   * menu, and a keypress arriving before there is one to rebuild would be a
   * crash in a callback nobody is watching.
   *
   * A failure here is not reported to the owner and does not stop anything: the
   * menu's `Shortcut ▸` submenu shows what happened, and `apply` never throws.
   */
  shortcut = createShortcutBinder({
    // The keys toggle the *mode*, the same thing the checkbox does — not "hide
    // him now". Turning the mode on with nothing to say hides him at once
    // anyway (see `Behaviour.setHideWhenIdle`), so the immediate effect is what
    // the owner expects from a hide key, and the menu's checkmark cannot get
    // out of step with what the keys did.
    onToggle: () => setHideWhenIdle(store?.get('hideWhenIdle') !== true)
  });
  shortcut.apply(readHideShortcut(store));
  trayHandle.refresh();

  // After the tray, which is where every answer it produces is shown.
  startUpdateChecks();

  void startHooks();

  // The hook-free source of Claude Code's state: its own session registry,
  // which needs no install, no trust step and no port (see `claude-sessions.ts`).
  // The hook server above stays regardless — it is the only source of Codex
  // events — and no dedupe is wired between the two: `Behaviour.onHook` already
  // replaces per kind *and* source, so the same fact arriving twice is the same
  // bubble written twice.
  claudeSessions = createClaudeSessions({
    onEvent: onHookEvent,
    // The renewal child is a real `claude` process, and a `claude` process is
    // what the registry sweep looks for — without this it would register as a
    // session and Walder would announce his own housekeeping as the owner
    // starting work. Not ours, *and* alive.
    isAlive: (pid) => !(claudeRenew?.ownsPid(pid) ?? false) && processIsAlive(pid)
  });
  claudeSessions.start();

  registerIpcBridge();

  // Last, so the first snapshot has somewhere to go.
  poller.start();

  // Numbers from before a sleep are exactly the stale case the schedule header
  // marks: poll on the wake, not at the due time the machine slept through.
  powerMonitor.on('resume', () => poller?.pokeNow());

  // And after the poll has been asked for, so that the second beat's "is there
  // a login?" question is answered by a poller that has already had its chance.
  startIntro();
}

/** Register the IPC table against the current windows. */
function registerIpcBridge(): void {
  if (overlay === null || store === null || sheet === null) return;
  registerIpc({
    overlay,
    store,
    sheet,
    getTray: () => trayHandle?.tray ?? null,
    getPanel: () => panel,
    getUsage: () => poller?.last() ?? null,
    getSessions: () => liveSessions(sessions, Date.now()),
    onRefreshNow: () => poller?.refreshNow() ?? false,
    onLogin: (service) => logins?.openLogin(service),
    onLogout: (service) => {
      // Same two steps as the tray's Log out, for the same reason — see there.
      void logins?.logout(service).then(() => {
        poller?.forget(service);
        poller?.pokeNow();
      });
    },
    onRendererLoad: () => behaviour?.resync(),
    onPet: () => {
      behaviour?.onPet();
      // After the dismissal, never before it: the beat queues a notice, and
      // `onPet` is what clears the screen for it to be promoted into.
      nextIntroBeat();
    }
  });
}

/** Rebuild the overlay if it was somehow destroyed; the tray and store persist. */
function ensureOverlay(): void {
  if (store === null || sheet === null) return;
  if (overlay !== null && !overlay.win.isDestroyed()) return;

  unregisterIpc();
  overlay = createOverlay(store, initialScale(store), sheetBoxes(sheet));
  // A fresh window wants to be shown, and its `ready-to-show` would put a
  // deliberately hidden dog back on screen — with nothing to say and no way for
  // the owner to explain it. Said before that event can fire.
  if (behaviour?.isHidden() === true) overlay.setVisible(false);
  // Same reason, same moment: a rebuilt window starts with `still: false`, and
  // an owner who asked for a still dog would get an animated one back.
  overlay.setStill(store.get('stillMode') === true);
  // registerIpc pushes the sheet itself once the new page finishes loading. The
  // tray needs no rebuild: it reads `overlay` through the closure above.
  registerIpcBridge();
  vlog('overlay rebuilt');
}

/**
 * `npm run sprites`: be the animation gallery instead of the mascot.
 *
 * A wholesale replacement, not an extra window. None of the machinery in
 * `start()` runs — no tray, no store write, no provider poll, no hook listener —
 * because the owner is reviewing artwork, and a review session that silently
 * polled his account or moved his dog would be a surprise. See
 * `gallery-window.ts`.
 */
function startGallery(): void {
  const win = openGallery();
  // An ordinary window, so ordinary window rules: closing it ends the run. This
  // is the exact opposite of the mascot's "never quit on your own", which is why
  // it is wired here and not in the shared handler below.
  win.on('closed', () => app.quit());
}

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Nothing to focus — the overlay deliberately never takes focus. Just make
    // sure it is actually there.
    //
    // And *not* if presence says he is hidden: with the hide-when-idle mode on,
    // launching Walder again (from the Dock, from Spotlight, by double-clicking
    // the app) used to un-hide a dog who had nothing to say, and nothing then
    // took him back down until the next bubble came and went.
    ensureOverlay();
    if (behaviour?.isHidden() === true) return;
    if (overlay !== null && !overlay.win.isVisible()) overlay.win.showInactive();
  });

  void app.whenReady().then(() => {
    // First, so that anything below which fails has somewhere to say so.
    // `app.getPath` is only meaningful after `whenReady`.
    startFileLog();

    // Before *any* window, mascot or gallery. It used to live inside `start()`,
    // which the gallery run returns before ever reaching — so the one window in
    // this app that renders a whole sheet of artwork was the one running on
    // Electron's permissive defaults. Nothing about a gallery needs a camera
    // either, and "no window has permissions" is a rule that is only worth
    // having if it has no exceptions.
    denyAllPermissions();

    if (isGallery) {
      // No `dock.hide()`: the gallery is a normal window and wants its icon.
      startGallery();
      return;
    }

    // No dock icon: Walder lives in the menu bar and on top of other windows.
    // Must run after ready and before the first window, or macOS briefly
    // bounces an icon into the dock.
    app.dock?.hide();

    start();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) ensureOverlay();
    });
  });

  app.on('before-quit', () => {
    // Stop every timer and the listener before the windows go: a poll, a tick or
    // a hook that lands mid-teardown would try to send to a destroyed
    // webContents.
    poller?.stop();
    behaviour?.stop();
    updates?.stop();
    fullscreenWatch?.stop();
    claudeSessions?.stop();
    claudeRenew?.stop();
    void hookServer?.close();
    logins?.closeAll();
    panel?.destroy();
  });

  /**
   * Let go of the global shortcut.
   *
   * `will-quit` rather than `before-quit`, because that is the event Electron's
   * own documentation for `globalShortcut` names — it fires after the windows
   * are gone and is the last point at which the process is still ours. Electron
   * releases hotkeys on exit anyway; doing it explicitly means a shortcut is
   * never held by a process that is halfway out of existence.
   */
  app.on('will-quit', () => {
    shortcut?.dispose();
  });

  /**
   * Never auto-quit. Electron's default is to quit once the last window closes;
   * registering a listener that does nothing suppresses that on every platform,
   * so the app survives even if the overlay is momentarily gone. Quit is the
   * tray item, and nothing else.
   *
   * This matters more now than in M3: a login window closing is the *normal*
   * end of a login, and it must not take the app with it.
   */
  app.on('window-all-closed', () => {
    vlog('all windows closed; staying alive (quit is a tray action)');
  });
}

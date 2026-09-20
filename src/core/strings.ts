/**
 * Every owner-facing sentence Walder produces, in one flat table.
 *
 * Groundwork for localisation — English only for now. Nothing reads the host's
 * locale to pick a table; there is exactly one, and `t()` is the only way
 * anything in `src/core` or `src/main` turns a key into words. A second
 * language is a second table and a lookup by locale, not a hunt through every
 * file that used to hold a literal.
 *
 * Dotted, flat keys (`'bubble.hookDone'`) rather than nested objects: a nested
 * `STRINGS.bubble.hookDone` reads the same but makes `keyof` recursive and
 * every call site's key a property-access chain instead of one string a
 * translator could grep for.
 *
 * ponytail: no plurals, no gender, no ICU MessageFormat — `{name}` is a plain
 * substitution and nothing here counts or genders anything. The ceiling is
 * real (a language with plural rules would need one), and the upgrade path is
 * one formatter behind `t`, not a rewrite of every call site: swap the body of
 * `t` for something that dispatches to `Intl.PluralRules` when a template asks
 * for it, and every caller is unchanged.
 */

export const STRINGS = {
  // src/core/bubble.ts
  'bubble.sourceLabel.claude': 'Claude',
  'bubble.sourceLabel.codex': 'Codex',
  'bubble.hookDone': '{tool} done',
  'bubble.hookWaiting': '{tool} waiting',
  'bubble.hooksMissing': 'Install Claude Code hooks',
  'bubble.hooksStale': 'Reinstall Claude Code hooks',
  'bubble.codexHooksMissing': 'Install Codex hooks',
  'bubble.codexHooksStale': 'Reinstall Codex hooks',
  'bubble.claudeLoggedOut': 'Claude Code logged out',
  'bubble.introHello': 'Hello. Click the bone in your menu bar.',
  'bubble.introLogin': 'Accounts ▸ Claude ▸ Log in',
  'bubble.sleep': '…zzz',
  'bubble.ellipsis': '…',
  'bubble.update': 'Walder {version} is out',
  'bubble.barkLabel.claudeFiveHour': 'Claude 5h',
  'bubble.barkLabel.claudeSevenDay': 'Claude 7-day',
  'bubble.barkLabel.claudeCredits': 'Claude credits',
  'bubble.barkLabel.modelWeekly': '{model} weekly',
  'bubble.barkLabel.codexFiveHour': 'Codex 5h',
  'bubble.nudge': '{label}: {pct}% used',

  // src/core/card-layout.ts
  'card.title': 'WALDER',
  'card.notCheckedYet': 'not checked yet',
  'card.noLimitsReported': 'no limits reported',
  'card.sourceLine': '{title}  ·  {via}',
  'card.via': 'via {label}',
  'card.estimatedSuffix': '{text} (est.)',
  'card.status.checking': '{name}: checking…',
  'card.status.ok': '{name}: ok via {via}',
  'card.status.authNeeded': '{name}: login needed',
  'card.status.endpointChanged': '{name}: endpoint changed — update Walder',
  'card.status.rateLimited': '{name}: rate limited, retrying',
  'card.status.error': '{name}: could not be reached — check the connection',
  'card.status.unavailable': '{name}: not logged in',
  'card.status.noLimitsReported': '{name}: no limits reported',
  'card.sessionsTitle': 'SESSIONS',
  'card.sessionRow': '{tool} · {cwd} · {state}',
  // The same row for a session whose directory nobody told us. The middle
  // segment is dropped rather than filled with a placeholder, because
  // `Claude · ? · waiting` only invites the owner to wonder what the `?` means.
  'card.sessionRowNoCwd': '{tool} · {state}',
  'card.session.working': 'working',
  'card.session.waiting': 'waiting',
  'card.session.done': 'done',

  // src/core/a11y-text.ts
  'a11y.mood.happy': 'happy',
  'a11y.mood.neutral': 'fine',
  'a11y.mood.worried': 'worried',
  'a11y.mood.exhausted': 'exhausted',
  'a11y.mood.out': 'out of Claude time',
  'a11y.mood.confused': 'confused, no number to show',
  'a11y.dogMood': 'Walder, {mood}.',
  'a11y.dogPct': ' Claude 5-hour {pct}% used.',
  'a11y.row': '{label}, {value}',
  'a11y.sharedPool': ', shared pool',

  // src/core/update-check.ts (updateMenuLine only)
  'update.available': 'Update available: {version} — Download…',
  'update.cooldown': 'Check for updates now (wait {seconds}s)',
  'update.failed': 'Last check failed ({time})',
  'update.check': 'Check for updates now',

  // src/core/services.ts (SERVICE_INFO)
  'services.claude.label': 'Claude',
  'services.claude.title': 'CLAUDE',
  'services.claude.noLogin': 'no Claude login yet — use Accounts ▸ Claude ▸ Log in…',
  'services.chatgpt.label': 'ChatGPT',
  'services.chatgpt.title': 'CHATGPT',
  'services.chatgpt.noLogin': 'no ChatGPT login yet — use Accounts ▸ ChatGPT ▸ Log in…',
  'services.cursor.label': 'Cursor',
  'services.cursor.title': 'CURSOR',
  // Not "use Accounts ▸ Cursor ▸ Log in…" like the two above, because there is
  // no such item to point at: Cursor is read from the editor's own stored token
  // and Walder never opens a cursor.com login (`LOGIN` in `services-main.ts`).
  'services.cursor.noLogin': 'no Cursor login yet — sign in inside the Cursor editor',

  // src/core/shortcuts.ts (caveats only — accelerators are not prose)
  'shortcuts.caveatAccents': 'may clash with typing accents',

  // src/main/tray.ts
  'tray.large': 'Large',
  'tray.medium': 'Medium',
  'tray.small': 'Small',
  'tray.resetStyle.clock': 'Clock time',
  'tray.resetStyle.countdown': 'Countdown',
  'tray.barkPreset.quiet': 'Quiet (95 %, 100 %)',
  'tray.barkPreset.normal': 'Normal',
  'tray.barkPreset.chatty': 'Chatty (every 10 %)',
  'tray.toolClaude': 'Claude',
  'tray.toolCodex': 'Codex',
  'tray.toolClaudeCode': 'Claude Code',
  'tray.refreshNow': 'Refresh now',
  'tray.refreshNowCooldown': 'Refresh now (wait {seconds}s)',
  'tray.usageUnknown': 'Claude 5-hour: ?',
  'tray.usageLine': 'Claude 5-hour: {pct} used',
  'tray.hookName': '{tool} hooks',
  'tray.hookNoListener': "{name}: Walder's listener is not running",
  'tray.hookNotInstalled': '{name}: not installed',
  'tray.hookInstalled': '{name}: installed (port {port})',
  'tray.hookPortMismatch': '{name}: installed for port {installedPort}, Walder is on {boundPort}',
  'tray.logIn': 'Log in…',
  'tray.logOut': 'Log out',
  'tray.shortcutCaveat': '{label} — {caveat}',
  'tray.shortcutCustom': 'Custom: {label}',
  'tray.verboseLog': 'Verbose log',
  'tray.logFileNone': 'Log file: none',
  'tray.revealLogFile': 'Reveal log file',
  'tray.logPathLine': '  Log: {path}',
  'tray.injectUsage': 'Inject usage',
  'tray.noData': 'no data',
  'tray.simulateHook': 'Simulate hook',
  'tray.hookKind.done': 'done',
  'tray.hookKind.waiting': 'waiting',
  'tray.hookKind.prompt': 'prompt',
  'tray.toggleFullscreen': 'Toggle fullscreen mode',
  'tray.renewClaudeNow': 'Renew Claude Code login now',
  'tray.walder': 'Walder',
  'tray.size': 'Size',
  'tray.cardSize': 'Card size',
  'tray.resetTimes': 'Reset times',
  'tray.showInOverview': 'Show in overview',
  'tray.barks': 'Barks',
  'tray.primaryService': 'Primary service',
  'tray.colour': 'Colour',
  'tray.launchAtLogin': 'Launch at login',
  'tray.launchAtLoginPackagedOnly': 'Launch at login (packaged app only)',
  'tray.sleepDuringFullscreen': 'Sleep during fullscreen video',
  'tray.stillMode': 'Still mode (no animation)',
  'tray.hideWhenIdle': 'Hide when idle',
  'tray.shortcut': 'Shortcut',
  'tray.notifyWhenHidden': 'Notify when hidden',
  'tray.installClaudeHooks': 'Install Claude Code hooks…',
  'tray.removeClaudeHooks': 'Remove Claude Code hooks…',
  'tray.installCodexHooks': 'Install Codex hooks…',
  'tray.removeCodexHooks': 'Remove Codex hooks…',
  'tray.resetPosition': 'Reset position',
  'tray.forceInteractive': 'Force interactive (debug)',
  'tray.developer': 'Developer',
  'tray.reportBug': 'Report a bug…',
  'tray.quit': 'Quit',
  'tray.accounts': 'Accounts',
  'tray.checkForUpdatesAutomatically': 'Check for updates automatically'
} as const;

export type StringKey = keyof typeof STRINGS;

/**
 * Look up `key` and substitute `{name}` placeholders from `params`.
 *
 * One `replace`, as asked: a placeholder with no matching param is left
 * exactly as written rather than becoming `undefined` or throwing — a missing
 * param is a programming mistake worth seeing on screen (`{tool}` staring back
 * from a menu is a bug report waiting to happen), not a reason to crash the
 * one file that draws Walder's whole interface.
 */
export function t(key: StringKey, params?: Readonly<Record<string, string | number>>): string {
  const template = STRINGS[key];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
}

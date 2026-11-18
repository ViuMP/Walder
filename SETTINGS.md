# Settings

Every setting Walder has. They are stored in `walder.json`:

- macOS: `~/Library/Application Support/walder/walder.json`
- Windows: `%APPDATA%\walder\walder.json`

Change them in the Walder window (tray menu ▸ **Overview and settings…**): Coat, Size and Card
size on the **Overview** page, where they are previewed and saved with **Apply**, every other setting on
its group's page in the list on the left, saved as soon as it is changed. Size and Hide when idle
are also in the tray menu. Every change is checked before it is saved, and a
hand-edited value that is not valid falls back to its default.

The list is defined once in [`src/core/settings-spec.ts`](src/core/settings-spec.ts). The
store takes its defaults from it, the window draws one control per entry, and
`test/settings.test.ts` fails if a key is missing here.

## User settings

| Key | In the window | Default | Allowed values | Takes effect |
| --- | --- | --- | --- | --- |
| `size` | Overview ▸ Size | Medium | Small, Medium, Large | On Apply |
| `palette` | Overview ▸ Model and Coat | Golden | The coats in the sprite sheet | On Apply |
| `cardSize` | Overview ▸ Card size | Large | Large, Medium, Small (kept but not used while `cardLayout` is Advanced, which is always Large) | On Apply |
| `resetStyle` | Appearance ▸ Reset times | Clock time | Clock time, Countdown | At once |
| `stillMode` | Appearance ▸ Still mode (no animation) | Off | On, Off | At once |
| `theme` | Appearance ▸ Theme | Automatic | Automatic (follows the system), Light, Dark | At once (the Walder window only) |
| `barkPreset` | Alerts ▸ Barks | Normal | Quiet (95 %, 100 %), Normal, Chatty (every 10 %) | At once |
| `barkSound` | Alerts ▸ Bark sound | Off | On, Off | At once |
| `primaryService` | Alerts ▸ Primary service | Claude | Claude, ChatGPT, Cursor, Copilot, Gemini | At once |
| `notifyWhenHidden` | Alerts ▸ Notify when hidden | Off | On, Off | At once |
| `hiddenServices` | Visibility ▸ Show in overview | All shown | Any of the five services hidden | At once |
| `cardLayout` | Visibility ▸ Hover card | Standard layout | Standard, or Advanced customization: always the Large card, up to 200 card lines in any order, each on or off | On Apply |
| `hideWhenIdle` | Visibility ▸ Hide when idle | Off | On, Off | At once |
| `hideShortcut` | Visibility ▸ Shortcut | Control+Command+W (macOS), Alt+Shift+W (Windows) | At least one modifier and one key, e.g. `Alt+Shift+H` | At once |
| `sleepInFullscreen` | Visibility ▸ Sleep during fullscreen video | On | On, Off | At once |
| `pollIntervalSec` | Usage ▸ Refresh interval | 180 | Whole seconds, 180 to 86400 | Next check |
| `codexCreditPrice` | Usage ▸ Codex credit price | 0.04 USD | Off, or an amount above 0 and a three-letter currency code | After restart |
| `language` | App ▸ Language | System | System (the first of your computer's preferred languages Walder has, else English), English, Dansk, 简体中文, हिन्दी, Español, العربية | After restart |
| `launchAtLogin` | App ▸ Launch at login | Off | On, Off (installed app only) | At once |
| `checkForUpdates` | App ▸ Check for updates automatically | On | On, Off | Next check |
| `hookPort` | App ▸ Hook port | 47811 | 1024 to 65535 | After restart, then install the hooks again |
| `verboseLog` | Advanced ▸ Verbose log | Off | On, Off (locked on while `WALDER_LOG=1`) | At once |
| `forceInteractive` | Advanced ▸ Force interactive (debug) | Off | On, Off | At once |

Notes:

- `pollIntervalSec` used to accept 30 in the file, but Walder never checked more often than
  every 180 seconds. The window now offers only what the app does.
- `hookPort` is written into the hook commands when you install the Claude Code or Codex
  hooks. After changing it, restart Walder and use **Install … hooks** again, or the
  hooks keep reporting to the old port.
- `codexCreditPrice` is read when the hover card loads, so a change shows after a restart.
- `cardLayout` lists line ids (`title`, `service:claude`, `row:claude.five_hour`,
  `reset:claude.five_hour`, `sessions`, `updated`). A line Walder has not seen before is
  drawn shown, right after the line before it in the standard order (a new reset under
  its row, and off when that row is listed off). With Advanced customization off the card is the
  standard one whatever the list holds.
- `language` is read once, as Walder starts, so a change shows after a restart (tray ▸
  **Restart**). Language names are always written in their own language, so you can find yours
  from any of them. See [docs/accessibility.md](docs/accessibility.md#language) for what stays English.
- `launchAtLogin` follows the operating system in the installed app: removing Walder from
  your login items there unticks it here.

## Not settings: app state

These keys are also in `walder.json`. Walder writes them itself, and neither the window
nor the tray can change them: `schemaVersion`, `positions`, `hookPortActual`,
`updateNotifiedVersion`, `chatgptDiscoveredEndpoints`, `claudeDiscoveredEndpoints` (no
longer used; emptied at startup), `lastSnapshot`, `pollSchedules`, `behaviourMemory`,
`hiddenBuckets` (replaced by `hiddenServices` in 0.2.7), `hooksOffered`, `introduced`.

## Environment variables

Set these before starting Walder. They are for development and are not saved.

| Variable | What it does |
| --- | --- |
| `WALDER_LOG=1` | Turns the verbose log on for this run. |
| `WALDER_DEV=1` | Shows the **Developer** menu (fake usage and hook events) in an installed build. |
| `WALDER_DEBUG=1` | Draws the hit outline around the dog. |
| `WALDER_GALLERY=1` | Opens the sprite gallery instead of the app (`npm run sprites` sets it). |
| `WALDER_DUMP_USAGE_SHAPE=1` | Development builds only: writes the shape of each usage reply to the log. |
| `CODEX_HOME` | Codex's own setting. Walder uses it to find Codex's hooks, login and sessions. |
| `ELECTRON_RENDERER_URL` | Set by `npm run dev`. Ignored by the installed app. |

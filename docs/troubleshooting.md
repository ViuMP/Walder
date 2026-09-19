# Troubleshooting

What to do when something is wrong, and the updating and uninstalling steps.
The short version is in the [README](../README.md).

## If macOS says Walder is **damaged**

If the message is *"Walder is damaged and can't be opened. You should move it to
the Trash"*, you have **0.2.2 or older**. **Open Anyway will not appear in System
Settings** — that dialog has no such button.

This is the one to tell apart from the ordinary block in step 3 of
[Installing on a Mac](../README.md#installing-on-a-mac), and the wording
is what separates them: *damaged* is the broken case, while *"Apple could not
verify…"* or *unidentified developer* is the normal one that **Open Anyway**
clears. Both dialogs offer to move the app to the Trash, and in neither case is
that what you want.

It is not actually damaged, and the download is not corrupt: those
builds shipped a bundle whose code signature does not verify, and macOS reports a
quarantined app in that state as damaged rather than as untrusted.

**Fixed in 0.2.3.** If you can, install that instead and the four steps in the
README are the whole job.

To run an older build anyway, one command in Terminal removes the quarantine flag
the download added:

```bash
xattr -dr com.apple.quarantine /Applications/Walder.app
```

Then open Walder normally. One time only. **Only run this on software you
actually trust** — it is the same decision **Open Anyway** represents, taken a
different way.

## When something is wrong

| Problem | What to do |
| --- | --- |
| You cannot find the dog, or he is on a monitor you have unplugged | Menu ▸ **Reset position** — he jumps back to the bottom-right of your main screen |
| Your clicks near the dog go to the wrong place | Menu ▸ tick **Force interactive (debug)**. His whole square then takes clicks. Untick it to go back |
| The card says **login needed** or **not logged in** | Menu ▸ **Accounts ▸ Log in…** for that service. Use **Log out** first if a login has gone stale |
| The card says **endpoint changed** | The service moved something we read. Nothing you can fix; the other numbers still work |
| Numbers look old, or nothing has updated | Menu ▸ **Refresh now**. It will not run more than once a minute — the item says how long to wait |
| The ears never go up when Claude Code finishes | The line above **Install Claude Code hooks…** in the menu says whether they are installed and for which port. Run the item again (the port can change if something else took 47811), then restart Claude Code |
| The ears never go up when Codex finishes, and the menu says the hooks *are* installed | You have not trusted them yet. Run `codex` in a terminal, type `/hooks`, and trust Walder's three entries — Codex skips an untrusted hook without saying so |
| He is asleep and there is no fullscreen video | Untick **Sleep during fullscreen video**, which wakes him immediately |
| The dog is gone, and nothing is fullscreen | **Hide when idle** is probably ticked — untick it (or press the shortcut) and he comes straight back. The menu's **Claude 5-hour** line at the top only appears while that mode is on, so it tells you at a glance |
| The hide shortcut does nothing | Open **Shortcut ▸**. If the line at the bottom says the keys are already used by another app, quit that app or pick a different combination — **Shift+F9** and **Ctrl+Shift+F12** are the safest. On Windows, Alt+Shift is also the keyboard-language switch |
| Something else is wrong | Menu ▸ **Developer ▸ Verbose log**, reproduce the problem, then **Report a bug…** (see [Privacy](privacy.md#reporting-a-bug)) |

**The verbose log.** Ticking **Developer ▸ Verbose log** turns on a detailed log
file. Warnings are always written, whether or not it is ticked; the tick adds
the detail. It rotates at 1 MB and keeps three files, so it cannot fill a disk.

- Mac: `~/Library/Logs/walder/walder.log`
- Windows: `%APPDATA%\walder\logs\walder.log` (untested — the menu prints the
  real path, and that is the one to trust)

**Developer ▸ Reveal log file** opens the folder with the file selected, ready to
drag into a bug report. The full path is printed on the line underneath it, so
you can also read it off the screen instead of typing it out.

Logins and tokens are removed from anything written to that file — see
[Privacy](privacy.md).

## Updating

**Walder tells you when there is a new version.** He checks about every six
hours, and when there is one:

- the menu's bottom item reads **Update available: 0.1.3 — Download…**, which
  opens the download page in your browser;
- and the dog says it once — a small `Walder 0.1.3 is out` bubble. Once per version,
  not once per check.

You can also ask at any time: **Check for updates now**, at the bottom of the
menu. It will not run more often than once a minute, and the item says so.

**A manual check always answers.** If there is nothing newer, the dog says
`You're up to date` — a bubble like any other, which goes when you click him.
You pressed something, so something has to happen; a button that produces no
visible result reads as a broken one. The automatic six-hourly checks stay
**silent** when there is nothing to report: those are Walder's idea rather than
yours, and a bubble four times a day saying nothing has changed is nagging.

**Nothing installs itself.** Walder does not download anything and never
replaces itself — it only tells you and opens the page. You install the new
version the same way as the first one: quit Walder from the menu, then drag the
new **Walder.app** into Applications (Mac), or run the new installer (Windows).

**Why not automatic?** Walder is not signed with an Apple developer
certificate, so *every* new copy has to be let through by hand in **System
Settings ▸ Privacy & Security ▸ Open Anyway**. An app that quietly replaced
itself would leave you with a Walder macOS refuses to open and no explanation.

Your settings, position, size, colour and logins are kept — they live outside
the app itself.

If you would rather not be told, untick **Check for updates automatically** at
the bottom of the menu. Walder then makes no request of its own — and
**Check for updates now** is still there for the day you want to know.

## Uninstalling

**If you installed the hooks, take them out first:** menu ▸ **Remove Claude Code
hooks…** and **Remove Codex hooks…**. Each asks first, naming the file it is
about to change, then strips Walder's three entries and leaves everything else in
that file untouched. A dated copy is saved beside it either way.

If for some reason that fails, you can do it by hand. Open the file in a text
editor and delete the entries whose `command` line contains `walder-hook`:

- `~/.claude/settings.json` — one each under `Stop`, `Notification` and
  `UserPromptSubmit`.
- `~/.codex/hooks.json` — one each under `Stop`, `PermissionRequest` and
  `UserPromptSubmit`. Nothing of Walder's is ever in `~/.codex/config.toml`.

There is also a dated copy of each file from before Walder first touched it,
named `settings.json.walder-backup-…` / `hooks.json.walder-backup-…`, in the same
folder.

Then:

- **Mac:** **Quit** from the menu, then drag **Walder.app** to the Trash.
- **Windows** (untested, like everything else on Windows): quit from the tray
  menu, then uninstall through **Settings ▸ Apps** (or Add/Remove Programs) as
  usual.

Your settings file is left behind and does no harm. If you want it gone too:
`~/Library/Application Support/walder/` on a Mac, `%APPDATA%\walder\` on
Windows.


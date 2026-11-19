# Privacy

The long version of the [README](../README.md)'s Privacy table: what Walder
reads, what he does on your behalf, what goes in the log, and every field a bug
report can carry.

## At a glance

Everything Walder reads is already on your own machine. Logins and tokens are
read at the moment a check is made and held in memory only.

| What Walder reads | Where | How | What he never does |
| --- | --- | --- | --- |
| Your **Claude Code** login token | The macOS keychain item `Claude Code-credentials`; on other systems `~/.claude/.credentials.json` | Read with `security find-generic-password` when a check gets as far as the Claude Code login, which happens only if no claude.ai session answered; on a 401 it is read once more, because Claude Code can leave a stale copy beside the live one. Then sent as a bearer token to `api.anthropic.com` | Never reads or spends your refresh token, never writes the token to the settings file or the log |
| Your **claude.ai** session | Walder's own browser session, created by **Accounts ▸ Claude ▸ Log in…** | The cookies ride along with the two usage requests to `claude.ai` (`/api/organizations`, then that organisation's `/usage`). When a Claude poll fails, and while the login window is open, they also ride along with a login check: `/api/organizations` again, then `/api/account` if that is unclear, of which only the status is read. Walder checks only that the `sessionKey` cookie exists — never its value | Never reads your conversations, your name or your billing details; only the organisation id and the usage numbers |
| Your **chatgpt.com** session | The same, from **Accounts ▸ ChatGPT ▸ Log in…** | `chatgpt.com` hands back a short-lived token, which reads the usage and is dropped at the end of that poll. When a ChatGPT poll fails, and while the login window is open, Walder also asks `/api/auth/session` and, if needed, `/backend-api/me`, and checks only whether the `email` has an `@` or the `id` is not an anonymous visitor's (`ua-…`); neither value is kept or logged | Never keeps or logs your name, email or picture, and never sends that token anywhere but back to `chatgpt.com` |
| Your **Codex CLI** login | `auth.json` in `$CODEX_HOME` (normally `~/.codex`) | Read when a check runs; the access token and account id go to `chatgpt.com` | Never writes that file, never keeps the token |
| Your **Cursor** login | The Cursor editor's own `state.vscdb`, opened read-only | Read when a check runs; the bearer token goes to `api2.cursor.sh` and nowhere else | Never writes the editor's files, never opens a Cursor login, never logs the token or the numbers |
| Your **GitHub Copilot** login | The token the GitHub CLI already holds, via `gh auth token` | Read when a check runs; it goes to `api.github.com/copilot_internal/user` and nowhere else | Never logs in for you, never writes `gh`'s config, never refreshes that token, never logs it or the numbers |
| Your **Gemini** limits, while **Antigravity** is running | The IDE's own language server on `127.0.0.1` — found by reading the id, `--csrf_token` argument and listening ports of your own processes named `language_server_macos_arm` (on Windows: your own session's `language_server.exe` processes whose file sits in `…\antigravity\resources\bin\`) | Read when a check runs; the request goes to `127.0.0.1` and nowhere else | Never talks to Google for this, never reads any other process's arguments beyond the name it was started under (on Windows, its name and file path), never logs the token or the numbers |
| **Claude Code's session files** — is it busy, waiting or idle | `~/.claude/sessions` | The `pid`, `status`, `cwd` and `sessionId` of each file, re-read every couple of seconds. The session id is kept in memory only, to tell sessions apart (the row's key, and whose `?` a later event clears) | Never reads anything you typed. The folder is shown only on your own hover card (SESSIONS, Large card), with your home folder shortened to `~`, and is never logged or saved. The session id is never shown, logged or saved |
| **Claude Code and Codex transcripts**, for the Tokens today row | `~/.claude/projects` and `sessions` in `$CODEX_HOME` (normally `~/.codex/sessions`) | Files touched since local midnight are opened and their token counts added up | Never reads a prompt or a reply, and never writes a line of a transcript to the log — only the path, if one cannot be read |
| **Hook events** from Claude Code and Codex, if you installed the hooks | A listener on `127.0.0.1`, normally port 47811 | It accepts one thing — a small JSON `POST` from your own machine — and keeps the event (done, waiting, prompt, or a tool call finishing), which tool sent it, and the session's folder and id for the card's SESSIONS list. The rest is thrown away | Never accepts a connection from another machine, and never writes the message body to the log |
| **Your settings** | `~/Library/Application Support/walder/walder.json`, `%APPDATA%\walder\` on Windows | Plain JSON, written by Walder | Never holds a login, a token or a provider's raw answer — there is no field for one |

Where it talks: `claude.ai`, `api.anthropic.com`, `chatgpt.com`,
`api2.cursor.sh` and `api.github.com` (your Copilot quota, with the GitHub CLI's
token). A service hidden under **Show in overview** makes no requests at all
until you tick it back on; it is then checked straight away. Plus one more request to `api.github.com`:
about a minute after launch, then every six hours (an hour after a check that
failed), to ask which version of Walder is the newest. It carries no token,
account or machine name; its only identifier is a `User-Agent` of
`Walder/<your installed version>`. Unticking **Check for updates automatically**
stops it for good.

No analytics. No telemetry. No account, no server of ours, nothing phoning
home. **Log out** under **Accounts** clears that service's whole stored
session, not only its cookies.

The sections below have the rest: the one thing Walder does
on your behalf (starting `claude` in the background so Claude Code renews its
own login), everything the settings file does keep, what is stripped from the
log, and every field a bug report can carry.

## What Walder reads

Walder reads nine things, all on your own machine:

- Your existing **Claude** login — the claude.ai browser session you created
  through **Accounts**, if there is one; otherwise, or when it fails, the Claude
  Code login.
- Your existing **ChatGPT** login — a chatgpt.com browser session, or the Codex
  CLI login if you have one.
- Your existing **Cursor** login — the bearer token the Cursor editor has
  already stored in its own `state.vscdb`, opened **read-only**. Walder never
  writes to the editor's files, and there is no Cursor login window anywhere in
  the app: signing in to cursor.com from here would create a second, empty
  account rather than reach the one the editor is using. Sign in — and out —
  inside Cursor.
- Your existing **GitHub Copilot** login — and it is not one of ours either:
  Walder asks the GitHub CLI for the token it already holds, by running
  `gh auth token`, and sends it to `api.github.com/copilot_internal/user` to
  read your quota percentages. It never logs in for you, never writes a line of
  `gh`'s config, and never refreshes or rotates that token. There is no Copilot
  login window in the app for the same reason there is no Cursor one: a
  github.com sign-in here would open a session beside the CLI's rather than fix
  it. `gh auth login`, in your own terminal, is the whole remedy — and if the
  account has no Copilot, GitHub says so and Walder shows that instead of a
  number. Neither the token nor the numbers are ever written to the log.
- Your running **Antigravity IDE**, for Gemini — and this one is not a login
  at all. Google's own quota endpoint answers 403 to anything that is not
  Antigravity, but the IDE's quota panel does not ask Google either: it asks a
  language server the IDE runs on your own machine, on `127.0.0.1`. Walder
  asks the same server the same question. To find it, it lists your own
  processes whose command line mentions `language_server_macos_arm`, keeps
  only the ones started under the name `language_server_macos_arm`
  (normally one), and reads for each of those its `--csrf_token` argument and
  listening ports. Not the rest of the process table, nothing of any other
  process beyond the name it was started under, and no process's environment.
  On Windows the same is done by one PowerShell command: it lists processes
  named `language_server.exe`, keeps those in your own Windows session whose
  file is Antigravity's (`…\antigravity\resources\bin\language_server.exe`),
  and only for those reads the command line and listening ports. A
  `language_server.exe` anywhere else has nothing but its name and file path
  looked at. The token goes into one header on
  one loopback request and is never written to the log, the settings file or
  a bug report. There is no
  Gemini login window, because there is nothing for one to sign in to: close
  Antigravity and the Gemini section leaves the card (Accounts says why).
- **Claude Code and Codex hook events**, if you installed those hooks. They
  arrive over a listener that accepts connections only from your own machine.
- **Claude Code's session files** in `~/.claude/sessions`, every couple of
  seconds: the `pid`, `status`, working folder and session id of each file, to
  tell whether a session is busy, waiting or idle. The folder is shown only on
  your own hover card, with your home folder shortened to `~`. Nothing you typed
  is read, and neither the folder nor the id is logged or saved.
- **Claude Code and Codex transcripts** in `~/.claude/projects` and
  `sessions` in `$CODEX_HOME` (normally `~/.codex/sessions`), for the Tokens today row. Files touched since local
  midnight are opened and their token counts added up. No prompt or reply is
  read into the log.
- **The frontmost window**, every two seconds: the size and position of the
  windows of the app in front, that app's name and path, and on Windows the
  window's class name, to tell whether something is fullscreen. Never a window
  title or a web address. The log records that fullscreen began or ended and,
  with Verbose log on, how many windows the app in front has; never which app
  or window, with one exception on Windows: when a system surface (taskbar,
  Start, Search, Alt+Tab, Quick Settings, Widgets) is in front, the Verbose
  log names it from Walder's own fixed list, or gives only the length of a
  class that is not on that list, never text the window supplied.

Where it talks: `claude.ai` and `api.anthropic.com`, `chatgpt.com`,
`api2.cursor.sh` — one `GetCurrentPeriodUsage` call, a bearer `POST` with an
empty message — and `api.github.com`, one `GET copilot_internal/user`, all on
the same cadence: every three minutes by default (**Refresh interval**, Walder
window ▸ Usage, never under 180 s), longer while a service is backed off. A
service you untick under **Show in overview** is not checked at all while it is
off: no usage request and no login check, so a hidden Copilot never runs `gh
auth token` or calls `api.github.com`, and a hidden Gemini never looks for
Antigravity's process. Ticking it back on checks it at once. Gemini is the exception that leaves nothing:
that poll goes to `127.0.0.1` and to no host at all beyond this machine —
**never to Google**. The login windows start on those two sites and then follow
wherever the sign-in leads, your employer's single-sign-on provider included.
They load `https:` pages only and never an address on this machine. The window
has no bridge into Walder, and a page on another site cannot read the claude.ai
or chatgpt.com cookies. With **Verbose log** on, only the host of each hop is logged.

There is one more request to `api.github.com`, and that one is not about your
account at all: about a minute after launch and then **every six hours** (an
hour after a check that failed), to ask which version of Walder is the newest.
Unlike the Copilot call it carries no token — no login, no account, no machine
name, not even which services you use. The one thing it says about you is the
version you have installed, in its `User-Agent` (`Walder/<version>`). Untick
**Check for updates automatically** (Walder window ▸ App) and Walder never asks of its own
accord again. The one exception is you: **Check for updates now** still asks,
because you clicked it.

Nowhere else.

One thing Walder does on your behalf, and only when he has to: when your Claude
Code login is about to lapse and he has no other way to read your usage, he
starts `claude` in the background, once, with an empty prompt — so that Claude
Code renews its own login, the way it does every time you open it. No
conversation, no transcript, nothing saved. Walder never reads or sends your
refresh token, and he never does this more than once per expiry.

Logins and tokens are read at the moment a check is made and held in memory
only. They are never written to the settings file, never written to the log
(anything that looks like one is masked), and never sent anywhere except back to
the service they belong to. The settings file keeps your position per display,
his size, the card size, his colour, which service is primary, how often Walder
polls, the hook port it prefers and the one it actually got, launch at login,
sleep during fullscreen, hide when idle and its shortcut, whether the automatic
update check is on, the last version you were told about, the Codex credit
price, which services you have hidden, Reset times, Still mode, Theme, Barks
level, Bark sound, Notify when hidden, the hover-card layout (Advanced
customization and its line order), Verbose log, Force interactive, each
service's poll backoff, what he has already barked about, the once-only flags for the first-run
introduction and the two hook offers, the last percentages (never a login), and
the request paths — path only, never a query string — that Walder watched go by
while you logged in, which it replays only to that same site.

No analytics. No telemetry. No account, no server of ours, nothing phoning home.

**Log out** under **Accounts** clears that service's whole stored session, not
only its cookies.

## What goes in the log

Logins and tokens are removed from anything written to the log file. Warnings
are always written; **Verbose log** (Walder window ▸ Advanced) adds the detail. Where the file
is and how it rotates is in [Troubleshooting](troubleshooting.md).

## Reporting a bug

Menu ▸ **Report a bug…** opens a **draft** issue in your browser, on Walder's
public tracker, with the boring half already filled in. Three things are worth
knowing about it:

- **Nothing is sent until you press Submit on GitHub.** Walder has no server and
  does not post anything anywhere. The menu item opens a page; you read it, edit
  it, and send it — or close the tab, and nothing has happened.
- **You can see everything it says**, because it is in the page in front of you.
  The same block is also copied to your clipboard, so you can paste it if your
  browser loses it or you would rather file the report from another machine.
- **Please attach `walder.log`** — Menu ▸ **Reveal log file** shows
  it in Finder (File Explorer on Windows), and you can drag it straight into the issue. If you can
  reproduce the problem, turn on **Verbose log** (Walder window ▸ Advanced) first, do it again, and
  send the file afterwards.

The report contains: Walder's version, your OS and its version, the processor
type, the Electron version, your screen sizes, your Walder settings (size, card
size, with "(advanced layout, drawn Large)" when Advanced customization is on,
the two switches, which service is primary), what the last update check
found, whether Walder thought a fullscreen app was in front, and where the log
file is.

It does **not** contain your account, your email, any login or token, or any of
your usage numbers — there is no way for it to: the report can only carry the
fields listed above, and none of them is a percentage.

# Walder

[![CI](https://github.com/ViuMP/Walder/actions/workflows/ci.yml/badge.svg)](https://github.com/ViuMP/Walder/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![Walder, a golden long-haired miniature dachshund](docs/images/walder-hero.png)

Walder is a small pixel-art dog — a golden long-haired miniature dachshund — who
sits on your desktop and keeps an eye on how much of your AI subscriptions you
have left.

He has no window and no Dock icon. He sits in a corner of the screen, on top of
whatever you are doing, and gets on with four jobs:

- **His face tells you the number without you asking.** He is cheerful when your
  Claude 5-hour window is barely touched, and increasingly worn out as it fills.
- **He barks** — a little speech bubble — when you cross 80, 85, 90, 95 and 100 %.
- **He gets out of the way.** He curls up and sleeps tiny while you watch
  something fullscreen.
- **He can stay out of sight altogether.** Turn on **Hide when idle** and he is
  not on your screen at all until he has something to say — then he appears,
  says it, and leaves again a few seconds later.

Hover over him and a small card appears with the actual percentages. Click him
to pet him. Drag him anywhere. Right-click him for the menu. He also perks his
ears up when Claude Code finishes a reply, if you turn that part on.

macOS and Windows. Built with Electron.

## Get Walder

The latest macOS `.dmg` and Windows `.exe` are on the releases page:
**https://github.com/ViuMP/walder-releases/releases/latest**

On a Mac the first launch is blocked, because the app is not signed with an
Apple developer certificate — **Installing on a Mac** below is the way past it,
and it is a one-time thing.

![Walder in the corner of the screen](docs/images/walder-dog.png)

Hover over him and the card appears — every window the two services report,
with the actual percentages and when each one resets:

![The hover card: Claude 5-hour and 7-day windows, tokens today, the Codex windows and credits](docs/images/walder-card.png)

## What you need

**macOS: Apple Silicon only.** There is no Intel build — the dmg is arm64, and
that is the only thing `electron-builder.yml` is asked to produce. On the OS
version: macOS 12 or newer is what Electron 44 supports, and the developers run
it on macOS 15. Nobody has tried it on anything in between, so that is a floor
from the runtime rather than a floor anyone has tested.

**Windows: 10 or 11, 64-bit.** Untested, as follows.

**A note on Windows before you start.** Walder is built and tested on a Mac.
The Windows installer is produced on that Mac, or by a GitHub Actions runner,
and **has never been run by the developers** — not the installer, not the tray icon, not the fullscreen
detection. It is expected to work; nobody has watched it. If you are the first,
please report what you actually see, including the parts that go fine.

## Installing on a Mac

1. Open the `.dmg` file.
2. Drag **Walder.app** into your **Applications** folder.
3. Open Applications and **double-click Walder**. macOS will block it — that is
   expected, and the next step is how you get past it. On macOS 15 and newer the
   block reads *"Apple could not verify 'Walder' is free of malware that may harm
   your Mac or compromise your privacy"*; on older versions it names an
   unidentified developer instead. Either way it is the same refusal.

   **Click "Done", not "Move to Trash".** Move to Trash is the highlighted button
   and it deletes the app you just installed. Done dismisses the block and leaves
   Walder in place for the next step.
4. Go to **System Settings ▸ Privacy & Security**, scroll down to the message
   about Walder being blocked, and click **Open Anyway**. Confirm, and enter your
   password or Touch ID if asked.

   **Open Anyway only appears after a blocked launch**, and it stops being
   offered about an hour later. If you do not see it, double-click Walder again
   to re-trigger the block and come straight back.

That is a one-time thing. After it, Walder opens like any other app.

**Why it is blocked.** Walder is not signed with an Apple developer certificate,
so macOS cannot check who made it and refuses to open it by default. **Open
Anyway** is how you tell macOS you trust it regardless.

*On macOS 14 and older*, right-clicking the app and choosing **Open**, then
**Open** again in the box, does the same job in one step. That shortcut was
removed in macOS 15 — right-click ▸ Open there gives you the same refusal as a
double-click — so **Open Anyway** in System Settings is the route that works on
every version.

**If the message says Walder is *damaged* instead**, that is the other dialog
and it has its own fix — see
[If macOS says Walder is damaged](docs/troubleshooting.md#if-macos-says-walder-is-damaged).

## Installing on Windows

> **Not yet tested by the developers** — this section, and every other mention
> of Windows below, describes what the code is *built* to do; see
> [What you need](#what-you-need).

1. Run the `.exe`.
2. Windows SmartScreen will warn you that it does not recognise the app. Click
   **More info**, then **Run anyway**.
3. The installer asks where to put Walder and offers a desktop shortcut.

Same reason as on the Mac: the app is not signed with a certificate Windows
recognises, so Windows cannot tell who made it and warns you instead. One time
only.

## First run

There is no window, and nothing appears in the Dock or the taskbar. Two things
to look for:

- **A little bone icon** in the menu bar (Mac, top right) or the system tray
  (Windows, bottom right — untested, see the note above). That menu is the whole
  app — there is no settings window anywhere.
- **The dog**, in the bottom-right corner of your main screen.

Then set him up from that menu, in this order:

1. **Accounts ▸ Claude ▸ Log in…** — a normal login window opens on claude.ai.
   Log in as you would in a browser. The window closes itself once the login has
   taken.
2. **Accounts ▸ ChatGPT ▸ Log in…** — the same for chatgpt.com. There is no
   such item for Cursor, Copilot or Gemini: if the Cursor editor is signed in,
   or the GitHub CLI is (`gh auth login`), or Antigravity is open, Walder reads
   their usage already.
3. **Install Claude Code hooks…** and **Install Codex hooks…** — only if you use
   those tools, and only if you want the ears-up reaction. Each asks first,
   naming the file, then writes three small entries into that tool's config and
   tells you what it did. Your original file is copied first, and the matching
   **Remove …** item in the same menu undoes it. Codex needs one more step of its
   own — see [The Codex perk](docs/hooks.md#the-codex-perk). Walder offers both, once, the
   first time it starts on a machine that has the tool.
4. **Launch at login** — tick it so Walder comes back after a restart.

If you already use Claude Code or the Codex CLI on this machine, Walder can read
those logins on its own and may show numbers before you log in to anything.

The numbers refresh by themselves about every three minutes.

## His faces and his barks

![His six faces: happy, neutral, worried, exhausted, out, and confused](docs/images/walder-faces.png)

His face follows **one** number: your **Claude 5-hour window**. That is the
allowance that actually runs out in the middle of an afternoon.

| Face | When |
| --- | --- |
| Happy — grinning, tail up | under 50 % used |
| Neutral — calm, breathing | 50 % to 79 % |
| Worried — ears down, a bead of sweat | 80 % to 94 % |
| Exhausted — half-closed eyes, panting | 95 % to 99 % |
| Out — flat on the floor, X eyes | 100 % or more |
| Confused — head cocked, a question mark | we could not read your usage |

**The confused face is honest, not broken.** It means Walder has no number for
your Claude 5-hour window right now: you are not logged in, a login has expired,
or the site answered with something it did not recognise. Hover over him — the
card names the problem — and **Accounts** in the menu is where you fix it. He
never shows a cheerful face on a number he does not have.

**Barking.** When a usage window crosses 80, 85, 90, 95 or 100 %, he barks once
with a bubble like `Claude 5h: 87% used` — once per threshold per window, so he
does not nag. Every window he can see gets its own barks, not only the 5-hour
one. A bubble names the service, and it stays until you click him. The rest of
the rules are in [What the card shows](docs/what-the-card-shows.md).

## What the card shows

Hover over him and a card appears beside him. For Claude it shows your 5-hour
window, your 7-day window, a row per model your dashboard gives a separate
weekly number for (today that is **Fable**), and — only if your account has it
switched on — Extra usage. For ChatGPT: Codex 5-hour, Codex weekly, and
whichever credit rows your account actually has. For Cursor: Cursor plan,
Cursor Auto when it is a different number, and Cursor on-demand when you have
an on-demand cap. For Copilot: Copilot premium, plus Copilot chat and Copilot
completions when those quotas apply to your account. For Gemini: one row per
quota bucket the running Antigravity IDE reports — Gemini weekly and Claude &
GPT weekly on the Starter plan. **Tokens today** counts
what
Claude Code and Codex have billed you for since local midnight, read from their
own transcripts on your machine. Nothing is on the card that the services did
not report, and a row Walder cannot name by name is left off rather than
guessed at.

[**docs/what-the-card-shows.md**](docs/what-the-card-shows.md) is the full
reference: every row and where its number comes from, the `(est.)` on Extra
usage, the `codexCreditPrice` recipe, the three card sizes, **Show in
overview**, his sizes and coats, when he sleeps through fullscreen video, and
**Hide when idle** with its keyboard shortcut.

## The Claude Code and Codex perks

If you use Claude Code or the Codex CLI in a terminal, Walder can react to
them: his ears go up and he says `Claude done` / `Codex done` when a reply
lands, and he tilts his head and says `Claude waiting` / `Codex waiting` when
one of them is waiting for you. This needs **Install Claude Code hooks…** or
**Install Codex hooks…** from the menu, once — and Codex needs one more step of
its own, which it does nothing without.

[**docs/hooks.md**](docs/hooks.md) has what gets written where, the port, what
the menu's four status lines mean, and how to take the hooks out again.

## Troubleshooting

Most of it is one menu item: **Reset position** if you cannot find him,
**Refresh now** if the numbers look old, **Accounts ▸ Log in…** if the card says
a login is needed, **Developer ▸ Verbose log** before you reproduce anything
odd. The whole table, and the log file it points at, is in
[**docs/troubleshooting.md**](docs/troubleshooting.md).

**Reporting a bug.** Menu ▸ **Report a bug…** opens a **draft** issue in your
browser with the boring half already filled in. Nothing is sent until you press
Submit on GitHub, you can see everything it says, and the same block goes to
your clipboard. Please attach `walder.log`. Every field the report can carry is
listed in [docs/privacy.md](docs/privacy.md#reporting-a-bug).

## Privacy

Everything Walder reads is already on your own machine. Logins and tokens are
read at the moment a check is made and held in memory only.

| What Walder reads | Where | How | What he never does |
| --- | --- | --- | --- |
| Your **Claude Code** login token | The macOS keychain item `Claude Code-credentials`; on other systems `~/.claude/.credentials.json` | Read with `security find-generic-password` when a check runs, then sent as a bearer token to `api.anthropic.com` | Never reads or spends your refresh token, never writes the token to the settings file or the log |
| Your **claude.ai** session | Walder's own browser session, created by **Accounts ▸ Claude ▸ Log in…** | The cookies ride along with the two usage requests to `claude.ai`. Walder checks only that the `sessionKey` cookie exists — never its value | Never reads your conversations, your name or your billing details; only the organisation id and the usage numbers |
| Your **chatgpt.com** session | The same, from **Accounts ▸ ChatGPT ▸ Log in…** | `chatgpt.com` hands back a short-lived token, which reads the usage and is dropped at the end of that poll | Never reads your name, email or picture, and never sends that token anywhere but back to `chatgpt.com` |
| Your **Codex CLI** login | `~/.codex/auth.json` | Read when a check runs; the access token and account id go to `chatgpt.com` | Never writes that file, never keeps the token |
| Your **Cursor** login | The Cursor editor's own `state.vscdb`, opened read-only | Read when a check runs; the bearer token goes to `api2.cursor.sh` and nowhere else | Never writes the editor's files, never opens a Cursor login, never logs the token or the numbers |
| Your **GitHub Copilot** login | The token the GitHub CLI already holds, via `gh auth token` | Read when a check runs; it goes to `api.github.com/copilot_internal/user` and nowhere else | Never logs in for you, never writes `gh`'s config, never refreshes that token, never logs it or the numbers |
| Your **Gemini** limits, while **Antigravity** is running | The IDE's own language server on `127.0.0.1` — found by reading one process's id, its `--csrf_token` argument and its listening ports | Read when a check runs; the request goes to `127.0.0.1` and nowhere else | Never talks to Google for this, never reads any other process, never logs the token or the numbers |
| **Claude Code's session files** — is it busy, waiting or idle | `~/.claude/sessions` | The `pid` and `status` of each file, re-read every couple of seconds | Never reads the folder you are working in, the session id, or anything you typed |
| **Claude Code and Codex transcripts**, for the Tokens today row | `~/.claude/projects` and `~/.codex/sessions` | Files touched since local midnight are opened and their token counts added up | Never reads a prompt or a reply, and never writes a line of a transcript to the log — only the path, if one cannot be read |
| **Hook events** from Claude Code and Codex, if you installed the hooks | A listener on `127.0.0.1`, normally port 47811 | It accepts one thing — a small JSON `POST` from your own machine — turns it into "done", "waiting" or "prompt", and throws the rest away | Never accepts a connection from another machine, and never writes the message body to the log |
| **Your settings** | `~/Library/Application Support/walder/walder.json`, `%APPDATA%\walder\` on Windows | Plain JSON, written by Walder | Never holds a login, a token or a provider's raw answer — there is no field for one |

Where it talks: `claude.ai` and `api.anthropic.com`, and `chatgpt.com`. Plus
`api.github.com` once every six hours, to ask which version of Walder is the
newest — a request that carries nothing about you, and that unticking **Check
for updates automatically** stops for good.

No analytics. No telemetry. No account, no server of ours, nothing phoning
home. **Log out** under **Accounts** clears that service's whole stored
session, not only its cookies.

[**docs/privacy.md**](docs/privacy.md) has the rest: the one thing Walder does
on your behalf (starting `claude` in the background so Claude Code renews its
own login), everything the settings file does keep, what is stripped from the
log, and every field a bug report can carry.

## Updating and uninstalling

**Walder tells you when there is a new version** — the menu's bottom item says
so, and he says it once himself. **Nothing installs itself**: he opens the
download page, and you install it the way you installed the first one. Untick
**Check for updates automatically** and he stops asking of his own accord.

**Uninstalling:** take the hooks out first — menu ▸ **Remove Claude Code
hooks…** and **Remove Codex hooks…** — then **Quit** from the menu and drag
**Walder.app** to the Trash. Both jobs in full, including the by-hand version,
are in [docs/troubleshooting.md](docs/troubleshooting.md#updating).

## Accessibility

**Still mode**, in the menu, stops every animation: no breathing, no tail, no
stretch. He holds a resting frame and stays there. His *face* still changes with
the number, because a different picture is not motion — a worried dog is still
worth seeing. If your system's Reduce Motion setting is on, Still mode switches
itself on with it.

For screen readers he carries a spoken label, rebuilt whenever anything changes:
*"Walder, worried. Claude 5-hour 87% used."* A bark is announced when it
appears, and each row of the hover card reads as one sentence rather than a
scatter of cells.

**What has and has not been checked** (2026-09-19, one Mac): Still mode and the
Reduce Motion link both work. VoiceOver does reach Walder's windows and
announces them as web content, but whether it then reads the labels inside has
not been tried, and the card is only on screen while the pointer is on the dog,
so a screen reader that follows the pointer can never land on its rows. If you
use one, please report what you hear — including nothing.

## Language

English only for now; every owner-facing string sits in
[`src/core/strings.ts`](src/core/strings.ts), so a second language is a second
table, not a hunt through the code.

## For developers

Everything that was here now lives in [`CONTRIBUTING.md`](CONTRIBUTING.md): the
setup, the scripts table, the `src/` map, the invariants that have tests behind
them, and a recipe for adding a usage provider. The short version is Node 22.12
or newer, `npm ci`, `npm run dev`, and `npm run typecheck && npm test && npm run
build` before a change counts as done.

Found a security problem? [`SECURITY.md`](SECURITY.md) — privately, please, not
on the tracker.

## Licence

The code is MIT — see [`LICENSE`](LICENSE). Take it, change it, ship it.

**The dog is not.** Walder is Victor's own illustration and all rights are
reserved on it: the artwork, and the sprite sheet that is the artwork stored as
data, are covered by [`art/LICENSE`](art/LICENSE) instead. So you are welcome to
fork the code — a fork ships its own mascot.

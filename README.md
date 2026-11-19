<p align="center">
  <img src="assets/shared/logo.png" width="128" alt="The Walder app icon: the head and chest of a golden long-haired dachshund in pixel art, on a rounded cream tile with a thin tan rim.">
</p>

<h1 align="center">Walder</h1>

<p align="center">
  A pixel-art dog on your desktop who shows your AI usage and tells you when a tool needs you, has finished, or is close to its limit.
</p>

<p align="center">
  <a href="https://github.com/ViuMP/Walder/releases/latest"><img src="https://img.shields.io/github/v/release/ViuMP/Walder?style=flat-square&color=22212a&label=release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Windows-22212a?style=flat-square" alt="Platforms: macOS and Windows">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22212a?style=flat-square" alt="License: MIT"></a>
</p>

<p align="center">
  <img src="assets/macos/hero.png" width="800" alt="The Large usage card beside the dog. Claude, read through Claude Code: the 5-hour window at 86 percent with a red bar, resetting in 4 hours 59 minutes, and the 7-day window at 34 percent. ChatGPT, read through the Codex CLI: Codex 5-hour at 18 percent and Codex weekly at 41 percent. The dog looks worried, with a drop of sweat, and says: Claude 5h: 86% used.">
</p>

<p align="center">
  <strong>Shows Claude, ChatGPT and Codex, Cursor, GitHub Copilot and Gemini usage on one card.</strong><br>
  <strong>Barks when a usage window nears its limit (80, 85, 90, 95 and 100 % by default).</strong><br>
  <strong>Tells you when Claude Code or Codex is waiting for you, or has finished.</strong>
</p>

<p align="center"><sub>Screenshots are from macOS with sample numbers. The same set from Windows is under <a href="#on-windows">On Windows</a>.</sub></p>

## Tracking

<img src="assets/macos/tracking-card.png" width="800" alt="The Large usage card on its own. A Claude section with the 5-hour window at 86 percent and the 7-day window at 34 percent, and a ChatGPT section with Codex 5-hour at 18 percent and Codex weekly at 41 percent. Each row has a 20-segment bar and its reset time.">

Hover over the dog and a card shows every usage window your services report, with the percentage
and when it resets. Claude and ChatGPT are read from your Claude Code and Codex CLI logins, or
from a login in Walder. Cursor comes from the signed-in Cursor editor, Copilot from the GitHub CLI,
and Gemini from the Antigravity IDE while it runs (on Windows not yet verified with a signed-in
account). The card comes Large, Medium
(no header) or Small (one line per window, no bars).

## Needs your input

<img src="assets/macos/alert-needs-input.png" width="800" alt="The dog with a blue question mark over his head and a speech bubble that says: Codex waiting.">

When Claude Code or Codex stops to ask you something, he tilts his head, shows a question mark
and says `Claude waiting` or `Codex waiting`. Claude Code works with nothing installed. Codex
needs its hooks from the bone menu (**Hooks ▸ Install Codex hooks…**) plus one step in Codex
([docs/hooks.md](docs/hooks.md)).

## Finished

<img src="assets/macos/alert-finished.png" width="800" alt="The dog with his ears up and a speech bubble that says: Codex done.">

When a reply lands, his ears go up and he says `Claude done` or `Codex done`. This works for the
command-line tools on the same computer. It does not cover the claude.ai or chatgpt.com websites.

## Close to the limit

<img src="assets/macos/alert-usage-limit.png" width="800" alt="The dog looking worried, with a drop of sweat, and a speech bubble that says: Claude 5h: 86% used.">

When a usage window passes 80, 85, 90, 95 or 100 %, he barks once with a bubble such as
`Claude 5h: 86% used`. Each level barks once per window. **Barks** changes the levels: Quiet
barks at 95 and 100%, Chatty every 10%. A service switched off in **Show in overview** does
not bark.

## The Walder window

<img src="assets/macos/window-overview.png" width="800" alt="The Walder window in the dark theme, on its Overview page. A rail on the left shows the dog, the name Walder, version 0.3.0, the pages Overview, Appearance, Alerts, Visibility, Usage, App and Advanced, and Connected. A preview shows the Large card beside the golden dog. Beside it, Your companion: Model with pictures of Walder and Yuna, Coat as six colour swatches, Size and Card size as Small, Medium and Large, and Apply changes and Revert. Along the bottom: Claude Connected, ChatGPT Connected, Cursor Not set up, Copilot Not set up, and Refresh now.">

**Overview and settings…** in the bone menu opens the Walder window. Starting Walder again while
it runs opens it too. A rail on the left lists Overview and one page per group of settings, and
Overview shows each service's state with **Refresh now**. Most settings save at once; only the
Overview choices and the hover card layout wait for **Apply changes**.

## Preview before you apply

<img src="assets/macos/window-apply.png" width="800" alt="The Overview page with Yuna the cat in the calico coat and Card size Medium chosen but not applied. The preview carries an Unapplied changes tag and shows the calico cat with the Medium card. Apply changes is highlighted, and Revert has the note: Not applied yet.">

On Overview you pick the model (Walder the dog or Yuna the cat), the coat, the size and the card
size. The preview shows the choice before it reaches your desktop. Nothing changes until you click
**Apply changes**, and closing the window drops a choice you did not apply.

## Your hover card, your way

<img src="assets/macos/window-hover-card.png" width="800" alt="The Visibility page, Hover card section, with Advanced customization on. A Card lines list: Card title, Claude heading, Claude 5-hour, Claude 5-hour reset, Claude 7-day (all models), Claude 7-day (all models) reset switched off, ChatGPT heading, Codex 5-hour, Codex 5-hour reset, Codex weekly, Codex weekly reset and Sessions, each with a drag handle and a switch. A live preview shows the Large card without the 7-day reset line, marked Preview, unapplied changes.">

**Advanced customization** (Visibility ▸ Hover card) turns the card into a list of lines. Drag a
line, or press Alt+Up or Alt+Down, to move it, and switch each one on or off. A live preview shows
the card before **Apply changes**, and **Restore default layout** puts every line back. The
advanced card is always the Large card, whatever Card size says.

## Light and dark

<img src="assets/macos/window-theme.png" width="800" alt="The Walder window's Overview page in the light theme: a cream background with dark text, the same rail, preview, companion choices and services bar as the dark version.">

**Theme** (Appearance ▸ Theme) draws the Walder window light, dark, or following the system, which
is the default. It changes the Walder window only. The hover card and the dog look the same.

## Settings

<img src="assets/macos/window-settings.png" width="800" alt="The top of the Visibility page: the title Visibility with Revert and Apply changes buttons, Show in overview switches for Claude, ChatGPT, Cursor and Copilot on and Gemini off, Hide when idle, a Shortcut set to Alt+Shift+H, Sleep during fullscreen video, and the start of the Hover card section.">

Every setting has a control in the window, and on the settings pages each one has a line under it
that says what it does. Each change is checked before it is saved, and most are saved at once. Codex credit price and Hook port
take effect only after a restart, and a new Hook port also needs the hooks installed again. The
only settings still in the bone menu are Size and Hide when idle.

Walder speaks English, Danish, Simplified Chinese, Hindi, Spanish, French and German. **App ▸ Language**
follows your computer by default; a change applies after a restart. The six translations were
written by a machine and have not yet been read by a native speaker, so corrections are welcome as
[issues](https://github.com/ViuMP/Walder/issues/new). [docs/accessibility.md](docs/accessibility.md#language)
says what stays in English.

## On Windows

<img src="assets/windows/hero.png" width="800" alt="Windows: the Large usage card beside the dog on a plain cream background. Claude, read through Claude Code: the 5-hour window at 86 percent with a red bar, resetting in 4 hours 59 minutes, and the 7-day window at 34 percent. ChatGPT, read through the Codex CLI: Codex 5-hour at 18 percent and Codex weekly at 41 percent. The dog looks worried, with a drop of sweat, and says: Claude 5h: 86% used.">

<img src="assets/windows/window-overview.png" width="800" alt="Windows: the Walder window in the dark theme with the green Windows title bar, on its Overview page. The rail lists Overview, Appearance, Alerts, Visibility, Usage, App and Advanced. A preview shows the Large card with the same sample numbers beside the golden dog. Your companion offers Walder and Yuna, six coats, Size with Medium chosen and Card size with Large chosen. Along the bottom: Claude Connected, ChatGPT Connected, Cursor Not set up, Copilot Not set up, and Refresh now.">

Walder looks and works the same on Windows (these were taken on Windows 11 at 100 %). The bone sits in the notification area
(it may be behind the ^ arrow until you drag it out), and right-clicking the dog opens the same
menu. The Walder window uses the normal Windows title bar. The rest of the Windows set, with the
same sample numbers, is in [assets/windows/](assets/windows/): the card on its own, the three
alerts, Preview before you apply, the hover card editor, the light theme and the Visibility page.

## Install

**macOS** (13 or newer). Apple Silicon (Apple menu ▸ About This Mac shows an "Apple M…" chip):

```bash
curl -L -o ~/Downloads/Walder-mac-arm64.dmg https://github.com/ViuMP/Walder/releases/latest/download/Walder-mac-arm64.dmg && open ~/Downloads/Walder-mac-arm64.dmg
```

Intel Mac (About This Mac shows an "Intel" processor). This build has not yet been tried on an
Intel Mac:

```bash
curl -L -o ~/Downloads/Walder-mac-x64.dmg https://github.com/ViuMP/Walder/releases/latest/download/Walder-mac-x64.dmg && open ~/Downloads/Walder-mac-x64.dmg
```

Drag **Walder.app** into **Applications** and open it. When macOS blocks it, click **Done**, then
**System Settings ▸ Privacy & Security ▸ Open Anyway**.

**Windows** (10 or 11, 64-bit), in PowerShell:

```powershell
Invoke-WebRequest https://github.com/ViuMP/Walder/releases/latest/download/Walder-win-x64.exe -OutFile "$env:USERPROFILE\Downloads\Walder-win-x64.exe"; Start-Process "$env:USERPROFILE\Downloads\Walder-win-x64.exe"
```

When SmartScreen warns you, click **More info**, then **Run anyway**. Tested on one Windows 11 PC
at 100 % and 125 % scaling, not yet on a second monitor.

The installers are not signed with a paid certificate, so each system warns you once.
[INSTALL.md](INSTALL.md) has every step, the first run, updating, uninstalling and building from
source. The [handbook](https://viump.github.io/Walder/) covers the first five minutes of setup
and every face, wiggle and bubble he has.

## Settings reference

| Setting | What it does |
| --- | --- |
| Overview ▸ Size | How big he is drawn: Small, Medium or Large. |
| Overview ▸ Model and Coat | Walder the dog or Yuna the cat, and the coat. |
| Overview ▸ Card size | How much the hover card shows: Large, Medium or Small. |
| Appearance ▸ Reset times | Reset times as a clock time or a countdown. |
| Appearance ▸ Still mode | Holds one frame per pose instead of animating. |
| Appearance ▸ Theme | The Walder window light, dark, or following the system. |
| Alerts ▸ Barks | Which usage levels raise a bubble: Quiet, Normal or Chatty. |
| Alerts ▸ Bark sound | Plays a short bark with each usage bubble. |
| Alerts ▸ Primary service | The service listed and reacted to first. |
| Alerts ▸ Notify when hidden | Sends a system notification when he is hidden and has something to say. |
| Visibility ▸ Show in overview | Which services appear on the card, may bark and are checked. A hidden service makes no requests. |
| Visibility ▸ Hover card | The standard card, or Advanced customization with your own lines. |
| Visibility ▸ Hide when idle | Keeps him off screen until he has something to say. |
| Visibility ▸ Shortcut | The global shortcut that turns Hide when idle on and off. |
| Visibility ▸ Sleep during fullscreen video | Curls him up small while a fullscreen video or game is in front. |
| Usage ▸ Refresh interval | Seconds between usage checks, from 180 to 86400. |
| Usage ▸ Codex credit price | The price per Codex credit for the cost on the card, or off. |
| App ▸ Language | System (follows your computer), English, Dansk, 简体中文, हिन्दी, Español, Français or Deutsch. After a restart. |
| App ▸ Launch at login | Starts Walder when you log in. Installed app only. |
| App ▸ Check for updates automatically | Asks GitHub every six hours whether a newer release exists. |
| App ▸ Hook port | The local port the Claude Code and Codex hooks report to. |
| Advanced ▸ Verbose log | Writes detailed lines to the log file. |
| Advanced ▸ Force interactive | Makes the whole dog window take clicks, for debugging. |

Defaults, allowed values and when each one takes effect: [SETTINGS.md](SETTINGS.md).

## FAQ

**Does Walder send my data anywhere?**
Only to the services it tracks, plus one request to GitHub every six hours for the update check.
There is no analytics or telemetry; [docs/privacy.md](docs/privacy.md) lists every request.

**Does it read my code or my prompts?**
No. It reads logins, usage numbers, session state and token counts, never a prompt or a reply
([docs/privacy.md](docs/privacy.md)).

**Why does macOS or Windows warn me when I install it?**
The installers are not signed with a paid certificate. [INSTALL.md](INSTALL.md) shows how to open
it.

**Why does Gemini show nothing?**
Walder reads Gemini limits from the Antigravity IDE while it runs, so open Antigravity and sign
in there. On Windows this is supported but not yet verified with a signed-in account.

**Does it update itself?**
No. When a newer release exists the bone menu and the dog say so, and you install it yourself;
**Check for updates automatically** turns the check off.

**How do I hide him?**
Turn on **Hide when idle** in the bone menu, or press its shortcut (Control+Command+W on macOS,
Alt+Shift+W on Windows). He comes back when he has something to say.

**Where is the dog?**
Bone menu ▸ **Reset position** puts him back in the bottom-right corner of your main screen.

**Does it speak my language?**
English, Danish, Simplified Chinese, Hindi, Spanish, French and German, chosen under App ▸ Language. The
translations are machine-made and still waiting for native speakers to check them.

**Does it work with a screen reader?**
Partly, and not yet tested. The dog, his bubbles and the card rows carry spoken labels, and Still
mode stops the animation, but nobody has run VoiceOver or Narrator through the Walder window yet.
[docs/accessibility.md](docs/accessibility.md) says what has and has not been checked.

## License

The code is MIT: see [LICENSE](LICENSE). The dog and the other artwork are not. They are the
author's own illustration, all rights reserved, under [art/LICENSE](art/LICENSE).

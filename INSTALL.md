# Installing Walder

## What you need

**macOS:** Apple Silicon, macOS 13 (Ventura) or newer. There is no Intel build. macOS 13 is the
lowest version Electron 45 runs on; the developers use macOS 15.

**Windows:** Windows 10 or 11, 64-bit. Tested on one Windows 11 PC at 100 % and 125 % display
scaling. Not yet tested on a second monitor.

Both installers are on the [latest release](https://github.com/ViuMP/Walder/releases/latest).
Neither is signed with a paid certificate, so each operating system warns you once.

## macOS

```bash
curl -L -o ~/Downloads/Walder-mac-arm64.dmg https://github.com/ViuMP/Walder/releases/latest/download/Walder-mac-arm64.dmg && open ~/Downloads/Walder-mac-arm64.dmg
```

1. Drag **Walder.app** into **Applications**.
2. Double-click **Walder** in Applications. macOS blocks it. On macOS 15 and newer the message
   says Apple could not verify Walder is free of malware; on older versions it names an
   unidentified developer. Click **Done**, not **Move to Trash**.
3. Open **System Settings ▸ Privacy & Security**, scroll to the message about Walder, and click
   **Open Anyway**. Confirm with your password or Touch ID.

**Open Anyway** appears only after a blocked launch and disappears about an hour later. If you
do not see it, double-click Walder again and come straight back. You do this once.

On macOS 14 and older, right-click the app, choose **Open**, then **Open** again. That shortcut
was removed in macOS 15.

If macOS says Walder is *damaged* instead, see
[If macOS says Walder is damaged](docs/troubleshooting.md#if-macos-says-walder-is-damaged).

## Windows

In PowerShell:

```powershell
Invoke-WebRequest https://github.com/ViuMP/Walder/releases/latest/download/Walder-win-x64.exe -OutFile "$env:USERPROFILE\Downloads\Walder-win-x64.exe"; Start-Process "$env:USERPROFILE\Downloads\Walder-win-x64.exe"
```

1. SmartScreen says it does not recognise the app. Click **More info**, then **Run anyway**.
2. The installer asks where to put Walder and adds a desktop shortcut.

## First run

Walder has no Dock or taskbar icon while the Walder window is closed. Look for:

- **The bone icon** in the menu bar (macOS, top right) or the system tray (Windows, bottom
  right). Its menu holds every action.
- **The dog**, in the bottom-right corner of your main screen.

Then, from the bone menu:

1. **Accounts ▸ Claude ▸ Log in…** opens claude.ai in a login window. It closes itself once
   you are logged in.
2. **Accounts ▸ ChatGPT ▸ Log in…** does the same for chatgpt.com.
3. Cursor, GitHub Copilot and Gemini need no login in Walder. Walder reads them when the
   Cursor editor is signed in, when the GitHub CLI is signed in (`gh auth login`), or while
   the Antigravity IDE is running. Gemini works on macOS only.
4. **Install Codex hooks…** if you use Codex. Codex then needs one more step of its own:
   see [The Codex perk](docs/hooks.md#the-codex-perk). Claude Code works without hooks.
5. **Launch at login**, so Walder starts again after a restart.

If Claude Code or the Codex CLI is already signed in on this computer, Walder reads those
logins and may show numbers before you log in to anything.

To open the Walder window, choose **Overview and settings…** in the bone menu, or start
Walder again while it is running.

## Updating

When a new version exists, a line near the bottom of the bone menu says so and the dog says it
once. Nothing installs itself: Walder opens the download page and you install it the same way.
Turn off **Check for updates automatically** in Settings to stop the check.

## Uninstalling

1. Bone menu ▸ **Remove Claude Code hooks…** and **Remove Codex hooks…**.
2. **Accounts ▸ Log out** for Claude and ChatGPT. Their logins stay on disk otherwise.
3. **Quit**, then delete the app: drag **Walder.app** to the Trash on macOS, or use **Add or
   remove programs** on Windows.

The by-hand version is in [docs/troubleshooting.md](docs/troubleshooting.md#updating).

## Building from source

Node 22.12 or newer.

```bash
git clone https://github.com/ViuMP/Walder.git && cd Walder && npm ci && npm run dev
```

Before a change counts as done: `npm run typecheck && npm test && npm run build`. Installers:
`npm run dist:mac` on a Mac, `npm run dist:win` for Windows. The details are in
[CONTRIBUTING.md](CONTRIBUTING.md).

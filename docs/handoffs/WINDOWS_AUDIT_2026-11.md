# Windows half of the 2026-11 audit — brief for a session on the Windows PC

Written 2026-11-13 on the Mac. The Mac session audited the code, drove every Mac screen and fixes
its findings on branch `audit-2026-11`. Nothing in that audit ran on Windows: the Windows findings
below come from reading the code. This brief is what a Claude Code session on the Windows PC needs
to close that half. Paste everything under "PROMPT" into that session.

Before the session can start, Victor pushes the branch from the Mac (`git push -u origin
audit-2026-11`) and checks it out on the PC. The Mac session's final report is
`docs/handoffs/AUDIT_2026-11-13.md`; read it first. Each finding below says whether the branch
already carries a fix (unverified on Windows) or whether it was left for this pass.

## PROMPT

You coordinate the Windows half of an audit of Walder on branch `audit-2026-11`. Three jobs, in
this order: get the gates green on Windows, look at every screen once, and verify the
Windows-only findings listed below on screen, fixing what fails.

YOUR ROLE
- You coordinate. Delegate hands-on work (driving the app, screenshots, clicks, code edits, running
  checks) to Opus subagents with tight, self-contained briefs, and judge what they return against
  the exact wording of the item before accepting it. Multi-agent orchestration is approved.
- Verifying on screen is serial (one Walder instance, one mouse). Reading code and fixing can run
  in parallel in git worktrees, never in the live checkout while a dev build runs from it.
- Every finding gets an independent skeptic before a fix is briefed, and every diff a review before
  it is kept.

CONTEXT
- Read `AGENTS.md`, `CONTRIBUTING.md` (binding rules), `docs/QA-CHECKLIST.md` and
  `docs/handoffs/QA_0.2.8_WINDOWS_REPORT.md` first. The last one records how the previous Windows
  pass drove the app and its harness caveat (F21), which still applies: tool shells run under the
  Claude desktop app's MSIX file-system and registry virtualisation, so launch the packaged app
  through Explorer and touch the real `%APPDATA%\walder` only from outside the virtualised layer.
- `npm run dist:win` on this PC builds the installer into `release\`. Use it for the install,
  uninstall and packaged-only items; use `$env:WALDER_LOG=1; npm run dev` for the Developer menu.
- Windows only. Do not edit the Mac column of the checklist.

SETUP (stop and tell me if anything fails)
1. A screenshot tool works from a script (PowerShell `System.Drawing` + `CopyFromScreen`), saving
   into `%USERPROFILE%\Walder-qa\2026-11-audit\`, never `%TEMP%`.
2. A click/keystroke tool works from a script (AutoHotkey v2 or a SendInput helper). Note the
   display scale; screenshots are in physical pixels, clicks may be logical.
3. Work on `audit-2026-11`. Do not push, tag or release; give me the commands instead. Commit only
   when I ask.
4. Back up `%APPDATA%\walder\` (the whole folder) to the evidence folder before anything that logs
   out, resets settings or reinstalls. Restore only into the exact parent folder.

JOB 1 — THE GATES ON WINDOWS
`npm ci`, then `npm run typecheck`, `npm test`, `npm run build`, `npm run dist:win`, each judged
by its exit code (never piped into a filter). Record the test count. A test that fails only on
Windows is a finding: fix the test's POSIX assumption, not the app, unless the app is wrong.

JOB 2 — EVERY SCREEN, ONCE
One careful look per screen and state, with a screenshot each: the dog at Small / Medium / Large,
standing and lying, at the default corner and mid-screen; the hover card at every Card size with
the real services and the SESSIONS section; a usage bark, a `… waiting` with `?` and a `… done`
at Small and Large, including at the right screen edge; the tray menu and every submenu, read item
by item (labels, ticks, disabled state, countdowns fresh on each open, the new Restart item, which
must relaunch exactly once); the login window (open and look only), the hook-install dialogs
(open, then Cancel), Report a bug, Check for updates; the gallery. Do all of it at 100 % and at
125 %. Look for clipped or overflowing text, blurred pixels, a box or shadow around a transparent
window, wrong or stale labels, something drawn off-screen, and wording that contradicts what
happens.

JOB 3 — THE WINDOWS-ONLY FINDINGS
Each is from a code read on the Mac. "Fixed on the branch" means the code changed and its unit
test passes on the Mac; nothing below has been seen on Windows. Establish on screen whether it is
real, then confirm the fix works, or fix it.

Fixed on the branch, confirm on screen:
- **W1 (high):** `gh auth token` was spawned without `windowsHide` (`src/providers/credentials.ts`).
  With the GitHub CLI on PATH, the 0.2.9 packaged app should flash a console window on every poll
  and the branch build should not. Packaged build only; a dev build inherits the terminal's console.
- **W4:** `build/installer.nsh` adds a `customUnInstall` macro that deletes the Launch-at-login Run
  value, skipped when `${isUpdated}`. It has never run. Uninstall with Launch at login ticked, then
  check `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` for a leftover `electron.app.Walder`.
  An update install over a running copy must NOT clear it.
- **W2 / D8:** Claude login renewal now spawns only `claude.exe` on Windows and survives a failed
  spawn. Test with an npm-installed CLI (`%APPDATA%\npm\claude` is a sh shim, `claude.cmd` cannot
  be spawned without a shell: renewal should be skipped quietly) and with the native `claude.exe`.
- **D6:** save `%APPDATA%\walder\walder.json` with a UTF-8 BOM (PowerShell 5.1
  `Set-Content -Encoding UTF8`) and relaunch: settings must survive.
- **F1:** the first-run hello says "Click the bone in your tray." on Windows, not "menu bar".
- **F4:** a long unbroken error string on the Large card must wrap, not run past the border.
- **T3:** `npm run sprites` from a checkout whose path contains a space.
- **T6:** CI's Windows job now runs `npm test`. Say whether `test/fullscreen-win-helper.test.ts`
  passes on this PC and would on a hosted runner.

Not fixed, left for this pass (each needs a Windows machine to establish):
- **W3 (medium):** the PowerShell hook command reads stdin through the console code page and posts
  it as ISO-8859-1. A session folder with a non-ASCII name (`C:\Users\…\Skrivebord\Blåbær`) should
  show wrong on the SESSIONS line or lose the event. Test from cmd, PowerShell and Git Bash.
- **M3 (low):** the fullscreen helper's window rect is compared with Electron's DIP bounds. Test
  a fullscreen film at 125 %, and on a second monitor at a different scale if there is one.
- **M5 (low):** open the tray overflow over a fullscreen film for more than four seconds: does he
  wake?
- **M4 / W5 (QA row only):** no `app.setAppUserModelId`. With Notify when hidden ticked and Hide
  when idle on, does a bark raise a toast in the packaged app, and under which name? Changing the
  id also renames the Launch-at-login Run value, so a fix needs a one-time migration of
  `electron.app.Walder`. Do not set the id without that migration.
- **W6 (QA row only):** with the taskbar on auto-hide, does an ordinary maximised window put him
  to sleep?

Platform-independent fixes to re-check here:
- A bubble arriving or clearing mid-drag does not shift him off the cursor (QA row 7.15a).
- Ending the overlay's renderer process brings him back, at most three times a run (row 7.15c).
- With two Claude Code sessions blocked at once, answering one leaves the other's `?` up.
- Hooks re-installed after the `--noproxy` change still deliver from Git Bash and WSL (the
  PowerShell command did not change).

HARD RULES
- Never redraw, trace or patch sprite pixels. `src/core` and `src/sprites` stay Electron-free.
  Never refresh CLI tokens. Never log usage payload values.
- Do not change system or security settings, type passwords, log in or out of a service, or
  publish anything. Those go on an owner list for one sitting with me at the end.
- Never extract a backup into `%APPDATA%` itself, only into the exact target folder.

FINISH
Done means: the four gates pass on Windows by exit code; every screen in Job 2 has a screenshot and
a verdict; every Job 3 item is confirmed fixed, fixed here with a unit test, or listed as out with
the reason; and you have given me a short report with the test count, the fixes, the out items and
anything the Mac side should re-check.

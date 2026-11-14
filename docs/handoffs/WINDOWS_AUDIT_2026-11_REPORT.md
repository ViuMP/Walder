# Windows half of the 2026-11 audit — report (2026-11-14)

Branch `audit-2026-11`: the fixes listed below were made on top of `2322108` and are committed with
this report as `1d7a16e` (pushed). Machine: Windows 11 Pro
26200, one 1920 × 1200 display, Windows PowerShell 5.1, Node 24. Coordinator: Claude Fable 5.2; hands:
Opus subagents driving the real mouse and keyboard, one at a time. Brief:
`docs/handoffs/WINDOWS_AUDIT_2026-11.md`. Evidence: `C:\Users\Victor\Walder-qa\2026-11-audit\`
(`100\` screens and notes per pass, `pkg\` packaged build, `patches\` every diff as reviewed, `gates*\`
gate logs, `W3\`, `M3\`, `M5\` experiments). Screenshots of Start, Alt+Tab and the notification centre
show private content; keep that folder private.

**State: the 100 % half and the packaged build are done; nothing was looked at at 125 %, and W6 was
not tested (Victor's call on 2026-11-14 to skip both; section 7). Committed and pushed as `1d7a16e`.**

## 1. Gates on Windows

Each judged by its own exit code, never piped into a filter.

| run | typecheck | test | build | dist:win |
| --- | --- | --- | --- | --- |
| `2322108` as pushed, fresh checkout | 0 | 0 — 80 files, 2720 passed, 10 skipped | 0 | 0 |
| `2322108`, after the first `dist:win` | | 0 — 2721 passed, 9 skipped (same as CI run 43580415415) | | |
| with W3 + M3 + M5 + D9 | 0 | 0 — 83 files, 2780 passed, 9 skipped | 0 | 0 |
| with M5b as well | 0 | 0 — 83 files, 2785 passed, 9 skipped | 0 | 0 |
| **final tree, 21:40, after `git fetch` (nothing new on the remote)** | **0** | **0 — 83 files, 2785 passed, 9 skipped** | **0** | (the installer under test was built from this tree) |

- No test fails only on Windows. The one-test difference between the first two rows is
  `test/check-asar.test.ts` ("every one of them satisfies the packaging contract"), which runs only
  when a packaged archive of this version exists; CI builds the installer before `npm test`, a fresh
  checkout has none. Not a defect.
- The 9 skips are all platform gates: 2 `icon.icns`, 4 macOS full-screen panel, 2 POSIX file
  mode/symlink, 1 `art/walder.json` comparison.
- **T6:** `test/fullscreen-win-helper.test.ts` passes on this PC with its live half running (2.4 s),
  and it ran live on the hosted `windows-latest` runner too (1.8 s, CI run 43580415415).
- `dist:win` overwrote `release\Walder-0.2.9-win-x64.exe` (same version number as the published 0.2.9;
  the published one was not in `release\` on this PC).

## 2. Fixes made here (each reviewed by a fresh reviewer)

| id | what | where | tests |
| --- | --- | --- | --- |
| W3 | The Windows hook command read stdin through the console code page and posted Latin-1. Now reads the raw stream as UTF-8 and posts UTF-8 bytes with `charset=utf-8`. Still `$`-free, still ends `; exit 0 # walder-hook`, old installs upgrade in place on the next Install. | `src/main/claude-hooks.ts` | `test/install-hooks.test.ts` 'reads stdin as UTF-8 bytes and posts UTF-8 bytes on Windows (W3)', 'upgrades a console-text (0.2.9) Windows install in place (W3)'; `test/codex-hooks.test.ts` re-pinned; new win32-only live `test/hook-command-win-live.test.ts` (cmd on cp 850 and 65001, Codex variant, Git Bash) |
| M3 | The helper now makes its sampling thread per-monitor DPI aware and marks its line `"physical":1`; main maps physical rects to DIPs through the display Windows reported. Unflagged lines are left alone, so nothing is scaled twice. | `src/main/fullscreen-win.ps1`, `src/main/fullscreen-watch.ts`, new `src/main/win-dpi.ts` | new `test/win-dpi.test.ts` (100 %, 125 %, both mixed-scale layouts), `test/fullscreen-watch.test.ts` 'the Windows probe, wired into the watch (audit M3)', helper test |
| M5 | A transient shell surface in front of a film holds the last fullscreen state, bounded at 15 s. The helper reports the window class (`cls`); the pure core classifies. Desktop, folder windows and ordinary apps still end fullscreen after two polls. | `src/core/fullscreen.ts`, `src/main/fullscreen-watch.ts`, `src/main/fullscreen-win.ps1` | `test/fullscreen.test.ts` 'Windows shell surfaces over a film (M5)' (10 tests), `test/fullscreen-watch.test.ts` (4), plus 11 M3 × M5 interaction tests |
| M5b | Found on screen: Widgets (Win+W, owner `WidgetBoard`) woke him; the verbose hold line printed `([redacted])` for long class names; only the first surface of an episode was logged. Widgets added; the line prints only names from Walder's own lists, spaced so the redactor (unchanged) leaves them; one line per distinct surface per episode. | `src/core/fullscreen.ts`, `src/main/fullscreen-watch.ts` | 'holds over a film with the Widgets board open (Win+W, M5b)', 'names a long listed class readably, and never prints an unlisted class (M5b)', 'logs each distinct surface once within an episode, not every poll (M5b)', 'every listed class and owner survives the real redactor on the hold line (M5b)' |
| D9 (new, platform-independent; called D2 in commit `1d7a16e`, the evidence files and the worktree; not the Mac report's D2) | After Card size ▸ Small with the card hidden, the first hover showed the card at 250 × 140 with a scrollbar and the bottom border cut, until an unrelated repaint fixed it. The hidden window kept the old width and the card was measured at `width: 100 %` of it. The painter now sets the card to the width it will be shown at; the page never scrolls. | `src/core/card-layout.ts`, `src/renderer/panel.ts`, `src/renderer/panel.html` | new `test/panel-measure.test.ts` (5 tests) |

Docs changed with them: `docs/hooks.md`, `docs/troubleshooting.md`, `docs/DECISIONS.md`,
`docs/QA-CHECKLIST.md` (Windows notes and Result cells only; the Mac column is untouched).
Not touched, as the Mac session asked: `src/main/ipc-bridge.ts`, `src/main/tray.ts` and their tests.

## 3. Job 3 — the Windows-only findings

| id | outcome | what was seen |
| --- | --- | --- |
| W1 | **not reproducible here; the fix is harmless** | The installed 0.2.9 spawns `gh.exe` twice per poll, each with its own `conhost.exe`, but no console window became visible (watcher at ~13 ms plus a screenshot burst; the detector does catch a plain `cmd.exe` window). The branch packaged build behaves the same: `gh.exe` twice per poll, each still with a `conhost.exe` child, nothing visible. So the flash W1 describes could not be shown on this PC, before or after. |
| W4 | **confirmed fixed** | Launch at login ticked → real value `electron.app.Walder  REG_SZ  "C:\Users\Victor\AppData\Local\Programs\Walder\Walder.exe"`. Update install over the running 0.2.9 (old uninstaller): value kept. Update install over the running branch build (the new `customUnInstall` macro in update mode): value kept. Real uninstall: value gone, uninstall key, folder and shortcuts gone, `%APPDATA%\walder` kept. All read from the real registry through an Explorer-launched script. |
| W2 / D8 | **confirmed fixed** (through a temporary profile) | The owner's standalone CLI has no login, so Renew stops at "no Claude Code login to renew" before any lookup. With a temporary profile and a made-up expired credential: only shims on PATH → `no claude binary found; renewal off`, neither shim ran; an unrunnable `claude.exe` → `the CLI could not be started; renewal off — Error: spawn UNKNOWN`, app alive, later polls fine. No console window in any case. Not exercised: a successful renewal with the native `claude.exe` (needs a CLI login: owner). |
| D6 | **confirmed fixed** | `walder.json` re-saved with a BOM by PowerShell 5.1: every setting, the position and the shortcut survived, no first-run hello, no `settings:` line. The app writes the file back without a BOM. |
| F1 | **confirmed fixed** | First run: "Hello. Click the bone in your tray." One line, on screen at Small and Medium. The hello held against a competing "Claude Code logged out" bark; beat 2 "Accounts ▸ Claude ▸ Log in". |
| F4 | **out: not producible on screen** | No route puts a long unbroken string into a card note without a code edit or a logout (notes are fixed texts, `HTTP nnn` or exception messages; a hook `cwd` only reaches the SESSIONS row, which shortens it). The CSS pin in `test/card-layout.test.ts` passes on Windows. |
| T3 | **confirmed fixed** | `npm run sprites` from this checkout (its path has spaces): gallery opened, exit 0. Node prints DEP0190 (args passed with `shell: true`), a warning only. |
| T6 | **confirmed** | See section 1. |
| W3 | **real; fixed here** | By experiment: 13 of 13 runs (cmd, PowerShell, Git Bash; code pages 437, 850, 1252, 65001) delivered a body that was not valid UTF-8. The event is never lost (the bad bytes stay inside strings). On screen from cmd on cp 437: old command `Claude · ~\Skrivebord\Bl?�b?�r_?� · working`, new command `Claude · ~\Skrivebord\Blåbær_Ø · working`; new command correct from Git Bash too. **Existing installs keep the old command until Install … hooks… is chosen again**, and the tray says "installed" either way. |
| M3 | **single display: not real. Mixed scale: predicted, fixed here, unverified** | `powershell.exe` 5.1 is DPI-unaware, so the old helper already reported 96-DPI logical rects, which equal Electron's DIPs on one display at any scale. Only a dog on a non-primary display of a mixed-scale pair is predicted to be missed. The fix cannot be observed on this one-display PC. At 100 % the new helper line carries `"physical":1` and fullscreen detection works (the whole M5 pass ran on it). **Not seen at 125 %** (owner list). |
| M5 | **real; fixed here and confirmed on screen** | Over a borderless fullscreen window, each held ≥ 10 s without waking him: tray overflow (`Shell_TrayWnd` → `TopLevelWindowForOverflowXamlIsland`, explorer), Start and Search (`Windows.UI.Core.CoreWindow`, SearchHost), Alt+Tab and Task View (`XamlExplorerHostIslandWindow`, explorer), Quick Settings (`ControlCenterWindow`, ShellHost), notification centre (ShellExperienceHost), a taskbar click. Win+D woke him in 3.7 s; a surface left open hit the 15 s bound and woke him at ~19 s; closing the film woke him in 3.9 s. Widgets woke him in 4.2 s → M5b, re-checked on the packaged build: Win+W held 10.5 s, no wake, log `a shell surface (WindowsDashboard; owner WidgetBoard) is in front; holding fullscreen`; overflow `(Top Level Window For Overflow Xaml Island; owner explorer)`; Alt+Tab `(Xaml Explorer Host Island Window; owner explorer)`; no `[redacted]`. |
| M4 / W5 | **QA row answered: no fix needed** | Packaged build, Notify when hidden and Hide when idle on: a `… waiting` and a 91 % bark each raised a toast under the name **"Walder"** with the dog icon, title "Walder", body the bubble text; the notification centre groups them under "Walder". `Get-StartApps` gives AppID `com.victorprehn.walder` (the installer's shortcut carries it), so no `app.setAppUserModelId` and no Run-value migration is needed. A `… done` raises no toast by design. One oddity: the first bark after ticking the options (82 %) raised no toast and left no log line; the next two did. Not reproduced a second time; cause unknown. |
| W6 | **out: not tested** | Needs "Automatically hide the taskbar" switched on, a system setting only Victor may change; he chose to skip it today. |

Platform-independent re-checks:

| item | outcome |
| --- | --- |
| M2 (no QA row): a bubble arriving or clearing mid-drag | **pass** at Small and Large, mid-screen and at the right edge: the cursor-to-dog offset stayed constant; he stays where dropped. |
| 7.15c, overlay renderer killed | **pass**: back in ~0.75 s three times, click-through intact, pettable; the fourth kill logs `renderer died again; not reloading again this run`. Known and already fixed on the Mac: after the fourth kill the hover card stays up over the empty spot (plus one `Render frame was disposed` error). Killing the panel renderer: the card comes back by itself. |
| Two sessions blocked | **pass**: answering one leaves the other's `… waiting` up (Codex and Claude sources); answering the second clears it. A pet drops the bubble while both rows still read "waiting" (owner decision 12). |
| Hooks re-installed | **pass from Git Bash**: both files re-installed from the tray with the new command, 4 Walder entries each, everything else identical; the installed command, read back and run under Git Bash, gave `Claude done`. **WSL: out** — WSL is not installed here, and it is not a supported path: on Windows Walder writes only the PowerShell command into the Windows-side files, never a WSL home. Codex needs `/hooks` trust again (owner). |

## 4. Job 2 — every screen

100 %: files in `C:\Users\Victor\Walder-qa\2026-11-audit\100\` (packaged build: `…\pkg\`).
**125 %: not done for any screen** — the scale is a system setting, and Victor chose to skip it.

| screen | file(s) | 100 % | 125 % |
| --- | --- | --- | --- |
| Dog, Small/Medium/Large, standing and lying, corner and mid-screen | `dog-<S\|M\|L>-<stand\|lie>-<corner\|mid>.png` (12) | pass — crisp, wholly on the work area, 16 px above the taskbar line | not done |
| Hover card Large / Medium / Small | `card-L.png`, `card-M.png`, `card-S.png` | pass (dev build; SESSIONS row present on Large) — Small had D9, fixed and re-checked (`D2-*-first.png`) | not done |
| Card at the right and left screen edge | `card-L-right-edge.png`, `card-L-left-edge.png` | pass — flips to the right at the left edge | not done |
| Usage bark, `… waiting` with `?`, `… done`, Small and Large, mid-screen and right edge | `bubble-<S\|L>-<bark\|waiting\|done>-<mid\|edge>.png` (12) | pass — bubble on screen at the edge, `?` crisp. Note: at Large, dragged as far right as the drag rule allows, the `?`'s last 3 px column is off screen | not done |
| Tray menu and every submenu | `tray-main.png`, `tray-sub-*.png` | pass — full transcription in `notes-A2.md`; order matches the checklist; Restart above Quit. Packaged (`pkg\pkg-tray.png`): Launch at login is a normal item; Developer holds only the log items | not done |
| Countdowns fresh on each open | `tray-countdown-1..4.png`, `tray-update-countdown-1..3.png` | pass — 57 → 43 → 23 → plain, by left-click, right-click and from the dog | not done |
| Restart | `restart-*.png`, `pkg\pkg-restart-*.png` | **packaged: pass, twice** — exactly one new main process each time, port 47811 bound again, one dog, one bone. Dev build: one new process but no dog (see 5) | not done |
| Login windows | `login-claude.png`, `login-chatgpt.png` | pass — 480 × 720, framed, on screen. The ChatGPT window closes itself in 1–2 s because that session is already logged in | not done |
| Hook dialogs (open, Cancel) | `hooks-claude-install.png`, `hooks-claude-remove.png`, `hooks-codex-install.png`, `hooks-codex-remove.png` | pass — texts verbatim in `notes-A3.md`; see 5 for two findings | not done |
| Report a bug | `report-bug.png`, `report-bug-bubble.png`, `report-bug-clipboard.txt` | pass — "Diagnostics copied to clipboard"; versions and settings only, no numbers or tokens (the log path carries the Windows user name) | not done |
| Check for updates | `updates-1.png`, `updates-2.png` | pass — "You're up to date", shown only after the bubble before it was petted away (X9, recorded) | not done |
| Gallery | `gallery-1..14.png` | pass — crisp, all 26 cards labelled, play once, grid and coat switcher work | not done |

## 5. Found on the way, not fixed (for Victor)

1. **Hook dialogs can sink behind another window, and then swallow the other hook items.** They have
   no parent window. With one open behind another app, a click on any other hook item does nothing
   visible (log: `a hook dialog is already open; not opening another`). The "no parent" part is
   Windows only: on macOS they hang off a host window (`src/main/dialog-host.ts`, since 0.2.8), but
   that host is an ordinary window and can sink the same way. Seen on Windows.
2. **The confirm dialogs' default button is Install / Remove.** A stray Enter installs or removes.
   During this pass a Codex install went through although Cancel was clicked (most likely exactly
   that); the file was restored from Walder's own backup at once.
3. **Restart in the dev build leaves no dog**: the relaunched process outlives the dev server its
   pages load from. Tray still works. Dev only: the packaged build restarts cleanly.
4. **A Windows Firewall prompt** for the dev `electron.exe` appeared the first time the Claude login
   window opened (Victor chose Allow). The packaged build raised none.
5. **After an overlay renderer reload a `… done` keeps its bubble but loses the perk pose.**
6. **Reset position with a bubble up** keeps the widened window: at Small the window ends 30 px past
   the screen edge and "Claude Code logged out" re-wraps to two lines.
7. **A stale deferred bark**: after petting away a held `?`, "Claude 5h: 96 % used" came up although
   a poll had since replaced that value (from an injection here; X4-adjacent).
8. **Medium card**: two "Tokens today" rows, the second (Codex) has no service label.
9. **SESSIONS rows grow the card without a cap** (10 test sessions → 380 × 626).
10. **The tray's "hooks: installed (port N)"** does not tell an old command from a new one, so
    nothing prompts a re-install for W3.
11. `claude-renew.ts` on Windows still lists `\opt\homebrew\bin\claude` and `\usr\local\bin\claude`
    (no `.exe`), against its "claude.exe only" comment. Harmless: a file there would fail to spawn
    and be caught. After renewal is off, a later Renew click logs no outcome line.
12. Wording: the hook dialogs say the hooks fire "when … finishes a reply or waits for you"; they
    also fire on every prompt and after every tool call.
13. In the dev build "Launch at login (packaged app only)" is greyed but ticked.

Looked at and by design: a Size change at the corner leaves the Large *window* 24 px past the screen
edge while his drawn body stays on screen (the clamp measures ink); the bubble floats above a lying
dog (X5); the card is translucent (X3).

## 6. For the Mac side to re-check

- **D9** is platform-independent: Card size change with the card hidden, then the first hover, at
  every size; the macOS pre-show still works.
- **W3** changed only the win32 branch of `hookCommand`; the curl branch is byte-identical.
- **M5 / M3** add optional fields to the active-window report; macOS reports carry neither.
- Items 1, 2, 5, 6, 7 and 9 of section 5 are platform-independent.
- `docs/QA-CHECKLIST.md`, `docs/DECISIONS.md`, `docs/hooks.md` and `docs/troubleshooting.md` have
  Windows edits that will meet the Mac session's uncommitted edits.

## 7. Not done, and the owner list

Not done:

1. **Nothing at 125 %.** Every screen in section 4, D9's shadow at a fractional scale, and M3's
   single-display check (a fullscreen film at 125 % must still put him to sleep now that the helper
   reports physical pixels: `fullscreen entered` in the log). The scale is a system setting.
2. **W6**: needs the taskbar on auto-hide (system setting). Then maximise an ordinary window and see
   whether the log says `fullscreen entered`.
3. **M3 on a mixed-scale pair of monitors**: no second monitor here.
4. **F4** on screen (no honest route), and a **successful** Claude login renewal with the native
   `claude.exe` (the standalone CLI has no login on this PC).
5. **WSL**: not installed.
6. QA rows 7.15a (B4, a cleared `?` or done leaves no pose) and 7.15b (B7, Still mode) were not run
   on Windows; the brief did not ask for them.

For one sitting with Victor:

- Set 125 %, then: the dog at three sizes, the three cards, a bark / `?` / done at the right edge,
  the tray menu, a fullscreen video (M3). Set auto-hide and do W6. Set both back.
- Codex: run `codex`, type `/hooks`, trust Walder's four entries again (the hook command changed).
- If wanted: `claude` ▸ `/login` in a terminal, then Developer ▸ Renew Claude Code login now.
- Decide on section 5, items 1 and 2 (hook dialogs: give them a parent, and make Cancel the default?).
- Release notes for the next version need: the Windows hook command changed, choose
  **Install … hooks…** again to get non-English folder names right; the dog no longer wakes when the
  Start menu, the tray overflow, Alt+Tab or Widgets opens over a fullscreen video.

State this PC was left in:

- **Installed and running: the branch build** (still labelled 0.2.9, built from this tree), not the
  published 0.2.9. Launch at login unticked and no Run value, as found. Settings and logins intact.
- **Both hook files were re-installed** with the new command (`~/.claude/settings.json`,
  `~/.codex/hooks.json`); Walder's dated backups sit beside them, and copies from before are in
  `2026-11-audit\backup\hooks-before\`.
- Windows Firewall now has an Allow rule for the dev `node_modules\electron\dist\electron.exe`
  (Victor's answer to the prompt).
- A backup of the real `%APPDATA%\walder` from the morning is in `2026-11-audit\backup\real\`.
- Git worktrees left for inspection: `C:\Users\Victor\Walder-qa\wt-audit-W3`, `-M3`, `-M5`, `-int`,
  `-D2`, `-M5b` (all detached at `2322108`, nothing committed). Remove with `git worktree remove`.
- Stray input during the pass, none of it typed text: three Esc keys opened the Claude app's Rewind
  dialog (closed, nothing chosen); a few clicks landed in the Claude app's window; Windows Search
  was opened once and closed.

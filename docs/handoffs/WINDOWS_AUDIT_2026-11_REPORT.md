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
not tested (Victor's call on 2026-11-14 to skip both; section 7). Committed and pushed as `1d7a16e`.
The owner-decided changes of 2026-11-14 (`a5435fb`) were looked at on 2026-11-15 at 100 %: section 8,
with the fix for the size-change flash found there; not yet committed. On 2026-11-16 `b90aae4` was
checked at 100 % and, for the first time, at 125 % with the taskbar on auto-hide: section 9. That
pass shows the flash fix is not sufficient, W6 is real, and three new faults at 125 %. The same day
the flash fix was reworked and W6 fixed, both checked on screen at 100 % and 125 %: section 10.
Uncommitted.**

**Update 2026-11-18:** the fixes are in `main` (`91448fc` W6, `1b14227` the Size-change blank,
`83d8564` the inside-screen clamp) and shipped in 0.3.0. The 125 % drag growth and drift (section 11)
are still open; open items now live in [`docs/OPEN_ITEMS.md`](../OPEN_ITEMS.md).

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
   a poll had since replaced that value (from an injection here; X4-adjacent). Since X4
   (2026-11-14) a window reset drops such a deferred bark and leaves the `?` up; a lower reading in
   the same window still keeps it, by design.
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

## 8. The owner's decisions of 2026-11-14, on screen (2026-11-15, 00:30–01:30)

Tree: `audit-2026-11` at `a5435fb`, dev build, one 1920 × 1200 display at 100 %. Nothing was fixed during
the six-row pass; the one fix that followed, on Victor's yes, is under the table. Evidence: `C:\Users\Victor\Walder-qa\2026-11-audit\owner\` (`notes-owner.md`,
screenshots named by row, `burst\`, `c-seq\`, `d-seq\`; an independent re-measurement of the same
files is in `owner\verify\`). Gate logs: `2026-11-audit\gates-owner\`.

Gates first, each by its own exit code: `npm ci` 0, typecheck 0, `npm test` 0 (84 files, 2815 passed,
9 skipped), build 0. `dist:win` was not run (not asked; the rows were checked on the dev build).
`git pull` printed `failed to delete '.git/worktrees/wt-*': Permission denied` for 14 old worktree
entries; the fast-forward itself went through.

| row | decision | verdict | what was seen | files |
| --- | --- | --- | --- | --- |
| 3.3 | X1 | **partly as found, pass after the fix below** — the edges hold; "without jumping" did not | Right half (dropped at 1400,600): window right edge 1488 and bottom 720 at Small, Medium, Large and back. Left half (400,600): left edge 400 and bottom 720 at every size. The side is decided at the drop: dropped at 1000,600, Large's centre is on the left half, yet Medium and Small kept right edge 1088. **But every size change shows a wrong picture for a moment**: growing, the old-size sprite is drawn at the top-left of the already-grown window (Small→Medium 78 px higher, on the right half also 88 px left; Medium→Large 76 px higher); Large→Small shows one frame without the dog. 6 of 6 captured changes, 1–2 screenshots each (frames 40–80 ms apart, so the length is somewhere between a few ms and under 200 ms). See below. | `3.3-R-*.png`, `3.3-L-*.png`, `3.3-side-*.png`, `3.3-*-frame*.png`, `burst\3.3-*`, `verify\3.3-*-montage.png` |
| 3.3a | X1 | **pass** | Home window: Small 1816,1016 88 × 120; Medium 1728,938 176 × 198; Large 1640,862 264 × 274 — right edge 1904 and bottom 1136 at every size, 16 px in from the screen edge and the work-area bottom. The 16 px is the window's; the ink's right edge is 27 / 38 / 49 px in, its bottom 16 px. S→L→S, S→M→S, M→L→M each end on the start rect, sprite pixel-identical. Reset position at each size moves nothing. Quit at Large and relaunch: Large at 1640,862, then back to Small lands on 1816,1016. | `3.3a-*.png` |
| 4.7a | F2 | **partly** — readable by eye; the grey lines measure under 4.5:1; no stale line seen | Over a flat black window every line is easy to read at Card size Large, Medium and Small. Measured on the screenshots: the card over black is rgb 206,202,195; percentages are exactly #794c14 (4.50:1 against that); the grey lines' darkest pixels are 94–103 per channel, lighter than the #5a5550 token, giving 3.65:1 (SESSIONS header) to 4.24:1; over white the same lines are about 6.2:1 and percentages 6.9:1. Bars unchanged (red 224,65,63 and empty 61,59,71, the same as in `100\card-L.png`). **A stale line could not be produced honestly** (no reading went stale during the pass), so the dark red is not checked. Only flat black was tested; the card is about 82 % opaque and bright content behind it shows through. Also seen: the dashed separators (207,200,187) vanish over black (1.02:1). | `4.7a-black-L/M/S*.png`, `4.7a-white-L*.png`, `verify\b-*.png` |
| 5.7f | X4 | **pass**, one sub-step thinly evidenced | (a) 91 % bark up; 45 % injected 88.6 s later: the bark went without a click. (b) 91 %, then 82 % 9 s later: the bark stayed — but the 82 % left no log line and no trace on screen, so this shows only that nothing cleared the bark. (c) Hide when idle on: he came with the 91 % bark; 45 % 78 s later cleared it and he left 8.01 s after that. (d) `Codex waiting` + `?` up, 91 % (nothing new shows), 45 % 77.6 s later: `?` still up; the pet cleared the wait and no 91 % bark came (watched 16 s; the pet's own refresh brought `Claude Code logged out`, since Claude is logged out on this PC, and the resting `?` of that state). Control: 45 % only 7 s after the 91 %, then the pet: `Claude 5h: 91% used` came up at once. An inject stamps the reset as now + 5 h and a reset counts as moved past 60 s, hence the timings. | `5.7f-a*.png` … `5.7f-e*.png`, `c-seq\`, `d-seq\` |
| 5.9h2 | X2 | **pass** | Size Small, Card size Large, `Claude 5h: 91% used` up: on 6 of 6 hovers the bubble's border, fill and text are drawn over the card's right border (identical pixels each time). Card shown under an existing bubble: 45-frame burst, the card fades in and never disappears, the bubble is on top in every frame. Card up first, then `Codex waiting` arrives: on top from the frame it appears, card never hidden. Card size Small, 5 hovers: on top (the overlap there is only a few px of border). Left half, card flipped right: the bark runs over the card's left border, on top. Typing: 40 characters typed into a test window while the mouse showed the card three times all arrived, and the window never lost focus (a plain test window, not Notepad, which would have restored Victor's tabs). Clicks in the transparent part of his window and just outside it reached the window behind, with and without the card. Caveat: a synthetic click that jumps from the dog to the spot and clicks in the same instant was swallowed 2 of 3 times; a move followed by a click always landed. | `5.9h2-*.png`, `burst\5.9h2-*`, `textbox.log`, `5.9h2-foreground.log` |
| 7.1a | X11 | **pass** (re-install case) | Both dialogs read "This writes Walder's four entries to" and the file path (`.claude\settings.json`, `.codex\hooks.json`). Both cancelled with the mouse; both files kept time, size and hash, no new backup. The first-install case was not put on screen: the text is one string in `src/main/index.ts` with no branch on it, and seeing it would have meant removing the hooks. | `7.1a-claude-dialog*.png`, `7.1a-codex-dialog*.png`, `7.1a-files-*.txt` |

**The 3.3 transient (found here; fixed afterwards, next paragraph).** The wrong frame is the previous picture, unscaled, at
the new window's origin: `resize()` calls `win.setBounds` (`src/main/overlay-window.ts:775`) before
the renderer has been told the new scale (`src/main/tray.ts:598–599`) or has painted at the new
size. By the code this is **not new in `a5435fb`**: the sequence is the same in 0.2.9 (`6e1e145`),
and under the old bottom-left anchor the old sprite would likewise have shown 76–78 px too high for
a frame. What X1 adds is the sideways part on the right half (88 px left per step). It was not put
on screen with 0.2.9; the earlier 3.3 passes were stills taken after each change, so they never
tested this. The same family as F15 (stale paint for < 50 ms on appearing from hidden,
`docs/QA-CHECKLIST.md`). Bubble widenings go through the same `resize()`; not measured. Seen on the
dev build, one capture per change, 100 % only. A fix would be: hide him across the gap
(`setOpacity(0)` before `setBounds` on a scale change, back on the renderer's first paint at the new
size, with a timeout fallback). That gives a short blank instead of a displaced dog, needs either a
new "painted" message through `ipc-bridge.ts` (the Mac session's file) or a guessed timer, and would
want a look on the Mac too. Reordering alone cannot remove it on a grow.

**The fix (2026-11-15, on Victor's "Yes, fix it"; uncommitted).** On Windows, on a Size change only,
the window goes transparent (`setOpacity(0)`) just before `setBounds` and opaque again when the
renderer reports a paint at the new scale and the new viewport, two frames after drawing it; 300 ms
at most. macOS and Linux make no opacity call. Box changes and bubble widenings are left alone. The
answer reuses `overlay:painted`, so `ipc-bridge.ts` and `tray.ts` are untouched; main counts one
answer owed per change. Files: new `src/core/size-change.ts`, `src/main/overlay-window.ts`
(`hideForSizeChange`, `SIZE_REVEAL_GRACE_MS`), `src/main/ipc.ts`, `src/preload/index.ts` and
`index.d.ts`, `src/renderer/overlay.ts`. Tests: `test/overlay-window.test.ts` 'a size change on
Windows hides the gap' (24), new `test/size-change.test.ts` (31), `test/preload.test.ts`; the older
overlay tests are pinned to one platform so they run the same on every host. Written in a detached
worktree, reviewed twice from two angles (races; tests and rules), one should-fix repaired (the
renderer half of the handshake had no test). Docs: `docs/DECISIONS.md` (2026-11-15),
`docs/QA-CHECKLIST.md` row 3.3 note. Gates on the patched tree, by exit code: typecheck 0, `npm test`
0 (85 files, 2874 passed, 9 skipped), build 0 (`gates-x1flash\`). Patch as reviewed:
`2026-11-audit\patches\X1flash.patch`; worktree `C:\Users\Victor\Walder-qa\wt-audit-X1flash`.

On screen (dev build, 100 %, 10:44–11:01; `owner\fix\`, `notes-fix.md`, `burst\`): 24 bursts at one
frame per 17 ms, every change on both halves twice. No displaced, wrong-size, partial or translucent
frame in any of them; each change is old size in place, 2–3 empty frames (17–69 ms), new size in
place. Every reveal came from the renderer's answer, 37–51 ms after the resize; the 300 ms fallback
never ran (35 reveals, 0 fallbacks). End positions as in the table. After it: he is pixel-identical
to the unpatched shots at all three sizes, clicks beside him pass through, a click on him pets, the
card and the bubble order are as before, a drag works, a Size change while hidden by Hide when idle
shows nothing and he later appears at the new size in place, a Size change with a bark up is clean,
and after a killed renderer he comes back visible and the next change still reveals by the answer.
It is a blink of the dog, not nothing. Not checked: 125 %, the packaged build, macOS (no opacity
call is made there), a Size pick within the first half second after launch (the one early reveal
left, see DECISIONS).

Left open by the fix, for Victor and the Mac side: every Size change now also writes the verbose
line `overlay painted its first frame`, because the answer arrives through that handler
(`src/main/ipc-bridge.ts:318`, not edited here). Harmless, but the line no longer means "started".
On appearing from hidden he fades in over about 100 ms; the same without the fix (control run).

Also seen in this pass:

- Reset position with a bubble up still leaves the window 30 px past the right edge and re-wraps the
  bubble (section 5 item 6; `TD-reset-with-bubble.png`). The 196 px bark window at home likewise
  reaches 38 px past the edge, though the bubble itself is drawn up to the last column.
- A drop at the bottom-left saved y 1012, 20 px above the work-area bottom, not 16.
- The Codex install dialog's default button is still Install (section 5 item 2).
- Stray input: one AutoHotkey error dialog (closed by mouse, nothing typed); one click that missed
  the dog and landed on an empty part of the Claude app's sidebar. The subagent also reports a
  message reading `commit` appearing in the other Claude session's window ("Walder full platform
  audit") between 01:15 and 01:16 that it did not type; its own typing log holds only the
  40-character test string.

State of the PC afterwards: dev build quit from the tray; the installed Walder (the build from
section 7) relaunched through Explorer and running; dev settings back as found (Small, card Large,
Hide when idle off, home position); both hook files untouched; nothing committed. The same holds
after the fix's on-screen check at 11:01.

## 9. `b90aae4` on screen, 100 % and 125 % (2026-11-16, 10:44–11:55)

Asked for by Victor through the Mac session. Head `b90aae4` (fast-forward from `a5435fb`), with the
uncommitted flash fix of section 8 on top in the main checkout. Dev build; Windows 11, one
1920 × 1200 display. Evidence: `2026-11-audit\b90aae4\` (`notes-b90aae4.md`, `burst\`) and
`b90aae4\125\` (`notes-125.md`); gate logs in `gates-b90aae4\`. No usage value is written anywhere.
Nothing in `src/` or `test/` was changed in this pass.

**Gates, by exit code.** Clean `b90aae4` (worktree `C:\Users\Victor\Walder-qa\wt-b90aae4`):
typecheck 0, `npm test` 0 (84 files, 2815 passed, 10 skipped), build 0. `b90aae4` + flash fix:
typecheck 0, `npm test` 0 (85 files, 2875 passed, 9 skipped), build 0. `npm ci` was not needed
(the lockfile did not change).

**At 100 %.**

| row | verdict | why | files |
|---|---|---|---|
| 3.3 (X1) | **fail** | The screen-side edge and the bottom hold on both halves. But on 7 of 8 grows one or two frames show the old-size dog out of place, 20–30 ms *after* the reveal; shrinks are clean. The blank is 4–6 frames today (2–3 on 2026-11-15), hide → reveal 46–70 ms, fallback never used. The fix of section 8 narrows the race and does not close it; its 24 clean bursts were luck of timing. | `A-displaced-montage.png`, `burst\R1-*`, `L1-*`, `L2-*` |
| 3.3a (X1) | pass | Three round trips end on the starting pixel; home 16 px from the right edge and the work-area bottom at every size; home after quit and relaunch. | `B-*.png` |
| 4.7a (F2) | pass | Over black, grey lines and percentages are easy to read at all three card sizes; percentages are `#794c14`. No stale line producible. | `C-black-card*.png` |
| 5.7f (X4) | pass | 91 % then a low reading 81 s later: bark gone without a click. A lower reading 9 s later: bark stays. With Hide when idle he leaves 8.02 s after. A 91 % held behind `Codex waiting` is dropped and the `?` stays. | `D-*.png` |
| 5.9h2 (X2) | pass | Size Small, card Large: bubble over the card's edge on 4 of 4 re-shows; no card-less frame; 40 typed characters all arrive; six clicks beside him reach the window behind. | `E-*.png`, `textbox.log` |
| 7.1a (X11) | pass | Both dialogs say "This writes Walder's four entries to"; both cancelled, both files unchanged by hash. Re-install case only. | `F-*.png` |
| zero cap (`isZeroCap`) | partly | After the first poll the card has no "Codex credit limit" row and no other spend-limit or extra-usage row. Before the first poll cannot be seen: every first poll had finished before the overlay's first frame. The snapshot restored at launch (written by the installed, older build) does hold such a bucket (presence only). | `G-*.png` |

**At 125 %, taskbar on auto-hide** (both set by Victor; read back as 120 DPI and auto-hide on; work
area = the whole screen, 1536 × 960 DIP).

| item | verdict | why | files |
|---|---|---|---|
| dog at three sizes | partly | Crisp, whole device pixels (Small 1×, Medium 3×, Large 4×; so Small is no bigger than at 100 %). Home at launch exact. But he creeps down 1–4 DIP with size changes, sleep/wake and bubbles, and then one row of the Small sprite is cut. | `1-*.png`, `x-S-*` |
| cards, D9 shadow | pass | All three sizes: layout intact, nothing clipped, shadow clean, card on screen. | `2-card-*` |
| bubbles at the right edge | pass | 91 % bark, `Codex done`, `Codex waiting` with `?`: all fully on screen. | `3-*` |
| menu | partly | Opens and reads well; Size works. It is taller than the screen: Reset position, Restart and Quit need the scroll arrow (installed build too). | `4-*`, `S1-*`, `TD-*` |
| 3.3 / 3.3a | **fail** | The flash fix's answer often never comes: 9 changes fell back (`size change: no answer from the renderer; revealing anyway`), a 300 ms blank. With an answer a displaced frame can still show. The side edge holds; the bottom creeps 1–2 DIP per change, so round trips do not come home (y 824 → 827 → 829). | `burst\5-*`, `5a-*` |
| M3, one display | pass | A borderless full-display window: `fullscreen entered`, he sleeps; closing it: `fullscreen left`, he wakes. | `6-*` |
| **W6** | **real** | A maximised ordinary window in front, taskbar hidden: `fullscreen entered` within about 4 s and he sleeps; he stays asleep while the taskbar is revealed, under it. Victor's own maximised Claude window did the same unprompted. A maximised Explorer window does not (it is on the helper's ignore list). | `7-maxwin-*` |

**New findings, none fixed** (each needs a decision or a measurement first):

1. **The flash fix (section 8) is not good enough to commit as it is.** 100 %: displaced frame after
   the reveal on grows. 125 %: no answer on many changes. Unproven guesses: Windows shows the stale
   surface for a frame after the window turns opaque; and at 125 % the viewport the renderer sees
   differs from the size main sent by more than the 1 px slack. A sturdier design would blank the
   picture in the renderer *before* the resize, so a stale frame has nothing in it.
2. **W6 is real** (low in the audit): with an auto-hide taskbar every maximised window counts as
   fullscreen, so with Sleep during fullscreen on he sleeps most of the day.
3. **125 %: his vertical position drifts** 1–4 DIP (size changes, sleep/wake, bubbles); the Small
   window took odd physical sizes after drags (140 × 175, 110 × 182 instead of 110 × 150); a purely
   horizontal drag moved him 27 DIP down. Not looked for on the unpatched build, so whether the flash
   fix plays a part is open.
4. **125 %: the menu is taller than the screen.**
5. Harness only: the dev build's `walder.log` rotated at 1 MB mid-pass and the virtualised view then
   showed a different file.

Still open: the row before the first poll for the zero-cap change; M3 on two monitors of different
scale (no second monitor); F4 (no honest route); the stale line of 4.7a; the Codex `/hooks` trust.

Accident: at 11:34 a helper clicked four times into a blank part of the right-hand Claude
conversation pane; nothing was typed and nothing changed. The helper now finds the menu first.

State of the PC: dev build quit; installed Walder (the older build) relaunched and running; dev
settings as found, plus one new saved position for the 125 % display key. Display scale and taskbar
auto-hide were left as Victor set them, for him to set back. A stash
`x1flash-fix-before-b90aae4` holds a copy of the flash fix as it was before the pull.

## 10. The flash fix reworked, and W6 fixed (2026-11-16, 12:20–22:40)

Two separate sets of changes on top of `b90aae4`, both in the main checkout, both uncommitted, each
with its own patch so one can be taken without the other. Gates on the tree with both, by exit code:
typecheck 0, `npm test` 0 (85 files, 3061 passed, 9 skipped), build 0.

### 10.1 The size-change flash, reworked (Victor: "Yes, rework it")

The opacity design of section 8 is gone; nothing of it was ever committed. Now, on Windows and on a
Size change only: main asks the renderer to paint nothing, waits for its report (200 ms at most,
then resizes anyway), resizes, and the renderer keeps painting nothing until it paints at the new
scale and a viewport nearer the new size than the old (500 ms at most). The stale frame Windows
shows after a resize is therefore empty. No `setOpacity` anywhere. The report has its own channel
(`walder:size:report`), handled on the overlay's own `webContents.ipc`, so `ipc-bridge.ts` and
`tray.ts` are untouched and `overlay painted its first frame` is written once, at launch.

Files: `src/core/size-change.ts` (rewritten), `src/main/overlay-window.ts` (`flushSizeChange`,
`followSizeChange`), `src/main/ipc.ts`, `src/preload/index.ts`, `index.d.ts`,
`src/renderer/overlay.ts`; tests `test/size-change.test.ts`, `test/overlay-window.test.ts` 'a size
change on Windows waits for a blank picture', `test/preload.test.ts`. Three designs, a judge, one
implementer, three review lenses; four findings repaired (a bubble or box change right after the
resize defeated the match rule; an untested line; a test that did not assert what it said; a comment
that stated a guess as fact). Patch: `2026-11-audit\patches\X1flash2.patch`; worktree
`C:\Users\Victor\Walder-qa\wt-flash2`.

On screen (`b90aae4\flash2\`, `b90aae4\w6fix\`, `b90aae4\125-fixes\`):

| scale | captured changes | displaced / wrong-size / partial | empty frames | pick → resized | resized → shown |
|---|---|---|---|---|---|
| 100 %, run 1 | 24 (+ 6 in side-effect tests) | 0 | 2–7, mostly 3 | 32–132 ms | 3–17 ms |
| 100 %, run 2 | 12 | 0 | 2–4 | 35–41 ms | 3–14 ms |
| 125 % | 24 | 0 | 2–3 | 36–45 ms | 3–17 ms |

Every one of the 90 or so size changes logged was resized on the renderer's answer and shown as
"matched"; neither time limit ever ran. At 125 % Windows grants 1–2 DIP more height than asked
(Small 88 × 121–122 for 88 × 120), which is what starved the old fix of its answer; the new match
rule does not need the sizes to agree. Side effects at 100 %, all as they should be: click-through
and petting right after a change, the hover card, a change with a bark up, a bubble landing during
the wait, two picks six seconds apart, a change while hidden by Hide when idle, a drag, a killed
renderer, quit just after a pick and relaunch. Not exercised: a bark arriving just *after* a pick.
Rows 3.3 passes at both scales on this code. Yesterday's fix also passed its first 24 captures and
failed the next day, so this result rests on three runs at two scales, not one.

### 10.2 W6: a maximised window is not fullscreen

Measured with the taskbar on auto-hide, with a probe that makes the same calls as
`fullscreen-win.ps1` (`b90aae4\w6\`, `w6probe.ps1`, `probe-raw*.txt`). Physical pixels; display and
work area 0,0–1920,1200 at both scales; overhang = how far the window sticks out past each edge.

| window | 125 %: rect, overhang | 100 %: rect, overhang | state |
|---|---|---|---|
| Notepad maximised (taskbar hidden or revealed: identical) | −9,−9–1929,1209 · 9/9/9/9 | −8,−8–1928,1208 · 8/8/8/8 | zoomed, caption, thick frame |
| WinForms window maximised | −10,−10–1930,1210 · 10/10/10/10 | 8/8/8/8 | same |
| Claude app maximised (Chromium, own frame) | −8,−8–1928,1208 · 8/8/8/8 | 8/8/8/8 | same |
| Electron window maximised, framed and `frame:false` | 9/9/9/9 | 8/8/8/8 | same |
| borderless film | 0,0–1920,1200 · 0/0/0/0 | 0/0/0/0 | not zoomed, no caption |
| Electron HTML element fullscreen | 0/0/0/0 | 0/0/0/0 | no caption |
| Electron `setFullScreen(true)` from restored | 0/0/0/0 | 0/0/0/0 | no caption |
| restored window that is exactly display-sized | 0/0/0/0 | 0/0/0/0 | caption, not zoomed |

The DWM frame of every maximised window is exactly the display. Electron reports the display as
0,0 1536 × 960 DIP at 125 % (from the log; the physical rect and factor 1.25 are derived). A browser
was not measured: the throwaway Edge profile signed itself into Victor's work account, so it was
closed untouched and its folder deleted on his word; a scratch Electron window stood in for the
Chromium path. `setFullScreen` straight from maximised left the window at its old restored size at
both scales (an Electron oddity; not fullscreen under any rule).

The rule: a window that covers the display and sticks out past **all four** edges by at least 3 (in
the DIPs the decision sees: 8 at 100 %, 6–8 at 125 %, 4–8 reckoned at 150–200 %) is maximised, not
fullscreen. `src/core/fullscreen.ts` (`MAXIMISED_OVERHANG_MIN_PX`, `overhangsEveryEdge`, one changed
line in `windowCoversAnyDisplay`); 48 tests in `test/fullscreen.test.ts`, `test/win-dpi.test.ts`,
`test/fullscreen-watch.test.ts`, 29 of which fail without the fix; no existing test changed its
verdict. Two review lenses, no finding. Patch: `patches\W6-final.patch`; worktree `wt-w6`. The
display-sized restored window still reads as fullscreen (accepted, commented).

On screen with the fix, Sleep during fullscreen on:

| case | 100 % | 125 % |
|---|---|---|
| Notepad maximised, taskbar hidden / revealed | no `fullscreen entered`, he stays up | same |
| WinForms window maximised | stays up | stays up |
| Victor's Claude window maximised (observed only) | stays up | not in front during the run |
| film | `fullscreen entered`, sleeps; closed: wakes | same |
| film, then maximised Notepad in front | `fullscreen left` after about 3 s | wakes |
| Start over the film (M5) | held, no wake in 14 s | not run |

The scratch Electron window says nothing here: its process is called `electron`, and the dev build
holds every such window as itself.

### 10.3 The 125 % position drift is older than both fixes

Control on clean `b90aae4` (`125-fixes\drift-control.txt` against `drift-fixes.txt`): the same steps
give the same window rects pixel for pixel. From home (bottom at 944 DIP) he sinks about 1–3 DIP per
size change, 2 per sleep/wake and per bubble shown or cleared, and a purely horizontal drag of
250 px moved him 45 DIP down and left the window oversized (210 × 244 DIP for Small). After the
first Large → Small the Small sprite shows 63 of its 65 rows. Reset position plus a Size change
brings him home. Not fixed: the cause is not yet known (Windows granting 1–2 DIP more height than
asked at 125 % is the likely start). Nothing like it at 100 %.

### 10.4 Left open

- The 125 % drift and the drag jump (10.3), and the menu taller than the screen at 125 %.
- W6 on a second monitor without a taskbar, and M3 on a mixed-scale pair: no second monitor.
- A real browser's F11 and video fullscreen under the W6 rule (reckoned from the Electron path).
- The zero-cap row before the first poll; F4; the stale line of 4.7a; Codex `/hooks` trust.
- The Mac side should look at both changes; neither makes any call on macOS that it did not before.

Accidents in these passes, none with an effect: one stray left click and one stray right click on
Victor's Claude window (blank areas, nothing typed), and one menu left open after a refused click.
The old tray helper that caused the first is retired; every click now checks the window under the
cursor first. A low-battery dialog stopped one pass until Victor plugged the PC in.

State of the PC at 22:40: dev builds quit, installed Walder (the older build) running, dev settings
as found, display at 125 % with taskbar auto-hide on for Victor to set back. Worktrees left:
`wt-b90aae4`, `wt-flash2`, `wt-w6`, `wt-audit-X1flash`. The stash `x1flash-fix-before-b90aae4` holds
the abandoned opacity fix.

## 11. He can never be outside the screen (2026-11-16/17)

Victor, 2026-11-16: "walder can't move outside your screen, so it always stay inside your screen
borders, no exceptions, should also take multiple displays into account". His two decisions: inside
the *work area* (clear of the taskbar, Dock and menu bar), and he may stand across the seam of two
displays as long as every part of him is on some display.

A third set of changes, on top of the two of section 10, in the main checkout, uncommitted. Patch:
`2026-11-audit\patches\inside-screen.patch` (against flash rework + W6; worktree `wt-inside`). Gates
on the tree with all three, by exit code: typecheck 0, `npm test` 0 (85 files, 3193 passed,
10 skipped), build 0.

**The rule.** Every part of his drawn ink is on the work area of some display at all times, however
his position was set or went stale: live drag (he stops flush and slides along the edge), drop,
launch from a saved position, Reset position, size, box and bubble changes, display added, removed,
rearranged or rescaled, a work-area change (taskbar moved or auto-hide toggled), show and wake. A
position already inside is never moved; otherwise he moves the shortest way. Where a taskbar strip
or a corner-only touch separates two work areas he stays on the near side until the far side is
nearer, then hops. Two fallbacks, as before: with no display reported nothing is touched, and ink
larger than every work area is pinned head-visible.

**How.** One clamp, `clampRectInsideWorkAreas`, now works on the union of the work areas
(`coveredByWorkAreas`; candidates on the grid of area edges, nearest wins) and replaces the lenient
`clampRectToWorkAreas` / `MIN_VISIBLE_PX` rule ("part of him always stays reachable", row 2.2) and
`clampToDisplays`. Every placement in main goes through it; there is no move or resize listener on
the window, so it cannot loop. Files: `src/core/geometry.ts`, `src/core/interaction.ts`,
`src/main/overlay-window.ts`, `src/main/store.ts`, `src/main/index.ts`, and four test files.
`ipc-bridge.ts` and `tray.ts` untouched. Map, design, one implementer, three review lenses; eight
findings, all repaired or pinned, each new test checked against a mutant.

**What it does not cure.** The 125 % drift of 10.3 is still there, cause unknown; the rule only stops
it at the edges. Pinned by tests as the code stands: after a long drag at 125 % he can stop short of
the *top* edge by as much as the window has grown, until the next resize (bark, sleep, size change);
up to 1 DIP over the bottom edge during a drag, corrected at the drop; after a size or box change
made at the bottom edge at 125 %, a relaunch can put him up to 2 DIP above it. A bubble with his
head flush at the top edge is clipped, as it was before.

**On screen at 125 %, taskbar on auto-hide (2026-11-17, `b90aae4inside`, `notes-inside.md`,
`measure.txt`).** Not yet seen at 100 %. Of 150 measurements none had ink outside the work area. On
clean `b90aae4` the same bottom-right drag took him wholly off screen and saved a position below
it; the rule prevents that.

| check | verdict | measured |
|---|---|---|
| drag past edges and corners | **fail** (ink inside) | The window grows on every drag step (Small 110 × 150 → 847 × 708 px in one drag; the same on clean `b90aae4`), so he stops 12–231 DIP short of the left, top and right edges and is not under the grab point on the way back. Bottom edge flush. No snap on release. |
| taskbar | pass (auto-hide) | Feet at the display edge. A shown taskbar was not possible. |
| saved position outside, relaunch | pass | Half off right, half off bottom, −5000/−5000, 9000/9000: he starts inside, bottom gap 0; 7–25 DIP in from the other edges. |
| Reset position | pass | 16 DIP from the bottom and right at every size, asleep and mid-bark (Medium 12.8 from the right). |
| size round trips | partly | Bursts at home and all four edges: no displaced frame. Bottom edge returns to the pixel. Home creeps 1.6–4 DIP per change; left and right end 12–16 DIP off; **at the top edge Small → Large → Small leaves him about 166 DIP lower.** |
| sleep/wake, bubbles | pass where done | Bottom edge: no hop. Bubbles readable left, right and bottom; clipped at the top edge (known). |
| hover card, Hide when idle | pass, top edge only | Card on screen; he came back 1–3 DIP off. |
| mid-screen | partly | Drag free, click-through and petting fine. Quit and relaunch not exact: 13 px left, 12 px down. |
| bottom edge at 125 % | pass | Bark, sleep, repeated size changes: bottom 0, no creep, no oscillation; flush after relaunch. |
| log | pass | No warning or error, no loop; one "moved back inside" line per action. |

So at 125 % the rule holds, and the older fault of 10.3 now has a name: the window grows while it is
dragged. That, not the rule, is what keeps him off the edges and moves him on a size change at the
top. Not done: sleep/wake and the card at the other edges; the full drag matrix. Accidents, all
undone: Still mode switched on by a misplaced menu click (off again within a minute), the OneDrive
flyout opened once, a Walder menu left open twice. PC left at 125 % with auto-hide on, installed
Walder running, dev settings as found.

Two displays cannot be seen on this PC at all: the seam, different heights, a taskbar strip on the
seam, mixed scale, unplugging.

**On screen at 100 %, taskbar on auto-hide (2026-11-17 morning, `b90aae4inside@`,
`notes-inside-100.md`, `measure.txt`, `rect-*.txt`).** Stopped early on Victor's word; the PC had
locked, and the dev build was ended and the installed Walder relaunched afterwards by hand.

| check | verdict | measured |
|---|---|---|
| drag, 3 sizes × 4 edges × 4 corners | pass | Stops flush, slides along the edge, no snap on release, back on the start rect at the grab point in 24 of 24 drags. No ink outside anywhere. At rest the sprite frame is on the edge; the ink is its transparent margin in (Small 3/7/3/0, Medium 6/14/6/0, Large 9/21/9/0 px left/top/right/bottom). |
| window size during a drag | stable | About 1000 readings per drag, bubbles and a drag right after a size change included: never changes. The growth of the 125 % pass does not happen at 100 %. |
| saved position outside, relaunch | pass | Six cases start inside, flush, nearest place. |
| Reset position | pass | 16 px from bottom and right at every size, asleep and mid-bark. |
| size round trips | **partly** | Home, left, right, bottom, bottom-right corner: back on the pixel; bursts show no displaced frame. **Top edge and top-left corner: Small → Large → Small ends 144 px lower, via Medium 72 px.** Whether that is new with the rule or older is not yet known. |
| sleep/wake at four edges | pass | Same pixel, no hop. |
| bubbles | partly | Readable at left, right, bottom. At the top edge the bubble is wholly off screen. |
| hover card, Hide when idle | partly | Card on screen at top, left and bottom. Hide and show at the top: same pixel. At the left edge he did not hide; not explained. Right not done. |

Not done at 100 %: the mid-screen regression checks, the log scan, a shown taskbar.

**The growing window: a fix written, not applied, not seen.** `patchesdrag-grow.patch` (on top of
the inside-screen patch, worktree `wt-inside`; gates there 0/0/0, 3209 tests passed): every move is
one `setBounds` restating the size main last asked for, and `setPosition` is never called. That
`setPosition` is the cause is a guess until it is run at 125 %.

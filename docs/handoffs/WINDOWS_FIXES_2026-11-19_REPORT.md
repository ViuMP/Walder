# Windows on-screen checks of `fixes-0.3.2` (2026-11-19)

Asked for by Victor through the Mac session; he authorised the whole brief at the PC and said the PC
was free. Branch under test: `fixes-0.3.2` at `da47341` (PR #36). Fixes are on
`win-fixes-2026-11-19`, based on it. Windows 11, one 1920 × 1200 display at **100 %**, taskbar shown
(work area 1920 × 1152). Evidence: `%USERPROFILE%\Walder-qa\2026-11-19-win-fixes\`, one folder per
row with a `notes.md`. No usage value is written anywhere.

**Gates, by exit code.** `fixes-0.3.2` at `da47341` after `npm ci`: typecheck 0, `npm test` 0
(103 files, 3580 passed, 13 skipped), build 0. `win-fixes-2026-11-19` with the two fixes: typecheck
0, `npm test` 0 (103 files, 3596 passed, 14 skipped), build 0.

## 1. What passed

| check | verdict | measured |
|---|---|---|
| 3.3b awake: top edge mid-width, both top corners, home | pass | Ink top 3 / 6 / 9 px at Small / Medium / Large (the same 3 sprite rows), he grows downwards, ends on the start pixel; at home he grows upwards and returns to 1816,1016. |
| 3.3c resting by ink | pass | Ink top 3 / 6 / 9 px against 7 / 14 / 21 on 2026-11-17: 4 / 8 / 12 px higher, sides unchanged. Pet hearts reach row 0 for 80–170 ms; whether anything is cut above row 0 cannot be seen in a screenshot. |
| 3.17 normal mode, on `da47341` | pass 6 of 6 | Card hides about 15 ms before the menu shows, back 256–290 ms after Esc. |
| 7.9b hook question in front | pass | Stays above Explorer; the second Install item logs `a hook dialog is already open; brought it forward`, no second box; clicks inside the 520 × 420 parent reach the window beneath; cancelled. After "brought it forward" its title bar stays grey. |
| 7.2a out-of-date hook command | pass, both | `installed (port N), out of date` and `Update … hooks…`; after Update back to `installed (port N)`. The confirm button reads "Install", not "Update". Both hook files byte-identical afterwards (SHA-256 compared). |
| 4.23a SESSIONS cap | pass | 6 sessions all listed; 9: five rows and `+4 more`; 10 with 2 waiting: the waiting ones first. Large card 380 × 476 throughout. |
| 12.1–12.7 languages | pass | All seven: a bark at Small on one line, the card at three sizes, the menu, both hook dialogs, all seven window pages. Not covered: the hook result box's OK (needs a real install), a card date (Reset times is on Countdown), the Copilot and Codex-credit rows in Spanish (services absent). Coat names stay English in every language. |
| 12.6a typography | pass | `91 %` with a no-break space in da, de, es, fr; `91%` in en, hi, zh. French: a space before every `:`; the U+202F before `?` in the hook dialog is a gap of about 3 px, narrower than a letter, no box. The bone menu has no `% ? ! ;` to judge. |
| 12.8, the parts needing no Windows setting | pass | A settings file with `"language": "ar"` opens as System; a language change waits for Restart and the page says so. |
| 3.5 / 3.6 Cream, Black and tan | pass | Only the coat changes. |
| 10.4, the part needing no Windows setting | pass | Dark and Light repaint the window at once; Light survives Restart. |
| audit §5 item 6 | pass | Reset position with a bubble up: 92 wide while it is up, home at 88 × 120 when it clears. |
| renewal search lists no Mac paths | pass, with a limit | 0 lines with `/opt/homebrew` or `/usr/local` in `walder.log` and the dev log. Claude Code is logged out on this PC, so the search itself never ran (`claude renewal: forced, but there is no Claude Code login to renew`), and it does not log the paths it tries. |
| system language before `ready` | pass | Electron 45.3.4: `app.getPreferredSystemLanguages()` returns `en-DK`, `en-US` before ready, the same as after. `getLocale()` is empty and `getSystemLocale()` throws before ready. |
| `dist:win` into a folder with a space | pass | From a clean worktree with a fresh `npm ci`: exit 0, installer and `win-unpacked` in `…\dist with space\`, `ok ..\dist with space\win-unpacked\resources\app.asar (win, 853 entries)`, no `release\` created. |
| that installer installs and starts | pass | No UAC or SmartScreen prompt; per-user upgrade; first frame logged, dog at home, tray icon present (tooltip "Walder"). Restart from the dog's menu brings back a visible dog. |

## 2. What failed, and what was done

**3.17, the card does not come back after Esc — fixed**. On `da47341`
5 of 10 Still-mode runs never showed the card again; every failure had a `hover:leave` about 30 ms
after `menu:open` that the pointer never made (seen in normal mode too). That leave drops the held
hover, so the release at menu close replays nothing, and with the pointer still nothing reads it
again. Fix: at menu close main sends the current cursor reading (`Overlay.resyncCursor`, called from
the `menuOpen` close callback), and the renderer's hold accepts a viewport one point off
(`cursorFitsViewport`). Why the stray leave is sent is not traced (the menu window opening under the
pointer is the guess). On screen with the fix: 10 of 10 in Still mode and 10 of 10 in normal mode
(252–282 ms), six of those runs with the stray leave; the card stays down when the pointer left him
or the menu was closed by a click elsewhere. Not seen at 125 %.

**A pet re-decided the side he keeps — fixed.** Seen as a side effect in 3.3c: at the top edge,
Medium → Large moved the window 88 px left, and later Large → Small 176 px right. `dragEnd` called
`decideAnchor` on every release, so a pet on a dog whose centre a grow had carried past the middle
flipped the kept edge. Fix: only a press that travelled the renderer's click slop, or a drop the
clamp corrected, re-decides. On screen: still pets between sizes hold x 912 through
Medium → Large → Small; a real drag across the middle still flips the edge.

**3.3b asleep and lying — not a code fault; the row's wording is.** Measured: lying body top
38 / 76 / 114 px, asleep body top 29 / 46 / 64. The code anchors the top of the box he is showing
plus the shared 4-row margin (`docs/DECISIONS.md`), so ink a fixed number of sprite rows below it is
`rows × scale` px down, exactly as the awake case (3 / 6 / 9). Asleep, the `z z` ink top is
11 / 12 / 13 px. The lying dog is already flush at every size. The row is left unticked on Windows
with a proposed wording; nothing was changed in the code. Reckoned, not seen: a size change while
asleep, then waking, should hop about 20 px by the clamp. That is an owner decision.

**Found and not fixed:**

1. **A pet that wobbles 2–3 px moves him by that much** and saves it (two such pets: 6 px right,
   2 px down, no longer flush). The kept side holds. The renderer has no dead zone for a pet.
2. **The dev build's Restart gives an invisible dog** (new process, never logs
   `overlay painted its first frame`). The installed build's Restart is fine.
3. **The first toast after ticking Notify when hidden in the same run does not show** and nothing is
   logged (row 9.23 again). After a Restart or a relaunch the toast shows, in English and Danish. No
   toast, shown or missed, leaves a log line. Do not disturb may have been on; not checked.
4. **Right-clicking Walder's tray icon in the overflow opened Microsoft Teams' menu**, three times,
   with both the installed and the dev build, although the tooltip there reads "Walder". Nothing was
   clicked in it. The bone-menu half of 3.17 is therefore unchecked. Whether this is Windows, Teams
   or Walder's icon is not known.
5. **The settings window and an injected reading** (asked for as a log): on opening, the Overview
   card showed the earlier reading; 10 s after Inject 82 % it showed the injected one and the ChatGPT
   section had gone ("not set up"); closed and reopened, still the injected one. The log for that
   minute (`10-inject\log-21-35.txt`) has **no line at all** for the inject or for the window opening
   and closing.
6. Small: the Update confirmation's button reads "Install"; Walder's Update leaves a dated backup
   copy beside each hook file.

## 3. Left

For Victor (OWNER):

- 125 %: 3.3b, 3.17 with the new one-point slack, the display-scale change and a drag.
- 7.18 (needs Codex `/hooks` trust); 12.8 with the computer's preferred language changed; 10.4
  Automatic following an OS theme switch; Narrator; sign-ins.
- Whether Do not disturb was on (finding 3); the tray icon and Teams (finding 4).
- Two backup copies holding a test edit: `~\.claude\settings.json.walder-backup-2026-11-19T20-26-07-212Z`
  and `~\.codex\hooks.json.walder-backup-2026-11-19T20-27-04-449Z`. Safe to delete.

Not run: 7.15b (needs an injected poll, the installed build has no Inject), 9.23 beyond finding 3,
audit §5 item 5.

## 4. State of the PC

The locally built installer of `da47341` is installed and running (0.3.0, per-user upgrade of the
build from 2026-11-18). `%APPDATA%\walder` restored from the backup into that exact folder; the new
build then wrote `"language": "system"` where the key had been absent. Both hook files are
hash-identical to before. No dev build, helper or keepalive running. Display scale and taskbar
untouched. A worktree is left at `%USERPROFILE%\Walder-qa\2026-11-19-win-fixes\wt`.

Accidents, none with an effect: three Teams menus opened by the tray route and closed with Esc; one
index-based menu click opened the Size submenu, and another chose Quit instead of Restart on the
installed build (relaunched); the notification centre was opened once and its screenshot deleted.

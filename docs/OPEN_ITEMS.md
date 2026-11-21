# Open items

The one current list of open work. Every session updates it before it finishes: remove what you
finished, add what you found (see "Before you finish" in [`AGENTS.md`](../AGENTS.md)). Each line
names where the evidence is. History lives elsewhere: the dated overview this list was built from
is [`handoffs/OVERVIEW_2026-11-18.md`](handoffs/OVERVIEW_2026-11-18.md), and the finished 0.2.6
roadmap is [`CODENOTCH_GAP_ANALYSIS.md`](CODENOTCH_GAP_ANALYSIS.md).

Last updated 2026-11-20 (Walder 0.3.0; `main` after PRs #36–#38). Evidence paths are from the repo root.

## Needs an on-screen check: Mac

Mac QA ran on 2026-11-19 on the Mac mini (report `docs/handoffs/MAC_QA_2026-11-19_REPORT.md`): §8, the
size rows (3.3–3.3c), 3.17, 4.23a, 7.9b, 2.2, 3.16, 6.3/6.12, 9.12, 10.1–10.3, 10.6, 10.7 and 12.1–12.7
passed there, and the pet-focus fault was fixed (`src/main/focus-return.ts`).

Waiting for Victor (later, 2026-11-19), about 10 minutes at the Mac; the session does the rest:

- **Sign-ins**: QA 4.2 passed on Victor's MacBook Pro 2026-11-20 (ChatGPT login window stays open, then reads chatgpt.com). Left: Cursor and Copilot sign-ins; and a Claude renewal reaching `renewed`, which needs the standalone CLI signed in (`claude /login`; on the MacBook it is signed out, and Developer ▸ Renew correctly said there is no login to renew). `src/main/claude-renew.ts`
- **Light wallpaper** for a minute: the light half of row 3.2. `docs/QA-CHECKLIST.md` 3.2
- **Preferred language**: add Danish at the top of Language & Region, then put it back: row 12.8. `docs/QA-CHECKLIST.md` 12.8
- **VoiceOver** on (⌘F5): the session checks what it announces from the caption panel; whether it sounds right is Victor's ear (11.1, 11.3). `docs/QA-CHECKLIST.md` §11
- **Gatekeeper** on a downloaded dmg, "Open Anyway" (8.2). `docs/QA-CHECKLIST.md` 8.2
- **Hardware**: a second monitor and a scaled external display (1.8, 2.5–2.7, 6.4). `docs/QA-CHECKLIST.md`
- **Hooks on the Mac mini**: Walder's Claude Code and Codex hooks were installed there at 00:26 on 2026-11-20 from the launch offers, outside any QA step (Walder kept the original `~/.claude/settings.json` as `settings.json.walder-backup-2026-11-19T23-26-05-414Z`). Keep them, or remove them from the menu (Hooks ▸ Remove). `docs/handoffs/MAC_QA_2026-11-19_REPORT.md`

Mac mini, 2026-11-20 (evidence `~/Walder-qa/2026-11-20-mac/`): passed 3.16 (Processor pre-filled Apple Silicon, draft = clipboard, Safari already signed in), §8 0.2.9 → 0.3.0 (every key kept, icon changed), 3.3b lying, and on PR #40 3.3d, 7.2b and 7.15d. Of the 0.2.8 observations: the card over a bubble no longer happens; the first-launch hooks notice staying up after Install, and a bark's text wrapped on two lines for 85–100 ms at Small, still happened and are fixed on PR #40 (QA 7.13b, 5.9i; to be re-seen on screen); the 4.8 stale marker needs the Mac asleep, which stops the session (not run). 9.15c, 9.19 and 6.12e were stopped on 2026-11-20 (Victor: not worth six hours now); 9.15c saw one silent check at +60 s; 6.12e's hover at the hour mark never ran. 7.13b and 5.9i (first frame) passed on PR #40.

Not run yet (the session can, no Victor needed):

- QA 3.16 under Rosetta: the x64 build pre-fills Apple Silicon (needs Rosetta, Victor's call).
- 0.3.0 installed over 0.2.9 (the Mac mini never had 0.2.9; needs a Mac that did, or installing 0.2.9 first). `docs/QA-CHECKLIST.md` §8
- 10.4 Automatic following an OS theme switch (a system setting: Victor flips it), 10.5, 9.15c and 9.19 (hours long), 6.12e, 3.3b lying, 7.2a Codex half and 7.18 (need Codex hooks installed and trusted). `docs/QA-CHECKLIST.md`
- Chrome toolbar fullscreen: `npm run probe:fullscreen` with Always Show Toolbar on, with and without the bookmarks bar (Chrome is not on the Mac mini). `docs/handoffs/RECHECK_2026-11-18.md` b
- The Antigravity process-name one-liner (Antigravity is not on the Mac mini). `docs/DECISIONS.md`
- The 4.8 stale marker after a short sleep (needs the Mac asleep; Victor at the Mac). `docs/handoffs/QA_0.2.8_MAC_RECHECK.md`
- macOS 13 and 14 are claimed but never tested (the Macs run macOS 27). `INSTALL.md`

Found by the Mac QA and fixed on `qa-2026-11-19` (2026-11-20); seen on the Mac mini the same day: coat names in every language (German needed soft hyphens, `818276c`); the Hindi up-to-date notice on one line at Small (12.4; the update-available notice could not be produced, and the Hindi width on Windows, Nirmala UI, was never measured); the Overview's Refresh row and its status line in every language (10.8); ⌘W closes the Walder window (11.3; never tried on Russian/Greek layouts, nor ⌘Z on AZERTY). Still open: German with all five services "not set up" still scrolls 38 px (the list needs two rows).

## Needs an on-screen check: Windows

The Windows session of 2026-11-18 ran at 100 % only (report: `docs/handoffs/WINDOWS_SESSION_2026-11_REPORT.md`). Done there and taken off this list: the window seen on screen, rows 10.1–10.7 and most rows the window reset, 7.15a, the hook confirm dialogs, the README screenshots, the dev-build Restart cause (§5 item 3).

Re-checked on the PC 2026-11-19/20 (`docs/handoffs/WINDOWS_FIXES_2026-11-19_REPORT.md`), passed at
100 %: 3.3b awake, 3.3c, 7.2a, 7.9b, 4.23a, 12.1–12.7, 12.6a, 3.5/3.6 on the window, the no-setting
parts of 12.8 and 10.4, audit §5 item 6, the renewal search (no Mac paths), the system language
before `ready`, `dist:win` into a folder with a space and its installer.

Sent to the Windows session on 2026-11-20; it reports back here:

Passed on the PC 2026-11-20 at 100 % (evidence `%USERPROFILE%\Walder-qa\2026-11-20-win\`): 3.5/3.6 (all six coats), 3.8 installed half (a real restart is Victor's), 7.15b, 12.4 Hindi at Small on one line. Audit §5 item 5 (a `done` loses its perk after a renderer reload) still reproduced: fixed on PR #40 (QA 7.15d), to be re-seen on screen. 3.16 needs Victor signed in to GitHub in Edge (the clipboard draft holds no login, token, usage number or user name).

- 7.18 (two Codex sessions) and 7.18b (Codex's automatic approval review), if Codex's hooks are already trusted; trusting them after the new hook command is a `/hooks` step for Victor. `src/main/hook-server.ts`
- 9.15c (six hours) and 9.19's six-hourly part: started 2026-11-20 and stopped (Victor: later); only the start-up check was seen, silent. `docs/QA-CHECKLIST.md`

Not sent (needs Victor or a setting): ChatGPT login 4.2 (sign-in), 10.4 Automatic following an OS
theme switch, Reduce Motion pickup (no row yet, `src/renderer/overlay.ts`), a renewal through
native `claude.exe` (sign-in).

Found by the Windows session 2026-11-19, fixed on `qa-2026-11-19` and passed on the PC's re-check (2026-11-20): pet dead zone (2.1a), the Update confirm (7.2a), the 9.23 toast, Inject (10.2b, no lag: under 90 ms), dev Restart (10.6b), the card after Esc (3.17, 10/10). The card over a keyboard-opened tray menu and the missing card after its Esc were fixed and re-seen on the PC (2026-11-20, 3.17). Teams' menu on a right-click in the overflow was the AutoHotkey click, not Walder: Victor's hand right-click opened Walder's menu in the overflow and on the taskbar (2026-11-20).

Needs Victor at the PC (the session may not change Windows settings or sign in):

- 125 %: the display-scale change with Walder running, then a drag (seen 2026-11-19 on a build before the `moveTo` fix, PR #32), and 3.3b at 125 %. `src/main/overlay-window.ts`
- Narrator rows 11.2 and 11.3; Cursor with a signed-in account; Windows 10 (claimed in INSTALL.md, never tested). 
- Never seen: M3 on mixed-scale monitors, W6 on a second monitor, a real browser's F11 or video fullscreen, the zero-cap row before the first poll, the stale line of 4.7a. `docs/handoffs/WINDOWS_AUDIT_2026-11_REPORT.md`
- PC tidied 2026-11-19 (13 worktrees, the stash and 15 old branches removed; each checked first; the saved patches were then judged shipped, superseded or abandoned, the one live fix landed as PR #34, and `pc-wip-2026-11` was deleted on 2026-11-19. A last zip of it is in the PC's `Walder-qa\2026-11-18-win\pc-wip-2026-11.zip`, safe to delete). Left for Victor: the Node.js firewall block rule made by Cancel on 2026-11-18; 30 stale folders in the PC checkout's `.git\worktrees` that git cannot delete because an ACL (apparently set by Codex's sandbox) denies it, harmless; Antigravity stays for Gemini. `docs/handoffs/WINDOWS_SESSION_2026-11_REPORT.md` §7

## Fixes

Merged with `fixes-0.3.2` (PR #36, 2026-11-19; their QA rows are above): the
top-edge round trip, the ink clamp (in part), the SESSIONS cap, the two token rows, the card over
the menu, out-of-date hook commands, the Windows hook dialog parent, Claude renewal paths, two Codex
sessions, one Retry-After rule (P4), the discovery helper (P8), the electron-builder advisories, the
picomatch exclusion, `dist:win`/`dist:mac` output override, the doubled Launch at login line.

- `dist:mac:signed` and `dist:all` have the same output-override fault `dist:mac` had (arguments land on `ditto`; the post-hook reads `release/`). Fix when a signed build is first attempted. `package.json`
- A Codex automatic approval review fires `PermissionRequest` exactly like a human prompt, so Walder may show "Codex waiting" while the review runs (the 3 s grace hides short ones). Needs two verbose-log runs, review on and off. `src/main/hook-server.ts`; QA 7.18b
- minimatch is forced to 11.0.9 under electron-builder (`overrides` in `package.json`) until app-builder-lib declares >= 11.0.1. `@types/node` stays on 24 on purpose: it follows the Node in Electron 45 (`.github/dependabot.yml`). `package.json`
- P4 leftovers: chatgpt-codex accepts rows with no number and chatgpt-web does not; a 5xx with Retry-After on a chatgpt-web candidate path is skipped; a manual Refresh can poll inside a 5xx floor. Each is a behaviour choice written in `docs/DECISIONS.md`. `AUDIT.md` P4
- Flush-side size fix (2026-11-20) limits, pinned in `test/overlay-window.test.ts`: a dog under 16 px (1×) from a side but not flush ends the round trip flush, not where he was; at 1.25×/1.5× a dog asleep where he stood flush can end asleep 1–3 px off and still wakes home. Mixed-scale displays at a side were not tested. `src/main/overlay-window.ts` ▸ `flushSide`
- Outdated-hooks bubble (2026-11-20) limits: a bark or the update-available notice can replace it in the one-slot notice queue, and a tool whose hooks stay missing keeps the other's Update bubble from being said; the menu still says it. `src/main/index.ts` ▸ `sayHooksOutdated`
- One-frame glitches when a bubble widens or narrows the window at Small (Mac 2026-11-20, QA 5.9i, 17–35 ms each, frame captures in `~/Walder-qa/2026-11-20-mac/5.9i/`): on the widen, the dog or the bubble drawn 13 px off and cut at the old window's edge; on the clear, the bubble redrawn wrapped in the narrowed window (the arrival bug mirrored; fixed 2026-11-20: the clear is sent before the window narrows, to be re-seen on screen); after a pet, the dog 5 px left for one frame. Window geometry and paint are out of step for one compositor frame. Removed 2026-11-20 by the side hold (Victor: 216 px a side): a bark no longer resizes the window, to be re-seen on the Mac and the PC (QA 5.9i, with idle CPU and a lie bark). Residuals: the diagnostics and dev notices and the first-launch hellos still widen once (one frame), the `…zzz` over a sleeping dog still changes the height, a launch at home now creates the window 200 px past the screen edge (checked on the Mac, not yet on Windows), the hold's wider forwarded area cost 12.5 % of a core with the pointer beside him on the PC (2026-11-20; cut by the move filter, to be measured on the PC and the Mac: next item), and a dog flush with the top of a display beside one that reaches higher has a held window that overlaps the neighbour more: main reckons him on his own display (`displayOf`, tested), but Windows may draw him at the neighbour's scale (reckoned, not seen; QA 5.9i). A hook beat of the introduction still queued (behind a bark) is not withdrawn by an install, and `offerHooksOnFirstLaunch` does not re-read the hook file, so its dialog can offer an install already done (predates 2026-11-20). `src/main/index.ts`
- Move filter (2026-11-20, shipped in 0.4.0 on Victor's call: "Yes, ship it"). Measured: Windows at 100 % circling beside him 2.6–2.7 % of a core against main's 2.32, parked beside 1.56 against 1.47; Mac with a fast pointer (125 Hz) beside him 4.8 % against main's 1.3, every other case at main's level. The residual is the main process receiving each move macOS hands it, which no setting can stop (bare-app spike S0: +2.2 %). Unit check passed at 1x (Mac mini), 100 % (PC) and Retina 2x (MacBook Pro, 2026-11-21). Flick-click: 10/10 Mac, 12/12 Windows when the click comes 17 ms or more after the flick; a click within about 10 ms passed through twice on Windows. Not checked: Windows 125 %. `src/main/overlay-window.ts`; `~/Walder-qa/2026-11-20-mac/mf-21d59f6/`
- Later, only if the Mac residual is noticed: the two-window split (a dog window as on `main`, a fixed bubble window), which needs a full frame-capture round for the bubble and dog staying in step (sleep frames bake the bubble in). `docs/DECISIONS.md` (move filter row)
- Unexplained on d019c58 (Windows, 2026-11-20): one flick-click passed through him although `hit:set true` was logged 9 ms before the click. Gone with the gate if the flick-click ×10 passes; if it recurs on `main` or this build, log `before-mouse-event` `mouseDown` to see whether the press reached the window. `src/main/overlay-window.ts` ▸ `setIgnore`
- Linux hook dialogs are still parentless (Linux is not a target). `src/main/dialog-host.ts`
- The Intel Mac build (approved 2026-11-18, merged with `qa-2026-11-19`) is packaged and checked as x86_64 but never run on an Intel Mac (QA 8.1a; the Mac mini has no Rosetta). Victor, 2026-11-20: ship it in the next release marked "not yet tested on Intel hardware" and ask Intel testers to report. The release must include `Walder-mac-x64.dmg` or the README link 404s. `electron-builder.yml`

## Languages

Victor, 2026-11-19: no native reviewers; ship the languages with the next release and act on
testers' comments. Done: CLDR percent spacing (da, de, es, fr), French no-break spaces before
`: ; ? !`, the Spanish Copilot row, a terminology glossary (`docs/i18n-glossary.md`) and a
two-reviewer automated pass over all six tables. System language is read before `ready` on
Electron 45.3.4 (checked on the Mac 2026-11-19: `["en-US","da-DK"]`).

- On-screen QA: 12.1–12.7 and 12.6a passed on both (2026-11-19/20). Left: 12.8 with the preferred language changed (Victor, Mac and PC) and 12.4 Hindi width on Windows (sent to the PC). `docs/QA-CHECKLIST.md` §12
- After the release: read testers' translation comments and fix them in the tables. `src/core/i18n/`

## Docs


- Handbook 0.4.0 pass done (2026-11-20). It states two things QA has not yet seen on screen: a wobbling pet does not move him (QA 2.1a) and the Intel build (untested, said so). If 2.1a fails, correct the Click row. `docs/handbook/build_walder.py`
- Antigravity process-name check: write down the result once it is run. `docs/DECISIONS.md`
- Windows signing has no plan written down (only macOS is in `docs/signing.md`). `docs/signing.md`

## Art

- The 20-strip gate is satisfied (2026-11-18). Victor may reopen any strip for minor fixes; a reopened strip is approved again before it ships. `CONTRIBUTING.md` binding rule 1

## Decisions waiting on Victor

Settled 2026-11-19: no `sit` pose (waiting keeps the head-tilt); keep the `decor-anchor-sheet` test
fixture; add a linter (Biome, `npm run lint`; typescript-eslint does not support TypeScript 7); the handbook is published on GitHub Pages and kept current
automatically; `docs/release-repo/` keeps its name; the ink clamp stays, with Yuna's top-edge
bubble fixed. Settled 2026-11-20: the gap under the menu bar and the dachshund's Small trade stay as they are; a flush side now comes home after a size round trip, and out-of-date hooks get one bubble per Walder version (QA 3.3d, 7.2b).

- **ChatGPT chat limits** (waits, Victor 2026-11-19): nothing readable exposes remaining chat messages today. OpenAI reportedly merges ChatGPT and Codex into one allowance in December 2026; then check whether `wham/usage` moves with chat and relabel the Codex rows. `docs/handoffs/CHATGPT_LIMITS_2026-11-18.md`

## Waiting on Victor (setup)

- **Trash:** the old QA runs and installers were moved to the macOS Trash on 2026-11-18; the space comes back when it is emptied.

## Parked

- **Apple signing: not in the budget (2026-11-18).** No certificate means Mac users still need "Open Anyway"; auto-update and Electron fuses wait on the first signed build. `docs/signing.md`; `package.json` (`//signed-path`)

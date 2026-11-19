# Open items

The one current list of open work. Every session updates it before it finishes: remove what you
finished, add what you found (see "Before you finish" in [`AGENTS.md`](../AGENTS.md)). Each line
names where the evidence is. History lives elsewhere: the dated overview this list was built from
is [`handoffs/OVERVIEW_2026-11-18.md`](handoffs/OVERVIEW_2026-11-18.md), and the finished 0.2.6
roadmap is [`CODENOTCH_GAP_ANALYSIS.md`](CODENOTCH_GAP_ANALYSIS.md).

Last updated 2026-11-19 (Walder 0.3.0; branch `fixes-0.3.2`). Evidence paths are from the repo root.

## Needs an on-screen check: Mac

- Install the published 0.3.0 dmg over 0.2.9 and run section 8 again (Electron, the settings-file format and the icon all changed). `docs/QA-CHECKLIST.md` §8
- Re-run the rows the Walder window reset: 3.4a, 3.4e, 3.4f, 3.4h, 3.4i, 3.5–3.13, 4.10, 9.12, 9.15c, 9.19. `docs/QA-CHECKLIST.md` §3, §4, §9
- Run the new Walder window rows 10.1–10.7 and the accessibility rows 11.1 and 11.3. `docs/QA-CHECKLIST.md` §10, §11
- Size change: the blanking fix has never been seen on screen (row 3.3). `docs/QA-CHECKLIST.md` 3.3; `docs/DECISIONS.md` (UI table)
- The top-edge bubble fix was worked out from the code only. `docs/handoffs/AUDIT_2026-11-13.md` "What is left"
- Dragging under the "never outside the screen" rule (row 2.2). `docs/QA-CHECKLIST.md` 2.2
- The full-screen hover card after the Electron 44 → 45 upgrades (row 6.12). `docs/QA-CHECKLIST.md` 6.12
- Mirroring (he turns to face the screen) is live and has no QA row; add one and run it. `docs/BUILD_LOG.md` (mirroring entry)
- Report a bug: compare the draft with the clipboard (row 3.16). `docs/QA-CHECKLIST.md` 3.16
- Run the Antigravity process-name one-liner; it was a release condition with no recorded result. `docs/handoffs/AUDIT_2026-11-13.md`; `docs/DECISIONS.md`
- Claude renewal through the Claude desktop app's bundled CLI is unconfirmed. `src/main/claude-renew.ts`
- A scaled external display (row 1.8) and the light-wallpaper half of row 3.2. `docs/QA-CHECKLIST.md` 1.8, 3.2
- A second monitor (rows 2.5–2.7 and 6.4); needs the hardware. `docs/QA-CHECKLIST.md` 2.5–2.7, 6.4
- macOS 13 and 14 are claimed but never tested (the test Mac runs macOS 27). `INSTALL.md`
- ChatGPT login (F23, fixed in PR #34: an anonymous `ua-` visitor is no longer taken for a login): re-run QA 4.2. `src/providers/chatgpt-web.ts`
- New rows from `fixes-0.3.2` (2026-11-19), first seen on the Mac: 3.3b and 3.3c (top-edge round trip, resting by ink), 3.17 (no card over the open menu, and that `menu-will-close` really fires for a tray popup), 7.2a (old hook command reads out of date), 7.9b (the hook question on its always-on-top host still takes Return), 4.23a (SESSIONS cap), 7.18 (two Codex sessions), 12.6a (typography). Install the `fixes-0.3.2` dmg (first one packaged with the minimatch override). `docs/QA-CHECKLIST.md`
- Petting him takes key focus from the window under him: no cause in Walder's code (every show is `showInactive`, nothing activates). Run the three-step experiment in `docs/handoffs/RECHECK_2026-11-18.md` c. `src/main/overlay-window.ts`
- Chrome window-fullscreen with its toolbar shown is not detected: needs a measurement before any fix. Run `npm run probe:fullscreen` with Always Show Toolbar on, with and without the bookmarks bar, once on a second display. `docs/handoffs/RECHECK_2026-11-18.md` b; `scripts/fullscreen-probe.ts`
- Observations from the 0.2.8 re-check never closed: the 4.8 stale marker after a short sleep, the card covering the start of a bubble, the first-launch hooks notice staying up after installing from the menu, a bubble drawn in the old narrow window for 100–270 ms after a bark. `docs/handoffs/QA_0.2.8_MAC_RECHECK.md`

## Needs an on-screen check: Windows

The Windows session of 2026-11-18 ran at 100 % only (report: `docs/handoffs/WINDOWS_SESSION_2026-11_REPORT.md`). Done there and taken off this list: the window seen on screen, rows 10.1–10.7 and most rows the window reset, 7.15a, the hook confirm dialogs, the README screenshots, the dev-build Restart cause (§5 item 3).

Sent to the Windows session on 2026-11-19 (branch `fixes-0.3.2`); it reports back here:

- New rows from `fixes-0.3.2` at 100 %: 3.3b and 3.3c (top-edge round trip, resting by ink), 3.17 (no card over the open menu; `menu-will-close` fires for a tray popup), 7.2a (old hook command reads out of date), 7.9b (the hook question stays in front, a click beside it reaches the window beneath), 4.23a (SESSIONS cap), 7.18 (two Codex sessions), 12.1–12.8 and 12.6a (languages, U+202F in the tray menu and dialogs), the renewal search lists no Mac paths. `docs/QA-CHECKLIST.md`
- `npm run dist:win -- --config.directories.output=<dir with a space>` builds there and its asar check passes; the installer (first with the minimatch override) installs and starts. `scripts/dist-win.ts`
- System language before `ready` on Windows (checked on the Mac). `src/main/language-boot.ts`
- The settings window and an injected usage snapshot: a `WALDER_LOG=1` log of open window ▸ Inject 82 % ▸ wait ▸ close ▸ reopen. `src/main/settings-window.ts`
- ChatGPT login (F23, PR #34): re-run QA 4.2 if Victor signs in. `src/providers/chatgpt-web.ts`
- Rows still open at 100 %: 3.5 and 3.6 (Cream, Black and tan), 3.8 installed half (needs a restart), 9.15c (six hours), 9.19 six-hourly part, 10.4 Automatic following an OS theme switch, 7.15b. `docs/QA-CHECKLIST.md`
- Codex `/hooks` trust after the new hook command, and a renewal through native `claude.exe`. `docs/handoffs/WINDOWS_AUDIT_2026-11_REPORT.md` §7
- Reduce Motion pickup on Windows (no row yet). `src/renderer/overlay.ts`
- One unexplained missed "Notify when hidden" toast (row 9.23). `docs/QA-CHECKLIST.md` 9.23
- Re-check audit report §5 items 5 and 6 (a `done` loses its perk after a renderer reload; Reset position with a bubble up keeps the window wider). `docs/handoffs/WINDOWS_AUDIT_2026-11_REPORT.md` §5

Needs Victor at the PC (the session may not change Windows settings or sign in):

- 125 %: the display-scale change with Walder running, then a drag (seen 2026-11-19 on a build before the `moveTo` fix, PR #32), and 3.3b at 125 %. `src/main/overlay-window.ts`
- Narrator rows 11.2 and 11.3; Cursor with a signed-in account; Windows 10 (claimed in INSTALL.md, never tested). 
- Never seen: M3 on mixed-scale monitors, W6 on a second monitor, a real browser's F11 or video fullscreen, the zero-cap row before the first poll, the stale line of 4.7a. `docs/handoffs/WINDOWS_AUDIT_2026-11_REPORT.md`
- PC tidied 2026-11-19 (13 worktrees, the stash and 15 old branches removed; each checked first; the saved patches were then judged shipped, superseded or abandoned, the one live fix landed as PR #34, and `pc-wip-2026-11` was deleted on 2026-11-19. A last zip of it is in the PC's `Walder-qa\2026-11-18-win\pc-wip-2026-11.zip`, safe to delete). Left for Victor: the Node.js firewall block rule made by Cancel on 2026-11-18; 30 stale folders in the PC checkout's `.git\worktrees` that git cannot delete because an ACL (apparently set by Codex's sandbox) denies it, harmless; Antigravity stays for Gemini. `docs/handoffs/WINDOWS_SESSION_2026-11_REPORT.md` §7

## Fixes

Done on branch `fixes-0.3.2` (2026-11-19; each needs its QA row on screen, listed above): the
top-edge round trip, the ink clamp (in part), the SESSIONS cap, the two token rows, the card over
the menu, out-of-date hook commands, the Windows hook dialog parent, Claude renewal paths, two Codex
sessions, one Retry-After rule (P4), the discovery helper (P8), the electron-builder advisories, the
picomatch exclusion, `dist:win`/`dist:mac` output override, the doubled Launch at login line.

- The settings window ignores a Developer ▸ Inject usage snapshot while open, and opening it seems to start a poll. No cause found in the code; needs a `WALDER_LOG=1` log of the sequence (asked of the Windows session). Dev only. `src/main/settings-window.ts`
- `dist:mac:signed` and `dist:all` have the same output-override fault `dist:mac` had (arguments land on `ditto`; the post-hook reads `release/`). Fix when a signed build is first attempted. `package.json`
- A Codex automatic approval review fires `PermissionRequest` exactly like a human prompt, so Walder may show "Codex waiting" while the review runs (the 3 s grace hides short ones). Needs two verbose-log runs, review on and off. `src/main/hook-server.ts`; QA 7.18b
- minimatch is forced to 11.0.9 under electron-builder (`overrides` in `package.json`) until app-builder-lib declares >= 11.0.1. `@types/node` stays on 24 on purpose: it follows the Node in Electron 45 (`.github/dependabot.yml`). `package.json`
- P4 leftovers: chatgpt-codex accepts rows with no number and chatgpt-web does not; a 5xx with Retry-After on a chatgpt-web candidate path is skipped; a manual Refresh can poll inside a 5xx floor. Each is a behaviour choice written in `docs/DECISIONS.md`. `AUDIT.md` P4
- Linux hook dialogs are still parentless (Linux is not a target). `src/main/dialog-host.ts`
- The Intel Mac build (approved 2026-11-18) has been packaged but never run on an Intel Mac (QA 8.1a), and the next release must include `Walder-mac-x64.dmg` or the README link 404s. `electron-builder.yml`

## Languages

Victor, 2026-11-19: no native reviewers; ship the languages with the next release and act on
testers' comments. Done: CLDR percent spacing (da, de, es, fr), French no-break spaces before
`: ; ? !`, the Spanish Copilot row, a terminology glossary (`docs/i18n-glossary.md`) and a
two-reviewer automated pass over all six tables. System language is read before `ready` on
Electron 45.3.4 (checked on the Mac 2026-11-19: `["en-US","da-DK"]`).

- On-screen QA rows 12.1–12.8 and 12.6a, on the Mac and on Windows (Windows: also that U+202F draws as a thin gap in the tray menu and dialogs). `docs/QA-CHECKLIST.md` §12
- After the release: read testers' translation comments and fix them in the tables. `src/core/i18n/`

## Docs


- Handbook pass at the next release (Victor, 2026-11-19): re-read it after PRs #23–#24 and `fixes-0.3.2`; the stale terminal-raise line is fixed. CI now fails if the committed handbook drifts from its sources, and Pages redeploys it on every change. `docs/handbook/`
- Antigravity process-name check: write down the result once it is run. `docs/DECISIONS.md`
- Windows signing has no plan written down (only macOS is in `docs/signing.md`). `docs/signing.md`

## Art

- The 20-strip gate is satisfied (2026-11-18). Victor may reopen any strip for minor fixes; a reopened strip is approved again before it ships. `CONTRIBUTING.md` binding rule 1

## Decisions waiting on Victor

Settled 2026-11-19: no `sit` pose (waiting keeps the head-tilt); keep the `decor-anchor-sheet` test
fixture; add a linter (ESLint); the handbook is published on GitHub Pages and kept current
automatically; `docs/release-repo/` keeps its name; the ink clamp stays, with Yuna's top-edge
bubble fixed.

- **ChatGPT chat limits** (waits, Victor 2026-11-19): nothing readable exposes remaining chat messages today. OpenAI reportedly merges ChatGPT and Codex into one allowance in December 2026; then check whether `wham/usage` moves with chat and relabel the Codex rows. `docs/handoffs/CHATGPT_LIMITS_2026-11-18.md`
- **The rest of the gap under the menu bar**: the clamp now uses the margin no frame inks (4 sprite rows), so about 21 rows of air stay above the resting dachshund; closing them means clamping on the resting pose and letting a jump or the pet heart clip. `docs/DECISIONS.md` (clamp row)
- **The ink clamp's one remaining trade** (Yuna fixed 2026-11-19: her coats keep the top-edge bubble lines they had): the dachshund at Small on a 175 % or 250 % display gets one line plus an ellipsis at a top edge instead of two; and after switching from a Yuna coat to a dog coat while flush at the top, he stays 4 rows below the edge until next moved. `docs/DECISIONS.md` (clamp row)
- **Sideways round trip from a flush side** at Medium/Large does not come home sideways (X1 keeps the window's edge, not the ink's). `docs/DECISIONS.md`
- **A launch-time bubble for out-of-date hooks** (today only the menu says it). `src/main/index.ts`

## Waiting on Victor (setup)

- **Mac session:** about an hour at an unlocked Mac for the Mac list above and the position faults.
- **Trash:** the old QA runs and installers were moved to the macOS Trash on 2026-11-18; the space comes back when it is emptied.

## Housekeeping (local, not in git)

- `art/out/`: the pre-rename Yuna folders are still there (`node art/render.mjs` regenerates it).
- `graphify-out/`: rebuild scoped or delete (built 2026-09-10).

## Parked

- **Apple signing: not in the budget (2026-11-18).** No certificate means Mac users still need "Open Anyway"; auto-update and Electron fuses wait on the first signed build. `docs/signing.md`; `package.json` (`//signed-path`)

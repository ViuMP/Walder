# Open items

The one current list of open work. Every session updates it before it finishes: remove what you
finished, add what you found (see "Before you finish" in [`AGENTS.md`](../AGENTS.md)). Each line
names where the evidence is. History lives elsewhere: the dated overview this list was built from
is [`handoffs/OVERVIEW_2026-11-18.md`](handoffs/OVERVIEW_2026-11-18.md), and the finished 0.2.6
roadmap is [`CODENOTCH_GAP_ANALYSIS.md`](CODENOTCH_GAP_ANALYSIS.md).

Last updated 2026-11-18 (Walder 0.3.0). Evidence paths are from the repo root.

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
- macOS 13 and 14 are claimed but never tested (the test Mac runs macOS 15). `INSTALL.md`
- Observations from the 0.2.8 re-check never closed: the 4.8 stale marker after a short sleep, the card covering the start of a bubble, the first-launch hooks notice staying up after installing from the menu, a bubble drawn in the old narrow window for 100–270 ms after a bark. `docs/handoffs/QA_0.2.8_MAC_RECHECK.md`

## Needs an on-screen check: Windows

- The Walder window has never been seen on a Windows screen; install the published 0.3.0 exe and look at it at 100 % and 125 %. `docs/handoffs/WINDOWS_AUDIT_2026-11_REPORT.md`; PR #19
- Run the new rows 10.1–10.7, 11.2 and 11.3 and the rows the window reset (see the Mac list). `docs/QA-CHECKLIST.md` §10, §11
- The tray menu taller than the screen at 125 %: shortened in 0.3.0, never looked at. `docs/release-notes/v0.3.0.md`
- Rows 7.15a and 7.15b. `docs/QA-CHECKLIST.md` 7.15a, 7.15b
- Codex `/hooks` trust after the new hook command, and a renewal through native `claude.exe`. `docs/handoffs/WINDOWS_AUDIT_2026-11_REPORT.md` §7
- Cursor and Copilot with a signed-in account on Windows. `src/providers/credentials.ts`
- Reduce Motion pickup on Windows (no row yet). `src/renderer/overlay.ts`
- One unexplained missed "Notify when hidden" toast (row 9.23). `docs/QA-CHECKLIST.md` 9.23
- Windows 10 is claimed in INSTALL.md but never tested. `INSTALL.md`
- Never seen: M3 on mixed-scale monitors, W6 on a second monitor, a real browser's F11 or video fullscreen, the zero-cap row before the first poll, the stale line of 4.7a. `docs/handoffs/WINDOWS_AUDIT_2026-11_REPORT.md`
- Re-check report §5 items 3, 5 and 6 (dev-build Restart leaves no dog; a `done` loses its perk after a renderer reload; Reset position with a bubble up keeps the window wider). `docs/handoffs/WINDOWS_AUDIT_2026-11_REPORT.md` §5
- Tidy the PC: 125 % and taskbar auto-hide, the dev firewall rule, six-plus worktrees, the stash `x1flash-fix-before-b90aae4` (check it first), the 0.2.9 branch build. `docs/handoffs/WINDOWS_AUDIT_2026-11_REPORT.md` §10.4
- Windows screenshots for the README (`assets/windows/`). `README.md`

## Fixes

Victor's answers of 2026-11-18: position faults are to be fixed, and the small Windows findings and
open 0.2.8 issues are to be checked and fixed where they still apply.

- 125 % drag: the window grows and he drifts. Apply the written `setBounds` patch and test it. `src/main/overlay-window.ts` (`setPosition` in the drag path); `docs/handoffs/WINDOWS_AUDIT_2026-11_REPORT.md` §10.3, §11
- A size round trip at the top edge ends about 144 pt lower. `docs/handoffs/AUDIT_2026-11-13.md` "What is left"
- He rests about 25 pt under the menu bar. `docs/handoffs/AUDIT_2026-11-13.md` "What is left"
- No cap on SESSIONS rows (10 sessions grew the card to 380×626). `src/core/card-layout.ts` (`sessionsFor`)
- Two "Tokens today" rows at Medium cannot be told apart. `src/core/local-tokens.ts` (`LOCAL_TOKENS_LABEL`)
- The menu cannot tell an old hook command from a new one ("installed (port N)" only). `src/main/tray.ts`
- Claude renewal lists Mac-only paths on Windows (harmless). `src/main/claude-renew.ts`
- 0.2.8 known issues still open: the card drawn over the right-click menu, Chrome window-fullscreen with its toolbar shown, the pet taking key focus (partly fixed). `docs/handoffs/QA_0.2.8_REPORT.md`
- ChatGPT's web route answers with a `WARNING_BANNER` only, so ChatGPT stays on the Codex CLI numbers. `docs/handoffs/QA_0.2.8_MAC_RECHECK.md`; `docs/handoffs/QA_0.2.8_WINDOWS_REPORT.md`
- Two Codex sessions merge into one row, and the Codex "waiting" mapping was never checked against a real hook body. `src/core/sessions.ts`; `src/main/hook-server.ts`
- The sync-sheet error message still says `node art/frames.mjs`, a script that no longer exists; it should name `python3 art/strips.py`. `scripts/sync-sheet.ts`
- Retry-after rules are still per provider (audit P4, fixed in part on purpose: unifying them changes behaviour per provider). `AUDIT.md` P4
- A service unticked under Show in overview is still polled (the 0.2.8 "Copilot polling while hidden" issue); decide whether hiding should also stop the checks, then fix or document. `src/main/poller.ts`; `docs/privacy.md`
- Audit lows fixed in part: P8 (the shared read-sanitise-write helper for discovered endpoints was not moved) and W-5 (the two crash-reload handlers stay separate on purpose). `AUDIT.md` P8, W-5
- The picomatch advisory is kept out of the installers by hand, not fixed; re-check after the next get-windows or node-gyp release. `AUDIT.md`; `scripts/check-asar.ts`
- There is no linter (no `lint` script, no ESLint or Biome config); typecheck and tests are the only gates. `package.json`

## Docs

- The build log stops at 0.2.8 and runs both ways (see Decisions). `docs/BUILD_LOG.md`
- The handbook was rebuilt for 0.3.0 but not re-read after PRs #23 and #24. `docs/handbook/`
- Antigravity process-name check: write down the result once it is run. `docs/DECISIONS.md`
- Windows signing has no plan written down (only macOS is in `docs/signing.md`). `docs/signing.md`

## Art

- The 20-strip gate is satisfied (2026-11-18). Victor may reopen any strip for minor fixes; a reopened strip is approved again before it ships. `CONTRIBUTING.md` binding rule 1
- The `sit` pose for a waiting session was never added; waiting uses the head-tilt. `docs/CODENOTCH_GAP_ANALYSIS.md` P0-6; `src/core/behaviour.ts`
- `test/fixtures/decor-anchor-sheet.ts`: leave, or repoint two tests at the real sheet and delete it. `test/sync-sheet.test.ts`; `test/sprites.test.ts`

## Decisions waiting on Victor

- **Yuna grey-tabby review files.** Nine files under `design/concepts/yuna/review/grey-tabby/` are on your Mac but not in git. The app ships the original generated strip, not these. Keep them in git with a corrected `REVIEW.md`, or delete them; the two fixes-v1/v2 sets the same. `docs/handoffs/CLAUDE_YUNA.md`
- **Hook install and remove dialogs.** Today a stray Enter presses Install or Remove, because that is the default button; on Windows the dialog can also hide behind other windows. Should Cancel be the default, and should the Windows dialog stay on top? `src/main/index.ts`; `src/main/dialog-host.ts`
- **Account states nobody can produce** (credit pool empty, spend limit reached, no login at all). Either add a developer menu item that fakes them so the rows can be checked, or mark those rows n/a and rely on the unit tests. `docs/QA-CHECKLIST.md` §4
- **GitHub settings.** Turn on Dependabot alerts, secret scanning and push protection; add a rule that CI must pass before merging into `main`; turn on "Automatically delete head branches" (merged PR branches then clean themselves up); fill in the empty homepage field. An agent can do all of this with `gh` once you say yes. GitHub settings
- **The build log.** Resume it, or close it with a line pointing at the CHANGELOG and the audit reports. `docs/BUILD_LOG.md`
- **Product scope**, each a real piece of work only worth doing if you want it: Gemini on Windows, the `sit` pose, the ChatGPT chat allowance (the endpoint was never found), a second language, an Intel Mac build, raising the terminal for Codex when you pet a `?` (today Claude Code only). `src/providers/chatgpt-web.ts`; `docs/hooks.md`
- **`~/Walder-qa` retention** (6.4 GB of QA evidence, private screenshots included). Not part of the safe clean-up because it is evidence and holds private images. `~/Walder-qa`
- **The handbook on GitHub Pages**: publish it, or keep shipping it with each release only. `docs/release-repo/README.md`
- **`docs/release-repo/` folder name** (named after the archived repo): leave it, or rename it to a release guide. Cosmetic. `docs/release-repo/README.md`

## Housekeeping (local, not in git)

- `release/`: delete the installers older than 0.3.0 (all are on GitHub; the 0.2.9 files trip `check:asar`).
- `art/out/`: delete the five empty " 2" folders and the pre-rename Yuna folders (`node art/render.mjs` regenerates it).
- `graphify-out/`: rebuild scoped or delete (built 2026-09-10).
- Stray `.git/objects/09/tmp_obj_*`: `git prune` when no other git process runs in the repo.

## Parked

- **Apple signing: not in the budget (2026-11-18).** No certificate means Mac users still need "Open Anyway"; auto-update and Electron fuses wait on the first signed build. `docs/signing.md`; `package.json` (`//signed-path`)

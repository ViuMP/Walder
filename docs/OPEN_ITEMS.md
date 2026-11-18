# Open items

The one current list of open work. Every session updates it before it finishes: remove what you
finished, add what you found (see "Before you finish" in [`AGENTS.md`](../AGENTS.md)). Each line
names where the evidence is. History lives elsewhere: the dated overview this list was built from
is [`handoffs/OVERVIEW_2026-11-18.md`](handoffs/OVERVIEW_2026-11-18.md), and the finished 0.2.6
roadmap is [`CODENOTCH_GAP_ANALYSIS.md`](CODENOTCH_GAP_ANALYSIS.md).

Last updated 2026-11-18 (Walder 0.3.0; weekly maintenance run). Evidence paths are from the repo root.

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
- Observations from the 0.2.8 re-check never closed: the 4.8 stale marker after a short sleep, the card covering the start of a bubble, the first-launch hooks notice staying up after installing from the menu, a bubble drawn in the old narrow window for 100–270 ms after a bark. `docs/handoffs/QA_0.2.8_MAC_RECHECK.md`

## Needs an on-screen check: Windows

The Windows session of 2026-11-18 ran at 100 % only (report: `docs/handoffs/WINDOWS_SESSION_2026-11_REPORT.md`). Done there and taken off this list: the window seen on screen, rows 10.1–10.7 and most rows the window reset, 7.15a, the hook confirm dialogs, the README screenshots, the dev-build Restart cause (§5 item 3).

- **Everything at 125 %** (OWNER: switch the scale): the drag-growth probe and a drag (`win-drag-grow` fix), the tray menu (shortened in 0.3.0, never seen), the window and the rows above. `docs/handoffs/WINDOWS_SESSION_2026-11_REPORT.md` §4
- Rows still open at 100 %: 3.5 and 3.6 (Cream, Black and tan), 3.8 installed half (needs a restart), 9.15c (six hours), 9.19 six-hourly part, 10.4 Automatic following an OS theme switch, 7.15b, 11.2 and 11.3 (Narrator). `docs/QA-CHECKLIST.md`
- Codex `/hooks` trust after the new hook command, and a renewal through native `claude.exe`. `docs/handoffs/WINDOWS_AUDIT_2026-11_REPORT.md` §7
- Cursor with a signed-in account on Windows (Copilot via the GitHub CLI login answered ok on 2026-11-18). `src/providers/credentials.ts`
- Gemini on Windows: verify a 200 with a signed-in Antigravity (OWNER: sign in to Antigravity on the PC). The discovery is merged on `win-session-2026-11-18`; on screen the card says "Antigravity is running but its language server did not answer" while it is not signed in, and the Accounts menu says "could not be reached — check the connection", which is the wrong advice for that state. `src/providers/antigravity.ts`; `docs/handoffs/GEMINI_WINDOWS.md`
- Reduce Motion pickup on Windows (no row yet). `src/renderer/overlay.ts`
- One unexplained missed "Notify when hidden" toast (row 9.23). `docs/QA-CHECKLIST.md` 9.23
- Windows 10 is claimed in INSTALL.md but never tested. `INSTALL.md`
- Never seen: M3 on mixed-scale monitors, W6 on a second monitor, a real browser's F11 or video fullscreen, the zero-cap row before the first poll, the stale line of 4.7a. `docs/handoffs/WINDOWS_AUDIT_2026-11_REPORT.md`
- Re-check audit report §5 items 5 and 6 (a `done` loses its perk after a renderer reload; Reset position with a bubble up keeps the window wider). `docs/handoffs/WINDOWS_AUDIT_2026-11_REPORT.md` §5
- Tidy the PC (OWNER): the worktrees under the user folder's `Walder-qa`, the stash `x1flash-fix-before-b90aae4` (both saved on `pc-wip-2026-11`), the Node.js firewall block rule made by Cancel on 2026-11-18, Antigravity (installed for the Gemini probe). `docs/handoffs/WINDOWS_SESSION_2026-11_REPORT.md` §7

## Fixes

Victor's answers of 2026-11-18: position faults are to be fixed, and the small Windows findings and
open 0.2.8 issues are to be checked and fixed where they still apply.

- 125 % drag: the window grows and he drifts. Fix merged on `win-session-2026-11-18` (no `setPosition`; every move is one `setBounds` with the asked size, `moveTo`); at 100 % on screen the window keeps its size through 270 drag steps; **125 % not yet seen**: run the probe `Walder-qa/2026-11-18-win/tools/probe-grow` at 125 %, then drag. `src/main/overlay-window.ts` (`moveTo`); `docs/handoffs/WINDOWS_AUDIT_2026-11_REPORT.md` §10.3, §11
- A size round trip at the top edge ends about 144 pt lower (Mac and Windows). `docs/handoffs/RECHECK_2026-11-18.md` d
- He rests about 25 pt under the menu bar. `docs/handoffs/RECHECK_2026-11-18.md` e
- No cap on SESSIONS rows (10 sessions grew the card to 380×626). `src/core/card-layout.ts` (`sessionsFor`)
- Two "Tokens today" rows at Medium cannot be told apart. `src/core/local-tokens.ts` (`LOCAL_TOKENS_LABEL`)
- The menu cannot tell an old hook command from a new one ("installed (port N)" only). `src/main/tray.ts`
- Claude renewal lists Mac-only paths on Windows (harmless). `src/main/claude-renew.ts`
- 0.2.8 known issues still open on 0.3.0 (re-checked from the code 2026-11-18): the card drawn over the right-click menu, Chrome window-fullscreen with its toolbar shown, the pet taking key focus (macOS). Each needs reproducing on screen before a fix. `docs/handoffs/RECHECK_2026-11-18.md` a–c
- ChatGPT's web route answers with a `WARNING_BANNER` only, so ChatGPT stays on the Codex CLI numbers (F23). A separate bug from the missing chat limits. `DISCOVERY_RE` does not match `/backend-api/conversation/init`, by design: not worth adding (see `docs/handoffs/CHATGPT_LIMITS_2026-11-18.md`). `docs/handoffs/QA_0.2.8_MAC_RECHECK.md`; `docs/handoffs/QA_0.2.8_WINDOWS_REPORT.md`
- Two Codex sessions merge into one row, and the Codex "waiting" mapping was never checked against a real hook body. `src/core/sessions.ts`; `src/main/hook-server.ts`
- Retry-after rules are still per provider (audit P4, fixed in part on purpose: unifying them changes behaviour per provider). `AUDIT.md` P4
- Audit lows fixed in part: P8 (the shared read-sanitise-write helper for discovered endpoints was not moved) and W-5 (the two crash-reload handlers stay separate on purpose). `AUDIT.md` P8, W-5
- The picomatch advisory is kept out of the installers by hand, not fixed; re-check after the next get-windows or node-gyp release. `AUDIT.md`; `scripts/check-asar.ts`
- `npm audit` reports 6 moderate advisories, all under electron-builder (app-builder-lib, dmg-builder); the fix is an electron-builder major bump, so it waits on Victor. `@types/node` 24 → 26 is also a major and is left. `package.json`
- There is no linter (no `lint` script, no ESLint or Biome config); typecheck and tests are the only gates. `package.json`

- The hook confirm dialog has no parent window on Windows. Seen 2026-11-18 with Notepad focused: Install and Remove (Claude Code and Codex) opened in front and took focus, Remove defaults to Cancel. Not seen with a fullscreen or always-on-top window in front. `src/main/dialog-host.ts:67`
- `npm run dist:win -- --config.directories.output=…` ignores the flag: `scripts/dist-win.ts` does not pass its arguments on, and `postdist:win` checks `release/` by name. `scripts/dist-win.ts`
- The settings window does not show a Developer ▸ Inject usage snapshot while it is open (it shows the next real poll), and opening it starts a poll that replaces an injected one. Dev only. `src/main/settings-window.ts`
- The Launch at login help line says the same thing twice in a dev build ("Only available in the installed app." and "Only the installed app can start at login."). `src/core/settings-spec.ts`
- The Intel Mac build (approved 2026-11-18) has been packaged but never run on an Intel Mac (QA 8.1a), and the next release must include `Walder-mac-x64.dmg` or the README link 404s. `electron-builder.yml`

## Languages

- Native review of the six machine-made translations (da, zh-CN, hi, es, fr, de); each table says so in its header. `src/core/i18n/`; `docs/accessibility.md` (Language)
- On-screen QA rows 12.1–12.8 (every language, and System), on the Mac and on Windows. `docs/QA-CHECKLIST.md` §12
- Check that `app.getPreferredSystemLanguages()` answers before `ready` on Electron 45 (first packaged run); if not, System falls back to English. `src/main/language-boot.ts`
- Spanish "Copilot completions" row reads "Autocompletado" alone: "Copilot autocompletado" is 22 columns and the row budget is 19. A native speaker may prefer another short word. `src/core/i18n/es.ts`; `test/card-layout.test.ts`
- Danish writes percentages without the usual space ("95%" rather than "95 %"). Keep it or add the space: Victor's call. `src/core/i18n/da.ts`
- French puts a plain space before ":", ";" and "?" outside the bubbles (card status lines, the window); where the line can wrap, the colon can land alone on the next line. Native review: use a no-break space there. `src/core/i18n/fr.ts`

## Docs

- The handbook was rebuilt for 0.3.0 but not re-read after PRs #23 and #24. `docs/handbook/`
- Antigravity process-name check: write down the result once it is run. `docs/DECISIONS.md`
- The handbook still says clicking the dog brings the terminal forward (`docs/handbook/build_walder.py` 571-575); fix in the handbook pass.
- Windows signing has no plan written down (only macOS is in `docs/signing.md`). `docs/signing.md`

## Art

- The 20-strip gate is satisfied (2026-11-18). Victor may reopen any strip for minor fixes; a reopened strip is approved again before it ships. `CONTRIBUTING.md` binding rule 1
- The `sit` pose for a waiting session was never added; waiting uses the head-tilt. `docs/CODENOTCH_GAP_ANALYSIS.md` P0-6; `src/core/behaviour.ts`
- `test/fixtures/decor-anchor-sheet.ts`: leave, or repoint two tests at the real sheet and delete it. `test/sync-sheet.test.ts`; `test/sprites.test.ts`

## Decisions waiting on Victor

- **ChatGPT chat limits**: researched 2026-11-18. Nothing readable exposes remaining chat messages today (CodexBar #3436 reached the same conclusion, 7 Oct 2026). OpenAI reportedly merges ChatGPT and Codex into one allowance for Plus/Pro/Business in December 2026, shown in ChatGPT Settings > Usage. After it ships: open Settings > Usage in Walder's login window and check whether `wham/usage` moves with advanced-model chat; if so, relabel the Codex rows. `docs/handoffs/CHATGPT_LIMITS_2026-11-18.md`
- **The `sit` pose** for a waiting session (new art). `src/core/behaviour.ts`
- **A linter** (ESLint or Biome in CI). Not decided.
- **The handbook on GitHub Pages**: publish it, or keep shipping it with each release only. `docs/release-repo/README.md`
- **`docs/release-repo/` folder name** (named after the archived repo): leave it, or rename it to a release guide. Cosmetic. `docs/release-repo/README.md`

## Waiting on Victor (setup)

- **Windows at 125 %:** switch the display to 125 % at the PC so the drag fix, the tray menu and the window can be checked there. `docs/handoffs/WINDOWS_SESSION_2026-11_REPORT.md`
- **Antigravity sign-in on the PC**, for the Gemini 200.
- **Mac session:** about an hour at an unlocked Mac for the Mac list above and the position faults.
- **Trash:** the old QA runs and installers were moved to the macOS Trash on 2026-11-18; the space comes back when it is emptied.

## Housekeeping (local, not in git)

- `art/out/`: the pre-rename Yuna folders are still there (`node art/render.mjs` regenerates it).
- `graphify-out/`: rebuild scoped or delete (built 2026-09-10).
- Stray `.git/objects/09/tmp_obj_*`: `git prune` when no other git process runs in the repo.

## Parked

- **Apple signing: not in the budget (2026-11-18).** No certificate means Mac users still need "Open Anyway"; auto-update and Electron fuses wait on the first signed build. `docs/signing.md`; `package.json` (`//signed-path`)

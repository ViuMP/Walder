# Windows session report (2026-11-18)

The brief was `docs/handoffs/WINDOWS_SESSION_2026-11.md`. Victor started it from his phone and was asked
for OWNER items only. Windows 11, one 1920 × 1200 display, at 100 % (the PC's setting when the session began, taskbar
shown), then at 125 % for the drag, the tray menu and Gemini (§4a). Evidence (PNGs, logs) is on the PC in
`%USERPROFILE%\Walder-qa\2026-11-18-win\`. No usage value is quoted here.

Branch: `win-session-2026-11-18`, off `main` at 036bdec, pushed. It holds three subagent branches
merged with `--no-ff` (`win-narrow-preview`, `win-drag-grow`, `win-gemini`) and two direct commits.

## 1. What the PC held, now saved

Branch **`pc-wip-2026-11`** (pushed, one commit, folder `pc-wip-2026-11/` with its own README). Saved as
diffs, nothing applied:

- all 15 files of `Walder-qa\2026-11-audit\patches\` (W3, M3, M5, M5b, D2, X1flash ×3, W6 ×2,
  combined, base-flash2-w6, decisions-local, inside-screen, **drag-grow** = the 125 % drag patch);
- `git diff HEAD` of the ten worktrees with uncommitted changes (`wt-audit-D2`, `-int`, `-M3`, `-M5`,
  `-M5b`, `-W3`, `-X1flash`, `wt-flash2`, `wt-inside`, `wt-w6`);
- the stash `x1flash-fix-before-b90aae4`;
- the one commit on no remote and not on main: c95be4b (local `qa-loop-win`/`qa-fix13`, chatgpt-web:
  an anonymous visitor is not a login, QA 4.2 / F23). **Still not on main** — worth a look.

Nothing was dropped or removed; see §7.

## 2. Gates (exit codes, never piped)

| tree | npm ci | typecheck | test | build |
|---|---|---|---|---|
| `main` 036bdec | 0 | 0 | 0 | 0 |
| `win-session-2026-11-18` after the merges | — | 0 | 0 | 0 |

Each subagent branch passed the same three gates on its own before the merge. `npm run dist:win`
built `Walder-0.3.0-win-x64.exe` (exit 0, asar check ok) — into `release\`, not the folder the brief
asked for: `scripts/dist-win.ts` drops its arguments (§6).

## 3. Faults found and fixed (root cause, shared code, unit test, re-checked on screen)

| # | fault | root cause | fix | test | on screen |
|---|---|---|---|---|---|
| 1 | **125 % drag: the window grows on every step** (audit §10.3, §11) | Confirmed at 125 % by a probe (§4a); written at `moveTo`: Electron's `setPosition` re-applies the size the window reports; on Windows that size comes from `ScreenToDIPRect`, whose enclosing-rect rounding at a fractional scale adds a DIP when the physical origin is not on the scale grid, and every `setPosition` re-applies it — so one per pointer event accumulates. Exact at 100 %. | 077330f: `moveTo` is the only way the overlay moves — one `setBounds` restating the size main last *asked* for; all five `setPosition` calls gone; `settleFor`/`insideEitherSize` for correcting moves of a window granted larger than asked | 4 new tests (a fake whose read-back grows by 1 DIP per read; fails before, passes after) plus the old patch's suites; 253/253 in the file | **100 %:** window 230 × 120 through 120- and 150-step drags; he follows the pointer (−994, +249 for −1000, +250) and slides along the right edge. **125 %: pass** (§4a) |
| 2 | Space on a Show-in-overview switch toggled it once, the next Space scrolled the page | `renderSettings` restores focus by element id after each save; the per-service switches and the credit price's amount and currency fields had no id | bef4a58: ids on all of them | `settings-focus-ids.test.ts` (fails before, passes after) | focus stays on the switch through two toggles |
| 3 | **Row 10.7:** at the minimum width (440 px) the hover-card Live preview ran off its frame (percentages cut, sideways page scroll), and the Overview squeezed the card to ~110 px beside the dog | the painter pins the card to its true width and nothing narrowed or scaled the Live preview; `placeCard` set `maxWidth` to the room left of the dog | 69ad475: `previewScale` (core) + ResizeObserver; both previews are laid out at their true size and scaled whole with `transform`; scale exactly 1 at the default width with the Medium dog | `preview-scale.test.ts`, `narrow-preview-markup.test.ts` | both previews whole at 440 px, no sideways scroll. Side effect, in DECISIONS: a Large dog with a Large card at 1140 px now scales to ~0.93 instead of squeezing the card |
| 4 | **Gemini on Windows** always said "Antigravity is not running" | the provider ran `/usr/bin/pgrep`, `ps`, `lsof` and looked for `language_server_macos_arm` | 0ec217c: one fixed PowerShell call (absolute path, no values interpolated) finds `language_server.exe` by exact path suffix `\antigravity\resources\bin\language_server.exe`, own session only, then its csrf token and listening ports; macOS path unchanged | 25 Windows tests failed before, 43/43 after | discovery finds the server and both ports; the card now says "Antigravity is running but its language server did not answer" (not signed in). signed in, `ok via antigravity` after a second fix, 808b6a0 (§4a) |

## 4. On screen, 100 %

Dev build unless said; installed = the locally built 0.3.0 installed silently over 0.2.9 and started
through Explorer (it reads the real `%APPDATA%\walder`). The checklist's Windows column carries each
result with this date.

| rows | verdict |
|---|---|
| 10.1 rail by click and keyboard | pass |
| 10.2 preview, 10.3 Apply/Revert/close discards | pass |
| 10.4 theme | Light/Dark pass, Dark survives a relaunch; Automatic following an OS switch not run (OWNER) |
| 10.5 hover card customization | pass |
| 10.6 Restart | pass on the installed build; in a dev build the relaunched process loads the dev-server URL that died with the first process (audit §5 item 3: cause found, dev-only) |
| 10.7 narrow window | fail → fixed (§3 #3) → pass |
| 3.4a, 3.4e, 3.4f, 3.4h, 3.4i, 3.7, 3.9, 3.10, 4.10, 9.12 | pass |
| 3.11, 3.12, 3.13 | pass (installed) |
| 3.5, 3.6 | partly (Red and Chocolate only) |
| 3.8 | dev half pass; installed half needs a restart (OWNER) |
| 9.19 | startup part pass; six-hourly part not waited for |
| 7.15a | pass (installed, scripted hooks) |
| Hooks ▸ Install / Remove with Notepad focused (brief step 4) | pass: each dialog opened in front and took focus; Remove defaults to Cancel; Cancel pressed; `~/.claude/settings.json` and `~/.codex/hooks.json` unchanged by hash |
| README screenshots (brief step 2) | done: ten images in `assets/windows/` (3824d04) with the macOS sample numbers, an "On Windows" README section and alt text for every image in `assets/windows/README.md`. Made from the dev build with a scratch inject that was never committed; the Sessions line was hidden by the same scratch because it shows a local path |

### 4a. At 125 % (2026-11-19, after Victor switched the scale; taskbar shown, DPI 120)

| check | result |
|---|---|
| **Root cause of §3 #1** (`tools\probe-grow\main.cjs`, Electron 45.3.4) | **confirmed.** A frameless non-resizable window asked for 88 × 120 DIP: after 1, 10 and 20 `setPosition` moves it read 96 × 128, 105 × 140 and 116 × 153 DIP; the same moves made with `setBounds` at the asked size stayed at 88–89 × 121 (the constant 1 DIP grant, never accumulating) |
| **Drag with the fix** (dev build) | **pass.** Window 348 × 150 physical px through 150, 100 and 150 steps; a 250 px horizontal drag moved him 247 px right with no vertical change (before: 45 DIP down and an oversized window); a drag past the top-left corner left him flush in the corner, no gap |
| **Tray menu at 125 %** (installed local 0.3.0) | **pass.** It fits on the screen whole, Restart and Quit included, no scroll arrow (0.2.9 needed one) |
| **Gemini with Antigravity signed in** | first **fail**: polls read "not running" although Antigravity ran. Cause: the PowerShell discovery took 1.8–1.9 s on four of four runs, at the 2 s limit shared with the macOS tools. Fixed in 808b6a0 (Windows gets 8 s, `execTimeoutFor`, `test/antigravity-timeout.test.ts` fails before, passes after); then `poll gemini: ok via antigravity (2 buckets)` and the card shows a Gemini section |

Not done at 125 %: the window rows (seen working at 100 %; the narrow-window fix measured only at 100 %).

## 5. The brief's steps

1. Window at 100 % done (§4); tray menu at 125 % done (§4a); window rows at 125 % not run.
2. README screenshots: done.
3. 125 % drift: root cause confirmed by the probe, fix sound on screen at 125 % and 100 % (§4a).
4. Hook confirm dialogs: done, pass.
5. Gemini: Antigravity installed on Victor's yes (winget `Google.AntigravityIDE` 2.7.0, publisher
   Google, hash verified); probed (process, path, flags with tokens redacted, two loopback ports: one
   TLS, one HTTP that answers 500 unsigned / 401 without the token); provider ported (§3 #4). Notes:
   `ev\gemini\notes.md`. A subagent's first probe printed that run's two local per-launch tokens into
   its own transcript only; Antigravity was restarted afterwards, so both are void.
6. OPEN_ITEMS Windows re-checks with no login/restart/second monitor: 7.15a done; §5 item 3 explained;
   the hook dialog item seen; the rest stays listed in `docs/OPEN_ITEMS.md`.

## 6. Found, not fixed (in OPEN_ITEMS)

- `npm run dist:win -- --config.directories.output=…` ignores the flag (`scripts/dist-win.ts` does not
  forward its arguments, and `postdist:win` checks `release/` by name).
- Accounts ▸ Gemini says "could not be reached — check the connection" for a running but signed-out
  Antigravity; the card's wording is right.
- Dev only: the settings window ignores an injected snapshot while open, and opening it starts a poll.
- The Launch at login help says the same thing twice in a dev build.

## 7. OWNER list, and what the PC still holds

**For Victor:**
1. Set the display back to **100 %** (it is at 125 % for §4a). Done by Victor: 125 % and the
   Antigravity sign-in (2026-11-19).
2. Antigravity stays installed and signed in; remove it if Gemini is not wanted.
3. Review the PR; merge decisions are yours. Look at c95be4b (§1) separately.
4. The rows that need you: 11.2, 11.3 (Narrator), 3.8 installed half and anything with a restart or
   sleep, 10.4 Automatic (OS theme switch).
5. Tidy when ready (none removed by the session):
   - worktrees `wt-audit-D2`, `-int`, `-M3`, `-M5`, `-M5b`, `-W3`, `-X1flash`, `wt-b90aae4`, `wt-fix12`,
     `wt-fix13`, `wt-flash2`, `wt-inside`, `wt-w6` under `Walder-qa\`, and this session's subagent
     worktrees under `.claude\worktrees\` in the checkout — all their changes are on `pc-wip-2026-11`
     or merged;
   - the stash `x1flash-fix-before-b90aae4` (saved);
   - local branches `qa-fix1`–`qa-fix13`, `qa-loop-win`, `qa-win-tests`, `fix-dist-win-on-windows`;
   - the Windows Firewall block rule for Node.js that Cancel created (Victor's choice, 2026-11-18);
   - Antigravity (`%LOCALAPPDATA%\Programs\antigravity` and `Antigravity IDE`) if not wanted.
6. The installed Walder is now the locally built **0.3.0** (from main 036bdec), not 0.2.9. Settings are
   as Victor had them (checked key by key against the backup; only runtime state and two new 0.3.0
   defaults differ). Backup: `Walder-qa\2026-11-18-win\backup\appdata-walder.zip`.

**Accidents, none with an effect:** one right-click opened Microsoft Teams' tray menu (the overflow
rearranged when Antigravity's icon appeared; closed with Esc, nothing chosen — the menu helper now
opens Walder's menu from the dog and checks the menu belongs to Walder); one click on the blank title
bar of Victor's Claude window and one End key in its transcript; one AutoHotkey error dialog closed;
Gemini switched on by mistake in the dev settings copy and off again. Three times a helper script
pressed Esc to close a menu it could not find while the Claude app was in front, which cancelled the
running command as if Victor had pressed it; the helpers now refuse to send keys unless Walder or
Notepad is in front.

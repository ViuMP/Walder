# Windows session brief (written 2026-11-18)

A brief for a Claude Code session on Victor's Windows PC. It runs without Victor at the keyboard:
he starts it, then follows it from his phone. Paste this to start:

> Read `docs/handoffs/WINDOWS_SESSION_2026-11.md` in this checkout and carry it out. Multi-agent
> orchestration is approved. Ask me only for the items marked OWNER.

## Before you start (Victor, about five minutes at the PC)

1. Plug the PC in. Set Settings ▸ System ▸ Power ▸ Screen and sleep to **Never** while plugged in,
   so the screen neither sleeps nor locks during the run. An agent may not change this for you.
2. Open the Claude desktop app, Code tab, in the Walder checkout, and turn on Remote Control so the
   session shows on your phone.
3. Paste the line above. Leave the PC alone until the session asks for you.

## 1. Save what is on the PC first

The PC holds work that exists nowhere else: the 125 % drag patch, uncommitted changes, the stash
`x1flash-fix-before-b90aae4` and six-plus worktrees under `%USERPROFILE%\Walder-qa\`
(`docs/handoffs/WINDOWS_AUDIT_2026-11_REPORT.md` §10.4, §11).

- Run `git status`, `git stash list`, `git worktree list`, and list `%USERPROFILE%\Walder-qa\*\patches`.
- Commit every uncommitted change, and each patch file not already on `main`, to a new branch
  `pc-wip-2026-11` and push that branch. Do not apply anything to `main`. Do not drop the stash or
  remove worktrees yet; list them in the report for Victor.
- Then `git switch main`, `git pull --ff-only`, `npm ci`, and the gate:
  `npm run typecheck && npm test && npm run build`, judged by exit code, never piped through
  `grep` or `tail`.

## 2. What to do (agent-only rows)

Work on a branch `win-session-<date>` off `main`. Evidence (PNGs, log excerpts, `notes.md` per row)
goes to `%USERPROFILE%\Walder-qa\<date>-win\`, never `%TEMP%`. Back up `%APPDATA%\walder\` there
first, and restore by extracting into that exact folder only.

Build the installer locally with `npm run dist:win` and an output folder outside `release/`
(`--config.directories.output=%USERPROFILE%\Walder-qa\<date>-win\dist`). A locally built installer
carries no download mark, so SmartScreen does not stop it.

1. **The Walder window on Windows**, at 100 % and at 125 %: rows 10.1–10.7 and the rows the window
   reset (3.4a, 3.4e, 3.4f, 3.4h, 3.4i, 3.5–3.13, 4.10, 9.12, 9.15c, 9.19) in
   `docs/QA-CHECKLIST.md`, Windows column. The tray menu at 125 % (shortened in 0.3.0, never seen).
2. **Windows screenshots for the README**: the same set as `assets/macos/` (hero, tracking card,
   the three alerts, the window pages, light theme), same sample numbers, same file names, into
   `assets/windows/`. Use the Developer menu (`WALDER_LOG=1`) to inject the sample numbers and, for
   out-of-credit or spend-limit rows, the account-state switch once it is on `main`. Crop to the
   dog, the card or the window; nothing else of the desktop may show. Write alt text in the README
   style and add a Windows section or a platform note to `README.md`.
3. **The 125 % drift** (`WINDOWS_AUDIT_2026-11_REPORT.md` §10.3, §11): the window grows while it is
   dragged at 125 %. Find the cause, starting from the `setPosition` call in the drag path of
   `src/main/overlay-window.ts` and the patch saved in step 1. Fix it in the shared code with a unit
   test, then measure on screen at 100 % and 125 % against the tables in §11.
4. **Hook confirm dialogs**: choose Hooks ▸ Install and Remove from the bone menu with another window
   focused. Check that the dialog stays in front and that Remove has Cancel as the default button.
   Press Cancel; do not change the installed hooks.
5. **Gemini on Windows**: if the Antigravity IDE is installed, start it and record how its language
   server runs on Windows (process name, command line flags, listening ports) without its token
   values, so the provider can be ported. Follow `docs/handoffs/GEMINI_WINDOWS.md` if it exists on
   `main`. If Antigravity is not installed, say so; do not install it without Victor's yes.
6. The re-check items in `docs/OPEN_ITEMS.md` under "Needs an on-screen check: Windows" that need no
   login, no restart and no second monitor.

Every fault you find: root cause first, fix at the shared function with a unit test, gate by exit
code, commit as `victorprehn@live.com`, re-check the row on screen.

## 3. Not in this session (OWNER, or later)

- Narrator and keyboard rows (11.2, 11.3): Victor has to listen.
- SmartScreen on the downloaded exe, logins (Claude, ChatGPT, Cursor, Copilot), restarts and sleep.
- A second monitor and mixed scales: no hardware.
- Changing Windows settings, typing passwords, publishing releases.

## Lessons from the earlier Windows passes

- Open the tray menu with a real click on its icon. Check the window under the cursor before every
  click; earlier passes clicked into Victor's Claude window by mistake.
- One Walder at a time: dev and packaged share `%APPDATA%\walder` and a single-instance lock.
- Victor's own Claude Code sessions post hooks all the time. For a `?` that stays up, send a Codex
  event to the hook port (`X-Walder-Source: codex`, no Origin header).
- A lost mouse-up looks like a stuck drag; send the release again before calling it a bug.
- Screenshots are in physical pixels; clicks may be in logical ones. Note the scale with each one.
- Do not sign in to anything in a browser; an earlier throwaway Edge profile signed itself into
  Victor's work account.

## Finish

- Push `win-session-<date>` and open a pull request. Never merge, release or force-push.
- Write `docs/handoffs/WINDOWS_SESSION_2026-11_REPORT.md` on that branch: what passed, what failed
  and was fixed, what is left, the OWNER list, and what the PC still holds (stash, worktrees).
- Update `docs/OPEN_ITEMS.md` and the Windows column of `docs/QA-CHECKLIST.md` with dates.
- Leave the PC as found: quit dev builds, start the installed Walder, put the display scale and
  taskbar back the way Victor had them.

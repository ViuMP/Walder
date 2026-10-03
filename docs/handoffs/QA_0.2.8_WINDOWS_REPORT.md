# QA loop report — Walder 0.2.8, Windows (2026-10-02/03)

Machine: Windows 11 Pro 26200, one 1920×1200 display at 100 %, Windows PowerShell 5.1, Node 24.18. Branch `qa-loop-win` off `main` (cfef143, the Mac loop's merge). Coordinator and advisor: Claude Fable 5.1; hands: Opus subagents driving the app with real input (SendInput / AutoHotkey v2), UI Automation for the tray, GDI screenshots. Evidence: `C:\Users\Victor\Walder-qa\evidence\<row>\` (first pass), `…\evidence\R\`, `R6\`, `R7\` (the regression pass on the final code), one `note.txt` + `log.txt` + PNGs per row; the Mac pass lost its evidence to `/tmp`, so this one lives in the home folder.

## Fixes on `qa-loop-win`, each with a unit test, gate green (`npm run typecheck && npm test && npm run build`, 2584 tests on Windows)
1. 56296b7 **fullscreen: the Windows helper compiles.** `fullscreen-win.ps1` had never run on Windows: `Add-Type -MemberDefinition` already emits `using System.Runtime.InteropServices`, and the explicit `-UsingNamespace` duplicate is a compile error on PowerShell 5.1 (warnings as errors). The helper exited 1 on every launch and the dog never slept over a film on Windows (rows 1.7, 6.1–6.11). `test/fullscreen-win-helper.test.ts` runs the script for real on win32.
2. 575c54d **the unit suite holds on a Windows checkout** (merge of `qa-win-tests`): 33 tests and one suite assumed POSIX paths, LF fixtures or a spawnable `.cmd`; `test/support/host.ts`, `.gitattributes` for `*.snap`. No app change.
3. e9ba50f **overlay: a Size change keeps him wholly on the work area.** The resize path used the drag clamp (24 px reachable), so Small → Large at the default corner ran the window to x 2102 on a 1920 px screen (row 3.3); macOS hid it because NSWindow constrains frames. New `clampRectInsideWorkAreas` for menu-driven size changes and for box changes of a dog already on screen; drags and bubbles keep the old rule.
4. 0f537f3 **hover: a watchdog brings the card down when Windows sends no mouse-leave.** After a drag that ends on him (pointer capture released) a fast exit produces no `WM_MOUSELEAVE`; the card stayed up for over a minute. Main polls the cursor every 200 ms only while a card is wanted and resyncs the renderer (`cursorOffWindow`).
5. d63ec67 **Reset position puts the resting window at the 16 px spot** even with a bubble up (was 21 px). 8981dbf **a Windows cwd is shortened at backslash components** on the card's SESSIONS line (`…\Desktop\Walder`, not `… Clausen Engineering\Desktop\Walder`).
6. e2f4cbb **credentials: the Claude Code login read says why it found no token** (key names only, never values): on this PC `.credentials.json present, keys: mcpOAuth — no claudeAiOauth block`. 798576f stale "three hooks" comments.
7. 02a3301 **hooks: the settings rename is retried while Windows has the file open** (one install in three hit EPERM with Claude Code watching `settings.json`; five bounded tries over ≤500 ms on EPERM/EBUSY/EACCES, same atomic rename, same cleanup). bc678da **the Windows hook command exits 0 when Walder is not running** (`powershell -Command "try {…} catch {}"` returned 1 — Claude Code showed every hook as failed while Walder was down, row 7.8; now `; exit 0 # walder-hook`, existing installs upgrade in place). 1f9764d **the tray menu is rebuilt right after a hook install or removal.**
8. f855c51 **on Windows the tray menu is rebuilt every time it opens, right-click included.** Electron shows a `setContextMenu` menu on right-click without emitting any event, so a right-click showed last poll's labels (`Refresh now (wait 60s)` frozen, rows 4.10/9.18). On win32 no context menu is set and both clicks open the freshly built menu through `popUpContextMenu(menu)`; macOS/Linux unchanged.
9. ebc45f1 **behaviour: a first-run intro beat holds against a usage bark** (platform-independent, found because the owner's 5-hour sat at 82 %): the hello was queued as a plain notice, which a bark displaces for good, so a new user whose first poll barks never read "Click the bone" (row 7a.1). Intro beats now queue the bark behind them, like a held `?`; the intro advances only on the pet that clears a beat. 0cfaa01 **the beat-3 hook offer opens when its own bubble is on screen**, not one click early over the bark.

## Rows reworded or qualified on Windows
- 3.3 passes with the fix (at the corner he is pulled left so his whole body stays visible; mid-screen the bottom-left stays put).
- 4.19 fallback half: out on this PC — the desktop app's Claude Code keeps its own login, and the standalone CLI has none here (owner: `claude` ▸ `/login` if wanted).
- 3.4i3: the first poll lands within 250 ms of the first frame on this PC, so a pre-poll hover cannot be made; the first card after a relaunch is filtered.
- 5.9a2: no two-line bark text is producible from the Inject menu on this account; the no-clip half passes at all three sizes.
- 7.17 live half: needs a terminal `claude` session (the desktop app's sessions do not write `~/.claude/sessions`).
- 9.13 **is** producible on Windows (RegisterHotKey refuses a second owner) and passes.

## OUT
Hardware: 1.8 (one display at 100 %), 2.5, 2.6, 2.7, 6.4. Account states: 3.4g, 3.4l, 4.13, 5.9b, 5.9c, 5.9d, 9.15a, the 455 % figures of 4.24, the comparison half of 3.4i2, the no-`~/.codex` half of 7.13.

## Findings outside the rows (for Victor)
- **DPI (F1/F4):** `devicePixelScale` rounds scale·dpr while layout uses it unrounded; at 125 % the Medium dog would draw 20 % larger than its window, and the fullscreen helper's physical-pixel rect is compared against DIP bounds. Only visible on a scaled display; worth one look at 125 %.
- **Art (F7):** one catch-light pixel per eye sits in a coat palette slot and follows the coat (grey on Black and tan, orange on Chocolate). Same sheet as the Mac; untouched.
- **Wording (F3, F12, F13, F17):** "menu bar" in the hello on Windows; 3.4f/3.4i "directly under Card size" and "two radio items" are stale (five services); 6.5 "then curls back up" happens after the bark is clicked away; 7.4 still says `woof` / "a few seconds"; 8.3 "offers a desktop shortcut" — the wizard creates it without asking (`createDesktopShortcut: true`).
- **Behaviour notes (F14, F18, F20, F11):** a cursor resting on him does not restart the hide-when-idle linger (clicks do); a bubble arriving mid-drag at the right edge leaves half of him off-screen (30 px reachable); when a `?` stands down only the newest deferred bark surfaces; opening the tray overflow over a fullscreen video reads as `fullscreen left` because explorer counts as not-fullscreen.
- **Diagnosability (F10):** "Login not checked yet" shows for both services after a relaunch until the first login check.
- **chatgpt.com route (4.22):** on this PC the chatgpt.com session answers an unexpected `WARNING_BANNER` payload, so ChatGPT is fed by the Codex CLI and the `[chatgpt-web]` dump block never prints; re-check after the owner's 4.2 login.

## Harness caveat worth knowing (F21)
The session's tool shells run under the Claude desktop app's MSIX file-system virtualisation: their writes to `%APPDATA%\walder` land in `…\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\walder`, while a Walder launched by Explorer, by the installer or by Victor uses the real folder. All dev and in-shell packaged runs were self-consistent (one view), so their results stand; one installer-launched instance in the regression pass found the real folder moved aside by an earlier restore and came up blank (not a Walder fault). The real folder was restored from an Explorer-launched script at 01:53 and the packaged rows were re-run with Explorer-launched instances. Next time: launch the packaged app through Explorer and touch the real folder only from outside the virtualised layer.

## What the Mac column should be re-checked for after these fixes
- 7a.1 with the 5-hour at or above 80 % at first launch (fix 9 is platform-independent).
- 3.3 at the default corner at Medium/Large (the strict clamp now applies on the Mac too; NSWindow used to hide the overflow).
- 2.4 with a bubble up (fix 5).
- 4.4 / 5.9h hover after a drag that ends on him (the watchdog runs on the Mac too).
- The SESSIONS line and the tray refresh after a hook write (fixes 5 and 7).

## Owner session
_Pending — filled in after the sitting._

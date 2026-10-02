# QA loop report — Walder 0.2.8, Mac (2026-10-01/02)

## Fixes on `qa-loop` (off v0.2.8 = d1ec2a3), each with a unit test, gate green
1. b27cad9 overlay: a saved position always means the standing window (quit while asleep/lying relaunched him 48–58 pt lower; pet on a widened bubble saved x−extra).
2. 5081adb card: the primary service's section leads the hover card (never worked since 0.2.2).
3. 8b9085e store: one bad key in walder.json costs only that key (was: the whole file reset); Large card's credit row wraps instead of truncating its label (0.2.6 regression).
4. 0d0082f overlay: bubbles laid out inside the on-screen part of the window (intro and barks ran off the right edge at the default spot).
5. 13dcacb four small ones: hook body cap 8 KiB → 1 MiB (real Stop hooks were refused); size change mid-bubble no longer shifts him; Inject usage gains 96 %; `remaining` printed verbatim in the shape dump.
6. a39b74b fullscreen: Walder frontmost after a pet holds the fullscreen state (a pet over a film woke him for good).
7. f9502a5 overlay: bubble re-laid-out when the window's screen position catches up (hooks notice after the intro stayed cut).
8. 71dbc5c hooks: an oversized hook body (PostToolUse with a big tool_response) is dispatched from its head; Log out forgets the last login check (tray said "Logged in" after ChatGPT ▸ Log out).

9. 9bacbd8 dialogs: the hook offer no longer stops the main process (a parentless macOS alert runs a nested modal loop) and waits for the dog to paint.
10. 75d0ce3 one Tokens today row after a relaunch; one log line per bad settings key; a logout reads as logged out (empty cookie jar answered without a request; cache cleared with the storage).
11. 4a82547 restored rows keep their order (primary bias stripped on restore); the offer waits for the overlay's first frame (2 s ceiling); tray confirmations are non-blocking too; the Codex offer names the /hooks trust; stale WARN wording.
12. 25224ec the bubble widens to the room that is on screen (Large dog mostly off the corner); a lost mouse-up ends a drag; the hit mask is the union of the animation's frames so a blink never toggles hover.

## Rows reworded to what the app does (approved by Victor on 2026-10-02, committed)
3.6 (Black and tan is grey by decision a7cb798), 4.10 (an open tray menu never redraws), 5.6 (96 % exhausted, 100 % out), 3.4k (per-service ticks re-publish the last real poll), 9.4 (bubble up from the first wake frame), 5.9h (a click hides the card for a moment), 4.17 (the row prints the currency claude.ai reports — EUR on this account, with a €60 monthly limit).

## OUT
Hardware: 1.8, 2.5, 2.6, 2.7, 6.4, 5.9a2 non-Retina half. Platform: 9.13 (macOS lets two apps register the same hot key, so "already used" cannot occur). Account states nobody can produce: 3.4g, 3.4l, 5.9b, 5.9c, 5.9d, 4.13, 4.17 monthly-limit variants, 9.15a (ViuMP/Walder now has releases), the "numbers disappear"/"confused" halves of 4.11, 9.7, 9.21 and the comparison half of 3.4i2 (the CLI logins keep both services fed), the no-`~/.codex` half of 7.13.

## Known issues left open (not rows)
- A pet takes key status from the window under him (Electron panel still activates the app; a `app.hide()`-after-click experiment is sketched, unverified).
- Chrome window full screen with its toolbar shown is not detected (content window 996 px high); player full screen is.
- `installed (port …)` is shown with 3 of 4 hook entries present.
- The Walder login item was registered twice (seen in System Settings ▸ Login Items on 2026-10-02; Victor removed one). Likely across the 0.2.7 → 0.2.8 reinstalls; the registration path deserves a look before the next release.
- The hover card is drawn over the right-click menu (cosmetic).
- A finished `claude -p` run from inside the Claude desktop app's terminal gives no perk: the session's app is frontmost (by design, onFrontmostApp).
- Copilot's usage poll hits api.github.com even when Copilot is hidden in Show in overview.

## Owner session (2026-10-02)
Done with Victor: logins 4.1/4.2/4.12 (SSO through the login window, closes itself, polls via the web logins within seconds), 7.14 (Codex lives in ChatGPT.app; `/hooks` trust there, then `Codex done`), 9.17 (Wi‑Fi off → `Last check failed (09:51)`), 3.2 (template icon on the dark bar), the Claude-desktop leveldb repair, the six + one rewordings. Codex hooks are trusted on this Mac from now on.

## Evidence
Each driver block saved screenshots, log excerpts and one note per row in the session scratchpad; the restart for rows 8.5/8.6 cleared /private/tmp and with it that folder. The surviving record is this checklist (Result cells), the block reports in the session transcript, and ~/Library/Logs/walder/walder.log. Next time: keep evidence under the repo's ignored `release/` or a home folder, not /tmp.

Also seen on 2026-10-02: a "Login Item Added" notification on an ordinary launch, i.e. the app re-registers its login item at launch — the likely source of the duplicate entry.

## What the Windows pass should look at first
1. The tray menu: accelerator glyph `Alt+Shift+W`, the `Developer ▸` caption with the log path, the Refresh/Update cooldown labels (same snapshot behaviour as macOS?).
2. Fullscreen via `fullscreen-win.ps1` (never run): 6.1–6.3, 6.9 (YouTube in Edge/Chrome), 6.10/6.11, and whether a pet activates the app there too (6.3's root cause).
3. Position save/restore with the taskbar work area (2.2–2.4) and the DPI rows (1.8 — Windows scaling is the common case).
4. Settings file: `%APPDATA%\walder\walder.json` bad-key survival (4.24) and the install-over (8.7), SmartScreen (8.4), Launch at login (8.5/8.6).
5. Hooks: the `curl` command in `%USERPROFILE%\.claude\settings.json` on Windows shells (7.1–7.9), oversized bodies (7.4).

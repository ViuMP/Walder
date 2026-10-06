# Mac re-check after the Windows fixes — Walder 0.2.8 (2026-10-05/06)

Branch `qa-mac-recheck` off `qa-loop-win` (5345569). MacBook Pro M4 Pro, built-in Retina display only (1728 × 1117 pt, dpr 2), Dock visible. Dev build (`WALDER_LOG=1 npm run dev`, verbose log on) for every row; Opus subagents drove the app (screencapture, cliclick, System Events for the tray after a real click), the owner did 4.8 and 4.11/4.12. Evidence: `~/Walder-qa/2026-10-05-recheck/<row>/` (PNGs, `log.txt`, `note.md`), driver manual and helper scripts beside it.

Gate (`npm run typecheck && npm test && npm run build`, by exit code): green on the branch as fetched (2660 passed, 2 skipped — no macOS portability fix needed) and after the fix below (2662 passed).

## Fix
14. 2302f90 **behaviour: a held perk and a lie-down bark survive a posture change** (the sibling 1603846 flagged). The renderer's `applyMode` releases whatever gesture is playing when the box changes; 1603846 put the `?` tilt back, but nothing else. Confirmed on screen before the fix: with `Codex done` up, Weekly 96 → 45 stood him up plain, ears down, under the bubble; 45 → Weekly 92 played the bark's sound and bubble but never drew the bark (no mouth-open frame in 3.7 s at 50 ms captures). `settle` now asks for the gesture the bubble on screen is wearing after the `mode`: the tilt for a `waiting`, the perk for a `done` or a notice, a bark only when the same batch started it (an old bark under a posture change gets the ordinary `wake`). Two unit tests; re-checked on screen (perk held both ways, bark frames at +139…+302 ms then the lie, no second bark under an old bubble, 7.15 a/b/c, 5.6/5.10/5.11 unchanged). The perk replaces the stand-up `wake` when he rises under a `done`, and the perk, tilt and bark are standing art, so for a moment he looks standing in a lie box — both by the P2-3b rule that a gesture plays over either lie.

## Rows (Mac column, appended to each Result cell)
All pass, 1.8 stays out (no scaled external display; the Retina half passes).
- Layout (665c61d/ba70ea4) — 1.1, 1.4, 1.5, 1.8, 3.1, 3.9, 3.10: feet on the floor and centred at every size (margins 8/16/24 pt, exact 1:2:3), every sprite pixel a solid 2×2/4×4/6×6 block, clicks and right-clicks on him, corners through to TextEdit. The hit test keeps one sprite pixel of slack (`HIT_DILATE_PX`), so a click 1–3 pt outside his outline at Medium/Large still pets — by design.
- Strict clamp (e9ba50f) — 3.3: at the corner he grows left with his ink ending at x 1728; mid-screen the bottom-left stays put; parked over the right edge, a size change pulls him fully in.
- 2.1–2.4: Reset with and without a `Codex waiting` up lands at 16 px from the right edge and the work-area bottom; same spot after a relaunch.
- Hover (0f537f3) — 4.4, 4.5, 5.9h: the card flips at all four edges; after a drag ending on him and a fast exit it is down within 0.3 s (3 of 3 — macOS sent the mouse-leave itself; the watchdog fired on its own five times, e.g. leaving while his menu was open).
- Faces and barks — 5.2, 5.3, 5.6, 5.8, 5.9, 5.9g, 5.10, 5.11, 7.15 (from standing, lie, lie_down, and stand → lie_down during the wait).
- Intro (ebc45f1/0cfaa01) — 7a.1–7a.3 with a fresh settings file and the Claude Code hooks removed for the run (with them installed beat 3 says nothing): the hello held 30 s against two deferred barks; each bark took one click; the offer dialog came with its own bubble.
- Poller (d7c76fe) — 4.10, 4.14, 4.11 (+4.12 with the owner), 4.8 with the owner (Wi-Fi off, lid closed 2.5 min: rows kept with `net::ERR_INTERNET_DISCONNECTED`, no `?`, `wake: no network yet; holding the poll`, then the quick retry came back ok).
- 4.23 and the SESSIONS line (8981dbf) and the tray after a hook write (1f9764d): a long cwd cut at a `/`; the status line fresh on the next real-click open after Remove and Install; `~/.claude/settings.json` byte-identical afterwards.

## Observations (not row failures)
- **chatgpt.com `WARNING_BANNER` (F23) on the Mac too**, but only after a fresh login: before the 4.11 logout the route answered `/backend-api/wham/usage`; after the owner's re-login it answered `WARNING_BANNER` only and ChatGPT stayed on the Codex CLI. The login window closed itself 2 s after opening — if chatgpt.com shows a consent step after login, the window may close before it appears.
- **4.8's stale marker** is unseen with a short sleep: the kept numbers were 5 min old, under the 2 × interval (6 min) threshold, so the header still read "refreshed just now" (the tick's time) while every status line said `net::ERR_INTERNET_DISCONNECTED`. At wake the regular poll timer also ran once outside the wake window, before `pollAfterWake` opened it (errors, rows kept).
- The hover card sits beside his 88-pt box, not beside the wider bubble window, so it can cover the start of a bubble (placement unchanged since `main`).
- A first-launch `Install Claude Code hooks` notice stays up after the hooks are installed from the tray, until he is petted.
- For 100–270 ms after a bark the bubble is drawn wrapped or ellipsised in the old narrow window, before main widens it.
- The bubble floor is the top of the 72 × 72 frame, ~23 sprite rows above the golden coat's head (unchanged at dpr 2).
- D11 not seen: every pet in the session landed.

## Not run
1.8's scaled-display half (no external display). Nothing else.

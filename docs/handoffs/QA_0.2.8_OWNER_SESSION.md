# Owner session — Walder 0.2.8 QA loop (Mac) — DRAFT, finalised when the AGENT rows are green

One sitting, in this order. I drive the checks and read the evidence; you do only the steps marked YOU.

## 0. Build and install the fixed packaged app (needed for the final pass)
YOU, from the repo on `qa-loop`:
```bash
npm run dist:mac
```
Then I install it (quit Walder, copy from the dmg into /Applications) and rerun the packaged-only rows plus the regression over everything that passed, on that build. (The released dmg file is backed up in the scratchpad and is restored into `release/` at the end; the GitHub release is untouched.)

## 1. Claude desktop app repair (not Walder; my mistake earlier today)
YOU (one command; blocked for me as destructive):
```bash
cd "$HOME/Library/Application Support/Claude/Local Storage/leveldb" && printf 'MANIFEST-030858\n' > CURRENT && rm -f 000003.log MANIFEST-000001 && cat CURRENT
```
Expect the Claude desktop app to ask you to sign in again at its next relaunch (its cookie file was replaced).

## 2. Wording approvals — five rows where the app is right and the row is stale
Approve or amend; I commit the new wording with the results.
- **3.6** Black and tan: chest/feet are GREY by your own decision (a7cb798, 2026-09-18). Proposed: "On Chocolate the chest, feet and ear hems turn tan; on Black and tan they turn grey (the body stays near-black)".
- **4.10** Refresh cooldown: macOS never redraws an open tray menu. Proposed: "… is greyed out. Close the menu, wait out the minute, reopen it: the item reads Refresh now again and is enabled, with nothing else clicked. A menu held open keeps the label it opened with."
- **5.6** 100 % shows the approved `out` pose (lying, X eyes); `exhausted` (tongue out) is 95–99. Proposed: "Inject 96 % → exhausted (tongue out, ears flat) and one bark; then 100 % → out (the lying pose with X eyes) and one more bark".
- **3.4k** Show in overview is per service since 0.2.7 and any tick re-publishes the last real poll, which re-arms the window, so the inject sequence barks for a reason the row does not describe. Proposed: drop the second 91 % inject; keep "inject 96: barks, because 95 is a level he has never said", and note that re-ticking replays the last real poll.
- **5.9h** A press on the dog hides the card for ~0.25 s by the drag-start rule and it returns in the same place; a bark and a blink leave it alone. Proposed: add "(a click hides it for a moment and it comes back in place)".
- **9.4** The bubble is up from the first wake frame by design. Proposed: "he appears already saying it — the bark bubble is up from the first frame while he plays the wake stretch — and is gone about 8 s after the bubble clears". (If you would rather have wake-then-speak, it is a renderer-only change; say so.)

## 3. Logins (rows 4.1, 4.2, 4.12) — then I re-check the rows that need a claude.ai session
YOU: Accounts ▸ Claude ▸ Log in… (claude.ai), Accounts ▸ ChatGPT ▸ Log out then Log in… (chatgpt.com, for 4.12). I watch the window close itself and the face change.
Then I run: 4.15 (rows), 4.17 (Extra usage row, `(est.)` only there, figure vs claude.ai ▸ Settings ▸ Usage — YOU read the real amount off claude.ai), 4.19 ("via claude.ai login"), 4.20, 4.21 (two requests, no supplement line), 4.22's claude.ai half (dev build with the dump variable), 5.9b (only if your Extra usage is ≥ 80 % — otherwise OUT).

## 4. Quick looks
- **3.2** YOU: toggle System Settings ▸ Appearance once (Light ↔ Dark) and back; I screenshot the bone icon on the other background.
- **4.8** YOU: close the lid / sleep the Mac for ~10 minutes; I check the card's age line marks itself stale on wake.
- **7.14** YOU: in a Codex terminal run `/hooks` and trust Walder's four entries; I confirm `Codex done` on the next finished turn and that the menu said installed before the trust (the install dialog now names this step).
- **Login Items** YOU: System Settings ▸ General ▸ Login Items — if Walder is listed twice, remove one; tell me what you see.
- **9.17** YOU: Wi‑Fi off; I click Check for updates now → "Last check failed (HH:MM)", nothing else affected, no dialog; Wi‑Fi on.
- **2.5–2.7** only if you have an external monitor at hand (otherwise OUT).

## 5. Gatekeeper and restarts — last, because restarts end the session
- **8.2** YOU: `xattr -w com.apple.quarantine "0081;00000000;Safari;" /Applications/Walder.app` then launch from Applications: macOS blocks it; System Settings ▸ Privacy & Security ▸ Open Anyway; second launch not blocked.
- **3.8 / 8.5** YOU: Launch at login ticked (it already is), restart: Walder comes back, no window steals focus.
- **8.6** YOU: untick, restart: Walder does not start. Re-tick afterwards if you want it.

## Blank by design
Windows column (every cell), 8.3, 8.4. OUT: 1.8, 2.5–2.7, 6.4, 5.9a2 non-Retina half, 3.4g, 3.4l, 5.9c, 5.9d, 4.13, 4.17 monthly-limit variants, 9.15a, 9.7/9.21 confused-face halves.

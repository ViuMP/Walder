# Mac QA, 2026-11-19 — report

Mac mini (arm64), macOS 27.2.1, one 1920 × 1080 display at 1×, Dock at the bottom. Coordinated by the
"Walder full platform audit" session. Evidence (screenshots, 60 fps frame logs, notes per row):
`~/Walder-qa/2026-11-19-mac/` on that Mac. Every gate below ran by exit code.

## Builds

| Build | What | Gate |
| --- | --- | --- |
| Published 0.3.0 | the v0.3.0 release dmg, fresh install (no 0.2.9 had ever been on this Mac) | – |
| main 4b486db | `dist:mac` into the evidence folder, installed over 0.3.0 | green, 3590 tests |
| mac-qa 36f1a26 | + focus return | green, 3610 tests |
| qa-2026-11-19 653085f | Windows fixes + mac-qa merged by the lead | green, 3627 tests |
| mac-qa 338aef6 | + the late menu-close resync | ipc-bridge tests, typecheck, lint |

## Commits on `mac-qa-2026-11-19`

- `4a50fde` docs: rows 3.3/3.3b (the clamp line stays flush at a top edge; the drawn head sits 21 sprite
  rows lower, so it moves 21 pt per size step; DECISIONS row 116 says so), 4.23a (the six-line cap,
  "never 600 px" was not a limit), 7.9 and the `hook-question.ts` comment (Return inert on the Mac).
- `36f1a26` fix(mac): give key focus back after a click on the dog (RECHECK c). `src/main/focus-return.ts`,
  `isDialogOpen()` in `dialog-host.ts`, QA row 1.5a.
- `338aef6` fix(mac): read the cursor again 80 ms after the menu closes (row 3.17).
- This report and the Mac column of `docs/QA-CHECKLIST.md` (36 rows dated 2026-11-19, new row 2.8 for
  mirroring).

## Faults found and fixed

1. **Petting takes key focus (RECHECK 2026-11-18 c).** Reproduced 3/3 on the installed main build. Root
   cause is Electron/AppKit: a bare `{ type: 'panel', focusable: false }` window activates its app on a
   click (with or without `dock.hide()`), and `app.setActivationPolicy('prohibited')` does not stop it.
   Fix: when Walder is activated within 1.5 s of a press on the dog, re-activate the previous app
   (`lsappinfo visibleProcessList` + `open -b`, no Automation prompt), macOS only, skipped while a
   focusable Walder window or a hook question is open. On screen: key back 42–62 ms after the
   activation, 3/3 over TextEdit with every letter landing; over a full-screen QuickTime clip and
   full-screen Safari he stays asleep and the app gets key back; the Walder window, login window and
   hook question keep the keyboard; tray and drag unchanged.
2. **3.17 on the combined build: the card stayed down 1 time in 10.** On the Mac the stray `mouseleave`
   arrives with the menu's close; when the renderer handles it after `resyncCursor` it has the last word.
   Fix: a second resync 80 ms later. 20/20 after.

## Not a code fault, wording corrected

- 3.3 / 3.3b (top-edge anchor), 4.23a (601 px is the capped block), 7.9 (Electron's message box cannot
  give a visible default Cancel, Return and Esc together: `cancelId` 1 = Return inert, `-1` = Esc inert,
  omitted = inferred 1).

## Results

Pass on the Mac: 8.1, 8.7, 7a.1–7a.3, 7.13, 2.2 (Small), 3.3, 3.3a, 3.3b, 3.3c, 3.4a, 3.4e, 3.4f, 3.4h,
3.4i, 3.5–3.7, 3.9–3.13, 3.16, 3.17 (after the fix), 4.10, 4.23a, 6.3 (with the fix), 6.12b–d, 7.9 (as
reworded), 7.9b, 10.1–10.3, 10.6, 10.7, 12.1–12.7 (showing), 1.5a (new), mirroring (direction).
Lead's checks on the combined build: a pet between sizes at a top edge no longer flips the kept side;
right-click on the dog opens Walder's own menu (drawn under the bone).

Partly: 7.2a (Claude half; this Mac has no `~/.codex/hooks.json`), 9.12 (set and toggles; survives a
restart: see the final relaunch), 10.4 (Light, Dark; not Automatic), 3.8 (switch live, restart is the
owner's).

## Findings left open

- **Coat names are English in every language** (`paletteLabel` builds them from the palette id).
- In Español, Français and Deutsch the Overview's Refresh button wraps below the services row, just
  under the window's edge at the default size (the page scrolls; the button is whole).
- The bug-report form's Processor dropdown stays "None" (not pre-filled).
- ⌘W does not close the Walder window (relevant to 11.3, keyboard only).
- The Hindi "up to date" notice takes two lines at Small.

## Not run, and why

- Owner: 8.2 (Gatekeeper on a Safari download), 3.2 light wallpaper, 10.4 Automatic, 12.8 (system
  languages), 1.8/2.5–2.7/6.4 (hardware), sign-ins (4.2 etc.), 11.3 VoiceOver listening; 11.1 also left
  to the owner (turning VoiceOver on is a system setting).
- Not installed here: Chrome (RECHECK b probe), Antigravity (process-name one-liner).
- Not reached in this session: 10.5, 9.15c / 9.19 (six-hourly timers), 6.12e (an hour's uptime), the
  0.2.8 re-check observations, 3.3b lying, 7.18.

## Harness notes (for the next Mac session)

- A synthetic click must move the pointer onto the dog and wait ~350 ms first, or it falls through.
- `cliclick kp:esc` does not reach a status-item menu; an HID-tap key event does.
- A CGEvent key with modifier flags leaves the flags set unless real modifier key-ups are posted; that
  caused one session of stray shortcuts in TextEdit/Finder (cleaned up, nothing outside the evidence
  folder changed). F-keys need the Fn flag.
- The `osascript … System Events` call raised an Automation prompt, and something in the run raised
  "claude wants to find devices on local networks": both left for the owner to answer (Don't Allow).

## Addendum, 2026-11-20: the lead's fixes (qa-2026-11-19 d99f3e4) re-checked on the Mac

Gate green by exit code (3649 tests); both dmgs built, each asar check ok. Installed arm64.
- (1) Coat names now show in every language (Overview, all seven). **Found:** in German
  SCHOKOBRAUN and SILBERGETIGERT were wider than their swatch cell and ran into each other. Fixed in
  `818276c` (soft hyphens in `de.ts`, the label may wrap rather than overlap, `test/coat-labels.test.ts`):
  on screen SCHOKO-/BRAUN, SILBER-/GETIGERT. Gate green (3654 tests).
- (2) 12.4: Hindi `आप अप-टू-डेट हैं` fits on one line at Small. The update-available notice was not
  producible (no newer release).
- (3) 10.8: in all seven languages Refresh stays on the services row (its label wraps inside the button
  in es/fr/de) and after a click the status line sits above the bar, no scroll.
- (4) 11.3 part: ⌘W closes the Walder window; in the Hook port field ⌘A ⌘C copied `47811`, typing
  replaced it, ⌘Z restored it, ⌘A ⌘V pasted it; the saved port never changed.
- (5) 3.16: still "None" on screen, because GitHub serves the issue template from the default branch and
  `main` still has the Processor dropdown. Walder sends `chip=Apple Silicon`; it fills once `333cf00`'s
  template reaches main. Re-check after the merge.
- (6) 8.1a: the x64 dmg builds; its main binary and the loaded `get-windows` addon are x86_64 (the spare
  arm64 prebuilds in it are unused). Not run: Rosetta is not installed on this Mac, and installing it is
  the owner's.
- Profile backed up before (`backup2/walder-profile-before-d99.zip`) and restored byte-identical after
  (`diff -rq` clean); `~/.claude/settings.json` still byte-identical; the installed Walder is the
  `818276c` build.

## Addendum 2, 2026-11-20: the focus hand-back without a reopen event (PR #38 review, QA 1.5a)

Pulled `qa-2026-11-19` 070887c: gate green by exit code (3656 tests), arm64 dmg built and installed, Verbose log on
(the profile was backed up first and restored after).
- **The `lsappinfo setfront` hand-back fails.** (a) 3 of 3: Walder stays in front and the letters typed after the pet
  are lost; the log says `asked ASN:0x0-0x266266 (TextEdit) to the front; front is now ASN:0x0-0x265265 (Walder)`. By
  hand from a shell, `lsappinfo setfront` prints `ERROR #-54 permErr` to stderr and exits 0, which is why Walder took
  it as done.
- **Fixed (the DECISIONS fallback):** the pid of that ASN (`lsappinfo info -only pid`), then `NSRunningApplication`
  `activateWithOptions` by pid through JXA (`osascript -l JavaScript`, pid as an argument). No Automation prompt;
  macOS accepted it although `osascript` is not the active app. `lsappinfo front` is now read 300 ms after the
  activation (read at once it still named Walder). `src/main/focus-return.ts`, `test/focus-return.test.ts`. Gate green
  (3661 tests).
- On screen with that build, every pet logging `activate … accepted; front is now` the same ASN:
  (a) TextEdit with a document, 3 of 3: every letter typed after the pet landed; TextEdit was key again about 120 ms after
  Walder's activation.
  (b) Finder in front with no window, 3 of 3 after a real click on the desktop and 3 of 3 brought forward by script: no
  Finder window opened and Finder stayed in front. On this Mac a click on the wallpaper slides every window away
  ("click wallpaper to reveal desktop"), so the real-click runs pet after the second click brings them back. Finder is
  still in front then, with no window.
  (c) TextEdit with every window closed, 3 of 3: no window, no Open panel; TextEdit stayed in front.
  (d) Walder left active by opening and closing the Walder window, 3 of 3: the keyboard went back to TextEdit and the
  letters landed.
  With the Walder window open, a pet left focus with Walder (unchanged).

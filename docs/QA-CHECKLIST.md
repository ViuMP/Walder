# Walder — manual QA checklist

The one checklist for a human at the keyboard. It replaces `test/manual/QA-M3.md`
(kept for its history) and folds in the data layer and the behaviour work.

Everything not listed here is covered by `npm test` and `npm run typecheck`.

## Before you start

Run the app one of two ways:

- **A real install** — the `.dmg` or the `.exe`. This is the one that matters:
  it is what you will actually use, and a few checks (Launch at login, the
  installers, Gatekeeper) only exist there.
- **From the project folder** — `npm run dev`. Faster to repeat, and it is the
  only way to reach the **fake-data** items under **Developer ▸** (Inject usage,
  Simulate hook, Toggle fullscreen mode), which is how the faces, the barks, the
  hook reactions and the fullscreen sleep are triggered on demand instead of
  waited for. They are deliberately missing from a real install: a mascot that
  can be *told* to say "100 % used" is a mascot nobody can trust.

**Developer ▸ Verbose log** is the exception — it is in the menu in a real
install too, because it is the only way to produce a diagnosable record of an
intermittent fault. Tick it before reproducing anything odd; the item underneath
it gives the path to the file.

Useful while testing:

```
WALDER_LOG=1 npm run dev                  # print diagnostics as you go
WALDER_DEBUG=1 WALDER_LOG=1 npm run dev   # also outline the clickable area in magenta
```

Quit between checks with **Quit** in the menu, never by closing something:
Walder deliberately never quits on his own.

## How to fill this in

Tick the platform you tested on, and write pass / fail / not tested in **Result**.

| Mark | Meaning |
| --- | --- |
| ⚠ | **Not verified by builders**, for a reason beyond the two below. Nobody has ever seen this work. The reasons are listed at the end |

Two blanket caveats apply to **every** row in this file, so they are not repeated
per line:

- **No builder has ever seen Walder on a screen.** Screen capture was not
  available in any build session. Everything visual was implemented, reasoned
  about and unit-tested — never looked at.
- **Nothing has ever run on Windows.** There was no Windows machine. Treat every
  cell in the **Windows** column as untested by anyone.

---

## 1. Window and click-through

| # | ⚠ | Check | Mac | Windows | Result |
| --- | --- | --- | --- | --- | --- |
| 1.1 | | The dog is in the bottom-right of the main screen: a pixel dachshund with no box, no shadow and no grey rectangle — only his own pixels visible | ☐ | ☐ | |
| 1.2 | | He is a golden long-haired dachshund, breathing gently, and looks like the approved design (not a blob, not a placeholder) | ☐ | ☐ | |
| 1.3 | | Put a normal window under him and click its title bar. He stays in front | ☐ | ☐ | |
| 1.4 | | Click a **transparent corner** of his square, over a link or button behind. The app behind gets the click; the dog does nothing | ☐ | ☐ | |
| 1.5 | | Click **his body**. The app behind does not react | ☐ | ☐ | |
| 1.6 | | No Walder icon in the Dock (Mac) or the taskbar (Windows). The bone icon in the menu bar / tray is the only one | ☐ | ☐ | |
| 1.7 | ⚠ | Play a fullscreen video with **Sleep during fullscreen video** unticked: he stays visible on top of it. On the Mac, switch Spaces and back — he is on every Space | ☐ | ☐ | |
| 1.8 | ⚠ | On a display scaled to 125 %, 150 % or 175 %: his pixels are crisp squares, not blurred or wobbling | ☐ | ☐ | |
| 1.9 | | Leave him alone for two minutes, then check Activity Monitor / Task Manager: the Walder processes total roughly under 1 % CPU | ☐ | ☐ | |

If 1.4 or 1.5 fails, run with `WALDER_DEBUG=1` and compare where you clicked
against the magenta outline. Checks 2.4 and 3.9 keep the app usable meanwhile.

## 2. Drag and position

| # | ⚠ | Check | Mac | Windows | Result |
| --- | --- | --- | --- | --- | --- |
| 2.1 | | Drag him by the body to another corner. He follows the cursor smoothly, and letting go does **not** pet him | ☐ | ☐ | |
| 2.2 | | Try to drag him off the edge of the screen. He refuses to disappear — part of him always stays reachable | ☐ | ☐ | |
| 2.3 | | Quit, relaunch. He comes back exactly where you left him | ☐ | ☐ | |
| 2.4 | | Drag him somewhere awkward, then choose **Reset position**. He jumps to the bottom-right of the **main** screen, 16 px from each edge. Quit and relaunch — he is still there | ☐ | ☐ | |
| 2.5 | ⚠ | With two monitors: drag him from one to the other. He stays crisp and does not jump | ☐ | ☐ | |
| 2.6 | ⚠ | Leave him on the second monitor, quit, unplug it, relaunch. He appears on the main screen (and **Reset position** always brings him back) | ☐ | ☐ | |
| 2.7 | ⚠ | Plug the second monitor back in, quit and relaunch: he returns to where he sat on that monitor | ☐ | ☐ | |

**Why 2.4 matters:** it is the recovery path for a dog you cannot reach with the
mouse at all, so it deliberately ignores whichever display he was on.

## 3. The tray menu

The menu is the whole app. Open it from the bone icon **and** by right-clicking
the dog — both must show the same menu.

| # | ⚠ | Check | Mac | Windows | Result |
| --- | --- | --- | --- | --- | --- |
| 3.1 | | Right-click his **body** → the menu opens. Right-click a **transparent corner** → nothing from Walder, and the app behind gets its own menu | ☐ | ☐ | |
| 3.2 | | The bone icon is visible and legible in the menu bar / tray, on a light and on a dark background | ☐ | ☐ | |
| 3.3 | | **Size ▸ Small / Medium / Large** resizes him at once. His bottom-left corner stays put, so he grows up and to the right rather than jumping | ☐ | ☐ | |
| 3.4 | | The radio dot marks the current size. Quit and relaunch — the size is remembered | ☐ | ☐ | |
| 3.4a | | **Card size ▸** sits directly under **Size**. Hover the dog to bring the card up, then — *without moving the cursor off him* — pick each of Large / Medium / Small from the menu. The open card re-draws in place at roughly 300 / 250 / 200 px wide. It must **not** vanish and stay vanished | ☐ | ☐ | |
| 3.4b | | At **Medium** the card has no WALDER header and no "via …" lines; the bars and the "resets in …" lines are still there | ☐ | ☐ | |
| 3.4c | | At **Small** each window is one line — label on the left, percentage on the right. Nothing is cut off at the right edge, and the card is not left with a wide empty strip either. The longest label (`7-day (all models)`) is the one to judge it on | ☐ | ☐ | |
| 3.4d | | At **Small**, the window shrinks to fit the card: no tall empty box around a short card | ☐ | ☐ | |
| 3.4e | | The radio dot marks the current card size, and it survives a quit and relaunch. It is **independent** of the dog's Size — changing one must not move the other's dot | ☐ | ☐ | |
| 3.5 | | **Colour ▸** each of Golden, Red, Cream, Black and tan, Chocolate visibly changes his coat, and only his coat (eyes, nose, tongue, hearts stay as they were) | ☐ | ☐ | |
| 3.6 | | On **Black and tan** and **Chocolate**, the chest, feet and ear hems turn tan rather than cream | ☐ | ☐ | |
| 3.7 | | The colour survives a quit and relaunch | ☐ | ☐ | |
| 3.8 | ⚠ | **Launch at login**: from a real install the item is live and ticking it makes Walder start after a restart. From `npm run dev` it is greyed out and reads "Launch at login (packaged app only)" — that is correct and deliberate | ☐ | ☐ | |
| 3.9 | | Tick **Force interactive (debug)**: his whole square now swallows clicks, transparent corners included | ☐ | ☐ | |
| 3.10 | | Untick it **with the cursor resting on him**, then click without moving the mouse first. He pets, and the transparent corners let clicks through again immediately | ☐ | ☐ | |
| 3.11 | | **Developer ▸ Verbose log** is present in a **real install**, and the line under it gives the path to the log file | ☐ | ☐ | |
| 3.12 | | Tick it, use the app for a minute, then open that file: it has timestamped lines, and **no** login token or session key anywhere in it | ☐ | ☐ | |
| 3.13 | | Untick it, quit and relaunch: it is still unticked, and the file stops growing except for warnings | ☐ | ☐ | |
| 3.14 | | From a **real install**, the fake-data items (Inject usage, Simulate hook, Toggle fullscreen mode) are **not** in the menu | ☐ | ☐ | |
| 3.15 | | **Quit** closes everything: no dog, no bone icon, no Walder left in Activity Monitor / Task Manager | ☐ | ☐ | |

**3.10 is the one to watch.** It is the case that needed a resync between the two
halves of the app, and both halves of it have to hold: click-through comes back
*and* he is still clickable where the cursor already is.

## 4. Accounts and numbers

| # | ⚠ | Check | Mac | Windows | Result |
| --- | --- | --- | --- | --- | --- |
| 4.1 | ⚠ | **Accounts ▸ Claude ▸ Log in…** opens a normal login window on claude.ai. Log in as you would in a browser. The window closes itself, and the dog's face changes within a few seconds | ☐ | ☐ | |
| 4.2 | ⚠ | **Accounts ▸ ChatGPT ▸ Log in…** does the same on chatgpt.com | ☐ | ☐ | |
| 4.3 | | The **Accounts** submenu shows one status line per service — "Claude: ok via …", "login needed", "endpoint changed", "rate limited, retrying", "could not be reached" or "not logged in" | ☐ | ☐ | |
| 4.4 | | Rest the cursor on the dog. After a moment a card appears beside him, not under the cursor, and it does not swallow clicks | ☐ | ☐ | |
| 4.5 | | Move him near each screen edge and hover again: the card flips to whichever side has room and stays fully on screen | ☐ | ☐ | |
| 4.6 | | The card lists CLAUDE and CHATGPT, each with the source it used ("via Claude Code login", "via claude.ai login", "via Codex CLI login"), each window's label, its percentage, a 20-segment bar, and when it resets | ☐ | ☐ | |
| 4.7 | | The card is see-through enough that a fullscreen video behind it stays visible | ☐ | ☐ | |
| 4.8 | | The footer says "refreshed just now" / "refreshed 3 min ago". Leave the machine asleep for a while — the age line marks itself as stale rather than pretending the numbers are current | ☐ | ☐ | |
| 4.9 | ⚠ | ChatGPT's windows are labelled **"Codex 5-hour"** and **"Codex weekly"**. That is deliberate and correct: that endpoint reports the Codex allowance, not the chat-message allowance | ☐ | ☐ | |
| 4.10 | | **Refresh now** updates the card. The item then reads "Refresh now (wait Ns)" and is greyed out for up to a minute, and comes back on its own without reopening the menu | ☐ | ☐ | |
| 4.11 | | **Accounts ▸ Log out** for a service: its status line changes at once (not three minutes later), and its numbers disappear from the card | ☐ | ☐ | |
| 4.12 | | Log in again after a logout and the numbers come back | ☐ | ☐ | |
| 4.13 | | With neither service logged in, the card says so in words and the dog wears the confused face — never a cheerful face and never `0%` | ☐ | ☐ | |
| 4.14 | | Quit with numbers on the card and relaunch: he has a real face immediately, not a confused one until the first refresh | ☐ | ☐ | |
| 4.15 | | The CLAUDE section of the card shows **only**: **5-hour**, **7-day (all models)**, one **7-day &lt;model&gt;** row per per-model weekly row your claude.ai dashboard shows (today: **7-day Fable**), and the **Extra usage** money row of 4.17 if the account has it on. On Victor's account that is four rows. Never "Amber ladder", "Nimbus quill", "Tangelo", "Seven day cowork", "Seven day omelette", "Seven day breakdown" or "Seven day oauth apps" — all of those are real top-level keys on his live payload and all are deliberately dropped, however long the app has been running. A per-model row for a model Walder has never heard of **is** legitimate and should appear: those are named by the dashboard itself, not by a list in the code | ☐ | ☐ | |
| 4.16 | | Tick **Developer ▸ Verbose log**, then **Refresh now**. `logs/` gets one `usage keys [claude-web]: …` (or `[claude-oauth]: …`) line listing key names only, and — only if your account is currently reporting a key Walder does not recognise — one `usage: ignoring unknown claude window "…"` line. Neither line contains a percentage or a timestamp with a time-of-day | ☐ | ☐ | |
| 4.17 | | **If your claude.ai account has Extra usage switched on but has NO monthly limit** (Victor's own case): the CLAUDE section ends with an **Extra usage** row reading just the amount spent — `$9.62 spent` — with **no bar**, **no percentage** and **no "resets in" line**. All three absences are correct: there is no cap to be a percentage of, and claude.ai states no billing anchor, so a countdown would be invented. Check the figure against claude.ai ▸ Settings ▸ Usage: if the card says roughly **100× the real amount**, the minor-units conversion has broken (the payload sends 962 for $9.62). **If you set a monthly limit on claude.ai:** after the next refresh the row becomes `9.62 / 50.00 USD  (19%)` with a bar, and barks at the usual thresholds. **If extra usage is switched off: the row is absent** — never `0.00 spent`, never `0 / 0`, never `0%` | ☐ | ☐ | |
| 4.18 | ⚠ | *(Now live — as 4.17. Before W3 every row was drawn as a window, so this one would have had a bar it cannot fill.)* **If your ChatGPT account has Codex credits:** the CHATGPT section ends with a **Codex credits** row reading `1,240 left` (or `unlimited`), with **no bar** and no reset line. If the account has no credit pool the row is absent. If the endpoint reports the pool without a number, the value is `?` — never `0` | ☐ | ☐ | |
| 4.19 | | The CLAUDE source line now normally reads **"via claude.ai login"** rather than "via Claude Code login" — that is the intended change (only the claude.ai route reports the per-model Fable window and Extra usage). With no claude.ai session, it falls back to the Claude Code login exactly as before | ☐ | ☐ | |
| 4.20 | | The **7-day Fable** row shows Fable's *own* percentage — on the confirmed payload 80 % against a 70 % weekly pool — and carries **no** "(shared pool)" note. It sits directly under 5-hour, above 7-day (all models). If it mirrors the weekly number *with* the note, the response's per-model list did not parse: capture the 4.22 dump and check that a `limits [n] . scope . model . display name` line is present | ☐ | ☐ | |
| 4.21 | | Tick **Developer ▸ Verbose log**, then **Refresh now**: there is **no** `claude-web supplement …` line at all, and the claude.ai route makes exactly **two** requests per poll (organisations, then usage). The Extra usage figure comes out of the usage response itself, so the third request the earlier build made is gone — if a supplement line reappears, something has been added back to `CLAUDE_SUPPLEMENTS` | ☐ | ☐ | |
| 4.22 | | **Developer only, and only from the project folder.** Run `WALDER_LOG=1 WALDER_DUMP_USAGE_SHAPE=1 npm run dev`: `logs/` gets a block of `usage shape: …` lines describing the raw claude.ai payload — nested field names with their **numbers** (`limits [2] . percent = 80`, `extra usage . used credits = 962`), arrays enumerated by index, and every string rendered as `<string:N chars>` and never its content. Check that no ISO timestamp, org id or plan name appears anywhere in the block. Run `npm run dev` without the variable and the block is absent; it is refused outright in a packaged build | ☐ | ☐ | |

## 5. Faces and barks

Fastest with `npm run dev` and **Developer ▸ Inject usage**, which pushes a fake
Claude 5-hour percentage down the same path a real reading takes.

| # | ⚠ | Check | Mac | Windows | Result |
| --- | --- | --- | --- | --- | --- |
| 5.1 | | Inject **45 %** → happy: grinning, tail carried high | ☐ | ☐ | |
| 5.2 | | Inject **no data** → confused: head cocked, with a question mark beside it | ☐ | ☐ | |
| 5.3 | | Inject **82 %** → worried (ears down, sweat bead) **and** one bark: a bubble reading `5-hour: 82% used` | ☐ | ☐ | |
| 5.4 | | Inject 82 % again → the face stays worried and he does **not** bark a second time | ☐ | ☐ | |
| 5.5 | | Then inject **91 %** → one bark for the 90 % threshold, not three barks for 85, 90 and 91 | ☐ | ☐ | |
| 5.6 | | Then inject **100 %** → he collapses flat with X eyes, and barks once more | ☐ | ☐ | |
| 5.7 | | A bark bubble clears itself after about 12 seconds | ☐ | ☐ | |
| 5.8 | | Clicking him while a bark is up dismisses the bubble at once | ☐ | ☐ | |
| 5.9 | | The bubble text is readable and not cut off at **Size ▸ Small** as well as Large | ☐ | ☐ | |
| 5.9b | ⚠ | **Extra usage barks like a window.** With the row present and above 80 %, a bubble reads `Extra usage: 80% used` (the label plus the observed percentage, same as any window) | ☐ | ☐ | |
| 5.9c | ⚠ | **Codex credits bark exactly once, and only when empty.** When the balance runs out he barks `Codex credits: none left`; he does **not** bark again on later polls while it stays empty, and does **not** bark at 80/85/90 of anything (a balance has no thresholds). Top the credits up and run them out again → one more bark | ☐ | ☐ | |
| 5.10 | | Click him with no bubble up → he squeezes his eyes shut, his head pushes up and a heart appears | ☐ | ☐ | |
| 5.11 | | Inject 45 % after 100 %: he stands back up and turns happy | ☐ | ☐ | |

## 6. Fullscreen

| # | ⚠ | Check | Mac | Windows | Result |
| --- | --- | --- | --- | --- | --- |
| 6.1 | ⚠ | **Sleep during fullscreen video** is ticked by default. Put a video fullscreen: within a few seconds he curls up into the small sleeping sprite | ☐ | ☐ | |
| 6.2 | ⚠ | Leave the video: he stretches, yawns and stands back up in the normal size | ☐ | ☐ | |
| 6.3 | ⚠ | Click him while he is asleep: he stirs or mumbles `…zzz`, and stays asleep. He must never do visibly nothing | ☐ | ☐ | |
| 6.4 | ⚠ | With two monitors: a fullscreen video on the monitor he is **not** on leaves him standing and awake | ☐ | ☐ | |
| 6.5 | ⚠ | While he is asleep, inject a bark (Developer ▸ Inject usage 91 %): he wakes, says it, then curls back up | ☐ | ☐ | |
| 6.6 | | Untick **Sleep during fullscreen video** while he is asleep: he stands up immediately, without waiting for the video to end | ☐ | ☐ | |
| 6.7 | | With it unticked, a fullscreen video no longer puts him to sleep. Tick it again and he sleeps again | ☐ | ☐ | |
| 6.8 | | A fullscreen presentation or a game behaves the same as a video | ☐ | ☐ | |
| 6.9 | ⚠ | **A video fullscreen inside a browser** — YouTube in Chrome, Safari, Edge — puts him to sleep, not just a dedicated player. This is the case that was broken until 2026-09-08, and it is the one to test first | ☐ | ☐ | |
| 6.10 | ⚠ | Enter and leave fullscreen a few times in a row: each time he settles into exactly one state. He must not stand up and lie down again during the Space-switch animation | ☐ | ☐ | |
| 6.11 | ⚠ | Enter fullscreen, leave it, wait a minute, enter it again: he sleeps **every** time. Detection must never stop working after the first video of the session | ☐ | ☐ | |

`Developer ▸ Toggle fullscreen mode` flips the believed state without a real
video, which is how to check 6.1–6.3 quickly. It is not a substitute for doing
them over an actual film — that is what the ⚠ on those rows is about.

Every real transition is written to the log file as `fullscreen entered` /
`fullscreen left` **whether or not Verbose log is ticked**, so 6.9–6.11 can be
confirmed after the fact from `Developer ▸ Open log file` instead of by watching
him the whole time.

### 6.12 — the hover card over a real full-screen page (needs the owner, macOS)

**This one is an experiment, not a pass/fail check.** The card does not appear
over a macOS full-screen page, the cause is a window-server behaviour nobody
here can reproduce, and six candidate fixes ship behind one environment
variable. What is wanted back is **which number shows the card**.

Run each of these from the project folder, one at a time, and hover the dog:

```
WALDER_LOG=1 WALDER_PANEL_EXPERIMENT=0 npm run dev   # today's behaviour, the control
WALDER_LOG=1 WALDER_PANEL_EXPERIMENT=1 npm run dev
WALDER_LOG=1 WALDER_PANEL_EXPERIMENT=2 npm run dev
WALDER_LOG=1 WALDER_PANEL_EXPERIMENT=3 npm run dev   # the one most likely to work
WALDER_LOG=1 WALDER_PANEL_EXPERIMENT=4 npm run dev
WALDER_LOG=1 WALDER_PANEL_EXPERIMENT=5 npm run dev
WALDER_LOG=1 WALDER_PANEL_EXPERIMENT=6 npm run dev
```

`WALDER_LOG=1` turns the verbose log on for that run whether or not
**Developer ▸ Verbose log** is ticked, so the lines are there either way. For
each run:

| # | ⚠ | Check | Mac | Windows | Result |
| --- | --- | --- | --- | --- | --- |
| 6.12a | | **Developer ▸ Toggle fullscreen mode** (no real Space), then hover the sleeping dog: does the card appear? | ☐ | n/a | |
| 6.12b | ⚠ | Put **Safari** into real full screen (green button), move the cursor to where the dog is, and hover him. Does the card appear? | ☐ | n/a | |
| 6.12c | | While over full-screen Safari, **pet** the dog (click him). If he reacts, mouse events *do* reach the overlay there — which is a different fault from the card landing on the wrong Space | ☐ | n/a | |
| 6.12d | | Open **Developer ▸ Open log file** afterwards and report the `hover:enter`, `panel shown`, `panel hidden` and `panel re-placed (already visible)` lines around the attempt | ☐ | n/a | |

Nothing to check on Windows: every experiment is guarded by `isMac`, and the
card already works there.

### Known behaviour in §6, not faults

- **A maximised window with the Dock hidden reads as fullscreen.** macOS reports
  a fullscreen window at the display's full width, sitting on its bottom edge and
  starting 33 px down (the hidden menu bar keeps its strip) — and with the Dock
  hidden too, a merely *maximised* window is reported at exactly those numbers.
  Nothing in the geometry separates them, so Walder sleeps for both. Accepted
  deliberately: with the Dock hidden and a window filling the screen the owner is
  effectively fullscreen anyway, and the stricter rule that was in place until
  2026-09-08 missed every in-browser video there is. With the Dock visible (the
  default) a maximised window is 66 px short at the bottom and he stays up.
- **He can take about four seconds to react**, by design: two agreeing 2 s polls.
  During a Space switch macOS reports nothing readable for roughly three seconds,
  and the watch deliberately holds the state it last knew for up to ten seconds
  rather than flapping.

## 7. The Claude Code perk

| # | ⚠ | Check | Mac | Windows | Result |
| --- | --- | --- | --- | --- | --- |
| 7.1 | | **Install Claude Code hooks…** asks first, naming `~/.claude/settings.json` and saying a backup is written; **Cancel** changes nothing. Confirming shows a second box naming the file it changed and the backup it saved | ☐ | ☐ | |
| 7.2 | | Run it a second time: it says it is already up to date and does not add a second copy | ☐ | ☐ | |
| 7.3 | | Your other Claude Code settings and any other hooks you had are untouched | ☐ | ☐ | |
| 7.4 | | Start Claude Code and send it a message. When the reply finishes, Walder's ears go up and he says `woof` for a few seconds | ☐ | ☐ | |
| 7.5 | | When Claude Code asks for permission or goes idle waiting for you, he tilts his head and shows a `?` — and holds the tilt as long as the `?` is up | ☐ | ☐ | |
| 7.6 | | Type your next message: the `?` clears on its own | ☐ | ☐ | |
| 7.7 | | Clicking him also clears the `?` | ☐ | ☐ | |
| 7.8 | | Quit Walder and use Claude Code normally: no errors, no delays, no failed hooks | ☐ | ☐ | |
| 7.9 | | **Remove Claude Code hooks…** asks the same way, then takes the three entries out and leaves everything else in the file as it was. Run it again: it says there is nothing to remove | ☐ | ☐ | |
| 7.9a | | `npm run install-hooks -- --remove` does the same from a terminal, for anyone working from the repo rather than an installed app | ☐ | ☐ | |
| 7.10 | | A bark arriving at the same moment as a `woof` shows the bark — the usage warning wins | ☐ | ☐ | |

`Developer ▸ Simulate hook ▸ done / waiting / prompt` exercises 7.4–7.7 without
a real Claude Code session.

## 8. Install and update

| # | ⚠ | Check | Mac | Windows | Result |
| --- | --- | --- | --- | --- | --- |
| 8.1 | | `npm run dist:mac` produces a `.dmg` in `release/`; opening it and dragging Walder.app to Applications works. *(A builder built the dmg, mounted it, copied the app out and launched it — the drag into Applications itself is all that is left)* | ☐ | – | |
| 8.2 | ⚠ | First launch from Applications is blocked by macOS, and **System Settings ▸ Privacy & Security ▸ Open Anyway** gets past it. The second launch is not blocked. *(On macOS 14 and older, right-click → Open is the same thing in one step; macOS 15 removed that override, so Open Anyway is the route README leads with and the one to test here)* | ☐ | – | |
| 8.3 | | `npm run dist:win` produces an `.exe` installer; it lets you choose the folder and offers a desktop shortcut. *(A builder produced the installer on a Mac and confirmed it is a real NSIS executable; nobody has run it)* | – | ☐ | |
| 8.4 | ⚠ | SmartScreen warns, and **More info → Run anyway** installs it. The app then starts and shows the tray icon | – | ☐ | |
| 8.5 | ⚠ | From the installed app, ticking **Launch at login** and restarting the machine brings Walder back — with no window stealing focus | ☐ | ☐ | |
| 8.6 | ⚠ | Untick it, restart: Walder does not start | ☐ | ☐ | |
| 8.7 | ⚠ | Move him, change size and colour, log in, then install a newer build over the top. Position, size, colour and logins all survive | ☐ | ☐ | |
| 8.8 | ⚠ | Uninstall: remove the hooks first from the menu (7.9), then Trash the app / use Add-Remove Programs. Nothing of Walder is left running, and Claude Code still works | ☐ | ☐ | |

## 9. Hide when idle, the shortcut, and the update check

The mode's failure modes are all "the dog is not there", which looks identical
to a crash — so the rows below are as much about *coming back* as about going
away. `Developer ▸ Inject usage` and `Developer ▸ Simulate hook` are how you
trigger each appearance on demand instead of waiting for one.

| # | ⚠ | Check | Mac | Windows | Result |
| --- | --- | --- | --- | --- | --- |
| 9.1 | | Tick **Hide when idle** with nothing on screen: he goes **immediately**, not eight seconds later | ☐ | ☐ | |
| 9.2 | | Untick it: he is back at once, standing normally — no stretch-and-wake animation, because he was never asleep | ☐ | ☐ | |
| 9.3 | | Tick it while a bubble is up: he stays until the bubble goes, then leaves 8 s later | ☐ | ☐ | |
| 9.4 | | With the mode on, `Developer ▸ Inject usage ▸ 82%`: he appears with the wake animation *before* the bark bubble, says it, and is gone about 8 s after the bubble clears | ☐ | ☐ | |
| 9.5 | | Same again, then click him while he is still there: the 8 s start over. Click repeatedly — he never disappears under the cursor | ☐ | ☐ | |
| 9.6 | | `Developer ▸ Simulate hook ▸ waiting`: he appears and holds the `?` indefinitely. `▸ prompt` clears it and he leaves 8 s later | ☐ | ☐ | |
| 9.7 | | Log out of Claude (**Accounts ▸ Claude ▸ Log out**) with the mode on: he appears once with the confused face. Wait through two or three polls — he does **not** keep coming back to say the same thing | ☐ | ☐ | |
| 9.8 | | While he is hidden, the menu's top shows **Claude 5-hour: 63% used** under his name. Untick the mode and that line disappears | ☐ | ☐ | |
| 9.9 | | While hidden, moving the mouse over where he was does nothing: no hover card, and clicks go through to whatever is behind | ☐ | ☐ | |
| 9.10 | ⚠ | Press the shortcut (**⌃⌘W** on the Mac, **Alt+Shift+W** on Windows): it toggles the checkbox, both ways, with no menu open — including while another app has focus | ☐ | ☐ | |
| 9.11 | ⚠ | The combination is **rendered next to "Hide when idle"** in the menu — as `⌃⌘W` on the Mac, as `Alt+Shift+W` on Windows. *(Nobody has seen a tray menu; if the platform does not draw it, say so — the fallback is putting it in the label text)* | ☐ | ☐ | |
| 9.12 | | **Shortcut ▸** shows the presets with a dot on the current one; picking another takes effect at once and survives a restart | ☐ | ☐ | |
| 9.13 | | Have another app take the keys first (or set a combination something else owns), restart Walder: **Shortcut ▸** ends with "… is already used by another app", the choice is still dotted, and the checkbox still works | ☐ | ☐ | |
| 9.14 | | Quit Walder and check the shortcut no longer does anything — the keys are released | ☐ | ☐ | |
| 9.15 | ⚠ | With a real release in `ViuMP/walder-releases` newer than the running version: **Check for updates now** turns the bottom item into **Update available: … — Download…**, and clicking it opens that release page in the browser. Nothing downloads and nothing installs itself | ☐ | ☐ | |
| 9.15a | | **Before the first release is published** (`ViuMP/walder-releases` empty, which is the state today): **Check for updates now** leaves the item reading **Check for updates now** — *not* "Last check failed". GitHub answers 404 for a repo with no releases, and that means "nothing newer", not a broken check. With **Developer ▸ Verbose log** on, the log line is `update check: no releases published yet` | ☐ | ☐ | |
| 9.16 | | The dog says `0.1.3 is out` **once**. Quit and reopen Walder, check again: he does not say it a second time (the version is remembered) | ☐ | ☐ | |
| 9.17 | | Turn wifi off and use **Check for updates now**: the item becomes **Last check failed (12:03)**. Nothing else in the app is affected, and no dialog appears | ☐ | ☐ | |
| 9.18 | | Click **Check for updates now** twice: the second click is refused and the item reads "(wait 58s)" and is greyed out | ☐ | ☐ | |
| 9.19 | | Untick **Check for updates automatically**, tick **Developer ▸ Verbose log**, leave Walder running: the log shows no request to `api.github.com` at all. (**Check for updates now** is the exception and does ask — that request is yours, not Walder's) | ☐ | ☐ | |
| 9.20 | | With the mode on **and** something fullscreen, a bark still brings him out at the standing size (not the tiny sleeping one). He stays standing for his eight seconds and then vanishes and curls up in the same moment — never curling up while you are still looking at him | ☐ | ☐ | |
| 9.21 | | With the mode on **and** something fullscreen, break the login (**Accounts ▸ Claude ▸ Log out**): he appears **standing** and confused on top of the video — not a standing dog crammed into the tiny sleeping window | ☐ | ☐ | |
| 9.22 | | Tick **Hide when idle**, quit Walder, start it again: he does not appear even for a frame. Then `Developer ▸ Inject usage ▸ 82%` — he comes out and animates normally, which is what says the renderer knew it had been hidden all along | ☐ | ☐ | |

---

## What builders could not verify, and why

Checked against `docs/BUILD_LOG.md`. Every ⚠ row above draws its reason from
this list.

| What | Why nobody has seen it |
| --- | --- |
| **Anything visual, on any platform** | Screen capture was not available in any build session. The overlay was verified by launching the app and reading the main-process log — window size, click-through default, the settings file, the IPC round trip — not by looking at the screen. This covers every row in this file |
| **Everything on Windows** | There was no Windows machine at any point. That includes the NSIS installer, the SmartScreen path, the tray icon (`build/tray-win.png` is generated and the platform branch is unit-tested, but it has never been looked at in a real tray), and the PowerShell fullscreen helper (`src/main/fullscreen-win.ps1`), which has never been run |
| **Floating over fullscreen video on macOS** | `alwaysOnTop(…, 'screen-saver')`, `setVisibleOnAllWorkspaces(visibleOnFullScreen: true)` and the macOS `panel` window type are the right combination, but macOS honours them differently across versions and Space setups. Rows 1.7 and 6.1–6.5 |
| **The fullscreen sleep itself** | Twice broken, twice fixed without anyone seeing it work. First the packaged mac build could not load its window-reading module at all; then, once it could, the owner reported that Walder still never curled up for YouTube in Chrome. A 1 Hz probe he ran caught why: macOS names the *toolbar strip* as Chrome's active window (1728×115) while the video is a second window in the same app (1728×1084), and a macOS fullscreen window starts 33 px down rather than covering the display. Both are fixed and the real recorded numbers are now fixtures (`test/fullscreen.test.ts`), but the decision is still only unit-tested: nobody has watched a dog actually curl up over a film. Rows 6.1–6.11 |
| **Fractional display scaling** | The sprite is rasterised at a whole number of device pixels per drawn pixel, which is what stops the pixels wobbling at 125 %, 150 % or 175 %. The arithmetic is unit-tested; the result has never been seen on a scaled monitor. Row 1.8 |
| **Multi-monitor drag, and unplugging a monitor** | The off-screen clamp is unit-tested against synthetic display layouts (`test/geometry.test.ts`). Dragging between two real monitors, and unplugging one while he sits on it, were never tried. Rows 2.5–2.7 |
| **The two account logins** | Both login windows were built and locked down, and the security review passed on the second pass, but nobody has logged in to claude.ai or chatgpt.com through them. Rows 4.1–4.2 |
| **The ChatGPT chat-message allowance** | Only one working endpoint has ever been found, and it reports the **Codex** allowance. The chat-message limit endpoint has not been found, so those windows are labelled "Codex 5-hour" and "Codex weekly" — honestly named rather than guessed. Confirming which chatgpt.com endpoint carries chat limits is still open. Row 4.9 |
| **The Claude Code login source** | The stored Claude Code token on the build machine was expired, so that provider was only ever seen reporting "login needed". Walder never refreshes that token on purpose — refreshing it could log Claude Code itself out |
| **Gatekeeper and SmartScreen** | Both installers now exist — `Walder-0.1.0-mac-arm64.dmg` and `Walder-0.1.0-win-x64.exe`, about 130 MB each, both built on 2026-09-08 — and a builder mounted the dmg, copied `Walder.app` out and launched it successfully. What is still unseen is the *warning* paths: the builder stripped the quarantine flag rather than clicking through Gatekeeper, so the **Open Anyway** step in 8.2 has never been performed, and nothing on Windows has been run at all. The app is not signed or notarised, which is exactly why 8.2 and 8.4 exist |
| **Launch at login from a real install** | The login-item API cannot work from an unpackaged dev build, so the live version of that checkbox has never run. Rows 8.5–8.6 |
| **Settings surviving an update** | Settings live outside the app bundle by design, but no build has ever been installed over another. Row 8.7 |
| **Accelerator glyphs in a tray menu** | The `accelerator` field on the **Hide when idle** item is display-only (the keys themselves are held by `globalShortcut`), and `registerAccelerator: false` is unit-asserted so the menu cannot bind them a second time. Whether macOS actually *draws* `⌃⌘W` beside a tray context-menu item, and whether Windows draws `Alt+Shift+W`, has never been looked at — no build session could see a menu bar. If it is not drawn, the fallback is to put the combination in the label text. Rows 9.11, 9.12 |
| **The global shortcut firing while another app has focus** | A `register()` smoke test on the build Mac confirmed all eight presets bind successfully and that `Control+Super+W` is refused even on macOS (which is why no preset mentions `Super`). Nobody has *pressed* any of them: that needs a person at a keyboard with the packaged app running. Rows 9.10, 9.13, 9.14 |
| **The real GitHub call, and the release script** | `ViuMP/walder-releases` now exists and is public but holds **no release yet**, so the only thing the update check has ever done against real GitHub is collect the 404 that state answers with (fixed 2026-09-10: it now reads as up-to-date, row 9.15a). Everything past that — an actual release body, the version comparison, the download link — has still only run against a fixture (`test/fixtures/github-release-latest.json`) and a stubbed `HttpFetch`. `npm run release` has never been run against GitHub either — its two decisions (which files go up, and the exact `gh` argv) are unit-tested, and `-- --dry-run` prints the command without publishing. Rows 9.15–9.19 |

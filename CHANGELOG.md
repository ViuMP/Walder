# Changelog

Every Walder release, newest first; each entry is identical to its file in [`docs/release-notes/`](docs/release-notes/).

<!-- NEXT RELEASE -->
<!-- For the next notes (qa-2026-11-19): Added: an Intel (x64) Mac download, **not yet tested on Intel hardware** — Intel Mac users, please report whether it starts. Fixed from the Mac and Windows QA of 2026-11-19: petting him no longer takes keyboard focus from your app (macOS); a pet that wobbles no longer moves him; the hover card stays off every menu and comes back after it; coat names in every language; Refresh row in es/fr/de; Cmd-W closes the Walder window; the bug form fills in the processor; Update hooks says Update; a missed notification after ticking Notify when hidden. Lint: Biome. -->
<!-- For the next notes (fixes-0.3.2, 2026-11-19), Fixed: a size round trip at the top edge comes home (he grows downwards in the top half); the dog rests a little nearer the top edge (Yuna where she was, so her bubble keeps its lines); the hover card no longer covers the open menu; SESSIONS shows five rows and "+N more"; the two "Tokens today" rows name Claude and Codex; two Codex sessions get two rows; the menu says when an installed hook command is out of date; the Windows hook question stays in front; one Retry-After rule for every service. Languages: percentages and French punctuation follow CLDR (no-break spaces), a glossary-checked pass over all six translations, and a translation feedback form. Build: npm audit clean (minimatch override); dist:mac/dist:win honour --config.directories.output. -->
<!-- For the next notes, Changed: **Installer contents**: tinyglobby, fdir and picomatch are back in the app archive as unused transitives; picomatch 4.0.7 cleared the advisory that kept them out in 0.3.0 (AUDIT.md item 23). -->

## v0.3.0: the walder window

2026-11-18

Adds the Walder window with every setting, an Overview that previews the companion and the card before Apply, and a hover card layout you can arrange line by line. Also the fixes from the audits of 2026-11-13 and 2026-11-17 (`docs/handoffs/AUDIT_2026-11-13.md`, `AUDIT.md`).

Unsigned installers for macOS on Apple Silicon and Windows x64; see the [first-launch steps](https://github.com/ViuMP/Walder).

### Added
- **Walder window**: **Overview and settings…** in the bone menu opens a window with a list of pages on the left: Overview, then one page per settings group (Appearance, Alerts, Visibility, Usage, App, Advanced) with every setting. Starting Walder again while it runs, or reopening it from Finder or Spotlight on macOS, opens the same window. (#19, #22)
- **Theme**: Appearance ▸ Theme draws the Walder window light, dark, or following the system (Automatic, the default). The hover card and the dog are unchanged. (#22)
- **Settings in one place**: every setting is checked against one list (`SETTINGS.md`) before it is saved. Refresh interval, Codex credit price and Hook port, which could only be changed in the settings file, now have controls. (#19)
- **Crash log**: an error nothing caught is written to `walder.log`. (#19)
- **Restart**: a Restart item above Quit in the bone menu. (#19)
- **Bug report confirmation**: after **Report a bug…** the dog says "Diagnostics copied to clipboard". (#19)
- **Hover card layout**: Visibility ▸ Hover card ▸ **Advanced customization** draws the hover card as one list of lines you order by dragging (or Alt+Up/Down) and switch on or off one by one: the title, each service's heading, each usage row, each row's reset time, the sessions and the last-updated line. The advanced card is always the Large card, whatever Card size is set to; turning it off goes back to that size. A live preview shows the card before **Apply changes**; **Revert** drops the changes and **Restore default layout** puts every line back. With it off the card is unchanged. Every checkbox in the Walder window is now a switch. (#22)
### Changed
- **Walder window layout**: a new look. The rail on the left shows the saved coat, an icon beside each page, and whether any service is connected. The Overview page has a large preview, with the coat drawn as on screen and the usage card at the chosen size, and beside it **Your companion**: Model (Walder the dog or Yuna the cat) as two pictures, Coat as colour swatches, and Size and Card size as Small, Medium and Large, then **Apply changes** and **Revert**. A choice there is saved only on Apply; one not applied is dropped when the window closes. Under them, each service with its state and **Refresh now**. The companion stands on one fixed spot, bottom-right as on the desktop, with the card beside it where the desktop puts it, in a preview that never changes size. Coat, Size and Card size are no longer on the Appearance page. (#22)
- **Refresh now**: no cooldown. The bone menu's and the window's Refresh check every service on each click. A service whose server asked Walder to wait keeps waiting and is named in the window. Petting the dog keeps the 60-second cooldown, and a Refresh starts it. (#22)
- **Bone menu**: shorter. It keeps Refresh now, Accounts, Overview and settings…, Size, Hide when idle, a **Hooks** submenu with both tools' install and remove items, Reset position, the update line, Report a bug…, **Reveal log file**, Restart and Quit. Every other setting is in the Walder window only. The **Developer** menu shows only in a development build or with `WALDER_DEV=1`. This also shortens the tray menu that was too tall on Windows at 125 % scaling. (#20)
- **App icon**: the dog's head and chest on a rounded cream tile with a thin tan rim, with the whole ear in frame. Still drawn from the sprite itself. (#20, #21)
- **Hide when idle and the shortcut**: saved by the same code as every other setting; a change made in the bone menu or by the shortcut shows in an open Walder window. (#19)
- **Refresh interval**: values under 180 seconds are refused, since Walder never checked more often. (#19)
- **Application menu**: Electron's default menu, with Reload and Developer Tools, is replaced by Edit and Window menus on macOS and by no menu on Windows. (#19)
- **Build tools**: electron-builder 26.18, electron-vite 6 and vite 8. The app itself is unchanged. (#19)
- **Electron**: 45.3.4 (Chromium 156, Node 24.22). macOS 13 is still the lowest supported version. (#19)
- **Settings storage**: electron-store 12. Existing settings files load unchanged; a settings file that is not valid JSON is now replaced with the defaults at startup. (#19)
- **Release titles**: GitHub releases are titled from the first line of their notes, for example "v0.2.9: fixes from the 0.2.8 qa passes". (#19)
- **Rate limits in a provider chain**: when no source answers, a 429 or an error from an earlier source is reported instead of a later "log in again", so Walder backs off. (#19)
- **CODEX_HOME**: the Codex login and the Codex Tokens today row follow `$CODEX_HOME`, as the hook installer already did. (#19)
- **GitHub CLI on Windows**: only `gh.exe` is searched for. (#19)
- **Installed app**: ignores `ELECTRON_RENDERER_URL`, so its pages always load from the app itself. (#19)
- **Hook commands**: the macOS hook command carries `--noproxy 127.0.0.1`, and the Windows command reads and writes UTF-8. Choose **Install … hooks…** again to get them; Codex then asks for `/hooks` trust again. (#19)
- **Windows first-run hello**: says "Click the bone in your tray" instead of "menu bar". (#19)
- **Waiting `?` per session**: another session of the same tool no longer clears it, two blocked sessions each keep their `?`, and a `?` is dropped 30 minutes after it was queued. (#19)
- **Tray menu on macOS**: built when it is opened, so lines such as "Check for updates now (wait 40s)" are current. (#19)
- **Zero limits**: no row for extra usage or a spend limit set to zero, on every provider. (#19)
- **On screen**: one rule keeps him inside the screens' work areas on every path, including a saved position far off screen and a size change; a bubble at the top edge stays below the menu bar; a size change blanks the picture before the resize. (#19)
### Fixed
- **Hook install on an unreadable file**: installing or removing hooks when Claude Code's `settings.json` or Codex's `hooks.json` cannot be read now changes nothing. Before, the file was replaced and its other settings were lost. (#19)
- **Reset times after a restart**: choosing Clock time after a restart with Countdown saved now updates the card at once. (#19)
- **Sleep during fullscreen video**: turning it off during a check can no longer put him to sleep afterwards. (#19)
- **Unwritable settings file**: a size change, a sleep or wake, or Reset position still completes when the settings file cannot be written. (#19)
- **Tokens today**: a Claude message copied into two transcripts is counted once. (#19)
- **SESSIONS list**: a hook with a session id over 256 characters no longer freezes the list. (#19)
- **Login window and rate limits**: a 429 while logging in no longer doubles the requests. (#19)
- **Stored claude.ai paths**: the unused list of discovered claude.ai paths, which could include the organisation id, is emptied at startup. (#19)
- **Windows fullscreen helper**: always starts the system PowerShell, never one found in the current folder or on PATH. (#19)
- **Installer contents**: three unused packages with known advisories (tinyglobby, fdir, picomatch) are left out of the app archive. (#19)
- **Renderer crash**: a crashed dog window reloads itself, at most three times per run, instead of leaving him gone until Restart. (#19)
- **Hide when idle**: no longer hides him while the cursor rests on him. (#19)
- **ChatGPT 429**: backs off with Retry-After instead of reading as "endpoint changed". (#19)
- **Restored rows**: Cursor, Copilot and Gemini rows survive a restart. (#19)
- **Settings file with a byte-order mark**: no longer resets every setting. (#19)
- **Launch at login**: on macOS an entry waiting for approval shows ticked and can be unticked; on Windows the uninstaller removes the startup entry. (#19)
- **Fullscreen on Windows**: he no longer wakes when Start, the tray overflow or Widgets opens over a fullscreen film, and a window that overhangs every display edge counts as maximised, not fullscreen. (#19)
- **Card size change**: the card no longer appears at the old width with a scrollbar. (#19)
- **Windows token renewal and Copilot**: renewal looks only for `claude.exe`, and reading the `gh` login no longer flashes a console window. (#19)
- **Log file**: rotation is retried on the next line when Windows blocks it, so the file no longer grows past its cap. (#19)
- **Log key names**: long setting and payload key names are readable in the log instead of `[redacted]`. (#19)
- **Bug report**: the log path in the issue draft writes your home folder as `~`. (#19)
- **Other fixes from the 2026-11-13 audit**: the full list of its 71 fixes is in `docs/handoffs/AUDIT_2026-11-13.md`. (#19)

Full changelog: [v0.2.9...v0.3.0](https://github.com/ViuMP/Walder/compare/v0.2.9...v0.3.0)

## v0.2.9: fixes from the 0.2.8 qa passes

2026-10-06

Fixes only, for problems found in two full QA passes over 0.2.8, one on a Mac and one on a Windows PC, covering every row of `docs/QA-CHECKLIST.md`. The reports are in `docs/handoffs/` (`QA_0.2.8_REPORT.md`, `QA_0.2.8_WINDOWS_REPORT.md`, `QA_0.2.8_MAC_RECHECK.md`).

Unsigned installers for macOS on Apple Silicon and Windows x64; see the [first-launch steps](https://github.com/ViuMP/Walder).

### Changed
- **Known problem, ChatGPT login**: on some accounts chatgpt.com answers a fresh login with a banner instead of usage. ChatGPT is then read through the Codex CLI login, as before.
### Fixed
- **Saved position**: quitting while he was asleep or lying down no longer relaunches him lower on the screen, and a pet on a widened bubble no longer shifts the saved spot sideways.
- **Bubbles on screen**: at the default corner the hello and the barks no longer run off the right edge. A bubble widens into the room available on screen and is laid out again when the window moves.
- **Size change**: keeps his whole body on screen, at the corner too, and no longer shifts him while a bubble is up.
- **Reset position**: places him 16 px from the screen edges, even with a bubble up.
- **Hover card position**: the card stays put through a bark and the pet that clears it.
- **Hover card dismissal**: the card comes down when the cursor leaves him, also when the system never reports the leave, for example after a drag that ends on him.
- **Primary service first**: the primary service is the first section on the card, as the setting always said.
- **Hover flicker**: a blink no longer flickers the hover.
- **Stuck drag**: a lost mouse-up no longer leaves a drag hanging.
- **First-run hello**: a usage bark on the first poll no longer replaces "Click the bone…" for good; it waits behind it. The hooks offer opens with its own sentence, not one click early.
- **Held pose through posture changes**: when the weekly pool laid him down or stood him up while a `?`, a `… done` or a bark was showing, the tilt, the ears-up or the bark itself is no longer dropped while the bubble stays.
- **Numbers after sleep**: a wake before Wi-Fi was back no longer empties the card, confuses his face and backs off for minutes. The last good numbers stay with their age, the poll waits for the network, and a failed read is retried every 25 seconds for two minutes.
- **Invalid settings**: one bad setting resets only that setting instead of the whole settings file, with one log line per bad key.
- **Logging out**: shows as logged out at once, including the tray's login line, and the numbers from that login leave the card.
- **Large hook bodies**: real `Stop` and `PostToolUse` bodies over 8 KiB are accepted.
- **Hooks status in the tray**: reflects an install or removal at once.
- **Hooks offer**: the first-launch offer no longer blocks the app or appears before he is drawn, and the Codex offer says to trust the hooks with `/hooks`.
- **Tokens today**: one row after a relaunch, not two.
- **Restored card order**: the card restored after a relaunch keeps its order.
- **Credit row on the Large card**: wraps instead of cutting off its label.
- **Launch at login on macOS**: no longer adds a second login item with every new build, since each unsigned build is a new app to macOS. If System Settings ▸ General ▸ Login Items lists Walder more than once from an older version, remove the extras there.
- **Petting over fullscreen on macOS**: a pet over a fullscreen film no longer wakes him for good.
- **Fullscreen video on Windows**: the fullscreen helper never compiled on Windows, so 0.2.8 never noticed a film. He now sleeps over fullscreen video.
- **Display scaling on Windows**: crisp and grounded at 125 % and 150 % scaling. He was drawn smaller than his box, floated above the taskbar and took clicks a few pixels off.
- **Tray menu on Windows**: rebuilt on every open, right-click included; it showed the previous poll's labels.
- **Hooks command on Windows**: exits cleanly when Walder is not running, so Claude Code no longer shows every hook as failed.
- **Claude Code settings on Windows**: writing `settings.json` is retried while Claude Code has it open.
- **Session paths on Windows**: a Windows path on the card's SESSIONS line is shortened at `\`, as a Mac path is at `/`.

Full changelog: [v0.2.8...v0.2.9](https://github.com/ViuMP/Walder/compare/v0.2.8...v0.2.9)

## v0.2.8: yuna, a second character

2026-10-01

Adds Yuna, a cat in five coats, as a second character, chosen the same way as a coat. Walder himself is unchanged from 0.2.7: his sheet, timings and behaviour are identical.

Unsigned macOS installer for Apple Silicon only; see the [first-launch steps](https://github.com/ViuMP/Walder).

### Added
- **Yuna, in five coats**: grey tabby, orange tabby, black, tuxedo and calico, each illustrated frame by frame and approved on 2026-09-21. They sit at the bottom of the Colour menu under the six Walder coats and switch the same way: the choice is remembered across restarts, and a switch mid-animation lands on a valid frame.
- **Yuna's own animations**: every state has her own drawings, not recoloured dog frames: the moods, the sleep curl, the lie-down postures, the bark, the walk, the hop and the petting. Her perk is six frames of batting a red yarn ball, holding the last two; her tail wag is three frames. Her `tilt` and `sleep` frames carry no baked glyphs, so the app draws the same shared `?` and `z z` over her as over Walder. She is carried as five more frame sets with a small per-set animation override; a sheet without that override behaves as before.
### Changed
- **New home on GitHub**: Walder's source is public, and releases (every earlier one copied over), bug reports and security reports are at [github.com/ViuMP/Walder](https://github.com/ViuMP/Walder). The update check and Report a bug… point there from this version on. The old `walder-releases` repository is archived, with 0.2.8 as its last release so that installs still checking it are told where to look.
- **Artwork**: no hand-edited pixels ship; an owner-requested correction to the grey tabby's eyes, made under the single-strip exception in `CONTRIBUTING.md`, was rejected, as logged in `docs/handoffs/CLAUDE_YUNA.md`.
### Fixed
- **Claude Code hooks no longer hold up prompts**: the hooks were installed as synchronous, so every prompt could wait up to a second on Walder's local listener when it was busy. They are now installed with `"async": true`. An existing install is not upgraded on its own: run Install Claude Code hooks… once more; it rewrites Walder's entries in place, adds no duplicates and touches nothing else in `~/.claude/settings.json`.
- **Handbook Silver dapple swatch**: no longer a broken image. Coat rows and their pictures now both come from the sprite sheet, so a new coat cannot arrive without its picture; the five Yuna swatches are included.

Full changelog: [v0.2.7...v0.2.8](https://github.com/ViuMP/Walder/compare/v0.2.7...v0.2.8)

## v0.2.7: gemini via antigravity, and fixes after 0.2.6

2026-09-22

Fixes for what the installed 0.2.6 did on a Mac that the development build had not, and Gemini usage read the way Antigravity reads it. A Windows installer was added to this release afterwards.

Unsigned installers for macOS on Apple Silicon and Windows x64; see the [first-launch steps](https://github.com/ViuMP/Walder).

### Added
- **Gemini**: while Antigravity is running, Walder asks its local language server over loopback for the figures Antigravity's own panel shows: `Gemini weekly` and `Claude & GPT weekly`, plus more windows on plans that have them. Nothing is sent to Google and there is no login window; the section says "open Antigravity" when it is not running. Walder reads only the language server's process id, listening ports and CSRF argument, and never logs the token ([privacy](https://github.com/ViuMP/Walder/blob/main/docs/privacy.md)). (#16)
- **Windows installer**: the first Windows x64 installer of the 0.2 series, `Walder-0.2.7-win-x64.exe`, added to this release afterwards. It has had far less use than the Mac build.
- **Weekly inject items**: Developer ▸ Inject usage ▸ Weekly 92% and Weekly 96%, one per lying pose. In the v0.2.6 tag, but the first 0.2.6 installer predates them.
### Changed
- **Show in overview per service**: one checkbox per service (Claude, ChatGPT, Cursor, Copilot, Gemini). An unticked service loses its section and its barks. A service whose rows were all hidden in 0.2.6 stays hidden until ticked. (#16)
- **Three-second hold on `?` and `done`**: these bubbles wait three seconds before showing, and are dropped if the same tool contradicts them in that time (you type, the turn ends, or an approved command finishes). This stops a Codex approval check that never asked you anything from showing a `?` mid-turn, and a batch of agents finishing from queueing a `done` each. A real approval prompt shows as before. (#16)
- **`done` clears when you return**: typing your next prompt clears that tool's `done`; bringing the tool's app to the front clears its `done` and its `?`. The second part is Claude Code only, because Codex sessions carry no process id. (#16)
- **Fourth hook entry**: the hooks files gain `PostToolUse`. Reinstall both from the tray after updating; Codex asks you to trust the new entry once with `/hooks`. (#16)
- **Facing**: he faces the centre of the main display from wherever he stands, on any monitor. (#16)
- **Services without a login**: a service you are not logged in to is not on the card. This is in the v0.2.6 tag, but the first 0.2.6 installer predates it.
### Fixed
- **Phantom ChatGPT rows**: four rows named `ChatGPT 0…3` showing `?` came from a fallback endpoint that returned model presets. A row now needs a number, and an endpoint that yields none is skipped. (#16)
- **Copilot in the installed app**: an app launched from Finder could not find `gh` and reported no Copilot. `gh` is now looked for on PATH and in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` and `/usr/bin`. (#16)
- **Antigravity restarts**: a quit or restarted Antigravity is noticed within the same poll, not one poll later. (#16)

Full changelog: [v0.2.6...v0.2.7](https://github.com/ViuMP/Walder/compare/v0.2.6...v0.2.7)

## v0.2.6: cursor, copilot and the weekly posture

2026-09-20

Cursor and GitHub Copilot join Claude and ChatGPT on the hover card, read from logins already on the machine, and Walder lies down when the weekly pool runs high. The release also ships the P0, P1 and P2 items from the codenotch gap analysis, including still mode, Claude Code login renewal, bark presets and a SESSIONS block.

Unsigned macOS installer for Apple Silicon only; see the [first-launch steps](https://github.com/ViuMP/Walder).

### Added
- **Cursor**: read from the editor's own login (`state.vscdb`), never a browser sign-in, which would create an empty second account. Rows: `Cursor plan`, `Cursor Auto` when it differs from the plan figure, and `Cursor on-demand` when a spend limit exists. The plan resets at the end of the billing cycle. (#3)
- **GitHub Copilot**: read with the GitHub CLI's token (`gh auth token`); Walder never logs in, refreshes or writes anything itself. Rows: `Copilot premium`, `Copilot chat` and `Copilot completions`, each a percentage of the month's quota with the account-wide reset date. An account with no Copilot says so instead of "endpoint changed". Cursor and Copilot are polled every 180 seconds with the same backoff as the other services, and nothing about either account is logged. (#3)
- **Weekly lie posture**: when `7-day (all models)` or `7-day Fable` reaches 90 % he lies down with his head up, and from 95 % with his head on his paws. Both are held poses with no animation. Barks, perks and the `?` play over the pose and he stays down. The face still follows the Claude 5-hour window. (#4, #12)
- **Bark presets**: Barks ▸ Quiet (95 and 100 %), Normal (80, 85, 90, 95, 100 %) or Chatty (every 10 %). Switching never repeats a level already announced. (#3)
- **Bark sound**: a tray checkbox, off by default. One short bark (a CC0 recording of a small dog) plays with threshold barks only, not with `Claude done` or a `?`. (#4)
- **SESSIONS block**: the Large card lists live Claude Code and Codex sessions, their folder, and whether each is working, waiting or done. Entries older than 30 minutes drop off. (#3)
- **Raise the terminal**: petting him while `Claude waiting` is up brings forward the app that owns the session (Terminal, iTerm, VS Code, Cursor and others). Claude Code only, because Codex hooks carry no process id. (#3)
- **Still mode**: a tray checkbox, also turned on by the system Reduce Motion setting, that stops all animation. His face still changes. (#1)
- **Screen-reader text**: the dog carries a label with his expression, the Claude 5-hour percentage and the current bubble; barks are announced, and hover card rows carry sentence labels. (#1)
- **Claude Code sessions without hooks**: Walder reads Claude Code's session registry (`~/.claude/sessions/`) every 2 seconds for done and waiting events, with nothing to install. Codex still uses hooks. (#1)
- **First-run introduction**: first launch shows three bubbles, one per pet: where the menu is, how to log in if the first poll found no numbers, then the hooks offer. (#1)
- **Claude Code login renewal**: when the Claude Code token is within four minutes of expiry and Walder has no other way to read usage, it runs the `claude` CLI so Claude Code renews its own login. Walder never touches the refresh token. Developer ▸ Renew Claude Code login now runs one attempt on demand. (#1)
- **Reset times**: Reset times ▸ Clock time (the new default) or Countdown. Clock time reads, by distance, `resets in 47m`, `resets in 3h 20m`, `resets Thu 14:30` or `resets 28 Sept`. (#2)
- **Notify when hidden**: a tray checkbox, off by default. A usage bark or a waiting tool sends a system notification while he is hidden by Hide when idle or asleep for fullscreen. (#2)
- **Claude Code logged-out notice**: when Claude Code's stored login has been emptied, the card says so with the fix, and he says it once per logout. (#2)
- **Per-service refresh time**: a card section whose numbers are older than the rest shows how long ago it refreshed, for example `refreshed 9 min ago`. (#2)
- **Stable download names**: each installer is also uploaded as `Walder-mac-arm64.dmg` or `Walder-win-x64.exe`, so `releases/latest/download/…` links do not change between releases. (#2)
- **Developer ▸ Inject usage**: `Weekly 92%` and `Weekly 96%`, one for each lying pose. (#9, #13)
### Changed
- **Services without a login**: a service you are not logged in to is not shown on the card; the Accounts submenu offers the login. A login that exists and fails still shows, with what to do about it. (#9)
- **Accounts submenu**: lists all four services. Cursor and Copilot have no Log in or Log out items, because their logins belong to the editor and to `gh`. (#3)
- **One string table**: every sentence Walder says comes from `src/core/strings.ts`. English only for now. (#3)
- **Waiting outranks a bark**: a `?` keeps the screen; a threshold bark that arrives meanwhile waits until the pet that clears the `?`. (#1)
- **Backoff**: a `Retry-After` from a service raises Walder's own backoff, and the backoff survives a relaunch. (#2)
- **Polls on wake and at reset**: Walder polls when the computer wakes and when a window's reset time passes, so the face does not lag behind a lifted limit. (#2)
- **Status notes name the fix**: the Medium and Small cards now show the remedy too, for example `use Accounts ▸ Claude ▸ Log in…`. (#2)
- **Codex credit estimate**: the Large card shows the credit counts behind the estimated money figure. (#2)
- **Codex credits row**: hidden when the endpoint states no balance. (#1)
- **Logging out**: removes that service's numbers from the card at once. (#2)
- **Gemini dropped**: Google closed the personal Gemini CLI sign-in in favour of Antigravity, and the consumer Gemini app has no usage endpoint, so Walder does not read Gemini. (#14)
- **Installers on tags only**: installers are built only for release tags and manual runs; every pull request still gets the type-check and the tests. (#14)
### Fixed
- **Bark sound timing**: the clip is loaded when the setting is turned on, so it plays with the bubble instead of a beat later. (#9)
- **Double bark sound**: a renderer reload while a bark was on screen could play it twice. (#4)
- **Stale `?`**: a `?` for a session that no longer exists stands down after 30 minutes. (#1)
- **Standing up while lying down**: a `Claude done` no longer stands him up when he is lying down. (#4)
- **Frozen numbers**: every provider request is sent with `Cache-Control: no-cache`, so a cached answer can no longer freeze the numbers. (#2)
- **Claude Code token rotation**: a 401 on the Claude Code token triggers one keychain re-read and retry with a newer token before a login is asked for. (#2)
- **Lost first-run bubble**: the face and bubble are replayed when the renderer loads, including after a renderer crash. (#1)
- **Black and tan coat**: the light tan is removed from the coat, including the idle pose's chest.

Full changelog: [v0.2.5...v0.2.6](https://github.com/ViuMP/Walder/compare/v0.2.5...v0.2.6)

## v0.2.5: tool-specific bubbles and codex hooks

2026-09-15

Fixes for cut-off and repeated barks and for the hover card over full-screen apps, plus bubbles that name the tool, Codex hooks, and a warning when hooks are missing.

Unsigned macOS installer for Apple Silicon only; see the [first-launch steps](https://github.com/ViuMP/Walder).

### Added
- **Tool-specific bubbles**: `Claude done` and `Claude waiting` replace `woof` and the bare `?`; Codex gets `Codex done` and `Codex waiting`. Replies from both tools seconds apart both show, and a new prompt clears only its own tool's wait. The pixel `?` still appears by his ear.
- **Codex hooks**: Install Codex hooks… writes three entries (`Stop`, `PermissionRequest`, `UserPromptSubmit`) to `~/.codex/hooks.json`. Codex runs a new hook only after you trust it once: run `codex`, type `/hooks` and trust Walder's entries. Codex has no event for plan-mode questions, so `Codex waiting` covers command and patch approvals only. The `notify` setting is not touched.
- **Missing-hooks warning**: the tray shows whether Claude Code and Codex hooks are installed, for example `Claude Code hooks: installed (port 47811)` or `not installed`. If they are missing at launch Walder says so once, and on a machine that has the tool he offers to install them once; a declined offer is not repeated.
- **"You're up to date"**: a manual Check for updates that finds nothing newer says so in a bubble. Scheduled checks stay silent.
- **Report a bug…**: opens a prefilled GitHub issue on the releases repository with an environment block (version, macOS, Electron, displays, settings, update state, log path), also copied to the clipboard. It contains no account name and no usage number, and nothing is sent until you submit on GitHub. Developer ▸ Reveal log file opens Finder on `walder.log`.
- **Show in overview**: a checkbox per row in the tray menu. A hidden row leaves the hover card at once and never barks; the face still follows the Claude 5-hour window.
### Changed
- **Bubbles name the service**: barks share one form, for example `Claude 5h: 87% used`, `Claude 7-day: 90% used` and `Fable weekly: 81% used`. Money rows become `Claude credits` and `Codex credits`, and exhaustion notices read `Codex credits: 100% used` and `Claude credits: 100% used`. The update notice reads `Walder 0.2.5 is out`. Hover card row labels are unchanged.
- **Fully hidden services**: unticking every row of a service removes the service from the card. A service that reported no rows still says "no limits reported".
- **Claude Code hooks**: if Walder has never reacted to Claude Code, install the hooks from the tray and restart Claude Code.
### Fixed
- **Cut-off bubbles**: the window widens to fit the whole sentence on one line, using the real width of the system monospace font. Every sentence is checked against the renderer at five pixel ratios.
- **Repeated barks**: a restart no longer repeats a threshold already announced, and a window easing back from 84 % to 81 % no longer re-arms the 80 % bark. The bubble still shows the observed number.
- **Hover card over full-screen Spaces**: the card is shown again on every hover instead of staying placed on another Space, and a card whose renderer died is reloaded.

Full changelog: [v0.2.4...v0.2.5](https://github.com/ViuMP/Walder/compare/v0.2.4...v0.2.5)

## v0.2.4: internal correctness fixes

2026-09-12

An internal correctness release with no visible changes. A full security review found no vulnerabilities in this or any earlier version; it found two checks and two comments that did not match their stated intent, none reachable by an attacker, and this release corrects them.

Unsigned macOS installer for Apple Silicon only; see the [first-launch steps](https://github.com/ViuMP/Walder). Nothing here needs action if you are on 0.2.3.

### Changed
- **Login window loopback check**: besides `127.0.0.1`, `::1` and `localhost`, the check now also refuses the IPv4-mapped IPv6 form (`::ffff:127.0.0.1`) and names with a trailing dot (`localhost.`). This was never exploitable: the check only governs where the login window may navigate, an earlier rule already refuses plain `http`, and Walder's local listener validates every request.
- **Stored ChatGPT endpoint path**: a path beginning with `//` is now refused when it is written. It was already cleaned every time it was read.
- **Code comments**: two comments that overstated the code are corrected; one named the wrong port and one claimed a guarantee the code does not provide.

Full changelog: [v0.2.3...v0.2.4](https://github.com/ViuMP/Walder/compare/v0.2.3...v0.2.4)

## v0.2.3: a packaging fix for macos

2026-09-11

A packaging fix only; app behaviour is unchanged. Walder can now be installed on macOS without using Terminal.

Unsigned macOS installer for Apple Silicon only; see the [first-launch steps](https://github.com/ViuMP/Walder).

### Fixed
- **"Damaged" warning on macOS**: every release up to 0.2.2 shipped a bundle whose code signature did not verify, so macOS reported the download as damaged and offered no Open Anyway button. The signature now verifies, so first launch shows the ordinary unidentified-developer block, which System Settings ▸ Privacy & Security ▸ Open Anyway clears. Walder still has no Apple developer certificate and is not notarised.
- **Stuck 0.2.2 installs**: installing this release is the fix for an older build stuck on the "damaged" dialog; the `xattr` workaround is no longer needed, though it still works.

Full changelog: [v0.2.2...v0.2.3](https://github.com/ViuMP/Walder/compare/v0.2.2...v0.2.3)

## v0.2.2: bug fixes and legibility

2026-09-11

A bug-fix and legibility release. The main fix is an animation-clock error that froze Walder mid-blink and again after every click.

Unsigned macOS installer for Apple Silicon only; there is no Intel build. See the [first-launch steps](https://github.com/ViuMP/Walder).

### Added
- **Primary service**: a tray setting, Claude or ChatGPT. That service's rows lead the hover card, and its bark shows first when several windows cross a threshold in the same poll. The face still follows the Claude 5-hour window.
### Changed
- **Bubbles stay until clicked**: every bubble (a bark, `woof`, the `?`, the update notice) now stays until you click him, because polls are three minutes apart and a 12-second bubble was easy to miss. The `…zzz` from petting a sleeping dog still fades on its own.
- **Hide when idle keeps unread bubbles**: with Hide when idle on, a bubble you have not clicked keeps him on screen.
- **Higher threshold replaces its bark**: an 80 % bubble waiting to be clicked becomes the 85 % one instead of queueing behind it. A different window still waits its turn.
- **Readable bubble size**: the speech bubble is 12, 14 or 16 px at Small, Medium or Large. It was a fixed multiple of the sprite and shrank to 8 px. The space reserved above him follows the same value.
- **Wider hover card**: 380 px at Large, so the `Codex credit limit` label is no longer cut off by its value.
- **Extra usage reset line**: restored, as `resets in 19d 3h (est.)`. claude.ai states no date for this row, so Walder estimates the first of the next calendar month and marks it `(est.)`.
- **Handbook**: the attached handbook is now the 0.2 edition.
- **Known problem, macOS download**: macOS reports this unsigned download as "damaged", and right-click ▸ Open does not help on macOS 15. v0.2.3 fixes it; the workaround is in [troubleshooting](https://github.com/ViuMP/Walder/blob/main/docs/troubleshooting.md#if-macos-says-walder-is-damaged).
### Fixed
- **Animation freeze**: the frame clock armed no timer when an animation was swapped mid-paint, which left him stuck mid-blink and motionless after a click. He now blinks normally and returns to the idle loop after every click.
- **Hover card position**: the card is anchored to his resting pose instead of the current frame, so a blink, bark or pet no longer moves it. It moves only when the window is dragged, the size changes or he turns round.
- **Currency symbol**: shown on both halves of a money row (`€9.62 / €50.00`).

Full changelog: [v0.2.1...v0.2.2](https://github.com/ViuMP/Walder/compare/v0.2.1...v0.2.2)

## v0.2.1: codex credit limit row

2026-09-11

The first 0.2 release offered to 0.1.2 installs from the tray. It contains everything in v0.2.0, which was not published at the time, plus a Codex credit limit row.

Unsigned macOS installer; see the [first-launch steps](https://github.com/ViuMP/Walder).

### Added
- **Codex credit limit**: a row on the ChatGPT side of the card showing the workspace's monthly Codex spend limit as a used percentage (it can exceed 100 %), with a reset line. It also shows an estimated money figure (for example `Est. $109.30 / $24.00`) priced from the new `codexCreditPrice` setting: $0.04 per credit by default, settable to EUR, or `null` for plain credit counts. Absent on accounts with no spend limit.
### Changed
- **Handbook**: the attached handbook is the 0.1.2 edition.

Full changelog: [v0.2.0...v0.2.1](https://github.com/ViuMP/Walder/compare/v0.2.0...v0.2.1)

## v0.2.0: tokens today, card sizes and new art

2026-09-11

The first 0.2 build: a Tokens today row, three card sizes, more usage rows and a new art set. It was built and smoke-tested but not published at the time; v0.2.1 superseded it.

Unsigned macOS installer; see the [first-launch steps](https://github.com/ViuMP/Walder).

### Added
- **Tokens today**: a row per service on the hover card, counted from the Claude Code and Codex transcripts on your machine since local midnight. It includes cache reads, so it matches billing. Absent when a CLI is not installed.
- **Card size**: Large, Medium and Small (condensed) in the tray menu.
- **Real 7-day Fable row**: read from claude.ai's per-model limits. The shared-pool figure is now only a fallback.
- **Extra usage and Codex credits**: a money row for Claude extra usage and a row for Codex credits.
- **Silver dapple coat and new art**: a new golden art set with a still idle and blinks, approved worried and exhausted poses, a clearer `out` pose, and shared heart, question-mark and sleep glyphs.
- **Hide when idle**: a new mode, with a keyboard shortcut.
- **Update bubble**: a bubble kind for update notices.
### Changed
- **Handbook**: the attached handbook is the 0.1.2 edition; a 0.2 edition follows in a later release.
### Fixed
- **Hover card over full-screen apps**: the card now appears over macOS full-screen apps.
- **Unknown usage windows**: only the specified usage windows reach the card. Unknown windows (for example "Amber ladder") are dropped.
- **Queued exhaustion alerts**: a second queued exhaustion alert is no longer discarded when the first is dismissed.

Full changelog: [v0.1.2...v0.2.0](https://github.com/ViuMP/Walder/compare/v0.1.2...v0.2.0)

## v0.1.2: fable weekly row and pet refresh

2026-09-09

Adds a weekly Fable row, hides internal entries from the card, and lets a pet refresh the numbers. This build is for macOS only.

The installer is unsigned; see the [first-launch steps](https://github.com/ViuMP/Walder).

### Added
- **Fable weekly row**: a Fable row derived from the shared weekly pool.
### Changed
- **Petting refreshes usage**: a pet triggers a usage refresh, at most once a minute.
### Fixed
- **Internal entries hidden**: keys in the usage response that are not limits (for example `nimbus_quill`) no longer appear as rows.

Full changelog: [v0.1.1...v0.1.2](https://github.com/ViuMP/Walder/compare/v0.1.1...v0.1.2)

## v0.1.1: login and fullscreen fixes

2026-09-09

Fixes from the first try-out: ChatGPT and Claude logins now register, and fullscreen video in Chrome and Safari is detected. The Windows build is still untested.

The installers are unsigned; see the [first-launch steps](https://github.com/ViuMP/Walder).

### Added
- **Last check in the Accounts menu**: each account shows what happened the last time Walder checked it, such as `HTTP 401` or `timeout`, never a name or email address.
### Fixed
- **ChatGPT and Claude login**: a login made in Walder's window now registers. Cookies are sent on authentication checks, the login window allows https only and permits SSO through WorkOS, and it presents a Chrome user agent.
- **Fullscreen detection**: checks every window of the front app, so fullscreen video in Chrome and Safari is detected. It tolerates the menu bar and no longer gives up permanently after a failure.

Full changelog: [v0.1.0...v0.1.1](https://github.com/ViuMP/Walder/compare/v0.1.0...v0.1.1)

## v0.1.0: first try-out build

2026-09-08

The first try-out build of Walder, a pixel-art dachshund that sits on the desktop and shows how much of your AI subscriptions you have left.

The installers are unsigned; see the [first-launch steps](https://github.com/ViuMP/Walder).

### Added
- **Desktop dog**: a golden long-haired miniature dachshund with no window and no Dock icon, drawn over other apps in a corner of the screen. Clicks on the transparent space around him pass through.
- **Face**: follows the Claude 5-hour window. Happy under 50 %, neutral to 79 %, worried to 94 %, exhausted to 99 %, out at 100 %, and confused when Walder has no number.
- **Barks**: a speech bubble when a usage window crosses 80, 85, 90, 95 or 100 %, once per threshold per window. It clears after about 12 seconds or on a click.
- **Hover card**: every percentage, the time until each resets, where the numbers came from and how old they are.
- **Accounts**: log in to claude.ai and chatgpt.com from the tray menu. Existing Claude Code and Codex CLI logins on the machine are read automatically. Numbers refresh about every three minutes.
- **Claude Code hooks**: Install Claude Code hooks… adds three entries to `~/.claude/settings.json`. He perks his ears and says `woof` when Claude Code finishes a reply, and tilts his head with a `?` while it waits for you. Remove Claude Code hooks… undoes it.
- **Fullscreen sleep**: he curls up while something is fullscreen on his screen and stands up when it ends. Can be switched off.
- **Sizes and coats**: Small, Medium and Large (72, 144 and 216 px), and five coats: Golden, Red, Cream, Black and tan, Chocolate.
- **Tray menu**: a bone icon in the menu bar or system tray, with Reset position, Refresh now, Launch at login and a verbose log. Click to pet him, drag to move him, right-click for the same menu.
- **Windows build**: a Windows installer is included, untested.

Full changelog: [v0.1.0](https://github.com/ViuMP/Walder/releases/tag/v0.1.0)

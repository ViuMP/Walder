# Walder

Walder is a small pixel-art dog — a golden long-haired miniature dachshund — who
sits on your desktop and keeps an eye on how much of your AI subscriptions you
have left.

He has no window and no Dock icon. He sits in a corner of the screen, on top of
whatever you are doing, and gets on with three jobs:

- **His face tells you the number without you asking.** He is cheerful when your
  Claude 5-hour window is barely touched, and increasingly worn out as it fills.
- **He barks** — a little speech bubble — when you cross 80, 85, 90, 95 and 100 %.
- **He gets out of the way.** He curls up and sleeps tiny while you watch
  something fullscreen.

Hover over him and a small card appears with the actual percentages. Click him
to pet him. Drag him anywhere. Right-click him for the menu. He also perks his
ears up when Claude Code finishes a reply, if you turn that part on.

macOS and Windows. Built with Electron.

**A note on Windows before you start.** Walder is built and tested on a Mac.
The Windows installer is produced on that Mac and **has never been run by the
developers** — not the installer, not the tray icon, not the fullscreen
detection. It is expected to work; nobody has watched it. If you are the first,
please report what you actually see, including the parts that go fine.

## Installing on a Mac

1. Open the `.dmg` file.
2. Drag **Walder.app** into your **Applications** folder.
3. Open Applications and **double-click Walder**. macOS will block it — that is
   expected, and the next step is how you get past it.
4. Go to **System Settings ▸ Privacy & Security**, scroll down to the message
   about Walder being blocked, and click **Open Anyway**. Confirm, and enter your
   password or Touch ID if asked.

That is a one-time thing. After it, Walder opens like any other app.

**Why it is blocked.** Walder is not signed with an Apple developer certificate,
so macOS cannot check who made it and refuses to open it by default. **Open
Anyway** is how you tell macOS you trust it regardless.

*On macOS 14 and older*, right-clicking the app and choosing **Open**, then
**Open** again in the box, does the same job in one step. That shortcut was
removed in macOS 15 — right-click ▸ Open there gives you the same refusal as a
double-click — so **Open Anyway** in System Settings is the route that works on
every version.

## Installing on Windows

> **Not yet tested by the developers.** Everything in this section and every
> other mention of Windows below describes what the code is *built* to do. No
> Walder developer has a Windows machine, so none of it has been watched
> happening. Please report what you see — including "it just worked".

1. Run the `.exe`.
2. Windows SmartScreen will warn you that it does not recognise the app. Click
   **More info**, then **Run anyway**.
3. The installer asks where to put Walder and offers a desktop shortcut.

Same reason as on the Mac: the app is not signed with a certificate Windows
recognises, so Windows cannot tell who made it and warns you instead. One time
only.

## First run

There is no window, and nothing appears in the Dock or the taskbar. Two things
to look for:

- **A little bone icon** in the menu bar (Mac, top right) or the system tray
  (Windows, bottom right — untested, see the note above). That menu is the whole
  app — there is no settings window anywhere.
- **The dog**, in the bottom-right corner of your main screen.

Then set him up from that menu, in this order:

1. **Accounts ▸ Claude ▸ Log in…** — a normal login window opens on claude.ai.
   Log in as you would in a browser. The window closes itself once the login has
   taken.
2. **Accounts ▸ ChatGPT ▸ Log in…** — the same for chatgpt.com.
3. **Install Claude Code hooks…** — only if you use Claude Code, and only if you
   want the ears-up reaction. It asks first, naming the file, then writes three
   small entries into your Claude Code settings and tells you what it did. Your
   original file is copied first, and **Remove Claude Code hooks…** in the same
   menu undoes it.
4. **Launch at login** — tick it so Walder comes back after a restart.

If you already use Claude Code or the Codex CLI on this machine, Walder can read
those logins on its own and may show numbers before you log in to anything.

The numbers refresh by themselves about every three minutes.

## His faces and his barks

His face follows **one** number: your **Claude 5-hour window**. That is the
allowance that actually runs out in the middle of an afternoon.

| Face | When |
| --- | --- |
| Happy — grinning, tail up | under 50 % used |
| Neutral — calm, breathing | 50 % to 79 % |
| Worried — ears down, a bead of sweat | 80 % to 94 % |
| Exhausted — half-closed eyes, panting | 95 % to 99 % |
| Out — flat on the floor, X eyes | 100 % or more |
| Confused — head cocked, a question mark | we could not read your usage |

**The confused face is honest, not broken.** It means Walder has no number for
your Claude 5-hour window right now: you are not logged in, a login has expired,
or the site answered with something it did not recognise. Hover over him — the
card names the problem — and **Accounts** in the menu is where you fix it. He
never shows a cheerful face on a number he does not have.

**Barking.** When a usage window crosses 80, 85, 90, 95 or 100 %, he barks once
with a bubble like `5-hour: 87% used`. Once per threshold per window, so he does
not nag. The bubble goes away by itself after about 12 seconds, or straight away
if you click him. Every window he can see gets its own barks, not only the
5-hour one.

**What you can do to him:**

| Action | What happens |
| --- | --- |
| Hover | after a moment, a card appears beside him with every percentage, how long until each resets, where the numbers came from, and how old they are |
| Click | he squeezes his eyes shut and a heart pops up. Also dismisses whatever bubble is up |
| Drag | he follows the cursor. He will not let you push him fully off the screen |
| Right-click | the menu opens — the same one as the bone icon |

Clicks on the transparent space around him pass straight through to whatever is
behind, so he does not block anything he is not standing on.

## Sizes and colours

**Size** in the menu: **Small**, **Medium** or **Large** — one, two or three
screen pixels per drawn pixel. Medium is the default, and the size the artwork
is drawn for. **Colour** offers five coats: **Golden** (Walder himself),
**Red**, **Cream**, **Black and tan**, **Chocolate**. Both choices are
remembered.

## Fullscreen behaviour

When something goes fullscreen on the screen he is sitting on — a film, a video
call, a presentation, a game — he curls up into a tiny sleeping dog and stays
out of the way. (On Windows this leans on a small PowerShell helper that no
developer has ever watched run; if he never sleeps there, that is the first thing
to say in a report.) When it ends he stretches and stands back up. It is per screen:
a video on your second monitor does not put a dog sitting on the laptop screen
to sleep.

If a bark arrives while he is asleep, he wakes up long enough to say it. If you
click a sleeping dog he stirs and mumbles `…zzz` rather than waking.

To switch it off, untick **Sleep during fullscreen video** in the menu. He then
stays visible over everything.

## The Claude Code perk

If you use Claude Code in a terminal, Walder can react to it:

- **Claude Code finishes a reply** → his ears go up and he says `woof` for a few
  seconds.
- **Claude Code is waiting for you** (a permission question, or an idle prompt) →
  he tilts his head and shows a `?`, and holds it until you type your next
  message or click him.

This needs **Install Claude Code hooks…** from the menu, once. It adds three
entries to `~/.claude/settings.json` that send a tiny message to Walder on your
own machine, and nothing else. If Walder is not running, the entries do nothing
and Claude Code carries on exactly as before.

That message goes to a listener which only accepts connections from your own
machine, normally on port 47811.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| You cannot find the dog, or he is on a monitor you have unplugged | Menu ▸ **Reset position** — he jumps back to the bottom-right of your main screen |
| Your clicks near the dog go to the wrong place | Menu ▸ tick **Force interactive (debug)**. His whole square then takes clicks. Untick it to go back |
| The card says **login needed** or **not logged in** | Menu ▸ **Accounts ▸ Log in…** for that service. Use **Log out** first if a login has gone stale |
| The card says **endpoint changed** | The service moved something we read. Nothing you can fix; the other numbers still work |
| Numbers look old, or nothing has updated | Menu ▸ **Refresh now**. It will not run more than once a minute — the item says how long to wait |
| The ears never go up when Claude Code finishes | Run **Install Claude Code hooks…** again (the port can change if something else took 47811), then restart Claude Code |
| He is asleep and there is no fullscreen video | Untick **Sleep during fullscreen video**, which wakes him immediately |
| Something else is wrong | Menu ▸ **Developer ▸ Verbose log**, reproduce the problem, then send the log file (below) |

**The verbose log.** Ticking **Developer ▸ Verbose log** turns on a detailed log
file. Warnings are always written, whether or not it is ticked; the tick adds
the detail. It rotates at 1 MB and keeps three files, so it cannot fill a disk.

- Mac: `~/Library/Logs/walder/walder.log`
- Windows: `%APPDATA%\walder\logs\walder.log` (untested — the menu prints the
  real path, and that is the one to trust)

The menu prints the full path just under the tick, so you can read it off the
screen instead of typing it out.

Logins and tokens are removed from anything written to that file.

## Privacy

Walder reads three things, all on your own machine:

- Your existing **Claude** login — the Claude Code login if you have one,
  otherwise a claude.ai browser session you create through **Accounts**.
- Your existing **ChatGPT** login — a chatgpt.com browser session, or the Codex
  CLI login if you have one.
- **Claude Code hook events**, if you installed the hooks. They arrive over a
  listener that accepts connections only from your own machine.

Where it talks: `claude.ai` and `api.anthropic.com`, and `chatgpt.com`. Nowhere
else. The login windows will only ever navigate to those sites, their sign-in
pages, and the "continue with Google / Microsoft / Apple" providers.

Logins and tokens are read at the moment a check is made and held in memory
only. They are never written to the settings file, never written to the log
(anything that looks like one is masked), and never sent anywhere except back to
the service they belong to. The settings file keeps your position, size, colour
and the last percentages — nothing else.

No analytics. No telemetry. No account, no server of ours, nothing phoning home.

**Log out** under **Accounts** clears that service's whole stored session, not
only its cookies.

## Updating

Install the new `.dmg` or `.exe` over the old one. On the Mac, quit Walder from
the menu first, then replace the app in Applications. On Windows, run the new
installer.

Your settings, position, size, colour and logins are kept — they live outside
the app itself.

There is no automatic update. You install new versions yourself.

## Uninstalling

**If you installed the Claude Code hooks, take them out first:** menu ▸ **Remove
Claude Code hooks…**. It asks first, naming the file it is about to change, then
strips Walder's three entries and leaves everything else in `settings.json`
untouched. A dated copy of the file is saved beside it either way.

If for some reason that fails, you can do it by hand: open
`~/.claude/settings.json` in a text editor and delete the three entries whose
`command` line contains `walder-hook` — one each under `Stop`, `Notification` and
`UserPromptSubmit`. There is also a dated copy of the file from before Walder
first touched it, named `settings.json.walder-backup-…`, in the same folder.

Then:

- **Mac:** **Quit** from the menu, then drag **Walder.app** to the Trash.
- **Windows** (untested, like everything else on Windows): quit from the tray
  menu, then uninstall through **Settings ▸ Apps** (or Add/Remove Programs) as
  usual.

Your settings file is left behind and does no harm. If you want it gone too:
`~/Library/Application Support/walder/` on a Mac, `%APPDATA%\walder\` on
Windows.

## For developers

Node.js 22.12 or newer (24 recommended). `npm install` also downloads the
Electron runtime (~130 MB, first time only).

| Script | What it does |
| --- | --- |
| `npm run dev` | Run the app in development, with hot reload |
| `npm run build` | Compile main, preload and renderer into `out/` |
| `npm run sprites` | Open the animation gallery: every animation of the loaded sheet at 4x with its name, frame count and frame durations, a palette switcher, a "play once" button for the one-shots, and a 1-px grid toggle. This is how the artwork gets approved |
| `npm run probe` | Ask every usage provider once, from the terminal, and print what each said |
| `npm test` / `npm run test:watch` | Run the unit tests |
| `npm run typecheck` | Type-check everything without emitting |
| `npm run dist:mac` / `dist:win` / `dist:all` | Build installers into `release/` |
| `npm run install-hooks` | Install the Claude Code hooks (`-- --remove` takes them out) |
| `npm run sync:sheet` | Copy `art/walder.json` into the app after validating it (runs automatically before `dev`, `build` and `sprites`; a sheet that fails validation stops the build instead of reaching the app) |
| `npm run gen:tray` | Regenerate the tray icons (runs automatically before `dev` and `build`) |
| `npm run gen:icons` | Regenerate the app icons from the sprite (runs automatically before `dist:*`) |
| `npm run check:asar` | Open the packaged `app.asar` and check what went into it: no source, tests, artwork or config; every runtime dependency present; no native build tooling. Runs automatically after `dist:mac` and `dist:win` |

`WALDER_LOG=1 npm run dev` turns on the diagnostics; add `WALDER_DEBUG=1` to
outline the clickable area in magenta.

```
src/core/       Pure TypeScript: no Electron, no network, fully unit-tested.
                buckets.ts / usage.ts    provider payloads -> the snapshot
                expression.ts            usage % -> which face to show
                nudge.ts                 when to bark, once per threshold
                behaviour.ts             arbitrates usage, hooks, clicks, fullscreen
                bubble.ts                speech-bubble wording and wrapping
                fullscreen.ts            is the active window fullscreen, per display
                hittest.ts / interaction.ts / geometry.ts   clicks, drag, clamping
src/main/       Electron main process: windows, tray, timers, poller, hook
                server, login windows, settings store.
src/providers/  The four usage sources and the chain that orders them.
src/preload/    The contextBridge seam between main and renderer.
src/renderer/   The overlay window, the hover panel, the sprite gallery.
src/sprites/    The sprite sheet the app draws (a validated copy of art/).
art/            The artwork and its generator. See art/README.md.
test/           Vitest suites, provider fixtures, the old M3 checklist.
docs/           BUILD_LOG.md (the stage-by-stage record), QA-CHECKLIST.md.
```

Anything under `src/core/` must stay free of Electron imports so it can be
tested in plain Node — that is what keeps the tricky logic (threshold firing,
window resets, tolerant payload parsing) provable. `docs/QA-CHECKLIST.md` is the
manual checklist, and it includes an honest list of what no human has ever
verified.

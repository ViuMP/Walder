"""Build the Walder handbook. Content only — all chrome comes from handbook.py."""
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from handbook import Handbook, figure, note, check  # noqa: E402
import walder_parts as W  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))   # <repo>/docs/handbook -> <repo>
OUT_DIR = HERE

hb = Handbook(
    title="Walder, and what he is telling you",
    subtitle="Every face, wiggle and speech bubble the desk dog has — what each one means, "
             "and the five minutes of setup that has to happen first.",
    eyebrow="Walder 0.2.1 · new-user handbook",
    thesis="Walder has exactly one job: tell you how much of your Claude 5-hour window is gone "
           "without you having to ask. His face follows that single number. His bark names any "
           "window that has just crossed a threshold. Everything else he does is either a "
           "reaction to you, a reaction to Claude Code, or him getting out of your way.",
    chain=["install", "log in", "read his face", "read his barks", "pet him"],
    meta=[("Runs on", "macOS (tested) · Windows (built, never run)"),
          ("Lives in", "the menu bar, and one corner of your screen"),
          ("Setup", "about five minutes, once"),
          ("His face follows", "the Claude 5-hour window only")],
    footer="Walder handbook · built from the shipped sprite sheet and behaviour code, v0.2.1 · "
           "sprites are Victor's own illustrations, used 1:1",
)

# ---------------------------------------------------------------- A. setting up
hb.phase("Before he can tell you anything", "Five minutes, once")

hb.step("Know what you are installing", [
    W.boot(),
    "Walder is a small pixel-art dachshund who sits on top of your desktop and watches how much "
    "of your **Claude** and **ChatGPT** allowances you have left. He is not a window and not an "
    "app you switch to.",
    "There is **no window**, **no Dock icon** and **no settings screen**. Two things exist: a "
    "**bone icon** in the menu bar, which is the entire app, and the dog himself, who starts in "
    "the bottom-right corner of your main screen.",
    note("He talks to `claude.ai`, `api.anthropic.com` and `chatgpt.com`, and nowhere else. No "
         "analytics, no account, no server. Logins are read at the moment of a check, held in "
         "memory, and never written to disk or into the log."),
])

hb.step("Get past the security warning (Mac)", [
    "Open the `.dmg`, drag **Walder.app** into **Applications**, then double-click it. "
    "**macOS will refuse to open it** — that is expected, and it is not a sign of a broken build.",
    "Go to **System Settings ▸ Privacy & Security**, scroll to the message about Walder being "
    "blocked, and click **Open Anyway**. Confirm with your password or Touch ID.",
    check("On **macOS 15 and newer, right-click ▸ Open no longer works** — it gives you the same "
          "refusal as a double-click. **Open Anyway** in System Settings is the only route that "
          "works on every version. Walder is unsigned (no Apple developer certificate), so macOS "
          "cannot check who made it. This is a one-time step."),
])

hb.step("If you are on Windows, expect to be the first", [
    "Run the `.exe`, click **More info** on the SmartScreen warning, then **Run anyway**. The "
    "installer asks where to put it and offers a desktop shortcut.",
    check("**No Walder developer has ever run the Windows build** — not the installer, not the "
          "tray icon, not the fullscreen detection. It is expected to work; nobody has watched it. "
          "If you are the first, please report what you actually see, including the parts that "
          "go fine."),
])

hb.step("Find him on first run", [
    "Nothing appears in the Dock or the taskbar. Look for the **bone icon** in the menu bar "
    "(Mac, top right) or the system tray (Windows, bottom right), and for **the dog** in the "
    "bottom-right of your main screen.",
    "He is drawn on a **72 × 72 grid** and shown at **Medium** by default — 144 screen pixels, "
    "which is the size the artwork was made for.",
    W.group("This is him doing nothing at all",
            "He holds one pose, still, and blinks every three to five seconds. No breathing "
            "cycle and no idle fidget — the owner asked for calm over motion. If this is what "
            "you see, nothing is wrong and nothing is happening.",
            [W.anim_card("idle", "always on",
                         "The base pose. On its own it never moves; the blink (next) is what "
                         "proves he is alive rather than a still picture.")]),
])

hb.step("Log in, or he cannot tell you anything", [
    "From the bone icon: **Accounts ▸ Claude ▸ Log in…**, and then **Accounts ▸ ChatGPT ▸ "
    "Log in…**. A normal login window opens on the real site; log in as you would in a browser. "
    "The window closes itself once the login has taken.",
    check("Until a Claude login exists, Walder shows the **confused** head-tilt with a `?` and "
          "nothing else. That face is honest, not broken — it means _\"I have no number for you\"_. "
          "He will never show a cheerful face on a number he does not have."),
    note("If you already use Claude Code or the Codex CLI on this machine, Walder can read those "
         "logins by itself and may show numbers before you log in to anything."),
])

hb.step("Optional: let Claude Code poke him", [
    "**Install Claude Code hooks…** in the menu — only if you use Claude Code in a terminal, and "
    "only if you want him to react to it. It asks first, names the file, writes three small "
    "entries into `~/.claude/settings.json`, and tells you what it did. Your original file is "
    "copied first, and **Remove Claude Code hooks…** undoes it.",
    "What you get: **ears up and a `woof`** when Claude Code finishes a reply, and a **head tilt "
    "with a `?`** when it is waiting for you.",
    note("The hooks send a tiny message to a listener that only accepts connections from your own "
         "machine, normally on port 47811. If Walder is not running, the entries do nothing and "
         "Claude Code carries on exactly as before."),
])

hb.step("Tick Launch at login", [
    "Last item of setup: **Launch at login** in the menu, so he comes back after a restart. "
    "The numbers then refresh by themselves about every three minutes, forever, with no further "
    "involvement from you.",
])

# ------------------------------------------------------------- B. reading him
hb.phase("Reading him at a glance", "The face, the barks, the bubbles")

hb.step("His face follows one number and one number only", [
    "That number is your **Claude 5-hour window** — the allowance that actually runs out in the "
    "middle of an afternoon. Not the weekly one, not ChatGPT, not an average of anything.",
    W.scale_bar(
        [(50, "#2C6E5B", "happy"), (30, "#4E8A6E", "neutral"),
         (15, "#9C7A17", "worried"), (5, "#9C4A17", "exhausted"), (12, "#5B2A2A", "out")],
        [(50, "0%"), (30, "50"), (15, "80"), (5, "95"), (12, "100% +")],
    ),
    "Everything else he can see — the 7-day window, the Opus and Fable rows, ChatGPT, Codex — "
    "still gets its own **barks** and still appears on the **hover card**. It just does not move "
    "his face.",
])

hb.step("The six faces", [
    W.faces([
        ("idle_happy", "under 50 %", "Happy", "The calm baseline pose — same drawing as plain "
                                              "idle, deliberately. Get on with your day.", True),
        ("idle_neutral", "50 – 79 %", "Neutral", "Also the calm baseline. Normal working state.",
         True),
        ("idle_worried", "80 – 94 %", "Worried", "Its own pose: ears down, one sweat bead. Start "
                                                 "thinking about what is left.", False),
        ("idle_exhausted", "95 – 99 %", "Exhausted", "Its own pose: tongue out, ears flat. "
                                                     "Almost gone.", False),
        ("out", "100 % or more", "Out", "Flat on the floor, X eyes, a breath puff on frame 2. "
                                       "The window is spent.", False),
        ("confused", "no number", "Confused", "Head cocked, `?`. Not logged in, login expired, or "
                                              "the site answered with something unreadable.", False),
    ]),
    note("**Happy and neutral share one drawing on purpose.** He holds one calm pose, blinking, "
         "for anything under 80 % — there is no separate grin for a barely-touched window, "
         "because a dog who visibly celebrates at 10 % and again at 79 % would be crying wolf. "
         "**Worried and exhausted are real, distinct poses** — each even blinks with its own "
         "face (a worried blink closes worried eyes, not neutral ones) — so from 80 % onward "
         "his mood is worth a glance, not just the hover card."),
])

hb.step("When he barks, and what the bark says", [
    "A bark is one **short animation plus a speech bubble**. It fires when a usage window crosses "
    "**80, 85, 90, 95 or 100 %** — **once per threshold per window**, so he does not nag. Every "
    "window he can see gets its own barks, not only the 5-hour one.",
    W.group("The bark", "Four frames, 400 ms. Frame 3 is mouth open with motion lines.",
            [W.anim_card("bark", "a threshold crossed",
                         "The bubble names the window and the **real** reading, not the threshold "
                         "that fired: cross 80 % at 87 % and it says <b>87% used</b>.")]),
    W.table(["The bubble reads", "Meaning"], [
        ["<span class='chip'>5-hour: 87% used</span>",
         "Your Claude 5-hour window. This is the one that drives his face."],
        ["<span class='chip'>7-day (all models): 91% used</span>",
         "The weekly pool, across every model."],
        ["<span class='chip'>7-day Fable: 91% used</span>",
         "Fable's own weekly number when Claude reports one; otherwise the same weekly pool "
         "shown under the Fable name, marked <i>(shared pool)</i>. Either way it never barks "
         "twice about the same number as the all-models row."],
        ["<span class='chip'>Codex 5-hour: 90% used</span>",
         "A ChatGPT / Codex window. Labels come straight from whatever the service reports, so a "
         "new window can appear without a new version of Walder."],
    ]),
    note("A bark stays until you **click him**. Nothing takes it away on a timer: Walder checks "
      "every three minutes, and a bubble that showed itself for twelve seconds of that was a "
      "warning you received only if you happened to be looking at the corner of the screen. If "
      "the same window climbs to the next threshold the bubble simply updates in place — an 80% "
      "bark becomes an 85% one. If a **different** window crosses while one is up, the second "
      "waits its turn, and one click at a time walks you through them."),
    "Two rows bark differently, because they have no threshold to cross: **Codex credits** and "
    "the capless side of **Extra usage** don't fire at 80/85/90/95/100 — instead each says its "
    "one thing exactly once, the moment it happens, and stays quiet until the provider clears "
    "the state:",
    W.table(["The bubble reads", "Fires when"], [
        ["<span class='chip'>Codex credits: none left</span>",
         "Your purchased Codex credit balance hits zero."],
        ["<span class='chip'>Extra usage: limit reached</span>",
         "claude.ai stops serving Extra usage — including on an account with **no monthly cap**, "
         "where no percentage ever crosses anything, so this is the only warning that row can "
         "ever give."],
    ]),
])

hb.step("The rows that are not percentages", [
    "Four more rows can appear on the hover card, below the usage windows. None of them move "
    "his face, and each behaves a little differently from a plain window.",
    W.table(["Row", "What it is"], [
        ["<b>Extra usage</b>", "claude.ai's pay-as-you-go spend once you have opted in: "
                               "<span class='chip'>$9.62 / $50.00 (19%)</span> against a cap, "
                               "or <span class='chip'>$9.62 spent</span> with none. Absent "
                               "entirely if you have never switched it on. Its countdown reads "
                               "<span class='chip'>resets in 19d 3h (est.)</span> — and the "
                               "<b>(est.)</b> is the point: claude.ai's response states a monthly "
                               "cap and a monthly spend and <i>no date at all</i>, so unlike every "
                               "other row on the card this horizon is Walder's arithmetic (the "
                               "first of the next calendar month) rather than a figure he was "
                               "given. If your billing anchor is your signup anniversary instead, "
                               "this one row will be a few days out — which is exactly why it is "
                               "the only line that admits where it came from."],
        ["<b>Codex credits</b>", "A purchased ChatGPT credit balance, if your account has one — "
                                 "<span class='chip'>2,733 credits</span>, no bar, because a "
                                 "balance has no denominator to be a fraction of. Absent on an "
                                 "account with no such pool."],
        ["<b>Codex credit limit</b>", "A different thing: Codex's own monthly <i>spend cap</i>, "
                                      "counted in credits. With a price set it converts to money — "
                                      "<span class='chip'>Est. $109.30 / $24.00 (455%)</span>, "
                                      "the <b>Est.</b> because it is a list price applied to a "
                                      "credit count, not your actual invoice. Without a price it "
                                      "shows the raw counts: <span class='chip'>2,733 / 600 "
                                      "credits (455%)</span>. The percentage is never capped at "
                                      "100 — blown through four times over reads as 455 %, "
                                      "honestly."],
        ["<b>Tokens today</b>", "A plain count, not an allowance: <span class='chip'>1.2M "
                                "tokens</span>, no bar, no reset time, never a bark. Read from "
                                "today's Claude Code and Codex CLI transcripts already on this "
                                "machine — nothing is sent anywhere for it. Present only for a "
                                "CLI you actually have and used today; absent, never a bare "
                                "<span class='chip'>0 tokens</span>, on a machine without it."],
    ]),
    note("The price behind <b>Est.</b> is a setting, `codexCreditPrice`, defaulting to OpenAI's "
         "own published $0.04 per credit. There is no menu for it yet — change it (a different "
         "amount, a different currency, or `null` to fall back to raw credit counts) by editing "
         "the settings file by hand."),
])

hb.step("The five things a bubble can be", [
    W.bubbles([
        ("5-hour: 87% used", "<b>A bark.</b> A real threshold crossing. Stays until you click "
                             "him. This is the only kind that carries a number."),
        ("woof", "<b>A perk.</b> Claude Code just finished a reply. Stays until you click him. "
                 "Only exists if you installed the hooks."),
        ("?", "<b>Waiting.</b> Claude Code wants something from you — a permission question, or "
              "an idle prompt. It goes when you type your next message, or when you click him."),
        ("…zzz", "<b>A sleepy mumble.</b> You petted him while he was curled up asleep. This is "
                 "the one bubble that still fades on its own, after about 1.5 seconds — a click "
                 "is what <i>makes</i> it, so a click cannot also take it away. He stays asleep. "
                 "It is an acknowledgement, not a message."),
    ]),
    W.bubbles([
        ("0.2.3 is out", "<b>An update notice.</b> A newer Walder exists. Once per version, and "
                         "it waits for a click like the rest — the three words are the whole "
                         "message; the actual <span class='chip'>Download…</span> link lives in "
                         "the menu, where you can read it at leisure."),
    ]),
    note("A bark outranks a `woof` and a `?`: if one arrives while either is up, the bark takes "
         "the screen and the `woof` is not re-queued afterwards. A `woof` that has already been "
         "seen has done its job; a warning shown after the fact is a warning shown too late. The "
         "update notice is the least urgent of the five — it queues behind everything else and a "
         "bark takes the screen from it too.\n\nBecause nothing expires any more, one thing "
         "follows that is worth knowing: with **Hide when idle** on, a bubble you have not "
         "clicked is exactly what keeps him on screen. He will not leave until you have dealt "
         "with it."),
])

hb.step("He gets out of the way for fullscreen video", [
    W.group("Curling up, and standing back up",
            "Two animations, and the size of the window changes with them: the curled pose has "
            "its own smaller 61 × 58 box, so a sleeping Walder is visibly a smaller dog.",
            [W.anim_card("sleep", "something went fullscreen",
                         "A slow three-second loop. Frame 3 carries the drawn <b>z z</b> — which "
                         "is why the app does not also print its own."),
             W.anim_card("wake", "fullscreen ended, or he has something to say",
                         "Curled, yawn, stretch, shake. Also plays when a bark needs saying while "
                         "he is asleep — he wakes up long enough to say it.")]),
    "It is **per screen**: a film on your second monitor does not put a dog sitting on the laptop "
    "screen to sleep. To switch it off, untick **Sleep during fullscreen video** — he then stays "
    "visible over everything.",
    check("On Windows this leans on a small PowerShell helper **nobody has ever watched run**. If "
          "he never sleeps there, that is the first thing to put in a report. There is also one "
          "accepted false positive on the Mac: **Dock hidden plus a maximised window** can read "
          "as fullscreen, and he will curl up when no video is playing."),
])

hb.step("Hiding him until he has something to say", [
    "**Hide when idle**, in the menu, is a stronger version of getting out of the way: with it "
    "on, Walder is not on screen at all unless he actually has something to tell you.",
    W.ladder([
        ("<b>Something to say → he appears.</b> A bark, a Claude Code perk or `?`, an update "
         "notice, or his face turning to <i>out</i> or <i>confused</i> — any of these brings "
         "him back, standing.", False),
        ("<b>Nothing to say → he lingers, then hides.</b> Once the last bubble clears he stays "
         "on screen a further eight seconds — long enough to look at him or pet him — then the "
         "window itself disappears.", False),
        ("<b>A pet resets the clock.</b> Petting him while he is lingering starts the eight "
         "seconds over, the same as anywhere else.", True),
    ]),
    note("Turning the mode on with nothing to say hides him **immediately** — flipping the "
         "checkbox is an action you took right now, not something that should wait eight "
         "seconds to take effect. Turning it off always shows him at once."),
    "Because the dog himself can vanish, the menu grows a line while the mode is on — "
    "<span class='chip'>Claude 5-hour: 87% used</span>, disabled, sitting above the separator — "
    "so the one number that matters is never more than a menu-bar click away.",
    check("A **global keyboard shortcut** toggles the mode without opening any menu at all — "
          "**Control+Command+W** on macOS, **Alt+Shift+W** on Windows and Linux by default. "
          "**Shortcut** in the menu offers seven other presets if the default is already taken "
          "by something else on your machine; whichever one is bound is shown, greyed out, next "
          "to **Hide when idle** itself. If a preset fails to register (another app already "
          "owns those keys), the setting is kept and the menu says so — nothing is silently "
          "reassigned to a combination you did not choose."),
])

hb.step("The two Claude Code reactions", [
    W.group("Only if you installed the hooks", "Both of these <b>hold their last frame</b> — the "
            "pose has to stay while the bubble that goes with it is still on screen.",
            [W.anim_card("perk", "claude code finished a reply",
                         "Resting, lifting, head high with ears flared — then it parks there for "
                         "as long as the <b>woof</b> is up, which is until you click him."),
             W.anim_card("tilt", "claude code is waiting for you",
                         "Head cocks over, and frame 3 carries the drawn <b>?</b>. It holds until "
                         "you type your next message or click him — there is no timer.")]),
    note("The held head-tilt is also exactly what the **confused** face is: the same last frame, "
         "looped on its own. Same picture, two different reasons — a `?` next to a dog means "
         "_\"something is waiting on you\"_ if you use Claude Code, and _\"I have no number\"_ if "
         "you have not logged in. The hover card tells the two apart in one glance."),
])

# ----------------------------------------------------- C. animation dictionary
hb.phase("The full animation dictionary", "All 24, grouped by what sets them off")

hb.step("Everything he can do, and who starts it", [
    "Every sprite below is the real artwork playing at its real tempo. **Click any of them to "
    "replay.** One-shots play once and park; loops keep going.",
    W.group("He does these by himself", "Idle life. Nothing is wrong and nothing is happening.", [
        W.anim_card("idle", "always on",
                    "The held pose. Everything else interrupts this and returns to it."),
        W.anim_card("blink", "every 3–5 seconds",
                    "Three frames, 249 ms — open, closed, open. Slipped in over the idle pose "
                    "on its own timer, so it never fights with anything else on screen."),
    ]),
    W.group("Your allowance drives these", "The three that carry information.", [
        W.anim_card("bark", "a window crossed 80/85/90/95/100 %",
                    "Once per threshold per window. The bubble beside it names which window."),
        W.anim_card("out", "the 5-hour window hit 100 %",
                    "A slow two-frame loop; frame 2 has a breath puff. Stays until the window "
                    "resets."),
        W.anim_card("confused", "no usage number available",
                    "One frame, held. Not logged in, login expired, or an unreadable answer. "
                    "Hover him — the card names the problem."),
    ]),
    W.group("You start these", "Clicking him is the only input he has.", [
        W.anim_card("pet", "you clicked him while he was standing",
                    "Six frames, 750 ms, <b>hearts from frame 3</b>. It also dismisses whatever "
                    "bubble is up, and quietly asks for a fresh usage check (at most once a "
                    "minute)."),
    ]),
    W.group("Getting out of the way", "Driven by whatever is fullscreen on his screen.", [
        W.anim_card("sleep", "fullscreen video started", "Small box, slow loop, drawn <b>z z</b>."),
        W.anim_card("wake", "fullscreen ended, or a bark arrived",
                    "Yawn, stretch, shake, back to standing."),
    ]),
    W.group("Drawn, validated, and never played",
            "These are in the sheet and pass every check, but <b>nothing in 0.2.1 triggers "
            "them</b>. You will only ever see them in the developer gallery. Not bugs — spare "
            "vocabulary, waiting for a reason to exist.", [
        W.anim_card("walk", "nothing", "A trot. He has no reason to walk anywhere yet.", True),
        W.anim_card("tail_wag", "nothing", "A wag on its own, separate from the pet.", True),
        W.anim_card("hop", "nothing",
                    "Five frames, airborne on frames 2 and 3 — the one animation that leaves "
                    "the ground line.", True),
    ]),
    note("Eight more entries exist that are not separate animations to learn: `idle_happy` and "
         "`idle_neutral` are the same frame as plain `idle`; `idle_worried` and `idle_exhausted` "
         "are their own poses (the previous step). Each of those four has its own blink entry "
         "too — `blink_happy` and `blink_neutral` reuse the plain `blink`, while "
         "`blink_worried` and `blink_exhausted` close a worried or exhausted eye rather than a "
         "neutral one, so a worried dog blinks worried."),
])

hb.step("The three decorations", [
    "Tiny one-frame sprites that live in their own small boxes. The interesting part is that "
    "**Victor drew them into the frames as well** — so the app deliberately suppresses its own "
    "copy wherever the art already shows one, rather than drawing two hearts or two question "
    "marks.",
    W.group("", "", [
        W.anim_card("heart", "baked into pet", "Already drawn from frame 3 of `pet`, which is over "
                    "in 750 ms — far too short to blink a second one on and off.", False, 4.0),
        W.anim_card("qmark", "baked into tilt and confused",
                    "The `?` you see on the head-tilt is the drawn one. The app's own would flash "
                    "on for two frames and vanish just as the drawn one arrived.", False, 4.0),
        W.anim_card("zz", "baked into sleep's last frame",
                    "Only frame 3 of `sleep` carries it — so the app is free to print `…zzz` over "
                    "the first two frames, and must not over the third.", False, 2.5),
    ]),
])

# ------------------------------------------------------------- D. living with him
hb.phase("Living with him", "Four gestures, three settings, one menu")

hb.step("The four things you can do to him", [
    W.table(["Do this", "You get"], [
        ["<b>Hover</b>", "After a moment, a card appears beside him: <b>every</b> percentage, how "
                         "long until each one resets, where each number came from, and how old it "
                         "is. This is the authoritative read — his face is only a summary."],
        ["<b>Click</b>", "He squeezes his eyes shut and a heart pops up. Also dismisses whatever "
                         "bubble is up, and asks for a fresh check (at most once a minute)."],
        ["<b>Drag</b>", "He follows the cursor and stays where you drop him. He will not let you "
                        "push him fully off the screen."],
        ["<b>Right-click</b>", "The menu opens — the same one as the bone icon."],
    ]),
    note("Clicks on the transparent space around him pass **straight through** to whatever is "
         "behind, so he never blocks anything he is not actually standing on."),
    note("**He automatically turns to face the middle of whichever screen he is on** — parked on "
         "the left half he faces right, and vice versa. There is no setting for it: drag him "
         "across the middle and he flips exactly once, near the centre, rather than fighting you "
         "over every pixel."),
])

hb.step("Size and coat", [
    "**Size**: Small, Medium or Large — one, two or three screen pixels per drawn pixel, so "
    "**72 px**, **144 px** or **216 px**.",
    check("**Medium is the default and the size the artwork is drawn for.** Large deliberately "
          "goes past it: at 3× the individual pixels start to show. Small is crisp and easy to "
          "lose behind a window. Asleep he is smaller again — 61 px wide at Small, 122 px at "
          "Medium."),
    "**Coat**: six to choose from. Golden is Walder himself.",
    W.coats([("golden", "Golden"), ("red", "Red"), ("cream", "Cream"),
             ("black-and-tan", "Black and tan"), ("chocolate", "Chocolate"),
             ("silver-dapple", "Silver dapple")]),
    "Both choices are remembered across restarts, along with his position and the last "
    "percentages he saw.",
])

hb.step("The hover card has its own size", [
    "**Card size**, right beside **Size** in the menu, is a separate choice — making the dog "
    "smaller does **not** shrink the card beside him.",
    W.table(["Size", "What you get"], [
        ["<b>Large</b> (default)", "A header with the age of the numbers, a source line per "
                                   "service, full rows with a 20-segment bar and a reset time. "
                                   "The layout every screenshot in this handbook shows."],
        ["<b>Medium</b>", "The same numbers with the scaffolding gone — no header, no source "
                          "lines. Bars and resets stay; a status note appears only when "
                          "something is actually wrong, and names the service (`Claude: login "
                          "needed`)."],
        ["<b>Small</b>", "One line per window and nothing else: "
                         "<span class='chip'>7-day (all models)  63%</span>. No bars, no "
                         "resets, no <i>(shared pool)</i> marker — for when you already know "
                         "what the rows mean and just want the numbers."],
    ]),
    note("Whatever the size, one rule holds: a card never presents stale data as current. Large "
         "says the age in its header; Medium and Small grow a small footer only when the "
         "numbers are stale or there has not been a check yet."),
])

hb.step("The menu, item by item", [
    W.table(["Menu item", "What it is for"], [
        ["<b>Accounts</b>", "Log in and out of Claude and ChatGPT. Each entry shows the last "
                            "check's result. Use <b>Log out</b> first if a login has gone stale — "
                            "it clears that service's whole stored session, not just cookies."],
        ["<b>Refresh now</b>", "Force a check. Will not run more than once a minute; the item "
                               "itself says how long to wait."],
        ["<b>Reset position</b>", "He jumps back to the bottom-right of your main screen. This is "
                                  "the fix for \"he is on a monitor I have unplugged\"."],
        ["<b>Size / Card size / Colour</b>", "As above — three independent choices."],
        ["<b>Launch at login</b>", "He comes back after a restart."],
        ["<b>Sleep during fullscreen video</b>", "On by default. Untick it and he stays visible "
                                                 "over everything — which also wakes him "
                                                 "immediately."],
        ["<b>Hide when idle</b>", "As above — hides him whenever he has nothing to say."],
        ["<b>Shortcut</b>", "The keys that toggle Hide when idle without opening the menu — "
                            "eight vetted presets, and a status line naming whichever one is "
                            "actually bound."],
        ["<b>Install / Remove Claude Code hooks…</b>", "Adds or strips the three entries in "
                                                       "<span class='chip'>~/.claude/settings.json</span>. "
                                                       "Both ask first and name the file; a dated "
                                                       "backup is saved either way."],
        ["<b>Update available: 0.2.2 — Download…</b>", "Only shown once a newer Walder actually "
                                                       "exists; otherwise the item reads "
                                                       "<b>Check for updates now</b>. Clicking "
                                                       "<b>Download…</b> opens the release page "
                                                       "in your browser — Walder never installs "
                                                       "anything by itself."],
        ["<b>Check for updates automatically</b>", "On by default: a quiet background check, "
                                                   "with its own cooldown so it never hammers "
                                                   "GitHub."],
        ["<b>Force interactive (debug)</b>", "Makes his whole square take clicks. Only for when "
                                             "clicks near him are going to the wrong place."],
        ["<b>Developer ▸ Verbose log</b>", "Turns on the detailed log, and prints the log file's "
                                           "real path underneath."],
        ["<b>Quit</b>", "He goes away until the next login."],
    ]),
])

# --------------------------------------------------------------- E. troubleshooting
hb.phase("When he looks wrong", "Read the card first, then the menu")

hb.step("Start with the hover card — it names the problem", [
    "Almost every confusing state has its explanation written on the card. Hover him before "
    "touching anything.",
    W.table(["The card says", "What to do"], [
        ["a login or auth line, e.g. <span class='chip'>auth-needed</span>",
         "<b>Accounts ▸ Log in…</b> for that service. If it was working yesterday, <b>Log out</b> "
         "first, then log in again."],
        ["<span class='chip'>endpoint-changed</span>",
         "The service moved something Walder reads. Nothing you can fix — and the other numbers "
         "still work."],
        ["<span class='chip'>rate-limited</span>",
         "You asked too often, or the service is throttling. It backs off and retries by itself."],
        ["the age line looks old, or <span class='chip'>not checked yet</span>",
         "<b>Refresh now</b>. Stale numbers are marked rather than hidden — they are still the "
         "best information there is."],
        ["a Fable row equal to the All-models row, marked <i>(shared pool)</i>",
         "Correct, not a bug. Claude has not reported a separate Fable number for your account, "
         "so Walder shows the shared weekly pool under the name you recognise instead of no row "
         "at all. If your account ever gets a real, separate Fable reading, that one is shown "
         "instead — automatically, with no <i>(shared pool)</i> tag — and it can bark on its "
         "own."],
    ]),
])

hb.step("The four everyday complaints", [
    W.table(["Symptom", "Fix"], [
        ["<b>He is confused and stays confused</b>",
         "No Claude login. <b>Accounts ▸ Claude ▸ Log in…</b>. He is being honest, not broken."],
        ["<b>I cannot find him</b>",
         "<b>Reset position</b>. He is probably on an unplugged monitor, or behind a window at the "
         "Small size."],
        ["<b>My clicks near him land in the wrong place</b>",
         "Tick <b>Force interactive (debug)</b>, do what you needed to do, untick it."],
        ["<b>His ears never go up when Claude Code finishes</b>",
         "Run <b>Install Claude Code hooks…</b> again — the port can change if something else "
         "took 47811 — then restart Claude Code."],
    ]),
    check("**He is asleep and there is no fullscreen video.** Untick <b>Sleep during fullscreen "
          "video</b>, which wakes him at once. Then say so in a report: the likely cause is the "
          "known false positive (Dock hidden plus a maximised window), and it is worth knowing "
          "how often it bites."),
])

hb.step("If it is something else, send the log", [
    "Tick **Developer ▸ Verbose log**, reproduce the problem, then send the file. Warnings are "
    "always written; the tick adds the detail. It rotates at 1 MB and keeps three files, so it "
    "cannot fill a disk.",
    W.table(["Platform", "Log file"], [
        ["Mac", "<span class='chip'>~/Library/Logs/walder/walder.log</span>"],
        ["Windows", "<span class='chip'>%APPDATA%\\walder\\logs\\walder.log</span> — untested; "
                    "trust the path the menu prints"],
    ]),
    note("**Logins and tokens are stripped** from anything written to that log — anything that "
         "looks like one is masked — so the file is safe to send as-is."),
])

# ------------------------------------------------------------------ F. appendix
hb.phase("Appendix: why he did that", "The arbitration rules, in one page")

hb.step("Who wins when several things happen at once", [
    "Several things compete for one small dog. This is the order they resolve in — it explains "
    "almost every odd moment you will see.",
    W.ladder([
        ("<b>A usage bark wins outright.</b> It takes the screen from a live <span class='chip'>"
         "woof</span> or head-tilt, and that one is <b>not</b> put back afterwards.", False),
        ("<b>A bark wakes him.</b> If a threshold is crossed while he is curled up asleep, he "
         "stands up, says it, and curls back down when the bubble clears.", False),
        ("<b>Claude Code events queue, and the newest wins.</b> At most one <span class='chip'>"
         "woof</span> and one <span class='chip'>?</span> are ever waiting, so a burst of replies "
         "cannot back up into a minute of bubbles.", False),
        ("<b>Fullscreen only takes effect once the screen is clear.</b> Starting a film while a "
         "bubble is up changes nothing until that bubble goes; then he curls up.", False),
        ("<b>Petting a sleeping dog does not wake him.</b> He mumbles <span class='chip'>…zzz"
         "</span> and stays curled — the one bubble that does not count as \"something to say\".",
         True),
        ("<b>The update notice waits for everything.</b> It is the least urgent bubble there is — "
         "queued behind a live <span class='chip'>woof</span> or <span class='chip'>?</span>, "
         "and cleared from the screen the instant a usage bark needs it.", True),
        ("<b>Hide when idle only brings him back for a reason.</b> A bark, a hook event, an "
         "update notice, or the face turning to <i>out</i>/<i>confused</i> — nothing else does, "
         "and with nothing left to say he lingers eight seconds, then hides again.", True),
        ("<b>His face changes silently.</b> A new percentage swaps the idle loop with no "
         "animation and no bubble, and the same face is never re-sent twice in a row.", True),
    ]),
    note("If you ever want to watch the whole vocabulary at once, a developer can run "
         "`npm run sprites` — the gallery that shows every animation at 4× with its frame count "
         "and durations, a coat switcher and a play-once button. It is how the artwork gets "
         "approved in the first place."),
])

hb.checklist([
    "The bone icon is in the menu bar, and the dog is on screen.",
    "**Accounts ▸ Claude** is logged in — he is not showing the confused head-tilt.",
    "**Accounts ▸ ChatGPT** is logged in, if you use it.",
    "Hovering him shows real percentages with reset times, and the age line is fresh.",
    "**Launch at login** is ticked.",
    "Hooks installed only if you use Claude Code — and his ears went up on the next reply.",
    "You know happy and neutral share one calm pose on purpose — worried, exhausted, out and "
    "confused are each their own, distinct face.",
])

full = hb.html()
local = os.path.join(REPO, "docs", "HANDBOOK.html")
with open(local, "w") as f:
    f.write(full)

# Artifact variant: the publisher supplies <!doctype>/<head>/<body>, so hand it
# the title, the font link, the styles and the body content only.
head = re.search(r"<title>.*?</style>", full, re.S).group(0)
body = re.search(r"<body>(.*)</body>", full, re.S).group(1)
fontlink = re.search(r'<link href="https://fonts\.googleapis[^>]*>', full).group(0)
art = f"{head.split('<title>')[0]}<title>Walder Field Guide</title>\n{fontlink}\n" + \
      head[head.index("<style>"):] + "\n" + body
# Body-only variant for publishing as an Artifact; derivable, so it is not kept
# in the repo.
art_path = os.path.join(tempfile.gettempdir(), "walder_handbook_artifact.html")
with open(art_path, "w") as f:
    f.write(art)

print("handbook:", os.path.getsize(local) // 1024, "KB ->", local)
print("artifact:", os.path.getsize(art_path) // 1024, "KB ->", art_path)
print("steps:", len(hb.steps) if hasattr(hb, "steps") else "?")

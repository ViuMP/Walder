# What the card shows

The full reference for what Walder puts on screen: his barks, every row of the
hover card, the sizes and colours, and when he sleeps or hides out of sight.
The short version is in the [README](../README.md).

## His barks and bubbles

**Barking.** When a usage window crosses 80, 85, 90, 95 or 100 %, he barks once
with a bubble like `Claude 5h: 87% used`. Once per threshold per window, so he
does not nag. Every window he can see gets its own barks, not only the 5-hour
one.

**Bark sound is optional.** Tray ▸ **Bark sound** is off by default. When on,
only a usage-threshold bark plays the short sound; hooks, waiting, sleep and
update bubbles remain silent.

**A bubble names the service; the hover card does not have to.** The card is a
table with a CLAUDE or CHATGPT heading over it, so its rows are `5-hour` and
`7-day (all models)`. A bubble is one line glanced at across the screen with no
heading and no neighbours, so it says `Claude 5h`, `Claude 7-day`,
`Fable weekly`, `Claude credits`, `Codex 5h`, `Codex weekly`, `Codex credits` —
the service first, and the word the card's layout was carrying dropped. If you
run Claude Code and Codex side by side, that is the difference between a warning
you can act on and one you have to go and look up. **The card's row labels are
unchanged.**

Every bark is the same shape — a name, a colon, a percentage — including the two
that are not thresholds: a Codex credit pool running dry and claude.ai refusing
further extra usage both read `…: 100% used`, because an empty pool and a hit cap
are 100 % by definition.

**Bubbles stay until you click him.** Every one of them — a bark, a `Claude
done`, a `Codex waiting`, the update notice. Nothing takes itself away on a timer. Walder polls every
three minutes and a bubble used to be up for twelve seconds of that, which meant
receiving a warning depended on happening to look at the corner of the screen at
the right moment; a warning you can miss by looking away is not a warning. The
one exception is the `…zzz` a pet earns from a sleeping dog, which fades on its
own because a click is what *makes* it.

Two things follow from that, and both are deliberate. A window that crosses a
*higher* threshold replaces its own bark in place — an 80 % bubble waiting to be
clicked becomes an 85 % one rather than letting 85 queue invisibly behind it. And
with **Hide when idle** on, an unclicked bubble is exactly what keeps him on
screen: he will not leave until you have dealt with it.

## What you can do to him

| Action | What happens |
| --- | --- |
| Hover | after a moment, a card appears beside him with every percentage, how long until each resets, where the numbers came from, and how old they are — at **Card size** Medium or Small it shows less of that, see below |
| Click | he squeezes his eyes shut and a heart pops up. Also dismisses whatever bubble is up |
| Drag | he follows the cursor. He will not let you push him fully off the screen |
| Right-click | the menu opens — the same one as the bone icon |

## The rows on the card

**What the card actually shows for Claude: your 5-hour window, your 7-day
window, a row per model your dashboard shows a separate weekly number for
(today that is **Fable**), and — only if your account has it switched on —
Extra usage. Nothing else Anthropic's response happens to contain.** The usage
endpoint hands back a great deal more, including internal, undocumented keys
that correspond to nothing on your dashboard, so the two halves of the response
are treated differently and on purpose:

- **The per-model rows come from the response's own list of them**, each
  carrying the display name claude.ai prints beside it. Those are shown
  whatever the model is called — if Anthropic adds a weekly row for a new model
  tomorrow, it appears on the card the same day, under the same name you read
  on the dashboard, with no Walder release needed.
- **A new *top-level* key is not picked up automatically.** Those arrive as
  bare identifiers with nothing to say whether they are an allowance at all,
  and Anthropic has shipped several that are not (`amber_ladder`,
  `nimbus_quill`, `seven_day_cowork`, `seven_day_omelette`,
  `seven_day_breakdown`). So a top-level key is shown only if Walder knows it
  by name; anything else is dropped and only shows up in the verbose log
  (Developer ▸ Verbose log) until a release adds it. That is deliberate rather
  than a gap: a keep-by-default rule is exactly what let `amber_ladder` sit on
  the card as a permanently-empty row until someone noticed it.

The **Fable** row is the dashboard's own per-model weekly row, read straight
from the response — Fable's own percentage, which is usually *not* the same as
7-day (all models). If your account reports no per-model row at all, Walder
falls back to showing the shared weekly pool again under that name, and the
card says "(shared pool)" so the two cannot be confused.

**Extra usage** is the money row: what you have spent this month, as
`$9.62 spent`. If you have set a monthly limit on claude.ai it becomes
`$9.62 / $50.00  (19%)` with a bar and the usual barks, because a spend
against a cap really is a percentage — and if you have not, there is no bar and
no percentage, because there is nothing to be close to. Either way Walder says
one thing if claude.ai reports that the limit has been reached, and says it
once. If you have not switched extra usage on, the row is simply absent —
never a `0%` one.

Its countdown reads **`resets in 19d 3h (est.)`**, and the `(est.)` is not
decoration. claude.ai's response states a monthly cap and a monthly spend and no
date whatsoever, so unlike every other row on the card this horizon is Walder's
arithmetic — the first of the next calendar month, UTC — rather than a figure
the provider gave him. If your billing anchor is your signup anniversary rather
than the calendar, this row will be a few days out and nothing else on the card
will be. That is exactly why it is the one line that admits where it came from.

**Tokens today** counts every token Claude Code and/or Codex has billed you
for today, since local midnight: input, cache writes, cache reads and output —
the same total the CLIs themselves report, not just what you typed. It comes
from the CLIs' own transcripts on your Mac (`~/.claude/projects` and
`~/.codex/sessions`), never from claude.ai or chatgpt.com — neither of those
endpoints reports a token count at all. No plan states a token allowance, so
there is nothing for the row to be a percentage of: no bar, and it never
barks. If a CLI is not installed, its row is simply absent — never `0 tokens`.

On the ChatGPT side, beside **Codex 5-hour** and **Codex weekly**, a **Codex
credits** row appears when your account has a credit pool *and the service says
something about it*: how many are left, `unlimited`, or that it has run out. It
has no bar, on purpose — the service says what is left but never what the pool
started at, and a bar would have to invent the missing half. When the service
only admits that a pool exists and will not say how much is in it (a common
answer), there is no row at all: a `?` under the credit limit row, which does
carry the number, was a line that said nothing. Walder says nothing about the
pool until it runs out, and then says it once.

**Codex credit limit** is the ChatGPT side's counterpart to Claude's Extra
usage: the monthly credit allowance your ChatGPT workspace sets for Codex. It
carries a bar (clamped full past 100%) and a reset line, because unlike Extra
usage this one does have a known billing anchor. Alongside the percentage —
`455%` on Victor's account, because the workspace can and does run past its
own limit — the row now shows a money figure the same way Extra usage does:
`Est. $109.30 / $24.00  (455%)`. That is 2,733 used against a 600 credit limit,
converted at a per-credit price, default `{ "amount": 0.04, "currency": "USD"
}` — OpenAI's own list price of $40 per 1,000 credits, hence the Est. prefix, since
OpenAI publishes no EUR price. To price it in EUR instead, hand-edit
`~/Library/Application Support/walder/walder.json` (no tray UI for this yet)
and relaunch:

```json
"codexCreditPrice": { "amount": 0.04, "currency": "EUR" }
```

Set it to `null` to drop the estimate and show plain credits instead:
`2,733 / 600 credits  (455%)`. An invalid value falls back to the default
price and leaves the rest of the settings file alone. If your account has no
spend limit set, the row is simply absent — never `0%`. This is a different
thing from the **Codex credits** row
above: that one is a *purchased* balance you buy down to zero, while the
credit limit is a workspace allowance measured as used-percent, and the two
can both be absent, both present, or either alone depending on how your
account is set up.

Under a **CURSOR** heading, three more rows, read from the Cursor editor's own
stored login (there is no Cursor login window — see
[Privacy](privacy.md#what-walder-reads)):

**Cursor plan** is your billing period: the percentage Cursor's dashboard calls
your total usage, with a reset line taken from the end of the billing cycle.

**Cursor Auto** is the Auto-model share of the same period, and it appears
**only when it is a different number from the plan row**. On a Free plan the
total can sit at 0 while Auto climbs, and those are genuinely two facts; on a
plan where Auto *is* all of your usage they are the same number twice, and the
second row would be noise with a reset time on it.

**Cursor on-demand** is your on-demand spend cap, and appears only when you
have one. It reads as a remaining balance — `1,550 left` — with no bar and no
reset line, for the same reason the Codex credits row has neither: it is topped
up by paying, not by a clock. It is deliberately *not* shown as an amount of
money: Cursor's response does not say whether the number is dollars, cents or
its own request credits, and a `$` in front of it would be an invention. If you
have no on-demand cap, the row is simply absent — never a `0%` one.

If Cursor answers with something Walder cannot read, the whole section says
"endpoint changed" rather than showing a confident `0 %`.

Under a **COPILOT** heading, up to three more rows, read with the token the
GitHub CLI already holds (there is no Copilot login window either — see
[Privacy](privacy.md#what-walder-reads)):

**Copilot premium** is your premium-interaction quota, the scarce one on every
Copilot plan, which is why it leads.

**Copilot chat** and **Copilot completions** are the other two quotas GitHub
reports. All three read as a used-percentage against the same reset date,
which is the one GitHub states for the account.

A row is left out when the quota does not apply to your account — an
entitlement of nought, or GitHub saying outright that there is no quota there.
On most paid plans chat and completions are unlimited, so the section is often
just the premium row. That is not Walder missing something: a bar against a
quota you do not have would be a fact about nothing.

If your GitHub account has no Copilot at all, the section says "GitHub Copilot
is not enabled on this account" rather than "endpoint changed" — GitHub answers
a plain 404 for that, and it is about the account, not about the endpoint. If
the GitHub CLI is simply logged out, it says to run `gh auth login`.

Clicks on the transparent space around him pass straight through to whatever is
behind, so he does not block anything he is not standing on.

## Sizes and colours

**Size** in the menu: **Small**, **Medium** or **Large** — one, two or three
screen pixels per drawn pixel. Walder is drawn on a 72 × 72 grid, so those are
**72 px**, **144 px** and **216 px** of screen.

**Medium is the default, and the size the artwork is drawn for.** 144 px is the
largest Walder was designed to be, and **Large deliberately goes past that**: it
is there for very high-resolution screens and for anyone who just wants a bigger
dog, but at 3x the individual pixels start to show and he takes up more of an
ordinary desktop than he was meant to. Small is the same drawing at one screen
pixel per drawn pixel — crisp, and easy to lose behind a window.

Asleep he is smaller still: the curled-up pose has its own 61 × 58 box, so the
sleeping dog is 61 px wide at Small and 122 px at Medium.

**Primary service** in the menu — **Claude** or **ChatGPT** — says which one you
actually live in. Its rows sit at the top of the hover card, and when several
windows cross a threshold in the same poll its bark is the one you see first;
the other waits for a click. It deliberately does **not** change the dog's face,
which always tracks the Claude 5-hour window — the face is the one thing on
screen at all times, and a setting that quietly re-pointed it would mean you
could no longer tell, from a worried dog alone, what he is worried about.

**Card size** in the menu — **Large**, **Medium** or **Small** — sizes the
*hover card*, and is a **separate setting from the dog's own Size**: a big dog
with a small card is a perfectly reasonable combination, and neither choice
moves the other.

| Card size | What is on it |
| --- | --- |
| **Large** (default) | everything: the WALDER header with how old the numbers are, a line per service saying which login answered, a status note when something is wrong, and per window a label, a percentage, a 20-segment bar and "resets in …" |
| **Medium** | the same numbers without the scaffolding: no header, no "via …" lines. Bars and resets stay. A status note appears only when something is actually wrong, and then it names the service — `Claude: login needed` |
| **Small** | one line per window, `7-day (all models)   63%`. No bars, no reset times, no header |

At Medium and Small a muted line appears at the bottom **only** when the numbers
are stale or have never been fetched — with no header, that is the only place
the age of the numbers can live, and Walder never shows numbers of unknown age
as though they were current.

**One thing Small leaves out on purpose:** the little `(shared pool)` note. The
"7-day Fable" row is the same weekly allowance as "7-day (all models)" under the
name you recognise, and on Large and Medium the note says so. On Small there is
no room, so two weekly rows can show the same percentage with nothing to explain
why — if that bothers you, use Medium.

**Show in overview** in the menu is a tick per row. Untick one and it is off the
hover card **at once** — the card redraws on the spot, not at the next poll —
and that row also **never barks** again. The two halves are the same setting: a
row that had gone quiet on the card and then announced itself anyway would be
the one exception nobody would think to look for. Tick it again and it comes
back where it was, without repeating the thresholds it already told you about.

**Untick every row a service has and the service disappears from the card** —
heading, "via …" line and all. It used to leave a CLAUDE heading over "no limits
reported", which is three lines to say nothing and one of them untrue: the login
is fine and the limits *were* reported, you just asked not to see them. A service
that genuinely reported no rows still says "no limits reported", because there
that line is the explanation rather than the noise.

Two things it deliberately does not do. It does not change the dog's **face**,
which goes on following the Claude 5-hour window whether or not that row is one
of the hidden ones — the same rule as Primary service, and for the same reason:
the face is the one thing on screen at all times. And it does not *lose* a pool
running out. If your Codex credits empty while that row is hidden, Walder notes
it quietly and stays quiet when you tick the row back on, rather than barking
`Codex credits: 100% used` about something that happened last Tuesday. Only the
pool refilling and emptying again is news.

The list holds every row Walder can name up front — Claude's above ChatGPT's —
**plus anything the last numbers carried that is not one of those**. The
services keep growing new rows (a per-model weekly window is the usual one), and
a row that can appear on the card has to be tickable, so an unrecognised one
shows up here under the name the card gave it.

**Colour** offers six coats: **Golden** (Walder himself), **Red**, **Cream**,
**Black and tan**, **Chocolate**, **Silver-dapple**. All three choices are
remembered.

## Fullscreen behaviour

When either Claude weekly pool reaches 90 % used, Walder lies down with his head up; at 95 %, he
rests his head on his paws. His face still follows the Claude 5-hour window.

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

## Hiding him until he has something to say

Tick **Hide when idle** in the menu and Walder is not on your screen at all
most of the time. He comes back for six things, and only these:

- a **bark** — you crossed 80, 85, 90, 95 or 100 % of a usage window;
- **Claude Code or Codex finished a reply** (`Claude done`, `Codex done`), if you
  installed that tool's hooks;
- **Claude Code or Codex is waiting for you** (`Claude waiting`, `Codex waiting`,
  and the `?` by his ear), likewise;
- your **Claude 5-hour window is used up** — the flat-out face, which has no
  bubble of its own;
- **Walder cannot read your usage any more** — the confused face, usually a
  login that has expired. He shows this once when it happens, not every few
  minutes;
- **a new version of Walder is out** — once per version.

Each time, he appears with a stretch, says his piece, and **stays for eight
seconds after the bubble goes away** before leaving again. Click him during
those eight seconds and they start over, so you can pet him or hover for the
full card without him disappearing mid-read.

While he is hidden there is nothing to hover over, so the menu shows the number
instead: **Claude 5-hour: 63% used**, right under his name at the top. That line
only appears while this mode is on.

Tick the item again — or press the shortcut — and he comes straight back.

**The keyboard shortcut.** The same thing as the checkbox, without opening the
menu:

- **Mac: ⌃⌘W** (Control-Command-W)
- **Windows: Alt+Shift+W**

The combination is shown next to **Hide when idle** in the menu, and
**Shortcut ▸** offers eight alternatives. Pick one there and it is remembered.

*On Windows, Alt+Shift is also Windows' own "switch keyboard language"
shortcut.* If you have more than one keyboard layout installed, choose
**Shift+F9** or **Ctrl+Shift+F12** from **Shortcut ▸** instead — both are free
on Windows and on the Mac.

If the menu says **⌃⌘W is already used by another app**, something else on your
machine got those keys first. Your choice is kept, so quitting that app makes it
work again; or pick a different one from **Shortcut ▸**. The checkbox always
works whatever the keys are doing.

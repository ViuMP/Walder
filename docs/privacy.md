# Privacy

The long version of the [README](../README.md)'s Privacy table: what Walder
reads, what he does on your behalf, what goes in the log, and every field a bug
report can carry.

## What Walder reads

Walder reads three things, all on your own machine:

- Your existing **Claude** login — the Claude Code login if you have one,
  otherwise a claude.ai browser session you create through **Accounts**.
- Your existing **ChatGPT** login — a chatgpt.com browser session, or the Codex
  CLI login if you have one.
- **Claude Code and Codex hook events**, if you installed those hooks. They
  arrive over a listener that accepts connections only from your own machine.

Where it talks: `claude.ai` and `api.anthropic.com`, and `chatgpt.com`. The
login windows will only ever navigate to those sites, their sign-in pages, and
the "continue with Google / Microsoft / Apple" providers.

There is one more, and it is not about your account: **once every six hours,
`api.github.com`**, to ask which version of Walder is the newest. That request
carries nothing about you — no login, no account, no machine name, not even
which of the two services you use — only "which is the latest Walder". Untick
**Check for updates automatically** in the menu and Walder never asks of its own
accord again. The one exception is you: **Check for updates now** still asks,
because you clicked it.

Nowhere else.

One thing Walder does on your behalf, and only when he has to: when your Claude
Code login is about to lapse and he has no other way to read your usage, he
starts `claude` in the background, once, with an empty prompt — so that Claude
Code renews its own login, the way it does every time you open it. No
conversation, no transcript, nothing saved. Walder never reads or sends your
refresh token, and he never does this more than once per expiry.

Logins and tokens are read at the moment a check is made and held in memory
only. They are never written to the settings file, never written to the log
(anything that looks like one is masked), and never sent anywhere except back to
the service they belong to. The settings file keeps your position per display,
his size, the card size, his colour, which service is primary, how often Walder
polls, the hook port it prefers and the one it actually got, launch at login,
sleep during fullscreen, hide when idle and its shortcut, whether the automatic
update check is on, the last version you were told about, the Codex credit
price, which rows you have hidden, the once-only flags for the first-run
introduction and the two hook offers, the last percentages (never a login), and
the request paths — path only, never a query string — that Walder watched go by
while you logged in, which it replays only to that same site.

No analytics. No telemetry. No account, no server of ours, nothing phoning home.

**Log out** under **Accounts** clears that service's whole stored session, not
only its cookies.

## What goes in the log

Logins and tokens are removed from anything written to the log file. Warnings
are always written; **Developer ▸ Verbose log** adds the detail. Where the file
is and how it rotates is in [Troubleshooting](troubleshooting.md).

## Reporting a bug

Menu ▸ **Report a bug…** opens a **draft** issue in your browser, on Walder's
public tracker, with the boring half already filled in. Three things are worth
knowing about it:

- **Nothing is sent until you press Submit on GitHub.** Walder has no server and
  does not post anything anywhere. The menu item opens a page; you read it, edit
  it, and send it — or close the tab, and nothing has happened.
- **You can see everything it says**, because it is in the page in front of you.
  The same block is also copied to your clipboard, so you can paste it if your
  browser loses it or you would rather file the report from another machine.
- **Please attach `walder.log`** — Menu ▸ **Developer ▸ Reveal log file** shows
  it in Finder, and you can drag it straight into the issue. If you can
  reproduce the problem, tick **Developer ▸ Verbose log** first, do it again, and
  send the file afterwards.

The report contains: Walder's version, your OS and its version, the processor
type, the Electron version, your screen sizes, your Walder settings (size, card
size, the two switches, which service is primary), what the last update check
found, whether Walder thought a fullscreen app was in front, and where the log
file is.

It does **not** contain your account, your email, any login or token, or any of
your usage numbers — there is no way for it to: the report can only carry the
fields listed above, and none of them is a percentage.

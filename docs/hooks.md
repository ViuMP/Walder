# Hooks

How the Claude Code and Codex hooks work, what they write, and how to take them
out. The short version is in the [README](../README.md).

## The Claude Code perk

If you use Claude Code in a terminal, Walder can react to it:

- **Claude Code finishes a reply** → his ears go up and he says `Claude done`.
- **Claude Code is waiting for you** (a permission question, or an idle prompt) →
  he tilts his head, shows a `?` by his ear and says `Claude waiting`, and holds
  it until you type your next message or click him.
- **A command you approved finishes running** (`PostToolUse`) → nothing of its
  own shows. It clears a held `?` for that tool before it is ever drawn, or
  cancels one already on screen — the one event that says "nobody is blocked
  on you", without being a prompt or a finished reply.

The bubbles name the tool because Codex can say the same things (below), and
"a reply is ready" is no use without "whose".

This needs **Install Claude Code hooks…** from the menu, once. It adds four
entries to `~/.claude/settings.json` that send a tiny message to Walder on your
own machine, and nothing else. If Walder is not running, the entries do nothing
and Claude Code carries on exactly as before.

That message goes to a listener which only accepts connections from your own
machine, normally on port 47811.

**A `?` or a `done` is not shown the instant it arrives — each is held for
three seconds first (0.2.7).** If the same tool contradicts it inside that
window — you type your next prompt, the turn ends (`Stop`), or a command you
approved finishes running (`PostToolUse`) — the held bubble is dropped
silently and you never see it. That is what stops a Codex approval check that
was never actually going to ask you anything from flashing a `?`, and what
stops several subagents finishing together from queueing a `done` for each
one. Anything still true three seconds later shows exactly as before; a real
approval prompt waits for you and so cannot be answered inside three seconds.

**And a perk you have plainly seen goes away on its own.** Typing your next
prompt clears that tool's `done`. Bringing the tool's own application to the
front — the same lookup that lets clicking the dog raise it — clears both its
`done` and its `?`. That second half is **Claude Code only**: a Codex session
carries no process id, so there is nothing for Walder to match against the
frontmost app, and only the prompt applies there.
It also rides on the same two-second frontmost-app poll as **Sleep during fullscreen video**: untick
that and Walder stops looking at which app is in front, so a `done` then clears only when you type.

**The menu says whether it is working.** A line above the two items reads one of
four things, and there is a line like it for Codex:

- **Claude Code hooks: installed (port 47811)** — healthy. The number is there
  so it can go straight into a bug report.
- **Claude Code hooks: not installed** — the common case, and the item directly
  below it is the fix.
- **Claude Code hooks: installed for port 47811, Walder is on 47812** — the
  hooks are real but post to a door that closed. The listener walks to the next
  port when something else already holds the preferred one, and hooks written
  before that launch still point at the old number.
- **Claude Code hooks: Walder's listener is not running** — said first even when
  the hooks are also missing, because installing them now would only write a
  hook pointing at nothing. A restart is usually all it takes.

**And he tells you himself, once per launch.** If the hooks are missing at
startup he says `Install Claude Code hooks` (`Install Codex hooks` for the
other); if they are installed for the wrong port he says `Reinstall Claude Code
hooks` / `Reinstall Codex hooks`. Once, not once per check — nothing about
either state changes until you act on it, and the menu line above is where to
look afterwards. On a machine that has the tool but no hooks yet he also offers
to install them at the first launch, and takes "Cancel" for an answer
permanently: the tray items stay, the dialog does not come back.

## The Codex perk

The same for Codex, from **Install Codex hooks…** in the menu:

- **Codex finishes a turn** → ears up, `Codex done`.
- **Codex asks to run a command or apply a patch** → head tilt, `?`, `Codex
  waiting`, until you answer or click him.
- **A command or patch you approved finishes running** (`PostToolUse`) →
  nothing of its own; it clears a held or shown `?`, the same as Claude
  Code's. This is 0.2.7's fix for Codex firing its approval event after an
  action or a subagent whether or not it is actually about to ask you
  anything — see the grace above.

It writes four entries into `~/.codex/hooks.json` — `Stop`,
`PermissionRequest`, `UserPromptSubmit` and `PostToolUse` — carrying the same
one-line `curl` as the Claude hooks plus a header that tells Walder which tool
is calling. A dated copy of the file is saved beside it first. Codex merges
every layer of its hook config, so whatever is already in that file (or in
`[hooks]` in `config.toml`) keeps working.

**Your `config.toml` is not touched at all.** Its `notify` key belongs to the
Codex desktop app, which rewrites that file itself; Walder stays out of it.

**One extra step, and Codex does nothing without it.** Codex only runs a hook
whose exact definition you have trusted once, and it skips an untrusted one
silently: open a terminal, run `codex`, type `/hooks`, and trust Walder's four
entries. Until then Codex stays silent. Walder will not record that trust for
you — it is your review of a command that will run on your machine, and forging
it would make the whole step meaningless. The install dialog says this too.

**One gap, and it is Codex's:** there is no Codex hook for a plan-mode question,
only for approval prompts. A Codex session parked on a question that is not an
approval goes unremarked, and no amount of guessing here would fix it honestly.


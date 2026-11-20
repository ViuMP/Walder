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

Claude Code needs nothing installed: Walder follows it through Claude Code's own
session files in `~/.claude/sessions`. **Hooks ▸ Install Claude Code hooks…** in
the bone menu adds four entries (`Stop`, `Notification`, `UserPromptSubmit`,
`PostToolUse`) to `~/.claude/settings.json` that deliver the same events as hooks,
beside that. If Walder is not running, the entries do nothing and Claude Code
carries on exactly as before. **Hooks ▸ Remove Claude Code hooks…** takes them out
again and leaves every other setting in the file alone. Its confirmation has **Cancel** as the
default button, so an accidental Return keeps the hooks. Install and remove both save a dated
copy of the file beside it first. From a terminal, `npm run install-hooks` does
the same (`-- --remove` to take them out, `-- --codex` for Codex, `-- --port <n>`
to override the port).

Each entry runs a one-line `curl` (a PowerShell call on Windows) that posts to a
listener which only accepts connections from your own machine, normally on port
47811 (**App ▸ Hook port** in the Walder window; after changing it, restart
Walder and install the hooks again). The hook forwards the tool's whole hook payload (prompt, tool input and
output, cwd, transcript path) to `127.0.0.1:<port>`. Walder uses three fields of
it (the event, the session id and the folder). Nothing of the payload goes to
the settings file; with Verbose log on, the log gets the payload's key names
and, for Codex, three short enum values (event name, permission mode,
approve/deny decision), never a path, prompt or tool output. Anything else
holding that port while Walder is quit, or after beating it to the port, would
receive the payload, which matters only on a machine with other local accounts.
The POSIX command carries `--noproxy 127.0.0.1`, so an `http_proxy` or
`all_proxy` in your environment does not send the payload to your proxy. The
Windows command reads the payload from stdin as UTF-8 and posts it as UTF-8
bytes (`application/json; charset=utf-8`), whatever code page the console is
on; before 2026-11 it went through the console code page and out as Latin-1,
so a folder such as `…\Blåbær` showed on the SESSIONS line as `Bl?�b?�r`
(the event itself still arrived). An existing install keeps its old command until you
choose **Install … hooks…** again, and Codex then asks you to trust its four
entries again through `/hooks`.

**A `?` or a `done` is not shown the instant it arrives — each is held for
three seconds first (0.2.7).** If the same session of that tool contradicts it inside that
window — you type your next prompt, the turn ends (`Stop`), or a command you
approved finishes running (`PostToolUse`) — the held bubble is dropped
silently and you never see it. That is what stops a Codex approval check that
was never actually going to ask you anything from flashing a `?`, and what
stops several subagents finishing together from queueing a `done` for each
one. Anything still true three seconds later shows exactly as before; a real
approval prompt waits for you and so cannot be answered inside three seconds.

**And a perk you have plainly seen goes away on its own.** Typing your next
prompt clears that tool's `done`. Clicking the dog clears the `?` for both
Claude Code and Codex, and brings nothing to the front. Bringing the tool's own
application to the front yourself clears both its `done` and its `?`. That last
part is **Claude Code only**: a Codex session carries no process id, so there is
nothing for Walder to match against the frontmost app, and only the prompt and
the click apply there.
It also rides on the same two-second frontmost-app poll as **Sleep during fullscreen video**: untick
that and Walder stops looking at which app is in front, so a `done` then clears only when you type.

**The Hooks submenu says whether it is working.** A line above the install and
remove items reads one of five things, and there is a line like it for Codex:

- **Claude Code hooks: installed (port 47811)** — healthy. The number is there
  so it can go straight into a bug report.
- **Claude Code hooks: installed (port 47811), out of date** — the port is
  right, but the command (or the list of events) is one an older Walder wrote.
  The item below then reads **Update Claude Code hooks…** (**Update Codex
  hooks…**): the same install, which rewrites Walder's entries in place.
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
permanently: the Hooks items stay, the dialog does not come back.

**Out of date is said once per Walder version, not per launch.** Hooks that are
installed for the right port but in an older form still work, so after the
Walder update that made them stale he says `Update Claude Code hooks` (`Update
Codex hooks`) once, and not again for that version; only a later Walder that
still finds them out of date says it again. Updating them from the menu ends it.
It never stands in for one of the notices above: if either tool's hooks are
missing or on the wrong port, or nothing is listening, that is what he says.
With both tools out of date he names Claude Code first and Codex at the next
launch.

## The Codex perk

The same for Codex, from **Hooks ▸ Install Codex hooks…** in the bone menu (**Remove Codex hooks…**
beside it takes them out):

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


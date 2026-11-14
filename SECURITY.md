# Security

Walder is a desktop mascot, but it is not a toy target: to show how much of your
AI subscription is left it holds two live site sessions, reads the Claude Code
and Codex CLI logins, the Cursor editor's stored token and the GitHub CLI's
token, and listens on a local port. A bug in any of those is worth reporting privately
first, which is what this file is for.

## What Walder holds

| What | Where | Why it matters |
| --- | --- | --- |
| A **claude.ai** session | Walder's own Electron partition, created by **Accounts ▸ Claude ▸ Log in…** | A full browser session for the account, cookies and all |
| A **chatgpt.com** session | The same, its own Electron partition | As above, plus the short-lived token that site hands back |
| The **Claude Code** login token | The macOS keychain item `Claude Code-credentials`; `~/.claude/.credentials.json` elsewhere | Read at poll time, sent as a bearer token to `api.anthropic.com`, held in memory only |
| The **Codex CLI** login | `~/.codex/auth.json` | Read at poll time; the access token and account id go to `chatgpt.com` |
| The **Cursor** editor's token | The editor's own `state.vscdb`, opened read-only | Read at poll time; the bearer token goes to `api2.cursor.sh` and nowhere else |
| The **GitHub CLI's** token, for Copilot | `gh auth token` | Read at poll time; it goes to `api.github.com/copilot_internal/user` and nowhere else |
| **Antigravity's** local CSRF token, for Gemini | The `--csrf_token` argument of the IDE's language server process | Read at poll time; the request goes to `127.0.0.1` only |
| A **loopback HTTP listener** | `127.0.0.1`, port 47811 by default (it walks to +1 or +2 if that one is taken) | The only inbound network surface in the app — see [`src/main/hook-server.ts`](src/main/hook-server.ts) |

The listener is deliberately narrow, and the narrowing is the security story:
one path and one method (`POST /event`), one media type, a 1 MiB body cap (past it
only the head is read, for the event name, `session_id` and `cwd`), a 2 s
socket timeout, no `Origin` header accepted and a `Host` that must be loopback —
those last two are what stop a web page the owner happens to have open from
driving the mascot. The only effect a request can have is one of four fixed
event kinds (done, waiting, prompt, resume) plus two strings of at most 1,024
characters, the session's folder, shown on the hover card's SESSIONS list, and
its id, kept in memory only to tell sessions apart (the row's key, and whose
`?` a later event clears); neither is logged. Bodies are never logged.

What the hook sends is wider than what Walder keeps. The hook command forwards
the tool's whole hook payload (prompt, tool input and output, cwd, transcript
path) to `127.0.0.1:<port>`, and Walder uses three fields of it (the event,
the session id and the folder). Nothing of the payload goes to the settings
file; with Verbose log on, the log gets the payload's key names and, for Codex,
three short enum values (event name, permission mode, approve/deny decision),
never a path, prompt or tool output. Nothing lets the hook check who is
listening, so anything else holding that port while Walder is quit, or after beating it to the port,
receives the payload. That matters only on a machine with other local accounts.

## What Walder never does

There is no server of ours, no analytics and no telemetry, and nothing leaves
the machine of Walder's own accord except the usage requests to the hosts
listed in the README's Privacy section and a version check against
`api.github.com` every six hours that carries nothing about you. Tokens are
never written to the settings file and never written to the log. The full
per-source table — what is read, where, how, and what is never done with it — is
in the README's [Privacy](README.md#privacy) section, with the long version in
[`docs/privacy.md`](docs/privacy.md).

If you find that any row of that table is untrue, that is a security report.

## Reporting privately

**Do not open a public issue for a vulnerability.** Use GitHub's private
vulnerability reporting, which opens a draft advisory only you and the
maintainer can read:

- <https://github.com/ViuMP/Walder/security/advisories/new>

That is the one route, and it reaches the maintainer. (Until 0.2.8 the source
was private and reports went through the separate `walder-releases` repository;
that repository is archived now.) There is no security email address — rather than invent one that nobody watches, this
is the only route.

### What to include

- Walder's version and your OS (menu ▸ **Report a bug…** copies both to the clipboard).
- What an attacker would need to already have: a local account, a web page the
  owner has open, a file they can write, a network position.
- The steps, in enough detail to reproduce it.
- What you think the impact is. A guess is useful; a missing one is not a
  reason to wait.

If you attach a log, read it first. Walder masks anything that looks like a
login or a token, but the masking recognises shapes, and a shape it has not seen
is a shape it does not mask.

### What to expect

One person, in his own time, doing this as well as he can. He will acknowledge
your report within a week. If something is wrong he will fix it and credit you
in the release notes unless you would rather he did not; if he disagrees that it
is a bug he will say so and why, rather than letting the report go quiet.

Please give him a chance to ship a fix before you publish.

## Already known

Two things are known, decided and written down, so they are not findings:

- **Walder is ad-hoc signed on macOS and unsigned on Windows.** There is no
  Apple developer certificate and no Windows code-signing certificate, and
  ad-hoc signing confers no trust. The reasoning is in the `//no-signing` note
  in [`package.json`](package.json).
- **There is no auto-update.** Walder tells you a new version exists and opens
  the download page; nothing installs itself. That waits on a signed build.

# Security

Walder is a desktop mascot, but it is not a toy target: to show how much of your
AI subscription is left it holds two live site sessions, reads two CLI logins,
and listens on a local port. A bug in any of those is worth reporting privately
first, which is what this file is for.

## What Walder holds

| What | Where | Why it matters |
| --- | --- | --- |
| A **claude.ai** session | Walder's own Electron partition, created by **Accounts ▸ Claude ▸ Log in…** | A full browser session for the account, cookies and all |
| A **chatgpt.com** session | The same, its own Electron partition | As above, plus the short-lived token that site hands back |
| The **Claude Code** login token | The macOS keychain item `Claude Code-credentials`; `~/.claude/.credentials.json` elsewhere | Read at poll time, sent as a bearer token to `api.anthropic.com`, held in memory only |
| The **Codex CLI** login | `~/.codex/auth.json` | Read at poll time; the access token and account id go to `chatgpt.com` |
| A **loopback HTTP listener** | `127.0.0.1`, port 47811 by default (it walks to +1 or +2 if that one is taken) | The only inbound network surface in the app — see [`src/main/hook-server.ts`](src/main/hook-server.ts) |

The listener is deliberately narrow, and the narrowing is the security story:
one path and one method (`POST /event`), one media type, an 8 KB body cap, a 2 s
socket timeout, no `Origin` header accepted and a `Host` that must be loopback —
those last two are what stop a web page the owner happens to have open from
driving the mascot. The only effect a request can have is one of three fixed
enum values. Bodies are never logged.

## What Walder never does

There is no server of ours, no analytics and no telemetry, and nothing leaves
the machine of Walder's own accord except a version check against
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

- <https://github.com/ViuMP/walder-releases/security/advisories/new> — the
  public repository the app itself links to;
- <https://github.com/ViuMP/Walder/security/advisories/new> — the source
  repository, if that is where you found it.

Either is fine; they reach the same person. There is no security email address —
rather than invent one that nobody watches, this is the only route.

### What to include

- Walder's version and your OS (the menu's bottom item says the version).
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

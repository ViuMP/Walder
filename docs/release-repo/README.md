# Files for `ViuMP/walder-releases`

These two files belong to the **public releases repository**, not to this one.
They are drafted and reviewed here because the wording has to match what the app
itself writes — `src/core/bug-report.ts` prefills the form's boxes by their
`id`, and an id that drifts drops that box's contents with no error anywhere —
and because a template nobody read is how a tracker fills up with unanswerable
reports.

Nothing here is installed by any script in this repo. The commands below are for
Victor to run; they are outward actions on a public repository, so no agent runs
them.

## Where they go

| File here | Path in `walder-releases` |
| --- | --- |
| `ISSUE_TEMPLATE/bug_report.yml` | `.github/ISSUE_TEMPLATE/bug_report.yml` |
| `ISSUE_TEMPLATE/config.yml` | `.github/ISSUE_TEMPLATE/config.yml` |

`bug_report.yml` is a GitHub **issue form**, not the Markdown template it used
to be: a form can mark the version, the OS and the chip required, and a Markdown
template can only ask. If a `bug_report.md` is already on the releases
repository from an earlier push, delete it in the same commit — GitHub will
otherwise offer both, and the Markdown one is the one that produces reports
nobody can diagnose. The command below does that.

## Issues must be enabled first

The releases repository holds nothing but installers and has **Issues switched
off**. Tray ▸ *Report a bug…* opens `https://github.com/ViuMP/walder-releases/
issues/new`, which on a repository with Issues disabled is a 404 — the owner
would click the menu item and get a page saying the app does not exist. So this
step is not optional and is not second: **turn Issues on before shipping the
menu item.**

In the web UI: **Settings ▸ General ▸ Features ▸ Issues**. Or:

```sh
gh api -X PATCH repos/ViuMP/walder-releases -f has_issues=true
```

## Enable private vulnerability reporting

`SECURITY.md` tells anyone who finds a vulnerability to open a **draft
advisory** rather than a public issue, and gives two links — one per repository.
Private vulnerability reporting is a repository *setting*, and it is off by
default: until it is on, both links are 404s and the only route left to a
reporter is the public tracker, which is the one place a vulnerability must not
be written down first.

In the web UI, on each repository: **Settings ▸ Code security ▸ Private
vulnerability reporting ▸ Enable**. Or:

```sh
gh api -X PUT repos/ViuMP/walder-releases/private-vulnerability-reporting
gh api -X PUT repos/ViuMP/Walder/private-vulnerability-reporting
```

Both, not one: the app links reporters at `walder-releases`, and `SECURITY.md`
itself is served from `ViuMP/Walder`, so that is where a reader of the source
will look for the button.

## Pushing the template

From a clone of the releases repository:

```sh
gh repo clone ViuMP/walder-releases
cd walder-releases
mkdir -p .github/ISSUE_TEMPLATE
cp /path/to/Walder/docs/release-repo/ISSUE_TEMPLATE/bug_report.yml .github/ISSUE_TEMPLATE/
cp /path/to/Walder/docs/release-repo/ISSUE_TEMPLATE/config.yml    .github/ISSUE_TEMPLATE/
git rm --ignore-unmatch .github/ISSUE_TEMPLATE/bug_report.md
git add .github/ISSUE_TEMPLATE
git commit -m "Bug report as an issue form, with required version, OS and chip"
git push
```

## Afterwards

Check both halves from a browser that is **not** signed in as the owner, since
that is what a reporter sees:

- `https://github.com/ViuMP/walder-releases/issues/new/choose` offers **Bug
  report** and nothing else — no "blank issue" link, and no second
  `bug_report.md` beside it;
- opening the form and pressing **Create** with the boxes empty is refused:
  version, OS and processor are required, which is the whole reason it is a
  form;
- Tray ▸ *Report a bug…* in a built Walder lands on that form with the version,
  the OS, the processor and the diagnostics already in their boxes, and with the
  same diagnostics block on the clipboard;
- `https://github.com/ViuMP/walder-releases/security/advisories/new` opens a
  draft advisory rather than a 404.

## Cutting a release

The publishing itself (`scripts/publish-release.ts`) is what talks to
`ViuMP/walder-releases`; this is the sequence around it, so the version bump,
the tag and the release notes cannot drift apart the way they have before.

```sh
npm version <patch|minor> -m "%s: <title>"
npm run dist:mac   # and/or: npm run dist:win
npm run release
```

`npm version` bumps `package.json`, commits that bump and tags it — atomically,
one command, so the tag can never point at a commit other than the one that
made it current. `%s` becomes the new version, so the commit and tag message
both read `0.2.6: <title>`, the one form every release from 0.2.2 on already
uses; do not also hand-write a bare `v0.2.6` commit or tag afterwards. Add
`docs/release-notes/<version>.md` (see the existing files for the `# Walder
<version>` heading `test/release-notes.test.ts` checks for) before or in the
same change as the version bump — `npm test` now fails once it isn't there.

### Two tags already point at the wrong commit

Checked against this repo's history: `v0.2.1` and `v0.2.4` were each pushed one
commit later than the commit that actually reads `0.2.1` / `0.2.4` in
`package.json` — most likely `git tag` run after an extra commit had already
landed, rather than right after the version bump.

| Tag | Points at | Should point at |
| --- | --- | --- |
| `v0.2.1` | `05e1ede` — "card: 'Est.' instead of '≈' …" | `c82f5ac` — "v0.2.1" (the version bump) |
| `v0.2.4` | `23515fa` — "docs: name the dialog macOS 15+ actually shows…" | `8d814c1` — "0.2.4: the security review's four corrections, and nothing else" |

Both tags are already published, and `walder-releases` already carries whatever
`gh release create` attached to them at the time — moving a tag is rewriting a
public reference other clones may have fetched, so this is Victor's call, not
something a script or an agent does on its own. The command, if he decides to
move one:

```sh
git tag -f v0.2.4 8d814c1 && git push -f origin v0.2.4
```

(and the same shape for `v0.2.1 c82f5ac` if he wants that one fixed too.) Not
run here.

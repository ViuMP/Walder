# Files for `ViuMP/walder-releases`

These two files belong to the **public releases repository**, not to this one.
They are drafted and reviewed here because the wording has to match what the app
itself writes — `src/core/bug-report.ts` produces the same four sections — and
because a template nobody read is how a tracker fills up with unanswerable
reports.

Nothing here is installed by any script in this repo. The commands below are for
Victor to run; they are outward actions on a public repository, so no agent runs
them.

## Where they go

| File here | Path in `walder-releases` |
| --- | --- |
| `ISSUE_TEMPLATE/bug_report.md` | `.github/ISSUE_TEMPLATE/bug_report.md` |
| `ISSUE_TEMPLATE/config.yml` | `.github/ISSUE_TEMPLATE/config.yml` |

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

## Pushing the template

From a clone of the releases repository:

```sh
gh repo clone ViuMP/walder-releases
cd walder-releases
mkdir -p .github/ISSUE_TEMPLATE
cp /path/to/Walder/docs/release-repo/ISSUE_TEMPLATE/bug_report.md .github/ISSUE_TEMPLATE/
cp /path/to/Walder/docs/release-repo/ISSUE_TEMPLATE/config.yml   .github/ISSUE_TEMPLATE/
git add .github/ISSUE_TEMPLATE
git commit -m "Add the bug report template"
git push
```

## Afterwards

Check both halves from a browser that is **not** signed in as the owner, since
that is what a reporter sees:

- `https://github.com/ViuMP/walder-releases/issues/new` opens the form with
  **Bug: ** already in the title;
- the "blank issue" link is absent;
- Tray ▸ *Report a bug…* in a built Walder lands on that form with the
  diagnostics already in the body, and with the same block on the clipboard.

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

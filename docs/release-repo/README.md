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

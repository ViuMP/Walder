# Releasing Walder

Releases, issues and security advisories all live on `ViuMP/Walder` since
0.2.8, when the source went public. The separate `ViuMP/walder-releases`
repository that used to hold them is archived: its releases were copied here,
and its final release (0.2.8) tells installs that still check it to look here.
The issue form it carried is now `.github/ISSUE_TEMPLATE/` in this repository.

## Cutting a release

The publishing itself (`scripts/publish-release.ts`) is what talks to
`ViuMP/Walder`; this is the sequence around it, so the version bump,
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

Both tags are already published, and their releases already carry whatever
`gh release create` attached to them at the time — moving a tag is rewriting a
public reference other clones may have fetched, so this is Victor's call, not
something a script or an agent does on its own. The command, if he decides to
move one:

```sh
git tag -f v0.2.4 8d814c1 && git push -f origin v0.2.4
```

(and the same shape for `v0.2.1 c82f5ac` if he wants that one fixed too.) Not
run here.

## Publishing the handbook on GitHub Pages

`npm run release` publishes `docs/HANDBOOK.html` as a release asset
(`Walder-<version>-HANDBOOK.html`), which is a download, not a page. Serving it
as an actual page needs a `gh-pages` branch on `Walder` and Pages
turned on for it — a one-time setup, plus a re-copy on every release since
nothing in `npm run release` does this step. Outward actions on a public
repository, so this is Victor's to run, not an agent's.

One-time setup, from a fresh clone of this repository:

```sh
gh repo clone ViuMP/Walder walder-pages
```

```sh
cd walder-pages
git checkout --orphan gh-pages
git rm -rf .
```

```sh
cp /path/to/Walder/docs/HANDBOOK.html index.html
```

```sh
git add index.html
git commit -m "gh-pages: the handbook as index.html"
git push origin gh-pages
```

Turn Pages on for that branch — Settings ▸ Pages ▸ Build and deployment ▸
Source: **Deploy from a branch**, Branch: **gh-pages** / `/(root)`, in the web
UI, or:

```sh
gh api -X POST repos/ViuMP/Walder/pages -f source[branch]=gh-pages -f source[path]=/
```

The handbook is then at `https://viump.github.io/Walder/`.

Per release, since the branch holds a copy and not a link: check out
`gh-pages` again, copy the freshly built `docs/HANDBOOK.html` over `index.html`,
commit and push. Doing this by hand every release is exactly the kind of step
that gets skipped one afternoon — a `publish-release.ts` follow-up that pushes
to `gh-pages` in the same run as the release itself would remove the
opportunity to forget it, and is worth doing once this manual version has been
run a few times.

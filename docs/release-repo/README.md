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
git push --follow-tags
npm run release
```

Push the tag before `npm run release`: the release is created with
`--verify-tag`, so it refuses a tag that GitHub does not have yet. It also
stops if `docs/HANDBOOK.html` is missing (rebuild it with
`python3 docs/handbook/build_walder.py`), and it uploads each installer a
second time under a version-less name (`Walder-mac-arm64.dmg`,
`Walder-mac-x64.dmg`, `Walder-win-x64.exe`), which is what the
`releases/latest/download/…` links in the root `README.md` and `INSTALL.md`
point at. (The bone menu's Download… opens the releases page, not a file.)

`npm version` bumps `package.json`, commits that bump and tags it — atomically,
one command, so the tag can never point at a commit other than the one that
made it current. `%s` becomes the new version, so the commit and tag message
both read `0.2.6: <title>`, the one form every release from 0.2.2 on already
uses; do not also hand-write a bare `v0.2.6` commit or tag afterwards. Add
`docs/release-notes/v<version>.md` (see the existing files for the format; the
`## v<version>: <headline>` first line is what `test/release-notes.test.ts`
checks for, and `npm run release` uses as the release title) and copy its text
into `CHANGELOG.md` before or in the same change as the version bump — `npm test`
now fails once either isn't there.

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

The handbook is at **https://viump.github.io/Walder/**, and it updates itself.
`.github/workflows/pages.yml` runs on every push to `main` that touches
`docs/handbook/`, `docs/HANDBOOK.html`, the art the handbook embeds
(`art/walder.json`, `art/render.mjs`, `art/refcells/`) or the workflow itself,
and on demand from the Actions tab. It renders the art, rebuilds the handbook,
checks the rebuild against the committed `docs/HANDBOOK.html`, and deploys the
committed file as `index.html` — the same file `npm run release` attaches to
the release as `Walder-<version>-HANDBOOK.html`.

So the one rule is: **change the handbook or the art, commit the rebuilt
`docs/HANDBOOK.html` with it.**

```sh
node art/render.mjs
python3 docs/handbook/build_walder.py
```

The CI check job runs the same comparison on every pull request, so a stale
copy fails the PR before it reaches `main`. If one gets there anyway, the Pages
run fails before deploying, the page keeps its last good copy, and the failure
says to rebuild. The check
(`docs/handbook/same_handbook.py`) compares every embedded PNG by its pixels,
not its compressed bytes, so a different Node or zlib on the runner is not a
difference.

One-time setup (Victor's, since it changes a public repository's settings), done
**before the branch that adds `pages.yml` (fixes-0.3.2) is merged to `main`**:
otherwise the first Pages run fails at `configure-pages` and the README link is
a 404 until it is done.
Settings ▸ Pages ▸ Build and deployment ▸ Source: **GitHub Actions**, or

```sh
gh api -X POST repos/ViuMP/Walder/pages -f build_type=workflow
```

After the merge, run the **Pages** workflow once from the Actions tab. There is no
`gh-pages` branch; the old manual one described here before was never set up.

# Contributing to Walder

Walder is one person's app with a public tracker, so this file exists to answer
the questions that would otherwise be answered twice: how to run it, what has to
pass before a change is a change, and which decisions are settled and not open
again.

Agents start at [`AGENTS.md`](AGENTS.md) instead — it is the short version of
this file plus the pointers into the roadmap and the build log.

## Setup

```sh
npm ci
npm run dev
```

Node 22.12 or newer (24 recommended); the floor is `engines.node` in
[`package.json`](package.json) and nothing here is tested below it. The install
also downloads the Electron runtime, about 130 MB, once.

`WALDER_LOG=1 npm run dev` turns on the diagnostics; add `WALDER_DEBUG=1` to
outline the clickable area in magenta.

## Checks

```sh
npm run typecheck && npm test && npm run build
```

That line is the gate, and `build` is in it on purpose: the renderer and the
main process are compiled separately, so a type error in one and a bad import in
the other are two different failures and only the build finds the second. Every
push runs `npm run typecheck && npm test` on GitHub Actions and builds an
unsigned installer per platform as a downloadable artifact
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

If you touched the artwork, the art checks are separate and also have to pass:

```sh
python3 art/strips.py --report && node art/render.mjs && npm run sprites
```

`npm run sprites` is not a test — it opens the gallery, and the artwork is
approved by eye, by Victor. See [`art/README.md`](art/README.md).

## The layout

```
src/core/       Pure TypeScript: no Electron, no network, fully unit-tested.
                buckets.ts / usage.ts    provider payloads -> the snapshot
                card-layout.ts           what the hover card says, per card size
                expression.ts            usage % -> which face to show
                nudge.ts                 when to bark, once per threshold
                behaviour.ts             arbitrates usage, hooks, clicks, fullscreen,
                                         and whether he is on screen at all
                bubble.ts                speech-bubble wording and wrapping
                shortcuts.ts             the vetted hide-shortcut presets and their labels
                semver.ts                version comparison for the update check
                update-check.ts          the update schedule, parsing and menu wording
                fullscreen.ts            is the active window fullscreen, per display
                hittest.ts / interaction.ts / geometry.ts   clicks, drag, clamping
src/main/       Electron main process: windows, tray, timers, poller, hook
                server, login windows, settings store.
src/providers/  The four usage sources and the chain that orders them.
src/preload/    The contextBridge seam between main and renderer.
src/renderer/   The overlay window, the hover panel, the sprite gallery.
src/sprites/    The sprite sheet the app draws (a validated copy of art/).
art/            The artwork and its generator. See art/README.md.
test/           Vitest suites, provider fixtures, the old M3 checklist.
docs/           BUILD_LOG.md (the stage-by-stage record), QA-CHECKLIST.md.
```

[`docs/QA-CHECKLIST.md`](docs/QA-CHECKLIST.md) is the manual checklist, and it
includes an honest list of what no human has ever verified.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Run the app in development, with hot reload |
| `npm run build` | Compile main, preload and renderer into `out/` |
| `npm run sprites` | Open the animation gallery: every animation of the loaded sheet at 4x with its name, frame count and frame durations, a palette switcher, a "play once" button for the one-shots, and a 1-px grid toggle. This is how the artwork gets approved |
| `npm run probe` | Ask every usage provider once, from the terminal, and print what each said |
| `npm run probe -- --keys` | Same, but prints only the key names of each usage payload, never the numbers — the fastest way to check what a provider's response actually contains before deciding whether a new key is a real window or noise |
| `npm test` / `npm run test:watch` | Run the unit tests |
| `npm run typecheck` | Type-check everything without emitting |
| `npm run dist:mac` / `dist:win` / `dist:all` | Build installers into `release/` |
| `npm run release` | Publish the installers in `release/` **and `docs/HANDBOOK.html`** (shown on the release page as `Walder-<version>-HANDBOOK.html`) to the public releases repo (`ViuMP/walder-releases`) with `gh`, which is where the app's update check looks. The handbook is required: a missing one stops the run and tells you to rebuild it with `python3 docs/handbook/build_walder.py`. Needs `gh auth login` once. `-- --dry-run` prints the command without publishing; `-- --clobber` replaces the files on an existing release |
| `npm run install-hooks` | Install the Claude Code hooks (`-- --remove` takes them out, `-- --codex` does the same for `~/.codex/hooks.json`) |
| `npm run sync:sheet` | Copy `art/walder.json` into the app after validating it (runs automatically before `dev`, `build` and `sprites`; a sheet that fails validation stops the build instead of reaching the app) |
| `npm run gen:tray` | Regenerate the tray icons (runs automatically before `dev` and `build`) |
| `npm run gen:icons` | Regenerate the app icons from the sprite (runs automatically before `dist:*`) |
| `npm run check:asar` | Open the packaged `app.asar` and check what went into it: no source, tests, artwork or config; every runtime dependency present; no native build tooling. Runs automatically after `dist:mac` and `dist:win` |

## Invariants

These are the hard rules from [`AGENTS.md`](AGENTS.md). Four of them now have a
test, which is the point: a rule nobody can break by accident is cheaper than a
rule everybody has to remember.

- **`src/core/` and `src/sprites/` stay Electron-free.** That is what keeps the
  tricky logic — threshold firing, window resets, tolerant payload parsing —
  testable in plain Node and therefore provable.
  [`test/core-boundary.test.ts`](test/core-boundary.test.ts) enforces it, and it
  rejects `node:*` imports too.
- **Never log usage payload values**, only key names.
  [`test/log-hygiene.test.ts`](test/log-hygiene.test.ts) enforces it.
- **Never refresh the Claude Code / Codex CLI tokens ourselves.** Renewal is
  delegated to the CLI: [`src/main/claude-renew.ts`](src/main/claude-renew.ts)
  spawns `claude -p` and never touches the token.
- **Never redraw, trace or patch sprite pixels.** Whole generated strips only —
  Victor's Firefly renders, or (since 2026-09-20, for the `lie` pose) GPT-image
  renders made by Codex — sliced 1:1 by `art/strips.py` and approved by Victor
  in `npm run sprites`.
- **Never release before all 20 strips are approved**, and the handbook content
  pass comes last.

Two more that are style rather than safety, and are the reason the files read
the way they do: long WHY comments, and no magic numbers.

## Binding rules (Victor's decisions — do not re-litigate)

1. **No release before all 20 planned visual slots are owner-approved** in `npm run sprites`. Victor
   approved the four current fallback slots on 2026-09-11; their absent v4 source PNGs are intentional.
2. **The handbook content pass comes LAST**, right before `npm run release` — never earlier (it would
   be redone once the art changes).
3. **Never redraw Walder by hand or trace him.** Every hand-drawn/traced sprite was rejected. The only
   accepted method is a whole generated strip — Victor's Firefly renders, or a GPT-image render Codex
   makes on his instruction (2026-09-20, the `lie` pose) — sliced 1:1 by `art/strips.py` and approved
   by Victor in `npm run sprites`.
4. Never refresh the Claude Code / Codex CLI tokens from Walder ourselves; Claude Code renewal is
   delegated to the CLI (src/main/claude-renew.ts spawns `claude -p` and never touches the token).
   Never log payload values, only key names.
5. `src/core/` and `src/sprites/` stay Electron-free; long WHY comments; no magic numbers.

## Process that has worked for this repo

Builder in a git worktree (`git worktree add ../Walder-<stage> -b <branch>`, symlink `node_modules`)
→ fresh reviewer → owner-side audit of the critical files → fix round → `git merge --no-ff` →
typecheck/vitest/build → push → remove worktree. Small verified steps; explain decisions to Victor in
plain language; ask before anything that changes the architecture.

## Commits and releases

One commit per change, with a message that says why. The history is read: the
reasoning for anything already built is indexed in
[`docs/DECISIONS.md`](docs/DECISIONS.md), and the stage-by-stage record is
[`docs/BUILD_LOG.md`](docs/BUILD_LOG.md).

Releases are cut with `npm version`, never with a hand-written bump plus a
separate `git tag` — that is how `v0.2.1` and `v0.2.4` ended up pointing at the
wrong commit. The sequence, and what to do about those two tags, is in
[`docs/release-repo/README.md`](docs/release-repo/README.md) under "Cutting a
release":

```sh
npm version <patch|minor> -m "%s: <title>"
npm run dist:mac   # and/or: npm run dist:win
npm run release
```

`docs/release-notes/<version>.md` has to exist before or in the same change as
the bump; `npm test` fails until it does.

## Adding a usage provider

A *provider* is one way to read one service's usage — a keychain token, a
browser session, a CLI login. A *service* is a member of `SERVICES` in
[`src/core/services.ts`](src/core/services.ts): `claude` or `chatgpt` today.

**A new service is the provider file plus four rows**: one entry in `SERVICES`,
one in `SERVICE_INFO` beside it (label, card heading, no-login remedy), one in
`LOGIN` in [`src/main/services-main.ts`](src/main/services-main.ts) (login URL,
origin, discovery store key, cookie partition, window title), and one chain in
`createChains`. `ServiceName` is derived from the tuple, so the compiler names
any row you forget; the poller, the snapshot, the tray and the card read the
list rather than the names. `test/poller.test.ts` drives the poller with an
invented third service to keep it that way. Everything below is the other
case: **another provider for a service Walder already knows**, which is one
new file and three edits.

### 1. Record the shape before writing anything

```sh
npm run probe -- --keys
```

`--keys` prints the top-level key names of each usage payload and never the
numbers. Do that before deciding whether a key is a real usage window or noise;
[`scripts/probe.ts`](scripts/probe.ts) is also where the answer goes once you
have it, because its provider list is hardcoded and nothing discovers a new one.

### 2. Write the provider

New file in [`src/providers/`](src/providers), next to its siblings. A provider
is a factory returning a plain object, not a class, and the interface it returns
is `UsageProvider` in [`src/providers/types.ts`](src/providers/types.ts):

```ts
export interface UsageProvider {
  readonly id: string;
  readonly service: ServiceName;
  readonly label: string;               // "Claude Code login", "chatgpt.com login"
  isAvailable(): Promise<boolean>;
  isAuthenticated?(): Promise<boolean>; // cookie-session providers only
  lastCheck?(): AuthCheck | null;
  fetch(now: Date): Promise<ProviderResult>;
}
```

Two members carry rules rather than behaviour:

- **`isAvailable` must be local and cheap** — does the keychain item exist, does
  the cookie jar hold a cookie. Never a network call, so that it cannot fail
  slowly. An absent login is not a failure; it is a skip.
- **define `isAuthenticated` only for a cookie-session login.** The registry
  finds the web provider by asking which one implements it, not by id, so a
  token provider that defines it would be handed the login window.

Take the dependencies as an interface — `http: HttpFetch`, the credential
reader, `onUnexpectedShape`, `onUsageKeys` — with real defaults, so a test can
pass fakes. `src/providers/chatgpt-codex.ts` is the shortest example to copy.

### 3. Return a `ProviderResult`, and never throw one

`ProviderResult` is one interface, not a union: `buckets`, a `status`, an
optional owner-facing `message`, and `via` (your provider's id). Two helpers in
`types.ts` do the work:

- `failure(via, status, message?, retryAfterMs?)` for every unhappy path.
- `classifyHttp(response)` maps a response to a `SourceStatus` and returns
  `null` when it looks usable: a redirect, a 404, a truncated body or HTML all
  become `endpoint-changed`, 401/403 becomes `auth-needed`, 429 becomes
  `rate-limited`. Use it rather than reading `status` codes yourself, so a new
  provider answers the same way the old ones do.

An empty parse is `endpoint-changed`, never a confident 0 %. A provider that
returned 0 % because the payload moved would put a calm face on an exhausted
account.

### 4. Return `Bucket[]` from a parser in `core/`

Parsing lives in [`src/core/buckets.ts`](src/core/buckets.ts), not in the
provider, because that is the file with no Electron in it and all the tests. A
parser returns `Bucket[]`: `pct` 0–100 or `null`, `resetsAt` an ISO 8601 string
or `null`, and an explicit `priority` — lower sorts first, and
`core/behaviour.ts` reads it directly. Reuse an existing parser if the payload
matches one; for an existing service it usually does.

Parsers must survive a field that is missing, renamed, extra or of the wrong
type by skipping it. Never throw.

### 5. Join a chain

[`src/main/provider-chains.ts`](src/main/provider-chains.ts), inside
`createChains`, is the only place a provider is registered — the chains are two
hand-written arrays. **Position is the behaviour:** `resolveService` in
[`src/providers/registry.ts`](src/providers/registry.ts) walks the chain,
skipping anything unavailable, returns the first result whose status is `ok`
without calling the rest, and otherwise returns the deepest available one. So
order the chain richest first. `claude` has the web provider ahead of the OAuth
one for exactly that reason: claude.ai carries rows the API route does not.

Hand it the right HTTP stack while you are there. A bearer-token provider gets
the cookie-less fetch; a cookie provider gets
`partitionSession(sessionFor(service))`, whose `'include'` credentials mode is
load-bearing.

### 6. Add it to the probe

[`scripts/probe.ts`](scripts/probe.ts), the `providers` array. It is hardcoded;
a provider that is not in it is a provider you cannot probe.

### 7. Test it

[`test/providers.test.ts`](test/providers.test.ts) has the fake every provider
is tested through:

```ts
function stub(routes: Record<string, HttpResponse | (() => HttpResponse)>): {
  http: HttpFetch;
  calls: Call[];
};
```

It answers per URL and records the headers and timeout it was asked with; an
unrouted URL throws, so a provider that hits an endpoint the test did not expect
fails loudly. `fakeSession()` wraps it for cookie providers, and `json`, `html`,
`status` and `fixture` build the responses.

Every provider gets the same five responses — valid, 401, 429, 404, HTML — plus
its own failure modes, the exact request headers, and an assertion that the
token never appears in the result. Payload fixtures go in `test/fixtures/`. If
you added a parser, extend [`test/buckets.test.ts`](test/buckets.test.ts); the
credentials mode and user agent of the stack you chose belong in
[`test/provider-chains.test.ts`](test/provider-chains.test.ts).

### 8. Then run it for real

```sh
npm run typecheck && npm test && npm run build
npm run probe
```

The suite says the provider is correct against the responses we imagined. The
probe says the service still answers the way we imagined.

## Reporting a security problem

Not here, and not in a public issue — [`SECURITY.md`](SECURITY.md).

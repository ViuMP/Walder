# Walder vs Codenotch — gap analysis and improvement plan

Date: 2026-09-19. Walder at 0.2.5 (`a7cb798`). Codenotch at `06aa05f` (v1.14.0, shallow clone of
https://github.com/vinzdg/codenotch).

Six independent audits were run in parallel (security of codenotch, test suites, CI/release,
architecture and providers, product/UX, docs and repo hygiene), then cross-compared. Every
recommendation below is an **idea to reimplement from scratch in TypeScript**. No codenotch code,
YAML, script text or prose is to be copied; the security section explains why that matters even
though the codebase is clean.

---

## 1. Summary

**Codenotch is clean.** No malicious code, no telemetry, no analytics, no obfuscation, no
credential sent anywhere but its own vendor, no checked-in executable other than the maintainer's
own notarized release DMG (Developer ID and Sparkle EdDSA signatures verified end to end). Nothing
dangerous can "follow over" if the *ideas* are rebuilt. There are things in it not to copy, listed
in §7.

**Where codenotch is ahead of Walder:** CI (four workflows; Walder has none), a real Windows build
pipeline with an install/run/uninstall smoke test, signed and notarized releases with a stable
download URL, self-update, 17 providers against Walder's 2, hook-free session detection
(working / done / waiting) read from Claude Code's own session registry, reset copy that degrades
to a weekday, Reduce Motion and Reduce Transparency support, 9 languages, a LICENSE, CONTRIBUTING,
issue and PR templates, and a subject-indexed decision log.

**Where Walder is ahead of codenotch:** the Electron-free core and a hermetic 1.6 s test suite
(1,779 tests, zero sleeps, zero network), fixtures on disk with provenance and length-padded
redaction, redaction tested in both directions, a 42-test update checker against codenotch's 3, a
packaged-artifact check (`check-asar`), a rotating redacted log file and one-click bug report
(codenotch has neither), a hardened loopback listener, per-display position memory, the no-TTL
bubble rule, hide-when-idle, the hook-install dialogs, and the honesty ledger of what nobody has
verified. Keep all of it (§6).

**The five things that should worry you most**, in order:

1. Walder has **no CI**. The suite is green and fast, and nothing runs it automatically.
2. The renderer trust boundary (`src/main/ipc-bridge.ts`, `src/preload/index.ts`) has **zero tests**.
3. A continuously animating mascot with **no reduced-motion path and no screen-reader text**.
4. There is **no LICENSE**, no download link in the README, and no picture of the dog.
5. Session state depends on hooks the owner has to install and (for Codex) trust by hand, while
   Claude Code already publishes `~/.claude/sessions/<pid>.json` with a `status` field that nobody
   has to install.

---

## 2. Security clearance of codenotch

Scope: all Swift sources (~64k LOC incl. vendored zstd), Sources/PhoneLink, Scripts, Makefile,
project.yml, Package.resolved, four workflows, the Rust/Tauri Windows port, `site/`, git history
for binaries, every dependency.

| Check | Result |
|---|---|
| Network destinations | ~30, every one the documented vendor endpoint or loopback. No telemetry host of any kind. |
| Process execution | 7 `Process()` sites in Swift, all absolute paths, argv arrays, no shell. No `NSTask`, `system()`, `dlopen`, `eval`. |
| Keychain writes | Two MiniMax items only; `…AfterFirstUnlock` rather than `…ThisDeviceOnly` (sloppy, not malicious). |
| File writes outside container | None. No LaunchAgent, no login-item plist. Launch at login is `SMAppService`, user-toggled. |
| Screen/clipboard/accessibility | No capture, no `AXUIElement`, no synthetic input. Two `NSPasteboard` *writes* (Copy link). |
| Obfuscation / blobs | Zero non-ASCII bytes in the 927 KB vendored zstd; verified as unmodified facebook/zstd 1.5.7 decode-only amalgamation. |
| Dependencies | 5 SwiftPM (Apple + Sparkle, pinned by revision); 545 Cargo lock entries all from crates.io; hook binary has zero deps. |
| CI secrets | None. Signing and notarization happen only on the maintainer's Mac. |
| Binaries in tree | One: the release DMG, signature-verified. |

**Real defects found** (relevant only as "do not copy"): a bypassable hand-rolled SVG sanitiser feeding
`innerHTML` with `csp: null` in the Windows port; job-wide `contents: write` on CI jobs that build PR
code plus one `${{ }}`-into-`run:` injection sink; unqualified `Command::new("cmd")` on Windows;
raw usage response bodies logged at `privacy: .public`; a stale v2 protocol doc that contradicts
the v3 code on every security point. Full list in §7.

---

## 3. Scoreboard

| Area | Leader | One line |
|---|---|---|
| Security posture of the code | Walder | Type-level redaction, hardened listener, CSP fails the build. Codenotch logs bodies publicly. |
| Test hermeticity and speed | Walder | 1.6 s, no sleeps, no network. Codenotch: ~4 s of `Task.sleep`, real panels, two tests disabled on CI by username sniffing. |
| Test coverage of trust boundaries | Codenotch | Walder's IPC bridge, preload, store persistence path and renderer are untested. |
| CI / release automation | Codenotch | Walder has no `.github/`. |
| Signing / notarization / update | Codenotch | Cost-gated ($99/yr). Walder's check-only updater is the right call *until* notarized. |
| Windows | Codenotch | A maintained port with a smoke test. Walder's has never been run by anyone. |
| Provider breadth | Codenotch | 17 vs 2. Walder's two-service union is hard-coded in 9 files. |
| Provider robustness | Mixed | Walder wins on 5xx backoff, jitter, HTTP bounds. Codenotch wins on Retry-After, persisted backoff, wake, reset-boundary polls. |
| Session state | Codenotch | Zero-install, per-provider, with liveness. Walder needs hooks and a manual trust step. |
| Product judgement | Walder | No-TTL bubbles, one bark grammar, hide-when-idle, fullscreen courtesy, hook dialogs. |
| Accessibility | Codenotch | Reduce Motion + Transparency honoured; Walder has nothing. Walder wins colour-blind safety by design. |
| Localization | Codenotch | 9 languages vs none. |
| Docs organisation | Codenotch | LICENSE, CONTRIBUTING, 3 issue forms, subject-indexed decisions, download-first README. |
| Docs writing and honesty | Walder | Gatekeeper walkthrough, unverified-capabilities ledger, `package.json` decision comments. |

---

## 4. Master roadmap

Deduplicated across all six audits. Each item names the files it touches and the test that proves
it. "Art" items need Firefly strips approved by Victor per AGENTS.md; nothing here redraws pixels.

### P0 — do these first

**P0-1 · CI.** One `.github/workflows/ci.yml`: `npm ci` → `npm run typecheck` → `npm test` on push
and PR, `ubuntu-latest`, `concurrency` with `cancel-in-progress`, `permissions: contents: read`,
`ELECTRON_SKIP_BINARY_DOWNLOAD=1` (verify locally that no test imports `electron` for real; the
`gen-icons` test needs `tsx`, which `npm ci` provides, and its `.icns` block self-gates off Linux).
Add a second job on `windows-latest` running `npm run dist:win` then `npm run check:asar`, uploading
`release/*.exe` as a per-commit artifact with `if-no-files-found: error`. This is the first time the
Windows installer will ever have been produced on Windows. Expect `scripts/gen-icons.ts` to need a
`process.platform !== 'darwin'` short-circuit around `iconutil`. Optional third job on `macos-latest`
for `dist:mac`; the `$TMPDIR` dance in `package.json` is harmless on a runner.
*Why P0:* the suite is hermetic, 1.6 s and green. Nothing runs it. Every other test item below is
worth less until this exists.

**P0-2 · Test the renderer trust boundary.** New `test/ipc-bridge.test.ts`: for each of the nine
guarded channels, invoke the captured handler with a foreign `event.sender` and assert it returns
without touching any dependency; assert `panel:size` rejects the overlay and vice versa; a destroyed
panel counts as absent; `unregisterIpc()` removes everything it added. New `test/preload.test.ts`:
`exposeInMainWorld` called once with the expected key; the exposed key set *equals* an explicit
list; no generic `invoke`/`send`; every `on*` returns an unsubscribe that calls `removeListener` with
the same reference. Faking: `vi.mock('electron')` with a recording `ipcMain`/`contextBridge`.
*Why P0:* `ipc-bridge.ts` states "only the app's own windows may drive the app" and nothing enforces
it but reading.

**P0-3 · Reduced motion and screen-reader text.** (a) Honour `prefers-reduced-motion: reduce` in
`src/renderer/overlay.ts`: pin every animation to its resting frame, make every `play` an instant
state change, still change expression (a different picture is not motion). Add a tray checkbox
"Still mode" backed by a `reduceMotion: 'auto'|'on'|'off'` store key. Put the schedule logic in
`src/core/anim-schedule.ts` so a unit test can assert still mode yields one frame and a null
deadline. (b) Give the canvas `role="img"` and an `aria-label` rebuilt on every scene change
("Walder, worried. Claude 5-hour 87% used."), put bubble text in an `aria-live="polite"` hidden span,
give hover-card rows `role="row"`. Build the sentence in a new pure `src/core/a11y-text.ts` and test
every expression × status. (c) Add a short `## Accessibility` README section in Walder's own voice
saying what is and is not supported.
*Why P0:* a looping animated overlay is the worst case for Reduce Motion, and the overlay currently
runs at full cadence even with `backgroundThrottling:false`.

**P0-4 · README front matter and LICENSE.** Add `LICENSE` (decide code licence and art licence
separately; `art/README.md` already claims the artwork). Add `## Get Walder` with the releases link
right after the intro, `## What you need` (macOS floor, **Apple Silicon only**, Windows untested)
so the Windows caveat lives in one place instead of four, and at least three images: banner, dog
with hover card open, the six-face strip. Fix the two README/code disagreements: six coats not five
(`silver-dapple` ships), and the Privacy section's "nothing else" list must name
`chatgptDiscoveredEndpoints` / `claudeDiscoveredEndpoints`.
*Why P0:* the README tells you to open a `.dmg` it never tells you how to get, and without a
licence the public releases are all-rights-reserved by accident.

**P0-5 · Hook-free session state from Claude Code's registry.** Verified live on this Mac:
`~/.claude/sessions/<pid>.json` carries `pid`, `procStart`, `cwd`, `sessionId`, `status`
(busy/waiting/idle), `statusUpdatedAt`. New pure `src/core/claude-sessions.ts`: given parsed
records and an is-alive predicate, emit `done`/`waiting`/`prompt` transitions; seed silently on the
first pass (no perk-storm at launch); drop a dead pid (`process.kill(pid,0)`) or a recycled one
(`procStart` parsed as UTC vs live start, 5-min tolerance); a vanished session is never announced.
Thin `src/main/claude-sessions.ts`: `fs.watch` on the directory, ~120 ms debounce, 2 s liveness
sweep, feeding `behaviour.onHook` with the existing `HookEvent` shape. Keep the hook server: it is
the only source of Codex events. Tests: reducer over fixture arrays (busy→idle = done,
busy→waiting = waiting, first pass = nothing, dead pid dropped, recycled pid dropped).
*Why P0:* a fresh install perks and tilts on day one with no install step, and the memory notes say
hooks were never installed on Victor's own Mac.

**P0-6 · "Waiting on you" outranks a bark and holds the pose.** Today a usage bark displaces a live
`waiting` and does not re-queue it (`src/core/behaviour.ts` ≈ lines 1035–1047). Invert that one
rule: `waiting` gets a held pose (sit up, face the cursor via `facing.ts`, `?` shown) and a bark
arriving meanwhile queues *behind* it. Keep per-source scoping. Add a 30-minute staleness so a
`waiting` from a closed terminal clears itself (mark the ceiling with a `ponytail:` comment; upgrade
path is the pid liveness from P0-5). Art: a `sit` pose slot in the expression cascade so strips can
land later; until then reuse the head-tilt frame. Test in `test/behaviour.test.ts`: waiting on
screen, then a crossing → bubble unchanged, bark queued; pet → bark promotes; clock past 30 min →
stands down.

**P0-7 · A first run that exists.** Three-beat bubble chain on first launch, each waiting for a pet
(which also teaches that clicking dismisses): "Hello. Click the bone in your menu bar." → if no login
found, "Accounts ▸ Claude ▸ Log in" with the confused face already showing → the existing hook offer.
Gate on an `introduced` store key written *before* the first bubble, same crash-safety as
`hooksOffered`. Strings in `src/core/bubble.ts` so they are pinned by tests.

### P1 — the trust and robustness gaps

**P1-1 · Real `electron-store` round-trip test.** `test/store.test.ts` currently mocks
`electron-store` to an empty class, so `SETTINGS_SCHEMA` and `clearInvalidConfig: true` never
execute. Instantiate the real store against `mkdtempSync` and assert: valid file round-trips; a
schema-invalid value wipes to `DEFAULTS`; a schema-valid but reader-invalid value (`cardSize:
"tiny"`) costs only that preference and keeps `positions`. Also add `schemaVersion: 1` now while it
is three lines.
*Done 2026-09-19:* `test/store-file.test.ts` opens the real `electron-store` via `createStore(cwd)`; `schemaVersion: 1` written.

**P1-2 · Retry-After and persisted backoff.** `HttpResponse` does not expose headers. Add
`retryAfterMs?` parsed in `fromFetch` (seconds or HTTP-date), carry it on `ProviderResult`, and let
`delayForStatus` take a server floor that may only *raise* the delay (Anthropic answers
`Retry-After: 0`; obeying it literally sustains the limit). Persist `{failures, nextDueAt}` per
service and restore in `poller.start()` so a relaunch mid-penalty waits. Tests: `Retry-After: 0`
does not shorten; `3600` beats the 15-min cap; unparseable falls back; past date never negative;
restored `nextDueAt` respected.
*Done 2026-09-19:* `parseRetryAfter` in `http.ts`, `retryAfterMs` on `HttpResponse`/`ProviderResult`, floor-only in `delayForStatus` (ceiling 6 h, `ponytail:` note), `pollSchedules` store key restored by `restoreSchedules`.

**P1-3 · Per-service `fetchedAt`.** `ServiceReport` has no timestamp, so a ChatGPT backed off to
15 min looks as fresh as a Claude polled 30 s ago. Add it to `ServiceReport` and
`PersistedServiceReport`, set in `pollOne`, mark stale per service on the card. Test: poll both,
advance past Claude's due only, assert ChatGPT's stamp did not move.
*Done 2026-09-19:* `ServiceReport.fetchedAt` stamped in `pollOne`, persisted, and a per-section `ago` line on the card that stays quiet when the whole card is stale.

**P1-4 · Wake and reset-boundary polls.** `powerMonitor.on('resume')` → `poller.pokeNow()`, which
marks both services due without consuming the 60 s manual cooldown (no `powerMonitor` exists in
`src/` today). Add pure `resetCrossed(buckets, since, now)` to `poll-schedule.ts` and treat a crossed
`resetsAt` as due even while backed off, so the face does not stay exhausted for up to 15 minutes
after the window rolls over. Tests for both.
*Done 2026-09-19:* `poller.pokeNow()` on `powerMonitor` `resume`; `resetCrossed` and `nextResetDelayMs` in `poll-schedule.ts` make a crossed `resetsAt` due and wake the timer at the boundary.

**P1-5 · Wedged-poll and late-answer tests.** A provider whose promise never settles is abandoned
after `RESOLVE_DEADLINE_MS` and the next tick runs; when it finally resolves, the older result does
not overwrite a newer snapshot; a service disabled mid-flight has its result discarded. Fake timers
plus a `new Promise(r => release = r)` provider.
*Done 2026-09-19:* late answer after the deadline cannot overwrite a newer snapshot; a tick that settles after `stop()` is discarded (`running` re-checked after the await). "Disabled mid-flight" has no counterpart in Walder beyond `stop()`.

**P1-6 · Timezone and clock-skew tests.** No test sets a non-UTC timezone. Add: a past `resetsAt`
renders "reset pending" not a negative; `fetchedAt` in the future clamps age to zero; identical
output under `TZ=UTC`, `Asia/Kolkata` (+05:30), `Pacific/Chatham` (+12:45), and across a
`America/New_York` DST boundary.
*Done 2026-09-19:* `test/timezone.test.ts` — four zones, the New York fall-back, past `resetsAt`, future `fetchedAt`. `process.env.TZ` switching works inside the vitest worker.

**P1-7 · Reset copy that degrades to a weekday.** `resets in 6d 4h` is unactionable. Ladder: under
an hour `47m`, under a day `3h 20m`, within the week `resets Thu 14:30`, beyond `resets 28 Sep`, via
`Intl.DateTimeFormat` with the locale the card already threads through. Tray radio "Reset times ▸
Countdown / Clock time". Test with a fixed locale.
*Done 2026-09-19:* `formatResetsIn` `clock` style (default) with the four-rung ladder; `Reset times ▸ Clock time / Countdown` in the tray, `resetStyle` store key, own IPC channel. September prints `Sept` on Node 24's ICU.

**P1-8 · Error copy that names the fix.** The tray already has "no Claude login yet — use Accounts ▸
Claude ▸ Log in…" (`src/providers/registry.ts`); route the provider `message` into the card's
compact status for `auth-needed`/`unavailable`, and give `endpoint-changed`/`error` a remedy clause.
One assertion per status × card size.
*Done 2026-09-19:* compact sizes carry the provider message for `auth-needed`/`unavailable`; `endpoint-changed`/`error` gained remedy clauses in `accountStatusLine`, shared with the tray.

**P1-9 · Notification fallback when the dog cannot be seen.** Only when hide-when-idle has him
hidden or he is curled up for fullscreen: post a native notification with the same one-shape text.
Off by default, one tray checkbox, permission requested lazily on first delivery, never at launch.
Test with a stub notifier: fires only in those two conditions, never twice per bark.
*Done 2026-09-19:* `src/core/notify.ts` gate + `notify` dep on `main/behaviour.ts`; tray checkbox "Notify when hidden", off by default; `Notification` built at delivery, never at launch.

**P1-10 · Stable download URL and release-notes gate.** In `scripts/publish-release.ts` upload each
installer a second time under a fixed label (`Walder-mac-arm64.dmg`) so
`releases/latest/download/…` never changes. Add a vitest asserting
`docs/release-notes/<package.json version>.md` exists and its H1 matches, so a bump without notes
fails the suite. Fix tag drift (`v0.2.1`, `v0.2.4` point at the wrong commits): use `npm version`
which commits and tags atomically, and pick one release-commit form (`0.2.6: <title>`).
*Done 2026-09-19:* `stableAssetName` and a second `--clobber` upload per installer in `publish-release.ts`; `test/release-notes.test.ts` gates a bump without notes; "Cutting a release" written; the two drifted tags each sit one commit after their bump — moving them is Victor's command, written not run.

**P1-11 · Contributor and reporter surface.** Create `CONTRIBUTING.md` by lifting `README.md`
"For developers" (scripts table, `src/` map, Electron-free invariant), `NEXT_STEPS.md` "Binding
rules" and "Process that has worked", and `AGENTS.md` checks; add an "adding a usage provider"
recipe. Create `SECURITY.md` (Walder holds two site sessions and runs a loopback listener; it needs
a private disclosure route). Push the two issue-template files to the release repo and enable
Issues; convert the bug template to a YAML form with required version/OS/chip fields that
`bug-report.ts` can prefill. Hand Victor the outward commands per `docs/release-repo/README.md`.
*Done 2026-09-19 (repo side):* `CONTRIBUTING.md`, `SECURITY.md`, `bug_report.yml` with required version/OS/chip, `bug-report.ts` prefills per field. Outward steps (Issues, private vulnerability reporting, pushing the form to `walder-releases`) are Victor's, listed in `docs/release-repo/README.md`.

**P1-12 · Split the README and index the decisions.** Move ~470 lines out: the card-row reference
(`amber_ladder`, `(est.)`, `codexCreditPrice` recipe) → `docs/what-the-card-shows.md`; hook internals
→ `docs/hooks.md`; bug-report field list and log redaction → `docs/privacy.md`; the "damaged"
dialog → `docs/troubleshooting.md`. Turn the Privacy prose into a per-source table
(`What Walder reads | Where | How | What he never does`). Create `docs/DECISIONS.md` as a
subject-indexed pointer table into `BUILD_LOG.md`, the `package.json` `//` keys and
`electron-builder.yml` — pure index, the content already exists. Re-date or retire
`docs/NEXT_STEPS.md`; `AGENTS.md` still sends every new agent to a handoff note about 0.2.0.
*Done 2026-09-19:* README 802 → ~280 lines; `docs/what-the-card-shows.md`, `hooks.md`, `privacy.md` (per-source table checked against the code), `troubleshooting.md`, `DECISIONS.md`; NEXT_STEPS retired; AGENTS points at §4 first.

**P1-13 · Three one-line hardenings.** `Cache-Control: no-cache` on every provider request (none
today; Chromium's `net.fetch` can serve a cached 200 and freeze the numbers with no error). A
`test/core-boundary.test.ts` asserting no file under `src/core` or `src/sprites` imports `electron`
or `node:`. A test that no `vlog`/`info`/`warn` call in `src/providers` or `src/main` passes a
response body. On `auth:logout`, clear that service's buckets from `lastSnapshot` so a logged-out
account's numbers do not reappear at next launch. One re-read-and-retry on a 401 before reporting
`auth-needed` (Claude Code files a new keychain item per rotation, and `security
find-generic-password` returns an arbitrary one).
*Done 2026-09-19:* all five — `Cache-Control: no-cache` in `fromFetch`; `test/core-boundary.test.ts`; `test/log-hygiene.test.ts` (string literals stripped, `topLevelKeys(json)` and `.length` allowed); `poller.forget(service)` on logout; one keychain re-read and retry on a 401 in `claude-oauth.ts`.

**P1-14 · Apple Developer ID and notarization** ($99/yr, the only thing that unlocks auto-update).
`hardenedRuntime: true`, `notarize: { teamId }`, drop `identity: "-"`, keep
`CSC_IDENTITY_AUTO_DISCOVERY=false` only on the unsigned local path, entitlements `allow-jit` and
`allow-unsigned-executable-memory`, no App Sandbox. Verify with `stapler validate`,
`codesign --verify --deep --strict`, `spctl --assess --type execute`. Keep the long
`electron-builder.yml` comment as history. Only after this: `electron-updater` against the release
repo and stop excluding `latest-mac.yml` from the upload.
*Prepared 2026-09-19, not exercised:* `electron-builder.signed.yml` (extends the default; Developer ID identity, hardened runtime, JIT entitlements, `notarize: true`), `npm run dist:mac:signed` + `check:signed`, `docs/signing.md`. Needs Victor's Apple Developer account and a certificate on this Mac; `security find-identity` finds none today. Auto-update waits for one verified signed release.

**P1-15 · A "Claude Code logged out" notice.** Found live on 2026-09-19: Claude Code had emptied
the keychain credential three days earlier (blank tokens, `expiresAt` 0, the refresh token gone)
and Walder reported plain `unavailable`, indistinguishable from never having logged in. Codenotch
treats it as its own state. In `readClaudeCodeCredentials` return a distinct result for "an item
exists but is emptied" (has `claudeAiOauth`, empty `accessToken`), surface it as a status the
card names ("Claude Code: logged out — run claude and log in"), and bark it once through the same
notice path as `HOOKS_MISSING_TEXT`. Not a renewal case: there is nothing to renew. Tests in
`test/credentials.test.ts` and `test/bubble.test.ts`.
*Done 2026-09-19:* `ExpiredCredentials.loggedOut`, `LOGGED_OUT_MESSAGE` as an `auth-needed`, `CLAUDE_LOGGED_OUT_TEXT` barked once per episode from `publishSnapshot`. Renewal untouched: `onExpiresAt(null)`.

**P1-16 · The Codex credit-limit estimate.** The card showed `Est. $109.30 / $48.00 (228%)` in
red on the owner's account. The percentage is real (the workspace runs past its cap), but the
money figure multiplies a credit count by a hard-coded list price and the row carries no hint of
that beyond `Est.`. Re-check the arithmetic against a fresh `npm run probe` capture, confirm the
`spend_control` semantics have not changed, and consider printing the credit count beside the
estimate so an owner can see what was multiplied. `src/core/usage.ts` money formatter and
`parseCodexSpendLimit` in `src/core/buckets.ts`.
*Done 2026-09-19:* re-checked against the live payload and the persisted row (2,733 / 1,200 credits × 0.04 USD = $109.30 / $48.00, 228 %); `spend_control` unchanged. The Large card now prints the credit counts inside the parenthesis.

### P2 — polish and breadth

**P2-1 · Break the two-service hard-coding before adding any provider.** `'claude' | 'chatgpt'`
is a literal union in 9 files with ~44 structural `.claude`/`.chatgpt` accesses. Adding Cursor is
ten edits, not one file. Make `ServiceName` a branded string, `ProviderChains` a record built from
an array, `UsageSnapshot.services` a `Record<string, ServiceReport>`, one exported `SERVICES`
constant. Keep `pctForFace` pinned to Claude's 5-hour window explicitly (product decision, not
coupling) and pin it by *id*, with a test for the key being renamed. Test with a fake third service
polling, backing off and persisting independently. If this is not worth doing, do not add a third
member to the union.
*Done 2026-09-20:* `SERVICES` const tuple in `src/core/services.ts` (closed, because the IPC validator and `noUncheckedIndexedAccess` want a known set), `ServiceMap`, `perService`, `SERVICE_INFO`; `ProviderChains` is a `ServiceMap` the poller reads its list from; the four main-side name tables collapsed into `LOGIN` (`services-main.ts`); `FACE_BUCKET_ID` pins the face by id with a test; a fake third service polls, backs off and persists in `test/poller.test.ts`.

**P2-2 · Providers, in this order, only after P2-1.** Cursor (borrows the editor's SQLite session
token sent as a *cookie*; on free plans `used`/`limit` are both zero and the real number is
`autoPercentUsed`; never offer a browser sign-in, it creates an empty second account). GitHub
Copilot (`gh auth token`, `copilot_internal/user`, skip `unlimited` and `entitlement == 0` rows).
Gemini/Antigravity last. Ollama and LM Studio are a different product and do not fit `Bucket`.
*Cursor, 2026-09-20:* provider written (`src/providers/cursor.ts`: the editor's `state.vscdb` token via `node:sqlite`, `POST GetCurrentPeriodUsage` on `api2.cursor.sh`, no browser login by design) and in the probe, not yet in `SERVICES`. Live `--keys` capture on Victor's Mac: `billingCycleStart/End` (string), `planUsage { autoPercentUsed, apiPercentUsed, totalPercentUsed, remainingBonus, bonusTooltip }`, `spendLimitUsage { pooledLimit, pooledRemaining, individualLimit, limitType, overallLimit, overallRemaining }`, `displayThreshold`, `displayMessage`, two `…DisplayMessage` strings, `autoBucketModels[]`. The public trackers' `planUsage.limit`/`totalSpend` and top-level percentages were NOT present — the parser follows this capture, not the docs. Copilot and Gemini still wait on their own captures.

**P2-3 · Weekly window as a second, non-facial cue.** The face stays on the 5-hour window (the
reasoning in `usage.ts` is right). Give the 7-day pool a posture channel (lying down above 90 %),
orthogonal to expression. Needs art.
*Needs art (2026-09-20):* `design/references/strips/v4/golden/lie.png` and `v4/dapple/lie.png` — 3 dogs each, 1376×768, lying down (head up / head lowered / eyes half-closed), no `z z`, per `docs/PROMPTS_V4.md` rules. Code (a `lie` box, posture from `CLAUDE_SEVEN_DAY_KEY` ≥ 90 %) follows the strips, not before.

**P2-4 · Bark presets.** Quiet (95, 100) / Normal (today's) / Chatty (every 10 %). `NudgeMachine`
already takes `levels`.
*Done 2026-09-20:* `BARK_PRESETS`/`BARK_LEVELS` in `nudge.ts`, `NudgeMachine.setLevels` keeps `lastFired` so a switch never re-barks, `barkPreset` store key, `Barks ▸ Quiet / Normal / Chatty` after Show in overview.

**P2-5 · One bark sound**, off by default, threshold barks only, via the renderer `Audio` element.
*Needs audio (2026-09-20):* `src/renderer/assets/bark.wav` — WAV PCM 16-bit mono 48 kHz, one bark ≤ 400 ms, peak ≤ −3 dBFS, no leading silence, ≤ 60 KB, with a provenance line for `art/README.md`. Code (`media-src 'self'`, `barkSound` off by default, played on `nudge` bubbles only) follows the file.

**P2-6 · String externalisation groundwork.** Move every user-facing literal into
`src/core/strings.ts` behind `t(key, params)` reading an English table; zero behaviour change,
snapshot test asserting byte-identical output. State "English only for now" in the README.
*Done 2026-09-20:* `src/core/strings.ts`, 117 keys behind `t(key, params)`; two snapshot suites pinned first and left byte-identical by the move; tray labels included, `main/index.ts` dialog prose is the follow-up; README says English only.

**P2-7 · Test-suite hygiene.** One meta-test asserting the `runIf` preconditions hold in a dev
checkout (`tsx` present, `art/walder.json` present) so a pruned tree fails loudly instead of
silently dropping 462 lines of icon verification. `coverage: { provider: 'v8', include: ['src/**'] }`
with no threshold. Prefix/slice sweeps over the six real-shape fixtures. Idempotence tests
(`f(f(x)) === f(x)`) for bucket merge, card layout, chain resolution. A read-only invariant test for
the local-token scanner (mtime and hash of every fixture file unchanged after a scan). An LRU
eviction test for `src/sprites/render.ts` at exactly `MAX_CACHE_ENTRIES`.
*Done 2026-09-20:* `test/dev-checkout.test.ts`, v8 coverage behind `npm run coverage`, prefix/key-deletion sweeps over the five REAL SHAPE fixtures (five carry the tag, not six), `forIpc` and `mergeBuckets` idempotence, the scanner's read-only invariant, `test/render.test.ts` for the LRU.

**P2-8 · Sessions block on the Large card** with cwd from the hook payload, and click-to-raise the
tool's app while a `waiting` is up. Do not attempt per-terminal-tab AppleScript.
*Done 2026-09-20:* `core/sessions.ts` reducer keyed by session id → pid → tool, fed by both event sources (cwd, pid, session id carried, never logged), `walder:sessions:set` to the panel, SESSIONS block at Large only; petting the dog while a `?` is up walks the pid's parents with `/bin/ps` to the first `.app` and runs `/usr/bin/open -a` (`core/raise.ts`, `main/raise.ts`). Codex hooks carry no pid, so the raise is Claude Code only.

**P2-9 · Repo furniture.** `dependabot.yml` (npm, monthly, grouped), `.github/ISSUE_TEMPLATE` and a
PR template in the source repo if it goes public, `CHANGELOG.md` as an index of `docs/release-notes/`,
publish `docs/HANDBOOK.html` to GitHub Pages off the release repo, badges once a licence exists,
`arch: [arm64, x64]` when someone with an Intel Mac asks. Skip CODEOWNERS and branch protection
until there is a second contributor.
*Done 2026-09-20 (repo side):* `dependabot.yml`, PR template, `CHANGELOG.md` (gated by `test/release-notes.test.ts`), badges. Issue templates skipped while the repo is private; the GitHub Pages recipe for the handbook is in `docs/release-repo/README.md` for Victor to run.

### Needs Victor's decision, not a code decision

**Renewing the Claude Code token via the CLI.** AGENTS.md forbids refreshing CLI tokens, and the
reason (spending `refreshToken` rotates the pair and logs the owner out) is correct. Codenotch
respects the same rule and still solves overnight expiry: it never touches the token, it spawns
`claude -p --no-session-persistence --strict-mcp-config` with empty stdin so the CLI renews its own,
and judges success by whether `expiresAt` moved, not by exit status. Gate: margin 4 min (under Claude
Code's own 5), cooldown 10 min, one attempt per distinct `expiresAt` so a failure stops instead of
looping, fixed scratch cwd, all fds to `/dev/null`, 30 s kill, spawned pid excluded from P0-5's
session source. It is spawning a subprocess on the owner's machine every few hours. That is a
product call. Approved 2026-09-19; implemented in src/core/claude-renew.ts and
src/main/claude-renew.ts.

---

## 5. Per-area detail

### 5.1 Testing

Measured: Walder 57 files, 1,779 passed / 2 skipped, 1.60 s, typecheck clean. Codenotch 91 XCTest
files, 1,640 test functions, plus ~101 Rust tests; not run (build forbidden).

Untested Walder surface, ranked by risk: `src/main/ipc-bridge.ts` (276 LOC, critical),
`src/renderer/overlay.ts` (1,417 LOC, no exports, needs pure-function extraction first),
`src/main/index.ts` (1,228 LOC: single-instance lock, `denyAllPermissions`, hook orchestration,
`openUpdatePage`), `src/preload/index.ts` (143 LOC), `src/sprites/render.ts` LRU,
`src/renderer/panel.ts`, `scripts/install-hooks.ts`, `scripts/probe.ts`. Everything in `src/core`
and `src/providers` has real coverage; `src/main` is 21 of 23.

Categories codenotch tests that Walder does not: settings migration (Walder has none to test),
`Retry-After` parsing, DST/timezone/year-rollover, sleep/wake (nothing to test), a hung dependency
with a late answer, idempotence, prefix/slice sweeps, a version↔release-notes gate, reduced-motion
paths, a read-only invariant on another app's files.

Where Walder is clearly better: file-level docblocks stating the threat model and incident;
on-disk fixtures with provenance (`claude-web-usage-live-keys.json` pads every invented string to
the real value's length so a leak cannot hide); redaction tested for what it must *not* destroy;
`check-asar` against the real archive; the duplicated `files` list machine-checked; the
`QA-CHECKLIST.md` ledger of what nobody has verified.

Codenotch flakiness worth not importing: `XCTSkipIf(NSUserName() == "runner")` silently disables
two tests on CI; ~15 wall-clock sleeps; real `NSPanel`s across every size × edge; a test that skips
if the developer's physical mouse is parked on the notch; assertions on `NSScreen.screens.count`;
one file that writes the developer's real `UserDefaults.standard`; one genuinely assertion-free
test (`Tests/TestPath.swift`).

### 5.2 CI, release, packaging

Codenotch: `ci.yml` (xcodegen → signing-logic self-test → `make test-ci` → `make verify-deps`
lockfile diff), `package.yml` (ad-hoc Release dmg per commit as an artifact, rolling `preview`
prerelease on main, `get-task-allow` stripped and *asserted* gone), `windows.yml` (cargo build/test,
clippy advisory), `windows-package.yml` (NSIS via pinned Tauri CLI, stable `Codenotch-Setup.exe`
name, **silent install → run `doctor` → assert output → uninstall**, auto-attach to `v*`
releases). Release notes live in Swift and a unit test fails the build if the version has no entry.
Signing, notarization and the Sparkle EdDSA key live only on the maintainer's Mac; the Makefile
auto-detects an Apple Development cert, falls back to ad-hoc, and disables signing for CI tests.

Walder: exact-pinned deps and a lockfile, but no `npm ci` anywhere; a pure-function, unit-tested,
provably-offline `--dry-run` publish script that uses `execFileSync` argv arrays throughout and
cannot attach a stale version's dmg; `check-asar` resolving `electron-store`'s dependency closure
from disk; a build-time CSP that fails closed. Tags have drifted; `QA-CHECKLIST.md` §8 records six of
eight install rows as never seen working.

What not to copy from codenotch here: committing a 10 MB dmg per release into git; a rolling
preview tag that force-moves and deletes assets; `contents: write` at job level on PR-triggered
jobs; `${{ }}` interpolated into `run:`; mutable action tags (and a mutable *branch* for
`rust-toolchain@stable`) on write-capable jobs; `npx --yes` of a build tool with no integrity pin;
`disable-library-validation` in public previews; a self-hosted appcast on a personal domain with no
key-loss or domain-lapse procedure; version duplicated across two build systems; no `concurrency`;
fork guards that give a fork's PR no checks at all; clippy reported but never enforced.

### 5.3 Architecture and providers

Codenotch's provider protocol is a plain existential with every member declared in the protocol
body (extension-only members dispatched to the default and "failed silently by reporting every
account as absent"). Readings are a flat `windows[]` with a **declared** `headlineID` and
`weeklyID`; both "most constrained" and "first in array" were tried and rejected because the
headline changed subject as numbers moved, the second one precisely at a rollover. `Fidelity`
(official / derived / manual) prefixes non-official numbers with `~`. Ten error cases, each with a
documented reason to exist separately; `credentialExpired` and `rateLimited` map to *stale* and keep
the last reading; only `needsAuth` and `unsupported` discard history. Backoff is per provider,
floor 60 s doubling to 15 min, `Retry-After` as a floor-raiser only, persisted so a relaunch
mid-penalty waits ("the app was the thing sustaining its own punishment"). Poll 60 s while a
session is busy, 5 min idle, forced on any window rollover and on `didWakeNotification`. No jitter,
no 5xx backoff, no App Nap opt-out. Credentials cached on the keychain item's modification date
(an attribute read never prompts; a data read may). Claude Code files a new keychain item per
rotation, so `kSecMatchLimitOne` can return an expired duplicate.

Session state on macOS is zero-install: `~/.claude/sessions/<pid>.json` (`status`, `tempo`,
`waitingFor`) watched by `DispatchSource` plus a 2 s liveness timer; desktop-hosted sessions fall
through to a 64 KiB transcript tail with an *allow-list* of record types (Claude Code keeps
appending bookkeeping records while idle, so "file touched recently" lied). Liveness is `kill(pid,0)`
plus start-time comparison. Cursor is read from `state.vscdb` `composerHeaders`. Codex has no status
field so activity is rollout recency, erring short. Waiting outranks busy; only *leaving* busy is
announced; the watcher seeds silently on first read so an overnight update does not chime per
window.

Walder's flow is `index.ts` → poller → `provider-chains` → `resolveService` → providers →
`mergeBuckets` → store → IPC → renderer. First `ok` wins, else the deepest available result;
`isAvailable` must be local and cheap; the web provider is found by capability
(`isAuthenticated !== undefined`), not id. One HTTP adapter owns timeout, `redirect: 'manual'` with
a single same-origin hop, a streamed 1 MB cap, and an explicit `credentials` mode (the bug fix for
"no cookies attached because a main-process request has no origin"). Endpoint discovery records
path only, never query, because `?token=…` would be persisted and replayed. `MIN_POLL_SEC = 180`
is a hard floor whatever the settings say, with ±10 s jitter; backoff only on `rate-limited` and
`error`, never on `auth-needed` or `endpoint-changed`. Redaction is type-level (`topLevelKeys` is
the only loggable thing about a body; `BugReportFacts` has no field for a token, percentage or
bucket name) with a regex backstop that deliberately spares `.` and `/`. The hook server is the
only inbound surface and its five checks are ordered so a CORS preflight gets 403 not an `Allow`
list.

Gaps, Walder side: token expiry reported as `auth-needed` when Claude Code will fix it itself;
no 401 retry; `Retry-After` unread; backoff not persisted; no `powerMonitor`; no reset-boundary
poll; constant 180 s cadence regardless of activity; `ServiceReport` has no timestamp; logout
leaves the persisted snapshot; no `Cache-Control`; no `schemaVersion`; the two-service union in
9 files.

### 5.4 Product and UX

Codenotch's tooltip copy is the transferable asset: reset phrasing that degrades by distance with
`max(1, minutes)` and rounding so "60 min" is unreachable; `—` never `0%` when there is no reading
and no bar when the fraction is unknown; error strings that name the tool and the remedy; a
neutral colour for "working" so it cannot be read as part of the usage scale; notification
permission requested inside the first real delivery, never at launch ("reads as grabbing"); an
escape hatch when every visual affordance is off; launch-at-login read from the OS not the store
(Walder already does this); height budgeted arithmetically so the hit region cannot drift.

Walder's product decisions that codenotch has not thought about: bubbles never expire and the
supersede-in-place rule bounds the queue; one bark grammar for every case including exhaustion
edges; bubble vocabulary deliberately different from card vocabulary; hide-when-idle with an 8 s
linger, six wake reasons, and "on the change only"; fullscreen courtesy per screen with `…zzz` as a
thought bubble; per-display position memory keyed `id:WxH` that survives undocking; "Show in
overview" hides the row *and* silences the bark while still recording the edge; emptying a service
removes its heading; threshold memory and exhaustion edges survive a quit; rolling-window jitter
handled correctly (codenotch re-arms on a flat drop below 80); eight vetted hotkey presets with a
status line; a schema that refuses to wipe the file over one bad field.

Feature-fit verdicts: rings, edge pinning, drop zones, Dock-presence choice and phone link do
**not** fit a mascot. Session state, "waiting outranks", reset-copy ladder, notification fallback,
and a sessions block on the Large card fit or adapt. The weekly window maps to posture, not face.

### 5.5 Accessibility and localization

Walder: zero `aria-*`, zero `role`, no `prefers-reduced-motion`, no `prefers-contrast`, no keyboard
path to the card or a bubble, no string externalisation. Colour-blind safety is genuinely good by
design (face shape, bar length and printed number are three redundant channels).

Codenotch: Reduce Motion honoured in seven files; Reduce Transparency honoured live; two VoiceOver
labels; nine languages with live switching and no restart, uneven coverage (zh/uk complete, fr and
pt-BR at 60 %); the Windows web UI is ahead of the Swift app on ARIA. No Increase Contrast, no
Dynamic Type, weaker colour-blind safety than Walder.

### 5.6 Windows

Codenotch's port is a separate Rust reimplementation with its own README, five providers, work-area
placement that polls so a moved taskbar re-pins the notch, a `doctor` subcommand, and CI that
installs, runs and uninstalls it. It has no fullscreen handling and no auto-update.

Walder's Windows support is a set of correctly reasoned, unit-tested branches nobody has executed:
`type:'panel'` and `visibleOnAllWorkspaces` are mac-only with no Windows twin, `fullscreen-win.ps1`
has never been run, the tray PNG has never been seen in a tray, and the NSIS installer has only ever
been produced on a Mac. First things to watch after P0-1's Windows job produces a real installer:
tray icon and menu; `fullscreen-win.ps1` emitting parseable lines and the dog curling up; the dog
staying above a maximised window and out of the taskbar rect; `Alt+Shift+W` on a machine with two
keyboard layouts.

### 5.7 Docs and hygiene

Codenotch: download-first README with a banner, a hero screenshot, four badges, a per-provider
`Provider | Source | How` privacy table with a fidelity claim per row, a named "honest caveat"
section; a 92-line CONTRIBUTING with a "why not what" comment rule and a localization contract;
`TASKS.md` as a subject-indexed decision log with symptom → wrong theory → measurement → root
cause → fix; three YAML issue forms (bug with the `log stream` command inline, feature, and a
*provider request* that asks for quota mechanics and credential location); a PR template with a
"tested on macOS (version)" checkbox; an asset-provenance ledger with SHAs; a vendored-dependency
README with two independent tarball hashes.

Walder: a 724-line README with no image, no link, no download, no requirements line (Apple Silicon
only appears in release notes), but the best Gatekeeper walkthrough anywhere, the Windows honesty
stated as a first-class fact, `package.json` `//` decision comments with dated measurements, the
`electron-builder.yml` signing post-mortem, `QA-CHECKLIST.md`'s "what builders could not verify"
table, type-enforced bug-report privacy, release notes with a thesis, `BUILD_LOG.md` recording
rejections and interruptions, and commit bodies that open with the observed problem. Missing:
LICENSE, CONTRIBUTING, SECURITY, any `.github/`, CHANGELOG, a subject index, an accessibility
statement, a localization statement, a versioning policy.

---

## 6. What Walder must keep

These are things codenotch does worse or not at all. Do not trade them away while closing gaps.

- `src/core` and `src/sprites` Electron-free, enforced by `tsconfig.web.json`'s empty `types` (add
  the explicit boundary test from P1-13 so the rule is stated, not inferred).
- The hermetic test suite: no sleeps, no network, no real windows, fake timers everywhere.
- Fixtures on disk with provenance and length-padded redaction tags.
- Redaction as a type: `topLevelKeys`, `IgnoredWindow`, `BugReportFacts`.
- One HTTP adapter owning every safety bound, with an explicit `credentials` mode per provider.
- The hook server's ordered checks and its refusal to log bodies.
- `MIN_POLL_SEC = 180` as a promise to the services, with jitter.
- No "highest percentage" fallback for the face.
- Check-only updates until builds are notarized, with `html_url` pinned to the releases prefix.
- `check-asar`, the duplicated-`files`-list test, and the provably-offline `--dry-run`.
- The no-TTL bubble rule, supersede-in-place, one bark grammar, two vocabularies, hide-when-idle,
  per-screen fullscreen courtesy, per-display position memory, "Show in overview" as one setting
  with two halves.
- The hook-install dialogs and the once-per-tool crash-safe offer flag.
- The rotating redacted log file and the one-click bug report.
- The Gatekeeper walkthrough, the Windows honesty, the unverified-capabilities ledger, the
  `package.json` `//` comments, the `electron-builder.yml` post-mortem, release notes with a thesis.

---

## 7. Practices in codenotch not to copy

From the security audit and the CI audit, each with the codenotch location for reference only.

1. Silent auto-update with the consent prompt deliberately suppressed, from a personal domain with
   no key-loss or domain-lapse procedure (`project.yml`, `Info.plist`).
2. Hand-rolled SVG/HTML sanitisation feeding `innerHTML`, `csp: null`, `withGlobalTauri: true`
   (Windows port). Walder's build-time CSP that fails closed is the right model.
3. Unqualified `Command::new("cmd"|"powershell"|"reg"|"netstat"|"explorer")` on Windows; always the
   full `System32` path. Walder's `execFile` with absolute-ish tool names is fine on macOS; mirror
   the rule on Windows.
4. Escaping only quote and backslash for AppleScript interpolation; whitelist inputs instead.
5. Logging raw response bodies at `.notice`/`privacy: .public` (four providers).
6. `kSecAttrAccessibleAfterFirstUnlock` for a purely local secret; use `…ThisDeviceOnly`.
7. Permanently granting an entire Team ID promptless keychain access (`fix-keychain-partitions.sh`).
8. A deliberate keychain-interaction bypass via `/usr/bin/security` after a refusal
   (`KeychainPrompt.swift`). Walder uses `security` as its *primary* read; do not add a bypass path.
9. Job-wide `contents: write` on PR-triggered jobs; `${{ }}` in `run:`; mutable action tags and a
   mutable branch on write-capable jobs; workflows with no `permissions:` block; `npx --yes` of a
   build tool.
10. `disable-library-validation` in publicly downloadable previews.
11. Backing up a secret-bearing config on every toggle with no retention, and matching other
    projects' hook names on uninstall (`hooks_install.rs`). Walder's dated single backup is fine.
12. Inferring another app's activity from its I/O counters (`activity.rs`). If the tool gives no
    signal, show no signal.
13. An unauthenticated loopback control endpoint accepting any local process (`server.rs`).
    Walder's is also unauthenticated by local process; a shared secret in the hook config would
    close it cheaply if it ever matters.
14. A pre-auth, pre-rate-limit endpoint disclosing exact version; no idle timeout on a
    single-threaded event loop; recording a nonce before verifying the signature (PhoneLink).
15. Keeping a stale second copy of a security contract (`docs/phone-link-protocol.md` v2 vs v3).
16. Committing a 10 MB release binary per version; locating a release-signing tool by a `find`
    glob under `$HOME`; `security import … -A`; `codesign --deep --sign`.
17. Reading every process's full command line (`ps -Ao pid,command`) or an ancestor's whole
    environment block to extract one value; the same codebase shows the narrow alternative
    (`diag.rs` WQL projection).
18. Shipping vendor logos carrying third-party C2PA provenance metadata while documenting them as
    unmodified.

---

## 8. Method and verification

Six Opus subagents ran read-only over both trees in parallel. I then re-verified the load-bearing
Walder claims directly: zero test references to `ipc-bridge`; `preload/index.ts` referenced only in
`login-window.test.ts` assertions that a login window has *no* preload; zero `powerMonitor`,
`aria-`, `role=` or `prefers-reduced-motion` in `src/`; the only `retryAfter` in `src/` is the
log-file's write-retry, unrelated to HTTP; zero `Cache-Control` in `src/providers`; `ServiceReport`
has no `fetchedAt`; the README says five coats and the sheet ships six; `~/.claude/sessions/*.json`
exists on this Mac with a `status` field; no `LICENSE`, no `.github/`; `clearInvalidConfig: true`
with `electron-store` mocked to an empty class in its test.

Not verified: codenotch's Swift tests were not executed (build forbidden); the keychain
duplicate-item hazard is cited from codenotch's own documentation, not reproduced here; the
per-provider wire specs in §4 P2-2 are taken from codenotch's parser doc comments, which quote
recorded payloads, and should be re-recorded with `npm run probe` before any adapter is written.

Nothing in either repository was modified by the audit. This file is the only change.

# Decisions — where the reasoning lives

An index, not an argument. Every decision in Walder was written down once, where
it was taken: in a `docs/BUILD_LOG.md` entry, in a `//…` comment key in
`package.json`, or in a comment in `electron-builder.yml`. This page says which
one, so you can find it without reading all three.

Pointers are exact: grep the quoted heading, key or comment lead-in.

## Packaging and release

| Subject | Where the reasoning lives |
| --- | --- |
| Ad-hoc signing on macOS, and the "damaged" builds it fixed | `BUILD_LOG.md` ▸ `## 2026-09-11 — the macOS signature: ad-hoc signing, and the iCloud file provider that was really blocking it (1619 tests)` · `package.json` ▸ `"//no-signing"` · `electron-builder.yml` ▸ the long `mac.identity` note |
| Why `dist:mac` packages into `$TMPDIR` and copies back | `package.json` ▸ `"//dist-mac-tmpdir"` |
| The signed-and-notarised path that has never run | `package.json` ▸ `"//signed-path"` |
| No hardened runtime; no notarisation or auto-update wired in | `electron-builder.yml` ▸ the `hardenedRuntime` note and the header comment |
| Skipping the native rebuild on Windows | `package.json` ▸ `"//win-npmRebuild"` |
| What may and may not be inside `app.asar` | `package.json` ▸ `"//check-asar"` · `electron-builder.yml` ▸ ``# WHY `node_modules/**/*` IS HERE.`` and ``# WHY THE LIST IS REPEATED UNDER `win`.`` |
| Why the `files` list is duplicated under `win` | `electron-builder.yml` ▸ ``# WHY THE LIST IS REPEATED UNDER `win`.`` |
| The `install-electron` postinstall, which cannot be removed | `package.json` ▸ `"//postinstall"` |
| Tray icons, app icons and the sprite sheet are generated, not committed — and the order they run in | `package.json` ▸ `"//gen-tray"`, `"//gen-icons"`, `"//sync-sheet"` |
| Publishing is a script with `gh`, not electron-builder | `electron-builder.yml` ▸ ``# WHY `publish: null`.`` · `BUILD_LOG.md` ▸ `## 2026-09-09 — stages F–H: hide-when-idle presence, the global shortcut, and the update check` |
| No Dock icon (`LSUIElement`), the artifact names, the assisted NSIS installer | `electron-builder.yml` ▸ the `LSUIElement`, `artifactName` and `nsis` notes |
| The Windows fullscreen probe shipped as an extra resource | `electron-builder.yml` ▸ the `extraResources` note |
| Build, smoke test, and why publishing is the owner's gate | `BUILD_LOG.md` ▸ `## 2026-09-11 — 0.2.0 built, smoke-tested, awaiting publish` · `## 2026-09-11 — 0.2.1 built and smoke-tested; supersedes the unpublished 0.2.0` · `## 2026-09-11 — 0.2.1 rebuilt with the credit amounts; smoke-tested` |
| The first release candidate, and the packaging bug that created `check:asar` | `BUILD_LOG.md` ▸ `## 2026-09-08 — ART v3 (strips 1:1) + M6 fixes + final integration — RELEASE CANDIDATE 0.1.0` |

## Polling

| Subject | Where the reasoning lives |
| --- | --- |
| The poll floor, jitter, backoff, the manual cooldown and the deadline | `BUILD_LOG.md` ▸ `## 2026-09-08 — M4: data layer + hover panel — ACCEPTED, SECURITY GATE PASSED on second review (598 tests)` |
| `Retry-After` as a floor, the six-hour ceiling, backoff persisted across a relaunch, `fetchedAt` ages, and waking on `powerMonitor` resume | `BUILD_LOG.md` ▸ `## 2026-09-19 — Seven P1 items from the codenotch gap analysis` |
| Petting him refreshes, under the same cooldown | `BUILD_LOG.md` ▸ `## 2026-09-09 — 0.1.1 live on Victor's Mac: logins OK, numbers match the dashboard; 0.1.2 follow-ups` |
| Late answers after the deadline, and after `stop()`, go nowhere | `BUILD_LOG.md` ▸ `## 2026-09-19 — Seven P1 items from the codenotch gap analysis` |

## Providers

| Subject | Where the reasoning lives |
| --- | --- |
| The live payload shapes, and the rule never to refresh a CLI's token | `BUILD_LOG.md` ▸ `## 2026-09-08 — Kickoff, live endpoint probe (before M1/M2)` |
| Provider chains, the login-window allowlist, how a token is handled | `BUILD_LOG.md` ▸ `## 2026-09-08 — M4: data layer + hover panel — ACCEPTED, SECURITY GATE PASSED on second review (598 tests)` |
| Cookie credentials, and opening the allowlist to the SSO providers | `BUILD_LOG.md` ▸ `## 2026-09-08 — 0.1.1: first live QA by Victor → login + fullscreen fixes` |
| Why a top-level key is shown only if Walder knows it by name, and the key-dump diagnostic | `BUILD_LOG.md` ▸ ``## 2026-09-10 — Stage I: the Claude window whitelist, and the key-dump diagnostic (W1, worktree `w1-whitelist`)`` |
| The real Fable row, Extra usage, Codex credits, and how each is persisted | `BUILD_LOG.md` ▸ `## 2026-09-10 — W3 / Stages II, III, III-b: the real Fable number, Extra usage, Codex credits — BUILT` |
| The Codex credit limit row, and the dev-only payload shape dump | `BUILD_LOG.md` ▸ `## 2026-09-11 — Codex credit limit row (spend_control) + chatgpt-web shape dump` |
| The credit money figure, and why the price is a setting rather than a constant | `BUILD_LOG.md` ▸ `## 2026-09-11 — Codex credit amounts and a configurable credit price` |
| Tokens today comes from the CLIs' own transcripts, and never bars or barks | `BUILD_LOG.md` ▸ `## 2026-09-11 — Tokens today row (local transcripts)` |
| Dropping `nimbus_quill`, and the derived Fable row that never barks | `BUILD_LOG.md` ▸ `## 2026-09-09 — 0.1.1 live on Victor's Mac: logins OK, numbers match the dashboard; 0.1.2 follow-ups` |
| Why the parsing core stays free of Electron | `BUILD_LOG.md` ▸ `## 2026-09-08 — M2a: scaffold + Electron-free core — ACCEPTED` |

## Renewal and the update check

| Subject | Where the reasoning lives |
| --- | --- |
| Renewal is delegated to the CLI; Walder never spends a refresh token | `BUILD_LOG.md` ▸ `## 2026-09-08 — Kickoff, live endpoint probe (before M1/M2)` |
| A distinct "logged out" state, the 401 re-read of the keychain, `no-cache`, and forgetting on logout | `BUILD_LOG.md` ▸ `## 2026-09-19 — Seven P1 items from the codenotch gap analysis` |
| The update schedule, the `html_url` pinned to the releases repo, a failed check that never warns, and the release script | `BUILD_LOG.md` ▸ `## 2026-09-09 — stages F–H: hide-when-idle presence, the global shortcut, and the update check` |
| What a stranger downloading a release actually meets | `BUILD_LOG.md` ▸ `## 2026-09-11 — the macOS signature: ad-hoc signing, and the iCloud file provider that was really blocking it (1619 tests)` |

## Hooks

| Subject | Where the reasoning lives |
| --- | --- |
| The loopback hook server, its limits, and the idempotent installer with `--remove` | `BUILD_LOG.md` ▸ `## 2026-09-08 — M5: behaviour — ACCEPTED (789 tests)` |
| The hook-driven ears, and how they arbitrate against usage and clicks | `BUILD_LOG.md` ▸ `## 2026-09-08 — M5: behaviour — ACCEPTED (789 tests)` |

## UI

| Subject | Where the reasoning lives |
| --- | --- |
| The click-through overlay, the alpha hit test, the tray, the CSP and the IPC seam | `BUILD_LOG.md` ▸ `## 2026-09-08 — M3: overlay shell — ACCEPTED (272 tests)` |
| The hover card in three sizes, and the panel as a pure painter | `BUILD_LOG.md` ▸ `## 2026-09-10 — Stage IV: the hover card in three sizes (W2 builder, 1363 tests)` |
| The card over a full-screen app: the instrumentation, the experiments, and the fix | `BUILD_LOG.md` ▸ `## 2026-09-10 — Stage V.1: permanent instrumentation for the full-screen card (1363 tests)` · `## 2026-09-10 — Stage V.2: the full-screen experiment switch (1374 tests)` · `## 2026-09-11 — fullscreen hover card fixed` |
| Hide-when-idle presence, the vetted shortcut presets, the tray menu order | `BUILD_LOG.md` ▸ `## 2026-09-09 — stages F–H: hide-when-idle presence, the global shortcut, and the update check` |
| The size ladder, the sheet-driven boxes and the semi-transparent panel | `BUILD_LOG.md` ▸ `## 2026-09-08 — DESIGN GATE: Victor REJECTED the first Walder design` |
| The exhaustion queue, and moving the usage shape into the Electron-free core | `BUILD_LOG.md` ▸ `## 2026-09-11 — deferred cleanup round` |
| Reset copy, the status notes that carry the remedy, per-section ages | `BUILD_LOG.md` ▸ `## 2026-09-19 — Seven P1 items from the codenotch gap analysis` |
| The handbook, and the expression gap it exposed | `BUILD_LOG.md` ▸ ``## 2026-09-09 — user handbook (`docs/HANDBOOK.html`), and the expression-art gap it exposed`` |

## Art

| Subject | Where the reasoning lives |
| --- | --- |
| The chosen design sheet, and why no model generates animation strips | `BUILD_LOG.md` ▸ `## 2026-09-08 — DESIGN GATE: Victor picked the Gemini (Nano Banana 2) design sheet` |
| The first design, rejected, and what replaced it | `BUILD_LOG.md` ▸ `## 2026-09-08 — DESIGN GATE: Victor REJECTED the first Walder design` |
| Generator-owned artwork, and the design canvas as a gate | `BUILD_LOG.md` ▸ `## 2026-09-08 — M1: Walder sprite art + design canvas — READY FOR VICTOR (design gate)` |
| Strips sliced 1:1, with no artistic edits | `BUILD_LOG.md` ▸ `## 2026-09-08 — ART v3 (strips 1:1) + M6 fixes + final integration — RELEASE CANDIDATE 0.1.0` |
| The v4 strip pipeline, the mood blinks, the dapple coat | `BUILD_LOG.md` ▸ `## 2026-09-09 — stages A–C: the art pipeline for the v4 strips, the mood blinks, and the dapple coat` |
| Mirroring, the app-drawn decoration layer and the tray bone | `BUILD_LOG.md` ▸ `## 2026-09-09 — stage E: mirroring, the app-drawn decoration layer, and the tray bone` |
| Coat-shared decoration, tan points, the out pose and the standalone symbols | `BUILD_LOG.md` ▸ `## 2026-09-11 — gallery fidelity: tan points, out pose, and universal symbols` · `## 2026-09-11 — clearer out, standalone symbols, and worried mouth` |
| The silver-dapple set and its cross-set thresholds | `BUILD_LOG.md` ▸ `## 2026-09-11 — silver-dapple gallery set assembled` |
| The idle frame, the blink-only revision, and the readable closed mouth | `BUILD_LOG.md` ▸ `## 2026-09-10 — first-frame idle with blinking only (owner revision)` · `## 2026-09-10 — readable closed mouth in the still idle` · `## 2026-09-10 — idle approved; remaining golden set ready for review` |
| Two rollbacks, and the lesson about global alignment shifts | `BUILD_LOG.md` ▸ `## 2026-09-10 — restore approved worried/exhausted only` · `## 2026-09-10 — restore original tilt/confused; withdraw happy candidate` |
| The closed art gate, and the four fallbacks approved with it | `BUILD_LOG.md` ▸ `## 2026-09-11 — final gallery approval and Claude handoff` |
| The validated copy of the sheet that the app draws | `package.json` ▸ `"//sync-sheet"` |

## Process and gates

| Subject | Where the reasoning lives |
| --- | --- |
| What a killed builder leaves behind, and the order to resume in | `BUILD_LOG.md` ▸ `## 2026-09-08 — PAUSED by Victor (approaching his 5-hour limit). Two builders were KILLED mid-work:` |
| The placeholder fixtures, and what discharged them | `BUILD_LOG.md` ▸ `### PLACEHOLDER FIXTURES — the reviewer must check these against Victor's key dump` |
| The hand-off to the card painter | `BUILD_LOG.md` ▸ `### Hand-off to W2 (the card painter)` |
| The live roadmap — what is done and what is left | `CODENOTCH_GAP_ANALYSIS.md` §4 |

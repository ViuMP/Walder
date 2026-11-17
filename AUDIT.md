# Audit — 2026-11-17

Branch `audit-and-desktop`, cut from `audit-2026-11` at `d523712`. That branch already carries the
full audit of 2026-11-13 (78 findings, 71 fixed; see
[`docs/handoffs/AUDIT_2026-11-13.md`](docs/handoffs/AUDIT_2026-11-13.md)). This audit did not
repeat it: each auditor read that list first and reported only what it does not cover.

**Method.** Six read-only auditors, one per area (providers; hooks and IPC; settings, tray and
store; windows and renderer; core logic; build, dependencies and tests), each followed by an
independent reviewer who tried to refute every finding. 44 findings: 42 held up (35 confirmed,
7 plausible) and 2 were refuted.

**Ranking.** Severity follows one rule, not how rare the trigger is. High: data loss, a security
hole, a crash, or wrong numbers in normal use. Medium: a real bug on a less common path,
meaningful duplication, missing validation at a trust boundary, or a missing test on risky logic.
Low: cleanup. Where the reviewer rated a finding lower, both ratings are shown.

**Result.** 1 high, 12 medium, 29 low, 2 refuted. The high and all 12 medium findings are fixed
(P4 within the scope stated on it). Of the 29 low ones, 24 are fixed (two of them in part) and
5 are left open: S3, S4, S5, S8 and S9. Each finding's status line says what was done.

Still open from the 2026-11-13 audit (not re-checked here): Windows on a second monitor, the
125 % position drift and tall tray menu on Windows, and the on-screen checks listed under "What is
left" in that report.

## Behaviour changes

Everything else was kept as it was. These are every change a person or another program can see:

1. **Hook install on an unreadable file** (H1): changes nothing and says "Could not read <path> (<code>), so nothing was changed." It used to replace the file.
2. **New Walder window** (S1): a tray item **Overview and settings…** opens it.
3. **Second launch** opens the Walder window. It used to do nothing visible.
4. **Uncaught errors** (S2) go to `walder.log`. Electron's generic error box no longer appears for them.
5. **A setting that cannot be saved** (S2) still applies for this run, and the window says it was not saved. It used to throw from the menu click.
6. **Refresh interval** below 180 seconds is refused by the window. The file accepted 30, but the poller never went below 180.
7. **Verbose log** cannot be switched off from the window or the tray while `WALDER_LOG=1` is set. Before, the tick was stored but had no effect.
8. **Reset times** (W-2): after a restart with Countdown saved, choosing Clock time updates the card at once.
9. **Sleep during fullscreen video** (W-3): switching it off mid-check can no longer put him to sleep, and switching it back on over a playing film puts him to sleep again.
10. **Unwritable settings file** (W-1): a size change, sleep or wake, or Reset position completes, with a warning in the log.
11. **Rate limits in a chain** (P1): with no source ok, an earlier 429 or error is reported instead of a later "log in again", and the poller backs off.
12. **Login window and 429** (P5): a 429 counts as "not logged in yet" without a second request.
13. **CODEX_HOME** (P3): the Codex login and the Codex Tokens today row follow it.
14. **GitHub CLI on Windows** (P2): only `gh.exe` is searched for, and the POSIX folders are not.
15. **Tokens today** (C1): a Claude message in two transcripts counts once, so totals on days with copied sessions are lower. Lines with no message id now collapse to one per scan, not one per file.
16. **Hook bodies** (H2, H3, H5): in an oversized body, the event key written first wins; a session id over 256 characters is ignored (the event still counts); an aborted request gets 400, not 413, and no warning.
17. **Stored claude.ai paths** (P6): no longer recorded, and the old list is emptied at startup.
18. **Windows PowerShell** (W-7): started by its full path.
19. **Installed app** (S7): ignores `ELECTRON_RENDERER_URL`.
20. **Removed renderer calls** (H4): the preload no longer offers `login`, `logout` or `refreshNow`. No page used them.
21. **Release title** (B6): `npm run release` titles a release from the first line of its notes, e.g. "v0.2.9: fixes from the 0.2.8 qa passes", instead of "Walder 0.2.9".
22. **Installer contents** (B3): tinyglobby, fdir and picomatch are no longer in the app archive. `check:asar` therefore fails on the old 0.2.9 archives in `release/`.
23. **Provider table check** (P8): a `LOGIN.chatgpt` row with no discovery key now fails at load. Only a code change can cause that.
24. **Dependabot** (B5): major updates arrive as separate pull requests.

## High

### H1 — `src/main/claude-hooks.ts:745`

**Status:** fixed — only "file not found" counts as no file; any other read error leaves the file untouched (install, remove, and the Codex file). · verified: confirmed · skeptic's severity: high

**Problem.** applyHooks treats every read error as 'no file'. If settings.json exists but cannot be read (EACCES, EISDIR, EMFILE and so on), original becomes null, parsed stays {}, the merge writes a file holding only Walder's hooks, no backup is written because original is null, and the rename replaces the owner's whole Claude Code settings file. applyCodexHooks uses the same function, so ~/.codex/hooks.json is exposed the same way. The file's own comment at 765-766 says a file it cannot parse must not be rewritten from scratch, and an unreadable file causes the same harm.

**Fix.** Treat only ENOENT as missing: `catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { path, changed:false, touched:[], backupPath:null, summary:`Could not read ${path} (${code}), so nothing was changed.` }; original = null; }`. Add one test that chmods the file to 000 (skip on win32) and asserts the contents are unchanged and changed is false.


## Medium

### B1 — `test/provider-chains.test.ts:177`

**Status:** fixed — `createChains` takes credential readers; the tests use fake tokens and real assertions. · verified: confirmed · skeptic's severity: medium

**Problem.** The createChains tests run the real Claude/Codex credential readers against the developer's machine. Only `electron` is mocked, so `npm test` runs `security find-generic-password` on the real keychain and reads the real ~/.codex auth file. The assertions were loosened so they pass whatever the machine holds, which makes the bearer-stack check vacuous wherever no credential exists, CI included.

**Fix.** Add a credential-reader seam to createChains (the providers already accept `readCredentials`, see test/providers.test.ts:179), or vi.mock('../src/providers/credentials') in this file. Then feed a fake live token and assert that at least one 'net' request was made with credentials 'omit', and that onClaudeExpiresAt receives the fake expiresAt exactly once.

### B2 — `.github/workflows/ci.yml:68`

**Status:** fixed — `npm run build` runs in the CI check job; `test/renderer-csp.test.ts` pins the production policy. · verified: confirmed · skeptic's severity: medium

**Problem.** The PR/main check job runs only typecheck and test, never `npm run build`. That leaves the renderer CSP untested: the `walderCsp` plugin (connect-src 'none' in production, plus failing the build when a page lacks the marker) is enforced only by a build. The only CI build is in the installer jobs, which run on v* tags. A broken build or a weakened production CSP can merge to main and stay unseen until release day.

**Fix.** Add `- run: npm run build` to the check job (ubuntu, cheap; first confirm it works after `npm ci --ignore-scripts`). Add a small test that imports the walderCsp plugin, or reads out/renderer/*.html after the build, and asserts that the production policy contains connect-src 'none', object-src 'none' and base-uri 'none', and that a page without the marker throws.

### B3 — `package.json:53`

**Status:** fixed — the three packages are excluded from both `files` lists and forbidden by `check-asar`; the 2026-11-13 report carries a dated correction. · verified: confirmed · skeptic's severity: low

**Problem.** The audit doc's dependency claim is stale, and the packaged app now ships the flagged packages. The get-windows bump to 10.0.0 in this audit pulls node-gyp@13.1.0 into the production tree, then tinyglobby/fdir/picomatch, and `npm audit --omit=dev` reports 5 high (picomatch ReDoS GHSA-fc5q-39xc-vjpf). fdir, picomatch and tinyglobby are inside the audit's own 0.2.9 mac app.asar even though nothing loads them at run time. The risk is not exploitable, but the doc's 'all dev-only' statement is false.

**Fix.** Correct the audit doc's line. Either add '!node_modules/tinyglobby/**/*', '!node_modules/fdir/**/*' and '!node_modules/picomatch/**/*' to both `files` lists in electron-builder.yml, plus check-asar's FORBIDDEN list (they are node-gyp's, which is already excluded), or note it as accepted. Re-check after the next get-windows/node-gyp release.

### C1 — `src/main/local-tokens.ts:138`

**Status:** fixed — Claude messages are de-duplicated across files; the per-file cache is kept. · verified: confirmed · skeptic's severity: low

**Problem.** "Tokens today" for Claude counts a message twice when the same message appears in two transcript files. The dedupe set is new for each file (`claudeTranscriptTokens(lines, from, new Set<string>())`), and the comment justifying that (lines 138-142: the repeated blocks of one message "never span two transcripts") is false on this machine. A forked or copied session, which happens in this owner's own handoff and subagent workflow, writes the same messages into a new .jsonl with the same timestamps.

**Fix.** Dedupe across the whole scan without breaking the per-file cache. Cache each file's Map<id, tokens> instead of a single total, then in totals() merge the maps of every file that passes the mtime filter into one Map and sum its values. Add a scanner test that writes the same assistant line (same id, requestId and timestamp) into two .jsonl files and expects it counted once. Fix the comment at 138-142.

### H3 — `src/main/hook-server.ts:255`

**Status:** fixed — a session id over 256 characters is dropped where it enters. · verified: confirmed · skeptic's severity: low

**Problem.** The hook server accepts a session_id of up to MAX_DETAIL_CHARS (1024). The sessions payload validator rejects any key over MAX_SESSION_KEY_CHARS (256) and then drops the whole list. One hook request with a 257-1024 character session_id puts an entry into `sessions` that every later push carries for the next 30 minutes, and the panel throws each push away. The SESSIONS block freezes on stale rows for every real session as well.

**Fix.** Bound the session id where it enters, at the cap the payload enforces: in hookDetailsFrom (and in hookHeadFrom's session_id), drop a session_id longer than MAX_SESSION_KEY_CHARS by importing it from core/sessions. Keep MAX_DETAIL_CHARS for cwd only. Add one test that a 300-character session_id is dropped.

### P1 — `src/providers/registry.ts:85`

**Status:** fixed — with nothing ok, the earliest back-off status (and its Retry-After) wins; `[429, ok]` still returns ok. · verified: confirmed · skeptic's severity: low

**Problem.** When a provider in a chain gets a 429, the chain loses that 429 if a later provider answers anything else. If the later provider answers `ok`, the earlier provider's `rate-limited` result and its `retryAfterMs` are dropped, so the poller never backs off. claude-web and chatgpt-web are first in their chains, so they are asked again on every poll for as long as they keep answering 429, and Retry-After is ignored. If the later provider fails with a status that does not back off (an expired Claude Code or Codex token gives `auth-needed`), that status is reported instead. The failure count goes back to 0, the last good numbers are thrown away, and the card shows 'token expired'. That is the outcome the D2 fix was meant to prevent, now reached through the registry instead of the candidate walk. This is a new registry finding, not a re-report of D2.

**Fix.** In resolveService, remember the first `rate-limited` result (and its retryAfterMs). If nothing in the chain is ok, return that result in preference to a later status that does not back off. If a later provider is ok, still pass the earlier provider's retryAfterMs/rate-limited state up, or keep a per-provider pause timestamp the way claude-web's supplements do (`supplementsPausedUntil`), so a 429'd provider is skipped until its floor passes. Add registry tests for [rate-limited, auth-needed] and [rate-limited, ok].

### P4 — `src/providers/copilot.ts:92`

**Status:** fixed in part — one `isRecord`, one `hasCredentials`, one `authMemory`. The retry-after rules were not unified, because that would change behaviour per provider. · verified: plausible · skeptic's severity: low

**Problem.** The token providers copy the same fetch pipeline instead of sharing it. Each one reads credentials (null gives 'unavailable', a throw gives 'error'), makes the HTTP call (a throw gives 'error'), maps classifyHttp to a failure, parses JSON, reports the keys, parses rows, and treats empty rows as 'endpoint-changed'. The copies have already drifted. cursor and copilot pass retryAfterMs for every status; claude-oauth and chatgpt-codex pass it only on 429. chatgpt-codex accepts rows with no number, while chatgpt-web requires one (`pct !== null || !isWindowKind`). The two web providers also duplicate the auth-memory block. A new provider means copying about 50 lines and choosing which variant to follow.

**Fix.** Add one helper in providers/types.ts, e.g. `tokenProvider({id, label, service, readCredentials, request(creds), parse(json, now), notFound?})`, that owns the read, classify and parse steps and a single retryAfter rule. Add a small `authMemory(clock)` helper for the two web providers. Keep the provider-specific steps (Claude's re-read on 401, Copilot's 404 mapping) as hooks.

### S1 — `src/main/tray.ts:591`

**Status:** fixed — `src/main/settings.ts` is the one writer; the tray, the shortcut and the Walder window all use it. · verified: plausible · skeptic's severity: low

**Problem.** No settings layer. Each setting's write and its side effects are private closures inside createTray, or ad-hoc lambdas in index.ts. A settings window, or any second UI, could not reuse them without copying every side effect.

**Fix.** Add one main-side settings module, e.g. `createSettings({store, overlay, panel, behaviour, poller, …})`, with a typed `get(key)` and `set(key, value)` that does the store write and its side effects in one place. Move the typed readers from store.ts into it as well. Make tray.ts a thin view that calls `settings.set` and reads `settings.get`. A future settings window then calls the same module over one validated IPC channel.

### S2 — `src/main/tray.ts:594`

**Status:** fixed — failed writes are applied and reported, not thrown; uncaught errors go to the log; the logout chain has a catch. · verified: confirmed · skeptic's severity: low

**Problem.** Settings writes from menu clicks are not guarded, and the process has no uncaughtException or unhandledRejection handler that writes to the log. A failed write (disk full, EACCES on walder.json) throws out of the click handler and skips the setting's side effect. Electron then shows its generic main-process error dialog, and nothing reaches walder.log. Logout promise chains have no catch, so a rejected session clear skips `poller.forget` silently.

**Fix.** Install `process.on('uncaughtException')` and `process.on('unhandledRejection')` early in index.ts and route both to `warn()`, so crashes land in the file the bug report asks for. Wrap the store write in one helper, ideally in the S1 settings module, so that a failed persist still applies the in-memory side effect, as setHideWhenIdle already does. Merge the two logout chains into one function with a `.catch(warn)`.

### W-1 — `src/main/behaviour.ts:351`

**Status:** fixed — the position save is caught inside `resize` and `resetPosition`. · verified: confirmed · skeptic's severity: medium

**Problem.** If the settings file cannot be written, a box change throws out of the behaviour coordinator's batch. The rest of the scene is lost: the renderer never gets `mode:set`, the remaining events (bubble, play, scene) are dropped and the deadline timer is never re-armed. The throw then reaches whoever called: an uncaught exception from a timer, a failed probe in the fullscreen watch, or a rejected IPC call. The audit added catches for the same throw in other places (flushSizeChange, safeReclamp, the renderer-crash handler) but left this path open.

**Fix.** In `resize`, wrap `remember(placed)` in the same try/catch with warn that safeReclamp uses, so every resize path keeps the window change and the following `mode:set`/syncFacing even when the save fails. Do the same in resetPosition. Add a test: with store.set throwing, a behaviour batch carrying `mode` then `bubble` still sends both, and arm() still runs.

### W-2 — `src/main/hover-panel.ts:207`

**Status:** fixed — the panel starts from the stored reset style. · verified: confirmed · skeptic's severity: medium

**Problem.** The panel's copy of the reset wording always starts at the default and is never loaded from the store. If the owner's stored style is not the default, then after a launch, picking the default style in the tray sends nothing: `setResetStyle` sees the value it already holds and returns early. The card keeps showing the old wording until a restart or a reload of the panel's renderer.

**Fix.** Seed the copy from the store, the same way cardSize is: add `resetStyle?: ResetStyle` to HoverPanelOptions and pass `readResetStyle(store)` at index.ts:1268. Add a test that starts the panel at 'countdown' and checks that setResetStyle('clock') sends.

### W-3 — `src/main/fullscreen-watch.ts:1120`

**Status:** fixed — switching off resets the watch directly, and a reading that lands after switch-off is ignored. · verified: confirmed · skeptic's severity: low

**Problem.** Turning 'Sleep in fullscreen' off while a probe is in flight does not reset the watch. `setEnabled(false)` calls `sample()`, which returns at once on the inFlight guard, so the disabled branch that clears `state` never runs. The probe already in flight then commits its reading anyway, because sample() does not re-check enabled() after the await. Result: the watch keeps `state.fullscreen = true` while index.ts has already woken the dog. After the switch is turned back on, a film that is still fullscreen produces no edge, so he does not sleep over it. If that in-flight sample is the one that completes the debounce, it calls onChange(true) after the switch is off and puts him to sleep with no further samples to wake him. Found by reading the code, not reproduced. On macOS each probe is about 77 ms of every 2 s (comment at lines 25-28), so roughly 4 % of toggles hit this.

**Fix.** After `await probe()`, return early if `!deps.enabled()`. In setEnabled(false), reset `state` to DEBOUNCE_INITIAL directly instead of relying on sample(). Add a test that turns the switch off while a deferred probe is pending.


## Low

### B4 — `.github/workflows/ci.yml:129`

**Status:** fixed — the mac installer job runs `npm test`. · verified: confirmed · skeptic's severity: low

**Problem.** The macOS suites never run in CI. The check job runs on ubuntu, and the mac installer job builds but has no `npm test`, so darwin-gated tests run only on the owner's Mac. This is the macOS twin of T6, which added `npm test` only to the Windows job.

**Fix.** Add `- run: npm test` as the last step of the mac job, as T6 did for Windows. Alternatively, stub process.platform in hover-panel.test.ts as tray.snapshot.test.ts:89 does, so the macOS branch runs on ubuntu too.

### B5 — `.github/dependabot.yml:12`

**Status:** fixed — minor and patch updates are grouped; majors come as their own pull requests. · verified: confirmed · skeptic's severity: low

**Problem.** The Dependabot config cannot deliver a mergeable npm update. One group matches every package and every update type, and open-pull-requests-limit is 1, so patch bumps are bundled with breaking majors into a single PR that fails typecheck. No other npm PR can open while it stays open.

**Fix.** Split the group: `npm-minor-patch` with `update-types: [minor, patch]`, and let majors arrive ungrouped or in their own group. Raise open-pull-requests-limit to 2-3.

### B6 — `scripts/publish-release.ts:471`

**Status:** fixed — the scratch folder is removed (not created on a dry run); the release title is read from the notes. · verified: confirmed · skeptic's severity: low

**Problem.** Every `npm run release` copies each installer into a fresh mkdtemp directory and never deletes it, `--dry-run` included. The copy happens at step 4, before the dry-run return at line 502. A dry run, documented as having asked GitHub nothing and changed nothing, leaves 100+ MB of installer copies in $TMPDIR, and so do a failed run and every real release.

**Fix.** For a dry run, compute the stable paths without copying (only names are printed). For a real run, wrap the publish in try/finally with `rmSync(scratch, { recursive: true, force: true })`.

### B7 — `scripts/sprites.ts:30`

**Status:** fixed — one shared helper, `scripts/cli.ts`. · verified: confirmed · skeptic's severity: low

**Problem.** The 'spawn a node_modules/.bin shim cross-platform' block is copied into scripts/sprites.ts and scripts/dist-win.ts: .cmd selection, quoting the path for cmd.exe, `shell: isWindows`, and the error/exit handlers. The copies already drifted once: T3 was the quoting fix dist-win had and sprites lacked. `flag()` is also duplicated, in scripts/install-hooks.ts:39 and scripts/publish-release.ts:366.

**Fix.** Move a `runBin(name, args, env)` helper into a scripts/ module (next to png.ts) and use it from both scripts. Move `flag()` alongside it.

### B8 — `test/fixtures/frame-set-sheet.ts:9`

**Status:** fixed — the headers say why the fixtures stay. · verified: confirmed · skeptic's severity: low

**Problem.** Two test fixtures call themselves temporary, with a deletion condition that has now been met. Their headers now misstate what the shipped sheet covers, so a reader concludes the real sheet's frame-set and anchor paths are untested.

**Fix.** Point the sprites/sync-sheet assertions at art/walder.json as the headers say, and delete the fixtures. If they stay as synthetic edge cases (pet without an anchor, identical decoration frames), rewrite the headers to say so.

### C2 — `src/core/interaction.ts:24`

**Status:** fixed — `CLICK_SLOP_PX` lives in core; a boundary test fails any core import from main, renderer or preload. · verified: confirmed · skeptic's severity: low

**Problem.** Core imports from main (`import { CLICK_SLOP_PX } from '../main/ipc';`). This is the only src/core or src/sprites file that does. It reverses the layering that expression.ts states ("the Electron-free core must not reach into main for the words it speaks"), and test/core-boundary.test.ts only checks direct `electron` / `node:` specifiers. If main/ipc.ts ever gains an electron import (it sits next to the preload), that import would reach core and the renderer bundle, and the boundary test would not catch it.

**Fix.** Move `CLICK_SLOP_PX` into src/core/interaction.ts (or another core module) and have main/ipc.ts re-export or import it from there. Optionally make core-boundary.test.ts also reject specifiers that start with `../main` or `../renderer`.

### C3 — `src/core/behaviour.ts:661`

**Status:** fixed. · verified: confirmed · skeptic's severity: low

**Problem.** The exhaustion bark text is built by hand in English (`${barkLabel(bucket)}: 100% used`), bypassing the `bubble.nudge` string that `nudgeText` uses (bubble.ts:267-269, '{label}: {pct}% used'). The B2/B5 fixes deduplicate an exhaustion bark against a machine bark by exact text match (behaviour.ts:1107-1108). That only works while the hand-built string and the strings-table template produce identical text. Editing or translating `bubble.nudge` in strings.ts would quietly bring back the double announcement that B5 fixed.

**Fix.** Use `nudgeText(barkLabel(bucket), 100)` for EXHAUSTED_TEXT so both paths go through one template.

### C4 — `src/core/nudge.ts:404`

**Status:** fixed — the unused path is deleted. · verified: confirmed · skeptic's severity: low

**Problem.** NudgeMachine's fullscreen sleep/wake path is unused in production. behaviour.ts's header says the coordinator never calls `machine.setFullscreen` and ignores the machine's sleep/wake events, and no src file calls it. Still carried: `setFullscreen`, the `fullscreen`/`asleep` fields, the `sleep`/`wake` NudgeEvent variants, and the wake/sleep branches in `promote`/`dismiss`. Only test/nudge.test.ts exercises them. A reader of the machine sees a second fullscreen model that does nothing.

**Fix.** Delete NudgeMachine.setFullscreen, the fullscreen/asleep fields, the sleep/wake event variants and their branches, plus the tests that cover only them.

### C6 — `src/sprites/types.ts:371`

**Status:** fixed. · verified: confirmed · skeptic's severity: low

**Problem.** `parseFrameSets` takes a `_base: Record<string, Frame>` parameter it never uses. Frame-set compatibility is checked separately in `validateFrameSetCompatibility`, so the argument is leftover.

**Fix.** Remove the parameter and the argument at its single call site.

### H2 — `src/core/hook-head.ts:104`

**Status:** fixed — of the two event keys, the one written first wins. · verified: confirmed · skeptic's severity: low

**Problem.** For an oversized body, hookHeadFrom runs the `event` regex over the whole head before it tries `hook_event_name`. A nested `"event":"<letters>"` anywhere in tool_input or tool_response therefore beats the real top-level hook_event_name, even when the real key comes first. The ponytail note says the first occurrence of a key wins, but across the two keys the code does the opposite: a nested key written later still wins. The result is a false 'done' bark, or a dropped PostToolUse 'resume' that leaves a '?' standing.

**Fix.** Take the earliest match by position across both patterns (compare match.index), not the first pattern that matches anywhere. Better still, since Claude Code and Codex only write hook_event_name, try hook_event_name first and fall back to event. Add a test with a nested `"event"` inside tool_input after the real key.

### H4 — `src/main/ipc-bridge.ts:281`

**Status:** fixed — the three unused preload calls, their channels and handlers are deleted. · verified: confirmed · skeptic's severity: low

**Problem.** The preload exposes login, logout and refreshNow, and the bridge registers privileged handlers for them (auth:login opens a browser window, auth:logout wipes a service's whole partition). No renderer calls any of the three. This is unused attack surface that a compromised renderer could use to log the owner out. The dead logout wiring is also a second copy of the tray's logout sequence and has already drifted: only the tray copy calls trayHandle.refresh().

**Fix.** Delete refreshNow, login and logout from preload/index.ts and index.d.ts, delete the three handlers and their RENDERER_CHANNELS entries, remove CH.refreshNow, CH.authLogin and CH.authLogout, and remove onRefreshNow, onLogin and onLogout from BridgeDeps along with the index.ts:1658-1667 wiring. Update the key list in test/preload.test.ts. If a card button is added later, route it through one shared logoutService(service) helper that the tray also calls.

### H5 — `src/main/hook-server.ts:484`

**Status:** fixed — an aborted request gets 400 and no misleading log line. · verified: confirmed · skeptic's severity: low

**Problem.** A request that errors or is aborted mid-body (readBody resolves null) is refused and logged as 'body over the cap (1024 KiB max)'. That uses up the once-per-process warn on a wrong diagnosis, and every later refusal, including a real stale-hook one that should say 'reinstall from the tray', goes only to vlog.

**Fix.** Split the branch: when read === null, reply(res, 400) with a vlog of 'hook request aborted' and do not call refuse, so the one warning stays for real refusals.

### P2 — `src/providers/credentials.ts:193`

**Status:** fixed. · verified: plausible · skeptic's severity: low

**Problem.** On Windows, the gh binary search still tries an extensionless `gh` and `gh.cmd` before `gh.exe`. This is the same bug class W2/D8 fixed for the claude CLI. Node's execFile with no shell cannot start a `.cmd` (it throws EINVAL synchronously) or an extensionless shim. A `gh`/`gh.cmd` earlier on PATH therefore shadows a real `gh.exe`. The throw inside the Promise executor becomes a rejection, readCopilotCredentials turns it into `null`, and Copilot reads 'GitHub CLI is not logged in'. The bad path is cached in the module-level `ghBinary` for the life of the process.

**Fix.** Use `['gh.exe']` on win32, as claude-renew does, and update the test at credentials.test.ts:604. The POSIX fallback roots (/opt/homebrew…) can also be skipped on win32.

### P3 — `src/providers/credentials.ts:644`

**Status:** fixed — one `codexHome()` used by hooks, credentials and the token scanner. · verified: confirmed · skeptic's severity: low

**Problem.** `$CODEX_HOME` is honoured when installing hooks, but the Codex credential read and the local token count ignore it. With CODEX_HOME set (Codex's documented override for a second profile), Walder installs hooks into $CODEX_HOME. It then reads `~/.codex/auth.json` and reports 'no Codex CLI login found', and the Codex 'Tokens today' row counts the wrong folder. The same directory is resolved by two different rules.

**Fix.** Move `codexHome()` to a place both sides can import (core or providers, since it only needs env and home) and use it in readCodexCredentials (through CredentialIo, so it stays testable) and in local-tokens. Add one credentials test with CODEX_HOME set.

### P5 — `src/providers/chatgpt-web.ts:305`

**Status:** fixed. · verified: confirmed · skeptic's severity: low

**Problem.** While the login window is open, a 429 from the auth check still triggers the second-opinion request, which doubles traffic to a host that has just asked Walder to slow down. The fallback is skipped after 401/403 for the very reason of not doubling the 2-second login-window polling, but a 429 falls through to `/backend-api/me` (chatgpt) or `/api/account` (claude). The login window asks every 2 s, so a rate-limited host gets about 60 requests a minute instead of 30.

**Fix.** Treat `classifyHttp(response) === 'rate-limited'` like 401/403 in both isAuthenticated methods: remember 'HTTP 429' and return false without the second request.

### P6 — `src/main/services-main.ts:59`

**Status:** fixed — the claude.ai login window no longer records paths, and the stored list is emptied at startup. The key stays in the schema so older files load. · verified: confirmed · skeptic's severity: low

**Problem.** `claudeDiscoveredEndpoints` is written but never read. The claude.ai login window records every quota-ish path into the plain settings file, and no provider consumes it, since claude-web uses fixed URLs. DISCOVERY_RE matches `/api/organizations/<org-uuid>/usage`, so the stored entry holds the owner's organisation id for no consumer. The store's doc comment also still says these lists hold 'Path + query', which the 2026-09-08 change replaced with path only.

**Fix.** Set the Claude row's discovery to nothing (e.g. make `discoveryKey` optional and skip attachDiscovery when absent). Clear the stored key once, and fix the store.ts comment to 'path only'.

### P7 — `src/providers/registry.ts:203`

**Status:** fixed — `allProviders` and `resolveAll` deleted. · verified: confirmed · skeptic's severity: low

**Problem.** `allProviders` is exported and used nowhere, not even in tests. `resolveAll` has no production caller, because the poller calls `resolveService` per service, but a comment still names it as a consumer of the chains.

**Fix.** Delete `allProviders`. Either delete `resolveAll` and its tests (registry.test.ts:189-215) or leave it and drop it from the provider-chains.ts:329 comment.

### P8 — `src/main/provider-chains.ts:366`

**Status:** fixed in part — the key is read from the `LOGIN` table once. Moving the shared read-sanitise-write helper was left out. · verified: confirmed · skeptic's severity: low

**Problem.** The persisted discovery key is written twice: once in the per-service LOGIN table, which says it is the place for it, and again as a string literal in the chain builder and its helper. Renaming it in one place (or adding a second web service, or a settings window that wants to show and clear learned endpoints) means finding the other copies by hand.

**Fix.** Read the key from `LOGIN.chatgpt.discoveryKey` in createChains. Move the shared 'read, sanitise, write back if changed' helper into endpoint-discovery.ts, where both attachDiscovery and provider-chains can call it.

### S3 — `src/main/log-file.ts:184`

**Status:** open (low) — not in scope for this run (high and medium only). · verified: confirmed · skeptic's severity: low

**Problem.** When rotation fails (rename blocked, for example by a Windows tool that opened walder.log without FILE_SHARE_DELETE), the live file still has its size counter reset to 0. The next rotation is then not attempted for another MAX_BYTES, so the live file grows without bound, 1 MB per missed rotation. This contradicts the code's own comment.

**Fix.** After rotate(), re-derive with `size = sizeOf(path)` instead of `size = 0`. If the rename failed, the file is still over the cap and the next line retries. Add a test that makes renameSync throw.

### S4 — `src/main/log.ts:51`

**Status:** open (low) — not in scope for this run. · verified: confirmed · skeptic's severity: low

**Problem.** The catch-all redactor masks any identifier of 20 or more characters, which destroys diagnostics that were built specifically to name keys. The store's 'ignoring an invalid <key>' line (the QA 4.24 fix) logs '[redacted]' for three settings keys. The one-time usage key-set lines lose payload key names such as `additional_rate_limits` and `code_review_rate_limit`.

**Fix.** Exempt pure lowercase or snake_case and camelCase identifiers, i.e. runs with no digits and no `-`/`+`/`=`, from BASE64ISH_RE, or require at least one digit or a mixed-case-plus-digit pattern. Real tokens almost always contain digits. Add a redaction test for a settings key name and a snake_case payload key.

### S5 — `src/core/bug-report.ts:200`

**Status:** open (low) — not in scope for this run; the issue draft is shown to the owner before anything is sent. · verified: plausible · skeptic's severity: low

**Problem.** The prefilled public GitHub issue and the clipboard both carry the absolute log path. That path contains the OS account name (/Users/<name>/… or C:\Users\<name>\…), while everywhere else the app shortens the home folder to `~` before anything leaves the machine.

**Fix.** In openBugReport, shorten `logPath` with the same `~` replacement used in onHookEvent (better: extract that into one helper and use it in both places), and update the test to expect `Log: ~/Library/Logs/Walder/walder.log`.

### S6 — `src/main/store.ts:317`

**Status:** fixed — `DEFAULTS` and the schema defaults come from `src/core/settings-spec.ts`; a test pins them. · verified: confirmed · skeptic's severity: low

**Problem.** Every default is written twice, once in DEFAULTS and once in SETTINGS_SCHEMA `default`, and some have a third copy elsewhere. No test checks that the copies agree. The pollIntervalSec limits also contradict each other: the schema accepts 30 to 179 seconds, but the poller silently floors them to 180.

**Fix.** Build each schema `default` from DEFAULTS, e.g. `default: DEFAULTS.size`, or generate the defaults from the schema. Import DEFAULT_HOOK_PORT in store.ts. Set the schema `minimum` for pollIntervalSec to MIN_POLL_SEC. Add a one-line test that `SETTINGS_SCHEMA[k].default` deep-equals `DEFAULTS[k]` for every key.

### S7 — `src/main/overlay-window.ts:267`

**Status:** fixed — `pageUrl` ignores `ELECTRON_RENDERER_URL` in the installed app. · verified: confirmed · skeptic's severity: low

**Problem.** ELECTRON_RENDERER_URL is honoured in packaged builds. A packaged Walder started with that variable set, for example from a developer shell where another electron-vite project exported it, loads that origin into the overlay and the panel. Both windows carry the preload bridge, so that page can pull settings:get (usage, sessions with cwd) and send login and logout IPC. The project already gates a comparable dev-only variable on `!app.isPackaged`.

**Fix.** Use the dev server URL only when `!app.isPackaged` in all three pageUrl() functions. That is one condition each, and it matches electron-vite's own `is.dev &&` idiom.

### S8 — `src/main/tray.ts:430`

**Status:** open (low) — `TrayDeps.onCheckForUpdates` is still unwired; harmless. · verified: confirmed · skeptic's severity: low

**Problem.** Two exported APIs are used only by tests. TrayDeps.onCheckForUpdates is never wired by the app, and ShortcutBinder.current() is never called outside tests.

**Fix.** Delete `onCheckForUpdates` from TrayDeps and the call at tray.ts:782, along with the test that feeds it. Delete `current()` from ShortcutBinder, or keep it and mark it test-only. Deletion is smaller.

### S9 — `src/core/shortcuts.ts:307`

**Status:** open (low) — not in scope for this run. · verified: confirmed · skeptic's severity: low

**Problem.** The shortcut status lines and all hook dialog text are hard-coded English that bypasses t(). This breaks the strings.ts contract that t() is the only way src/core and src/main produce owner-facing words, so a translation pass would miss them.

**Fix.** Move these strings into STRINGS with `{label}`/`{path}` placeholders and call t(). The strings snapshot test then pins them.

### W-4 — `src/core/fullscreen.ts:348`

**Status:** fixed — deleted. · verified: confirmed · skeptic's severity: low

**Problem.** `displayFor` and its private helper `intersectionArea` are dead in production: only a test imports them. They also duplicate `overlap` and `physicalDisplayFor` in win-dpi.ts, the same 'display with the largest overlap' logic.

**Fix.** Delete `displayFor` and `intersectionArea` and their test block. If the overlap rule is needed in core again, export one helper and have win-dpi.ts use it.

### W-5 — `src/main/hover-panel.ts:257`

**Status:** fixed in part — `src/main/window-page.ts` holds the page URL, preload path and navigation lock for every window; the two crash-reload handlers differ on purpose and stay separate. · verified: confirmed · skeptic's severity: low

**Problem.** The overlay window and the hover panel each build their own copy of the same window plumbing: the navigation lock, the dev/packaged page-URL resolver, the PRELOAD path, the render-process-gone reload with the same bound, and the transparent/frameless/focusable:false/alwaysOnTop 'screen-saver' option block. overlay-window.ts already has `lockNavigation` but hover-panel copies its body. A third card-like window, such as a settings or detail window, would make a fourth copy of the security-relevant navigation lock.

**Fix.** Move `lockNavigation`, `pageUrl(name)` and a `reloadOnCrash(win, label)` helper into a small module under src/main/ and call it from all three windows. Keep each window's own option block.

### W-6 — `src/main/tray.ts:591`

**Status:** fixed — same fix as S1. · verified: plausible · skeptic's severity: low

**Problem.** Each setting's apply logic (write the store, notify the window or service, rebuild the menu) lives in a private closure inside the tray. Main-side copies of setting values (the panel's resetStyle, the overlay's `still`) must be kept in step by whoever calls them. A settings window cannot reuse any of this: it would have to copy each applier and remember every side effect, and W-2 is that kind of drift already happening. The pattern is also mixed: hideWhenIdle and hiddenServices are written in index.ts, the rest in the tray.

**Fix.** Pull the appliers out into one `settings` service in main (for example `applySetting(key, value)`) that owns the store write and the side effects, with change listeners. The tray and any future settings window then both call it and only refresh their own UI. Seed every main-side copy from that service.

### W-7 — `src/main/fullscreen-watch.ts:782`

**Status:** fixed — PowerShell is started by its full path under `%SystemRoot%`. · verified: plausible · skeptic's severity: low

**Problem.** The Windows fullscreen helper starts `powershell.exe` by bare name, so the executable is found by searching the current directory and PATH. The codebase's own rule elsewhere is to use absolute binary paths because PATH belongs to the user (raise.ts), and this spawn starts automatically at launch when the feature is on.

**Fix.** Resolve the binary as `join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')` and spawn that path. Keep `-ExecutionPolicy Bypass -File` as it is.


## Refuted (not defects)

### C5 — `src/core/anim-schedule.ts:480`

**Status:** not a defect (refuted). · verified: refuted · skeptic's severity: low

**Problem.** The same union is declared twice: `ThenWhat` in anim-schedule.ts and `PlayThen` in behaviour.ts are both 'idle' | 'hold' | 'sleep'. The overlay passes behaviour's `PlayThen` into anim-schedule's `resolveThen`/`parksWhenDone`, so the two must be kept in step by hand. The doc comment at 476 says it 'Mirrors `PlayThen`'.

**Fix.** `export type ThenWhat = PlayThen;` (type-only import from ./behaviour), or drop ThenWhat and use PlayThen directly.

### H6 — `src/main/ipc-bridge.ts:112`

**Status:** not a defect (refuted); S1 added the validated setter it asked about. · verified: refuted · skeptic's severity: low

**Problem.** The IPC layer has a read-only settings path and no validated setter. settings:get assembles the values from separate read* helpers, every write is an inline store.set followed by a per-setting side-effect callback inside tray.ts click handlers, and each pushed setting has its own channel (cardSizeSet, resetStyleSet, barkSoundSet). A settings window could not reuse any of that. It would need a new channel, handler and validator per setting, plus a copy of each tray side effect. The sender guards also hard-code the two existing windows as three near-identical closures, so a third window means editing every guard.

**Fix.** Only when a settings window is actually started: move each setting's 'write and apply' into one main-side setSetting(key, value) that validates with the existing isCardSize, isResetStyle and similar guards, then performs the side effect. Have tray.ts call it, and expose it over a single validated settings:set channel. Replace the three sender closures with one allowedSenders(channel) lookup. Do not build this ahead of the window.

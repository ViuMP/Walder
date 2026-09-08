# Walder build log

Stage-by-stage record. Each entry: what exists, what was verified, what is deferred.
Written by the orchestrator (Fable) after auditing each builder + reviewer pass.

## 2026-09-08 — Kickoff, live endpoint probe (before M1/M2)

- Project folder created, git initialised, private repo `ViuMP/Walder` created and set as origin.
- **Claude OAuth probe:** Keychain item `Claude Code-credentials` exists with keys
  `accessToken, refreshToken, expiresAt, refreshTokenExpiresAt, scopes, subscriptionType (team), rateLimitTier`.
  The stored access token was EXPIRED; `GET api.anthropic.com/api/oauth/usage` → 401
  `authentication_error: OAuth access token has expired`.
  **Decision:** Walder NEVER refreshes CLI tokens (refresh rotates the token and could invalidate
  Claude Code's own login). Expired token → status `auth-needed` for that provider → fall back to the
  claude.ai web-session provider. The panel shows which source is live.
- **Codex probe:** `~/.codex/auth.json` has `tokens.{access_token, account_id, id_token, refresh_token}`.
  `GET chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer` + `ChatGPT-Account-Id` → 200.
  Real shape (fixture saved, identifiers redacted): `rate_limit.primary_window` and
  `rate_limit.secondary_window`, each `{used_percent, limit_window_seconds (18000 / 604800),
  reset_after_seconds, reset_at (unix seconds)}`; plus `plan_type`, `credits`, `model_usage`.
  NOTE: this is the Codex allowance, not necessarily the ChatGPT chat message allowance — M4 must run
  the endpoint-discovery step inside the chatgpt.com login window to find the chat limit endpoint,
  and label the Codex buckets honestly ("Codex 5-hour", "Codex weekly") until then.
- Parser consequence for M2a: `parseChatGptUsage` must handle key `rate_limit` (singular) with
  `primary_window/secondary_window`, `reset_at` as unix seconds, `limit_window_seconds`.

## 2026-09-08 — M2a: scaffold + Electron-free core — ACCEPTED

- **Exists:** electron-vite scaffold (electron 44.2.0, vite 7.3.6, vitest 5, TS 7), placeholder main/preload/renderer,
  `src/core/{buckets,expression,nudge,hittest}.ts`, fixtures + 106 unit tests, `docs/`, `build/` placeholder.
- **Review found (fixed):** ChatGPT parser tested against an invented payload → replaced with the real Codex shape
  (`rate_limit.primary_window/secondary_window`, labels "Codex 5-hour"/"Codex weekly"); relative reset field beat the
  absolute one and drifted every poll → would have re-barked forever; nudge re-arm now needs a >60 s real move;
  Claude fraction auto-detect misread 1 % as 100 % → default is now `percent`; walker no longer reads window lengths as
  percentages; single-instance lock, window-open deny, navigation lock, tight CSP added.
- **Verified by me:** `npm test` 106/106, `typecheck` clean. `postinstall: install-electron` is REQUIRED with
  electron 44 + npm 11 (empirically: without it `npm run dev` dies "Electron uninstall") — do not remove.
- **Deferred:** CSP `connect-src 'none'` blocks Vite HMR websocket in dev (app still runs) → M3 makes the CSP dev-aware.
  `will-navigate` hands http(s) URLs to the OS browser; fine for now.

## 2026-09-08 — M1: Walder sprite art + design canvas — READY FOR VICTOR (design gate)

- **Exists:** `art/walder.json` (45 frames, 22 animations, 5 palettes, boxes 48×40 stand / 32×24 sleep), generator
  `art/frames.mjs` (edit the base pose there, regenerate — hand edits to the JSON are overwritten), renderer
  `art/render.mjs` → `art/out/` (1x/2x/3x/6x per frame, contact sheets, CHECK.txt clean).
- **Art review (Fable):** first pass read as a smooth-haired, boxy dog. Revision added the plume tail, ear fringe,
  cream chest/belly feathering, body contour, paws, closed neutral mouth, sweat drop on worried. Accepted for the gate.
  Known soft spots: `out` frame's tail is a nub (no room behind the rump), `wake_1` stretch is weak, black-and-tan
  eyes are low contrast.
- **Design canvas:** `design/*.dc.html` + `canvas.json`, published as artifact
  https://claude.ai/code/artifact/16f3dadc-0b5d-45f5-be75-52e4ae4649e9 (title "Walder"). Re-seed from `design/`
  after any art change (`node <design-skill>/seed-canvas.mjs …`); `design/walder-mascot.html` is the seeded output.
- **Gate:** M2 (sprite pipeline code: frames/palettes/anim from `art/walder.json`) waits for Victor's approval or change
  requests on the canvas. M3 fixes are in flight in `src/` independently.

## 2026-09-08 — M3: overlay shell — ACCEPTED (272 tests)

- **Exists:** transparent always-on-top click-through window (`src/main/overlay-window.ts`), alpha hit test + drag via
  pure reducers (`src/core/interaction.ts`), ink-aware clamp + Reset position, per-display store, tray (Size/Colour/
  Launch at login/Force interactive/Reset position/Quit), typed validated IPC, dev-aware CSP, deny-all permission
  handlers, no `shell.openExternal`, bounded raster cache keyed by palette name/frame/scale/dpr, fractional-DPR-safe
  rasterisation, near-zero idle wakeups. Placeholder sprite only. `test/manual/QA-M3.md` is the human checklist.
- **Not verified:** anything visual (screen capture unavailable this session); fullscreen-over-video; Windows.

## 2026-09-08 — DESIGN GATE: Victor REJECTED the first Walder design

- Verdict: "horrendous". Reference images supplied: chibi pixel dachshunds — big head (≈40 % of body length), large
  round dark eyes with highlight, soft rounded forms, richer 4–5 tone shading, fluffy long-haired feathering (ears, chest,
  tail plume), front-3/4 view, cute. Our sprite was too small-headed, too boxy, too "sausage".
- **Decisions:** max on-screen size = the 3x "large" (no 4x); sizes → small 1x / medium 2x / large 3x. Hover panel liked,
  but must be semi-transparent so fullscreen video stays visible behind it (M4). Sprite pipeline (M2) must be fully
  data-driven on box sizes (the winning design may not be 48×40) — the `[48,40]`/`[32,24]` assertions in
  `src/main/sheet.ts` and `STAND_BOX` in `src/core/geometry.ts` become "read from the sheet".
- **Next:** Victor will generate candidate design sheets in ChatGPT / Gemini / Claude Design / Adobe from a prompt we
  write (`docs/MASCOT_PROMPT.md`), pick one, and we re-author `art/walder.json` from the winner. M2 stays gated.

## 2026-09-08 — DESIGN GATE: Victor picked the Gemini (Nano Banana 2) design sheet

- Chosen look: chibi golden long-hair, big head (~40 %), big round dark eyes with highlight, cream bib, plume tail,
  Pokémon B/W palette (cream / golden light / honey mid / amber shadow / dark-brown outline). Victor's copy of the
  sheet goes in `design/references/` when he sends the pose images.
- Process agreed: no animation strips from the image model (frame drift). Victor generates one large image per key
  pose from `docs/MASCOT_POSE_PROMPTS.md`; we re-author one 48×48 master pose and derive all frames from it.
- Sprite work restarts when the pose references arrive. Grid stays 48×48 stand / 32×24 sleep.
- **Update, same day:** Victor switched to a second Gemini sheet (fluffier, natural proportions, 16-colour palette with
  hex codes). Grid decision: 64×64 stand / 40×28 sleep; default on-screen 2x (128 px). Header v2 in
  `docs/MASCOT_POSE_PROMPTS.md`. Sheet-driven boxes (M4 change A2) make this a data-only switch.

## 2026-09-08 — M4: data layer + hover panel — ACCEPTED, SECURITY GATE PASSED on second review (598 tests)

- **Exists:** providers `claude-oauth` (Keychain / credentials.json, never refreshes), `claude-web` (persist:claude
  cookies → /api/organizations → /usage), `chatgpt-web` (persist:chatgpt → /api/auth/session → candidate endpoints,
  discovery of paths only, 45 s budget), `chatgpt-codex` (~/.codex/auth.json → wham/usage, labelled "Codex …");
  registry chains claude=[oauth, web], chatgpt=[web, codex]; poller (180 s floor, jitter, backoff, 60 s manual
  cooldown, 90 s deadline, re-entrancy guard); login windows (no preload, sandboxed, host allowlist enforced on
  navigate/redirect/frame/popup children + did-navigate revert, deny-all permissions); semi-transparent hover panel
  (0.82 cream card) with edge-flip placement; tray Accounts + Refresh now; `npm run probe`; log redaction.
- **Security gate (first pass FAILED S3/S4/S8, fixed):** login window closed itself when CLI logins existed → now
  checks the web provider's real authentication; popups now inherit the navigation lock; discovery stores pathnames
  only; `.auth0.com` removed from the allowlist; bearer requests never follow cross-origin redirects; bodies capped
  at 1 MB. Tokens: read at poll time, in memory only, never in store/snapshot/IPC/log (traced by reviewer).
- **Owner-facing changes landed:** sizes small 1x / medium 2x / large 3x; sheet-driven sprite boxes (any grid).
- **Verified by me:** 598/598, typecheck, build, probe (claude-oauth auth-needed because the Keychain token is
  expired; chatgpt-codex ok). **Needs Victor:** log into claude.ai and chatgpt.com via the tray; confirm which
  chatgpt.com endpoint carries CHAT limits (Codex ≠ chat).

## 2026-09-08 — M5: behaviour — ACCEPTED (789 tests)

- **Exists:** pure behaviour coordinator (`src/core/behaviour.ts`: usage nudges via the existing NudgeMachine, perk/
  waiting hook events queued behind nudges, fullscreen sleep/wake, one armed deadline instead of a heartbeat), bubble
  wording/wrapping, fullscreen decision per DISPLAY (video on another monitor does not put the dog to sleep),
  fullscreen watch (macOS `get-windows` 9.3.0 — no Screen Recording permission needed; Windows: bundled PowerShell
  helper `fullscreen-win.ps1`, no native addon), loopback hook server (POST /event, JSON only, 8 KB cap, Host/Origin/
  Content-Type checks → 403/415, never echoes), `install-hooks` (idempotent merge into `~/.claude/settings.json`,
  refuses unparsable or wrongly-shaped files, temp-write + backup + rename, `--remove`), tray Developer menu
  (inject usage / simulate hook / toggle fullscreen) in dev.
- **Review found (fixed):** missing Content-Type check (browser form CSRF), `electron-store` not packaged (app would
  not launch), Windows fullscreen impossible from a Mac build (native addon) → PowerShell helper, Windows hook command
  broke under a POSIX shell, installer discarded wrongly-typed hook entries, CLI installer ignored the walked port,
  bubble truncation at size small, plus L1–L6. Builder also found `get-windows` helper path broken inside the asar
  (packaged mac never slept over video) → imports the unpacked copy.
- **Verified by me:** 789/789, typecheck, build. Packaged `--dir` mac build launched and polled (builder evidence).
- **Not verified:** Windows PowerShell helper (no Windows machine); all visuals.

## 2026-09-08 — PAUSED by Victor (approaching his 5-hour limit). Two builders were KILLED mid-work:
- **M1b art revision** (coat tones lighter, calm neutral face, ear stripes, distinct expressions, belly band): `art/` is
  in a PARTIAL state — the base was remapped, "the other authored poses were never remapped". Do NOT trust
  `art/out/` or `art/walder.json` until the revision is re-run from the brief (README + frames.mjs). Last good
  committed art = v2 (dark/orange, open-mouth face) at commit e089236.
- **M2+M6 sheet wiring / gallery / icons / packaging / README**: `src/`, `scripts/`, `electron-builder.yml` have
  PARTIAL uncommitted edits (sync-sheet + tests were being written). Either finish from the brief or `git checkout .`
  and re-run. Tests may not pass in this state — last green commit is e089236 (789 tests).
- Resume order: (1) re-run the M1b art revision brief → Fable visual check at 2x → design canvas v2 for Victor →
  (2) finish M2+M6 → reviewer → QA checklist → installers for Victor.

## 2026-09-08 — ART v3 (strips 1:1) + M6 fixes + final integration — RELEASE CANDIDATE 0.1.0

- **Art:** Victor rejected all hand-drawn/traced sprites. Final method: his 13 Firefly strips (`design/references/Strips`)
  are sliced 1:1 by `art/strips.py` (background removal, per-strip uniform scale, ground-line alignment, 16-colour
  quantisation, no artistic edits) → `art/walder.json`: stand 72×72, sleep 61×58 (incl. baked "z z"), decorations from
  the strips. Known 1:1 artefacts: `out` fits at 0.66× (very wide illustration), idle frame 3 is larger (breathing
  "pulse"). happy/worried/exhausted alias idle until Victor's expressions strip arrives (one-line change in strips.py).
  `frames.mjs` retired to `art/obsolete/`. Design canvas v3 published (same artifact URL).
- **M6 review fixes:** Windows asar shipped the whole repo (platform `files` replaces global) → fixed + `check:asar`
  guard in `postdist`; README leads with Privacy & Security → Open Anyway (macOS 15+); Windows marked untested;
  Remove-hooks tray item + confirmation dialogs; gallery gets deny-all permissions; asar slimmed (node-gyp tree out).
- **Integration:** sheet-driven everything (no 64/40 constants), baked decorations not double-drawn, auto head crop
  for icons, sizes Small 72 / Medium 144 (default) / Large 216 px (Large exceeds the recommendation, documented).
- **Installers:** `release/Walder-0.1.0-mac-arm64.dmg` (127 MB), `release/Walder-0.1.0-win-x64.exe` (107 MB), both
  pass `check:asar`; packaged mac app launched and logged `fullscreen watch armed` + both polls. 927 tests.
- **Next:** Victor installs on Mac, logs into claude.ai/chatgpt.com via tray Accounts, installs hooks, runs
  `docs/QA-CHECKLIST.md`; Windows try-out; expressions strip; possibly regenerate `out` and idle strips.

## 2026-09-08 — 0.1.1: first live QA by Victor → login + fullscreen fixes

- **Login windows failed (Victor):** (1) ChatGPT login succeeded but was never registered — main-process `session.fetch`
  sends NO cookies unless `credentials:'include'` → fixed in `http.ts`/`provider-chains.ts`. (2) Claude "Continue with
  SSO" hung — Anthropic's enterprise SSO goes through `api.workos.com` → `login.microsoftonline.com`, not on the old
  allowlist; iframes (Cloudflare, IdP widgets) were blocked too. **Policy change:** the login window (sandboxed, no
  preload) may navigate to ANY https host except loopback; non-https denied; popups re-locked; host trail logged.
  Chrome-equivalent UA on both partitions. Detection fallbacks `/api/account`, `/backend-api/me`. Accounts submenu shows
  last-check result (no identity).
- **Fullscreen never detected (Victor, Chrome+YouTube):** live probe recordings showed `get-windows.activeWindow()`
  returns Chrome's hidden toolbar strip (1728×115) in fullscreen; the content window (1728×1084 @ y=33) sits 33 px
  (menu bar) short of the top; and 3 consecutive `undefined` during the Space transition tripped the permanent
  `broken` flag. Fixes: decide over ALL windows of the frontmost app (`openWindows`), relaxed rule (full width, reaches
  display bottom, top gap ≤ 44 px), failures are "unknown" with 10 s hold + backoff, never permanent; state transitions
  logged at INFO. Known accepted false positive: Dock hidden + maximised window reads as fullscreen.
- 1012 tests. Installers `release/Walder-0.1.1-*` rebuilt, check:asar ok; published to GitHub release v0.1.1.

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

## 2026-09-09 — 0.1.1 live on Victor's Mac: logins OK, numbers match the dashboard; 0.1.2 follow-ups

- Victor confirmed: both logins register, 5-hour and 7-day match claude.ai's dashboard, dog renders from his strips.
- claude.ai response carries `nimbus_quill` (0 %, no reset) — not a usage window → dropped (unknown key + no reset + no
  usage). Dashboard shows a "Fable" weekly row equal to All models (shared pool) → Walder synthesises a derived
  "7-day Fable (shared pool)" row from `seven_day` when no `/fable/i` key exists; derived rows never bark.
- Victor request: petting triggers a manual refresh (60 s cooldown enforced by the poller).
- 1033 tests; `release/Walder-0.1.2-mac-arm64.dmg` published as v0.1.2 (mac only; Windows still untested).

## 2026-09-09 — user handbook (`docs/HANDBOOK.html`), and the expression-art gap it exposed

- **New:** `docs/HANDBOOK.html` — a single self-contained page for someone who has never run Walder:
  install (incl. the macOS 15 **Open Anyway** route), logins, the hooks, the face/percentage bands, the bark
  thresholds and wording, the four bubble kinds, sleep/wake, the full 22-animation dictionary with every sprite
  playing at its real tempo from `art/out/golden/*@3x.png`, the menu item by item, troubleshooting, and an
  arbitration appendix. Regenerate with `python3 docs/handbook/build_walder.py` (content in `build_walder.py`,
  widgets in `walder_parts.py`, chrome in `handbook.py` from the handbook-builder skill). Also published as a
  private Claude artifact.
- **Gap the handbook had to document as-is — fix next session.** `[6]` of `art/out/CHECK.txt` says it plainly:
  `neutral=idle_0  happy=idle_0  worried=idle_0  exhausted=idle_0`. All four per-mood idle loops point at the
  same four frames, so **anything under 95 % looks identical on screen** — no grin, no ears-down, no sweat bead.
  `expression.ts` and the sheet contract are ready for the poses; the thirteen strips contain no worried or
  panting dog, so `strips.py` has nothing to fit. Consequences:
  1. the handbook tells the reader to trust the hover card, not his face, below 95 % — that instruction should
     be removed once the art lands;
  2. `docs/QA-CHECKLIST.md` **5.3 is currently unpassable as written** ("worried (ears down, sweat bead)"); it
     should either be relaxed to "no visible change below 95 %" or left failing on purpose until the poses exist;
  3. `ear_flop`, `walk`, `tail_wag` and `hop` are drawn, validated and triggered by nothing in the app — spare
     vocabulary, documented as such rather than as bugs.
- **Next (art):** draw three new strips — a happy/grinning idle, a worried idle (ears down, and a sweat drop if
  the coat allows one), an exhausted/panting idle — then map them in `strips.py` so `idle_happy` /
  `idle_worried` / `idle_exhausted` stop aliasing `idle_0…3`. Nothing in the code changes; `pickAnimation`
  already prefers `idle_<expression>` when the sheet has it.

## 2026-09-09 — stage E: mirroring, the app-drawn decoration layer, and the tray bone

- **Why he can turn now (owner request 5).** Every strip is drawn facing left, so "look at the screen
  instead of off the edge" can only be a horizontal mirror. New pure `src/core/facing.ts` owns the
  decision — `facingFor(dogCentreX, displayBounds, previous)` with a **4 % dead band** around the
  display centre, so a dog dragged across the middle turns exactly **once** and a window nudged by a
  re-clamp or a bubble widening never turns at all. Main decides (only main knows which display the
  window is on): `syncFacing()` in `overlay-window.ts` runs at all five move chokepoints — creation,
  `reclamp` (which also covers `display-metrics-changed`, where the screen resizes around a stationary
  dog), `resize`, `resetPosition`, `dragMove` — and pushes `walder:facing:set` only on a change.
  `currentMode()` carries `facing`, so the first paint is already right; preload gains `onFacing`; the
  renderer validates with `isFacing` and keeps its current facing on junk.
- **The flip is at the blit, and the queries are mirrored, not the art.** `FrameRender.mirrored`
  does `translate(w,0); scale(-1,1)` inside `renderFrame` — an exact integer reflection at any DPR, and
  deliberately **not** part of the raster cache key, so one bitmap serves both directions. There is still
  exactly one alpha mask per frame, in art orientation: `onInk` reflects the cursor's column into art
  coordinates (`mirrorLogicalX`, after the `OFF_SPRITE` check so a near-miss keeps its grab slack on the
  correct side), and `drawHitOutline` / `spriteRectScreen` reflect the silhouette bounds so the debug
  outline and the hover card follow the flipped body. Never mirrored: bubble text, the bubble tail,
  `spriteOrigin`, `boxMetrics`, every clamp.
- **Decoration layer, with the one rule that differs from the plan (orchestrator's call).** The app draws
  a decoration **only where the sheet declares an anchor** — there is no default above-box anchor. Today's
  art still has the `?` and `z z` painted into `tilt_2`/`sleep_2`, and a default would draw a second one
  beside them, in the speech-bubble reserve, where it collides with a bark bubble's tail. Sheet schema
  therefore gains top-level `decorAnchors: {animation: {decor: {x, y}}}` — sprite px, art orientation,
  validated to name a real animation, to name a decoration that is *both* a box and a drawable animation
  of that box, to be whole pixels, and to fit **inside** the animation's box. `SpriteSheet.decorAnchors`
  is always present (`{}` on every sheet drawn so far). `contract.ts` keeps the three baked tables exactly
  as they were and adds `APP_DECOR_BY_FRAME` (`tilt_2 -> qmark`, `sleep_2 -> zz`), `BUBBLE_AS_DECOR`
  (`waiting -> qmark`, i.e. the `?` bubble is *replaced* by the sprite), `visibleDecors`,
  `decorAnchorFor` and `bubbleIsDrawnAsDecor`. **Net effect on screen today: nothing changes.** When
  stage A's glyph-less strips and `strips.py` anchors land, the same code starts drawing the glyphs
  itself, un-mirrored. The migration story is written into the doc comments in `contract.ts`.
- **Mirroring is DORMANT until stage A, and the sheet is what says so.** `mirrorReady(sheet)` in
  `contract.ts` is true only when, for every entry in `APP_DECOR_BY_FRAME`, at least one animation plays
  that frame *and* every animation that plays it anchors every one of its decorations. The overlay draws
  with `isMirrored(facing) && mirrorReady(sheet)` (memoised once per sheet load, in `setSheet`) and uses
  that one value for the blit, the decoration anchors, `onInk`, `spriteRectScreen` and the debug outline,
  so the picture and the hit test can never disagree about which way he is facing. Today's `?` in `tilt_2`
  and `z z` in `sleep_2` mirror *with* him and come out backwards — a worse bug than facing off the edge —
  so on both shipped sheets this is `false` and nothing on screen turns. When the glyph-less strips and
  their anchors land it becomes `true` on the new sheet and the mirror switches on by itself: no code
  change, no flag to remember. A half-migrated sheet (`tilt` anchored, `sleep` forgotten) stays
  un-mirrored rather than showing one correct glyph and one reversed one.
- `drawDecorations()` sits between the dog blit and the bubble: first frame of the decoration's own
  animation, `mirrored: false` (a reversed `?` is not a question mark — only its *anchor* flips, via
  `mirrorAnchorX`), positioned in whole `pixelScale` units from the dog's device origin so it is locked
  to his pixel grid, riding the pet bob, and **not** part of the hit mask.
- **Gallery** (`npm run sprites`): a "mirror (faces right)" checkbox that flips every card the way the app
  does, plus the anchored decorations drawn on the frames the app would draw them on. A card's canvas is
  now the union of its box and any anchored decoration rect (identical to the box while anchors stay
  in-box — computed as a union so a decoration hanging off the box can never be silently clipped).
- **Tray bone (owner request 6).** The 16x16 grid moved to `scripts/tray-bone.ts` and is now the plan's
  bone: rows 4–11, columns 1–14, a 2-px shaft, two lobes per end with a notch between them, and one
  column of inset so the Windows outline is not clipped. All four PNGs regenerated; read at 1x, 2x and
  at 16x — it reads as a bone, not a dumbbell. `test/tray-bone.test.ts` pins the shape properties
  (square, symmetric both ways, shaft ink per column at most half a lobe's, notch present, no border ink)
  rather than the pixels, so a redraw is free and a redraw that stops looking like a bone is not.
- **Tests 1033 → 1088** (all green; typecheck and `npm run build` green). New `test/facing.test.ts` and
  `test/tray-bone.test.ts`; `sprites.test.ts` gains the `decorAnchors` validator cases; `sync-sheet.test.ts`
  gains an app-drawn-decoration block. The baked-glyph tests there are **deliberately not inverted** — the
  art has not changed — so the new path is exercised through a temporary fixture,
  `test/fixtures/decor-anchor-sheet.ts`, which is to be deleted once `art/walder.json` carries anchors.
- **A human must still verify (packaged app, Victor):** drag him across the middle of the screen — he
  turns once, no flapping; click-through still lands on his flipped ink; the hover card anchors to the
  flipped body (it will now usually appear on his right when mirrored — expected, eyeball it); a mid-drag
  flip leaves the cursor briefly off ink (drag suppresses verdicts, so the drag must not drop); the tray
  bone at 1x and 2x on a real menu bar. The `?`/`z z` anchor checks in the plan's stage-E list cannot be
  run yet — the sheet declares no anchors, so there is nothing on screen to look at until stage A.

## 2026-09-09 — stages F–H: hide-when-idle presence, the global shortcut, and the update check

Three of the owner's seven 2026-09-09 requests, built in one worktree (`stage-GH`) while stage E did the
renderer. Plan: `~/.claude/plans/structured-chasing-sparrow.md` §F–H, implemented in its own H9 order.
**1033 → 1188 tests** (1175 on the first pass, 1188 after the review fix round at the end of this entry),
typecheck and `npm run build` green.

- **G1 — presence lives inside `Behaviour`, not in an observer.** New `SceneEvent {type:'visible', shown}`,
  `LINGER_MS = 8_000`, `setHideWhenIdle(on, now)`, `hidden` / `hideWhenIdleEnabled`. Three states documented
  in the class header (VISIBLE-BUSY → LINGERING → HIDDEN), `attention()` at the `wake()` and `pushExpression`
  chokepoints, `settlePresence()` as the last step of `settle()`, and `nextDeadlineAt()` now the min of the
  bubble ttl and the linger — so the single timer in `main/behaviour.ts` still covers everything.
  Deliberate details: turning the mode ON with nothing to say hides **immediately** (the linger is
  pre-expired, because a keypress must act now); `attention` emits its own `play:wake` when `wake()` had
  nothing to do, since a hidden dog is normally a hidden *standing* dog; and `mode`/`play` always precede
  `visible:true`, so the resize happens off screen.
  One decision beyond the plan: the **first** face of a run counts as a change, so launching with an expired
  login shows the confused dog once. Suppressing it would have left the mode's worst case — an invisible
  broken Walder — exactly as unreported as before.
- **G2/G3 — the window and the renderer.** `Overlay.setVisible`/`isShown` behind a `wantShown` + `ready` pair:
  a `visible:false` that arrives before `ready-to-show` suppresses the initial show outright rather than
  hiding a window that already flashed. `showInactive` only, never `show`/`focus`. `main/behaviour.ts` gains
  `hideWhenIdle()`/`onHidden()` and applies the stored preference **as a setter call** (the constructor option
  alone would leave him up for one linger at every launch). `visible` is acted on *and* forwarded — the
  renderer stops its own animation timer, which nothing else would, because `backgroundThrottling: false`
  keeps a hidden window ticking at full cadence — and drops the hover state, because a hidden window sends no
  `mouseleave`. `index.ts`: one `setHideWhenIdle(on)` for the checkbox and the shortcut, and both
  `second-instance` and `ensureOverlay` now consult `behaviour.isHidden()` instead of re-showing a
  deliberately hidden dog.
- **F/G6 — the shortcut.** `core/shortcuts.ts` holds eight vetted presets, each with a `darwin` and an
  `other` accelerator so `Command` never reaches Windows and `Control+Alt` (= AltGr on the Danish layout)
  never does either. Defaults per the owner's decision: **⌃⌘W** on macOS, **Alt+Shift+W** on Windows,
  knowing Alt+Shift is the input-language switch there — README notes it in one line and points at
  `Shift+F9` / `Ctrl+Shift+F12`.
  **Smoke test on this Mac** (throwaway Electron script, `globalShortcut.register` on each candidate): all
  eight presets returned `true`; `Super+W` registered but **`Control+Super+W` was REFUSED on macOS too**, and
  `isRegistered()` then lied and said `true` — so `Super` is excluded on both platforms, not just Windows,
  and `looksLikeAccelerator` rejects it outright.
  `main/shortcut.ts`: try/catch around `register` (a malformed accelerator throws rather than returning
  false), `false` → `'in-use'` with **the setting kept** and one `warn`, release-before-re-register (otherwise
  re-applying the same combination reports itself as in use), `dispose()` on `will-quit`, and a failure that
  never blocks startup.
  Beyond the plan: on Windows the default preset and the explicit `Alt+Shift+W` one are the same keys, so
  `shortcutPresetsFor(platform)` de-duplicates — two radio items with one accelerator would both show a dot.
- **G5 — settings.** `hideWhenIdle:false`, `hideShortcut` (platform default), `checkForUpdates:true`,
  `updateNotifiedVersion:null`. **Neither string is constrained in the JSON schema**, and a test asserts the
  absence of `pattern`/`minLength`/`enum`: `clearInvalidConfig: true` wipes the *whole* settings file on any
  schema failure, so a pattern on the shortcut would cost the owner his position memory, size and coat. The
  validation is `readHideShortcut()`, exactly as `readSize()` does it.
- **G4/H4/H5 — the menu.** `Hide when idle` (checkbox, `accelerator` for display, `registerAccelerator:false`)
  and `Shortcut ▸` (radios, a disabled `Custom: …` row for a hand-edited value, a disabled status line only
  when registration failed). `Claude 5-hour: 63% used` under the header **while the mode is on only** — with
  the dog hidden there is no face and nothing to hover, so that line is the mode's entire compensation;
  `Claude 5-hour: ?` when there is no number, never `0% used`. Update block above `Quit`: the four-state
  `updateMenuLine` item plus `Check for updates automatically`. Final order per plan H5.
- **H1/H2 — the update check.** `core/semver.ts` (strict and total: the version comes out of a remote API
  response) and `core/update-check.ts` — 6 h interval, 60 s first-check delay so it is not in the launch
  burst, 1 h retry floor, 10 s timeout. **The one security rule: `html_url` from the API is pinned to
  `https://github.com/ViuMP/walder-releases/` and anything else falls back to the releases-page constant**,
  because `shell.openExternal` hands a URL to whatever the OS registered for its scheme. `index.ts` checks the
  same prefix again at the point of use and holds the only `shell.open*` call in the app.
  `main/update-check.ts` is Electron-free like `poller.ts`: one timer off `nextCheckAt`, the injected
  `fromFetch(net.fetch, 'omit')` adapter (timeout, 1 MB cap, `redirect: 'manual'`), and every failure a `vlog`
  + `failed` state — **never a `warn`**, since offline wifi and GitHub's rate limit are not things the owner
  can fix, and the log file he is asked to send must not be full of them. A test asserts `console.warn` is
  never called across a 403, an HTML page and a timeout.
  Wiring detail worth keeping: `updateNotifiedVersion` is written **before** `behaviour.onUpdateAvailable`,
  so a crash between the two costs at most one un-shown notice rather than repeating the bubble for the whole
  life of that version.
- **H3 — the fifth bubble kind.** `BubbleKind` gains `'update'` and `updateText(v)` = `"0.1.3 is out"`; queued
  behind everything (a hook's bubble splices in *front* of it), one at a time with the latest version winning,
  12 s, perk animation, outranked by a bark and not re-queued afterwards. `contract.ts`'s `BUBBLE_DECOR` is a
  `Partial<Record<…>>` so it needed no change, and there is no exhaustive `switch` over `BubbleKind` anywhere.
  **`docs/HANDBOOK.html` still says "four bubble kinds" and needs regenerating** (`python3
  docs/handbook/build_walder.py`) — not done here, it is the art stages' script.
- **H6 — `npm run release`** (`scripts/publish-release.ts`): `execFileSync` with argv arrays only, imports
  `UPDATE_REPO` from core so app and script cannot drift, refuses to publish without installers for *this*
  version (`release/` accumulates, and an old `.dmg` on a new release is a download that installs the wrong
  build), never uploads `latest-mac.yml` / `builder-debug.yml`, never `--generate-notes`, stops on an existing
  release unless `--clobber`, and detects an empty release repository with the two commands that fix it.
  `-- --dry-run` prints the `gh` command. **Not run against GitHub** — the repo does not exist yet
  (owner action: `gh repo create ViuMP/walder-releases --public` plus one commit).
- **H7 — docs.** README: the fourth intro bullet, a new "Hiding him until he has something to say" section
  (six triggers, the 8 s linger, pet resets it, no hover card while hidden, the menu percentage line, both
  platform defaults, the Alt+Shift caveat and the collision-free alternatives, what "already used by another
  app" means), `api.github.com` added to Privacy with the opt-out, a rewritten Updating section, two new
  Troubleshooting rows, `npm run release` in the developer table, and three new `src/core/` entries.
  `docs/QA-CHECKLIST.md` §9 (20 rows, 22 after the fix round) plus three new "could not verify" entries.

### Review fix round (same day, eight items)

A review of the above found three real bugs and five smaller things. Where a fix contradicts a bullet
above, the bullet describes the first pass and this describes the code.

- **The expression path did not reconcile the box** (`core/behaviour.ts`). `pushExpression` called
  `attention()` directly, and `attention` never touches `currentBox` — so with the mode on, a film playing
  and the dog curled up and hidden, a face turning *confused* emitted `play:wake` + `visible:true` while the
  box was still `sleep`: a stand-box animation inside the tiny sleeping window, on top of the video, which
  `wake()`'s own comment forbids. Now routed through a new `askForAttention()` → `wake()` (box, stretch,
  show) when he is hidden, and to plain `attention()` otherwise — a *visible* dog must not stand up and sit
  back down mid-film.
  That exposed the second half: `settle()` put him straight back to sleep in the same batch. So **presence is
  now decided before the box, not after it** (`settlePresence` moved ahead of the box block) and `wantsSleep`
  gained `lingerUntil === null`. The rule that falls out is uniform and simpler than what it replaced: **a
  dog on screen in this mode is a dog standing**; he curls up *as he leaves*, in the batch that hides him
  (`visible:false` first, then `mode:sleep`, so the resize is behind a hidden window). This changed one
  existing behaviour on purpose — a bark that ends mid-film used to curl him up immediately and linger
  asleep; QA 9.20 was rewritten and 9.21 added.
- **The launch `visible:false` never reached the renderer** (`main/ipc.ts`, `overlay-window.ts`,
  `renderer/overlay.ts`). It is emitted synchronously inside `createBehaviour`, before the page loads, and
  `ipc-bridge` replays only the sheet — so a Walder launched with the mode on animated an invisible dog at
  full cadence for the whole session (`backgroundThrottling: false`), and a renderer rebuilt by
  `ensureOverlay` did the same. Presence is now *state* on `ModePayload` (`hidden: boolean`, from
  `Overlay.isShown()`, i.e. `Behaviour.hidden` at one remove), carried by both `settings:get` and every
  `mode:set`, and `applyMode` feeds it through the same `applyScene({type:'visible'})` path as the event —
  which is idempotent, so the repetition is free.
- **`visible:true` landed before the bubble** (`core/behaviour.ts`). The window grows for a bubble and
  resizes for a box, both in main, so showing it first meant one frame of a narrow, bubble-less dog.
  `attention` now records `pendingShow` and `settle` flushes it as the **last** event of every batch;
  `settlePresence` drops a `visible:false` that would cancel an unflushed show, which is what keeps the
  "never two identical `visible` in a row" invariant true by construction.
- **`--dry-run` reached the network** (`scripts/publish-release.ts`). `gh auth status`, the empty-repo
  `gh api` probe and `gh release view` all ran *before* the flag was consulted — so the flag you type when
  you are not sure could die on "you are not signed in" without ever printing the command it was asked
  about. The steps are now planned up front by a pure exported `ghPlan()` (a dry run's plan is one local
  call, `gh --version`), `main` runs only what the plan names, and every local check comes first.
- **The disabled update check overwrote an `available` state** (`main/update-check.ts`). The skip assigned
  `state` directly, past `publish()`, so a six-hour wakeup after finding 0.1.3 reverted the menu to "Check
  for updates now" with the update still un-installed. `state` is now left alone and the timer re-armed with
  an explicit due time — necessary, because `nextCheckAt({kind:'never'})` is already in the past by then and
  would have spun the timer at 1 ms for the rest of the run.
- **`checkNow()`**: a click that lands while a check is in flight returns `false` **without stamping the
  cooldown** (charging a minute's wait for a click that did nothing, with nothing in the menu to explain
  it). And it now runs the request **regardless of the on/off setting** — the owner asked in so many words,
  and the setting is about traffic Walder starts on its own. README's two "no request, ever" sentences and
  QA 9.19 were amended to say so.
- Nits: `tray.ts` names the `wait + 100` menu-rebuild slack (`COOLDOWN_REBUILD_SLACK_MS`); the `html_url`
  pin gained the four hostile cases it was missing (`javascript:`, scheme-relative `//github.com/…`, an
  uppercase `HTTPS://GITHUB.COM/…`, and the `walder-releases.evil` lookalike the prefix's trailing slash
  exists for).

**What a human still has to verify** — all of it is in QA §9, and three items are things no build session
could reach: (1) **the accelerator glyphs actually rendering in a tray menu** — `⌃⌘W` on macOS and
`Alt+Shift+W` on Windows are set as `accelerator` with `registerAccelerator:false`, which is unit-asserted,
but nobody has ever seen a Walder menu; if a platform does not draw it, the fallback is the label text;
(2) **the shortcut firing while another app has focus**, and the "already used by another app" path, which
needs a person at a keyboard; (3) **the real GitHub call and `npm run release`** — the checker has only run
against `test/fixtures/github-release-latest.json` and a stubbed `HttpFetch`. And, as ever, **everything on
Windows**: the `other` half of every preset, the Alt+Shift language-switch clash, and whether `Alt+Shift+W`
is usable at all there.

**Follow-up 2026-09-10 — the empty releases repo read as a permanent failure.** The first real call to
GitHub found the one case the fixture could not: `ViuMP/walder-releases` exists and is public but has
published nothing, and `GET /releases/latest` answers **404** for that. The shared `classifyHttp` maps 404
to `endpoint-changed`, so the check recorded `{kind:'failed', detail:'HTTP 404'}` and the tray read "Last
check failed (hh:mm)" forever — a lie about a healthy app with nothing newer to install. Fixed in the pure
layer: `core/update-check.ts` gains `NO_RELEASES_STATUS` and `isNoReleasesResponse`, and `main` consults it
*before* `classifyHttp`, publishing `up-to-date` and logging `no releases published yet`. The special case
is deliberately narrow — 404 only, not redirected, not truncated, and the body must be GitHub's JSON object
(a captive portal's 404 sign-in page stays a failure) — and it lives **only** on this endpoint: a 404 from a
usage provider still means the API moved. GitHub returns the same 404 for "no releases" and "no such repo";
the ambiguity is accepted because the repository is a compile-time constant shared with
`scripts/publish-release.ts`. New QA row 9.15a covers the pre-first-release state.

## 2026-09-09 — stages A–C: the art pipeline for the v4 strips, the mood blinks, and the dapple coat

Owner requests 2, 3 and 4 (missing expressions, dapple coat, a less distracting idle) are all one change
to `art/strips.py` plus a scheduler change and a sheet-schema change. **The v4 strips do not exist yet** —
Victor is generating them one at a time — so every piece below had to work *before* and *after* they land,
and be testable in both states.

- **The transitional rule, and the diff that proves it.** With an empty `v4/` tree the pipeline reproduces
  the 0.1.2 sheet: the legacy 4-frame idle plus the legacy blink strip, today's timings, the legacy
  `tilt`/`sleep` with their baked glyphs and **no `decorAnchors`**, and the three mood idles aliasing
  `idle`. `diff` against the pre-change `art/walder.json` is **one hunk — the removed `ear_flop` block**
  (15 lines) and nothing else. `ear_flop` was an alias of `idle_rare` referenced by nothing but a stale
  gallery comment and one handbook card; both are gone, and `docs/handbook/build_walder.py` would have
  crashed with a `KeyError` had the card stayed (it reads the sheet directly), so `HANDBOOK.html` is
  regenerated — a 2-line diff.
- **A1 — three tables instead of one.** `SOURCES` (1 strip = 1 animation, hard-coded count) is replaced by
  `STRIP_FRAMES` (how many dogs are in a strip), `SET_DIRS`/`LEGACY_SOURCES` (which file, per coat set) and
  `ANIMATIONS_*` (which frames in which order at what tempo) — **the only source of timing**, replacing
  `TIMING`. Build-time asserts, before a pixel is read: every `"strip:index"` reference is in range, every
  resolved strip is used by at least one animation, no animation is both `loop` and `hold`. Frame *order* in
  the JSON is deliberately 0.1.2's, so a reordering cannot hide a real change in a whole-file diff.
- **A2 — one strip, three animations.** The six-frame idle strip yields `idle` = `[0,1,2,1]` @ 375 ms (a
  1.5-second lap, three times slower than 0.1.2 — the lap time *was* the distraction; there-and-back because
  a saw-tooth reads as a twitch), `blink` = `[3,4,3]` @ 83 ms (symmetric so it splices back without a pop,
  both frames drawn at rest so the chest does not jump) and `idle_rare` = `[0,5,5,0]` @ 125 ms. All three
  from ONE image, so they can never disagree about what the dog looks like — which is the bug the old
  separate blink strip had.
- **A3 — decoration provenance is now explicit, and checked.** The standalone `?` and `z z` are pinned to
  the LEGACY `tilt`/`sleep` illustrations for good (loaded decoration-only: frames not emitted, excluded
  from the common scale), because the regenerated strips deliberately do not draw them and there is nowhere
  else to get them. `--report` lists every non-dog component per frame, and a **v4** strip outside
  `EXPECTED_DECOR = {pet, idle_worried, bark, out, wake}` that carries one **fails the build**. That is the
  point: `tilt` and `sleep` are being redrawn precisely to remove a glyph, so they are where Firefly is
  most likely to put it back, and a baked `?` is mirrored backwards on half the screen with nothing in any
  log. Legacy strips are reported but never failed — they are the approved 0.1.2 art, glyphs and all.
- **A4 — `SLEEP_DECOR_HEADROOM_ROWS = 18`,** added only when the sleep strip is glyph-less. The fullscreen
  sleep window is sized from the sleep box and has no reserve of its own, so removing the drawn `z z` would
  shrink the box to ~61x40 and leave the app's own `z z` nowhere to go. Eighteen rows is exactly what the
  owner's glyph occupied, so the box stays 61x58 and the picture is identical either way. Padding a strip
  that still *has* the glyph would grow the box to 76 rows and float the dog, hence the condition.
- **A5 — anchors by arithmetic, not by hand.** New `--measure-decor` reports where the owner's own baked
  glyphs actually sat (the `?` at rows 10–21 / cols 24–31 of `tilt_2`; the `z z` at rows 14–29 / cols 43–64
  before the sleep crop) and converts that into two numbers per glyph in **dog-size units** — the offset
  from the reference frame's centre-of-mass column and topmost ink row to the glyph's top-left, in multiples
  of `k`. Those seeds are `DECOR_ANCHORS`; `decorAnchors` in the sheet is derived from them, so the file's
  "no per-frame hand-tuning" principle holds and the anchors survive a box change or a new coat set. They
  are emitted **only for glyph-less strips**, which is the whole migration in one condition: no anchor means
  `mirrorReady` stays false and stage E's mirror stays off while the glyphs are still in the art.
- **B1/B2 — the moods blink, in their own faces.** Each five-frame mood strip yields `idle_<mood>` @ 375 ms
  and `blink_<mood>` @ 83 ms. `src/core/anim-schedule.ts` is now **name-derived**: `blinkFor(base, has)`
  maps `idle` → `blink` and `idle_<mood>` → `blink_<mood>`, `rareFor` stays on the neutral idles (moods
  blink but never ear-flick — a worried dog flourishing is a mixed message), `idleExtras(base, has)`
  returns the pair of names and `canInterject(base, has)` is "either is non-null". `INTERJECTABLE_LOOPS` is
  deleted: `sleep`/`out`/`confused` are excluded by not being idle loops, rather than by a list somebody has
  to remember to update. This is what fixes the handbook's finding — three of the four healthy moods were
  unblinking stares, because the one blink was drawn from the neutral pose and playing it over a worried
  face would have read as him cheering up and back.
- **A bug found while doing it: `onIdleLoop` now ARMS an unarmed blink.** `initIdle` runs once, when the
  sheet arrives, and whether a blink exists depends on which mood is running. A dog who happened to be
  worried at that moment got `blinkDueAt: null` and kept it — so he never blinked again in *any* mood for
  the rest of the session. The timer is now a property of the loop that is actually running.
- **C1/C5/C6 — the dapple coat is a frame SET, not a palette.** A palette remap cannot express irregular
  black blotches, so the sheet grew `frameSets` (a complete alternative drawing of every frame),
  `paletteFrameSets` (`silver-dapple` → `dapple`) and a `silver-dapple` palette, placed LAST so it is last
  in the Colour menu and emitted only when its set was actually built. Both default to `{}` so every
  earlier sheet validates unchanged. `parseFrameSets` runs each set through `parseFrames` and then insists
  the sets are *interchangeable* — exactly the base set's frame names (the message names the first
  missing/extra one), in the same boxes, at the same dimensions — because the coat switcher swaps sets
  mid-animation and keeps the frame index. `framesFor(sheet, palette)` in `contract.ts` is the one call
  every renderer makes instead of reading `sheet.frames`; unknown coat → the base set.
- **C2 — one scale across every coat.** A single global `k`/`anchor_x` over all present sets, so the dog is
  the same on-screen size in both coats; the sleep box is the union across sets plus the headroom; and every
  frame's tight bounding box is compared with the base set's, **warn above 3 %, fail above 5 %** (a check
  that now runs on every build, not only under `--report` — it used to live inside the report function).
  The dapple set is skipped-with-reasons unless `--require-set dapple`, so golden work is never blocked.
- **C4 — the background detector is per set, and the golden set does NOT move.** A border-colour-keyed
  flood fill (median of the outer 8-px ring, OKLab tolerance 0.06 / 0.10 for the fringe) was added for the
  dapple strips, whose silver base coat the old "achromatic mid-grey" rule would eat as background — which
  is why their prompts ask for flat green `#3FA34D`. **Verified and it is not byte-identical on the legacy
  strips:** all 48 frames change, ~20,100 cells in total, and the `qmark`/`zz`/`sleep` boxes each grow a
  row. So per the plan's fallback, `legacy` stays the golden set's default (`BG_DETECTOR_BY_SET`) and the
  new rule is opt-in per set; `--legacy-bg` forces the old rule everywhere.
- **C3 — the `silver-dapple` ramp is SEEDS.** Read off Victor's reference photograph, marked as such in the
  code, and to be resampled (cluster medians over the first dapple `idle` strip) before the coat is called
  finished. It is also deliberately **not** monotonic in luminance: a dapple dog is cool silver, warm tan
  points and near-black blotches at once, and one luminance order would turn every tan brow grey.
- **The path casing is fixed.** `STRIPS = ROOT / "design" / "references" / "strips"` — lower case, as git
  tracks it. The old `"Strips"` worked only on this case-insensitive Mac; on a case-sensitive checkout every
  strip vanished and the build failed with "matched 0 files".
- **`art/render.mjs`** gains checks **[9]** frame-set parity, **[10]** palette → set (including an
  unreachable-set failure), **[11]** anchors in range; and renders every per-frame PNG, contact sheet and
  expressions strip **from the set its palette names** — so `expressions_silver-dapple@2x.png` really is the
  dapple dog. Verified `CLEAN` on both the legacy-only sheet and a synthetic two-set one.
- **`npm run sprites`** paints through `framesFor`, counts frame sets in its summary line, and gains a
  **"decoration anchors"** checkbox that crosses every declared anchor and flips it with the mirror — the
  anchors are the one part of the sheet nobody can check by looking at the result. `npm run sync:sheet` now
  prints the frame sets and the anchors, because a second coat is invisible in the frame count.
- **Testing the "after" path with no art: `art/tools/synth_strip.py`.** It lifts the dog out of a legacy
  illustration, stamps him N times onto a flat canvas (grey for golden, green for dapple), writes that into
  a throwaway `v4/` tree under `art/out/synthetic/`, points `strips.py` at it and asserts the result —
  **138 checks, CLEAN**: A2's tables and tempi, B1's per-mood pairs with no `idle_rare_<mood>`, the absence
  of `ear_flop` and of any separate-blink-strip frame, the 18-row sleep reserve measured off the emitted
  frames, every anchor in-box, a restatement of the app's own `mirrorReady` rule (so "the mirror switches
  itself on" is asserted rather than hoped for), frame-set name/box/dimension parity, the glyph sprites
  shared verbatim, and the border detector finding the green ground where the grey rule finds nothing at
  all. Worst cross-set bounding-box difference between the two fabricated sets, each on its own ground
  through its own detector: **0.0 %**. The fabricated PNGs never touch
  `design/references/strips/v4/` — that is the owner's drop box, and a fake dog in it would be
  indistinguishable from a real one.
- **Review round, 2026-09-10 — nine fixes, one real bug on screen today.** In order of what they cost:
  - **Walder stopped blinking in his default state.** `pickAnimation` answers `idle_neutral` for the
    middle usage band, `blinkFor` derived `blink_neutral` from it, and no sheet has ever carried one (the
    legacy table omits it deliberately — it would be the same two frames under a second name). So the one
    loop he is in most of the day was the one loop with no blink. Both `NEUTRAL_IDLES` now fall back to
    plain `blink`, mirroring how `rareFor` already treats them; asserted against the **real shipped
    `src/sprites/walder.json`** rather than a hand-written predicate, because a hand-written predicate is
    what let this through.
  - **A mood strip dropped on its own was taken for the neutral idle.** `"idle" in "idle_happy.png"`, so
    `find_in`'s fuzzy fallback silently swapped the base loop for the happy one at the wrong frame count;
    two mood strips made it "matched 2 files" and stopped the build. Substring matching may no longer
    cross a strip name: a name that is the beginning of another one requires the exact `<strip>.png`, and
    a file named exactly after some other strip is never a candidate.
  - **A `?` *touching* the dog passed every gate.** `EXPECTED_DECOR` only sees a detached component; a
    glyph welded to an ear is the same blob as the dog, so it was baked into `tilt_2`, the anchors were
    emitted anyway, `mirrorReady` flipped true and the app drew a **second** `?`. `check_glued_glyphs`
    now compares each v4 `tilt`/`sleep` frame against its own neighbours — top ink row more than 8 % of a
    dog-height above the lowest-topped frame, or bounding box more than 6 % over the strip's median — and
    fails naming the frame. It is a heuristic and says so, in the failure text and in `v4/README.md`: the
    tilt and sleep cards in `npm run sprites` are still the last word.
  - **`--require-set dapple` could not be satisfied.** While the golden idle is legacy, `resolve_set`
    also loads the separate legacy `blink` strip, and the readiness comparison then demanded a
    `dapple/blink.png` that cannot exist. A complete non-base set behind a legacy base idle is now its own
    state — "dapple is waiting for golden/idle.png" — and deliberately not a `--require-set` failure,
    because nothing in the dapple folder is wrong.
  - **A plain run now prints one summary block** (which strips fell back to legacy, which anchors were
    emitted, `mirrorReady: yes/no` **and why**), so dropping a strip has a report that is not eighty lines
    of `--report`; and `--require-set` is validated *first*, so a typo fails immediately with the valid
    names instead of quietly requiring nothing.
  - **Four holes in the harness itself.** Two assertions compared a constant with itself (the sheet's
    `expressions` echoing `S.EXPRESSIONS`; the golden detector's name) and now check the emitted sheet and
    the configured detector's behaviour, including that `expressions` covers exactly the six names
    `src/core/expression.ts` knows. The golden-only run asserts the *negatives* (no `frameSets`, no
    `paletteFrameSets`, no `silver-dapple` palette). The app's decoration table is **parsed out of
    `src/sprites/contract.ts`** instead of retyped, and `blink_1` is covered as well as `blink_0`. And A4
    is now pinned against the **real** legacy art: the glyph-less sleep dog plus the 18-row reserve
    measures exactly **61x58**, the box 0.1.2 shipped, so a v4 sleep pose that would resize the fullscreen
    sleep window is caught rather than discovered on screen.
- **Tests 1088 → 1136** (all green; `npm run typecheck`, `npx vitest run`, `npm run build`,
  `python3 art/strips.py --report`, `node art/render.mjs` → `RESULT: CLEAN` all green on the legacy-only
  tree). New `test/fixtures/frame-set-sheet.ts`; `anim-schedule.test.ts` rewritten around the derived names
  and the self-arming blink; `sprites.test.ts` gains the `frameSets`/`paletteFrameSets`/`framesFor` cases;
  `expression.test.ts` gains the `pickAnimation` cascade tests the plan flagged as missing;
  `sync-sheet.test.ts` gains a frame-set block over the real sheet. The baked-glyph and
  `decorAnchors: {}` tests there are **still not inverted**, and correctly so: the art has not changed yet.
- **What is DORMANT until the art lands.** `ANIMATIONS_IDLE_V4`, every `blink_<mood>`, all three
  `decorAnchors`, the whole `frameSets`/`paletteFrameSets`/`silver-dapple` path, the border-keyed detector,
  the cross-set size check, and — through `mirrorReady` — stage E's mirror and app-drawn glyphs. All of it
  is exercised by `synth_strip.py`; none of it is exercised by the shipped sheet. Nothing on screen changes
  today.
- **What a human must verify in `npm run sprites` once the strips land (Victor):** the idle lap looks
  *still* (this is the "less distracting" test, and 375 ms is a judgement call — say if it is now too slow);
  the blink splices in without a chest pop; worried and exhausted blink in their own faces rather than
  flashing neutral; `?` and `z z` sit where he drew them (turn on **decoration anchors** and check the
  crosses, then turn on **mirror** and check they flip to the other side of the head); the coat switcher
  shows the dapple dog at the same size as the golden one, and switching coats mid-animation does not make
  him jump; and the **golden gallery needs re-approving once** when the dapple set first lands, because one
  common scale across both sets can lower `k` slightly and re-quantise the golden frames. Also worth a look:
  `art/out/expressions_silver-dapple@3x.png` beside `expressions_golden@3x.png`.
- **Deferred, not done here.** `docs/QA-CHECKLIST.md` 5.3 still describes the old aliased moods, and the
  handbook's note that "all four mood idles are the same frames as `idle`" becomes false the moment the mood
  strips land — both are on the plan's own docs list, not stage A–C. The dapple ramp still needs resampling
  from real art.

## 2026-09-10 — Stage IV: the hover card in three sizes (W2 builder, 1363 tests)

- **Exists:** new pure `src/core/card-layout.ts` — `CardSize`/`CARD_SIZES`/`DEFAULT_CARD_SIZE='large'`,
  `isCardSize`, `CARD_WIDTH {large:300, medium:250, small:200}`/`cardWidthFor`, the `CardModel`
  (`header | sections[{sourceLine, statusLine, rows[]}] | footer`) and `cardRowsFor(snapshot, size, now)`.
  `SERVICE_LABELS` and `accountStatusLine` MOVED here from `tray.ts` (re-exported there, so the menu's
  import and `tray.test.ts` are unchanged): at Medium and Small the card has no source line, so its status
  note must name the service, and two copies of that wording would let the menu and the card disagree.
- **Content rules:** Large = today. Medium = no header, no source lines; bars and resets kept; a status note
  only when the source is not `ok`, in the menu's `Claude: login needed` form. Small = one line per window
  (`label  63%`), no bars/resets/`(shared pool)`/header/source.
- **Judgement call, flagged for the audit:** the plan specifies the muted age footer for Medium; I applied it
  to **Small as well**. Small has no header either, so without it a stale card would present unknown-age
  numbers as current — the rule the plan invokes when it asks for the footer at all. It appears only when the
  snapshot is stale or absent.
- **Renderer** `panel.ts` is now a painter with no data decisions in it (`paint(cardRowsFor(...))`,
  `#card[data-size]`), which matters because it is the one file vitest cannot reach (node env, no jsdom).
  `panel.html` gains per-size `--pad`/`--gap` blocks, `.section + .section` (and `.head + .section`) for the
  dashed rule that used to hang off the source line, and `.foot`.
- **Plumbing:** `CH.cardSizeSet` (its own channel — `usage:update` also feeds the bark machine),
  `SettingsPayload.cardSize` for the first paint, store key `cardSize` (schema: plain string, **no enum** —
  `clearInvalidConfig` would wipe the whole file; `readCardSize` validates), tray radio submenu **"Card size"**
  directly under "Size" (`applyCardSize`: store + dep + refresh, and deliberately NOT `onGeometryChanged`,
  which hides the card the owner is comparing sizes with).
- **`PANEL_WIDTH` removed** (callers use `cardWidthFor`); **`PANEL_MIN_HEIGHT` 40 → 24**: a one-row Small card
  measures ≈41 px and `parsePanelSizePayload` *drops* out-of-range payloads, so the old floor would have left
  the window at 220 px with a small card floating in it and nothing logged.
- **Two adjacent hover-panel fixes:** `hoverLeave()` now hides unconditionally (macOS `isVisible()` is false
  for an occluded window and true for one on another Space — it cannot answer "can the owner see this"), and
  `hoverEnter` no longer re-arms the 250 ms timer on a rect change. The renderer sends `hover:enter` on every
  frame that moves the ink, and `blink` (83 ms) / `tail_wag` (100 ms) both starved that timer indefinitely —
  the card never appeared at all while the dog was blinking.
- **Verified:** `npm run typecheck`, `npx vitest run` (1316 → 1363, +47), `npm run build` all green.
  New `test/card-layout.test.ts` (6 fixtures × 3 sizes) plus store / tray / ipc-payload / hover-panel updates.
- **Not done here:** the renderer has no DOM test and cannot have one — the three layouts must be *looked at*
  (QA §3.4a–3.4e). Small's dropped `(shared pool)` marker is a real information loss, documented in the README.

## 2026-09-10 — Stage V.1: permanent instrumentation for the full-screen card (1363 tests)

- **Exists:** `vlog('hover:enter', rect)` / `vlog('hover:leave')` in `ipc-bridge.ts`; in `hover-panel.ts`,
  `panel shown {isVisible, bounds, display, cursor, fullscreen}` after **every** `showInactive()`,
  `panel hidden` in `hoverLeave`, and `panel re-placed (already visible)` in the early-return branch.
  `createHoverPanel({isFullscreen})` is wired to `behaviour.isFullscreen()` in `index.ts`.
- **Why these four lines, and why they stay:** the failure ("the card does not appear over a macOS
  full-screen page") cannot be reproduced off the owner's Mac, and the three candidate causes are told apart
  *only* by which lines appear. No `hover:enter` at all ⇒ the renderer never saw the mouse on that Space.
  `panel shown` with `isVisible: true` and sane bounds, or a stream of `panel re-placed (already visible)`,
  while the owner sees nothing ⇒ the window was ordered in on the wrong Space (Electron's `isVisible()` is
  true for such a window, which is why app-side state cannot detect this).
- **Verified:** typecheck / 1363 tests / build green. The log *text* is not asserted — this suite installs no
  log sink, and `vlog` is silent unless Developer ▸ Verbose log is ticked.

## 2026-09-10 — Stage V.2: the full-screen experiment switch (1374 tests)

- **Exists:** pure `panelExperimentFromEnv(env) → 0..6` in `hover-panel.ts` (anything unparseable → 0, so a
  typo cannot silently arm a different experiment), read **once** in `index.ts` and passed to
  `createHoverPanel`. All six candidates are guarded by `isMac`: 1 re-asserts
  `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen, skipTransformProcessType})` + the level before each
  show; 2 omits `type:'panel'` (keeping `roundedCorners:false`); 3 pre-shows once at `ready-to-show` with
  `setOpacity(0) → showInactive → hide → setOpacity(1)`; 4 `moveTop()` after the show; 5 asks for
  `screen-saver` + 1; 6 = 2 and 3 together.
- **The test fake was rebuilt to record rather than swallow.** `setVisibleOnAllWorkspaces` now keeps its
  arguments and its position in the call order — it did not before, which is why the
  `{visibleOnFullScreen: true}` flag the whole feature rests on had never been asserted. It also records
  `setAlwaysOnTop`, `moveTop`, `setOpacity`, `once('ready-to-show')`, `webContents.send`, `getBounds`, and can
  be told to *lie* about `isVisible()` (the macOS reading that made the unconditional `hide()` necessary).
- **Verified:** typecheck / 1374 tests (+11) / build green. Every experiment is asserted for what it does
  *and* for the order it does it in; experiment 3 leaves `isShowing() === false`; the workspace flag is
  asserted at creation for all seven values.
- **Owner's part (QA §6.12):** run `WALDER_LOG=1 WALDER_PANEL_EXPERIMENT=<0-6> npm run dev`, hover the dog
  over full-screen Safari, and report which number shows the card plus the log lines around it.
- **Stage V.3 is NOT in this branch**, by instruction: it hard-wires the winner, deletes
  `panelExperimentFromEnv` and the env var, and pins the surviving calls — it waits for the owner's answer.

## 2026-09-10 — Stage I: the Claude window whitelist, and the key-dump diagnostic (W1, worktree `w1-whitelist`)

Owner requests 4 (hide unlisted usage trackers, "no Amber ladder") from the PART II interview. Built in
isolation from `main`, alongside a parallel hover-card builder touching different files.

- **The bug, exactly.** On 2026-09-10 the owner's account started reporting a fourth Claude key —
  `amber_ladder`, `{ utilization: 0, resets_at: <month-end> }` — beside `five_hour`, `seven_day` and the
  already-known `nimbus_quill`. `looksLikeWindow` (`src/core/buckets.ts`) was a *keep-by-default* rule: an
  unknown key survives if it has a reset time or nonzero usage, written that way so a genuinely new Claude
  window would appear without a Walder release. It did exactly what it was built to do, and the result was
  a permanently empty "Amber ladder 0%, resets in …" row sitting next to the 5-hour window the owner actually
  watches. A keep-by-default rule cannot tell a new *allowance* from a new *codename* — only a name can.
- **The fix inverts the policy.** `CLAUDE_WINDOW_MAP` (`five_hour`, `seven_day`, `seven_day_opus`,
  `seven_day_sonnet`, `seven_day_fable`, each with a label and a display priority) plus `KNOWN_PATTERNS` —
  `^seven_day_[a-z0-9]+(?:_[a-z0-9]+)*$` for a per-model weekly window Walder has never named, and `/fable/i`
  because `withDerivedFableRow`'s own contract says any spelling of a Fable key must win over the derived
  mirror — are now the **only** way onto the card. `isAllowedClaudeWindow(key)` decides; `claudeSpecFor(key)`
  supplies the label/priority for an allowed-but-unmapped hit, same humanising + substring-priority heuristic
  as before. `IGNORED_KEYS` (`nimbus_quill`) still short-circuits before the whitelist is even consulted —
  dropped silently, no log line, because it is already understood. Everything else that fails the whitelist
  is reported once through the new `ClaudeParseOptions.onIgnored` (shape only — a key name, whether it had a
  usage number, and a bare `YYYY-MM-DD` reset date, never the payload) and then dropped, same as before.
  `Bucket` gains an optional, currently-unused `kind?: 'window' | 'money' | 'credits'` — Stage III's type,
  introduced now so that stage does not have to revisit every place `Bucket` is threaded through.
- **The key-dump diagnostic (Stage II.1, pulled forward — it is value-free logging and belongs with the
  whitelist).** `src/main/usage-diagnostics.ts` (pure, Electron-free): `ignoredWindowLine` and `keySetLine`
  format the two log lines; `once` gates each to print a single time per run rather than once per
  three-minute poll. `provider-chains.ts` wires both into all three usage providers through module-level
  `once` closures mirroring `uaApplied`'s "once per partition, not once per poll" shape — `emitIgnoredWindow`
  dedupes on the key **alone** (the same unknown key from two Claude providers is one fact, not two);
  `emitKeySet` dedupes on `(provider, sorted key set)`, so a provider whose payload shape actually changes
  logs again. `ClaudeOauthDeps`/`ClaudeWebDeps` gained `onIgnoredWindow` and `onUsageKeys` (called with the
  sorted top-level keys of every payload that *did* parse); `ChatGptWebDeps` gained `onUsageKeys`, called
  only for the winning candidate — a dead candidate's keys are not evidence of anything. `npm run probe --
  keys` prints each provider's key names instead of bucket values (statuses/messages still print) — the same
  diagnostic without needing Developer ▸ Verbose log ticked in a build.
- **The ChatGPT side gets no whitelist** — the real chat-usage endpoint is still unidentified, so
  `walkForBuckets`'s whole job is discovery and a key allow-list would just be guessing at names nobody has
  confirmed. It does get a ceiling: `MAX_WALKED_BUCKETS = 4`, applied after sorting buckets-with-a-real-
  percentage ahead of ties, so an unfamiliar payload with a dozen usage-shaped fields cannot turn into a
  dozen unexplained "ChatGPT …" rows.
- **Tests 1314 → 1335** (`npm run typecheck`, `npx vitest run`, `npm run build` all green). Inverted
  `test/buckets.test.ts`'s two "keeps an unknown key…" cases into "drops an unknown key…"; added cases for a
  pattern-matched new model key, a codename that only *contains* "seven_day" failing the anchored pattern, the
  `onIgnored` shape contract, and the real 2026-09-10 shape (new fixture `test/fixtures/claude-web-usage-
  amber.json` — fake numbers, the real four-key set) reducing to exactly `five_hour`/`seven_day`/derived
  `seven_day_fable`, feeding `pctForFace` unchanged. New `test/usage-diagnostics.test.ts` (the three line
  shapes, `keySetLine` carries none of a real fixture's own values, both survive `redact` unchanged, `once`
  semantics). `test/providers.test.ts` gained `onIgnoredWindow`/`onUsageKeys` cases for both Claude providers
  and a `MAX_WALKED_BUCKETS` cap case for `chatgpt-web`. Every previously-passing assertion still passes.
- **What a human must verify (Victor):** with Verbose log on, `logs/` should show one `usage keys [claude-
  web]: …` (or `[claude-oauth]: …`) line per run, and — only if the account is still reporting a key Walder
  does not recognise — one `usage: ignoring unknown claude window "…"` line, neither carrying a percentage.
  And the card itself: Amber ladder (or any other unfamiliar row) should now simply not be there.

### 2026-09-10 — fix round (same worktree)

Five issues found reviewing the stage above, all fixed in place — no design change, no new file except tests.

- **`once` was consuming the key while verbose logging was off (the real QA 4.16 bug).** `once()` added a key
  to `seen` unconditionally and let `vlog`'s own no-op-when-quiet silently swallow the line — so ticking
  **Developer ▸ Verbose log** and pressing **Refresh now** never logged anything for a key already polled once
  while quiet, which in practice is every key, every time. `once(keyOf, emit, shouldEmit?)` now checks
  `shouldEmit()` *before* touching `seen`; `provider-chains.ts` wires both closures to `verbose` (the exported
  accessor already in `log.ts`, not a new flag).
- **The Fable pattern was a bare `/fable/i`**, which would have let a codename that merely *contains* the
  letters (`notfable_ladder`) ride onto the card the same way `amber_ladder` did before the whitelist existed.
  Anchored to `/(^|_)fable(_|$)/i`, matching the `seven_day_…` pattern's own anchoring logic: `fable_weekly`,
  `seven_day_fable`, `weekly_fable`, and (deliberately) `amber_fable` all pass; `notfable_ladder` and `fablex`
  are rejected.
- **A window key ≥20 characters is masked whole by `log.ts`'s `BASE64ISH_RE`**, quotes or comma or not — no
  separator placed *outside* a run of letters/digits/`_`/`+`/`=`/`-` can break characters *inside* it.
  `keySetLine` now joins with `', '` rather than `','` (stops two *short* keys from bleeding into one run when
  concatenated; does not and cannot rescue a single long key). Documented as a known, accepted limit in both
  functions' doc comments rather than papered over.
- **`IgnoredWindow.hasUtilization` is always `true`** from `parseClaudeUsage` — an entry with no readable
  utilization is dropped as malformed before the whitelist check that calls `onIgnored` is ever reached.
  Field kept (it is part of the shape `ignoredWindowLine` reports and future callers may need it), documented
  as reserved wording rather than something this parser currently emits `false` for; the buckets test for it
  is now explicitly framed that way instead of implying production can hit the false branch.
- **README overstated what shows up automatically.** The "new windows" sentence now says plainly that only a
  new `seven_day_<model>` weekly window or a Fable-named key is picked up without a release; anything else
  (a new 5-hour tier, say) is dropped from the card and only visible in the verbose log until a release maps
  it by name.
- **Tests 1335 → 1349** (`npm run typecheck`, `npx vitest run`, `npm run build` all green). New `once`
  `shouldEmit` cases (not consumed while off, emits once on the first call after it flips true, defaults to
  always-on with no third argument); a dedicated `isAllowedClaudeWindow` describe block for the five anchored-
  Fable cases; a `keySetLine`/`ignoredWindowLine` pair pinning the 20+ character limitation with the real
  `seven_day_claude_sonnet_4` (25 chars) key, plus a short-keys-concatenate regression case; a reframed
  `hasUtilization` test in `test/buckets.test.ts`. `test/login-window.test.ts`'s `../src/main/log` mock gained
  a `verbose: () => false` stub — `provider-chains.ts` (imported transitively) now reads it at module load.

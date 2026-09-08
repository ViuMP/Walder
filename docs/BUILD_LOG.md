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

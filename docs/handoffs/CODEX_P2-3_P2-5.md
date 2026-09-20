# Handoff to Codex — P2-3 (weekly posture) and P2-5 (one bark sound)

Written 2026-09-20 by the Claude session that built the P2 batch (PR #3, branch `p2-batch`).
Read `AGENTS.md`, then `CONTRIBUTING.md` ("Invariants", "Binding rules", "Checks"), then
`docs/CODENOTCH_GAP_ANALYSIS.md` §4 paragraphs P2-3 and P2-5, before touching anything.

## Where to work

- Branch **off `p2-batch`**, not off `main`: PR #3 is open and the tray, strings table and
  service list changed there. Suggested: `git worktree add ../Walder-codex -b codex/p2-3-p2-5 p2-batch`
  and symlink `node_modules` from the main checkout. Use the full quoted path in every `cd`;
  the main checkout runs Victor's dev build and must not be edited.
- One commit per item, message body opening with the observed problem, ending with the
  attribution line your harness gives you. Push the branch and open a PR **targeting `p2-batch`**.
- Before every commit, from the worktree, and read the **exit codes**, never grep the runner:

  ```sh
  npm run typecheck > /tmp/codex-typecheck.log 2>&1; echo "typecheck exit $?"
  npm test > /tmp/codex-test.log 2>&1; echo "test exit $?"
  ```
  Both must print `0`. `npm run build` once before the PR.

## Rules that are not yours to relax

- `src/core/` and `src/sprites/` import no `electron` and no `node:` (`test/core-boundary.test.ts`).
- Never log payload values (`test/log-hygiene.test.ts`).
- **Never redraw, trace or patch sprite pixels.** Frames come only from Victor's Firefly strips
  sliced 1:1 by `art/strips.py`. You may add a strip *entry* to `strips.py`; you may not edit a PNG.
- Every owner-facing string goes through `t()` in `src/core/strings.ts` (new key, English text).
  `test/__snapshots__/*.snap` may gain lines for new keys; no existing line may change.
- Do not invent assets. If a strip or the WAV is missing, stop and ask Victor; do not synthesise,
  download or draw a stand-in.
- Long WHY comments in the voice of the surrounding code; no magic numbers.

## P2-3 · Weekly window as posture

**Product rule (Victor, via the gap analysis):** the face stays on Claude's 5-hour window
(`pctForFace`, `FACE_BUCKET_ID`). The 7-day pool gets a *posture* channel, orthogonal to the
expression: at or above 90 % used he lies down; below it he stands. No bark, no bubble.

**Assets Victor must produce first** (Firefly, per `docs/PROMPTS_V4.md` §0 rules and §1/§2 blocks):

| Save as | Dogs | Canvas | Frames, left to right | Attach |
|---|---|---|---|---|
| `design/references/strips/v4/golden/lie.png` | 3 | 1376×768 | lying down head up · head lowered onto paws · eyes half-closed | approved `v4/golden/idle.png` |
| `design/references/strips/v4/dapple/lie.png` | 3 | 1376×768 | the same three | golden `lie.png` + the dapple photo |

Facing left, flat uniform background, one ground line, no `z z`, no props. Until both files exist,
do only the code that does not need them and leave the rest as a listed TODO in your PR.

**Code, once the strips exist** (one commit):

1. `art/strips.py`: register `lie` beside `sleep` — frame count 3, its own box (mirror how
   `SLEEP_BOX_STRIPS` gives `sleep` a wide box; `lie` needs the same treatment because a lying dog
   is wider than `stand`), animation `lie` = frames 0–2 at 1000 ms looping, in the animation table
   near line ~521. Then `python3 art/strips.py --report && node art/render.mjs` must print
   `RESULT: CLEAN`, and `npm run sync:sheet` must copy the sheet. **Victor approves the pose in
   `npm run sprites` before you commit.**
2. `src/sprites/contract.ts`: `REQUIRED_BOXES` stays `['stand', 'sleep']` — `lie` is optional so a
   sheet without it still validates and the app falls back to `stand`.
3. `src/main/ipc.ts`: `BoxName = 'stand' | 'sleep' | 'lie'` (type-only import in core).
4. `src/core/behaviour.ts`: a posture rule reading the 7-day pool row (`CLAUDE_SEVEN_DAY_KEY`,
   id `claude.seven_day`; use the id constant pattern `FACE_BUCKET_ID` set) from each usage
   snapshot: `pct >= LIE_DOWN_PCT (90)` → `{ type: 'mode', box: 'lie' }`, else back to `stand`.
   Emit only on change (the `mode` event is an edge, like `visible`). It must not fight the
   existing sleep logic: fullscreen sleep wins while it holds; a pet while lying plays `pet` and
   returns to `lie`, not `stand`. A `ponytail:` comment naming the ceiling: no hysteresis, so a pool
   flickering around 90 % stands and lies alternately — the upgrade is a lower stand-up threshold.
5. `src/core/anim-schedule.ts`: still mode shows `lie`'s first frame and a null deadline, like
   every other animation — one test.
6. `src/renderer/overlay.ts`: the `mode` handler already switches boxes; check it accepts `lie`
   and falls back to `stand` when the sheet lacks the box (validate against `sheet.boxes`).
7. `src/core/a11y-text.ts`: the dog label gains ", lying down" when the box is `lie` (via `t()`).
8. Tests: `test/behaviour.test.ts` (89 % → stand, 90 % → lie, unchanged pct → no event, pet while
   lying → back to lie, fullscreen sleep outranks lie), `test/anim-schedule.test.ts`,
   `test/a11y-text.test.ts`, `test/sync-sheet.test.ts` if it lists animations by name.

## P2-5 · One bark sound

**Asset Victor must produce first:** `src/renderer/assets/bark.wav` — WAV, PCM 16-bit, mono,
48 kHz, one short bark ≤ 400 ms, peak ≤ −3 dBFS, no leading silence, ≤ 60 KB — plus its source and
licence for a provenance line in `art/README.md`. Until the file exists, do only the code and leave
the file as a listed TODO. Do not generate one.

**Code** (one commit), wired exactly like `resetStyle` (read that chain first: `src/core/buckets.ts`
`RESET_STYLES`/`isResetStyle`, `src/main/store.ts` `resetStyle` + `readResetStyle`, `src/main/tray.ts`
`applyResetStyle`, `src/main/ipc.ts` `CH.resetStyleSet`/`ResetStylePayload`, `src/main/hover-panel.ts`
`setResetStyle`, `src/preload/index.ts` `onResetStyle`, `src/renderer/panel.ts`):

1. `electron.vite.config.ts`: add `"media-src 'self'"` to the CSP list and nothing else.
2. `src/main/store.ts`: `barkSound: boolean`, default `false`, schema `{ type: 'boolean', default: false }`,
   `readBarkSound(store)`.
3. `src/main/tray.ts`: a checkbox `Bark sound` via `t('tray.barkSound')`, placed right after the
   `Barks` submenu; `applyBarkSound(on)` = `store.set` + `deps.onBarkSound?.(on)` + `refresh()`.
4. `src/main/ipc.ts`: `CH.barkSoundSet: 'walder:barkSound:set'`, `BarkSoundPayload { barkSound: boolean }`,
   `parseBarkSoundPayload`; `SettingsPayload.barkSound`. `src/main/ipc-bridge.ts` fills it from
   `readBarkSound`. `src/preload/index.ts` + `index.d.ts`: `onBarkSound(callback)` (extend the exposed
   key list that `test/preload.test.ts` asserts). `src/main/overlay-window.ts` (or wherever the overlay
   is sent `facingSet`): a `setBarkSound(on)` that sends the payload, wired from `src/main/index.ts`.
5. New pure `src/core/bark-sound.ts`: `shouldPlayBark(kind: BubbleKind, enabled: boolean): boolean` —
   true only for `kind === 'nudge'` with the setting on. Threshold barks only: never perk, waiting,
   sleepy or update. Header says why (a sound on every bubble would be a notification channel; the
   owner opted into one bark).
6. `src/renderer/overlay.ts`: one `Audio` element created lazily on the first play (never at
   launch), `src` the bundled `bark.wav` (import it as an asset URL the way Vite expects, so the
   build copies it under `out/renderer/assets/`), `.play()` in the `case 'bubble'` handler when
   `shouldPlayBark(event.kind, barkSound)`; catch and ignore a rejected play (autoplay policy).
   Subscribe to `onBarkSound` and read the initial value from `getSettings()`.
7. `docs/what-the-card-shows.md` or README "Tray menu" list: one line for the checkbox.
8. Tests: `test/bark-sound.test.ts` (every `BubbleKind` × on/off), `test/ipc-payloads.test.ts`
   (validator), `test/tray.test.ts` (label, checked state, click writes the key and calls `onBarkSound`),
   `test/preload.test.ts` (key list), `test/store-file.test.ts` if it round-trips keys.
   `test/check-asar.test.ts` / `scripts/check-asar.ts`: confirm the WAV lands in the packaged app once
   it exists (a `dist:mac` run is Victor's; note it).

## Definition of done — what the reviewing Claude session will check

- Two commits (or one per item plus a docs commit), each with both gates at exit 0 in the log.
- `git diff p2-batch...HEAD -- design/ art/*.png src/sprites/walder.json` shows **no pixel edits**:
  only the two new strips (Victor's) and the regenerated sheet.
- `test/core-boundary`, `test/log-hygiene`, both snapshot suites green; `.snap` diff is additions only.
- `electron.vite.config.ts` diff is one added `media-src` line.
- `barkSound` defaults to false; `shouldPlayBark` is false for every kind but `nudge`.
- `pctForFace` and `FACE_BUCKET_ID` untouched; the posture reads the 7-day row only.
- Victor's approval of the `lie` pose in `npm run sprites` is stated in the PR body, or the strips
  are listed as still missing and the posture commit is absent.
- The PR targets `p2-batch`, and `docs/CODENOTCH_GAP_ANALYSIS.md` §4 carries a *Done* note per item.

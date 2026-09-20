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
  PR #3 (`p2-batch` → `main`) is held until your PR has landed, so the base will not move under you.
- Before every commit, from the worktree, and read the **exit codes**, never grep the runner:

  ```sh
  npm run typecheck > /tmp/codex-typecheck.log 2>&1; echo "typecheck exit $?"
  npm test > /tmp/codex-test.log 2>&1; echo "test exit $?"
  ```
  Both must print `0`. `npm run build` once before the PR.

## Rules that are not yours to relax

- `src/core/` and `src/sprites/` import no `electron` and no `node:` (`test/core-boundary.test.ts`).
- Never log payload values (`test/log-hygiene.test.ts`).
- **Never redraw, trace or patch sprite pixels.** Frames come only from whole generated strips —
  Victor's Firefly renders so far, your GPT-image renders for `lie` — sliced 1:1 by `art/strips.py`
  and approved by Victor in `npm run sprites`. You may add a strip *entry* to `strips.py`; you may
  not open a PNG in an editor.
- Every owner-facing string goes through `t()` in `src/core/strings.ts` (new key, English text).
  `test/__snapshots__/*.snap` may gain lines for new keys; no existing line may change.
- The two `lie` strips are yours to generate (see P2-3); the WAV is Victor's to supply. Do not
  synthesise, download or draw a stand-in for the WAV, and never hand-edit a strip.
- Long WHY comments in the voice of the surrounding code; no magic numbers.

## P2-3 · Weekly window as posture

**Product rule (Victor, 2026-09-20):** the 5-hour window is the thing to watch — until a weekly
pool is nearly gone. Once **either** `7-day (all models)` (`claude.seven_day`) **or** `7-day Fable`
(`claude.seven_day_fable`) is at or above 90 % used, the 5-hour number no longer says how close the
owner is to the real limit, so the dog changes *posture*: he lies down. The face keeps following the
5-hour window (`pctForFace`, `FACE_BUCKET_ID` — do not touch). No bark, no bubble: posture is a
second, quiet channel.

**The pose must read differently from `out`.** `out` is the 5-hour window exhausted: flat on his
side, done. The weekly pose is a dog that has settled in for the week — a composed resting lie,
sphinx-style, paws forward, alert but low. Anyone glancing at the desk must be able to tell the two
apart at 2×.

**Art: you generate it, with GPT image generation.** This is Victor's decision and the reason the
item is yours: the earlier strips were his Firefly renders, and he now wants these two from you.
The rule that stands is the one underneath it — *no pixel is ever drawn, traced or retouched by a
person or a model*: the strip is generated whole, saved as-is, and `art/strips.py` slices it 1:1.
Follow `docs/PROMPTS_V4.md` §0 to the letter (one flat uniform background colour, exactly N dogs in
one row evenly spaced and clear of the edges, every dog the same size with all paws on one ground
line, facing LEFT in three-quarter view with both eyes visible, only the one described thing changing
between frames, no extras). Paste the §1 golden character block and rules block first, attach the
approved `design/references/strips/v4/golden/idle.png` as the identity reference, and expect two or
three tries — models like to add a shadow, a fourth dog or a prop.

| Save as | Dogs | Canvas | Frames, left to right | Attach |
|---|---|---|---|---|
| `design/references/strips/v4/golden/lie.png` | 3 | 1376×768 | resting lie, head up · head lowered onto paws · eyes half-closed | approved `v4/golden/idle.png` |
| `design/references/strips/v4/dapple/lie.png` | 3 | 1376×768 | the same three, dapple coat | your golden `lie.png` + the dapple photo used for rows 7–20 in PROMPTS_V4 |

Then `python3 art/strips.py --report && node art/render.mjs` must print `RESULT: CLEAN`, and
**Victor approves the pose in `npm run sprites` before the commit.** Put the two prompts you ended
up using into `docs/PROMPTS_V4.md` as "Strip 21 — `lie`" (golden) and a row 21 in the dapple table,
so the art has provenance like every other strip.

**Code** (one commit, after approval):

1. `art/strips.py`: register `lie` beside `sleep` — frame count 3, its own box (mirror how
   `SLEEP_BOX_STRIPS` gives `sleep` a wide box; a lying dog is wider than `stand`), animation
   `lie` = frames 0–2 at 1000 ms looping in the animation table near line ~521, present in both
   coats' tables. `npm run sync:sheet` copies the validated sheet.
2. `src/sprites/contract.ts`: `REQUIRED_BOXES` stays `['stand', 'sleep']` — `lie` is optional so an
   older sheet still validates and the app falls back to `stand`.
3. `src/main/ipc.ts`: `BoxName = 'stand' | 'sleep' | 'lie'` (type-only import in core).
4. `src/core/behaviour.ts`: on each usage snapshot compute the weekly figure as the **max** of the
   `claude.seven_day` and `claude.seven_day_fable` rows' `pct` (either may be absent or `null`; the
   Fable row is `derived: true` and that is fine here — posture is not a bark). `>= LIE_DOWN_PCT`
   (90, a named constant with the WHY above) → emit `{ type: 'mode', box: 'lie' }`; below → back to
   `stand`. Emit on change only (the `mode` event is an edge, like `visible`). Precedence: fullscreen
   sleep wins while it holds and the lie resumes when it lifts; a pet while lying plays `pet` and
   returns to `lie`; a bark or perk plays over the lie and returns to it. A `ponytail:` comment
   naming the ceiling: no hysteresis, so a pool hovering at 90 % alternates — the upgrade is a
   lower stand-up threshold.
5. `src/core/anim-schedule.ts`: still mode shows `lie`'s first frame and a null deadline, like
   every other animation — one test.
6. `src/renderer/overlay.ts`: the `mode` handler already switches boxes; make sure it accepts `lie`
   and falls back to `stand` when the loaded sheet lacks the box.
7. `src/core/a11y-text.ts`: the dog label gains ", lying down" when the box is `lie` (via a new
   `t()` key), so a screen reader hears the posture the way it hears the mood.
8. `docs/what-the-card-shows.md` (or the README's "What the dog does" list): one line — "lies down
   when a weekly pool passes 90 %; the face still shows the 5-hour window".
9. Tests: `test/behaviour.test.ts` (weekly 89 % → stand; 90 % → lie; Fable at 90 with the pool at
   40 → lie; unchanged → no event; pet while lying → back to lie; fullscreen sleep outranks lie and
   lie resumes after), `test/anim-schedule.test.ts`, `test/a11y-text.test.ts`,
   `test/sync-sheet.test.ts` if it lists animations or boxes by name.

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
- `git diff p2-batch...HEAD -- design/ art/ src/sprites/walder.json` shows **no pixel edits**: only
  the two new generated strips, saved whole, and the sheet `strips.py` regenerated from them.
- The `lie` frames read as a resting dog, not as `out`'s collapsed one, side by side at 2× in
  `npm run sprites`; the two prompts are in `docs/PROMPTS_V4.md`.
- `test/core-boundary`, `test/log-hygiene`, both snapshot suites green; `.snap` diff is additions only.
- `electron.vite.config.ts` diff is one added `media-src` line.
- `barkSound` defaults to false; `shouldPlayBark` is false for every kind but `nudge`.
- `pctForFace` and `FACE_BUCKET_ID` untouched; the posture reads the 7-day row only.
- Victor's approval of the `lie` pose in `npm run sprites` is stated in the PR body, or the strips
  are listed as still missing and the posture commit is absent.
- The PR targets `p2-batch`, and `docs/CODENOTCH_GAP_ANALYSIS.md` §4 carries a *Done* note per item.

# Walder 0.2 — what is left before release (handoff note, 2026-09-10)

Written for whoever picks this up next (Victor, Codex, or Claude). Read this first, then
`docs/PROMPTS_V4.md` (the strip prompts) and `docs/BUILD_LOG.md` (stage history).

## Where we are

- **All 0.2 code is finished and merged** on `main` (`cc0f764`, 1526 vitest tests, typecheck + build
  green, pushed). Nothing in `src/` is waiting on anything.
- **The only thing missing is art: 20 Firefly strips**, and every art-dependent feature is dormant
  until they land (mirroring, the still idle, the four mood faces, `?`/`z z` drawn by the app, the
  silver dapple coat). The pipeline detects each strip on its own and switches over automatically.
- One live check is also still open (item 3 below) — Victor at the keyboard, ten minutes.

## Binding rules (Victor's decisions — do not re-litigate)

1. **No release before ALL 20 strips are in and approved** in `npm run sprites`.
2. **The handbook content pass comes LAST**, right before `npm run release` — never earlier (it would
   be redone once the art changes).
3. **Never redraw Walder by hand or trace him.** Every hand-drawn/traced sprite was rejected. The only
   accepted method is Victor's own Firefly strips sliced 1:1 by `art/strips.py`.
4. Never refresh the Claude Code / Codex CLI tokens from Walder. Never log payload values, only key
   names.
5. `src/core/` and `src/sprites/` stay Electron-free; long WHY comments; no magic numbers.

## 1. The 20 missing strips (all still missing — both `v4/` folders are empty)

Drop folder: `design/references/strips/v4/<coat>/<strip>.png` (exact names; `idle.png` MUST be exact).
Prompts + the routine per strip: `docs/PROMPTS_V4.md` ("At a glance" table at the top).
Order matters: generate golden first, approve, then use the approved golden strips as references for dapple.

| # | coat | strip | dogs | canvas | notes |
|---|---|---|---|---|---|
| 1 | golden | `idle` | 6 | 2048×768 | **FIRST** — everything else is timed against it |
| 2 | golden | `idle_happy` | 5 | 1376×768 | 3 breathing + eyes half + eyes closed |
| 3 | golden | `idle_worried` | 5 | 1376×768 | one sweat drop, same spot in all 5 |
| 4 | golden | `idle_exhausted` | 5 | 1376×768 | tongue out, ears flat |
| 5 | golden | `tilt` | 3 | 1376×768 | **NO question mark** (app draws it) |
| 6 | golden | `sleep` | 3 | 1376×768 | **NO z z** (app draws it), wide framing |
| 7–12 | dapple | the same six | as above | as above | green background `#3FA34D` |
| 13 | dapple | `out` | 2 | 1376×768 | frame-for-frame match of legacy golden `out` |
| 14 | dapple | `perk` | 3 | 1376×768 | |
| 15 | dapple | `bark` | 4 | 1376×768 | |
| 16 | dapple | `walk` | 4 | 1376×768 | |
| 17 | dapple | `wake` | 4 | 1376×768 | |
| 18 | dapple | `tail_wag` | 4 | 1376×768 | |
| 19 | dapple | `hop` | 5 | 1376×768 | |
| 20 | dapple | `pet` | 6 | 2048×768 | hearts allowed on dogs 3–6 |

Golden background: flat light grey `#C8C8C8`. Dapple: flat green `#3FA34D` (the build separates dog
from ground by colour; silver on grey is the one case it cannot do). Wrong dog count = loud failure.

**What an agent (Codex) can and cannot do here**
- It CAN: run the checks after every drop, read the failure text, tell Victor which strip to regenerate
  and why, and (if it has an image-generation tool) generate strips by pasting the prompt blocks from
  `docs/PROMPTS_V4.md` verbatim — character block, rules block, then the strip prompt.
- It CANNOT: fix a strip by editing pixels, drawing, tracing, or compositing (rule 3). If a strip
  fails, the answer is always "regenerate", never "patch".

**After every drop, run:**
```bash
python3 art/strips.py --report      # summary: which strips are still legacy, anchors, mirrorReady
node art/render.mjs                 # art/out/CHECK.txt must say RESULT: CLEAN
npm run sprites                     # gallery — Victor approves motion here
```
What "good" looks like in the gallery: idle lap is calm, blink splices without a chest pop,
worried/exhausted blink in their own face, `?` and `z z` sit at their anchors on tilt/sleep,
"mirror" checkbox looks right, dapple set is the same size as golden.

After the FIRST dapple `idle` lands: resample the `silver-dapple` palette seed hexes in `art/strips.py`
(`COAT_RAMPS["silver-dapple"]`) from that strip's cluster medians — the current hexes are guesses.
Once dapple lowers the global `k`, golden is re-quantised; Victor re-approves the golden gallery once.

## 2. Deferred code cleanups (all LOW, one short fix round, do with item 3)

- (a) `src/core/behaviour.ts` ~:626 — pet-dismiss `pending.filter(kind !== active.kind)` can swallow a
  second queued non-machine nudge; skip the filter when `active.kind === 'nudge'`; add a test.
- (b) move `usageShapeLines` (+helpers) from `src/main/usage-diagnostics.ts` to `src/core/`
  (`providers → main` import is an inversion).
- (c) `docs/QA-CHECKLIST.md` §5: add a row for the `Extra usage: limit reached` bark.
- (d) W2 leftovers: `describe.runIf(process.platform === 'darwin')` on the panel-experiment tests;
  remove unreachable `isEmptySection` + its vacuous test; duplicate `card size ->` log line; false
  comment at `src/renderer/panel.ts:63`; QA 6.12d add "panel pre-shown off-Space".
- (e) `src/main/store.ts`: drop the `enum` on the `size` schema (a hand-edited setting would wipe ALL
  settings via `clearInvalidConfig`), same as was done for `cardSize`.

## 3. Open live check: hover card over a macOS fullscreen page (needs Victor)

The card does not appear over a Safari fullscreen page. Seven candidate fixes ship behind an env
switch; the winner is unknown until Victor tries them:
```bash
cd "/Users/victorprehn/Desktop/Tree/06 Claude/Walder" && WALDER_LOG=1 WALDER_PANEL_EXPERIMENT=3 npm run dev
```
Try 3 first, then 0, 2, 1, 4, 5, 6: put Safari in real fullscreen, hover the dog, note which number
shows the card. Then: hard-wire that variant in `src/main/hover-panel.ts`, delete the env switch and
`panelExperimentFromEnv`, and pin it in `test/hover-panel.test.ts` (the fake BrowserWindow must record
`setVisibleOnAllWorkspaces` args, call order vs `showInactive`, `once('ready-to-show')`, `setOpacity`).

## 4. Release checklist, in order

1. All 20 strips dropped, `CHECK.txt` CLEAN, gallery approved by Victor (item 1).
2. Fix round: items 2 + 3 → fresh reviewer → merge → `npm run typecheck && npm test && npm run build`.
3. `docs/QA-CHECKLIST.md` 5.3 rewritten for the real moods (ears down, sweat drop are now real).
4. **Handbook 0.2 content pass** (`docs/handbook/`, then `python3 docs/handbook/build_walder.py`):
   hide-when-idle mode + shortcut, five bubble kinds (incl. `update`), Card size, Extra usage / Codex
   credits rows, real Fable row, mirroring, dapple coat, remove the "trust the hover card below 95 %"
   paragraph. Then republish the artifact.
5. `npm version 0.2.0`, `npm run dist:mac` (+ `dist:win` if a Windows machine is available),
   `npm run check:asar`.
6. Live smoke test on Victor's Mac: back up `~/Library/Application Support/walder/walder.json`, quit
   the running app (`osascript -e 'quit app "Walder"'`), run the packaged build with `WALDER_LOG=1`,
   check card rows / hide mode / shortcut / mirroring, relaunch.
7. `npm run release` — publishes to the public `https://github.com/ViuMP/walder-releases` (needs
   `gh auth status` OK and `docs/HANDBOOK.html` present; it attaches the handbook). First release
   there ever, so the update checker in 0.1.2 installs will start seeing it.
8. `docs/BUILD_LOG.md` entry; update `docs/PROMPTS_V4.md` checklist ticks.

## Process that has worked for this repo

Builder in a git worktree (`git worktree add ../Walder-<stage> -b <branch>`, symlink `node_modules`)
→ fresh reviewer → owner-side audit of the critical files → fix round → `git merge --no-ff` →
typecheck/vitest/build → push → remove worktree. Small verified steps; explain decisions to Victor in
plain language; ask before anything that changes the architecture.

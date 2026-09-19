# Walder 0.2 — what is left before release (handoff note, 2026-09-10)

## State at hand-off, 2026-09-11 late evening (read this first)

- **0.2.2 is PUBLISHED.** `main` = `32e64f7`, tagged `v0.2.2`; the release is live at
  <https://github.com/ViuMP/walder-releases/releases/tag/v0.2.2> with the dmg and the 0.2-edition
  handbook attached. 0.2.1 installs will offer it within six hours. `v0.2.0` and `v0.2.1` remain on
  origin; 0.2.0 was never published.
- **Pushed.** `main` and `v0.2.2` are on origin (`ViuMP/Walder`).
- **NOT SMOKE-TESTED.** `release/Walder-0.2.2-mac-arm64.dmg` is built and asar-checked but has not
  been run on a desktop. This matters more than usual for this release: almost everything in it is
  animation timing and window geometry, which unit tests can only assert arithmetic about. Run QA
  rows **5.9f–5.9h** first (he blinks and never parks half-closed; a click hands back to the idle
  loop; the hover card does not move through a blink or a bark), then 5.7–5.7e (bubbles persist) and
  3.4f–3.4h (Primary service).

### What 0.2.2 contains

- **The freeze.** `nextFrameDueAt` answered `null` for a clock that had not been ticked, so every
  animation swap the renderer performs *inside* a paint armed no timer. The shipped `blink` is
  `[idle_3, idle_4, idle_3]` and `idle_3` is the half-closed eye, so he froze on the first frame of
  his own blink; `onPlayFinished` did the same at the other end, so a click parked him for the
  session. One line, three owner reports.
- **Bubbles stay until petted.** `NUDGE_TTL_MS`/`PERK_TTL_MS`/`UPDATE_TTL_MS` and
  `NudgeMachine.onTick` are deleted. A window's higher crossing supersedes its own bark in place
  (bare `show`, no `clear`). `SLEEP_PET_TTL_MS` survives — a click makes the `…zzz`, so a click
  cannot dismiss it.
- **Bubble sized for reading**: `bubbleFontPx` 12/14/16, `bubbleReservePx` derived from it. The
  slack was *solved for*, not guessed — dpr 1.5 rounds `unit` up to 2 while the font scales by half
  and dropped a line at 16 px of slack. `test/geometry.test.ts` re-derives `drawBubble`'s own `rows`
  arithmetic across five ratios.
- **Hover card anchored** to the resting pose with no bob (`restingFrame` in `overlay.ts`).
- **Money rows** carry the currency symbol on both halves.
- **Extra usage reset restored**, computed (`nextMonthlyResetAt`, first of the next calendar month
  UTC) and flagged `resetsEstimated`, which the card renders as `(est.)`. This reverses a documented
  decision — the old comment argued a date claude.ai never stated is a lie you cannot detect — and
  the marker is what answers that argument. The flag is persisted; a restored snapshot without it
  would show the invented date unmarked for the three minutes before the first poll.
- **Primary service** setting (Claude/ChatGPT), biasing card order and bark priority by rewriting
  `priority` inside `mergeBuckets`. Deliberately NOT the face — `pctForFace` stays on Claude 5-hour.
  `Poller.republish()` re-emits the held snapshot so the menu re-sorts instantly, keeping the
  original `fetchedAt` so a re-sort cannot look like a refresh.
- **Card widened** to 380/370/250. Medium at 370 against Large's 380 is deliberate and owner-approved:
  Medium shows the same rows as Large with only the scaffolding removed, so it must fit the same
  widest row (`Codex credit limit`).
- Launch at login was already shipped in 0.2.1 and needed nothing; it is greyed out under
  `npm run dev` because an unpackaged app has no login item.

### DONE, unreleased: the macOS signature (2026-09-11)

**Fixed in the working tree, verified on a built dmg, NOT released.** Every published
Walder — 0.1.2, 0.2.1, 0.2.2 — is still the broken one, so README's "If macOS says
Walder is **damaged**" section and the 0.2.2 release notes remain true as written and
must not be edited until the fix ships.

**What it was.** `mac.identity: null` made electron-builder *skip* signing, which is not
the same as being unsigned: what shipped was the Electron binary's own linker signature
(`Identifier=Electron`, `Sealed Resources=none`). A quarantined copy of that — any
download — is reported by macOS as **"Walder is damaged and can't be opened"**, with no
Open Anyway button.

**What fixed it.** `identity: "-"` and `hardenedRuntime: false` in `electron-builder.yml`,
plus `dist:mac` packaging into `${TMPDIR:-/tmp}/walder-dist` and `ditto`ing the artifacts
back into `release/`.

**The out-of-tree packaging is the load-bearing half, and the previous note's theory was
wrong.** `codesign` refuses a bundle carrying `com.apple.FinderInfo`, and the attribute is
not coming from Electron: `~/Desktop` is synced by iCloud's Desktop & Documents file
provider, which stamps it on every `.app` inside — and **re-stamps it within one second**
of removal (measured). So neither the drafted `ditto` hook nor a targeted
`xattr -rd com.apple.FinderInfo` hook can work; both were written, both failed the same
way, both are deleted. Building in `$TMPDIR` means nothing stamps anything and **no hook
exists**. `com.apple.provenance` is confirmed a red herring. Full account, with the
before/after verdict table, in `docs/BUILD_LOG.md`.

**Verdict, on the dmg** (`codesign --verify --deep --strict`): was `code has no resources
but signature indicates they must be present`; is now `valid on disk`, `satisfies its
Designated Requirement`, `Identifier=com.victorprehn.walder`, `Sealed Resources version=2`.
`spctl` on a quarantined copy went from that same resources error to a plain `rejected` —
the ordinary unidentified-developer refusal, which **System Settings ▸ Privacy &
Security ▸ Open Anyway** clears. (Not right-click ▸ Open — macOS 15 removed that
override, as README already records.)

**Shipping it (0.2.3):**

1. **Version bumped and built.** `package.json` is 0.2.3 and
   `release/Walder-0.2.3-mac-arm64.dmg` is built, asar-checked and verified:
   `codesign --verify --deep --strict` exits 0, and `spctl` on a quarantined copy
   gives the plain `rejected` rather than the resources error.
2. **Docs done.** `docs/release-notes/0.2.3.md` is written, and README's
   "If macOS says Walder is **damaged**" section is now scoped to 0.2.2-and-older
   with the `xattr` command kept for anyone staying on an old build.
   `docs/release-notes/0.2.2.md` is deliberately NOT edited: it is the permanent
   record of a build that really did ship that way, and it is accurate.
3. **Still to do — publish.** Commit, tag `v0.2.3` in `ViuMP/Walder`, then:

   ```
   npm run release -- --notes-file docs/release-notes/0.2.3.md
   ```

4. **QA row 8.2 is now the row that matters** and has never been performed:
   download the dmg on a machine that will quarantine it, install, and confirm the
   dialog is the unidentified-developer one and that **Open Anyway** gets past it.
   Everything above is evidence from `codesign`/`spctl`, not from a human clicking.
5. The rest of 0.2.2 is still **NOT SMOKE-TESTED** — see the top of this note.

Also still true and worth deciding separately: **there is no Intel build.**
`electron-builder.yml` targets `arm64` only, so Walder cannot run on an Intel Mac
at all. The 0.2.2 notes now say so; adding an `x64` or `universal` target is a
config change that roughly doubles the dmg and needs its own smoke test.

### Still open

- **The EUR price per Codex credit** from Victor's OpenAI invoice, for `DEFAULT_CODEX_CREDIT_PRICE`
  in `src/main/store.ts` (still the USD list price). Unchanged from the previous note.
- **Handbook read-through against a running build.** Its 0.2.2 pass corrected four claims that were
  false as of this release (bark/perk/update durations, the Extra usage countdown), but like the 0.2
  pass before it, it was written from source rather than from clicking through the app.
- **Windows build** and **PROMPTS_V4 checklist ticks**, both still deferred.

## Current owner release decision — 2026-09-11

Victor approves the gallery as it currently renders. The four planned source files that remain absent
are deliberate, approved active fallbacks: golden `idle_happy`, golden `tilt`, golden `sleep`, and
dapple `idle_happy`. Do **not** generate replacements for them. This closes the artwork approval
gate even though those four `v4/` PNGs do not exist; record them as approved fallbacks, never as
generated source strips.

The active sheet has 58 frames, two frame sets, and six palettes. The final art report and renderer
are clean. Claude now starts release preparation at item 4.2 below.

## Latest owner decision (2026-09-10, after this handoff)

Golden `v4/golden/idle.png` now contains ChatGPT-generated candidate 03, regenerated to keep the
closed mouth visible after slicing. Victor accepted candidate 02's general appearance, then requested
**first frame held still with blinking only**: no breathing cycle and
no rare head/ear movement. This overrides the breathing/ear-flick instructions below for every idle
mood and both coats. Victor approved candidate 03 and its motion ("that looks great").
Victor subsequently requested restoring the original tilt/confused and rejected happy candidate01
for its mouth and inconsistent shading. Both candidate strips have been removed from the live review:
tilt/confused use the original artwork, and happy/blink_happy use the approved neutral fallback.
Keep original tilt/confused; the older replacement plan below does not authorize changing them again.
Latest correction: Victor approved the new worried and exhausted strips and requested restoring those
two only, keeping happy as-is and nothing else. They are now the active v4 mood sources. Happy still
uses the approved neutral fallback; original tilt/confused and sleep remain. A per-strip alignment
fix keeps every other sprite unchanged. See `design/candidates/golden-set/REVIEW.md`.
No further generation or other steps are authorized for now. The user authorized direct ChatGPT
image generation (the original Firefly workflow also used ChatGPT); pixel patching remains forbidden.

Latest direction: Victor asked for a clearer golden `out` pose and more legible standalone heart,
question-mark and sleep symbols, then asked for the worried mouth to remain visible at sprite size.
`out.png`, `decorations.png`, and worried candidate02 are now active v4 sources. Only those eleven
rendered frames changed; all other frames and animation tables were compared against the preceding
approved sheet. No further work is authorized until this gallery review.

Victor approved silver-dapple idle candidate02 on 2026-09-11. It is installed as
`v4/dapple/idle.png`; the silver-dapple palette ramp now comes from its perceptual colour-cluster
medians. The absent dapple-puppy photograph was not in the repository, so the approved golden idle
and documented dapple-coat specification were used. Continue the remaining dapple strips one at a
time; the dapple coat remains unavailable until all fourteen are present.

Update, 2026-09-11: the remaining dapple motion and mood sources were generated as complete strips,
installed unchanged, and the dapple set now renders in the gallery. Happy deliberately remains the
approved neutral fallback for both coats: the generated dapple happy candidate is preserved under
`v4/dapple/deferred/`, rather than activating a happy expression while golden happy stays deferred.
The active dapple set therefore has thirteen v4 strips and exactly matches the active golden frame
list. `art/strips.py --require-set dapple` and the renderer are clean; gallery review is still required
before any release. Golden legacy tilt/sleep retain their baked symbols, so glyph-free dapple poses are
excluded from the tight-bounds cross-set failure check; all v4-to-v4 comparison remains enforced.

## Where we are

- The approved gallery is complete. Its sources are 16 generated v4 strips plus the four
  owner-approved current fallbacks above; the legacy golden motion strips remain deliberately active.
- Deferred code cleanup and the live Safari fullscreen hover-card check are complete.
- The shared working tree is intentionally still uncommitted. Claude must review it as one release
  preparation change set before packaging.

## Binding rules (Victor's decisions — do not re-litigate)

1. **No release before all 20 planned visual slots are owner-approved** in `npm run sprites`. Victor
   approved the four current fallback slots on 2026-09-11; their absent v4 source PNGs are intentional.
2. **The handbook content pass comes LAST**, right before `npm run release` — never earlier (it would
   be redone once the art changes).
3. **Never redraw Walder by hand or trace him.** Every hand-drawn/traced sprite was rejected. The only
   accepted method is Victor's own Firefly strips sliced 1:1 by `art/strips.py`.
4. Never refresh the Claude Code / Codex CLI tokens from Walder ourselves; Claude Code renewal is
   delegated to the CLI (src/main/claude-renew.ts spawns `claude -p` and never touches the token).
   Never log payload values, only key names.
5. `src/core/` and `src/sprites/` stay Electron-free; long WHY comments; no magic numbers.

## 1. The 20 planned strips — artwork gate complete

The table below is the original production plan, retained as source provenance. Rows 2, 5, 6, and 8
are approved current fallbacks rather than generated PNGs; every other slot has an active generated
source. This is not a generation queue.

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

## 2. Deferred code cleanups — completed 2026-09-11

- The second queued external exhaustion notice now promotes after the first is dismissed; a regression
  test covers simultaneous empty Codex credits and reached Extra usage.
- `usageShapeLines` and its pure helpers now live in `src/core/usage-shape.ts`; providers no longer
  import from `main/`.
- The checklist includes the capless `Extra usage: limit reached` edge. Dead card-section code and the
  duplicate card-size log are gone, and the panel comments/QA row describe the provisional pre-show
  paint accurately.
- `size` uses the same bare-string schema and runtime fallback as `cardSize`, preserving the rest of a
  hand-edited settings file when one value is invalid.

Validation: typecheck; 1,523 tests passing (one skipped); production build; sprite report, render
`CLEAN`, and gallery launch.

## 3. Fullscreen hover-card check — completed 2026-09-11

Safari confirmed that the card appears in real full screen with the invisible pre-show sequence.
That sequence is now the macOS default in `src/main/hover-panel.ts`; the environment switch and all
other candidates are removed. Tests pin the panel type, workspace flag, opacity/order-in/hide sequence,
and the later normal hover show.

## 4. Release checklist, in order

1. ☑ Artwork: report/render CLEAN and gallery approved by Victor, including four deliberate fallbacks.
2. **Claude starts here:** fresh-review/audit the entire shared working tree, run the required code and
   art checks, then commit the approved change set.
3. Update `docs/QA-CHECKLIST.md` to the approved art actually rendered:
   1.2 is still/blink-only rather than breathing; 5.1 is the approved neutral happy fallback; 5.3
   already matches worried; and 5.6 must name the approved exhausted pose. Preserve the completed
   5.9d and 6.12 entries.
4. ☑ **Handbook 0.2 content pass**, done 2026-09-11 (see "Done since the above" note). Not yet
   proof-read against a running build — do that before release, not another rewrite from source.
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

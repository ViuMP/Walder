# Walder v4 — Firefly prompts for the new strips

Twenty strips in total: **six golden** (the still idle first — everything else is built on it), then
**fourteen dapple** (the whole set again, in the new coat). Generate them in the order below, one strip per
image. Drop each finished PNG into `design/references/strips/v4/golden/` or `.../v4/dapple/`, named after
the strip (`idle.png`, `idle_happy.png`, …). `design/references/strips/v4/README.md` says what the build does
with them.

Every prompt has the same shape: **character block + rules block + the strip itself.** Paste all three.
The blocks are here once so they never drift between strips. Attach the reference images named in each
section — Firefly keeps a character far more consistent from a reference than from words.

**2026-09-10 motion decision:** idle means the first frame held still, interrupted only by its
blink. No breathing cycle and no rare head/ear movement, in either coat or any mood. Keep the
six-/five-frame strip format for compatibility; extra rest cells are not played. The existing golden
idle candidate 03's appearance and still-and-blink motion are approved (Victor: "that looks great").

**Later owner correction:** keep the original golden tilt/confused. Their proposed replacement below
is superseded. Happy candidate01 was rejected for its mouth and shading; happy/blink_happy now use
the approved neutral fallback. Victor subsequently approved worried candidate01 and exhausted01:
restore those two only, keep happy as-is, and do nothing else for now. Do not treat the earlier
full-strip plan as approval for more changes.

---

## At a glance — the twenty strips, in order

Tick them off here. **Golden 1 must be approved before anything else**; golden 2–6 before any dapple.
"Attach" = the reference image(s) to give Firefly for that strip. All paths are inside the `Walder` folder.

| # | Coat | Save as | Dogs | Canvas | Attach | Prompt | Done |
|---|---|---|---|---|---|---|---|
| 1 | golden | `v4/golden/idle.png` | 6 | 2048×768 | `design/references/walder_hero_reference.png` + `design/references/strips/named/idle.png` | §1 · Strip 1 | ☑ |
| 2 | golden | `v4/golden/idle_happy.png` | 5 | 1376×768 | approved `v4/golden/idle.png` | §1 · Strip 2 | ☐ |
| 3 | golden | `v4/golden/idle_worried.png` | 5 | 1376×768 | approved `v4/golden/idle.png` | §1 · Strip 3 | ☑ |
| 4 | golden | `v4/golden/idle_exhausted.png` | 5 | 1376×768 | approved `v4/golden/idle.png` | §1 · Strip 4 | ☑ |
| 5 | golden | `v4/golden/tilt.png` | 3 | 1376×768 | approved `v4/golden/idle.png` | §1 · Strip 5 — **no `?`** | ☐ |
| 6 | golden | `v4/golden/sleep.png` | 3 | 1376×768 | `design/references/strips/named/sleep.png` (pose) + approved idle (dog) | §1 · Strip 6 — **no `z z`** | ☐ |
| 7 | dapple | `v4/dapple/idle.png` | 6 | 2048×768 | `v4/golden/idle.png` + the dapple puppy photo | §2 · row 7 | ☑ |
| 8 | dapple | `v4/dapple/idle_happy.png` | 5 | 1376×768 | `v4/golden/idle_happy.png` + photo | §2 · row 8 | ☐ |
| 9 | dapple | `v4/dapple/idle_worried.png` | 5 | 1376×768 | `v4/golden/idle_worried.png` + photo | §2 · row 9 | ☑ |
| 10 | dapple | `v4/dapple/idle_exhausted.png` | 5 | 1376×768 | `v4/golden/idle_exhausted.png` + photo | §2 · row 10 | ☑ |
| 11 | dapple | `v4/dapple/tilt.png` | 3 | 1376×768 | `v4/golden/tilt.png` + photo | §2 · row 11 — **no `?`** | ☑ |
| 12 | dapple | `v4/dapple/sleep.png` | 3 | 1376×768 | `v4/golden/sleep.png` + photo | §2 · row 12 — **no `z z`** | ☑ |
| 13 | dapple | `v4/dapple/out.png` | 2 | 1376×768 | `design/references/strips/named/out.png` + photo | §2 · row 13 | ☑ |
| 14 | dapple | `v4/dapple/perk.png` | 3 | 1376×768 | `…/named/perk.png` + photo | §2 · row 14 | ☑ |
| 15 | dapple | `v4/dapple/bark.png` | 4 | 1376×768 | `…/named/bark.png` + photo | §2 · row 15 | ☑ |
| 16 | dapple | `v4/dapple/walk.png` | 4 | 1376×768 | `…/named/walk.png` + photo | §2 · row 16 | ☑ |
| 17 | dapple | `v4/dapple/wake.png` | 4 | 1376×768 | `…/named/wake.png` + photo | §2 · row 17 | ☑ |
| 18 | dapple | `v4/dapple/tail_wag.png` | 4 | 1376×768 | `…/named/tail_wag.png` + photo | §2 · row 18 | ☑ |
| 19 | dapple | `v4/dapple/hop.png` | 5 | 1376×768 | `…/named/hop.png` + photo | §2 · row 19 | ☑ |
| 20 | dapple | `v4/dapple/pet.png` | 6 | 2048×768 | `…/named/pet.png` + photo | §2 · row 20 | ☑ |

`v4/` is short for `design/references/strips/v4/`. `…/named/` is `design/references/strips/named/` — the
legacy strips, which stay the reference for the eight animations that are not being redrawn in golden.

**Current happy exception (2026-09-11):** golden happy remains the owner-approved neutral fallback.
To keep both coats on the same animation table, dapple happy does too; its generated candidate is
preserved at `v4/dapple/deferred/idle_happy.png` and is intentionally not an active source. Rows 2, 5,
6, and 8 remain unticked because they are final approved fallbacks, not generated source files.

**Release approval (2026-09-11):** Victor approves the gallery in its current form. Rows 2, 5, 6, and
8 are approved current fallbacks rather than generated v4 files: golden `idle_happy`, golden `tilt`,
golden `sleep`, and dapple `idle_happy`. This closes the artwork gate. Do not generate or patch
replacements; leave the four files absent and treat their rendered output as final.

### The routine, per strip

1. **Assemble the prompt**: character block (§1 or §2) + rules block (same section) + the strip's own text.
   Set N. Attach the reference(s) from the table.
2. **Generate** at the canvas size in the table. Expect two or three tries — Firefly likes to add a shadow,
   a sixth dog, or a `?`.
3. **Check** against §4 before saving: flat background, right dog count, one ground line, all facing left,
   nothing floating that the strip did not ask for.
4. **Save** the PNG under the exact name in the table. For `idle` the name must be exact (`idle.png`) —
   a Firefly name containing "idle" would also match the mood strips.
5. **Run** `python3 art/strips.py` in the `Walder` folder. It prints which strips it found, which fell back to
   the old art, and whether the `?`/`z z` anchors are in place. `RESULT: CLEAN` from `node art/render.mjs`,
   then `npm run sprites` to look — approve golden 1 there before moving to 2.

The dapple coat only switches on when **all fourteen** dapple strips are present; until then the build
lists what is missing and carries on with golden. Nothing you drop can break the golden dog.

---

## 0. Before you generate anything: what the build can and cannot digest

`art/strips.py` does not know what a dog is. It finds the background by colour, keeps everything that is not
background, and treats the N biggest blobs as the N dogs, left to right. So:

| It needs | Because |
|---|---|
| One flat, uniform background colour over the whole canvas | anything that is not that colour becomes part of a dog. A gradient, a floor line, a shadow under the paws, a divider, a label — all of it gets glued onto him |
| Exactly N dogs in one row, evenly spaced, none touching another, none within ~30 px of the edge | the flood fill starts at the border; a dog touching the edge is read as background |
| Every dog the same size (±5 %) with all paws on one line | the pipeline scales the strip once and aligns on the lowest paw row; one tall dog shrinks the whole strip |
| Facing LEFT, three-quarter view, both eyes visible | the app mirrors him at runtime; the art itself is only ever drawn facing left |
| Only the one thing that is supposed to move changes between frames | the pipeline anchors on the dog's centre of mass; unrelated drift becomes a wobble on screen |
| No extras unless the strip asks for them | small blobs (a `?`, `z z`, hearts) attach to the nearest dog and are baked into that frame forever |
| Landscape canvas: **1376×768** for up to five dogs, **2048×768** for six | keeps each dog ≥ 4× oversampled before it is shrunk onto the 72-pixel grid |

If Firefly gives you a shadow or a floor line, regenerate — do not try to paint it out.

---

## 1. Golden set

### Character block (paste first in every golden prompt)

> Pixel-art golden long-haired miniature dachshund, the SAME dog as the attached reference: big head,
> big round dark eyes each with one white highlight, cream chest bib, long feathered ears, plume tail,
> five-tone golden coat (#FFF3D6 #FFE3A6 #FFC67D #E3A454 #C47A30 with #A25F21 and #7A451A shading and a
> dark warm-brown #5F3415 outline). Pokémon Black/White sprite style: crisp hand-placed pixels, hard
> outline, no anti-aliasing, no gradients, no blur, no texture.

Attach as reference: `design/references/walder_hero_reference.png` and
`design/references/strips/named/idle.png` (the current idle strip — it IS the dog).

### Rules block (paste second in every golden prompt)

> Sprite sheet strip: exactly N dogs in ONE horizontal row, evenly spaced, none overlapping, none touching
> the canvas edge. Every dog identical in size, all paws on one shared ground line, all facing LEFT in
> three-quarter view with both eyes visible. Plain flat light-grey background #C8C8C8 filling the whole
> canvas — no gradient, no floor line, no shadow under the dog, no frame, no dividers, no text, no labels,
> no props, no collar. Only the one described change differs between frames; head, ears, tail, legs and
> paws are otherwise pixel-identical from frame to frame.

Replace N with the number in each strip. Canvas: 1376×768 unless the strip says otherwise.

### Strip 1 — `idle` (6 dogs, canvas 2048×768) — GENERATE THIS FIRST

> N = 6. Standing calm, mouth closed, neutral face, tail relaxed. The ONLY movement is blinking.
> Frame 1: at rest. Frames 2 and 3: exactly frame 1, no breathing or movement.
> Frame 4: exactly frame 1 but eyes half-closed.
> Frame 5: exactly frame 1 but eyes fully closed (thin dark line). Frame 6: exactly frame 1.
> Head height, ear position, chest, body, legs, paws and tail identical in all six.

The build holds frame 1 and uses frames 4–5 for the blink. Frames 2, 3 and 6 stay unused;
the fixed strip format is retained so accepted images need no pixel changes. Approve this one in
`npm run sprites` before generating the moods — every mood strip is a copy with a different face.

### Strip 2 — `idle_happy` (5 dogs)

> N = 5. Same still pose as the attached idle strip, HAPPY face: bright wide eyes, brows raised,
> small open smile, tail held high and curled. Frames 1–3 identical at rest, no breathing or head movement.
> Frame 4 = frame 1 with eyes half-closed, frame 5 = frame 1 with eyes closed. The smile and the high
> tail stay identical in all five frames.

Attach the approved `v4/golden/idle.png` as the reference for this and the next three.

### Strip 3 — `idle_worried` (5 dogs)

> N = 5. Same still pose as the attached idle strip, WORRIED face: brows angled inward, eyes a
> little smaller, ears hanging lower, mouth closed and turned down, tail low. One small light-blue sweat
> drop beside the head, in exactly the same place in all five frames, well inside the dog's own width.
> Frames 1–3 identical at rest, no breathing or head movement; frame 4 = frame 1 with eyes
> half-closed, frame 5 = frame 1 with eyes closed.

### Strip 4 — `idle_exhausted` (5 dogs)

> N = 5. Same still pose as the attached idle strip, EXHAUSTED face: eyelids half down, pink tongue
> hanging out, ears flat back, head sunk slightly lower, tail down. Frames 1–3 identical at rest, no breathing
> or head movement; frame 4 = frame 1 with eyes almost closed, frame 5 = frame 1 with eyes closed.
> The tongue is identical in all five.

### Strip 5 — `tilt` (3 dogs) — NO question mark

> N = 3. Same standing pose as the attached idle strip, curious head tilt. Frame 1: head straight.
> Frame 2: head tilted about 8 degrees to its right, one ear starting to lift. Frame 3: head tilted about
> 15 degrees, that ear up. Body, legs and tail identical in all three. Absolutely nothing floating above or
> beside the dog — no question mark, no sparkle, no symbol.

Why: the app now draws the `?` itself so it reads the right way round when he is mirrored. A `?` in the
art would be baked in backwards on the left half of the screen. If Firefly insists on adding one, regenerate.

### Strip 6 — `sleep` (3 dogs, wide framing) — NO z z

> N = 3. The dog curled into a tight ball on the ground, nose tucked toward the tail, plume tail draped
> over the body, eyes closed. Wide, low framing. Frame 1: at rest. Frame 2: the ribcage lifted one row.
> Frame 3: at rest with one ear settled slightly lower. Nothing floating above the dog — no "z", no
> stars, no bubbles.

Same reason as the tilt: the app draws the `z z` itself.

---

## 2. Silver dapple set

### Character block (paste first in every dapple prompt)

> Pixel-art SILVER DAPPLE (blue merle) long-haired miniature dachshund, the same dog and proportions as
> the attached golden reference — big head, big round eyes each with one white highlight, long feathered
> ears, plume tail — but in a dapple coat: cool silver-grey base (#A28D7D, lighter #B9A693 highlights,
> darker #848182 shading), irregular black and charcoal blotches (#494542, #66605B) scattered over the
> back, head and ears, tan points (#EED1AC light, #AE7740 dark) on the eyebrows, the sides of the muzzle,
> the chest and all four paws, ice-blue eyes, cool near-black #0F0E0D outline. Pokémon Black/White sprite
> style: crisp hand-placed pixels, hard outline, no anti-aliasing, no gradients, no blur, no texture.

Attach as reference for EVERY dapple strip: the matching approved golden strip from `v4/golden/` (or, for
the eight animations that were not regenerated, the golden original from `design/references/strips/named/`),
plus your photo of the dapple puppy for the coat. The instruction "same silhouettes as the attached strip,
frame for frame" is what makes the two coats interchangeable in the app.

### Rules block (paste second in every dapple prompt)

> Sprite sheet strip: exactly N dogs in ONE horizontal row, matching the attached strip frame for frame —
> same poses, same sizes, same spacing, same ground line, same facing (LEFT, three-quarter view, both eyes
> visible). Plain flat GREEN background #3FA34D filling the whole canvas — no gradient, no floor line, no
> shadow, no frame, no dividers, no text, no props, no collar. The blotch pattern is the same on every dog
> in the row. Only the described change differs between frames.

Why green: the build tells background from dog by colour. A silver dog on a grey background is the one
combination it cannot separate cleanly.

### The fourteen dapple strips

Generate in this order, each with the matching golden strip attached:

| # | strip | N | what the frames show (identical to the golden strip) | golden reference |
|---|---|---|---|---|
| 7 | `idle` | 6 | rest · rest · rest · eyes half · eyes closed · rest | `v4/golden/idle.png` |
| 8 | `idle_happy` | 5 | happy face, 3 identical rest + 2 blink | `v4/golden/idle_happy.png` |
| 9 | `idle_worried` | 5 | worried face + sweat drop, 3 identical rest + 2 blink | `v4/golden/idle_worried.png` |
| 10 | `idle_exhausted` | 5 | exhausted face, 3 identical rest + 2 blink | `v4/golden/idle_exhausted.png` |
| 11 | `tilt` | 3 | straight · slight tilt · full tilt — **no question mark** | `v4/golden/tilt.png` |
| 12 | `sleep` | 3 | curled · ribcage up · settled — **no z z**, wide framing | `v4/golden/sleep.png` |
| 13 | `out` | 2 | flat on the belly, legs splayed, X eyes · same with a small breath puff | `named/out.png` |
| 14 | `perk` | 3 | resting · head lifting · head high, ears flared out | `named/perk.png` |
| 15 | `bark` | 4 | closed · opening · mouth wide with two short motion lines · closing | `named/bark.png` |
| 16 | `walk` | 4 | trot cycle, ears bouncing | `named/walk.png` |
| 17 | `wake` | 4 | curled · yawn · front-leg stretch · shake | `named/wake.png` |
| 18 | `tail_wag` | 4 | tail left · centre · right · centre, body still | `named/tail_wag.png` |
| 19 | `hop` | 5 | crouch · push-off · airborne · landing · standing | `named/hop.png` |
| 20 | `pet` | 6 | eyes squeezing shut, head pushing up; two small pink hearts from frame 3 on | `named/pet.png` |

For each, the strip text is simply:

> N = ⟨n⟩. Reproduce the attached strip frame for frame in the silver dapple coat: ⟨the frame description
> from the table⟩. Every pose, size and position identical to the reference; only the coat changes.

Add "**no question mark**" to 11 and "**no z z**" to 12 explicitly, and "two small pink hearts floating
beside the head from frame 3 onward, nothing else floating" to 20.

---

## 3. Fallback only: the menu-bar bone

The bone in the menu bar is drawn in code (`scripts/gen-tray-icon.ts`) and is being redrawn there — you do
not need to generate it. If you ever want to try an illustrated one instead:

> 16×16 pixel-art icon of a dog bone, pure white on a transparent background, no outline, no shading, no
> anti-aliasing: a straight 2-pixel shaft with two rounded lobes at each end and a one-pixel notch between
> the lobes. Centred, one pixel of empty margin on every side.

It would have to be converted into the 16-row text grid the script uses; the code path is simpler.

---

## 4. Before you drop a file into `v4/`

- [ ] The background is one flat colour edge to edge (zoom in on the corners and under the paws).
- [ ] Count the dogs. Six means six — Firefly likes to add or merge one.
- [ ] All paws sit on one line; no dog is noticeably bigger.
- [ ] Every dog faces left.
- [ ] Nothing floats around the dog that the strip did not ask for — especially on `tilt` and `sleep`.
- [ ] The file is named after the strip: `idle.png`, `idle_happy.png`, `tilt.png`, … in the right coat folder.

Then, in the repo folder:

```bash
python3 art/strips.py --report
```

It prints what it found per strip (dog count, any stray blobs). A missing dapple strip is not an error —
the build says which ones are missing and skips the dapple coat until they are all there. Finish with
`node art/render.mjs` and `npm run sprites` to look at the result.

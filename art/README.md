# Walder — sprite art

Walder is a golden long-haired miniature dachshund (*langhåret dværggravhund*),
drawn in the Pokémon DS (Gen 4/5) sprite language.

## Running it

```
node art/render.mjs
```

Zero dependencies — Node built-ins only (`zlib` for PNG encoding). Outputs land
in `art/out/`:

| path | what |
|---|---|
| `<palette>/<frame>@1x.png` | one PNG per frame per palette, transparent, 1 px per logical pixel |
| `<palette>/<frame>@2x.png` · `@3x.png` | the sizes the app actually draws Walder at — judge detail here, not at 6× |
| `<palette>/<frame>@6x.png` | the same, nearest-neighbour 6×, for pixel-level work |
| `sheet_<palette>.png` | contact sheet at 4×, one animation per row, 8 px gaps |
| `sheet_index.txt` | which animation sits on which sheet row |
| `expressions_golden@6x.png` · `@3x.png` | the six expressions side by side |
| `base_golden_scales.png` | `idle_0`/`idle_1` at 1×/2×/3×/4×/6× — the readability ladder |
| `CHECK.txt` | validation report — must say `RESULT: CLEAN` |

`art/out/` is generated; it can be deleted and rebuilt at any time.

## Files

- **`walder.json`** — the artwork. Canonical and hand-editable: every frame is a
  plain array of row strings, one character per pixel. Editing a row here is the
  normal way to fix a pixel.
- **`render.mjs`** — the renderer and validator. Reads `walder.json`, writes PNGs
  and `CHECK.txt`.
- **`frames.mjs`** — the script that first generated `walder.json`
  (`node art/frames.mjs` rewrites it). Every standing frame is *derived* from one
  base pose there, which is what keeps proportions and the ground line identical
  across 35 standing frames. Use it for structural changes (a new pose, a
  different ear shape); use `walder.json` directly for one-off pixel fixes.
  **Regenerating overwrites hand edits to `walder.json`.**

## Letter legend

`.` transparent (a space also works)

| | | | |
|---|---|---|---|
| `o` outline (hue-shifted dark brown, never black) | `d` coat dark | `m` coat mid | `l` coat light |
| `h` coat highlight | `a` accent — tan points | `e` eye dark | `w` eye specular dot |
| `n` nose | `k` mouth interior | `p` pink (tongue, inner ear) | `t` tan paw pad |
| `r` heart red | `s` bubble/glyph dark grey | `b` bubble white | `z` sleepy blue |

`a` is the load-bearing trick: on `black-and-tan` and `chocolate` it is a real
tan point, and on `golden`/`red`/`cream` it resolves to the same value as `l`.
The same pixels therefore give tan muzzle, eyebrow pips, chest bib and feet on
the tan-pointed coats, and read as ordinary cream highlights on the others.

## Palettes

Only `o d m l h a` (coat) and `n` (nose) differ between palettes. Every other
letter is shared, and `CHECK.txt` asserts that every letter used by any frame
resolves in every palette.

| | `o` | `d` | `m` | `l` | `h` | `a` | `n` |
|---|---|---|---|---|---|---|---|
| **golden** (Walder) | `#5a3416` | `#b8741f` | `#e2a53a` | `#f2c96b` | `#fbe7b0` | `#f2c96b` | `#241a16` |
| **red** | `#4a1d10` | `#8f3a18` | `#b85326` | `#d4713c` | `#eda374` | `#d4713c` | `#241a16` |
| **cream** | `#6b5236` | `#d3b489` | `#e8d5b0` | `#f5e9cf` | `#fdf8ea` | `#f5e9cf` | `#2b201a` |
| **black-and-tan** | `#100d0c` | `#262020` | `#38312e` | `#4e443e` | `#665a52` | `#c98b3a` | `#0b0908` |
| **chocolate** | `#241610` | `#46291a` | `#654027` | `#855735` | `#a37348` | `#c8873f` | `#1a1210` |

Shared: `e #3b2416` · `w #ffffff` · `k #140d09` · `p #e58fa0` · `t #c98b3a`
· `r #e24a5c` · `s #43434c` · `b #fdfdfd` · `z #7fb8e8`

## Boxes

| box | size | used by |
|---|---|---|
| `stand` | 48 × 40 | all standing frames; the dog's paws sit on row 39 |
| `sleep` | 32 × 24 | `sleep_*`, `wake_*` — the "tiny" fullscreen sprite (32 px at 1×) |
| `heart` | 7 × 6 | `heart_0/1` |
| `qmark` | 5 × 8 | `qmark` |
| `zz` | 8 × 8 | `zz_0/1` |
| `sweat` | 3 × 4 | `sweat` |

Rows 0–7 of the `stand` box are deliberately empty headroom: the bob, the raised
head in `perk`/`pet`, and the airborne `hop` frame all use it. Row 39 is the
ground line and is identical across every grounded standing frame, so switching
frames never makes Walder slide.

## Timing table

Durations are per frame, in milliseconds, and live in `animations` in the JSON.

| animation | frames | durations (ms) | loop | notes |
|---|---|---|---|---|
| `idle` | idle_0, idle_1 | 600, 600 | yes | 1 px body bob; ear fringe hangs 1 px lower on frame 1 |
| `idle_neutral` | idle_neutral_0/1 | 600, 600 | yes | byte-identical to `idle`; the name `expressions.neutral` points at |
| `blink` | blink_0 | 90 | no | insert between idle frames |
| `idle_happy` | idle_happy_0/1 | 320, 320 | yes | round eyes + raised brows, grin + tongue, plume wagging |
| `idle_worried` | idle_worried_0/1 | 700, 700 | yes | inner-raised brows, frown, low tail, ears drooped 2 px, sweat bead |
| `idle_exhausted` | idle_exhausted_0/1 | 480, 480 | yes | half-lidded, panting, sweat bead, head down |
| `out` | out_0, out_1 | 900, 900 | yes | collapsed flat, X eyes — "limit reached" |
| `confused` | confused_0/1 | 700, 700 | yes | head cocked; show `qmark` beside the head |
| `ear_flop` | ear_flop_0/1 | 120, 180 | no | ear flicks back, then settles (frame 1 == idle_0) |
| `tail_wag` | tail_wag_0/1 | 140, 140 | yes | frame 1 == idle_0 |
| `walk` | walk_0…walk_3 | 130 × 4 | yes | DS trot; diagonal pairs, 1 px dip on the contact beats |
| `bark` | bark_0/1 | 90, 160 | no | forward lean, mouth open |
| `pet` | pet_0, pet_1, pet_2 | 220, 300, 220 | yes | eyes squeezed shut (`^ ^`), head pushes up; show `heart` |
| `perk` | perk_0/1 | 140, 420 | no | ears lifted, head raised — "Claude is done" |
| `tilt` | tilt_0/1 | 260, 900 | yes | head cocked — "waiting for you" |
| `hop` | hop_0, hop_1, hop_2 | 90, 160, 110 | no | squash → airborne (stretched) → squash on landing |
| `sleep` | sleep_0/1 | 1200, 1200 | yes | curled; 1 px chest rise on frame 1 |
| `wake` | wake_0/1 | 260, 380 | no | head lifts, then a stretch — hand off to `idle` after |
| `heart` | heart_0/1 | 300, 300 | yes | decoration |
| `zz` | zz_0/1 | 700, 700 | yes | decoration; pair with `sleep` |
| `qmark` | qmark | 900 | no | decoration; pair with `confused`/`tilt` |
| `sweat` | sweat | 900 | no | decoration (also baked into `idle_exhausted`) |

`hop_1` carries `"airborne": true` — the only standing frame allowed to have an
empty bottom row. `CHECK.txt` enforces that, in both directions.

## Expressions

`expressions` maps a mood name to an **animation** name, and each of those
animations is made of complete frames — the base idle pose with a different
face — not face overlays composited at runtime. Draw the whole frame and you are
done.

```
neutral → idle_neutral      worried   → idle_worried      out      → out
happy   → idle_happy        exhausted → idle_exhausted    confused → confused
```

## Art direction (the conventions a later coder should keep)

1. **Hue-shifted outline, never black.** Every silhouette edge is `o`, a dark
   warm brown pulled from the coat's own hue; pure black (`k`) appears only
   inside an open mouth. Outlines are 1 px and there is no anti-aliasing, no
   gradient and no dithering — except two-pixel steps along the ear and tail
   fringes, which is what makes the long hair read as hair rather than a smooth
   curve.
2. **Selective inner outlining only.** Parts are drawn far-to-near and each one
   outlines against whatever is already on the canvas, so an inner outline
   appears exactly where forms overlap — ear over cheek, haunch over flank, near
   ear over far ear — and nowhere else. A form that should merge (skull into
   snout) is drawn as one part.
3. **Three tones plus a highlight, lit from the upper left.** `d/m/l/h` are
   assigned by how deep a pixel sits below the lit edge of its own part, so the
   banding follows the form. Fur fringes invert it: the ear tip and tail plume
   catch the light at the *bottom*, which is what gives Walder his cream
   feathering.
4. **Depth by tone, not by detail.** The far ear is the same drawing as the near
   ear shifted one tone darker; the far legs are flat `d`. Never add detail to a
   far-side form to distinguish it — darken it.
5. **He is long-haired, and the feathering is the point.** Five places carry it,
   and all five are generated, not hand-placed:
   - the **tail** is a plume (`drawPlume`), ~10 px long and up to 6 px thick,
     carried up and back in a curve. Mid tone through the middle, shadow along
     the underside, highlight on the lit top/back edge, light streaks running
     out along the hair. The 1-px in-and-out steps in its span list are what
     make the lower edge ragged. Its root rows sit *behind* the body, so it
     grows out of the rump crest instead of being stuck on top of it. The tip
     stops at row 11, clear of the headroom rows a speech bubble uses.
   - the **near ear** ends in a fringed hem — notches plus two hair strands
     that hang a row further — and `earFeather()` runs two light streaks down
     its length. A 1-px hair tip has no interior at this scale, so tips come
     out outline-coloured with the cream hem right above them; that dark-tipped
     cream edge is what backlit long hair looks like. The **far** ear gets the
     silhouette but no streaks and no teeth — a tooth changes a column's depth
     and would stripe the whole flap (see 4).
   - the **belly** carries a cream band hugging the underline, 1 px in some
     columns and 2 in others, clumped rather than alternating. It is drawn
     *inside* the silhouette: pixels dangling below the outline read as extra
     tiny feet once the sprite is down at 2×.
   - the **chest** is a fuller cream bib under the neck, and the **back of each
     near leg** a 1-px cream trailing edge. Both are `a`, so they turn tan on
     the tan-pointed coats — which is exactly where a tan point belongs.
   - each paw is 1 px wider than its leg and carries a 1-px toe split.
6. **The body is a cylinder, not a box.** The topline lifts 1 px over the
   shoulders, dips through the middle and lifts again over the rump; the rear
   corner is rounded; the chest is 1 px deeper than the belly, which tucks up
   toward the hind legs. `botDark: 4` lays a dark band along the bottom third,
   against the highlight on the topline.
7. **Judge every change at 2× and 3×, not at 6×.** `base_golden_scales.png`
   exists for exactly this: detail that only survives at 6× is wasted, and
   detail that vanishes at 2× has to be strengthened or dropped. It is what
   ruled out a 3-px `^` caret for `idle_happy` (two thin lines at 2×) in favour
   of round eyes with raised brows; the caret now lives on `pet`, where the
   eyes are meant to be shut.
8. **The face is small and built from fixed parts.** An eye is a 2x2 block of
   `e` with the specular `w` in the upper-left and one darker brow pixel above
   and slightly *inward* (toward the middle of the skull); worried angles that
   brow inward-up over two rows. The nose is a 2x2 `n` on the snout tip and
   moves with the head shear. Pink appears in exactly three mouths — `grin`
   (a hint), `pant` (hanging) and the collapsed `out` pose. Every closed mouth,
   `neutral` included, is dark ink only: a mouth that shows pink at rest reads
   as permanently panting.
9. **Motion is small and the ground is fixed.** The idle bob is 1 px and moves
   the body while the paws stay planted; ears and tail follow through a frame
   later rather than moving in lockstep; landings squash by 1 px. Every grounded
   frame shares row 39, so nothing slides when frames swap.

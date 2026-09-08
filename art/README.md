# Walder — sprite art (v2, from the chosen design sheet)

Walder is a golden long-haired miniature dachshund (*langhåret dværggravhund*).
The art follows `design/references/walder_design_sheet_chosen.png` — Panel A is
the look, Panel C the coat swaps, Panel D the animation set, Panel E the small
pieces. The master pose matches `design/references/poses/12_hero_neutral_a.png`
and `13_hero_neutral_b.png`.

## Running it

```
node art/frames.mjs      # regenerates art/walder.json from the authored poses
node art/render.mjs       # renders every PNG + CHECK.txt from walder.json
```

Zero dependencies — Node built-ins only (`zlib` for PNG encoding). Outputs land
in `art/out/`:

| path | what |
|---|---|
| `<palette>/<frame>@1x.png` | one PNG per frame per palette, transparent, 1 px per logical pixel |
| `<palette>/<frame>@2x.png` | **the acceptance size** — the app's default; judge every change here |
| `<palette>/<frame>@3x.png` | the app's large size |
| `<palette>/<frame>@6x.png` | nearest-neighbour 6×, for pixel-level work only |
| `sheet_<palette>.png` | contact sheet at 4×, one animation per row, 8 px gaps |
| `sheet_index.txt` | which animation sits on which sheet row |
| `expressions_golden@2x.png` · `@3x.png` | the six expressions side by side |
| `base_golden_scales.png` | `idle_0`/`idle_1` at 1×–6× — the readability ladder |
| `CHECK.txt` | validation report — must say `RESULT: CLEAN` |

`art/out/` is generated; it can be deleted and rebuilt at any time.

## Files

- **`frames.mjs`** — the generator, and the canonical source of the artwork.
  Section 2 (`POSE`) holds the five hand-authored key poses as literal row
  strings; `POSE.base` is **the** master pose. Sections 3–5 derive the other 63
  frames from it. Structural changes (a new pose, a different ear hang) go here.
  **Running it overwrites hand edits to `walder.json`.**
- **`walder.json`** — the artwork as data: every frame is a plain array of row
  strings, one character per pixel. Hand-editable for one-off pixel fixes, but
  the next `frames.mjs` run replaces it.
- **`render.mjs`** — the renderer and validator. Reads `walder.json`, writes the
  PNGs and `CHECK.txt`. Never edits the artwork.

## Letter legend

`.` transparent (a space also works). The coat is an 8-step ramp, light to dark:
`a h l m t d o q`.

| letter | role | golden hex |
|---|---|---|
| `a` | cream — chest bib, belly feathering, ear hem, leg trailing edge. **Doubles as the tan point** on `black-and-tan` and `chocolate`. | `#FFF3D6` |
| `h` | coat highlight | `#FFE3A6` |
| `l` | coat light — the lit topline, muzzle bridge, hair streaks | `#FFC67D` |
| `m` | coat mid — the dominant tone | `#E3A454` |
| `t` | coat mid-shadow — cheek ruff, ear inner edge, belly band | `#C47A30` |
| `d` | coat shadow — far legs, far ear, brows | `#A25F21` |
| `o` | deep shadow | `#7A451A` |
| `q` | outline — every silhouette edge, and the inner outline where forms overlap | `#5F3415` |
| `k` | deep ink — mouth line, closed eyelids, eye rim, glyph outlines | `#3E2411` |
| `e` | eye | `#2D1A0D` |
| `n` | nose | `#1F1208` |
| `w` | eye specular dot / bubble fill | `#FFFFFF` |
| `p` | tongue | `#FF6188` |
| `r` | heart | `#FF6188` |
| `z` | sleepy blue — `zz`, sweat drop | `#4BA2E1` |
| `y` | sleepy blue highlight | `#9CD7FF` |
| `s` | bubble outline (= `k`) | `#3E2411` |
| `b` | bubble fill (= `w`) | `#FFFFFF` |

Only `a h l m t d o q` differ between palettes. Everything else is shared, and
`CHECK.txt` asserts that every letter used by any frame resolves in every
palette. `a` is the load-bearing trick: on `golden`/`red`/`cream` it is the
cream feathering, and on the tan-pointed coats the *same pixels* become the tan
chest, feet and ear hem — which is exactly where a tan point belongs.

## Palettes

Sampled from Panel C of the design sheet (per-tone luminance percentiles against
the golden ramp, then hand-corrected at the light end).

| | `a` | `h` | `l` | `m` | `t` | `d` | `o` | `q` |
|---|---|---|---|---|---|---|---|---|
| **golden** (Walder) | `#FFF3D6` | `#FFE3A6` | `#FFC67D` | `#E3A454` | `#C47A30` | `#A25F21` | `#7A451A` | `#5F3415` |
| **red** | `#FFEBD6` | `#F6D3A9` | `#DE9A62` | `#C06B34` | `#9E5228` | `#7E3F1E` | `#5C2C16` | `#431F10` |
| **cream** | `#FFFDF4` | `#FDF0D8` | `#F8E3C0` | `#EBCB9F` | `#D0A87A` | `#B48B60` | `#8E6A45` | `#6E4F32` |
| **black-and-tan** | `#D69A4A` | `#5E5A5B` | `#4E4A4B` | `#3C3839` | `#302D2F` | `#262425` | `#1B1A1B` | `#121112` |
| **chocolate** | `#C8873F` | `#96684A` | `#7A5138` | `#61402B` | `#4E3322` | `#3E281A` | `#2E1D14` | `#22150E` |

Shared: `e #2D1A0D` · `w #FFFFFF` · `n #1F1208` · `k #3E2411` · `p #FF6188`
· `r #FF6188` · `z #4BA2E1` · `y #9CD7FF` · `s #3E2411` · `b #FFFFFF`

## Boxes

| box | size | used by |
|---|---|---|
| `stand` | 64 × 64 | every standing frame; the paws sit on **row 63** |
| `sleep` | 40 × 28 | `sleep_*`, `wake_*` — the small curled sprite |
| `heart` | 7 × 6 | `heart_0/1` |
| `qmark` | 5 × 8 | `qmark` |
| `zz` | 8 × 8 | `zz_0/1` |
| `sweat` | 3 × 4 | `sweat` |

In the `stand` box the dog occupies roughly cols 1–62, rows 16–63. Rows 0–15
are deliberately empty headroom: the perk lift, the airborne hop frame and any
speech bubble or decoration live there — the plume tail tops out at row 20, so
there are always ≥ 6 clear rows above it. Row 63 is the ground line and is
identical across every grounded standing frame, so switching frames never makes
Walder slide.

## Timing table

Durations are per frame, in milliseconds, and live in `animations` in the JSON.
`hold: true` means the renderer/app should freeze on the last frame instead of
returning to idle. Frame rates follow Panel D of the design sheet.

| animation | frames | ms/frame | loop | hold | notes |
|---|---|---|---|---|---|
| `idle` | 4 | 125 (8 fps) | yes | – | breathe; paws never move, only rows 0–57 squash. Ear and tail follow through a frame later |
| `idle_neutral` | 4 | 125 | yes | – | same pose; the name `expressions.neutral` points at |
| `idle_rare` | 4 | 100 (10 fps) | no | – | ear flick + tail lift, with two motion ticks |
| `blink` | 2 | 83 (12 fps) | no | – | shut, then half-open; insert between idle frames |
| `idle_happy` | 2 | 250 | yes | – | raised brows, grin + tongue, plume carried high |
| `idle_worried` | 2 | 700 | yes | – | inner-raised brows, frown, ears drooped, tail down, sweat bead |
| `idle_exhausted` | 2 | 480 | yes | – | half-lidded, panting tongue, head down, tail low |
| `out` | 2 | 1000 (1 fps) | yes | – | collapsed flat, X eyes — "limit reached" |
| `confused` | 2 | 700 | yes | – | head lowered and cocked; show `qmark` beside the head |
| `ear_flop` | 2 | 120, 180 | no | – | ear flicks back, then settles (frame 1 == `idle_0`) |
| `tail_wag` | 4 | 100 (10 fps) | yes | – | the plume swings from its root; the body never moves |
| `walk` | 4 | 125 (8 fps) | yes | – | DS trot; diagonal pairs swing, 1 px dip on the contact beats |
| `bark` | 4 | 100 (10 fps) | no | – | lean in, mouth open, motion ticks, settle |
| `pet` | 6 | 125 (8 fps) | no | – | eyes squeezed shut, head pushes up; show `heart` |
| `perk` | 3 | 100 (10 fps) | no | **yes** | ears lift, head raises, tail up — "Claude is done" |
| `tilt` | 3 | 125 (8 fps) | no | **yes** | head cocks lower each frame — "waiting for you" |
| `hop` | 5 | 100 (10 fps) | no | – | crouch → deeper crouch → airborne → land squash → stand |
| `sleep` | 3 | 1000 (1 fps) | yes | – | curled, plume over the body, nose tucked; 1 px chest rise |
| `wake` | 4 | 125 (8 fps) | no | – | eye cracks open → yawn stretch → play-bow → up; hand off to `idle` |
| `heart` | 2 | 300 | yes | – | decoration |
| `zz` | 2 | 700 | yes | – | decoration; pair with `sleep` |
| `qmark` | 1 | 900 | no | – | decoration; pair with `confused`/`tilt` |
| `sweat` | 1 | 900 | no | – | decoration (also baked into `idle_worried`/`idle_exhausted`) |

`hop_2` carries `"airborne": true` — the only standing frame allowed to have an
empty bottom row. `CHECK.txt` enforces that, in both directions.

## Expressions

`expressions` maps a mood name to an **animation** name, and each of those
animations is made of complete frames — the master pose with a different face —
not face overlays composited at runtime. Draw the whole frame and you are done.

```
neutral → idle_neutral      worried   → idle_worried      out      → out
happy   → idle_happy        exhausted → idle_exhausted    confused → confused
```

## Art direction (the conventions a later coder should keep)

1. **The master pose is the only source of proportion.** `POSE.base` is a 3/4
   view facing left, both eyes visible, head about 55 % of the sprite width once
   the ears are counted. Everything in the idle family — expressions, blink,
   walk, wag, bark, pet, perk, tilt, hop — is *derived* from it in `frames.mjs`,
   which is what keeps the ground line and the silhouette from drifting across
   63 frames. Only `out`, `sleep` and the two `wake` stretch poses are authored
   separately, because they are genuinely different bodies.
2. **Hue-shifted outline, never black.** Every silhouette edge is `q`, a dark
   warm brown pulled from the coat's own hue; pure ink (`k`) appears only in the
   mouth, eyelids, eye rim and glyph outlines. Outlines are 1 px, no
   anti-aliasing, no gradients, no dithering. The outline is applied *last*, by
   `outline()`, so it always follows the real silhouette — including the ragged
   hair fringes, which is what makes long hair read as hair.
3. **Selective inner outlining only.** An inner `q` line appears exactly where
   forms overlap — the near ear over the cheek, the haunch over the flank — and
   nowhere else. A form that should merge (skull into snout) is one part.
4. **Depth by tone, not by detail.** The far ear and the far legs are the same
   drawing one or two tones darker. Never add detail to a far-side form to
   distinguish it — darken it.
5. **He is long-haired, and the feathering is the point.** Five places carry it:
   the **plume tail** (a fat crescent carried up and back, ~14 px of arc, 7–8 px
   thick, with cream catch-lights and dark notches along the outer rim); the
   **near ear**, a pendant drape past the jaw with 1-px hair strands and a cream
   feathered hem plus two strands hanging a row lower; the **belly**, a clumped
   cream band drawn *inside* the underline; the **chest bib**, a fuller cream
   patch under the neck; and a 1-px cream **trailing edge** on the back of each
   near leg. All five use `a`, so they turn tan on the tan-pointed coats.
6. **The body is a cylinder, not a box.** The topline lifts over the shoulder,
   dips through the middle and lifts again over the rump, shaded `h → l → m → t
   → d` from the lit top edge down, with a dark band along the bottom third.
7. **Judge every change at 2×.** `base_golden_scales.png` exists for exactly
   this. 2× (128 px) is what the app draws by default, so it is the acceptance
   size: detail that only survives at 6× is wasted, and detail that vanishes at
   2× has to be strengthened or dropped.
8. **The face is small and built from fixed parts.** An eye is a 3×3 block of
   `e` with the `w` specular in the upper-left, a warm `t` glint in the
   lower-right, and a 1-px `k` rim; one darker `d` brow pixel sits above and
   slightly *inward*. The nose is a rounded 5×4 `n` on the snout tip. Pink
   appears in exactly three mouths — `grin`, `pant` and `open` (bark/yawn).
   Every closed mouth, `neutral` included, is dark ink only: a mouth that shows
   pink at rest reads as permanently panting.
9. **Motion is small and the ground is fixed.** The idle breathe is 1 px and
   squashes rows 0–57 while the paws stay planted. Ears and tails move by
   `swing()`, a shear from a fixed root, never by cutting and pasting a block —
   that is what keeps the plume attached to the rump. `mend()` closes the 1-px
   seams a shear leaves behind. Every grounded frame shares row 63.

## How the master pose was made

The five authored poses were traced from the owner's chosen reference renders:
each reference was reduced to the sprite grid with an area-average filter,
mapped to the sheet's 16-colour palette, largest-component filtered (which drops
the references' own `zZ`/`?`/heart decorations), then cleaned by hand — cross-
median smoothing on the coat ramp, despeckling, a fresh 1-px `q` outline, and
hand-authored eyes, nose, mouth, brows, bib, belly band, ear hem and tail
fringe. The reference downsample is an underlay, not the artwork; every face and
every fur accent in the shipped frames is placed by hand in `frames.mjs`.

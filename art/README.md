# Walder — sprite art (v3, fitted from the owner's strips)

Walder is a golden long-haired miniature dachshund (*langhåret dværggravhund*).

**The artwork is the owner's.** Every frame in `walder.json` comes from one of the
thirteen strip illustrations in `design/references/Strips/`, used **1:1**. Nothing
in this directory draws, redraws, retouches or "improves" a pixel: `strips.py`
only *fits* the illustrations onto the sheet grid — background removal, slicing,
one uniform scale per strip, ground-line alignment, area downsampling, and a
nearest-colour map onto the sheet's own 15 colours.

The previous hand-authored pipeline (`frames.mjs`, `trace.py`, `traced/`,
`compare.mjs`) is retired under `art/obsolete/`. It is not run, not imported and
not a reference for anything.

## Running it

```
python3 art/strips.py            # rebuild walder.json from the strips
python3 art/strips.py --report   # the same, plus the measurement tables
node art/render.mjs              # render every PNG + CHECK.txt from walder.json
```

`strips.py` needs Pillow, NumPy and SciPy. `render.mjs` is zero-dependency
(Node built-ins only). Outputs land in `art/out/`, which is generated and can be
deleted and rebuilt at any time.

| path | what |
|---|---|
| `<palette>/<frame>@1x.png` | one PNG per frame per palette, transparent |
| `<palette>/<frame>@2x.png` | **the acceptance size** — the app's default; judge every change here |
| `<palette>/<frame>@3x.png` · `@6x.png` | the large size, and pixel-level work |
| `sheet_<palette>.png` | contact sheet at 2×, one animation per row |
| `sheet_index.txt` | which animation sits on which sheet row |
| `expressions_golden@2x.png` · `@3x.png` | the six expressions side by side |
| `compare_strip_vs_sprite.png` | the owner's original cell beside the sprite it became, at matched height — the honesty check |
| `base_golden_scales.png` | `idle_0`/`idle_1` at 1×–6× |
| `box_compare_64_72_80.png` | only from `--box-compare`; the box-size decision |
| `CHECK.txt` | validation report — must say `RESULT: CLEAN` |

## Files

- **`strips.py`** — the generator, and the only thing that decides what the art
  is. Constants at the top; no per-frame hand-tuning anywhere. Re-running it
  reproduces `walder.json` exactly.
- **`walder.json`** — the artwork as data. **Do not hand-edit**: the next
  `strips.py` run replaces it, and a hand edit is by definition no longer 1:1
  with the owner's illustration.
- **`render.mjs`** — the renderer and validator. Never edits artwork.
- **`refcells/`** — headerless RGBA crops of three original strip cells, written
  by `strips.py` so `render.mjs` can build `compare_strip_vs_sprite.png` without
  a PNG decoder.
- **`obsolete/`** — the retired hand-authored pipeline.

## The strips

Each source is copied to `design/references/Strips/named/<animation>.png`, so the
mapping is a file on disk rather than a comment. Verified frame by frame.

| animation | frames | strip |
|---|---|---|
| `idle` | 4 | `pixel_art_01.png` — breathing; frame 3 lifts the head |
| `blink` | 2 | `…573286` — half-closed, closed |
| `out` | 2 | `…866337` — flat, X eyes; frame 2 has a breath puff |
| `perk` | 3 | `…341644` — resting, lifting, head high with ears flared |
| `tilt` | 3 | `…853216` — frame 3 carries the `?` |
| `sleep` | 3 | `…20058` — curled; frame 3 carries the `z z` |
| `bark` | 4 | `…584196` — frame 3 mouth open with motion lines |
| `walk` | 4 | `…746127` — trot |
| `wake` | 4 | `…834491` — curled, yawn, stretch, shake |
| `tail_wag` | 4 | `…50632` |
| `hop` | 5 | `…768051` — frame 3 airborne |
| `pet` | 6 | `…114291` — hearts from frame 3 |

`Firefly (1).png` and `pixel_art_01.png` are **byte-identical pictures**, so there
is one idle strip and no separate `idle_rare` illustration. Its third frame is
the head-raised, ears-flared beat, which is exactly what `idle_rare` is for — so
`idle_rare` and `ear_flop` replay the idle frames at their own tempo rather than
inventing art the owner did not draw. Likewise there is no sweat drop anywhere in
the thirteen strips, so the sheet has no `sweat` decoration.

## How the fitting works

1. **Slice.** The flat grey ground is removed by a flood fill from the image
   border over "achromatic and mid-grey" pixels, then two constrained dilations
   to eat the anti-aliased fringe and the soft drop shadow. The remainder is
   labelled; the *n* largest components are the *n* dogs, left to right. Every
   smaller component — hearts, `z`, `?`, motion ticks, the breath puff — is
   assigned to the nearest dog and **stays part of that frame**: the owner drew
   them there. Four are *additionally* extracted as standalone decoration
   sprites, for the app's own bubbles.
2. **Normalise.** One scale per strip, chosen so the dog is the same size in
   every strip as it is in `idle`. The size measure is the median
   `sqrt(silhouette area)` of the strip's dogs, **not** bbox height: height is
   meaningless for the curled `sleep` and the flat `out` poses. On the nine
   standing strips the two measures agree to within ±4 % (`--report` prints the
   comparison), so this is the height rule extended to the poses that break it.
   Frames align on their strip's ground line and anchor horizontally on the dog's
   centre of mass, so frames never slide. A paw gap of ≥ 2 px is kept (`hop_1`,
   `hop_2`); anything smaller is sub-pixel slicing noise and the frame aligns on
   its own lowest paw instead, so every grounded frame really touches row 71.
3. **Rasterise.** Area-average (PIL `BOX`) straight from the source rectangle
   into the box, alpha thresholded at 50 %, each surviving pixel mapped to the
   nearest of the 15 sheet colours in **OKLab**, no dithering. Exactly one
   cleanup pass follows: transparent holes fully enclosed by the silhouette and
   no larger than 4 px are filled with their neighbours' majority colour.

## Boxes

| box | size | used by |
|---|---|---|
| `stand` | 72 × 72 | every standing frame — and `out` and `wake`; paws sit on **row 71** |
| `sleep` | 61 × 58 | `sleep_*` only — the tight union box of the three sleep frames |
| `heart` | 8 × 8 | `heart_0/1` |
| `qmark` | 8 × 12 | `qmark` |
| `zz` | 22 × 16 | `zz_0` |

72 × 72 is 144 px on screen at 2×, the owner's stated maximum. Inside it the
standing dog is 47–50 px tall; the headroom carries the perk lift, the airborne
hop frame, the `?` and the pet hearts.

`out` and `wake` are **stand-box** animations even though both start off their
feet: `core/behaviour.ts` emits `{type:'mode', box:'stand'}` immediately before
`play('wake')`, and `core/expression.ts` reaches `out` from the stand-box
cascade. Only `sleep` lives in the sleep box, which is what the tiny fullscreen
window is sized from. Within that 61 × 58 box the curled dog occupies 61 × 40 on
the bottom; the extra 18 rows are the `z z` the owner drew above him in frame 3.

`out` is the one strip that does not sit at the common scale. That illustration is
2.47 dog-widths across — a 72-wide box cannot hold it at full size — so it is
fitted to the box width, at 0.66× the common scale. That is the largest `out` a
72-px box allows, not a choice.

## Letter legend

`.` transparent (a space also works). The coat is an 8-step ramp, light to dark:
`a h l m t d o q`.

| letter | role | golden hex |
|---|---|---|
| `a` | cream — chest bib, belly feathering, ear hem. **Doubles as the tan point** on `black-and-tan` and `chocolate`. | `#FFF3D6` |
| `h` | coat highlight | `#FFE3A6` |
| `l` | coat light | `#FFC67D` |
| `m` | coat mid — the dominant tone | `#E3A454` |
| `t` | coat mid-shadow | `#C47A30` |
| `d` | coat shadow | `#A25F21` |
| `o` | deep shadow | `#7A451A` |
| `q` | outline / silhouette edge | `#5F3415` |
| `k` | deep ink — mouth line, eyelids, glyph outlines | `#3E2411` |
| `e` | eye | `#2D1A0D` |
| `n` | nose | `#1F1208` |
| `w` | eye specular / bubble fill | `#FFFFFF` |
| `p` | tongue, heart | `#FF6188` |
| `z` | sleepy blue | `#4BA2E1` |
| `y` | sleepy blue highlight | `#9CD7FF` |
| `r` `s` `b` | documented aliases of `p` `k` `w`; defined in every palette, never emitted | — |

Only `a h l m t d o q` differ between palettes. `CHECK.txt` asserts that every
letter any frame uses resolves in every palette.

## Palettes

Sampled from Panel C of `design/references/walder_design_sheet_chosen.png`
(per-tone luminance percentiles against the golden ramp, then hand-corrected at
the light end). Unchanged from the previous sheet — the panel has not changed.

| | `a` | `h` | `l` | `m` | `t` | `d` | `o` | `q` |
|---|---|---|---|---|---|---|---|---|
| **golden** (Walder) | `#FFF3D6` | `#FFE3A6` | `#FFC67D` | `#E3A454` | `#C47A30` | `#A25F21` | `#7A451A` | `#5F3415` |
| **red** | `#FFEBD6` | `#F6D3A9` | `#DE9A62` | `#C06B34` | `#9E5228` | `#7E3F1E` | `#5C2C16` | `#431F10` |
| **cream** | `#FFFDF4` | `#FDF0D8` | `#F8E3C0` | `#EBCB9F` | `#D0A87A` | `#B48B60` | `#8E6A45` | `#6E4F32` |
| **black-and-tan** | `#D69A4A` | `#5E5A5B` | `#4E4A4B` | `#3C3839` | `#302D2F` | `#262425` | `#1B1A1B` | `#121112` |
| **chocolate** | `#C8873F` | `#96684A` | `#7A5138` | `#61402B` | `#4E3322` | `#3E281A` | `#2E1D14` | `#22150E` |

Shared: `e #2D1A0D` · `w #FFFFFF` · `n #1F1208` · `k #3E2411` · `p #FF6188`
· `r #FF6188` · `z #4BA2E1` · `y #9CD7FF` · `s #3E2411` · `b #FFFFFF`

## Timing table

Durations are per frame, in milliseconds, and live in `animations` in the JSON,
from `TIMING` in `strips.py`. `hold: true` means freeze on the last frame.

| animation | frames | ms/frame | loop | hold | notes |
|---|---|---|---|---|---|
| `idle` | 4 | 125 | yes | – | the owner's breathe cycle; frame 3 lifts the head |
| `idle_neutral` | 4 | 125 | yes | – | alias of the idle frames |
| `idle_rare` | 4 | 100 | no | – | the same frames, faster — see the note above |
| `ear_flop` | 4 | 100 | no | – | alias of `idle_rare` |
| `blink` | 2 | 83 | no | – | half-closed, closed |
| `idle_happy` · `idle_worried` · `idle_exhausted` | 4 | 125 | yes | – | **temporary** aliases of `idle`, pending the expressions strip |
| `out` | 2 | 1000 | yes | – | collapsed flat, X eyes; frame 2 breathes |
| `confused` | 1 | 700 | yes | – | `tilt_2`, question mark included |
| `tail_wag` | 4 | 100 | yes | – | |
| `walk` | 4 | 125 | yes | – | trot |
| `bark` | 4 | 100 | no | – | frame 3 open-mouthed with motion ticks |
| `pet` | 6 | 125 | no | – | hearts from frame 3 |
| `perk` | 3 | 100 | no | **yes** | ears up — "Claude is done" |
| `tilt` | 3 | 125 | no | **yes** | head cocks — "waiting for you" |
| `hop` | 5 | 100 | no | – | `hop_1` and `hop_2` are airborne |
| `sleep` | 3 | 1000 | yes | – | curled; frame 3 carries the `z z` |
| `wake` | 4 | 125 | no | – | curled → yawn → stretch → shake; hands off to `idle` |
| `heart` | 2 | 300 | yes | – | decoration |
| `qmark` | 1 | 900 | no | – | decoration |
| `zz` | 1 | 700 | yes | – | decoration |

## Expressions

`expressions` maps a mood to an **animation**.

```
neutral → idle_neutral      worried   → idle_worried*     out      → out
happy   → idle_happy*       exhausted → idle_exhausted*   confused → confused
```

`*` = currently the idle frames. When the owner's expressions strip arrives, add
it to `SOURCES` in `strips.py` and change the three values in
`EXPRESSION_ANIMATION` from `"idle"` to their own animation names. That is the
whole change.

## The rules a later coder must keep

1. **The strips are the artwork.** If something looks wrong, fix the *fitting* in
   `strips.py` — never the pixels. A hand-edited frame is no longer the owner's
   drawing, and the next generator run silently deletes it anyway.
2. **Decorations stay in their frames.** The hearts, the `?`, the `z z`, the
   motion ticks and the breath puff are part of the illustrations. The
   standalone `heart`/`qmark`/`zz` sprites are *extra copies* for the app's own
   bubbles, not replacements.
3. **Judge every change at 2×.** That is what the app draws. `base_golden_scales.png`
   and `compare_strip_vs_sprite.png` exist for exactly this.
4. **`CHECK.txt` must stay `CLEAN`,** and the sheet must still pass the app's own
   `validateSheet` + `requireSheetContract` (`npm run sync:sheet` enforces it).

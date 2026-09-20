# Walder — sprite art (v4 pipeline, fitted from the owner's strips)

Walder is a golden long-haired miniature dachshund (*langhåret dværggravhund*), and
since 2026-09-09 he has a silver dapple cousin who is the same dog in a coat no
palette can express.

**The artwork is the owner's.** Every frame in `walder.json` comes from a strip
illustration in `design/references/strips/`, used **1:1**. Nothing in this
directory draws, redraws, retouches or "improves" a pixel: `strips.py` only
*fits* the illustrations onto the sheet grid — background removal, slicing, one
uniform scale per strip, ground-line alignment, area downsampling, and a
nearest-colour map onto the sheet's own 15 colours.

The previous hand-authored pipeline (`frames.mjs`, `trace.py`, `traced/`,
`compare.mjs`) is retired under `art/obsolete/`. It is not run, not imported and
not a reference for anything.

> **Path casing.** The strips live in `design/references/strips/` — lower case,
> which is how git tracks the directory. `strips.py` used to spell it `Strips`,
> which worked only because this Mac's filesystem is case-insensitive; on a
> case-sensitive checkout every strip vanished and the build failed with
> "matched 0 files". Do not reintroduce the capital.

## Running it

```
python3 art/strips.py                  # rebuild walder.json from the strips
python3 art/strips.py --report         # the same, plus the measurement tables
python3 art/strips.py --measure-decor  # where the legacy ? and z z actually sit
python3 art/strips.py --require-set dapple   # fail instead of skipping a coat
python3 art/strips.py --legacy-bg      # force the grey background rule everywhere
node art/render.mjs                    # every PNG + CHECK.txt from walder.json
python3 art/tools/synth_strip.py       # exercise the v4 path with no v4 art
```

`strips.py` needs Pillow, NumPy and SciPy. `render.mjs` is zero-dependency
(Node built-ins only). Outputs land in `art/out/`, which is generated and can be
deleted and rebuilt at any time.

| path | what |
|---|---|
| `<palette>/<frame>@1x.png` | one PNG per frame per palette, transparent — **from the frame set that palette draws** |
| `<palette>/<frame>@2x.png` | **the acceptance size** — the app's default; judge every change here |
| `<palette>/<frame>@3x.png` · `@6x.png` | the large size, and pixel-level work |
| `sheet_<palette>.png` | contact sheet at 2×, one animation per row |
| `sheet_index.txt` | which animation sits on which sheet row |
| `expressions_<palette>@2x.png` · `@3x.png` | the six expressions side by side, once per coat that draws its own set |
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
- **`tools/synth_strip.py`** — fabricates strips out of legacy cells so the v4
  code paths can be tested before the v4 art exists. See "The fallback rule".
- **`refcells/`** — headerless RGBA crops of three original strip cells, written
  by `strips.py` so `render.mjs` can build `compare_strip_vs_sprite.png` without
  a PNG decoder.
- **`obsolete/`** — the retired hand-authored pipeline.

## Sound asset provenance

`src/renderer/assets/bark.wav` is the single bark from
[freesound.org sound 630648, "single bark - small to medium dog" by haulaway](https://freesound.org/people/haulaway/sounds/630648/),
uploaded 2022-04-27 under **Creative Commons 0** (public domain dedication: copying,
modifying and redistributing, commercially too, with no attribution required —
credited here anyway). Converted 2026-09-20 with macOS `afconvert` to PCM 16-bit mono
48 kHz, the leading silence removed down to 2 ms before the bark's onset (−30 dBFS),
cut to the 224 ms bark with a 1 ms fade-in and a 10 ms fade-out, no level
change (peak −7.6 dBFS). SHA-256
`0907c6c241c3f459abdcff4046c89ed9178f4e703ec14832e41a01d8f24f9520`.

It replaces a clip cut from an Epidemic Sound recording: that Pro licence covers
synchronisation in video and podcast productions only and forbids making the work
available on a standalone basis, which a WAV inside a downloadable app is.

## The strips

Two coat **sets**, resolved strip by strip. A set's strips are looked for in
`v4/<set>/` first; only the golden set has a fallback (the 0.1.2 Firefly exports
one directory up), because there is no legacy dapple art. Each resolved strip is
copied to `design/references/strips/named/<set>/<strip>.png`, so the mapping from
a Firefly filename to an animation is a file on disk rather than a comment.

| strip | frames | golden source | dapple source | what the frames show |
|---|---|---|---|---|
| `idle` | 6 | `v4/golden/idle.png`, else the legacy 4-frame strip | `v4/dapple/idle.png` | rest · chest +1 · chest +2 · eyes half · eyes shut · ears flicked |
| `idle_happy` | 5 | `v4/golden/idle_happy.png`, else absent | `v4/dapple/…` | 3 breathing + the blink pair, happy face |
| `idle_worried` | 5 | ” | ” | ” worried face, one sweat drop (baked in) |
| `idle_exhausted` | 5 | ” | ” | ” exhausted face, tongue out |
| `out` | 2 | `…866337` | `v4/dapple/out.png` | flat, X eyes; frame 2 has a breath puff |
| `perk` | 3 | `…341644` | ” | resting, lifting, head high with ears flared |
| `tilt` | 3 | `v4/golden/tilt.png`, else `…853216` | ” | straight, slight tilt, full tilt — **no `?`** |
| `sleep` | 3 | `v4/golden/sleep.png`, else `…20058` | ” | curled, wide framing — **no `z z`** |
| `bark` | 4 | `…584196` | ” | frame 3 mouth open with motion ticks |
| `walk` | 4 | `…746127` | ” | trot |
| `wake` | 4 | `…834491` | ” | curled, yawn, stretch, shake (frame 4 sprays ticks) |
| `tail_wag` | 4 | `…50632` | ” | |
| `hop` | 5 | `…768051` | ” | frames 2 and 3 airborne |
| `pet` | 6 | `…114291` | ” | shared heart from frame 3 |

Plus two strips that are never a set's art:

- **the legacy `blink` strip** (`…573286`, 2 frames) is loaded *only* when the
  golden `idle` falls back to the legacy 4-frame illustration. On the v4 strip the
  blink comes out of the idle strip itself, keeping it consistent with the
  first frame used for the still idle. The remaining breathing and ear-flick
  source frames are retained but never played.
- The standalone `heart`, `qmark` and `zz` sprites are the only glyph art the
  runtime draws; their anchors are emitted for every coat set.

A file may keep its Firefly name as long as the strip name appears in it; an
exact `<strip>.png` is preferred and always wins. A fragment matching two files
is an error rather than a coin toss.

### The fallback rule

Every strip resolves individually, and the pipeline is green at every point
between "no v4 art at all" and "all twenty strips". This is not politeness — the
owner generates the strips one at a time over days, and a pipeline that only
works at the end is one he cannot check his work with.

- **No `v4/golden/idle.png`.** The legacy 4-frame idle and the legacy blink strip
  are used: `idle` holds frame 0 in a one-second loop and `blink` uses 2×83 ms.
  There is no `idle_rare` or `blink_neutral`.
- **The moment `v4/golden/idle.png` exists,** the new tables apply and the legacy
  blink strip is not loaded at all.
- **A missing mood strip** aliases both `idle` and `blink` from neutral art,
  so every mood stays still and blinks while its own strip is pending.
- **Every `pet`, `tilt` and `sleep` strip** omits its detached glyph component and
  emits decoration anchors, so the app uses the same heart, `?` and `z z` for
  every coat.
- **The dapple set needs all fourteen strips**, at the same frame counts the
  golden set resolved. Short of that the build prints what is missing and skips
  the set — golden work is never blocked by unfinished dapple work. Pass
  `--require-set dapple` to make it a failure instead.
- **A missing golden strip that has no fallback either** is a hard error: the app
  cannot be drawn without it.

`python3 art/tools/synth_strip.py` is how the *v4* half is tested without v4 art.
It lifts the dog out of a legacy illustration, stamps him N times onto a flat
canvas, writes that into a throwaway `v4/` tree under `art/out/synthetic/`, runs
the real pipeline against it and asserts the animation tables, the sleep
headroom, the anchors and the frame-set parity. The fabricated PNGs never go near
`design/references/strips/v4/` — that folder is the owner's drop box, and a fake
dog in it would be indistinguishable from a real one.

## How the fitting works

1. **Slice.** The background is removed by a flood fill from the image border,
   then two constrained dilations to eat the anti-aliased fringe and the soft drop
   shadow. Two rules are available and each set uses one:
   - **`legacy`** (the golden set) — "achromatic and mid-grey". The rule 0.1.2
     shipped. It cannot read the dapple strips: a silver dog *is* achromatic
     mid-grey, and the fringe passes would chew two pixels off every un-outlined
     silver edge.
   - **`border`** (the dapple set) — whatever colour the outer 8-px ring is, at
     an OKLab tolerance of 0.06 (0.10 for the fringe). This is why the dapple
     prompts ask for a flat green `#3FA34D` background: ground and coat then
     cannot be confused. The golden set stays on `legacy` because `border` does
     **not** reproduce the approved golden frames byte for byte on the legacy
     strips — all 48 frames move, ~20,000 cells in total, and two boxes grow a
     row — so switching it would silently re-quantise art the owner has already
     signed off. `--legacy-bg` forces `legacy` everywhere.

   What survives is labelled; the *n* largest components are the *n* dogs, left
   to right. Every smaller component is assigned to the nearest dog. The approved
   exception is `pet`, `tilt` and `sleep`: their detached heart, `?` and `z z`
   components are omitted so the app can draw the shared decoration sprites.

   A **v4** strip that carries a component the pipeline was not told to expect
   **fails the build**. The allow-list is `EXPECTED_DECOR = {pet, idle_worried,
   bark, out, wake}`, and the failure is the point: `tilt` and `sleep` are being
   regenerated precisely to remove a glyph, so they are the two strips where
   Firefly is most likely to put it back — and a baked `?` would be mirrored
   backwards on half the screen with nothing in any log to say why. Legacy strips
   are reported but never failed: they are the approved 0.1.2 art, glyphs and all.
2. **Normalise.** One scale per strip, chosen so the dog is the same size in
   every strip — **and in every coat set** — as he is in `idle`. One common `k`
   across all sets is the whole point: the coat switcher swaps frame sets under a
   running animation, and a per-set scale would make the dog change size when his
   colour changed. (Adding the dapple set can therefore lower `k` slightly and
   re-quantise the golden frames. Expected — the owner re-approves the golden
   gallery once when the second coat lands.)

   The size measure is the median `sqrt(silhouette area)` of the strip's dogs,
   **not** bbox height: height is meaningless for the curled `sleep` and the flat
   `out` poses. On the standing strips the two measures agree to within ±4 %
   (`--report` prints the comparison), so this is the height rule extended to the
   poses that break it. Frames align on their strip's ground line and anchor
   horizontally on the dog's centre of mass, so frames never slide. A paw gap of
   ≥ 2 px is kept (`hop_1`, `hop_2`); anything smaller is sub-pixel slicing noise
   and the frame aligns on its own lowest paw instead, so every grounded frame
   really touches row 71.

   Across sets, every frame's tight bounding box is then compared with the base
   set's: **warn above 3 %, fail above 5 %.** A stockier dapple drawing would
   otherwise make the dog visibly jump size on a coat switch. This check runs on
   every build, not only under `--report`.
3. **Rasterise.** Area-average (PIL `BOX`) straight from the source rectangle
   into the box, alpha thresholded at 50 %, each surviving pixel mapped to the
   nearest of **that set's** 15 colours in **OKLab**, no dithering. Exactly one
   cleanup pass follows: transparent holes fully enclosed by the silhouette and
   no larger than 4 px are filled with their neighbours' majority colour.

## Boxes

| box | size | used by |
|---|---|---|
| `stand` | 72 × 72 | every standing frame — and `out` and `wake`; paws sit on **row 71** |
| `sleep` | 61 × 58 | `sleep_*` only — the tight union box across every set, plus the headroom below |
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
window is sized from.

**Sleep headroom.** Within the 61 × 58 sleep box the curled dog occupies about
61 × 40 along the bottom. The extra 18 rows are reserved for the universal `z z`:
`SLEEP_DECOR_HEADROOM_ROWS = 18` transparent rows are kept above the tight union
box, because the fullscreen sleep window is sized from this box and has no
reserve of its own — so the `z z` the app now draws itself would otherwise have
nowhere to go. Eighteen rows is exactly what the owner's own glyph occupied, so
the box, the window and the picture are identical either way. The headroom is
applied to every sleep strip, keeping the universal glyph in the same place
across coat sets.

`out` is the one strip that does not sit at the common scale. That illustration is
2.47 dog-widths across — a 72-wide box cannot hold it at full size — so it is
fitted to the box width, at 0.66× the common scale. That is the largest `out` a
72-px box allows, not a choice.

## Decoration anchors

The app draws the `?` and the `z z` itself, un-mirrored, so they read the right
way round when the dog turns to face the screen. `strips.py` tells it where:

```json
"decorAnchors": { "tilt": { "qmark": { "x": 24, "y": 6 } },
                  "confused": { "qmark": { "x": 24, "y": 6 } },
                  "sleep": { "zz": { "x": 37, "y": 0 } },
                  "pet": { "heart": { "x": 14, "y": 3 } } }
```

Top-left of the decoration box, sprite pixels, in the animation's own box, in the
art's orientation (facing left) — the renderer mirrors the x at draw time
(`mirrorAnchorX`), so one anchor per animation is the truth and a second mirrored
copy is not something the pipeline can get out of step with itself.

They come from `DECOR_ANCHORS`, a hand table of **two numbers per glyph in
dog-size units**: the offset from the reference frame's dog — its centre-of-mass
column and its topmost ink row — to the glyph's top-left corner, in multiples of
`k`. Measured in the dog rather than in the box, so they survive a box change or
a new coat set, and applied by arithmetic, which is what keeps the "no per-frame
hand-tuning" rule intact. The values are seeded from
`python3 art/strips.py --measure-decor`, then stored as dog-relative offsets so
every coat uses the same placement.

`tilt` and `confused` share `tilt_2` and therefore share an anchor, but both are
listed: the renderer looks anchors up by *animation*, and `mirrorReady`
(`src/sprites/contract.ts`) refuses to mirror the dog unless every animation that
plays a decorated frame has one. A sheet that landed half-migrated stays
un-mirrored rather than shipping one correct glyph and one backwards one.

## Frame sets

`frames` is the golden set and stays the base: `gen-icons` takes `idle_0` from
it, `render.mjs` builds its comparison sheets from it, and the window geometry
and hit mask are the same for every set because every set shares its boxes.

A coat a palette cannot express carries its own drawing instead:

```json
"frameSets":        { "dapple": { "idle_0": …, "sleep_0": …, … } },
"paletteFrameSets": { "silver-dapple": "dapple" }
```

Each set draws **exactly the base set's frame names, in the same boxes, at the
same dimensions** — `src/sprites/types.ts` refuses a sheet where that is not
true, because the coat switcher swaps sets mid-animation and keeps the frame
index. The three glyph sprites are copied into every set verbatim: they are ink
rather than coat, and there is nowhere else to get them.

`framesFor(sheet, palette)` (`src/sprites/contract.ts`) is the one call every
renderer makes instead of reading `sheet.frames`. An unknown coat, or a coat
naming a set the sheet does not carry, falls back to the base set.

**Size.** One set of 48 frames is 257 KB of JSON today. The v4 art adds frames
(a six-frame idle and three five-frame mood strips) and a second set doubles
whatever that comes to, so the finished two-coat sheet is expected around
**650 KB** — about 2.5× today. It is a static import, so it is parsed once at
bundle time and structured-cloned once per window that asks for it: against a
mascot that has to stay under 1 % CPU forever, a one-off cost at startup and
nothing per frame. Acceptable; worth knowing before a third coat is added.

## Letter legend

`.` transparent (a space also works). The coat is an 8-step ramp; on golden it
runs light to dark, and on silver dapple it does not — see the note under
Palettes.

| letter | golden role | golden hex | dapple role | dapple hex |
|---|---|---|---|---|
| `a` | cream — chest bib, belly feathering, ear hem | `#FFF3D6` | silver light | `#B9A693` |
| `h` | coat highlight | `#FFE3A6` | **silver mid — the base coat** | `#A28D7D` |
| `l` | coat light | `#FFC67D` | tan light — brows, muzzle sides, chest, paws | `#EED1AC` |
| `m` | coat mid — the dominant tone | `#E3A454` | silver dark | `#848182` |
| `t` | coat mid-shadow | `#C47A30` | tan dark | `#AE7740` |
| `d` | coat shadow | `#A25F21` | charcoal blotch | `#66605B` |
| `o` | deep shadow | `#7A451A` | black blotch | `#494542` |
| `q` | outline / silhouette edge | `#5F3415` | outline | `#0F0E0D` |
| `k` | deep ink — mouth line, eyelids, glyph outlines | `#3E2411` | shared | `#3E2411` |
| `e` | eye | `#2D1A0D` | shared | `#2D1A0D` |
| `n` | nose | `#1F1208` | shared | `#1F1208` |
| `w` | eye specular / bubble fill | `#FFFFFF` | shared | `#FFFFFF` |
| `p` | tongue, heart | `#FF6188` | shared | `#FF6188` |
| `z` | sleepy blue | `#4BA2E1` | shared | `#4BA2E1` |
| `y` | sleepy blue highlight | `#9CD7FF` | shared | `#9CD7FF` |
| `r` `s` `b` | documented aliases of `p` `k` `w`; defined in every palette, never emitted | — | — | — |

Only `a h l m t d o q` differ between palettes. `CHECK.txt` asserts that every
letter any frame of any set uses resolves in every palette.

## Palettes

Sampled from Panel C of `design/references/walder_design_sheet_chosen.png`
(per-tone luminance percentiles against the golden ramp, then hand-corrected at
the light end). `silver-dapple` was subsequently re-sampled from the approved
dapple source-strip cluster medians. The menu order is the insertion order below.

| | `a` | `h` | `l` | `m` | `t` | `d` | `o` | `q` |
|---|---|---|---|---|---|---|---|---|
| **golden** (Walder) | `#FFF3D6` | `#FFE3A6` | `#FFC67D` | `#E3A454` | `#C47A30` | `#A25F21` | `#7A451A` | `#5F3415` |
| **red** | `#FFEBD6` | `#F6D3A9` | `#DE9A62` | `#C06B34` | `#9E5228` | `#7E3F1E` | `#5C2C16` | `#431F10` |
| **cream** | `#FFFDF4` | `#FDF0D8` | `#F8E3C0` | `#EBCB9F` | `#D0A87A` | `#B48B60` | `#8E6A45` | `#6E4F32` |
| **black-and-tan** | `#5E5A5B` | `#5E5A5B` | `#4E4A4B` | `#3C3839` | `#302D2F` | `#262425` | `#1B1A1B` | `#121112` |
| **chocolate** | `#C8873F` | `#96684A` | `#7A5138` | `#61402B` | `#4E3322` | `#3E281A` | `#2E1D14` | `#22150E` |
| **silver-dapple** | `#B9A693` | `#A28D7D` | `#EED1AC` | `#848182` | `#AE7740` | `#66605B` | `#494542` | `#0F0E0D` |

Shared: `e #2D1A0D` · `w #FFFFFF` · `n #1F1208` · `k #3E2411` · `p #FF6188`
· `r #FF6188` · `z #4BA2E1` · `y #9CD7FF` · `s #3E2411` · `b #FFFFFF`

`silver-dapple` is last, so it is last in the tray's Colour menu, and it is
emitted **only when its frame set was actually built** — a coat in the menu
drawing golden pixels in silver would be a lie the owner cannot see through.

Two things about that row are deliberate and easy to "fix" by mistake:

- **The hexes are fitted source medians.** They replaced the original reference
  photograph seeds after the approved dapple `idle` strip landed, preserving the
  light-brown band at sprite size.
- **The ramp is not monotonic in luminance.** A dapple dog is two hue families at
  once: cool silver (`a h m`), warm tan points (`l t`) and near-black blotches
  (`d o q`). Forcing one luminance order on them would turn every tan brow grey.

## Timing table

Durations are per frame, in milliseconds, and live in `animations` in the JSON,
from `ANIMATIONS_*` in `strips.py` — **the only source of timing**. `hold: true`
means freeze on the last frame.

### With the v4 idle strip

| animation | frames | ms/frame | loop | hold | notes |
|---|---|---|---|---|---|
| `idle` · `idle_neutral` | `idle` 0 | 1000 | yes | – | holds the first frame; each loop boundary lets the scheduler check whether a blink is due |
| `blink` · `blink_neutral` | `idle` 3-4-3 | 83 | no | – | symmetric, so it splices back without a pop; both frames drawn AT REST so the chest does not jump |
| `idle_happy` · `idle_worried` · `idle_exhausted` | that strip 0 | 1000 | yes | – | holds the mood's own first frame |
| `blink_happy` · `blink_worried` · `blink_exhausted` | that strip 3-4-3 | 83 | no | – | so a worried dog blinks worried |

There is deliberately **no `idle_rare` or `idle_rare_<mood>`**: all resting
expressions hold their first frame and only blink. Breathing, head lifts and
ear-flicks are never scheduled. `IDLE_STILL_MS` sets the one-second boundary;
the same image remains visible while the scheduler checks whether a blink is due.

### With the legacy idle strip (the fallback)

| animation | frames | ms/frame | loop | hold | notes |
|---|---|---|---|---|---|
| `idle` · `idle_neutral` | `idle` 0 | 1000 | yes | – | holds the first frame; the head-lift frame is never played |
| `blink` | legacy `blink` 0-1 | 83 | no | – | half-closed, closed |
| `idle_happy` · `idle_worried` · `idle_exhausted` | `idle` 0 | 1000 | yes | – | neutral fallback when that mood strip is absent |
| `blink_happy` · `blink_worried` · `blink_exhausted` | legacy `blink` 0-1 | 83 | no | – | matching neutral blink fallback when that mood strip is absent |

No `blink_neutral` in this table: the scheduler falls back to `blink` for neutral.
An available mood strip always supplies its own still pose and blink pair, even
when the neutral idle still uses legacy art.

### Unchanged either way

| animation | frames | ms/frame | loop | hold | notes |
|---|---|---|---|---|---|
| `out` | 2 | 1000 | yes | – | collapsed flat, X eyes; frame 2 breathes |
| `confused` | 1 (`tilt_2`) | 700 | yes | – | the held tilt as a one-frame loop |
| `tail_wag` | 4 | 100 | yes | – | |
| `walk` | 4 | 125 | yes | – | trot |
| `bark` | 4 | 100 | no | – | frame 3 open-mouthed with motion ticks |
| `pet` | 6 | 125 | no | – | hearts from frame 3 |
| `perk` | 3 | 100 | no | **yes** | ears up — "Claude is done" |
| `tilt` | 3 | 125 | no | **yes** | head cocks — "waiting for you" |
| `hop` | 5 | 100 | no | – | `hop_1` and `hop_2` are airborne |
| `sleep` | 3 | 1000 | yes | – | curled |
| `wake` | 4 | 125 | no | – | curled → yawn → stretch → shake; hands off to `idle` |
| `heart` | 2 | 300 | yes | – | decoration |
| `qmark` | 1 | 900 | no | – | decoration |
| `zz` | 1 | 700 | yes | – | decoration |

`ear_flop` is **retired** (2026-09-09). It was an alias of `idle_rare` referenced
by nothing but a stale gallery comment.

## Expressions

`expressions` maps a mood to an **animation**, and every value is guaranteed to
exist: a mood with its own strip gets its own animation, and a mood without one
is aliased onto the idle frames. So it is a flat table rather than a cascade.

```
neutral → idle_neutral      worried   → idle_worried     out      → out
happy   → idle_happy        exhausted → idle_exhausted   confused → confused
```

The app's own cascade (`pickAnimation`, `src/core/expression.ts`) is separate and
degrades further, for sheets that carry fewer names than these.

## The rules a later coder must keep

1. **The strips are the artwork.** If something looks wrong, fix the *fitting* in
   `strips.py` — never the pixels. A hand-edited frame is no longer the owner's
   drawing, and the next generator run silently deletes it anyway.
2. **No per-frame hand-tuning.** Every number is a named constant at the top of
   `strips.py`, including the decoration anchors, which are two numbers per glyph
   in dog-size units and are turned into pixels by arithmetic.
3. **Only the approved detached glyphs are omitted.** `pet`, `tilt` and `sleep`
   use the standalone `heart`/`qmark`/`zz` sprites; all other decorative marks
   remain part of the illustrations.
4. **`ANIMATIONS` is the only source of timing,** and the only place frames are
   assembled into animations. A strip that no animation uses, or a frame
   reference past the end of a strip, fails the build before a pixel is read.
5. **Judge every change at 2×.** That is what the app draws.
   `base_golden_scales.png` and `compare_strip_vs_sprite.png` exist for exactly
   this, and `npm run sprites` is where the *motion* is approved.
6. **`CHECK.txt` must stay `CLEAN`,** and the sheet must still pass the app's own
   `validateSheet` + `requireSheetContract` (`npm run sync:sheet` enforces it).

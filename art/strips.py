#!/usr/bin/env python3
"""
art/strips.py — build ``art/walder.json`` from the owner's strip illustrations.

    python3 art/strips.py                  # rebuild walder.json (+ refcells), print the summary
    python3 art/strips.py --report         # the same, plus the measurement tables
    python3 art/strips.py --measure-decor  # where the legacy glyphs actually sit
    python3 art/strips.py --require-set dapple
                                           # fail instead of skipping a coat set
    python3 art/strips.py --legacy-bg      # force the old background rule everywhere
    python3 art/strips.py --box-compare 64 72 80
                                           # extra: art/out/box_compare_*.png

The owner's instruction is binding: **the strip illustrations are used 1:1.**
Nothing here draws, redraws, retouches or "improves" a pixel. Every operation is
a *fitting* operation — background removal, slicing, one uniform scale per strip,
alignment on the ground line, area downsampling, and a nearest-colour map onto
the sheet's own 15 colours. The old hand-authored pipeline (``frames.mjs``,
``trace.py``, ``traced/``) is retired under ``art/obsolete/`` and is not used.

WHAT CHANGED ON 2026-09-09 (stages A–C of the 0.2 plan), and why
----------------------------------------------------------------
Four owner requests reshaped this file at once, and they are easier to read as
one change than as four:

1. **One strip can now feed several animations.** The old ``SOURCES`` table
   hard-wired one strip to one animation, which made the new six-frame idle
   strip impossible to express. It originally supplied breathing, blink and
   ear-flick animations from ONE image; the owner's later still-idle decision
   keeps only frame 1 at rest and frames 4–5 for blinking. That is why
   the tables are now split three ways — ``STRIP_FRAMES`` (how many dogs are in
   a strip), ``SOURCE_KEYS`` (which file, per coat set) and ``ANIMATIONS`` (which
   frames, in which order, at what tempo). ``ANIMATIONS`` is the only source of
   timing.
2. **The glyphs move out of the art.** The dog is mirrored when he stands on the
   left half of a display, and a ``?`` painted into ``tilt_2`` mirrors with him
   and comes out backwards. So the regenerated ``tilt``/``sleep`` strips carry no
   glyph, and this file emits ``decorAnchors`` telling the app where to draw them
   itself. The standalone ``qmark``/``zz`` sprites still come from the LEGACY
   strips, which are the only place those glyphs are drawn.
3. **A second coat that a palette swap cannot express.** A silver dapple dog has
   irregular black blotches; no letter remap produces spots. So the sheet grew a
   second *frame set*, quantised against its own ramp, and every set is fitted
   at ONE common scale so the dog does not change size when the coat is switched.
4. **The strips do not all exist yet.** The owner generates them one at a time,
   and a pipeline that only works once all twenty have landed is a pipeline he
   cannot check his work with. So every strip resolves individually: v4 art if it
   is there, the legacy Firefly export if it is not, and a printed line either
   way. With an empty ``v4/`` tree this file reproduces the 0.1.2 sheet (bar the
   retired ``ear_flop``); with a full one it produces the 0.2 sheet; and it is
   green at every point in between.

Pipeline
--------
0. **Resolve and name.** Each coat set is resolved strip by strip (see
   ``resolve_set``) and copied to
   ``design/references/strips/named/<set>/<strip>.png`` so the mapping from a
   Firefly filename to an animation is a file on disk, not a comment.
1. **Slice.** The flat background is removed by a flood fill from the image
   border, then two constrained dilations to eat the anti-aliased fringe and the
   soft drop shadow. What is left is labelled into connected components; the
   ``n`` largest are the ``n`` dogs, left to right. Every smaller component
   (hearts, ``z``, ``?``, motion ticks, the breath puff) is assigned to the
   nearest dog and stays **part of that frame** — the owner drew them there.
   Three of them are *additionally* extracted as standalone decoration sprites
   for the app to draw. A strip that carries a decoration the pipeline was not
   told to expect FAILS (``EXPECTED_DECOR``), because the commonest way for a
   regenerated strip to be wrong is Firefly adding back the ``?`` it was told to
   leave out.
2. **Normalise.** One scale per strip, so that the dog is the same size in every
   strip — and in every coat set — as he is in ``idle``. The size measure is the
   median ``sqrt(silhouette area)`` of the strip's dogs, not the bbox height:
   height is meaningless for the curled ``sleep`` and the flat ``out`` poses. On
   the standing strips the two measures agree to within ±4 %, so this is the same
   normalisation the height rule would give, extended to the poses where the
   height rule breaks. Frames are aligned on their strip's ground line (the
   lowest paw row of the strip) and anchored horizontally on the dog's centre of
   mass, so frames do not slide. A frame whose paws sit more than
   ``LIFT_EPSILON_PX`` above the ground line keeps that gap (``hop_2``, ``hop_1``);
   anything less is sub-pixel slicing noise and is snapped down.
3. **Rasterise.** Each frame is area-averaged (PIL ``BOX``) straight from the
   source rectangle into the box, alpha is thresholded at 50 %, and each surviving
   pixel is mapped to the nearest colour of *that set's* ramp in OKLab — no
   dithering. One cleanup pass follows and only one: transparent holes fully
   enclosed by the silhouette and no larger than ``MAX_HOLE_PX`` are filled with
   their neighbours' majority colour.
4. **Write.** ``art/walder.json`` plus ``art/refcells/`` — raw RGBA crops of three
   original strip cells that ``render.mjs`` puts beside the finished sprites in
   ``compare_strip_vs_sprite.png`` (kept as raw buffers so ``render.mjs`` stays
   dependency-free and needs no PNG decoder).

Nothing in this file is hand-tuned per frame. Every number is a named constant
below — including the decoration anchors, which are two numbers per glyph in
*dog-size units* and are turned into pixels by arithmetic — and re-running it
reproduces ``walder.json`` exactly.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
from collections import Counter
from pathlib import Path
from typing import NamedTuple

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
#: Lower-case, because that is how the repo tracks it. The old spelling
#: (``"Strips"``) only ever worked because this Mac's filesystem is
#: case-insensitive; on a case-sensitive checkout — CI, or a Linux box — every
#: strip vanished and the build failed with "matched 0 files".
STRIPS = ROOT / "design" / "references" / "strips"
V4 = STRIPS / "v4"
NAMED = STRIPS / "named"
OUT_JSON = HERE / "walder.json"
REFCELLS = HERE / "refcells"

# --------------------------------------------------------------------------- #
# 1. The strips                                                                #
# --------------------------------------------------------------------------- #

#: strip -> how many dogs are in the v4 illustration. Frames are named
#: ``<strip>_<i>``, ``i`` counting from the left.
#:
#: The ORDER is the order the frames land in the JSON, and it is deliberately the
#: order the retired ``SOURCES`` table used (with the three mood strips inserted
#: after ``idle``, where they belong): a reordering here shows up as a
#: whole-file diff on ``walder.json`` and hides the change that actually
#: mattered.
STRIP_FRAMES: dict[str, int] = {
    "idle": 6,  # rest · chest +1 · chest +2 · eyes half · eyes shut · ears flicked
    "idle_happy": 5,  # 3 breathing + half-closed + closed, happy face
    "idle_worried": 5,  # ... worried face, one sweat drop (baked in, EXPECTED_DECOR)
    "idle_exhausted": 5,  # ... exhausted face, tongue out
    "out": 2,  # flat, X eyes; frame 2 has a breath puff
    "perk": 3,  # resting, lifting, head high with ears flared
    "tilt": 3,  # straight, slight tilt, full tilt — and NO question mark
    "sleep": 3,  # curled; wide framing — and NO z z
    "lie": 3,  # settled low, paws forward; its own wide framing
    "bark": 4,  # frame 3 mouth open with motion lines
    "walk": 4,  # trot
    "wake": 4,  # curled, yawn, stretch, shake
    "tail_wag": 4,
    "hop": 5,  # frames 2 and 3 airborne
    "pet": 6,  # hearts from frame 3
}

#: Yuna keeps the shared strip vocabulary, but her approved yarn play begins
#: with four setup frames and then loops on the final two; her tail wag is a
#: compact three-frame cycle. Those source frames are deliberately not squeezed
#: into Walder's older counts.
YUNA_STRIP_FRAMES: dict[str, int] = {
    **STRIP_FRAMES,
    "perk": 6,
    "tail_wag": 3,
}

#: Strips the owner is regenerating that have no legacy counterpart at all.
#: Missing ones are not an error: the mood idles fall back to aliasing ``idle``,
#: which is exactly what the 0.1.2 sheet did.
OPTIONAL_STRIPS = frozenset({"idle_happy", "idle_worried", "idle_exhausted", "lie"})

#: The legacy Firefly exports, one directory up from ``v4/``: ``(filename or a
#: unique fragment of it, frame count)``.
#:
#: This table is the *fallback*, and it carries its own frame counts because the
#: legacy idle strip has four dogs where the v4 one has six. It is also where
#: eight strips that are not being regenerated at all live permanently
#: (``out perk bark walk wake tail_wag hop pet``) — the owner is only redrawing
#: the idle family, ``tilt`` and ``sleep``.
#:
#: ``blink`` has no v4 entry on purpose: the v4 blink comes out of the idle
#: strip, so the separate blink illustration is only loaded when the legacy idle
#: is in use. ``Firefly (1).png`` and ``pixel_art_01.png`` are byte-for-byte the
#: same picture (identical pixels, different PNG metadata), so there is exactly
#: one legacy idle strip.
LEGACY_SOURCES: dict[str, tuple[str, int]] = {
    "idle": ("pixel_art_01.png", 4),  # breathing; frame 3 lifts the head
    "blink": ("573286", 2),  # half-closed, closed
    "out": ("866337", 2),
    "perk": ("341644", 3),
    "tilt": ("853216", 3),  # frame 3 carries the question mark
    "sleep": ("20058", 3),  # frame 3 carries the z z
    "bark": ("584196", 4),
    "walk": ("746127", 4),
    "wake": ("834491", 4),
    "tail_wag": ("50632", 4),
    "hop": ("768051", 5),
    "pet": ("114291", 6),
}

#: Coat sets, in the order they are built and reported. ``golden`` is the base
#: set: its frames are the sheet's ``frames``, every other set lands in
#: ``frameSets``.
YUNA_SETS = (
    "yuna-grey-tabby", "yuna-orange-tabby", "yuna-black", "yuna-tuxedo", "yuna-calico"
)
SETS: tuple[str, ...] = ("golden", "dapple", *YUNA_SETS)
BASE_SET = "golden"

#: Where each set's strips are looked for, in order. The first directory wins,
#: so a v4 file always overrides the legacy export of the same name.
#:
#: ``dapple`` has no legacy directory because there is no legacy dapple art: the
#: coat is new. That is why a partly-generated dapple set is *skipped* rather
#: than patched with golden strips — a silver dog with two golden legs is worse
#: than no silver dog.
SET_DIRS: dict[str, tuple[Path, ...]] = {
    "golden": (V4 / "golden", STRIPS),
    "dapple": (V4 / "dapple",),
    **{set_name: (V4 / set_name,) for set_name in YUNA_SETS},
}

#: Which coat ramp each set is quantised against (see ``letter_table``).
SET_COAT: dict[str, str] = {
    "golden": "golden",
    "dapple": "silver-dapple",
    "yuna-grey-tabby": "yuna-grey-tabby",
    "yuna-orange-tabby": "yuna-orange-tabby",
    "yuna-black": "yuna-black",
    "yuna-tuxedo": "yuna-tuxedo",
    "yuna-calico": "yuna-calico",
}

#: Which background detector each set uses by default (see ``background_mask``).
#:
#: ``golden`` stays on the legacy achromatic-grey rule, and that is a *result*,
#: not a preference: the border-keyed detector does not reproduce the shipped
#: golden frames byte for byte, so making it the default would silently
#: re-quantise thirteen strips the owner has already approved. It is the right
#: rule for the dapple strips, whose silver base coat the grey rule would eat as
#: background, and those strips are drawn on flat green for exactly that reason.
BG_DETECTOR_BY_SET: dict[str, str] = {
    "golden": "legacy",
    "dapple": "border",
    **{set_name: "border" for set_name in YUNA_SETS},
}

#: Which box each strip's frames are written into. ``wake`` is a *stand* box
#: animation even though it starts curled: ``core/behaviour.ts`` emits
#: ``{type:'mode', box:'stand'}`` immediately before ``play('wake')``, so the
#: window is already the big one when it runs. ``out`` is a stand-box animation
#: because ``core/expression.ts`` reaches it from the stand-box cascade.
SLEEP_BOX_STRIPS = {"sleep"}
LIE_BOX_STRIPS = {"lie"}
# These strips bypass the ordinary stand-frame pass because their frames choose
# their own boxes below. `lie` still uses the standing dimensions, but its two
# held postures belong to separate boxes.
SPECIAL_BOX_STRIPS = SLEEP_BOX_STRIPS | LIE_BOX_STRIPS

#: Strips loaded only to lift a decoration out of them, never emitted as frames.
#:
#: The standalone ``?`` and ``z z`` sprites can only come from the legacy
#: ``tilt``/``sleep`` illustrations, because the regenerated ones deliberately do
#: not contain them — and the app needs the sprites precisely *because* the new
#: art does not carry them. So these two strips are pinned to the legacy files
#: for good, independently of what ``tilt`` and ``sleep`` resolve to.
DECOR_ONLY_STRIPS: dict[str, str] = {"qmark_source": "tilt", "zz_source": "sleep"}

#: Strips whose illustrations legitimately contain something besides the dog.
#:
#: Everything else FAILS on a stray component, and that failure is the point:
#: the two strips being regenerated to *remove* a glyph are the two where
#: Firefly is most likely to put it back, and a baked ``?`` would be mirrored
#: backwards on half the screen with nothing in any log to say why.
#:
#: Checked only against v4 art. The legacy strips are the 0.1.2 artwork, glyphs
#: and all, already approved and shipped; failing them would make the fallback
#: path — the one that has to work while the owner draws — impossible.
#: What each of them is: two pink hearts over the petted dog (``pet`` 3-6), one
#: sweat drop beside the worried head (all five frames), two motion ticks by the
#: open mouth (``bark`` 3), the breath puff (``out`` 2), and the shake's spray of
#: short ticks (``wake`` 4).
EXPECTED_DECOR = frozenset({"pet", "idle_worried", "bark", "out", "wake", "perk"})

# The owner explicitly approved masking these detached source decorations so the
# app can use the shared v4 heart, question mark and sleep glyph everywhere.
# Keep the dog component and its fitted transform untouched; only these extra
# components are omitted from the emitted frame rows.
UNIVERSAL_DECOR_STRIPS = frozenset({"pet", "tilt", "sleep"})

#: The two strips regenerated specifically to LOSE a glyph, checked a second way.
#:
#: ``EXPECTED_DECOR`` above only catches a glyph that is a **detached**
#: component. A ``?`` whose tail touches the dog's ear is one connected
#: component with him, so it is not a decoration at all as far as the slicer is
#: concerned: it is part of the dog, it passes the stray check, it gets baked
#: into ``tilt_2`` — and because the strip is v4 art the anchors are emitted,
#: ``mirrorReady`` flips true, and the app draws its OWN ``?`` beside the one in
#: the picture. Two question marks, one of them backwards on half the screen,
#: from a build that said nothing. That is the exact failure the regeneration
#: exists to prevent, so it gets its own test.
#:
#: The test is a SHAPE test, because the pixels cannot be told apart: the dog is
#: the same dog in all three frames of ``tilt`` (and of ``sleep``), so a frame
#: that suddenly reaches much further above the others is carrying something the
#: others are not. Both measures below are relative to the strip's own frames —
#: never to a hard-coded size — so a new pose, a new coat or a new box changes
#: nothing.
GLYPH_SHAPE_CHECK_STRIPS = frozenset({"tilt", "sleep"})

#: How much higher one frame's topmost ink may sit than the strip's lowest-topped
#: frame, as a fraction of the strip's median dog height. A head lifting or a
#: chest rising is a few per cent; a glyph over the ears is tens.
GLYPH_HEADROOM_FRACTION = 0.08

#: How much one frame's dog bounding box may grow over the strip's median, by
#: area. Catches a glyph welded to the SIDE of the dog, which adds no headroom.
GLYPH_BBOX_AREA_FRACTION = 0.06

#: How each glyph is named in that failure — the owner's words, not the sheet's
#: keys, because he is the one who has to regenerate the strip.
GLYPH_NAMES: dict[str, str] = {"tilt": "question mark", "sleep": "z z"}

# --------------------------------------------------------------------------- #
# 2. Fitting constants                                                         #
# --------------------------------------------------------------------------- #

BOX = 72  #: the standing box, 72x72 -> 144 px on screen at 2x (the owner's max)
REFERENCE_STRIP = "idle"  #: every other strip is scaled to match this one's dog

#: Transparent rows kept above the curled dog in the sleep box.
#:
#: Removing the drawn ``z z`` shrinks the tight sleep box from 61x58 to about
#: 61x40, and the fullscreen sleep window is sized from that box
#: (``core/geometry.ts``, no reserve of its own) — so the ``z z`` the app now
#: draws itself would have nowhere to go. Eighteen rows is what the owner's own
#: glyph occupied, so keeping exactly that much leaves the box, the window and
#: the on-screen result identical to 0.1.2.
#:
#: Added only when the sleep strip is glyph-less v4 art. On the legacy strip the
#: rows are already there, filled with the drawn glyph, and padding on top of
#: them would grow the box to 76 rows and float the dog.
SLEEP_DECOR_HEADROOM_ROWS = 18

#: The legacy background rule: "achromatic and mid-grey".
BG_CHROMA = 14  #: max(R,G,B) - min(R,G,B) at or below this reads as grey
BG_MIN, BG_MAX = 140, 245  #: ... and mean brightness inside this band is ground
FRINGE_CHROMA, FRINGE_MIN = 18, 150  #: the looser test used to eat the AA fringe

#: The border-keyed rule: whatever colour the outer ring is, that is the ground.
BORDER_RING_PX = 8  #: the ring sampled for the background's own colour
BORDER_TOL = 0.06  #: OKLab distance from that colour that still reads as ground
BORDER_FRINGE_TOL = 0.10  #: the looser test used to eat the AA fringe

FRINGE_PASSES = 2
MIN_COMPONENT_PX = 40  #: below this a component is slicing speckle, not artwork

ALPHA_THRESHOLD = 128  #: 50 % coverage keeps the pixel
LIFT_EPSILON_PX = 2.0  #: a smaller gap under the paws is noise, snap it down
MAX_HOLE_PX = 4  #: enclosed transparent holes up to this size are filled

#: Standalone decorations have their own four-cell source and output sizes.
#: They never enter the dog fitting pass; the two hearts share one scale so
#: their drawn size difference survives as a pulse instead of being normalized.
DECORATION_CELLS = (("heart_0", "heart"), ("heart_1", "heart"),
                    ("qmark", "qmark"), ("zz_0", "zz"))
DECORATION_BOXES = {"heart": [12, 12], "qmark": [12, 18], "zz": [24, 18]}
DECORATION_MARGIN_PX = 1

#: How far one set's drawing of a frame may differ in size from the base set's.
#:
#: The coat switcher swaps frame sets under a running animation, so a stockier
#: dapple drawing would make the dog visibly jump size when the owner changes
#: his colour. Warn early, fail before it ships.
CROSS_SET_BBOX_WARN = 0.03
# A fitted 58px-wide sprite can acquire or lose four outline pixels at an ear or
# tail tip between two otherwise equal poses. That is 6.9% of its tight box,
# although it does not change its fitted size or ground line. Seven per cent
# admits that raster rounding while still catching a one-cell scale change.
CROSS_SET_BBOX_FAIL = 0.07

# --------------------------------------------------------------------------- #
# 3. Colour                                                                    #
# --------------------------------------------------------------------------- #

#: The sheet's 15 opaque colours (+ transparent = the 16 the brief names), in the
#: letter vocabulary of art/README.md. Quantisation picks the nearest of these in
#: OKLab. ``r``/``s``/``b`` are kept in the palettes as documented aliases of
#: ``p``/``k``/``w`` but are never emitted.
LETTERS: list[tuple[str, str]] = [
    ("w", "#FFFFFF"),
    ("a", "#FFF3D6"),
    ("h", "#FFE3A6"),
    ("l", "#FFC67D"),
    ("m", "#E3A454"),
    ("t", "#C47A30"),
    ("d", "#A25F21"),
    ("o", "#7A451A"),
    ("q", "#5F3415"),
    ("k", "#3E2411"),
    ("e", "#2D1A0D"),
    ("n", "#1F1208"),
    ("y", "#9CD7FF"),
    ("z", "#4BA2E1"),
    ("p", "#FF6188"),
]
TRANSPARENT = "."

#: The eight coat letters, remapped per coat. Everything else is shared.
COAT = "ahlmtdoq"

#: Coat ramps sampled from Panel C of design/references/walder_design_sheet_chosen.png
#: (per-tone luminance percentiles against the golden ramp).
#:
#: ``silver-dapple`` was sampled from the owner-approved first dapple idle on
#: 2026-09-11 (perceptual cluster medians, then assigned by their coat role).
#: The ramp is deliberately NOT monotonic in
#: luminance the way the others are: a dapple dog is two hue families at once —
#: cool silver (``a h m``), warm tan points (``l t``) and near-black blotches
#: (``d o q``) — and forcing one ramp order on them would turn every tan brow
#: into grey.
COAT_RAMPS: dict[str, str] = {
    "golden": "#FFF3D6 #FFE3A6 #FFC67D #E3A454 #C47A30 #A25F21 #7A451A #5F3415",
    "red": "#FFEBD6 #F6D3A9 #DE9A62 #C06B34 #9E5228 #7E3F1E #5C2C16 #431F10",
    "cream": "#FFFDF4 #FDF0D8 #F8E3C0 #EBCB9F #D0A87A #B48B60 #8E6A45 #6E4F32",
    "black-and-tan": "#5E5A5B #5E5A5B #4E4A4B #3C3839 #302D2F #262425 #1B1A1B #121112",
    "chocolate": "#C8873F #96684A #7A5138 #61402B #4E3322 #3E281A #2E1D14 #22150E",
    # a: silver light · h: silver mid (the base coat) · l: tan light ·
    # m: silver dark · t: tan dark · d: charcoal blotch · o: black blotch ·
    # q: outline.  Sampled from dapple/idle.png, never guessed by hand.
    # Re-sampled after the first gallery review: the source's warm tan pixels
    # landed in the light ``l`` role, but its former cream target erased that
    # light-brown band after area reduction. These are medians of the pixels
    # assigned by the fitted dapple sources, so they correct colour only.
    "silver-dapple": "#B9A693 #A28D7D #EED1AC #848182 #AE7740 #66605B #494542 #0F0E0D",
    "yuna-grey-tabby": "#F0E8DD #D5CBC0 #B8AA9B #9B8C7C #F4B23C #74685D #51463E #2E2925",
    "yuna-orange-tabby": "#FFF0D2 #FFD48A #F4B23C #DC862B #B85F22 #8E431B #653016 #3A1D11",
    "yuna-black": "#D7D1C8 #A6A19D #73706F #4E4B4C #F4B23C #343235 #222124 #141316",
    "yuna-tuxedo": "#FFFFFF #EEEDE9 #C9C6C0 #747174 #F4B23C #403E41 #28272A #151416",
    "yuna-calico": "#FFFFFF #F5E5CE #F4B23C #D58135 #9C5428 #484346 #302D30 #171518",
}

#: The coat every palette in the sheet is built from, in menu order (the tray
#: reads ``Object.keys(sheet.palettes)``). ``silver-dapple`` is LAST so it lands
#: at the bottom of the Colour menu, and it is only emitted when its frame set
#: was actually built — a coat in the menu that draws golden pixels in silver
#: would be a lie the owner cannot see through.
PALETTE_ORDER: tuple[str, ...] = (
    "golden",
    "red",
    "cream",
    "black-and-tan",
    "chocolate",
    "silver-dapple",
    "yuna-grey-tabby",
    "yuna-orange-tabby",
    "yuna-black",
    "yuna-tuxedo",
    "yuna-calico",
)

#: Which palette draws which frame set. Only sets that were built appear.
PALETTE_SET: dict[str, str] = {
    "silver-dapple": "dapple",
    **{set_name: set_name for set_name in YUNA_SETS},
}

#: Shared (non-coat) letters, identical in every palette.
SHARED = {
    "e": "#2D1A0D",
    "w": "#FFFFFF",
    "n": "#1F1208",
    "k": "#3E2411",
    "p": "#FF6188",
    "r": "#FF6188",
    "z": "#4BA2E1",
    "y": "#9CD7FF",
    "s": "#3E2411",
    "b": "#FFFFFF",
}

# The yarn is an illustrated prop in Yuna's approved perk strips, not the
# universal pink heart; keep that red local to her palettes.
PALETTE_SHARED_OVERRIDES = {set_name: {"p": "#E53935"} for set_name in YUNA_SETS}


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    """rgb: float array (..., 3) in 0..255 -> OKLab (..., 3)."""
    c = np.asarray(rgb, dtype=np.float64) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    r, g, b = lin[..., 0], lin[..., 1], lin[..., 2]
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = np.cbrt(l), np.cbrt(m), np.cbrt(s)
    return np.stack(
        [
            0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
            1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
            0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
        ],
        axis=-1,
    )


class LetterTable(NamedTuple):
    """One coat's 15 colours, ready for nearest-colour lookup."""

    coat: str
    chars: list[str]
    lab: np.ndarray


def letter_table(coat: str) -> LetterTable:
    """The 15 sheet colours as ``coat`` draws them.

    Built in ``LETTERS`` order with the eight coat letters swapped for that
    coat's ramp, so the golden table is character-for-character the one this
    file has always used and the golden frames do not move.
    """
    ramp = dict(zip(COAT, COAT_RAMPS[coat].split()))
    chars = [ch for ch, _ in LETTERS]
    hexes = [ramp[ch] if ch in COAT else default for ch, default in LETTERS]
    return LetterTable(coat, chars, srgb_to_oklab(np.array([hex_to_rgb(h) for h in hexes], dtype=np.float64)))


def shared_letter_table() -> LetterTable:
    """The palette vocabulary that never changes with the dog's coat.

    Standalone hearts, question marks and sleep symbols are UI decorations, not
    fur.  Even a source drawn with only pink, white and blue develops blended
    edge pixels during area reduction; looking those pixels up in a coat table
    used to turn them into tan or cream in one coat and grey in another.  A
    shared-only table keeps their source fitting intact while guaranteeing that
    every emitted letter has one colour in every palette.
    """
    entries = [(ch, colour) for ch, colour in LETTERS if ch not in COAT]
    chars = [ch for ch, _ in entries]
    lab = srgb_to_oklab(np.array([hex_to_rgb(colour) for _, colour in entries], dtype=np.float64))
    return LetterTable("shared", chars, lab)


def quantise(rgb: np.ndarray, table: LetterTable) -> np.ndarray:
    """(...,3) uint8 -> index into ``table.chars``, nearest in OKLab, no dithering."""
    lab = srgb_to_oklab(rgb.reshape(-1, 3))
    d = ((lab[:, None, :] - table.lab[None, :, :]) ** 2).sum(-1)
    return d.argmin(1).reshape(rgb.shape[:-1])


# --------------------------------------------------------------------------- #
# 4. Animations — the only source of timing                                    #
# --------------------------------------------------------------------------- #

#: ``(frame refs, ms per frame, loop, hold)``. A ref is ``"<strip>:<index>"``.
Anim = tuple[list[str], int, bool, bool]

#: Animations built from the strips that every sheet has, whatever else is
#: present. Timings are Panel D of the design sheet, unchanged.
ANIMATIONS_COMMON: dict[str, Anim] = {
    "walk": (["walk:0", "walk:1", "walk:2", "walk:3"], 125, True, False),
    "tail_wag": (["tail_wag:0", "tail_wag:1", "tail_wag:2", "tail_wag:3"], 100, True, False),
    "bark": (["bark:0", "bark:1", "bark:2", "bark:3"], 100, False, False),
    "pet": (["pet:0", "pet:1", "pet:2", "pet:3", "pet:4", "pet:5"], 125, False, False),
    "hop": (["hop:0", "hop:1", "hop:2", "hop:3", "hop:4"], 100, False, False),
    "perk": (["perk:0", "perk:1", "perk:2"], 100, False, True),
    "tilt": (["tilt:0", "tilt:1", "tilt:2"], 125, False, True),
    "sleep": (["sleep:0", "sleep:1", "sleep:2"], 1000, True, False),
    "wake": (["wake:0", "wake:1", "wake:2", "wake:3"], 125, False, False),
    "out": (["out:0", "out:1"], 1000, True, False),
    # `confused` is `tilt`'s held frame as a one-frame loop: the same cocked head,
    # meaning "no idea" rather than "waiting for you".
    "confused": (["tilt:2"], 700, True, False),
}

# Yuna is a separate character, so only the two approved motion differences
# live beside her frame set. The rest deliberately inherits the Walder table.
YUNA_ANIMATION_OVERRIDES: dict[str, Anim] = {
    "idle_happy": (["idle_happy:0"], 1000, True, False),
    "blink_happy": (["idle_happy:3", "idle_happy:4", "idle_happy:3"], 83, False, False),
    "idle_worried": (["idle_worried:0"], 1000, True, False),
    "blink_worried": (["idle_worried:3", "idle_worried:4", "idle_worried:3"], 83, False, False),
    "idle_exhausted": (["idle_exhausted:0"], 1000, True, False),
    "blink_exhausted": (["idle_exhausted:3", "idle_exhausted:4", "idle_exhausted:3"], 83, False, False),
    "tail_wag": (["tail_wag:0", "tail_wag:1", "tail_wag:2"], 100, True, False),
    "perk": (["perk:0", "perk:1", "perk:2", "perk:3", "perk:4", "perk:5"], 100, True, False),
}
YUNA_LOOP_FROM = {"perk": 4}

ANIMATIONS_LIE: dict[str, Anim] = {
    "lie": (["lie:0"], 1000, True, False),
    "lie_down": (["lie:1"], 1000, True, False),
}

#: A one-second still-frame loop gives the blink scheduler regular loop
#: boundaries without animating the resting pose. Every idle uses only its first
#: frame: the owner found breathing, head lifts and ear-flicks distracting.
IDLE_STILL_MS = 1000

#: The v4 rest pose and symmetric blink come from the same strip. Keeping the
#: half · shut · half sequence preserves the existing blink transition; the
#: breathing and ear-flick source frames remain available but are never played.
ANIMATIONS_IDLE_V4: dict[str, Anim] = {
    "idle": (["idle:0"], IDLE_STILL_MS, True, False),
    "idle_neutral": (["idle:0"], IDLE_STILL_MS, True, False),
    "blink": (["idle:3", "idle:4", "idle:3"], 83, False, False),
    "blink_neutral": (["idle:3", "idle:4", "idle:3"], 83, False, False),
}

#: Before the v4 idle lands, hold the first legacy frame and use the separate
#: legacy blink strip. No ``blink_neutral`` alias is needed: the scheduler falls
#: back to ``blink`` for neutral. Omitting ``idle_rare`` in both tables prevents
#: the scheduler from inserting a head lift or ear-flick into the still idle.
ANIMATIONS_IDLE_LEGACY: dict[str, Anim] = {
    "idle": (["idle:0"], IDLE_STILL_MS, True, False),
    "idle_neutral": (["idle:0"], IDLE_STILL_MS, True, False),
    "blink": (["blink:0", "blink:1"], 83, False, False),
}

#: Each available mood strip contributes its first resting frame and blink pair,
#: so a worried dog stays still and blinks with worried eyes. There are no rare
#: idle interjections for any mood.
MOOD_BLINK_MS = 83
MOODS: tuple[str, ...] = ("happy", "worried", "exhausted")

#: The decoration animations. Their frames are lifted out of the strips rather
#: than sliced from them, so they are named directly instead of by ``strip:index``.
DECOR_ANIMATIONS: dict[str, Anim] = {
    "heart": (["heart_0", "heart_1"], 300, True, False),
    "qmark": (["qmark"], 900, False, False),
    "zz": (["zz_0"], 700, True, False),
}

#: Expression -> the animation that plays it.
#:
#: Every value is guaranteed to exist: a mood with its own strip gets its own
#: animation, and a mood without one is aliased onto the idle frames. So this is
#: a flat table rather than the cascade it used to be.
EXPRESSIONS: dict[str, str] = {
    "neutral": "idle_neutral",
    "happy": "idle_happy",
    "worried": "idle_worried",
    "exhausted": "idle_exhausted",
    "out": "out",
    "confused": "confused",
}

#: Which original cells ``render.mjs`` shows beside the finished sprites.
COMPARE_CELLS: list[tuple[str, int]] = [("idle", 0), ("tilt", 2), ("pet", 3)]


# --------------------------------------------------------------------------- #
# 5. Decoration anchors                                                        #
# --------------------------------------------------------------------------- #

#: Where the app draws each glyph, as ``(dx, dy)`` in **dog-size units**.
#:
#: The pair is the offset from the reference frame's dog — its centre-of-mass
#: column and its topmost ink row — to the TOP-LEFT of the decoration box, in
#: multiples of ``k`` (the one silhouette measure every strip is scaled to). Two
#: numbers per glyph, applied by arithmetic, so this stays inside the file's
#: "no per-frame hand-tuning" rule: change the box size or add a coat set and the
#: anchors follow, because they are measured in the dog rather than in the box.
#:
#: SEEDED from ``--measure-decor``, which reports where the owner's own baked
#: glyphs actually sat in the legacy strips (the ``?`` in ``tilt_2``, the ``z z``
#: in ``sleep_2``). So the app draws them where he drew them, not where a
#: developer guessed.
#:
#: ``tilt`` and ``confused`` share ``tilt_2`` and therefore share an anchor, but
#: both are listed: the renderer looks the anchor up by *animation*, and
#: ``mirrorReady`` (``src/sprites/contract.ts``) refuses to mirror the dog unless
#: EVERY animation that plays a decorated frame has one — a logged-out dog with a
#: backwards ``?`` is the bug that gate exists to prevent.
#: The values below use the 2026-09-09 measurement. The ``?`` is raised four
#: output pixels after visual review; the ``z z`` sat 0.149 to the right of centre
#: and 0.422 above his back.
DECOR_ANCHORS: dict[tuple[str, str], tuple[float, float]] = {
    ("tilt", "qmark"): (-0.2861, -0.3313),
    ("confused", "qmark"): (-0.2861, -0.3313),
    ("sleep", "zz"): (0.1488, -0.4217),
    # Centred on the first original pet heart (pet_3) after its 12px shared
    # heart box is substituted for the two 8px baked hearts.
    ("pet", "heart"): (-0.5060, -0.3433),
}

#: How far the in-box clamp may move an anchor before it is worth a warning.
#:
#: The sleep reserve is exactly as deep as the glyph the owner drew, so the
#: ``z z`` anchor lands on row 0 give or take a pixel of rounding — which is the
#: arithmetic working, not a mistake. Anything further out means the hand table
#: and the art have genuinely diverged, and that is worth saying out loud.
ANCHOR_CLAMP_TOLERANCE_PX = 1

#: Which frame each anchor is measured against: the frame the glyph appears on.
#:
#: ``tilt_2`` is both the frame ``tilt`` holds while the ``?`` is up and
#: ``confused``'s only frame; ``sleep_2`` is the one frame of the three-second
#: sleep loop that shows the ``z z``. Both mirror ``APP_DECOR_BY_FRAME`` in
#: ``src/sprites/contract.ts``, which is the app's side of the same statement.
DECOR_ANCHOR_REFERENCE: dict[tuple[str, str], tuple[str, int]] = {
    ("tilt", "qmark"): ("tilt", 2),
    ("confused", "qmark"): ("tilt", 2),
    ("sleep", "zz"): ("sleep", 2),
    ("pet", "heart"): ("pet", 3),
}


def app_decor_by_frame() -> dict[str, list[str]]:
    """Frame -> the glyphs the APP is responsible for drawing on it.

    The same statement as ``APP_DECOR_BY_FRAME`` in ``src/sprites/contract.ts``,
    read off the table above rather than repeated by hand, so the two cannot
    drift apart in this file's direction. It is what ``mirror_ready`` walks.
    """
    out: dict[str, list[str]] = {}
    for (_animation, decor), (strip, index) in DECOR_ANCHOR_REFERENCE.items():
        decors = out.setdefault(f"{strip}_{index}", [])
        if decor not in decors:
            decors.append(decor)
    return out


# --------------------------------------------------------------------------- #
# 6. Resolving the strips                                                      #
# --------------------------------------------------------------------------- #

class Resolved(NamedTuple):
    """One strip, found."""

    path: Path
    frames: int
    #: ``"v4"`` for the regenerated art, ``"legacy"`` for the 0.1.2 exports. The
    #: pipeline branches on this in three places — which animation table to use,
    #: whether to reserve sleep headroom, and whether a stray decoration is a
    #: failure — so it is carried rather than re-derived from the path.
    provenance: str


#: Every name this file will ever look a strip up by. Substring matching is not
#: allowed to cross one of these — see ``find_in``.
#:
#: ``blink`` is in here even though nothing looks it up by name (the legacy blink
#: strip is found by its Firefly key): a file called ``blink.png`` is still a
#: strip name, and must not be swept up as a fuzzy match for something else.
KNOWN_STRIP_NAMES: frozenset[str] = frozenset(STRIP_FRAMES) | frozenset(LEGACY_SOURCES)


def strip_counts(set_name: str) -> dict[str, int]:
    """The complete source-strip contract for one character set."""
    return YUNA_STRIP_FRAMES if set_name in YUNA_SETS else STRIP_FRAMES


def find_in(directory: Path, strip: str) -> Path | None:
    """``<strip>.png`` if it is there, else the one file whose name contains it.

    An exact name always wins. The fuzzy fallback exists so the owner can drop a
    Firefly export under its own long generated filename
    (``Firefly_..._idle_happy 12345.png``) and have it picked up — but it is
    fenced by two rules, both added 2026-09-10 after the substring match ate the
    wrong file:

    1. **A name that is a PREFIX of another strip name requires the exact file.**
       ``"idle" in "idle_happy.png"`` is true, so a folder holding only
       ``idle_happy.png`` resolved the *neutral* idle to the happy strip — one
       mood strip dropped on its own silently replaced the base loop, at the
       wrong frame count, with nothing in the report saying so. Two mood strips
       turned the same lookup into "matched 2 files" and killed the build. Today
       ``idle`` is the only name with this problem, but the rule is derived from
       ``KNOWN_STRIP_NAMES`` rather than special-cased, so a future
       ``tilt``/``tilt_slow`` pair cannot reintroduce it.
    2. **A file whose stem is exactly ANOTHER strip's name is never a candidate.**
       That file has an owner already; lending it to a second strip would emit
       the same dogs twice under two animations.

    A fragment matching more than one remaining file is an error rather than a
    coin toss.
    """
    if not directory.is_dir():
        return None
    exact = directory / f"{strip}.png"
    if exact.exists():
        return exact
    longer = sorted(n for n in KNOWN_STRIP_NAMES if n != strip and n.startswith(strip))
    if longer:
        # Rule 1. Nothing fuzzy can be trusted here, so say what would fix it
        # rather than silently returning the wrong dog. Not an error: a missing
        # strip is normal — the caller falls back to the legacy export.
        return None
    others = KNOWN_STRIP_NAMES - {strip}
    hits = sorted(p for p in directory.glob("*.png") if strip in p.name and p.stem not in others)
    if len(hits) > 1:
        raise SystemExit(
            f"{directory.name}/: {strip!r} matched {len(hits)} files "
            f"({', '.join(p.name for p in hits)}) — rename one to {strip}.png"
        )
    return hits[0] if hits else None


def resolve_set(set_name: str) -> tuple[dict[str, Resolved], list[str]]:
    """Find every strip of one coat set. Returns ``(resolved, missing)``.

    v4 art first, then — for the golden set only, because it is the only one with
    a legacy directory — the 0.1.2 Firefly exports. A strip that is nowhere is
    *reported*, not guessed at: the caller decides whether that is fatal (the
    golden set, which the app cannot draw without) or a reason to skip the set
    (dapple, which the owner is still generating).
    """
    v4_dir, *fallbacks = SET_DIRS[set_name]
    resolved: dict[str, Resolved] = {}
    missing: list[str] = []

    for strip, count in strip_counts(set_name).items():
        found = find_in(v4_dir, strip)
        if found is not None:
            resolved[strip] = Resolved(found, count, "v4")
            continue
        legacy = LEGACY_SOURCES.get(strip)
        if legacy is not None:
            key, legacy_count = legacy
            for directory in fallbacks:
                path = find_in(directory, key)
                if path is not None:
                    resolved[strip] = Resolved(path, legacy_count, "legacy")
                    break
            if strip in resolved:
                continue
        missing.append(strip)

    # The legacy blink strip is a *consequence* of the idle strip's provenance,
    # not a strip in its own right: the v4 blink comes out of the idle strip, so
    # the separate illustration is loaded if and only if the legacy idle is.
    idle = resolved.get("idle")
    if idle is not None and idle.provenance == "legacy":
        key, count = LEGACY_SOURCES["blink"]
        for directory in fallbacks:
            path = find_in(directory, key)
            if path is not None:
                resolved["blink"] = Resolved(path, count, "legacy")
                break
        else:
            missing.append("blink")

    return resolved, missing


def report_resolution(set_name: str, resolved: dict[str, Resolved], missing: list[str]) -> None:
    """One line per strip that is not yet the new art, so the owner sees progress.

    Terse on purpose when a whole set is absent: a set nobody has started is one
    fact, and printing it fourteen times buries the one strip he is waiting on.
    """
    directory = SET_DIRS[set_name][0]
    if not any(found.provenance == "v4" for found in resolved.values()):
        print(f"  {set_name}: no v4 strips in {directory.relative_to(ROOT)} yet")
    else:
        for strip in strip_counts(set_name):
            found = resolved.get(strip)
            if found is not None and found.provenance == "legacy":
                print(f"  {set_name}: no v4 {strip}.png — using the legacy {found.path.name}")
    if missing:
        print(f"  {set_name}: nothing found for: {', '.join(missing)}")


def name_sources(set_name: str, resolved: dict[str, Resolved]) -> None:
    """Copy every resolved strip to ``named/<set>/<strip>.png``. Idempotent.

    The mapping from a Firefly filename to an animation is then a file on disk
    rather than a comment, and ``design/references/strips/named/`` is a folder the
    owner can flip through. The flat ``named/<strip>.png`` copies from 0.1.2 are
    left alone: ``docs/PROMPTS_V4.md`` tells him to attach them as the golden
    references when he generates the dapple set, and they are the legacy art,
    which is exactly what those prompts mean.
    """
    directory = NAMED / set_name
    directory.mkdir(parents=True, exist_ok=True)
    for strip, found in resolved.items():
        dst = directory / f"{strip}.png"
        if not dst.exists() or dst.stat().st_size != found.path.stat().st_size:
            shutil.copyfile(found.path, dst)


# --------------------------------------------------------------------------- #
# 7. Slicing                                                                   #
# --------------------------------------------------------------------------- #

def background_mask_legacy(rgb: np.ndarray) -> np.ndarray:
    """The flat grey ground: flood fill from the border, then eat the AA fringe.

    The rule 0.1.2 shipped, and still the default for the golden set. It keys on
    "achromatic and mid-grey" rather than on the actual border colour, which is
    why it cannot be used for the dapple strips: a silver dog IS achromatic
    mid-grey, and the fringe passes would chew two pixels off every un-outlined
    silver edge.
    """
    a = rgb.astype(np.int16)
    chroma = a.max(2) - a.min(2)
    mean = a.mean(2)
    grey = (chroma <= BG_CHROMA) & (mean >= BG_MIN) & (mean <= BG_MAX)
    return _flood_from_border(grey, (chroma <= FRINGE_CHROMA) & (mean >= FRINGE_MIN))


def background_mask_border(rgb: np.ndarray) -> np.ndarray:
    """Whatever colour the outer ring is, that is the ground.

    Generalises the rule above to any flat background, which is what the dapple
    strips need: they are drawn on flat green ``#3FA34D`` precisely so that ground
    and coat cannot be confused, and a rule keyed on grey would see no background
    at all. The key is the *median* of the outer ring, not its mean, so a stray
    dark pixel in a corner cannot drag it.

    Tolerances are OKLab distances, so "close enough to the background" means the
    same amount of visible difference on a green ground as on a grey one.
    """
    ring = np.ones(rgb.shape[:2], bool)
    ring[BORDER_RING_PX:-BORDER_RING_PX, BORDER_RING_PX:-BORDER_RING_PX] = False
    key = np.median(rgb[ring].reshape(-1, 3), axis=0)
    d = np.sqrt(((srgb_to_oklab(rgb.astype(np.float64)) - srgb_to_oklab(key)) ** 2).sum(-1))
    return _flood_from_border(d <= BORDER_TOL, d <= BORDER_FRINGE_TOL)


def _flood_from_border(seed: np.ndarray, fringe: np.ndarray) -> np.ndarray:
    """Keep the seed components that touch the image border, then grow into ``fringe``.

    Two steps, both load-bearing. Flooding from the border is what stops a patch
    of background-coloured coat in the middle of the dog from being punched out of
    him. The constrained dilations then eat the anti-aliased edge and the soft
    drop shadow, which are neither ground nor dog and would otherwise survive as
    a grey halo the quantiser had to find a letter for.
    """
    lab, _ = ndimage.label(seed)
    edge = set(lab[0]) | set(lab[-1]) | set(lab[:, 0]) | set(lab[:, -1])
    edge.discard(0)
    bg = np.isin(lab, sorted(edge))
    for _ in range(FRINGE_PASSES):
        grown = ndimage.binary_dilation(bg) & fringe
        if np.array_equal(grown, bg):
            break
        bg = grown
    return bg


BG_DETECTORS = {"legacy": background_mask_legacy, "border": background_mask_border}


class Cell:
    """One frame of a strip: the dog, plus the decorations drawn with it."""

    def __init__(self, labels: np.ndarray, dog_id: int, deco_ids: list[int], slices):
        self.labels = labels
        self.dog_id = dog_id
        self.deco_ids = deco_ids
        dsl = slices[dog_id - 1]
        self.dog_slice = dsl
        mask = labels[dsl] == dog_id
        ys, xs = np.nonzero(mask)
        self.dog_area = int(mask.sum())
        self.dog_bottom = dsl[0].stop - 1
        self.dog_top = dsl[0].start
        self.dog_cx = float(xs.mean() + dsl[1].start)
        all_sl = [slices[i - 1] for i in [dog_id, *deco_ids]]
        self.top = min(s[0].start for s in all_sl)
        self.bottom = max(s[0].stop for s in all_sl) - 1
        self.left = min(s[1].start for s in all_sl)
        self.right = max(s[1].stop for s in all_sl) - 1
        #: Pixel area of each decoration component, largest first — the
        #: per-strip decoration report, and the `EXPECTED_DECOR` check, read this.
        self.deco_areas = sorted((int((labels == i).sum()) for i in deco_ids), reverse=True)

    def mask(self, ids: list[int] | None = None) -> np.ndarray:
        want = [self.dog_id, *self.deco_ids] if ids is None else ids
        return np.isin(self.labels, want)


def slice_strip(path: Path, n: int, detector: str) -> tuple[np.ndarray, list[Cell]]:
    rgb = np.array(Image.open(path).convert("RGB"))
    fg = ~BG_DETECTORS[detector](rgb)
    labels, k = ndimage.label(fg, structure=np.ones((3, 3), int))
    areas = ndimage.sum(fg, labels, range(1, k + 1))
    slices = ndimage.find_objects(labels)
    live = [i + 1 for i in range(k) if areas[i] >= MIN_COMPONENT_PX]
    live.sort(key=lambda i: -areas[i - 1])
    if len(live) < n:
        raise SystemExit(
            f"{path.name}: found {len(live)} components, need {n} dogs — check that "
            f"the background is one flat colour and no dog touches the border"
        )

    dogs = sorted(live[:n], key=lambda i: (slices[i - 1][1].start + slices[i - 1][1].stop) / 2)
    deco: dict[int, list[int]] = {d: [] for d in dogs}
    for other in live[n:]:
        sl = slices[other - 1]
        cx = (sl[1].start + sl[1].stop) / 2

        def gap(d: int) -> float:
            ds = slices[d - 1][1]
            if ds.start <= cx <= ds.stop:
                return 0.0
            return float(min(abs(cx - ds.start), abs(cx - ds.stop)))

        deco[min(dogs, key=gap)].append(other)
    return rgb, [Cell(labels, d, deco[d], slices) for d in dogs]


# --------------------------------------------------------------------------- #
# 8. Rasterising                                                              #
# --------------------------------------------------------------------------- #

def cell_rgba(rgb: np.ndarray, cell: Cell, ids: list[int] | None = None) -> Image.Image:
    """The cell as an RGBA image whose transparent pixels carry RGB 0.

    Zeroing the RGB under the transparent pixels makes the plain per-channel BOX
    resize below an exactly premultiplied one, so no ground bleeds into the
    silhouette edge.
    """
    m = cell.mask(ids)
    out = np.zeros((*m.shape, 4), np.uint8)
    out[..., :3] = np.where(m[..., None], rgb, 0)
    out[..., 3] = np.where(m, 255, 0)
    return Image.fromarray(out, "RGBA")


def resample(img: Image.Image, rect: tuple[float, float, float, float], size: tuple[int, int]):
    """Area-average ``rect`` (source coords, may exceed the image) into ``size``."""
    x0, y0, x1, y1 = rect
    pad_l = max(0, math.ceil(-x0)) + 2
    pad_t = max(0, math.ceil(-y0)) + 2
    pad_r = max(0, math.ceil(x1 - img.width)) + 2
    pad_b = max(0, math.ceil(y1 - img.height)) + 2
    if pad_l or pad_t or pad_r or pad_b:
        canvas = Image.new("RGBA", (img.width + pad_l + pad_r, img.height + pad_t + pad_b), (0, 0, 0, 0))
        canvas.paste(img, (pad_l, pad_t))
        img = canvas
        x0, y0, x1, y1 = x0 + pad_l, y0 + pad_t, x1 + pad_l, y1 + pad_t
    small = img.resize(size, Image.Resampling.BOX, box=(x0, y0, x1, y1))
    return np.array(small)


def to_rows(rgba: np.ndarray, table: LetterTable) -> tuple[list[str], int]:
    """Threshold alpha, un-premultiply, quantise, fill enclosed holes."""
    alpha = rgba[..., 3].astype(np.int32)
    opaque = alpha >= ALPHA_THRESHOLD
    with np.errstate(divide="ignore", invalid="ignore"):
        rgb = np.where(
            alpha[..., None] > 0,
            np.clip(rgba[..., :3].astype(np.float64) * 255.0 / np.maximum(alpha, 1)[..., None], 0, 255),
            0.0,
        )
    idx = quantise(rgb.astype(np.uint8), table)

    # The one cleanup pass: transparent holes that the silhouette fully encloses.
    holes = 0
    trans = ~opaque
    lab, k = ndimage.label(trans)
    if k:
        outside = set(lab[0]) | set(lab[-1]) | set(lab[:, 0]) | set(lab[:, -1])
        outside.discard(0)
        for i in range(1, k + 1):
            if i in outside:
                continue
            sel = lab == i
            if sel.sum() > MAX_HOLE_PX:
                continue
            ring = ndimage.binary_dilation(sel) & opaque
            vals = idx[ring]
            if vals.size == 0:
                continue
            idx[sel] = Counter(vals.tolist()).most_common(1)[0][0]
            opaque |= sel
            holes += int(sel.sum())

    rows = []
    for y in range(idx.shape[0]):
        rows.append("".join(table.chars[idx[y, x]] if opaque[y, x] else TRANSPARENT
                            for x in range(idx.shape[1])))
    return rows, holes


def standalone_decorations(path: Path, table: LetterTable) -> tuple[dict, int]:
    """Fit a four-cell source without dropping disconnected dots or letters.

    Dog slicing keeps the largest connected components, which would mistake a
    question mark's dot or the second z for noise. Here the exact quarter-cell
    boundary owns every foreground pixel. Only the existing grey removal,
    uniform area resampling and colour quantizer touch the supplied artwork.
    """
    rgb = np.array(Image.open(path).convert("RGB"))
    count = len(DECORATION_CELLS)
    if rgb.shape[1] % count:
        raise SystemExit(f"{path.name}: width must divide into {count} equal decoration cells")
    cell_w = rgb.shape[1] // count
    cells = []
    for i, (name, box_name) in enumerate(DECORATION_CELLS):
        cell = rgb[:, i * cell_w:(i + 1) * cell_w]
        mask = ~background_mask_legacy(cell)
        ys, xs = np.nonzero(mask)
        if not len(xs):
            raise SystemExit(f"{path.name}: decoration cell {i + 1} ({name}) is empty")
        if mask[0].any() or mask[-1].any() or mask[:, 0].any() or mask[:, -1].any():
            raise SystemExit(f"{path.name}: {name} touches its cell edge; regenerate with clear gutters")
        rgba = np.zeros((*mask.shape, 4), np.uint8)
        rgba[..., :3] = np.where(mask[..., None], cell, 0)
        rgba[..., 3] = np.where(mask, 255, 0)
        bounds = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        cells.append((name, box_name, Image.fromarray(rgba, "RGBA"), bounds))

    scales = {}
    for _, box_name, _, (x0, y0, x1, y1) in cells:
        width, height = DECORATION_BOXES[box_name]
        scale = min((width - 2 * DECORATION_MARGIN_PX) / (x1 - x0),
                    (height - 2 * DECORATION_MARGIN_PX) / (y1 - y0))
        scales[box_name] = min(scales.get(box_name, scale), scale)

    frames = {}
    holes_total = 0
    for name, box_name, image, (x0, y0, x1, y1) in cells:
        width, height = DECORATION_BOXES[box_name]
        scale = scales[box_name]
        left = (x0 + x1) / 2 - width / (2 * scale)
        top = (y0 + y1) / 2 - height / (2 * scale)
        rgba = resample(image, (left, top, left + width / scale, top + height / scale),
                        (width, height))
        rows, holes = to_rows(rgba, table)
        if not any(row.strip(TRANSPARENT) for row in rows):
            raise SystemExit(f"{path.name}: {name} disappears at its output size; regenerate bolder art")
        frames[name] = {"box": box_name, "rows": rows}
        holes_total += holes
    return frames, holes_total


def tight(rows: list[str]) -> tuple[int, int, int, int] | None:
    ys = [y for y, r in enumerate(rows) if r.strip(TRANSPARENT)]
    if not ys:
        return None
    xs = [x for x in range(len(rows[0])) if any(r[x] != TRANSPARENT for r in rows)]
    return min(xs), min(ys), max(xs), max(ys)


def crop(rows: list[str], bbox: tuple[int, int, int, int]) -> list[str]:
    x0, y0, x1, y1 = bbox
    return [r[x0:x1 + 1] for r in rows[y0:y1 + 1]]


def bbox_size(rows: list[str]) -> tuple[int, int]:
    b = tight(rows)
    return (0, 0) if b is None else (b[2] - b[0] + 1, b[3] - b[1] + 1)


# --------------------------------------------------------------------------- #
# 9. The build                                                                 #
# --------------------------------------------------------------------------- #

class Strip:
    def __init__(self, name: str, path: Path, n: int, detector: str):
        self.name = name
        self.path = path
        self.rgb, self.cells = slice_strip(path, n, detector)
        self.size = float(np.median([c.dog_area ** 0.5 for c in self.cells]))
        self.ground = max(c.dog_bottom for c in self.cells)  # the lowest paw row
        self.scale = 0.0
        self.shrink = 1.0
        self.anchor_x = 0.0  # fitted before transform, alongside scale

    # extents in units of `size`, measured from the ground line / dog centroid
    def up(self) -> float:
        return max((self.ground - c.top) / self.size for c in self.cells)

    def width_ratio(self) -> float:
        return max((c.right - c.left + 1) / self.size for c in self.cells)

    def left_ratio(self) -> float:
        return max((c.dog_cx - c.left) / self.size for c in self.cells)

    def right_ratio(self) -> float:
        return max((c.right - c.dog_cx) / self.size for c in self.cells)

    def has_decorations(self) -> bool:
        return any(c.deco_ids for c in self.cells)

    def transform(self, cell: Cell) -> tuple[float, float, float]:
        """``(x_left, y_top, scale)`` — the source rectangle this cell is fitted from.

        Shared by the rasteriser and the anchor arithmetic, so an anchor cannot
        be computed against a different mapping from the one the pixels used.
        """
        s = self.scale
        # Align on the strip's ground line, which keeps a genuinely airborne
        # frame (hop_1, hop_2) the right distance off the floor. A gap under
        # LIFT_EPSILON_PX is sub-pixel slicing noise rather than lift, and would
        # otherwise cost the frame its contact row: those align on their own
        # lowest paw instead, so every grounded frame really does touch row 71.
        lift = (self.ground - cell.dog_bottom) * s
        base = self.ground if lift >= LIFT_EPSILON_PX else cell.dog_bottom
        y_top = base + 1 - BOX / s
        x_left = cell.dog_cx - self.anchor_x / s
        # keep the drawn content inside the box; only `out` ever needs this
        cl = (cell.left - x_left) * s
        cr = (cell.right + 1 - x_left) * s
        if cl < 0:
            x_left += cl / s
        elif cr > BOX:
            x_left += (cr - BOX) / s
        return x_left, y_top, s


#: Base anchor and common scale, set by `fit_scales` before rasterising. Each
#: strip carries its fitted anchor; these module values also serve the report.
ANCHOR_X = 36.5
K = 0.0


def fit_scales(strips: dict[tuple[str, str], Strip]) -> tuple[float, float]:
    """One scale for every strip of every set, and the box's horizontal anchor.

    ONE common ``k`` across all sets is the whole point: the coat switcher swaps
    frame sets under a running animation, and a per-set scale would make the dog
    change size when his colour changed. It also means adding the dapple set can
    lower ``k`` slightly and re-quantise the golden frames — expected, and why
    the owner re-approves the golden gallery once when the second coat lands.

    ``out`` and the weekly ``lie`` are low, wide poses. Letting either set ``k``
    would re-quantise the standing cast, so both are fitted to the box instead
    (see ``shrink``).
    """
    driving = [s for (_, name), s in strips.items() if name not in {"out", "lie"}]
    k = min(min((BOX - 1) / s.up(), (BOX - 1) / s.width_ratio()) for s in driving)

    def fitted_anchor(group: list[Strip]) -> float:
        left_r = max(s.left_ratio() for s in group)
        right_r = max(s.right_ratio() for s in group)
        return round(BOX * left_r / (left_r + right_r)) + 0.5

    # An exhausted pose extends its tail further right. Letting that optional
    # mood recenter every strip shifted already-approved idle, happy and tilt
    # pixels two columns left. Keep their anchor derived from the non-mood cast;
    # moods retain the full-cast fit used when they were reviewed. The common K
    # and existing boundary clamp stay unchanged, so this is source alignment,
    # not a pixel patch or a second size normalizer.
    base_driving = [s for (_, name), s in strips.items()
                    if name not in {"out", "lie"} and name not in OPTIONAL_STRIPS]
    anchor_x = fitted_anchor(base_driving or driving)
    mood_anchor_x = fitted_anchor(driving)

    for (_, name), s in strips.items():
        s.anchor_x = mood_anchor_x if name in OPTIONAL_STRIPS else anchor_x
        s.scale = k / s.size
        need_h = s.up() * s.size * s.scale
        need_w = s.width_ratio() * s.size * s.scale
        s.shrink = min(1.0, (BOX - 1) / need_h, (BOX - 1) / need_w)
        s.scale *= s.shrink
    return k, anchor_x


def check_animation_tables(
    animations: dict[str, Anim], counts: dict[str, int], where: str
) -> None:
    """Build-time asserts on the tables, before a single pixel is read.

    Two failures are possible and both are silent otherwise: a ref past the end
    of a strip (which produces a `KeyError` deep in the raster loop, or worse a
    frame nobody notices is wrong), and a strip that no animation uses (which
    means an entire strip of the owner's artwork is unreachable). Individual
    source frames may deliberately be unused, such as the breathing and ear-flick
    frames retained in the idle strips after the owner chose a still pose.
    """
    for name, (refs, ms, loop, hold) in animations.items():
        if hold and loop:
            raise SystemExit(f"{where}: {name} is both loop and hold")
        if ms <= 0:
            raise SystemExit(f"{where}: {name} has a non-positive duration")
        for ref in refs:
            if ":" not in ref:
                continue  # a literal frame name (the decorations)
            strip, index = ref.split(":", 1)
            if strip not in counts:
                raise SystemExit(f"{where}: {name} references unknown strip {strip!r}")
            if not 0 <= int(index) < counts[strip]:
                raise SystemExit(
                    f"{where}: {name} references {ref}, but {strip} has "
                    f"{counts[strip]} frame(s)"
                )

    used = {ref.split(":", 1)[0] for refs, *_ in animations.values() for ref in refs if ":" in ref}
    unused = [s for s in counts if s not in used]
    if unused:
        raise SystemExit(f"{where}: no animation uses {', '.join(unused)}")


def check_glued_glyphs(
    strips: dict[tuple[str, str], Strip], resolutions: dict[str, dict[str, Resolved]]
) -> None:
    """Catch a glyph DRAWN ONTO the dog in a v4 ``tilt`` or ``sleep`` strip.

    The stray-component check above sees a glyph only while it floats free. Once
    Firefly lets the ``?``'s tail touch an ear the two are one connected
    component, the slicer calls the whole thing "the dog", and the glyph is baked
    into ``tilt_2`` — under a v4 provenance, which is what emits the anchors,
    which is what flips ``mirrorReady``, which is what makes the app draw a
    SECOND ``?`` beside the first. See ``GLYPH_SHAPE_CHECK_STRIPS``.

    So this compares the dog against himself, frame to frame within one strip.
    Both measures are relative to the strip's own frames — nothing here knows how
    big a dog is supposed to be:

    * **headroom** — how far a frame's topmost ink rises above the frame whose
      top sits LOWEST (the least-decorated one, whichever that is), as a fraction
      of the strip's median dog height. A glyph over the ears is the only thing
      in these two poses that moves the top by tens of per cent.
    * **bbox area** — how far a frame's dog box grows past the strip's median.
      A glyph welded to the dog's flank adds no headroom at all, but it cannot
      avoid adding area.

    THIS IS A HEURISTIC AND IT IS ADVERTISED AS ONE, in ``v4/README.md`` and in
    the message below: a small glyph tucked against the dog's silhouette can
    stay under both thresholds. It narrows the hole rather than closing it, and
    the closing move is still a pair of human eyes on the tilt and sleep cards in
    ``npm run sprites``.
    """
    for (set_name, strip_name), s in sorted(strips.items()):
        if set_name in YUNA_SETS or strip_name not in GLYPH_SHAPE_CHECK_STRIPS or len(s.cells) < 2:
            continue
        found = resolutions[set_name].get(strip_name)
        # Legacy strips carry their glyphs on purpose and emit no anchors, so
        # there is nothing to be confused about and nothing to fail.
        if found is None or found.provenance != "v4":
            continue

        heights = [c.dog_slice[0].stop - c.dog_slice[0].start for c in s.cells]
        areas = [h * (c.dog_slice[1].stop - c.dog_slice[1].start)
                 for h, c in zip(heights, s.cells)]
        median_h = float(np.median(heights))
        median_a = float(np.median(areas))
        lowest_top = max(c.dog_top for c in s.cells)
        glyph = GLYPH_NAMES.get(strip_name, "glyph")

        for i, cell in enumerate(s.cells):
            rise = (lowest_top - cell.dog_top) / median_h if median_h else 0.0
            growth = areas[i] / median_a - 1.0 if median_a else 0.0
            if rise <= GLYPH_HEADROOM_FRACTION and growth <= GLYPH_BBOX_AREA_FRACTION:
                continue
            raise SystemExit(
                f"frame {i} of {strip_name} carries extra ink above the head — is there "
                f"a {glyph} glued to the dog? Regenerate.\n"
                f"  {set_name}/{strip_name}: {found.path.name}, frame {strip_name}_{i}\n"
                f"  its ink starts {rise:.1%} of a dog-height higher than the strip's "
                f"lowest-topped frame (limit {GLYPH_HEADROOM_FRACTION:.0%}) and its box is "
                f"{growth:+.1%} of the strip's median area (limit "
                f"{GLYPH_BBOX_AREA_FRACTION:.0%}).\n"
                f"  A glyph that FLOATS free is caught as a stray component; one that "
                f"TOUCHES the dog is caught here, by size, which is a heuristic — the "
                f"`{strip_name}` card in `npm run sprites` is still the last word.\n"
                f"  If the pose really did change this much, widen "
                f"GLYPH_HEADROOM_FRACTION / GLYPH_BBOX_AREA_FRACTION and say why."
            )


def build(
    report: bool = False,
    require_sets: frozenset[str] = frozenset(),
    force_legacy_bg: bool = False,
) -> dict:
    global ANCHOR_X, K

    # --- the flags, before any work ----------------------------------------- #
    # Checked FIRST, not after the sets have been resolved and skipped, because
    # `--require-set dappel` used to spend the whole build finding nothing wrong
    # and then exit 0: the typo'd name matched no skipped set, so it turned into
    # a requirement on a set that does not exist and was never enforced. A flag
    # that silently does nothing is worse than no flag, and the owner cannot see
    # the difference from the outside.
    for set_name in require_sets:
        if set_name not in SETS:
            raise SystemExit(
                f"--require-set {set_name}: no such coat set. The sets are: "
                f"{', '.join(SETS)}."
            )

    # --- resolve every set -------------------------------------------------- #
    resolutions: dict[str, dict[str, Resolved]] = {}
    skipped: dict[str, str] = {}
    #: Sets that are complete in themselves and blocked by the BASE set instead.
    #: Reported separately from `skipped` because `--require-set` must not turn
    #: them into a failure — see below.
    waiting: dict[str, str] = {}
    for set_name in SETS:
        resolved, missing = resolve_set(set_name)
        if report:
            report_resolution(set_name, resolved, missing)
        if set_name == BASE_SET:
            hard = [s for s in missing if s not in OPTIONAL_STRIPS]
            if hard:
                raise SystemExit(
                    f"the {BASE_SET} set is missing {', '.join(hard)} — the app cannot "
                    f"be drawn without them. Drop them in {V4 / set_name} or restore the "
                    f"legacy exports in {STRIPS}."
                )
            resolutions[set_name] = resolved
            continue

        # Yuna is a second character with an owner-approved animation contract
        # of her own. Her complete set is ready as soon as every source strip is
        # present; frame compatibility is checked against her overrides below.
        if set_name in YUNA_SETS:
            if missing:
                skipped[set_name] = "; ".join(f"{strip}.png missing" for strip in missing)
            else:
                resolutions[set_name] = resolved
            continue

        # A non-base set must match the base set exactly: `frameSets` is keyed by
        # the same frame names as `frames` and the validator insists on it, so a
        # set with a different strip list (or a different frame count for the
        # same strip) cannot be expressed at all. Reported as a skip rather than
        # a failure, because the owner generates these one at a time.
        base = resolutions[BASE_SET]

        # FIRST: is the base set even comparable yet? (fixed 2026-09-10.)
        #
        # While the base idle is the legacy four-frame strip, `resolve_set` also
        # loads the separate legacy `blink` illustration — and a non-base set has
        # no legacy directory and therefore no `blink.png`, no six-frame idle and
        # no mood strips to match it with. Comparing anyway produced a list of
        # demands the owner could not meet in the folder he was being pointed at,
        # headed by an impossible `blink.png missing`, and `--require-set dapple`
        # turned that into a hard failure on a set where every one of the
        # fourteen strips was present and correct.
        #
        # So this is its own state, and deliberately NOT a `--require-set`
        # failure: nothing about the dapple folder is wrong, and the one file
        # that would unblock it is a golden one.
        if base["idle"].provenance != "v4":
            waiting[set_name] = (
                f"{set_name} is waiting for {BASE_SET}/idle.png (the {BASE_SET} set still "
                f"uses the legacy 4-frame idle, and the {set_name} set has no equivalent)"
            )
            continue

        reasons: list[str] = []
        for strip, found in base.items():
            mine = resolved.get(strip)
            if mine is None:
                reasons.append(f"{strip}.png missing")
            elif mine.frames != found.frames:
                reasons.append(f"{strip} has {mine.frames} frames, {BASE_SET} has {found.frames}")
        extra = [s for s in resolved if s not in base]
        if extra:
            reasons.append(f"{BASE_SET} has no {', '.join(extra)} to match")
        if reasons:
            skipped[set_name] = "; ".join(reasons)
            continue
        resolutions[set_name] = resolved

    # Reported in the summary block at the end rather than here, so that a plain
    # run prints its news in one place; a required set that is genuinely not
    # ready still stops the build on the spot.
    for set_name, reason in skipped.items():
        if set_name in require_sets:
            raise SystemExit(
                f"the {set_name} set is not ready: {reason}\n"
                f"(--require-set {set_name} was given)"
            )

    base = resolutions[BASE_SET]
    counts = {strip: found.frames for strip, found in base.items()}
    idle_is_v4 = base["idle"].provenance == "v4"

    # --- which animation tables apply -------------------------------------- #
    idle_table = ANIMATIONS_IDLE_V4 if idle_is_v4 else ANIMATIONS_IDLE_LEGACY
    animations_spec: dict[str, Anim] = {**idle_table, **ANIMATIONS_COMMON}
    for mood in MOODS:
        strip = f"idle_{mood}"
        if strip in base:
            # Its own resting frame and blink pair, so the face stays in the
            # same mood while the body stays still between blinks.
            animations_spec[f"idle_{mood}"] = (
                [f"{strip}:0"], IDLE_STILL_MS, True, False
            )
            animations_spec[f"blink_{mood}"] = (
                [f"{strip}:3", f"{strip}:4", f"{strip}:3"], MOOD_BLINK_MS, False, False
            )
        else:
            # No mood strip yet: both the resting pose and blink use neutral
            # art. The scheduler looks up blink_<mood>, so aliasing only idle
            # would leave the default happy expression permanently unblinking.
            for family in ("idle", "blink"):
                refs, ms, loop, hold = idle_table[family]
                animations_spec[f"{family}_{mood}"] = (list(refs), ms, loop, hold)
    if "lie" in base:
        animations_spec.update(ANIMATIONS_LIE)
    check_animation_tables(animations_spec, counts, "ANIMATIONS")
    for set_name in YUNA_SETS:
        if set_name not in resolutions:
            continue
        yuna_counts = {strip: found.frames for strip, found in resolutions[set_name].items()}
        check_animation_tables(
            {**animations_spec, **YUNA_ANIMATION_OVERRIDES}, yuna_counts, set_name
        )

    # --- load every strip --------------------------------------------------- #
    cache: dict[tuple[Path, int, str], Strip] = {}

    def load(name: str, found: Resolved, set_name: str) -> Strip:
        detector = "legacy" if force_legacy_bg else BG_DETECTOR_BY_SET[set_name]
        key = (found.path, found.frames, detector)
        cached = cache.get(key)
        if cached is None:
            cached = Strip(name, found.path, found.frames, detector)
            cache[key] = cached
        return cached

    strips: dict[tuple[str, str], Strip] = {}
    for set_name, resolved in resolutions.items():
        name_sources(set_name, resolved)
        for strip, found in resolved.items():
            strips[(set_name, strip)] = load(strip, found, set_name)

    # The two decoration sources are pinned to the legacy illustrations, which
    # are the only place the `?` and the `z z` are drawn at all. Loaded outside
    # `strips` so they cannot influence the common scale: they contribute no dog
    # frames, and letting them drive `k` would shrink the cast to fit a glyph.
    decor_strips: dict[str, Strip] = {}
    for alias, legacy_strip in DECOR_ONLY_STRIPS.items():
        key, count = LEGACY_SOURCES[legacy_strip]
        path = find_in(STRIPS, key)
        if path is None:
            raise SystemExit(
                f"the legacy {legacy_strip} strip ({key}) is missing from {STRIPS} — it is "
                f"the only source of the standalone {alias.split('_')[0]} sprite"
            )
        decor_strips[alias] = Strip(alias, path, count, "legacy")

    dog_strips = {
        key: strip for key, strip in strips.items() if key[0] not in YUNA_SETS
    }
    K, ANCHOR_X = fit_scales({**dog_strips, **{("_decor", a): s for a, s in decor_strips.items()}})
    k, anchor_x = K, ANCHOR_X
    yuna_strips = {key: strip for key, strip in strips.items() if key[0] in YUNA_SETS}
    if yuna_strips:
        # A cat should share a size with her own coats, not re-fit the shipped
        # dog around a different silhouette. The dog scale remains the one used
        # to derive its decoration anchors below.
        fit_scales(yuna_strips)
        K, ANCHOR_X = k, anchor_x

    # --- the decoration report, and the check it exists for ----------------- #
    decor_report: list[tuple[str, str, str, list[int]]] = []
    for (set_name, strip), s in strips.items():
        for i, cell in enumerate(s.cells):
            if cell.deco_areas:
                decor_report.append((set_name, strip, f"{strip}_{i}", cell.deco_areas))
    stray = sorted(
        {
            (set_name, strip)
            for (set_name, strip), s in strips.items()
            if s.has_decorations()
            and strip not in EXPECTED_DECOR
            and resolutions[set_name][strip].provenance == "v4"
        }
    )
    if stray:
        lines = "\n".join(
            f"  {set_name}/{strip}: {resolutions[set_name][strip].path.name}"
            for set_name, strip in stray
        )
        raise SystemExit(
            "these v4 strips carry something besides the dog:\n" + lines + "\n"
            "The app draws the `?` and the `z z` itself now, so a glyph in the art would be "
            "mirrored backwards on half the screen. Regenerate the strip, or add it to "
            "EXPECTED_DECOR if the extra really is part of the drawing."
        )
    # ... and the same glyph drawn TOUCHING the dog, which the check above cannot
    # see at all: it is one component with him. See `check_glued_glyphs`.
    check_glued_glyphs(strips, resolutions)

    # --- rasterise ---------------------------------------------------------- #
    tables = {set_name: letter_table(SET_COAT[set_name]) for set_name in resolutions}
    holes_total = 0

    def raster(strip: Strip, cell: Cell, table: LetterTable, ids=None) -> list[str]:
        nonlocal holes_total
        x_left, y_top, s = strip.transform(cell)
        if ids is None and strip.name in UNIVERSAL_DECOR_STRIPS:
            ids = [cell.dog_id]
        img = cell_rgba(strip.rgb, cell, ids)
        rgba = resample(img, (x_left, y_top, x_left + BOX / s, y_top + BOX / s), (BOX, BOX))
        rows, holes = to_rows(rgba, table)
        holes_total += holes
        return rows

    frames_by_set: dict[str, dict[str, dict]] = {}
    for set_name, resolved in resolutions.items():
        table = tables[set_name]
        frames: dict[str, dict] = {}
        for strip in strip_counts(set_name):
            if strip not in resolved or strip in SPECIAL_BOX_STRIPS:
                continue
            s = strips[(set_name, strip)]
            for i, cell in enumerate(s.cells):
                rows = raster(s, cell, table)
                f: dict = {"box": "stand", "rows": rows}
                if not rows[-1].strip(TRANSPARENT):
                    f["airborne"] = True
                frames[f"{strip}_{i}"] = f
            # The legacy blink strip sits immediately after the idle strip it
            # belongs to, so the frame order in the JSON matches 0.1.2's exactly
            # and a diff of the two files shows only what changed.
            if strip == "idle" and "blink" in resolved:
                blink = strips[(set_name, "blink")]
                for i, cell in enumerate(blink.cells):
                    frames[f"blink_{i}"] = {"box": "stand", "rows": raster(blink, cell, table)}
        frames_by_set[set_name] = frames

    # --- the sleep box ------------------------------------------------------ #
    # Rendered at the common scale, then cropped to the tight union box across
    # every set, so both coats live in one box and the fullscreen sleep window is
    # sized from something real rather than assumed.
    sleep_rows: dict[str, list[list[str]]] = {}
    union = None
    for set_name in resolutions:
        s = strips[(set_name, "sleep")]
        rows_list = [raster(s, c, tables[set_name]) for c in s.cells]
        sleep_rows[set_name] = rows_list
        for rows in rows_list:
            b = tight(rows)
            union = b if union is None else (
                min(union[0], b[0]), min(union[1], b[1]),
                max(union[2], b[2]), max(union[3], b[3]))
    assert union is not None

    sleep_glyphless = (
        base["sleep"].provenance == "v4" or "sleep" in UNIVERSAL_DECOR_STRIPS
    )
    headroom = SLEEP_DECOR_HEADROOM_ROWS if sleep_glyphless else 0
    sleep_box = (union[0], max(0, union[1] - headroom), union[2], union[3])
    for set_name, rows_list in sleep_rows.items():
        for i, rows in enumerate(rows_list):
            frames_by_set[set_name][f"sleep_{i}"] = {"box": "sleep", "rows": crop(rows, sleep_box)}
    sleep_w = sleep_box[2] - sleep_box[0] + 1
    sleep_h = sleep_box[3] - sleep_box[1] + 1

    boxes = {"stand": [BOX, BOX], "sleep": [sleep_w, sleep_h]}
    if "lie" in base:
        # The weekly pose needs the standing canvas even though its resting ink
        # is tight: shared pet/bark/perk frames can play over either posture,
        # and a smaller canvas would crop those whole-strip animations. The
        # third source cell is deliberately rasterised but discarded: it remains
        # in the owner-approved strip, while the held-pose design uses only the
        # head-up and head-on-paws states.
        lie_rows: dict[str, list[list[str]]] = {}
        for set_name in resolutions:
            s = strips[(set_name, "lie")]
            rows_list = [raster(s, c, tables[set_name]) for c in s.cells]
            lie_rows[set_name] = rows_list
        lie_box = (0, 0, BOX - 1, BOX - 1)
        for set_name, rows_list in lie_rows.items():
            frames_by_set[set_name]["lie_0"] = {"box": "lie", "rows": crop(rows_list[0], lie_box)}
            frames_by_set[set_name]["lie_1"] = {
                "box": "lie_down", "rows": crop(rows_list[1], lie_box)
            }
        boxes["lie"] = [BOX, BOX]
        boxes["lie_down"] = [BOX, BOX]

    # --- decorations, lifted out of the legacy frames they are drawn in ----- #
    base_frames = frames_by_set[BASE_SET]

    def decoration(name: str, strip: Strip, cell_index: int, pick) -> None:
        """Rasterise chosen decoration components on their own tight box.

        Quantised against the base table and copied into every set. The glyphs
        are outline-and-fill shapes whose letters are the shared ones — the ``?``
        is ink and white, the ``z z`` is sleepy blue — so they read identically
        under any coat, and there is nowhere else to get them: the regenerated
        strips do not draw them.
        """
        strip_cell = strip.cells[cell_index]
        made = []
        for suffix, ids in pick(strip_cell):
            rows = raster(strip, strip_cell, tables[BASE_SET], ids)
            b = tight(rows)
            if b is None:
                continue
            made.append((suffix, crop(rows, b)))
        if not made:
            return
        w = max(len(r[0]) for _, r in made)
        h = max(len(r) for _, r in made)
        boxes[name] = [w, h]
        for suffix, rows in made:
            padded = [r.ljust(w, TRANSPARENT) for r in rows]
            padded = [TRANSPARENT * w] * (h - len(padded)) + padded
            for frames in frames_by_set.values():
                frames[f"{name}{suffix}"] = {"box": name, "rows": padded}

    def by_area(cell: Cell, labels: np.ndarray):
        return sorted(cell.deco_ids, key=lambda i: -int((labels == i).sum()))

    # heart: the two hearts the owner drew above the petted dog, largest first.
    # Still from the golden `pet` strip, which was never regenerated.
    pet = strips[(BASE_SET, "pet")]
    hearts = by_area(pet.cells[3], pet.cells[3].labels)[:2]
    decoration("heart", pet, 3, lambda c: [(f"_{j}", [i]) for j, i in enumerate(hearts)])
    # question mark: its curve and its dot are two components, one sprite
    decoration("qmark", decor_strips["qmark_source"], 2, lambda c: [("", list(c.deco_ids))])
    # z z: the whole glyph cluster the owner drew over the sleeping dog
    decoration("zz", decor_strips["zz_source"], 2, lambda c: [("_0", list(c.deco_ids))])
    # sweat: baked into the worried strip's own frames, so the sheet has none.

    # Optional replacements are standalone only. Keep the legacy extraction
    # above and its fit inputs intact: removing those inputs could recenter the
    # dog cast, and replacing pixels inside pet/tilt/sleep would redraw art the
    # owner did not ask to change.
    decoration_path = V4 / "decorations.png"
    if decoration_path.exists():
        replacement_frames, holes = standalone_decorations(decoration_path, shared_letter_table())
        holes_total += holes
        boxes.update({name: list(size) for name, size in DECORATION_BOXES.items()})
        for frames in frames_by_set.values():
            frames.update(replacement_frames)
        print(f"standalone decorations: {decoration_path} (four fixed-grid cells)")

    # --- animations --------------------------------------------------------- #
    def resolve_refs(refs: list[str]) -> list[str]:
        return [ref.replace(":", "_") if ":" in ref else ref for ref in refs]

    def animation_json(refs: list[str], ms: int, loop: bool, hold: bool, loop_from: int | None = None) -> dict:
        frame_names = resolve_refs(refs)
        a: dict = {"frames": frame_names, "durationsMs": [ms] * len(frame_names), "loop": loop}
        if hold:
            a["hold"] = True
        if loop_from is not None:
            a["loopFrom"] = loop_from
        return a

    animations: dict[str, dict] = {}
    for name, (refs, ms, loop, hold) in animations_spec.items():
        animations[name] = animation_json(refs, ms, loop, hold)
    # Decorations last, and only the frames that were actually extracted.
    decor_animations: dict[str, dict] = {}
    for name, (refs, ms, loop, hold) in DECOR_ANIMATIONS.items():
        present = [n for n in refs if n in base_frames]
        if not present:
            continue
        a = {"frames": present, "durationsMs": [ms] * len(present), "loop": loop}
        if hold:
            a["hold"] = True
        decor_animations[name] = a

    # Ordered so that the JSON reads (and diffs) the way 0.1.2's did: the idle
    # family, the common strips, the decorations, then the moods.
    ordered: dict[str, dict] = {}
    for name in idle_table:
        ordered[name] = animations[name]
    for name in ANIMATIONS_COMMON:
        ordered[name] = animations[name]
    for name in ANIMATIONS_LIE:
        if name in animations:
            ordered[name] = animations[name]
    ordered.update(decor_animations)
    for mood in MOODS:
        for name in (f"idle_{mood}", f"blink_{mood}"):
            if name in animations:
                ordered[name] = animations[name]
    animations = ordered

    for expression, animation in EXPRESSIONS.items():
        if animation not in animations:
            raise SystemExit(f"expressions: {expression} -> {animation}, which is not in the sheet")

    # --- decoration anchors ------------------------------------------------- #
    anchors = decor_anchors(strips, base, boxes, sleep_box, sleep_glyphless)

    # --- palettes ----------------------------------------------------------- #
    palettes = {}
    for coat in PALETTE_ORDER:
        needs = PALETTE_SET.get(coat)
        if needs is not None and needs not in resolutions:
            continue
        p = dict(zip(COAT, COAT_RAMPS[coat].split()))
        p.update(SHARED)
        p.update(PALETTE_SHARED_OVERRIDES.get(coat, {}))
        palettes[coat] = p

    sheet: dict = {
        "boxes": boxes,
        "palettes": palettes,
        "frames": base_frames,
        "animations": animations,
        "expressions": dict(EXPRESSIONS),
    }
    # The optional sections, appended so that a sheet without them is diffable
    # against 0.1.2's line for line.
    extra_sets = {s: frames_by_set[s] for s in resolutions if s != BASE_SET}
    if extra_sets:
        sheet["frameSets"] = extra_sets
        sheet["paletteFrameSets"] = {
            coat: PALETTE_SET[coat] for coat in palettes if coat in PALETTE_SET
        }
        sheet["frameSetAnimations"] = {
            set_name: {
                name: animation_json(refs, ms, loop, hold, YUNA_LOOP_FROM.get(name))
                for name, (refs, ms, loop, hold) in YUNA_ANIMATION_OVERRIDES.items()
            }
            for set_name in YUNA_SETS
            if set_name in resolutions
        }
    if anchors:
        sheet["decorAnchors"] = anchors

    write_refcells(strips, base)
    cross_set = check_cross_set(frames_by_set, resolutions)

    if report:
        print_report(
            strips, resolutions, base, k, anchor_x, sleep_w, sleep_h, headroom,
            holes_total, decor_report, cross_set, anchors,
        )
        print()
    print_summary(resolutions, skipped, waiting, animations, anchors)

    return sheet


def decor_anchors(
    strips: dict[tuple[str, str], Strip],
    base: dict[str, Resolved],
    boxes: dict[str, list[int]],
    sleep_box: tuple[int, int, int, int],
    sleep_glyphless: bool,
) -> dict[str, dict[str, dict[str, int]]]:
    """Turn ``DECOR_ANCHORS`` into sheet pixels.

    Emitted only for a strip whose frames carry NO glyph, which today means only
    v4 art. That single condition is the whole migration: an anchor is the sheet
    saying "this glyph is the app's job", so declaring one for the legacy
    ``tilt`` would draw a second ``?`` next to the one the owner painted — and
    withholding it keeps ``mirrorReady`` false, which keeps the dog
    art-oriented, which is correct while his glyphs are baked in.
    """
    out: dict[str, dict[str, dict[str, int]]] = {}
    for (animation, decor), (dx, dy) in DECOR_ANCHORS.items():
        strip_name, index = DECOR_ANCHOR_REFERENCE[(animation, decor)]
        if base[strip_name].provenance != "v4" and strip_name not in UNIVERSAL_DECOR_STRIPS:
            continue
        if decor not in boxes:
            continue
        strip = strips[(BASE_SET, strip_name)]
        cell = strip.cells[index]
        x_left, y_top, s = strip.transform(cell)
        crop_x, crop_y = (sleep_box[0], sleep_box[1]) if strip_name in SLEEP_BOX_STRIPS else (0, 0)
        box_name = "sleep" if strip_name in SLEEP_BOX_STRIPS else "stand"
        box_w, box_h = boxes[box_name]
        decor_w, decor_h = boxes[decor]

        # The dog's own frame of reference: the column his centre of mass lands
        # in and the row his topmost ink sits on, both in box coordinates.
        ref_col = (cell.dog_cx - x_left) * s - crop_x
        ref_row = (cell.dog_top - y_top) * s - crop_y
        x = round(ref_col + dx * K)
        y = round(ref_row + dy * K)
        clamped_x = max(0, min(x, box_w - decor_w))
        clamped_y = max(0, min(y, box_h - decor_h))
        drift = max(abs(clamped_x - x), abs(clamped_y - y))
        if drift > ANCHOR_CLAMP_TOLERANCE_PX:
            print(
                f"warning: the {decor} anchor for {animation} computed to ({x}, {y}), which "
                f"is outside the {box_w}x{box_h} {box_name} box; clamped to "
                f"({clamped_x}, {clamped_y}). Re-run --measure-decor and update DECOR_ANCHORS."
            )
        out.setdefault(animation, {})[decor] = {"x": clamped_x, "y": clamped_y}
    return out


def write_refcells(strips: dict[tuple[str, str], Strip], base: dict[str, Resolved]) -> None:
    """Raw RGBA crops of three original cells, for render.mjs's comparison sheet.

    Written as headerless RGBA buffers plus a JSON index so that render.mjs needs
    no PNG decoder and stays on Node built-ins.
    """
    REFCELLS.mkdir(parents=True, exist_ok=True)
    index = []
    for strip_name, i in COMPARE_CELLS:
        if strip_name not in base:
            continue
        strip = strips[(BASE_SET, strip_name)]
        if i >= len(strip.cells):
            continue
        cell = strip.cells[i]
        # match the sprite's 2x height: the same scale, doubled
        s = strip.scale * 2
        w = max(1, round((cell.right - cell.left + 1) * s))
        h = max(1, round((cell.bottom - cell.top + 1) * s))
        ids = [cell.dog_id] if strip_name in UNIVERSAL_DECOR_STRIPS else None
        img = cell_rgba(strip.rgb, cell, ids)
        rgba = resample(img, (cell.left, cell.top, cell.right + 1, cell.bottom + 1), (w, h))
        name = f"{strip_name}_{i}.rgba"
        (REFCELLS / name).write_bytes(rgba.astype(np.uint8).tobytes())
        index.append({"animation": strip_name, "frame": f"{strip_name}_{i}", "file": name, "w": w, "h": h})
    (REFCELLS / "index.json").write_text(json.dumps(index, indent=2) + "\n")


# --------------------------------------------------------------------------- #
# 10. Reports                                                                  #
# --------------------------------------------------------------------------- #

def check_cross_set(
    frames_by_set: dict[str, dict[str, dict]],
    resolutions: dict[str, dict[str, Resolved]] | None = None,
) -> list[tuple]:
    """Compare every non-base set's frames with the base set's, by tight bbox.

    Runs on every build, not only under ``--report``: the coat switcher swaps
    frame sets under a running animation, so a stockier drawing of one coat makes
    the dog visibly change size when his colour changes — and a check that only
    fires when someone remembers a flag is a check that does not fire.
    A base frame from a legacy strip is deliberately excluded from the hard
    comparison. Some retained legacy frames include a baked ``?`` or ``z z``,
    while their new dapple counterparts must be glyph-free so the app can draw
    the symbol after mirroring. Their tight bounds measure different artwork,
    not different dog scale. The normaliser still fits both sets into the same
    runtime box, and all v4-to-v4 frames keep the hard check.
    """
    rows: list[tuple] = []
    failures: list[str] = []
    for set_name, frames in frames_by_set.items():
        if set_name == BASE_SET or set_name in YUNA_SETS:
            continue
        for name, frame in frames.items():
            strip_name = name.rsplit("_", 1)[0]
            base_source = (
                resolutions.get(BASE_SET, {}).get(strip_name)
                if resolutions is not None else None
            )
            if base_source is not None and base_source.provenance != "v4":
                continue
            bw, bh = bbox_size(frame["rows"])
            aw, ah = bbox_size(frames_by_set[BASE_SET][name]["rows"])
            if aw == 0 or ah == 0:
                continue
            ratio = max(abs(bw / aw - 1), abs(bh / ah - 1))
            rows.append((set_name, name, bw, bh, aw, ah, ratio))
            if ratio > CROSS_SET_BBOX_FAIL:
                failures.append(f"{set_name}/{name}: {bw}x{bh} vs {aw}x{ah} ({ratio:.1%})")
    if failures:
        raise SystemExit(
            "these frames differ too much in size between coat sets:\n  "
            + "\n  ".join(failures)
            + f"\nThe coat switcher swaps sets under a running animation, so the dog would "
              f"visibly change size when his colour changed (the limit is "
              f"{CROSS_SET_BBOX_FAIL:.0%}). Regenerate the strip at the same scale as its "
              f"{BASE_SET} reference."
        )
    return rows


def mirror_ready(animations: dict[str, dict], anchors: dict) -> tuple[bool, str]:
    """``mirrorReady`` (``src/sprites/contract.ts``), answered here, with a reason.

    The app's gate is a silent boolean: the dog is either mirrored on the left
    half of the screen or he is not, and the owner cannot see *why* from looking
    at him. Since this file is what decides the answer — by emitting anchors, or
    by withholding them while the glyphs are still baked into the art — it is
    also the only place that can explain it, so the summary says both.

    Deliberately the same rule and not an approximation of it: for every frame
    the app draws glyphs on, at least one animation must play that frame, and
    EVERY animation that plays it must anchor EVERY one of its glyphs.
    """
    for frame, decors in app_decor_by_frame().items():
        playing = [name for name, a in animations.items() if frame in a["frames"]]
        if not playing:
            return False, f"no animation plays {frame}"
        for decor in decors:
            blind = [n for n in playing if anchors.get(n, {}).get(decor) is None]
            if blind:
                return False, (
                    f"{', '.join(blind)} play {frame} with no {decor} anchor — the glyph "
                    f"is still baked into the art"
                )
    return True, "every decorated frame is anchored in every animation that plays it"


def print_summary(
    resolutions: dict[str, dict[str, Resolved]],
    skipped: dict[str, str],
    waiting: dict[str, str],
    animations: dict[str, dict],
    anchors: dict,
) -> None:
    """The one block a plain ``python3 art/strips.py`` run prints.

    The owner runs this file after dropping each new strip, and before this
    existed a plain run said only "wrote walder.json — 48 frames": nothing about
    which strips it had actually used, so a file dropped under a name the
    resolver did not match looked exactly like a file that had been picked up.
    ``--report`` had the answer buried in eighty lines of measurements, which is
    not a thing to read after every drop.

    Three questions, in the order he asks them: did my new strip land (which
    ones are still legacy), did the anchors come out, and is the mirror on yet.
    """
    print("summary")
    for set_name in SETS:
        resolved = resolutions.get(set_name)
        if resolved is None:
            if set_name in waiting:
                print(f"  {waiting[set_name]}")
            else:
                print(f"  {set_name}: not ready — {skipped.get(set_name, 'not built')}; "
                      f"skipped, the {BASE_SET} set is built as usual")
            continue
        legacy = [strip for strip, found in resolved.items() if found.provenance == "legacy"]
        if not legacy:
            print(f"  {set_name}: all {len(resolved)} strips are v4 art")
        elif len(legacy) == len(resolved):
            print(f"  {set_name}: no v4 art yet — all {len(legacy)} strips are the legacy "
                  f"exports ({', '.join(legacy)})")
        else:
            v4 = len(resolved) - len(legacy)
            print(f"  {set_name}: still on the legacy export for {', '.join(legacy)}; "
                  f"the other {v4} {'is' if v4 == 1 else 'are'} v4 art")
    if anchors:
        pairs = [f"{animation}.{decor}" for animation, entries in anchors.items()
                 for decor in entries]
        print(f"  anchors emitted: {', '.join(pairs)}")
    else:
        print("  anchors emitted: none — the glyphs are still baked into the art, "
              "so the app draws none")
    ready, why = mirror_ready(animations, anchors)
    print(f"  mirrorReady: {'yes' if ready else 'no'} ({why})")


def print_report(
    strips, resolutions, base, k, anchor_x, sleep_w, sleep_h, headroom,
    holes_total, decor_report, cross_set, anchors,
) -> None:
    print(f"box {BOX}x{BOX}   K (dog size measure, px) = {k:.2f}   anchor x = {anchor_x}")
    print(f"sleep box {sleep_w}x{sleep_h}   headroom rows: {headroom}   holes filled: {holes_total}")
    print(f"{'strip':10s} {'set':8s} {'from':7s} {'size(src)':>9s} {'ground':>7s} {'scale':>7s} {'anchorX':>7s} "
          f"{'shrink':>7s} {'dogH(px)':>9s} {'contentH':>9s} {'contentW':>9s}")
    for (set_name, strip), s in strips.items():
        heights = [(c.dog_slice[0].stop - c.dog_slice[0].start) * s.scale for c in s.cells]
        provenance = resolutions[set_name][strip].provenance if strip in resolutions[set_name] else "legacy"
        print(f"{strip:10s} {set_name:8s} {provenance:7s} {s.size:9.1f} {s.ground:7d} "
              f"{s.scale:7.4f} {s.anchor_x:7.1f} {s.shrink:7.3f} {np.median(heights):9.1f} "
              f"{s.up()*s.size*s.scale:9.1f} {s.width_ratio()*s.size*s.scale:9.1f}")

    ref = strips[(BASE_SET, REFERENCE_STRIP)]
    h_ref = np.median([(c.dog_slice[0].stop - c.dog_slice[0].start) for c in ref.cells])
    print()
    print("height-vs-area normaliser agreement (standing strips, 1.000 = identical):")
    for (set_name, strip), s in strips.items():
        if strip in ("out", "sleep"):
            continue
        h = np.median([(c.dog_slice[0].stop - c.dog_slice[0].start) for c in s.cells])
        print(f"   {strip:10s} {set_name:8s} {(h / s.size) / (h_ref / ref.size):6.3f}")

    print()
    print("decorations found per strip (components that are not the dog):")
    if not decor_report:
        print("   none")
    for set_name, strip, frame, areas in decor_report:
        if strip in EXPECTED_DECOR:
            note = "expected"
        elif resolutions[set_name][strip].provenance == "legacy":
            note = "the legacy glyph — not checked, and the source of the app's own sprite"
        else:
            note = "UNEXPECTED"  # unreachable: the build fails above
        print(f"   {set_name:8s} {frame:16s} {len(areas)} component(s), "
              f"{', '.join(str(a) for a in areas)} px  ({note})")

    if cross_set:
        print()
        print(f"cross-set bounding boxes vs {BASE_SET} "
              f"(warn > {CROSS_SET_BBOX_WARN:.0%}, fail > {CROSS_SET_BBOX_FAIL:.0%}):")
        for set_name, name, bw, bh, aw, ah, ratio in cross_set:
            if ratio > CROSS_SET_BBOX_WARN:
                print(f"   warn {set_name}/{name}: {bw}x{bh} vs {aw}x{ah} ({ratio:+.1%})")
        print(f"   worst: {max(r[-1] for r in cross_set):.1%}")

    print()
    print("decoration anchors (top-left of the glyph box, sprite px, art orientation):")
    if not anchors:
        print("   none — the glyphs are still baked into the art, so the app draws none")
    for animation, entries in anchors.items():
        for decor, at in entries.items():
            print(f"   {animation:10s} {decor:6s} ({at['x']}, {at['y']})")


def measure_decor(force_legacy_bg: bool = False) -> None:
    """Where the owner's own baked glyphs actually sit — the seed for DECOR_ANCHORS.

    A one-off report, and the reason ``DECOR_ANCHORS`` is a table of two numbers
    rather than a guess: the ``?`` and the ``z z`` go where he drew them.
    """
    global ANCHOR_X, K
    resolved, missing = resolve_set(BASE_SET)
    if missing:
        print(f"note: {BASE_SET} is missing {', '.join(missing)}")
    detector = "legacy" if force_legacy_bg else BG_DETECTOR_BY_SET[BASE_SET]
    strips = {
        (BASE_SET, strip): Strip(strip, found.path, found.frames, detector)
        for strip, found in resolved.items()
    }
    decor: dict[str, Strip] = {}
    for alias, legacy_strip in DECOR_ONLY_STRIPS.items():
        key, count = LEGACY_SOURCES[legacy_strip]
        path = find_in(STRIPS, key)
        if path is None:
            raise SystemExit(f"the legacy {legacy_strip} strip ({key}) is missing from {STRIPS}")
        decor[legacy_strip] = Strip(alias, path, count, "legacy")

    K, ANCHOR_X = fit_scales({**strips, **{("_decor", n): s for n, s in decor.items()}})
    table = letter_table(SET_COAT[BASE_SET])
    print(f"K = {K:.4f} px   anchor x = {ANCHOR_X}")
    print(f"{'strip':8s} {'cell':4s} {'glyph box':>18s} {'dog cx':>8s} {'dog top':>8s} "
          f"{'dx':>9s} {'dy':>9s}")

    seen: set[tuple[str, int]] = set()
    for (animation, glyph), (strip_name, index) in DECOR_ANCHOR_REFERENCE.items():
        if (strip_name, index) in seen:
            continue
        seen.add((strip_name, index))
        strip = decor.get(strip_name)
        if strip is None:
            print(f"{strip_name}: no legacy strip to measure")
            continue
        cell = strip.cells[index]
        if not cell.deco_ids:
            print(f"{strip_name}_{index}: no decoration in the legacy strip either")
            continue
        x_left, y_top, s = strip.transform(cell)
        img = cell_rgba(strip.rgb, cell, list(cell.deco_ids))
        rgba = resample(img, (x_left, y_top, x_left + BOX / s, y_top + BOX / s), (BOX, BOX))
        rows, _ = to_rows(rgba, table)
        b = tight(rows)
        if b is None:
            print(f"{strip_name}_{index}: the decoration vanished at this scale")
            continue
        ref_col = (cell.dog_cx - x_left) * s
        ref_row = (cell.dog_top - y_top) * s
        dx = (b[0] - ref_col) / K
        dy = (b[1] - ref_row) / K
        print(f"{strip_name:8s} {index:<4d} rows {b[1]}-{b[3]} cols {b[0]}-{b[2]}  "
              f"{ref_col:8.2f} {ref_row:8.2f} {dx:9.4f} {dy:9.4f}   "
              f"({glyph} for {animation})")
    print()
    print("Paste dx/dy into DECOR_ANCHORS. They are in dog-size units (multiples of K),")
    print("measured from the dog's centre-of-mass column and topmost ink row to the")
    print("TOP-LEFT of the glyph box — so they survive a box change or a new coat set.")


def box_compare(sizes: list[int]) -> None:
    """Render idle_0 at several box sizes, side by side, 4x, for the face verdict."""
    global BOX, ANCHOR_X, K
    resolved, _ = resolve_set(BASE_SET)
    tiles = []
    keep = BOX
    table = letter_table(SET_COAT[BASE_SET])
    for size in sizes:
        BOX = size
        strips = {
            (BASE_SET, name): Strip(name, found.path, found.frames, BG_DETECTOR_BY_SET[BASE_SET])
            for name, found in resolved.items()
        }
        K, ANCHOR_X = fit_scales(strips)
        strip = strips[(BASE_SET, "idle")]
        cell = strip.cells[0]
        x_left, y_top, sc = strip.transform(cell)
        rgba = resample(cell_rgba(strip.rgb, cell), (x_left, y_top, x_left + size / sc, y_top + size / sc), (size, size))
        rows, _ = to_rows(rgba, table)
        tiles.append((size, rows))
    BOX = keep

    pal = dict(zip(COAT, COAT_RAMPS["golden"].split()))
    pal.update(SHARED)
    scale = 4
    gap = 8
    height = max(len(r) for _, r in tiles) * scale + gap * 2
    width = sum(len(r[0]) * scale + gap for _, r in tiles) + gap
    img = Image.new("RGB", (width, height), (92, 92, 102))
    px = img.load()
    x = gap
    for size, rows in tiles:
        oy = height - gap - len(rows) * scale
        for y, row in enumerate(rows):
            for xx, ch in enumerate(row):
                if ch == TRANSPARENT:
                    continue
                c = hex_to_rgb(pal[ch])
                for sy in range(scale):
                    for sx in range(scale):
                        px[x + xx * scale + sx, oy + y * scale + sy] = c
        x += len(rows[0]) * scale + gap
    out = HERE / "out" / ("box_compare_" + "_".join(str(s) for s in sizes) + ".png")
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    print(f"wrote {out}  (boxes {sizes}, 4x)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--report", action="store_true", help="print the measurement tables")
    ap.add_argument("--measure-decor", action="store_true",
                    help="print where the legacy ? and z z sit, and exit")
    ap.add_argument("--require-set", action="append", default=[], metavar="SET",
                    help="fail instead of skipping this coat set (repeatable)")
    ap.add_argument("--legacy-bg", action="store_true",
                    help="use the achromatic-grey background rule for every set")
    ap.add_argument("--box-compare", nargs="*", type=int, metavar="N",
                    help="also write art/out/box_compare_<sizes>.png and exit")
    args = ap.parse_args()

    if args.measure_decor:
        measure_decor(force_legacy_bg=args.legacy_bg)
        return

    if args.box_compare:
        box_compare(args.box_compare)
        return

    sheet = build(
        report=args.report,
        require_sets=frozenset(args.require_set),
        force_legacy_bg=args.legacy_bg,
    )
    OUT_JSON.write_text(json.dumps(sheet, indent=1) + "\n")
    n_frames = len(sheet["frames"])
    sets = 1 + len(sheet.get("frameSets", {}))
    print(f"wrote {OUT_JSON}  —  {n_frames} frames x {sets} frame set(s), "
          f"{len(sheet['animations'])} animations, {len(sheet['palettes'])} palettes, "
          f"boxes {', '.join(f'{k}={v[0]}x{v[1]}' for k, v in sheet['boxes'].items())}")


if __name__ == "__main__":
    main()

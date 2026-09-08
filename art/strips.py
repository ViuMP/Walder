#!/usr/bin/env python3
"""
art/strips.py — build ``art/walder.json`` from the owner's strip illustrations.

    python3 art/strips.py            # rebuild walder.json (+ refcells for render.mjs)
    python3 art/strips.py --report   # the same, plus the measurement tables
    python3 art/strips.py --box-compare 64 72 80
                                     # extra: art/out/box_compare_*.png, face legibility

The owner's instruction is binding: **the strip illustrations are used 1:1.**
Nothing here draws, redraws, retouches or "improves" a pixel. Every operation is
a *fitting* operation — background removal, slicing, one uniform scale per strip,
alignment on the ground line, area downsampling, and a nearest-colour map onto
the sheet's own 15 colours. The old hand-authored pipeline (``frames.mjs``,
``trace.py``, ``traced/``) is retired under ``art/obsolete/`` and is not used.

Pipeline
--------
0. **Name.** Each source strip is copied (idempotently) to
   ``design/references/Strips/named/<animation>.png`` so the mapping from a
   Firefly filename to an animation is a file on disk, not a comment.
1. **Slice.** The flat grey ground is removed by a flood fill from the image
   border over "achromatic and mid-grey" pixels, then two constrained dilations
   to eat the anti-aliased fringe and the soft drop shadow. What is left is
   labelled into connected components; the ``n`` largest are the ``n`` dogs, left
   to right. Every smaller component (hearts, ``z``, ``?``, motion ticks, the
   breath puff) is assigned to the nearest dog and stays **part of that frame** —
   the owner drew them there. Four of them are *additionally* extracted as
   standalone decoration sprites for the app's own bubbles.
2. **Normalise.** One scale per strip, so that the dog is the same size in every
   strip as it is in ``idle``. The size measure is the median
   ``sqrt(silhouette area)`` of the strip's dogs, not the bbox height: height is
   meaningless for the curled ``sleep`` and the flat ``out`` poses. On the nine
   standing strips the two measures agree to within ±4 %, so this is the same
   normalisation the height rule would give, extended to the poses where the
   height rule breaks. Frames are aligned on their strip's ground line (the
   lowest paw row of the strip) and anchored horizontally on the dog's centre of
   mass, so frames do not slide. A frame whose paws sit more than
   ``LIFT_EPSILON_PX`` above the ground line keeps that gap (``hop_2``, ``hop_1``);
   anything less is sub-pixel slicing noise and is snapped down.
3. **Rasterise.** Each frame is area-averaged (PIL ``BOX``) straight from the
   source rectangle into the box, alpha is thresholded at 50 %, and each surviving
   pixel is mapped to the nearest of the sheet's 15 colours in OKLab — no
   dithering. One cleanup pass follows and only one: transparent holes fully
   enclosed by the silhouette and no larger than ``MAX_HOLE_PX`` are filled with
   their neighbours' majority colour.
4. **Write.** ``art/walder.json`` plus ``art/refcells/`` — raw RGBA crops of three
   original strip cells that ``render.mjs`` puts beside the finished sprites in
   ``compare_strip_vs_sprite.png`` (kept as raw buffers so ``render.mjs`` stays
   dependency-free and needs no PNG decoder).

Nothing in this file is hand-tuned per frame. Every number is a named constant
below, and re-running it reproduces ``walder.json`` exactly.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
STRIPS = ROOT / "design" / "references" / "Strips"
NAMED = STRIPS / "named"
OUT_JSON = HERE / "walder.json"
REFCELLS = HERE / "refcells"

# --------------------------------------------------------------------------- #
# 1. The strips                                                                #
# --------------------------------------------------------------------------- #

#: animation -> (source file or a unique fragment of it, expected frame count).
#: Verified frame by frame against the images on 2026-09-08.
#: NOTE: ``Firefly (1).png`` and ``pixel_art_01.png`` are byte-for-byte the same
#: picture (identical pixels, different PNG metadata), so there is exactly one
#: idle strip and no separate ``idle_rare`` illustration. Its third frame is the
#: head-raised / ears-flared beat, which is what ``idle_rare`` is for, so
#: ``idle_rare`` (and ``ear_flop``) replay the idle frames at their own tempo
#: rather than inventing art the owner did not draw.
SOURCES: list[tuple[str, str, int]] = [
    ("idle", "pixel_art_01.png", 4),  # breathing; frame 3 lifts the head
    ("blink", "573286", 2),  # half-closed, closed
    ("out", "866337", 2),  # flat, X eyes; frame 2 has a breath puff
    ("perk", "341644", 3),  # resting, lifting, head high with ears flared
    ("tilt", "853216", 3),  # frame 3 carries the question mark
    ("sleep", "20058", 3),  # curled; frame 3 carries the z z
    ("bark", "584196", 4),  # frame 3 mouth open with motion lines
    ("walk", "746127", 4),  # trot
    ("wake", "834491", 4),  # curled, yawn, stretch, shake
    ("tail_wag", "50632", 4),
    ("hop", "768051", 5),  # frame 3 airborne
    ("pet", "114291", 6),  # hearts from frame 3
]

#: Which box each strip's frames are written into. ``wake`` is a *stand* box
#: animation even though it starts curled: ``core/behaviour.ts`` emits
#: ``{type:'mode', box:'stand'}`` immediately before ``play('wake')``, so the
#: window is already the big one when it runs. ``out`` is a stand-box animation
#: because ``core/expression.ts`` reaches it from the stand-box cascade.
SLEEP_BOX_STRIPS = {"sleep"}

# --------------------------------------------------------------------------- #
# 2. Fitting constants                                                         #
# --------------------------------------------------------------------------- #

BOX = 72  #: the standing box, 72x72 -> 144 px on screen at 2x (the owner's max)
REFERENCE_STRIP = "idle"  #: every other strip is scaled to match this one's dog

BG_CHROMA = 14  #: max(R,G,B) - min(R,G,B) at or below this reads as grey
BG_MIN, BG_MAX = 140, 245  #: ... and mean brightness inside this band is ground
FRINGE_CHROMA, FRINGE_MIN = 18, 150  #: the looser test used to eat the AA fringe
FRINGE_PASSES = 2
MIN_COMPONENT_PX = 40  #: below this a component is slicing speckle, not artwork

ALPHA_THRESHOLD = 128  #: 50 % coverage keeps the pixel
LIFT_EPSILON_PX = 2.0  #: a smaller gap under the paws is noise, snap it down
MAX_HOLE_PX = 4  #: enclosed transparent holes up to this size are filled

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
#: (per-tone luminance percentiles against the golden ramp). Unchanged from the
#: previous sheet — the panel has not changed, so neither have the samples.
COAT_RAMPS: dict[str, str] = {
    "golden": "#FFF3D6 #FFE3A6 #FFC67D #E3A454 #C47A30 #A25F21 #7A451A #5F3415",
    "red": "#FFEBD6 #F6D3A9 #DE9A62 #C06B34 #9E5228 #7E3F1E #5C2C16 #431F10",
    "cream": "#FFFDF4 #FDF0D8 #F8E3C0 #EBCB9F #D0A87A #B48B60 #8E6A45 #6E4F32",
    "black-and-tan": "#D69A4A #5E5A5B #4E4A4B #3C3839 #302D2F #262425 #1B1A1B #121112",
    "chocolate": "#C8873F #96684A #7A5138 #61402B #4E3322 #3E281A #2E1D14 #22150E",
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

#: Timings from Panel D of the design sheet (ms per frame, loop, hold).
TIMING: dict[str, tuple[int, bool, bool]] = {
    "idle": (125, True, False),
    "idle_neutral": (125, True, False),
    "idle_rare": (100, False, False),
    "ear_flop": (100, False, False),
    "blink": (83, False, False),
    "walk": (125, True, False),
    "tail_wag": (100, True, False),
    "bark": (100, False, False),
    "pet": (125, False, False),
    "hop": (100, False, False),
    "perk": (100, False, True),
    "tilt": (125, False, True),
    "sleep": (1000, True, False),
    "wake": (125, False, False),
    "out": (1000, True, False),
    "confused": (700, True, False),
    "heart": (300, True, False),
    "qmark": (900, False, False),
    "zz": (700, True, False),
}

#: Expression -> the animation that plays it. ``happy``/``worried``/``exhausted``
#: are TEMPORARY aliases of ``idle``: the owner's expressions strip has not been
#: drawn yet. When it arrives, add it to SOURCES and change these three values to
#: their own animation names — that is the whole change.
EXPRESSION_ANIMATION: dict[str, str] = {
    "neutral": "idle_neutral",
    "happy": "idle",
    "worried": "idle",
    "exhausted": "idle",
    "out": "out",
    "confused": "confused",
}

#: Which original cells ``render.mjs`` shows beside the finished sprites.
COMPARE_CELLS: list[tuple[str, int]] = [("idle", 0), ("tilt", 2), ("pet", 3)]


# --------------------------------------------------------------------------- #
# 3. Colour                                                                    #
# --------------------------------------------------------------------------- #

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


PALETTE_RGB = np.array([hex_to_rgb(h) for _, h in LETTERS], dtype=np.float64)
PALETTE_LAB = srgb_to_oklab(PALETTE_RGB)
PALETTE_CHARS = [ch for ch, _ in LETTERS]


def quantise(rgb: np.ndarray) -> np.ndarray:
    """(...,3) uint8 -> index into LETTERS, nearest in OKLab, no dithering."""
    lab = srgb_to_oklab(rgb.reshape(-1, 3))
    d = ((lab[:, None, :] - PALETTE_LAB[None, :, :]) ** 2).sum(-1)
    return d.argmin(1).reshape(rgb.shape[:-1])


# --------------------------------------------------------------------------- #
# 4. Slicing                                                                   #
# --------------------------------------------------------------------------- #

def resolve_source(key: str) -> Path:
    exact = STRIPS / key
    if exact.exists():
        return exact
    hits = sorted(p for p in STRIPS.glob("*.png") if key in p.name)
    if len(hits) != 1:
        raise SystemExit(f"source {key!r} matched {len(hits)} files: {[p.name for p in hits]}")
    return hits[0]


def name_sources() -> dict[str, Path]:
    """Step 0 — copy every strip to named/<animation>.png. Idempotent."""
    NAMED.mkdir(parents=True, exist_ok=True)
    named: dict[str, Path] = {}
    for anim, key, _ in SOURCES:
        src = resolve_source(key)
        dst = NAMED / f"{anim}.png"
        if not dst.exists() or dst.stat().st_size != src.stat().st_size:
            shutil.copyfile(src, dst)
        named[anim] = dst
    return named


def background_mask(rgb: np.ndarray) -> np.ndarray:
    """The flat grey ground: flood fill from the border, then eat the AA fringe."""
    a = rgb.astype(np.int16)
    chroma = a.max(2) - a.min(2)
    mean = a.mean(2)
    grey = (chroma <= BG_CHROMA) & (mean >= BG_MIN) & (mean <= BG_MAX)
    lab, _ = ndimage.label(grey)
    edge = set(lab[0]) | set(lab[-1]) | set(lab[:, 0]) | set(lab[:, -1])
    edge.discard(0)
    bg = np.isin(lab, sorted(edge))
    fringe = (chroma <= FRINGE_CHROMA) & (mean >= FRINGE_MIN)
    for _ in range(FRINGE_PASSES):
        grown = ndimage.binary_dilation(bg) & fringe
        if np.array_equal(grown, bg):
            break
        bg = grown
    return bg


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
        self.dog_cx = float(xs.mean() + dsl[1].start)
        all_sl = [slices[i - 1] for i in [dog_id, *deco_ids]]
        self.top = min(s[0].start for s in all_sl)
        self.bottom = max(s[0].stop for s in all_sl) - 1
        self.left = min(s[1].start for s in all_sl)
        self.right = max(s[1].stop for s in all_sl) - 1

    def mask(self, ids: list[int] | None = None) -> np.ndarray:
        want = [self.dog_id, *self.deco_ids] if ids is None else ids
        return np.isin(self.labels, want)


def slice_strip(path: Path, n: int) -> tuple[np.ndarray, list[Cell]]:
    rgb = np.array(Image.open(path).convert("RGB"))
    fg = ~background_mask(rgb)
    labels, k = ndimage.label(fg, structure=np.ones((3, 3), int))
    areas = ndimage.sum(fg, labels, range(1, k + 1))
    slices = ndimage.find_objects(labels)
    live = [i + 1 for i in range(k) if areas[i] >= MIN_COMPONENT_PX]
    live.sort(key=lambda i: -areas[i - 1])
    if len(live) < n:
        raise SystemExit(f"{path.name}: found {len(live)} components, need {n} dogs")

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
# 5. Rasterising                                                               #
# --------------------------------------------------------------------------- #

def cell_rgba(rgb: np.ndarray, cell: Cell, ids: list[int] | None = None) -> Image.Image:
    """The cell as an RGBA image whose transparent pixels carry RGB 0.

    Zeroing the RGB under the transparent pixels makes the plain per-channel BOX
    resize below an exactly premultiplied one, so no grey ground bleeds into the
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


def to_rows(rgba: np.ndarray) -> tuple[list[str], int]:
    """Threshold alpha, un-premultiply, quantise, fill enclosed holes."""
    alpha = rgba[..., 3].astype(np.int32)
    opaque = alpha >= ALPHA_THRESHOLD
    with np.errstate(divide="ignore", invalid="ignore"):
        rgb = np.where(
            alpha[..., None] > 0,
            np.clip(rgba[..., :3].astype(np.float64) * 255.0 / np.maximum(alpha, 1)[..., None], 0, 255),
            0.0,
        )
    idx = quantise(rgb.astype(np.uint8))

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
        rows.append("".join(PALETTE_CHARS[idx[y, x]] if opaque[y, x] else TRANSPARENT
                            for x in range(idx.shape[1])))
    return rows, holes


def tight(rows: list[str]) -> tuple[int, int, int, int] | None:
    ys = [y for y, r in enumerate(rows) if r.strip(TRANSPARENT)]
    if not ys:
        return None
    xs = [x for x in range(len(rows[0])) if any(r[x] != TRANSPARENT for r in rows)]
    return min(xs), min(ys), max(xs), max(ys)


def crop(rows: list[str], bbox: tuple[int, int, int, int]) -> list[str]:
    x0, y0, x1, y1 = bbox
    return [r[x0:x1 + 1] for r in rows[y0:y1 + 1]]


# --------------------------------------------------------------------------- #
# 6. The build                                                                 #
# --------------------------------------------------------------------------- #

class Strip:
    def __init__(self, anim: str, path: Path, n: int):
        self.anim = anim
        self.rgb, self.cells = slice_strip(path, n)
        self.size = float(np.median([c.dog_area ** 0.5 for c in self.cells]))
        self.ground = max(c.dog_bottom for c in self.cells)  # the lowest paw row
        self.scale = 0.0
        self.shrink = 1.0

    # extents in units of `size`, measured from the ground line / dog centroid
    def up(self) -> float:
        return max((self.ground - c.top) / self.size for c in self.cells)

    def width_ratio(self) -> float:
        return max((c.right - c.left + 1) / self.size for c in self.cells)

    def left_ratio(self) -> float:
        return max((c.dog_cx - c.left) / self.size for c in self.cells)

    def right_ratio(self) -> float:
        return max((c.right - c.dog_cx) / self.size for c in self.cells)


def build(report: bool = False) -> dict:
    named = name_sources()
    strips = {anim: Strip(anim, named[anim], n) for anim, _, n in SOURCES}
    ref = strips[REFERENCE_STRIP]

    # --- one scale per strip, and the largest K that keeps everything in the box.
    # `out` is the flat collapse pose: at 2.47x its own size measure it is far
    # wider than any other frame, and letting it set K would shrink the whole cast
    # by a third. It is fitted to the box instead (see `shrink` below), which is
    # the only place a strip departs from the common scale.
    driving = [s for a, s in strips.items() if a != "out"]
    k = min(min((BOX - 1) / s.up(), (BOX - 1) / s.width_ratio()) for s in driving)
    left_r = max(s.left_ratio() for s in driving)
    right_r = max(s.right_ratio() for s in driving)
    anchor_x = round(BOX * left_r / (left_r + right_r)) + 0.5

    for s in strips.values():
        s.scale = k / s.size
        need_h = s.up() * s.size * s.scale
        need_w = s.width_ratio() * s.size * s.scale
        s.shrink = min(1.0, (BOX - 1) / need_h, (BOX - 1) / need_w)
        s.scale *= s.shrink

    frames: dict[str, dict] = {}
    holes_total = 0

    def raster(strip: Strip, cell: Cell, ids=None) -> list[str]:
        nonlocal holes_total
        s = strip.scale
        # Align on the strip's ground line, which keeps a genuinely airborne
        # frame (hop_1, hop_2) the right distance off the floor. A gap under
        # LIFT_EPSILON_PX is sub-pixel slicing noise rather than lift, and would
        # otherwise cost the frame its contact row: those align on their own
        # lowest paw instead, so every grounded frame really does touch row 71.
        lift = (strip.ground - cell.dog_bottom) * s
        base = strip.ground if lift >= LIFT_EPSILON_PX else cell.dog_bottom
        y_top = base + 1 - BOX / s
        x_left = cell.dog_cx - anchor_x / s
        # keep the drawn content inside the box; only `out` ever needs this
        cl = (cell.left - x_left) * s
        cr = (cell.right + 1 - x_left) * s
        if cl < 0:
            x_left += cl / s
        elif cr > BOX:
            x_left += (cr - BOX) / s
        img = cell_rgba(strip.rgb, cell, ids)
        rgba = resample(img, (x_left, y_top, x_left + BOX / s, y_top + BOX / s), (BOX, BOX))
        rows, holes = to_rows(rgba)
        holes_total += holes
        return rows

    # --- standing frames -----------------------------------------------------
    for anim, _, _ in SOURCES:
        if anim in SLEEP_BOX_STRIPS:
            continue
        strip = strips[anim]
        for i, cell in enumerate(strip.cells):
            rows = raster(strip, cell)
            f: dict = {"box": "stand", "rows": rows}
            if not rows[-1].strip(TRANSPARENT):
                f["airborne"] = True
            frames[f"{anim}_{i}"] = f

    # --- the sleep box: rendered at the common scale, then cropped to the tight
    #     union box of the sleep frames. That box is what the tiny fullscreen
    #     window is sized from, so it is recorded rather than assumed.
    sleep = strips["sleep"]
    sleep_rows = [raster(sleep, c) for c in sleep.cells]
    boxes_sleep = None
    for rows in sleep_rows:
        b = tight(rows)
        boxes_sleep = b if boxes_sleep is None else (
            min(boxes_sleep[0], b[0]), min(boxes_sleep[1], b[1]),
            max(boxes_sleep[2], b[2]), max(boxes_sleep[3], b[3]))
    for i, rows in enumerate(sleep_rows):
        frames[f"sleep_{i}"] = {"box": "sleep", "rows": crop(rows, boxes_sleep)}
    sleep_w = boxes_sleep[2] - boxes_sleep[0] + 1
    sleep_h = boxes_sleep[3] - boxes_sleep[1] + 1

    # --- decorations, lifted out of the frames they are drawn in -------------
    boxes = {"stand": [BOX, BOX], "sleep": [sleep_w, sleep_h]}
    decorations: dict[str, list[tuple[str, list[int]]]] = {}

    def decoration(name: str, strip: Strip, cell_index: int, pick) -> None:
        """Rasterise chosen decoration components on their own tight box."""
        strip_cell = strip.cells[cell_index]
        groups = pick(strip_cell)
        made = []
        for suffix, ids in groups:
            rows = raster(strip, strip_cell, ids)
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
            frames[f"{name}{suffix}"] = {"box": name, "rows": padded}
        decorations[name] = made

    def by_area(cell: Cell, labels: np.ndarray):
        return sorted(cell.deco_ids, key=lambda i: -int((labels == i).sum()))

    # heart: the two hearts the owner drew above the petted dog, largest first
    pet = strips["pet"]
    hearts = by_area(pet.cells[3], pet.cells[3].labels)[:2]
    decoration("heart", pet, 3, lambda c: [(f"_{j}", [i]) for j, i in enumerate(hearts)])
    # question mark: its curve and its dot are two components, one sprite
    tilt = strips["tilt"]
    decoration("qmark", tilt, 2, lambda c: [("", list(c.deco_ids))])
    # z z: the whole glyph cluster the owner drew over the sleeping dog
    decoration("zz", strips["sleep"], 2, lambda c: [("_0", list(c.deco_ids))])
    # sweat: the owner's strips do not contain one, so the sheet has none.

    # --- animations ----------------------------------------------------------
    def anim(name: str, frame_names: list[str]) -> dict:
        ms, loop, hold = TIMING[name]
        a = {"frames": frame_names, "durationsMs": [ms] * len(frame_names), "loop": loop}
        if hold:
            a["hold"] = True
        return a

    idle_frames = [f"idle_{i}" for i in range(4)]
    animations: dict[str, dict] = {
        "idle": anim("idle", idle_frames),
        "idle_neutral": anim("idle_neutral", idle_frames),
        "idle_rare": anim("idle_rare", idle_frames),
        "ear_flop": anim("ear_flop", idle_frames),
        "blink": anim("blink", [f"blink_{i}" for i in range(2)]),
        "walk": anim("walk", [f"walk_{i}" for i in range(4)]),
        "tail_wag": anim("tail_wag", [f"tail_wag_{i}" for i in range(4)]),
        "bark": anim("bark", [f"bark_{i}" for i in range(4)]),
        "pet": anim("pet", [f"pet_{i}" for i in range(6)]),
        "hop": anim("hop", [f"hop_{i}" for i in range(5)]),
        "perk": anim("perk", [f"perk_{i}" for i in range(3)]),
        "tilt": anim("tilt", [f"tilt_{i}" for i in range(3)]),
        "sleep": anim("sleep", [f"sleep_{i}" for i in range(3)]),
        "wake": anim("wake", [f"wake_{i}" for i in range(4)]),
        "out": anim("out", [f"out_{i}" for i in range(2)]),
        "confused": anim("confused", ["tilt_2"]),
        "heart": anim("heart", [n for n in ("heart_0", "heart_1") if n in frames]),
        "qmark": anim("qmark", ["qmark"]),
        "zz": anim("zz", ["zz_0"]),
    }
    for mood, target in EXPRESSION_ANIMATION.items():
        name = f"idle_{mood}"
        if name not in animations and target == "idle":
            animations[name] = anim("idle", idle_frames)

    palettes = {}
    for coat, ramp in COAT_RAMPS.items():
        p = dict(zip(COAT, ramp.split()))
        p.update(SHARED)
        palettes[coat] = p

    sheet = {
        "boxes": boxes,
        "palettes": palettes,
        "frames": frames,
        "animations": animations,
        "expressions": {
            m: (f"idle_{m}" if EXPRESSION_ANIMATION[m] == "idle" and f"idle_{m}" in animations else EXPRESSION_ANIMATION[m])
            for m in EXPRESSION_ANIMATION
        },
    }

    write_refcells(strips, anchor_x)

    if report:
        print(f"box {BOX}x{BOX}   K (dog size measure, px) = {k:.2f}   anchor x = {anchor_x}")
        print(f"sleep box {sleep_w}x{sleep_h}   holes filled: {holes_total}")
        print(f"{'strip':10s} {'size(src)':>9s} {'ground':>7s} {'scale':>7s} {'shrink':>7s} "
              f"{'dogH(px)':>9s} {'contentH':>9s} {'contentW':>9s}")
        for a, s in strips.items():
            heights = [(c.dog_slice[0].stop - c.dog_slice[0].start) * s.scale for c in s.cells]
            print(f"{a:10s} {s.size:9.1f} {s.ground:7d} {s.scale:7.4f} {s.shrink:7.3f} "
                  f"{np.median(heights):9.1f} {s.up()*s.size*s.scale:9.1f} "
                  f"{s.width_ratio()*s.size*s.scale:9.1f}")
        h_ref = np.median([(c.dog_slice[0].stop - c.dog_slice[0].start) for c in ref.cells])
        print()
        print("height-vs-area normaliser agreement (standing strips, 1.000 = identical):")
        for a, s in strips.items():
            if a in ("out", "sleep"):
                continue
            h = np.median([(c.dog_slice[0].stop - c.dog_slice[0].start) for c in s.cells])
            print(f"   {a:10s} {(h / s.size) / (h_ref / ref.size):6.3f}")

    return sheet


def write_refcells(strips: dict[str, Strip], anchor_x: float) -> None:
    """Raw RGBA crops of three original cells, for render.mjs's comparison sheet.

    Written as headerless RGBA buffers plus a JSON index so that render.mjs needs
    no PNG decoder and stays on Node built-ins.
    """
    REFCELLS.mkdir(parents=True, exist_ok=True)
    index = []
    for anim, i in COMPARE_CELLS:
        strip = strips[anim]
        cell = strip.cells[i]
        # match the sprite's 2x height: the same scale, doubled
        s = strip.scale * 2
        w = max(1, round((cell.right - cell.left + 1) * s))
        h = max(1, round((cell.bottom - cell.top + 1) * s))
        img = cell_rgba(strip.rgb, cell)
        rgba = resample(img, (cell.left, cell.top, cell.right + 1, cell.bottom + 1), (w, h))
        name = f"{anim}_{i}.rgba"
        (REFCELLS / name).write_bytes(rgba.astype(np.uint8).tobytes())
        index.append({"animation": anim, "frame": f"{anim}_{i}", "file": name, "w": w, "h": h})
    (REFCELLS / "index.json").write_text(json.dumps(index, indent=2) + "\n")


def box_compare(sizes: list[int]) -> None:
    """Render idle_0 at several box sizes, side by side, 4x, for the face verdict."""
    global BOX
    named = name_sources()
    tiles = []
    keep = BOX
    for size in sizes:
        BOX = size
        strip = Strip("idle", named["idle"], 4)
        strips = {a: Strip(a, named[a], n) for a, _, n in SOURCES}
        driving = [s for a, s in strips.items() if a != "out"]
        k = min(min((size - 1) / s.up(), (size - 1) / s.width_ratio()) for s in driving)
        left_r = max(s.left_ratio() for s in driving)
        right_r = max(s.right_ratio() for s in driving)
        ax = round(size * left_r / (left_r + right_r)) + 0.5
        strip.scale = k / strip.size
        cell = strip.cells[0]
        sc = strip.scale
        y_top = strip.ground + 1 - size / sc
        x_left = cell.dog_cx - ax / sc
        rgba = resample(cell_rgba(strip.rgb, cell), (x_left, y_top, x_left + size / sc, y_top + size / sc), (size, size))
        rows, _ = to_rows(rgba)
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
    ap.add_argument("--box-compare", nargs="*", type=int, metavar="N",
                    help="also write art/out/box_compare_<sizes>.png and exit")
    args = ap.parse_args()

    if args.box_compare:
        box_compare(args.box_compare)
        return

    sheet = build(report=args.report)
    OUT_JSON.write_text(json.dumps(sheet, indent=1) + "\n")
    n_frames = len(sheet["frames"])
    print(f"wrote {OUT_JSON}  —  {n_frames} frames, "
          f"{len(sheet['animations'])} animations, {len(sheet['palettes'])} palettes, "
          f"boxes {', '.join(f'{k}={v[0]}x{v[1]}' for k, v in sheet['boxes'].items())}")


if __name__ == "__main__":
    main()

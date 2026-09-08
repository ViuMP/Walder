#!/usr/bin/env python3
"""
art/trace.py — turn the owner's reference renders into sprite rows.

    python3 art/trace.py            # trace every pose -> art/traced/
    python3 art/trace.py --measure  # print the scale measurements only
    python3 art/trace.py --only 13_hero_neutral_b

The owner's 21 renders in `design/references/poses/` ARE the artwork: they are
pixel art at roughly a 128x86 logical grid, upscaled ~9.87x to 1264x848 with a
flat light-grey background.  This script shrinks each one onto the sprite grid
instead of anybody redrawing it by hand, so the sprite is a faithfully reduced
version of the render rather than an interpretation of it.

Pipeline, per pose
------------------
 1. BACKGROUND       flood the flat grey in from the four corners with a
                     tolerance (`BG_TOL`).  Only grey that is *connected to the
                     border* is removed, so an interior grey stays opaque.
 2. DECORATIONS      keep the largest connected foreground blob.  The hearts,
                     the `?`, the `zZ`, the sweat bead and the petting hand are
                     all separate blobs in the renders, and they are separate
                     decoration frames in our sheet, so dropping them here is
                     exactly right.  (09_pet_with_hand is therefore unusable —
                     the hand touches the head — which is why 19 is the pet
                     reference.)
 3. SCALE            one scale factor for the whole standing family, so a frame
                     never changes size between animations.  The renders are
                     not all shot at the same distance, so the factor is
                     `STAND_SCALE * size_ratio`, where `size_ratio` comes from a
                     pose-invariant measurement of the dog: the diameter of the
                     dark eye blob (`--measure` prints them).  Where the eyes are
                     shut, squinted or crossed the ratio is set by hand in POSES.
 4. DOWNSAMPLE       Pillow BOX (area average) on premultiplied RGBA, so the
                     grey background can never bleed into the edge pixels.
 5. QUANTIZE         nearest of the 15 design-sheet colours in OKLab (a
                     perceptual space — nearest-in-sRGB flips the mid coat tones
                     against each other), alpha thresholded at 50 %, no dither.
 6. CLEANUP          despeckle (a pixel with no same-colour 8-neighbour becomes
                     the majority of its neighbours; `w`/`n`/`p` are exempt so a
                     1-px eye specular survives), then force a continuous 1-px
                     `q` outline onto the alpha edge.
 7. PLACE            into the frame's box on a fixed ground line: the lowest
                     opaque pixel lands on row `box_h - 1 - lift`, horizontally
                     centred.  Every grounded standing frame therefore shares
                     row 63 and Walder never slides when a frame changes.

Outputs (art/traced/)
    <frame>.rows.json      {"box","rows",...} — the letter rows frames.mjs imports
    <frame>@4x.png         a 4x preview of that frame
    _all@4x.png            every traced frame on one sheet, for reviewing
    _grid_<frame>@8x.png   8x with a coordinate grid, for reading off landmarks
    landmarks.json         measured feature positions in the traced base pose

Only Pillow + numpy + scipy are needed; nothing here runs in the app.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REF_DIR = os.path.join(ROOT, "design", "references", "poses")
OUT_DIR = os.path.join(HERE, "traced")

# --------------------------------------------------------------------------
# 1. the palette — the 15 colours printed on walder_design_sheet_chosen.png,
#    in the letter scheme art/README.md documents.  `r`, `s`, `b` are aliases
#    of p/k/w and are never produced by the tracer.
# --------------------------------------------------------------------------
PALETTE: dict[str, str] = {
    "a": "#FFF3D6",  # cream — chest bib, belly feathering, ear hem
    "h": "#FFE3A6",  # coat highlight
    "l": "#FFC67D",  # coat light
    "m": "#E3A454",  # coat mid — the dominant tone
    "t": "#C47A30",  # coat mid-shadow
    "d": "#A25F21",  # coat shadow
    "o": "#7A451A",  # deep shadow
    "q": "#5F3415",  # outline
    "k": "#3E2411",  # deep ink — mouth, lids, glyph outline
    "e": "#2D1A0D",  # eye
    "n": "#1F1208",  # nose
    "w": "#FFFFFF",  # eye specular
    "p": "#FF6188",  # tongue
    "z": "#4BA2E1",  # sleepy blue (zz / sweat)
    "y": "#9CD7FF",  # sleepy blue highlight
}
# Letters a despeckle pass must never delete: they are legitimately 1 px.
SPECKLE_EXEMPT = set("wnp")
# Letters that already read as an outline, so the outline pass leaves them.
OUTLINE_LETTERS = set("qk")
OUTLINE = "q"
# Letters the tracer is allowed to emit.  `z`/`y` are EXCLUDED on purpose: they
# only ever belong to the zz/sweat decorations, which are their own frames, and
# leaving them in the quantizer is actively harmful — a neutral grey (a scrap of
# background the flood fill could not reach) is nearer #9CD7FF than any coat
# tone in OKLab, so a stray grey pixel would come out as a blue speck.
QUANT_LETTERS = "ahlmtdoqkenwp"

BOXES = {"stand": (64, 64), "sleep": (40, 28)}

# --------------------------------------------------------------------------
# 2. geometry
# --------------------------------------------------------------------------
# The reference dog's bounding box is ~1.43x wider than it is tall (hero 13:
# 1061 x 742).  A 64-wide box therefore caps the height at ~44 px — asking for
# a 56 px tall dog would need 80 px of width and would mean either distorting
# the aspect ratio or cropping the tail off, both of which break "same dog as
# the reference".  So the standing family is fitted by WIDTH: the hero's bbox
# maps to STAND_HERO_W px, and the widest pose (bark, whose tail and open jaw
# reach furthest) is allowed to lose a pixel or two off the tail tip.
STAND_HERO_W = 60
EYE_R = 0.44   # redrawn eye radius, as a fraction of the render's eye diameter
FAR_EYE = 0.85  # the far eye of a 3/4 view is this much of the near eye
NOSE_RX, NOSE_RY = 0.36, 0.30  # redrawn nose semi-axes / the render's nose box
STAMP_NOSE = False  # see stamp_nose(): unreliable, the face is authored in frames.mjs
BG_TOL = 30  # per-channel tolerance for "this is the flat grey background"


def _find_eyes(rgb: np.ndarray, fg: np.ndarray):
    """Locate the open eyes in a reference render.

    Returns [(diameter, cx, cy), ...] in reference pixels, anchor (near) eye
    first, or None if this render has no open eye.

    Every open eye in these renders is a dark, roughly round blob carrying a
    pure-white specular, and NOTHING ELSE in the render is: the nose highlight is
    a brown, the cream feathering (#FFF3D6) is too yellow to pass the neutrality
    test, and the flat grey background — which does pass it — is excluded by
    only counting white INSIDE an eroded foreground.  That combination is what
    finally separated the eyes from the nose and from an open mouth; earlier
    versions grew a white dot on the bark pose's muzzle.

    The FAR eye's dark blob is usually fused with the brow stroke above it, so
    its bounding box is useless as a centre.  Its position instead comes from its
    specular plus the anchor eye's own specular-to-centre offset, which is the
    same in both eyes because they are the same drawing."""
    lum = rgb @ np.array([0.299, 0.587, 0.114])
    dark = (lum < 80) & fg
    inside = ndimage.binary_erosion(fg, iterations=3)
    white = (rgb.min(axis=2) > 200) & (np.ptp(rgb.astype(int), axis=2) < 35) & inside
    lab, _ = ndimage.label(dark)
    found = []
    for i, sl in enumerate(ndimage.find_objects(lab), 1):
        m = lab[sl] == i
        area = int(m.sum())
        if area < 700:
            continue
        bh = sl[0].stop - sl[0].start
        bw = sl[1].stop - sl[1].start
        fill, aspect = area / (bh * bw), bw / bh
        if fill < 0.45 or not (0.40 <= aspect <= 1.40):
            continue
        pad = tuple(slice(max(0, a.start - 6), a.stop + 6) for a in sl)
        full = np.zeros(rgb.shape[:2], bool)
        full[sl] = m
        ring = ndimage.binary_dilation(full[pad], iterations=4) & ~full[pad]
        spec = ring & white[pad]
        if spec.sum() < 60:
            continue
        sy, sx = np.where(spec)
        found.append(dict(
            diam=(bw + bh) / 2.0, fill=fill, aspect=aspect,
            cx=(sl[1].start + sl[1].stop - 1) / 2.0,
            cy=(sl[0].start + sl[0].stop - 1) / 2.0,
            sx=pad[1].start + sx.mean(), sy=pad[0].start + sy.mean(),
        ))
    if not found:
        return None
    # the anchor is the most eye-shaped blob (roundest, best filled, biggest);
    # its bbox centre IS the eye centre because nothing is fused with it
    anchor = max(found, key=lambda b: (b["fill"] * (1 - abs(1 - b["aspect"])), b["diam"]))
    dx, dy = anchor["cx"] - anchor["sx"], anchor["cy"] - anchor["sy"]
    eyes = [(anchor["diam"], anchor["cx"], anchor["cy"])]
    for b in found:
        if b is anchor:
            continue
        # a far eye is on the same eye line and a little behind the near one
        if abs(b["sy"] - anchor["sy"]) > 0.9 * anchor["diam"]:
            continue
        if not (anchor["sx"] - 2.4 * anchor["diam"] <= b["sx"] <= anchor["sx"] + 0.6 * anchor["diam"]):
            continue
        eyes.append((anchor["diam"] * FAR_EYE, b["sx"] + dx, b["sy"] + dy))
        break
    return eyes


def _find_nose(rgb: np.ndarray, fg: np.ndarray, eyes):
    """The nose: the big dark blob below and ahead of the eyes that carries NO
    white specular.  Returns (w, h, cx, cy) in reference pixels or None.

    Like the specular, a 4-5 px nose does not survive an area-average intact —
    it comes out as a 2 px smudge and the muzzle reads flat — so it is measured
    in the render and redrawn.  Needs the eye anchor to know where to look, so a
    pose with `eyes=False` keeps whatever the plain trace gave it."""
    if not eyes:
        return None
    d0, cx0, cy0 = eyes[0]
    lum = rgb @ np.array([0.299, 0.587, 0.114])
    dark = (lum < 80) & fg
    inside = ndimage.binary_erosion(fg, iterations=3)
    white = (rgb.min(axis=2) > 200) & (np.ptp(rgb.astype(int), axis=2) < 35) & inside
    lab, _ = ndimage.label(dark)
    best = None
    for i, sl in enumerate(ndimage.find_objects(lab), 1):
        m = lab[sl] == i
        area = int(m.sum())
        if area < 600:
            continue
        bh = sl[0].stop - sl[0].start
        bw = sl[1].stop - sl[1].start
        if area / (bh * bw) < 0.35 or not (0.45 <= bw / bh <= 1.9):
            continue
        cx = (sl[1].start + sl[1].stop - 1) / 2.0
        cy = (sl[0].start + sl[0].stop - 1) / 2.0
        if not (cy0 + 0.5 * d0 <= cy <= cy0 + 2.4 * d0):
            continue
        if not (cx0 - 3.2 * d0 <= cx <= cx0 + 0.2 * d0):
            continue
        pad = tuple(slice(max(0, a.start - 6), a.stop + 6) for a in sl)
        full = np.zeros(rgb.shape[:2], bool)
        full[sl] = m
        ring = ndimage.binary_dilation(full[pad], iterations=4) & ~full[pad]
        if int((ring & white[pad]).sum()) >= 60:
            continue                      # that is an eye, not the nose
        if best is None or area > best[0]:
            best = (area, bw, bh, cx, cy)
    return None if best is None else best[1:]


def stamp_nose(grid: np.ndarray, nose, s: float) -> np.ndarray:
    """Redraw the nose as a small solid ellipse of `n` at the measured place.

    OFF by default (`STAMP_NOSE`).  Unlike the eye, the nose has no unique
    signature in these renders: it fuses with the muzzle shadow and the mouth
    line, so the detector finds it in only 3 of the 16 standing poses and gets
    the box wrong in 2 of those.  The nose, mouth and brows are therefore
    hand-authored per expression in frames.mjs — which is where the sheet's
    conventions already put them — and this stays for the record."""
    if nose is None or not STAMP_NOSE:
        return grid
    bw, bh, cx, cy = nose
    ni = LETTERS.index("n")
    rx = max(1.0, bw * s * NOSE_RX)
    ry = max(1.0, bh * s * NOSE_RY)
    gx, gy = cx * s, cy * s
    bhh, bww = grid.shape
    for y in range(int(np.floor(gy - ry)), int(np.ceil(gy + ry)) + 1):
        for x in range(int(np.floor(gx - rx)), int(np.ceil(gx + rx)) + 1):
            if not (0 <= x < bww and 0 <= y < bhh) or grid[y, x] < 0:
                continue
            if ((x + 0.5 - gx) / rx) ** 2 + ((y + 0.5 - gy) / ry) ** 2 <= 1.0:
                grid[y, x] = ni
    return grid


def _measure_eye_diameter(rgb: np.ndarray, fg: np.ndarray) -> float | None:
    """The scale number: the ANCHOR eye's diameter, or None if the eyes are shut,
    half-lidded or crossed in this render and the measurement is meaningless."""
    eyes = _find_eyes(rgb, fg)
    return None if not eyes else float(eyes[0][0])


def sharpen_eyes(grid: np.ndarray, eyes, s: float, ox: int, oy: int) -> np.ndarray:
    """Redraw each eye as a clean disc with a 1-px white specular.

    This is the one feature the downsample cannot carry: the render's specular is
    a ~15 px white dot, which area-averages into the surrounding near-black and
    quantizes away, leaving a flat dark blob and a dead face.  The POSITION and
    the RADIUS both come from the render — the eye blobs are detected at full
    resolution and mapped through the same scale factor — so this sharpens the
    trace rather than inventing a face.  `eyes` is None for a pose whose eyes are
    shut, half-lidded or crossed; those are left exactly as traced."""
    if not eyes:
        return grid
    bh, bw = grid.shape
    ei, wi = LETTERS.index("e"), LETTERS.index("w")
    for diam, cx, cy in eyes:
        r = max(1.0, diam * s * EYE_R)
        gx, gy = cx * s + ox, cy * s + oy
        for y in range(int(np.floor(gy - r)), int(np.ceil(gy + r)) + 1):
            for x in range(int(np.floor(gx - r)), int(np.ceil(gx + r)) + 1):
                if not (0 <= x < bw and 0 <= y < bh) or grid[y, x] < 0:
                    continue
                # pixel centres, so an r=2 eye is a 4-px round blob not a square
                if (x + 0.5 - gx) ** 2 + (y + 0.5 - gy) ** 2 <= r * r:
                    grid[y, x] = ei
        # specular: up and toward the front (left), as in every reference face
        sx, sy = int(round(gx - r * 0.45)), int(round(gy - r * 0.45))
        if 0 <= sx < bw and 0 <= sy < bh and grid[sy, sx] == ei:
            grid[sy, sx] = wi
    return grid


# --------------------------------------------------------------------------
# 3. the pose table — reference render -> sprite frame
# --------------------------------------------------------------------------
# frame     the frame name frames.mjs imports
# src       the reference file
# box       "stand" (64x64) or "sleep" (40x28)
# size      pose-invariant size of the dog in the render, in reference pixels.
#           1.0 == the hero.  Measured with `--measure` (eye diameter / 81.5,
#           the hero 13 value); the hand-set ones are poses whose eyes are shut,
#           squinted, half-lidded or crossed, where the measurement is invalid
#           and the value comes from matching the head against the hero.
# lift      rows to raise the sprite off the ground line (hop_2 is airborne)
# fit       "width" (standing family, one shared scale) or "box" (the sleep box,
#           where the pose is its own thing and just has to fit)
POSES: list[dict] = [
    # ---- the standing family: ONE scale, ground line row 63 -------------
    dict(frame="idle_0",           src="12_hero_neutral_a.png", box="stand", size=0.963),
    dict(frame="idle_0_alt",       src="13_hero_neutral_b.png", box="stand", size=1.000),
    dict(frame="idle_happy_0",     src="17_happy.png",          box="stand", size=0.988),
    dict(frame="idle_worried_0",   src="05_worried_sweat.png",  box="stand", size=1.025),
    dict(frame="idle_exhausted_0", src="16_exhausted_tongue.png", box="stand", size=0.95, eyes=False),
    dict(frame="out_0",            src="15_out_flat_xeyes.png", box="stand", size=1.030, eyes=False),
    dict(frame="confused_0",       src="07_confused_qmark_a.png", box="stand", size=0.868),
    dict(frame="tilt_2",           src="14_tilt_qmark_b.png",   box="stand", size=0.872),
    dict(frame="bark_1",           src="02_bark.png",           box="stand", size=0.920),
    dict(frame="pet_2",            src="19_pet_hearts_no_hand.png", box="stand", size=0.950, eyes=False),
    dict(frame="perk_2",           src="08_perk_alert.png",     box="stand", size=0.896),
    dict(frame="walk_0",           src="03_walk_trot.png",      box="stand", size=0.957),
    dict(frame="hop_2",            src="11_hop_flying_ears_a.png", box="stand", size=0.850, lift=7),
    dict(frame="run_0",            src="20_run_flying_ears_b.png", box="stand", size=0.840, lift=5),
    dict(frame="run_1",            src="21_hop_flying_ears_c.png", box="stand", size=0.860, lift=5),
    dict(frame="run_2",            src="01_hop_run_a.png",      box="stand", size=0.850, lift=4),
    # ---- the small box: curled sleep and the two stretch/yawn poses -----
    dict(frame="sleep_0",          src="04_sleep_curled_zz.png", box="sleep", fit="box", eyes=False),
    dict(frame="wake_1",           src="06_stretch_yawn_a.png",  box="sleep", fit="box", eyes=False),
    dict(frame="wake_2",           src="18_stretch_yawn_b.png",  box="sleep", fit="box", eyes=False),
]

# The six face close-ups on 10_faces_six_closeups.png, left to right, top row
# then bottom row.  Traced as loose head crops; used only to repair a face the
# body trace muddled.
FACE_ORDER = ["happy", "neutral", "worried", "exhausted", "out", "confused"]


# --------------------------------------------------------------------------
# 4. colour
# --------------------------------------------------------------------------
def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    """rgb in 0..255, any leading shape -> OKLab (Bjorn Ottosson, 2020)."""
    c = np.asarray(rgb, dtype=np.float64) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    M1 = np.array([
        [0.4122214708, 0.5363325363, 0.0514459929],
        [0.2119034982, 0.6806995451, 0.1073969566],
        [0.0883024619, 0.2817188376, 0.6299787005],
    ])
    lms = lin @ M1.T
    lms = np.cbrt(np.maximum(lms, 0.0))
    M2 = np.array([
        [0.2104542553, 0.7936177850, -0.0040720468],
        [1.9779984951, -2.4285922050, 0.4505937099],
        [0.0259040371, 0.7827717662, -0.8086757660],
    ])
    return lms @ M2.T


LETTERS = list(QUANT_LETTERS)
PAL_RGB = np.array([hex_to_rgb(PALETTE[c]) for c in LETTERS], dtype=np.float64)
PAL_LAB = srgb_to_oklab(PAL_RGB)


def quantize(rgb: np.ndarray, alpha: np.ndarray, thresh: float = 0.5) -> np.ndarray:
    """rgb (h,w,3) 0..255 + alpha (h,w) 0..1 -> (h,w) int index, -1 = transparent.
    Nearest palette entry in OKLab, chroma weighted a little above lightness so
    the pink tongue and the blue sweat never collapse into a brown."""
    h, w, _ = rgb.shape
    lab = srgb_to_oklab(rgb.reshape(-1, 3))
    wgt = np.array([1.0, 1.35, 1.35])
    d = ((lab[:, None, :] - PAL_LAB[None, :, :]) * wgt) ** 2
    idx = d.sum(axis=2).argmin(axis=1).reshape(h, w)
    return np.where(alpha >= thresh, idx, -1)


# --------------------------------------------------------------------------
# 5. background, decorations, downsampling
# --------------------------------------------------------------------------
def foreground_mask(rgb: np.ndarray, tol: int = BG_TOL) -> np.ndarray:
    """True where the pixel is the dog (or a decoration), False on the background.

    Background is grey that is either connected to the border or forms a pocket
    of at least `POCKET` pixels enclosed by the dog (the gap between an ear and a
    foreleg, say — visually background, and if it is left opaque it downsamples
    to a grey blob).  A grey speck smaller than that is kept, so a stray
    anti-aliased pixel inside the coat never punches a hole.

    The blue of the sweat bead and the `zZ` is ALSO treated as background: those
    are separate decoration frames in our sheet, and in 05_worried_sweat the bead
    touches the ear, so the largest-blob filter alone would not drop it."""
    h, w, _ = rgb.shape
    corners = np.array([rgb[0, 0], rgb[0, w - 1], rgb[h - 1, 0], rgb[h - 1, w - 1]], float)
    ref = corners.mean(axis=0)
    bgish = (np.abs(rgb.astype(float) - ref).max(axis=2) <= tol)
    lab, n = ndimage.label(bgish)
    border = set(lab[0, :]) | set(lab[-1, :]) | set(lab[:, 0]) | set(lab[:, -1])
    border.discard(0)
    sizes = ndimage.sum(bgish, lab, range(1, n + 1)) if n else np.array([])
    POCKET = 40
    keep = [i for i in range(1, n + 1) if i in border or sizes[i - 1] >= POCKET]
    bg = np.isin(lab, keep) if keep else np.zeros_like(bgish)
    # blue decorations (sweat bead, zZ): b* well negative and clearly chromatic
    ok = srgb_to_oklab(rgb.reshape(-1, 3)).reshape(h, w, 3)
    blue = (ok[:, :, 2] < -0.03) & (np.hypot(ok[:, :, 1], ok[:, :, 2]) > 0.035)
    blue = ndimage.binary_dilation(blue, iterations=2)
    return ~(bg | blue)


def largest_blob(fg: np.ndarray) -> np.ndarray:
    """Keep the biggest connected foreground component — this is what strips the
    references' own decorations (hearts, `?`, `zZ`, sweat bead)."""
    lab, n = ndimage.label(fg)
    if n <= 1:
        return fg
    sizes = ndimage.sum(fg, lab, range(1, n + 1))
    keep = int(np.argmax(sizes)) + 1
    return lab == keep


def downsample(rgb: np.ndarray, fg: np.ndarray, tw: int, th: int):
    """Area-average to (tw, th) with PREMULTIPLIED alpha, so the grey background
    can never bleed into the silhouette's edge pixels."""
    a = fg.astype(np.float64)
    pm = rgb.astype(np.float64) * a[:, :, None]
    small_pm = np.stack([
        np.array(Image.fromarray(pm[:, :, c]).resize((tw, th), Image.BOX))
        for c in range(3)
    ], axis=2)
    small_a = np.array(Image.fromarray(a).resize((tw, th), Image.BOX))
    with np.errstate(divide="ignore", invalid="ignore"):
        out = np.where(small_a[:, :, None] > 1e-6, small_pm / np.maximum(small_a, 1e-6)[:, :, None], 0.0)
    return np.clip(out, 0, 255), np.clip(small_a, 0, 1)


# --------------------------------------------------------------------------
# 6. cleanup on the quantized grid
# --------------------------------------------------------------------------
N8 = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]


def despeckle(idx: np.ndarray, passes: int = 2) -> np.ndarray:
    """A pixel with no 8-neighbour of its own colour becomes the majority colour
    of its opaque neighbours.  Letters in SPECKLE_EXEMPT keep their single pixel:
    the eye specular and the nose tip are legitimately one pixel wide."""
    h, w = idx.shape
    exempt = {LETTERS.index(c) for c in SPECKLE_EXEMPT if c in LETTERS}
    for _ in range(passes):
        out = idx.copy()
        for y in range(h):
            for x in range(w):
                v = idx[y, x]
                if v < 0 or v in exempt:
                    continue
                same = 0
                votes = Counter()
                for dx, dy in N8:
                    nx, ny = x + dx, y + dy
                    if not (0 <= nx < w and 0 <= ny < h):
                        continue
                    u = idx[ny, nx]
                    if u < 0:
                        continue
                    if u == v:
                        same += 1
                    votes[u] += 1
                if same == 0 and votes:
                    out[y, x] = votes.most_common(1)[0][0]
        idx = out
    return idx


def enforce_outline(idx: np.ndarray) -> np.ndarray:
    """Every opaque pixel on the alpha edge becomes the 1-px outline, unless it
    already is one.  The renders draw that outline themselves, so this only
    repairs the places the downsample lightened it away."""
    h, w = idx.shape
    oi = LETTERS.index(OUTLINE)
    keep = {LETTERS.index(c) for c in OUTLINE_LETTERS}
    out = idx.copy()
    for y in range(h):
        for x in range(w):
            if idx[y, x] < 0 or idx[y, x] in keep:
                continue
            edge = False
            for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                nx, ny = x + dx, y + dy
                if not (0 <= nx < w and 0 <= ny < h) or idx[ny, nx] < 0:
                    edge = True
                    break
            if edge:
                out[y, x] = oi
    return out


def fill_pinholes(idx: np.ndarray) -> np.ndarray:
    """A single transparent pixel completely surrounded by opaque ones is a
    downsampling artefact, not a hole in the dog."""
    h, w = idx.shape
    out = idx.copy()
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            if idx[y, x] >= 0:
                continue
            nb = [idx[y + dy, x + dx] for dx, dy in N8]
            if all(v >= 0 for v in nb):
                out[y, x] = Counter(nb).most_common(1)[0][0]
    return out


# --------------------------------------------------------------------------
# 7. rows / preview
# --------------------------------------------------------------------------
def to_rows(idx: np.ndarray) -> list[str]:
    return ["".join("." if v < 0 else LETTERS[v] for v in row) for row in idx]


def rows_to_image(rows: list[str], scale: int, bg=None) -> Image.Image:
    h, w = len(rows), max(len(r) for r in rows)
    im = Image.new("RGBA", (w * scale, h * scale), bg or (0, 0, 0, 0))
    px = im.load()
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch in (".", " "):
                continue
            r, g, b = hex_to_rgb(PALETTE[ch])
            for sy in range(scale):
                for sx in range(scale):
                    px[x * scale + sx, y * scale + sy] = (r, g, b, 255)
    return im


def grid_image(rows: list[str], scale: int = 8) -> Image.Image:
    """The frame at `scale`, with a 1-px rule every pixel and a heavier one every
    5 and 10, so landmark coordinates can be read straight off the preview."""
    from PIL import ImageDraw

    h, w = len(rows), max(len(r) for r in rows)
    base = rows_to_image(rows, scale, bg=(92, 92, 102, 255))
    im = Image.new("RGBA", (base.width + 24, base.height + 24), (28, 28, 32, 255))
    im.paste(base, (24, 24))
    d = ImageDraw.Draw(im)
    for x in range(w + 1):
        c = (255, 255, 255, 70) if x % 10 else (255, 90, 90, 200)
        if x % 5 == 0 and x % 10:
            c = (255, 255, 255, 130)
        d.line([(24 + x * scale, 24), (24 + x * scale, 24 + base.height)], fill=c)
        if x % 10 == 0:
            d.text((24 + x * scale + 1, 8), str(x), fill=(255, 200, 200, 255))
    for y in range(h + 1):
        c = (255, 255, 255, 70) if y % 10 else (255, 90, 90, 200)
        if y % 5 == 0 and y % 10:
            c = (255, 255, 255, 130)
        d.line([(24, 24 + y * scale), (24 + base.width, 24 + y * scale)], fill=c)
        if y % 10 == 0:
            d.text((2, 24 + y * scale + 1), str(y), fill=(255, 200, 200, 255))
    return im


# --------------------------------------------------------------------------
# 8. the tracer
# --------------------------------------------------------------------------
def trace_pose(pose: dict, stand_scale: float, verbose=True) -> dict:
    path = os.path.join(REF_DIR, pose["src"])
    rgb = np.array(Image.open(path).convert("RGB"))
    fg = largest_blob(foreground_mask(rgb))
    ys, xs = np.where(fg)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    crop_rgb = rgb[y0:y1 + 1, x0:x1 + 1]
    crop_fg = fg[y0:y1 + 1, x0:x1 + 1]
    rh, rw = crop_fg.shape

    bw, bh = BOXES[pose["box"]]
    if pose.get("fit") == "box":
        s = min(bw / rw, bh / rh)
    else:
        s = stand_scale / pose.get("size", 1.0)
    tw, th = max(1, round(rw * s)), max(1, round(rh * s))

    small_rgb, small_a = downsample(crop_rgb, crop_fg, tw, th)
    idx = quantize(small_rgb, small_a)
    idx = fill_pinholes(idx)
    idx = despeckle(idx, passes=2)
    idx = enforce_outline(idx)
    eyes = _find_eyes(crop_rgb, crop_fg) if pose.get("eyes", True) else None
    idx = stamp_nose(idx, _find_nose(crop_rgb, crop_fg, eyes), s)
    idx = sharpen_eyes(idx, eyes, s, 0, 0)

    # place: lowest opaque pixel on row (bh-1-lift), centred horizontally
    grid = np.full((bh, bw), -1, dtype=int)
    lift = pose.get("lift", 0)
    # `align`: a pose wider than the box loses pixels, and it must never be the
    # muzzle.  The head is at the LEFT in every reference, so a wide pose is
    # left-aligned and gives up the tail tip instead.
    if pose.get("align", "center") == "left" or tw > bw:
        ox = 0
    else:
        ox = round((bw - tw) / 2)
    ox += pose.get("dx", 0)
    oy = bh - lift - th
    clipped = 0
    for y in range(th):
        gy = oy + y
        if not (0 <= gy < bh):
            clipped += int((idx[y] >= 0).sum())
            continue
        for x in range(tw):
            gx = ox + x
            if not (0 <= gx < bw):
                if idx[y, x] >= 0:
                    clipped += 1
                continue
            if idx[y, x] >= 0:
                grid[gy, gx] = idx[y, x]
    # a clip can leave a raw light edge where the outline was cut away
    if clipped:
        grid = enforce_outline(grid)

    rows = to_rows(grid)
    if verbose:
        print(f"  {pose['frame']:<18} {pose['src']:<28} ref {rw}x{rh} "
              f"-> {tw}x{th} @ {s:.5f}  box {bw}x{bh}  clipped {clipped}")
    return dict(frame=pose["frame"], box=pose["box"], rows=rows,
                ref=pose["src"], ref_size=[rw, rh], sprite_size=[tw, th],
                scale=round(s, 6), lift=lift, clipped=clipped,
                airborne=bool(lift) or None)


def trace_faces(stand_scale: float, verbose=True) -> list[dict]:
    """The six close-ups on 10_faces_six_closeups.png, as loose head crops at
    the standing family's scale.  Only used to repair a muddled face."""
    path = os.path.join(REF_DIR, "10_faces_six_closeups.png")
    rgb = np.array(Image.open(path).convert("RGB"))
    fg = foreground_mask(rgb)
    lab, n = ndimage.label(fg)
    sizes = ndimage.sum(fg, lab, range(1, n + 1))
    # the six heads are the six biggest blobs; the `?` is a small extra
    order = np.argsort(sizes)[::-1][:6] + 1
    boxes = []
    for i in order:
        sl = ndimage.find_objects(lab == i)[0]
        boxes.append((sl[1].start, sl[0].start, sl[1].stop, sl[0].stop, int(i)))
    boxes.sort(key=lambda b: (b[1] // 300, b[0]))  # top row then bottom row
    out = []
    for name, (bx0, by0, bx1, by1, i) in zip(FACE_ORDER, boxes):
        m = (lab == i)[by0:by1, bx0:bx1]
        c = rgb[by0:by1, bx0:bx1]
        # the close-ups are drawn ~2.1x the body poses' head; match the hero head
        s = stand_scale / 2.13
        tw, th = max(1, round(m.shape[1] * s)), max(1, round(m.shape[0] * s))
        sr, sa = downsample(c, m, tw, th)
        idx = quantize(sr, sa)
        idx = fill_pinholes(idx)
        idx = despeckle(idx, passes=2)
        rows = to_rows(idx)
        if verbose:
            print(f"  face:{name:<12} {m.shape[1]}x{m.shape[0]} -> {tw}x{th}")
        out.append(dict(frame=f"face_{name}", box="face", rows=rows))
    return out


# --------------------------------------------------------------------------
# 9. landmarks in the traced base pose
# --------------------------------------------------------------------------
def landmarks(rows: list[str]) -> dict:
    """Measure the base pose so frames.mjs's derivations (ear swing, tail swing,
    leg alternation, face patches) can be anchored to real coordinates instead
    of the hand-authored pose's old ones."""
    g = np.array([list(r) for r in rows])
    h, w = g.shape
    ink = g != "."
    ys, xs = np.where(ink)
    out = {
        "box": [int(w), int(h)],
        "bbox": [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
        "ground_row": int(ys.max()),
    }
    for letter, key in (("e", "eye"), ("n", "nose"), ("w", "specular"), ("k", "ink")):
        m = g == letter
        if m.any():
            yy, xx = np.where(m)
            out[key] = {"bbox": [int(xx.min()), int(yy.min()), int(xx.max()), int(yy.max())],
                        "count": int(m.sum())}
    # eye blobs, left to right
    m = (g == "e") | (g == "w")
    if m.any():
        lab, n = ndimage.label(m)
        blobs = []
        for i, sl in enumerate(ndimage.find_objects(lab), 1):
            blobs.append([int(sl[1].start), int(sl[0].start),
                          int(sl[1].stop - 1), int(sl[0].stop - 1),
                          int((lab[sl] == i).sum())])
        blobs.sort(key=lambda b: b[0])
        out["eye_blobs"] = blobs
    # per-column topmost/bottommost ink — the topline and the underline
    top, bot = [], []
    for x in range(w):
        col = np.where(ink[:, x])[0]
        top.append(int(col.min()) if col.size else -1)
        bot.append(int(col.max()) if col.size else -1)
    out["col_top"] = top
    out["col_bottom"] = bot
    # ground contacts: runs of columns whose lowest ink is within 1 px of the
    # ground line — the paws, which is what the walk cycle has to move
    gr = out["ground_row"]
    runs, cur = [], None
    for x in range(w):
        onground = bot[x] >= gr - 1
        if onground and cur is None:
            cur = x
        elif not onground and cur is not None:
            runs.append([cur, x - 1])
            cur = None
    if cur is not None:
        runs.append([cur, w - 1])
    out["paw_runs"] = runs
    return out


# --------------------------------------------------------------------------
# 10. main
# --------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--measure", action="store_true",
                    help="print the pose-invariant size measurements and exit")
    ap.add_argument("--only", default=None, help="trace one frame name only")
    ap.add_argument("--no-faces", action="store_true")
    args = ap.parse_args()

    if args.measure:
        print("pose-invariant size measurement (dark eye-blob diameter):")
        hero = None
        vals = {}
        for f in sorted(os.listdir(REF_DIR)):
            if not f.endswith(".png"):
                continue
            rgb = np.array(Image.open(os.path.join(REF_DIR, f)).convert("RGB"))
            fg = largest_blob(foreground_mask(rgb))
            d = _measure_eye_diameter(rgb, fg)
            vals[f] = d
            if f.startswith("13_"):
                hero = d
        for f, d in vals.items():
            if d is None:
                print(f"  {f:<30} (no clean eye blob — set `size` by hand)")
            else:
                print(f"  {f:<30} eye {d:6.1f} px   size {d / hero:.3f}")
        return 0

    os.makedirs(OUT_DIR, exist_ok=True)
    # the shared standing scale, from the hero
    hero = next(p for p in POSES if p["frame"] == "idle_0")
    rgb = np.array(Image.open(os.path.join(REF_DIR, hero["src"])).convert("RGB"))
    fg = largest_blob(foreground_mask(rgb))
    ys, xs = np.where(fg)
    hero_w = xs.max() - xs.min() + 1
    stand_scale = STAND_HERO_W / hero_w
    print(f"hero {hero['src']}: bbox width {hero_w} -> {STAND_HERO_W} px "
          f"(STAND_SCALE {stand_scale:.6f})")

    todo = [p for p in POSES if not args.only or p["frame"] == args.only]
    traced = [trace_pose(p, stand_scale) for p in todo]
    if not args.only and not args.no_faces:
        traced += trace_faces(stand_scale)

    for t in traced:
        rec = {k: v for k, v in t.items() if v is not None}
        with open(os.path.join(OUT_DIR, f"{t['frame']}.rows.json"), "w") as fh:
            json.dump(rec, fh, indent=1)
        rows_to_image(t["rows"], 4).save(os.path.join(OUT_DIR, f"{t['frame']}@4x.png"))

    base = next((t for t in traced if t["frame"] == "idle_0"), None)
    if base:
        with open(os.path.join(OUT_DIR, "landmarks.json"), "w") as fh:
            json.dump(landmarks(base["rows"]), fh, indent=1)
        for t in traced:
            if t["frame"] in ("idle_0", "idle_0_alt", "sleep_0", "out_0"):
                grid_image(t["rows"], 8).save(
                    os.path.join(OUT_DIR, f"_grid_{t['frame']}@8x.png"))

    # one review sheet
    pad, cols = 8, 5
    tiles = [(t["frame"], rows_to_image(t["rows"], 4, bg=(92, 92, 102, 255))) for t in traced]
    cw = max(im.width for _, im in tiles) + pad
    ch = max(im.height for _, im in tiles) + pad + 12
    rows_n = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cw + pad, rows_n * ch + pad), (28, 28, 32, 255))
    from PIL import ImageDraw
    d = ImageDraw.Draw(sheet)
    for i, (name, im) in enumerate(tiles):
        x = pad + (i % cols) * cw
        y = pad + (i // cols) * ch
        d.text((x, y), name, fill=(230, 230, 230, 255))
        sheet.paste(im, (x, y + 12), im)
    sheet.save(os.path.join(OUT_DIR, "_all@4x.png"))
    print(f"traced {len(traced)} frames -> art/traced/")
    return 0


if __name__ == "__main__":
    sys.exit(main())

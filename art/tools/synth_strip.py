#!/usr/bin/env python3
"""
art/tools/synth_strip.py — run ``art/strips.py``'s v4 path without any v4 art.

    python3 art/tools/synth_strip.py            # both checks
    python3 art/tools/synth_strip.py --keep     # ... and leave the tree on disk
    python3 art/tools/synth_strip.py --only after|sets|background

WHY THIS EXISTS
---------------
``art/strips.py`` has two halves that cannot both be exercised by the art in the
repo. The half that runs today reads the 0.1.2 Firefly exports and reproduces the
0.1.2 sheet. The half that matters — the six-frame idle strip becoming three
animations, the mood strips carrying their own blink, the glyph-less ``tilt`` and
``sleep`` earning ``decorAnchors``, the sleep box keeping its headroom, the second
coat becoming a ``frameSets`` entry — needs twenty strips the owner is still
generating, one at a time, over days.

Waiting for the art means the first run of that code is on the owner's machine
with the owner watching, which is the worst place to find out that a frame table
is off by one. So this script *fabricates* strips: it lifts the dog out of a
legacy illustration, stamps him N times onto a flat canvas, writes that into a
throwaway ``v4/`` tree, points ``strips.py`` at it, and asserts the sheet that
comes out.

WHAT IT DOES NOT CLAIM
----------------------
Nothing here checks that the art is *good*. The dogs are copies of one legacy
cell with a few pixels recoloured, so every frame of a synthetic "breathe" is the
same pose. That is deliberate: it makes the geometry exactly equal frame to frame
and set to set, which is what lets the assertions be about the tables, the boxes
and the anchors rather than about tolerances. Whether the blink reads as a blink
is a question for ``npm run sprites`` and the owner's eye, and no test can answer
it.

The synthetic PNGs never go near ``design/references/strips/v4/`` — that folder is
the owner's drop box, and a fake dog in it would be indistinguishable from a real
one. Everything lands under ``art/out/synthetic/``, which is generated and
gitignored along with the rest of ``art/out/``.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import shutil
import sys
import textwrap
from contextlib import redirect_stdout
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = Path(__file__).resolve().parent
ART = HERE.parent
ROOT = ART.parent
sys.path.insert(0, str(ART))

import strips as S  # noqa: E402  (the module under test; the path is set above)

#: Everything this script writes. Under `art/out/`, which is generated.
WORK = ART / "out" / "synthetic"

#: The two flat grounds the prompts specify (`docs/PROMPTS_V4.md`): light grey
#: for the golden set, green for the dapple set, so a silver coat can never be
#: confused with the floor.
BG_GOLDEN = "#C8C8C8"
BG_DAPPLE = "#3FA34D"

#: Clear of the border by more than the flood fill's ring, and clear of each
#: other, so the slicer sees N separate components and no dog touches the edge.
MARGIN_PX = 60
GAP_PX = 40

#: The six strips the owner is regenerating, and where a stand-in dog for each
#: comes from: `(legacy strip, cell index, frame count)`.
#:
#: `tilt` and `sleep` take a cell the owner drew WITHOUT a glyph (cell 0), which
#: is the whole point of those two strips being regenerated — the synthetic
#: version has to be glyph-less or the anchors would not be emitted and this
#: script would be testing the fallback it is trying to get past.
REGENERATED: dict[str, tuple[str, int, int]] = {
    "idle": ("idle", 0, 6),
    "idle_happy": ("idle", 0, 5),
    "idle_worried": ("idle", 0, 5),
    "idle_exhausted": ("idle", 0, 5),
    "tilt": ("tilt", 0, 3),
    "sleep": ("sleep", 0, 3),
}

#: The eight strips nobody is redrawing in golden but which the dapple set needs
#: a copy of. Taken cell for cell from the legacy strip, decorations included, so
#: the two sets are the same drawing and the cross-set size check has something
#: meaningful to compare.
CARRIED: tuple[str, ...] = ("out", "perk", "bark", "walk", "wake", "tail_wag", "hop", "pet")

#: How far above the dog a *detached* test glyph is dropped, in source pixels.
#:
#: Comfortably more than the background detector's two constrained dilations, so
#: the gap is still a gap after the fringe is eaten and the slicer really does
#: see two components. The point of that case is the OLD check (a stray
#: component), and a test that accidentally welded the glyph would silently
#: become a second copy of the new one.
DETACHED_GLYPH_GAP_PX = 24

# --------------------------------------------------------------------------- #
# What the app says, read from the app                                         #
# --------------------------------------------------------------------------- #
#
# Two small parsers rather than two copies. Both tables below used to be typed
# out here as Python literals, which meant the generator agreed with the app
# right up until somebody changed the app — and then went on passing.

def _ts_source(*parts: str) -> str:
    path = ROOT.joinpath(*parts)
    if not path.exists():
        raise SystemExit(f"{path} is missing — this script reads the app's own tables from it")
    return path.read_text(encoding="utf-8")


def app_decor_by_frame() -> dict[str, list[str]]:
    """``APP_DECOR_BY_FRAME`` out of ``src/sprites/contract.ts``.

    The app's own statement of which glyphs it draws on which frame, and the
    table ``mirrorReady`` walks. Parsed, not copied: a hard-coded
    ``{"tilt_2": ["qmark"], "sleep_2": ["zz"]}`` here would keep asserting the
    2026-09 arrangement long after the app had moved on, and the failure mode of
    that — the mirror silently staying off, or coming on with an unanchored
    glyph — is precisely what these checks exist to catch.
    """
    source = _ts_source("src", "sprites", "contract.ts")
    body = re.search(r"APP_DECOR_BY_FRAME[^=]*=\s*\{(.*?)\n\};", source, re.S)
    if body is None:
        raise SystemExit(
            "could not find APP_DECOR_BY_FRAME in src/sprites/contract.ts — if it was "
            "renamed or reshaped, teach this parser about it rather than hard-coding the "
            "table here again"
        )
    table = {
        frame: re.findall(r"'([^']+)'", decors)
        for frame, decors in re.findall(r"(\w+)\s*:\s*\[([^\]]*)\]", body.group(1))
    }
    if not table:
        raise SystemExit("APP_DECOR_BY_FRAME parsed as empty — the parser needs updating")
    return table


def app_expressions() -> list[str]:
    """The ``Expression`` union out of ``src/core/expression.ts``.

    Every one of these has to be a key of the sheet's ``expressions`` map: the
    renderer looks the running expression up there by name, and a missing key is
    a dog with no animation to play.
    """
    source = _ts_source("src", "core", "expression.ts")
    union = re.search(r"export type Expression\s*=([^;]+);", source)
    if union is None:
        raise SystemExit("could not find the Expression union in src/core/expression.ts")
    names = re.findall(r"'([^']+)'", union.group(1))
    if not names:
        raise SystemExit("the Expression union parsed as empty — the parser needs updating")
    return names


# --------------------------------------------------------------------------- #
# Fabricating a strip                                                          #
# --------------------------------------------------------------------------- #

def legacy_strip(name: str) -> S.Strip:
    """One of the 0.1.2 illustrations, sliced by the real pipeline."""
    key, count = S.LEGACY_SOURCES[name]
    path = S.find_in(S.STRIPS, key)
    if path is None:
        raise SystemExit(f"the legacy {name} strip ({key}) is not in {S.STRIPS}")
    return S.Strip(name, path, count, "legacy")


def cell_crop(strip: S.Strip, index: int, dog_only: bool) -> np.ndarray:
    """A cell as a tight RGBA crop: the dog, and optionally what was drawn with him."""
    cell = strip.cells[index]
    ids = [cell.dog_id] if dog_only else None
    rgba = np.array(S.cell_rgba(strip.rgb, cell, ids))
    mask = rgba[..., 3] > 0
    ys, xs = np.nonzero(mask)
    return rgba[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def edited(crop: np.ndarray, frame: int) -> np.ndarray:
    """The same dog with a few pixels recoloured — never a pixel of alpha.

    Enough that the frames are not byte-identical (so a pipeline that silently
    emitted one frame N times would be caught), and not enough to move the
    silhouette by a pixel (so every geometric assertion below is exact).
    """
    out = crop.copy()
    if frame == 0:
        return out
    h, w = out.shape[:2]
    y = min(h - 4, 4 + frame * 3)
    x = w // 2
    patch = out[y:y + 3, x:x + 3]
    opaque = patch[..., 3] > 0
    patch[..., :3] = np.where(opaque[..., None], (patch[..., :3] // 2), patch[..., :3])
    return out


def compose(crops: list[np.ndarray], bg_hex: str, path: Path) -> None:
    """Stamp the crops left to right onto one flat canvas, all feet on one line."""
    heights = [c.shape[0] for c in crops]
    widths = [c.shape[1] for c in crops]
    width = MARGIN_PX * 2 + sum(widths) + GAP_PX * (len(crops) - 1)
    height = MARGIN_PX * 2 + max(heights)
    canvas = np.zeros((height, width, 3), np.uint8)
    canvas[:] = S.hex_to_rgb(bg_hex)

    x = MARGIN_PX
    for crop in crops:
        h, w = crop.shape[:2]
        # bottom-aligned: one ground line for the whole strip, as the prompts ask
        y = height - MARGIN_PX - h
        region = canvas[y:y + h, x:x + w]
        opaque = crop[..., 3] > 0
        region[...] = np.where(opaque[..., None], crop[..., :3], region)
        x += w + GAP_PX

    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(canvas, "RGB").save(path)


def glyph_pieces(name: str, index: int) -> list[np.ndarray]:
    """The glyph the owner drew on one legacy cell, one tight crop per component.

    A `?` is two components — the curve and its dot — and that matters here:
    welding "the glyph" as a single block would leave the dot floating, the
    stray-component check would fire, and the test would be exercising the OLD
    gate while claiming to exercise the new one. So the pieces come out
    separately and each is welded on its own.
    """
    strip = legacy_strip(name)
    cell = strip.cells[index]
    if not cell.deco_ids:
        raise SystemExit(f"the legacy {name} strip has no glyph on cell {index} to borrow")
    out = []
    for deco_id in sorted(cell.deco_ids, key=lambda i: -int((cell.labels == i).sum())):
        rgba = np.array(S.cell_rgba(strip.rgb, cell, [deco_id]))
        ys, xs = np.nonzero(rgba[..., 3] > 0)
        out.append(rgba[ys.min():ys.max() + 1, xs.min():xs.max() + 1])
    return out


def _paste(canvas: np.ndarray, piece: np.ndarray, top: int, left: int) -> None:
    """Alpha-paste `piece` into `canvas`, clipped to it."""
    h, w = piece.shape[:2]
    top = max(0, min(top, canvas.shape[0] - h))
    left = max(0, min(left, canvas.shape[1] - w))
    region = canvas[top:top + h, left:left + w]
    opaque = piece[..., 3] > 0
    region[...] = np.where(opaque[..., None], piece, region)


def with_glyph(dog: np.ndarray, pieces: list[np.ndarray], touching: bool) -> np.ndarray:
    """The dog with a glyph over his head — welded to him, or floating clear.

    ``touching=True`` is the case the size heuristic exists for and the reason
    it had to exist: each piece is dropped so its lowest ink pixel sits one row
    above the dog's own ink in that column, which makes dog and glyph a single
    connected component. The slicer then reports no decoration at all, the strip
    sails past ``EXPECTED_DECOR``, and — because it is v4 art — the anchors are
    emitted and the app draws a second `?` beside the baked one.

    ``touching=False`` is the case that was already caught: a clear gap, two
    components, ``EXPECTED_DECOR`` fails the build.

    The welded result is asserted to be one component before it is used
    (``check_glyph``); a "glued" fixture that quietly came apart would test the
    wrong gate and pass.
    """
    tallest = max(p.shape[0] for p in pieces)
    widest = max(p.shape[1] for p in pieces)
    pad_top = tallest + DETACHED_GLYPH_GAP_PX + 4
    pad_x = widest
    h, w = dog.shape[:2]
    out = np.zeros((h + pad_top, w + pad_x * 2, 4), np.uint8)
    out[pad_top:, pad_x:pad_x + w] = dog

    ink = out[..., 3] > 0
    columns = np.nonzero(ink.any(0))[0]
    centre = int((columns[0] + columns[-1]) / 2)
    span = sum(p.shape[1] for p in pieces) + 4 * (len(pieces) - 1)
    x = centre - span // 2
    for piece in pieces:
        ph, pw = piece.shape[:2]
        # A column the dog actually occupies, so "one row above his ink" means
        # something; the anchor column walks inwards until it finds one.
        column = min(max(x + pw // 2, int(columns[0])), int(columns[-1]))
        while not ink[:, column].any():
            column += 1 if column < centre else -1
        top_of_dog = int(np.nonzero(ink[:, column])[0][0])
        rows = np.nonzero(piece[..., 3] > 0)[0]
        bottom_of_piece = int(rows.max())
        if touching:
            top = top_of_dog - 1 - bottom_of_piece
        else:
            top = top_of_dog - DETACHED_GLYPH_GAP_PX - ph
        _paste(out, piece, top, x)
        x += pw + 4

    ys, xs = np.nonzero(out[..., 3] > 0)
    return out[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def components(crop: np.ndarray) -> int:
    """How many connected components of ink the crop holds — 8-connectivity, as the slicer counts."""
    _, count = ndimage.label(crop[..., 3] > 0, structure=np.ones((3, 3), int))
    return int(count)


def write_strip_with_glyph(directory: Path, strip: str, source_cell: int, touching: bool) -> tuple[Path, int]:
    """Overwrite one fabricated strip so its LAST frame carries the legacy glyph.

    Returns the path and the component count of the doctored frame, so the
    caller can assert the fixture really is what it claims to be.
    """
    legacy = legacy_strip(strip)
    dog = cell_crop(legacy, 0, dog_only=True)
    count = S.STRIP_FRAMES[strip]
    frames = [edited(dog, i) for i in range(count)]
    doctored = with_glyph(frames[-1], glyph_pieces(strip, source_cell), touching)
    frames[-1] = doctored
    path = directory / f"{strip}.png"
    compose(frames, BG_GOLDEN, path)
    return path, components(doctored)


def write_set(directory: Path, bg_hex: str, strips_wanted: dict[str, tuple[str, int, int]],
              carried: tuple[str, ...]) -> None:
    """Fabricate one coat set's strips into ``directory``."""
    directory.mkdir(parents=True, exist_ok=True)
    for name, (source, index, count) in strips_wanted.items():
        crop = cell_crop(legacy_strip(source), index, dog_only=True)
        compose([edited(crop, i) for i in range(count)], bg_hex, directory / f"{name}.png")
    for name in carried:
        strip = legacy_strip(name)
        crops = [cell_crop(strip, i, dog_only=False) for i in range(len(strip.cells))]
        compose(crops, bg_hex, directory / f"{name}.png")


# --------------------------------------------------------------------------- #
# Running the real pipeline against a fabricated tree                          #
# --------------------------------------------------------------------------- #

def build_tree(name: str, golden: bool, dapple: bool) -> Path:
    """A throwaway ``strips/`` directory: the legacy exports, plus fake v4 art."""
    tree = WORK / name
    if tree.exists():
        shutil.rmtree(tree)
    tree.mkdir(parents=True)
    # The legacy exports are still the source of eight golden strips and of both
    # decoration sprites, so they have to be reachable. Symlinked, not copied:
    # they are large, and nothing in the pipeline writes to them.
    for png in S.STRIPS.glob("*.png"):
        (tree / png.name).symlink_to(png)

    # Golden only needs the six strips being regenerated; the other eight resolve
    # to the legacy exports, which is the arrangement the owner will actually be
    # in. When a second set is wanted it needs all fourteen — there is no legacy
    # dapple art — and golden then needs all fourteen too, because `frameSets`
    # is keyed by the base set's frame names and the two must match exactly.
    if golden:
        write_set(tree / "v4" / "golden", BG_GOLDEN, REGENERATED, CARRIED if dapple else ())
    if dapple:
        write_set(tree / "v4" / "dapple", BG_DAPPLE, REGENERATED, CARRIED)
    return tree


#: Everything the last ``run()`` printed.
#:
#: The build's own words are part of what is being tested — the summary block a
#: plain run prints is the owner's only report on which strips were used, and
#: the "waiting for golden/idle.png" line is the whole of fix 4. Captured rather
#: than left on the terminal so the checks can assert on it, and echoed back
#: indented so the harness output still shows what he would have seen.
LAST_OUTPUT = ""


def run(tree: Path, dapple_detector: str | None = None, **kwargs) -> dict:
    """Point ``strips.py`` at ``tree`` and build. Restores the module afterwards."""
    global LAST_OUTPUT
    saved = {
        name: getattr(S, name)
        for name in ("STRIPS", "V4", "NAMED", "SET_DIRS", "OUT_JSON", "REFCELLS",
                     "BG_DETECTOR_BY_SET")
    }
    captured = io.StringIO()
    try:
        S.STRIPS = tree
        S.V4 = tree / "v4"
        S.NAMED = tree / "named"
        S.SET_DIRS = {"golden": (S.V4 / "golden", tree), "dapple": (S.V4 / "dapple",)}
        S.OUT_JSON = tree / "walder.json"
        S.REFCELLS = tree / "refcells"
        if dapple_detector is not None:
            S.BG_DETECTOR_BY_SET = {**S.BG_DETECTOR_BY_SET, "dapple": dapple_detector}
        with redirect_stdout(captured):
            sheet = S.build(**kwargs)
    finally:
        LAST_OUTPUT = captured.getvalue()
        for name, value in saved.items():
            setattr(S, name, value)
        if LAST_OUTPUT.strip():
            print(textwrap.indent(LAST_OUTPUT.rstrip("\n"), "  | "))
    (tree / "walder.json").write_text(json.dumps(sheet, indent=1) + "\n")
    return sheet


def run_expecting_failure(tree: Path, **kwargs) -> str:
    """Build and return the message it died with. Raises if it did NOT die."""
    try:
        run(tree, **kwargs)
    except SystemExit as exit_:
        return str(exit_)
    raise AssertionError("the build was expected to fail and did not")


# --------------------------------------------------------------------------- #
# The assertions                                                               #
# --------------------------------------------------------------------------- #

class Checks:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.passes = 0

    def that(self, condition: bool, what: str, detail: str = "") -> None:
        if condition:
            self.passes += 1
            print(f"  ok   {what}")
        else:
            self.failures.append(f"{what}{f' — {detail}' if detail else ''}")
            print(f"  FAIL {what}" + (f" — {detail}" if detail else ""))

    def equal(self, got, want, what: str, detail: str = "") -> None:
        seen = f"got {got!r}, want {want!r}"
        self.that(got == want, what, f"{seen}; {detail}" if detail else seen)


def anim(sheet: dict, name: str) -> dict:
    return sheet["animations"].get(name, {})


def top_ink_row(rows: list[str]) -> int:
    for y, row in enumerate(rows):
        if row.strip(S.TRANSPARENT):
            return y
    return len(rows)


def check_after(c: Checks, sheet: dict) -> None:
    """The v4 path: A2's timings, B1's mood pairs, A4's headroom, A5's anchors."""
    print("\nthe animation tables (A2 / B1)")
    c.equal(anim(sheet, "idle").get("frames"), ["idle_0", "idle_1", "idle_2", "idle_1"],
            "idle breathes there and back, 0-1-2-1")
    c.equal(anim(sheet, "idle").get("durationsMs"), [375] * 4, "idle runs at 375 ms a frame")
    c.that(anim(sheet, "idle").get("loop") is True, "idle loops")
    c.equal(anim(sheet, "idle_neutral").get("frames"), anim(sheet, "idle").get("frames"),
            "idle_neutral is the same four frames")
    c.equal(anim(sheet, "blink").get("frames"), ["idle_3", "idle_4", "idle_3"],
            "blink comes out of the idle strip, symmetric")
    c.equal(anim(sheet, "blink").get("durationsMs"), [83] * 3, "blink runs at 83 ms a frame")
    c.that(anim(sheet, "blink").get("loop") is False, "blink is a one-shot")
    c.equal(anim(sheet, "blink_neutral").get("frames"), anim(sheet, "blink").get("frames"),
            "blink_neutral is the same three frames")
    c.equal(anim(sheet, "idle_rare").get("frames"), ["idle_0", "idle_5", "idle_5", "idle_0"],
            "idle_rare holds the ear-flick for two beats")
    c.equal(anim(sheet, "idle_rare").get("durationsMs"), [125] * 4, "idle_rare runs at 125 ms")
    c.that("ear_flop" not in sheet["animations"], "ear_flop is gone")
    # The legacy blink strip has TWO cells, so it contributes `blink_0` AND
    # `blink_1`; testing only the first would have passed a build that loaded the
    # old illustration and used half of it. Anything matching `blink_<digits>`
    # came from a separate strip — the mood blinks are `blink_happy` and friends,
    # and they are animations over `idle_happy_3`/`_4`, not frames.
    c.equal([n for n in sheet["frames"] if re.fullmatch(r"blink_\d+", n)], [],
            "no frames come from a separate blink strip")
    c.equal(anim(sheet, "confused").get("frames"), ["tilt_2"], "confused is tilt's held frame")

    for mood in S.MOODS:
        strip = f"idle_{mood}"
        c.equal(anim(sheet, strip).get("frames"),
                [f"{strip}_0", f"{strip}_1", f"{strip}_2", f"{strip}_1"],
                f"idle_{mood} breathes in its own face")
        c.equal(anim(sheet, strip).get("durationsMs"), [375] * 4, f"idle_{mood} runs at 375 ms")
        c.equal(anim(sheet, f"blink_{mood}").get("frames"),
                [f"{strip}_3", f"{strip}_4", f"{strip}_3"],
                f"blink_{mood} blinks in its own face")
        c.equal(anim(sheet, f"blink_{mood}").get("durationsMs"), [83] * 3,
                f"blink_{mood} runs at 83 ms")
        c.that(f"idle_rare_{mood}" not in sheet["animations"],
               f"no idle_rare_{mood} — moods blink but never ear-flick")

    print("\nthe boxes (A4)")
    c.equal(sheet["boxes"]["stand"], [72, 72], "the standing box is 72x72")
    sleep_frames = [sheet["frames"][n]["rows"] for n in ("sleep_0", "sleep_1", "sleep_2")]
    reserve = min(top_ink_row(rows) for rows in sleep_frames)
    c.equal(reserve, S.SLEEP_DECOR_HEADROOM_ROWS,
            "the sleep box keeps exactly SLEEP_DECOR_HEADROOM_ROWS empty above the dog")
    c.that(sheet["boxes"]["sleep"][1] > S.SLEEP_DECOR_HEADROOM_ROWS,
           "and there is a dog under the reserve")

    print("\nnothing that belongs to a second coat set (C1 must stay out of a golden-only build)")
    # The negative half of the frame-set work, and the half that is easy to lose:
    # `frameSets`, `paletteFrameSets` and the sixth palette are all appended
    # conditionally, and a condition that quietly became "always" would ship a
    # Colour menu offering a silver dapple coat that draws golden pixels. The
    # owner cannot tell that from a screenshot; the sheet can.
    c.that("frameSets" not in sheet, "a golden-only sheet has no frameSets")
    c.that("paletteFrameSets" not in sheet, "... and no paletteFrameSets")
    c.that("silver-dapple" not in sheet["palettes"],
           "... and no silver-dapple in the Colour menu",
           f"palettes: {list(sheet['palettes'])}")

    print("\nthe decoration anchors (A5)")
    anchors = sheet.get("decorAnchors", {})
    c.equal(sorted(anchors), ["confused", "sleep", "tilt"],
            "tilt, confused and sleep all carry anchors")
    c.equal(anchors.get("tilt"), anchors.get("confused"),
            "tilt and confused share tilt_2, so they share its anchor")
    for animation, entries in anchors.items():
        box_name = sheet["frames"][sheet["animations"][animation]["frames"][0]]["box"]
        box_w, box_h = sheet["boxes"][box_name]
        for decor, at in entries.items():
            decor_w, decor_h = sheet["boxes"][decor]
            c.that(
                0 <= at["x"] and 0 <= at["y"]
                and at["x"] + decor_w <= box_w and at["y"] + decor_h <= box_h,
                f"{animation}.{decor} at ({at['x']}, {at['y']}) is inside the "
                f"{box_w}x{box_h} {box_name} box",
            )

    # The app's own gate (`mirrorReady`, src/sprites/contract.ts) restated here:
    # every animation that plays a decorated frame must anchor every one of that
    # frame's glyphs, or the dog stays un-mirrored. Asserting it in the generator
    # is what makes "the mirror switches itself on" true rather than hoped for —
    # and the table is READ FROM THE APP (`app_decor_by_frame`) rather than typed
    # out again, so adding a third glyph to `contract.ts` fails here until the
    # art pipeline anchors it, instead of passing a check that no longer matches
    # the thing it is checking.
    for frame, decors in app_decor_by_frame().items():
        playing = [n for n, a in sheet["animations"].items() if frame in a["frames"]]
        c.that(len(playing) > 0, f"some animation plays {frame}")
        for decor in decors:
            c.that(
                all(anchors.get(n, {}).get(decor) is not None for n in playing),
                f"every animation playing {frame} anchors the {decor} "
                f"(mirrorReady would say yes)",
                f"unanchored: {[n for n in playing if anchors.get(n, {}).get(decor) is None]}",
            )

    print("\nthe rest of the sheet")
    # These two used to be `sheet["expressions"] == dict(S.EXPRESSIONS)`, which
    # is the constant compared with itself: `build` writes that dict into the
    # sheet unchanged, so the assertion held however wrong the table was. What
    # matters is not that the sheet echoes the table but that the table survives
    # contact with the rest of the sheet and with the app.
    dangling = sorted(
        f"{expression} -> {animation}"
        for expression, animation in sheet["expressions"].items()
        if animation not in sheet["animations"]
    )
    c.equal(dangling, [], "every expression names an animation the sheet actually has")
    c.equal(sorted(sheet["expressions"]), sorted(app_expressions()),
            "the sheet covers exactly the expressions src/core/expression.ts knows",
            "an expression the app can reach with no entry here is a dog with nothing to play")

    for name, animation in sheet["animations"].items():
        c.that(len(animation["frames"]) == len(animation["durationsMs"]),
               f"{name} has one duration per frame")
        c.that(all(f in sheet["frames"] for f in animation["frames"]),
               f"{name} names frames that exist")

    print("\nthe summary block a plain run prints (no --report)")
    # The owner's whole report after dropping a strip. Before it existed a plain
    # run said only "wrote walder.json — 48 frames", so a file he had named
    # wrongly looked exactly like one that had been picked up.
    c.that("summary" in LAST_OUTPUT, "the build prints a summary block")
    c.that("still on the legacy export for out, perk, bark, walk, wake, tail_wag, hop, pet"
           in LAST_OUTPUT,
           "it names the strips that fell back to the legacy exports", LAST_OUTPUT)
    c.that("anchors emitted: tilt.qmark" in LAST_OUTPUT,
           "it lists the anchors that were emitted", LAST_OUTPUT)
    c.that("mirrorReady: yes" in LAST_OUTPUT,
           "and it says the mirror is on, in the owner's words rather than his eyes",
           LAST_OUTPUT)


def check_sets(c: Checks, sheet: dict) -> None:
    """C1/C2: the second coat as a frame set, at the same size and the same names."""
    print("\nthe frame sets (C1)")
    c.equal(sorted(sheet.get("frameSets", {})), ["dapple"], "the dapple set is in frameSets")
    c.equal(sheet.get("paletteFrameSets"), {"silver-dapple": "dapple"},
            "silver-dapple draws the dapple set")
    c.equal(list(sheet["palettes"])[-1], "silver-dapple",
            "silver-dapple is last, so it is last in the Colour menu")
    c.equal(len(sheet["palettes"]), 6, "six coats")

    dapple = sheet["frameSets"]["dapple"]
    c.equal(sorted(dapple), sorted(sheet["frames"]),
            "the dapple set has exactly the base set's frame names")
    mismatched = [n for n in sheet["frames"] if dapple[n]["box"] != sheet["frames"][n]["box"]]
    c.equal(mismatched, [], "every dapple frame is in the same box as its base frame")
    sizes = [
        n for n in sheet["frames"]
        if (len(dapple[n]["rows"]), len(dapple[n]["rows"][0]))
        != (len(sheet["frames"][n]["rows"]), len(sheet["frames"][n]["rows"][0]))
    ]
    c.equal(sizes, [], "every dapple frame has its base frame's dimensions")
    differs = sum(1 for n in sheet["frames"] if dapple[n]["rows"] != sheet["frames"][n]["rows"])
    c.that(differs > 0, "the dapple set is its own pixels, not a copy of the base set")

    glyphs = [n for n in ("heart_0", "heart_1", "qmark", "zz_0") if n in sheet["frames"]]
    c.that(all(dapple[n]["rows"] == sheet["frames"][n]["rows"] for n in glyphs),
           "the glyph sprites are shared verbatim — they are ink, not coat")

    print("\nthe cross-set size check (C2)")
    rows = S.check_cross_set({"golden": sheet["frames"], "dapple": dapple})
    worst = max((r[-1] for r in rows), default=0.0)
    c.that(worst <= S.CROSS_SET_BBOX_WARN,
           f"the worst cross-set bounding-box difference is {worst:.1%}",
           "the two fabricated sets are the same drawing on two grounds, read by two "
           "detectors, so anything above the warn threshold is the detectors disagreeing "
           "about where a silhouette ends")


def check_resolution(c: Checks) -> None:
    """One mood strip dropped on its own must not be mistaken for the neutral idle.

    ``"idle" in "idle_happy.png"`` is true, and ``find_in``'s fuzzy fallback used
    to act on that: the very first strip the owner is told to generate after
    ``idle`` — a mood — silently became the base loop, at five frames where six
    were expected, and the second mood turned the same lookup into "matched 2
    files" and stopped the build outright. Both are checked here, once as the
    lookup and once end to end, because the end-to-end version is what says the
    fallback to the legacy idle still happens.
    """
    print("\nstrip lookup: a mood strip is not the neutral idle (find_in)")
    probe = WORK / "lookup"
    if probe.exists():
        shutil.rmtree(probe)
    probe.mkdir(parents=True)
    blank = Image.new("RGB", (4, 4), (200, 200, 200))
    for name in ("idle_happy", "idle_worried"):
        blank.save(probe / f"{name}.png")

    c.that(S.find_in(probe, "idle") is None,
           "idle does not resolve to idle_happy.png / idle_worried.png",
           f"got {S.find_in(probe, 'idle')}")
    for name in ("idle_happy", "idle_worried"):
        found = S.find_in(probe, name)
        c.equal(None if found is None else found.name, f"{name}.png",
                f"{name} still resolves to its own file")

    single = WORK / "lookup_one"
    if single.exists():
        shutil.rmtree(single)
    single.mkdir(parents=True)
    blank.save(single / "idle_happy.png")
    c.that(S.find_in(single, "idle") is None,
           "and it does not resolve when idle_happy.png is the only file there")

    print("\n... and the build falls back to the legacy idle (end to end)")
    tree = build_tree("lookup_build", golden=False, dapple=False)
    write_set(tree / "v4" / "golden", BG_GOLDEN, {"idle_happy": ("idle", 0, 5)}, ())
    sheet = run(tree)
    c.equal(anim(sheet, "idle").get("frames"), ["idle_0", "idle_1", "idle_2", "idle_3"],
            "idle is the legacy four-frame strip, not the happy one")
    c.equal(anim(sheet, "idle").get("durationsMs"), [125] * 4,
            "... at the legacy tempo, so the legacy table is the one in use")
    c.that(any(re.fullmatch(r"blink_\d+", n) for n in sheet["frames"]),
           "... and the separate legacy blink strip was loaded with it")
    c.equal(anim(sheet, "idle_happy").get("frames"),
            ["idle_happy_0", "idle_happy_1", "idle_happy_2", "idle_happy_1"],
            "the happy strip that WAS dropped resolves to its own frames")
    c.that("blink_happy" in sheet["animations"],
           "... and brings its own blink, so the dropped strip really was used")


def check_glyph(c: Checks) -> None:
    """A `?` glued to the dog must fail the build, not get baked and mirrored.

    The detached case was already covered by ``EXPECTED_DECOR``; this adds the
    touching one, which that check cannot see at all because dog and glyph are
    then a single component. Both are asserted, in that order, because the fix
    for the second must not have quietly disabled the first.
    """
    print("\na glyph the illustrator left in (EXPECTED_DECOR + the size heuristic)")

    for touching, expect in ((False, "carry something besides the dog"),
                             (True, "glued to the dog")):
        label = "welded to his head" if touching else "floating above him"
        tree = build_tree(f"glyph_{'glued' if touching else 'loose'}",
                          golden=True, dapple=False)
        _path, pieces = write_strip_with_glyph(
            tree / "v4" / "golden", "tilt", source_cell=2, touching=touching
        )
        # A welded fixture that quietly came apart would exercise the
        # stray-component check and pass for the wrong reason, so the fixture is
        # asserted before the build is: one component means glued, more than one
        # means the slicer will see a decoration.
        if touching:
            c.equal(pieces, 1, "the fixture is what it claims: a `?` welded to his head")
        else:
            c.that(pieces > 1, "the fixture is what it claims: a `?` floating clear of him",
                   f"the frame holds {pieces} component(s)")
        message = run_expecting_failure(tree)
        c.that(expect in message, f"the build refuses a `?` {label}", message)
        if touching:
            c.that("npm run sprites" in message,
                   "... and says out loud that the size test is only a heuristic",
                   message)
            c.that("tilt" in message and "frame 2" in message,
                   "... naming the strip and the frame", message)


def check_waiting(c: Checks) -> None:
    """A complete dapple set blocked by a LEGACY golden idle is waiting, not broken.

    The regression: `resolve_set` adds the separate legacy `blink` strip to the
    golden set whenever the golden idle is still the four-frame export, the
    readiness comparison then demanded a `dapple/blink.png` that cannot exist,
    and `--require-set dapple` — the flag whose entire job is "tell me whether
    the dapple coat is ready" — failed on a set where all fourteen strips were
    present and correct.
    """
    print("\nthe dapple set while golden is still legacy (the readiness gate)")
    tree = build_tree("waiting", golden=False, dapple=True)
    sheet = run(tree, require_sets=frozenset({"dapple"}))
    expected = ("dapple is waiting for golden/idle.png (the golden set still uses the "
                "legacy 4-frame idle, and the dapple set has no equivalent)")
    c.that(expected in LAST_OUTPUT, "the build says what dapple is actually waiting for",
           LAST_OUTPUT)
    c.that("blink.png" not in LAST_OUTPUT,
           "and never asks for a blink.png the dapple coat cannot have", LAST_OUTPUT)
    c.that("frameSets" not in sheet, "the dapple set is skipped, not half-built")
    c.that("silver-dapple" not in sheet["palettes"],
           "so the Colour menu does not offer a coat with no frames")


def check_sleep_box(c: Checks) -> None:
    """A4 against the REAL legacy art: dog-only + the reserve is still 61x58.

    The reserve is checked on the synthetic tree above, but the synthetic dog is
    a stand-in and the number that matters is a real measurement: the fullscreen
    sleep window is sized from this box (``core/geometry.ts``, no reserve of its
    own), so if removing the drawn ``z z`` and adding
    ``SLEEP_DECOR_HEADROOM_ROWS`` back does not land on exactly the 61x58 the
    0.1.2 sheet shipped, the sleep window changes size the day the new strip
    arrives — a thing nobody would connect to a headroom constant.

    So: the owner's own legacy sleep illustration, rasterised at the real common
    scale with the glyph components excluded, plus the reserve. 61x58, or the
    constant is wrong.
    """
    print("\nthe sleep box on the real legacy art (A4)")
    saved = (S.K, S.ANCHOR_X)
    try:
        resolved, _ = S.resolve_set(S.BASE_SET)
        detector = S.BG_DETECTOR_BY_SET[S.BASE_SET]
        strips = {(S.BASE_SET, name): S.Strip(name, found.path, found.frames, detector)
                  for name, found in resolved.items()}
        decor = {}
        for alias, legacy_name in S.DECOR_ONLY_STRIPS.items():
            key, count = S.LEGACY_SOURCES[legacy_name]
            decor[alias] = S.Strip(alias, S.find_in(S.STRIPS, key), count, "legacy")
        # The same common scale the real build fits, decoration sources included.
        S.K, S.ANCHOR_X = S.fit_scales(
            {**strips, **{("_decor", a): s for a, s in decor.items()}}
        )
        table = S.letter_table(S.SET_COAT[S.BASE_SET])
        sleep = strips[(S.BASE_SET, "sleep")]
        union = None
        for cell in sleep.cells:
            x_left, y_top, s = sleep.transform(cell)
            # `[cell.dog_id]` is the whole point: the drawn `z z` is excluded, so
            # this is the v4 strip's geometry read off the legacy drawing.
            img = S.cell_rgba(sleep.rgb, cell, [cell.dog_id])
            rgba = S.resample(img, (x_left, y_top, x_left + S.BOX / s, y_top + S.BOX / s),
                              (S.BOX, S.BOX))
            rows, _ = S.to_rows(rgba, table)
            b = S.tight(rows)
            union = b if union is None else (min(union[0], b[0]), min(union[1], b[1]),
                                             max(union[2], b[2]), max(union[3], b[3]))
        assert union is not None
        box = (union[0], max(0, union[1] - S.SLEEP_DECOR_HEADROOM_ROWS), union[2], union[3])
        size = [box[2] - box[0] + 1, box[3] - box[1] + 1]
    finally:
        S.K, S.ANCHOR_X = saved
    c.equal(size, [61, 58],
            "the glyph-less sleep dog plus the reserve is the 61x58 box 0.1.2 shipped",
            "so the fullscreen sleep window does not change size when the v4 sleep "
            "strip lands; if a new pose really needs a different box, "
            "core/geometry.ts and this number have to move together")


def check_flags(c: Checks) -> None:
    """``--require-set`` is validated before anything else happens."""
    print("\nthe flags")
    try:
        S.build(require_sets=frozenset({"dappel"}))
    except SystemExit as exit_:
        message = str(exit_)
    else:  # pragma: no cover - the build is expected to refuse
        message = ""
    c.that("no such coat set" in message, "a misspelled --require-set fails immediately",
           message or "the build did not fail at all")
    for name in S.SETS:
        c.that(name in message, f"... and the message lists {name}", message)


def check_background(c: Checks) -> None:
    """C4: the border-keyed detector on the ground the dapple prompts specify."""
    print("\nthe background detector (C4)")
    strip = legacy_strip("idle")
    crop = cell_crop(strip, 0, dog_only=True)
    path = WORK / "background" / "green.png"
    compose([crop], BG_DAPPLE, path)
    rgb = np.array(Image.open(path).convert("RGB"))

    border = S.background_mask_border(rgb)
    legacy = S.background_mask_legacy(rgb)
    c.that(border[0, 0] and border[-1, -1], "the border detector finds the green ground")
    c.that(border.mean() > 0.5, "and most of a mostly-empty canvas is ground")
    c.that(not legacy.any(), "the legacy grey rule finds no ground on green at all",
           "which is why the dapple prompts ask for green and this rule is per set")

    # The dog must survive: a detector that ate him would also "find the ground".
    dog_rows = np.nonzero(~border)[0]
    c.that(len(dog_rows) > 0, "and the dog is not part of it")

    # This used to read `c.equal(S.BG_DETECTOR_BY_SET["golden"], "legacy", ...)`,
    # which is the constant compared with itself — it restated the config
    # instead of testing it. What the golden set actually needs is that the
    # detector it is configured with works on the ground its prompts specify, so
    # ask the configured detector, on a grey canvas, and check it separates dog
    # from floor.
    grey = WORK / "background" / "grey.png"
    compose([crop], BG_GOLDEN, grey)
    grey_rgb = np.array(Image.open(grey).convert("RGB"))
    configured = S.BG_DETECTORS[S.BG_DETECTOR_BY_SET["golden"]]
    ground = configured(grey_rgb)
    c.that(ground[0, 0] and ground[-1, -1] and ground.mean() > 0.5,
           "the detector the golden set is configured with finds the grey ground")
    c.that((~ground).sum() > 0 and not ground.all(),
           "... and leaves the dog standing on it",
           "a detector that ate the dog would also pass 'it found the ground'")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--keep", action="store_true", help="leave the fabricated tree on disk")
    groups = ("after", "sets", "background", "resolve", "glyph", "waiting", "sleepbox", "flags")
    ap.add_argument("--only", choices=groups, action="append", default=[])
    args = ap.parse_args()
    wanted = set(args.only) or set(groups)

    c = Checks()
    try:
        if "after" in wanted:
            print("=== the v4 path, golden only (stages A, B) ===")
            tree = build_tree("after", golden=True, dapple=False)
            check_after(c, run(tree))
        if "sets" in wanted:
            print("\n=== both coat sets (stage C) ===")
            tree = build_tree("sets", golden=True, dapple=True)
            # Each set on the ground its own prompts specify, read by its own
            # detector — grey through the legacy rule, green through the
            # border-keyed one. Both sets are the same drawing, so this is also
            # the sharpest available check that the two detectors agree about
            # where a silhouette ends: `--report` puts the worst cross-set
            # bounding-box difference at 0.0 %.
            check_sets(c, run(tree, require_sets=frozenset({"dapple"})))
        if "background" in wanted:
            check_background(c)
        if "resolve" in wanted:
            print("\n=== resolving strips by name (the fuzzy fallback's fences) ===")
            check_resolution(c)
        if "glyph" in wanted:
            print("\n=== a glyph left in the art, detached and glued (A5's two gates) ===")
            check_glyph(c)
        if "waiting" in wanted:
            print("\n=== a finished dapple set behind a legacy golden idle (C1) ===")
            check_waiting(c)
        if "sleepbox" in wanted:
            print("\n=== the sleep box on the real art (A4) ===")
            check_sleep_box(c)
        if "flags" in wanted:
            print("\n=== the command line ===")
            check_flags(c)
    finally:
        if not args.keep and WORK.exists():
            shutil.rmtree(WORK)

    print()
    if c.failures:
        print(f"RESULT: {len(c.failures)} FAILURE(S) of {c.passes + len(c.failures)}")
        for line in c.failures:
            print(f"  - {line}")
        raise SystemExit(1)
    print(f"RESULT: CLEAN ({c.passes} checks)")


if __name__ == "__main__":
    main()

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
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

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


def run(tree: Path, dapple_detector: str | None = None, **kwargs) -> dict:
    """Point ``strips.py`` at ``tree`` and build. Restores the module afterwards."""
    saved = {
        name: getattr(S, name)
        for name in ("STRIPS", "V4", "NAMED", "SET_DIRS", "OUT_JSON", "REFCELLS",
                     "BG_DETECTOR_BY_SET")
    }
    try:
        S.STRIPS = tree
        S.V4 = tree / "v4"
        S.NAMED = tree / "named"
        S.SET_DIRS = {"golden": (S.V4 / "golden", tree), "dapple": (S.V4 / "dapple",)}
        S.OUT_JSON = tree / "walder.json"
        S.REFCELLS = tree / "refcells"
        if dapple_detector is not None:
            S.BG_DETECTOR_BY_SET = {**S.BG_DETECTOR_BY_SET, "dapple": dapple_detector}
        sheet = S.build(**kwargs)
    finally:
        for name, value in saved.items():
            setattr(S, name, value)
    (tree / "walder.json").write_text(json.dumps(sheet, indent=1) + "\n")
    return sheet


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

    def equal(self, got, want, what: str) -> None:
        self.that(got == want, what, f"got {got!r}, want {want!r}")


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
    c.that(not any(n.startswith("blink_0") for n in sheet["frames"]),
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
    # is what makes "the mirror switches itself on" true rather than hoped for.
    app_decor = {"tilt_2": ["qmark"], "sleep_2": ["zz"]}
    for frame, decors in app_decor.items():
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
    c.equal(sheet["expressions"], dict(S.EXPRESSIONS), "expressions map to their own animations")
    for name, animation in sheet["animations"].items():
        c.that(len(animation["frames"]) == len(animation["durationsMs"]),
               f"{name} has one duration per frame")
        c.that(all(f in sheet["frames"] for f in animation["frames"]),
               f"{name} names frames that exist")


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
    c.equal(S.BG_DETECTOR_BY_SET["golden"], "legacy",
            "the golden set stays on the rule its approved frames were quantised with")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--keep", action="store_true", help="leave the fabricated tree on disk")
    ap.add_argument("--only", choices=("after", "sets", "background"), action="append", default=[])
    args = ap.parse_args()
    wanted = set(args.only) or {"after", "sets", "background"}

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

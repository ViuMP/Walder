# Handoff to Claude — Yuna cat character sets

Victor approved Yuna's full review gallery on 2026-09-21. The exact whole generated sources remain
archived under `design/concepts/yuna/review/` and are now installed, unchanged, in the active art
pipeline.

## Approved source of truth

Yuna is a domestic cat with five individually illustrated, owner-approved frame sets:

- `grey-tabby` — `idle-v1`, `tail-wag-v4`, and `pet-v5` are selected.
- `orange-tabby` — all selected sources are `*-v1`.
- `black` — selected idle is `idle-v3`, retaining the right-eye highlight; all other strips are `*-v1`.
- `tuxedo` — all selected sources are `*-v1`; white fur must remain neutral, never blue.
- `calico` — all selected sources are `*-v1`; white fur must remain neutral, never blue.

Each selected set has 15 strips: idle 6, happy 5, worried 5, exhausted 5, out 2, perk 6,
tilt 3, sleep 3, lie 3, bark 4, walk 4, wake 4, tail wag 3, hop 5, pet 6. `perk` is Yuna batting a
red yarn ball and loops its final two frames. `pet` starts and ends on idle and contains no hearts;
the existing universal heart remains runtime decoration. `tilt` has no question mark and `sleep`
has no sleep glyph. Sources must stay whole: no pixel-level edits, recolours, copied cells or splices.

The `full-animation-gallery-v2.png` beside each set is the exact owner-approved review surface.
Older tail/pet iterations and `alternate-cat/` are intentionally retained as rollback/reference art,
not approved Yuna sources.

## Active implementation

Yuna is carried in five frame sets plus the minimal `frameSetAnimations` override map. Her mood
idles use their own approved faces, `perk` runs six frames then repeats frames 5–6, and `tail_wag`
uses three frames. Walder and dapple retain their original animation table; older sheets default to
no overrides. The gallery rebuilds its cards when a coat changes, so it shows the selected
character's timing rather than a stale shared frame list.

Validation after any future source replacement:

```sh
python3 art/strips.py --report && node art/render.mjs && npm run sprites
npm run typecheck && npm test && npm run build
```

Do not release. The owner needs to approve the live app gallery after integration.

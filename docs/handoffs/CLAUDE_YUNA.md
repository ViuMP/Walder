# Handoff to Claude — Yuna cat character sets

Victor approved Yuna's full review gallery on 2026-09-21. This commit archives the exact whole
generated sources under `design/concepts/yuna/review/`; it deliberately does **not** alter active
art, `art/walder.json`, or the app's colour menu.

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

## Why this is not active yet

`art/strips.py` and the sprite-sheet contract currently require all alternate frame sets to have
the base frame names and share one global animation table. Walder's current contract has a 3-frame
`perk` and 4-frame `tail_wag`; Yuna's approved contract has a 6-frame perk (last two loop) and a
3-frame tail wag. Installing the sources now would either fail validation or discard/repeat owner-
approved frames. Neither is acceptable.

## Next implementation task

Implement first-class character-specific animation sequences, then install the **selected untouched
sources** as five Yuna frame sets and expose their palettes/menu labels. Keep the existing Walder
and dapple sheet byte-for-byte stable. The design must preserve safe mid-animation switching: if a
palette changes while an animation is running, the renderer must choose a valid frame in the target
character's sequence rather than assuming equal frame indexes.

Before editing, read `AGENTS.md`, `CONTRIBUTING.md`, `art/README.md`, this handoff, and the current
`art/strips.py`, `src/sprites/types.ts`, `src/sprites/contract.ts`, `src/core/expression.ts`, and
`src/renderer/sprites-dev.ts`. Make the smallest model that can represent per-frame-set animation
frame lists and timing; do not duplicate five near-identical sheet schemas. Add focused parser,
frame-selection, and gallery tests. The app must still fall back safely for an old sheet without
Yuna. Then run:

```sh
python3 art/strips.py --report && node art/render.mjs && npm run sprites
npm run typecheck && npm test && npm run build
```

Do not release. The owner needs to approve the live app gallery after integration.

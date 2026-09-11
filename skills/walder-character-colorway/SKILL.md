---
name: walder-character-colorway
description: Add a new Walder character, coat, or colourway to the animation gallery. Use when introducing a palette-only colourway, a visually distinct coat such as silver dapple, or a new named character that needs its own Firefly strip set.
---

# Walder Character & Colourway

Use this skill to extend Walder's gallery without breaking the source-art contract.

## Start with the project state

Read `AGENTS.md`, `docs/NEXT_STEPS.md`, `docs/PROMPTS_V4.md`, `docs/BUILD_LOG.md`,
`art/README.md`, and `design/references/strips/v4/README.md`. Inspect the current
`art/strips.py` before deciding whether the request needs a palette or a frame set.
Do not overwrite pending work, approved art, or a documented handoff decision.

Ask only for the information that cannot be inferred: the character/colourway name,
the intended visual reference, and whether it is a palette-only change or must have
its own illustrated silhouette. Treat the gallery as the approval surface.

For the decision rules, source-art policy, generation brief, acceptance gates, and
handoff requirements, read [the Walder art pipeline reference](references/walder-art-pipeline.md).

## Choose the implementation

- Use a **palette-only colourway** when the same base frames faithfully represent
  the character. Add a named palette/ramp and make sure it has no `paletteFrameSets`
  entry. Review every output at 2x; a colourway that makes markings, the mouth, or
  decor unreadable needs its own drawn source art.
- Use a **frame set** when markings, coat distribution, proportions, or silhouette
  need different pixels. A frame set contains a complete counterpart to the base
  frames and is attached through `paletteFrameSets`. Never make a hybrid by copying,
  recolouring, or patching individual sprite cells.
- Use a **new character frame set** when the newcomer needs a different pose,
  shape, or personality. Keep the same animation/box contract unless the product
  contract is deliberately being expanded and the owner has approved that scope.

## Source-art contract

The artwork must come from complete owner-approved illustration strips. Run
`art/strips.py` to remove the background, slice frames, fit them consistently, and
quantise them to the sprite sheet. It is the only permitted route from strip to
`art/walder.json`.

Never hand draw, trace, retouch, recolour, copy, or patch sprite pixels. Do not
hand-edit `art/walder.json`, rendered PNGs, or the generated named-strip copies.
A palette adjustment is code/data policy, not an excuse to alter an individual
frame. Keep Firefly candidates outside the active `v4/<set>/` source directory
until the owner has reviewed them.

Use only owner-authorized Firefly source strips. Generate a complete strip with the
exact required frame count and a flat, set-specific background. Keep `tilt` and
`sleep` glyph-free; the app supplies question marks and sleep marks from its
decoration system.

## Work in reviewable batches

1. Record the proposed canonical name and whether it maps to a palette or a frame set.
2. When source-strip requirements change, update the appropriate prompt/reference
   material before producing source art.
3. In an isolated review worktree, place one complete strip or a coherent small
   batch in that worktree's active `v4/<set>/` path and run the art checks there.
   Never fill a missing frame with pixels borrowed from another set.
4. Build the gallery and inspect the new colourway at 2x, including idle/blink,
   expressions, `out`, `tilt`, `sleep`, decor, and palette switching.
5. Present the result for owner approval. A partial or fallback result must be
   described exactly as such; it is not generated source art.
6. After approval, install the untouched approved complete source strip in the
   main checkout's active directory, rebuild, and record the decision and remaining
   work.

For a frame set, retain the base set's frame names, frame counts, boxes, dimensions,
and animation semantics. Its palette must select only its own frame set. The builder
should reject incomplete or misaligned sets; do not weaken those checks to ship.

## Verify and hand off

Run the project commands documented in `AGENTS.md` and inspect their artifacts:

```bash
python3 art/strips.py --report
node art/render.mjs
npm run sprites
npm run typecheck && npm test && npm run build
```

`art/out/CHECK.txt` must report clean. Confirm the gallery renders the selected
palette/frame set, no glyph is baked into `tilt` or `sleep`, and the new set does
not visibly jump in scale. Update `docs/PROMPTS_V4.md`, `docs/BUILD_LOG.md`, and
`docs/NEXT_STEPS.md` with precise source status, owner approvals, fallbacks, and
next actions. Do not release until the required source art and owner approvals are
complete; leave the handbook pass for the release stage specified by the project.

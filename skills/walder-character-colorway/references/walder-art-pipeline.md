# Walder character and colourway pipeline

Use this reference while applying `walder-character-colorway`. It reflects the
current Walder strip architecture; inspect the repository before relying on any
implementation detail, because new character support may deliberately extend it.

## Intake and routing

Start by writing down the requested canonical display name, stable slug, visual
reference, and the decision below.

| Request | Implementation |
|---|---|
| Same dog and every frame can be represented by the existing pixels | Add a palette-only colourway. |
| Same character type, but coat markings or features need their own pixels | Add a full alternate frame set and connect the colourway to it. |
| A new character with different proportions, pose, or personality | Add a named full frame set, selectable palette, and `paletteFrameSets` mapping under the current UI. |
| A request that alters animation counts, box sizes, or semantics | Treat as a product-contract change; identify and approve that scope before sourcing art. |

Do not assume that a colour name implies palette-only. Silver dapple is the model:
its irregular markings cannot be expressed with a ramp, so it owns a `dapple` frame
set selected by the `silver-dapple` palette.

Before changing code, read the active source and generated contract:

```text
art/strips.py
art/README.md
art/render.mjs
src/sprites/types.ts
src/sprites/contract.ts
src/renderer/sprites-dev.ts
docs/PROMPTS_V4.md
docs/BUILD_LOG.md
docs/NEXT_STEPS.md
```

## Source art rules

1. An owner-authorized Firefly illustration strip is authoritative. `art/strips.py`
   is the only converter from that source to sprite pixels.
2. Never redraw, trace, patch, recolour, clone, or hand-edit sprite pixels. This
   includes `art/walder.json`, generated sprites, and a single mouth, shadow, or
   decorative glyph.
3. Source strips are complete scenes: one cell per required frame, laid out left to
   right, at the exact documented frame count. The pipeline fails on a count mismatch.
4. Keep unapproved experiments out of active `design/references/strips/v4/<set>/`.
   Preserve useful candidates with their prompt and version in a clearly named
   review location.
5. Set-specific flat backgrounds are processing requirements. Use the current
   background rule configured in `art/strips.py`; do not substitute a pretty
   background that makes foreground extraction ambiguous.
6. `tilt` contains no question mark and `sleep` contains no `z z`. Their universal
   decorations are runtime assets, so they stay readable and face the right direction.
7. A partial new frame set remains absent. Never combine base-set legs, expressions,
   or decoration pixels with the unfinished character. If the project permits a
   fallback, label it as fallback and get owner approval for that exact state.

## Creating a generation brief

Use `docs/PROMPTS_V4.md` as the source of truth for animation names, counts, visual
language, and source background. A concise brief should state:

- character identity, coat markings, and reference images the user authorizes;
- the strip name and exact number of left-to-right cells;
- the intended action in each cell, including the unchanged first idle pose where
  relevant;
- square pixel-art/illustration style matching the approved gallery, full dog in
  frame, no crop, stable ground line, and no unrelated objects or text;
- the exact flat background colour for the set;
- required expression features such as mouth, tongue, or eye state;
- the explicit no-glyph requirement for `tilt` and `sleep`.

Do not rely on the image model to infer technical animation conditions. Inspect the
candidate at the gallery's 2x acceptance size before it becomes active source art.

## Frame-set implementation contract

The base sheet holds `frames`. A distinct character/coated set belongs in
`frameSets`, and the selectable palette points to it through `paletteFrameSets`.
The current parser requires an alternate set to have exactly the same frame names,
boxes, and dimensions as the base. The generator also checks cross-set scale so a
coat switch does not make the dog jump in size.

When adding a set:

1. Add stable set/colourway mappings, source roots, background detection, and ramp
   values in the generator rather than in generated output.
2. Supply every required strip for the completed base animation contract. A set
   that is incomplete should be skipped or fail according to the documented
   readiness rule; the menu must never offer it while it draws base pixels.
3. Quantise source art against the set's own ramp. Keep all shared/UI colours
   legible across palettes, especially the mouth, eyes, heart, question mark, and
   sleep marks.
4. Confirm its frames pass the parser and renderer parity checks. Do not lower
   scale or parity thresholds merely to accept a visibly mismatched character.
5. Ensure switching from any animation and from every supported palette behaves
   safely. An unknown saved palette still needs the project’s defined fallback.

A palette-only addition still needs broad visual review: variations that collapse
light/dark coat regions or make an outlined facial feature disappear are rejected.

## Approval loop

Use a small, reversible loop.

1. Prepare prompt(s) and candidate sources outside the main checkout.
2. In an isolated review worktree, temporarily place the complete candidate at the
   required `v4/<set>/` path and build its gallery there.
3. Review the candidate visually for pose, mouth/eyes, coat marks, shading,
   framing, and decoration policy.
4. Show the owner the affected 2x cards and compare it with the established
   characters. Check still idle/blink separately from animated poses.
5. Once the owner approves it, install the untouched whole source strip in the main
   checkout and run the source-to-gallery pipeline again.
6. Record explicit approval by character/colourway and animation names. Do not
   rework assets the owner said to keep.
7. If the owner accepts a temporary fallback, record the exact fallback as a
   temporary approved presentation state. Never describe it as a source strip or
   silently replace it later.

Any change in shared scale or palette roles can alter an already approved gallery.
When that happens, re-review every affected base and alternate frame set before
calling the batch complete.

## Checks and release handoff

Use the project interpreter/environment that has the art dependencies. Run:

```bash
python3 art/strips.py --report
node art/render.mjs
npm run sprites
npm run typecheck && npm test && npm run build
```

Inspect `art/out/CHECK.txt` and the rendered 2x gallery, not just process exits.
Look for missing mouths, muddy shading, baked/mirrored glyphs, scale shifts,
truncated art, unreadable decor, and a palette whose output accidentally uses base
pixels. If the change touches source selection, exercise the relevant fallback and
incomplete-set paths as well.

Before handoff, update:

- `docs/PROMPTS_V4.md` with source prompts and the status of every expected strip;
- `docs/BUILD_LOG.md` with what was added, commands run, and any compatibility facts;
- `docs/NEXT_STEPS.md` with the next concrete action, owner approvals, remaining
  source art, and any approved fallback.

Do not create a release, change the acceptance record, or begin the handbook pass
until the repository's stated release order allows it. Keep `src/core/` and
`src/sprites/` Electron-free, never refresh CLI tokens, and never place raw usage
payload values in logs or handoff notes.

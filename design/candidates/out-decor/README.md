# Out and decoration review — 2026-09-11

| Output | Untouched built-in generation | Exact prompt |
|---|---|---|
| `v4/golden/out.png` | `out-02.png` | `out-02.prompt.md` |
| `v4/decorations.png` | `decorations-01.png` | `exactprompt.md` |
| `v4/golden/idle_worried.png` | `idle_worried-02.png` | `idle_worried-02.md` |

`out-01` is preserved as a rejected candidate: its reduced face was too small. `out-02` is compact
so its face, mouth and X eyes stay readable. `decorations-01` carries four fixed cells: heart,
heart pulse, question mark with detached dot, and paired z symbols. The pipeline fits only these
standalone symbols into larger output boxes; no dog artwork or legacy baked glyph is edited.

The art render passed CLEAN. A sheet comparison confirmed exactly eleven changed frames: `out_0`,
`out_1`, `idle_worried_0`–`idle_worried_4`, `heart_0`, `heart_1`, `qmark`, and `zz_0`.

## 2026-09-11 — gallery colour and symbol correction

The active golden out source is now the untouched `golden-out-02.png`, generated from the approved
silver-dapple out pose and the golden idle identity. It replaces the earlier compact out in
`v4/golden/out.png`, so the golden, red, cream, black-and-tan and chocolate palettes all share the
same improved pose. Its exact prompt is `golden-out-03.prompt.md`.

The active standalone source is now `decorations-03.png`. Its heart silhouette follows the
silver-dapple pet hearts; heart, question mark and paired z symbols use only shared sheet colours,
so they render identically in every coat. Its exact prompt is `decorations-03.prompt.md`.

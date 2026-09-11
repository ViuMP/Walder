# Golden set preview — 2026-09-10

Current status: approved neutral idle03 remains active. Victor approved worried candidate01 and exhausted01 and asked to restore those two only, keep happy as-is, and do nothing else. Both source PNGs are installed in main and the gallery review copy. Happy/blink_happy still alias approved neutral, while tilt/confused and sleep use their originals. Rejected happy/tilt and unapproved sleep remain archived.

The earlier blanket rollback was too broad. The slicer now calculates the base alignment without optional mood strips, while keeping those mood strips at their existing all-strip alignment. This preserves both the approved new mood frames and every pre-existing frame exactly, without editing sprite pixels. A common scale is retained. `CHECK-moods-restored.txt`, `sheet-moods-restored.json` and `slicer-report-moods-restored.txt` record this result. The previous `*-restored` files record the superseded blanket rollback; unqualified files preserve the superseded full-set preview.

No further generation or changes for now, per owner instruction.

## Superseded full-set preview

The complete candidate set was staged in `/private/tmp/walder-idle-review`, served at http://localhost:5173/sprites-dev.html.

| Strip | Untouched generated source | Exact prompt |
|---|---|---|
| happy | idle_happy_candidate01.png | idle_happy_candidate01.prompt.md |
| worried | idle_worried_candidate01.png | idle_worried_candidate01.prompt.md |
| exhausted | idle_exhausted-01.png | idle_exhausted-01.md |
| tilt | tilt-02.png | tilt-02.md |
| sleep | sleep-01.png | sleep-01.md |

Generated with built-in ChatGPT imagegen using the approved idle and, for sleep, the legacy curled pose. Native outputs are around 1677×938 despite requested 1376×768; preserved untouched and fitted by the existing slicer. No sprite pixels were patched or traced. Tilt01 failed the bounding-box glyph heuristic because its raised ear enlarged the silhouette. Tilt02 was regenerated with relaxed ears; guard thresholds were unchanged.

Each accepted drop passed `art/strips.py --report` and `node art/render.mjs`. Final `CHECK.txt` is CLEAN; `sheet.json` and `slicer-report.txt` preserve the complete result. `npm run sync:sheet` passed in the isolated review copy: 63 frames, 24 animations, five palettes. Anchors exist for tilt/confused question marks and sleep symbols; mirrorReady is true. Root checked the gallery and mirrored poses. Subagents generated happy/worried/exhausted/tilt; root generated sleep and audited their outputs. A separate subagent reviewed the reduced frames and anchors.

Visual review notes: mouths remain visible through all mood blinks. Worried has a slight anxious smile and a small forehead/sweat-drop shift during blinking; its half-blink is already almost closed at 2×. Exhausted half/full blink frames also look similar at that scale. Tilt02 is intentionally subtle; the held frame changes muzzle shading, making its mouth less distinct than its first frame. These are owner-review points, not pixel repairs.

All idles hold frame0 and only interrupt for blinking. Sleep retains its gentle three-frame loop. The eight other golden strips remain legacy. No dapple generation, release, or handbook pass yet. Existing full typecheck/test/build results cover the approved idle and code changes; this candidate set has art/sync checks only. When these five are approved and installed, migrate shipped-sheet tests that deliberately still expect legacy baked tilt/sleep glyphs, then run full checks.

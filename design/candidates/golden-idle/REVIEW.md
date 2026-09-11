# Golden idle — first review, 2026-09-10

Status: candidate 03 approved by Victor ("that looks great"). Victor withdrew the quality concern after identifying the scale mismatch, requested a first-frame-only idle with blinking, then spotted that candidate 02's mouth disappeared after slicing. Candidate 03 is now the golden v4 source, fully regenerated with a stronger closed-mouth seam. Root and independent reviewer confirmed the mouth is visible in idle_0, idle_3 and idle_4 at 2×. No sprite pixels were hand-edited. See PROMPT-attempt-03.md for exact generation instructions.

Generated two untouched strips with built-in ChatGPT image generation using the hero and legacy idle references. Exact prompts in PROMPTS.md. Attempt 02 is preferred after independent subagent review and root audit: more space between dogs, better dachshund proportions, recognizable identity, correctly ordered open/half-closed/closed eyes and lifted ears.

Remaining visual concerns: head/chest variation during frames 1–3; raised tail follows the reference rather than the literal relaxed-tail wording; background is subtly uneven. No pixels were patched.

Attempt 02 validated in isolated copy /private/tmp/walder-idle-review using the unchanged art/strips.py and art/render.mjs. Slicer success, no extra idle decorations detected, CHECK.txt CLEAN, sync:sheet success. Gallery loaded with 22 animations, 48 frames, 5 palettes. Idle 0-1-2-1 at 375 ms; blink 3-4-3 at 83 ms; rare 0-5-5-0 at 125 ms. Existing tilt/sleep still use legacy baked glyphs, so mirroring remains dormant as expected.

The default Python lacked art dependencies. Review used /private/tmp/walder-art-python, based on bundled Python with SciPy installed in that temporary environment.

Live gallery: http://localhost:5173/sprites-dev.html while the isolated npm run sprites process is running. NOW SHOWS CANDIDATE 03 WITH STILL IDLE AND VISIBLE MOUTH: first frame held, half/closed/half blink, no breathing or rare ear/head motion. Both production sheet JSON files are regenerated from the untouched v4 PNG through art/strips.py. The gallery uses the app's own idle scheduler so each idle card actually blinks; separate blink cards remain available. CHECK/sheet-attempt-03 record this revision. The earlier CHECK/sheet/scales-attempt-02 files record the original breathing candidate, not the revised timing.

Quality follow-up: candidate and original production palettes and boxes were identical; all 42 common non-idle frames were byte-identical. Victor subsequently confirmed quality was fine and the perceived difference came from comparing different display scales. Always compare final rendered appearance at the same scale, independently of structural CLEAN status.

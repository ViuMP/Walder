# v4 strips — drop folder

Put Firefly outputs here, one PNG per animation, named after the strip:

```
v4/
  golden/   idle.png  idle_happy.png  idle_worried.png  idle_exhausted.png  tilt.png  sleep.png
  dapple/   idle.png  idle_happy.png  idle_worried.png  idle_exhausted.png  tilt.png  sleep.png
            out.png  perk.png  bark.png  walk.png  wake.png  tail_wag.png  hop.png  pet.png
```

The prompts, in the order to generate them, are in `docs/PROMPTS_V4.md`.

## How the build reads this folder

- `art/strips.py` looks for each strip first here (`v4/<coat>/<strip>.png`), then falls back to the
  legacy Firefly exports one level up (`strips/*.png`) for the golden coat only. So the eight golden
  animations that are NOT being regenerated (`out perk bark walk wake tail_wag hop pet`) keep coming from
  the legacy files, and a new golden `idle.png` here replaces the legacy idle strip.
- A file may keep its Firefly name as long as the strip name (`idle_happy`) appears in it; an exact
  `<strip>.png` is preferred and always wins.
- **Each strip counts on its own.** Drop one file and the build uses it; the rest keep falling back. A
  golden mood strip that is not here yet simply aliases the plain idle, exactly as v0.1.2 did. The moment
  `golden/idle.png` lands, the new six-frame timings take over and the old separate blink strip stops
  being read at all.
- The dapple coat needs ALL fourteen strips, at the same frame counts the golden coat resolved. Until then
  the build prints what is missing and skips the dapple coat — the golden coat is never blocked by
  unfinished dapple work. `python3 art/strips.py --require-set dapple` turns the skip into a failure.
- Frame counts are fixed: `idle` 6 · the three moods 5 · `tilt` 3 · `sleep` 3 · `out` 2 · `perk` 3 ·
  `bark` 4 · `walk` 4 · `wake` 4 · `tail_wag` 4 · `hop` 5 · `pet` 6. A strip with the wrong number of
  dogs fails loudly rather than guessing.
- `tilt` and `sleep` must carry NO `?` and NO `z z` — the app draws those itself, so that they read the
  right way round when he turns to face the screen. A stray glyph **fails the build** (it is also listed
  in the `--report` decoration table), because a baked one would be mirrored backwards on half the screen
  with nothing in any log to say why. The same check runs on every strip: anything besides the dog fails
  unless the drawing is meant to have it (`pet`'s hearts, `idle_worried`'s sweat drop, `bark`'s and
  `wake`'s motion ticks, `out`'s breath puff).
- The dapple strips want a flat **green** `#3FA34D` background, the golden ones flat light grey `#C8C8C8`.
  That is not decoration: the build tells dog from ground by colour, and a silver dog on a grey ground is
  the one case it cannot separate.

## Commands

```bash
python3 art/strips.py --report   # fit the strips onto the 72-px sheet, print what it found
node art/render.mjs              # render every frame as PNG + CHECK.txt (must say RESULT: CLEAN)
npm run sprites                  # the gallery, where the motion is approved
```

`named/<coat>/<strip>.png` copies are written by the build for reference and can be deleted at any time.

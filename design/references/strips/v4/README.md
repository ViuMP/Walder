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
  legacy Firefly exports one level up (`Strips/*.png`) for the golden coat only. So the eight golden
  animations that are NOT being regenerated (`out perk bark walk wake tail_wag hop pet`) keep coming from
  the legacy files, and a new golden `idle.png` here replaces the legacy idle strip.
- A file may keep its Firefly name as long as the strip name (`idle_happy`) appears in it; an exact
  `<strip>.png` is preferred and always wins.
- The dapple coat needs ALL fourteen strips. Until they are all present the build prints which are missing
  and skips the dapple coat — the golden coat is never blocked by unfinished dapple work.
- Frame counts are fixed: `idle` 6 · the three moods 5 · `tilt` 3 · `sleep` 3 · `out` 2 · `perk` 3 ·
  `bark` 4 · `walk` 4 · `wake` 4 · `tail_wag` 4 · `hop` 5 · `pet` 6. A strip with the wrong number of
  dogs fails loudly rather than guessing.
- `tilt` and `sleep` must carry NO `?` and NO `z z` — the app draws those itself. A stray glyph is reported
  by `--report` and fails the build.

## Commands

```bash
python3 art/strips.py --report   # fit the strips onto the 72-px sheet, print what it found
node art/render.mjs              # render every frame as PNG + CHECK.txt (must say RESULT: CLEAN)
npm run sprites                  # the gallery, where the motion is approved
```

`named/<coat>/<strip>.png` copies are written by the build for reference and can be deleted at any time.

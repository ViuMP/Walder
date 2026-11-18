# Walder — pose reference prompts (for Gemini, after the winning design sheet)

Victor picked the Gemini (Nano Banana 2) design sheet on 2026-09-08. Image models cannot keep a character
identical across small animation frames, so we do NOT ask for strips. Instead: one large image per key pose,
used as a REFERENCE; the pixel frames are re-authored by hand from one master pose so consistency is guaranteed.

## Header (send once, with the design sheet attached)
This is Walder, my pixel-art golden long-haired miniature dachshund (Panel A is the reference).
For every image I ask for next: draw THE SAME DOG, same proportions (big head, big round dark eyes with one
white highlight, cream chest bib, feathered ears, plume tail), same 5-tone golden palette and dark warm-brown
outline, same Pokémon Black/White pixel style: crisp hand-placed pixels, no anti-aliasing, no gradients,
no blur. One single dog per image, large (fill the canvas), three-quarter view facing LEFT, plain flat
light-grey background, no text, no props, no scene. Square 2048×2048 output.

## Poses (one message each)
1. Hero, standing calm, neutral face, mouth closed. This is the master pose. (Generate twice.)
2. Same pose, HAPPY face: bright eyes, raised brows, small open smile, tail up high.
3. Same pose, WORRIED face: brows angled inward, ears drooping lower, one sweat drop by the head.
4. Same pose, EXHAUSTED face: half-closed eyes, tongue hanging out panting, ears flat.
5. OUT: lying completely flat on his belly, legs splayed, eyes closed as X marks, tail flat on the ground.
6. CONFUSED: head tilted to one side, one ear lifted, big curious eyes, a floating question mark above.
7. BARK: mouth wide open mid-bark, body leaning one step forward, ears swung back, two small motion lines.
8. PET: being stroked, eyes closed into happy arcs, head pushed upward, two small red pixel hearts floating.
9. PERK / alert: head lifted high, ears flared out and slightly up, eyes wide, tail straight up.
10. TILT / curious: head tilted 15 degrees, one ear lifted, question mark above, otherwise calm.
11. WALK: mid-trot, front-left and rear-right legs forward, ears bouncing, plume tail swaying.
12. HOP: mid-air jump, all four paws off the ground, ears flying up, tail up.
13. SLEEP: curled into a tight ball, nose tucked to tail, plume tail draped over the body, eyes closed,
    a small "z z" floating above. Wide landscape framing (this becomes the 32×24 sleeping sprite).
14. STRETCH / waking: front legs stretched forward, rear up, big yawn, ears forward.
15. Face close-ups only: the head at very large scale showing the six faces side by side:
    happy, neutral, worried, exhausted, out (X eyes), confused. Same head, only the face changes.

## What happens next (Fable)
- Re-author the 48×48 master pose pixel by pixel from the hero (chibi proportions, ≈40 % head).
- Derive every frame from the master with the generator (`art/frames.mjs`), using the pose images as guides.
- Render the gallery (`npm run sprites`) for Victor's approval BEFORE wiring the sheet into the app.

## Header v2 — for the second (fluffy, natural-proportion) design Victor chose on 2026-09-08
This is Walder, my pixel-art golden long-haired miniature dachshund (Panel A is the reference).
For every image I ask for next: draw THE SAME DOG with the SAME look as Panel A: natural dachshund
proportions with a slightly enlarged head and big round dark eyes with one white highlight, very fluffy
long feathered ears, cream chest and belly feathering, a full plume tail, short legs. Use EXACTLY the
palette from the sheet (cream #FFF3D6, light #FFE3A6, gold #FFC67D, honey #E3A454, amber #C47A30,
shadow #A25F21, dark #7A451A, outline #5F3415 and #3E2411, nose #1F1208), Pokémon Black/White pixel
style: crisp hand-placed pixels, no anti-aliasing, no gradients, no blur. One single dog per image,
large (fill the canvas), three-quarter view facing LEFT, plain flat light-grey background, no text,
no props, no scene. Square 2048×2048 output.

Decisions for this design: author on a **64×64** stand grid (48 cannot hold the fur), sleep grid 40×28;
palette letters map to the sheet's hex codes (o=#5F3415, k/outline-dark=#3E2411, n=#1F1208, d=#A25F21,
m=#E3A454, l=#FFC67D, h=#FFE3A6, a/cream=#FFF3D6, extra shadow #C47A30 and #7A451A, blue z #4BA2E1/#9CD7FF,
heart #FF6188). Sizes: small 1x (64 px), medium 2x (128 px, default), large 3x (192 px, optional).

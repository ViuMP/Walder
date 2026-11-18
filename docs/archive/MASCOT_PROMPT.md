# Walder mascot design sheet — prompt for ChatGPT / Gemini / Claude Design / Adobe

Paste the block below into each tool. Attach your five reference images (the chibi pixel dachshunds and the
long-haired coat chart) when the tool allows attachments. Per-tool notes are at the bottom.

---

## THE PROMPT

Design a **pixel-art mascot design sheet** for **Walder**, a **golden long-haired miniature dachshund**. Walder is a
small always-on-top desktop companion (macOS and Windows) that shows how much of my Claude and ChatGPT usage is left,
so he needs clear facial expressions, a few short animations, and a coat-colour system.

### Style (this matters most)
- **Nintendo DS Pokémon pixel art**, specifically the look of Pokémon Black/White battle sprites and Diamond/Pearl
  overworld sprites: clean hand-placed pixels, **no anti-aliasing, no gradients, no blur, no dithering** except a
  one- or two-pixel fur hint on ear and tail fringes.
- **Chibi proportions**: the head is about **40 % of the body length**, big rounded skull, short muzzle. Body is a soft,
  slightly arched loaf, not a straight rectangle. Legs are short and stubby with visible paws.
- **Eyes are the star**: large, round, dark brown, about a fifth of the head height, each with a **one-pixel white
  highlight**. Small black nose, tiny mouth line. Friendly, calm, a little sleepy. Cute, not cartoon-crazy.
- **Long-haired coat**: feathered ears that hang past the jaw with a wavy fringe, a fluffy cream chest bib, a soft
  fringe under the belly and behind the legs, and a **feathered plume tail** carried up in a gentle curve.
- **Palette**: at most **16 colours including transparency**. Golden coat with four to five tones: cream highlight,
  golden light, honey mid, amber shadow, and a **dark warm-brown outline** (never pure black on the coat). Outline
  every silhouette; use inner lines only where forms overlap (ear over neck, leg over body).
- **View**: side-on **three-quarter view facing left**, face turned slightly toward the viewer so both eyes show.
  Feet on a fixed ground line so he can stand on the bottom edge of the screen.
- **Transparent background** everywhere (checkerboard or plain flat colour is acceptable if transparency is not
  possible; never a scene).

### Size
- Standing frames on a **48 × 48 pixel grid**. Sleeping/curled frames on a **32 × 24 pixel grid**. Decorations
  (heart, question mark, sleep "z", sweat drop) each within **8 × 8**.
- Show everything **enlarged with nearest-neighbour scaling** (6x or 8x) so the pixels are crisp and countable, and
  also include the true 1x size next to the hero pose. He will be shown on screen at 2x (medium) and at most 3x.

### Sheet layout (one image, or one artboard per panel)
**Panel A — Hero.** Walder standing, neutral-calm face, at 8x and at 1x, with a small colour swatch strip showing
the exact palette used (hex values if the tool can write them).

**Panel B — Six expressions**, same pose, only the face changes. Label each:
1. **Happy** (usage under 50 %): bright eyes, raised brows, slight smile, tail up.
2. **Neutral** (50–80 %): calm, mouth closed.
3. **Worried** (80–95 %): brows angled in, ears drooped one pixel lower, one sweat drop.
4. **Exhausted** (95–100 %): half-closed eyes, tongue out panting, ears flat.
5. **Out** (limit reached): lying flat, eyes closed or X-eyes, tail down.
6. **Confused** (no data): head tilted, one ear lifted, a floating question mark.

**Panel C — Coat colours.** The same neutral pose in five palettes: **golden** (default, Walder's real coat),
**red**, **cream**, **black-and-tan** (black body with grey points), **chocolate** (with tan
points). Only the colours change; the pixels stay identical.

**Panel D — Animation strips.** One horizontal strip per animation, frames left to right with a one-cell gap, each
frame on its own 48×48 (or 32×24) cell, labelled with the frame count and playback speed below. Follow the Pokémon
Black/White cadence: frames are **held**, not smooth 30 fps; most loops play at about **8–10 frames per second**,
short reactions up to **12 fps**, sleep at **1–2 fps**. Frame counts:

| Animation | Frames | Speed | Notes |
|---|---|---|---|
| Idle (breathe) | 4 | 8 fps, loops forever | 1-px chest rise and body bob, ears and tail lag one frame behind the body |
| Idle rare (ear flick / head shake) | 4 | 10 fps, plays once every ~4 idle loops | the Pokémon B/W "rare animation" trick |
| Blink | 2 | 12 fps, inserted into idle every 3–5 s | half-closed, closed |
| Walk (trot) | 4 | 8 fps, loops | Diamond/Pearl overworld-style two-beat trot, ears bounce, plume sways |
| Tail wag | 4 | 10 fps, loops | plume swings 2 px with the tip lagging |
| Bark | 4 | 10 fps, plays once | mouth open, one-pixel forward lean, two tiny motion lines |
| Pet (being stroked) | 6 | 8 fps, plays once | eyes close to happy arcs, head pushes up, two small hearts float up (heart: 2 frames, 4 fps) |
| Hop (excited) | 5 | 10 fps, plays once | squash, launch, airborne, land squash, settle |
| Perk (alert, "done") | 3 | 10 fps, hold last frame | head lifts, ears flare out and up, eyes wide, tail up |
| Tilt (curious, "waiting for you") | 3 | 8 fps, hold last frame | head tilts 1–2 px, one ear lifts, question mark appears |
| Sleep (curled, 32×24) | 3 | 1 fps, loops | curled up, plume over the body, chest rises one pixel; "z z" 2 frames at 1 fps |
| Wake / stretch | 4 | 8 fps, plays once | eyes open, front stretch, shake, stand |
| Out (collapsed) | 2 | 1 fps, loops | lying flat, tiny breath |

**Panel E — Small pieces.** The 32×24 sleeping sprite at 1x and 4x; heart (7×6), question mark (5×8), "z" (8×8),
sweat drop (3×4); and a speech-bubble sample in matching pixel style (white fill, 2-px dark outline, small tail) with
the text "5-hour: 80%".

### Rules for the tool
- Keep every frame on the same grid and the same ground line so frames can be swapped without the dog sliding.
- Same outline colour, same palette, across all frames and expressions.
- No text inside the sprites; labels go beside the panels.
- Do not add props, backgrounds, collars or accessories. No hot-dog bun.

---

## Per-tool notes

- **ChatGPT (image) / Gemini (image) / Adobe Firefly:** image models cannot hold an exact pixel grid. Ask for the
  sheet anyway and treat the result as a **style and proportion reference**; the final sprites are re-drawn pixel by
  pixel from the winner. If the output is blurry, add: "render as crisp large pixels, nearest-neighbour upscaled,
  no smoothing".
- **Claude Design:** ask for one artboard per panel and say "author each sprite as an inline SVG of square rects on a
  48×48 grid so the pixels are exact". That gives real, countable pixels.
- **Adobe Express:** use the prompt for a style board, then place the panels on one 1600×2000 page.
- When you have your favourite, send it back here (an image is enough). I will re-author Walder's sprite data from
  it, run the animation gallery so you can approve the motion, and only then wire it into the app.

/**
 * The animation gallery — the page the owner approves Walder's *motion* on.
 *
 * `art/out/` already holds a PNG of every frame and a contact sheet per coat, and
 * none of that answers the questions that actually matter: is the idle breathe
 * too fast, does the tail wag read as a wag, does the hop land, is the blink long
 * enough to see and short enough not to look like a nap. Only the animation
 * playing at its real durations answers those, and before this page the only way
 * to see one was to run the whole app and wait for the mascot to happen to do it.
 *
 * Three decisions worth knowing about:
 *
 *  - **The timing is not reimplemented here.** Every clock on this page is
 *    `advanceFrames` from `src/core/anim-schedule.ts`, the same pure module the
 *    overlay runs. That is the entire point: a gallery with its own timing loop
 *    would be asking the owner to approve motion the app does not produce.
 *  - **The sheet is read directly, not over IPC.** A static import of the same
 *    `src/sprites/walder.json` the app draws, chosen by the same
 *    `chooseSheetSource`. So the window needs no preload and no bridge into the
 *    main process at all (see `main/gallery-window.ts`).
 *  - **4x, and one card per animation.** 4x is above the app's largest size (3x)
 *    on purpose — this is a review tool, and a flaw that is invisible at 3x is
 *    still a flaw. Every animation in the sheet gets a card, including the
 *    decorations (`heart`, `zz`, `qmark`, `sweat`), because a gallery that showed
 *    a curated subset would be a place for art to hide.
 */
import placeholder from '../sprites/placeholder.json';
import walder from '../sprites/walder.json';
import { SpriteSheetError, validateSheet, type Animation, type SpriteSheet } from '../sprites/types';
import { FALLBACK_PALETTE, boxSize, chooseSheetSource } from '../sprites/contract';
import { devicePixelScale, renderFrame } from '../sprites/render';
import { FRESH_CLOCK, advanceFrames, timingOf, type FrameClock } from '../core/anim-schedule';

/** Logical pixels per sprite pixel. Above the app's 3x maximum, deliberately. */
const SCALE = 4;

/** Colour of the 1-px grid overlay: light enough to see, faint enough to ignore. */
const GRID_INK = 'rgba(255, 255, 255, 0.16)';

interface Card {
  readonly name: string;
  readonly animation: Animation;
  /** The whole card, for the caller to append. */
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** Sprite-pixel dimensions of this animation's box. */
  readonly box: { readonly width: number; readonly height: number };
  clock: FrameClock;
  /** Repaint even if the frame index did not move (a coat or grid change). */
  dirty: boolean;
}

const cards: Card[] = [];
let paletteName = FALLBACK_PALETTE;
let showGrid = false;
let sheet: SpriteSheet | null = null;

/* ------------------------------------------------------------------ helpers */

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`gallery: no #${id} in the page`);
  return node as T;
}

/**
 * Report a broken sheet in the page rather than the console.
 *
 * The owner runs this, not a developer, and a blank window with the reason in a
 * devtools panel he will never open is indistinguishable from a crash.
 */
function fail(message: string): void {
  const box = el<HTMLDivElement>('error');
  box.textContent = message;
  box.hidden = false;
  el<HTMLSpanElement>('summary').textContent = 'could not load the sheet';
}

/**
 * "4 frames · 125 ms each" when the durations are uniform, and the actual list
 * when they are not (`ear_flop` is 120 then 180, and that asymmetry is the
 * animation — it must be visible here or nobody would know to check it).
 */
function describeTiming(animation: Animation): string {
  const { durationsMs, frames } = animation;
  const count = `${frames.length} frame${frames.length === 1 ? '' : 's'}`;
  const first = durationsMs[0];
  const uniform = first !== undefined && durationsMs.every((ms) => ms === first);
  if (uniform) {
    const fps = Math.round(1_000 / first);
    return `${count} · ${first} ms each · ${fps} fps`;
  }
  return `${count} · ${durationsMs.join(', ')} ms`;
}

/** `loop`, `one-shot`, or `one-shot, holds` — how this animation ends. */
function describeEnding(animation: Animation): { text: string; hold: boolean } {
  if (animation.loop) return { text: 'loop', hold: false };
  if (animation.hold) return { text: 'holds last frame', hold: true };
  return { text: 'one-shot', hold: false };
}

/** The chosen coat, or golden if the sheet somehow lacks it. */
function currentPalette(loaded: SpriteSheet): { name: string; colors: Record<string, string> } {
  const chosen = Object.hasOwn(loaded.palettes, paletteName)
    ? loaded.palettes[paletteName]
    : undefined;
  if (chosen !== undefined) return { name: paletteName, colors: chosen };
  const fallback = loaded.palettes[FALLBACK_PALETTE];
  if (fallback === undefined) throw new SpriteSheetError('no palettes to draw with');
  return { name: FALLBACK_PALETTE, colors: fallback };
}

/* ------------------------------------------------------------------ drawing */

/**
 * One sprite-pixel grid over the frame, for judging alignment.
 *
 * Drawn in *device* pixels at the same `devicePixelScale` the sprite was
 * rasterised at, so the lines land exactly on the pixel boundaries rather than
 * drifting across them on a fractional display ratio.
 */
function drawGrid(card: Card, pixelScale: number): void {
  const { ctx, box } = card;
  ctx.save();
  ctx.strokeStyle = GRID_INK;
  ctx.lineWidth = 1;
  for (let x = 0; x <= box.width; x++) {
    // The 0.5 offset puts a 1-device-pixel line *on* the boundary instead of
    // straddling it, which would render as a 2-pixel blur.
    const px = Math.round(x * pixelScale) + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, box.height * pixelScale);
    ctx.stroke();
  }
  for (let y = 0; y <= box.height; y++) {
    const py = Math.round(y * pixelScale) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(box.width * pixelScale, py);
    ctx.stroke();
  }
  ctx.restore();
}

function paint(card: Card, loaded: SpriteSheet): void {
  const { ctx, canvas, animation, clock } = card;
  const frameName = animation.frames[clock.index % animation.frames.length];
  if (frameName === undefined) return;
  const frame = loaded.frames[frameName];
  if (frame === undefined) return;

  const dpr = window.devicePixelRatio || 1;
  const pixelScale = devicePixelScale(SCALE, dpr);
  const palette = currentPalette(loaded);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  renderFrame(
    { frame, frameName, palette: palette.colors, paletteName: palette.name, scale: SCALE, dpr },
    ctx
  );
  if (showGrid) drawGrid(card, pixelScale);
}

/**
 * Size a card's canvas: CSS pixels for layout, device pixels for the backing
 * store, and no `ctx.scale` anywhere — the rasteriser already works in device
 * pixels, and scaling the context on top of that is what makes pixel art wobble.
 */
function sizeCanvas(card: Card): void {
  const dpr = window.devicePixelRatio || 1;
  const pixelScale = devicePixelScale(SCALE, dpr);
  card.canvas.width = card.box.width * pixelScale;
  card.canvas.height = card.box.height * pixelScale;
  card.canvas.style.width = `${card.box.width * SCALE}px`;
  card.canvas.style.height = `${card.box.height * SCALE}px`;
  card.ctx.imageSmoothingEnabled = false;
}

/* -------------------------------------------------------------------- cards */

function buildCard(loaded: SpriteSheet, name: string, animation: Animation): Card | null {
  const firstFrame = animation.frames[0];
  if (firstFrame === undefined) return null;
  const frame = loaded.frames[firstFrame];
  if (frame === undefined) return null;

  const article = document.createElement('article');
  article.className = 'card';

  const top = document.createElement('div');
  top.className = 'top';
  const title = document.createElement('h2');
  title.textContent = name;
  const ending = describeEnding(animation);
  const tag = document.createElement('span');
  tag.className = ending.hold ? 'tag hold' : 'tag';
  tag.textContent = ending.text;
  top.append(title, tag);

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = describeTiming(animation);

  article.append(top, canvas, meta);

  const card: Card = {
    name,
    animation,
    element: article,
    canvas,
    ctx,
    box: boxSize(loaded, frame.box),
    clock: FRESH_CLOCK,
    dirty: true
  };

  // A one-shot has stopped by the time the owner looks up from the card above
  // it, so it needs its own way back. A loop needs no button — it is still going.
  if (!animation.loop) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Play once';
    button.addEventListener('click', () => {
      card.clock = FRESH_CLOCK;
      card.dirty = true;
    });
    article.append(button);
  }

  sizeCanvas(card);
  return card;
}

/* --------------------------------------------------------------------- loop */

/**
 * One animation frame for the whole page.
 *
 * A single `requestAnimationFrame` loop rather than a timer per card: there are
 * twenty-odd cards, and `advanceFrames` decides for each of them whether
 * anything is actually due, so the loop costs one cheap pass per display refresh
 * and repaints only what moved. The overlay sleeps until `nextFrameDueAt`
 * instead, because it has to stay under 1 % CPU forever; this page is open for a
 * few minutes while someone looks at it.
 */
function tick(): void {
  const loaded = sheet;
  if (loaded === null) return;
  const now = performance.now();

  for (const card of cards) {
    const step = advanceFrames(card.clock, timingOf(card.animation), now);
    card.clock = step.clock;
    if (step.changed || card.dirty) {
      paint(card, loaded);
      card.dirty = false;
    }
  }

  requestAnimationFrame(tick);
}

/* --------------------------------------------------------------------- boot */

function buildPaletteSwitcher(loaded: SpriteSheet): void {
  const select = el<HTMLSelectElement>('palette');
  for (const name of Object.keys(loaded.palettes)) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    select.append(option);
  }
  select.value = Object.hasOwn(loaded.palettes, paletteName) ? paletteName : FALLBACK_PALETTE;
  paletteName = select.value;
  select.addEventListener('change', () => {
    paletteName = select.value;
    for (const card of cards) card.dirty = true;
  });
}

function boot(): void {
  const source = chooseSheetSource(walder, placeholder);

  let loaded: SpriteSheet;
  try {
    loaded = validateSheet(source.json);
  } catch (error) {
    fail(
      `${source.name} could not be read.\n\n${error instanceof Error ? error.message : String(error)}` +
        `\n\nRun "npm run sync:sheet" to copy art/walder.json into the app.`
    );
    return;
  }
  sheet = loaded;

  const names = Object.keys(loaded.animations);
  el<HTMLSpanElement>('summary').textContent =
    `${source.name}${source.isReal ? '' : ' (placeholder — no art synced)'} · ` +
    `${names.length} animations · ${Object.keys(loaded.frames).length} frames · ` +
    `${Object.keys(loaded.palettes).length} coats · drawn at ${SCALE}x`;

  buildPaletteSwitcher(loaded);

  const container = el<HTMLElement>('cards');
  for (const name of names) {
    const animation = loaded.animations[name];
    if (animation === undefined) continue;
    const card = buildCard(loaded, name, animation);
    if (card === null) continue;
    cards.push(card);
    container.append(card.element);
  }

  el<HTMLInputElement>('grid').addEventListener('change', (event) => {
    showGrid = (event.currentTarget as HTMLInputElement).checked;
    for (const card of cards) card.dirty = true;
  });

  el<HTMLButtonElement>('replay').addEventListener('click', () => {
    for (const card of cards) {
      if (card.animation.loop) continue;
      card.clock = FRESH_CLOCK;
      card.dirty = true;
    }
  });

  // A window dragged to a monitor with a different ratio needs every backing
  // store resized, or the sprites go soft.
  window.addEventListener('resize', () => {
    for (const card of cards) {
      sizeCanvas(card);
      card.dirty = true;
    }
  });

  requestAnimationFrame(tick);
}

boot();

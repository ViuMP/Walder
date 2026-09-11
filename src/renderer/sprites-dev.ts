/**
 * The animation gallery — the page the owner approves Walder's *motion* on.
 *
 * `art/out/` already holds a PNG of every frame and a contact sheet per coat, and
 * none of that answers the questions that actually matter: does the idle stay
 * still between blinks, does the tail wag read as a wag, does the hop land, is
 * the blink long enough to see and short enough not to look like a nap. Only the animation
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
 *    decorations (`heart`, `qmark`, `zz`), because a gallery that showed a
 *    curated subset would be a place for art to hide.
 *  - **The coat switcher swaps frame sets, not just colours.** Silver dapple is
 *    a second drawing of every frame (`framesFor`), so the switcher is where the
 *    owner checks that both coats are the same dog at the same size — which is
 *    exactly what he cannot check in `art/out/`, where each coat is its own
 *    folder of PNGs.
 */
import placeholder from '../sprites/placeholder.json';
import walder from '../sprites/walder.json';
import { SpriteSheetError, validateSheet, type Animation, type SpriteSheet } from '../sprites/types';
import {
  FALLBACK_PALETTE,
  boxSize,
  chooseSheetSource,
  decorAnchorFor,
  framesFor,
  visibleDecors
} from '../sprites/contract';
import { devicePixelScale, frameSize, renderFrame } from '../sprites/render';
import { mirrorAnchorX } from '../core/facing';
import {
  FRESH_CLOCK,
  advanceFrames,
  idleExtras,
  initIdle,
  onIdleLoop,
  timingOf,
  type FrameClock,
  type FrameTiming,
  type IdleExtras,
  type IdleState
} from '../core/anim-schedule';

/** Logical pixels per sprite pixel. Above the app's 3x maximum, deliberately. */
const SCALE = 4;

/** Colour of the 1-px grid overlay: light enough to see, faint enough to ignore. */
const GRID_INK = 'rgba(255, 255, 255, 0.16)';

/** Colour of the anchor cross. Loud, because it is only on when asked for. */
const ANCHOR_INK = 'rgba(120, 230, 255, 0.95)';

/** Arm length of the anchor cross, in sprite pixels. */
const ANCHOR_CROSS_PX = 3;

interface Card {
  readonly name: string;
  readonly animation: Animation;
  /**
   * `timingOf(animation)`, taken once when the card is built.
   *
   * The animation never changes for the life of a card, so its timing does not
   * either — but it used to be re-derived inside the `requestAnimationFrame`
   * loop, which meant a fresh object allocated per card per display refresh:
   * twenty-odd cards at 120 Hz is ~2,400 short-lived objects a second, all
   * identical, for a page whose whole job is to look smooth while someone
   * studies the motion on it.
   */
  readonly timing: FrameTiming;
  /** The whole card, for the caller to append. */
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** Sprite-pixel dimensions of this animation's box. */
  readonly box: { readonly width: number; readonly height: number };
  /** The canvas's own extent: the box plus any decoration anchored outside it. */
  readonly extent: CardExtent;
  readonly extras: IdleExtras;
  idle: IdleState;
  playing: { readonly animation: Animation; readonly timing: FrameTiming } | null;
  clock: FrameClock;
  /** Repaint even if the frame index did not move (a coat or grid change). */
  dirty: boolean;
}

/**
 * How big a card's canvas has to be, and where the animation's box sits inside it.
 *
 * The sheet's own validator keeps every anchor inside its animation's box today
 * (`parseDecorAnchors`), so this is the box itself and both offsets are zero.
 * It is computed as a union anyway: the gallery is where the owner *approves* the
 * anchors, and a card that silently clipped a decoration hanging off the box
 * would be the one place the mistake could hide.
 */
interface CardExtent {
  readonly width: number;
  readonly height: number;
  /** Sprite-pixel offset of the animation's box within the canvas. */
  readonly dogX: number;
  readonly dogY: number;
}

const cards: Card[] = [];
let paletteName = FALLBACK_PALETTE;
let showGrid = false;
/**
 * Draw every card mirrored, as the app does when the dog stands on the left half
 * of a display (`core/facing.ts`).
 *
 * Here so the owner can approve the *mirror* rather than discover it on his
 * desktop: a coat whose highlights only work facing one way, a decoration anchor
 * that lands on the wrong side of the head, and a glyph that was accidentally
 * mirrored with the dog are all invisible until something flips.
 */
let mirror = false;
/**
 * Mark each declared decoration anchor with a cross at its top-left corner.
 *
 * The anchors are the one part of the sheet nobody can check by looking at the
 * result: a `?` two pixels off the ear looks like a `?` two pixels off the ear
 * whether the anchor is wrong or the ear moved. With the cross on, the owner can
 * see the number the art declared, and see it flip when the mirror does.
 */
let showAnchors = false;
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
 * when they are not. Every animation the pipeline emits today is uniform, but a
 * non-uniform one would be an asymmetry that *is* the animation — it has to be
 * visible here or nobody would know to check it.
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
  // Over the animation's box, not the whole canvas: the grid is for judging the
  // dog's alignment, and it would be misread as the box edge if it covered the
  // extra room a decoration's extent can add.
  ctx.translate(card.extent.dogX * pixelScale, card.extent.dogY * pixelScale);
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
  const { ctx, canvas, clock } = card;
  const animation = card.playing?.animation ?? card.animation;
  const frameName = animation.frames[clock.index % animation.frames.length];
  if (frameName === undefined) return;

  const dpr = window.devicePixelRatio || 1;
  const pixelScale = devicePixelScale(SCALE, dpr);
  const palette = currentPalette(loaded);
  // The chosen coat's own drawing, which for silver dapple is a different set of
  // pixels rather than the same ones in different colours.
  const frames = framesFor(loaded, palette.name);
  const frame = frames[frameName];
  if (frame === undefined) return;
  const { dogX, dogY } = card.extent;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(dogX * pixelScale, dogY * pixelScale);
  renderFrame(
    {
      frame,
      frameName,
      palette: palette.colors,
      paletteName: palette.name,
      scale: SCALE,
      dpr,
      mirrored: mirror
    },
    ctx
  );
  ctx.restore();

  // Exactly what the app would draw over this frame — same table, same anchors,
  // same "never mirror the glyph" rule. `null` for the bubble kind: the gallery
  // says nothing, so only the frame-driven decorations appear.
  for (const decor of visibleDecors(loaded, card.name, frameName, null)) {
    const anchor = decorAnchorFor(loaded, card.name, decor);
    if (anchor === null) continue;
    const decorFrameName = loaded.animations[decor]?.frames[0];
    if (decorFrameName === undefined) continue;
    const decorFrame = frames[decorFrameName];
    if (decorFrame === undefined) continue;

    const x = mirror
      ? mirrorAnchorX(anchor.x, card.box.width, frameSize(decorFrame).width)
      : anchor.x;

    ctx.save();
    ctx.translate((dogX + x) * pixelScale, (dogY + anchor.y) * pixelScale);
    renderFrame(
      {
        frame: decorFrame,
        frameName: decorFrameName,
        palette: palette.colors,
        paletteName: palette.name,
        scale: SCALE,
        dpr,
        mirrored: false
      },
      ctx
    );
    ctx.restore();
  }

  if (showAnchors) drawAnchors(card, loaded, pixelScale);
  if (showGrid) drawGrid(card, pixelScale);
}

/**
 * A cross at the top-left corner of every anchor this animation declares.
 *
 * Every anchor, not only the ones showing: `pet` may declare a `heart` anchor
 * the app never uses, and an anchor nothing draws is exactly the kind of thing
 * that should be visible while the art is being approved.
 */
function drawAnchors(card: Card, loaded: SpriteSheet, pixelScale: number): void {
  const anchors = loaded.decorAnchors[card.name];
  if (anchors === undefined) return;
  const { ctx } = card;
  const { dogX, dogY } = card.extent;

  ctx.save();
  ctx.strokeStyle = ANCHOR_INK;
  ctx.lineWidth = 1;
  for (const [decor, anchor] of Object.entries(anchors)) {
    const decorBox = loaded.boxes[decor];
    const x = mirror && decorBox !== undefined
      ? mirrorAnchorX(anchor.x, card.box.width, decorBox[0])
      : anchor.x;
    // Half a device pixel off the boundary, or a 1-px line renders as a 2-px blur.
    const px = Math.round((dogX + x) * pixelScale) + 0.5;
    const py = Math.round((dogY + anchor.y) * pixelScale) + 0.5;
    const arm = ANCHOR_CROSS_PX * pixelScale;
    ctx.beginPath();
    ctx.moveTo(px - arm, py);
    ctx.lineTo(px + arm, py);
    ctx.moveTo(px, py - arm);
    ctx.lineTo(px, py + arm);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Size a card's canvas: CSS pixels for layout, device pixels for the backing
 * store, and no `ctx.scale` anywhere — the rasteriser already works in device
 * pixels, and scaling the context on top of that is what makes pixel art wobble.
 */
function sizeCanvas(card: Card): void {
  const dpr = window.devicePixelRatio || 1;
  const pixelScale = devicePixelScale(SCALE, dpr);
  const { width, height } = card.extent;
  card.canvas.width = width * pixelScale;
  card.canvas.height = height * pixelScale;
  card.canvas.style.width = `${width * SCALE}px`;
  card.canvas.style.height = `${height * SCALE}px`;
  card.ctx.imageSmoothingEnabled = false;
}

/**
 * The union of the animation's box and every decoration anchored in it.
 *
 * Anchors are box-relative and may in principle sit at a negative coordinate
 * (the validator forbids it today), so the union is expressed as a size plus the
 * offset the *dog* has to be drawn at inside it. With in-box anchors that offset
 * is `(0, 0)` and the extent is the box, which is why nothing in the gallery
 * moved when this landed.
 */
function cardExtent(
  loaded: SpriteSheet,
  animationName: string,
  box: { readonly width: number; readonly height: number }
): CardExtent {
  let minX = 0;
  let minY = 0;
  let maxX = box.width;
  let maxY = box.height;

  for (const [decor, anchor] of Object.entries(loaded.decorAnchors[animationName] ?? {})) {
    const decorBox = loaded.boxes[decor];
    if (decorBox === undefined) continue;
    const [decorWidth, decorHeight] = decorBox;
    minX = Math.min(minX, anchor.x);
    minY = Math.min(minY, anchor.y);
    maxX = Math.max(maxX, anchor.x + decorWidth);
    maxY = Math.max(maxY, anchor.y + decorHeight);
  }

  return { width: maxX - minX, height: maxY - minY, dogX: -minX, dogY: -minY };
}

/* -------------------------------------------------------------------- cards */

function buildCard(loaded: SpriteSheet, name: string, animation: Animation): Card | null {
  const firstFrame = animation.frames[0];
  if (firstFrame === undefined) return null;
  // Read through `framesFor` for symmetry with `paint`, though any set would do:
  // `parseFrameSets` proves every set draws the same names in the same boxes, so
  // the card's geometry does not change when the coat does.
  const frame = framesFor(loaded, paletteName)[firstFrame];
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
  const extras = animation.loop
    ? idleExtras(name, (extra) => loaded.animations[extra] !== undefined)
    : { blink: null, rare: null };
  const still = animation.loop && animation.frames.length === 1;
  meta.textContent = [
    still ? 'Still pose' : describeTiming(animation),
    ...(extras.blink !== null ? ['occasional blink'] : []),
    ...(extras.rare !== null ? ['occasional idle gesture'] : [])
  ].join(' · ');

  article.append(top, canvas, meta);

  const box = boxSize(loaded, frame.box);
  const card: Card = {
    name,
    animation,
    timing: timingOf(animation),
    element: article,
    canvas,
    ctx,
    box,
    extent: cardExtent(loaded, name, box),
    extras,
    idle: initIdle(extras, performance.now()),
    playing: null,
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
    const step = advanceFrames(card.clock, card.playing?.timing ?? card.timing, now);
    card.clock = step.clock;
    // An idle card must show the same pause and blink as the desktop dog. A
    // bare one-frame loop would never blink here, while a gallery-only timer
    // would ask the owner to approve different timing. Keep each card's base
    // loop and temporary interjection separate, and use the overlay's scheduler
    // at lap boundaries; a finished blink returns to the unchanged base pose.
    if (card.playing !== null && step.finished) {
      card.playing = null;
      card.clock = FRESH_CLOCK;
      card.dirty = true;
    } else if (
      card.playing === null && step.wrapped &&
      (card.extras.blink !== null || card.extras.rare !== null)
    ) {
      const decision = onIdleLoop(card.idle, card.extras, now, Math.random, step.laps);
      card.idle = decision.state;
      const interjection = decision.play === null ? undefined : loaded.animations[decision.play];
      if (interjection !== undefined) {
        card.playing = { animation: interjection, timing: timingOf(interjection) };
        card.clock = FRESH_CLOCK;
        card.dirty = true;
      }
    }
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
  // The base set counts: `frameSets` holds only the alternatives.
  const frameSets = 1 + Object.keys(loaded.frameSets).length;
  el<HTMLSpanElement>('summary').textContent =
    `${source.name}${source.isReal ? '' : ' (placeholder — no art synced)'} · ` +
    `${names.length} animations · ${Object.keys(loaded.frames).length} frames · ` +
    `${frameSets} frame set${frameSets === 1 ? '' : 's'} · ` +
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

  el<HTMLInputElement>('mirror').addEventListener('change', (event) => {
    mirror = (event.currentTarget as HTMLInputElement).checked;
    for (const card of cards) card.dirty = true;
  });

  el<HTMLInputElement>('anchors').addEventListener('change', (event) => {
    showAnchors = (event.currentTarget as HTMLInputElement).checked;
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

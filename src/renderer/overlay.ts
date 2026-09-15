/**
 * Walder — overlay renderer.
 *
 * Draws the mascot and owns the pixel hit test. The window is click-through by
 * default, so this side is what decides when the dog should accept a click: on
 * every mouse move it converts the cursor to logical sprite coordinates and asks
 * the current frame's alpha mask whether there is ink there. Only *crossings* are
 * reported to main (`hit:set`), never every move — the main process changes
 * window state, which is expensive and must not run 60 times a second. The two
 * state machines that decide all of that (hover and drag) are pure functions in
 * `src/core/interaction.ts`; this file is only the DOM wiring around them.
 *
 * **Scheduling.** The clock is `setTimeout`, not `requestAnimationFrame`: the
 * next thing that can possibly change the picture is the end of the current
 * animation frame, which the durations table already knows, so the loop sleeps
 * exactly that long and `rAF` is used only to paint once it wakes. A permanently
 * re-armed `rAF` would wake 60 times a second to compare two timestamps, which
 * for a mascot that must stay under 1 % idle CPU is most of the budget spent on
 * discovering there is nothing to do. With a two-frame idle loop at 500 ms this
 * wakes twice a second; with a non-looping animation finished, not at all.
 *
 * **Device pixels.** The canvas backing store is sized in device pixels and every
 * draw is done in device pixels — there is no `ctx.scale(dpr, dpr)`. A fractional
 * ratio (1.5, 2.25) multiplied into the sprite scale gives a fractional pixel
 * size, and rounding *that* per pixel makes some sprite pixels a device pixel
 * wider than their neighbours: on pixel art the dog visibly wobbles. Instead the
 * bitmap is rasterised at a whole number of device pixels per sprite pixel (see
 * `devicePixelScale`) and blitted at that exact size. Hit testing stays in CSS
 * pixels, which is what the browser reports and what the sprite's CSS-pixel
 * placement is computed in.
 */
import { HIT_DILATE_PX, OFF_SPRITE, isOpaqueAt, toLogical } from '../core/hittest';
import {
  ART_FACING,
  isFacing,
  isMirrored,
  mirrorAnchorX,
  mirrorBounds,
  mirrorLogicalX,
  type Facing
} from '../core/facing';
import { bubbleFontPx, spriteOrigin } from '../core/geometry';
import { pickAnimation, type Expression } from '../core/expression';
import { bubbleShape, wrapBubbleText, type BubbleKind } from '../core/bubble';
import type { PlayThen } from '../core/behaviour';
import {
  FRESH_CLOCK,
  advanceFrames,
  canInterject,
  idleExtras,
  initIdle,
  nextFrameDueAt,
  onIdleLoop,
  playOutcome,
  resolveThen,
  timingOf,
  type FrameClock,
  type IdleExtras,
  type IdleState
} from '../core/anim-schedule';
import {
  HOVER_INITIAL,
  dragBegin,
  dragTo,
  hoverLeave,
  hoverMove,
  hoverResync,
  hoverRetest,
  isClick,
  type DragState,
  type HoverDecision,
  type HoverState
} from '../core/interaction';
import {
  devicePixelScale,
  frameAlphaMask,
  frameSize,
  maskBounds,
  renderFrame
} from '../sprites/render';
import {
  bubbleIsBakedIn,
  bubbleIsDrawnAsDecor,
  decorationPlacements,
  framesFor,
  mirrorReady,
  visibleDecors,
  type DecorName
} from '../sprites/contract';
import type { Animation, Frame, Palette, SpriteSheet } from '../sprites/types';
import type { BoxName, ModePayload, PalettePayload, ScenePayload } from '../main/ipc';

/** Palette every sheet defines; used when the chosen coat is not in the sheet. */
const FALLBACK_PALETTE = 'golden';

/** How long a pet wiggle lasts, and how often it flips, in ms. */
const PET_MS = 600;
const PET_STEP_MS = 100;


/* ------------------------------------------------------------ bubble styling */

/**
 * The universal bubble chrome: flat white fill, hard dark outline and a one-pixel
 * offset shadow. Speaking uses a stepped tail; sleeping uses thought dots. Every
 * dimension below is a whole number of *device* pixels, because a half-pixel edge
 * on a 2 px outline is exactly the soft grey smear that would make the bubble
 * look like it came from a different app than the dog.
 */
const BUBBLE_FILL = '#ffffff';
const BUBBLE_OUTLINE = '#22212a';
const BUBBLE_TEXT = '#22212a';
const BUBBLE_SHADOW = 'rgba(34, 33, 42, 0.35)';

/**
 * Monospace, so the wrap arithmetic in `core/bubble.ts` can work in columns:
 * every glyph is one `measureText('M')` wide, which is what lets the wrapping be
 * a pure, tested function instead of a measuring loop.
 */
const BUBBLE_FONT_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** Two lines at most; a third would not fit the reserve at the smallest size. */
const BUBBLE_MAX_LINES = 2;

/** Steps in the stepped tail, and its glyph height in bubble units. */
const TAIL_STEPS = 3;

const canvas = document.getElementById('dog') as HTMLCanvasElement | null;
const ctx = canvas?.getContext('2d') ?? null;
const debug = new URLSearchParams(window.location.search).get('debug') === '1';

/*
 * Renderer logging: silent unless the page was opened with `?debug=1`.
 *
 * A `console.*` call in this window is not a diagnostic anybody reads — the
 * page is loaded from `file://` in a packaged app, by a window that draws a dog
 * and has no devtools anyone is going to open. The real log is the main
 * process's (`main/log.ts`, with its redaction filter); this is the renderer
 * half, off by default for the same reason `vlog` is. `?debug=1` is the flag
 * that already turns on the hit-area outline, so one switch covers both.
 *
 * Deliberately duplicated in `panel.ts` rather than shared: a common module
 * would be hoisted into a second ESM chunk, and a `file://` document cannot
 * fetch a sibling module (opaque origin, blocked by CORS). Six lines beats a
 * blank window.
 */
function rwarn(...args: unknown[]): void {
  if (debug) console.warn('[walder]', ...args);
}

function rerror(...args: unknown[]): void {
  if (debug) console.error('[walder]', ...args);
}

/* ------------------------------------------------------------------- state */

let sheet: SpriteSheet | null = null;
/** What main asked for. Resolved lazily so sheet/palette can arrive in any order. */
let paletteRequest: PalettePayload = { name: FALLBACK_PALETTE, colors: null };
let warnedAbout = '';
let scale = 2;
let box: BoxName = 'stand';
/**
 * The face the last snapshot implies. Decided in main (`expressionForBuckets`)
 * and sent with the snapshot, so the dog and the panel can never disagree about
 * how bad things are. `confused` until the first snapshot arrives — honest, and
 * the restored snapshot usually arrives in the same tick as the first frame.
 */
let expression: Expression = 'confused';
/**
 * Which way the dog is looking. Decided in main, which is the only side that
 * knows which display the window is on (`core/facing.ts`), and arriving either
 * with `mode` (the first paint) or on `facing:set` (every turn after that).
 *
 * `ART_FACING` until then, so a renderer that somehow never hears is drawing the
 * frames exactly as they were painted rather than guessing.
 */
let facing: Facing = ART_FACING;
/**
 * Whether the *loaded sheet* can survive being mirrored — `mirrorReady`, cached.
 *
 * Recomputed exactly where `sheet` is assigned (`setSheet`), because that is the
 * only thing it depends on: it walks every animation's frame list looking for
 * anchors, which is cheap once per sheet load and wasteful sixty times a second.
 * `false` before any sheet arrives, which is also the safe answer.
 */
let sheetMirrorReady = false;

/**
 * Adopt a sheet, and re-derive everything that is a property of the sheet rather
 * than of the moment. One function so a new arrival can never update the sheet
 * and leave `sheetMirrorReady` describing the previous one — which would mirror
 * the dog on art that cannot take it, or refuse to on art that can.
 */
function setSheet(next: SpriteSheet): void {
  sheet = next;
  sheetMirrorReady = mirrorReady(next);
}

/**
 * Is the frame on screen actually being drawn mirrored right now?
 *
 * Two conditions, and both are needed: main says which way he is *looking*
 * (`facing`), and the sheet says whether turning him round is safe at all
 * (`sheetMirrorReady`, see `mirrorReady` in `sprites/contract.ts`).
 *
 * The single source for every consumer — the blit, the decoration anchors, the
 * hit test, the hover rect, the debug outline. Any two of those disagreeing is a
 * dog who swallows clicks a body-width from where he is drawn, so they read one
 * function rather than each recomputing `isMirrored(facing)`.
 */
function mirroredNow(): boolean {
  return isMirrored(facing) && sheetMirrorReady;
}

/** Which frame of the running animation is showing, and since when. */
let clock: FrameClock = FRESH_CLOCK;
/**
 * Blink / ear-flick bookkeeping, carried across idle laps.
 *
 * Rebuilt when a sheet arrives, because whether either exists at all is the
 * art's decision (`idleExtras`).
 */
let idle: IdleState = { loopsSinceRare: 0, blinkDueAt: null };
let lastBob = 0;
let petStartedAt = 0;
let dpr = window.devicePixelRatio || 1;
/** Set when the sprite's on-screen geometry changed, so hover must be re-derived. */
let needsHitTest = false;
/**
 * Is the window hidden by the hide-when-idle mode?
 *
 * The renderer has to know, because `backgroundThrottling: false` — which is
 * what keeps the dog animating while he is occluded or the app is in the
 * background, the mascot's whole job — means a *hidden* window goes on ticking
 * at full cadence as well. So the animation timer is stopped here
 * (`scheduleWake`) rather than left for the browser to notice.
 */
let hidden = false;

let hover: HoverState = HOVER_INITIAL;
let drag: DragState | null = null;

/* ------------------------------------------------------------- scene state */

/**
 * A one-off animation the behaviour coordinator asked for, overriding the
 * per-box/per-expression loop until it finishes.
 *
 * `queued` holds at most one follow-up, so a pair like "wake, then bark" plays
 * as one gesture instead of the wake being cut off after two frames. Only a
 * *non-looping* animation is ever waited for — a looping one would never finish
 * and the queue would stall — so a `play` arriving over a loop replaces it.
 */
interface Play {
  readonly animation: string;
  readonly then: PlayThen;
}

let playing: Play | null = null;
let queuedPlay: Play | null = null;
/** True once `playing` has run to its end and its `then` has been honoured. */
let playSettled = false;

/** The bubble currently on screen, or `null` for none. */
let bubble: { readonly text: string; readonly kind: BubbleKind } | null = null;

const maskCache = new WeakMap<Frame, Uint8ClampedArray>();

function maskFor(frame: Frame): Uint8ClampedArray {
  let mask = maskCache.get(frame);
  if (mask === undefined) {
    mask = frameAlphaMask(frame);
    maskCache.set(frame, mask);
  }
  return mask;
}

/* ---------------------------------------------------------------- selection */

/**
 * Which animation the current box and expression imply.
 *
 * The cascade lives in `pickAnimation` (pure, tested): a per-expression idle
 * loop if the art has one, `out`/`confused` as whole-body states if it has
 * those, plain `idle` otherwise. So art that ships one idle loop and art that
 * ships five both work with no change here.
 */
function baseAnimationName(): string {
  if (sheet === null) return 'idle';
  const animations = sheet.animations;
  return pickAnimation(box, expression, (name) => animations[name] !== undefined);
}

function currentAnimationName(): string {
  if (sheet === null) return 'idle';
  if (playing !== null) return playing.animation;
  return baseAnimationName();
}

/** Does the sheet have this animation, and does it end on its own? */
function isOneShot(name: string): boolean {
  return sheet?.animations[name]?.loop === false;
}

/** Does the art ask this animation to park on its last frame? */
function sheetHolds(name: string): boolean {
  return sheet?.animations[name]?.hold === true;
}

/** Start `next` now, from its first frame. */
function startPlay(next: Play): void {
  playing = next;
  queuedPlay = null;
  playSettled = false;
  clock = FRESH_CLOCK;
  needsHitTest = true;
}

/** Drop any override and go back to the normal per-box, per-expression loop. */
function releasePlay(): void {
  if (playing === null && queuedPlay === null) return;
  playing = null;
  queuedPlay = null;
  playSettled = false;
  clock = FRESH_CLOCK;
  needsHitTest = true;
}

/**
 * A `play` scene event.
 *
 * An animation the loaded sheet does not have is *not* an error and not a frozen
 * dog: the art and the behaviour advance separately, so an unknown name simply
 * releases the override and the normal loop for this box and expression takes
 * over (`idle`, or `sleep` in the sleeping box). That is the graceful fallback
 * the whole naming scheme exists for.
 */
function onPlay(animation: string, then: PlayThen): void {
  if (sheet === null) return;
  if (sheet.animations[animation] === undefined) {
    rwarn(`no "${animation}" animation in the sheet; falling back to the idle loop`);
    releasePlay();
    requestPaint();
    return;
  }

  const current = playing;
  if (current !== null && !playSettled && isOneShot(current.animation)) {
    queuedPlay = { animation, then };
    return;
  }
  startPlay({ animation, then });
  requestPaint();
}

/**
 * The running override reached its last frame: play whatever was queued, or
 * honour its `then`.
 *
 * `hold` parks on that last frame — what a head-tilt that must stay tilted while
 * the `?` is up needs. `idle` and `sleep` both release to the normal loop; which
 * one arrives says what the coordinator believes the box to be, and the box
 * itself decides what that loop is.
 *
 * The *art* can also ask to park, with `hold: true` on the animation, and it
 * wins over the request (`resolveThen`): `perk`'s last frame is ears-up and
 * `tilt`'s is head-cocked, and dropping either the instant the frames run out
 * would undo the gesture while its speech bubble is still on screen. Whatever
 * ends the moment releases the pose — the bubble being cleared, or the next
 * animation.
 */
function onPlayFinished(): boolean {
  if (playing === null || playSettled) return false;

  const next = queuedPlay;
  if (next !== null) {
    startPlay(next);
    return true;
  }

  playSettled = true;
  const then = resolveThen(playing.then, sheetHolds(playing.animation));
  if (playOutcome(then) === 'park') return false;
  releasePlay();
  return true;
}

/**
 * A parked pose has outlived what it was saying: let go of it.
 *
 * Called when a bubble is cleared, which is the end of the moment a `hold`
 * exists for — the `?` coming down, the woof timing out. Without this the dog
 * would stay head-cocked or ears-up until the next unrelated animation, which on
 * a quiet afternoon is a long time.
 */
function releaseHeldPose(): void {
  if (playing === null || !playSettled) return;
  if (playOutcome(resolveThen(playing.then, sheetHolds(playing.animation))) !== 'park') return;
  releasePlay();
  requestPaint();
}

function currentAnimation(): Animation | null {
  if (sheet === null) return null;
  return sheet.animations[currentAnimationName()] ?? null;
}

/**
 * The frame to draw, with its sheet name — the name is part of the raster cache key.
 *
 * Read through `framesFor` rather than off `sheet.frames`, because a coat the
 * palette cannot express (silver dapple, whose blotches are drawn rather than
 * remapped) carries its own drawing of every frame. The animation, the clock and
 * the frame *name* are the same either way — only the pixels differ — so the
 * coat can change mid-lap and the dog does not so much as blink. The raster
 * cache is already keyed by palette name as well as frame name, and the mask
 * cache is keyed by `Frame` identity, so both get a separate entry per coat for
 * free.
 */
function currentFrame(): { name: string; frame: Frame } | null {
  const animation = currentAnimation();
  const palette = activePalette();
  if (sheet === null || animation === null || palette === null) return null;
  const name = animation.frames[clock.index % animation.frames.length];
  if (name === undefined) return null;
  const frame = framesFor(sheet, palette.name)[name];
  if (frame === undefined) return null;
  return { name, frame };
}

/**
 * The palette to draw with, and the name to cache it under. An unknown coat name
 * falls back to golden and warns once — the colour menu offers all five variants
 * although the placeholder sheet only carries one, so this is an expected state,
 * not a bug. The *effective* name is returned, so a fallback shares one cache
 * entry with golden instead of one per unknown coat.
 */
function activePalette(): { name: string; colors: Palette } | null {
  if (paletteRequest.colors !== null) {
    return { name: paletteRequest.name, colors: paletteRequest.colors };
  }
  if (warnedAbout !== paletteRequest.name) {
    warnedAbout = paletteRequest.name;
    rwarn(
      `palette "${paletteRequest.name}" is not in the sheet; ` +
        `falling back to "${FALLBACK_PALETTE}"`
    );
  }
  const fallback = sheet?.palettes[FALLBACK_PALETTE];
  if (fallback === undefined) return null;
  return { name: FALLBACK_PALETTE, colors: fallback };
}

/**
 * Vertical offset in logical pixels: 0 or 1 while a pet wiggle is playing.
 * Clears the wiggle when it expires, so call it exactly once per paint — `paint`
 * does, and hands the result to everything else.
 */
function bobAt(now: number): number {
  if (petStartedAt === 0) return 0;
  const elapsed = now - petStartedAt;
  if (elapsed >= PET_MS) {
    petStartedAt = 0;
    return 0;
  }
  // Squash: the dog dips a pixel and springs back. Stands in for the real pet
  // frames, which arrive with the art.
  return Math.floor(elapsed / PET_STEP_MS) % 2 === 0 ? 1 : 0;
}

/* ------------------------------------------------------------------ drawing */

/** Where the sprite's top-left sits, in CSS pixels, including the bob. */
function spritePlacement(frame: Frame, bob: number): { x: number; y: number } {
  const { width, height } = frameSize(frame);
  const origin = spriteOrigin(window.innerWidth, window.innerHeight, width, height, scale);
  return { x: origin.x, y: origin.y + bob * scale };
}

function resizeCanvas(): void {
  if (canvas === null) return;
  const cssWidth = window.innerWidth;
  const cssHeight = window.innerHeight;
  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
}

function draw(bob: number): void {
  if (canvas === null || ctx === null) return;

  resizeCanvas();
  // Identity transform throughout: the backing store *is* device pixels, and
  // scaling the context by a fractional dpr is what makes pixel widths uneven.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const current = currentFrame();
  const palette = activePalette();
  if (current === null || palette === null) return;

  ctx.imageSmoothingEnabled = false;

  const at = spritePlacement(current.frame, bob);
  const device = { x: Math.round(at.x * dpr), y: Math.round(at.y * dpr) };
  // One decision, three consumers below: the dog, the decorations' anchor, and
  // the debug outline. The bubble is deliberately not one of them.
  const mirrored = mirroredNow();
  const animationName = currentAnimationName();

  ctx.save();
  ctx.translate(device.x, device.y);
  renderFrame(
    {
      frame: current.frame,
      frameName: current.name,
      palette: palette.colors,
      paletteName: palette.name,
      scale,
      dpr,
      mirrored
    },
    ctx
  );
  ctx.restore();

  // Between the dog and the bubble: a `?` belongs in front of his ear and behind
  // anything he is saying. Empty on sheets without anchors.
  const decors =
    sheet === null
      ? []
      : visibleDecors(sheet, animationName, current.name, bubble?.kind ?? null);
  if (decors.length > 0) {
    drawDecorations(decors, animationName, current.name, current.frame, device, mirrored, palette);
  }

  // The dog's *unbobbed* top edge: the bubble stays put while he wiggles, which
  // is what keeps the text readable through a pet. The animation and frame go
  // with it so the bubble can stay quiet about something the art is already
  // saying (`bubbleIsBakedIn`), and `decors` so it can stay quiet about
  // something *this* file has just drawn (`bubbleIsDrawnAsDecor`).
  drawBubble(at.y - bob * scale, animationName, current.name, decors);

  if (debug) drawHitOutline(current.frame, device, mirrored);
}

/**
 * The decoration sprites — the `?` and the `z z` — drawn by the app rather than
 * by the illustrator.
 *
 * Four properties, each of which is the reason for one line:
 *
 *  - **Never mirrored.** A `?` is a glyph; reversed it is not a question mark.
 *    Only its *anchor* flips, via `mirrorAnchorX`, so it moves to the other side
 *    of the dog's head and stays legible. That is the whole reason the flip is
 *    per-`renderFrame` rather than a transform over the entire paint.
 *  - **Positioned in whole sprite pixels.** The offset is `anchor * pixelScale`
 *    from the dog's own device origin, i.e. an exact multiple of the size one
 *    sprite pixel is being drawn at — so the glyph is locked to the dog's pixel
 *    grid at any device ratio, instead of drifting half a pixel against it.
 *  - **Rides the bob.** `device` already includes the pet wiggle, so the `?`
 *    bounces with the head it belongs to. (The bubble does not, on purpose.)
 *  - **Not in the hit mask.** `onInk` tests the dog's frame alone, so a click on
 *    the `?` passes through to whatever is behind. It is a thought, not a body
 *    part; a decoration that swallowed clicks would put an invisible 8x12 pad of
 *    dead screen above his ear.
 */
function drawDecorations(
  decors: readonly DecorName[],
  animationName: string,
  dogFrameName: string,
  dogFrame: Frame,
  device: { x: number; y: number },
  mirrored: boolean,
  palette: { name: string; colors: Palette }
): void {
  const loaded = sheet;
  if (ctx === null || loaded === null) return;

  const boxWidth = frameSize(dogFrame).width;
  const pixel = devicePixelScale(scale, dpr);

  for (const decor of decors) {
    for (const { anchor, frameName } of decorationPlacements(
      loaded, decor, animationName, dogFrameName
    )) {
      const frame = loaded.frames[frameName];
      if (frame === undefined) continue;
      const x = mirrored
        ? mirrorAnchorX(anchor.x, boxWidth, frameSize(frame).width)
        : anchor.x;

      ctx.save();
      ctx.translate(device.x + x * pixel, device.y + anchor.y * pixel);
      renderFrame(
        {
          frame,
          frameName,
          palette: palette.colors,
          paletteName: palette.name,
          scale,
          dpr,
          mirrored: false
        },
        ctx
      );
      ctx.restore();
    }
  }
}

/**
 * The universal speech or thought bubble, in the reserve above the dog.
 *
 * Everything is laid out in *device* pixels for the same reason the sprite is
 * (see the header): a fractional dpr multiplied into a CSS-pixel layout gives
 * uneven outline widths and blurry glyph edges, and pixel-art chrome cannot
 * absorb that. The layout is bounded by the window, which cannot grow — a
 * click-through window's size is fixed at creation — so the text is wrapped to
 * at most two lines and ellipsised beyond that (`wrapBubbleText`).
 *
 * Silently draws nothing when there is not room for a single line: an empty
 * outlined box would look like a bug, while no bubble looks like no bubble. The
 * sleeping box has no reserve at all, which lands here as `reserveCss <= 0`.
 *
 * It also draws nothing when the decoration the bubble would be saying is
 * already on screen — either because an older sheet drew it into this frame
 * (`bubbleIsBakedIn`) or because `drawDecorations` has just drawn it as a sprite
 * (`bubbleIsDrawnAsDecor`). Only
 * the drawing is skipped: the bubble is still live state in the behaviour
 * coordinator, so its ttl still runs, the head-tilt it holds is still held, and a
 * click still dismisses it. As soon as the loop moves off the decorated frame
 * (`sleep_0`, `sleep_1`) the bubble draws again, which is the point — the two
 * never appear at once, and neither is silently lost.
 *
 * The bubble itself is **never mirrored**: its text would come out backwards, and
 * its tail already points at the dog's centre, which does not move when he turns.
 */
function drawBubble(
  spriteTopCss: number,
  animationName: string | null,
  frameName: string | null,
  visible: readonly DecorName[]
): void {
  if (ctx === null || bubble === null) return;
  if (spriteTopCss <= 0) return;
  if (bubbleIsBakedIn(bubble.kind, animationName, frameName)) return;
  if (bubbleIsDrawnAsDecor(bubble.kind, visible)) return;
  const shape = bubbleShape(bubble.kind);

  const unit = Math.max(1, Math.round(dpr));
  const outline = 2 * unit;
  const padX = 3 * unit;
  const padY = 2 * unit;
  const tailStep = 2 * unit;
  const tailHeight = TAIL_STEPS * tailStep;

  const viewWidth = Math.round(window.innerWidth * dpr);
  // One unit of breathing room at the window edges and above the dog.
  const maxBoxWidth = viewWidth - 2 * unit;
  // The tail overlaps the box's bottom outline by exactly that outline.
  const boxSpace = Math.floor(spriteTopCss * dpr) - unit - tailHeight + outline;
  if (maxBoxWidth <= 2 * (outline + padX) || boxSpace <= 2 * (outline + padY)) return;

  // Sized for reading, not for the dog: `bubbleFontPx` is 12 / 14 / 16 CSS px
  // at Small / Medium / Large, and the window's reserve above the sprite was
  // computed from the same function (`bubbleReservePx`), so the two cannot drift
  // into a bubble that does not fit the room reserved for it.
  const fontPx = Math.round(bubbleFontPx(scale) * dpr);
  ctx.font = `${fontPx}px ${BUBBLE_FONT_STACK}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const charWidth = Math.max(1, ctx.measureText('M').width);
  const lineHeight = Math.max(1, Math.round(fontPx * 1.2));

  const cols = Math.floor((maxBoxWidth - 2 * (outline + padX)) / charWidth);
  const rows = Math.floor((boxSpace - 2 * (outline + padY)) / lineHeight);
  if (cols < 1 || rows < 1) return;

  const lines = wrapBubbleText(bubble.text, cols, Math.min(BUBBLE_MAX_LINES, rows));
  if (lines.length === 0) return;

  // Measured, not counted. `charWidth` above is one `measureText('M')`, which is
  // exactly right for the *wrap* (it works in columns, by design) and only
  // approximately right for the *box*: the stacks in `BUBBLE_FONT_STACK` are not
  // all perfectly monospaced for `…`, `%` and digits, and the fallback at the
  // end of the stack need not be monospaced at all. `line.length * charWidth`
  // therefore mis-sized the bubble and mis-centred each line by a pixel or two —
  // visible on pixel-art chrome, and the reason a line could touch the outline.
  const widths = lines.map((line) => ctx.measureText(line).width);
  const widest = widths.reduce((most, width) => Math.max(most, width), 0);
  const boxWidth = Math.min(maxBoxWidth, Math.ceil(widest) + 2 * (outline + padX));
  const boxHeight = lines.length * lineHeight + 2 * (outline + padY);

  const centre = Math.round(viewWidth / 2);
  const boxX = Math.max(
    unit,
    Math.min(Math.round(centre - boxWidth / 2), viewWidth - boxWidth - unit)
  );
  const boxY = Math.max(0, Math.floor(spriteTopCss * dpr) - unit - tailHeight + outline - boxHeight);

  // A hard offset shadow, not a blur: one pixel down-right, as pixel art does it.
  ctx.fillStyle = BUBBLE_SHADOW;
  ctx.fillRect(boxX + unit, boxY + unit, boxWidth, boxHeight);

  ctx.fillStyle = BUBBLE_OUTLINE;
  ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
  ctx.fillStyle = BUBBLE_FILL;
  ctx.fillRect(boxX + outline, boxY + outline, boxWidth - 2 * outline, boxHeight - 2 * outline);

  if (shape === 'thought') {
    drawThoughtTail(boxX, boxY + boxHeight, boxWidth, centre, unit, outline);
  } else {
    drawBubbleTail(boxX, boxY + boxHeight, boxWidth, centre, unit, outline, tailStep);
  }

  ctx.fillStyle = BUBBLE_TEXT;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const x = Math.round(boxX + boxWidth / 2 - (widths[i] ?? 0) / 2);
    ctx.fillText(line, x, boxY + outline + padY + i * lineHeight);
  }
}

/** Two pixel-art thought dots, using the same vertical reserve as the speech tail. */
function drawThoughtTail(
  boxX: number,
  boxBottom: number,
  boxWidth: number,
  dogCentre: number,
  unit: number,
  outline: number
): void {
  const large = 4 * unit;
  const small = 3 * unit;
  const x = Math.max(
    boxX + outline,
    Math.min(dogCentre - Math.floor(large / 2), boxX + boxWidth - outline - large)
  );
  drawThoughtDot(x, boxBottom - outline, large, unit);
  drawThoughtDot(x + unit, boxBottom + 3 * unit, small, unit);
}

/** A hard-edged circular dot, made from rectangles so Canvas cannot anti-alias it. */
function drawThoughtDot(x: number, y: number, size: number, unit: number): void {
  if (ctx === null) return;
  ctx.fillStyle = BUBBLE_OUTLINE;
  ctx.fillRect(x + unit, y, size - 2 * unit, size);
  ctx.fillRect(x, y + unit, size, size - 2 * unit);
  ctx.fillStyle = BUBBLE_FILL;
  ctx.fillRect(x + unit, y + unit, Math.max(0, size - 2 * unit), Math.max(0, size - 2 * unit));
}

/**
 * A stepped tail under the bubble, pointing at the dog.
 *
 * Built from whole rectangles rather than a filled triangle: a diagonal path
 * would be anti-aliased, and a soft grey edge next to a hard 2 px outline is
 * immediately visible as wrong. Each step is drawn dark and then re-filled white
 * except for its right edge, which is what makes a staircase whose outside is
 * outlined and whose inside is the bubble's own white — including erasing the
 * box's bottom outline where the tail meets it.
 */
function drawBubbleTail(
  boxX: number,
  boxBottom: number,
  boxWidth: number,
  dogCentre: number,
  unit: number,
  outline: number,
  step: number
): void {
  if (ctx === null) return;
  const width = TAIL_STEPS * step;
  const x = Math.max(
    boxX + outline,
    Math.min(dogCentre - step, boxX + boxWidth - outline - width)
  );

  for (let i = 0; i < TAIL_STEPS; i++) {
    const stepWidth = (TAIL_STEPS - i) * step;
    const y = boxBottom - outline + i * step;
    ctx.fillStyle = BUBBLE_OUTLINE;
    ctx.fillRect(x, y, stepWidth, step);
    // The last step is solid outline — that is the tail's tip.
    if (i === TAIL_STEPS - 1) continue;
    ctx.fillStyle = BUBBLE_FILL;
    ctx.fillRect(x, y, Math.max(unit, stepWidth - outline), step);
  }
}

/**
 * `?debug=1`: a one-pixel box around the region that swallows clicks.
 *
 * Drawn around the *dilated* bounds, because that is the real clickable area —
 * `isOpaqueAt` dilates outward, so a click up to `HIT_DILATE_PX` sprite pixels
 * outside the silhouette still lands on the dog. An outline drawn at the tight
 * mask bounds would understate the area it exists to show.
 */
function drawHitOutline(
  frame: Frame,
  device: { x: number; y: number },
  mirrored: boolean
): void {
  if (ctx === null) return;
  const { width, height } = frameSize(frame);
  const tight = maskBounds(maskFor(frame), width, height);
  if (tight === null) return;
  // Mirrored when the dog is: this outline is a claim about where on the *screen*
  // clicks land, and an art-oriented one beside a flipped dog would make a
  // correct hit test look broken.
  const bounds = mirrored ? mirrorBounds(tight, width) : tight;

  const pixel = devicePixelScale(scale, dpr);
  const d = HIT_DILATE_PX;

  ctx.strokeStyle = 'rgba(255, 0, 255, 0.9)';
  ctx.lineWidth = 1;
  ctx.strokeRect(
    device.x + (bounds.minX - d) * pixel - 0.5,
    device.y + (bounds.minY - d) * pixel - 0.5,
    (bounds.maxX - bounds.minX + 1 + 2 * d) * pixel + 1,
    (bounds.maxY - bounds.minY + 1 + 2 * d) * pixel + 1
  );
}

/* -------------------------------------------------------------- hit testing */

/**
 * Is the CSS-pixel point over opaque sprite pixels of the frame on screen now?
 *
 * The **query** is mirrored, not the mask. There is one alpha mask per frame,
 * cached by frame identity and always in the art's orientation, so a flipped dog
 * is tested by reflecting the cursor's column into art coordinates
 * (`mirrorLogicalX`) and asking the same mask. Mirroring the mask instead would
 * mean a second cache, keyed by facing, that has to be proved identical to the
 * first — for a transform that is exact and costs one subtraction.
 *
 * The reflection happens *after* the `OFF_SPRITE` check, so an unusable
 * coordinate is rejected rather than folded back onto the sprite. A coordinate
 * that is merely just outside the frame (`-1`, or `width`) is mirrored honestly
 * and keeps its one pixel of grab slack on the correct side.
 */
function onInk(x: number, y: number): boolean {
  const current = currentFrame();
  if (current === null) return false;
  const { width, height } = frameSize(current.frame);
  const at = spritePlacement(current.frame, lastBob);
  const raw = toLogical(x, scale, at.x);
  const ly = toLogical(y, scale, at.y);
  if (raw === OFF_SPRITE || ly === OFF_SPRITE) return false;
  const lx = mirroredNow() ? mirrorLogicalX(raw, width) : raw;
  return isOpaqueAt(maskFor(current.frame), width, height, lx, ly, HIT_DILATE_PX);
}

/**
 * The dog's **resting** pose: the first frame of the per-box, per-expression
 * loop, whatever is actually on screen at this instant.
 *
 * It exists for one consumer, `spriteRectScreen`, and the reason is in that
 * function's comment. Read through `framesFor` like `currentFrame`, so a coat
 * with its own drawing of every frame is measured on its own pixels.
 */
function restingFrame(): Frame | null {
  const loaded = sheet;
  const palette = activePalette();
  if (loaded === null || palette === null) return null;
  const name = loaded.animations[baseAnimationName()]?.frames[0];
  if (name === undefined) return null;
  return framesFor(loaded, palette.name)[name] ?? null;
}

/**
 * The sprite's opaque bounds in *screen* coordinates, for placing the hover
 * panel beside it.
 *
 * Main cannot compute this: the window is mostly transparent padding plus a tall
 * bubble reserve, and which pixels are ink depends on the art. Measured from an
 * alpha mask (not the box, and not the dilated hit area) so the panel sits a
 * constant gap from the dog's outline at every size. `null` when there is
 * nothing drawn yet.
 *
 * **Measured on the resting pose, and with no bob — not on the frame showing.**
 * That is the 0.2.2 fix, and it is the whole reason `restingFrame` exists. This
 * used to measure `currentFrame()` at `lastBob`, which is honest about where the
 * ink is *right now* and completely wrong as an anchor: a bark, a blink, a
 * head-tilt and the pet wiggle all change the silhouette, so every one of them
 * moved the rect, `syncPanel` noticed the change and re-sent it, and main
 * re-placed the window. The owner's report was that the card "moves with the
 * animations… should be stuck in place, and not move back and forth". It was
 * tracking the dog frame by frame, which is a card that twitches while you are
 * trying to read four rows of numbers off it.
 *
 * The resting pose is stable across every animation and every frame of one, and
 * still changes for the things that genuinely should move the card: the window
 * being dragged, the size changing, the box changing, the dog turning round, or
 * the mood's own idle loop being a different drawing. The tight-gap property the
 * mask was chosen for survives, because the resting pose is the one the card is
 * beside for all but a second or two at a time.
 *
 * Mirrored with the dog, because the silhouette is not symmetric: his nose and
 * tail are at different distances from the box edges, so an art-oriented rect
 * would place the hover card a few pixels into a flipped dog on one side and a
 * gap too far from him on the other.
 */
function spriteRectScreen(): { x: number; y: number; width: number; height: number } | null {
  // The resting pose is the anchor; the frame on screen is only the fallback for
  // art whose base loop is missing, which is the same state `currentFrame`
  // already tolerates.
  const frame = restingFrame() ?? currentFrame()?.frame ?? null;
  if (frame === null) return null;
  const { width, height } = frameSize(frame);
  const tight = maskBounds(maskFor(frame), width, height);
  if (tight === null) return null;
  const bounds = mirroredNow() ? mirrorBounds(tight, width) : tight;

  // Bob 0, never `lastBob`: the pet wiggle is a 1 px dip that lasts 600 ms, and
  // a card that hopped with it would be the same bug in miniature.
  const at = spritePlacement(frame, 0);
  return {
    x: Math.round(window.screenX + at.x + bounds.minX * scale),
    y: Math.round(window.screenY + at.y + bounds.minY * scale),
    width: Math.round((bounds.maxX - bounds.minX + 1) * scale),
    height: Math.round((bounds.maxY - bounds.minY + 1) * scale)
  };
}

/* --------------------------------------------------------------- hover panel */

/** What main currently believes: whether the panel is wanted, and where. */
let panelWanted = false;
let panelRect: { x: number; y: number; width: number; height: number } | null = null;

function sameRect(
  a: { x: number; y: number; width: number; height: number } | null,
  b: { x: number; y: number; width: number; height: number } | null
): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Keep main's idea of the hover state in step with ours.
 *
 * Separate from the click-through channel on purpose: `hit:set` must fire the
 * instant the cursor crosses the outline (it decides whether clicks land), while
 * the panel is a slower, cosmetic thing that also needs a *rect*. Suppressed
 * during a drag — the dog is moving under the cursor and a card following it
 * around would be in the way of the very gesture being made.
 *
 * Also re-sends when the rect moves while the panel is already up, which is what
 * makes a size change from the tray re-place the card instead of leaving it
 * floating away from the dog.
 */
function syncPanel(): void {
  const wanted = hover.inside && drag === null;
  if (!wanted) {
    if (!panelWanted) return;
    panelWanted = false;
    panelRect = null;
    void window.walder.hoverLeave();
    return;
  }

  const rect = spriteRectScreen();
  if (rect === null) return;
  if (panelWanted && sameRect(rect, panelRect)) return;
  panelWanted = true;
  panelRect = rect;
  void window.walder.hoverEnter(rect);
}

/** Commit a hover decision: keep the state, and tell main only if asked to. */
function commit(decision: HoverDecision): void {
  hover = decision.state;
  if (decision.notify) void window.walder.setHit(hover.inside);
  syncPanel();
}

/* -------------------------------------------------------------- event wiring */

function attachEvents(): void {
  const move = (x: number, y: number): void => {
    commit(hoverMove(hover, x, y, drag !== null, onInk));
  };

  // Both event families: forwarded mouse messages (what `forward: true` delivers
  // while the window is click-through) surface as mouse events, and pointer
  // events are what give us capture during a drag. `hoverMove` only notifies on a
  // change, so hearing about the same move twice is free.
  window.addEventListener('mousemove', (event) => move(event.clientX, event.clientY));
  window.addEventListener('pointermove', (event) => {
    if (drag !== null) {
      const step = dragTo(drag, event.screenX, event.screenY);
      drag = step.state;
      // Still record the position: `endDrag` re-derives hover from it.
      commit(hoverMove(hover, event.clientX, event.clientY, true, onInk));
      void window.walder.dragMove(step.dxScreen, step.dyScreen);
      return;
    }
    move(event.clientX, event.clientY);
  });

  // Leaving the window can never leave the dog holding clicks hostage.
  const leave = (): void => {
    commit(hoverLeave(hover, drag !== null));
  };
  document.documentElement.addEventListener('mouseleave', leave);
  document.documentElement.addEventListener('pointerleave', leave);

  window.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    // Re-test rather than trusting the cached verdict: the frame may have
    // advanced since the last move, and a click on a transparent pixel must not
    // start a drag.
    if (!onInk(event.clientX, event.clientY)) return;
    event.preventDefault();
    drag = dragBegin(event.screenX, event.screenY, event.pointerId);
    // Main hides the panel on `drag:start`; mirror that here so our idea of its
    // state matches, and a re-enter is sent when the drag ends.
    panelWanted = false;
    panelRect = null;
    // Capture keeps move/up coming even if the cursor slips outside the window
    // (which happens once a drag is clamped at a screen edge).
    try {
      canvas?.setPointerCapture(event.pointerId);
    } catch {
      // Capture is a nicety; the drag still works without it.
    }
    void window.walder.dragStart();
  });

  const endDrag = (event: PointerEvent): void => {
    if (drag === null) return;
    const wasClick = isClick(drag);
    try {
      canvas?.releasePointerCapture(event.pointerId);
    } catch {
      // Already released, or never captured.
    }
    drag = null;
    void window.walder.dragEnd();

    if (wasClick) {
      petStartedAt = performance.now();
      requestPaint();
      void window.walder.pet();
    }
    // The window stopped moving, so the hover state is meaningful again.
    commit(hoverMove(hover, event.clientX, event.clientY, false, onInk));
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  window.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (!onInk(event.clientX, event.clientY)) return;
    void window.walder.openMenu();
  });

  window.addEventListener('resize', () => {
    // A size change moves the sprite within the window, so the cursor may now be
    // on ink (or off it) without having moved at all. A resize is also how a dpr
    // change usually surfaces, so re-read it here too.
    syncDpr();
    needsHitTest = true;
    requestPaint();
  });

  // Nothing here is selectable or draggable as content; suppress the native
  // behaviours that would otherwise fight the mascot drag.
  window.addEventListener('dragstart', (event) => event.preventDefault());
  window.addEventListener('selectstart', (event) => event.preventDefault());
}

/* --------------------------------------------------------------------- dpr */

/**
 * Watch for a device-pixel-ratio change (dragging the dog between a Retina and a
 * non-Retina monitor, or the user changing the scaling) with a media query rather
 * than by polling `devicePixelRatio` on every frame — polling is precisely the
 * per-frame wakeup this loop exists to avoid. The query matches only the current
 * ratio, so any change fires it.
 */
let dprQuery: MediaQueryList | null = null;

function syncDpr(): boolean {
  const ratio = window.devicePixelRatio || 1;
  if (ratio === dpr) return false;
  dpr = ratio;
  watchDpr();
  return true;
}

function onDprChange(): void {
  if (!syncDpr()) return;
  requestPaint();
}

function watchDpr(): void {
  dprQuery?.removeEventListener('change', onDprChange);
  dprQuery = window.matchMedia(`(resolution: ${dpr}dppx)`);
  dprQuery.addEventListener('change', onDprChange);
}

/* ----------------------------------------------------------------- animation */

let timer: ReturnType<typeof setTimeout> | null = null;
let rafHandle = 0;

/** Paint on the next frame. Coalesces: several requests before a paint are one. */
function requestPaint(): void {
  if (rafHandle !== 0) return;
  rafHandle = requestAnimationFrame(paint);
}

/**
 * Advance the animation to `now`.
 *
 * The arithmetic itself is `advanceFrames` in `core/anim-schedule.ts` — pure,
 * unit-tested, and shared with the animation gallery so that what the owner
 * approves there is timed by the same code that runs on his desktop. This is the
 * stateful wrapper around it, plus the one thing that is specific to the live
 * mascot: slipping a blink or an ear-flick between idle laps.
 */
function advance(now: number): { changed: boolean; finished: boolean } {
  const animation = currentAnimation();
  if (animation === null) return { changed: false, finished: false };

  const step = advanceFrames(clock, timingOf(animation), now);
  clock = step.clock;

  // A completed lap of the *base* idle loop is the moment an interjection can
  // go in. Only the base loop: an interjection over an override would fight
  // with it. WHICH interjection is the loop's own business now — `canInterject`
  // and `idleExtras` derive the names from it (`idle_worried` -> `blink_worried`),
  // so a worried dog blinks worried and `sleep`/`out`/`confused` are excluded by
  // not being idle loops at all.
  const base = currentAnimationName();
  if (step.wrapped && playing === null && canInterject(base, hasAnimation)) {
    // `step.laps`, not "one": a late wake catches up through several laps in a
    // single call, and counting them as one drifts the ear-flick's every-fourth
    // cadence out a little further with every hesitation the machine has.
    const decision = onIdleLoop(idle, sheetIdleExtras(base), now, Math.random, step.laps);
    idle = decision.state;
    if (decision.play !== null) {
      startPlay({ animation: decision.play, then: 'idle' });
      return { changed: true, finished: false };
    }
  }

  return { changed: step.changed, finished: step.finished };
}

/** Does the loaded sheet carry this animation? */
function hasAnimation(name: string): boolean {
  return sheet?.animations[name] !== undefined;
}

/** What the loaded sheet offers in the way of interjections for one idle loop. */
function sheetIdleExtras(baseAnimation: string): IdleExtras {
  return idleExtras(baseAnimation, hasAnimation);
}

/**
 * When the picture can next change on its own, or `null` for "not until
 * something happens" — which is the state a parked one-shot animation with no
 * pet in flight sits in, at zero wakeups.
 */
function nextWakeAt(now: number): number | null {
  let at: number | null = null;
  const bid = (t: number): void => {
    if (at === null || t < at) at = t;
  };

  const animation = currentAnimation();
  if (animation !== null) {
    const due = nextFrameDueAt(clock, timingOf(animation), now);
    if (due !== null) bid(due);
  }

  if (petStartedAt !== 0) {
    const elapsed = Math.max(0, now - petStartedAt);
    const step = Math.floor(elapsed / PET_STEP_MS) + 1;
    bid(Math.min(petStartedAt + step * PET_STEP_MS, petStartedAt + PET_MS));
  }

  return at;
}

/** Arm the single timer for the next state change, replacing any pending one. */
function scheduleWake(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  // Nothing is on screen to animate, so nothing is worth a wakeup. `requestPaint`
  // is deliberately *not* gated the same way: a paint keeps the cached state
  // (frame, bob, hit mask) consistent, and it costs one frame rather than a
  // repeating timer.
  if (hidden) return;
  const now = performance.now();
  const at = nextWakeAt(now);
  if (at === null) return;
  timer = setTimeout(
    () => {
      timer = null;
      requestPaint();
    },
    Math.max(0, Math.ceil(at - now))
  );
}

/** One repaint. Only ever called through `requestAnimationFrame`. */
function paint(): void {
  rafHandle = 0;
  const now = performance.now();

  const step = advance(now);
  let changed = step.changed;
  // An override that has run its course either starts the queued animation or
  // releases back to the normal loop; both change the picture.
  if (step.finished && onPlayFinished()) changed = true;

  const bob = bobAt(now);
  if (bob !== lastBob) {
    lastBob = bob;
    changed = true;
  }

  const retest = changed || needsHitTest;
  needsHitTest = false;

  draw(lastBob);

  // A new frame can have a different silhouette, and a resize moves the sprite —
  // either way the click-through state must be re-derived for a cursor that has
  // not moved.
  if (retest) commit(hoverRetest(hover, drag !== null, onInk));

  scheduleWake();
}

/* ---------------------------------------------------------------------- boot */

/**
 * Which way to look, from main.
 *
 * `needsHitTest` because a mirror moves the ink under a cursor that has not
 * moved: the dog's nose is now where his tail was, so the click-through verdict
 * and the hover panel's anchor both have to be re-derived even though nothing
 * about the animation changed. Validated with `isFacing` like every other
 * cross-process value; a junk payload leaves him as he was.
 */
function applyFacing(next: unknown): void {
  if (!isFacing(next) || next === facing) return;
  facing = next;
  needsHitTest = true;
  requestPaint();
}

function applyMode(mode: ModePayload): void {
  if (Number.isFinite(mode.scale) && mode.scale > 0) scale = mode.scale;
  // Carried by `mode` so the first paint is already the right way round.
  applyFacing(mode.facing);
  if (mode.box !== box) {
    box = mode.box;
    // Frames belong to a box, and the window has just been resized around the
    // new one: an override that was mid-play in the other box would be drawn at
    // the wrong size. The coordinator always sends `mode` before the `play` that
    // belongs with it, so the right animation arrives immediately after this.
    releasePlay();
    clock = FRESH_CLOCK;
  }
  needsHitTest = true;
  requestPaint();
  /*
   * Presence, through the same code path as the scene event.
   *
   * `mode` carries it because a `visible` event is an *edge*: the very first one
   * of a run is emitted synchronously inside `createBehaviour`, before this page
   * exists, so a Walder launched with the hide-when-idle mode on never heard
   * about it and kept animating an invisible dog at full cadence for the whole
   * session (`backgroundThrottling: false`). `applyScene` is idempotent about
   * this — it returns immediately when nothing changed — so repeating it on
   * every `mode:set` costs nothing, and it covers a renderer rebuilt after a
   * crash too, which pulls this through `settings:get`.
   *
   * Last, after the box: the animation `applyScene` restarts on becoming visible
   * belongs to the box this call has just set.
   */
  applyScene({ type: 'visible', shown: !mode.hidden });
}

/**
 * One behaviour event.
 *
 * `mode` is deliberately absent: a box change is a window resize, so main
 * performs it and the renderer hears about it on `mode:set` (which also carries
 * the scale). Everything else is cosmetic and lands here.
 */
function applyScene(event: ScenePayload): void {
  switch (event.type) {
    case 'expression':
      if (event.expression === expression) return;
      expression = event.expression;
      // A different animation means a different frame list: restart rather than
      // indexing into the new one at the old frame's position.
      clock = FRESH_CLOCK;
      needsHitTest = true;
      requestPaint();
      return;

    case 'bubble': {
      const cleared = event.kind === 'none' || event.text.length === 0;
      bubble = cleared ? null : { text: event.text, kind: event.kind };
      // The bubble is the reason a held pose is held: the `?` coming down or the
      // woof timing out is what lets the head straighten and the ears drop.
      if (cleared) releaseHeldPose();
      requestPaint();
      return;
    }

    case 'play':
      onPlay(event.animation, event.then);
      return;

    case 'visible': {
      const nextHidden = !event.shown;
      if (nextHidden === hidden) return;
      hidden = nextHidden;
      if (hidden) {
        // Stop the animation timer — `scheduleWake` clears the pending one and,
        // now that `hidden` is set, arms no replacement.
        scheduleWake();
        // And drop the hover state: the window is gone, so main must be told the
        // cursor is no longer on ink (or clicks would keep landing on nothing)
        // and the card must come down. No `mouseleave` will arrive to do it.
        commit(hoverLeave(hover, drag !== null));
        return;
      }
      // Back on screen: restart the animation from frame one rather than
      // resuming a lap that ran, invisibly, for the whole time he was away.
      clock = FRESH_CLOCK;
      needsHitTest = true;
      requestPaint();
      return;
    }

    default:
      return;
  }
}

async function boot(): Promise<void> {
  if (canvas === null || ctx === null) {
    rerror('overlay canvas missing; nothing will be drawn');
    return;
  }

  window.walder.onSheet((payload) => {
    setSheet(payload.sheet);
    clock = FRESH_CLOCK;
    // Whether there is a blink or an ear-flick to slip in at all is the art's
    // decision, so the interjection state is rebuilt with every sheet.
    idle = initIdle(sheetIdleExtras(baseAnimationName()), performance.now());
    needsHitTest = true;
    requestPaint();
  });
  window.walder.onMode(applyMode);
  window.walder.onPalette((payload) => {
    paletteRequest = payload;
    requestPaint();
  });
  window.walder.onHitResync(() => {
    commit(hoverResync(hover, onInk));
  });
  window.walder.onFacing((payload) => {
    applyFacing(payload.facing);
  });
  // The snapshot's own face is what a *restored* snapshot carries, before the
  // behaviour coordinator has run at all; a live poll also produces an
  // `expression` scene event, and the two always agree because both come from
  // `expressionFor` over the same buckets.
  window.walder.onUsage((snapshot) => {
    applyScene({ type: 'expression', expression: snapshot.expression });
  });
  window.walder.onScene(applyScene);

  attachEvents();
  watchDpr();
  requestPaint();

  // Ask rather than wait: this removes the race between the page finishing load
  // and main deciding to push.
  const settings = await window.walder.getSettings();
  if (settings === null) {
    rerror('settings:get was refused; the overlay has no sheet');
    return;
  }
  setSheet(settings.sheet);
  idle = initIdle(sheetIdleExtras(baseAnimationName()), performance.now());
  paletteRequest = settings.palette;
  if (settings.usage !== null) expression = settings.usage.expression;
  applyMode(settings.mode);
}

void boot();

export {};

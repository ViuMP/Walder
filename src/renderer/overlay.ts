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
import { spriteOrigin } from '../core/geometry';
import { pickAnimation, type Expression } from '../core/expression';
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
import type { Animation, Frame, Palette, SpriteSheet } from '../sprites/types';
import type { BoxName, ModePayload, PalettePayload } from '../main/ipc';

/** Palette every sheet defines; used when the chosen coat is not in the sheet. */
const FALLBACK_PALETTE = 'golden';

/** How long a pet wiggle lasts, and how often it flips, in ms. */
const PET_MS = 600;
const PET_STEP_MS = 100;

/** Duration used when an animation frame somehow has none. Matches `tick`'s old default. */
const DEFAULT_FRAME_MS = 600;

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

let frameIndex = 0;
/** `performance.now()` when the current animation frame started; 0 = not started. */
let frameStartedAt = 0;
let lastBob = 0;
let petStartedAt = 0;
let dpr = window.devicePixelRatio || 1;
/** Set when the sprite's on-screen geometry changed, so hover must be re-derived. */
let needsHitTest = false;

let hover: HoverState = HOVER_INITIAL;
let drag: DragState | null = null;

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
function currentAnimationName(): string {
  if (sheet === null) return 'idle';
  const animations = sheet.animations;
  return pickAnimation(box, expression, (name) => animations[name] !== undefined);
}

function currentAnimation(): Animation | null {
  if (sheet === null) return null;
  return sheet.animations[currentAnimationName()] ?? null;
}

/** The frame to draw, with its sheet name — the name is part of the raster cache key. */
function currentFrame(): { name: string; frame: Frame } | null {
  const animation = currentAnimation();
  if (sheet === null || animation === null) return null;
  const name = animation.frames[frameIndex % animation.frames.length];
  if (name === undefined) return null;
  const frame = sheet.frames[name];
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

  ctx.save();
  ctx.translate(device.x, device.y);
  renderFrame(
    {
      frame: current.frame,
      frameName: current.name,
      palette: palette.colors,
      paletteName: palette.name,
      scale,
      dpr
    },
    ctx
  );
  ctx.restore();

  if (debug) drawHitOutline(current.frame, device);
}

/**
 * `?debug=1`: a one-pixel box around the region that swallows clicks.
 *
 * Drawn around the *dilated* bounds, because that is the real clickable area —
 * `isOpaqueAt` dilates outward, so a click up to `HIT_DILATE_PX` sprite pixels
 * outside the silhouette still lands on the dog. An outline drawn at the tight
 * mask bounds would understate the area it exists to show.
 */
function drawHitOutline(frame: Frame, device: { x: number; y: number }): void {
  if (ctx === null) return;
  const { width, height } = frameSize(frame);
  const bounds = maskBounds(maskFor(frame), width, height);
  if (bounds === null) return;

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

/** Is the CSS-pixel point over opaque sprite pixels of the frame on screen now? */
function onInk(x: number, y: number): boolean {
  const current = currentFrame();
  if (current === null) return false;
  const { width, height } = frameSize(current.frame);
  const at = spritePlacement(current.frame, lastBob);
  const lx = toLogical(x, scale, at.x);
  const ly = toLogical(y, scale, at.y);
  if (lx === OFF_SPRITE || ly === OFF_SPRITE) return false;
  return isOpaqueAt(maskFor(current.frame), width, height, lx, ly, HIT_DILATE_PX);
}

/**
 * The sprite's opaque bounds in *screen* coordinates, for placing the hover
 * panel beside it.
 *
 * Main cannot compute this: the window is mostly transparent padding plus a tall
 * bubble reserve, and which pixels are ink depends on the frame currently
 * showing. Measured from the frame's alpha mask (not the box, and not the
 * dilated hit area) so the panel sits a constant gap from the dog's outline at
 * every size. `null` when there is nothing drawn yet.
 */
function spriteRectScreen(): { x: number; y: number; width: number; height: number } | null {
  const current = currentFrame();
  if (current === null) return null;
  const { width, height } = frameSize(current.frame);
  const bounds = maskBounds(maskFor(current.frame), width, height);
  if (bounds === null) return null;

  const at = spritePlacement(current.frame, lastBob);
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
 * Advance the animation to `now`, returning whether the frame index moved.
 *
 * Loops rather than stepping once, because a wake can be late (a busy machine, a
 * laptop resuming) and the frame that should be showing may be two or three on.
 * The `guard` bounds that catch-up, and a wake more than a second late abandons
 * it and resynchronises — there is no value in replaying a minute of idle loop.
 */
function advance(now: number): boolean {
  const animation = currentAnimation();
  if (animation === null) return false;
  if (frameStartedAt === 0) {
    frameStartedAt = now;
    return false;
  }

  let changed = false;
  for (let guard = 0; guard < 64; guard++) {
    const duration = animation.durationsMs[frameIndex] ?? DEFAULT_FRAME_MS;
    if (now - frameStartedAt < duration) break;
    const next = frameIndex + 1;
    if (next >= animation.frames.length && !animation.loop) {
      // A one-shot that has finished: park on the last frame and stop waking.
      frameIndex = animation.frames.length - 1;
      frameStartedAt = now;
      changed = true;
      break;
    }
    frameIndex = next >= animation.frames.length ? 0 : next;
    frameStartedAt += duration;
    changed = true;
  }

  // The loop above exits as soon as the current frame is not yet due, so this is
  // true only when the guard ran out — i.e. we are still hopelessly behind after
  // 64 frames. Give up catching up and resynchronise to now. Testing the current
  // frame's own duration matters: a flat "more than a second behind" would also
  // fire on a paint that an event triggered halfway through a long frame, and
  // silently stretch that frame.
  const duration = animation.durationsMs[frameIndex] ?? DEFAULT_FRAME_MS;
  if (now - frameStartedAt >= duration) frameStartedAt = now;
  return changed;
}

/**
 * When the picture can next change on its own, or `null` for "not until
 * something happens" — which is the state a finished one-shot animation with no
 * pet in flight sits in, at zero wakeups.
 */
function nextWakeAt(now: number): number | null {
  let at: number | null = null;
  const bid = (t: number): void => {
    if (at === null || t < at) at = t;
  };

  const animation = currentAnimation();
  if (animation !== null && frameStartedAt !== 0) {
    const running = animation.loop || frameIndex < animation.frames.length - 1;
    if (running) bid(frameStartedAt + (animation.durationsMs[frameIndex] ?? DEFAULT_FRAME_MS));
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

  let changed = advance(now);
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

function applyMode(mode: ModePayload): void {
  if (Number.isFinite(mode.scale) && mode.scale > 0) scale = mode.scale;
  if (mode.box !== box) {
    box = mode.box;
    frameIndex = 0;
    frameStartedAt = 0;
  }
  needsHitTest = true;
  requestPaint();
}

async function boot(): Promise<void> {
  if (canvas === null || ctx === null) {
    rerror('overlay canvas missing; nothing will be drawn');
    return;
  }

  window.walder.onSheet((payload) => {
    sheet = payload.sheet;
    frameIndex = 0;
    frameStartedAt = 0;
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
  window.walder.onUsage((snapshot) => {
    if (snapshot.expression === expression) return;
    expression = snapshot.expression;
    // A different animation means a different frame list: restart rather than
    // indexing into the new one at the old frame's position.
    frameIndex = 0;
    frameStartedAt = 0;
    needsHitTest = true;
    requestPaint();
  });

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
  sheet = settings.sheet;
  paletteRequest = settings.palette;
  if (settings.usage !== null) expression = settings.usage.expression;
  applyMode(settings.mode);
}

void boot();

export {};

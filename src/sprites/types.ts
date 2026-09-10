/**
 * Sprite-sheet schema and validator.
 *
 * The sheet is the contract between the art pipeline (`art/walder.json`, drawn
 * by hand) and the runtime. Because the art is authored outside the type system,
 * `validateSheet` is the only place that turns untyped JSON into a `SpriteSheet`:
 * every consumer downstream may assume the invariants below hold.
 *
 * Deliberately Electron-free and DOM-free so it can be unit-tested under vitest's
 * node environment and imported from main, preload and renderer alike.
 */

/** Logical pixel dimensions of a frame box: `[width, height]`. */
export type Box = readonly [number, number];

/** Single-letter palette key -> CSS colour. `.` is reserved for transparent. */
export type Palette = Readonly<Record<string, string>>;

/**
 * One frame. `rows.length` equals the box height and every row's length equals
 * the box width; each character is `.` (transparent) or a key defined by *every*
 * palette in the sheet.
 *
 * The art pipeline writes per-frame metadata of its own — `airborne` on `hop_2`,
 * which tells `art/render.mjs` that this is the one standing frame allowed an
 * empty bottom row. It is **deliberately not carried through**: it records how
 * the artwork was checked, not how it is drawn, and the runtime draws every frame
 * the same way. Unknown keys on a frame are ignored rather than rejected, so the
 * art pipeline can add more of them without a code change here.
 */
export interface Frame {
  readonly box: string;
  readonly rows: readonly string[];
}

/** A named loop (or one-shot) over frames, with a per-frame duration. */
export interface Animation {
  readonly frames: readonly string[];
  /** Same length as `frames`; each entry is a positive, finite millisecond count. */
  readonly durationsMs: readonly number[];
  readonly loop: boolean;
  /**
   * Park on the last frame when this one-shot ends, instead of returning to the
   * idle loop. The *art* declares it (`perk`, `tilt`), because it is a property
   * of the drawing: a head-tilt meaning "waiting for you" has to stay tilted
   * while the `?` is up, and ears that lift for "Claude is done" have to stay up
   * while the woof is on screen. Released by whatever ends the moment — the
   * bubble being cleared, or the next animation.
   *
   * Always a boolean on a validated sheet (absent in the JSON means `false`), so
   * no consumer needs `?? false`. Meaningless on a looping animation, which never
   * ends, so `validateSheet` rejects that combination rather than leaving it to
   * be interpreted two ways.
   */
  readonly hold: boolean;
}

/**
 * Where the top-left corner of a decoration box sits inside an animation's box,
 * in sprite pixels, in the **art's** orientation (facing left).
 *
 * Mirroring is applied by the renderer at draw time (`mirrorAnchorX` in
 * `core/facing.ts`), never stored: one anchor per animation is the truth, and a
 * second mirrored copy in the sheet would be one more thing for the art pipeline
 * to get out of step with itself.
 */
export interface DecorAnchor {
  readonly x: number;
  readonly y: number;
}

/**
 * `animation -> decoration -> anchor`.
 *
 * Keyed by *animation* rather than by frame because an anchor is a statement
 * about where the dog's head is in that pose, which is a property the whole
 * animation shares; *whether* the decoration is showing on a given frame is the
 * app's decision, in `contract.ts`.
 */
export type DecorAnchors = Readonly<Record<string, Readonly<Record<string, DecorAnchor>>>>;

/**
 * One complete alternative drawing of every frame in the sheet.
 *
 * A *frame set*, not a palette, because some coats are not a colour swap. Walder
 * has a silver dapple cousin whose coat is irregular black blotches over silver
 * with tan points, and no remapping of eight letters produces spots — the blotch
 * has to be drawn. So the sheet can carry the whole cast a second time, and the
 * palette says which drawing to use (`paletteFrameSets`).
 *
 * Keyed by exactly the same frame names as `frames`, with each frame in the same
 * box: the two sets are the same animations in a different coat, and the
 * renderer swaps between them under a running clock — the frame index carries
 * straight across, because the name it indexes means the same thing in both.
 */
export type FrameSet = Readonly<Record<string, Frame>>;

export interface SpriteSheet {
  readonly boxes: Readonly<Record<string, Box>>;
  readonly palettes: Readonly<Record<string, Palette>>;
  /**
   * The base drawing — and, for every consumer that does not care about coats,
   * *the* drawing. `gen-icons` takes `idle_0` from here, `render.mjs` builds its
   * comparison sheets from here, and the hit mask and the window geometry are the
   * same for every set because every set shares its boxes.
   */
  readonly frames: Readonly<Record<string, Frame>>;
  readonly animations: Readonly<Record<string, Animation>>;
  /**
   * Alternative drawings, by set name. Optional in the JSON, always present
   * here — `{}` on every sheet with one coat's worth of art, which is every
   * sheet drawn before 2026-09-09. `frames` is never one of these: the base set
   * has a home already, and duplicating it would be one more thing for the two
   * copies to disagree about.
   */
  readonly frameSets: Readonly<Record<string, FrameSet>>;
  /**
   * `palette -> frame set`. A palette absent from this map draws `frames`.
   *
   * Separate from `palettes` rather than a field inside one because a palette is
   * a map of single-character keys to colours and nothing else — `parsePalettes`
   * rejects a longer key, which is what keeps a typo'd letter from silently
   * becoming a colour nobody notices is unused.
   */
  readonly paletteFrameSets: Readonly<Record<string, string>>;
  /**
   * Optional in the JSON, always present here — `{}` when the art declares none,
   * which is what every sheet drawn before 2026-09-09 does. An empty map means
   * the app draws no decorations at all and the glyphs the illustrator baked into
   * `tilt_2` / `sleep_2` are the only ones on screen; see `contract.ts`.
   */
  readonly decorAnchors: DecorAnchors;
}

/** The transparent cell marker. Never a palette key. */
export const TRANSPARENT = '.';

/** Thrown by `validateSheet`. Separate class so callers can distinguish it. */
export class SpriteSheetError extends Error {
  constructor(message: string) {
    super(`sprite sheet: ${message}`);
    this.name = 'SpriteSheetError';
  }
}

function fail(message: string): never {
  throw new SpriteSheetError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(`${what} must be an object`);
  return value;
}

/** A positive integer dimension. Rejects 0, negatives, fractions and NaN. */
function isDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function parseBoxes(raw: unknown): Record<string, Box> {
  const source = requireObject(raw, '"boxes"');
  const boxes: Record<string, Box> = {};

  for (const [name, value] of Object.entries(source)) {
    if (!Array.isArray(value) || value.length !== 2) {
      fail(`box "${name}" must be a [width, height] pair`);
    }
    const [w, h] = value as unknown[];
    if (!isDimension(w) || !isDimension(h)) {
      fail(`box "${name}" must be positive integers, got [${String(w)}, ${String(h)}]`);
    }
    boxes[name] = [w, h];
  }

  if (Object.keys(boxes).length === 0) fail('"boxes" is empty');
  return boxes;
}

function parsePalettes(raw: unknown): Record<string, Palette> {
  const source = requireObject(raw, '"palettes"');
  const palettes: Record<string, Palette> = {};

  for (const [name, value] of Object.entries(source)) {
    const entries = requireObject(value, `palette "${name}"`);
    const colors: Record<string, string> = {};
    for (const [key, color] of Object.entries(entries)) {
      if (key.length !== 1) {
        fail(`palette "${name}" key "${key}" must be a single character`);
      }
      if (key === TRANSPARENT) {
        fail(`palette "${name}" may not define "${TRANSPARENT}" (reserved for transparent)`);
      }
      if (typeof color !== 'string' || color.length === 0) {
        fail(`palette "${name}" key "${key}" must map to a colour string`);
      }
      colors[key] = color;
    }
    if (Object.keys(colors).length === 0) fail(`palette "${name}" is empty`);
    palettes[name] = colors;
  }

  if (Object.keys(palettes).length === 0) fail('"palettes" is empty');
  return palettes;
}

function parseFrames(
  raw: unknown,
  boxes: Record<string, Box>,
  palettes: Record<string, Palette>
): Record<string, Frame> {
  const source = requireObject(raw, '"frames"');
  const frames: Record<string, Frame> = {};
  const paletteNames = Object.keys(palettes);

  for (const [name, value] of Object.entries(source)) {
    const frame = requireObject(value, `frame "${name}"`);

    const boxName = frame['box'];
    if (typeof boxName !== 'string') fail(`frame "${name}" is missing a "box" name`);
    const box = boxes[boxName];
    if (box === undefined) fail(`frame "${name}" references unknown box "${boxName}"`);
    const [width, height] = box;

    const rows = frame['rows'];
    if (!Array.isArray(rows)) fail(`frame "${name}" is missing a "rows" array`);
    if (rows.length !== height) {
      fail(
        `frame "${name}" has ${rows.length} rows but box "${boxName}" is ${width}x${height} ` +
          `(expected ${height} rows)`
      );
    }

    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      if (typeof row !== 'string') fail(`frame "${name}" row ${y} is not a string`);
      if (row.length !== width) {
        fail(
          `frame "${name}" row ${y} is ${row.length} characters but box "${boxName}" is ` +
            `${width}x${height} (expected ${width})`
        );
      }
      for (let x = 0; x < row.length; x++) {
        const ch = row[x] as string;
        if (ch === TRANSPARENT) continue;
        for (const paletteName of paletteNames) {
          if ((palettes[paletteName] as Palette)[ch] === undefined) {
            fail(
              `frame "${name}" row ${y} column ${x} uses key "${ch}", which palette ` +
                `"${paletteName}" does not define`
            );
          }
        }
      }
    }

    frames[name] = { box: boxName, rows: rows as string[] };
  }

  if (Object.keys(frames).length === 0) fail('"frames" is empty');
  return frames;
}

function parseAnimations(raw: unknown, frames: Record<string, Frame>): Record<string, Animation> {
  const source = requireObject(raw, '"animations"');
  const animations: Record<string, Animation> = {};

  for (const [name, value] of Object.entries(source)) {
    const anim = requireObject(value, `animation "${name}"`);

    const frameNames = anim['frames'];
    if (!Array.isArray(frameNames) || frameNames.length === 0) {
      fail(`animation "${name}" needs a non-empty "frames" array`);
    }
    for (const frameName of frameNames as unknown[]) {
      if (typeof frameName !== 'string' || frames[frameName] === undefined) {
        fail(`animation "${name}" references unknown frame "${String(frameName)}"`);
      }
    }

    const durations = anim['durationsMs'];
    if (!Array.isArray(durations) || durations.length !== frameNames.length) {
      fail(
        `animation "${name}" has ${Array.isArray(durations) ? durations.length : 0} durations ` +
          `for ${frameNames.length} frames`
      );
    }
    for (const ms of durations as unknown[]) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
        fail(`animation "${name}" duration "${String(ms)}" must be a positive number of ms`);
      }
    }

    const loop = anim['loop'];
    if (typeof loop !== 'boolean') fail(`animation "${name}" needs a boolean "loop"`);

    // Absent is the common case and means "fall back to idle when you finish".
    const rawHold = anim['hold'];
    if (rawHold !== undefined && typeof rawHold !== 'boolean') {
      fail(`animation "${name}" has a non-boolean "hold"`);
    }
    const hold = rawHold === true;
    if (hold && loop) {
      fail(
        `animation "${name}" is both "loop" and "hold" — a looping animation never ` +
          `ends, so there is no last frame to park on`
      );
    }

    animations[name] = {
      frames: frameNames as string[],
      durationsMs: durations as number[],
      loop,
      hold
    };
  }

  if (Object.keys(animations).length === 0) fail('"animations" is empty');
  return animations;
}

/**
 * Validate `frameSets`: the sheet's alternative coats.
 *
 * Each set goes through `parseFrames` unchanged, so a dapple frame is held to
 * exactly the standards a golden one is — right number of rows, right width,
 * every letter resolvable in every palette. Two rules are then added, and both
 * are about the sets being interchangeable rather than merely valid:
 *
 *  - **The same frame names, exactly.** The renderer swaps sets when the coat
 *    changes, mid-animation, keeping the frame index it already had. A set
 *    missing `hop_3` would draw nothing for a third of the hop, and a set with
 *    an extra frame nothing plays would be artwork the gallery never shows. The
 *    message names the first offender in each direction, because "the sets
 *    differ" is not a thing anyone can act on.
 *  - **The same box per frame.** The window is sized from the base set's boxes
 *    and the hit mask is derived from the frame on screen; a `sleep_0` drawn in
 *    the standing box would put a 72x72 sprite in a 61x58 window.
 */
function parseFrameSets(
  raw: unknown,
  boxes: Record<string, Box>,
  palettes: Record<string, Palette>,
  base: Record<string, Frame>
): Record<string, FrameSet> {
  if (raw === undefined) return {};
  const source = requireObject(raw, '"frameSets"');
  const sets: Record<string, FrameSet> = {};
  const baseNames = Object.keys(base);

  for (const [setName, value] of Object.entries(source)) {
    let frames: Record<string, Frame>;
    try {
      frames = parseFrames(value, boxes, palettes);
    } catch (error) {
      if (error instanceof SpriteSheetError) {
        // Re-thrown with the set named: the message is read by whoever is
        // editing the art, and "frame hop_3 row 12" is ambiguous across sets.
        fail(`frame set "${setName}": ${error.message.replace(/^sprite sheet: /, '')}`);
      }
      throw error;
    }

    const missing = baseNames.filter((name) => frames[name] === undefined);
    if (missing.length > 0) {
      fail(
        `frame set "${setName}" is missing ${missing.length} frame(s) the base set has, ` +
          `starting with "${missing[0] as string}" — the coat switcher swaps sets ` +
          `mid-animation and keeps the frame index, so both sets must draw the same names`
      );
    }
    const extra = Object.keys(frames).filter((name) => base[name] === undefined);
    if (extra.length > 0) {
      fail(
        `frame set "${setName}" has ${extra.length} frame(s) the base set does not, ` +
          `starting with "${extra[0] as string}" — no animation would ever play it`
      );
    }
    for (const name of baseNames) {
      const mine = frames[name] as Frame;
      const theirs = base[name] as Frame;
      if (mine.box !== theirs.box) {
        fail(
          `frame set "${setName}" draws "${name}" in box "${mine.box}", but the base set ` +
            `draws it in "${theirs.box}" — the window is sized from the base set's boxes`
        );
      }
    }

    sets[setName] = frames;
  }

  return sets;
}

/**
 * Validate `paletteFrameSets`: which coat draws which set.
 *
 * Both ends must exist. A palette that is not in the sheet would be a mapping
 * nothing can reach; a set that is not in the sheet would send the renderer to
 * `frames` anyway, silently drawing the wrong coat's pixels — which looks like a
 * rendering bug rather than a missing entry, and is the harder of the two to
 * find.
 */
function parsePaletteFrameSets(
  raw: unknown,
  palettes: Record<string, Palette>,
  frameSets: Record<string, FrameSet>
): Record<string, string> {
  if (raw === undefined) return {};
  const source = requireObject(raw, '"paletteFrameSets"');
  const result: Record<string, string> = {};

  for (const [paletteName, value] of Object.entries(source)) {
    if (palettes[paletteName] === undefined) {
      fail(
        `"paletteFrameSets" names palette "${paletteName}", which the sheet does not ` +
          `define (has ${Object.keys(palettes).join(', ')})`
      );
    }
    if (typeof value !== 'string' || frameSets[value] === undefined) {
      fail(
        `"paletteFrameSets"."${paletteName}" names frame set "${String(value)}", which the ` +
          `sheet does not carry (has ${Object.keys(frameSets).join(', ') || 'none'})`
      );
    }
    result[paletteName] = value;
  }

  return result;
}

/** A whole-pixel coordinate. Fractions would land the glyph on a half pixel. */
function isWholePixel(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * The one box every frame of an animation is drawn in.
 *
 * An anchor is expressed in that box's coordinates, so an animation whose frames
 * straddled two boxes could not have one — the same `x` would mean two different
 * places. The art has never done this (`test/sync-sheet.test.ts` asserts it for
 * `sleep`, the only box it would matter for), and the check is here so that if it
 * ever did, the message says so instead of the `?` quietly landing off the head.
 */
function animationBox(
  name: string,
  animation: Animation,
  frames: Record<string, Frame>
): string {
  const first = frames[animation.frames[0] as string] as Frame;
  const box = first.box;
  for (const frameName of animation.frames) {
    const other = frames[frameName] as Frame;
    if (other.box !== box) {
      fail(
        `"decorAnchors" names animation "${name}", whose frames span boxes ` +
          `"${box}" and "${other.box}" — an anchor is in one box's coordinates`
      );
    }
  }
  return box;
}

/**
 * Validate `decorAnchors`, the art's statement of where the app may draw a
 * decoration sprite.
 *
 * Every rule here exists to make the renderer's job unconditional — it looks an
 * anchor up and blits, with no bounds arithmetic and no fallback:
 *
 *  - the animation must exist, or the anchor is dead weight nobody will notice;
 *  - the decoration must name a box **and** an animation of that box, because
 *    the renderer draws the first frame of `animations[decor]` and a decoration
 *    with a box but no animation has no frame to draw;
 *  - coordinates must be whole pixels, and the decoration box must fit **inside**
 *    the animation's box. The in-box rule is the one the *app* depends on: the
 *    standing box's top rows are the speech-bubble reserve, and a `?` placed
 *    above the box would either be clipped by the window or collide with a bark
 *    bubble's tail. The art pipeline has the headroom to satisfy it
 *    (`SLEEP_DECOR_HEADROOM_ROWS` in `art/strips.py`), so the sheet is where the
 *    problem gets solved rather than at draw time.
 */
function parseDecorAnchors(
  raw: unknown,
  boxes: Record<string, Box>,
  frames: Record<string, Frame>,
  animations: Record<string, Animation>
): DecorAnchors {
  if (raw === undefined) return {};
  const source = requireObject(raw, '"decorAnchors"');
  const result: Record<string, Record<string, DecorAnchor>> = {};

  for (const [animationName, value] of Object.entries(source)) {
    const animation = animations[animationName];
    if (animation === undefined) {
      fail(`"decorAnchors" names unknown animation "${animationName}"`);
    }
    const boxName = animationBox(animationName, animation, frames);
    const [boxWidth, boxHeight] = boxes[boxName] as Box;

    const entries = requireObject(value, `"decorAnchors" entry "${animationName}"`);
    const anchors: Record<string, DecorAnchor> = {};

    for (const [decor, anchor] of Object.entries(entries)) {
      const decorBox = boxes[decor];
      if (decorBox === undefined) {
        fail(
          `decoration anchor "${animationName}"."${decor}" names no box — a ` +
            `decoration is a box of its own (has ${Object.keys(boxes).join(', ')})`
        );
      }
      const decorAnimation = animations[decor];
      if (decorAnimation === undefined) {
        fail(
          `decoration anchor "${animationName}"."${decor}" has box "${decor}" but no ` +
            `animation of the same name — the renderer draws its first frame`
        );
      }
      const decorFrame = frames[decorAnimation.frames[0] as string] as Frame;
      if (decorFrame.box !== decor) {
        fail(
          `decoration anchor "${animationName}"."${decor}": animation "${decor}" draws ` +
            `box "${decorFrame.box}", not "${decor}"`
        );
      }

      const at = requireObject(anchor, `decoration anchor "${animationName}"."${decor}"`);
      const x = at['x'];
      const y = at['y'];
      if (!isWholePixel(x) || !isWholePixel(y)) {
        fail(
          `decoration anchor "${animationName}"."${decor}" must be whole-pixel ` +
            `{x, y}, got {${String(x)}, ${String(y)}}`
        );
      }

      const [decorWidth, decorHeight] = decorBox;
      if (x < 0 || y < 0 || x + decorWidth > boxWidth || y + decorHeight > boxHeight) {
        fail(
          `decoration anchor "${animationName}"."${decor}" at (${x}, ${y}) puts a ` +
            `${decorWidth}x${decorHeight} decoration outside the ${boxWidth}x${boxHeight} ` +
            `"${boxName}" box`
        );
      }

      anchors[decor] = { x, y };
    }

    result[animationName] = anchors;
  }

  return result;
}

/**
 * Validate untyped sheet JSON and return it as a `SpriteSheet`.
 *
 * Throws `SpriteSheetError` with a message naming the exact frame, row and
 * column at fault — the art is hand-written, so a bad sheet must say what to fix
 * rather than surfacing later as an invisible mascot.
 */
export function validateSheet(json: unknown): SpriteSheet {
  const root = requireObject(json, 'sheet');
  const boxes = parseBoxes(root['boxes']);
  const palettes = parsePalettes(root['palettes']);
  const frames = parseFrames(root['frames'], boxes, palettes);
  const animations = parseAnimations(root['animations'], frames);
  const frameSets = parseFrameSets(root['frameSets'], boxes, palettes, frames);
  const paletteFrameSets = parsePaletteFrameSets(root['paletteFrameSets'], palettes, frameSets);
  const decorAnchors = parseDecorAnchors(root['decorAnchors'], boxes, frames, animations);
  return { boxes, palettes, frames, animations, frameSets, paletteFrameSets, decorAnchors };
}

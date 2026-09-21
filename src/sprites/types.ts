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
  /**
   * While parked by `hold`, keep cycling the **last `holdLoop` frames** at their
   * own durations instead of standing still.
   *
   * The art declares it for the same reason it declares `hold`: it is a property
   * of the drawing. Yuna's `perk` is her batting a yarn ball, and that gesture
   * does not end — the ball goes on swinging while the woof is on screen — so the
   * last two of its six frames alternate until something releases the pose.
   * Walder's `perk` ends ears-up and simply stops, which is `holdLoop: 1`.
   *
   * Always a number on a validated sheet (absent in the JSON means `1`), so no
   * consumer needs `?? 1`. Meaningless without `hold` — there is no parked state
   * to cycle in — and it cannot be longer than the animation it is a tail of, so
   * `validateSheet` rejects both rather than interpreting them.
   */
  readonly holdLoop: number;
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

/**
 * A second mascot: its own coats, its own animation table, its own anchors.
 *
 * A *character* rather than another frame set, because Yuna is not Walder in a
 * cat's colours — her `perk` has six frames to his three and her `tail_wag`
 * three to his four. `frameSets` exists for a coat a palette cannot express, and
 * its whole premise is that the frame index carries straight across; two
 * gestures of different lengths cannot share an index, so the animation table
 * has to fork wherever the drawing does.
 *
 * Everything else stays shared on purpose. The boxes, the decoration sprites and
 * the names the app hard-codes are the same for both, so every consumer goes on
 * working by name: `sheetFor` (in `contract.ts`) is the one call that swaps a
 * character's tables in, and nothing downstream knows there are two.
 */
export interface Character {
  /** Display name — card title, screen reader. */
  readonly name: string;
  /**
   * The palettes this character owns, in menu order. A palette listed here is
   * *not* offered under the base character; see `palettesFor`.
   */
  readonly palettes: readonly string[];
  /**
   * Per-coat display-name override, `{}` when the art declares none.
   *
   * One coat can be somebody in particular: the tuxedo cat is the owner's own
   * Buda, and shows as that wherever the *character's* name is shown, while the
   * coat keeps its plain name in the Colour menu — which is a list of colours.
   */
  readonly paletteNames: Readonly<Record<string, string>>;
  /** The character's whole animation table, standing in for the sheet's. */
  readonly animations: Readonly<Record<string, Animation>>;
  /** Anchors for the character's own poses; the sheet's rules, its own numbers. */
  readonly decorAnchors: DecorAnchors;
}

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
  /**
   * The cast beyond the base mascot, by key. Optional in the JSON, always
   * present here — `{}` on every sheet drawn before 2026-09-21, which is every
   * sheet that draws only Walder. An empty map means every palette belongs to
   * the base character and `sheetFor` hands back the sheet unchanged.
   */
  readonly characters: Readonly<Record<string, Character>>;
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

    // Absent is the common case and means "park still", which is what every
    // animation drawn before Yuna does.
    const rawHoldLoop = anim['holdLoop'];
    if (
      rawHoldLoop !== undefined &&
      (typeof rawHoldLoop !== 'number' || !Number.isInteger(rawHoldLoop) || rawHoldLoop < 1)
    ) {
      fail(
        `animation "${name}" has "holdLoop" ${String(rawHoldLoop)} — it counts frames, ` +
          `so it must be a whole number of at least 1`
      );
    }
    if (rawHoldLoop !== undefined && !hold) {
      fail(
        `animation "${name}" has "holdLoop" but not "hold" — there is no parked ` +
          `state to cycle in unless the animation parks on its end`
      );
    }
    const holdLoop = rawHoldLoop === undefined ? 1 : rawHoldLoop;
    if (holdLoop > frameNames.length) {
      fail(
        `animation "${name}" has "holdLoop" ${holdLoop} but only ${frameNames.length} ` +
          `frame(s) — the loop is a tail of the animation, not more of it`
      );
    }

    animations[name] = {
      frames: frameNames as string[],
      durationsMs: durations as number[],
      loop,
      hold,
      holdLoop
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
 *
 * A set owned by a **character** (`owners`) is held to the second rule and not
 * the first, against its siblings rather than against the base: Yuna's `perk` is
 * six frames where Walder's is three, so parity with the base is exactly what
 * she cannot have. Parity *within* a character is still the interchangeability
 * rule above, for the same reason — the Colour menu swaps her coats
 * mid-animation and keeps the index.
 */
function parseFrameSets(
  raw: unknown,
  boxes: Record<string, Box>,
  palettes: Record<string, Palette>,
  base: Record<string, Frame>,
  owners: Record<string, string>
): Record<string, FrameSet> {
  if (raw === undefined) return {};
  const source = requireObject(raw, '"frameSets"');
  const sets: Record<string, FrameSet> = {};
  const baseNames = Object.keys(base);
  /** The first set seen for each character — what its siblings are matched to. */
  const reference: Record<string, { set: string; frames: Record<string, Frame> }> = {};

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

    if (Object.hasOwn(owners, setName)) {
      const character = owners[setName] as string;
      const first = reference[character];
      if (first === undefined) {
        reference[character] = { set: setName, frames };
      } else {
        matchFrameNames(setName, frames, first.set, first.frames, character);
      }
      sets[setName] = frames;
      continue;
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
 * Two coats of one character must draw exactly the same names in the same boxes.
 *
 * The same interchangeability rule the base sets are held to, stated against a
 * sibling instead of against `frames`: a character's coats are one drawing in
 * five colourways, the Colour menu swaps them under a running clock, and the
 * frame index carries across.
 */
function matchFrameNames(
  setName: string,
  frames: Record<string, Frame>,
  otherName: string,
  other: Record<string, Frame>,
  character: string
): void {
  const missing = Object.keys(other).filter((name) => frames[name] === undefined);
  const extra = Object.keys(frames).filter((name) => other[name] === undefined);
  const odd = missing[0] ?? extra[0];
  if (odd !== undefined) {
    fail(
      `frame sets "${setName}" and "${otherName}" both draw character "${character}" but ` +
        `disagree about "${odd}" — the coat switcher swaps sets mid-animation and keeps ` +
        `the frame index, so every coat of one character must draw the same names`
    );
  }
  for (const [name, mine] of Object.entries(frames)) {
    const theirs = other[name] as Frame;
    if (mine.box !== theirs.box) {
      fail(
        `frame set "${setName}" draws "${name}" in box "${mine.box}", but "${otherName}" — ` +
          `the same character "${character}" — draws it in "${theirs.box}"`
      );
    }
  }
}

/**
 * Which frame sets belong to a character, as `set -> character`.
 *
 * Read off the *raw* JSON, before either end has been validated, because the two
 * rules are circular otherwise: a character set is validated differently from a
 * base set, and a character's own table is validated against its set. Nothing
 * here reports a fault — a malformed entry is simply not counted as ownership,
 * and `parseCharacters` and `parsePaletteFrameSets` produce the real message a
 * moment later. `Object.hasOwn` throughout: both maps come from JSON.
 */
function characterSetOwners(rawCharacters: unknown, rawPaletteFrameSets: unknown): Record<string, string> {
  if (!isPlainObject(rawCharacters) || !isPlainObject(rawPaletteFrameSets)) return {};
  const owners: Record<string, string> = {};
  for (const [character, value] of Object.entries(rawCharacters)) {
    if (!isPlainObject(value)) continue;
    const palettes = value['palettes'];
    if (!Array.isArray(palettes)) continue;
    for (const palette of palettes as unknown[]) {
      if (typeof palette !== 'string' || !Object.hasOwn(rawPaletteFrameSets, palette)) continue;
      const setName = rawPaletteFrameSets[palette];
      if (typeof setName === 'string') owners[setName] = character;
    }
  }
  return owners;
}

/**
 * Validate `characters`: the cast beyond the base mascot.
 *
 * A character is a name, the coats it owns, and its own copies of the two tables
 * the sheet otherwise holds once. Each coat must be a palette the sheet defines
 * *and* draw a frame set of its own — a character that is only a palette swap of
 * Walder is a coat, and belongs in `palettes` with no entry here.
 *
 * The two tables go through `parseAnimations` and `parseDecorAnchors` unchanged,
 * against the character's **own** frames, so a cat's `perk` is held to exactly
 * the standards the dog's is and every frame she names has to be drawn in every
 * coat she owns — the first set stands for all of them, because `parseFrameSets`
 * has already insisted they draw the same names.
 */
function parseCharacters(
  raw: unknown,
  boxes: Record<string, Box>,
  palettes: Record<string, Palette>,
  frameSets: Record<string, FrameSet>,
  paletteFrameSets: Record<string, string>
): Record<string, Character> {
  if (raw === undefined) return {};
  const source = requireObject(raw, '"characters"');
  const result: Record<string, Character> = {};

  for (const [key, value] of Object.entries(source)) {
    const entry = requireObject(value, `character "${key}"`);

    const name = entry['name'];
    if (typeof name !== 'string' || name.length === 0) {
      fail(`character "${key}" needs a non-empty "name" — it is shown on screen`);
    }

    const owned = entry['palettes'];
    if (!Array.isArray(owned) || owned.length === 0) {
      fail(`character "${key}" needs a non-empty "palettes" array`);
    }
    for (const palette of owned as unknown[]) {
      if (typeof palette !== 'string' || !Object.hasOwn(palettes, palette)) {
        fail(
          `character "${key}" owns palette "${String(palette)}", which the sheet does not ` +
            `define (has ${Object.keys(palettes).join(', ')})`
        );
      }
      if (!Object.hasOwn(paletteFrameSets, palette)) {
        fail(
          `character "${key}" owns palette "${palette}", which draws no frame set of its ` +
            `own — a character is a drawing, not a recolour of the base one`
        );
      }
    }

    const rawNames = entry['paletteNames'];
    const paletteNames: Record<string, string> = {};
    if (rawNames !== undefined) {
      const names = requireObject(rawNames, `character "${key}" "paletteNames"`);
      for (const [palette, display] of Object.entries(names)) {
        if (!(owned as string[]).includes(palette)) {
          fail(`character "${key}" renames palette "${palette}", which it does not own`);
        }
        if (typeof display !== 'string' || display.length === 0) {
          fail(`character "${key}" "paletteNames"."${palette}" must be a non-empty string`);
        }
        paletteNames[palette] = display;
      }
    }

    const setName = paletteFrameSets[(owned as string[])[0] as string] as string;
    const frames = frameSets[setName] as Record<string, Frame>;
    let animations: Record<string, Animation>;
    let decorAnchors: DecorAnchors;
    try {
      animations = parseAnimations(entry['animations'], frames);
      decorAnchors = parseDecorAnchors(entry['decorAnchors'], boxes, frames, animations);
    } catch (error) {
      if (error instanceof SpriteSheetError) {
        // Named, for the same reason a frame set's failures are: "animation perk
        // references unknown frame perk_5" is ambiguous once there are two casts.
        fail(`character "${key}": ${error.message.replace(/^sprite sheet: /, '')}`);
      }
      throw error;
    }

    result[key] = { name, palettes: owned as string[], paletteNames, animations, decorAnchors };
  }

  return result;
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
  const owners = characterSetOwners(root['characters'], root['paletteFrameSets']);
  const frameSets = parseFrameSets(root['frameSets'], boxes, palettes, frames, owners);
  const paletteFrameSets = parsePaletteFrameSets(root['paletteFrameSets'], palettes, frameSets);
  const decorAnchors = parseDecorAnchors(root['decorAnchors'], boxes, frames, animations);
  const characters = parseCharacters(root['characters'], boxes, palettes, frameSets, paletteFrameSets);
  return {
    boxes,
    palettes,
    frames,
    animations,
    frameSets,
    paletteFrameSets,
    decorAnchors,
    characters
  };
}

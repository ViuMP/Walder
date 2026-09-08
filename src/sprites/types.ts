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
}

export interface SpriteSheet {
  readonly boxes: Readonly<Record<string, Box>>;
  readonly palettes: Readonly<Record<string, Palette>>;
  readonly frames: Readonly<Record<string, Frame>>;
  readonly animations: Readonly<Record<string, Animation>>;
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

    animations[name] = {
      frames: frameNames as string[],
      durationsMs: durations as number[],
      loop
    };
  }

  if (Object.keys(animations).length === 0) fail('"animations" is empty');
  return animations;
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
  return { boxes, palettes, frames, animations };
}

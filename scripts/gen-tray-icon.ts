/**
 * `npm run gen:tray` — writes the four tray icon PNGs into `build/`.
 *
 * The icons are generated rather than checked in as binary blobs so they stay
 * reviewable: the artwork below is a text grid, and the PNG encoder is 40 lines
 * of `zlib` (a Node built-in — no dependency is added for this).
 *
 * Two variants, because the platforms differ in kind and not in degree:
 *
 *  - `trayTemplate.png` / `@2x` — **macOS**. A template image carries its shape
 *    in the alpha channel and is *tinted by the system*, so it is drawn as pure
 *    black with hard alpha and comes out correct on a light or dark menu bar.
 *    The `Template` suffix is what makes macOS treat it as one, and `tray.ts`
 *    also calls `setTemplateImage(true)`.
 *  - `tray-win.png` / `@2x` — **Windows and Linux**, which do no such tinting.
 *    The macOS file there is black on transparent, i.e. invisible on the default
 *    dark taskbar. This one is a white bone with a one-pixel dark outline, which
 *    reads on a dark *and* a light taskbar without knowing which it is.
 *
 * Runs before `dev` and `build` via npm's `pre*` hooks, so the files always
 * exist before the app looks for them.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * A bone, 16x16, `#` = ink. Reads as a dog thing at menu-bar size, where a whole
 * dog would be mud.
 */
const BONE = [
  '................',
  '................',
  '................',
  '.##..........##.',
  '####........####',
  '####........####',
  '.#####....#####.',
  '..############..',
  '..############..',
  '.#####....#####.',
  '####........####',
  '####........####',
  '.##..........##.',
  '................',
  '................',
  '................'
];

const SIZE = 16;

/** CRC-32, table built once. Required by every PNG chunk. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xff_ff_ff_ff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xff_ff_ff_ff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Encode 8-bit RGBA pixel rows as a PNG. `rgba` is `width * height * 4` bytes. */
function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // no filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type byte (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1
    );
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function isInk(gx: number, gy: number): boolean {
  if (gx < 0 || gy < 0 || gx >= SIZE || gy >= SIZE) return false;
  return (BONE[gy] as string)[gx] === '#';
}

/**
 * Is this grid cell part of the one-pixel outline? Empty, but touching ink —
 * including diagonally, or the corners of the bone would leak.
 */
function isOutline(gx: number, gy: number): boolean {
  if (isInk(gx, gy)) return false;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (isInk(gx + dx, gy + dy)) return true;
    }
  }
  return false;
}

/**
 * Render the grid at `factor`x with nearest-neighbour scaling.
 *
 * `light: false` is the macOS template: black, shape in the alpha channel.
 * `light: true` is the Windows/Linux variant: white ink, dark outline, both
 * opaque, everything else transparent.
 */
function render(factor: number, light: boolean): Buffer {
  const size = SIZE * factor;
  const rgba = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const gy = Math.floor(y / factor);
    for (let x = 0; x < size; x++) {
      const gx = Math.floor(x / factor);
      const i = (y * size + x) * 4;

      if (isInk(gx, gy)) {
        if (light) {
          rgba[i] = 255;
          rgba[i + 1] = 255;
          rgba[i + 2] = 255;
        }
        // The macOS template leaves RGB at 0: black, and the system tints it.
        rgba[i + 3] = 255;
        continue;
      }

      if (light && isOutline(gx, gy)) {
        // Near-black rather than pure black, so it reads as an outline and not
        // as a second shape when the taskbar behind it is dark.
        rgba[i] = 26;
        rgba[i + 1] = 26;
        rgba[i + 2] = 26;
        rgba[i + 3] = 255;
      }
    }
  }

  return encodePng(size, size, rgba);
}

const buildDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
mkdirSync(buildDir, { recursive: true });

for (const [factor, light, name] of [
  [1, false, 'trayTemplate.png'],
  [2, false, 'trayTemplate@2x.png'],
  [1, true, 'tray-win.png'],
  [2, true, 'tray-win@2x.png']
] as const) {
  const file = join(buildDir, name);
  writeFileSync(file, render(factor, light));
  console.log(`wrote ${file} (${SIZE * factor}x${SIZE * factor})`);
}

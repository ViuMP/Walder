/**
 * A minimal PNG writer, shared by the icon-generating scripts.
 *
 * It exists so that neither `gen-tray-icon.ts` nor `gen-icons.ts` needs an image
 * library. Both write pixel art with hard edges and exact colours, which is the
 * one case where "encode RGBA, no filtering, no colour management" is not a
 * compromise but the correct output — and `node:zlib` already ships the only
 * non-trivial part (deflate). Adding `sharp`/`jimp` would pull a native or
 * multi-megabyte dependency into a project whose entire image need is this file.
 *
 * Extracted from `gen-tray-icon.ts` (where it lived first) when `gen-icons.ts`
 * needed the same 40 lines. The code is unchanged by that move on purpose: the
 * tray PNGs are checked byte-for-byte by hand against the previous build, so the
 * chunk order, the filter choice and `level: 9` must stay exactly as they were.
 *
 * The encoder is deliberately dumb: colour type 6 (RGBA) always, no palette
 * quantisation, no `tRNS`, filter type 0 on every scanline. A pixel-art sprite
 * has few colours and would compress smaller as an indexed PNG, but these files
 * are 16x16 to 1024x1024 build artefacts where a few hundred bytes buys nothing,
 * and an indexed writer has real edge cases (>256 colours, alpha) that this one
 * cannot get wrong.
 */
import { deflateSync } from 'node:zlib';

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

export function crc32(buf: Buffer): number {
  let c = 0xff_ff_ff_ff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xff_ff_ff_ff) >>> 0;
}

export function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** The 8 bytes every PNG starts with. Exported so readers can assert on it. */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encode 8-bit RGBA pixel rows as a PNG. `rgba` is `width * height * 4` bytes. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
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
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

"""Exit 0 when two handbook builds show the same thing, 1 when they differ.

    python3 docs/handbook/same_handbook.py a.html b.html

Used by .github/workflows/pages.yml to check that the committed
docs/HANDBOOK.html is what the sources build today. A plain byte compare is not
enough: art/render.mjs writes its PNGs with Node's deflate, and the compressed
bytes may differ between machines and Node versions for the same pixels. So each
embedded PNG is compared by its header and its decompressed image data, and
every other byte of the page exactly.
"""
import base64
import hashlib
import re
import struct
import sys
import zlib

PNG = re.compile(rb"data:image/png;base64,([A-Za-z0-9+/=]+)")


def _pixels(m):
    png = base64.b64decode(m.group(1))
    pos, ihdr, idat = 8, b"", b""
    while pos < len(png):
        (n,) = struct.unpack(">I", png[pos:pos + 4])
        kind, body = png[pos + 4:pos + 8], png[pos + 8:pos + 8 + n]
        if kind == b"IHDR":
            ihdr = body
        elif kind == b"IDAT":
            idat += body
        pos += 12 + n
    return b"png:" + hashlib.sha256(ihdr + zlib.decompress(idat)).hexdigest().encode()


def normalised(path):
    with open(path, "rb") as f:
        return PNG.sub(_pixels, f.read())


if __name__ == "__main__":
    a, b = sys.argv[1:3]
    if normalised(a) != normalised(b):
        print(f"{a} and {b} differ: rebuild with python3 docs/handbook/build_walder.py "
              "(after node art/render.mjs) and commit docs/HANDBOOK.html")
        sys.exit(1)
    print("handbook matches its sources")

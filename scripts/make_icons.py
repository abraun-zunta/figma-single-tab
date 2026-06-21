#!/usr/bin/env python3
"""Generate the extension's PNG icons without any third-party dependencies.

Concept: two overlapping browser "tabs" collapsing into one — the back tab is
faded, the front tab is solid — on a Figma-blue rounded tile. Rendered with 4x
supersampling for smooth, anti-aliased edges.

Run: python3 scripts/make_icons.py
"""
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "icons")
SS = 4  # supersampling factor

# Palette
BLUE = (13, 153, 255)      # Figma blue tile
BLUE_DK = (10, 122, 204)   # subtle bottom shade
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded(x, y, w, h, r):
    def inside(px, py):
        if px < x or px >= x + w or py < y or py >= y + h:
            return False
        cx = min(max(px, x + r), x + w - 1 - r)
        cy = min(max(py, y + r), y + h - 1 - r)
        dx, dy = px - cx, py - cy
        return dx * dx + dy * dy <= r * r
    return inside


def over(dst, src):
    """Alpha-composite src (r,g,b,a 0..255) over dst (r,g,b,a)."""
    sa = src[3] / 255.0
    da = dst[3] / 255.0
    oa = sa + da * (1 - sa)
    if oa == 0:
        return (0, 0, 0, 0)
    out = []
    for i in range(3):
        out.append(round((src[i] * sa + dst[i] * da * (1 - sa)) / oa))
    return (out[0], out[1], out[2], round(oa * 255))


def tab_shape(x, y, w, h, r):
    """A browser-tab silhouette: a rounded card with a small tab ear on top."""
    body = rounded(x, y + h * 0.18, w, h * 0.82, r)
    ear = rounded(x + w * 0.12, y, w * 0.5, h * 0.32, r * 0.6)
    return lambda px, py: body(px, py) or ear(px, py)


def render(size):
    S = size * SS
    radius = S * 0.22
    bg = rounded(0, 0, S, S, radius)

    # Two tabs, offset diagonally.
    tw, th, tr = S * 0.46, S * 0.5, S * 0.06
    back = tab_shape(S * 0.20, S * 0.18, tw, th, tr)   # faded, behind
    front = tab_shape(S * 0.34, S * 0.32, tw, th, tr)  # solid, in front

    buf = [(0, 0, 0, 0)] * (S * S)
    for py in range(S):
        v = py / (S - 1)
        bgcol = (*lerp(BLUE, BLUE_DK, v), 255)
        for px in range(S):
            i = py * S + px
            if not bg(px, py):
                continue
            c = bgcol
            if back(px, py):
                c = over(c, (*WHITE, 150))
            if front(px, py):
                # thin blue keyline so the front tab reads on top of the back
                c = over(c, (*BLUE, 255))
                c = over(c, (*WHITE, 255))
            buf[i] = c

    # Downsample SSxSS -> 1x1 by averaging.
    out = bytearray()
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for dy in range(SS):
                for dx in range(SS):
                    px = buf[(y * SS + dy) * S + (x * SS + dx)]
                    a += px[3]
                    r += px[0] * px[3]
                    g += px[1] * px[3]
                    b += px[2] * px[3]
            n = SS * SS
            if a == 0:
                out += bytes((0, 0, 0, 0))
            else:
                out += bytes((round(r / a), round(g / a), round(b / a), round(a / n)))
    return out


def write_png(path, size, rgba):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(
            ">I", zlib.crc32(c) & 0xFFFFFFFF
        )

    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        write_png(os.path.join(OUT_DIR, f"icon{size}.png"), size, render(size))
        print(f"wrote icons/icon{size}.png")


if __name__ == "__main__":
    main()

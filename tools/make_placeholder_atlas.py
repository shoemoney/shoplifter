#!/usr/bin/env python3
"""Generates public/assets/atlas.png — the Milestone 0 placeholder sprite sheet.

Committing a generator instead of hand-painted art keeps the repo free of binary churn while
art direction is still an open decision in the PRD. Premultiplied alpha, to match the sampler.
"""
import math
import struct
import zlib
from pathlib import Path

W = H = 128
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "assets" / "atlas.png"

px = [[(0, 0, 0, 0) for _ in range(W)] for _ in range(H)]


def put(x, y, rgba):
    if 0 <= x < W and 0 <= y < H:
        r, g, b, a = rgba
        af = a / 255.0
        px[y][x] = (int(r * af), int(g * af), int(b * af), a)


def rect(x0, y0, w, h, rgba):
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            put(x, y, rgba)


def disc(cx, cy, radius, rgba):
    for y in range(int(cy - radius) - 1, int(cy + radius) + 2):
        for x in range(int(cx - radius) - 1, int(cx + radius) + 2):
            d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
            if d <= radius:
                edge = min(1.0, radius - d)
                r, g, b, a = rgba
                put(x, y, (r, g, b, int(a * edge)))


# 0,0 32x32 — white square: solid quads, bars, flat colour fills
rect(0, 0, 32, 32, (255, 255, 255, 255))

# 32,0 32x32 — soft disc: particles, muzzle flash, lights
disc(48, 16, 14.5, (255, 255, 255, 255))

# 64,0 48x24 — helicopter body placeholder
rect(68, 8, 34, 10, (126, 142, 160, 255))
rect(96, 6, 14, 6, (108, 122, 138, 255))   # tail boom
rect(72, 18, 22, 3, (86, 96, 110, 255))    # skids
rect(74, 10, 12, 6, (64, 176, 214, 255))   # canopy

# 0,32 64x6 — rotor blade
rect(0, 33, 64, 3, (196, 204, 214, 255))

# 0,40 8x16 — civilian placeholder
rect(2, 40, 4, 5, (226, 200, 170, 255))
rect(1, 45, 6, 8, (212, 130, 74, 255))
rect(2, 53, 2, 3, (70, 74, 86, 255))
rect(5, 53, 2, 3, (70, 74, 86, 255))

# 16,40 32x16 — ground strip (vertical gradient so parallax layers read as depth)
for y in range(16):
    t = y / 15
    shade = int(96 - 46 * t)
    rect(16, 40 + y, 32, 1, (shade + 30, shade + 18, shade, 255))

# 56,40 8x8 — star
put(59, 43, (255, 255, 255, 255))
put(60, 43, (255, 255, 255, 255))
put(59, 44, (255, 255, 255, 255))
put(60, 44, (255, 255, 255, 255))
for x, y in ((58, 43), (61, 43), (58, 44), (61, 44), (59, 42), (60, 42), (59, 45), (60, 45)):
    put(x, y, (255, 255, 255, 120))

# 0,64 64x64 — checkerboard: UV orientation debug and missing-asset stand-in
for y in range(64):
    for x in range(64):
        on = ((x // 8) + (y // 8)) % 2 == 0
        put(x, 64 + y, (255, 0, 255, 255) if on else (40, 40, 48, 255))

raw = b"".join(
    b"\x00" + b"".join(struct.pack("4B", *px[y][x]) for x in range(W)) for y in range(H)
)


def chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(raw, 9))
    + chunk(b"IEND", b"")
)

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_bytes(png)
print(f"wrote {OUT} ({len(png)} bytes, {W}x{H})")

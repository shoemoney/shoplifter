"""Ground vehicles, emplacements, projectiles, effects and terrain."""
import math

from spritelib import canvas, ellipse, line, outline, polygon, px, radial, rect, shade_top

OUT = (24, 26, 31, 255)
ARMOUR = (118, 106, 82, 255)
ARMOUR_MD = (92, 82, 62, 255)
ARMOUR_DK = (62, 56, 42, 255)
TREAD = (54, 50, 46, 255)
GUNMETAL = (66, 70, 76, 255)
METAL = (150, 156, 164, 255)


def tank_hull():
    """Light tank, side on. The turret is a separate sprite so it can traverse independently."""
    img = canvas(52, 22)
    # Hull with a sloped glacis.
    polygon(img, [(4, 8), (14, 4), (40, 4), (48, 8), (48, 14), (4, 14)], ARMOUR)
    rect(img, 4, 11, 44, 3, ARMOUR_MD)
    # Track run with road wheels — the detail that stops it reading as a brick.
    rect(img, 2, 14, 48, 5, TREAD)
    for i in range(6):
        ellipse(img, 4 + i * 8, 15, 6, 5, (82, 78, 72, 255))
        ellipse(img, 6 + i * 8, 17, 2, 2, (44, 42, 40, 255))
    for x in range(2, 50, 4):
        px(img, x, 14, (38, 36, 34, 255))
    # Rear exhaust and stowage.
    rect(img, 1, 6, 4, 4, ARMOUR_DK)
    rect(img, 34, 5, 10, 2, ARMOUR_DK)
    shade_top(img, (146, 132, 104, 255))
    outline(img, OUT)
    return img


def tank_turret():
    """Drawn separately and rotated by the renderer, so the firing line is readable."""
    img = canvas(34, 12)
    polygon(img, [(2, 4), (8, 1), (18, 1), (22, 5), (22, 9), (2, 9)], ARMOUR)
    rect(img, 2, 7, 20, 2, ARMOUR_MD)
    # Barrel and muzzle brake.
    rect(img, 22, 4, 10, 2, GUNMETAL)
    rect(img, 31, 3, 3, 4, (52, 56, 62, 255))
    shade_top(img, (146, 132, 104, 255))
    outline(img, OUT)
    return img


def aa_gun():
    """Twin-barrel AA on a low mount. Reads as 'pointing up' even when idle."""
    img = canvas(34, 30)
    # Base and sandbags.
    rect(img, 2, 22, 30, 6, (112, 102, 78, 255))
    for i in range(4):
        ellipse(img, 2 + i * 8, 20, 9, 6, (134, 124, 96, 255))
    # Mount and gunner shield.
    rect(img, 12, 15, 10, 8, ARMOUR_MD)
    polygon(img, [(9, 14), (25, 14), (25, 20), (9, 20)], ARMOUR)
    # Twin barrels, elevated.
    polygon(img, [(16, 14), (31, 2), (33, 4), (18, 16)], GUNMETAL)
    polygon(img, [(14, 14), (29, 2), (31, 4), (16, 16)], GUNMETAL)
    # Radar dish — the scan-cone variant the PRD calls out.
    ellipse(img, 2, 8, 9, 9, (166, 172, 180, 255))
    ellipse(img, 4, 10, 5, 5, (96, 102, 110, 255))
    line(img, 6, 12, 6, 21, METAL)
    shade_top(img, (150, 140, 112, 255))
    outline(img, OUT)
    return img


def radar_mast():
    """The destructible secondary objective."""
    img = canvas(26, 44)
    rect(img, 11, 10, 4, 32, (128, 134, 142, 255))
    for y in range(12, 42, 6):
        line(img, 11, y, 15, y + 3, (92, 98, 106, 255))
        line(img, 15, y, 11, y + 3, (92, 98, 106, 255))
    ellipse(img, 2, 0, 22, 16, (176, 182, 190, 255))
    ellipse(img, 5, 3, 16, 10, (104, 110, 118, 255))
    rect(img, 11, 40, 4, 4, (72, 76, 82, 255))
    outline(img, OUT)
    return img


def bullet():
    img = canvas(8, 4)
    rect(img, 0, 1, 8, 2, (255, 236, 176, 255))
    rect(img, 6, 1, 2, 2, (255, 255, 236, 255))
    return img


def rocket():
    img = canvas(16, 6)
    rect(img, 4, 2, 10, 2, (178, 184, 192, 255))
    polygon(img, [(14, 1), (16, 3), (14, 5)], (222, 96, 64, 255))
    polygon(img, [(4, 0), (7, 2), (4, 2)], (120, 126, 134, 255))
    polygon(img, [(4, 4), (7, 4), (4, 6)], (120, 126, 134, 255))
    radial(img, 2, 3, 5, (255, 200, 120, 220), (255, 110, 40, 0))
    return img


def flare():
    img = canvas(10, 10)
    radial(img, 5, 5, 5, (255, 244, 214, 255), (255, 150, 60, 0), power=1.1)
    return img


def glow():
    """Soft disc for particles, muzzle flashes and lights."""
    img = canvas(32, 32)
    radial(img, 16, 16, 16, (255, 255, 255, 255), (255, 255, 255, 0), power=1.9)
    return img


def spark():
    img = canvas(6, 6)
    rect(img, 0, 2, 6, 2, (255, 228, 168, 255))
    rect(img, 2, 0, 2, 6, (255, 228, 168, 200))
    return img


def smoke():
    img = canvas(24, 24)
    radial(img, 12, 12, 12, (188, 184, 178, 190), (150, 146, 140, 0), power=1.3)
    return img


def white():
    img = canvas(8, 8)
    rect(img, 0, 0, 8, 8, (255, 255, 255, 255))
    return img


def star():
    img = canvas(8, 8)
    px(img, 3, 3, (255, 255, 255, 255))
    px(img, 4, 3, (255, 255, 255, 255))
    px(img, 3, 4, (255, 255, 255, 255))
    px(img, 4, 4, (255, 255, 255, 255))
    for x, y in ((2, 3), (5, 3), (2, 4), (5, 4), (3, 2), (4, 2), (3, 5), (4, 5)):
        px(img, x, y, (255, 255, 255, 120))
    return img


def ground_strip():
    """Vertical slice of terrain: lit crust on top, darkening into shadow below.

    Sampled as a single column and stretched horizontally by the renderer, so the vertical
    gradient is the only thing that matters — but it needs grain, or a 60 m cliff of flat tan
    is what you get.
    """
    img = canvas(32, 64)
    top = (142, 128, 98)
    bottom = (24, 21, 18)
    for y in range(64):
        t = (y / 63) ** 0.72
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        rect(img, 0, y, 32, 1, (*c, 255))
    # Crust highlight and a grit band just under it.
    rect(img, 0, 0, 32, 1, (196, 182, 142, 255))
    rect(img, 0, 1, 32, 1, (168, 154, 118, 255))
    # Deterministic grain: a fixed hash, so the atlas regenerates byte-identically.
    for y in range(2, 64):
        for x in range(32):
            h = (x * 73856093) ^ (y * 19349663)
            if (h >> 5) % 11 == 0:
                r, g, b, a = img.getpixel((x, y))
                d = 14 if (h >> 9) % 2 else -14
                img.putpixel((x, y), (max(0, min(255, r + d)), max(0, min(255, g + d)), max(0, min(255, b + d)), a))
    return img


def landing_pad():
    """Painted pad marking. Reads as prepared ground, which is exactly what the sim guarantees."""
    img = canvas(64, 16)
    rect(img, 0, 5, 64, 6, (88, 92, 96, 255))
    rect(img, 0, 5, 64, 1, (140, 146, 150, 255))
    for x in range(2, 62, 10):
        rect(img, x, 7, 6, 2, (226, 214, 160, 255))
    # Corner brackets.
    for x in (1, 57):
        rect(img, x, 3, 6, 2, (226, 214, 160, 255))
        rect(img, x, 11, 6, 2, (226, 214, 160, 255))
    return img

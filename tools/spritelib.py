"""Small pixel-art toolkit for the Shoplifter atlas generator.

Hard-edged on purpose: the sampler is `nearest`, so anti-aliasing here would only produce
halo pixels around every sprite. Everything draws into an RGBA PIL image with straight alpha;
the atlas writer premultiplies once at the end, because the shader blends premultiplied.
"""
from PIL import Image

TRANSPARENT = (0, 0, 0, 0)


def canvas(w, h):
    return Image.new("RGBA", (w, h), TRANSPARENT)


def px(img, x, y, color):
    x, y = int(round(x)), int(round(y))
    if 0 <= x < img.width and 0 <= y < img.height:
        img.putpixel((x, y), color)


# Every primitive below is rasterised here rather than by PIL.
#
# CI asserts that the committed atlas matches this generator pixel for pixel, and Pillow's
# rasterisers are not contracted to be stable across versions — a runner with a different
# Pillow produced a nine-pixel difference on identical source. Owning the rasterisation makes
# the output a function of this file alone.


def rect(img, x, y, w, h, color):
    x0, y0, w, h = int(round(x)), int(round(y)), int(round(w)), int(round(h))
    for py in range(y0, y0 + h):
        for pxx in range(x0, x0 + w):
            px(img, pxx, py, color)


def line(img, x0, y0, x1, y1, color):
    """Integer Bresenham."""
    x0, y0, x1, y1 = int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))
    dx = abs(x1 - x0)
    dy = -abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx + dy
    while True:
        px(img, x0, y0, color)
        if x0 == x1 and y0 == y1:
            return
        e2 = 2 * err
        if e2 >= dy:
            err += dy
            x0 += sx
        if e2 <= dx:
            err += dx
            y0 += sy


def ellipse(img, x, y, w, h, color):
    """Filled axis-aligned ellipse inside the box (x, y, w, h), scanline by scanline."""
    x, y, w, h = int(round(x)), int(round(y)), int(round(w)), int(round(h))
    if w <= 0 or h <= 0:
        return
    a = w / 2.0
    b = h / 2.0
    cx = x + a - 0.5
    cy = y + b - 0.5
    for row in range(h):
        py = y + row
        dy = (py - cy) / b
        if abs(dy) > 1.0:
            continue
        span = a * ((1.0 - dy * dy) ** 0.5)
        left = int(round(cx - span + 0.5))
        right = int(round(cx + span - 0.5))
        for pxx in range(left, right + 1):
            px(img, pxx, py, color)


def polygon(img, points, color):
    """Even-odd scanline fill. Closed automatically; vertices are rounded to the pixel grid."""
    pts = [(float(int(round(a))), float(int(round(b)))) for a, b in points]
    if len(pts) < 3:
        return
    top = int(min(p[1] for p in pts))
    bottom = int(max(p[1] for p in pts))
    for py in range(top, bottom + 1):
        sample = py + 0.5
        crossings = []
        for i in range(len(pts)):
            ax, ay = pts[i]
            bx, by = pts[(i + 1) % len(pts)]
            if ay == by:
                continue
            lo, hi = (ay, by) if ay < by else (by, ay)
            if not (lo <= sample < hi):
                continue
            crossings.append(ax + (sample - ay) * (bx - ax) / (by - ay))
        crossings.sort()
        for i in range(0, len(crossings) - 1, 2):
            left = int(round(crossings[i]))
            right = int(round(crossings[i + 1])) - 1
            for pxx in range(left, right + 1):
                px(img, pxx, py, color)


def replace(img, old, new):
    for y in range(img.height):
        for x in range(img.width):
            if img.getpixel((x, y)) == old:
                img.putpixel((x, y), new)


def outline(img, color, diagonal=False):
    """Traces a 1px border just outside every opaque pixel.

    A dark outline is what keeps a 16-pixel-tall civilian readable against terrain; without it
    sprites dissolve into the background at gameplay scale.
    """
    offsets = [(-1, 0), (1, 0), (0, -1), (0, 1)]
    if diagonal:
        offsets += [(-1, -1), (1, -1), (-1, 1), (1, 1)]
    src = img.copy()
    for y in range(img.height):
        for x in range(img.width):
            if src.getpixel((x, y))[3] != 0:
                continue
            for dx, dy in offsets:
                nx, ny = x + dx, y + dy
                if 0 <= nx < img.width and 0 <= ny < img.height and src.getpixel((nx, ny))[3] > 0:
                    img.putpixel((x, y), color)
                    break


def shade_top(img, color, rows=1):
    """Lightens the topmost opaque pixel of each column — a cheap, consistent key light."""
    for x in range(img.width):
        painted = 0
        for y in range(img.height):
            if img.getpixel((x, y))[3] > 0:
                img.putpixel((x, y), color)
                painted += 1
                if painted >= rows:
                    break


def shade_bottom(img, color, rows=1):
    for x in range(img.width):
        painted = 0
        for y in range(img.height - 1, -1, -1):
            if img.getpixel((x, y))[3] > 0:
                img.putpixel((x, y), color)
                painted += 1
                if painted >= rows:
                    break


def tint(img, color, amount):
    out = img.copy()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = out.getpixel((x, y))
            if a == 0:
                continue
            out.putpixel(
                (x, y),
                (
                    int(r + (color[0] - r) * amount),
                    int(g + (color[1] - g) * amount),
                    int(b + (color[2] - b) * amount),
                    a,
                ),
            )
    return out


def radial(img, cx, cy, radius, inner, outer, power=1.6):
    """Soft radial gradient for glows and explosion flashes."""
    for y in range(img.height):
        for x in range(img.width):
            d = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) ** 0.5
            if d > radius:
                continue
            t = (d / radius) ** power
            img.putpixel(
                (x, y),
                (
                    int(inner[0] + (outer[0] - inner[0]) * t),
                    int(inner[1] + (outer[1] - inner[1]) * t),
                    int(inner[2] + (outer[2] - inner[2]) * t),
                    int(inner[3] + (outer[3] - inner[3]) * t),
                ),
            )


def radial_over(img, cx, cy, radius, color, strength=1.0, power=1.4):
    """Blends a radial tint into pixels that are ALREADY opaque.

    `radial` writes unconditionally, which is right for a glow that *is* the sprite and wrong
    for scorching an existing one — there it paints a solid disc across the transparent margin.
    """
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = img.getpixel((x, y))
            if a == 0:
                continue
            d = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) ** 0.5
            if d > radius:
                continue
            t = (1 - (d / radius) ** power) * strength
            img.putpixel(
                (x, y),
                (
                    int(r + (color[0] - r) * t),
                    int(g + (color[1] - g) * t),
                    int(b + (color[2] - b) * t),
                    a,
                ),
            )


class ShelfPacker:
    """Packs named sprites into one atlas and reports where each landed.

    Hand-maintained atlas coordinates and a hand-maintained manifest drift apart the first time
    a sprite changes size, and the symptom is a sprite sampling half of its neighbour. Packing
    and manifest generation therefore come from the same pass.
    """

    def __init__(self, width, height, padding=2):
        self.image = canvas(width, height)
        self.padding = padding
        self.x = padding
        self.y = padding
        self.shelf_height = 0
        self.regions = {}

    def add(self, name, sprite, meters=None):
        w, h = sprite.size
        if self.x + w + self.padding > self.image.width:
            self.x = self.padding
            self.y += self.shelf_height + self.padding
            self.shelf_height = 0
        if self.y + h + self.padding > self.image.height:
            raise RuntimeError(f"atlas full while placing {name!r} ({w}x{h})")
        # Direct copy, not alpha_composite: sprites land on empty space so there is nothing
        # to blend, and this keeps the atlas a function of this file rather than of Pillow's
        # compositing implementation.
        for sy in range(h):
            for sx in range(w):
                pixel = sprite.getpixel((sx, sy))
                if pixel[3] != 0:
                    self.image.putpixel((self.x + sx, self.y + sy), pixel)
        region = {"x": self.x, "y": self.y, "width": w, "height": h}
        if meters:
            region["meters"] = [round(meters[0], 3), round(meters[1], 3)]
        self.regions[name] = region
        self.x += w + self.padding
        self.shelf_height = max(self.shelf_height, h)
        return region

    # NOTE: the atlas is written with STRAIGHT alpha. The loader hands the PNG to
    # createImageBitmap with premultiplyAlpha:'premultiply' and then tells WebGPU the source is
    # already premultiplied, so premultiplying here too would darken every soft edge twice.

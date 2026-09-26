"""The player helicopter, its rotors, and the aircraft-scale enemies."""
from spritelib import (
    canvas,
    ellipse,
    line,
    outline,
    polygon,
    px,
    radial,
    radial_over,
    rect,
    shade_top,
    tint,
)

OUT = (24, 26, 31, 255)
H_HI = (146, 158, 148, 255)
H_MD = (104, 116, 106, 255)
H_LO = (72, 82, 74, 255)
H_DK = (48, 56, 50, 255)
GLASS_HI = (168, 232, 246, 255)
GLASS = (84, 182, 210, 255)
GLASS_DK = (40, 104, 132, 255)
ACCENT = (228, 118, 60, 255)
METAL = (176, 184, 192, 255)
METAL_DK = (98, 106, 114, 255)
BLACK = (18, 20, 24, 255)


def helicopter_side():
    """Nose right, tail left. 96x40 at 16 px/m — about 6 m long and 2.5 m tall."""
    img = canvas(96, 40)

    # Tail boom, tapering toward the fin so the silhouette reads as a tail and not a plank.
    polygon(img, [(14, 19), (48, 17), (48, 27), (14, 24)], H_LO)
    # Horizontal stabiliser.
    rect(img, 8, 21, 16, 3, H_MD)
    # Vertical fin, swept back.
    polygon(img, [(6, 6), (18, 17), (18, 22), (4, 22)], H_MD)

    # Cabin: a rounded box with a sloped nose, drawn as one polygon so the outline pass traces
    # a single clean silhouette rather than the seams between primitives.
    polygon(
        img,
        [(44, 14), (74, 12), (86, 16), (90, 22), (88, 30), (52, 32), (44, 28)],
        H_MD,
    )
    # Engine deck and rotor mast on top.
    rect(img, 42, 10, 26, 5, H_LO)
    rect(img, 51, 6, 4, 5, METAL_DK)
    ellipse(img, 49, 3, 8, 4, METAL)

    # Cockpit glass, with a hard highlight along the top edge.
    polygon(img, [(70, 15), (84, 18), (87, 23), (72, 25), (68, 20)], GLASS)
    polygon(img, [(70, 16), (82, 18), (83, 19), (70, 18)], GLASS_HI)
    polygon(img, [(72, 23), (86, 22), (87, 23), (73, 25)], GLASS_DK)

    # Side door, open — this is a rescue aircraft and the opening is the point.
    rect(img, 50, 18, 14, 11, H_DK)
    rect(img, 51, 19, 12, 9, (36, 42, 38, 255))
    # Rescue stripe.
    rect(img, 44, 29, 44, 2, ACCENT)
    # Exhaust outlet.
    rect(img, 40, 13, 4, 4, BLACK)

    # Skids: two struts and a rail, with the rail turned up at the front.
    line(img, 56, 31, 52, 36, METAL_DK)
    line(img, 57, 31, 53, 36, METAL_DK)
    line(img, 80, 31, 82, 36, METAL_DK)
    line(img, 81, 31, 83, 36, METAL_DK)
    rect(img, 48, 36, 40, 2, METAL)
    line(img, 88, 36, 91, 34, METAL)

    shade_top(img, H_HI)
    outline(img, OUT)
    return img


def helicopter_front():
    """The foreground-facing plane: foreshortened, nose toward the camera."""
    img = canvas(56, 40)
    # Rotor mast and hub.
    rect(img, 26, 6, 4, 6, METAL_DK)
    ellipse(img, 23, 3, 10, 4, METAL)
    # Fuselage seen head on: wider, shorter, symmetrical.
    polygon(img, [(14, 14), (42, 14), (46, 22), (42, 31), (14, 31), (10, 22)], H_MD)
    # Windscreen wraps around the nose.
    polygon(img, [(17, 16), (39, 16), (41, 23), (15, 23)], GLASS)
    polygon(img, [(18, 17), (38, 17), (38, 18), (18, 18)], GLASS_HI)
    # Chin turret — the anti-tank posture the original's forward facing was for.
    rect(img, 24, 29, 8, 4, H_DK)
    rect(img, 27, 32, 2, 3, BLACK)
    rect(img, 10, 29, 36, 2, ACCENT)
    # Skids splay out either side.
    line(img, 18, 31, 12, 36, METAL_DK)
    line(img, 38, 31, 44, 36, METAL_DK)
    rect(img, 8, 36, 12, 2, METAL)
    rect(img, 36, 36, 12, 2, METAL)

    shade_top(img, H_HI)
    outline(img, OUT)
    return img


def helicopter_wreck():
    """Destroyed: the same silhouette, collapsed and burnt, so the loss is legible at a glance."""
    img = helicopter_side()
    img = tint(img, (44, 36, 32), 0.55)
    # Rotor mast and fin torn off.
    rect(img, 44, 0, 22, 11, (0, 0, 0, 0))
    rect(img, 0, 0, 20, 14, (0, 0, 0, 0))
    # The boom droops toward the tail rather than snapping cleanly.
    for x in range(14, 48):
        drop = (48 - x) // 7
        if drop == 0:
            continue
        column = [img.getpixel((x, y)) for y in range(img.height)]
        for y in range(img.height - 1, -1, -1):
            src = y - drop
            img.putpixel((x, y), column[src] if 0 <= src < img.height else (0, 0, 0, 0))
    # Scorching, blended into the hull instead of painted over the frame.
    radial_over(img, 56, 20, 22, (26, 20, 18), strength=0.85)
    radial_over(img, 40, 16, 12, (12, 10, 10), strength=0.95)
    return img


def rotor_blade(span, thickness, alpha):
    """One rotor position. Three of these cycled read as a turning disc without a shader."""
    img = canvas(span, max(6, thickness + 4))
    cy = img.height // 2
    colour = (214, 222, 228, alpha)
    rect(img, 0, cy - thickness // 2, span, max(1, thickness), colour)
    # Blade tips taper, which is what stops a spinning rotor reading as a floating bar.
    rect(img, 0, cy - 1, 4, 2, (214, 222, 228, max(40, alpha - 70)))
    rect(img, span - 4, cy - 1, 4, 2, (214, 222, 228, max(40, alpha - 70)))
    return img


def rotor_disc():
    """The blurred disc used at speed: an ellipse of motion streaks, not a solid shape."""
    img = canvas(128, 14)
    for i in range(0, 128, 3):
        t = abs(i - 64) / 64
        a = int(120 * (1 - t * 0.75))
        h = 2 if t > 0.5 else 3
        rect(img, i, 7 - h // 2, 2, h, (222, 230, 236, a))
    return img


def tail_rotor():
    img = canvas(14, 14)
    for angle in range(0, 180, 30):
        import math

        dx = math.cos(math.radians(angle)) * 6
        dy = math.sin(math.radians(angle)) * 6
        line(img, 7 - dx, 7 - dy, 7 + dx, 7 + dy, (214, 222, 228, 120))
    ellipse(img, 5, 5, 4, 4, METAL_DK)
    return img


def jet():
    """Interceptor, nose right. Sharp and pale so it reads instantly as the fast threat."""
    img = canvas(72, 22)
    body = (150, 160, 176, 255)
    body_dk = (92, 100, 116, 255)
    polygon(img, [(4, 9), (48, 7), (64, 9), (70, 11), (62, 14), (46, 15), (4, 13)], body)
    # Delta wing and canard.
    polygon(img, [(22, 11), (44, 11), (34, 20), (18, 20)], body_dk)
    polygon(img, [(10, 4), (24, 10), (12, 10)], body_dk)
    # Canopy.
    polygon(img, [(52, 8), (62, 10), (52, 12)], GLASS)
    # Intake and exhaust glow.
    rect(img, 2, 9, 4, 4, BLACK)
    radial(img, 2, 11, 7, (255, 190, 110, 210), (255, 120, 40, 0))
    shade_top(img, (192, 202, 216, 255))
    outline(img, OUT)
    return img


def drone():
    """Homing drone: an eye on a ring. Small, slow, and the one thing that follows you home."""
    img = canvas(26, 26)
    shell = (134, 118, 96, 255)
    shell_dk = (82, 70, 54, 255)
    ellipse(img, 3, 6, 20, 14, shell)
    ellipse(img, 5, 8, 16, 10, shell_dk)
    # Sensor eye, lit — the tell that it has acquired you.
    ellipse(img, 10, 10, 7, 6, (255, 96, 72, 255))
    ellipse(img, 12, 11, 3, 3, (255, 214, 190, 255))
    # Rotor arms.
    rect(img, 1, 4, 8, 2, shell_dk)
    rect(img, 17, 4, 8, 2, shell_dk)
    for x in (1, 17):
        rect(img, x, 2, 8, 1, (210, 214, 220, 150))
    shade_top(img, (168, 152, 126, 255))
    outline(img, OUT)
    return img

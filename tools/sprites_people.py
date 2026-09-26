"""Civilians and ground troops.

These are the smallest sprites in the game and the ones that matter most: the PRD's whole
design anchor is that each civilian is an individual whose fate the player can read. So each
pose has a distinct silhouette — a waving civilian must be distinguishable from a running one
at 28 pixels tall, without reading the colour.
"""
from spritelib import canvas, line, outline, polygon, px, rect, shade_top

OUT = (22, 20, 26, 255)
SKIN = (226, 178, 140, 255)
SKIN_DK = (178, 132, 98, 255)
HAIR = (62, 44, 34, 255)
BOOT = (48, 44, 52, 255)

# Civilian shirt colours. Varied so a crowd reads as people rather than clones, and all warm
# so they separate from the cool hostile palette.
CIVIL_SHIRTS = [
    ((226, 196, 120, 255), (178, 148, 82, 255)),
    ((206, 122, 96, 255), (158, 84, 64, 255)),
    # Deliberately NOT green: the hostile uniform is green, and a civilian the player
    # mistakes for a soldier is the worst possible readability failure in this game.
    ((132, 170, 208, 255), (92, 124, 158, 255)),
    ((196, 166, 190, 255), (148, 120, 144, 255)),
]
TROUSERS = (86, 88, 104, 255)
TROUSERS_DK = (62, 64, 78, 255)

HOSTILE_UNIFORM = (86, 96, 78, 255)
HOSTILE_UNIFORM_DK = (58, 66, 52, 255)
HELMET = (74, 82, 66, 255)
GUNMETAL = (58, 60, 66, 255)


def _head(img, x, y, hair=HAIR):
    rect(img, x, y, 5, 5, SKIN)
    rect(img, x, y, 5, 2, hair)
    px(img, x + 4, y + 3, SKIN_DK)


def civilian(pose="idle", variant=0):
    """14x28. Pose changes the silhouette, never only the colour."""
    shirt, shirt_dk = CIVIL_SHIRTS[variant % len(CIVIL_SHIRTS)]
    img = canvas(14, 28)

    if pose == "down":
        # Lying down: read as horizontal, which is the point — a body on the ground.
        rect(img, 1, 20, 11, 5, shirt)
        rect(img, 1, 23, 11, 2, shirt_dk)
        rect(img, 11, 19, 5, 5, SKIN)
        rect(img, 0, 21, 3, 3, TROUSERS)
        outline(img, OUT)
        return img

    _head(img, 4, 2)
    # Torso.
    rect(img, 3, 7, 7, 10, shirt)
    rect(img, 3, 14, 7, 3, shirt_dk)

    if pose == "wave":
        # One arm straight up. The 1982 game's civilians waved; it is how they ask to be seen.
        rect(img, 2, 9, 2, 7, shirt)
        rect(img, 10, 2, 2, 7, shirt)
        rect(img, 10, 0, 2, 2, SKIN)
        rect(img, 4, 17, 2, 8, TROUSERS)
        rect(img, 7, 17, 2, 8, TROUSERS)
    elif pose == "run_a":
        rect(img, 1, 8, 2, 6, shirt)
        rect(img, 10, 10, 2, 6, shirt)
        polygon(img, [(3, 17), (6, 17), (4, 25), (1, 25)], TROUSERS)
        polygon(img, [(7, 17), (10, 17), (12, 24), (9, 24)], TROUSERS_DK)
    elif pose == "run_b":
        rect(img, 2, 10, 2, 6, shirt)
        rect(img, 10, 8, 2, 6, shirt)
        polygon(img, [(3, 17), (6, 17), (6, 25), (3, 25)], TROUSERS_DK)
        polygon(img, [(7, 17), (10, 17), (11, 25), (8, 25)], TROUSERS)
    elif pose == "board":
        # Reaching for the door with both arms — unmistakably "getting in".
        rect(img, 10, 5, 3, 3, SKIN)
        rect(img, 9, 8, 2, 4, shirt)
        rect(img, 2, 9, 2, 6, shirt)
        rect(img, 4, 17, 2, 8, TROUSERS)
        rect(img, 7, 17, 2, 7, TROUSERS_DK)
    else:  # idle
        rect(img, 2, 9, 2, 7, shirt)
        rect(img, 9, 9, 2, 7, shirt)
        rect(img, 4, 17, 2, 8, TROUSERS)
        rect(img, 7, 17, 2, 8, TROUSERS)

    rect(img, 3, 25, 3, 2, BOOT)
    rect(img, 7, 25, 3, 2, BOOT)
    shade_top(img, (245, 210, 176, 255) if pose != "down" else SKIN)
    outline(img, OUT)
    return img


def civilian_wounded():
    """Hunched and holding an arm: visibly slower and costlier to carry."""
    img = canvas(14, 28)
    shirt, shirt_dk = (198, 106, 96, 255), (150, 72, 64, 255)
    _head(img, 5, 5)
    polygon(img, [(3, 10), (10, 10), (9, 19), (4, 19)], shirt)
    rect(img, 3, 16, 7, 3, shirt_dk)
    rect(img, 2, 12, 2, 6, shirt)
    # Bandaged arm across the chest.
    rect(img, 4, 12, 6, 2, (236, 232, 224, 255))
    rect(img, 4, 19, 2, 6, TROUSERS)
    rect(img, 7, 19, 2, 6, TROUSERS_DK)
    rect(img, 3, 25, 3, 2, BOOT)
    rect(img, 7, 25, 3, 2, BOOT)
    outline(img, OUT)
    return img


def infantry(kind="rifle"):
    """Hostile ground troops. Cool green against the civilians' warm palette."""
    img = canvas(16, 28)
    rect(img, 4, 3, 5, 4, SKIN)
    # Helmet, brim forward.
    rect(img, 3, 1, 7, 3, HELMET)
    rect(img, 9, 3, 2, 1, HELMET)
    rect(img, 3, 8, 7, 10, HOSTILE_UNIFORM)
    rect(img, 3, 14, 7, 4, HOSTILE_UNIFORM_DK)
    # Webbing.
    rect(img, 3, 11, 7, 1, (48, 54, 44, 255))
    rect(img, 4, 18, 2, 7, HOSTILE_UNIFORM_DK)
    rect(img, 7, 18, 2, 7, HOSTILE_UNIFORM_DK)
    rect(img, 3, 25, 3, 2, BOOT)
    rect(img, 7, 25, 3, 2, BOOT)

    if kind == "rpg":
        # Launcher on the shoulder, angled up — the 1.1 s telegraph has to be visible.
        polygon(img, [(1, 12), (15, 6), (15, 8), (1, 14)], GUNMETAL)
        rect(img, 0, 12, 3, 3, (40, 42, 48, 255))
        rect(img, 12, 5, 4, 3, (120, 70, 50, 255))
        rect(img, 5, 10, 2, 4, SKIN_DK)
    else:
        # Rifle held across the body.
        polygon(img, [(2, 13), (14, 10), (14, 11), (2, 14)], GUNMETAL)
        rect(img, 3, 13, 3, 2, (70, 54, 42, 255))
        rect(img, 8, 11, 2, 3, SKIN_DK)

    shade_top(img, (112, 122, 102, 255))
    outline(img, OUT)
    return img

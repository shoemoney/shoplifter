#!/usr/bin/env python3
"""Generates the Shoplifter sprite atlas and its manifest.

Original pixel art, authored in code. A generator rather than a folder of PNGs because it keeps
binary churn out of history while art direction is still an open PRD decision, and because CI
can regenerate it and fail on any diff — so the committed atlas can never drift from the source
that made it.

Everything is drawn at 16 pixels per metre, and each region records the world size it was drawn
for, so the renderer scales sprites instead of guessing and squashing them.
"""
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import sprites_aircraft as air  # noqa: E402
import sprites_people as ppl  # noqa: E402
import sprites_world as wld  # noqa: E402
from spritelib import ShelfPacker  # noqa: E402

PX_PER_M = 16.0
ATLAS = 512

OUT_PNG = ROOT / "public" / "assets" / "atlas.png"
OUT_MANIFEST = ROOT / "src" / "content" / "atlases" / "core.json"

CIVILIAN_POSES = ["idle", "wave", "run_a", "run_b", "board", "down"]
CIVILIAN_VARIANTS = 4


def meters(sprite):
    return (sprite.width / PX_PER_M, sprite.height / PX_PER_M)


def build():
    packer = ShelfPacker(ATLAS, ATLAS, padding=2)

    def add(name, sprite, m=None):
        packer.add(name, sprite, m or meters(sprite))

    # --- Aircraft --------------------------------------------------------
    add("helicopter", air.helicopter_side())
    add("helicopter_front", air.helicopter_front())
    add("helicopter_wreck", air.helicopter_wreck())
    add("rotor", air.rotor_disc())
    for i, (thickness, alpha) in enumerate([(3, 235), (2, 170), (1, 110)]):
        add(f"rotor_blade_{i}", air.rotor_blade(128, thickness, alpha))
    add("tail_rotor", air.tail_rotor())

    # --- People ----------------------------------------------------------
    for variant in range(CIVILIAN_VARIANTS):
        for pose in CIVILIAN_POSES:
            add(f"civilian_{variant}_{pose}", ppl.civilian(pose, variant))
    add("civilian_wounded", ppl.civilian_wounded())
    add("infantry_rifle", ppl.infantry("rifle"))
    add("infantry_rpg", ppl.infantry("rpg"))

    # --- Vehicles and emplacements ---------------------------------------
    add("tank_hull", wld.tank_hull())
    add("tank_turret", wld.tank_turret())
    add("aa_gun", wld.aa_gun())
    add("jet", air.jet())
    add("drone", air.drone())
    add("radar_mast", wld.radar_mast())

    # --- Projectiles and effects -----------------------------------------
    add("bullet", wld.bullet())
    add("rocket", wld.rocket())
    add("flare", wld.flare())
    add("glow", wld.glow())
    add("spark", wld.spark())
    add("smoke", wld.smoke())

    # --- Environment ------------------------------------------------------
    # Stretched by the renderer, so their drawn size comes from the world, not the sprite.
    add("ground", wld.ground_strip(), (2.0, 4.0))
    add("landing_pad", wld.landing_pad(), (4.0, 1.0))
    add("white", wld.white(), (0.5, 0.5))
    add("star", wld.star(), (0.5, 0.5))

    return packer


def manifest_text(packer):
    return (
        json.dumps(
            {
                "image": "/assets/atlas.png",
                "width": ATLAS,
                "height": ATLAS,
                "regions": dict(sorted(packer.regions.items())),
            },
            indent=2,
        )
        + "\n"
    )


def straight_alpha_problems(image):
    """Verifies the atlas is STRAIGHT alpha, not premultiplied.

    The loader hands this PNG to createImageBitmap with premultiplyAlpha:'premultiply', so a
    premultiplied file gets premultiplied twice and every soft edge darkens. That is the bug
    this repo shipped: invisible while every sprite was fully opaque, visible the instant
    anything had a feathered edge.

    This is an ABSOLUTE invariant, which is why it earns its place next to the pixel-equality
    check. That one compares the committed file against the generator, so it goes blind the
    moment the generator itself is what premultiplies — both sides agree and the bug is
    invisible. This check does not care what the generator does.

    A premultiplied pixel can never have a colour channel above its alpha. A straight-alpha one
    can, and a white glow fading out is exactly that. Absence of semi-transparent pixels is
    itself a failure: it means the check proves nothing, which is how the bug hid the first time.
    """
    data = image.tobytes()
    soft = 0
    evidence = 0
    for i in range(0, len(data), 4):
        alpha = data[i + 3]
        if alpha == 0 or alpha == 255:
            continue
        soft += 1
        if max(data[i], data[i + 1], data[i + 2]) > alpha:
            evidence += 1

    if soft == 0:
        return [
            "atlas has no semi-transparent pixels, so straight-alpha cannot be verified "
            "(this check would pass vacuously — add a sprite with a soft edge)"
        ]
    if evidence == 0:
        return [
            f"atlas looks PREMULTIPLIED: all {soft} semi-transparent pixels have every colour "
            "channel at or below their alpha. The loader premultiplies on upload, so this file "
            "must be straight alpha or soft edges darken twice."
        ]
    return []


def check(packer):
    """Verifies the committed art still matches what this generator produces.

    Compares PIXELS, not file bytes. PNG encoding is not stable across Pillow and zlib
    versions, so a byte comparison fails on a CI runner with a different Pillow even though
    every pixel is identical — it checks the encoder, not the art.
    """
    problems = []

    if not OUT_PNG.exists():
        problems.append(f"{OUT_PNG.relative_to(ROOT)} is missing")
    else:
        committed = Image.open(OUT_PNG).convert("RGBA")
        fresh = packer.image
        if committed.size != fresh.size:
            problems.append(f"atlas is {committed.size}, generator produces {fresh.size}")
        elif committed.tobytes() != fresh.tobytes():
            a, b = committed.tobytes(), fresh.tobytes()
            diff = sum(1 for i in range(0, len(a), 4) if a[i : i + 4] != b[i : i + 4])
            problems.append(f"atlas pixels differ from the generator ({diff} pixels)")

    if OUT_PNG.exists():
        problems.extend(straight_alpha_problems(Image.open(OUT_PNG).convert("RGBA")))

    expected = manifest_text(packer)
    if not OUT_MANIFEST.exists():
        problems.append(f"{OUT_MANIFEST.relative_to(ROOT)} is missing")
    elif OUT_MANIFEST.read_text() != expected:
        problems.append("atlas manifest differs from the generator")

    if problems:
        for problem in problems:
            print(f"atlas check FAILED: {problem}", file=sys.stderr)
        print("run `npm run assets:atlas` and commit the result", file=sys.stderr)
        return 1

    print(f"atlas check ok: {len(packer.regions)} regions match the generator")
    return 0


def main():
    packer = build()
    if "--check" in sys.argv:
        return check(packer)

    OUT_PNG.parent.mkdir(parents=True, exist_ok=True)
    # Straight alpha: the loader premultiplies on upload.
    packer.image.save(OUT_PNG, optimize=True)
    OUT_MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    OUT_MANIFEST.write_text(manifest_text(packer))

    used = sum(r["width"] * r["height"] for r in packer.regions.values())
    print(
        f"wrote {OUT_PNG.relative_to(ROOT)} ({OUT_PNG.stat().st_size} bytes) "
        f"and {OUT_MANIFEST.relative_to(ROOT)}: "
        f"{len(packer.regions)} regions, {used * 100 // (ATLAS * ATLAS)}% of the sheet used"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

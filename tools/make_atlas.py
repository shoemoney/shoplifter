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


def main():
    packer = build()
    OUT_PNG.parent.mkdir(parents=True, exist_ok=True)
    # Straight alpha: the loader premultiplies on upload.
    packer.image.save(OUT_PNG, optimize=True)

    manifest = {
        "image": "/assets/atlas.png",
        "width": ATLAS,
        "height": ATLAS,
        "regions": dict(sorted(packer.regions.items())),
    }
    OUT_MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    OUT_MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")

    used = sum(r["width"] * r["height"] for r in packer.regions.values())
    print(
        f"wrote {OUT_PNG.relative_to(ROOT)} ({OUT_PNG.stat().st_size} bytes) "
        f"and {OUT_MANIFEST.relative_to(ROOT)}: "
        f"{len(packer.regions)} regions, {used * 100 // (ATLAS * ATLAS)}% of the sheet used"
    )


if __name__ == "__main__":
    main()

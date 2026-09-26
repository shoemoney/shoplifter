import { describe, expect, it } from 'vitest';
import coreAtlas from '../atlases/core.json' with { type: 'json' };
import { atlasManifestSchema } from './atlas.js';
import { loadCoreAtlasManifest } from '../loaders/atlasLoader.js';

describe('atlas manifest', () => {
  it('validates the shipped manifest', () => {
    expect(atlasManifestSchema.safeParse(coreAtlas).success).toBe(true);
  });

  it('exposes every sprite the renderer asks for by name', () => {
    const manifest = loadCoreAtlasManifest();
    for (const name of [
      'helicopter',
      'helicopter_front',
      'helicopter_wreck',
      'rotor',
      'tank_hull',
      'tank_turret',
      'aa_gun',
      'jet',
      'drone',
      'infantry_rifle',
      'infantry_rpg',
      'civilian_wounded',
      'bullet',
      'rocket',
      'ground',
      'landing_pad',
      'glow',
      'white',
      'star',
    ]) {
      expect(manifest.regions[name], `missing region "${name}"`).toBeDefined();
    }
  });

  it('carries a full set of civilian poses for every colour variant', () => {
    const manifest = loadCoreAtlasManifest();
    for (let variant = 0; variant < 4; variant++) {
      for (const pose of ['idle', 'wave', 'run_a', 'run_b', 'board', 'down']) {
        expect(manifest.regions[`civilian_${variant}_${pose}`]).toBeDefined();
      }
    }
  });

  it('declares a world size for every sprite, so nothing is drawn at a guessed aspect', () => {
    const manifest = loadCoreAtlasManifest();
    for (const [name, region] of Object.entries(manifest.regions)) {
      expect(region.meters, `region "${name}" has no declared size`).toBeDefined();
      expect(region.meters?.[0]).toBeGreaterThan(0);
      expect(region.meters?.[1]).toBeGreaterThan(0);
    }
  });

  it('draws people at a human scale', () => {
    const manifest = loadCoreAtlasManifest();
    const civilian = manifest.regions.civilian_0_idle;
    expect(civilian?.meters?.[1]).toBeGreaterThan(1.5);
    expect(civilian?.meters?.[1]).toBeLessThan(2.1);
  });

  it('keeps the helicopter about six metres long', () => {
    const heli = loadCoreAtlasManifest().regions.helicopter;
    expect(heli?.meters?.[0]).toBeGreaterThan(5);
    expect(heli?.meters?.[0]).toBeLessThan(7);
  });

  it('packs every region inside the sheet without overlap', () => {
    const manifest = loadCoreAtlasManifest();
    const entries = Object.entries(manifest.regions);
    for (const [name, region] of entries) {
      expect(region.x + region.width, name).toBeLessThanOrEqual(manifest.width);
      expect(region.y + region.height, name).toBeLessThanOrEqual(manifest.height);
    }
    // Overlapping regions sample each other's pixels, which looks like a corrupt sprite and is
    // maddening to track down — so the packer's output is checked, not trusted.
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i]?.[1];
        const b = entries[j]?.[1];
        if (!a || !b) continue;
        const disjoint =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(disjoint, `${entries[i]?.[0]} overlaps ${entries[j]?.[0]}`).toBe(true);
      }
    }
  });

  it('rejects a region that runs off the atlas', () => {
    const broken = structuredClone(coreAtlas);
    broken.regions.helicopter = { x: 500, y: 0, width: 96, height: 40, meters: [6, 2.5] };
    expect(atlasManifestSchema.safeParse(broken).success).toBe(false);
  });

  it('rejects a zero-sized region', () => {
    const broken = structuredClone(coreAtlas);
    broken.regions.star = { x: 0, y: 0, width: 0, height: 8, meters: [0.5, 0.5] };
    expect(atlasManifestSchema.safeParse(broken).success).toBe(false);
  });
});
